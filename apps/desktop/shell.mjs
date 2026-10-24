#!/usr/bin/env node
/**
 * 桌面薄壳的 **Node 那一半**。
 *
 * 分工：Rust 那半只管窗口与进程；"控制面起没起、要不要起、退出收不收"全在这儿 ——
 * 用的是 `apps/server/src/lifecycle.mjs`，**与 `start.cmd` 同一条实现**（不写第二份）。
 *
 * 与 `start.mjs` 的本质差别只剩**端口**（下面 `pickPort` 有长注释）：命令行的 8787 是
 * 给人用的约定，桌面版没人关心端口 —— 它只该**别撞上别人的程序、也别粘上别人的实例**。
 *
 * 数据目录两边**同一个默认**：本机用户目录（`apps/server/src/data-dir.mjs`）。桌面版不能
 * 塞安装目录 —— 否则用户机器上要么要管理员权限、要么升级被覆盖（docs/形态决策.md §十二 第 1 条）；
 * 要沙盒/临时/真实库，显式 `BANDI_DATA`。
 *
 * 与 Rust 那半的协议（stdout 只出协议行，人看的话都走 stderr，免得解析被搅）：
 *   `BANDI_SHELL READY <url> <0|1>`   1 = 这个服务是本次由壳起的，0 = 复用了本来就在跑的
 *                                     （⚠️ 这两个数**只影响 Rust 那边的文案**；收不收服务由
 *                                      下面的"客户端登记"决定，跟它无关 —— 2026-10-22 改）
 *   `BANDI_SHELL ALIEN <说明>`        端口被别的程序占着，我们没动它
 *   `BANDI_SHELL FAILED <说明>`       起不来
 *
 * 退出信号：stdin 收到一行 `STOP`，或 stdin 被关闭（壳没了），或 SIGTERM/SIGINT。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **服务归"最后一个窗口"所有（2026-10-22 修）**
 *
 * 原来是谁起的谁杀（`r.action === 'started'` 才 stopPid）。双击第二次时第二次只是**复用**，
 * 于是先退出的那个壳一收摊，就把还开着的窗口甩在了 `ERR_CONNECTION_REFUSED` 上
 * （用户实报，见 `%APPDATA%\bandi\shell.log` 15:46 那三条）。
 *
 * 现在服务是**共享资源**，按引用计数收：
 *   ① 每个壳一启动就在 `<数据目录>/clients/<自己 PID>.json` 登记，每 3 秒刷一次 mtime（心跳）；
 *   ② 退出时先撤掉自己的登记 → 扫一遍**还有谁活着**（mtime 超过 15 秒没刷 = 那个壳被强杀了）；
 *   ③ 还有活窗口 → 服务留着；一个都不剩 → 才按 `<数据目录>/service.json` 里**记下来的 PID** 收。
 *
 * 为什么判活只看 mtime、不看 PID 在不在：PID 会被回收，`kill -0` 说"活着"可能是个刚巧复用了
 * 同一个号的陌生进程 —— 那会让服务**永远收不掉**（孤儿）。反过来，mtime 是死的：进程没了，
 * 心跳就停了，15 秒后一定判死。代价是被强杀的壳要在登记簿上多躺 15 秒，扫描时顺手清掉。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **并发启动不许留下孤儿（2026-10-22 QA 打回后补的三层）**
 *
 * 现场：两个壳 1~2 秒内先后启动到同一个空端口 → `pickPort` 都判 'fresh' → 各 `startDetached`
 * 一个控制面 → 输的那个 EADDRINUSE 崩掉 → 两个壳都 `action==='started'` 都写 `service.json`
 * → 后写的记住的是**已崩的 PID** → 全部退出时 `stopPid(死PID)` 空手 → 服务没有人收，孤儿永生。
 *
 * 三层，缺一层都不算修好（每一层都有独立用例顶着）：
 *   ② 起服务**串行化**：`<数据目录>/start.lock`（`wx` 原子创建）—— 抢不到锁的那个窗口
 *      **不许**自己也去 startDetached，改成等对方把服务起好（见 `startControlPlane`）。
 *      这是唯一从根上不制造"两个控制面抢一个端口"的一层。
 *      判"该不该等"看的是**锁的持有人还活着吗**（PID 在不在），不是锁文件的年龄：
 *      上一个壳在起服务途中被强杀时锁是"新鲜"的，只看年龄要空等 40 秒
 *      （而 Rust 等 READY 的预算只有 45 秒，这 40 秒里窗口根本不存在）。
 *      整套等待（抢锁 + 等对方起好 + 接手）有 15 秒总预算，烧完就明确接手或给 FAILED，不死等。
 *   ③ 写 `service.json` 之前**核对端口上真在听的是谁**：只记实际监听者，不记"我以为我起的"
 *      （`recordVerifiedService`）。崩掉的那个 PID 永远进不了记录。
 *      **但记录得更早一点**（QA R2-B）：`ensureRunning` 一 `startDetached` 出 PID 就回调
 *      `onSpawn`，先写一条 `pending: true` 的待定记录 —— 否则"spawn 完成"到"健康确认"之间
 *      最长 30 秒里壳被强杀，服务起来了却没有任何凭据，后面每个壳都当它不是自己人 →
 *      **永久孤儿**。起失败（`action === 'failed'` / 抛异常）就把这条待定记录撤掉，不留假话。
 *   ① 收摊**兜底**：`stopPid(记录的 PID)` 收不到时，若那个端口上坐的仍是**我们自己**的服务
 *      （`stopRunning` 的 `isOurs` 命令行核验，一点没放宽），按端口再收一次；
 *      只有确认真的收干净了才 `forgetService()`，收不干净就**保留记录**并写明原因
 *      —— 留下一条"下次还能收"的线索，比留一个孤儿强。
 *   ①-b 兜底**只对本壳自己写的记录**生效（`rec.byPid === process.pid`，QA R2-A）：
 *      `isOurs` 分不清"壳起的"和"命令行起的"，旧记录一旦当凭据，就会把用户在命令行里
 *      起的活服务收掉。而复用分支会**当场作废**指向已消失 PID 的旧记录
 *      （`auditServiceRecord` → `voidServiceRecord`），从源头上拆掉这颗雷。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureRunning,
  stopPid,
  stopRunning,
  waitPortFree,
  isUp,
  isOurs,
  listeners,
  processInfo,
  sleep,
  urlOf,
} from '../server/src/lifecycle.mjs';
import { userDataDir } from '../server/src/data-dir.mjs';

/** 探测起点。桌面版**没有**"端口"这个概念要给人看，这里只是个起点。 */
const BASE_PORT = Number(process.env.BANDI_PORT_BASE ?? 8787);
/** 往上找多少个。20 个够用了；全被占着才报错。 */
const PROBE_RANGE = 20;

const emit = (line) => process.stdout.write(line + '\n');

/* 数据目录默认与命令行**同一份**（`userDataDir()`）；要沙盒/临时/真实库显式 `BANDI_DATA`。 */
const DATA = process.env.BANDI_DATA ? path.resolve(process.env.BANDI_DATA) : userDataDir();
const LOG = path.join(DATA, 'server.log');
const PORT_FILE = path.join(DATA, 'port');
const SHELL_LOG = path.join(DATA, 'shell.log');
/** 客户端登记簿：谁还在用这个服务。（目录里的文件是"人还在"的证据，不是配置） */
const CLIENTS = path.join(DATA, 'clients');
/** 服务登记：这个服务是哪个 PID、由谁起的。**收摊时只认它**，不在收摊时重新猜端口上是谁。 */
const SERVICE_FILE = path.join(DATA, 'service.json');
/** 起服务的互斥锁：**同一个数据目录只允许一个壳在起服务**（竞态根因见文件头 ②）。 */
const START_LOCK = path.join(DATA, 'start.lock');

/** 心跳间隔。比判死阈值小 5 倍：偶发一次卡顿不至于被误判成"这个壳死了"。 */
const HEARTBEAT_MS = 3000;
/** 多久没心跳算死。窗口还开着时每秒都在刷，正常值就是 0~3 秒。 */
const STALE_MS = 15000;

/**
 * 抢 `start.lock` 时的单次轮询窗口。
 *
 * 正常路径用不到它的一半：对方起一个服务实测 1~3 秒，锁一放我们就拿到了。
 * ⚠️ 别调大 —— Rust 那边给壳的 READY 预算是 **45 秒**，这 45 秒里窗口根本还没建出来
 * （`lib.rs` 要等 READY 才建窗）。等待时间一长，用户看到的就是"双击了但什么都没发生"，
 * 于是反复双击，越点越多等待者（2026-10-22 QA R2-1 实测：陈旧锁场景曾要 41 秒才 READY）。
 */
