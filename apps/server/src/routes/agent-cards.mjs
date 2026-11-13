/* routes/agent-cards.mjs —— 数字员工的"工作证"接口（2026-10-24）。
 *
 * 调用方是**正在跑的 agent 进程**（不是浏览器、不是 curl 用户），身份靠 runs.mjs 派活时
 * 注入进程环境的一次性钥匙（agent-auth）验证 —— 冒名者拿不到别人进程里的环境变量。
 * 钥匙在 run 收尾时吊销，活干完了就再也不能建卡。
 *
 * 权限：**只有带「建卡」权限的岗位**能建卡（主理人 2026-10-24 拍板"只有固定的角色身份可以建卡，
 * 不然谁都能建卡就乱套了"）。2026-11-11 起权限挂在内置岗位上（roles.mjs），判据是
 * `roles.can(persona, 'card.create')` —— **不再解析 role 文本**（打四个字就拿权限的洞已堵）。
 * 没钥匙 / 钥匙过期 → E2056；权限不对 → E2057；卡体不对（状态/项目/标题/派的人）→ E2058/E2059；
 * 标题/描述里的中文在到服务端之前就被 shell 压成「?」（2026-11-12 实报）→ E2075。
 *
 * 2026-11-09 **重复建卡实报**（贺韬一轮里把 5 张卡发了两遍，看板多出 10 张）：根因是
 * 建卡接口**不幂等**、也**没有批量口** —— 5 张卡 = 5 个独立 POST，客户端一旦把"部分成功"
 * 误判成失败就整批重发（Windows PowerShell 的中文/编码坑让前几次确实吃了 400）。
 * 现在补两个机制：
 *   · **幂等键**：单卡/批量都收 `idempotencyKey`（可省略：省略时按 `runId + 项目 + 标题`
 *     派生）。同一项目下同一个键 = 同一张卡：重复请求返回已有卡（`deduped: true`），
 *     不再新建。键落在 `project_tasks.externalKey`（同一列流程卡用的是 `flow:` 前缀，
 *     这里一律 `agent:` 前缀，互不串）。
 *   · **批量口** `POST /api/agent/cards/batch`：先**全量校验**（有一张不合格就整批拒），
 *     再一次性建卡、最后才逐张派活 —— 不会留下"建了半批、另一半还在重发"的烂摊子。
 *
 * 现有两跳（单卡/批量）共用同一套校验与建卡函数；两边都别绕过它另写一份。
 */

import crypto from 'node:crypto';
import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import { createProjectTask, startProjectTask, assertTeamGroup } from '../project-tasks.mjs';
import { verifyRunCredential } from '../agent-auth.mjs';
// 权限判定（2026-11-11）：只认内置岗位的权限位，不再解析 role 文本 —— 见 roles.mjs
import { can, roleNameOf } from '../roles.mjs';
// 中文被 shell 压成问号（2026-11-12 实报）→ 400 E2075，别建出看不懂的卡
import { assertReadableText } from '../text-guard.mjs';

/** agent 建卡只许这两种状态：「待办」= 可逆的活，建完直接干；「想法」= 要雇主拍板，先挂着 */
const AGENT_STATUSES = new Set([store.TASK_STATUS.IDEA, store.TASK_STATUS.TODO]);
/*
 * **补记**（2026-11-11）：建卡通道坏过一段时间、活改成群里 @ 人干完了 —— 恢复后要把这件事
 * 补成卡。补记卡允许**一步写成最终状态**，且**不自动派活**（否则等于把干完的活重跑一遍）。
 * 只有建卡人（= 派活人 = 验收人）能写；主卡归雇主验收，见 routes/project.mjs 的闸。
 */
const BACKFILL_STATUSES = new Set([
  store.TASK_STATUS.REVIEW,
  store.TASK_STATUS.BLOCKED,
  store.TASK_STATUS.DONE,
  store.TASK_STATUS.CANCELLED,
  store.TASK_STATUS.FAILED,
]);
/** 一批最多建几张（再多说明拆活方式不对，回去重新拆，别拿批量口当搬运工） */
const BATCH_MAX = 20;
/** 幂等键最长长度（落 externalKey 用；超了直接拒，别悄悄截断成另一个键） */
const KEY_MAX = 120;
/** 单卡标题/描述长度上限（与建卡 handler 的 200/8000 同口径） */
const TITLE_MAX = 200;
const DESC_MAX = 8000;

