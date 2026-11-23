import * as store from './store.mjs';
import * as runtimes from './runtimes.mjs';
import * as cliModels from './cli-models.mjs';
import * as connectors from './connectors.mjs';
import { normalizeSandbox } from './sandbox.mjs';
import { ADAPTERS } from './adapters.mjs';
import { controlUrl, issueRunCredential, revokeRunCredential } from './agent-auth.mjs';
// 建卡口径的判据（2026-11-11）：有建卡权限的岗位才多注入一段，见 roles.mjs
import { can } from './roles.mjs';
import { stripTrailingDoneMark, claimOf } from './delivery-claim.mjs';
// 失败分型 + 自动续跑（2026-11-21）：判据与提示语都在那个模块里，这里只做编排
import { classifyFailure, retryBrief, MAX_AUTO_RETRY, AUTO_RETRY_DELAY_MS } from './run-retry.mjs';
import { conversationStatusFor, EMPTY_REPLY_TEXT } from './store/status.mjs';
import { codexContextOf } from './context-probe.mjs';
import { acquirePowerLock, releasePowerLock } from './power-lock.mjs';
import { agentGitEnv, gitAbilityBrief } from './agent-git.mjs';
// 运行钥匙的能力清单（2026-11-19）：从 route-policy 生成，不再手写一份
import { runCredentialBrief } from './capabilities.mjs';

/**
 * 「这条会话在对面那个 CLI 里不存在」的报错特征。
 *
 * 各家的说法不一样（都来自 CLI 自己，不由班底杜撰）：
 *   · Codex ：`thread/resume failed: no rollout found for thread id <id>`（code -32600）
 *   · Claude：`No conversation found with session ID: <id>`
 * 命中它就说明：**这个 sessionId 是别的运行时给的，或者那边的会话文件没了**——
 * 这种情况只能新开一条会话，硬 resume 永远失败。
 */
const SESSION_GONE =
  /no rollout found for thread id|no conversation found with session id|session[^.]{0,40}not found|会话[^。]{0,20}(不存在|找不到)/i;

/** 从适配器的返回值里抽出"错在哪儿"的那段文字（各家字段名不一样，挨个试） */
const errorTextOf = (res) =>
  String(
    res?.error?.message ?? res?.error ?? res?.stderr ?? res?.turnReason?.error?.message ?? res?.text ?? '',
  );

const runs = new Map();
const MAX_KEPT_RUNS = 50;

/** 写一条 SSE，payload 是**已经序列化好的 JSON**（落库那份；超限已在 store 里截断）。**必须带 `id:`** —— 浏览器重连时把它放进 `Last-Event-ID`，服务端才能只补缺口 */
const sseJson = (res, json, seq) => res.write(`id: ${seq}\ndata: ${json}\n\n`);
/** 对象版（回放库里的事件时用）：序列化交给 JSON.stringify，不再二次截断 */
const sse = (res, evt, seq) => sseJson(res, JSON.stringify(evt), seq);

/** 这一行是不是终止事件 */
function isDoneRow(row) {
  if (!row) return false;
  try {
    return JSON.parse(row.evt)?.type === '__done';
  } catch {
    return false;
  }
}

export function getRun(runId) {
  return runs.get(runId) ?? null;
}


/**
 * 把一条**已经落库的**失败运行补成"能看懂的那句话"（2026-10-26）。
 *
 * 为什么读的时候还要补一次：上面已经改成结算时记住 error 事件了，但**历史行改不回来**
 * （那次 WorkBuddy 401 的 `runs.error` 就是四个字的「退出码 1」，真因躺在 run_events 里）。
 * 改数据要迁移，读时补一句更便宜，也不动任何已存的账。
 *
 * 只对"error 就是退出码"或空的失败行查事件表：正常失败一次都不查，代价只在出问题的那几条上。
 */
export function errorForDisplay(run) {
  const raw = String(run?.error ?? '').trim();
  /*
   * 什么算"没说出真因"的废话：
   *   · 空 / 只有退出码 —— 最常见的两种；
   *   · `success` —— 2026-10-26 实踩：Claude Code 未登录时 result 里 subtype 是 "success"
   *     而 is_error 是 true，适配器把 subtype 当原因存了下来，界面上就是「没跑成：success」。
   *     这种值有字面内容但零信息，同样得回查事件表。
   */
  const noise = /^(success|ok|error|运行出错)$/i;
  const bare = !raw || /^退出码\s*-?\d+$/.test(raw) || noise.test(raw);
  if (!bare || run?.status !== 'failed') return raw;
  /*
   * 只读事件流**尾部** 50 条（tailRunEvents，seq 倒序）：error / final 都是终止事件，
   * 必在末尾 —— 老写法 listRunEvents(id, 0) 是把整段事件流（CLI 输出一行一条，
   * 长跑能上千行）全读出来逐行 JSON.parse，会话详情里每条失败 run 来一遍，最坏秒级阻塞。
   */
  const rows = store.tailRunEvents(run.id, 50);
  let lastLineOfFinal = '';
  for (let i = 0; i < rows.length; i++) { // tailRunEvents 已是 seq 倒序：从最新往回找
    let evt = null;
    try {
      evt = JSON.parse(rows[i].evt);
    } catch {
      continue; // 坏行跳过，别为了补一句话把整页拖炸
    }
    const m = String(evt?.message ?? '').trim();
    if (evt?.type === 'error' && m && !noise.test(m)) return m;
    /*
     * error 事件本身也是废话时，退而取 final 的**最后一行**：那是 CLI 真正说出口的话
     * （未登录那次的 final.text 是「（会话切换提示）\n\nNot logged in · Please run /login」，
     *  末行才是能照做的信息）。只取末行，不整段搬正文。
     */
    if (!lastLineOfFinal && evt?.type === 'final' && typeof evt.text === 'string') {
      lastLineOfFinal = evt.text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    }
  }
  if (lastLineOfFinal) return lastLineOfFinal.slice(0, 160);
  return raw;
}

/**
 * 落一条事件，再推给所有订阅者。
 *
 * ⚠️ **先落库、再广播**，顺序不能反：反过来的话会有一个窗口
 * ——「订阅者已经收到、库里还没有」，恰好在这时断线重连，那条事件就**永久丢了**
 * （重放补不回来）。宁可慢一点点，也不留这个洞。
 *
 * `seq` 是**每次运行自己的**计数器（从 1 起），它同时就是 SSE 的 `id:`。
 */
function pushEvent(run, evt) {
  run.seq += 1;
  /*
   * 把**已经说出口的回复**攒一份（2026-10-29，用户实报「点停止生成，对方的消息完全消失」）。
   *
   * 为什么要在推给订阅者**之前**就攒：人一点停止，子进程被掐，适配器多半**等不到 final 事件**
   * （dsh 的 finalText 只来自 final）；收尾时 `run.finalText` 是空的 → 那条回话一个字都没落库，
   * 界面从库里重画时它整段消失。用户看到的字就在下面这几行里，先留住它们。
   *
   * 按**分块**累加：前端的实时气泡也是逐块追加的（chat.mjs 的 onText），
   * 这样停止时留下的就是"他刚才对我说到哪儿"的原文，不另造一句话。
   */
  if (evt.type === 'text' && typeof evt.text === 'string' && evt.text) run.streamedText += evt.text;
  // 落库与广播用**同一份序列化结果**：超过 64 KB 的事件在 appendRunEvent 里被截断，
  // 实时流也发截断后的那份 —— 否则实时看全文、刷新重放却是短的，像是丢了内容。
  const stored = store.appendRunEvent(run.id, run.seq, evt);
  for (const s of run.subs) {
    sseJson(s, stored, run.seq);
    /*
     * 背压（2026-10-28 性能审查）：write 返回 false 且写缓冲积过 1MB = 客户端
     * 已经慢到压不动了，断开让它重连 —— 订阅是按 Last-Event-ID 补缺口的，
     * 断开期间的事件从库里回放，一条不丢。不掐的话缓冲无界涨，内存迟早出事。
     */
    if (s.writableLength > (1 << 20)) {
      run.subs.delete(s);
      s.destroy();
    }
  }
}

/**
 * 订阅某次运行的事件流：从 `sinceSeq` 之后补发，再接上后续的。
 *
 * `sinceSeq` 就是浏览器重连时带来的 `Last-Event-ID`（0 = 从头）。
 * 事件**从库里回放**，不再从内存数组 —— 于是服务重启之后那段照样接得上，
 * 而且**只补缺口**：改前是全量重放，回话会被重复追加一遍（真 bug）。
 *
 * 三种情形：
 *   · 内存里有这次运行（还在跑）→ 补发 + 挂着收后续；
 *   · 内存里没有、但库里最后一条是终止事件 → 补发 + 收尾（重启过、或已被挤出内存都走这条）；
 *   · 内存里没有、库里也没有终止标记 → 认不出来，返回 false 交给上层 404（与改前一致）。
 */
export function subscribe(runId, res, sinceSeq = 0) {
  const run = runs.get(runId);
  const last = store.lastRunEvent(runId);
  const done = isDoneRow(last);
  if (!run && !done) return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  for (const r of store.listRunEvents(runId, sinceSeq)) {
    try {
      sse(res, JSON.parse(r.evt), r.seq);
    } catch { /* 坏行跳过：不能为了一行脏数据把整段流带崩 */ }
  }

  // 已经到底了：补完就收尾，别让连接挂着（客户端会自己关）
  if (done) {
    res.end();
    return true;
  }

  run.subs.add(res);
  res.on('close', () => run.subs.delete(res));
  return true;
}

