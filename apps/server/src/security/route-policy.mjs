/*
 * security/route-policy.mjs —— **全站路由权限清单（默认拒绝）**（IAM §8.3）。
 *
 * 一条铁律：**没登记的 `/api/*` 路径一律 404 `E4090`** —— guard 在认证之前先查这张表，
 * "服务里有但清单上没有"的接口从根上不存在。新加路由必须先来这里登记，smoke 的
 * 覆盖率扫描（扫 routes/*.mjs 的 `/api/` 字面量）会逼着两端同步。
 *
 * 字段口径：
 *   · `m`      —— 方法（文档用途 + 将来收紧；运行时登记检查只看路径，方法级
 *                 拒绝仍由 decide()/handler 负责 —— 分两步收，一次全收必翻车）；
 *   · `auth`   —— `public`（guard 在认证前放行）/ `session`（要身份，按 kind 判）/
 *                 `local`（本机接口，handler 里走 authorizeLocal，§8.5 矩阵）/
 *                 `bootstrap`（零账号引导，guard 豁免 + users.mjs 自校验）；
 *   · `member` —— 成员基线：**任何登录用户**都可达（≈原手机白名单 ∪ 本人接口，
 *                 行为与 v2.5 完全一致）；
 *   · `device` —— 手机设备令牌也可（设备白名单 ⊆ 成员基线，所以打了这个标的不
 *                 必再打 member）；
 *   · `noPanel`—— panel 令牌禁止（原 PANEL_FORBIDDEN 逐条迁进来：panel =「看 + 用」，
 *                 管理动作只有 operator/admin 能做）；
 *   · `perm`   —— 词表权限（§8.1）：非 admin 用户可由 `role_permissions` 解锁
 *                 （`store.roleHasPerm`）；admin 隐式 `*` 不查表。
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
  { id: 'nodes.join', m: ['POST'], path: p('/api/nodes/join'), auth: 'public', note: '新机器凭一次性邀请码加入' },
  { id: 'pair.claim', m: ['POST'], path: p('/api/pair/claim'), auth: 'public', note: '手机扫码换码' },
  { id: 'login', m: ['POST'], path: p('/api/login'), auth: 'public' },
  { id: 'login.otp', m: ['POST'], path: p('/api/login/otp'), auth: 'public', note: '两段式登录第二段' },
  { id: 'logout', m: ['POST'], path: p('/api/logout'), auth: 'public', note: '登出自检（有票才有的撤）' },
  { id: 'auth.token', m: ['POST'], path: p('/api/auth/token'), auth: 'public', note: '换票（§6.2）：三种凭据自校验 —— 密码(+otp) / refreshToken / 根令牌头换 break-glass 票' },
  { id: 'auth.refresh', m: ['POST'], path: p('/api/auth/refresh'), auth: 'public', note: '轮换：refresh 换新 access + 新 refresh；复用 → 整族撤销 E4092' },
  { id: 'auth.revoke', m: ['POST'], path: p('/api/auth/revoke'), auth: 'public', note: '凭票自撤（accessToken / refreshToken 至少一个）' },
  { id: 'users.bootstrap', m: ['POST'], path: p('/api/users'), auth: 'bootstrap', note: '零账号引导；有账号后要求 operator/admin + network 形态 X-Bandi-Setup（§8.6）' },
  { id: 'collab.join', m: ['POST'], path: p('/api/collab/join'), auth: 'public', note: '分公司凭 bc_ 令牌，handler 自校验（§6）' },
  { id: 'collab.poll', m: ['POST'], path: p('/api/collab/poll'), auth: 'public', note: '同上' },
  { id: 'collab.leave', m: ['POST'], path: p('/api/collab/leave'), auth: 'public', note: '同上' },
  { id: 'collab.task.report', m: ['POST'], path: p('/api/collab/tasks', id1, 'report'), auth: 'public', note: '同上' },
  // —— 中心侧管理面（操作员令牌 / admin，mayManage 语义）——
  { id: 'collab.invites', m: ['POST'], path: p('/api/collab/invites'), auth: 'session', perm: 'collab:manage', noPanel: true },
  { id: 'collab.branches', m: ['GET'], path: p('/api/collab/branches'), auth: 'session', perm: 'collab:read', noPanel: true },
  { id: 'collab.branch.revoke', m: ['POST'], path: p('/api/collab/branches', id1, 'revoke'), auth: 'session', perm: 'collab:manage', noPanel: true },
  { id: 'collab.tasks', m: ['GET', 'POST'], path: p('/api/collab/tasks'), auth: 'session', perm: 'collab:manage', noPanel: true },
  { id: 'collab.task.one', m: ['GET', 'PATCH'], path: p('/api/collab/tasks', id1), auth: 'session', perm: 'collab:manage', noPanel: true },
  { id: 'ai.image-config', m: ['GET', 'PUT'], path: p('/api/ai/image-config'), auth: 'public', note: 'guard 只对 source=loopback 豁免 GET；PUT 永远要身份' },
  { id: 'ai.image', m: ['POST'], path: p('/api/ai/image'), auth: 'public', note: '回环免令牌（本地模型探测）；network 不豁免' },
  { id: 'ai.image-test', m: ['POST'], path: p('/api/ai/image-test'), auth: 'public', note: '同上' },

  /* ------------------------------------------------------------ 本机接口 */
  // auth:'local' = handler 里 authorizeLocal() 说了算（§8.5 矩阵 / 姊妹文档）；
  // 这里登记只为「存在性」—— 漏登记会被默认拒绝 404。
  { id: 'local.status', m: ['GET'], path: p('/api/local/status'), auth: 'local' },
  { id: 'local.backups', m: ['GET'], path: p('/api/local/backups'), auth: 'local' },
  { id: 'local.collab.status', m: ['GET'], path: p('/api/local/collab/status'), auth: 'local' },
  { id: 'local.collab.join', m: ['POST'], path: p('/api/local/collab/join'), auth: 'local' },
  { id: 'local.collab.leave', m: ['POST'], path: p('/api/local/collab/leave'), auth: 'local' },
  { id: 'local.export', m: ['POST'], path: p('/api/local/export'), auth: 'local' },
  { id: 'local.import', m: ['POST'], path: p('/api/local/import'), auth: 'local' },
  { id: 'local.discover', m: ['POST'], path: p('/api/local/discover'), auth: 'local' },
  { id: 'local.probe', m: ['POST'], path: p('/api/local/probe'), auth: 'local' },
  { id: 'local.hosts.add', m: ['POST'], path: p('/api/local/hosts/add'), auth: 'local' },
  { id: 'local.hosts.remove', m: ['POST'], path: p('/api/local/hosts/remove'), auth: 'local' },
  { id: 'local.hosts.test', m: ['POST'], path: p('/api/local/hosts/test'), auth: 'local' },
  { id: 'local.join', m: ['POST'], path: p('/api/local/join'), auth: 'local' },
  { id: 'local.leave', m: ['POST'], path: p('/api/local/leave'), auth: 'local' },
  { id: 'restart', m: ['POST'], path: p('/api/restart'), auth: 'local', note: "秘密档位 'never'（v2.5：单向门）；但 panel 仍禁止" },

  /* ------------------------------------------------- 成员基线（登录即可） */
  { id: 'state.read', m: ['GET'], path: p('/api/state'), auth: 'session', member: true, device: true, perm: 'state:read' },
  { id: 'me.read', m: ['GET'], path: p('/api/me'), auth: 'session', member: true, device: true, note: '「我是谁」—— 登录完第一件事' },
  { id: 'me.password', m: ['POST'], path: p('/api/me/password'), auth: 'session', member: true, note: '改自己的密码，不要求管理员' },
  { id: 'me.otp', m: ['GET', 'POST', 'DELETE'], path: p('/api/me/otp'), auth: 'session', member: true, note: '动态验证自助' },
  { id: 'me.otp.bind', m: ['POST'], path: p('/api/me/otp/bind'), auth: 'session', member: true },
  { id: 'me.otp.bind.confirm', m: ['POST'], path: p('/api/me/otp/bind/confirm'), auth: 'session', member: true },
  { id: 'me.otp.status', m: ['GET'], path: p('/api/me/otp/status'), auth: 'session', member: true },
  { id: 'me.otp.unbind', m: ['POST'], path: p('/api/me/otp/unbind'), auth: 'session', member: true },
  { id: 'skills.list', m: ['GET'], path: p('/api/skills'), auth: 'session', member: true, device: true },
  { id: 'workflows.list', m: ['GET'], path: p('/api/workflows'), auth: 'session', member: true, device: true },
  { id: 'workflows.thread', m: ['GET'], path: p('/api/workflows/thread'), auth: 'session', member: true },
  { id: 'projects.list', m: ['GET'], path: p('/api/projects'), auth: 'session', member: true, device: true },
  { id: 'tasks.list', m: ['GET'], path: p('/api/tasks'), auth: 'session', member: true, device: true },
  { id: 'pair.me', m: ['GET'], path: p('/api/pair/me'), auth: 'session', member: true, device: true },
  { id: 'web.version', m: ['GET'], path: p('/api/web-version'), auth: 'session', member: true, device: true, note: '60 秒版本指纹轮询，零敏感' },
  { id: 'prefs.read', m: ['GET'], path: p('/api/prefs'), auth: 'session', member: true, device: true, note: 'PUT（改全体沟通偏好）不在此列' },
  { id: 'events.sse', m: ['GET'], path: p('/api/events'), auth: 'session', member: true, device: true, noPanel: true, note: '全局 SSE；panel 禁（只许单运行流）' },
  { id: 'runtimes.list', m: ['GET'], path: p('/api/runtimes'), auth: 'session', member: true, note: '分机模式页要机器名/版本' },
  { id: 'local.status.forUser', m: ['GET'], path: p('/api/local/status'), auth: 'session', member: true, note: '与 local.status 同路径：登记处放行，handler 的 authorizeLocal 照旧把员外身份拦下（E4091）' },
  { id: 'run.stream', m: ['GET'], path: p('/api/runs', id1, 'stream'), auth: 'session', member: true, device: true, note: '单运行事件流（SSE）' },
  { id: 'conv.detail', m: ['GET'], path: p('/api/conversations', id1), auth: 'session', member: true, device: true },
  { id: 'conv.send', m: ['POST'], path: p('/api/conversations', id1, 'messages'), auth: 'session', member: true, device: true, perm: 'message:send' },
  { id: 'card.detail', m: ['GET'], path: p('/api/projects/tasks', id1), auth: 'session', member: true, device: true, perm: 'task:read' },
  { id: 'card.patch', m: ['PATCH'], path: p('/api/projects/tasks', id1), auth: 'session', member: true, device: true, perm: 'task:write', note: '手机审批只放 {status, note}（字段级闸在 project.mjs）' },
  { id: 'card.comments', m: ['GET', 'POST'], path: p('/api/projects/tasks', id1, 'comments'), auth: 'session', member: true, device: true, perm: 'task:write' },
  { id: 'card.files', m: ['GET', 'POST'], path: p('/api/projects/tasks', id1, 'files'), auth: 'session', member: true, perm: 'task:read' },
  { id: 'card.pr', m: ['GET', 'POST'], path: p('/api/projects/tasks', id1, 'pr(?:\\/refresh|\\/create|\\/merge)?'), auth: 'session', member: true, perm: 'task:write' },
  { id: 'board', m: ['GET'], path: p('/api/projects', id1, 'tasks'), auth: 'session', member: true, device: true, perm: 'project:read' },
  { id: 'persona.detail', m: ['GET'], path: p('/api/personas', id1), auth: 'session', member: true, device: true, perm: 'persona:read' },
  { id: 'persona.tasks', m: ['GET'], path: p('/api/personas', id1, 'tasks'), auth: 'session', member: true, device: true, perm: 'persona:read' },
  { id: 'group.detail', m: ['GET'], path: p('/api/groups', id1), auth: 'session', member: true, device: true },
  { id: 'run.abort', m: ['POST'], path: p('/api/runs', id1, 'abort'), auth: 'session', member: true, device: true, note: '能派不能停 = 会话永远「正在输入」' },

  /* --------------------------------------- 需要权限（role_permissions 可扩） */
  { id: 'conv.create', m: ['POST'], path: p('/api/conversations'), auth: 'session', perm: 'conversation:read' },
  { id: 'conv.update', m: ['PUT'], path: p('/api/conversations', id1), auth: 'session', perm: 'conversation:read' },
  { id: 'conv.delete', m: ['DELETE'], path: p('/api/conversations', id1), auth: 'session', perm: 'conversation:read' },
  { id: 'conv.hide', m: ['POST'], path: p('/api/conversations', id1, 'hide'), auth: 'session', perm: 'conversation:read' },
  { id: 'conv.card', m: ['POST'], path: p('/api/conversations', id1, 'card'), auth: 'session', perm: 'task:write' },
  { id: 'conv.files', m: ['POST'], path: p('/api/conversations', id1, 'files'), auth: 'session', perm: 'message:send' },
  { id: 'files.get', m: ['GET'], path: p('/api/files', id1, id1), auth: 'session', perm: 'conversation:read' },
  { id: 'persona.create', m: ['POST'], path: p('/api/personas'), auth: 'session', perm: 'persona:write' },
  { id: 'persona.update', m: ['PUT', 'PATCH'], path: p('/api/personas', id1), auth: 'session', perm: 'persona:write' },
  { id: 'persona.delete', m: ['DELETE'], path: p('/api/personas', id1), auth: 'session', perm: 'persona:write' },
  { id: 'persona.open', m: ['POST'], path: p('/api/personas', id1, 'open'), auth: 'session', perm: 'persona:write' },
  { id: 'persona.runtimeSkills', m: ['GET', 'PUT'], path: p('/api/personas', id1, 'runtime-skills'), auth: 'session', perm: 'persona:write' },
  { id: 'persona.skills', m: ['GET', 'POST'], path: p('/api/personas', id1, 'skills'), auth: 'session', perm: 'persona:write' },
  { id: 'persona.skill.one', m: ['PUT', 'DELETE'], path: p('/api/personas', id1, 'skills', id1), auth: 'session', perm: 'persona:write' },
  { id: 'persona.feishu', m: ['GET', 'PUT', 'POST'], path: p('/api/personas', id1, 'feishu(?:\\/test|\\/start|\\/stop)?'), auth: 'session', perm: 'persona:write' },
  { id: 'group.create', m: ['POST'], path: p('/api/groups'), auth: 'session', perm: 'persona:write' },
  { id: 'group.update', m: ['PATCH', 'PUT'], path: p('/api/groups', id1), auth: 'session', perm: 'persona:write' },
  { id: 'group.delete', m: ['DELETE'], path: p('/api/groups', id1), auth: 'session', perm: 'persona:write' },
  { id: 'group.sessions', m: ['POST'], path: p('/api/groups', id1, 'sessions'), auth: 'session', perm: 'persona:write' },
  { id: 'group.members', m: ['POST'], path: p('/api/groups', id1, 'members'), auth: 'session', perm: 'persona:write' },
  { id: 'group.member.one', m: ['DELETE'], path: p('/api/groups', id1, 'members', id1), auth: 'session', perm: 'persona:write' },
  { id: 'project.create', m: ['POST'], path: p('/api/projects'), auth: 'session', perm: 'project:write' },
  { id: 'project.update', m: ['PATCH', 'PUT'], path: p('/api/projects', id1), auth: 'session', perm: 'project:write' },
  { id: 'project.delete', m: ['DELETE'], path: p('/api/projects', id1), auth: 'session', perm: 'project:write' },
  { id: 'project.tasks', m: ['POST'], path: p('/api/projects', id1, 'tasks'), auth: 'session', perm: 'task:write' },
  { id: 'project.repoCards', m: ['GET', 'POST'], path: p('/api/projects', id1, 'repo-cards'), auth: 'session', perm: 'project:write' },
  { id: 'card.delete', m: ['DELETE'], path: p('/api/projects/tasks', id1), auth: 'session', perm: 'task:write' },
  { id: 'workflow.create', m: ['POST'], path: p('/api/workflows'), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.tpl.list', m: ['GET'], path: p('/api/workflows/templates'), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.tpl.create', m: ['POST'], path: p('/api/workflows/templates'), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.tpl.one', m: ['GET', 'PUT', 'POST', 'DELETE'], path: p('/api/workflows/templates', id1), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.tpl.archive', m: ['POST'], path: p('/api/workflows/templates', id1, 'archive'), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.tpl.publish', m: ['POST'], path: p('/api/workflows/templates', id1, 'publish'), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.tpl.runs', m: ['GET'], path: p('/api/workflows/templates', id1, 'runs'), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.run.create', m: ['POST'], path: p('/api/workflows/runs'), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.run.one', m: ['GET', 'DELETE'], path: p('/api/workflows/runs', id1), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.run.act', m: ['POST'], path: p('/api/workflows/runs', id1, '(?:start|decide|retry|assign|status|abort)'), auth: 'session', perm: 'workflow:write' },
  { id: 'wf.run.stepCard', m: ['POST'], path: p('/api/workflows/runs', id1, 'tasks', id1, 'card'), auth: 'session', perm: 'workflow:write' },
  { id: 'schedule.list', m: ['GET'], path: p('/api/schedules'), auth: 'session', perm: 'schedule:manage' },
  { id: 'schedule.create', m: ['POST'], path: p('/api/schedules'), auth: 'session', perm: 'schedule:manage' },
  { id: 'schedule.one', m: ['PATCH', 'DELETE'], path: p('/api/schedules', id1), auth: 'session', perm: 'schedule:manage' },
  { id: 'schedule.run', m: ['POST'], path: p('/api/schedules', id1, 'run'), auth: 'session', perm: 'schedule:manage' },
  { id: 'skill.create', m: ['POST'], path: p('/api/skills'), auth: 'session', perm: 'skill:manage' },
  { id: 'skill.discover', m: ['POST'], path: p('/api/skills/discover'), auth: 'session', perm: 'skill:manage', noPanel: true, note: 'body 里 root 是任意本机路径 —— 供应链投毒面，panel 收' },
  { id: 'skill.import', m: ['POST'], path: p('/api/skills/import'), auth: 'session', perm: 'skill:manage', noPanel: true, note: '同上' },
  { id: 'skill.one', m: ['GET', 'PUT', 'PATCH', 'DELETE'], path: p('/api/skills', id1), auth: 'session', perm: 'skill:manage' },
  { id: 'skill.personas', m: ['POST'], path: p('/api/skills', id1, 'personas'), auth: 'session', perm: 'skill:manage' },
  { id: 'connector.list', m: ['GET'], path: p('/api/connectors'), auth: 'session', perm: 'connector:manage' },
  { id: 'connector.catalog', m: ['GET'], path: p('/api/connectors/catalog'), auth: 'session', perm: 'connector:manage' },
  { id: 'connector.create', m: ['POST'], path: p('/api/connectors'), auth: 'session', perm: 'connector:manage', noPanel: true },
  { id: 'connector.one', m: ['PUT', 'PATCH', 'DELETE'], path: p('/api/connectors', id1), auth: 'session', perm: 'connector:manage', noPanel: true },
  { id: 'connector.probe', m: ['POST'], path: p('/api/connectors', id1, 'probe'), auth: 'session', perm: 'connector:manage' },
  { id: 'quota.read', m: ['GET'], path: p('/api/quota'), auth: 'session', perm: 'quota:manage' },
  { id: 'quota.write', m: ['POST'], path: p('/api/quota'), auth: 'session', perm: 'quota:manage', noPanel: true, note: '每模型限额就是路由约束' },
  { id: 'git.status', m: ['GET'], path: p('/api/git/status'), auth: 'session', perm: 'git:manage' },
  { id: 'git.whoami', m: ['GET'], path: p('/api/git/whoami'), auth: 'session', perm: 'git:manage' },
  { id: 'git.available', m: ['GET'], path: p('/api/git/available'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repos.list', m: ['GET'], path: p('/api/git/repos'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repos.create', m: ['POST'], path: p('/api/git/repos'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repos.dir', m: ['GET'], path: p('/api/git/repos-dir'), auth: 'session', perm: 'git:manage' },
  { id: 'git.token', m: ['POST', 'DELETE'], path: p('/api/git/token'), auth: 'session', perm: 'git:manage', noPanel: true, note: '连接器凭据' },
  { id: 'git.prs.refresh', m: ['POST'], path: p('/api/git/prs/refresh'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.one', m: ['GET', 'DELETE'], path: p('/api/git/repos', id1), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.settings', m: ['POST'], path: p('/api/git/repos', id1, 'settings'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.patrol', m: ['POST'], path: p('/api/git/repos', id1, 'patrol'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.patrolRun', m: ['POST'], path: p('/api/git/repos', id1, 'patrol', 'run'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.changes', m: ['GET'], path: p('/api/git/repos', id1, 'changes'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.log', m: ['GET'], path: p('/api/git/repos', id1, 'log'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.diff', m: ['GET'], path: p('/api/git/repos', id1, 'diff'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.discard', m: ['POST'], path: p('/api/git/repos', id1, 'discard'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.branches', m: ['GET'], path: p('/api/git/repos', id1, 'branches'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.checkout', m: ['POST'], path: p('/api/git/repos', id1, 'checkout'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.branch', m: ['POST'], path: p('/api/git/repos', id1, 'branch'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.branchDelete', m: ['POST'], path: p('/api/git/repos', id1, 'branch-delete'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.branchDiff', m: ['GET'], path: p('/api/git/repos', id1, 'branch-diff'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.branchDiffFile', m: ['GET'], path: p('/api/git/repos', id1, 'branch-diff', 'file'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.commit', m: ['POST'], path: p('/api/git/repos', id1, 'commit'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.suggestCommit', m: ['POST'], path: p('/api/git/repos', id1, 'suggest-commit'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.suggestPr', m: ['POST'], path: p('/api/git/repos', id1, 'suggest-pr'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.push', m: ['POST'], path: p('/api/git/repos', id1, 'push'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.fetch', m: ['POST'], path: p('/api/git/repos', id1, 'fetch'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.sync', m: ['POST'], path: p('/api/git/repos', id1, 'sync'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.back', m: ['POST'], path: p('/api/git/repos', id1, 'back'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.prs', m: ['GET', 'POST'], path: p('/api/git/repos', id1, 'prs'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.pr.one', m: ['POST', 'DELETE'], path: p('/api/git/repos', id1, 'prs', '(\\d+)'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.pr.checks', m: ['GET', 'POST'], path: p('/api/git/repos', id1, 'prs', '(\\d+)', 'checks(?:\\/rerun)?'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.pr.fix', m: ['POST'], path: p('/api/git/repos', id1, 'prs', '(\\d+)', 'fix'), auth: 'session', perm: 'git:manage' },
  { id: 'git.repo.pr.merge', m: ['POST'], path: p('/api/git/repos', id1, 'prs', '(\\d+)', 'merge'), auth: 'session', perm: 'git:manage' },
  { id: 'ssh.list', m: ['GET'], path: p('/api/ssh/servers'), auth: 'session', perm: 'ssh:manage' },
  { id: 'ssh.create', m: ['POST'], path: p('/api/ssh/servers'), auth: 'session', perm: 'ssh:manage', noPanel: true, note: '含私钥路径' },
  { id: 'ssh.one', m: ['DELETE', 'PUT'], path: p('/api/ssh/servers', id1), auth: 'session', perm: 'ssh:manage', noPanel: true },
  { id: 'ssh.key', m: ['POST'], path: p('/api/ssh/servers', id1, 'key'), auth: 'session', perm: 'ssh:manage', noPanel: true },
  { id: 'ssh.test', m: ['POST'], path: p('/api/ssh/servers', id1, 'test'), auth: 'session', perm: 'ssh:manage' },
  { id: 'workspace.file', m: ['GET', 'POST'], path: p('/api/workspace/file'), auth: 'session', perm: 'project:read' },
  { id: 'open.path', m: ['POST'], path: p('/api/open'), auth: 'session', perm: 'project:read' },
  { id: 'fs.dirs', m: ['GET'], path: p('/api/fs/dirs'), auth: 'session', perm: 'machine:read', noPanel: true, note: '任意目录列举 = 摸操作员整块磁盘' },
  { id: 'fs.pickDir', m: ['POST'], path: p('/api/fs/pick-dir'), auth: 'session', perm: 'machine:read' },
  { id: 'status.ledger', m: ['GET'], path: p('/api/status/ledger'), auth: 'session', perm: 'machine:read' },
  { id: 'status.managed', m: ['POST'], path: p('/api/status/managed'), auth: 'session', perm: 'machine:read' },
  { id: 'status.projects', m: ['GET'], path: p('/api/status/projects'), auth: 'session', perm: 'project:read' },
  { id: 'plugins.list', m: ['GET'], path: p('/api/plugins'), auth: 'session', perm: 'plugin:manage' },
  { id: 'plugin.action', m: ['POST'], path: p('/api/plugins', id1, '(?:install|enable|disable)'), auth: 'session', perm: 'plugin:manage', noPanel: true, note: '插件装卸 = 在总机上落代码' },
  { id: 'plugin.delete', m: ['DELETE'], path: p('/api/plugins', id1), auth: 'session', perm: 'plugin:manage', noPanel: true },
  { id: 'nodes.list', m: ['GET'], path: p('/api/nodes'), auth: 'session', perm: 'device:read' },
  /*
   * ⚠️ **节点自端点必须登记在 `nodes.one`（/api/nodes/:id）之前**：路径正则
   * 不分先后、按清单顺序取第一条，`register` 会被通配条目当成 :id 抢走，
   * compute 标记就丢了（smoke-auth ⑥ 的"报到 403 E4031"就是这么来的）。
   */
  { id: 'nodes.register', m: ['POST'], path: p('/api/nodes/register'), auth: 'session', compute: true, note: '共享端点：id 在 body 里，归属在 handler 判' },
  { id: 'nodes.heartbeat', m: ['POST'], path: p('/api/nodes', id1, 'heartbeat'), auth: 'session', compute: true, note: '只认自己的 id（nodeMayReach）' },
  { id: 'nodes.claim', m: ['POST'], path: p('/api/nodes', id1, 'claim'), auth: 'session', compute: true },
  { id: 'nodes.task.report', m: ['POST'], path: p('/api/nodes', id1, 'tasks', id1, 'report'), auth: 'session', compute: true },
  { id: 'nodes.invites', m: ['POST'], path: p('/api/nodes/invites'), auth: 'session', perm: 'machine:manage', noPanel: true, note: '发邀请码 = 拉机器进门' },
  { id: 'nodes.create', m: ['POST'], path: p('/api/nodes'), auth: 'session', perm: 'machine:manage' },
  { id: 'nodes.one', m: ['DELETE'], path: p('/api/nodes', id1), auth: 'session', perm: 'machine:manage', noPanel: true, note: '忘掉 = 吊销' },
  { id: 'nodes.scope', m: ['POST'], path: p('/api/nodes', id1, 'scope'), auth: 'session', perm: 'machine:manage', noPanel: true, note: '权限本身只能总机侧改' },
  { id: 'nodes.role', m: ['POST'], path: p('/api/nodes', id1, 'role'), auth: 'session', perm: 'machine:manage', noPanel: true },
  { id: 'nodes.paths', m: ['POST'], path: p('/api/nodes', id1, 'paths'), auth: 'session', perm: 'machine:manage', noPanel: true },
  { id: 'nodes.dispatch', m: ['POST'], path: p('/api/nodes', id1, 'tasks'), auth: 'session', perm: 'machine:manage', noPanel: true, note: '让别的机器装东西' },
  { id: 'nodes.task.one', m: ['DELETE'], path: p('/api/nodes', id1, 'tasks', id1), auth: 'session', perm: 'machine:manage', noPanel: true },
  { id: 'devices.list', m: ['GET'], path: p('/api/devices'), auth: 'session', perm: 'device:read' },
  { id: 'devices.create', m: ['POST'], path: p('/api/devices'), auth: 'session', perm: 'device:manage' },
  { id: 'devices.one', m: ['GET', 'DELETE'], path: p('/api/devices', id1), auth: 'session', perm: 'device:manage', noPanel: true },
  { id: 'devices.rename', m: ['POST'], path: p('/api/devices', id1, 'rename'), auth: 'session', perm: 'device:manage', noPanel: true },
  { id: 'devices.runtimes', m: ['POST'], path: p('/api/devices', id1, 'runtimes'), auth: 'session', perm: 'device:manage', noPanel: true },
  { id: 'devices.runtime.one', m: ['PUT', 'PATCH', 'DELETE'], path: p('/api/devices', id1, 'runtimes', id1), auth: 'session', perm: 'device:manage', noPanel: true },
  { id: 'devices.runtime.probe', m: ['POST'], path: p('/api/devices', id1, 'runtimes', id1, 'probe'), auth: 'session', perm: 'device:manage' },
  { id: 'runtime.detect', m: ['GET'], path: p('/api/runtimes/detect'), auth: 'session', perm: 'machine:read' },
  { id: 'runtime.test', m: ['POST'], path: p('/api/runtimes/test'), auth: 'session', perm: 'machine:manage' },
  { id: 'runtime.families', m: ['GET'], path: p('/api/runtime-families'), auth: 'session', perm: 'machine:read' },
  { id: 'runtime.models', m: ['GET'], path: p('/api/runtimes', id1, 'models'), auth: 'session', perm: 'machine:read' },
  { id: 'lan.read', m: ['GET'], path: p('/api/lan'), auth: 'session', perm: 'machine:read' },
  { id: 'lan.write', m: ['POST'], path: p('/api/lan'), auth: 'session', perm: 'machine:manage', noPanel: true, note: '局域网开关' },
  { id: 'experts.list', m: ['GET'], path: p('/api/experts'), auth: 'session', perm: 'persona:read' },
  { id: 'expert.hire', m: ['POST'], path: p('/api/experts', id1, 'hire'), auth: 'session', perm: 'persona:write' },
  { id: 'expert.fire', m: ['POST'], path: p('/api/experts', id1, 'fire'), auth: 'session', perm: 'persona:write' },
  { id: 'agent.cards', m: ['POST'], path: p('/api/agent/cards'), auth: 'session', perm: 'task:write', note: '建卡权按岗位认：PM brief 注入 + 403 E2057 在 handler（agent-auth）' },
  { id: 'pair.tokens', m: ['POST'], path: p('/api/pair/tokens'), auth: 'session', perm: 'device:manage', noPanel: true },
  { id: 'pair.devices', m: ['GET'], path: p('/api/pair/devices'), auth: 'session', perm: 'device:read', noPanel: true },
  { id: 'pair.device.revoke', m: ['POST'], path: p('/api/pair/devices', id1, 'revoke'), auth: 'session', perm: 'device:manage', noPanel: true },
  { id: 'pair.device.role', m: ['POST'], path: p('/api/pair/devices', id1, 'role'), auth: 'session', perm: 'device:manage', noPanel: true },
  { id: 'menus.list', m: ['GET'], path: p('/api/menus'), auth: 'session', perm: 'role:manage', noPanel: true },
  { id: 'roles.list', m: ['GET'], path: p('/api/roles'), auth: 'session', perm: 'role:manage', noPanel: true },
  { id: 'roles.create', m: ['POST'], path: p('/api/roles'), auth: 'session', perm: 'role:manage', noPanel: true },
  { id: 'roles.one', m: ['PATCH', 'DELETE'], path: p('/api/roles', id1), auth: 'session', perm: 'role:manage', noPanel: true },
  { id: 'users.list', m: ['GET'], path: p('/api/users'), auth: 'session', perm: 'user:manage', noPanel: true },
  { id: 'users.create', m: ['POST'], path: p('/api/users'), auth: 'session', perm: 'user:manage', noPanel: true, note: '有账号后的建号（零账号引导走 users.bootstrap）' },
  { id: 'users.one', m: ['GET', 'PATCH', 'DELETE'], path: p('/api/users', id1), auth: 'session', perm: 'user:manage', noPanel: true },
  { id: 'security.sessions', m: ['GET'], path: p('/api/security/sessions'), auth: 'session', perm: 'audit:read' },
  { id: 'security.revokeOthers', m: ['POST'], path: p('/api/security/sessions/revoke-others'), auth: 'session', member: true, note: '踢自己的其它会话，本人操作不算管理' },
  { id: 'security.audit', m: ['GET'], path: p('/api/security/audit'), auth: 'session', perm: 'audit:read' },
  { id: 'run.events', m: ['POST'], path: p('/api/runs', id1, 'events'), auth: 'session', compute: true, note: '过程回传：getNodeJobByRun 归属校验' },
  { id: 'run.finish', m: ['POST'], path: p('/api/runs', id1, 'finish'), auth: 'session', compute: true, note: '回执：同上' },
];

/* ------------------------------------------------------------------ 查询 */

const COMPILED = ROUTES.map((r) => ({ ...r, re: r.path }));

/**
 * 登记了这条「路径 + 方法」吗。guard 在认证之前调它 —— 未登记 = 这个接口
 * 不存在（404 E4090）。**方法也要登记**：PUT /api/prefs 这种"路径登记过、
 * 方法没登记"的写法同样 404（v2.8 修正 —— 旧版只看路径，PUT 会借 GET 条目
 * 溜过这道闸，PDP 那层的方法感知被它架空）。HEAD 按 GET 算；OPTIONS 交给
 * CORS 层处理，这里放行。
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
 *     auth:'local'、一条给登录用户的 member 条目；`/api/users` 一条 bootstrap、
 *     一条 list），判"这个**已认证**的身份能不能过"该看 session 那条；
 *   · **方法必须命中** —— 同一路径不同方法待遇不同（`GET /api/quota` 只读、
 *     `POST /api/quota` 是 noPanel 的管理动作）。带 method 时**只认方法命中的
 *     条目**，找不到就返回 null（v2.8 修正：旧版回落到同路径其它方法的条目，
 *     PUT /api/prefs 会借 GET 条目的 device:true 放行 —— 方法闸等于没有）。
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
