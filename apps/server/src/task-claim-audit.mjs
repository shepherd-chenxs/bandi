/**
 * 台账核对（2026-11-14 用户拍板"做"）：员工回话里**声称**的卡号与状态，和台账对一遍，
 * 对不上就跟一条平台更正。
 *
 * 起因（当天第三次「回话说的」和「台账实际」不符）：贺韬报「已派研发实现卡给嘉辉
 * （pt-8c1b3d2f doing）」—— 台账里根本没有这张卡。提示词（不编数 / 不空转 /
 * 甲方只要结果，见 dispatch.platformContractBlock 第 11 条）压不住模型的一时虚构，
 * 只有**确定性核对**能兜住：卡号是平台发的，"还没建的卡的号"不可能被预告。
 *
 * 只核两件最硬的事（其余启发式容易误报，先不做）：
 *   ① **存在性**：回话里出现的每个 `pt-` 卡号，台账里必须存在；
 *   ② **完成声明**：卡号所在句子里有「标记完成 / 已转 done / 已完成」→ 台账必须是 done
 *      （声称的动作，run 收尾时早就该落库 —— 这轮没做就是没做）。
 * 「已派 … doing」这类只核存在性：卡可能已经跑完进了下一态，状态词对不上不算撒谎。
 *
 * 时机：挂在 runs.onRunFinish、且注册在 onTaskRunFinished **之后**（server.mjs 的注册
 * 顺序保证）—— 先让 [完成] 标记把卡状态流转完，再核对，避免"员工刚声明交付、
 * 卡还在待验收"的假阳性。
 *
 * 更正怎么发：**进信箱（addNotice），不进聊天、不 @ 员工、不唤醒任何运行** ——
 * 平台不以雇主的口吻在群里说话（2026-11-15 用户："我不需要他替我回复"）；
 * dedupeKey 按 run 记，同一轮的核对只进一次信箱。
 */

import * as store from './store.mjs';
import { candidateRoots, resolveInRoots } from './routes/workspace.mjs';
import { dispatchEventToThread } from './dispatch.mjs';

/** 卡号：pt- 前缀 + 6~16 位十六进制（平台 newId 的实际形态） */
const ID_RE = /\bpt-[0-9a-f]{6,16}\b/gi;
/** 完成**声明**词：出现在卡号所在的句子里，就当作"这张卡已被我标成 done" */
const DONE_RE = /(标记完成|已转\s*done|已完成|已标为|转\s*done)/i;
/**
 * 系统动作的**执行声明**（2026-11-14 关机虚报补的核对）：已执行 / 已运行 / 已设置 /
 * 已部署 / 已重启 + 反引号里的命令。崔老三那次：thinking 里明明白白计划了
 * 「Let me execute the shutdown command」→ 下一跳直接写报告，工具一次没调。
 */
