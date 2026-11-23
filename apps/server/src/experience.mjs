/**
 * experience.mjs —— 经验簿（2026-11-22，缺口①「员工没有长期记忆」的最小兑现）。
 *
 * ## 病根不是"没地方存"
 * 聊天、卡、返工、交付证据全都持久化在库里；丢的只有一样：**员工自己那条 CLI 会话**。
 * 会话一换（上下文预算、换流程、换卡），他就"重新做人"——同一个坑能踩第二遍，
 * 这个团队的口径要每次重新讲。而现有的交接块只带最近 8 条消息、每条 160 字，那是"刚才聊到哪"，
 * 不是"这台机器上什么是对的"。
 *
 * ## 所以这里只记两样，且都能指回一件真发生过的事
 *   · 口径（kind='repo'）    这个团队定过的规矩。**只收显式写入**（人说 / 员工听到雇主明确给规矩）。
 *   · 坑（kind='pitfall'）   平台**核对出来**的错：声称完成却没跑测试、报了没发生过的执行、
 *                            打回重做后还对不上。来源是 notices，带 runId，可回溯。
 *
 * 明确**不做**的三件事：
 *   1. 不做"聊天摘要"。总结是模型生成的，会漏会编，且没人能核 —— 那正是
 *      `delivery-evidence.mjs` 写在最前面那条"把判据押在员工记得写字上，本身就是错的"。
 *   2. 不做自动淘汰以外的清理。雇主能看见、能删（CLI / 接口）；平台不替他忘。
 *   3. 不记"这人行不行"。经验簿存事实与口径，不存评价 —— 评价是人做的事。
 *
 * ## 读的时候（注入）
 * 每轮派活把两类各取几条，摆在任务之后、方法论之前。
 *   · 口径最多 4 条、坑最多 3 条、事实最多 3 条（按当前任务相关度取，同分时按原口径：
 *     口径新的在前、坑被核出次数多的在前），每条一行、整块 ≤ 1200 字；
 *   · 一条都没有 → 返回空串，**不出现空块**（空块会让模型以为"这里该有内容却缺了"）。
 *
 * 为什么要有上限：这不是知识库，是"别在同一个地方摔第二次"的提醒。十行以内他会看，
 * 五十行他会跳过 —— 而跳过之后，这块就变成纯占 token。
 *
 * ## 事实层（2026-11-23 补）
 * 经验簿只存"人给的规矩"和"被核出来的错"，但"这个仓怎么跑、常改哪儿"同样会随着会话
 * 丢掉。事实层从**跑通那一轮**的 run_events 里抽，只认三种确定性事实（见 factsFromEvents）：
 *   · 验证命令：`node tools/run-smokes.mjs` / `npm test` / `pytest` …
 *   · 重启方式：`bandi restart`
 *   · 常改文件：同一文件在 ≥2 轮里被改过（只记这类多次证实的，避免把一次性临时脚本带进来）
 * 摘不出来就一条都不记 —— 宁可少，不要猜。
 */
import * as store from './store.mjs';
import { cleanCommand } from './progress-ledger.mjs';

/** 注入配额：超了就削，宁少不滥。三类加起来 10 行 */
export const INJECT = Object.freeze({
  repo: 4,
  pitfall: 3,
  fact: 3,
  lineMax: 160,
  blockMax: 1200,
});

/** 只有平台核对出来的通知算"坑" —— 建卡失败那类是我（平台）的问题，不是他的坑 */
const HARVEST_KINDS = new Set(['audit']);

const clamp = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * 去重用的归一化：把**会变的那部分**抹掉（日期、卡号、轮次 id、纯数字），留住"是哪一类事"。
 *
 * 为什么必须抹：同一个坑每犯一次，detail 里的卡号、耗时、命令条数都不一样 ——
 * 不归一化就会变成 5 条各说一遍的坑，而人想看的是"这个坑他犯了 5 次"。
 */
