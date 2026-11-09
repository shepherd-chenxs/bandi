import * as store from './store.mjs';
import * as runtimes from './runtimes.mjs';
import * as cliModels from './cli-models.mjs';
import * as connectors from './connectors.mjs';
import { normalizeSandbox } from './sandbox.mjs';
import { ADAPTERS } from './adapters.mjs';
import { controlUrl, issueRunCredential, isPmRole, revokeRunCredential } from './agent-auth.mjs';

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
  if (!bare || run?.status !== '失败') return raw;
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
 * **运行钥匙的每轮提醒**（2026-11-08 全员群实报补）。
 *
 * 员工 CLI 的会话是续接的（codex resume / claude --resume），上一轮它可能把自己那次
 * 用过的钥匙**字面值**写进了历史命令；而钥匙每轮现发、上一轮收尾即作废。真机实报：
 * 贺韬把 15:49 那把 `rt-…` 抄进了命令，之后每轮的 `GET /api/projects` 都带着死钥匙
 * → 401 E2056，他还判断成"通道没恢复、要雇主重置 token"。历史上下文改不了，所以每轮
 * 都在任务**末尾**贴一句：现取环境变量、别抄旧值；顺便把两个错误码的意思说死。
 */
function runCredentialBrief(pm = false) {
  return [
    '【平台接口 · 运行钥匙】本轮环境变量 `BANDI_RUN_TOKEN` 是**这次运行现发**的钥匙（run 收尾作废，每轮都换）。',
    '调平台接口（建卡 / 只读台账）时现场取：PowerShell 用 `$env:BANDI_RUN_TOKEN`，bash 用 `$BANDI_RUN_TOKEN`，请求头写 `X-Bandi-Run-Token: <这个值>`；',
    '**不要把值抄进命令，也不要沿用历史命令里记得的旧值** —— 旧钥匙一定已作废。',
    '错误码：`401 E2056` = 用了旧/错钥匙（重取一次重试，不是权限问题，不要让人重置 token）；`403 E4034` = 这个接口不归运行钥匙管。',
    '查台账：问进度 / 找自己的卡先看本轮任务合同里的「你的任务台账」；要查全部卡或别人的卡，用 `GET ${controlUrl}/api/tasks`（带 `X-Bandi-Run-Token`），**不要去仓库里 grep 源码找答案**。',
    /*
     * 项目经理的建卡口径（2026-11-09 重复建卡实报后每轮提醒）：
     * 技能只在会话**首轮**注入，续接的会话读不到新技能 —— 贺韬那轮就是在旧会话里
     * 把 5 张卡重发了遍、多出 10 张。所以每轮贴一句：走批量口 + 每张卡带稳定幂等键，
     * 重发天然安全（同一 key 只会返回已有卡，不会多建）。
     * 汇报格式已收进平台的每轮契约（dispatch.platformContractBlock），这里不再重复。
     */
    ...(pm
      ? [
          '建卡：走 `POST /api/agent/cards/batch`（一次一批，最多 20 张），**每张卡带稳定的 `idempotencyKey`** —— 重发命中幂等、不会建出第二张；别一张张发，也别怕重发前先查台账。',
          '改卡：`PATCH $BANDI_CONTROL_URL/api/projects/tasks/<卡id>`（status / description / assigneePersonaId / startNow=true 重跑）—— 只对你建的卡，或你当群助手那张团队卡。',
        ]
      : []),
  ].join('\n');
}

/**
 * 起一次运行。排队式：一个会话同一时间只允许一次运行（在 server 层拦）。
 *
 * @param thread     会话（1:1 或群）行
 * @param member     本次干活的成员：{ personaId, runtime, sandbox, cwd, model }
 * @param task       交给 runtime 的任务文本
 * @param watermark  本次运行"读到"的最后一条消息 rowid，跑完写回水位线
 */
