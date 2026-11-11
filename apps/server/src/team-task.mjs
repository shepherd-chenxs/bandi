/*
 * 「到点把活派给一个团队」—— 定时任务的第三个通用动作（2026-11-11，执行方式三选一的中间那个）。
 *
 * 跟「指派人」（persona-task）、「流程任务」（run-workflow）是**同一件事的三种执行者**：
 * 一个是被点名的人，一条是按节点点名的流水线，这个是把活派进**一个群**、由群助手（项目经理）
 * 承接 —— 拆子卡、盯回执。用户口径："改成执行方式、执行对象，支持指派人、团队协作、流程任务，
 * 参考任务面板" —— 所以这里**不复制任何派群逻辑**，就是任务面板团队协作的定时版：
 *   · 到点在看板上**建一张卡**（挂到所选项目），随即走 `createProjectTask(startNow)` 的
 *     团队协作分支派进群 —— 可见派活票、群助手唤醒、子卡授权、回执全是现成的；
 *   · 每次触发 = 一张新卡（团队协作的拆卡机制长在"父卡"上，没有卡就拆不了）；
 *   · 撞忙（群助手在跑别的）由 30 秒节拍重试 —— 卡上留着 queuedAt，`retryQueuedTasks` 管。
 *
 * 为什么「关联项目」在这里是**必填**（指派人那边选填）：手工卡必须挂在某个项目下
 * （`project-tasks.mjs` 的硬规矩），团队协作的每次触发都要落一张卡，就得有地方落。
 */
import * as store from './store.mjs';
import { assertTeamGroup, createProjectTask } from './project-tasks.mjs';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** 建任务/改任务时能提前拦下的错，就不该等到半夜跑的时候才写进 lastError */
export function validateTeamTask(config = {}) {
  const instruction = String(config.instruction ?? '').trim();
  if (!instruction) return '「做什么」还没写 —— 到点了得知道给团队派什么活';
  // 先把"没填"的全拦完（一次说清一件事），再看"填了的对不对"
  const groupId = String(config.groupId ?? '').trim();
  if (!groupId) return '还没选「执行对象」（选一个群）';
  const projectId = String(config.projectId ?? '').trim();
  if (!projectId) return '团队协作的每次触发都要在看板落一张卡 —— 先选「关联项目」';
  // 群在、群助手在、群助手是项目经理、群助手在群里 —— 与任务面板建卡同一份判据
  try {
    assertTeamGroup(groupId);
  } catch (e) {
    return String(e?.message ?? e);
  }
  if (!store.getProject(projectId)) return '选的那个项目已经不在了，换一个';
  return null;
}

/** 卡片上那一行说明（服务端拼好，前端照抄 —— 卡片本身不该认识每个动作的字段名） */
export function describeTeamTask(config = {}) {
  const group = config.groupId ? store.getGroup(String(config.groupId)) : null;
  const proj = config.projectId ? store.getProject(String(config.projectId)) : null;
  const instr = clip(config.instruction, 44);
  const head = `团队协作 · 群「${group ? group.title : '?'}」${proj ? `（在「${proj.name}」）` : ''}`;
  return instr ? `${head}：${instr}` : head;
}

export function runTeamTask({ job, config }) {
  const bad = validateTeamTask(config);
  if (bad) throw new Error(bad);
  const project = store.getProject(String(config.projectId));
  const group = store.getGroup(String(config.groupId));
  const instruction = String(config.instruction).trim();

  /*
   * 建卡即派（`startNow`）：能走到这里返回的卡一定已经「进行中」—— 派不出去
   * （群助手正忙…）`createProjectTask` 会把错带 `taskId` 重抛，落到下面的 catch：
   * 按失败记账 —— 真话说在 lastError 里，卡本身还在看板上等着节拍重试，
   * 人不会以为"跑了但什么都没发生"。
   */
  const card = createProjectTask(project, {
    title: job.name,
    description: instruction,
    // 团队协作：派给群（群助手现读），建好立即派 —— 忙了退待办排队，节拍自己会再试
    assigneeGroupId: group.id,
    startNow: true,
  });

  const assistant = group.assistantPersonaId ? store.getPersona(group.assistantPersonaId) : null;
  return {
    summary: `已在「${project.name || project.id}」建卡并派进群「${group.title}」，${assistant ? `群助手 ${assistant.name} ` : ''}承接（看板 / 群里看进度）`,
    // 给界面/日志留个把手：这一轮落在了哪张卡、哪条会话
    taskId: card.id,
    conversationId: card.conversationId ?? null,
  };
}