export function normalizeForDedupe(text) {
  return String(text ?? '')
    .replace(/pt-[0-9a-z]+/gi, '<card>')
    .replace(/\br-[0-9a-z]{6,}/gi, '<run>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * 一条通知 → 一条坑。返回 `{ text, dedupe }`，不值得记的返回 null。
 *
 * 取法：标题（去掉【类型】前缀）+ 详情第一条**破折号之前**那半句。
 * 为什么只取前半句：`——` 后面是**这一轮的证据**（跑过的命令、当时的卡号、耗时），
 * 每次都不一样。把它写进经验簿，同一个坑就会变成"一句话重复五遍"；
 * 证据留在 run_events 和信箱里，那儿才是该查证据的地方。
 */
export function pitfallFromNotice(notice) {
  if (!notice || !HARVEST_KINDS.has(String(notice.kind ?? ''))) return null;
  const core = String(notice.title ?? '').replace(/^【[^】]*】\s*/, '').trim();
  if (!core) return null;
  const first = String(notice.detail ?? '')
    .split('\n')
    .map((l) => l.replace(/^[·\-*•]\s*/, '').trim())
    .find(Boolean) ?? '';
  // 破折号前那半句 = "是哪一类错"；破折号后 = 这一轮的证据（不进来）
  const brief = first
    .split('——')[0]
    .replace(/^pt-[0-9a-z]+\s*[：:]\s*/i, '')
    .trim();
  const text = clamp(brief ? `${core}：${brief}` : core, 200);
  return { text, dedupe: `audit:${store.shortHash(`${normalizeForDedupe(core)}|${normalizeForDedupe(brief)}`)}` };
}

/**
 * 收尾采集：把这一轮**被核出来**的事记成他的坑。
 *
 * 时机在 `taskClaimAudit.reconcile` 与 `criteriaAudit.reconcile` **之后** —— 那两个先把结论写进
 * notices，这里只是把结论抄进经验簿（一个来源、两处读，不重算事件）。
 *
 * 不抛错：收尾链路上任何一环挂掉都不该影响 run 的收束（onRunFinish 是最后一段）。
 * 同一个 runId 只采一次（进程内记账）：run 收尾被重放时不该把 hits 刷成 2。
 */
const harvestedRuns = new Set();

export function harvest({ run } = {}) {
  const out = [];
  try {
    if (!run?.id || !run.personaId) return out;
    if (harvestedRuns.has(run.id)) return out;
    harvestedRuns.add(run.id);
    if (harvestedRuns.size > 500) {
      // 只防内存涨：这是进程内的一次性去重，不是账本（账本在 evidence 里）
      for (const k of harvestedRuns) {
        harvestedRuns.delete(k);
        if (harvestedRuns.size <= 250) break;
      }
    }
    for (const notice of store.listNoticesForRun(run.id)) {
      const p = pitfallFromNotice(notice);
      if (!p) continue;
      const r = store.addPersonaNote({
        personaId: run.personaId,
        kind: 'pitfall',
        text: p.text,
        source: 'audit',
        dedupe: p.dedupe,
        evidence: { runId: run.id, noticeId: notice.id, conversationId: run.conversationId ?? null },
      });
      out.push({ id: r.note?.id, merged: r.merged, text: r.note?.text, hits: r.note?.hits });
    }
    if (out.length) {
      console.log(`[经验簿] ${run.id} 记下 ${out.length} 条（合并 ${out.filter((x) => x.merged).length}）`);
    }
  } catch (e) {
    console.warn(`[经验簿] 采集失败（不影响收尾）：${e?.message ?? e}`);
  }
  return out;
}

/* ---------------------------------------------------------------- 相关性召回 */

const CJK_RE = /[\u4e00-\u9fff]/;

/**
 * 把一段话拆成可比较的词：英文/路径词 + 中文二元组（不做分词，也不猜同义）。
 *
 * 为什么不用 SQLite FTS5：这里的中文没有分词器，`unicode61` 会把整句当一个词，
 * `trigram` 又要求查询至少 3 个字；而每人候选集最多几百行 —— 确定性的二元组重叠
 * 既够用，也不会因为分词误差把"相关的"漏掉。
 */
export function tokensOf(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_][a-z0-9_./-]{1,}/g) ?? []) out.add(w);
  for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 相关度：共享词越多个越相关；英文/路径词一次顶两个中文二元组（信息量更大） */
export function scoreText(query, text) {
  const q = tokensOf(query);
  if (!q.size) return 0;
  let score = 0;
  for (const t of tokensOf(text)) {
    if (q.has(t)) score += CJK_RE.test(t) ? 1 : 2;
  }
  return score;
}

