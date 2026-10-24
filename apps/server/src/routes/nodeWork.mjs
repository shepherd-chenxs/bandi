/* routes/nodeWork.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import os from 'node:os';
import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as runs from '../runs.mjs';
import * as runtimes from '../runtimes.mjs';
import * as externals from '../externals.mjs';
import * as connectors from '../connectors.mjs';
import * as status from '../status.mjs';

const CLAIM_POLL_MS = 250;
const CLAIM_MAX_WAIT_MS = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * **本机就地执行**一件安装任务（2026-10-21）：「设置 → 这台机器 → 未安装 → 在这台机器上安装」。
 *
 * 为什么要有这一条：远程节点那侧是"控制面排任务 → 节点领走 → 节点自己查表跑"；
 * 而单机形态下本机（id=`local`）没有节点进程来领活，任务会永远"待领"。
 * 本机就是控制面自己，所以排完任务由本进程直接跑。
 *
 * ⚠️ **安全边界和节点那条完全一样**：调用方只能发**族名**，命令永远来自
 * `runtimes.installCommandFor` 这张写死在代码里的表 —— 这里没有"传什么跑什么"的口子。
 *
 * Windows 上 `npm` 是 .cmd 垫片：Node 22 直接 spawn 它会 EINVAL（实测，见 connectors.mjs
 * 的 launcher 注释），所以过一层 `cmd /c` —— 拼进去的仍是表里的固定字符串，没有用户输入。
 * 输出节流写回任务行（界面每 1.5 秒读回来），装完的清单本机是**现探**的，不用额外上报。
 */
