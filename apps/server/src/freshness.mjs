/**
 * 上下文更新闸（2026-11-15，借鉴 Cumora COORDINATION.md §5 freshness preflight）。
 *
 * 问题：员工被唤醒那一刻拿到的是当时的群聊快照；他干活这几分钟里，别人可能又发了
 * 新消息 —— 他的回复就是**基于过期信息**的。Cumora 的解法：发送前预检"我看过之后
 * 有没有新消息"，有就 HELD（扣下），把新消息摆给员工重新决策。
 *
 * bandi 的形态更轻：**不扣回话**（扣了要重构整条消息管线），改为**紧跟一条上下文
 * 更新简报** @ 该员工 —— 他自己判断要不要修正。只覆盖最有价值的一档：
 *   · **群聊**（1:1 里雇主的新消息本来就由正常派活接管，不用这里管）；
 *   · 上一轮回复期间来了**其他同事**的新发言（role=assistant 的）——
 *     雇主自己的新消息会被正常派活机制处理；平台卡票消息（meta.type='card'，
 *     派活卡/回执卡都算）与【台账核对】不算。
 *
 * 闸的纪律（Cumora 的教训直接搬）：
 *   · 每个群 5 分钟冷却 —— 忙碌房间里无限接力是真实风险；
 *   · 简报只列最近 3 条、每条截断 —— 噪音滤掉，判断留给员工；
 *   · 简报明说"没变就不用回" —— 不制造礼貌性确认的噪音。
 */
import * as store from './store.mjs';
import { dispatchEventToThread } from './dispatch.mjs';
import { onReplyPersisted } from './runs.mjs';

const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_LIST = 3;
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** 回话落库时，上一轮期间有没有**其他同事**的新发言（平台通知不算）。有就返回简报数据。 */
export function stalePeersOf({ run, message }) {
  const conv = store.getConversation(run.conversationId);
  if (!conv || conv.kind !== 'group') return null;
  const peers = store
    .listMessagesSince(run.conversationId, run.watermark ?? 0, message.id)
    .filter((m) => m.role === 'assistant' && m.personaId && m.personaId !== run.personaId)
    // 卡票消息是平台登记（派活/回执），不是同事在对话里发言 —— 2026-11-16 起回执文案
    // 从【卡片回执】开头改成 "@建卡人 请验收"，前缀认不出来了，改认 meta.type='card'；
    // 旧库里的老回执没 meta 标记，仍用前缀兜住。
    .filter((m) => m.meta?.type !== 'card' && !/^(【卡片回执】|【台账核对】)/.test(String(m.text ?? '')));
  if (!peers.length) return null;
  return peers.slice(-MAX_LIST).map((m) => ({
    name: m.personaName ?? '同事',
    text: clip(m.text, 120),
  }));
}

export function freshnessBrief(peers) {
  return [
    '【上下文更新】你上一轮回复期间，群里新来了这些消息（可能影响你的结论）：',
    ...peers.map((p) => `· ${p.name}：${p.text}`),
    '基于最新情况重新考虑 —— 结论变了就修正一句；没变就不用回。',
  ].join('\n');
}

const lastBriefAt = new Map(); // convId → 上次简报时刻

export function freshnessGate({ run, message }) {
  try {
    const conv = store.getConversation(run.conversationId);
    if (!conv || conv.kind !== 'group') return;
    const last = lastBriefAt.get(run.conversationId) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    const peers = stalePeersOf({ run, message });
    if (!peers?.length) return;
    lastBriefAt.set(run.conversationId, Date.now());
    /*
     * **只提醒，不唤醒**（2026-11-15 实测踩坑）：初版 @ 了经办人自动续跑 —— 群派冒烟里
     * 两个人两轮对话跑出了四次 run（A 回复期间 B 发言 → @A 补跑 → A 补跑期间 B 又……
     * 乒乓循环）。Cumora 用 HELD（扣下回话让 agent 基于新状态重想）解决，那个架构
     * bandi 还没有 —— 所以这里降级为**给人看的提示**：不带 @（@ 会唤醒，见契约第 10 条），
     * 落一条通知进会话，雇主看得见"这条回复基于过期信息"，要不要追究由人定。
     */
    const text = [
      '【上下文更新】（知会：下面这条回复基于它开始时的群聊状态；期间新来了这些消息）',
      ...peers.map((p) => `· ${p.name}：${p.text}`),
    ].join('\n');
    // **直接落库，不走 dispatchEventToThread**：那条路是"派活"——没有 @ 目标就直接跳过
    // （实测：知会条根本不落库）。这条知会**刻意不 @ 任何人**（@ 会唤醒，见契约第 10 条 ——
    // 初版 @ 了经办人自动续跑，群派冒烟里两人两轮对话跑出四次 run，乒乓循环）。
    store.addMessage({ conversationId: run.conversationId, role: 'user', text });
  } catch (e) {
    console.warn(`[上下文更新] 简报没发出去（${run?.conversationId}）：${e?.message ?? e}`);
  }
}

// 回话落库即核对（与 @ 接力同一个钩子；注册顺序在接力之后 —— dispatch 先注册）
onReplyPersisted(freshnessGate);
