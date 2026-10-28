/*
 * store.mjs —— 门面（2026-10-22 拆分）。
 *
 * 对外 API：原有 178 个导出**逐一比对过、一个不少**；另多 3 个跨域私有助手
 * （purgeConversation / purgeDissolvedGroup / purgePersonaHistory —— 删除链路要跨
 * 会话/群/员工三域复用，收不回来）。实现按域拆进 ./store/*.mjs，这里只负责 re-export。
 * 调用方一律 `import * as store from './store.mjs'`，不受拆分影响。
 * 规矩不变：**SQL 只出现在 store/ 目录里**（docs/形态决策.md §十二）；
 * `db` 本体从这里开始不再外泄 —— 只有 store/ 内的模块拿得到。
 *
 * 域地图：db=连接/建表/迁移 · personas=数字员工 · personaSkills=技能挂载 ·
 * conversations/messages/groups=会话与消息 · runs=一次执行及事件流 ·
 * projects/projectTasks=项目与看板卡 · nodes=节点/任务/作业/令牌 · workflows=流程引擎 ·
 * quota=额度 · gitRepos=仓库 · schedules=定时任务。
 */

export { newId, nowIso, getMetaValue, setMetaValue, backupTo } from './store/db.mjs';
export * from './store/personas.mjs';
export * from './store/personaSkills.mjs';
export * from './store/conversations.mjs';
export * from './store/messages.mjs';
export * from './store/groups.mjs';
export * from './store/runs.mjs';
export * from './store/projects.mjs';
export * from './store/projectTasks.mjs';
export * from './store/nodes.mjs';
// 手机配对与设备域（2026-11 手机端增量）：mobile_devices / mobile_device_tokens / mobile_pair_tokens
export * from './store/devices.mjs';
export * from './store/workflows.mjs';
export * from './store/quota.mjs';
export * from './store/gitRepos.mjs';
export * from './store/schedules.mjs';
