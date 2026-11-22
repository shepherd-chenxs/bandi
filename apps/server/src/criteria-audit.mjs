/**
 * **判据核对**（2026-11-22，缺口②的"收尾那一半"）：这一轮的动作，够不够格说"做完了"。
 *
 * 与 `task-claim-audit.mjs` 的分工（两个都挂在 `runs.onRunFinish`，别混）：
 *   · 台账核对管**说话与事实**（声称的卡号存不存在、文件在不在、声称已执行的命令跑没跑）；
 *   · 这里管**动作与岗位判据**（这个岗声称完成，必须跑过的那件事到底跑没跑）。
 * 前者是"你说了假话"，后者是"你没按这个岗位的规矩收工"——两件事，处置也不同。
 *
 * 处置只有一种：**记信箱，不改卡、不 @ 人、不自动重跑**。
 *   · 不改卡：验收权在人手里（`delivery-evidence.mjs` 写在最前面的那条）；
 *   · 不 @ 人：平台不以雇主口吻在群里说话（2026-11-15 用户口径），也不替雇主催工；
 *   · 不自动重跑：判据未过往往不是"差一次跑"，自动重跑会变成"每轮都重跑"的循环
 *     （与 claim-audit 的 env 分支同一条理由）。
 * 所以它现在的价值是**让这件事有账**：雇主在信箱里看得见，人格化决策留给他。
 *
 * 时机：注册在 `taskClaimAudit.reconcile` **之后**（server.mjs 的注册顺序）——先让
 * `[完成]` 把卡流转完，再看这一轮的动作够不够，避免"卡刚转待验收就同时报判据未过"的自相矛盾。
 */
import * as store from './store.mjs';
import { claimOf } from './delivery-claim.mjs';
import { criteriaFor, actionsOf, checkCriteria } from './role-criteria.mjs';

/** `listRunEvents` 回来的是 {seq, evt:<json 字符串>}；解析失败的跳过，不让核对挂掉 */
function parseEvents(runId) {
  const out = [];
  for (const row of store.listRunEvents(runId, 0)) {
    try {
      const evt = JSON.parse(row.evt);
      if (evt) out.push(evt);
    } catch {
      /* 坏事件跳过 */
    }
  }
  return out;
}

/**
 * 核一条 run。返回 `{checked, failed, skipped}`（供日志/冒烟读，不抛错）。
 */
export function reconcile({ run } = {}) {
  const empty = { checked: 0, failed: [], skipped: [] };
  if (!run?.id || !run.conversationId) return empty;

  const persona = run.personaId ? store.getPersona(run.personaId) : null;
  const criteria = criteriaFor(persona?.roleKey ?? '');
  if (!criteria.length) return empty;

  const actions = actionsOf(parseEvents(run.id));
  const claimed = claimOf(run.finalText);
  const { checked, failed, skipped } = checkCriteria({ criteria, actions, claimed });

  console.log(
    `[判据核对] ${run.id} ${persona?.name ?? run.personaId ?? '(无)'}：核 ${checked.length} 条` +
      `（完成声明=${claimed === 'done' ? '是' : '否'}），未过 ${failed.length} 条，跳 ${skipped.length} 条`,
  );

  if (failed.length) {
    store.addNotice({
      kind: 'audit',
      severity: 'warn',
      title: '【判据核对】声称完成，但岗位判据里的动作没有发生',
      detail:
        failed.map((f) => `· ${f.label} —— ${f.why}`).join('\n') +
        '\n\n这不是措辞问题，是动作没发生：判据核的是本轮工具事件，不是回话怎么写。' +
        '要放行还是让他重做，你定。',
      conversationId: run.conversationId,
      personaId: run.personaId ?? null,
      runId: run.id,
      dedupeKey: `criteria:${run.id}`,
    });
  }

  return { checked: checked.length, failed, skipped };
}