const EXEC_RE = /已(?:执行|运行|设置|部署|重启)(?:了)?\s*[：:]?\s*`([^`]+)`/g;
/** 这句话是**历史引用**（昨天 / 之前 / 上一轮做过的事），不算本轮的执行声明 */
const PAST_REF_RE = /(昨天|之前|上一轮|上次|早前)/;
/**
 * 回话里**不值得核对的句子**：将来时 / 提案 / 疑问 / 引导去别处看 —— 这些句子里
 * 提到的路径还没发生（贺韬"我把它复制一份到根目录"的提案句不能当"已落盘"抓）。
 */
const SKIP_SENTENCE_RE = /(还没|将(要|会|落盘|写入|创建|生成|复制|开)|准备|计划|例如|比如|（如|建议|拍板|同意|要不要|吗)/;
/**
 * 文件路径的**正向声明**白名单（2026-11-15 张坤实报修）：只核对带着这些词的句子 ——
 * 「已查：…均不可用」是**否定式诊断**（路径被他报告为"查过了、不存在"），黑名单
 * （排除句）永远追不完，白名单才能零误判：没有正向声明 = 没有核对对象。
 */
const FILE_CLAIM_RE = /(落盘|已写入|已保存|已生成|已创建|已放到|已复制|已落到|证据|已存在)/;
/** 打回重做的预算：同一轮里同一处不一致只打回一次 —— 重做还不行才升级信箱 */
const MAX_BOUNCE = 1;
const bounceBudget = new Map(); // key: runId:id:kind → 已打回次数

/**
 * 从回话文本里抽**声称的卡**。按句子（换行 / 。/ ；/ 分号）归组：
 * 卡号与完成词同句才算完成声明 —— 隔了一句的"已完成"是别人的事。
 */
export function claimedCards(text) {
  const out = new Map();
  const sentences = String(text ?? '')
    .split(/[\n。；;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sentences) {
    for (const m of s.matchAll(ID_RE)) {
      const id = m[0].toLowerCase();
      const cur = out.get(id) ?? { id, doneClaim: false };
      if (DONE_RE.test(s)) cur.doneClaim = true;
      out.set(id, cur);
    }
  }
  return [...out.values()];
}

/**
 * 抽**系统动作的执行声明**：已执行 / 已运行 / 已设置 / 已部署 / 已重启 + 反引号命令。
 * 含"昨天 / 之前"等字样的句子是历史引用，不算本轮声明。
 */
export function claimedExecCommands(text) {
  const out = [];
  for (const s of String(text ?? '').split(/[\n。；;]+/).map((x) => x.trim()).filter(Boolean)) {
    if (PAST_REF_RE.test(s)) continue;
    for (const m of s.matchAll(EXEC_RE)) {
      const cmd = m[1].trim();
      if (cmd) out.push(cmd);
    }
  }
  return [...new Set(out)];
}

/**
 * 核对一条 run 的最终回话。返回不一致清单（空数组 = 全对得上）：
 *   · { id, kind: 'missing', line }   —— 声称的卡台账里没有；
 *   · { id, kind: 'status', line, actual } —— 声称已完成，台账还是别的状态。
 */
/**
 * 抽回话里的**文件路径**词元（含 / 或 \ 且带扩展名；剥尾部标点与 :行号）。
 * 含空格的路径 v1 放弃 —— 漏报不误报。URL / 卡号 / 纯数字 / 版本号都不算。
 */
function filePathTokens(text) {
  const out = new Set();
  for (const raw of String(text ?? '').split(/[^\w\u4e00-\u9fa5.:\\/+\-]/)) {
    let s = raw.trim();
    if (/^https?:/i.test(s) || s.includes('?') || s.includes(' ')) continue;
    if (/^pt-[0-9a-f]/i.test(s)) continue;
    s = s.replace(/:\d+$/, '');
    if (s.length < 4 || s.length > 200) continue;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(s)) continue;                 // 必须带扩展名
    if (!/(\/|\\)/.test(s) && !/^[A-Za-z]:[\\/]/.test(s)) continue; // 必须含分隔符或盘符
    if (/^[0-9.]+$/.test(s)) continue;
    out.add(s);
  }
  return [...out];
}

/**
 * 核对回话里声称的**文件路径**（2026-11-14 沈丹青实报）：
 * "稿件已落盘"说得再笃定，文件不在就是不在 —— fs 验证，零误判。
 * 解析口径与 /api/workspace/file 同一套（candidateRoots + resolveInRoots）：
 * 相对路径按会话成员的工作目录 / 项目根猜；绝对路径只要落在任一注册根里就算存在。
 */
function auditFileClaims(text, convId, notices) {
  for (const p of filePathTokens(text)) {
    const abs = resolveInRoots(p, candidateRoots(convId));
    if (!abs) {
      notices.push({
        id: `file:${p.toLowerCase()}`,
        kind: 'file',
        line: `声称落盘 / 存在的文件找不到：${p} —— 要么补写，要么更正回话`,
      });
    }
  }
}

export function auditRunReply({ run }) {
  const text = String(run?.finalText ?? '');
  if (!text.trim() || !run?.conversationId) return [];
  const notices = [];
  for (const c of claimedCards(text)) {
    const card = store.getProjectTask(c.id) ?? null;
    if (!card) {
      notices.push({ id: c.id, kind: 'missing', line: `台账里没有这张卡 —— 声称的派卡 / 改动没有发生：要么补建，要么更正回话` });
      continue;
    }
    if (c.doneClaim && card.status !== 'done') {
      const label = store.TASK_LABEL[card.status] ?? card.status;
      notices.push({
        id: c.id,
        kind: 'status',
        actual: card.status,
        line: `声称已完成 —— 台账里还是「${label}」：改状态的动作没有发生`,
      });
    }
  }
  /*
   * ②-b 系统动作的执行声明（2026-11-14 关机虚报）：声称"已执行 X" → 本轮 run_events
   * 里必须有 **type:'tool'** 的事件真调过这条命令（按命令首词匹配）。
   * ⚠️ 只认 tool 事件 —— thinking 里"想过这条命令"不算（崔老三那次：thinking 写了
   * 「Let me execute the shutdown command」，工具一次没调，回话照样说"已执行"）。
   */
  for (const cmd of claimedExecCommands(text)) {
    const toolEvs = store
      .listRunEvents(run.id, 0)
      .map((e) => {
        try { return JSON.parse(e.evt); } catch { return null; }
      })
      .filter((e) => e?.type === 'tool');
    const first = cmd.trim().split(/\s+/)[0].toLowerCase();
    const executed = toolEvs.some((e) => JSON.stringify(e.input ?? e).toLowerCase().includes(first));
    if (!executed) {
      notices.push({
        id: `exec:${first}`,
        kind: 'exec',
        line: `声称已执行 \`${cmd}\` —— 本轮没有任何工具调用真的跑过它（凭空报告执行结果）`,
      });
    }
  }
  // ②-c 文件路径核对（2026-11-14 沈丹青实报）："稿件已落盘" —— 文件不在就是不在。
  // 只核对**正向声明句**（落盘 / 已写入 / 证据…）—— 否定式诊断（"已查：…均不可用"）
  // 里的路径是"报告为不存在"，不是"声称存在"，绝不核对（2026-11-15 张坤实报的误报）。
  const claimSentences = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/[\n。；;]+/)
    .map((s) => s.trim())
    .filter((s) => s && FILE_CLAIM_RE.test(s) && !SKIP_SENTENCE_RE.test(s));
  for (const s of claimSentences) {
    auditFileClaims(s, run.conversationId, notices);
  }
  return notices;
}

