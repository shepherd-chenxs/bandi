/*
 * 「到点起一条流程」—— 定时任务的第二个通用动作（2026-10-29，用户："定时任务也可以交给流程来执行"）。
 *
 * 跟「交给数字员工」是**同一件事的两种执行者**：一个是被点名的人，一条是按节点点名的流水线。
 * 所以这里不复制派活逻辑，只做三件事：
 *   · 校验（流程在不在、发没发布、有没有节点、有没有写「做什么」）；
 *   · 调引擎的 `startWorkflow` —— 起实例、起第一步、撞忙由 30 秒节拍补派，都是引擎自己的事；
 *   · 把结果说成一句人话（第一步是已经在跑、还是卡住了等人），存进 `lastSummary`。
 *
 * 为什么**只认已发布**的模板：发布就是"这条流程可以真跑"的确认。
 * 看板建卡（`project-tasks.mjs` 的 assertRunnableFlow）也是这条口径 ——
 * 定时任务是三个入口里最"没人看着"的那个，不能比人手点还宽松。
 *
 * 为什么不建卡：流程自己会在自己的会话里派活、写步骤记录；
 * 定时起一条就只是"又起了一条实例"，卡是看板的事，硬塞一张反而要人去收拾。
 */
import * as store from './store.mjs';
import { startWorkflow, nodesOf } from './workflows.mjs';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** 建任务/改任务时能提前拦下的错，就不该等到半夜跑的时候才写进 lastError */
export function validateWorkflowTask(config = {}) {
  const templateId = String(config.templateId ?? '').trim();
  if (!templateId) return '还没选「哪条流程」';
  const tpl = store.getWorkflowTemplate(templateId);
  if (!tpl) return '选的那条流程已经不在了，换一条';
  if (!tpl.publishedAt) return `流程「${tpl.name}」还没发布 —— 去工作台 › 工作流里发布一下，定时任务只跑已发布的`;
  if (!nodesOf(tpl).length) return `流程「${tpl.name}」还没有节点，起不了`;
  // 想法 = 这一次发起要办的那件事。它会被发给第一个节点的人，空了就等于没起因
  if (!String(config.intent ?? '').trim()) return '「做什么」还没写 —— 到点了得知道拿什么事去起这条流程';
  const projectId = String(config.projectId ?? '').trim();
  if (projectId && !store.getProject(projectId)) return '选的那个项目已经不在了，换一个（或者留空）';
  return null;
}

/** 卡片上那一行说明（服务端拼好，前端照抄 —— 卡片本身不该认识每个动作的字段名） */
export function describeWorkflowTask(config = {}) {
  const tpl = config.templateId ? store.getWorkflowTemplate(String(config.templateId)) : null;
  const proj = config.projectId ? store.getProject(String(config.projectId)) : null;
  const intent = clip(config.intent, 44);
  const head = `交给流程${tpl ? `「${tpl.name}」` : ''}${proj ? `（在「${proj.name}」）` : ''}`;
  return intent ? `${head}：${intent}` : head;
}

export function runWorkflowTask({ job, config }) {
  const bad = validateWorkflowTask(config);
  if (bad) throw new Error(bad);
  const tpl = store.getWorkflowTemplate(String(config.templateId));
  const intent = String(config.intent).trim();
  const projectId = String(config.projectId ?? '').trim() || null;
  const project = projectId ? store.getProject(projectId) : null;

  // 标题用任务名：流程列表里一眼能认出"这是某某定时任务起的"，而不是千篇一律的第一行想法
  const started = startWorkflow({ templateId: tpl.id, title: job.name, intent, projectId });

  /*
   * 第一步**可能一发起就卡住**（模板那个节点没点名 / 额度拦了）——
   * 那不是"发起失败"（实例确实建出来了），但也不能只说"已发起"让人以为在跑。
   * 所以照实例自己算出来的状态说：在跑 / 等你指派 / 卡住了。
   */
  const step = started?.nodeName ? `第 ${started.visit ?? 1} 步「${started.nodeName}」` : '第一步';
  const how =
    started?.taskStatus === '已阻塞' || started?.taskStatus === '失败'
      ? `${step}卡住了：${clip(started.lastNote ?? '等人处理', 60)}`
      : started?.waiting && started.waiting !== '正在跑'
        ? `${step}${started.waiting}`
        : `${step}已经开始`;

  return {
    summary: `已发起「${tpl.name}」${project ? `（在「${project.name || project.id}」）` : ''}，${how}（去工作台 › 工作流看进度）`,
    // 给界面/日志留个把手：这一条实例是哪个
    runId: started?.id ?? null,
  };
}