/** 有查询词就按相关度稳定排序；没有查询词就保持调用方给的顺序（口径按新、坑按次数） */
function ranked(list, query, limit) {
  if (!query) return list.slice(0, limit);
  return list
    .map((item, i) => ({ item, i, score: scoreText(query, item.text) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

/**
 * 注入块。一条都没有就返回空串 —— **不要印一个空壳**（模型会当成"该有内容却缺了"）。
 *
 * @param {object} o
 * @param {string} o.personaId
 * @param {string} [o.query] 本轮任务文本（雇主原话 + 卡标题/描述 + 流程本步）；空 = 不排序
 * @param {string|null} [o.root] 当前仓库根；给了就只取"该仓库 + 全局"的事实
 */
export function memoryBlock({ personaId, query = '', root = null } = {}) {
  const pid = String(personaId ?? '').trim();
  if (!pid) return '';
  let repo = [];
  let pits = [];
  let facts = [];
  try {
    // 先多取一些再按相关度截：只取前 N 条再排序的话，相关的可能根本没进候选
    repo = ranked(store.listPersonaNotes(pid, { kind: 'repo', limit: INJECT.repo * 4 }), query, INJECT.repo);
    pits = ranked(
      store
        .listPersonaNotes(pid, { kind: 'pitfall', limit: 40 })
        .slice()
        .sort((a, b) => (b.hits ?? 0) - (a.hits ?? 0)),
      query,
      INJECT.pitfall,
    );
    facts = ranked(
      store
        .listPersonaFacts(pid, { scope: root ? store.normalizeScope(root) : null, limit: 60 })
        // 常改文件要 ≥2 轮才算事实：只改过一次的，多半是这一轮的临时脚本
        .filter((f) => f.kind !== 'path' || (f.hits ?? 1) >= 2),
      query,
      INJECT.fact,
    );
  } catch {
    return ''; // 读不到就当没有：绝不因为一段提醒挡住派活
  }
  if (!repo.length && !pits.length && !facts.length) return '';

  const lines = [
    '【长期记忆 · 你在这台机器上已经知道的事】',
    '（平台从真实发生过的事里记的，不是你上次会话的回忆。**直接用，别重新发现一遍**；和本轮任务无关就别提它。）',
  ];
  if (repo.length) {
    lines.push('', '· 这个团队的口径');
    for (const n of repo) lines.push(`  - ${clamp(n.text, INJECT.lineMax)}`);
  }
  if (facts.length) {
    lines.push('', '· 平台记下的事实（跑通过的命令 / 常在动的文件；可以直接用）');
    for (const f of facts) lines.push(`  - ${clamp(f.text, INJECT.lineMax)}`);
  }
  if (pits.length) {
    lines.push('', '· 你踩过的坑（括号里是被核出过的次数）');
    for (const n of pits) {
      const times = Number(n.hits ?? 1);
      lines.push(`  - ${clamp(n.text, INJECT.lineMax)}${times > 1 ? `（${times} 次）` : ''}`);
    }
  }
  const text = lines.join('\n');
  return text.length > INJECT.blockMax ? `${text.slice(0, INJECT.blockMax - 1)}…` : text;
}

/** 老名字（无查询词）—— 保留给 CLI / 冒烟直接用；派活走 memoryBlock 带 query */
export function experienceBlock(personaId) {
  return memoryBlock({ personaId });
}

/* ---------------------------------------------------------------- 事实抽取 */

/** 确定性可认的验证命令。顺序有意义：先精确的，后泛的 */
const VERIFY_RULES = Object.freeze([
  [/^node\s+tools\/run-smokes\.mjs\b/, '冒烟验证', 'node tools/run-smokes.mjs'],
  [/^npm\s+run\s+lint\b/, '检查', 'npm run lint'],
  [/^npm\s+run\s+build\b/, '构建', 'npm run build'],
  [/^npm\s+run\s+typecheck\b/, '类型检查', 'npm run typecheck'],
  [/^npm\s+(run\s+)?test\b/, '测试', 'npm test'],
  [/^pytest\b/, '测试', 'pytest'],
  [/^go\s+test\b/, '测试', 'go test ./...'],
  [/^cargo\s+test\b/, '测试', 'cargo test'],
  [/^dotnet\s+test\b/, '测试', 'dotnet test'],
]);

/** 不该记成"事实"的路径：依赖、产物、临时目录、员工自己写的验证脚本 */
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|target|gen|tmp|uploads|backups|\.cache)\//i;
const SKIP_FILE = /^(test|tmp|scratch)[-_][^/]*$/i;

/** 路径相对化；仓库外的绝对路径返回 null（别把别的仓的事实记到这个人头上） */
function relOf(p, root) {
  const s = String(p ?? '').replace(/\\/g, '/').trim();
  if (!s) return null;
  const r = store.normalizeScope(root ?? '');
  if (/^[a-z]:\//i.test(s) || s.startsWith('/')) {
    if (!r || !s.toLowerCase().startsWith(`${r}/`)) return null;
    return s.slice(r.length + 1);
  }
  return s.replace(/^\.\//, '');
}

function harvestablePath(rel) {
  if (!rel || SKIP_PATH.test(rel)) return '';
  const base = rel.split('/').at(-1) ?? '';
  if (SKIP_FILE.test(base)) return '';
  if (/\.(log|tmp)$/i.test(base)) return '';
  return rel;
}

/**
 * 从一轮的事件里抽事实（纯函数，冒烟直接喂事件）。
 *
 * @param {Array<object>} events 已解析的事件对象，按 seq 升序
 * @param {{root?: string|null}} [o]
 * @returns {Array<{kind:string, text:string, scope:string, dedupe:string, evidence?:object}>}
 */
export function factsFromEvents(events, { root = null } = {}) {
  const scope = store.normalizeScope(root ?? '');
  const commands = new Map(); // canonical → { kind, text }
  const paths = new Map(); // rel → 本轮编辑次数

  for (const e of events) {
    if (e?.type !== 'tool') continue;
    const d = e.input ?? e.detail ?? {};
    const raw = d.command ?? d.cmd ?? '';
    if (raw) {
      const cmd = cleanCommand(raw).replace(/\s+/g, ' ').trim();
      for (const [re, label, canonical] of VERIFY_RULES) {
        if (re.test(cmd)) {
          commands.set(canonical, { kind: 'command', text: `${label}：${canonical}` });
          break;
        }
      }
      if (/^bandi\s+restart\b/i.test(cmd)) {
        commands.set('bandi restart', { kind: 'restart', text: '重启：bandi restart' });
      }
    }

    // 只认改动类事件，同 progress-ledger 的口径：Read 带 path 不算"改过"
    const changes = Array.isArray(d.changes) ? d.changes : [];
    const mutating = changes.length > 0 || e.name === 'file_change' || e.name === 'apply_patch';
    if (!mutating) continue;
    const list = changes.length
      ? changes.map((c) => c?.path).filter(Boolean)
      : [d.path ?? d.file].filter(Boolean);
    for (const p of list) {
      const rel = harvestablePath(relOf(p, root));
      if (rel) paths.set(rel, (paths.get(rel) ?? 0) + 1);
    }
  }

  const out = [];
  for (const [canonical, v] of commands) {
    out.push({ ...v, scope, dedupe: `fact:${v.kind}:${store.shortHash(canonical)}` });
  }
  // 一轮里改得最多的两个文件才值得记；其余下一轮还会出现
  for (const [rel, edits] of [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    out.push({
      kind: 'path',
      text: `常改：${rel}`,
      scope,
      dedupe: `fact:path:${store.shortHash(`${scope}|${rel}`)}`,
      evidence: { path: rel, edits },
    });
  }
  return out;
}

/**
 * 收尾采集事实：只从**跑通（status=done）**的那一轮里抽 —— 失败了还照抄命令，
 * 等于把一个没验证过的东西写进长期记忆。
 *
 * 与 `harvest` 一样：不抛错、同一 run 只采一次（run 收尾被重放不刷 hits）。
 */
const harvestedFactRuns = new Set();

export function harvestFacts({ run } = {}) {
  const out = [];
  try {
    if (!run?.id || !run.personaId) return out;
    if (run.status !== 'done') return out;
    if (harvestedFactRuns.has(run.id)) return out;
    harvestedFactRuns.add(run.id);
    if (harvestedFactRuns.size > 500) {
      for (const k of harvestedFactRuns) {
        harvestedFactRuns.delete(k);
        if (harvestedFactRuns.size <= 250) break;
      }
    }
    const rows = store.tailRunEvents(run.id, 300) ?? [];
    const events = rows
      .slice()
      .reverse()
      .map((r) => {
        try {
          return JSON.parse(r.evt);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    for (const f of factsFromEvents(events, { root: run.root ?? null })) {
      const r = store.addPersonaFact({
        personaId: run.personaId,
        scope: f.scope,
        kind: f.kind,
        text: f.text,
        source: 'audit',
        dedupe: f.dedupe,
        evidence: { runId: run.id, ...(f.evidence ?? {}) },
      });
      out.push({ id: r.fact?.id, text: r.fact?.text, hits: r.fact?.hits, merged: r.merged });
    }
    if (out.length) {
      console.log(`[长期记忆] ${run.id} 记下 ${out.length} 条事实（合并 ${out.filter((x) => x.merged).length}）`);
    }
  } catch (e) {
    console.warn(`[长期记忆] 事实采集失败（不影响收尾）：${e?.message ?? e}`);
  }
  return out;
}

/**
 * 显式记一条（接口 / CLI 用）。**只让这句"人给的口径"进来**，不让模型自由发挥：
 * 正文超过 300 字会被 store 截断，那已经说明它不该是一条口径，而该是一份文档。
 */
export function remember({ personaId, kind = 'repo', text, source = 'manual', evidence = null } = {}) {
  return store.addPersonaNote({ personaId, kind, text, source, evidence });
}
