/*
 * security/route-policy.mjs —— **全站路由登记清单（默认拒绝）**。
 *
 * 一条铁律：**没登记的 `/api/*` 路径一律 404 `E4090`** —— guard 在认证之前先查这张表，
 * "服务里有但清单上没有"的接口从根上不存在。新加路由必须先来这里登记，smoke 的
 * 覆盖率扫描（扫 routes/*.mjs 的 `/api/` 字面量）会逼着两端同步。
 *
 * 字段口径：
 *   · `m`      —— 方法（文档用途 + 将来收紧；运行时登记检查只看路径，方法级
 *                 拒绝仍由 decide()/handler 负责 —— 分两步收，一次全收必翻车）；
 *   · `auth`   —— `public`（guard 在认证前放行）/ `session`（要身份，按 kind 判）/
 *                 `local`（本机接口，handler 里走 authorizeLocal）；
 *   · `noPanel`—— 原为节点 panel 令牌的禁止标记（原 PANEL_FORBIDDEN 逐条迁进来）；
 *                 节点令牌 2026-11-09 随多机子系统整体删除后，该标记仅作管理动作的
 *                 存档语义保留（运行时已无 panel 身份会来查它）；
 *   · `run`    —— **运行钥匙**（数字员工进程，`X-Bandi-Run-Token`）可达：建卡通道 +
 *                 只读台账。没标的一律 403 `E4034`。2026-11-08 全员群实报 401 后补：
 *                 真机监听 0.0.0.0 时认证层不认这把钥匙，建卡与台账整条断掉；
 *                 现在开哪几扇门全凭这个标记（见 policy.mjs 的 run 分支）。
 *
 * 2026-11-07：`perm` / `member` 字段与角色体系一起退场 —— 登录用户全权，
 * 分级只剩机器身份（operator / run）自己的边界。手机设备那条（`device` 标）随配对
 * 体系同日退场：手机现在也是登录进来的 user。多机节点的全部条目
 * （nodes.* / run.events / run.finish）2026-11-09 随子系统整体删除；
 * 本机软件商店安装任务通道改挂 `/api/install/tasks`（原 /api/nodes/local/tasks）。
 */

/* ------------------------------------------------------------------ 助记 */

