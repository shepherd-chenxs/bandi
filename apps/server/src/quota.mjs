/**
 * 额度：**每个模型**每天最多用多少 token。
 *
 * 为什么是"按模型"而不是"按供应商"：贵和便宜的分界线落在**模型 id** 上，不在供应商上。
 * 本机 codex / dsh 的供应商只有一个（magpie 网关，`~/.codex/config.toml` 与 dsh profile 都只配了它），
 * 而 `group/auto-deepseek-v4-1-flash`、`opencode-zen-free/*` 这些**模型**才是"走哪条上游、花不花钱"。
 * 按供应商设额度等于给 magpie 设一个数，把免费的和收费的一起管住 —— 正好不是要的效果。
 *
 * 口径（都是查证过的，别想当然）：
 *   · 用量来自 `runs.usage.totalTokens`（三个 runtime 都解析、`finishRun` 都写）
 *   · ⚠️ **只有约 80% 的运行有用量记录**（失败/被杀的那批没有）→ 所以另有一道**次数**兜底闸
 *   · **归因靠 `runs.model`**（models.effectiveModelOf 解析出来的"实际生效的模型"）。
 *     老记录这一列是 NULL —— 它们确实归不了因，界面上当一个单独的"认不出"桶摆出来，不装看不见。
 *   · 缓存读占大头（一次 12.5 万里 8.5 万是缓存读），按 totalTokens 一刀切会**高估成本**。
 *     v1 先不分项加权，界面上把口径写出来，别给一个看着精确、其实偏了的数字。
 *
 * 默认**不限制**（该模型没有行 / 值为空）：升级不该把人卡住。
 */
/*
 * 这个模块**不碰 SQL**：表结构与所有查询都在 `store.mjs` 里
 * （见 docs/形态决策.md §十二 第 2 条「SQL 收口」）。
 * 这里只留业务口径 —— 谁超了、按什么算、怎么给人看。
 */
import * as store from './store.mjs';
import * as cliModels from './cli-models.mjs';
import * as runtimes from './runtimes.mjs';

/** 全部限额：{ 模型id: {dailyTokens, dailyRuns, updatedAt} } */
export function getQuotas() {
  const out = {};
  for (const r of store.listQuotaRows()) {
    out[r.model] = { dailyTokens: r.dailyTokens ?? null, dailyRuns: r.dailyRuns ?? null, updatedAt: r.updatedAt ?? null };
  }
  return out;
}

/** 一个模型的限额（没有就是"不限制"） */
export function getQuota(model) {
  const r = store.getQuotaRow(model);
  return {
    dailyTokens: r?.dailyTokens ?? null,
    dailyRuns: r?.dailyRuns ?? null,
    updatedAt: r?.updatedAt ?? null,
  };
}

/**
 * 整表替换：传进来的 map 就是**全部**限额，没提到的模型一律回到"不限制"。
 *
 * 为什么是替换而不是逐条 upsert：界面上是一张表、一个「保存」——
 * 用户把一个上限清空，意思就是"这个模型不管了"，那一下必须真的落下去。
 * 逐条 upsert 的话，"清空"跟"这次没提交"长得一样，删不掉上面设过的数。
 */
export function setQuotas(map = {}) {
  const t = (v) => (Number(v) > 0 ? Math.floor(Number(v)) : null);
  // 先把界面形状翻成"要落库的行"：空的不用占一行
  const entries = [];
  for (const [k, v] of Object.entries(map ?? {})) {
    const id = String(k ?? '').trim();
    if (!id) continue;
    const tokens = t(v?.dailyTokens);
    const runs = t(v?.dailyRuns);
    if (tokens === null && runs === null) continue;
    entries.push({ model: id, dailyTokens: tokens, dailyRuns: runs });
  }
  // 替换 + 事务都在 store 里（那儿是唯一有 SQL 的地方）
  store.replaceQuotas(entries);
  return getQuotas();
}

/** 本地时区的"今天 00:00" */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * 今天的用量，**按模型分开算**。
 *
 * 累加在 JS 里做，不用 SQLite 的 JSON 函数 —— 一天的运行数是几十几百条，够快；
 * 也省得赌 SQLite 编了 JSON1。
 *
 * 返回值里的 `''` 键 = **认不出模型的那些**（升级前的老记录）。
 * 次数用的是"今天跑了几次"，不是"有几次带用量" —— 一次跑就是一次花钱，
 * 哪怕它失败没报用量。这条正是"约 20% 没有用量记录"的兜底闸。
 */
export function usageToday() {
  const since = startOfToday();
  const byModel = {};
  const runsByModel = {};
  let tokens = 0;
  let runs = 0;

  for (const r of store.listRunUsageSince(since)) {
    const key = r.model || '';
    runsByModel[key] = (runsByModel[key] ?? 0) + 1;
    runs += 1;
    let t = 0;
    try {
      t = JSON.parse(r.usage)?.totalTokens ?? 0;
    } catch {
      /* 坏记录跳过，不因为一条脏数据把额度算崩 */
    }
    byModel[key] = (byModel[key] ?? 0) + t;
    tokens += t;
  }
  return { tokens, runs, since, byModel, runsByModel };
}

/**
 * 额度数字给人看：够大就说"万"，不够大就照原样 ——
 * 一律除以万再四舍五入的话，1000 会显示成"0 万"（验收时真出现）。
 *
 * **导出**：设置页那张表、实例页顶栏那句都用它。数字的口径只有这一处。
 */
