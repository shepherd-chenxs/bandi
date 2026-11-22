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
 * 每轮派活把两类各取几条，摆在任务之后、方法论之前：
 *   · 口径最多 6 条、坑最多 5 条（按 hits 高的在前），每条一行、整块 ≤ 900 字；
 *   · 一条都没有 → 返回空串，**不出现空块**（空块会让模型以为"这里该有内容却缺了"）。
 *
 * 为什么要有上限：这不是知识库，是"别在同一个地方摔第二次"的提醒。十行以内他会看，
 * 五十行他会跳过 —— 而跳过之后，这块就变成纯占 token。
 */
import * as store from './store.mjs';

/** 注入配额：超了就削，宁少不滥 */
export const INJECT = Object.freeze({
  repo: 6,
  pitfall: 5,
  lineMax: 160,
  blockMax: 900,
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

/**
 * 注入块。一条都没有就返回空串 —— **不要印一个空壳**（模型会当成"该有内容却缺了"）。
 */
export function experienceBlock(personaId) {
  const pid = String(personaId ?? '').trim();
  if (!pid) return '';
  let repo = [];
  let pits = [];
  try {
    repo = store.listPersonaNotes(pid, { kind: 'repo', limit: INJECT.repo });
    // 坑按"被核出几次"排 —— 反复犯的那条才是真该提醒的；同次数时新的在前（库里已按 updatedAt 排）
    pits = store
      .listPersonaNotes(pid, { kind: 'pitfall', limit: 40 })
      .slice()
      .sort((a, b) => (b.hits ?? 0) - (a.hits ?? 0))
      .slice(0, INJECT.pitfall);
  } catch {
    return ''; // 读不到就当没有：绝不因为一段提醒挡住派活
  }
  if (!repo.length && !pits.length) return '';

  const lines = [
    '【经验簿 · 你在这台机器上已经知道的事】',
    '（平台从真实发生过的事里记的，不是你上次会话的回忆。**直接用，别重新发现一遍**；和本轮任务无关就别提它。）',
  ];
  if (repo.length) {
    lines.push('', '· 这个团队的口径');
    for (const n of repo) lines.push(`  - ${clamp(n.text, INJECT.lineMax)}`);
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

/**
 * 显式记一条（接口 / CLI 用）。**只让这句"人给的口径"进来**，不让模型自由发挥：
 * 正文超过 300 字会被 store 截断，那已经说明它不该是一条口径，而该是一份文档。
 */
export function remember({ personaId, kind = 'repo', text, source = 'manual', evidence = null } = {}) {
  return store.addPersonaNote({ personaId, kind, text, source, evidence });
}