/**
 * **运行钥匙的每轮提醒**（2026-11-08 全员群实报补；2026-11-09 P5 压缩）。
 *
 * 员工 CLI 的会话是续接的（codex resume / claude --resume），上一轮它可能把自己那次
 * 用过的钥匙**字面值**写进了历史命令；而钥匙每轮现发、上一轮收尾即作废。真机实报：
 * 贺韬把 15:49 那把 `rt-…` 抄进了命令，之后每轮的 `GET /api/projects` 都带着死钥匙
 * → 401 E2056，他还判断成"通道没恢复、要雇主重置 token"。历史上下文改不了，所以每轮
 * 都在任务**末尾**贴一句：现取环境变量、别抄旧值；顺便把两个错误码的意思说死。
 *
 * P5 压缩（922→约 330 字）：这层是**操作说明**，不是权限/交付说明 —— 原来的"查台账"那段
 * 与平台契约重复，删掉；被问"权限归谁"时模型曾把这段当答案素材复读，所以只留"怎么用钥匙"。
 *
 * 2026-11-19 搬去 `capabilities.mjs`：这里原来是手写的，"能调哪些接口"与 `route-policy`
 * 的真源各写一份 —— 结果 prompt 说得出接口、却没说基址变量，模型连着试了 6 次命令。
 * 现在清单由路由表生成，见那个文件顶部的两条规矩。
 */

/**
 * 起一次运行。排队式：一个会话同一时间只允许一次运行（在 server 层拦）。
 *
 * @param thread     会话（1:1 或群）行
 * @param member     本次干活的成员：{ personaId, runtime, sandbox, cwd, model }
 * @param task       交给 runtime 的任务文本
 * @param watermark  本次运行"读到"的最后一条消息 rowid，跑完写回水位线
 */
/*
 * **进门排队**（2026-11-15，借鉴 Cumora 协调机制的三件套）。
 *
 * 起因：群派多个员工、多条流程同时收尾时，所有 CLI **同一秒**齐撞供应商——
 * Cumora 实测 7 人同醒、17 分钟 130 次限流。三件套（全部确定性，不靠 AI 自觉）：
 *   ① **全局并发帽**：同一瞬间最多 MAX_CONCURRENT 个 CLI 在跑，满了 FIFO 等空位；
 *   ② **spawn 间距**：相邻两次启动至少隔 MIN_SPAWN_INTERVAL_MS —— "随机抖动"不行，
 *      4 个同时唤醒可以全掷出低值还是齐撞；间距闸把突发速率硬性钉成 1/间隔；
 *   ③ **限流冷却**：撞了限流的运行时静默冷却 RATE_LIMIT_COOLDOWN_MS —— 供应商限流
 *      不是平台的失败，不该在群里报错刷屏；busy 语义交给上层（卡回待办排队重试）。
 *
 * 排队期间 run 已经是 running 态，事件流里有一条 queued 事件，台账可见 —— 不是瞎等。
 */
const MAX_CONCURRENT = Number(process.env.BANDI_MAX_CONCURRENT_RUNS ?? 6);
const MIN_SPAWN_INTERVAL_MS = Number(process.env.BANDI_MIN_SPAWN_INTERVAL_MS ?? 500);
/**
 * **单轮看护：只认"没动静"，绝不认"跑了多久"**（2026-11-19 七改）。
 *
 * 前六版全在同一个误区里打转：拿一个**数量**当"该停了"的判据（工具次数、正文字数、墙钟
 * 时长）。用户一句话点破 —— **复杂功能跑几个小时是正常的**。按墙钟掐，掐的不是"病"，
 * 是"活"，只是把大活砍成两半让人重来一遍。六版里三次砍掉正常任务，就是这个道理。
 *
 * 正确的判据是**状态**，不是量：进程还在但**事件流不动了** = 卡死；只要还有事件进来，
 * 无论跑了 20 秒还是 5 小时，都是"在干活"。所以这里只看一件事：
 *
 *   连续 `BANDI_RUN_IDLE_MS`（默认 10 分钟）**一条事件都没有** → 判挂死，掐进程收口。
 *
 * 任何 type 的事件都算活着（thinking / text / tool / status / session）。工具次数照旧记进
 * `usage.toolCalls` 供排障，但**永远不触发中止**。
 *
 * 已知代价：模型单次思考若超过 10 分钟不吐任何事件，会被误判（CLI 一般会流 thinking，
 * 实测没碰到；真碰到就调 BANDI_RUN_IDLE_MS，别回来改判据）。
 *
 * 收口后**不是白干**：每轮都会 resume 上一轮的 CLI 会话（见 resumeId），中断只是把控制权
 * 交还给人，下一句「继续」接着原来的会话往下做 —— 前提是 sessionId 已落库，所以
 * **收到 session 事件当场就写库**（见 onEvent），不等收尾。
 *
 * **要再加新的中止条件，先回答两个问题**：①这个信号凭什么是"病"而不是"活"？
 * ②长任务（几小时）会不会被它砍？两个都答不上来就别加。
 */
const RUN_IDLE_MS = Number(process.env.BANDI_RUN_IDLE_MS ?? 10 * 60_000);
/** 巡检间隔：别太密（白烧 CPU），也别太稀（挂死后多等一分钟） */
const IDLE_TICK_MS = Math.min(30_000, Math.max(500, Math.floor(RUN_IDLE_MS / 4)));

/**
 * **模型通道断了**（2026-11-19 用户实报："连不上模型，要让我直接能看到你在重连，
 * 我看到会处理的"）。
 *
 * 这条判据只回答一个问题："这条 error 是**上游模型/网络**的问题，还是这个任务本身的问题"。
 *   · 是通道问题 → 前端进度卡当场报「连不上模型 · 重连 2/5 · 已等 43 秒」，
 *     人一眼就知道该去看代理/网络，而不是以为活干挂了；
 *   · 不是通道问题 → 老路（扣住、收尾时当失败原因）。
 *
 * 为什么必须单独挑出来放行（见 onEvent）：error 事件在续会话时是**扣住**的 ——
 * 初衷是"会话不存在"那个必然失败别闪一下。但重连中的 error 恰恰是最该实时看到的东西，
 * 被扣到进程结束才补发，用户那 7 分钟里只会看到界面一片死。
 */
const CHANNEL_FAIL_RE =
  /(reconnecting|econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|fetch failed|socket (?:disconnect|hang ?up)|tls handshake|network error|50[234]\b)/i;

/** 这条 error 是不是"连不上模型"（导出给冒烟用） */
export function isChannelError(message) {
  return CHANNEL_FAIL_RE.test(String(message ?? ''));
}

/**
 * **模型输出畸形**的硬信号：约束解码的特殊 token 泄漏到正文里。
 *
 * 正常的 reasoning / 正文永远不会带 `<|constrain|>`、`<|channel|>`、`<rfl:parameter` ——
 * 它们只出现在"工具调用被降级成纯文本"的时候。见到就当"这轮的动作可能没真执行"。
 */
const MALFORMED_RE = /<\|(?:constrain|message|end|start|channel)\|>|<rfl:parameter/i;

const MALFORMED_NOTE =
  '模型输出格式异常（工具调用没走正常通道）—— 这一步可能没有真执行，别当它干完了';

/** 通道错误说人话：原文压成一行、留头留尾（ERR 码多半在尾巴上） */
function channelReason(message) {
  const one = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (one.length <= 140) return one || '没有拿到模型的第一句输出';
  return `${one.slice(0, 100)}…${one.slice(-30)}`;
}

/**
 * 空回话占位（**按原因分档**）。
 *
 * 以前一律是 `EMPTY_REPLY_TEXT`（"模型输出为空或运行被中断"）—— 那句话对"通道 502"
 * 这种情形等于没说：人不知道是自己网络的问题，也不知道该做什么。分档之后，
 * 通道类失败给的是**可执行的一句话**（查代理、修好回「继续」）。
 */
function emptyReplyText(run) {
  const last = String(run?.lastErrMsg ?? '');
  if (!isChannelError(last)) return EMPTY_REPLY_TEXT;
  return (
    `（这一轮没连上模型 —— ${channelReason(last)}。\n` +
    '看一眼网络 / 代理（开着 Clash「系统代理」时最常见），好了回一句「继续」，' +
    '我接着原来的会话往下做，之前做的不用重来）'
  );
}

/**
 * 时长说人话（"48 秒" / "15 分钟"）：收口说明和卡片描述共用一套口径 ——
 * 两处各写一遍会出现「跑了 15 分钟」和「跑了 0 分钟」两种，就是因为除不尽时没兜。
 * 导出给 project-tasks 的 endNoteOf 用。
 */
export function humanSpan(ms) {
  const sec = Math.max(1, Math.round(Number(ms ?? 0) / 1000));
  if (sec < 90) return `${sec} 秒`;
  return `${Math.round(sec / 60)} 分钟`;
}
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.BANDI_RATE_LIMIT_COOLDOWN_MS ?? 60_000);
const RATE_LIMIT_RE = /(rate.?limit|429|temporarily limiting|使用量已达上限|请求过于频繁|限流)/i;
let activeSpawns = 0;
let lastSpawnAt = 0;
let spawnChain = Promise.resolve();
const backoffUntil = new Map(); // runtimeId → 限流冷却截止时刻