async function runLocalInstall(taskId) {
  const task = store.claimNodeTaskById(taskId);
  if (!task) return; // 已经被领走 / 已经结束：不重复执行
  const spec = runtimes.installCommandFor(task.family);
  if (!spec) {
    store.appendNodeTaskOutput(task.id, '这台机器上的班底不认识这个族，或者它不是一条命令能装的\n');
    return store.finishNodeTask(task.id, '失败');
  }
  const isWin = process.platform === 'win32';
  const file = isWin ? process.env.ComSpec || 'cmd.exe' : spec.bin;
  const args = isWin ? ['/c', spec.bin, ...spec.args] : spec.args;

  let buf = '';
  let lastAt = 0;
  const flush = (force = false) => {
    if (!buf) return;
    const now = Date.now();
    if (!force && now - lastAt < 400) return;
    lastAt = now;
    const chunk = buf;
    buf = '';
    store.appendNodeTaskOutput(task.id, chunk);
  };

  console.log(`[本机] 开始安装 ${task.family}：${spec.cmd}`);
  let child;
  try {
    const { spawn } = await import('node:child_process');
    child = spawn(file, args, { cwd: os.homedir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    store.appendNodeTaskOutput(task.id, `起不来：${[e?.code, e?.message].filter(Boolean).join(' ')}\n`);
    return store.finishNodeTask(task.id, '失败');
  }
  const onData = (c) => {
    buf += String(c);
    flush();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  let settled = false; // 'error' 与 'close' 只许收尾一次，别把任务判两遍
  const finish = (status, extra = '') => {
    if (settled) return;
    settled = true;
    clearTimeout(killer);
    if (extra) {
      buf += extra;
      flush(true);
    }
    store.finishNodeTask(task.id, status);
  };
  // 兜底超时：npm 卡死（网络挂起）不该让这一行永远"执行中"
  const killer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  }, 15 * 60 * 1000);
  killer.unref();
  child.on('error', (e) => {
    finish('失败', `起不来：${e?.message ?? e}\n`);
    console.log(`[本机] 安装 ${task.family} 失败：${e?.message ?? e}`);
  });
  child.on('close', (code) => {
    const ok = code === 0;
    finish(ok ? '完成' : '失败', ok ? '\n装完了。\n' : `\n（${spec.bin} 退出码 ${code}）\n`);
    console.log(`[本机] 安装 ${task.family}${ok ? '装好了' : `失败了（退出码 ${code}）`}`);
  });
}

/**
 * 领活三件事：**领**（长轮询）/ **回传事件** / **报回执**。
 *
 * 为什么不是"控制面推给节点"：出站连接是多机方案里唯一不用开端口、不用打洞的形态，
 * 而"推"要求能连到节点。所以反过来 —— 节点挂着等（长轮询），有活立刻拿到。
 *
 * 事件批次的**响应里带回 `stop`**：这是反向的控制通道。人点了停止，不需要另开一条连接，
 * 下一个批次就把话带到，节点自己掐子进程。
 */
export async function handleNodeWork(req, res, url) {
  const claim = /^\/api\/nodes\/([^/]+)\/claim$/.exec(url.pathname);
  const events = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
  const done = /^\/api\/runs\/([^/]+)\/finish$/.exec(url.pathname);
  const tasks = /^\/api\/nodes\/([^/]+)\/tasks$/.exec(url.pathname);
  const oneTask = /^\/api\/nodes\/([^/]+)\/tasks\/([^/]+)$/.exec(url.pathname);
  const taskReport = /^\/api\/nodes\/([^/]+)\/tasks\/([^/]+)\/report$/.exec(url.pathname);

  /*
   * 一键安装 —— 排一个「让那台机器做件小事」。
   *
   * ⚠️ 只接受**族名**：命令表在节点那侧（`runtimes.installCommandFor`），控制面发不出命令。
   * 谁拿着令牌就能在每台节点上装软件，所以这条边界是这件事成立的前提，不是"顺手的设计"。
   *
   * 本机（id=`local`）2026-10-21 起也走这里：单机形态下没有节点进程来领活，
   * 所以排完任务由**控制面自己执行**（见 runLocalInstall）—— 边界不变，
   * 命令还是那张固定表里的，前端照样只能发族名。
   */
  if (req.method === 'POST' && tasks) {
    const nodeId = decodeURIComponent(tasks[1]);
    const isLocal = nodeId === runtimes.LOCAL_ID;
    if (!isLocal && !store.getNode(nodeId)) return fail(res, 404, 'E2041', '这个节点没登记过');
    const body = await readBody(req);
    const kind = String(body?.kind ?? '');
    const target = String(body?.family ?? body?.id ?? '');

    /*
     * 两种"小事"，共用一套队列：装一个**运行时**（agent CLI），或处理一个**外部件**的某一步
     * （装上 / 装成常驻服务）。命令表都在**节点那侧**，控制面只发 id 与步骤。
     */
    let spec = null;
    if (kind === 'install-runtime') {
      spec = runtimes.installCommandFor(target);
      if (!spec) {
        return fail(res, 400, 'E1044', `「${target || '(没给族名)'}」没法一键安装 —— 它要么不是这三个族之一，要么形态上就不是 npm 装的（比如 dsh 是 Windows 桌面端自带的）。去那台机器上手工装。`);
      }
      const task = store.enqueueNodeTask({ nodeId, kind, family: target });
      console.log(`[节点] 给 ${nodeId} 排了个任务：${kind} ${target}`);
      if (isLocal) void runLocalInstall(task.id); // 本机：控制面当场跑，不等谁来领
      return sendJson(res, 201, { task: store.publicNodeTask(task), willRun: spec.cmd });
    } else if (kind === 'external-install' || kind === 'external-serve') {
      // 本机不给外部件一键（2026-10-16 定的边界，别被"本机也能装运行时"带偏）：
      // 那是 `curl … | sh`，控制面直接跑不合适 —— 界面上给复制命令，用户自己在终端粘。
      if (isLocal) {
        return fail(res, 400, 'E1043', '本机不给外部件一键安装 —— 复制那条命令，在终端里粘一下更清楚');
      }
      const step = kind === 'external-install' ? 'install' : 'serve';
      /*
       * 走镜像装：`mirror` 是个**参数**，不是命令 —— 它会先过 externals.mirrorOk()
       * （它要被拼进 `sh -c '… --mirror "<前缀>"'`，所以带 shell 元字符的一律拒）。
       * 不能过就直接 400，别让它跑到那台机器上再失败。
       */
      const mirror = String(body?.mirror ?? '').trim();
      if (mirror && !externals.mirrorOk(mirror)) {
        return fail(res, 400, 'E1046', '镜像前缀里不能有空格、引号、反引号、$、;、|、& 这些字符（它会被拼进 shell 命令）—— 给一个普通的 https:// 前缀');
      }
      // 按**那台节点**的平台判（控制面在 Linux，节点可能是 Windows）
      spec = externals.commandFor(step, target, store.getNode(nodeId)?.platform, { mirror });
      if (!spec) {
        return fail(res, 400, 'E1045', `「${target}」的这一步在**那台机器**上没法一键做（比如 Windows 上 magpie 是桌面安装包，没有一条命令）。去那台机器上手工装。`);
      }
      const task = store.enqueueNodeTask({ nodeId, kind, family: target, arg: mirror || null });
      console.log(`[节点] 给 ${nodeId} 排了个任务：${kind} ${target}${mirror ? `（走镜像 ${mirror}）` : ''}`);
      return sendJson(res, 201, { task: store.publicNodeTask(task), willRun: spec.cmd });
    } else {
      return fail(res, 400, 'E1043', '只认这三种小事：install-runtime / external-install / external-serve');
    }
  }

  // 界面轮询"装到哪一步了"
  if (req.method === 'GET' && oneTask) {
    const t = store.getNodeTask(decodeURIComponent(oneTask[2]));
    if (!t || t.nodeId !== decodeURIComponent(oneTask[1])) return fail(res, 404, 'E2043', '没有这个任务');
    return sendJson(res, 200, { task: store.publicNodeTask(t) });
  }

  // 节点回执：边跑边报输出，跑完报终态
  if (req.method === 'POST' && taskReport) {
    const t = store.getNodeTask(decodeURIComponent(taskReport[2]));
    if (!t || t.nodeId !== decodeURIComponent(taskReport[1])) return fail(res, 404, 'E2043', '没有这个任务');
    const body = await readBody(req);
    if (body?.output) store.appendNodeTaskOutput(t.id, body.output);
    if (body?.status === '完成' || body?.status === '失败') {
      store.finishNodeTask(t.id, body.status);
      console.log(`[节点] ${t.nodeId} 的安装任务${body.status === '完成' ? '装好了' : '失败了'}：${t.family}`);
    }
    return sendJson(res, 200, { task: store.publicNodeTask(store.getNodeTask(t.id)) });
  }

  /**
   * 发一个**一次性邀请码**（10 分钟、只用一次）—— 新机器凭它加入。
   *
   * 只有操作员能用：节点令牌的权限边界里没有这条（见 auth.nodeMayReach）✓。
   */
  if (req.method === 'POST' && url.pathname === '/api/nodes/invites') {
    const inv = store.createInvite();
    console.log('[节点] 发了一个邀请码（10 分钟内有效，只用一次）');
    return sendJson(res, 201, inv);
  }

  /**
   * **加入**：一台新机器凭邀请码换回**只属于它自己**的那枚令牌。
   *
   * 为什么要有这一步（2026-10-16）：原来节点直接用总机那枚 master 令牌 ✗ ——
   * 一台被翻等于整套被翻，而且「忘掉」踢不掉它。现在换成"一次性码 → 每节点一枚"：
   * 权限只到它自己那台的节点接口 ✓，可逐台吊销 ✓。
   *
   * 这条**不需要令牌**（新机器还没有），凭据就是邀请码本身 ✓；用了就作废 ✓。
   */
  if (req.method === 'POST' && url.pathname === '/api/nodes/join') {
    const body = await readBody(req);
    const code = String(body?.code ?? '').trim();
    const id = String(body?.id ?? '').trim();
    if (!id) return fail(res, 400, 'E1047', '加入要带上你自己的 id');
    /*
     * `scope`（2026-10-20，设计 §5.8）：这台机器用来做什么 —— `compute` / `panel` 可同时具备。
     *
     * ⚠️ **前端 wire 发 `scopes` 数组**（复数键优先），此处统一归一进 `normScope` ——
     * 只读单数键的话，前端那份数组会被静默忽略、按缺省落成 `compute`，
     * "当入口也能干活"的机器就只拿到算力令牌（静默降级，QA 实测堵掉的就是它）。
     *
     * **缺省 `compute`**：老的 `node.mjs --join`（它一个字节不改）照旧能用，且行为与改前完全一致。
     * 校验放在**消耗邀请码之前**：非法值不该把一个一次性邀请码白白烧掉。
     * 码沿用 `E1047`（与"加入要带 id"同码，不新增）。
     */
    const scopeInput = body?.scopes ?? body?.scope;
    if (!store.scopeIsValid(scopeInput)) {
      return fail(res, 400, 'E1047', '这台机器的用途只认「算力」(compute) 与「面板」(panel) 的组合');
    }
    const scope = store.normScope(scopeInput);
    if (!store.consumeInvite(code, id)) {
      return fail(res, 401, 'E4011', '邀请码不对、已经用过、或者过期了 —— 让控制面上重新生成一个（10 分钟有效、只用一次）');
    }
    const label = String(body.label ?? id).trim() || id;
    store.upsertNode({
      id,
      label,
      hostname: String(body.hostname ?? label).trim() || label,
      platform: body.platform ? String(body.platform) : null,
      runtimes: Array.isArray(body.runtimes) ? body.runtimes : [],
      externals: Array.isArray(body.externals) ? body.externals : null,
    });
    const token = store.issueNodeToken(id, scope);
    console.log(`[节点] ${label} 用邀请码加入了（${id}）—— 给了它自己一枚令牌，权限「${scope}」`);
    return sendJson(res, 201, {
      token,
      node: runtimes.publicDeviceById(id),
      heartbeatSeconds: runtimes.NODE_HEARTBEAT_SEC,
      // 回显：节点侧据此自检"总机记下的权限"与"我以为的"是不是同一份
      scope,
    });
  }

  if (req.method === 'POST' && claim) {
    const nodeId = decodeURIComponent(claim[1]);
    if (!store.getNode(nodeId)) return fail(res, 404, 'E2041', '这个节点没登记过，先调 /api/nodes/register');
    const body = await readBody(req);
    const waitMs = Math.min(Math.max(Number(body?.waitMs ?? 0) || 0, 0), CLAIM_MAX_WAIT_MS);
    const until = Date.now() + waitMs;

    /*
     * ⚠️ **要盯着请求方还在不在**。长轮询的请求可能在等待期间就断了（节点被杀、
     * 网线拔了、壳崩了）—— 那时如果把活"领"走，它就落在空气里：节点那边没人跑、
     * 队列里也看不见、界面上永远"跑中"（2026-10-15 实测踩到：活被一个已经死掉的
     * 节点领走，86ms 之内）。
     *
     * 判据是 **`res.destroyed`**（以及它底下那个 socket），实测：
     *   · 健康的领活请求 → false；
     *   · 客户端已经死了的那条 → true。
     * ⚠️ **别用 req.destroyed**：请求体读完（readBody）之后它**恒为 true**，
     * 拿它当判据会把正常领活也全拒掉（这一步真的踩了两遍）。
     * `'close'` 在这里也**不触发**，所以 close/aborted 只当双保险留着。
     */
    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    req.on('aborted', () => {
      closed = true;
    });
    const gone = () => closed || res.destroyed || !!res.socket?.destroyed;

    let job = store.claimNodeJob(nodeId);
    while (!job && !gone() && Date.now() < until) {
      /*
       * 等待期间也盯着"让这台机器做件小事"（一键安装）—— 不看的话，它得等这次长轮询
       * 整整超时（20 秒）才轮到，界面上就是"点了没反应"。
       */
      const task = store.claimNodeTask(nodeId);
      if (task) return gone() ? undefined : sendJson(res, 200, { task: store.publicNodeTask(task) });
      await sleep(CLAIM_POLL_MS);
      job = store.claimNodeJob(nodeId);
    }
    if (!job) {
      // 长轮询收工前再看一次任务，别让它白等一轮
      const task = store.claimNodeTask(nodeId);
      if (task && !gone()) return sendJson(res, 200, { task: store.publicNodeTask(task) });
      return gone() ? undefined : sendJson(res, 200, { job: null });
    }

    // 领到的那一刻请求方已经没了 → **放回队列**，别让这次活凭空消失
    if (gone()) {
      store.releaseNodeJob(job.id);
      console.log(`[节点] ${nodeId} 领活途中连接断了 —— 把活放回队列`);
      return undefined;
    }

    console.log(`[节点] ${nodeId} 领到活（${job.family}）· 队列里还剩 ${store.countNodeJobs(nodeId)}`);
    // repo（工作空间，2026-10-22）：存库时是 JSON 字符串，发回对象 —— 解不开就当没有
    let repo = null;
    try {
      repo = job.repo ? JSON.parse(job.repo) : null;
    } catch {
      repo = null;
    }
    return sendJson(res, 200, {
      job: {
        id: job.id,
        runId: job.runId,
        family: job.family,
        model: job.model,
        sandbox: job.sandbox,
        cwd: job.cwd,
        repo,
        task: job.task,
        sessionId: job.sessionId,
      },
    });
  }

  if (req.method === 'POST' && events) {
    const runId = decodeURIComponent(events[1]);
    const body = await readBody(req);
    const list = Array.isArray(body?.events) ? body.events : [];
    // 这个活还有动静（**空批次也算** —— 那是节点在"一声不吭"时唯一的心跳，见下）
    const job = store.getNodeJobByRun(runId);
    if (job) store.touchNodeJob(job.id);
    let stop = false;
    for (const evt of list) {
      const r = runs.ingestEvent(runId, evt);
      if (!r.ok) return fail(res, 404, 'E2042', r.error);
      if (r.stop) stop = true;
    }
    /*
     * **空批次也要回 stop**：节点每 2 秒发一个空批次，那是它在一声不吭时唯一能收到
     * "人点了停止"的通道（模型在想的时候可能几分钟不吐一个字）。
     * 只看 `list` 里的结果，这个通道就等于不存在。
     */
    if (!list.length) {
      const run = runs.getRun(runId);
      if (!run) return fail(res, 404, 'E2042', '这次运行不在内存里（服务重启过？）');
      stop = !!(run.stoppedByUser || run.finished);
    }
    return sendJson(res, 200, { ok: true, stop });
  }

  if (req.method === 'POST' && done) {
    const runId = decodeURIComponent(done[1]);
    const body = await readBody(req);
    const job = store.getNodeJobByRun(runId);
    if (job) store.finishNodeJob(job.id);
    const ok = runs.finishRemote(runId, {
      status: String(body?.status ?? '失败'),
      exitCode: body?.exitCode ?? null,
      error: body?.error ?? null,
      usage: body?.usage ?? null,
      sessionId: body?.sessionId ?? null,
      finalText: String(body?.finalText ?? ''),
    });
    return ok ? sendJson(res, 200, { ok: true }) : fail(res, 404, 'E2043', '这次运行不在内存里（服务重启过？）');
  }

  return false;
}

/** 运行时管理：设备 → CLI → 详情 */