const START_LOCK_WAIT_MS = 5000;
/** 抢不到锁时，探活等对方把服务起好的窗口（这段时间里对方通常已经起好了）。 */
const START_HANDOFF_MS = 6000;
/**
 * 起服务这件事的**总预算**：锁等待 + 等对方起好 + 接手，全算在里面。
 * 烧完还没结论就明确接手或给 FAILED，**绝不死等** —— 死等的代价是那个永远不出现的窗口。
 * 15 秒 = 45 秒预算的三分之一，给真正的启动（DB 迁移等）留了足够余量。
 */
const START_TOTAL_BUDGET_MS = 15000;
/**
 * 锁多久没动静算"持锁的那个壳卡死了"—— **最后一道兜底**，不再是主要判据
 * （主要判据是"持有人 PID 还在不在"，见 `lockHolderState`）。
 * 必须比一次 `ensureRunning` 的健康等待（30 秒）长：正在启动的壳不该被抢锁。
 */
const START_LOCK_STALE_MS = 40000;

/**
 * 收摊时等 `start.lock` 的上限。
 *
 * 为什么收摊也要拿这把锁（2026-10-22 第三轮）：用户最自然的"重启"动作是**关掉旧窗口、
 * 立刻再双击**。旧壳判「一个窗口都不剩」与实际 taskkill 之间有 0.5~2 秒（`stopPid` 要起
 * PowerShell 读命令行），新壳恰好在这段时间 `ensureRunning` 看到服务还在 → READY 0（复用），
 * 紧接着旧壳把服务杀了 → 新窗口当场断连，又回到用户实报的那个画面。
 * 拿锁 + 拿锁后复扫，把这段窗口关掉。
 *
 * 上限压到 800ms：Rust 的 STOP_GRACE 只有 3 秒，收摊不能等太久。
 * 等不到（别人正在起服务）就**保守留着服务** —— 留着最多是"服务多活一会儿"，
 * 杀掉则是把那个窗口甩在"连不上"上。
 */
const SHUTDOWN_LOCK_WAIT_MS = 800;

/** 本进程的登记文件。用 PID 做文件名：同一个壳只会有一份，重复写就是覆盖自己的。 */
const CLIENT_FILE = path.join(CLIENTS, `${process.pid}.json`);
const STARTED_AT = new Date().toISOString();

/**
 * 人看的话一律走 stderr —— 但**正式安装包没有控制台**
 * （release 下 `windows_subsystem = "windows"`，stderr 等于扔进虚空）。
 * 所以同时落一份到数据目录的 `shell.log`：出问题时，这是唯一能看到"壳当时说了什么"的地方。
 */
