/*
 * routes/chain.mjs —— **分发顺序表**（2026-11-08）。
 *
 * 这个文件只做一件事：把「请求按什么顺序问各个域模块」从 `server.mjs` 里的一段
 * if 链，变成**一张可读、可审、可检查的数组**。
 *
 * **为什么必须集中**：每个 `handleX` 自己判自己那段路径，判不到就 `return false`，
 * 于是「谁先谁后」只存在于 server.mjs 的**书写顺序**里 —— 那是最难 review 的一种契约：
 *   · 顺序错了不报错，只是某条路由被更早的通配条目抢走（`/api/nodes/register` 被
 *     `/api/nodes/:id` 抢走就是真踩过的，见 route-policy 里那条注释）；
 *   · 加一个模块要"插在对的位置"，而"对的位置"没有任何文字说明；
 *   · 十几个路由文件的文件头都写着「主分发顺序见 ../server.mjs 的 CHAIN」——
 *     而那个 `CHAIN` 从来不存在（2026-11-08 之前的漂移：注释指着一个没有的符号）。
 *
 * 现在 `CHAIN` 就是它。规矩：
 *   ① **顺序 = 数组下标**，先匹配先赢；
 *   ② 每个 `routes/*.mjs` 导出的 handler 必须在这张表里出现**恰好一次**
 *      （`tools/check-dispatch-chain.mjs` 在 PR 门禁里扫，漏挂会红）；
 *   ③ 加模块 = 在表里插一行 + 写清"为什么在这个位置"，别只写"新模块"。
 *
 * 与 `server.mjs` 里那张**精确 key 表**（`GET /api/hello` 这类字面量）的关系：
 * 那张表查一次哈希就够了，排在链**之前**（热路径）；这里这条链负责所有带动态段的路径。
 * 两层，不是一个机制写两遍 —— 精确匹配的条目在链里只会变成更慢的一堆正则。
 */

import { handleEvents } from './events.mjs';
import { handleConversation } from './conversation.mjs';
import { handlePersona } from './persona.mjs';
import { handleAgentCards } from './agent-cards.mjs';
import { handleExpert } from './expert.mjs';
import { handleUsers } from './users.mjs';
import { handleProject } from './project.mjs';
import { handleWorkspace } from './workspace.mjs';
import { handleStatus } from './status.mjs';
import { handleFs } from './fs.mjs';
import { handleGroup } from './group.mjs';
import { handleSkill } from './skill.mjs';
import { handleConnector } from './connector.mjs';
import { handleRuntime } from './runtime.mjs';
import { handleNode } from './node.mjs';
import { handleNodeWork } from './nodeWork.mjs';
import { handlePluginAction } from './plugin.mjs';
import { handleSsh } from './ssh.mjs';
import { handleWorkflow } from './workflow.mjs';
import { handleRun } from './run.mjs';
import { handleGit } from './git.mjs';
import { handleSchedules } from './schedules.mjs';
import { handleImageAi } from './imageai.mjs';
import { handlePrefs } from './prefs.mjs';
import { handleFeishu } from './feishu.mjs';

/**
 * 顺序表。**改顺序前先想清楚谁会抢谁的路径** —— 越宽的通配越要往后放。
 */
export const CHAIN = [
  // ── 长连接与"页面一开就要"的：排最前，别让它们在别的 handler 里排队
  { id: 'events', handle: handleEvents, note: '全局 SSE（/api/events）—— 长命连接，链头' },
  { id: 'conversation', handle: handleConversation, note: '会话详情与发消息' },
  { id: 'persona', handle: handlePersona, note: '数字员工' },

  // ── 员工"工作证"通道：自成一套身份（run token），不能跟在别的鉴权后面
  { id: 'agent-cards', handle: handleAgentCards, note: '建卡通道（X-Bandi-Run-Token）' },

  { id: 'expert', handle: handleExpert, note: '专家库' },
  // /api/me 是"每个页面启动都会问一次"的接口，能早一步就早一步
  { id: 'users', handle: handleUsers, note: '账号 / 登录 / 安全（含 /api/me）' },
  { id: 'project', handle: handleProject, note: '项目、看板卡、评论、附件' },
  { id: 'workspace', handle: handleWorkspace, note: '工作区文件读取 + 系统打开' },
  { id: 'status', handle: handleStatus, note: '状态账本 / 托管 / 项目状态' },
  { id: 'fs', handle: handleFs, note: '目录列举（选工作目录用）' },
  { id: 'group', handle: handleGroup, note: '群聊' },
  { id: 'skill', handle: handleSkill, note: '技能包' },
  { id: 'connector', handle: handleConnector, note: '连接器（MCP 之类）' },
  { id: 'runtime', handle: handleRuntime, note: '运行时 / 模型清单' },

  // ── 节点两半：node = 总机侧的节点管理，nodeWork = 节点自己干活的那半边。
  //    两者路径前缀不同（/api/nodes 与 /api/node/...），但都窄，靠前靠后都不抢别人
  { id: 'node', handle: handleNode, note: '总机侧：节点、任务下发、邀请码' },
  { id: 'nodeWork', handle: handleNodeWork, note: '节点侧：领活、回执' },

  { id: 'plugin', handle: handlePluginAction, note: '插件装卸' },
  { id: 'ssh', handle: handleSsh, note: '远程机器（SSH）' },
  { id: 'workflow', handle: handleWorkflow, note: '流程模板与实例' },
  { id: 'run', handle: handleRun, note: '单次运行：事件流（SSE）与停止' },
  { id: 'git', handle: handleGit, note: '代码托管 / PR（路径最宽，排后面）' },
  { id: 'schedules', handle: handleSchedules, note: '定时任务' },
  { id: 'imageai', handle: handleImageAi, note: '生图（回环免令牌，自己判来源）' },
  { id: 'prefs', handle: handlePrefs, note: '回复风格偏好' },
  { id: 'feishu', handle: handleFeishu, note: '飞书通道（挂在 /api/personas/:id/feishu）' },
];

/*
 * 加载期自检：粘错一行（写成 undefined、或者 id 撞名）在启动时就炸，
 * 而不是等到某条路由 404 才回头找。这两样都是"改表时手滑"的典型形态。
 */
{
  const ids = new Set();
  for (const e of CHAIN) {
    if (!e || typeof e.handle !== 'function') throw new Error(`routes/chain.mjs：${e?.id ?? '?'} 没有 handle 函数`);
    if (ids.has(e.id)) throw new Error(`routes/chain.mjs：id 重复 —— ${e.id}`);
    ids.add(e.id);
  }
}

/**
 * 按顺序问一遍。返回 true = 这条请求已经被某个域模块接走。
 *
 * 返回值的口径要跟改造前的 if 链**一模一样**：只有严格 `false` 才算"不是我"，
 * 其余（含 `undefined`，比如 handler 里 `return sendJson(...)`）都算已处理 ——
 * 这条口径写歪了，表现为"某个接口回完还继续往下走"，最后一个 404 把响应盖掉。
 */
export async function runChain(req, res, url) {
  for (const entry of CHAIN) {
    const out = await entry.handle(req, res, url);
    if (out !== false) return true;
  }
  return false;
}
