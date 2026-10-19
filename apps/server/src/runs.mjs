import * as store from './store.mjs';
import * as runtimes from './runtimes.mjs';
import * as cliModels from './cli-models.mjs';
import * as connectors from './connectors.mjs';
import { normalizeSandbox } from './sandbox.mjs';
import { ADAPTERS } from './adapters.mjs';

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

/** 写一条 SSE。**必须带 `id:`** —— 浏览器重连时把它放进 `Last-Event-ID`，服务端才能只补缺口 */
const sse = (res, evt, seq) => res.write(`id: ${seq}\ndata: ${JSON.stringify(evt)}\n\n`);

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
  store.appendRunEvent(run.id, run.seq, evt);
  for (const s of run.subs) sse(s, evt, run.seq);
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
    // 在哪个项目里干活 —— 项目互斥（同一目录同时只跑一个）按它判
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
    // 读到的那条消息的水位线，跑完回写（远端那条路要留着，收尾时用）
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
    exitCode: null,
    error: null,
    connectors: null,
  };
  runs.set(run.id, run);
  store.setConversationStatus(thread.id, '跑中');

  // 运行时被停用就别硬跑 —— 报清楚，别让人对着空白发呆
  if (!rt || !rt.enabled) {
    finish(run, {
      status: '失败',
      exitCode: null,
      error: `运行时「${runtime}」${rt ? '已被停用' : '不存在'} —— 去「设置 → 运行时」看看`,
    });
    return run;
  }

  /*
   * 远端节点：**控制面一个子进程都不起** —— 把活放进队列，等那台机器的节点来领。
   *
   * 这一步就是"多台电脑一起干活"的落点，也是"离线排队"的**全部实现**：
   * 节点不在线时，活就一直躺在队列里（见 store 里 `node_jobs` 那段注释）。
   * 排在"按协议族选适配器"之前：远端用什么路径、起不起得来，是**那台机器**的事，
   * 控制面既不知道也不该猜。
   */
  if (rt.remote) {
    return queueRemoteRun(run, { thread, rt, task, member });
  }

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
   * 起一次。`sid` 非空时把 `error` 事件**先扣住** ——
   * 万一只是"这条会话在对面那个 CLI 里不存在"，我们马上会重开一条重跑，
   * 那个必然失败的报错不该先闪到人眼前（其它事件照常实时推，不耽误看进度）。
   *
   * 返回值里 `held` 是扣住的那几个；确认不是会话丢失时再按原顺序补发。
   */
  const runOnce = (sid) => {
    const held = [];
    const p = adapter({
      task,
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
      signal: ctl.signal,
      onEvent: (evt) => {
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
      // 各家适配器字段名不完全一样（codex/dsh 给 finalText，claude 给 text），这里归一
      const text = res.finalText ?? res.text ?? '';
      // 跨运行时（或自动重开）时，先说一句"上下文带不过来"，再接他的回话
      run.finalText = text ? memoryNote + text : text;
      run.exitCode = res.exitCode;

      // sessionId 写回**本作用域**那一行；水位线仍写主行（'' ）——
      // 它记的是"在这个会话里读到哪儿"，与 runtime 会话作用域无关。
      // 同时记下**是哪个族给的**这个 id：换运行时后不能拿它去 resume（见上面 familyCrossed）。
      if (res.sessionId) store.setMemberSession(thread.id, personaId, res.sessionId, sessionScope, rt.family);
      if (watermark) store.setMemberWatermark(thread.id, personaId, watermark);

      if (run.finalText) {
        /*
         * 评论区（2026-10-18）：回话挂在**触发他的那条评论所在的议题**下。
         * 触发消息的 rowid 就是 run.watermark，按它反查最稳 ——
         * 别拿"最后一条 user 消息"猜，连着回复两个议题时会挂错。
         *
         * 顶层评论（parentId 为空）的回复挂到**这条评论自己**：只靠"时序"归组的话，
         * 过几天回到旧议题补一句、中间又插了新议题时，回复会认到错的议题下。
         */
        const trigger = store.getMessageByRowid(thread.id, watermark);
        store.addMessage({
          conversationId: thread.id,
          runId: run.id,
          role: 'assistant',
          text: run.finalText,
          personaId,
          // ⚠️ 回复也要带上这一步的标记：不带的话，流程面板按 taskId 筛时
          //    就只剩"我"这侧的消息，他的回话整段看不见（用户实报）
          taskId: run.workflowTaskId ?? null,
          parentId: trigger?.parentId ?? trigger?.id ?? null,
        });
      }

      // 成功的判据：没标错，且没有非零退出码。
      // claude 在收到 result 就结算，不给 exitCode —— 所以不能只看 exitCode === 0。
      const ok = !res.isError && (res.exitCode == null || res.exitCode === 0);
      // **人主动停的**要和"跑挂了"分开：前者没有错，不该记成失败、也不该让流程判失败
      const stopped = ctl.signal.aborted || run.stoppedByUser;
      finish(run, {
        status: stopped ? '已停止' : ok ? '完成' : '失败',
        exitCode: res.exitCode ?? null,
        error: stopped
          ? null
          : ok
            ? null
            : res.error?.message || res.error || res.stderr?.trim() || res.turnReason?.error?.message || `退出码 ${res.exitCode}`,
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

/* --------------------------------------------------------- 远端节点那条路 */

/**
 * 把这次执行交给某台机器：**放进队列**，等那台机器的节点来领（长轮询，不引 WebSocket）。
 *
 * 控制面这边**照样建一个内存里的 run 对象** —— 于是事件广播、SSE 的 `id:`、落库后的回放、
 * 收尾那一整套全都**复用本机那条路**，只是事件从 HTTP 来、不是从子进程来。
 * 少一套"远端专用"的管线，就少一处只有多机才暴露的坑。
 */
function queueRemoteRun(run, { thread, rt, task, member }) {
  const ms = store.getMemberSession(thread.id, run.personaId, run.sessionScope);
  // 同上：那个 sessionId 是**记录里那个族**的，由别的族来 resume 必然找不到
  const remoteSession = ms?.sessionId && (!ms.family || ms.family === rt.family) ? ms.sessionId : null;
  const job = store.enqueueNodeJob({
    runId: run.id,
    nodeId: rt.deviceId,
    family: rt.family,
    model: run.model,
    // 权限模式同样要换成那台机器上那个 CLI 认得的写法
    sandbox: normalizeSandbox(rt.family, member.sandbox),
    cwd: member.cwd ?? null,
    task,
    // 续接用：**那台机器上**那个 CLI 的会话 id（空 = 让它在那边新开一条）
    sessionId: remoteSession,
  });
  run.remote = true;
  run.nodeId = rt.deviceId;
  run.jobId = job.id;
  pushEvent(run, {
    type: 'status',
    phase: 'queued',
    nodeId: rt.deviceId,
    text: `已排进「${rt.deviceLabel ?? rt.deviceId}」的队列，等它来领`,
  });
  return run;
}

/**
 * 节点回传一批事件。
 * 返回 `{ ok, stop }` —— `stop: true` 是**反向的控制通道**：
 * 人点了停止，靠下一个事件批次的响应把话带过去，不用另开一条连接。
 */
export function ingestEvent(runId, evt) {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: '这次运行不在内存里（服务重启过？）' };
  pushEvent(run, evt);
  return { ok: true, seq: run.seq, stop: !!(run.stoppedByUser || run.finished) };
}

/**
 * 节点报回执：这次执行在那边结束了。
 * 走的是**与本机同一个 `finish()`** —— 消息落库、会话状态、流程推进、终止事件全都一样。
 */
export function finishRemote(
  runId,
  { status, exitCode = null, error = null, usage = null, sessionId = null, finalText = '' },
) {
  const run = runs.get(runId);
  if (!run) return false;
  // 已经收过尾（比如人先点了停止）→ 别覆盖事实
  if (run.finished) return true;
  if (sessionId) {
    run.sessionId = sessionId;
    // 远端那条路也要记族：这个 id 是**那台机器上那个 CLI**给的，换运行时后同样不能硬 resume
    let fam = '';
    try {
      fam = runtimes.resolveForRun(run.runtime)?.family ?? '';
    } catch {
      /* 查不到就记空 —— 只是少一层保护，不影响这次收尾 */
    }
    store.setMemberSession(run.conversationId, run.personaId, sessionId, run.sessionScope, fam);
  }
  if (finalText) {
    run.finalText = finalText;
    store.addMessage({
      conversationId: run.conversationId,
      runId: run.id,
      role: 'assistant',
      text: finalText,
      personaId: run.personaId,
      taskId: run.workflowTaskId ?? null,
    });
  }
  if (run.watermark) store.setMemberWatermark(run.conversationId, run.personaId, run.watermark);
  finish(run, { status, exitCode, error, usage });
  return true;
}

/**
 * 人在界面上点了停止，而这次跑在远端。
 * 还没被领走的**直接撤掉**（不然那台机器一上线就会把它跑一遍）；已经在跑的，
 * 等它下一个事件批次的响应里带回 `stop`，由节点自己掐。
 */
export function abortRemote(runId) {
  const run = runs.get(runId);
  if (!run?.remote) return false;
  run.stoppedByUser = true;
  const job = store.getNodeJobByRun(runId);
  if (job && job.status === '待领') {
    store.finishNodeJob(job.id, '已取消');
    finish(run, { status: '已停止', exitCode: null, error: null });
  }
  return true;
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

function finish(run, { status, exitCode = null, error = null, usage = null, elapsedMs = null }) {
  run.status = status;
  run.exitCode = exitCode;
  run.error = error;
  run.finished = true;

  store.finishRun(run.id, { status, exitCode, error, usage });
  store.setConversationStatus(run.conversationId, status);

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
