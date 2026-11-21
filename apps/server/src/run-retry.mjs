/**
 * **失败分型 + 自动续跑判据**（2026-11-21）。
 *
 * 起因是用户的第一性问题：「同一个任务 zcode 能做到底，bandi 撞一下就报失败停下，为什么」。
 * 读下来根因不在模型，在**外层没有循环**：一次 run = 一次 spawn，进程一退平台只拿到终态，
 * 而判据是"exitCode 非 0 / isError"这一个布尔（runs.mjs 的 `ok`）——于是通道抖一下、
 * 进程被杀一次、供应商 502 一下，全都变成卡面「失败」，等人来点「重跑一次」。
 *
 * 这个模块只回答一个问题：**这次失败，再跑一遍是不是有可能不一样？**
 *
 * 分型原则（顺序即优先级，先命中先返回）：
 *   · **确定性失败**（配置错、没登录、权限档、上下文满、限流冷却、通道断）→ 不续。
 *     再跑一遍是同样的结果，续跑等于拿 token 换一句一样的话；
 *   · **环境性失败**（上游 5xx/超时、进程无理由地死）→ 续，有限次；
 *   · **有具体报错的未知失败** → 不续。让人看见原文比悄悄重试有用 ——
 *     被藏起来的错误，第二次还是错的。
 *
 * 通道断为什么在"不续"这一档（第一版写反了，冒烟打回来的）：CLI 内部已经重连过
 * （Reconnecting 1/5…5/5），外层再 spawn 只是把同一段重连再演一遍；而那条回话
 * 恰恰要告诉人去修代理、回来「继续」—— 这个下一步比自动重试有用。
 *
 * 规则全部来自真库样本（2026-11-21 查 `%APPDATA%/bandi/bandi.db`）：
 *   · `退出码 4294967295`（Windows 的 -1，进程被杀）—— 无任何原因文本，最典型的假失败；
 *   · `unknown MCP server 'filesystem'` —— 连接器配置丢了，重跑必然一样；
 *   · `接口报错 400：Backend [maas] is not supported` —— 模型路由配错；
 *   · `服务重启，这次运行被中断` —— 走的是启动清账（reap），不经过本模块，见 recoverInterruptedCards。
 *
 * 纯函数，不碰库、不起服务 —— 所以能被冒烟直接钉住（smoke-run-retry.mjs）。
 */

/** 最多自动续跑几次（**不含**第一次尝试）。0 = 关掉这个功能。 */
export const MAX_AUTO_RETRY = clampInt(process.env.BANDI_RUN_AUTO_RETRY, 2, 0, 5);

/** 续跑前的间隔：给被杀进程的孙进程一点时间退干净，也让人在界面上看见"在重试" */
export const AUTO_RETRY_DELAY_MS = clampInt(process.env.BANDI_RUN_AUTO_RETRY_DELAY_MS, 1500, 0, 30_000);