export function fmtTokens(n) {
  return n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)} 万` : String(n);
}

/**
 * 这个模型超了没有？返回 null = 放行；否则返回一句给人看的话。
 *
 * 两道闸任一到顶就拦：
 *   · dailyTokens —— 主闸（估算成本）
 *   · dailyRuns   —— 兜底闸（次数 100% 准；有 20% 的运行没用量记录，靠它补）
 */
function whyOver(lim, usedTokens, usedRuns, modelId) {
  const name = modelId ? `「${modelId}」` : '这个模型';
  if (lim.dailyTokens && usedTokens >= lim.dailyTokens) {
    return `${name}今天的额度用完了（已用 ${fmtTokens(usedTokens)} / 上限 ${fmtTokens(lim.dailyTokens)} token）`;
  }
  if (lim.dailyRuns && usedRuns >= lim.dailyRuns) {
    return `${name}今天的次数用完了（已跑 ${usedRuns} 次 / 上限 ${lim.dailyRuns} 次）`;
  }
  return null;
}

/**
 * 这一步**要用的那个模型**超了没有。
 *
 * modelId 为空（认不出实际会跑哪个模型，比如 claude 没有可读的默认值）→ **不拦**。
 * 拿一个猜出来的模型去拦人，比不拦更糟：拦错了没法解释，也会把 blame 记到错的模型头上。
 */
export function overQuotaFor(modelId) {
  const id = String(modelId ?? '').trim();
  if (!id) return null;
  const lim = getQuota(id);
  if (!lim.dailyTokens && !lim.dailyRuns) return null;
  const u = usageToday();
  return whyOver(lim, u.byModel[id] ?? 0, u.runsByModel[id] ?? 0, id);
}

/**
 * 被额度拦下时写在任务备注里的那句「出路」。
 *
 * 它同时是**"这次阻塞是额度拦的"的标记** —— 实例页靠它决定给不给「继续一次」
 * （见 workflows.viewRun 的 quotaBlocked）。改这句话要两边一起改，所以放这儿导出。
 */
export const CONTINUE_HINT = '点这一步的「继续一次」可以再放一步（会超出额度）';

/**
 * 接口和界面要的一整份：今天的总量 + **每个模型一行**（限额、用量、超没超）。
 *
 * 为什么要打包成一次：这几个数必须来自**同一次读数**。分几次查的话，"已用多少"和
 * "超没超"中间可能刚好跑完一次派活，界面上就会印出"已用 99 万 / 上限 100 万 · 未超"
 * 这种自相矛盾的话。给人看的文字也在这儿一起给，界面直接印，不自己算第二遍。
 */
export async function quotaStatus() {
  const quotas = getQuotas();
  const u = usageToday();

  /*
   * 「现在哪些模型可用」**直接读各运行时的配置**（不再有账本）。
   *
   * 读它是为了保住一个能力：限额是对着一个**清单**设的 —— 只列"已经跑过的"，
   * 你就没法给还没跑起来的模型预先上闸。
   *
   * 代价：这一页打开时要读一遍各运行时的配置（dsh 那条是一次 HTTP，本机约 10–50ms）。
   * 只在设置页用，不在派活路径上，可以接受。某个运行时读不到就不贡献行
   * —— 少几行，但已有那几行的限额判断不受影响。
   */
  const avail = new Map();
  for (const listed of runtimes.publicList()) {
    /*
     * 远端节点的运行时**不参与**这一步：它的模型清单要在**那台机器**上读 ——
     * 本机既读不到（路径是别人家的），更不该为了列个清单在本机把它的 CLI 起起来。
     */
    if (listed.remote) continue;
    const rt = runtimes.resolveForRun(listed.id);
    if (!rt) continue;
    let found;
    try {
      found = await cliModels.forRuntime(rt);
    } catch {
      continue;
    }
    for (const m of found.models ?? []) if (!avail.has(m.id)) avail.set(m.id, m);
  }

  const ids = new Set([...avail.keys(), ...Object.keys(quotas), ...Object.keys(u.byModel).filter(Boolean)]);
  const rows = [...ids]
    .map((id) => {
      const m = avail.get(id) ?? null;
      const lim = quotas[id] ?? { dailyTokens: null, dailyRuns: null };
      const usedTokens = u.byModel[id] ?? 0;
      const usedRuns = u.runsByModel[id] ?? 0;
      return {
        id,
        label: m?.name ?? '',
        // false = 今天跑过它，但现在各运行时的配置里已经没有它了（历史用量，别再派给它）
        available: !!m,
        limitTokens: lim.dailyTokens ?? null,
        limitRuns: lim.dailyRuns ?? null,
        usedTokens,
        usedRuns,
        usedText: fmtTokens(usedTokens),
        limitText: lim.dailyTokens ? fmtTokens(lim.dailyTokens) : null,
        over: whyOver(lim, usedTokens, usedRuns, id),
      };
    })
    // 用过的排前面（要盯的就是它们），其余按名字排 —— 顺序稳定，找起来才快
    .sort((a, b) => b.usedTokens - a.usedTokens || a.id.localeCompare(b.id));

  const un = { tokens: u.byModel[''] ?? 0, runs: u.runsByModel[''] ?? 0 };
  return {
    today: {
      tokens: u.tokens,
      runs: u.runs,
      since: u.since,
      tokensText: fmtTokens(u.tokens),
    },
    models: rows,
    // 认不出模型的那些（升级前的老记录）：单独摆出来，别混进任何一个模型的账里
    unattributed: { ...un, tokensText: fmtTokens(un.tokens) },
  };
}
