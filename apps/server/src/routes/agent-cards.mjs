/* routes/agent-cards.mjs —— 数字员工的"工作证"接口（2026-10-24）。
 *
 * 目前只有一个动作：建任务卡。调用方是**正在跑的 agent 进程**（不是浏览器、不是 curl 用户），
 * 身份靠 runs.mjs 派活时注入进程环境的一次性钥匙（agent-auth）验证 —— 冒名者拿不到
 * 别人进程里的环境变量。钥匙在 run 收尾时吊销，活干完了就再也不能建卡。
 *
 * 权限：**只有项目经理岗位**能建卡（主理人 2026-10-24 拍板"只有固定的角色身份可以建卡，
 * 不然谁都能建卡就乱套了"）。岗位取 role 的第一段（「岗位 · 职责」口径，同前端 personLabel）。
 * 没钥匙 / 钥匙过期 → E2056；岗位不对 → E2057（两码顺位排，全仓无撞号）。
 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import { createProjectTask } from '../project-tasks.mjs';
import { isPmRole, verifyRunCredential } from '../agent-auth.mjs';

/** agent 建卡只许这两种状态：「待办」= 可逆的活，建完直接干；「想法」= 要雇主拍板，先挂着 */
const AGENT_STATUSES = new Set(['想法', '待办']);

export async function handleAgentCards(req, res, url) {
  const create = /^\/api\/agent\/cards$/.exec(url.pathname);

  if (req.method === 'POST' && create) {
    // 钥匙不对 → 401（身份没认下来，不是请求格式错）
    const cred = verifyRunCredential(req.headers['x-bandi-run-token']);
    if (!cred) return fail(res, 401, 'E2056', '建卡要带有效的运行钥匙（X-Bandi-Run-Token）—— 这个值在你的进程环境变量 BANDI_RUN_TOKEN 里');
    const persona = store.getPersona(cred.personaId);
    if (!persona) return fail(res, 401, 'E2056', '这把钥匙对应的员工已经不在了');

    // 岗位不对 → 403（认出来了，但没这个权）
    if (!isPmRole(persona.role)) {
      return fail(res, 403, 'E2057', '只有项目经理岗位能建任务卡 —— 你的岗位是「' + String(persona.role ?? '').split(' · ')[0].trim() + '」。要立项的活，把需求和理由说给项目经理或雇主。');
    }

    const body = await readBody(req);
    const status = String(body.status ?? '待办').trim();
    if (!AGENT_STATUSES.has(status)) {
      return fail(res, 400, 'E2058', `建卡状态只能是「待办」（建完自动派活）或「想法」（等雇主拍板），不能是「${status}」`);
    }

    // 项目：认 projectId；也收 projectRoot（agent 从任务里看到的是目录，不是 id）
    let project = body.projectId ? store.getProject(String(body.projectId)) : null;
    if (!project && body.projectRoot) {
      const root = String(body.projectRoot).replace(/[\\/]+$/, '');
      project = store.listProjects().find((p) => String(p.root).replace(/[\\/]+$/, '') === root) ?? null;
    }
    if (!project) return fail(res, 400, 'E2059', '建卡得指明挂哪个项目 —— 传 projectId 或 projectRoot（项目清单：GET /api/projects）');

    const title = String(body.title ?? '').trim().slice(0, 200);
    if (!title) return fail(res, 400, 'E2059', '任务得有标题（一句话说清要做什么）');
    const description = String(body.description ?? '').trim().slice(0, 8000);
    const assignee = body.assigneePersonaId ? String(body.assigneePersonaId) : null;

    try {
      // 建卡那次运行所在的会话 = PM 跟雇主说话的地方（群或 1:1）。
      // 记下来是为了卡片回执（project-tasks.mjs notifyCardCreator）：卡到「待验收」「已阻塞」「失败」时
      // 往这里投一条回执并唤醒他 —— 他答应雇主"有产出我再回你"，得给他兑现承诺的通道。
      const originRun = store.getRunRow(cred.runId);
      const task = createProjectTask(project, {
        title,
        description,
        status,
        personaId: assignee,
        // 「待办」+ 执行人 = 建完自动派活（与人手建卡同一条链路、同一套闸）；
        // 「想法」永远不派 —— 那是"等雇主拍板"，派了等于白建
        startNow: status === '待办' && !!assignee,
        createdBy: persona.id,
        creatorConvId: originRun?.conversationId ?? null,
      });

      /*
       * 卡票消息（2026-10-24）：建卡那一刻往 PM 说话的那场会话里落一张**票**。
       *
       * 为什么服务端发、而不是指望 PM 自己说：PM 的回话是他组织的散文（说没说卡号、
       * 说的 id 对不对都不可控）；票是结构化的（meta 带 cardId），界面上画成
       * 一张可点的卡 → 直达任务卡详情页。text 写一句人话兜底 —— 纯文本视图
       * （喂给 agent 的历史、老客户端）不认 meta 也不丢信息。
       * 以 PM 的名义（role: assistant + personaId）落，像 IM 里机器人的卡片消息；
       * **不派活、不叫醒任何人** —— 只是登记"这张卡在这场对话里立的"。
       * 「想法」也发：雇主拍板的入口本来就是这张票。
       */
      if (originRun?.conversationId) {
        const assigneeName = task.assigneePersonaId ? (store.getPersona(task.assigneePersonaId)?.name ?? null) : null;
        store.addMessage({
          conversationId: originRun.conversationId,
          role: 'assistant',
          personaId: persona.id,
          text: `【任务卡】${task.title} —— 已建立（${task.status}${assigneeName ? `，交给了 ${assigneeName}` : ''}）`,
          meta: {
            type: 'card',
            cardId: task.id,
            title: task.title,
            status: task.status,
            assignee: assigneeName,
          },
        });
      }

      return sendJson(res, 201, { task });
    } catch (e) {
      // 派活失败卡也在（createProjectTask 的口径）：把 id 带回去，agent 能跟雇主交代清楚
      return fail(res, 400, 'E2059', String(e.message ?? e), { taskId: e.taskId ?? null });
    }
  }

  return false;
}