const log = (s) => {
  const line = `[壳] ${s}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(SHELL_LOG, `${new Date().toISOString()} ${line}`);
  } catch { /* 写不了就算了，不能因为日志把启动搞挂 */ }
};

/**
 * 上次用的是哪个端口。记它不是为了"固定"，是为了**复用自己那一个实例**：
 * 第二次双击时应该聚焦到已经跑着的那个，而不是在隔壁端子上再起一个控制面
 * （两个控制面共用一个数据目录，是给自己找麻烦）。
 */
function readRecordedPort() {
  try {
    const n = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

function recordPort(port) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(PORT_FILE, `${port}\n`, 'utf8');
  } catch { /* 写不了就算了：下次重新挑一个，不影响能不能跑 */ }
}

/* ------------------------------------------------------- 登记簿（谁在用这个服务） */

/**
 * 写一个小 JSON 文件，**先写临时名再 rename**。
 *
 * 为什么不能直接 writeFileSync：另一个壳可能正在同一时刻读这个文件来判断"还有没有人"，
 * 半截文件会被读成"解析失败 = 没有客户端" → 服务被误杀。rename 在同一个卷上是原子的。
 * 临时名以 `.tmp` 结尾，扫描时按 `.json` 过滤，天然不会被当成一个客户端。
 */
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(obj)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉也不影响扫描（.tmp 不是 .json） */ }
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 不存在 / 半截 / 不是 JSON —— 一律当"没有"，别让一个坏文件把启动搞挂
  }
}

let heartbeatTimer = null;
/** 我用的端口（端口定下来之后补上）。心跳重写登记文件时也要带着它。 */
let myPort = null;

/**
 * 登记自己"还在用这个服务"，并开始心跳。
 *
 * 一启动就登记（端口还不知道时先写 `port: null`），不是等 ensureRunning 回来才登记：
 * 起控制面最长要等 30 秒，这段时间里如果**别的**窗口退出，它扫登记簿必须能看见我 ——
 * 否则它会把"正在被这个壳启动/使用的服务"当成没人要的给收了。
 */
function enroll(port) {
  if (Number.isInteger(port) && port >= 1) myPort = port;
  const payload = () => ({ pid: process.pid, startedAt: STARTED_AT, port: myPort });
  const ok = writeJsonAtomic(CLIENT_FILE, payload());
  if (!ok) log('登记不了自己的存活（写不进 clients/）—— 别的窗口退出时可能看不见我');
  if (heartbeatTimer) return ok;

  heartbeatTimer = setInterval(() => {
    const now = new Date();
    try {
      fs.utimesSync(CLIENT_FILE, now, now); // 只刷 mtime：内容是给人排查用的，不用重写
    } catch {
      /*
       * 登记文件没了 —— 可能是本进程卡了很久被判成"死客户端"清掉了。
       * 重新写一份：我还活着，就该重新出现在登记簿上（判活看的是刷新时间，重写即刷新）。
       */
      writeJsonAtomic(CLIENT_FILE, payload());
    }
  }, HEARTBEAT_MS);
  // 心跳不能把进程钉住：收摊靠的是退出信号，不是这个定时器
  heartbeatTimer.unref?.();
  // 决策要能在 shell.log 里读出来：这份登记长什么样、判死按什么算
  log(
    `登记 ${path.basename(CLIENT_FILE)}（心跳 ${HEARTBEAT_MS / 1000}s，超过 ${STALE_MS / 1000}s 算死）`,
  );
  return ok;
}

/** 撤掉自己的登记。**必须在扫描之前**做，否则"最后一个窗口"永远会看见自己。 */
function leave() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    fs.rmSync(CLIENT_FILE, { force: true });
  } catch { /* 删不掉就等它 15 秒后过期，不影响结论 */ }
}

/**
 * 扫一遍登记簿：谁还活着、哪些是死人留下的脏文件（顺手清掉）。
 *
 * 判活**只看 mtime**（见文件头注释：PID 会被回收，"这个号有人"不等于"这个壳还在"）。
 * 刚写下的登记自然是最新鲜的，所以"刚起的活窗口"一定算数 —— 这是不能误杀的那一头。
 */
function scanClients() {
  let names = [];
  try {
    names = fs.readdirSync(CLIENTS);
  } catch {
    return { alive: [], stale: [] }; // 还没有 clients/ 目录 = 只有我自己（而且已经被 leave 撤掉了）
  }

  const now = Date.now();
  const alive = [];
  const stale = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(CLIENTS, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue; // 扫描期间被别的壳删了，跳过
    }
    const meta = readJson(file) ?? {};
    const pid = Number(meta.pid) || Number(name.slice(0, -'.json'.length)) || 0;
    const ageMs = now - st.mtimeMs;
    if (ageMs <= STALE_MS) {
      alive.push({ pid, file, ageMs, meta });
      continue;
    }
    stale.push({ pid, file, ageMs });
    try {
      fs.rmSync(file, { force: true });
    } catch { /* 删不掉也只是下次再清；它已经超时，不会影响"还有没有人"的判断 */ }
  }
  return { alive, stale };
}

/**
 * 扫一眼登记簿：返回**还活着的**客户端（顺手清掉陈旧文件，并把这件事记进日志）。
 *
 * 起服务的分支、复用的分支、收摊都用它 —— 清理是副作用，但"为什么清"必须留在 `shell.log` 里，
 * 否则用户看到"服务收掉了"只会怀疑是谁乱杀的。
 */
function aliveClients() {
  const { alive, stale } = scanClients();
  if (stale.length) {
    log(
      `清掉 ${stale.length} 个陈旧登记（${stale
        .map((s) => `PID ${s.pid} 静默 ${Math.round(s.ageMs / 1000)}s`)
        .join('、')}）—— 超过 ${Math.round(STALE_MS / 1000)}s 没心跳，那些壳是被强杀的`,
    );
  }
  return alive;
}

/** 记下"这个服务是哪个 PID、由哪个壳起的"。收摊时只认这份记录。 */
function recordService(pid, port) {
  const ok = writeJsonAtomic(SERVICE_FILE, {
    pid,
    port,
    byPid: process.pid,
    at: STARTED_AT,
  });
  if (!ok) log('⚠️ 没能把"服务是我起的"写进 service.json —— 退出时不会收它（宁可留个服务，也不误杀）');
  return ok;
}

/**
 * **spawn 那一刻**就落一条「待定」记录（QA R2-B）。
 *
 * 为什么不能等"起来了"再记：`ensureRunning` 里 spawn 与返回之间隔着最长 **30 秒**的健康等待。
 * 壳恰好在这段时间被强杀（任务管理器 / 崩溃 / 断电）时——服务已经起来了、端口 200、
 * 磁盘上却**一条凭据都没有** → 后面每一个壳读不到 `service.json` → 按"不是壳起的就不动"
 * 把它们全放过去 → **永久孤儿**（2026-10-22 实报：`qa-kill-lock-holder.mjs`）。
 *
 * `pending: true` 是给后面的人看的一句实话：**这条记录还没经过核对**，它记的 PID 可能
 * 因为 EADDRINUSE 已经崩了。谁想用它（收摊 / 作废）都该先问一句"这个 PID 还在不在端口上"，
 * 而**不能**像正式记录那样直接当凭据 —— 这正是 `recordVerifiedService` 在成功后会覆盖它的原因。
 *
 * 写失败不算故障：服务确实在跑，只是退化成"成功了再记"的旧行为。
 */
function recordPendingService(pid, port) {
  const ok = writeJsonAtomic(SERVICE_FILE, {
    pid,
    port,
    byPid: process.pid,
    at: STARTED_AT,
    pending: true,
  });
  log(
    ok
      ? `刚 spawn 出一个服务（PID ${pid}，端口 ${port || '?'}）—— 先记一条**待定**记录：` +
        '这会儿它还没确认健康，万一我半路被强杀，后面的人至少知道这服务是壳起的'
      : `⚠️ 待定记录没写成（PID ${pid}）—— 起不来的话就退化成"成功了再记"`,
  );
  return ok;
}

/**
 * 起服务失败时**撤掉自己那条待定记录**。
 *
 * 留着它就是一条彻头彻尾的假话："这个服务是我起的" —— 而它根本没起来（或者起来就崩了）。
 * 下一次收摊会照着它去 `stopPid`，最坏的情况是那个 PID 已经被系统回收给了别人
 * （PID 回收的坑，见文件头那段为什么登记簿只看 mtime）。
 *
 * 只撤**自己的、还没转正的**那条：`byPid` 是我、`pending` 为真。别人的记录（哪怕也是 pending）
 * 一个字都不碰 —— 那是人家的收摊凭据。
 *
 * `pid` 给了就顺带核一下号，防止"我这次起失败"把"我上一次成功起的那条正式记录"误删。
 */
function dropPendingService(pid = null) {
  const rec = readService();
  if (!rec || !rec.pending) return;
  if (Number(rec.byPid) !== process.pid) return;
  if (pid && Number(rec.pid) !== Number(pid)) return;
  forgetService();
  log(
    `那条待定记录（PID ${rec.pid}）**作废**了 —— 服务没起来，我不能在盘上留一句"这是我起的"的假话`,
  );
}

/**
 * 写记录之前**先核对端口上真在听的是谁**（QA 打回的第 ③ 层）。
 *
 * 为什么不能直接 `recordService(我刚起的 pid)`：两个壳同一瞬间各起一个控制面时，
 * 输的那个会 EADDRINUSE 崩掉，而赢的那个仍在同一个端口上服务 —— 于是"我刚起的 pid"
 * 其实已经是个死进程。把死 PID 写进记录，收摊时就只能空手而归，服务变成孤儿
 * （QA 取证：记录 pid=15124，实际监听 1644）。
 *
 * ⚠️ 判定顺序**不能反**（2026-10-22 回归踩到）：先看"我起的 PID 自己在不在听"，
 * 再看"听的那个是不是我们的人"。因为第二问要读命令行（Windows 上是 `powershell`），
 * 而环境一退化就读不到（`smoke-shell.mjs` 用例⑨ 造的就是这个情形：PATH 里只有
 * System32，powershell 不在）。那时如果把"读不到"当成"不是我们的"，`service.json`
 * 就永远写不下去 —— 收摊只能空手，正好是 2026-10-15 那条教训的反面。
 * `netstat` 给的是 PID 本身，不需要认字，所以第一问在退化环境里照样成立。
 *
 * 返回最终记下的 PID（没记则 null）。
 */
function recordVerifiedService(pid, port) {
  const p = Number(port);
  const listening = Number.isInteger(p) && p > 0 ? listeners(p) : [];

  // ① 最可信、且不依赖命令行读取：我刚起的那个 PID 本身就在这个端口上听着
  if (listening.includes(Number(pid))) {
    return recordService(pid, port) ? Number(pid) : null;
  }

  // ② 我起的那个不在听 —— 它崩了（EADDRINUSE / 启动失败），或者端口被别人抢走了。
  //    这时以**实际监听者里的自己人**为准（能认出来的前提下）。
  const ours = oursOnPort(port);
  if (ours.length) {
    log(
      `端口 ${port} 上真在听的是 PID ${ours.join('、')}，不是我起的 ${pid}` +
        '（我起的那个崩了 / 端口被别人抢了）—— **记录以实际监听者为准**',
    );
    return recordService(ours[0], port) ? ours[0] : null;
  }

  /*
   * ③ 谁都认不出来。读不到命令行时**绝不猜**：那个 PID 可能是别人的程序，
   * 记下来收摊就会误杀（`stopPid` 在"读不到命令行"时是按记录直接收的）。
   * 宁可这次不记 —— 后面还有收摊兜底与下一次启动来收拾，而杀错别人的进程是不可挽回的。
   */
  const unidentified = listening.length > 0 && listening.map(processInfo).every((i) => !i.cmd);
  log(
    unidentified
      ? `⚠️ 起的 PID ${pid} 不在端口 ${port} 上，而且读不到命令行认不出监听者是谁 —— 不写 service.json（猜着写会误杀别人的程序）`
      : `⚠️ PID ${pid} 已经不在端口 ${port} 上监听了 —— 不写 service.json（写一条指向死进程的记录，收摊时就会空手，留下孤儿）`,
  );
  return null;
}

const readService = () => readJson(SERVICE_FILE);

function forgetService() {
  try {
    fs.rmSync(SERVICE_FILE, { force: true });
  } catch { /* 删不掉也就是留一条过期记录，下次起服务的壳会覆盖它 */ }
}

/**
 * 把一条记录**当场作废**（QA R2-A 第 2 条）：内容留着，但打上 `stale` 标记。
 *
 * 为什么不直接删文件：`service.json` 里那几行（PID / byPid / 时间）是事后排查"当年到底是谁
 * 起的、被谁收了"的唯一线索，删了就永远查不到。而**功能上它已经死了** ——
 * 下面 `readService` 的三处使用者（复用分支 / 收摊 / 下一次启动）全都会先看 `stale`，
 * 看到就当作"没有记录"：不认领、不按它收、也不再重复作废一次。
 *
 * 也就是说：**作废之后谁也拿不动它** —— 这跟把文件删掉在功能上是等价的，
 * 但比删掉多留了一份"谁在什么时候把它作废的"证据。
 */
function voidServiceRecord(rec, why) {
  const ok = writeJsonAtomic(SERVICE_FILE, {
    ...rec,
    pid: rec.pid ?? null,
    port: rec.port ?? null,
    byPid: rec.byPid ?? null,
    at: rec.at ?? null,
    stale: true,
    staleAt: new Date().toISOString(),
    staleReason: why,
  });
  log(ok ? why : `${why}（⚠️ 没写进去：文件读写失败，但它本来就是条死记录，不影响判断）`);
  return ok;
}

/**
 * 复用分支的**即时体检**：`service.json` 指的那个 PID 还在这个端口上服务吗？
 *
 * 为什么必须在这儿做（QA R2-A 的根）：复用方**不认领**这个服务（它不是自己起的，写记录
 * 就是冒名，那是 2026-10-15 误杀的近亲），但"不认领"不等于"可以不管" ——
 * 一条指向早已不存在的 PID 的旧记录留在盘上，就是后面每一次收摊的定时炸弹：
 * 2026-10-22 实测有壳拿它去按端口兜底，把**命令行起的活服务**收了。
 *
 * 所以：记录里的 PID 不在当前监听者里 → 立刻作废（`voidServiceRecord`），并说明白
 * 「服务不是我起的」—— 让日志自己解释为什么这个壳一个进程都没动。
 *
 * 三个"不动手"的前提：没有记录 / 记录本身没有 PID → `'none'`；已经作废过 → `'void'`；
 * 读不到监听者（netstat 失败）→ `'unknown'`，此时**不猜**，跟收摊兜底一个原则：
 * 宁可留着一条可疑记录，也不凭猜去杀进程。
 *
 * 返回 `'valid' | 'void' | 'unknown' | 'none'`。
 */
function auditServiceRecord(rec, livePids) {
  if (!rec || !rec.pid) return 'none';
  if (rec.stale) return 'void'; // 已经作废过，别每次开窗都重写一遍
  const actual = livePids?.length ? livePids : listeners(PORT);
  if (!actual.length) return 'unknown';
  if (actual.includes(Number(rec.pid))) return 'valid'; // 还在，记录有效
  voidServiceRecord(rec, `旧记录指向的 PID ${rec.pid} 已经不在了，作废这条记录（服务不是我起的）`);
  return 'void';
}

/**
 * 端口上**我们自己的**服务是谁（PID 数组）。
 *
 * 判据就是 `lifecycle.mjs` 的 `isOurs`（命令行里的入口后缀），**一点没放宽**：
 * 读不到命令行、或对不上，都算"不是我们的" —— 收摊兜底宁可收不掉、也不能误杀别人的程序。
 */
function oursOnPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1) return [];
  return listeners(p)
    .map(processInfo)
    .filter(isOurs)
    .map((i) => i.pid);
}

/* ------------------------------------------------------------------- 挑端口 */

/**
 * 挑端口。**这是桌面版与命令行版的一处本质差别。**
 *
 * 命令行的 8787 是"人的约定" —— 你要知道去哪儿开浏览器、去连谁。桌面版没有这个约定：
 * 窗口是它自己开的，端口只是个内部细节。所以它可以、也应该自己挑。
 *
 * 对每个候选端口：
 *   · 上面是**我们自己的**实例而且在响应 → 用它（复用，`mode: 'reuse'`）；
 *   · 谁都没在听，或者听的是我们自己但已经僵死 → 用它（起，或让 lifecycle 重启）；
 *   · 听的是**别人的**程序 → **跳过**（不碰、不报错，看下一个）。
 *
 * 最后一条是关键：硬编码 8787 的桌面版，在"用户机器上恰好有别的程序占着 8787"时
 * 只剩一张错误页 —— 对不懂电脑的人是死路。自己挑就不会。
 */
async function pickPort() {
  const candidates = [];
  const recorded = readRecordedPort();
  if (recorded) candidates.push(recorded);
  for (let p = BASE_PORT; p < BASE_PORT + PROBE_RANGE; p++) {
    if (!candidates.includes(p)) candidates.push(p);
  }

  for (const port of candidates) {
    const pids = listeners(port);
    if (!pids.length) return { port, mode: 'fresh' }; // 空着 → 就在这儿起
    const infos = pids.map(processInfo);
    // 认不出来（读不到命令行等）也按"别人的"处理 —— 宁可换一个端口，也不误判成自己人
    if (!infos.every(isOurs)) continue;
    if (await isUp(port)) return { port, mode: 'reuse' };
    return { port, mode: 'fresh' }; // 自己的但僵死 → 交给 ensureRunning 收掉重起
  }
  return { port: 0, mode: 'none', error: `从 ${BASE_PORT} 往上找了 ${PROBE_RANGE} 个端口，全被别人占着` };
}

/* ------------------------------------------------------- 起服务串行化（start.lock） */

let holdingStartLock = false;

/** 锁文件有多久没动（读不到返回 null）。年龄只在"持有人判不出来"时当最后一道兜底用。 */
function lockAgeMs() {
  try {
    return Date.now() - fs.statSync(START_LOCK).mtimeMs;
  } catch {
    return null;
  }
}

/** 锁文件里记的持有人 PID（没有/写坏返回 0）。 */
function lockHolderPid() {
  const who = readJson(START_LOCK);
  const pid = Number(who?.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * 这个 PID 还活着吗？
 *
 * 用 `process.kill(pid, 0)`：信号 0 什么都不发，只做"这个进程存在吗"这一件事。
 * `EPERM` 是"进程在、只是我没权限给它发信号"——**算活着**（保守）；
 * 只有 `ESRCH`（找不到）才算死。
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 锁的持有人现在什么状态：`'dead'`（可以立刻接手）/ `'unknown'`（刚建、还没写完）/ `'alive'`。
 *
 * ⚠️ **按持有人存活判，而不是只按年龄判**（2026-10-22 QA R2-1）：
 * 上一个壳在"起服务过程中"被 `taskkill /F` 之后，锁文件是**新鲜**的（几十毫秒前建的），
 * 只按年龄判就要空等满 40 秒 —— 而 Rust 给壳的 READY 预算只有 45 秒，窗口在这段时间里
 * 压根不存在，用户会以为双击没反应、反复点，越点越多等待者。
 * 年龄阈值退化成"判不出持有人时"的最后一道兜底（`START_LOCK_STALE_MS`）。
 */
function lockHolderState() {
  const pid = lockHolderPid();
  if (pid) return pidAlive(pid) ? 'alive' : 'dead';

  /*
   * 没有可用的 pid：对方可能刚 `open` 完还没来得及 `write`（同一次事件循环里的毫秒级窗口）。
   * 给 1 秒宽限，过了还是一片空白就当没人持有 —— 不能因为一个空文件把启动卡住。
   */
  const age = lockAgeMs();
  if (age === null) return 'dead'; // 文件已经没了
  return age > 1000 ? 'dead' : 'unknown';
}

/** 锁文件的内容（"哪一把锁"）。判陈旧靠它，不靠文件名 —— 文件名是固定的。 */
function lockToken() {
  try {
    return fs.readFileSync(START_LOCK, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * **原子地**把一把"已判定该抢"的锁换成我的（QA 打回的第 ④ 条，2026-10-22 第三轮）。
 *
 * 旧写法是 `dropStartLock(); continue;` —— "删了再造"。两个等待者会互相删对方刚造的新锁：
 *   A 删旧锁 → A 造新锁 → B 删掉 A 的新锁 → B 造自己的 → **两个壳都以为自己持锁**
 *   → 各起一个控制面 → 一个 EADDRINUSE 崩掉 + `server.log` 里 `database is locked`
 *   （`tmp/qa-lock-double-takeover.mjs` 实测能抓到 2 次）。
 *
 * 改成「**先改名占为己有，再核对改名拿到的是不是刚才判定的那一把**」：
 *   · `rename` 在同一卷上是原子的 —— 两个人抢同一个名字，只有一个成功；
 *   · 改名后读一眼内容：还是判定时的 token → 真抢到了；变了 → 说明我拖走的是别人刚建的新锁
 *     （极窄窗口），**原样放回去**，这一轮让给别人；
 *   · 代价：改名瞬间会出现几十微秒的"锁文件不存在"，别的壳能直接 `wx` 建锁 ——
 *     最坏结果是它先起服务、我下一轮看到 `alive` 去等它，**不会双起**。
 *
 * @param {string} expectToken 判定锁该抢时读到的内容；空串 = 不比对内容、强制接手（15 秒预算那条）
 * @returns {boolean} true = 抢到（锁文件已被移走，下一轮 `wx` 自己建）；false = 别人先动了
 */
function takeoverStartLock(expectToken) {
  const mine = `${START_LOCK}.takeover-${process.pid}-${Date.now()}`;
  const seen = expectToken ?? lockToken();
  try {
    fs.renameSync(START_LOCK, mine);
  } catch (e) {
    if (e.code === 'ENOENT') return false; // 锁已经没了（别人先拿走 / 自己过期）→ 回循环再看
    throw e;
  }
  let moved = '';
  try {
    moved = fs.readFileSync(mine, 'utf8').trim();
  } catch { /* 读不到 = 没对上，保守放回 */ }
  if (seen && moved !== seen) {
    /*
     * 拖走的是别人**新造**的锁：放回原位，但绝不覆盖现在已经存在的锁。
     * 放不回去（位置被别人占了）就删掉手里这份 —— 对方下一轮按"锁没了"重来，两边都不会双持。
     */
    try {
      fs.renameSync(mine, START_LOCK);
    } catch {
      try { fs.rmSync(mine, { force: true }); } catch { /* ignore */ }
    }
    return false;
  }
  try { fs.rmSync(mine, { force: true }); } catch { /* 留个垃圾文件而已，不影响判断 */ }
  return true;
}

/**
 * 抢锁失败计数：**必须收敛**（QA 打回的第 ④ 条里"删不掉就无限自旋"那半）。
 *
 * 死循环的现场：锁被判定 dead → 删不掉（ACL / 杀软占着 / 父目录只读）→ 下一轮 `wx` 还是 EEXIST
 * → 又判 dead → 又删不掉 …… **100% CPU、永远不 READY**（Rust 45 秒后掐掉，用户看到"没起来"）。
 * 所以连续 3 次抢不动就明说"这次没有防双开保护"继续往下走：**起飞比完美互斥重要**。
 */
let takeoverFailures = 0;

/** 尝试接手一次；把"抢到 / 让路 / 抢不动"收敛成一个值，调用方只管 continue 或走 nolock。 */
function tryTakeover(expectToken, why) {
  try {
    if (takeoverStartLock(expectToken)) {
      takeoverFailures = 0;
      log(`start.lock 的持有人已经不在了（${why}）—— 接手起服务`);
      return 'taken';
    }
    return 'lost';
  } catch (e) {
    takeoverFailures += 1;
    if (takeoverFailures >= 3) {
      log(`start.lock 抢不过来（${e.code ?? e.message}）—— 本次没有防双开保护，照常往下走`);
      return 'nolock';
    }
    return 'retry';
  }
}

/**
 * 抢"起服务"的锁（QA 打回的第 ② 层，堵的是**根因**）。
 *
 * `fs.openSync(file, 'wx')` 是原子的"不存在才创建"：两个壳同时抢，只有一个能拿到。
 *
 * 返回：
 *   `'ok'`     抢到了，调用方起完服务必须 `releaseStartLock()`
 *   `'busy'`   持有人**还活着**，在 `waitMs` 内它一直没放锁 —— 调用方去等它把服务起好
 *   `'nolock'` 这个文件系统压根不支持这种锁（写不进数据目录之类）—— 没有保护，但也不能因此起不来
 */
async function acquireStartLock(waitMs) {
  const until = Date.now() + waitMs;
  let told = false;
  for (;;) {
    try {
      const fd = fs.openSync(START_LOCK, 'wx');
      try {
        fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
      } finally {
        fs.closeSync(fd);
      }
      holdingStartLock = true;
      return 'ok';
    } catch (e) {
      if (e.code !== 'EEXIST') {
        log(`拿不到 start.lock（${e.code ?? e.message}）—— 这次没有防双开保护，照常往下走`);
        return 'nolock';
      }

      // ① 先看持有人还在不在 —— 死了就立刻接手，一分钟都不等
      const holder = lockHolderState();
      if (holder === 'dead') {
        const pid = lockHolderPid();
        const age = lockAgeMs();
        const ageText = age === null || age < 1500 ? '刚建的' : `${Math.round(age / 1000)}s 前建的`;
        const verdict = tryTakeover(
          lockToken(),
          `${pid ? `PID ${pid}` : '文件里没有 PID'}，锁是${ageText}`,
        );
        if (verdict === 'nolock') return 'nolock'; // 抢不动就别自旋了（见 takeoverFailures）
        continue;
      }

      // ② 判不出来（刚建、内容还没落地）：再宽限一点，别抢一个正写到一半的锁
      if (holder === 'unknown') {
        if (Date.now() > until) return 'busy';
        await sleep(150);
        continue;
      }

      // ③ 持有人活着 —— 年龄超了就按"卡死"兜底（它早该在 30 秒健康等待内放锁）
      const age = lockAgeMs();
      if (age !== null && age > START_LOCK_STALE_MS) {
        const verdict = tryTakeover(
          lockToken(),
          `PID ${lockHolderPid()} 还在，但锁已经 ${Math.round(age / 1000)}s 没放 —— 按卡死处理`,
        );
        if (verdict === 'nolock') return 'nolock';
        continue;
      }

      if (!told) {
        log(
          `另一个窗口正在起服务（PID ${lockHolderPid()}）—— 先等它，不能两个壳各起一个控制面抢同一个端口`,
        );
        told = true;
      }
      if (Date.now() > until) return 'busy';
      await sleep(250);
    }
  }
}

/** 放锁。只删自己那把（万一被别人当陈旧锁抢走重建过，别替它删）。 */
function releaseStartLock() {
  if (!holdingStartLock) return;
  holdingStartLock = false;
  try {
    const who = readJson(START_LOCK);
    if (who && Number(who.pid) !== process.pid) return;
  } catch { /* 读不到就按自己的删 */ }
  try {
    fs.rmSync(START_LOCK, { force: true });
  } catch { /* 删不掉就等它 40 秒后过期，不影响下一次启动 */ }
}

/** `ensureRunning` 的参数只写一份 —— 三个调用点（抢到锁 / 没锁 / 接手）用同一套。 */
function ensureOptions() {
  return {
    port: PORT,
    dataDir: DATA,
    logFile: LOG,
    /*
     * ⚠️ **不再写死 `BANDI_HOST: '127.0.0.1'`**（2026-10-16 改）。
     *
     * 原来那句是故意的（"壳只服务本机，别因为外面环境里塞了 BANDI_HOST 就把界面暴露出去" ✓）——
     * 但那让桌面版**永远当不了总机** ✗（别的机器连不进来）。现在这件事交给
     * 数据目录里的 `netmode.json`（设置里那个「允许局域网内的机器加入」开关 ✓）：
     * `config.mjs` 读它 → 桌面壳 / 开机自启 / 命令行**三种起法都按同一个开关走** ✓。
     * 开关默认**关** → 行为跟以前一模一样（只听回环、免鉴权）✓。
     */
    extraEnv: {},
    /*
     * **spawn 那一刻就落记录**（QA R2-B 的修法，见 `recordPendingService`）。
     * 回调的是 `lifecycle.ensureRunning` —— 它一 `startDetached` 出 PID 就同步喊我一声，
     * 而不是等它把 30 秒的健康等待走完。中间被强杀也不再有"起了但没记档"的空窗。
     */
    onSpawn: (pid) => recordPendingService(pid, PORT),
  };
}

/** 探到服务起来为止（只有"另一个窗口正在起"时才这么等）。 */
async function waitUntilUp(port, ms) {
  const until = Date.now() + ms;
  for (;;) {
    if (await isUp(port)) return true;
    if (Date.now() >= until) return false;
    await sleep(300);
  }
}

/**
 * 起控制面（**串行化**），三层防护里的第 ② 层就落在这里。
 *
 * 抢到锁：正常 `ensureRunning`。它在锁里做的第一件事就是 `isUp` ——
 * 所以"复用的那个窗口"看到的必然是前一个窗口起好的服务，不会再多起一个。
 *
 * 抢不到锁（持有人还活着）：**绝不**自己也去 `startDetached`（那就是孤儿服务的来源），
 * 改成探活等对方把服务起好，等到了就当 `already` 用。
 *
 * 总等待有上限（`START_TOTAL_BUDGET_MS`）：预算烧完、持有人却还活着且服务没起来 ——
 * 说明那个壳卡住了，**明确接手**（删它的锁自己起），起不来才认输给 FAILED。
 * 这一条是为了不死等：Rust 那边 45 秒拿不到协议行就直接掐了。
 */
async function startControlPlane() {
  const deadline = Date.now() + START_TOTAL_BUDGET_MS;
  /**
   * 一开始等的是**哪个 PID** 手里的锁。
   *
   * 这是 15 秒接手分支的判据（2026-10-22 第三轮）：如果锁已经换到**别人**手里，说明
   * 有人接过手、正在起服务 —— 这时候再"接手"就是抢一个正在正常工作的壳，
   * 两个都 spawn 控制面（`database is locked` 的另一个来源）。所以只看"我最初等的那个
   * 持有人"还在不在：它还在 → 真卡死了，接手；换人了 → 让路并等它起好。
   */
  let waitedOn = 0;

  for (;;) {
    const leftMs = Math.max(600, deadline - Date.now());
    const lock = await acquireStartLock(Math.min(START_LOCK_WAIT_MS, leftMs));

    if (lock === 'ok') {
      try {
        return await ensureRunning(ensureOptions());
      } finally {
        releaseStartLock();
      }
    }
    if (lock === 'nolock') return ensureRunning(ensureOptions());

    // 锁的持有人还活着：先等它把服务起好（这是正常路径 —— 实测 1~3 秒）
    if (!waitedOn) waitedOn = lockHolderPid();
    const up = await waitUntilUp(PORT, Math.min(START_HANDOFF_MS, Math.max(800, deadline - Date.now())));
    if (up) {
      const pids = listeners(PORT);
      log(`等到了：另一个窗口已经把控制面起好了（PID ${pids.join('、') || '读不到'}）—— 直接复用`);
      return { action: 'already', url: urlOf(PORT), pids };
    }

    if (Date.now() < deadline) continue; // 还有预算：再抢一次（对方可能刚放锁）

    /*
     * 预算烧完：**先看锁还在不在我等的那个 PID 手里**（见 `waitedOn` 的注释）。
     * 换人了 = 有人接手了，让给新持有人，绝不抢一个正在起服务的壳。
     */
    const holderNow = lockHolderPid();
    if (waitedOn && holderNow && holderNow !== waitedOn) {
      log(
        `等的那把锁（PID ${waitedOn}）已经换到 PID ${holderNow} 手里 —— 有人接手了，让给它，等它起好`,
      );
      if (await waitUntilUp(PORT, START_HANDOFF_MS)) {
        const pids = listeners(PORT);
        log(`等到了：接手方已经把控制面起好（PID ${pids.join('、') || '读不到'}）—— 直接复用`);
        return { action: 'already', url: urlOf(PORT), pids };
      }
      return {
        action: 'failed',
        url: urlOf(PORT),
        reason: `接手的窗口（PID ${holderNow}）${Math.round(
          START_HANDOFF_MS / 1000,
        )} 秒内也没把服务起好`,
      };
    }

    /*
     * 预算烧完、持有人在、服务却没起来。这就是"对方卡住了" —— 明确接手，别让用户对着
     * 一个永远不出现的窗口。`ensureRunning` 自己会把端口上那个僵死的自己人收掉重起，
     * 所以这里不会变成"两个控制面抢一个端口"。
     */
    log(
      `另一个窗口（PID ${lockHolderPid() || '?'}）${Math.round(
        START_TOTAL_BUDGET_MS / 1000,
      )}s 都没把服务起好 —— 不等了，**接手自己起**`,
    );
    /*
     * **强制接手**（QA 打回的第 ④ 条）：这里同样不能"删了再造" —— 两个都等满 15 秒的壳会互相
     * 删对方刚建的新锁，然后各起一个控制面（`database is locked` 就是这么来的）。
     *
     * 改成原子改名 + **核对 token**：把"我判定要接手时看到的这一把"读下来，改名后对不上，
     * 说明另一个壳已经抢先接手、我拖走的是它的新锁 —— 原样放回、让给它。
     * 让路之后**先等它把服务起好**（`START_HANDOFF_MS`），等服务起来就按"复用"返回，
     * 而不是转头去抢锁（那会把它刚起的服务又搅乱）。
     */
    const stuckToken = lockToken();
    let tookOver = false;
    try {
      tookOver = takeoverStartLock(stuckToken);
    } catch (e) {
      log(`强制接手 start.lock 失败（${e.code ?? e.message}）—— 交给下一步正常抢锁`);
    }
    if (!tookOver) {
      log('这把锁已经被另一个窗口接过去了 —— 让给它，等它把服务起好');
      if (await waitUntilUp(PORT, START_HANDOFF_MS)) {
        const pids = listeners(PORT);
        log(`等到了：接手方已经把控制面起好（PID ${pids.join('、') || '读不到'}）—— 直接复用`);
        return { action: 'already', url: urlOf(PORT), pids };
      }
    }
    if ((await acquireStartLock(1500)) === 'ok') {
      try {
        return await ensureRunning(ensureOptions());
      } finally {
        releaseStartLock();
      }
    }
    return {
      action: 'failed',
      url: urlOf(PORT),
      reason: `另一个窗口一直占着"起服务"，等了 ${Math.round(START_TOTAL_BUDGET_MS / 1000)} 秒也没能接手`,
    };
  }
}

fs.mkdirSync(DATA, { recursive: true });
log(`数据目录 ${DATA}`);

/* 一启动就登记（端口未知时也登记）—— 见 enroll 的注释 */
enroll(null);

/* ---------------------------------------------------------------- 定端口 */

let PORT = Number(process.env.BANDI_PORT ?? 0);
let mode = 'explicit';
if (!PORT) {
  const picked = await pickPort();
  if (picked.mode === 'none') {
    log(picked.error);
    leave();
    emit(`BANDI_SHELL FAILED ${picked.error}`);
    process.exit(3);
  }
  PORT = picked.port;
  mode = picked.mode;
  recordPort(PORT);
}

/* 端口确定了，把登记补上端口号（人排查时能一眼看到"这个窗口用的是哪个端口"） */
enroll(PORT);

log(
  `端口 ${PORT}（${
    mode === 'explicit' ? '环境变量指定的' : mode === 'reuse' ? '复用已有实例' : '自己挑的'
  }）`,
);
log(`控制面 ${urlOf(PORT)}`);

/* ---------------------------------------------------------------- 起控制面 */

/*
 * **必须包 try/catch**（QA 打回的第 3 条）：`ensureRunning` 里会做真实 IO ——
 * `startDetached` 要 `openSync(server.log, 'a')`、要 spawn 进程。任何一步抛出来
 * （实测踩到过 `EPERM`：server.log 被别的程序锁着 / 数据目录权限不对），
 * 不接住就是"壳直接崩掉、一个协议行都不给" —— Rust 那边只能等到 45 秒超时，
 * 用户看到的是「等了 45 秒还没就绪」，而不是真正的原因。
 */
let r;
try {
  r = await startControlPlane();
} catch (err) {
  const msg = String(err?.message ?? err);
  log(`起控制面时炸了：${msg}`);
  dropPendingService(); // 也许就在 `onSpawn` 之后炸的：别把一条"这是我起的"留在盘上
  leave(); // 我没成事，别在登记簿上留一个"还在用"的假象
  emit(`BANDI_SHELL FAILED ${msg}`);
  process.exit(3);
}

/**
 * **迟到的健康**（2026-10-22 第三轮）。
 *
 * `ensureRunning` 的健康等待是 30 秒，超时就报 failed —— 但超时不等于没起来：
 * 大库迁移 / 杀毒扫描 / 慢盘上，进程经常 30 秒后才开始应答。原来的做法是立刻给
 * `BANDI_SHELL FAILED`，用户看到「班底没起来」那张错误页，而服务下一秒就好了 —— 白折腾。
 *
 * 这里再给 `LATE_START_GRACE_MS`：Rust 给的 READY 预算是 45 秒，30 + 7 + 取令牌(≤3s)
 * 仍在预算内。真等到了就按「这次是壳起的」继续走后面的正常分支（写记录、报 READY）；
 * 等不到才认输。这一步**不改 ensureRunning 本身** —— 命令行那条路不该陪着桌面版多等。
 */
const LATE_START_GRACE_MS = 7000;
if (r.action === 'failed' && Number(r.pid) > 0 && listeners(PORT).includes(Number(r.pid))) {
  log(
    `健康等待超时，但 PID ${r.pid} 还在端口 ${PORT} 上 —— 再等 ${Math.round(
      LATE_START_GRACE_MS / 1000,
    )} 秒（可能只是起得慢）`,
  );
  if (await waitUntilUp(PORT, LATE_START_GRACE_MS)) {
    log('迟到的控制面已经应答 —— 按「这次是壳起的」继续');
    r = { action: 'started', url: urlOf(PORT), pid: Number(r.pid) };
  } else {
    log('还是没应答 —— 认输，把这个原因原样交给 Rust 的错误页');
  }
}

/**
 * 窗口该开在哪个地址。
 *
 * ⚠️ 开了「允许局域网内的机器加入」之后，控制面就**要求令牌**了（"只看监听地址"那条规则 ✓）——
 * 于是桌面版自己那个窗口也会撞上登录页 ✗。壳能读到同一台机器上的令牌文件，
 * 所以直接把令牌带上：`?token=…` 会让服务端设好 Cookie 再跳回干净地址 ✓（那正是它的用途 ✓）。
 *
 * 只在**真被要求**时才带（拿 401 试探一下 ✓）：回环模式下带上它，地址栏里会留一串没用的令牌 ✗。
 */
async function windowUrl(url) {
  try {
    const probe = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (probe.status !== 401) return url;
  } catch {
    return url; // 探测不了就按原样开，别把壳卡在这儿
  }
  try {
    const token = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
    if (!token) return url;
    return `${url.replace(/\/$/, '')}/?token=${encodeURIComponent(token)}`;
  } catch {
    return url;
  }
}

const WINDOW_URL = r.url ? await windowUrl(r.url) : '';
if (WINDOW_URL !== r.url) log('这次要令牌（局域网模式）—— 已把令牌带进窗口地址，免登录');

if (r.action === 'already') {
  const alive = aliveClients();
  log(
    `已经在跑（PID ${(r.pids ?? []).join(', ') || '读不到'}）—— 复用；我是第 ${alive.length} 个窗口，` +
      '退出时按「还有谁在用」决定收不收',
  );
  /*
   * **当场给旧记录做体检**（QA R2-A 第 2 条）：记录指的那个 PID 已经不在了就立刻作废。
   * 这是"复用方不认领、但必须管一眼"的那道分界线 —— 不认领是怕冒名，
   * 放任一条死记录留下则是给后面每一次收摊埋雷（实测会误杀命令行起的活服务）。
   */
  const rec = readService();
  const recState = auditServiceRecord(rec, r.pids);
  if (recState === 'none') {
    log('但没有 service.json：这个服务不是壳起的（命令行/开机自启）—— 退出时我一个都不会动它');
  } else if (recState === 'void') {
    log('（这条旧记录已经作废：它既不能当凭据，也不会再被谁拿去按端口收 —— 这个服务不是壳起的）');
  } else if (recState === 'unknown') {
    log(
      `读不到端口 ${PORT} 上到底是谁在听 —— 不去动 service.json` +
        `（里面记的还是 PID ${rec.pid}，是死是活下一次收摊再验）`,
    );
  } else {
    log(`service.json 记的 PID ${rec.pid} 确实在这个端口上 —— 记录有效，退出时按记录收`);
  }
  emit(`BANDI_SHELL READY ${WINDOW_URL} 0`);
} else if (r.action === 'started') {
  /*
   * **只在"这次是我起的"时才写 service.json**：这份记录是收摊的唯一凭据，
   * 复用的那个壳不写 —— 它没资格声称服务是自己的（那正是 2026-10-15 误杀的近亲）。
   *
   * 写之前过一道**核对**（`recordVerifiedService`）：只记端口上真在听的那个 PID。
   * 并发启动时"我刚起的那个"可能已经 EADDRINUSE 崩了，照抄会给收摊留下一条死记录。
   */
  const recorded = recordVerifiedService(r.pid, PORT);
  const alive = aliveClients();
  /*
   * 核对不过（返回 null）时**别急着说"没写"**：`onSpawn` 早就落了一条 `pending` 记录，
   * 它是"这服务是壳起的"唯一凭据。端口上那个监听者认不出来（命令行读不到）时，
   * 宁可留着带 PID 的待定记录、让收摊时再验，也好过一句"没写"把它变成孤儿。
   */
  const kept = recorded ? null : readService();
  log(
    `起来了（PID ${r.pid}）—— service.json 记的是 ${
      recorded
        ? `PID ${recorded}（已核对）`
        : kept?.pid
          ? `PID ${kept.pid}（**待定**：端口上没核对到，先按我起的那个记着，收摊时再验）`
          : '空（没写：端口上也没核对到我们的服务）'
    }；我是第 ${alive.length} 个窗口，退出时由**最后一个**窗口收掉它`,
  );
  emit(`BANDI_SHELL READY ${WINDOW_URL} 1`);
} else if (r.action === 'alien') {
  const who = (r.alien ?? []).map((a) => `PID ${a.pid} ${a.name ?? ''} ${a.cmd ?? ''}`.trim()).join(' | ');
  log(`端口 ${PORT} 被别的程序占着，我没动它：${who}`);
  leave(); // 我没成事，别在登记簿上留一个"还在用"的假象
  emit(`BANDI_SHELL ALIEN 端口 ${PORT} 被别的程序占着：${who}`);
  process.exit(2);
} else {
  log(`没起来：${r.reason}`);
  if (r.logTail) log(r.logTail);
  /*
   * 撤待定记录之前先核实一件事（2026-10-22 第三轮）：**「30 秒健康等待超时」不等于
   * 「进程没起来」**。大库迁移 / 杀毒扫描 / 慢盘上，进程经常还活着、只是还没开始应答。
   *
   * 旧写法无条件 `dropPendingService()`：服务后来起来了，盘上却一条凭据都不剩 →
   * 后面每个壳都判「这服务不是壳起的」→ 谁都不收 → **永久孤儿**（只有手动 taskkill 能清）。
   * 所以：PID 还在端口上听 → 保留这条待定记录（壳退出后下一个窗口会复用并认出它）；
   * 真不在 → 才撤。这里**不强杀**那个进程：它可能下一秒就健康，杀了等于把慢启动判死刑。
   */
  const latePid = Number(r.pid) > 0 ? Number(r.pid) : 0;
  const lateAlive = latePid ? listeners(PORT).includes(latePid) : false;
  if (lateAlive) {
    log(
      `不过 PID ${latePid} 还在端口 ${PORT} 上 —— **保留待定记录**（它可能只是起得慢），` +
        '下一个窗口会认得出这是壳起的服务',
    );
  } else {
    dropPendingService(r.pid);
  }
  leave();
  emit(`BANDI_SHELL FAILED ${r.reason}`);
  process.exit(3);
}

/* ------------------------------------------------- 自愈（watchdog，2026-10-22 第三轮） */

/**
 * 控制面**在窗口还开着的时候死掉**（崩溃 / 被误杀 / 被 `bandi stop`），以前没有任何人
 * 负责把它拉起来：Rust 的 `watch_service` 只做「探不通→换兜底页、通了→跳回去」，
 * 兜底页是 `data:` URL（origin=null）连 fetch/IPC 都发不出去。
 * 于是窗口会永远停在离线页上，而那一页写着「正在自动恢复」—— 用户等的是一个不会发生的事。
 *
 * 这条 watchdog 补的就是那一半：**只要本窗口还开着，服务就该在**。
 *   · 3 秒探一次（和心跳同频），连续 2 次探不通才动手（一次 GC / 长同步操作不该翻页）；
 *   · 动手就是走**原来那条 `startControlPlane()`** —— 锁、待定记录、端口核对、alien 判断
 *     全都是现成的，不另写一套「重启」逻辑（那会多出第二份真相）；
 *   · 成功后补一条 `recordVerifiedService`：否则「这次是我起的」没有凭据，下次收摊空手；
 *   · 失败退避 30 秒：`bandi stop` / 端口被别的程序占着时不能每 3 秒无脑重起。
 *
 * 服务一旦回来，Rust 的巡检会在 1 秒内把窗口导航回控制面 —— 页面自己什么都不用做。
 *
 * ⚠️ 已知取舍：窗口开着时用户在命令行 `bandi stop`，这里会在 ~6~10 秒内把服务又拉起来。
 * 桌面窗口本来就需要控制面才可用，这个方向的"多管闲事"比"窗口变砖"好；真要尊重手动 stop，
 * 让 CLI 写一个 `stopped-by-user` 标记、这里见到就退出即可（未做）。
 */
const HEAL_INTERVAL_MS = 3000;
/** 连续几次探不通才动手。1 次太敏感（服务端一次 >800ms 的同步任务就会误判）。 */
const HEAL_MISSES = 2;
/** 起失败后的退避。避免 alien / 起不来时每 3 秒重试一遍、把日志刷满。 */
const HEAL_BACKOFF_MS = 30000;

let watchdogTimer = null;
let downTicks = 0;
let healing = false;
let healAfter = 0;

function startWatchdog() {
  if (watchdogTimer) return;
  /*
   * 整段包 try/catch：定时器回调里抛出来的异常**没有人接** —— Node 会把它当成
   * unhandled rejection 直接退出进程（用户看到窗口突然没了，比断连更难解释）。
   * 巡检这种"锦上添花"的东西，出错只能自己咽下去。
   */
  watchdogTimer = setInterval(async () => {
    try {
      if (stopping || healing || Date.now() < healAfter) return;
      if (await isUp(PORT)) {
        downTicks = 0;
        return;
      }
      downTicks += 1;
      if (downTicks < HEAL_MISSES) return; // 去抖：再探一次，别把一次抖动当崩溃

      downTicks = 0;
      healing = true;
      try {
        log('控制面探不通（窗口还开着）—— 开始自动恢复');
        const rr = await startControlPlane();
        if (rr.action === 'started') {
          const recorded = recordVerifiedService(rr.pid, PORT);
          log(
            `自动恢复成功（PID ${rr.pid ?? '?'}，端口 ${PORT}）` +
              (recorded ? '' : ' —— 端口上没核对到，按待定记录留着，收摊时再验'),
          );
        } else if (rr.action === 'already') {
          // 别的窗口 / 命令行刚好也拉起来了：直接复用，别再起第二个
          log('自动恢复：控制面已经被别的窗口/命令行拉起，直接复用');
        } else {
          throw new Error(rr.reason || rr.action);
        }
      } catch (e) {
        healAfter = Date.now() + HEAL_BACKOFF_MS;
        log(
          `自动恢复失败：${String(e?.message ?? e)}（${Math.round(HEAL_BACKOFF_MS / 1000)} 秒后再试）`,
        );
      } finally {
        healing = false;
      }
    } catch (e) {
      // 连探活都炸了：退避，别每 3 秒刷一遍日志
      healAfter = Date.now() + HEAL_BACKOFF_MS;
      log(`自动恢复巡检自身出错：${String(e?.message ?? e)}（${Math.round(HEAL_BACKOFF_MS / 1000)} 秒后再试）`);
    }
  }, HEAL_INTERVAL_MS);
  // 定时器不能把进程钉住：收摊靠退出信号，不靠它
  watchdogTimer.unref?.();
}

/* 走到这儿说明窗口已经开起来了（三条 READY 分支都在这儿汇合）—— 开始看住服务 */
startWatchdog();

/* ------------------------------------------------------------------ 收摊 */

let stopping = false;

/**
 * 收摊。**异步**：收不掉时要等端口真正空出来，才知道那条 `service.json` 记录该不该作废。
 *
 * 顺序：撤自己的登记 → 看还有没有别的窗口 → 一个不剩才收服务。
 */
async function shutdown(why) {
  if (stopping) return;
  stopping = true;

  /* ⓪ 自愈定时器先停：一边收摊、一边又把服务拉起来，是最坏的一种打架 */
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  /* ① 先撤掉自己 —— 不撤的话下面的扫描永远能看见"我自己还活着" */
  leave();
  // 顺手放锁：正常路径在 startControlPlane 的 finally 里已经放了，这里兜住"起服务途中收到退出信号"
  releaseStartLock();

  /*
   * ② 和「正在起服务的别人」互斥，**拿到锁之后再扫登记簿**。
   * 锁在手 → 这段时间不会有新壳走完「探活 → 复用 → READY」，下面杀服务才不会误伤它。
   * 等不到就保守留着（见 `SHUTDOWN_LOCK_WAIT_MS` 的注释）。
   */
  const guard = await acquireStartLock(SHUTDOWN_LOCK_WAIT_MS);
  if (guard === 'busy') {
    log(
      `退出（${why}）：另一个窗口正在起服务 —— **服务一律不动**（它马上要用），` +
        '留着最多是多活一会儿，杀掉就是把它甩在"连不上"上',
    );
    process.exit(0);
  }
  /** 收摊期间所有出口都要放锁 —— `process.exit` 不执行 finally，只能显式放。 */
  const finish = (code = 0) => {
    releaseStartLock();
    process.exit(code);
  };

  /* ②-b 等锁这几百毫秒里可能有新窗口登记进来 —— **必须复扫**，这就是竞态的修法本身 */
  const alive = aliveClients();

  if (alive.length) {
    log(
      `退出（${why}）：还有 ${alive.length} 个窗口在用（PID ${alive
        .map((a) => a.pid)
        .join('、')}）—— **服务留着**，不能把它们的窗口甩在"连不上"上`,
    );
    finish(0);
  }

  /* ③ 一个窗口都不剩了，收摊 */
  const rec = readService();
  if (!rec || !rec.pid) {
    log(`退出（${why}）：最后一个窗口，但没有 service.json（这服务不是壳起的）—— 留着不动`);
    finish(0);
  }
  /*
   * 已作废的记录 = 没有记录（QA R2-A）。上面复用分支体检出来的那种：
   * 指向一个早就不在的 PID，而且**那服务根本不是壳起的**（命令行 / 开机自启）。
   * 这里要是还拿它当凭据，就是 2026-10-22 那次误杀的原样重演。
   */
  if (rec.stale) {
    log(
      `退出（${why}）：最后一个窗口，但 service.json 是**已作废**的旧记录` +
        `（PID ${rec.pid}：${rec.staleReason || '指向的进程早就不在了'}）—— 留着不动`,
    );
    finish(0);
  }

  const port = Number(rec.port) || 0;
  /*
   * 按**记录下来的 PID** 收，而不是再问一遍"端口上是谁"。
   * 后者在 Windows 上要 `powershell` 读命令行，环境一退化就读不到，
   * 于是会把**自己刚起的进程**误判成外人、拒绝清理，留下孤儿（2026-10-15 实测踩到）。
   */
  const s = stopPid(Number(rec.pid));
  const verdict =
    s.verified === 'match'
      ? '命令行核对过'
      : s.verified === 'unknown'
        ? '读不到命令行，按记录处理'
        : s.verified === 'mismatch'
          ? '命令行对不上（PID 大概已被别人复用），没动它'
          : '记录里没有可用 PID';

  let stopped = s.stopped;
  let note = '';

  /*
   * **归属校验**（QA R2-A 第 1 条，2026-10-22 补）：端口兜底只对**本壳自己写的**记录生效。
   *
   * 为什么必须加这一道：`isOurs` 只能回答"端口上那个是不是 bandi 服务"，
   * 回答不了"这个服务是**壳**起的、还是命令行 / 开机自启起的"。旧记录（写它的那个壳早没了）
   * 一旦被当成凭据，兜底就会把**用户自己在命令行里起的活服务**当成"我们的"收掉 ——
   * 实测：`service.json{pid:999998(早已不存在)}` + `start.cmd` 起的服务 → 关窗口 → 服务被杀。
   *
   * 而"不是壳起的就不动"是桌面壳对用户的承诺（`docs/形态决策.md`：壳只收拾自己造的东西）。
   * 于是判据落到 `byPid`：记录里写着**是哪个壳**把它起的。不是我就一律不动端口 ——
   * 记的 PID 还在就直接按 PID 收（那是明确的凭据，属于所有人共有的"最后一个窗口"语义），
   * 收不到就只留记录、只写日志，绝不退化成"按端口猜一遍"。
   */
  const mine = Number(rec.byPid) === process.pid;
  const pendingTag = rec.pending ? '（待定记录，没经过端口核对）' : '';

  if (!stopped) {
    if (!mine) {
      const left = oursOnPort(port);
      if (!left.length) {
        // 端口上已经没有我们自己的服务了：服务本身就不在了，等同于"收干净"
        stopped = true;
        note =
          `记录里的 PID ${rec.pid} 没收到（${verdict}${pendingTag}），` +
          `端口 ${port || '?'} 上也没有我们的服务 —— 记录的那个服务已经不在了`;
      } else {
        note =
          `记录里的 PID ${rec.pid} 没收到（${verdict}${pendingTag}）；端口 ${port} 上还坐着自己的服务` +
          `（PID ${left.join('、')}），但这条记录不是我写的（byPid ${rec.byPid || '?'}）—— ` +
          '**不是壳起的就不动端口**，一个都没碰';
      }
    } else {
      /*
       * **收摊兜底**（QA 打回的第 ① 层）：记录里的 PID 可能是个**已经崩掉的** PID ——
       * 并发启动时"我起的那个"抢端口失败 EADDRINUSE 就没了，而记录要是（旧版本）照抄了它，
       * 按 PID 收就只能空手，服务变成孤儿。
       *
       * 这时按**端口**再收一次，但只收**我们自己的**（`stopRunning` 内部就是 `isOurs`
       * 命令行核验，一点没放宽）：端口上坐着别人的程序，一个都不许动。
       * 而这条路只对 `byPid === 我` 的记录开（见上面那段）——我起的、我记的，我才兜这个底。
       */
      const ours = oursOnPort(port);
      if (ours.length) {
        const pr = stopRunning(port);
        await waitPortFree(port, 4000);
        stopped = oursOnPort(port).length === 0;
        note =
          `记录里的 PID ${rec.pid} 没收到（${verdict}${pendingTag}）；` +
          `按端口 ${port} 兜底收了 ${pr.stopped} 个自己人（PID ${ours.join('、')}）` +
          (stopped ? '，端口已经空了' : `，端口还被 PID ${oursOnPort(port).join('、')} 占着`);
      } else {
        // 端口上已经没有我们自己的服务了：服务本身就不在了，等同于"收干净"
        stopped = true;
        note =
          `记录里的 PID ${rec.pid} 没收到（${verdict}${pendingTag}），` +
          `端口 ${port || '?'} 上也没有我们的服务 —— 记录的那个服务已经不在了`;
      }
    }
  }

  if (s.stopped) {
    log(`退出（${why}）：最后一个窗口，收掉服务 PID ${rec.pid}（端口 ${port || '?'}）—— ${verdict}`);
  } else {
    log(`退出（${why}）：${note}`);
  }

  if (stopped) {
    /*
     * 记录用一次就作废：下一次谁起服务谁来写。留着它只会让"上一次的 PID"在后面某次
     * 收摊时被当成真的（PID 会被回收 —— 那才是最危险的那种误杀）。
     */
    forgetService();
  } else {
    /*
     * **没收干净就别删记录**：留着它是下一次收摊（或用户手动排查）唯一的线索。
     * 删掉才真成了孤儿 —— 谁都不知道那个 PID 曾经属于我们。
     */
    log(`⚠️ 服务没收干净（PID ${rec.pid}，端口 ${port || '?'}）—— service.json **保留**，下次收摊再收`);
  }
  finish(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  if (String(c).trim().split(/\s+/).includes('STOP')) void shutdown('STOP');
});
// 壳要是直接没了，stdin 会被关掉 —— 这是最可靠的一个"该收摊了"信号
process.stdin.on('end', () => void shutdown('stdin 关闭'));
process.stdin.resume();

log('就绪，等壳的退出信号（STOP / stdin 关闭 / SIGTERM）');