/**
 * 核对 + 发更正。有不一致 → 组一条【台账核对】通知（@ 经办员工，唤醒他自己补），
 * 返回实际核对出的不一致清单。
 */
/**
 * **核对处置**（2026-11-15 用户口径："如果他撒谎，应该是解决他撒谎的问题"）：
 * 核对出不一致，程序**直接把账做平 / 打回员工真做**，不给雇主写信。
 *
 *   · 状态类（声称已完成、卡还在待验收）→ **声称人就是建卡人（验收人）**时，
 *     验收决定已经用文字表达了，程序照办：落 done —— 账实一致，谎言被"做实"。
 *     建卡人之外的人声称完成 = 越权无效，不改账（卡留在待验收给真验收人）。
 *   · 存在类（声称已派的卡不存在 / 声称落盘的文件找不到）→ **打回本人真做**：
     平台替他把自己的活干一遍没有意义，让他重做一次（有台账核对盯着，谎话第二次
 *     现形）；打回一次为限 —— 重做还不行，说明干不了，才升级信箱给雇主。
 *   · 执行类（声称已执行命令但本轮没跑过）→ **绝不自动补执行**（关机这类命令
 *     凭一句幻觉就真执行 = 灾难），声明无效、静默记录 —— 员工下轮重干时会
 *     被同一套核对再抓一次。
 */
export function reconcile({ run }) {
  const mismatches = auditRunReply({ run });
  if (!mismatches.length) return { mismatches, applied: [], bounced: [], escalated: [] };
  const convId = run.conversationId;
  const applied = [];
  const bounced = [];
  const escalated = [];

  for (const m of mismatches) {
    const bKey = `${run.id}:${m.id}:${m.kind}`;
    const times = bounceBudget.get(bKey) ?? 0;

    if (m.kind === 'status') {
      // **验收人（建卡人）的文字验收**：决定已表达，程序照办 —— 账做平
      const card = store.getProjectTask(m.id) ?? null;
      if (card && card.createdBy === run.personaId && card.status === 'review') {
        store.updateProjectTask(card.id, { status: 'done' });
        applied.push(`· ${m.id}：已按验收人声明标成 done`);
      }
      // 他人声称完成 = 越权无效：不改账（真验收人看到卡自然会处理）
      continue;
    }

    // 存在类（缺卡 / 缺文件）与执行类共用同一招：**打回本人真做**（一次为限）。
    // 执行类例外：绝不自动补执行（shutdown 凭幻觉执行 = 灾难），声明无效静默记录。
    if (m.kind === 'exec') continue;
    if (times >= MAX_BOUNCE) {
      escalated.push(`· ${m.id}：${m.line}`);
      continue;
    }
    bounceBudget.set(bKey, times + 1);
    bounced.push({ id: m.id, kind: m.kind, brief: m.line });
  }

  // 打回本人：真派一次（@ 他，唤醒他把自己声称的活真做掉）—— 这是纠偏动作，
  // 走 dispatchEventToThread（回执同一条路）。起跑失败按它的"不抛错"口径走，简报仍落库。
  for (const b of bounced) {
    const persona = run.personaId ? store.getPersona(run.personaId) : null;
    const who = persona?.name ?? '经办人';
    try {
      dispatchEventToThread(
        convId,
        `【台账核对】@${who} 你上一轮说的这件事和台账对不上：${b.brief}\n现在把它做掉——做完了正常回话，台账核对会再验一遍。`,
        { personaId: run.personaId ?? null },
      );
    } catch (e) {
      console.warn(`[台账核对] 打回重做没派出去（${convId}）：${e?.message ?? e}`);
    }
  }

  // 打回过后还没平的账 → 升级信箱给雇主（最后手段，不是第一反应）
  if (escalated.length) {
    store.addNotice({
      kind: 'audit',
      severity: 'warn',
      title: '【台账核对】打回重做后仍然对不上，需要你处理',
      detail: escalated.join('\n'),
      conversationId: convId ?? null,
      personaId: run.personaId ?? null,
      dedupeKey: `claim-audit:${run.id}`,
    });
  }
  return { mismatches, applied, bounced, escalated };
}