/** 幂等键的哈希尾巴：标题一样 = 同一件事（同一次运行内重发） */
const hashOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/** 这枚运行钥匙是谁的（认不出来 → null；岗位判定在下面各自做） */
function credOf(req) {
  return verifyRunCredential(req.headers['x-bandi-run-token']);
}

/** 这次运行所在的会话（建卡票要回投到 PM 跟雇主说话的那里） */
function originConversationOf(cred) {
  try {
    return store.getRunRow(cred.runId)?.conversationId ?? null;
  } catch {
    return null;
  }
}

/** 认项目：projectId 优先，其次 projectRoot（agent 从任务里看到的是目录，不是 id） */
function resolveProject(body) {
  let project = body?.projectId ? store.getProject(String(body.projectId)) : null;
  if (!project && body?.projectRoot) {
    const root = String(body.projectRoot).replace(/[\\/]+$/, '');
    project = store.listProjects().find((p) => String(p.root).replace(/[\\/]+$/, '') === root) ?? null;
  }
  return project;
}

/**
 * 群派活**默认用群关联的项目**（2026-11-11）：群已经和项目绑定（一项目一群），
 * 建卡不必再让模型先查项目 id —— 少一个遗忘点。1:1 或群没关联项目时返回 null。
 */
function projectOfRunConversation(convId) {
  if (!convId) return null;
  try {
    const conv = store.getConversation(convId);
    const g = conv?.groupId ? store.getGroup(conv.groupId) : null;
    return g?.projectId ? store.getProject(g.projectId) : null;
  } catch {
    return null;
  }
}

/**
 * 幂等键 → `externalKey`。
 *   · 显式 `idempotencyKey`：跨运行也去重（同一件事重发不重建）；
 *   · 省略：`run:<runId>:<项目+标题>` —— 只兜"同一轮里的重发"（这次实报的形态）。
 */
function externalKeyOf(cred, project, card) {
  const explicit = String(card.idempotencyKey ?? '').trim();
  if (explicit) return `agent:k:${explicit.slice(0, KEY_MAX)}`;
  return `agent:r:${cred.runId}:${hashOf(`${project.id}\n${card.title}`)}`;
}