function clampInt(raw, dflt, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/* ------------------------------------------------------------------ 判据表 */

/**
 * 上游模型服务的问题：换个时刻再跑就好。
 * `50[234]` 已在 runs.mjs 的通道判据里，这里只管"通道通着、对面自己出错"。
 */
const UPSTREAM_RE =
  /(overloaded|service unavailable|bad gateway|gateway time-?out|api error:?\s*5\d\d|接口报错\s*5\d\d|upstream (?:error|connect)|internal server error)/i;

/** 登录/鉴权：重跑一万次也是同一个 401 */
const AUTH_RE =
  /(not logged in|please run \/login|invalid api key|unauthorized|forbidden|401\b|403\b|未登录|鉴权失败|认证失败|token (?:expired|invalid))/i;

/** 配置类：MCP 没接上、模型名不认识、config 读不了 —— 都是"改配置"才能好的 */
const CONFIG_RE =
  /(unknown mcp server|mcp server .{0,40}(?:unknown|not found)|unknown variant|error loading config|invalid config|unrecognized_model|unrecognized model|model .{0,30}not found)/i;

/** 上下文/额度：同一条会话再跑只会更满，续跑是反方向 */
const CONTEXT_RE =
  /(context (?:window|length).{0,30}(?:exceed|limit)|maximum context|too many tokens|prompt is too long|上下文.{0,10}(?:超|满))/i;

/** 限流：平台已有冷却机制（runs.mjs 的 backoffUntil），别在这里空跑 */
const LIMIT_RE = /(rate.?limit|429\b|temporarily limiting|使用量已达上限|请求过于频繁|限流)/i;

/**
 * 请求本身被拒（4xx）：参数/模型/路由不对，重发同一条请求只会拿到同一个 4xx。
 * 真库样本：`接口报错 400：API Error: 400 WorkBuddy AI: Backend [maas] is not supported`
 * （那年是订阅套餐不支持这个后端，重试一百次也一样）。
 */
const REQUEST_RE = /(接口报错\s*4\d\d|api error:?\s*4\d\d)/i;

/** 进程根本没起来（路径不对 / .cmd shim）—— 续跑必然同样起不来 */
const NOT_STARTED_RE = /EINVAL|ENOENT|EACCES|EPERM/;

/** "退出码 4294967295" 这种**只有数字、没有原因**的兜底文案 */
const BARE_EXIT_RE = /^(?:退出码|exit code|exitcode)\s*-?\d+$/i;

/* -------------------------------------------------------------------- 分型 */

/**
 * 这次失败该不该自动续跑。
 *
 * @param {object}   f
 * @param {string}   f.error         失败原因原文（适配器的 error / stderr / 最后一条 error 事件）
 * @param {number}   [f.exitCode]    进程退出码（4294967295 是 Windows 的 -1）
 * @param {boolean}  [f.channelDown] 是否被 runs.isChannelError 判成"连不上模型"
 * @param {string}   [f.claim]       这一轮的交付声明（done / blocked / silent / unclaimed）
 * @param {boolean}  [f.sandboxBlocked] 权限档本身跑不动命令（runs.mjs 的 sandboxBlocked）
 * @returns {{retry: boolean, kind: string, why: string}}
 */
export function classifyFailure({
  error = '',
  exitCode = null,
  channelDown = false,
  claim = 'unclaimed',
  sandboxBlocked = false,
} = {}) {
  const said = String(error ?? '').trim();

  /*
   * ① 已经把结论说完了（`[完成]` / `[受阻]`）就不续。它不是"半路死"，
   *    是"说完了才死" —— 再跑一遍会推翻它自己刚下的判断，界面上还会说两遍。
   */
  if (claim === 'done' || claim === 'blocked') {
    return { retry: false, kind: 'claimed', why: '这一轮已经把结论说完了' };
  }

  /*
   * ② 权限档挡命令：确定性拒绝。续跑只是把同一条命令再撞一次墙，
   *    正解是让人去「员工详情」放开权限档（runs.mjs 的 blockedUserNote 已经说了）。
   */
  if (sandboxBlocked) {
    return { retry: false, kind: 'permission', why: '权限档把命令挡了（重跑也一样）' };
  }

  // ③ 进程压根没起来：路径/shims 的问题，重试无意义
  if (NOT_STARTED_RE.test(said)) {
    return { retry: false, kind: 'not-started', why: '进程没起来（路径或权限问题）' };
  }

  // ④ 确定性失败：配置 / 登录 / 上下文满
  if (CONFIG_RE.test(said)) {
    return { retry: false, kind: 'config', why: '运行时配置有问题（重跑也一样）' };
  }
  if (AUTH_RE.test(said)) {
    return { retry: false, kind: 'auth', why: 'CLI 没登录或鉴权失败（重跑也一样）' };
  }
  if (CONTEXT_RE.test(said)) {
    return { retry: false, kind: 'context', why: '上下文超了（同一条会话再跑只会更满）' };
  }
  // ⑤ 限流：有冷却机制，这里不抢着跑
  if (LIMIT_RE.test(said)) {
    return { retry: false, kind: 'rate-limit', why: '撞了供应商限流（等冷却，不空跑）' };
  }
  // 5.5 请求本身被拒：同一条请求重发还是同一个 4xx
  if (REQUEST_RE.test(said)) {
    return { retry: false, kind: 'request', why: '请求被上游拒了（4xx，重跑也一样）' };
  }

  /*
   * ⑥ 通道断**不续**（2026-11-21，被 smoke-run-channel 打回来一次才想清楚）。
   *
   * 第一版把它归进"环境性失败 → 续"，跑冒烟就红了：一整轮连不上模型时，那条回话要落成
   * "没连上模型 —— 看一眼网络/代理，好了回一句「继续」"，这是给人**可执行下一步**的设计。
   * 而且通道断在 CLI 内部已经重连过（Reconnecting 1/5…5/5），外层再 spawn 一遍就是
   * 把同一段重连再演一次 —— 代理没修好，两轮都是白等。
   *
   * 所以：通道问题交给"内层重连 + 明确提示"，外层不掺和。真正需要外层兜的是
   * "进程没交代就死了"（process-died）和"上游自己 5xx"（upstream）。
   */
  if (channelDown) {
    return { retry: false, kind: 'channel', why: '连不上模型（网络/代理），修好回「继续」就行' };
  }
  // ⑦ 上游自己出错：通道是通的，换个时刻就好
  if (UPSTREAM_RE.test(said)) {
    return { retry: true, kind: 'upstream', why: '上游接口 5xx / 超时' };
  }
  /*
   * ⑦ 没有任何原因、只有退出码 —— 真库里最常见的一种（`退出码 4294967295`）。
   *    进程被谁杀了（重启、OOM、壳退出、孙子进程占着管道）都不该算"活做不成"。
   */
  if (!said || BARE_EXIT_RE.test(said)) {
    return { retry: true, kind: 'process-died', why: '进程异常退出（没给出原因）' };
  }

  // ⑧ 有具体报错的未知失败：**不猜**。藏着错误重试，第二次还是错的。
  return { retry: false, kind: 'opaque', why: '报错有具体内容，先让人看一眼' };
}

/* ---------------------------------------------------------------- 续跑提示 */

/**
 * 续跑时贴在任务原文后面的那段话。
 *
 * **核心是第 1 条**（2026-11-21，来自 ZCode 的观察，这里给它一个正确落点）：
 * 停下来的诊断会过期。真例：某轮 15:54 停在"全局钩子有问题，先确认 hook 路径"，
 * 次日那条钩子残留早没了，重跑直接 101 项烟测全过 —— 它抱着一张过期的诊断等人回话。
 * 所以续跑第一句不是"接着干"，是"**先复核你那时的判断现在还成立吗**"。
 *
 * @param {{attempt: number, max: number, why: string}} p
 */
export function retryBrief({ attempt = 2, max = 2, why = '进程异常退出' } = {}) {
  return [
    `【自动续跑 · 第 ${attempt} 次尝试，共 ${max} 次】`,
    `上一轮没跑完就断了（原因：${why}）。这不一定是活做不成 —— 先把下面两件事做完再动手：`,
    '',
    '1. **先复核你上一轮的判断**：那个结论依赖的路径、进程、端口、文件状态，现在是否还成立？',
    '   环境是流动的，你停下来之后它可能已经变了 —— 别拿一张过期的诊断继续往下走。',
    '2. **从做完的地方接着做**：已经验证过的步骤不用重来，也不要重复执行同一条命令；',
    '   如果复核发现上次的判断不成立，直接按新的实际情况走，不用向我解释。',
  ].join('\n');
}
