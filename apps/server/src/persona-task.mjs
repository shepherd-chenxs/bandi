/*
 * 「让某个数字员工干一件事」—— 定时任务里最通用的那一条动作（2026-10-17）。
 *
 * 用户的原话是「把做什么做成输入区」：定时任务不该只认 PR 巡检、备份那几条写死的动作，
 * 而应该是「到点把一句话交给某个人」。所以这里只做三件事：
 *   · 拿到那句话（`config.instruction`）和干活的人（`config.personaId`）；
 *   · 把人话发进**这个任务自己的会话**（复用 `dispatchToThread`，跟聊天、看板派活同一条链路）；
 *   · 把会话 id 记回 config —— 下次还落同一条，历史能在消息页里翻。
 *
 * 为什么单独开一条会话，而不是直接丢进这个人的 1:1：
 *   ① 人的 1:1 是人和他说话的地方，半夜的定时消息混进去，第二天要往上翻很久才找得到人话；
 *   ② 也不能每次新建 —— 每天一条跑一个月就是三十条会话，列表直接废掉。
 *   一条任务 = 一条会话，标题写任务名，正好。
 *
 * 只读边界：这个动作**不碰代码、不改配置**，它只是替人说一句话；真干什么由那个人自己的权限决定。
 */
import * as store from './store.mjs';
import { dispatchToThread } from './dispatch.mjs';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** 建任务/改任务时能提前拦下的错，就不该等到半夜跑的时候才写进 lastError */
export function validatePersonaTask(config = {}) {
  const instruction = String(config.instruction ?? '').trim();
  if (!instruction) return '「做什么」还没写 —— 到点了得知道让它干什么';
  const personaId = String(config.personaId ?? '').trim();
  if (!personaId) return '还没选「交给谁」';
  if (!store.getPersona(personaId)) return '选的那个人已经不在了，换一个';
  // 工作空间是选填的；填了就得是真项目，别等半夜跑的时候才发现"项目没了"
  const projectId = String(config.projectId ?? '').trim();
  if (projectId && !store.getProject(projectId)) return '选的那个项目已经不在了，换一个（或者留空）';
  return null;
}

/** 卡片上那一行说明（服务端拼好，前端照抄 —— 卡片本身不该认识每个动作的字段名） */
export function describePersonaTask(config = {}) {
  const instr = clip(config.instruction, 44);
  const who = config.personaId ? store.getPersona(String(config.personaId))?.name : null;
  const proj = config.projectId ? store.getProject(String(config.projectId))?.name : null;
  const head = `交给${who ? `「${who}」` : '员工'}${proj ? `（在「${proj}」）` : ''}`;
  return instr ? `${head}：${instr}` : head;
}

export function runPersonaTask({ job, config }) {
  const bad = validatePersonaTask(config);
  if (bad) throw new Error(bad);
  const instruction = String(config.instruction).trim();
  const persona = store.getPersona(String(config.personaId));
  const projectId = String(config.projectId ?? '').trim() || null;
  const project = projectId ? store.getProject(projectId) : null;

  // 会话还在就接着用；被删了就重开一条（并把 id 换掉），而不是从此每次都失败
  let conv = config.conversationId ? store.getConversation(String(config.conversationId)) : null;
  if (!conv) {
    conv = store.createConversation({ title: `定时 · ${job.name}`, personaId: persona.id });
    // 记回去：下次落到同一条会话里。config 是这张表里唯一"动作自己解释"的字段，调度核心不看它。
    store.updateSchedule(job.id, { config: { ...config, conversationId: conv.id } });
  }

  let run;
  try {
    /*
     * 工作空间：选了项目就在**那个项目的目录**里干（`dispatchToThread` 会用它覆盖 cwd 与可读写根），
     * 跟流程节点、看板派活是同一个开关。没选就照旧用这个人自己的默认目录。
     * 每跑一次都按**当前**配置传 —— 后来改了项目，下一次就换到新目录，不用重建会话。
     */
    ({ run } = dispatchToThread(conv.id, instruction, { projectId }));
  } catch (e) {
    // 「他正在忙」是最常见的一种，原话太技术（busy），换成能照做的说法
    if (e?.code === 'busy') throw new Error(`「${persona.name}」手上有活在跑，这次没派出去`);
    throw e;
  }

  return {
    summary: `已交给「${persona.name}」${project ? `（在「${project.name || project.id}」）` : ''}：${clip(instruction, 36)}（会话里看结果）`,
    // 给界面/日志留个把手：这次派活落在哪条会话、哪次运行
    conversationId: conv.id,
    runId: run.id,
  };
}