/** 单张卡归一/校验（单卡与批量共用；不合格抛 `{code,message}`，调用方翻成 HTTP） */
function normalizeCard(body, project, { allowBackfill = false } = {}) {
  const status = String(body?.status ?? 'todo').trim();
  const backfill = body?.backfill === true;
  /*
   * 只收**码**（2026-11-12）：中文是显示名，写到入参里一律 400 并告诉他该写哪个码。
   * 以前接口收中文，于是同一个状态在库里/接口里/前端各有一种写法 —— 一次是中文被
   * shell 打烂成 `??`（重试 9 次全废），一次是模型写成 `todo`（那会儿只认中文）。
   * 现在码是唯一真身；这里给"写错成显示名"的人一句精确的改法，不猜、不兼容。
   */
  const labelHit = Object.entries(store.TASK_LABEL).find(([, label]) => label === status);
  const codeHint = labelHit ? `（「${status}」是显示名，接口只收码 —— 请写 "${labelHit[0]}"）` : '';
  if (backfill) {
    // 补记：只允许写"这件事现在实际是什么状态"，不允许待办/想法（那两种不是补记）
    if (!BACKFILL_STATUSES.has(status)) {
      throw Object.assign(
        new Error(
          `补记只收码：${[...BACKFILL_STATUSES].join(' / ')}（依次是 待验收 / 已阻塞 / 已完成 / 已取消 / 失败），收到「${status}」${codeHint}`,
        ),
        { code: 'E2058' },
      );
    }
  } else if (!AGENT_STATUSES.has(status)) {
    throw Object.assign(
      new Error(
        `建卡状态只收码：todo（建完自动派活）或 idea（等雇主拍板），收到「${status}」${codeHint}——写最终状态要带 "backfill": true（补记，收 ${[...BACKFILL_STATUSES].join(' / ')}）`,
      ),
      { code: 'E2058' },
    );
  }
  if (backfill && !allowBackfill) {
    throw Object.assign(new Error('这个口不支持补记'), { code: 'E2058' });
  }
  const title = String(body?.title ?? '').trim().slice(0, TITLE_MAX);
  if (!title) throw Object.assign(new Error('任务得有标题（一句话说清要做什么）'), { code: 'E2059' });
  const description = String(body?.description ?? '').trim().slice(0, DESC_MAX);
  /*
   * 「??????(ui ??? temperature ??)」这类**整段中文变成问号**的请求，2026-11-12 实报过一次：
   * 调用方（PowerShell 5.1 的 Invoke-RestMethod）没带 charset，body 按 ASCII 编了出去，
   * 中文在**到达服务端之前**就没了。这种请求最坑的地方是"看起来成功"——卡建出来了、
   * 只是谁都看不懂，只能事后人工改。所以这里直接挡回去，让他当场换写法（见 text-guard.mjs）。
   */
  assertReadableText(title, '标题');
  assertReadableText(description, '描述');
  const assignee = body?.assigneePersonaId ? String(body.assigneePersonaId) : null;
  if (assignee && !store.getPersona(assignee)) throw Object.assign(new Error('这张卡要派的人已经不在了'), { code: 'E2059' });
  const explicitKey = String(body?.idempotencyKey ?? '').trim();
  if (explicitKey.length > KEY_MAX) throw Object.assign(new Error(`idempotencyKey 最多 ${KEY_MAX} 个字`), { code: 'E2059' });
  return {
    project,
    title,
    description,
    status,
    assignee,
    // 团队协作（2026-11-09）：派给群 / 协作子卡挂主卡。互斥；详细校验在下面两个函数里
    assigneeGroupId: body?.assigneeGroupId ? String(body.assigneeGroupId) : null,
    parentTaskId: body?.parentTaskId ? String(body.parentTaskId) : null,
    // 补记（2026-11-11）：建最终状态、不自动派活（见 BACKFILL_STATUSES 的注释）
    backfill: backfill && BACKFILL_STATUSES.has(status),
    idempotencyKey: explicitKey,
  };
}

/** 团队协作的**群里派卡**（2026-11-09）：群在、群助手在且是 PM 岗、群助手在群里 */
function validateGroupCard(card) {
  if (card.parentTaskId && card.assigneeGroupId) {
    throw Object.assign(new Error('子卡派给具体的人，不再派给群（二选一）'), { code: 'E2059' });
  }
  if (!card.assigneeGroupId) return null;
  if (card.assignee) throw Object.assign(new Error('派给群的卡不再指定执行人（人在群里由群助手拆）'), { code: 'E2059' });
  try {
    return assertTeamGroup(card.assigneeGroupId); // 与建卡/改派共用同一份预检（别各写一份）
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: 'E2059' });
  }
}

/**
 * **协作子卡的权限**（2026-11-09 用户规则）：拆卡人必须同时是 ——
 *   ① 项目经理岗（身份闸：自己既拆卡又干活容易"自己等自己"把任务卡死）；
 *   ② 这张主卡执行群的**当前群助手**（卡上不记协调人，现读群助手）；
 *   ③ 主卡群成员。
 * 外加结构约束：子卡同项目、只一层、执行人必须是本群成员、**不能派给自己**。
 */