/** 过闸：等并发空位 + 间距，全过了才放行去 spawn。限流冷却期内的运行时直接拒（busy）。 */
function acquireSpawnGate(run, rt) {
  const mine = spawnChain.then(async () => {
    const until = backoffUntil.get(rt.id) ?? 0;
    if (Date.now() < until) {
      const e = new Error(
        `「${rt.label}」刚撞过限流，冷却中（${Math.ceil((until - Date.now()) / 1000)} 秒后自动重试）`,
      );
      e.code = 'busy';
      throw e;
    }
    while (activeSpawns >= MAX_CONCURRENT) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const gap = MIN_SPAWN_INTERVAL_MS - (Date.now() - lastSpawnAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastSpawnAt = Date.now();
    activeSpawns += 1;
    run.spawnSlotAcquired = true;
  });
  spawnChain = mine.catch(() => {}); // 链继续，不因单个失败断掉
  return mine;
}

export function startRun({ thread, member, task, standing = null, watermark = 0, workflowTaskId = null, sessionScope = '', projectId = null }) {
  const runtime = member.runtime ?? 'codex';
  const personaId = member.personaId;

  // 运行时先解析：**这一列的模型得在落库那一刻就知道**（见下）
  // 注意用 resolveForRun：员工只记 runtime id，设备由这里挑（将来多设备时的决策点）
  const rt = runtimes.resolveForRun(runtime);
  /*
   * **不变量与任务分家**（2026-11-15，借鉴 Cumora 的 out-of-band standing prompt）：
   * `standing`（平台契约 + PM 统筹块，每轮一模一样）在 claude 族走
   * `--append-system-prompt-file`（out-of-band：不占任务文本、resume 会话里不积累、
   * 稳定前缀吃得进缓存）；codex / dsh 没有等价 flag，拼回任务文本，行为与从前一字不差。
   */
  const useOutOfBand = standing && rt?.family === 'claude';
  const baseTask = standing && !useOutOfBand ? `${standing}\n\n${task}` : task;
  /*
   * 这一次**实际用哪个模型**。
   *
   * 它落进 `runs.model`（界面显示这次跑的哪个模型），并作为 `model` 传给适配器 ——
   * 适配器只负责把**模型名**递下去（codex 的 `-m`、dsh 的 `--patch`），
   * 走哪条地址、带谁的 Key 由 CLI 自己的配置决定，班底不碰。
   *
   * 跟 workflows 的 viewRun.model 用的是**同一个解析**：页面上写的、
   * 账上记的、实际传下去的必须是同一个模型。
   */
  const eff = cliModels.effectiveModelOf({ family: rt?.family ?? null, model: member.model });
  // dsh 的补丁层是整块替换 config，所以要把 CLI 自己配的 provider 原样带回去（见 dsh.mjs）
  const provider = cliModels.cliProviderOf(rt?.family ?? null);
  const row = store.createRun({
    conversationId: thread.id,
    runtime,
    personaId,
    model: eff.id,
    // 是流程的一步就记下那一步（下面 reply 消息也要带同一个标记）
    taskId: workflowTaskId,
    // 在哪个项目里干活 —— 项目安全网（同一目录并发堆积上限）按它判
    projectId,
  });

  const run = {
    id: row.id,
    /*
     * **这一轮是什么时候开始的**（2026-11-21 实报 pt-b82d3193 后补）。
     *
     * DB 行里一直有 `startedAt`，内存对象却漏了 —— 而 `finishHooks` 能拿到的只有这个对象。
     * 收尾钩子要用它判"卡是不是**本轮内**被上报成待验收的"（见 project-tasks 的
     * `reportedByThisRun`），字段一缺就是 `Date.parse(undefined)` → 判据恒不成立 →
     * 回执照**静默**不发：员工把卡报成待验收，群里一条「请验收」都没有，人得自己去翻看板。
     *
     * 别把它改成 `Date.now()`：收尾要用的是**起点**，不是收尾那一刻。
     */
    startedAt: row.startedAt,
    conversationId: thread.id,
    personaId,
    projectId,
    runtime,
    runtimeId: rt?.id ?? null,
    // 这次跑的是哪个模型（界面要显示它），以及"从哪来的"（员工绑的 / CLI 默认）
    model: eff.id,
    modelFrom: eff.from,
    // 这一步的标记：回复落库时要带上它（流程面板按 taskId 取往来）
    workflowTaskId,
    // 这次执行的 session 作用域（'' = 普通会话；'wf:<流程实例id>' = 某条流程）。
    // 发起新流程 = 换作用域 = 从零开一条会话（见 dispatch.sessionScopeOf）
    sessionScope,
    // 读到的那条消息的水位线，跑完回写
    watermark,
    status: 'running',
    // 事件序号（SSE 的 `id:`）。**每次运行自己从 1 起**，不是全局计数器 ——
    // 全局的会让重连时"补到哪儿"的边界对错人。新运行的库里没有事件，所以是 0。
    seq: store.maxRunSeq(row.id),
    subs: new Set(),
    finished: false,
    done: null,
    sessionId: null,
    finalText: '',
    // 已经流出去的回话（text 事件逐块累加，见 pushEvent）—— 人点停止时靠它把话留住
    streamedText: '',
    // 这一轮的回复是不是已经落过库（正常完成会落；收尾时别重复写一条）
    replyPersisted: false,
    exitCode: null,
    error: null,
    connectors: null,
  };
  runs.set(run.id, run);
  store.setConversationStatus(thread.id, 'running');

  // 运行时被停用就别硬跑 —— 报清楚，别让人对着空白发呆
  if (!rt || !rt.enabled) {
    /* auto 挑不到时说人话：不是"auto 不存在"，是这台机器上还没有一个能用的运行时
       （用户看到的旧文案是「运行时「auto」不存在」，对着设置页根本找不到叫 auto 的东西）
       2026-11-19 文案改版：显示运行时**名字**而不是 rt-xxx 机器 ID；前端失败气泡会在
       前面补「这轮没跑起来——」，并把「设置 → 运行时」做成真链接，这里只写原因和引导。 */
    const err = !rt && runtime === 'auto'
      ? '我想自动挑一个运行时，但这台机器上还没有能用的。去「设置 → 运行时」接一个。'
      : rt
        ? `我挂的运行时「${rt.label || runtime}」已经被停用了。去「设置 → 运行时」换一个。`
        : `我挂的运行时「${runtime}」在这台机器上找不到了。去「设置 → 运行时」换一个。`;
    finish(run, {
      status: 'failed',
      exitCode: null,
      error: err,
    });
    return run;
  }

  /*
   * **工作证**（agent-auth，2026-10-24）：本地跑的运行发一把一次性钥匙，agent 凭它
   * 调专用接口（现在是建卡，见 routes/agent-cards.mjs）。钥匙在 run 收尾时吊销。
   */
  const cred = issueRunCredential(run.id, personaId, { local: true });
  /*
   * **git 能力**（2026-11-13 试点）：研发岗的运行动拿一把"能推但受闸"的能力。
   * 以前这里只有工作证（不能 git），员工失败只能等人救；现在给凭据 + 钩子，
   * 规则（不直推 main / 不改写历史 / 不推凭据文件）在 apps/server/src/git-hooks/pre-push.mjs 里。
   * 合并顺序要紧：agentGitEnv 里的 GIT_CONFIG_* 必须盖在 agentEnv() 的删除之后（见 run.agentEnv 的用法）。
   */
  const persona = store.getPersona(personaId);
  const gitEnv = agentGitEnv({ runId: run.id, personaId, roleKey: persona?.roleKey ?? '', cwd: member.cwd ?? '' });
  run.agentEnv = {
    ...(cred ? { BANDI_CONTROL_URL: controlUrl, BANDI_RUN_TOKEN: cred.token } : {}),
    ...gitEnv,
  };
  // 每轮把"钥匙现取、别抄旧值"贴在任务末尾（见 capabilities.mjs 的说明）；
  // 有建卡权限的岗位（现在只有项目经理）再多一句建卡口径（续接会话读不到新技能，这行每轮都在）
  /*
   * 权限档是这一族**实测跑不动命令**的档位（blocked，2026-11-13 claude 的 default/plan
   * 补进来了）时，把话说破 —— 不悄悄换档（提权出错看不见，sandbox.mjs 的口径），
   * 也不让它白跑还误诊：任务里告诉员工"命令被拒不是环境故障"。
   * 2026-11-13 实报：马超在 default 档把"命令全拒"诊断成"本机无 git/ssh、沙箱拦网络"，
   * 把能干的部署活判成"无通道可用"。codex 的 workspace-write/read-only 是同一处境
   * （runtimes.mjs 的实测注释），这条对两族一视同仁。
   */
  const effSandbox = normalizeSandbox(rt.family, member.sandbox) ?? 'danger-full-access';
  const sandboxBlocked = Array.isArray(rt.blocked) && rt.blocked.includes(effSandbox);
  if (sandboxBlocked) {
    console.warn(
      `[权限] ${rt.label}：员工的权限档「${effSandbox}」在无人审批下跑不动命令（blocked 档），这轮照跑，命令类动作会被拒`,
    );
  }
  const agentTask =
    (cred ? `${baseTask}\n\n${runCredentialBrief(can(store.getPersona(personaId), 'card.create'))}` : baseTask) +
    // 真发了 git 能力才说 —— 没说等于让它继续以为"代码动作归平台、我推不了"
    (Object.keys(gitEnv).length ? `\n\n${gitAbilityBrief()}` : '') +
    (sandboxBlocked
      ? `\n\n（权限提醒：你当前的权限档是「${effSandbox}」，这种档在无人审批的运行方式下跑不动命令 —— ` +
        `需要执行命令/改文件的动作这轮都会被拒。这不是网络或环境故障，别往"连不上/没工具"的方向诊断；` +
        `只读类动作仍可做。请在回话里向雇主说明权限档不足，请他到「员工详情」把权限档放开（这一族能跑命令的是"完全权限"那档）后重派。）`
      : member.sandboxFromConv
        ? /*
           * 会话级覆盖的**正向 counterpart**（2026-11-14 李俊实报）：提权后员工看不见
           * "权限已经变了"—— 续接的会话里躺着早前的"权限不足"提醒，照着旧账继续
           * 自报"我跑不动命令"，明明已经在完全权限档上。非 blocked 档时补一句把话说破；
           * blocked 那边上面的提醒已经说清，不叠加。
           */
          `\n\n（权限更新：这个会话给当前派活统一设了权限档「${effSandbox}」—— ` +
          `之前收到的"权限不足 / 跑不动命令"提醒不再适用，命令与文件操作按这个档执行，别再引用旧提醒。）`
        : '');

  // 按**协议族**选适配器：同一族下可以有多个实例，它们共用一套事件解析
  const adapter = ADAPTERS[rt.adapter];
  if (!adapter) {
    finish(run, {
      status: 'failed',
      exitCode: null,
      error: `运行时「${rt.label}」的协议族「${rt.family}」没有适配器`,
    });
    return run;
  }

  // 没路径就别往下走了。以前这里会一路走到适配器里，被写死的默认值接住（或者直接抛）
  if (!rt.path) {
    finish(run, {
      status: 'failed',
      exitCode: null,
      error: `运行时「${rt.label}」没有可执行路径 —— 去「设置 → 运行时」点「识别本机运行时」接一个`,
    });
    return run;
  }

  // 连接器：把账本翻译成这个协议族的启动参数。接不上不拦运行 —— 连接器坏了不该让人连话都说不了
  const wiring = connectors.resolve(rt.family);
  run.connectors = { active: wiring.active, notes: wiring.notes };
  for (const note of wiring.notes) console.warn(`[连接器] ${note}`);

  // 会话状态按 (会话 × 成员 × **作用域**) 取：群里每人一条互不污染；
  // 流程作用域下，每条流程实例各有一条 —— 这就是"新流程 = 新会话"的落点。
  const prev = store.getMemberSession(thread.id, personaId, sessionScope);
  const startedAt = Date.now();

  /*
   * **跨运行时不能续会话**（2026-10-17 实报）。
   *
   * sessionId 是各 CLI 自己发、自己存的：Codex 记在 `~/.codex/sessions/<日期>/rollout-*.jsonl`，
   * Claude 记在 `~/.claude/projects/…` —— 两家互不相通。员工把运行时从 Claude 换成 Codex，
   * 上一轮那个 id 一并带过去，Codex 就会说「no rollout found for thread id …」，
   * 然后这一整轮直接失败（用户看到的就是这句）。
   *
   * 所以：**记了族、且族不同 → 不 resume**，这轮新开一条，并在回话前面说明一句
   * （记忆带不过来是事实，说清楚比默默丢掉上下文强）。
   * 老库里没记族（family=''）的行仍按老行为先试，真接不上时下面会自动降级重跑。
   */
  const prevFamily = String(prev?.family ?? '');
  const familyCrossed = !!prev?.sessionId && !!prevFamily && prevFamily !== rt.family;
  const resumeId = familyCrossed ? null : (prev?.sessionId ?? null);
  let memoryNote = familyCrossed
    ? `（这个会话上一轮跑在「${runtimes.familyLabel(prevFamily)}」上，会话记忆存在那个 CLI 里，` +
      `「${rt.label}」接不上 —— 这轮从新会话开始，之前的上下文带不过来。）\n\n`
    : '';

  // ⚠️ **必须真的能停**：以前 run 对象上根本没有 abortController，
  //    而界面（和"终止流程"）都在调 `run.abortController?.abort()` ——
  //    于是点了"停止生成"只是改了数据库，**子进程还在跑**（状态说停了、实际没停）。
  //    这里给每次运行配一个，并把 signal 交给适配器（codex/claude/dsh 都认 signal，会 kill 子进程）。
  const ctl = new AbortController();
  run.abortController = ctl;
  run.stoppedByUser = false;
  /**
   * 单轮工具计数（**只记不掐**，见 RUN_IDLE_MS 的注释）、"是否已被挂死检测收口"，
   * 以及**最后一次活动时刻**（心跳，挂死判据的唯一输入）。
   */
  let toolCalls = 0;
  let limitHit = false;
  run.lastEventAt = Date.now();

  /**
   * 最近一条 error 事件的原文（2026-10-26 补）。
   *
   * 为什么需要它：有些 CLI 失败时**stderr 是空的**，真因只从事件流里吐过一遍 ——
   * 2026-10-26 实报的那次（WorkBuddy 账号 401）就是：9 条 error 事件写着
   * 「WorkBuddy refused this account's sign-in (401)…」，stderr 一个字没有，
   * 结算时 `res.error`/`res.stderr` 全空 → 落库只剩兜底的「退出码 1」，
   * 用户看到的就是一句读了等于没读的话（截图里「退出码 1（退出码 1）」）。
   *
   * 只当**兜底**用：`res.error` / `stderr` 有值时仍以它们为准（它们更具体、更常在终端里）。
   * 取**最后一条**：重连 1/5…5/5 那种噪音在前，最后那条才是"为什么真的挂了"。
   */
  let lastErrMsg = '';

  /**
   * 起一次。`sid` 非空时把 `error` 事件**先扣住** ——
   * 万一只是"这条会话在对面那个 CLI 里不存在"，我们马上会重开一条重跑，
   * 那个必然失败的报错不该先闪到人眼前（其它事件照常实时推，不耽误看进度）。
   *
   * 返回值里 `held` 是扣住的那几个；确认不是会话丢失时再按原顺序补发。
   */
  const runOnce = (sid, extra = null) => {
    const held = [];
    const p = adapter({
      /*
       * 自动续跑时在任务原文后面贴一段"先复核再动手"（见 run-retry.mjs 的 retryBrief）。
       * 不改 agentTask 本体：同一轮重发的还是同一张任务单，续跑只是多一句提醒 ——
       * 续接的会话里它已经读过了，这句是压在末尾的"当场指令"，权重比历史更靠后但更近。
       */
      task: extra ? `${agentTask}\n\n${extra}` : agentTask,
      // out-of-band 不变量（平台契约 + PM 统筹）：claude 走 --append-system-prompt-file；
      // codex / dsh 没有等价 flag，standing 已在上方拼回任务文本（行为不变）
      systemPrompt: useOutOfBand ? standing : null,
      sessionId: sid,
      cwd: member.cwd || undefined,
      roots: member.roots ?? [],
      // 权限模式按**当前运行时族**换算：这个值挂在员工身上，可能是上一个运行时留下的词
      // （Claude 的 bypassPermissions 喂给 Codex 会让它读配置就报错退出）。
      // 换算结果在上一段已经算过一遍（effSandbox，blocked 提醒用它）—— 用同一个值，
      // 别两处各算各的，将来一处改了另一处漏
      sandbox: effSandbox,
      // 模型传**解析出来的那个**（不只是员工绑的）：账上记的、传给 CLI 的必须是同一个，
      // 否则按模型限额会盯错人（员工没绑时，实际用的是 CLI 默认值）
      model: eff.id,
      // 只有 dsh 用得上：补丁层整块替换 config，得把 CLI 自己的 provider 带回去
      provider,
      cliPath: rt.path,
      connectorArgs: wiring.args,
      env: run.agentEnv ?? {},
      signal: ctl.signal,
      onEvent: (evt) => {
        /*
         * **心跳**（2026-11-19 七改）：任何事件都证明"进程还在动"，挂死检测只认这一行
         * （见 RUN_IDLE_MS）。放在最前面 —— 连被扣住的 error 事件也算，它同样是活着的证据。
         */
        run.lastEventAt = Date.now();
        /*
         * **session 事件：只落库，不进事件流。**
         *
         * ① 中断那一轮也要能接着干：下一轮的「继续」全靠 resume 这个 id，而中断（挂死收口 /
         *    人点停止 / 进程崩）时收尾路径未必拿得到 sessionId —— 事件里一出现就写库，
         *    中断的代价就只剩"少做了几步"，不是"从头再来"。
         * ② 它绝不能进 run.seq：`retryFresh` 靠 `run.seq === 0` 判断"这一轮还什么都没推出去，
         *    可以安全换新会话重跑"，session 事件若能计数，续接失败就再也不会自动重试。
         */
        if (evt.type === 'session') {
          if (evt.sessionId) {
            run.sessionId = evt.sessionId;
            try {
              store.setMemberSession(thread.id, personaId, evt.sessionId, sessionScope, rt.family);
            } catch {
              /* 落库失败不能影响这一轮：最坏就是中断后要重新交代一次上下文 */
            }
          }
          return;
        }
        /*
         * **畸形输出：工具调用没走正常通道**（2026-11-19 实报，用户第 N 次问"这是停了吗"）。
         *
         * 现场（r-1be44a4d，19:16）：模型把要执行的动作以**原始 token 流**吐了出来 ——
         * `<|constrain|>xml<|message|><rfl:parameter name="cmd">cd … python3 - <<'PY' …`，
         * 外加 `<|end|>|assistant<|channel|>analysis<|message|>`。CLI 把它当 reasoning 收下，
         * 于是**那条命令根本没执行**，模型紧接着就说"已补全、本地跑通"——
         * 用户看到的是一句完整可信的假交付，工作区一个字没改。
         *
         * 这几个 token 是模型的约束解码标记，正常输出里**绝不会**出现（不是"措辞像不像"那种
         * 软判断），所以拿来当硬信号：见到就记一条 error 推到前台，让人当场知道这轮不可信。
         * 不中止、不重试 —— 模型可能下一步自己就恢复了；凭空掐活的老毛病不能再犯。
         */
        if (evt.type === 'thinking' && MALFORMED_RE.test(String(evt.text ?? ''))) {
          run.lastErrMsg = MALFORMED_NOTE;
          pushEvent(run, { type: 'error', message: MALFORMED_NOTE });
          return;
        }
        /*
         * 工具事件**只计数、不掐**（2026-11-19 六改，见 RUN_IDLE_MS 的注释）：
         * 次数分不出"正经活"和"绕圈"，四次改三次误杀，这条尺子作废。
         * 次数只进 usage 供排障（`summarizeRun` 拿它看"这轮有多重"）。
         */
        if (evt.type === 'tool') {
          /*
           * 收口之后**不再落工具事件**：abort 之后 CLI 未必立刻死（子进程正在收尾、
           * 或适配器根本不认 signal），它还能继续吐一串 tool —— 实测有吐到 200 多条的，
           * 库和 SSE 都被灌满。text / status 照旧推（收口前说的那些话要留下）。
           */
          if (limitHit) return;
          toolCalls += 1;
          run.toolCalls = toolCalls;
        }
        // 先留一份真因，再走"扣住/推出去"那一套 —— 扣住的那几个也一样要记，
        // 否则续会话失败又重开也失败时，最后只剩退出码（见 lastErrMsg 的注释）
        if (evt.type === 'error') {
          const m = String(evt.message ?? '').trim();
          if (m) {
            lastErrMsg = m;
            // 挂到 run 上：收尾时 persistReply 要按它决定"空回话占位"写哪一句，
            // 而 lastErrMsg 是 runOnce 作用域里的局部量，出不了这个函数
            run.lastErrMsg = m;
          }
          /*
           * **通道类错误不进 held**（2026-11-19）：held 的初衷只是"会话不存在"那个
           * 必然失败别先闪一下；「重连 1/5 … ECONNRESET」跟会话无关，而且它是用户
           * **最需要实时看到**的东西 —— 被扣到进程结束才补发，人只能干瞪着一片死。
           * 详见 isChannelError 的注释。
           */
          if (sid && !isChannelError(m)) {
            held.push(evt);
            return;
          }
        }
        pushEvent(run, evt);
      },
    });
    return { p, held };
  };

  let first = null;
  /*
   * **过闸后才开始 spawn**（进门排队见上方 acquireSpawnGate）。原来的写法是
   * 同步 `try { first = runOnce(...) }` —— 现在闸要等（并发帽 / 间距 / 冷却），
   * spawn 整体挪进闸的 promise 链：适配器的**同步**抛（launchCommand 起不来）
   * 也落进同一条 catch，finish 语义不变；`run.seq === 0` 的续接失败重跑
   * （retryFresh）在闸后执行，一样成立。
   * 排队时先落一条 queued 事件 —— 台账/直播里能看出"在排队"，不是瞎等。
   */
  pushEvent(run, { type: 'queued', behind: activeSpawns });
  /*
   * 电源锁（pt-bfe8e476）：有活才向系统申报"别睡"。排队期间也算有活（马上就要跑），
   * 所以在过闸**之前**就申报；起不来的 throw 会走 finish() 把锁还掉，语义不变。
   */
  run.powerLock = true;
  acquirePowerLock();
  /** 续不上就重开一条：同一轮任务在**新会话**里重跑一次，成功即照常收尾 */
  const retryFresh = async () => {
    memoryNote ||=
      `（上一轮的会话在「${rt.label}」里找不到（CLI 那边没有这条会话的记录），` +
      `已自动开一条新会话重跑这一轮，之前的上下文带不过来。）\n\n`;
    try {
      return await runOnce(null).p;
    } catch (err) {
      return { isError: true, error: `重开会话也起不来：${err?.message ?? err}`, exitCode: null };
    }
  };
  // 同步 spawn：保证 adapter 注册 abort 监听在 requestStop() 之前，否则 abort 丢失（见 smoke-stop-watchdog 竞态）
  /*
   * **挂死检测**（见 RUN_IDLE_MS 的注释）：巡检式，不是一次性定时器 —— 因为判据是
   * "多久没动静"而不是"一共跑了多久"，每来一条事件心跳就往后推，所以跑五个小时也不会响。
   *
   * 从"真的要起进程"这一刻才开始。排队（并发帽 / 间距 / 冷却）等多久都不算 —— 那段时间
   * 还没有子进程，谈不上挂死。
   *
   * 判定后的动作：先掐（适配器认 signal 就直接杀），再看门狗兜"适配器不认 abort"那一层
   * （复用人工停止同一条路径）；收尾由 finish 统一清掉这个 interval。
   */
  run.limitTimer = setInterval(() => {
    if (run.finished || limitHit) return;
    const idle = Date.now() - (run.lastEventAt ?? Date.now());
    if (idle < RUN_IDLE_MS) return;
    limitHit = true;
    run.limitHit = true;
    run.idleMs = idle;
    run.limitMs = idle;
    run.toolCalls = toolCalls;
    ctl.abort();
    armStopWatchdog(run);
  }, IDLE_TICK_MS);
  run.limitTimer.unref?.();
  /*
   * ── 自动续跑（2026-11-21）────────────────────────────────────────────────
   * 用户的原始疑问：同一个任务 zcode 能做到底，bandi 撞一下就报失败停下。
   * 根因不在模型，在**外层没有循环**：一次 run = 一次 spawn，进程一退平台只拿到终态，
   * 而判据是"exitCode 非 0 / isError"这一个布尔 —— 通道抖一下、进程被杀一次、
   * 供应商 502 一下，全都落成卡面「失败」，等人来点「重跑一次」。
   *
   * 这里补的就是外层：**同一条会话、有限次**再跑一遍。四条硬约束：
   *   ① 只续"看得出是环境问题"的（判据全在 run-retry.mjs，规则来自真库样本）；
   *      配置错 / 没登录 / 权限档 / 上下文满 / 限流 一律不续 —— 不拿 token 换必然的失败；
   *   ② 人工停（stopped）、挂死收口（limitHit）、交付声明已下（[完成]/[受阻]）都不续；
   *   ③ 续跑首句要求它**先复核上一轮诊断**（环境是流动的，停下来的结论会过期）；
   *   ④ 次数上限 MAX_AUTO_RETRY（默认 2），可用 BANDI_RUN_AUTO_RETRY 关掉。
   *
   * 为什么不塞进 finish()：finish 会写库、吊销钥匙、推进流程、通知卡主 ——
   * 那正是"这一轮结束了"。续跑要的恰恰是"还没结束"，所以必须在 settle 里、finish 之前拦。
   */
  let attemptNo = 0;
  let autoRetries = 0;
  let retrySuffix = '';

  /** 起一次尝试：held 的补发也收在这里，调用方只关心"最后拿到了什么" */
  const runAttempt = (sid, extra) => {
    attemptNo += 1;
    const a = runOnce(sid, extra);
    return a.p.then(async (res) => {
      // 续接失败且原因是"这条会话不在"→ 自动新开一条重跑；其它错照原样往上走。
      // `run.seq === 0`：**这一轮还什么都没推出去**才敢重跑 —— 已经出过话再重跑，
      // 用户会看到同一件事被说两遍（会话找不到是启动即失败，正常情况下 seq 就是 0）。
      if (sid && run.seq === 0 && !ctl.signal.aborted && SESSION_GONE.test(errorTextOf(res))) {
        return retryFresh();
      }
      // 不是会话丢失：把扣住的 error 事件按原顺序补发，画面与以前完全一致
      for (const evt of a.held) pushEvent(run, evt);
      return res;
    });
  };

  /** 这一轮真的到头了才走这里（成功 / 停止 / 放弃续跑） */
  function settle(res) {
    run.sessionId = res.sessionId ?? run.sessionId;
    // **人主动停的**要和"跑挂了"分开：前者没有错，不该记成失败、也不该让流程判失败
    const stopped = !run.limitHit && (ctl.signal.aborted || run.stoppedByUser);
    // 成功的判据：没标错，且没有非零退出码。
    // claude 在收到 result 就结算，不给 exitCode —— 所以不能只看 exitCode === 0。
    const ok = run.limitHit ? true : !res.isError && (res.exitCode == null || res.exitCode === 0);

    /*
     * **续跑判定**（放在算 finalText / 落库之前：续跑的那一轮不许先落一条回话，
     * 否则界面上会变成"他说完了一段 + 又说了一段"，两段之间还没有任何交代）。
     */
    if (!ok && !stopped) {
      const errText = errorTextOf(res) || lastErrMsg;
      const verdict = classifyFailure({
        error: errText,
        exitCode: res.exitCode,
        channelDown: isChannelError(errText),
        claim: claimOf(res.finalText ?? res.text ?? ''),
        sandboxBlocked,
      });
      if (verdict.retry && autoRetries < MAX_AUTO_RETRY) {
        autoRetries += 1;
        // 续跑必须 resume **这条**会话：session 事件一出现就落过库了，这里再保险一次
        // （codex 有些版本只在结算里给 sessionId，不补这一下就只能新开会话重来）
        if (res.sessionId) {
          run.sessionId = res.sessionId;
          try {
            store.setMemberSession(thread.id, personaId, res.sessionId, sessionScope, rt.family);
          } catch { /* 落库失败最多是续跑丢上下文，不该把这一轮搞挂 */ }
        }
        // 前台看得见"在重试"：进度卡读 status.text（见 run-progress.mjs 的 info）
        pushEvent(run, {
          type: 'status',
          phase: 'auto_retry',
          text: `第 ${attemptNo} 次尝试没跑完（${verdict.why}），自动续跑 ${autoRetries}/${MAX_AUTO_RETRY}`,
        });
        console.warn(
          `[续跑] run ${run.id} 第 ${attemptNo} 次失败（${verdict.kind}: ${verdict.why}），` +
            `自动重试 ${autoRetries}/${MAX_AUTO_RETRY}`,
        );
        // 定时器挂到 run 上：finish() 是所有终点的唯一出口，它得能把这个还没醒的定时器掐掉
        // （人点了停止 / 看门狗收尾之后还去 spawn 一条新进程，是最不该发生的那种"鬼运行"）
        run.autoRetryTimer = setTimeout(() => {
          run.autoRetryTimer = null;
          // 等这一秒半里人可能点了停止 —— 抢在起进程之前再确认一次
          if (run.finished || ctl.signal.aborted || run.stoppedByUser) return;
          /*
           * 这里的 try 不能省：`runAttempt` 里 spawn 是**同步**发生的，启动路径失效时
           * launchCommand 会当场抛 —— 定时器回调里抛出去就是 uncaught exception，
           * 整个服务跟着倒。首次尝试有外面的 try/catch 接，续跑只有这一层。
           */
          try {
            runAttempt(
              run.sessionId ?? null,
              retryBrief({ attempt: attemptNo + 1, max: MAX_AUTO_RETRY + 1, why: verdict.why }),
            )
              .then(settle)
              .catch(fail);
          } catch (err) {
            fail(err);
          }
        }, AUTO_RETRY_DELAY_MS);
        run.autoRetryTimer.unref?.();
        return;
      }
      /*
       * 不续（或次数用尽）：把**为什么没续**写进失败原因。没有这句话的话，
       * 卡面只有"跑挂了：unknown MCP server 'filesystem'"，人还是不知道平台试过没有、
       * 为什么没再试 —— 而这正是这次改动的出发点。
       */
      retrySuffix = verdict.retry
        ? `（已自动续跑 ${autoRetries} 次仍失败）`
        : `（未自动续跑：${verdict.why}）`;
    }

    // 各家适配器字段名不完全一样（codex/dsh 给 finalText，claude 给 text），这里归一
    const text = res.finalText ?? res.text ?? '';
    /*
     * 停止生成（2026-10-29）：CLI 被掐死时往往**来不及发 final**（dsh 的 finalText 只来自
     * final 事件，见 pushEvent 的注释），这时用已经流出去的 text 事件兜底 ——
     * 用户屏幕上看到的就是这些字，丢掉它等于"对方刚说的话凭空消失"。
     */
    const kept = text || ((stopped || run.limitHit) ? run.streamedText : '');
    // 跨运行时（或自动重开）时，先说一句"上下文带不过来"；权限档跑不动命令时，
    // 再提醒雇主一句（2026-11-13）—— 这轮八成白跑，别让他以为是员工"又连不上了"
    const blockedUserNote = sandboxBlocked
      ? `（这个员工的权限档「${effSandbox}」在无人审批的运行方式下跑不动命令，这轮命令类动作都会被拒 —— ` +
        `去「员工详情」把权限档放开（"完全权限"那档）再派。）\n\n`
      : '';
    // 收口说明只在两处出现（这里 / 看门狗），文案统一走 idleNote
    const budgetNote = run.limitHit ? idleNote(run) : '';
    /*
     * 续跑过的那一轮，正文前面补一句交代（2026-11-21）：不补的话历史里只剩最后一次尝试，
     * 用户看着"他说得好好地就没下文了"，其实中间断过两次 —— 断过就得写出来。
     */
    const retryNote = autoRetries
      ? `（这一轮中途断了 ${autoRetries} 次，已自动续跑接上；下面是接着做完的结果。）\n\n`
      : '';
    run.finalText = kept ? retryNote + memoryNote + blockedUserNote + kept + budgetNote : budgetNote.slice(2);
    run.exitCode = res.exitCode;

    // sessionId 写回**本作用域**那一行；水位线仍写主行（'' ）——
    // 它记的是"在这个会话里读到哪儿"，与 runtime 会话作用域无关。
    // 同时记下**是哪个族给的**这个 id：换运行时后不能拿它去 resume（见上面 familyCrossed）。
    if (res.sessionId) store.setMemberSession(thread.id, personaId, res.sessionId, sessionScope, rt.family);
    if (watermark) store.setMemberWatermark(thread.id, personaId, watermark);

    const status = stopped ? 'stopped' : ok ? 'done' : 'failed';

    // 回话落库（见 persistReply）。人停的那一轮也要落 —— 带 meta.stopped 给界面标「已停止生成」
    persistReply(run, run.finalText, replyMeta({ stopped }));

    /*
     * **真实上下文**（2026-11-12，用户实报「一个会话上下文就爆了」后加）：
     * `res.usage.inputTokens` 是**整轮所有 API 调用求和**（工具活每步都重发上下文、缓存反复命中），
     * 拿它当"单轮上下文"会把一次重活判成 234 万 —— 实际最后一调才 6 万（窗口 95 万）。
     * Codex 自己的会话转录里记着真数，收尾时读一次挂进 usage，轮换判据和上下文环都用它。
     * 探不到就不挂（回退旧口径），探测失败绝不能影响 run 收尾。
     */
    const ctx = rt.family === 'codex' ? codexContextOf(res.sessionId) : null;
    /*
     * runtimeFamily 一起记：轮换判据要知道"这个 usage 是哪种运行时给的" ——
     * 多调用型（codex/dsh）的 inputTokens 是整轮求和，**不能**当窗口用；
     * 单轮型才可用 perTurnTokens 兜底（见 session-budget.mjs 的 shouldRotate）。
     * 老数据没这个字段 → 判据按"未知"保守处理。
     */
    const usageBase = res.usage || ctx ? { ...(res.usage ?? {}), ...(ctx ?? {}), runtimeFamily: rt.family } : null;
    /*
     * 收口要**留痕**：store.summarizeRun / project-tasks 的 endNoteOf 都要判"这轮是被
     * 挂死检测收的"（卡片上写"10 分钟没动静"，不是"没交回结论"）。
     * 挂 usage 而不是加 DB 列 —— 这一列本来就是自由形态 JSON，为排障再走一次迁移不划算。
     * `toolCalls` 无论掐没掐都记：它是"这轮有多重"的唯一依据（只记不掐）。
     */
    const usage = {
      ...(usageBase ?? {}),
      runtimeFamily: rt.family,
      ...(toolCalls ? { toolCalls } : {}),
      ...(run.limitHit ? { limitHit: 'idle', idleMs: run.idleMs ?? RUN_IDLE_MS, limitMs: run.limitMs } : {}),
      // 自动续跑的次数（2026-11-21）：排障时要能看出"这轮到底试了几次"，
      // 以及最后一次是被什么样的错挡下的（卡面只写一句，细节留在这儿）。
      ...(autoRetries ? { autoRetries } : {}),
      // 失败收尾时清理掉的残留进程（2026-11-20）：写进 usage 是为了排障时能查到
      // "这一轮结束时到底收了哪些 PID"，不用去翻服务端控制台。
      ...(res.cleanup?.killed?.length ? { processCleanup: res.cleanup } : {}),
    };

    /*
     * 清理动作直接写进这一轮的失败原因（2026-11-20 用户："把清理动作记进日志"）：
     * 任务卡的「[运行结束] …」读的就是 error，写在这里不用另开一套日志通道。
     */
    const cleanupNote = res.cleanup?.killed?.length
      ? `（收尾时清理了 ${res.cleanup.killed.length} 个残留进程：${res.cleanup.killed.join(', ')}）`
      : '';
    const failReason = res.error?.message || res.error || res.stderr?.trim() || res.turnReason?.error?.message || lastErrMsg || `退出码 ${res.exitCode}`;

    finish(run, {
      status,
      exitCode: res.exitCode ?? null,
      // retrySuffix：为什么没再试一次 / 试了几次仍然不行（2026-11-21）——
      // 卡面「跑挂了：…」读的就是这一句，人得知道平台到底试过没有。
      error: stopped ? null : ok ? null : `${failReason}${cleanupNote}${retrySuffix}`,
      usage,
      elapsedMs: Date.now() - startedAt,
    });
  }

  /**
   * 「起不来」的兜底（原 .catch 原样搬出来，供首次尝试和每次续跑共用）。
   *
   * 有两种冒出来的方式，以前只兜住了前一种：
   *   ① **同步**抛 —— `launchCommand()` 在返回 promise 之前就抛，下面那个 catch 兜住；
   *   ② **异步**抛 —— 子进程的 'error' 事件（`spawn EINVAL` / `ENOENT`：
   *      路径给的是 .cmd shim，或者文件根本不在）。
   * 第 ② 种以前直接落成光秃秃的 `spawn EINVAL`，用户看着这句话不知道该改哪儿
   * （2026-10-15 实测：挑一个班底自己说 launchable=false 的运行时派活就是这个结果）。
   * 判据：**一条事件都没产出**且错误码是启动类的 —— 那这次进程根本没起来，
   * 补上跟同步那条一样的人话。
   */
  function fail(err) {
    // finish 是防重入的：续跑期间人点了停止、看门狗已经收过尾，这里的迟到结算会被丢掉
    if (run.finished) return;
    const msg = String(err?.message ?? err);
    const neverStarted = run.seq === 0 && /EINVAL|ENOENT|EACCES|EPERM/.test(msg);
    finish(run, {
      // 掐子进程会让 promise 以异常收尾 —— 人主动停的不算失败
      status: ctl.signal.aborted || run.stoppedByUser ? 'stopped' : 'failed',
      exitCode: null,
      // retrySuffix 也要带上：续跑那一轮起不来时，人得知道前面已经试过几次
      error: ctl.signal.aborted ? null : neverStarted ? `起不来：${msg}${retrySuffix}` : `${msg}${retrySuffix}`,
      elapsedMs: Date.now() - startedAt,
    });
  }

  try {
    first = runAttempt(resumeId, null);
  } catch (err) {
    finish(run, { status: 'failed', exitCode: null, error: `起不来：${err?.message ?? err}` });
    return run;
  }
  first.then(settle).catch(fail);

  return run;
}

/**
 * 停止看门狗：人明确说了停，abort 也发了，但**子进程的退出通知可能永远等不来**——
 *   · 员工的 CLI 自己又起了命令子进程（powershell / cmd / 构建脚本），父进程被杀后
 *     孙进程继承了 stdout 管道的写端，服务这边的 'close' 事件就永远不来；
 *   · kill 因任何原因没杀死（句柄失效、Electron 壳的特殊性）。
 * 后果实测过（2026-10-23）：运行永远停在「跑中」，会话被"他还在跑上一条"闸死，
 * 只能重启服务解围。所以：**5 秒还没收尾就强制收尾** —— 人要的是停，状态就得停。
 * 迟到的正常收尾由 finish() 的防重入挡掉，不会两头写。
 */
export const STOP_WATCHDOG_MS = 5000;

/**
 * 挂死收口的说明（两条收尾路径共用：适配器认 abort 的走 .then，不认的走看门狗）。
 *
 * 措辞的三个硬要求（都是踩出来的）：
 *   ① 点明"**没动静**"而不是"跑了多久" —— 否则用户以为平台又按时间砍活；
 *   ② 给出下一步（回一句「继续」），不然他只会觉得服务坏了；
 *   ③ 说清"接着原来的会话，之前做的不用重来" —— 中断后 resume 是真的续上，
 *      不说清楚他会以为要从头再干一遍（那才是真正浪费几小时的地方）。
 */
function idleNote(run) {
  /*
   * 最后一条是"连不上模型"时要写出来（2026-11-19）：不写的话，收口说明一律是
   * "进程没动静了"，人只会去怀疑员工卡了，不会想到该去看代理 —— 而这条恰恰是**唯一**
   * 他自己能修的那类故障。
   */
  const chan = isChannelError(run.lastErrMsg)
    ? `最后一次是连不上模型（${channelReason(run.lastErrMsg)}），`
    : '';
  return (
    `\n\n（这一轮有 ${humanSpan(run.idleMs ?? RUN_IDLE_MS)}没有进展（${chan}进程没动静了），我先停在这儿 —— ` +
    `回一句「继续」，我接着原来的会话往下做，之前做的不用重来。）`
  );
}

function armStopWatchdog(run) {
  if (run.finished || run.stopWatchdog) return;
  run.stopWatchdog = setTimeout(() => {
    run.stopWatchdog = null;
    if (run.finished) return;
    /*
     * 挂死收口也走到这里（适配器不认 abort 时，这是**唯一**的收尾路径，2026-11-19 七改）：
     *   · 它不是"人停的"→ 记 done，别让界面显示「已停止生成」；
     *   · 说明必须补在这儿 —— 正常路径拼 budgetNote 的那段 `.then` 永远不会执行；
     *   · usage 也得在这儿写，否则摘要/卡片看不出"这轮是挂掉的"（原来传 null，摘要一片空白）。
     */
    if (run.limitHit) {
      if (!run.finalText) run.finalText = (run.streamedText || '') + idleNote(run);
      finish(run, {
        status: 'done',
        exitCode: null,
        error: null,
        usage: {
          limitHit: 'idle',
          idleMs: run.idleMs ?? RUN_IDLE_MS,
          ...(run.toolCalls ? { toolCalls: run.toolCalls } : {}),
        },
        elapsedMs: null,
      });
      return;
    }
    // 人明确说了停：状态就得停
    finish(run, { status: 'stopped', exitCode: null, error: null, elapsedMs: null });
  }, STOP_WATCHDOG_MS);
  // 别让这颗定时器拖着进程不退
  run.stopWatchdog.unref?.();
}

/**
 * 人点了「停止」：置标记 → 掐子进程 → 上看门狗。
 * 路由（routes/run.mjs）和界面所有停止入口都走这里，别再各自拼一遍。
 */
export function requestStop(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  run.stoppedByUser = true;
  run.abortController?.abort();
  armStopWatchdog(run);
  return run;
}

/**
 * 执行完成时的回调钩子。
 *
 * 挂在这里是因为 `finish()` 是所有 run 的**唯一终点** —— 成功、失败、
 * 甚至"运行时被停用当场就挂"都走它，挂这儿不会漏。
 * 工作流引擎靠它推进流程（`workflows.onAgentRunFinished`）。
 */
const finishHooks = [];
export function onRunFinish(fn, label = '') {
  // label 只在钩子抛错时用于定位（匿名箭头函数没有可读的 fn.name）。
  finishHooks.push({ fn, label: label || fn?.name || '未命名钩子' });
}

/**
 * 回话**落库之后**的回调（2026-11-12）。与 `onRunFinish` 的区别是它拿得到
 * "刚落下的那条消息"本身 —— 群里成员回复 @ 谁就唤醒谁（接力）要用它的 rowid 当水位线，
 * 光有 run 拿不到。
 *
 * 为什么不在 `dispatch.mjs` 里直接 import 本模块来回调：那边已经 import 了 runs，
 * 反向再 import 就是一个循环。用钩子注册，谁需要谁来挂，模块依赖仍是单向的。
 */
const replyHooks = [];
export function onReplyPersisted(fn) {
  replyHooks.push(fn);
}

/**
 * 回话消息的 meta：只记「人停的」这一种标记（界面标「已停止生成」）。
 *
 * 2026-11-08 **砍掉过程快照**（原来的 meta.progress + 气泡顶上那行过程收起行），
 * 用户实判"没啥用"。证据也摆着：这边跑的 codex 系 runtime 不发工具结果事件，
 * 快照里 174/174 个步骤状态都是「已发起」、耗时全 null，展开只剩一串截断的命令；
 * 真正有用的那部分（走到哪步、卡没卡、能不能停）本来只活在直播里，不进历史。
 * `run_events` 仍全量落库（重连重放 / 排错用），只是不再给回话消息摘快照。
 * 老库里已有的副本由 store/db.mjs 的数据迁移清掉（结构版本 1→2）。
 */
function replyMeta({ stopped = false } = {}) {
  return stopped ? { stopped: true } : null;
}

/**
 * 把这一轮的回话落成一条 assistant 消息（**唯一入口**，2026-10-29 收口）。
 *
 * 评论区（2026-10-18）：回话挂在**触发他的那条评论所在的议题**下。
 * 触发消息的 rowid 就是 run.watermark，按它反查最稳 ——
 * 别拿"最后一条 user 消息"猜，连着回复两个议题时会挂错。
 * 顶层评论（parentId 为空）的回复挂到**这条评论自己**：只靠"时序"归组的话，
 * 过几天回到旧议题补一句、中间又插了新议题时，回复会认到错的议题下。
 *
 * `meta`：人点停止的那一轮带 `{ stopped: true }`，界面据此在气泡上标「已停止生成」。
 * 重复调用是安全空操作（`replyPersisted` 记住已经落过的那一次）。
 */
function persistReply(run, text, meta = null) {
  if (run.replyPersisted) return;
  const trigger = store.getMessageByRowid(run.conversationId, run.watermark);
  /*
   * P4 的交付声明是**给平台判卡状态的机器信号**，不是给雇主看的报告标题。
   * P5（2026-11-09）：问答题把标记放**最后一行**（第一行留给答案），落库时剥掉最后一行
   * 单独的 `[完成]`；做事类沿用首行标记，也剥。判据仍用 run.finalText 原文，卡状态不受影响。
   * `[受阻]` 保留 —— 它后面跟着原因，是给人看的。
   */
  const raw = String(text ?? '');
  /*
   * **人停的、一个字都没说过 → 一条都不落**（跟 finish() 里那句"不硬造消息"同一个口径）：
   * 界面那边会画一条安静的「已停止」状态行。空白占位只属于"跑完了却什么都没交回"那一档，
   * 两件事混起来，用户会看到一条"他说没回话"的假回话（本用例 ③ 就是盯这个）。
   */
  if (!raw.trim() && meta?.stopped) return;
  /*
   * 空回话兜底（2026-11-11 实报，见 store/status.mjs 末段）：finalText 只有 `"\n\n\n"` 时
   * 以前也照样落一条消息 → 界面上就是**空白气泡**。这里换成人话占位，至少能看出"这轮没回话"。
   * 只动消息文本，`run.finalText` 保持原样（判卡状态 / 证据仍按原文）。
   */
  const blank = !raw.trim();
  // 空回话**按原因分档**（见 emptyReplyText）：通道断了要写出"查代理、好了回继续"，
  // 不能跟"模型输出为空"共用一句废话
  const shown = blank
    ? emptyReplyText(run)
    : stripTrailingDoneMark(raw.replace(/^\s*\[完成\][ \t]*(?:\r?\n)*/, '')) || raw;
  const finalMeta = blank
    ? { ...(meta ?? {}), emptyReply: true, ...(isChannelError(run.lastErrMsg) ? { channelDown: true } : {}) }
    : meta;
  const msg = store.addMessage({
    conversationId: run.conversationId,
    runId: run.id,
    role: 'assistant',
    text: shown,
    personaId: run.personaId,
    // ⚠️ 回复也要带上这一步的标记：不带的话，流程面板按 taskId 筛时
    //    就只剩"我"这侧的消息，他的回话整段看不见（用户实报）
    taskId: run.workflowTaskId ?? null,
    parentId: trigger?.parentId ?? trigger?.id ?? null,
    meta: finalMeta,
  });
  run.replyPersisted = true;

  /*
   * 回话落地后通知订阅方（2026-11-12，群里成员 @ 谁就唤醒谁）。
   *
   * 人停的那一轮不发：那半句话不是"他要谁接活"，拿去接力只会把人叫起来看半截。
   * 空占位也不发：那是"这轮没回话"，里面没有任何人的名字可接。
   * 订阅方自己扛错：接力失败不能让一条已经落库的回话变成"运行失败"。
   */
  if (!meta?.stopped && !blank) {
    for (const fn of replyHooks) {
      try {
        fn({ run, message: msg, text: shown });
      } catch (e) {
        console.error(`[回复落库钩子] 失败（run ${run.id}）：${e?.message ?? e}`);
      }
    }
  }
}

function finish(run, { status, exitCode = null, error = null, usage = null, elapsedMs = null }) {
  // **只收一次尾**：看门狗强制收尾之后，迟到的正常收尾（或反过来）一律忽略 ——
  // 不设防的话两边会各写一遍状态，后到的把先到的盖掉
  if (run.finished) return;
  run.finished = true;
  if (run.stopWatchdog) {
    clearTimeout(run.stopWatchdog);
    run.stopWatchdog = null;
  }
  if (run.limitTimer) {
    clearTimeout(run.limitTimer);
    run.limitTimer = null;
  }
  // 还没醒的自动续跑定时器也一起掐（2026-11-21）：收尾之后再去 spawn 一条进程，
  // 就是"状态已经结束、进程还在跑"的鬼运行 —— 这个文件里有太多地方吃过它的亏。
  if (run.autoRetryTimer) {
    clearTimeout(run.autoRetryTimer);
    run.autoRetryTimer = null;
  }
  // 过了门的 run 收尾时把**并发名额**还掉（进门排队见 acquireSpawnGate）
  if (run.spawnSlotAcquired) {
    run.spawnSlotAcquired = false;
    activeSpawns = Math.max(0, activeSpawns - 1);
  }
  /*
   * 限流冷却（进门排队第 ③ 件）：这次失败的**真因**是供应商限流 → 这个运行时
   * 静默冷却 RATE_LIMIT_COOLDOWN_MS，冷却期内的新 spawn 直接拒（busy → 上层排队
   * 自动重试）。供应商限流不是平台的失败，不该在群里报错刷屏。
   */
  if (status === 'failed' && run.runtimeId && RATE_LIMIT_RE.test(String(error ?? ''))) {
    backoffUntil.set(run.runtimeId, Date.now() + RATE_LIMIT_COOLDOWN_MS);
  }
  run.status = status;
  run.exitCode = exitCode;
  run.error = error;
  run.finished = true;

  /*
   * 人主动停的这一轮：子进程被掐，适配器那条 promise 可能**永远不结算**
   * （孙进程占着 stdout 管道，'close' 不来 —— 见 armStopWatchdog），
   * 也可能结算了但没有 final。于是 `.then` 那次落库根本没发生，
   * 用户点完停止、界面从库里重画时，"他刚才说的话"整段不见了（2026-10-29 实报）。
   *
   * 这里是**所有运行的唯一终点**，所以兜底放在这儿：停止的收尾把已经流出去的回话落库，
   * 一个字都没有的就不硬造消息（界面那边另画一条安静的状态行，见 chat.mjs 的 stopBlock）。
   */
  if (
    !run.replyPersisted &&
    (run.finalText || run.streamedText) &&
    (status === 'stopped' || run.limitHit)
  ) {
    /*
     * 2026-11-19 七改把条件从 "只认 stopped" 扩到 "**挂死收口也算**"：那两条路径都等不到
     * `.then` 的正常收尾，不在这里兜底，用户屏幕上就是一片空白（连"为什么停"都不知道）。
     * finalText 优先 —— 看门狗路径已经把 idleNote 拼进去了。
     */
    if (!run.finalText) run.finalText = run.streamedText;
    persistReply(run, run.finalText, replyMeta({ stopped: status === 'stopped' }));
  }

  store.finishRun(run.id, {
    status,
    exitCode,
    error,
    usage,
    /*
     * 交付落款（2026-11-22）：**在这里、按原文判一次并存下来**。上面 persistReply 已经把
     * `[完成]` 从落库的消息里剥掉了（那是给平台的机器信号，不进界面），事后从 messages
     * 判不出来 —— 判据核对、回归量具都读这一列，别再各自去猜。
     */
    claim: claimOf(run.finalText ?? run.streamedText ?? ''),
  });
  /*
   * 空回话不装作「完成」（2026-11-11 实报）：run 自身状态如实记「完成」（进程正常退出），
   * 但**会话**上什么都没交回来 → 标「已阻塞」，头部的状态胶囊不再显示绿色「完成」。
   * 已停止 / 失败不受影响（那两种缺回话是意料之中）。
   */
  store.setConversationStatus(run.conversationId, conversationStatusFor(status, run.finalText ?? run.streamedText));
  revokeRunCredential(run.id); // 钥匙跟活走：run 收尾就作废，agent 不能在活干完之后再建卡

  // 电源锁跟活走：finish 是所有运行的唯一终点（正常收尾/停止/看门狗强杀都路过这里），
  // 在这儿还锁才不会漏。releasePowerLock 幂等，多还无害。
  if (run.powerLock) {
    run.powerLock = false;
    releasePowerLock();
  }

  // 钩子出错不能影响执行本身的收尾 —— 否则一条流程的推进逻辑会把发言也搞挂
  run.usageRecord = usage ?? null; // 收尾钩子要判"是不是被预算掐的"（project-tasks 的 endNoteOf）
  for (const { fn, label } of finishHooks) {
    try {
      fn(run);
    } catch (err) {
      /*
       * 2026-11-23：以前这里是空 catch —— 钩子一抛错就静默消失（流程不推进、卡不
       * 收尾、判据不核对），事后连"哪一环挂了"都查不到。只记日志，不改收尾状态、
       * 不写 run_events（判据只看 tool 事件，别让日志污染量具）。
       */
      console.error(`[收尾钩子] ${label} 出错（run ${run.id}，status ${status}）：${err?.stack ?? err}`);
    }
  }

  run.done = {
    type: '__done',
    runId: run.id,
    status,
    exitCode,
    error,
    usage,
    sessionId: run.sessionId,
    finalText: run.finalText,
    elapsedMs,
    connectors: run.connectors,
  };

  /*
   * 终止事件也走**同一条路**（落库 → 广播）。
   * 于是"重连的人"和"当场看着的人"拿到的是同一条事件、同一个 seq；
   * 而重连时它是从库里回放的 —— 服务重启之后也能正确收尾，不会挂在半路。
   */
  pushEvent(run, run.done);

  for (const s of run.subs) s.end();
  run.subs.clear();

  // 内存里只留最近的一批运行
  if (runs.size > MAX_KEPT_RUNS) {
    for (const [id, r] of runs) {
      if (r.finished) {
        runs.delete(id);
        break;
      }
    }
  }
}