export function startRun({ thread, member, task, watermark = 0, workflowTaskId = null, sessionScope = '', projectId = null }) {
  const runtime = member.runtime ?? 'codex';
  const personaId = member.personaId;

  // 运行时先解析：**这一列的模型得在落库那一刻就知道**（见下）
  // 注意用 resolveForRun：员工只记 runtime id，设备由这里挑（将来多设备时的决策点）
  const rt = runtimes.resolveForRun(runtime);

  /*
   * 这一次**实际用哪个模型**。
   *
   * 它落进 `runs.model`（按模型限额全靠它），并作为 `model` 传给适配器 ——
   * 适配器只负责把**模型名**递下去（codex 的 `-m`、dsh 的 `--patch`），
   * 走哪条地址、带谁的 Key 由 CLI 自己的配置决定，班底不碰。
   *
   * 跟 workflows 的额度闸用的是**同一个解析**：闸盯的模型和账上记的、
   * 实际传下去的必须是同一个，否则限额会盯错人。
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
    conversationId: thread.id,
    personaId,
    projectId,
    runtime,
    // 这次跑的是哪个模型（界面/额度要显示它），以及"从哪来的"（员工绑的 / CLI 默认）
    model: eff.id,
    modelFrom: eff.from,
    // 这一步的标记：回复落库时要带上它（流程面板按 taskId 取往来）
    workflowTaskId,
    // 这次执行的 session 作用域（'' = 普通会话；'wf:<流程实例id>' = 某条流程）。
    // 发起新流程 = 换作用域 = 从零开一条会话（见 dispatch.sessionScopeOf）
    sessionScope,
    // 读到的那条消息的水位线，跑完回写
    watermark,
    status: '跑中',
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
  store.setConversationStatus(thread.id, '跑中');

  // 运行时被停用就别硬跑 —— 报清楚，别让人对着空白发呆
  if (!rt || !rt.enabled) {
    /* auto 挑不到时说人话：不是"auto 不存在"，是这台机器上还没有一个能用的运行时
       （用户看到的旧文案是「运行时「auto」不存在」，对着设置页根本找不到叫 auto 的东西） */
    const err = !rt && runtime === 'auto'
      ? '自动：这台机器上还没有能用的运行时 —— 去「设置 → 运行时」接一个'
      : `运行时「${runtime}」${rt ? '已被停用' : '不存在'} —— 去「设置 → 运行时」看看`;
    finish(run, {
      status: '失败',
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
  run.agentEnv = cred ? { BANDI_CONTROL_URL: controlUrl, BANDI_RUN_TOKEN: cred.token } : {};
  // 每轮把"钥匙现取、别抄旧值"贴在任务末尾（见 runCredentialBrief 的说明）；
  // PM 再多一句建卡口径（续接会话读不到新技能，这行每轮都在）
  const agentTask = cred ? `${task}\n\n${runCredentialBrief(isPmRole(store.getPersona(personaId)?.role))}` : task;

  // 按**协议族**选适配器：同一族下可以有多个实例，它们共用一套事件解析
  const adapter = ADAPTERS[rt.adapter];
  if (!adapter) {
    finish(run, {
      status: '失败',
      exitCode: null,
      error: `运行时「${rt.label}」的协议族「${rt.family}」没有适配器`,
    });
    return run;
  }

  // 没路径就别往下走了。以前这里会一路走到适配器里，被写死的默认值接住（或者直接抛）
  if (!rt.path) {
    finish(run, {
      status: '失败',
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
  const runOnce = (sid) => {
    const held = [];
    const p = adapter({
      task: agentTask,
      sessionId: sid,
      cwd: member.cwd || undefined,
      roots: member.roots ?? [],
      // 权限模式按**当前运行时族**换算：这个值挂在员工身上，可能是上一个运行时留下的词
      // （Claude 的 bypassPermissions 喂给 Codex 会让它读配置就报错退出）。
      sandbox: normalizeSandbox(rt.family, member.sandbox) ?? 'danger-full-access',
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
        // 先留一份真因，再走"扣住/推出去"那一套 —— 扣住的那几个也一样要记，
        // 否则续会话失败又重开也失败时，最后只剩退出码（见 lastErrMsg 的注释）
        if (evt.type === 'error') {
          const m = String(evt.message ?? '').trim();
          if (m) lastErrMsg = m;
        }
        if (sid && evt.type === 'error') {
          held.push(evt);
          return;
        }
        pushEvent(run, evt);
      },
    });
    return { p, held };
  };

  let first;
  try {
    first = runOnce(resumeId);
  } catch (err) {
    /*
     * ⚠️ 适配器会**同步**抛：`launchCommand()` 在返回 promise 之前就跑
     * （dsh / claude / codex 都是这个结构），路径起不来时直接 throw。
     * 这一句以前没有兜 —— 异常冒到路由就是 HTTP 500，用户看到"服务器错误"，
     * 而不是"这个运行时起不来"。运行失败要记成**这一次运行失败**，不是服务器崩了。
     */
    finish(run, { status: '失败', exitCode: null, error: `起不来：${err?.message ?? err}` });
    return run;
  }

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

  first.p
    .then(async (res) => {
      // 续接失败且原因是"这条会话不在"→ 自动新开一条重跑；其它错照原样往上走。
      // `run.seq === 0`：**这一轮还什么都没推出去**才敢重跑 —— 已经出过话再重跑，
      // 用户会看到同一件事被说两遍（会话找不到是启动即失败，正常情况下 seq 就是 0）。
      if (resumeId && run.seq === 0 && !ctl.signal.aborted && SESSION_GONE.test(errorTextOf(res))) {
        return retryFresh();
      }
      // 不是会话丢失：把扣住的 error 事件按原顺序补发，画面与以前完全一致
      for (const evt of first.held) pushEvent(run, evt);
      return res;
    })
    .then((res) => {
      run.sessionId = res.sessionId;
      // **人主动停的**要和"跑挂了"分开：前者没有错，不该记成失败、也不该让流程判失败
      const stopped = ctl.signal.aborted || run.stoppedByUser;
      // 各家适配器字段名不完全一样（codex/dsh 给 finalText，claude 给 text），这里归一
      const text = res.finalText ?? res.text ?? '';
      /*
       * 停止生成（2026-10-29）：CLI 被掐死时往往**来不及发 final**（dsh 的 finalText 只来自
       * final 事件，见 pushEvent 的注释），这时用已经流出去的 text 事件兜底 ——
       * 用户屏幕上看到的就是这些字，丢掉它等于"对方刚说的话凭空消失"。
       */
      const kept = text || (stopped ? run.streamedText : '');
      // 跨运行时（或自动重开）时，先说一句"上下文带不过来"，再接他的回话
      run.finalText = kept ? memoryNote + kept : kept;
      run.exitCode = res.exitCode;

      // sessionId 写回**本作用域**那一行；水位线仍写主行（'' ）——
      // 它记的是"在这个会话里读到哪儿"，与 runtime 会话作用域无关。
      // 同时记下**是哪个族给的**这个 id：换运行时后不能拿它去 resume（见上面 familyCrossed）。
      if (res.sessionId) store.setMemberSession(thread.id, personaId, res.sessionId, sessionScope, rt.family);
      if (watermark) store.setMemberWatermark(thread.id, personaId, watermark);

      // 成功的判据：没标错，且没有非零退出码。
      // claude 在收到 result 就结算，不给 exitCode —— 所以不能只看 exitCode === 0。
      const ok = !res.isError && (res.exitCode == null || res.exitCode === 0);
      const status = stopped ? '已停止' : ok ? '完成' : '失败';

      // 回话落库（见 persistReply）。人停的那一轮也要落 —— 带 meta.stopped 给界面标「已停止生成」
      persistReply(run, run.finalText, replyMeta({ stopped }));

      finish(run, {
        status,
        exitCode: res.exitCode ?? null,
        error: stopped
          ? null
          : ok
            ? null
            : res.error?.message || res.error || res.stderr?.trim() || res.turnReason?.error?.message || lastErrMsg || `退出码 ${res.exitCode}`,
        usage: res.usage ?? null,
        elapsedMs: Date.now() - startedAt,
      });
    })
    .catch((err) => {
      const msg = String(err?.message ?? err);
      /*
       * 「起不来」有两种冒出来的方式，以前只兜住了前一种：
       *   ① **同步**抛 —— `launchCommand()` 在返回 promise 之前就抛，上面那个 catch 兜住；
       *   ② **异步**抛 —— 子进程的 'error' 事件（`spawn EINVAL` / `ENOENT`：
       *      路径给的是 .cmd shim，或者文件根本不在）。
       * 第 ② 种以前直接落成光秃秃的 `spawn EINVAL`，用户看着这句话不知道该改哪儿
       * （2026-10-15 实测：挑一个班底自己说 launchable=false 的运行时派活就是这个结果）。
       * 判据：**一条事件都没产出**且错误码是启动类的 —— 那这次进程根本没起来，
       * 补上跟同步那条一样的人话。
       */
      const neverStarted = run.seq === 0 && /EINVAL|ENOENT|EACCES|EPERM/.test(msg);
      finish(run, {
        // 掐子进程会让 promise 以异常收尾 —— 人主动停的不算失败
        status: ctl.signal.aborted || run.stoppedByUser ? '已停止' : '失败',
        exitCode: null,
        error: ctl.signal.aborted ? null : neverStarted ? `起不来：${msg}` : msg,
        elapsedMs: Date.now() - startedAt,
      });
    });

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

function armStopWatchdog(run) {
  if (run.finished || run.stopWatchdog) return;
  run.stopWatchdog = setTimeout(() => {
    run.stopWatchdog = null;
    if (run.finished) return;
    finish(run, { status: '已停止', exitCode: null, error: null, elapsedMs: null });
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
export function onRunFinish(fn) {
  finishHooks.push(fn);
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
  if (!text || run.replyPersisted) return;
  const trigger = store.getMessageByRowid(run.conversationId, run.watermark);
  store.addMessage({
    conversationId: run.conversationId,
    runId: run.id,
    role: 'assistant',
    text,
    personaId: run.personaId,
    // ⚠️ 回复也要带上这一步的标记：不带的话，流程面板按 taskId 筛时
    //    就只剩"我"这侧的消息，他的回话整段看不见（用户实报）
    taskId: run.workflowTaskId ?? null,
    parentId: trigger?.parentId ?? trigger?.id ?? null,
    meta,
  });
  run.replyPersisted = true;
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
  if (status === '已停止' && !run.replyPersisted && run.streamedText) {
    if (!run.finalText) run.finalText = run.streamedText;
    persistReply(run, run.streamedText, replyMeta({ stopped: true }));
  }

  store.finishRun(run.id, { status, exitCode, error, usage });
  store.setConversationStatus(run.conversationId, status);
  revokeRunCredential(run.id); // 钥匙跟活走：run 收尾就作废，agent 不能在活干完之后再建卡

  // 钩子出错不能影响执行本身的收尾 —— 否则一条流程的推进逻辑会把发言也搞挂
  for (const fn of finishHooks) {
    try {
      fn(run);
    } catch { /* 忽略 */ }
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