function requireSubCard({ persona, card }) {
  if (!card.parentTaskId) return null;
  const parent = store.getProjectTask(card.parentTaskId);
  if (!parent) throw Object.assign(new Error('要挂的主卡不存在'), { code: 'E2059' });
  if (parent.projectId !== card.project.id) throw Object.assign(new Error('协作子卡必须和主卡在同一个项目'), { code: 'E2059' });
  if (!parent.assigneeGroupId) throw Object.assign(new Error('这张主卡不是团队协作模式（没派给群），不能拆子卡'), { code: 'E2059' });
  if (parent.parentTaskId) throw Object.assign(new Error('子卡不能再拆子卡（只允许一层）'), { code: 'E2059' });
  const group = store.getGroup(parent.assigneeGroupId);
  if (!group || group.dissolvedAt) throw Object.assign(new Error('主卡挂的群已经不在了'), { code: 'E2059' });
  if (!can(persona, 'card.split')) {
    throw Object.assign(new Error('拆子卡要「拆子卡」权限（现在只有项目经理岗位有）—— 团队协作的子卡由主卡执行群的群助手来拆'), { code: 'E2057' });
  }
  if (group.assistantPersonaId !== persona.id) {
    throw Object.assign(new Error('子卡只能由这张主卡执行群的**当前群助手**（项目经理）来拆；你可能是别的 PM，但这张卡不归你协调'), { code: 'E2057' });
  }
  if (!group.members.some((m) => m.personaId === persona.id)) {
    throw Object.assign(new Error('你不在主卡执行群里，不能拆这张卡'), { code: 'E2059' });
  }
  if (!card.assignee) throw Object.assign(new Error('协作子卡要指定执行人（派给群里的人）'), { code: 'E2059' });
  if (card.assignee === persona.id) {
    throw Object.assign(new Error('不能把子卡派给自己（自己拆的活自己干，会跟主卡互相等、把任务卡死）'), { code: 'E2059' });
  }
  if (!group.members.some((m) => m.personaId === card.assignee)) {
    throw Object.assign(new Error('子卡的执行人不在主卡那个群里'), { code: 'E2059' });
  }
  return parent;
}

/**
 * 建一张（含幂等命中）。返回 `{ task, deduped }`。
 * `startNow` 允许调用方推迟派活（批量口先建完一批、再统一开跑）。
 * **补记卡永远不派活**（`backfill`）—— 活已经干过了，建卡只是补账，重跑等于再干一遍。
 */
function createOne({ cred, persona, convId, card, startNow = !card.backfill && card.status === 'todo' && !!(card.assignee || card.assigneeGroupId) }) {
  const externalKey = externalKeyOf(cred, card.project, card);
  const existed = store.getProjectTaskByExternalKey(card.project.id, externalKey);
  if (existed) return { task: existed, deduped: true };
  const task = createProjectTask(card.project, {
    title: card.title,
    description: card.description,
    status: card.status,
    personaId: card.assignee,
    assigneeGroupId: card.assigneeGroupId,
    parentTaskId: card.parentTaskId,
    startNow: card.backfill ? false : startNow,
    // 补记卡打来源戳：看板上能一眼分清"正常卡"和"事后补的账"（SOURCE_TEXT 里有「补记」）
    source: card.backfill ? 'backfill' : null,
    // 建卡那次运行所在的会话 = PM 跟雇主说话的地方（群或 1:1）。
    // 记下来是为了卡片回执（project-tasks.mjs notifyCardCreator）：卡到「待验收」「已阻塞」
    // 「失败」时往这里投一条回执并唤醒他 —— 他答应雇主"有产出我再回你"，得给他兑现承诺的通道。
    createdBy: persona.id,
    creatorConvId: convId,
    externalKey,
  });
  return { task, deduped: false };
}

/**
 * 卡票消息（2026-10-24）：建卡那一刻往 PM 说话的那场会话里落一张**票**。
 *
 * 为什么服务端发、而不是指望 PM 自己说：PM 的回话是他组织的散文（说没说卡号、
 * 说的 id 对不对都不可控）；票是结构化的（meta 带 cardId），界面上画成一张可点的卡 →
 * 直达任务卡详情页。text 写一句人话兜底 —— 纯文本视图（喂给 agent 的历史、老客户端）
 * 不认 meta 也不丢信息。以 PM 的名义（role: assistant + personaId）落，像 IM 里机器人的
 * 卡片消息；**不派活、不叫醒任何人** —— 只是登记"这张卡在这场对话里立的"。
 * 幂等命中（重发）的卡不再补票，不然群里全是重复的【任务卡】消息。
 */
function announceCard(convId, persona, task) {
  if (!convId) return;
  const assigneeName = task.assigneePersonaId ? (store.getPersona(task.assigneePersonaId)?.name ?? null) : null;
  const backfill = task.source === 'backfill';
  store.addMessage({
    conversationId: convId,
    role: 'assistant',
    personaId: persona.id,
    text: `【${backfill ? '补记' : '任务卡'}】${task.title} —— 已建立（${store.taskLabel(task.status)}${assigneeName ? `，交给了 ${assigneeName}` : ''}）`,
    meta: {
      type: 'card',
      cardId: task.id,
      title: task.title,
      status: task.status,
      assignee: assigneeName,
      ...(backfill ? { backfill: true } : {}),
    },
  });
}