const seg = (s) => s.replace(/\//g, '\\/'); // 写正则时少打反斜杠
const id1 = '([^/]+)'; // 一段动态 id

/** 动态段模式速写：p('/api/conversations', id1) → /^\/api\/conversations\/([^/]+)$/ */
const p = (...parts) => new RegExp(`^${parts.map(seg).join('\\/')}$`);

/* ------------------------------------------------------------------ 清单 */

export const ROUTES = [
  /* ---------------------------------------------------- public（认证前放行） */
  { id: 'hello', m: ['GET'], path: p('/api/hello'), auth: 'public', note: '加入向导探测；披露字段与 UDP 应答同源，故意无秘密（§5.4）' },
  /*
   * **健康探测口**（2026-11-08）：桌面壳的 watch_service 每 1~2 秒探一次
   * 「端口上有个班底在回话」。它在 server.mjs 里**排在认证之前**返回，所以这条登记
   * 不改变任何行为 —— 登记的意义是把"故意免鉴权"写在清单上，而不是靠"它跑得早、
   * 没人查得到"（覆盖率扫描 B 段正是拿这张表判每个 /api 字面量）。
   * 响应只有 `{ ok, platform, authRequired }`：platform 这个字段 401 响应体里本来就带，
   * authRequired 与"任何 /api 有没有凭据都试得出来"同信息量 —— 零新增暴露
   * （2026-11-10 晚加，给桌面壳决定要不要走 /shell/enter，免得每次开壳都裸打 /api/state 吃 401）。
   */
  { id: 'ping', m: ['GET', 'HEAD'], path: p('/api/ping'), auth: 'public', note: '健康探测；认证之前返回，只回 {ok, platform, authRequired}' },
  /*
   * 版本指纹（2026-11-09 从 session 改 public）：只回前端文件指纹，零敏感 ——
   * 旧页面（会话失效后）每 60 秒轮询一次，原先每次 401 都进审计，刷成噪音；
   * 改成跟 /api/ping / /api/hello 一样的免鉴权探活口径（guard 里放行）。
   */
  { id: 'web.version', m: ['GET'], path: p('/api/web-version'), auth: 'public', note: '60 秒版本指纹轮询，零敏感；免鉴权（避免旧页面轮询刷 401 审计）' },
  { id: 'logout', m: ['POST'], path: p('/api/logout'), auth: 'public', note: '登出自检（有票才有的撤）' },
  { id: 'ai.image-config', m: ['GET', 'PUT'], path: p('/api/ai/image-config'), auth: 'public', note: 'guard 只对 source=loopback 豁免 GET；PUT 永远要身份' },
  { id: 'ai.image', m: ['POST'], path: p('/api/ai/image'), auth: 'public', note: '回环免令牌（本地模型探测）；network 不豁免' },
  { id: 'ai.image-test', m: ['POST'], path: p('/api/ai/image-test'), auth: 'public', note: '同上' },

  /* ------------------------------------------------------------ 本机接口 */
  // auth:'local' = handler 里 authorizeLocal() 说了算（§8.5 矩阵 / 姊妹文档）；
  // 这里登记只为「存在性」—— 漏登记会被默认拒绝 404。
  { id: 'local.status', m: ['GET'], path: p('/api/local/status'), auth: 'local' },
  // 外部件现状（2026-11-04）：插件页「软件」商店条目 —— 只读
  { id: 'local.externals', m: ['GET'], path: p('/api/local/externals'), auth: 'local' },
  { id: 'local.backups', m: ['GET'], path: p('/api/local/backups'), auth: 'local' },
  { id: 'local.export', m: ['POST'], path: p('/api/local/export'), auth: 'local' },
  { id: 'local.import', m: ['POST'], path: p('/api/local/import'), auth: 'local' },
  { id: 'local.probe', m: ['POST'], path: p('/api/local/probe'), auth: 'local' },
  { id: 'local.hosts.add', m: ['POST'], path: p('/api/local/hosts/add'), auth: 'local' },
  { id: 'local.hosts.remove', m: ['POST'], path: p('/api/local/hosts/remove'), auth: 'local' },
  { id: 'local.hosts.test', m: ['POST'], path: p('/api/local/hosts/test'), auth: 'local' },

  /* ------------------------------------------------- 登录用户与手机设备共用 */
  { id: 'state.read', m: ['GET'], path: p('/api/state'), auth: 'session', run: true, note: '运行钥匙可读（秘书台账：谁在忙 / 有哪些会话）' },
  { id: 'me.read', m: ['GET'], path: p('/api/me'), auth: 'session', note: '「我是谁」—— 登录完第一件事' },
  // 改中枢密码（2026-11-10）：只认会话里的 user（operator 没有中枢账号），
  // handler 里再判 kind —— 这里登记的是"存在"。真验证在中枢（/v1/auth/password）。
  { id: 'me.password', m: ['POST'], path: p('/api/me/password'), auth: 'session', noPanel: true, note: '「我的 › 修改密码」：转发中枢，本机不存密码' },
  { id: 'skills.list', m: ['GET'], path: p('/api/skills'), auth: 'session' },
  // 信箱（2026-11-11）：列表 / 未读数 / 标记已读 —— 都是登录用户自己的界面状态
  { id: 'notices.list', m: ['GET'], path: p('/api/notices'), auth: 'session' },
  { id: 'notices.unread', m: ['GET'], path: p('/api/notices/unread'), auth: 'session' },
  { id: 'notices.read', m: ['POST'], path: p('/api/notices/read'), auth: 'session' },
  // 岗位清单（2026-11-11）：岗位系统内置、权限挂在岗位上 —— 只读下发，界面画岗位下拉与权限矩阵
  { id: 'roles.list', m: ['GET'], path: p('/api/roles'), auth: 'session' },
  { id: 'workflows.list', m: ['GET'], path: p('/api/workflows'), auth: 'session' },
  { id: 'projects.list', m: ['GET'], path: p('/api/projects'), auth: 'session', run: true, note: '运行钥匙可读（PM brief：拿项目 id / 目录；秘书台账）' },
  { id: 'tasks.list', m: ['GET'], path: p('/api/tasks'), auth: 'session', run: true, note: '运行钥匙可读（秘书台账：全部任务卡）' },
  { id: 'prefs.read', m: ['GET'], path: p('/api/prefs'), auth: 'session', note: '回复风格读：设备也放行（手机设置页要画）' },
  // 2026-11-04 补登（用户实报 E4090）：v2.8 默认拒绝时漏了 PUT —— 设置 › 偏好的
  // 「言简意赅」开关点的就是它，一点就 404 E4090。语义：改**全体数字员工**的沟通
  // 偏好（存 config.json，下一轮派活生效），登录用户可改、设备不给 —— 与 settings.mjs
  // 「设备形态不渲染那一节」的前端口径对齐（设备打它 → E4033，不是 404）。
  { id: 'prefs.write', m: ['PUT'], path: p('/api/prefs'), auth: 'session', noPanel: true },
  { id: 'events.sse', m: ['GET'], path: p('/api/events'), auth: 'session', noPanel: true, note: '全局 SSE；panel 禁（只许单运行流）' },
  { id: 'runtimes.list', m: ['GET'], path: p('/api/runtimes'), auth: 'session', run: true, note: '分机模式页要机器名/版本；运行钥匙可读（值班手册：CLI 配没配好）' },
  { id: 'local.status.forUser', m: ['GET'], path: p('/api/local/status'), auth: 'session', note: '与 local.status 同路径：登记处放行，handler 的 authorizeLocal 照旧把员外身份拦下（E4091）' },
  { id: 'run.stream', m: ['GET'], path: p('/api/runs', id1, 'stream'), auth: 'session', note: '单运行事件流（SSE）' },
  // 证据索引（2026-11-09 检修 P2）：聊天里「证据」按钮点它 —— 只回工具/错误/时长摘要，
  // 完整事件仍走 stream 回放。只读、不新增任何写面。
  { id: 'run.evidence', m: ['GET'], path: p('/api/runs', id1, 'evidence'), auth: 'session', note: '运行证据摘要（工具/错误/时长）；细节走 stream' },
  { id: 'conv.detail', m: ['GET'], path: p('/api/conversations', id1), auth: 'session' },
  { id: 'conv.send', m: ['POST'], path: p('/api/conversations', id1, 'messages'), auth: 'session' },
  { id: 'card.detail', m: ['GET'], path: p('/api/projects/tasks', id1), auth: 'session' },
  { id: 'card.patch', m: ['PATCH'], path: p('/api/projects/tasks', id1), auth: 'session', run: true, note: '手机审批只放 {status, note}（字段级闸在 project.mjs）；2026-11-09 起运行钥匙可改**自己建的/自己当群助手的**卡（让 PM 能退待办/重跑/取消，不把活留成空话）' },
  { id: 'card.comments', m: ['GET', 'POST'], path: p('/api/projects/tasks', id1, 'comments'), auth: 'session' },
  { id: 'card.files', m: ['GET', 'POST'], path: p('/api/projects/tasks', id1, 'files'), auth: 'session' },
  { id: 'card.pr', m: ['GET', 'POST'], path: p('/api/projects/tasks', id1, 'pr(?:/refresh|/create|/merge)?'), auth: 'session' },
  { id: 'board', m: ['GET'], path: p('/api/projects', id1, 'tasks'), auth: 'session' },
  { id: 'card.create', m: ['POST'], path: p('/api/projects', id1, 'tasks'), auth: 'session',
    note: '手机建卡（2026-11-03 实机放开）："人不在电脑前想起一件事要派下去"是手机端核心场景，绑人后建卡署名走 actorUser=归属人。只开**建**——删卡/改归属留在桌面；PATCH 的 {status, note} 字段级闸仍在 project.mjs' },
  { id: 'persona.detail', m: ['GET'], path: p('/api/personas', id1), auth: 'session' },
  { id: 'persona.tasks', m: ['GET'], path: p('/api/personas', id1, 'tasks'), auth: 'session', run: true, note: '运行钥匙可读（秘书台账：单个人手上的活）' },
  { id: 'group.detail', m: ['GET'], path: p('/api/groups', id1), auth: 'session' },
  { id: 'run.abort', m: ['POST'], path: p('/api/runs', id1, 'abort'), auth: 'session', note: '能派不能停 = 会话永远「正在输入」' },

  /* --------------------------------------- 需要权限（role_permissions 可扩） */
  { id: 'conv.create', m: ['POST'], path: p('/api/conversations'), auth: 'session',
    note: '手机「发消息」的第一步（2026-11-03 实机：E4033）。通讯录点人进详情 → 详情点「发消息」→ 与这个人**还没聊过**时没有可复用的会话，必须先建一段（openDirectChat 的 ③ 分支）。原来没开 device，于是「先聊过的能发、没聊过的报 E4033」—— 看着像"发消息按钮坏了"。只开建：改名/删会话/不显示仍是桌面的事' },
  { id: 'conv.update', m: ['PUT'], path: p('/api/conversations', id1), auth: 'session' },
  { id: 'conv.delete', m: ['DELETE'], path: p('/api/conversations', id1), auth: 'session' },
  { id: 'conv.hide', m: ['POST'], path: p('/api/conversations', id1, 'hide'), auth: 'session' },
  { id: 'conv.card', m: ['POST'], path: p('/api/conversations', id1, 'card'), auth: 'session' },
  { id: 'conv.files', m: ['POST'], path: p('/api/conversations', id1, 'files'), auth: 'session' },
  { id: 'files.get', m: ['GET'], path: p('/api/files', id1, id1), auth: 'session' },
  { id: 'persona.create', m: ['POST'], path: p('/api/personas'), auth: 'session' },
  { id: 'persona.update', m: ['PUT', 'PATCH'], path: p('/api/personas', id1), auth: 'session', note: '手机执行配置卡（2026-11-05）：设备只许改 runtime/model/maxParallel 三项，身份字段以库中现值原样回填 —— 字段级闸在 persona.mjs' },
  { id: 'persona.delete', m: ['DELETE'], path: p('/api/personas', id1), auth: 'session' },
  { id: 'persona.open', m: ['POST'], path: p('/api/personas', id1, 'open'), auth: 'session' },
  { id: 'persona.runtimeSkills', m: ['GET', 'PUT'], path: p('/api/personas', id1, 'runtime-skills'), auth: 'session' },
  { id: 'persona.skills', m: ['GET', 'POST'], path: p('/api/personas', id1, 'skills'), auth: 'session' },
  { id: 'persona.skill.one', m: ['PUT', 'DELETE'], path: p('/api/personas', id1, 'skills', id1), auth: 'session' },
  { id: 'persona.feishu', m: ['GET', 'PUT', 'POST'], path: p('/api/personas', id1, 'feishu(?:/test|/start|/stop)?'), auth: 'session' },
  { id: 'group.create', m: ['POST'], path: p('/api/groups'), auth: 'session',
    note: '手机建群（2026-11-05 实机：E4033，与 conv.create 同一个坑——路由没打 device 标）。只开**建**：改名/解散/换群助手/踢人仍是桌面的事' },
  { id: 'group.update', m: ['PATCH', 'PUT'], path: p('/api/groups', id1), auth: 'session' },
  { id: 'group.delete', m: ['DELETE'], path: p('/api/groups', id1), auth: 'session' },
  { id: 'group.sessions', m: ['POST'], path: p('/api/groups', id1, 'sessions'), auth: 'session',
    note: '手机进群聊天要用（2026-11-05）：群是"一次任务一段"，没有可复用的空会话时前端会落一段新的（groups.mjs）；不开 device 手机上"点群进详情再进聊天"就 E4033' },
  { id: 'group.members', m: ['POST'], path: p('/api/groups', id1, 'members'), auth: 'session',
    note: '手机建完群选人拉进来要用（2026-11-05 实机又 E4033）：建群时只勾了一部分人，事后补拉是同一动作的后半截；踢人（group.member.one）仍留桌面' },
  { id: 'group.member.one', m: ['DELETE'], path: p('/api/groups', id1, 'members', id1), auth: 'session' },
  { id: 'project.create', m: ['POST'], path: p('/api/projects'), auth: 'session' },
  { id: 'project.update', m: ['PATCH', 'PUT'], path: p('/api/projects', id1), auth: 'session' },
  { id: 'project.delete', m: ['DELETE'], path: p('/api/projects', id1), auth: 'session' },
  { id: 'project.tasks', m: ['POST'], path: p('/api/projects', id1, 'tasks'), auth: 'session' },
  { id: 'project.repoCards', m: ['GET', 'POST'], path: p('/api/projects', id1, 'repo-cards'), auth: 'session' },
  { id: 'card.delete', m: ['DELETE'], path: p('/api/projects/tasks', id1), auth: 'session' },
  { id: 'workflow.create', m: ['POST'], path: p('/api/workflows'), auth: 'session' },
  { id: 'wf.tpl.list', m: ['GET'], path: p('/api/workflows/templates'), auth: 'session',
    note: '只读清单（名字 + 发布态）：手机建定时任务时「交给流程」要选一条，读不到就成了"一条都没有"的假空态' },
  { id: 'wf.tpl.create', m: ['POST'], path: p('/api/workflows/templates'), auth: 'session' },
  { id: 'wf.tpl.one', m: ['GET', 'PUT', 'POST', 'DELETE'], path: p('/api/workflows/templates', id1), auth: 'session' },
  { id: 'wf.tpl.archive', m: ['POST'], path: p('/api/workflows/templates', id1, 'archive'), auth: 'session' },
  { id: 'wf.tpl.publish', m: ['POST'], path: p('/api/workflows/templates', id1, 'publish'), auth: 'session' },
  { id: 'wf.tpl.runs', m: ['GET'], path: p('/api/workflows/templates', id1, 'runs'), auth: 'session' },
  { id: 'wf.run.create', m: ['POST'], path: p('/api/workflows/runs'), auth: 'session' },
  { id: 'wf.run.one', m: ['GET', 'DELETE'], path: p('/api/workflows/runs', id1), auth: 'session' },
  { id: 'wf.run.act', m: ['POST'], path: p('/api/workflows/runs', id1, '(?:start|decide|retry|assign|status|abort)'), auth: 'session' },
  { id: 'wf.run.stepCard', m: ['POST'], path: p('/api/workflows/runs', id1, 'tasks', id1, 'card'), auth: 'session' },
  { id: 'schedule.list', m: ['GET'], path: p('/api/schedules'), auth: 'session' },
  { id: 'schedule.create', m: ['POST'], path: p('/api/schedules'), auth: 'session' },
  { id: 'schedule.one', m: ['PATCH', 'DELETE'], path: p('/api/schedules', id1), auth: 'session' },
  { id: 'schedule.run', m: ['POST'], path: p('/api/schedules', id1, 'run'), auth: 'session' },
  { id: 'skill.create', m: ['POST'], path: p('/api/skills'), auth: 'session' },
  { id: 'skill.discover', m: ['POST'], path: p('/api/skills/discover'), auth: 'session', noPanel: true, note: 'body 里 root 是任意本机路径 —— 供应链投毒面，panel 收' },
  { id: 'skill.import', m: ['POST'], path: p('/api/skills/import'), auth: 'session', noPanel: true, note: '同上' },
  { id: 'skill.one', m: ['GET', 'PUT', 'PATCH', 'DELETE'], path: p('/api/skills', id1), auth: 'session' },
  { id: 'skill.personas', m: ['POST'], path: p('/api/skills', id1, 'personas'), auth: 'session' },
  { id: 'connector.list', m: ['GET'], path: p('/api/connectors'), auth: 'session' },
  { id: 'connector.catalog', m: ['GET'], path: p('/api/connectors/catalog'), auth: 'session' },
  { id: 'connector.create', m: ['POST'], path: p('/api/connectors'), auth: 'session', noPanel: true },
  { id: 'connector.one', m: ['PUT', 'PATCH', 'DELETE'], path: p('/api/connectors', id1), auth: 'session', noPanel: true },
  { id: 'connector.probe', m: ['POST'], path: p('/api/connectors', id1, 'probe'), auth: 'session' },
  { id: 'quota.read', m: ['GET'], path: p('/api/quota'), auth: 'session' },
  { id: 'quota.write', m: ['POST'], path: p('/api/quota'), auth: 'session', noPanel: true, note: '每模型限额就是路由约束' },
  { id: 'git.status', m: ['GET'], path: p('/api/git/status'), auth: 'session' },
  { id: 'git.whoami', m: ['GET'], path: p('/api/git/whoami'), auth: 'session' },
  { id: 'git.available', m: ['GET'], path: p('/api/git/available'), auth: 'session' },
  { id: 'git.repos.list', m: ['GET'], path: p('/api/git/repos'), auth: 'session' },
  { id: 'git.repos.create', m: ['POST'], path: p('/api/git/repos'), auth: 'session' },
  { id: 'git.repos.dir', m: ['GET'], path: p('/api/git/repos-dir'), auth: 'session' },
  { id: 'git.token', m: ['POST', 'DELETE'], path: p('/api/git/token'), auth: 'session', noPanel: true, note: '连接器凭据' },
  { id: 'git.prs.refresh', m: ['POST'], path: p('/api/git/prs/refresh'), auth: 'session' },
  { id: 'git.repo.one', m: ['GET', 'DELETE'], path: p('/api/git/repos', id1), auth: 'session' },
  { id: 'git.repo.settings', m: ['POST'], path: p('/api/git/repos', id1, 'settings'), auth: 'session' },
  { id: 'git.repo.patrol', m: ['POST'], path: p('/api/git/repos', id1, 'patrol'), auth: 'session' },
  { id: 'git.repo.patrolRun', m: ['POST'], path: p('/api/git/repos', id1, 'patrol', 'run'), auth: 'session' },
  { id: 'git.repo.changes', m: ['GET'], path: p('/api/git/repos', id1, 'changes'), auth: 'session' },
  { id: 'git.repo.log', m: ['GET'], path: p('/api/git/repos', id1, 'log'), auth: 'session' },
  { id: 'git.repo.diff', m: ['GET'], path: p('/api/git/repos', id1, 'diff'), auth: 'session' },
  { id: 'git.repo.discard', m: ['POST'], path: p('/api/git/repos', id1, 'discard'), auth: 'session' },
  { id: 'git.repo.branches', m: ['GET'], path: p('/api/git/repos', id1, 'branches'), auth: 'session' },
  { id: 'git.repo.checkout', m: ['POST'], path: p('/api/git/repos', id1, 'checkout'), auth: 'session' },
  { id: 'git.repo.branch', m: ['POST'], path: p('/api/git/repos', id1, 'branch'), auth: 'session' },
  { id: 'git.repo.branchDelete', m: ['POST'], path: p('/api/git/repos', id1, 'branch-delete'), auth: 'session' },
  { id: 'git.repo.branchDiff', m: ['GET'], path: p('/api/git/repos', id1, 'branch-diff'), auth: 'session' },
  { id: 'git.repo.branchDiffFile', m: ['GET'], path: p('/api/git/repos', id1, 'branch-diff', 'file'), auth: 'session' },
  { id: 'git.repo.commit', m: ['POST'], path: p('/api/git/repos', id1, 'commit'), auth: 'session' },
  { id: 'git.repo.suggestCommit', m: ['POST'], path: p('/api/git/repos', id1, 'suggest-commit'), auth: 'session' },
  { id: 'git.repo.suggestPr', m: ['POST'], path: p('/api/git/repos', id1, 'suggest-pr'), auth: 'session' },
  { id: 'git.repo.push', m: ['POST'], path: p('/api/git/repos', id1, 'push'), auth: 'session' },
  { id: 'git.repo.fetch', m: ['POST'], path: p('/api/git/repos', id1, 'fetch'), auth: 'session' },
  { id: 'git.repo.sync', m: ['POST'], path: p('/api/git/repos', id1, 'sync'), auth: 'session' },
  { id: 'git.repo.back', m: ['POST'], path: p('/api/git/repos', id1, 'back'), auth: 'session' },
  { id: 'git.repo.prs', m: ['GET', 'POST'], path: p('/api/git/repos', id1, 'prs'), auth: 'session' },
  { id: 'git.repo.pr.one', m: ['POST', 'DELETE'], path: p('/api/git/repos', id1, 'prs', '(\\d+)'), auth: 'session' },
  { id: 'git.repo.pr.checks', m: ['GET', 'POST'], path: p('/api/git/repos', id1, 'prs', '(\\d+)', 'checks(?:/rerun)?'), auth: 'session' },
  { id: 'git.repo.pr.fix', m: ['POST'], path: p('/api/git/repos', id1, 'prs', '(\\d+)', 'fix'), auth: 'session' },
  { id: 'git.repo.pr.merge', m: ['POST'], path: p('/api/git/repos', id1, 'prs', '(\\d+)', 'merge'), auth: 'session' },
  { id: 'ssh.list', m: ['GET'], path: p('/api/ssh/servers'), auth: 'session' },
  { id: 'ssh.create', m: ['POST'], path: p('/api/ssh/servers'), auth: 'session', noPanel: true, note: '含私钥路径' },
  { id: 'ssh.one', m: ['DELETE', 'PUT'], path: p('/api/ssh/servers', id1), auth: 'session', noPanel: true },
  { id: 'ssh.key', m: ['GET', 'POST'], path: p('/api/ssh/servers', id1, 'key'), auth: 'session', noPanel: true, note: 'GET=读公钥/引导步骤（详情页），POST=生成密钥对' },
  { id: 'ssh.test', m: ['POST'], path: p('/api/ssh/servers', id1, 'test'), auth: 'session' },
  { id: 'ssh.hostkey', m: ['POST'], path: p('/api/ssh/servers', id1, 'hostkey'), auth: 'session', noPanel: true, note: '清本机主机指纹并重测（弹窗「更新指纹并重试」按钮）；这是"我确认服务器换过身份"的操作' },
  { id: 'workspace.file', m: ['GET', 'POST'], path: p('/api/workspace/file'), auth: 'session' },
  { id: 'open.path', m: ['POST'], path: p('/api/open'), auth: 'session' },
  { id: 'fs.dirs', m: ['GET'], path: p('/api/fs/dirs'), auth: 'session', noPanel: true, note: '任意目录列举 = 摸操作员整块磁盘' },
  { id: 'status.ledger', m: ['GET'], path: p('/api/status/ledger'), auth: 'session' },
  { id: 'status.managed', m: ['POST'], path: p('/api/status/managed'), auth: 'session' },
  { id: 'status.projects', m: ['GET'], path: p('/api/status/projects'), auth: 'session' },
  { id: 'status.project.one', m: ['GET'], path: p('/api/status/projects', id1), auth: 'session' }, // 详情（版本/要点）—— 2026-10-31 收尾回归抓漏补登
  { id: 'plugins.list', m: ['GET'], path: p('/api/plugins'), auth: 'session' },
  { id: 'plugin.action', m: ['POST'], path: p('/api/plugins', id1, '(?:install|enable|disable)'), auth: 'session', noPanel: true, note: '插件装卸 = 在总机上落代码' },
  { id: 'plugin.delete', m: ['DELETE'], path: p('/api/plugins', id1), auth: 'session', noPanel: true },
  /*
   * 本机软件商店安装任务（原 nodes.dispatch / nodes.task.one 改名保留，2026-11-09）：
   * 多机节点子系统删除后，nodeId 恒为 'local'，路径从 /api/nodes/local/tasks 改为
   * /api/install/tasks，响应形状不变。auth 照搬原条目（session + noPanel）。
   */
  { id: 'localTasks.dispatch', m: ['POST'], path: p('/api/install/tasks'), auth: 'session', noPanel: true, note: '本机软件商店安装任务（一键装/常驻/打开面板）' },
  { id: 'localTasks.list', m: ['GET'], path: p('/api/install/tasks'), auth: 'session', note: '本机安装任务列表（新的在前）' },
  { id: 'localTasks.one', m: ['GET'], path: p('/api/install/tasks', id1), auth: 'session', note: '本机安装任务详情（装装进度轮询）' },
  { id: 'devices.list', m: ['GET'], path: p('/api/devices'), auth: 'session' },
  { id: 'devices.create', m: ['POST'], path: p('/api/devices'), auth: 'session' },
  { id: 'devices.one', m: ['GET', 'DELETE'], path: p('/api/devices', id1), auth: 'session', noPanel: true },
  { id: 'devices.rename', m: ['POST'], path: p('/api/devices', id1, 'rename'), auth: 'session', noPanel: true },
  { id: 'devices.runtimes', m: ['POST'], path: p('/api/devices', id1, 'runtimes'), auth: 'session', noPanel: true },
  { id: 'devices.runtime.one', m: ['PUT', 'PATCH', 'DELETE'], path: p('/api/devices', id1, 'runtimes', id1), auth: 'session', noPanel: true },
  { id: 'devices.runtime.probe', m: ['POST'], path: p('/api/devices', id1, 'runtimes', id1, 'probe'), auth: 'session' },
  { id: 'runtime.detect', m: ['GET'], path: p('/api/runtimes/detect'), auth: 'session' },
  { id: 'runtime.test', m: ['POST'], path: p('/api/runtimes/test'), auth: 'session' },
  { id: 'runtime.families', m: ['GET'], path: p('/api/runtime-families'), auth: 'session' },
  { id: 'runtime.models', m: ['GET'], path: p('/api/runtimes', id1, 'models'), auth: 'session', note: '只读模型清单（2026-11-05）：手机能设模型就得能读清单 —— 名字列表，无敏感' },
  { id: 'lan.read', m: ['GET'], path: p('/api/lan'), auth: 'session' },
  { id: 'lan.write', m: ['POST'], path: p('/api/lan'), auth: 'session', noPanel: true, note: '局域网开关' },
  { id: 'control.restart', m: ['POST'], path: p('/api/control-plane/restart'), auth: 'session', noPanel: true, note: '重启控制面（改了监听地址后生效；只给被 systemd/桌面壳监护的进程，E1061）' },
  { id: 'experts.list', m: ['GET'], path: p('/api/experts'), auth: 'session' },
  { id: 'expert.hire', m: ['POST'], path: p('/api/experts', id1, 'hire'), auth: 'session' },
  { id: 'expert.fire', m: ['POST'], path: p('/api/experts', id1, 'fire'), auth: 'session' },
  { id: 'agent.cards', m: ['POST'], path: p('/api/agent/cards'), auth: 'session', run: true, note: '建卡通道：运行钥匙可达；建卡权按岗位认（403 E2057 在 handler，agent-auth）' },
  { id: 'agent.cards.batch', m: ['POST'], path: p('/api/agent/cards/batch'), auth: 'session', run: true, note: '批量建卡通道：先全量校验再建，一张不合格整批拒；运行钥匙可达' },
  { id: 'users.list', m: ['GET'], path: p('/api/users'), auth: 'session', noPanel: true },
  { id: 'users.create', m: ['POST'], path: p('/api/users'), auth: 'session', noPanel: true, note: '建影子账号（预占名字，等中枢账号首次登录时绑定）' },
  { id: 'users.one', m: ['GET', 'PATCH', 'DELETE'], path: p('/api/users', id1), auth: 'session', noPanel: true },
  { id: 'security.sessions', m: ['GET'], path: p('/api/security/sessions'), auth: 'session' },
  { id: 'security.revokeOthers', m: ['POST'], path: p('/api/security/sessions/revoke-others'), auth: 'session', note: '踢自己的其它会话，本人操作不算管理' },
  { id: 'security.audit', m: ['GET'], path: p('/api/security/audit'), auth: 'session' },
  { id: 'security.auditExport', m: ['GET'], path: p('/api/security/audit/export'), auth: 'session', noPanel: true, note: '审计日志全量导出（2026-11-03）；读的是同一份数据，权限同 audit' },
  { id: 'security.auditClear', m: ['POST'], path: p('/api/security/audit/clear'), auth: 'session', noPanel: true, note: '彻底清空审计日志（主表+归档一起删、不留痕迹；破坏性动作，走 security:manage 而不是 audit:read）' },
];

/* ------------------------------------------------------------------ 查询 */

const COMPILED = ROUTES.map((r) => ({ ...r, re: r.path }));

/**
 * 登记了这条「路径 + 方法」吗。guard 在认证之前调它 —— 未登记 = 这个接口
 * 不存在（404 E4090）。**方法也要登记**：同一路径只登记部分方法时（如
 * `/api/security/audit` 只有 GET），没登记的方法同样 404（v2.8 修正 —— 旧版
 * 只看路径，其它方法会借已登记条目溜过这道闸，PDP 那层的方法感知被它架空）。
 * HEAD 按 GET 算；OPTIONS 交给 CORS 层处理，这里放行。
 */
export function isRegistered(pathname, method) {
  const p = String(pathname ?? '');
  const m = String(method ?? '').toUpperCase();
  if (m === 'OPTIONS') return true;
  const eff = m === 'HEAD' ? 'GET' : m;
  return COMPILED.some((r) => r.re.test(p) && (!eff || r.m.includes(eff)));
}

/**
 * 按路径（+ 方法）找登记项（PDP 用）。
 *
 * 两条规则：
 *   · **session 条目优先** —— 同一路径可能有多条登记（`/api/local/status` 一条
 *     auth:'local'、一条给登录用户的 session 条目），判"这个**已认证**的身份
 *     能不能过"该看 session 那条；
 *   · **方法必须命中** —— 同一路径不同方法待遇不同（`GET /api/prefs` 与
 *     `PUT /api/prefs` 不是一回事；`GET /api/quota` 只读、`POST /api/quota`
 *     是 noPanel 的管理动作）。带 method 时**只认方法命中的条目**，找不到就
 *     返回 null（v2.8 修正：旧版回落到同路径其它方法的条目，未登记的方法会
 *     借别的条目的宽松标放行 —— 方法闸等于没有）。
 */
export function findRoute(pathname, method) {
  const p = String(pathname ?? '');
  const m = String(method ?? '').toUpperCase();
  const eff = m === 'HEAD' ? 'GET' : m;
  if (eff) {
    const byMethod = COMPILED.find((r) => r.auth === 'session' && r.re.test(p) && r.m.includes(eff))
      ?? COMPILED.find((r) => r.re.test(p) && r.m.includes(eff));
    if (byMethod) return byMethod;
    return null;
  }
  return COMPILED.find((r) => r.auth === 'session' && r.re.test(p)) ?? COMPILED.find((r) => r.re.test(p)) ?? null;
}