/** 一组卡里有没有"还没跑、但有执行方式"的卡 —— 批量口用它决定建完要不要开跑 */
const needsStart = (task) => task.status === 'todo' && !!(task.assigneePersonaId || task.assigneeGroupId);

/**
 * 建卡失败写「信箱」（2026-11-11 用户拍板：左栏一级「信箱」）。
 * 机器侧事实原样落库：错误码 / runId / 员工 / 会话都在，人点开知道"哪一轮、什么错、重试几次"。
 * 同轮同码去重、次数累加（3 次重试不会 3 条红点）。写信箱失败绝不影响建卡响应。
 */
function noticeCardFailure({ cred, persona, convId, code, message }) {
  try {
    store.addNotice({
      kind: 'card.create.failed',
      severity: 'warn',
      code: code ?? 'E2059',
      title: `建卡失败：${code ?? 'E2059'}`,
      detail: String(message ?? ''),
      personaId: persona?.id ?? null,
      conversationId: convId ?? null,
      runId: cred?.runId ?? null,
      dedupeKey: `card:${cred?.runId ?? 'no-run'}:${code ?? 'E2059'}`,
    });
  } catch { /* 信箱写失败不影响建卡响应 */ }
}

export async function handleAgentCards(req, res, url) {
  const one = /^\/api\/agent\/cards$/.exec(url.pathname);
  const batch = /^\/api\/agent\/cards\/batch$/.exec(url.pathname);
  if (!one && !batch) return false;

  if (req.method !== 'POST') return fail(res, 405, 'E2057', '建卡通道只收 POST'), true;

  // 钥匙不对 → 401（身份没认下来，不是请求格式错）
  const cred = credOf(req);
  if (!cred) {
    return fail(res, 401, 'E2056',
      '建卡要带有效的运行钥匙（X-Bandi-Run-Token）—— 钥匙每轮现发、收尾作废，值取自本进程环境变量 BANDI_RUN_TOKEN；别用历史命令里记得的旧值'), true;
  }
  const persona = store.getPersona(cred.personaId);
  if (!persona) {
    noticeCardFailure({ cred, code: 'E2056', message: '这把钥匙对应的员工已经不在了' });
    return fail(res, 401, 'E2056', '这把钥匙对应的员工已经不在了'), true;
  }

  // 权限不对 → 403（认出来了，但没这个权）
  if (!can(persona, 'card.create')) {
    noticeCardFailure({ cred, persona, code: 'E2057', message: '岗位没有建卡权限' });
    return fail(res, 403, 'E2057',
      '只有带「建卡」权限的岗位能建任务卡（现在只有项目经理）—— 你的岗位是「' + (roleNameOf(persona.roleKey) ?? '未设岗位') + '」。要立项的活，把需求和理由说给项目经理或雇主。'), true;
  }

  const convId = originConversationOf(cred);
  const body = await readBody(req);
  // 群派活默认项目 = 这个群关联的项目（省掉"先查项目 id"这一步；1:1 仍是 null）
  const defaultProject = resolveProject(Array.isArray(body) ? {} : body) ?? projectOfRunConversation(convId);

  /* ---------------------------------------------------------------- 单卡 */
  if (one) {
    const cardProject = resolveProject(Array.isArray(body) ? {} : body) ?? defaultProject;
    let card;
    try {
      if (!cardProject) throw Object.assign(new Error('建卡得指明挂哪个项目 —— 传 projectId 或 projectRoot（群派活会自动用群关联的项目；项目清单：GET /api/projects）'), { code: 'E2059' });
      card = normalizeCard(body, cardProject, { allowBackfill: true });
      validateGroupCard(card);
      requireSubCard({ persona, card });
    } catch (e) {
      noticeCardFailure({ cred, persona, convId, code: e.code ?? 'E2059', message: e.message });
      return fail(res, e.code === 'E2057' ? 403 : 400, e.code ?? 'E2059', e.message), true;
    }
    try {
      const out = createOne({ cred, persona, convId, card });
      if (!out.deduped) announceCard(convId, persona, out.task);
      return sendJson(res, out.deduped ? 200 : 201, { task: out.task, deduped: out.deduped }), true;
    } catch (e) {
      // 派活失败时卡已经建好了 —— 把 id 带回去，界面才能说清"卡在、但没跑起来"
      noticeCardFailure({ cred, persona, convId, code: 'E2059', message: `建了卡但没派出去：${String(e.message ?? e)}` });
      return fail(res, 400, 'E2059', String(e.message ?? e), { taskId: e.taskId ?? null }), true;
    }
  }

  /* ---------------------------------------------------------------- 批量 */
  /*
   * 认三种写法（2026-11-11 实报：模型第二次尝试发了裸数组，被 400 挡回）：
   *   { cards: [...] }（标准）/ 裸数组 [...] / 单张卡对象（等价于一次建一张）。
   * 写法不该决定成败 —— 校验仍然照做，只是不再因为"外壳不对"拒掉整批。
   */
  const cards = Array.isArray(body) ? body : Array.isArray(body?.cards) ? body.cards : body?.title ? [body] : null;
  if (!cards || !cards.length) {
    noticeCardFailure({ cred, persona, convId, code: 'E2059', message: '批量建卡没带 cards 数组' });
    return fail(res, 400, 'E2059', '批量建卡要带 cards 数组（1~20 张）；也接受裸数组或单张卡对象'), true;
  }
  if (cards.length > BATCH_MAX) {
    noticeCardFailure({ cred, persona, convId, code: 'E2059', message: `一次建了 ${cards.length} 张，超过上限 ${BATCH_MAX}` });
    return fail(res, 400, 'E2059', `一次最多建 ${BATCH_MAX} 张卡 —— 再多说明活还没拆明白`), true;
  }

  // 先全量校验：有一张不合格就整批拒（不留"建了半批"的烂摊子）
  const plan = [];
  for (let i = 0; i < cards.length; i += 1) {
    const raw = cards[i] ?? {};
    const project = resolveProject(raw) ?? defaultProject;
    try {
      if (!project) throw Object.assign(new Error('没指明挂哪个项目（projectId 或 projectRoot；群派活默认用群关联的项目）'), { code: 'E2059' });
      const card = normalizeCard(raw, project, { allowBackfill: true });
      validateGroupCard(card);
      requireSubCard({ persona, card });
      plan.push(card);
    } catch (e) {
      noticeCardFailure({ cred, persona, convId, code: e.code ?? 'E2059', message: `第 ${i + 1} 张卡不合格：${e.message}` });
      return fail(res, e.code === 'E2057' ? 403 : 400, e.code ?? 'E2059', `第 ${i + 1} 张卡不合格：${e.message}`), true;
    }
  }

  // 一次性建卡（先不派活）—— 建卡阶段的失败不会留下"半批 + 已派出去"的状态
  const out = [];
  try {
    for (const card of plan) out.push(createOne({ cred, persona, convId, card, startNow: false }));
  } catch (e) {
    const created = out.filter((x) => !x.deduped).map((x) => x.task.id);
    noticeCardFailure({ cred, persona, convId, code: 'E2059', message: `建卡中断：${String(e.message ?? e)}` });
    return fail(res, 400, 'E2059', `建卡中断：${String(e.message ?? e)}${created.length ? `（已建好 ${created.length} 张：${created.join('、')}）` : ''}`), true;
  }

  // 全部建完再逐张开跑：某一张派活失败只记在 errors 里，不影响其它卡
  const errors = [];
  for (const item of out) {
    if (item.deduped || !needsStart(item.task)) continue;
    try {
      item.task = startProjectTask(item.task.id);
    } catch (e) {
      errors.push({ id: item.task.id, message: String(e.message ?? e) });
    }
  }
  // 卡票：只给真新建的（幂等命中不重复发）
  for (const item of out) if (!item.deduped) announceCard(convId, persona, item.task);

  const deduped = out.filter((x) => x.deduped).length;
  return sendJson(res, out.length === deduped ? 200 : 201, {
    tasks: out.map((x) => ({ ...x.task, deduped: x.deduped })),
    deduped,
    errors,
  }), true;
}
