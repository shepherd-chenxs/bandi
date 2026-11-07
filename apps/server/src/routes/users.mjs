/*
 * routes/users.mjs —— 账号与安全。
 *
 * 账号（2026-11-07 起）只是「中枢账号在本机的影子」：**登录入口只有 `POST /hub/login`**
 * （routes/hub.mjs 转给中枢），本文件不再管认证 —— 剩下的是影子账号的维护与"我是谁"：
 *
 *   POST   /api/logout       → 退出（**免令牌**，凭据就是那张会话票本身）
 *   GET    /api/me           → 我是谁（operator / user / device）
 *   GET    /api/users        → 账号列表（**不含任何凭据字段**）
 *   POST   /api/users        → 建影子账号（预占名字，等中枢账号首次登录时绑定）
 *   PATCH  /api/users/:id    → 改名 / 启用禁用
 *   DELETE /api/users/:id    → 删账号
 *   GET    /api/security/*   → 会话列表 / 审计日志（只认会话里的身份）
 *
 * **两条不能松的口径**：
 *   1. 会话票**绝不进日志、不回显**；列表接口不出现任何凭据字段。
 *   2. 内置账号（第一个账号）不可删、不可禁用 —— hub 绑定（hub_links）都指向它，
 *      那是"把自己关在门外"的同义词。
 *
 * 本文件用掉的错误码（E38xx 段）：
 *   E3801 用户名不能为空 / 超过 20 字      （400）
 *   E3802 用户名已被占用                   （409）
 *   E3807 账号不存在                       （404）
 *   E3808 内置账号不可禁用 / 不可删        （403）
 *   E3810 还没登录                         （401）
 *   E3812 账号接口不支持这个方法           （405）
 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as auth from '../auth.mjs';
import * as store from '../store.mjs';
import * as csrf from '../security/csrf.mjs';

const NAME_MAX = 20;

/** 内置账号 = 第一个账号（判据只在这里和 store 里各一处） */
const isBuiltin = (u) => !!u?.builtin;

export class UserError extends Error {
  constructor(status, code, message, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ 校验 */

function checkName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new UserError(400, 'E3801', '用户名不能为空');
  if ([...name].length > NAME_MAX) throw new UserError(400, 'E3801', `用户名最多 ${NAME_MAX} 个字`);
  return name;
}

function meOf(who) {
  const u = store.getUser(who.userId);
  if (!u) return null;
  // hub = 这个本机名条绑着的**中枢账号**（登录用的手机号）——「我的」页身份卡用它；
  // 本机名条的名字随每次登录与中枢对齐（routes/hub.mjs），所以 name 一般就等于 hub。
  const link = store.listHubLinks().find((l) => l.userId === u.id);
  return { kind: 'user', user: { id: u.id, name: u.name, hub: link?.login ?? null } };
}

/* ------------------------------------------------------------------ 主体 */

export async function handleUsers(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const touched =
    p === '/api/logout' || p === '/api/me' || p.startsWith('/api/users') || p.startsWith('/api/security');
  if (!touched) return false;

  try {
    /* ------------------------------------------------ 退出（免令牌） */
    if (method === 'POST' && p === '/api/logout') {
      const sid = auth.sessionTokenOf(req);
      if (sid) store.deleteSession(sid);
      /*
       * **两张票一起清**：除了登录会话票，还要让浏览器丢掉访问令牌 Cookie ——
       * 否则一个填过令牌的浏览器永远被"令牌优先"放进面板，退出登录退了个寂寞。
       * 脚本用头带令牌，不受 Cookie 影响。
       */
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': [auth.clearedSessionCookie(), auth.clearedTokenCookie()],
      });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    /* ------------------------------------------------ 安全（会话 / 审计） */
    /*
     * 口子，都只认**会话里**的身份：
     *   GET  /api/security/sessions               → 我的活动会话（设备/IP/最近活跃）
     *   POST /api/security/sessions/revoke-others → 踢掉我其它设备（保留当前这张票）
     *   GET  /api/security/audit                  → 审计日志（kind/limit 游标翻页）
     *   GET  /api/security/audit/export           → 审计日志全量导出
     *   POST /api/security/audit/clear            → 清空（先归档再删，留 audit.clear 痕迹）
     */
    if (p.startsWith('/api/security')) {
      const who = req.bandiAuth;
      if (who?.kind !== 'user') throw new UserError(401, 'E3810', '还没登录');
      const me = store.getUser(who.userId);
      if (!me) throw new UserError(401, 'E3810', '这个账号已经不在了，请重新登录');

      if (method === 'GET' && p === '/api/security/sessions') {
        return sendJson(res, 200, { sessions: store.listSessionsOf(me.id) }), true;
      }

      if (method === 'POST' && p === '/api/security/sessions/revoke-others') {
        const sid = auth.sessionTokenOf(req);
        const hit = sid ? store.userBySession(sid) : null; // 顺手验一遍：票还有效才配"保留自己"
        if (!hit) throw new UserError(401, 'E3810', '会话已过期，请重新登录');
        const kicked = store.deleteOtherSessions(me.id, hit.tokenHash);
        return sendJson(res, 200, { ok: true, kicked }), true;
      }

      if (method === 'GET' && p === '/api/security/audit') {
        const events = store.list({
          kind: url.searchParams.get('kind') ?? '',
          actorId: url.searchParams.get('actorId') ?? '',
          before: url.searchParams.get('before') ?? '',
          limit: Number(url.searchParams.get('limit') ?? 50),
        });
        return sendJson(res, 200, { events }), true;
      }

      /*
       * 导出：同一套类型筛选，全量返回（上限 5000 行）。
       * 回 JSON 而不是 CSV —— 前端自己拼 CSV 再下载，服务端不管编码 / 换行 / BOM 这些浏览器侧的事。
       */
      if (method === 'GET' && p === '/api/security/audit/export') {
        const events = store.listForExport({ kind: url.searchParams.get('kind') ?? '' });
        return sendJson(res, 200, { events }), true;
      }

      /*
       * 清空：先归档再删，主表留一条 audit.clear 痕迹 ——
       * "清空"不等于"抹掉证据"，搬进 archive 表的行仍然可事后查。
       */
      if (method === 'POST' && p === '/api/security/audit/clear') {
        const cleared = store.clearAll({
          actorKind: who.kind,
          actorId: who.userId ?? null,
          ip: String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''),
        });
        return sendJson(res, 200, { ok: true, cleared }), true;
      }

      throw new UserError(405, 'E3812', '安全接口不支持这个方法');
    }

    /* ------------------------------------------------ 我是谁 */
    if (method === 'GET' && p === '/api/me') {
      const who = req.bandiAuth;
      /*
       * `via` 要带上（2026-11-01 实报：点「退出登录」没反应）：
       *   · `loopback` = 本机免登录信任（回环形态 guard 在令牌识别**之前**就判成 operator），
       *     这种身份**没有登录态可退** —— 清了 Cookie 重载还是操作员，前端据此不摆退出按钮；
       *   · `token`    = 面板令牌（非回环形态）—— 退出会清掉令牌 Cookie，有效。
       */
      if (who?.kind === 'operator') return sendJson(res, 200, { kind: 'operator', via: who.via ?? null }), true;
      if (who?.kind === 'user') {
        const me = meOf(who);
        // 会话有效但账号被删了：当成没登录（前端会回登录页）
        if (!me) throw new UserError(401, 'E3810', '这个账号已经不在了，请重新登录');
        return sendJson(res, 200, me), true;
      }
      /*
       * 设备 / 节点令牌：回它们自己的身份。`/api/me` 是**给浏览器问"我是谁"**的，
       * 前端 `load()` 现在只问这一条，所以设备详情也一起带上（原来在 /api/pair/me 里）。
       */
      if (who?.kind === 'device') {
        const d = store.getDevice(who.deviceId);
        /*
         * 归属人（2026-11-03 设备绑人）：手机也要能回答"我是谁"。
         * 现在带上它归属的账号（零账号形态的老设备可能是 null，前端按"未绑定"显示）。
         */
        const owner = who.userId ? store.getUser(who.userId) : null;
        return sendJson(res, 200, {
          kind: 'device',
          device: d ? { id: d.id, name: d.name, pairedAt: d.pairedAt } : null,
          user: owner ? { id: owner.id, name: owner.name } : null,
        }), true;
      }
      throw new UserError(401, 'E3810', '还没登录');
    }

    /* ------------------------------------------------ 账号 CRUD（登录即全权） */

    if (method === 'GET' && p === '/api/users') {
      /*
       * `hubAccounts`（2026-11-07）：这台机器认下的**中枢账号**名单 —— 「认证在中枢、
       * 授权在本机」里"授权"那一半的可视形态：有行 = 票验过后能进门。
       * userName 带出来是给「中枢账号绑着哪个影子账号」看的（一机一用户是常态，
       * 但预占影子账号时会出现多行绑同一个人的情况，页面上要能对上号）。
       */
      const hubAccounts = store
        .listHubLinks()
        .map((l) => ({
          accountId: l.accountId,
          login: l.login ?? null,
          userId: l.userId,
          userName: store.getUser(l.userId)?.name ?? null,
          createdAt: l.createdAt ?? null,
          lastEnterAt: l.lastEnterAt ?? null,
        }));
      return sendJson(res, 200, { users: store.listUsers(), hasUsers: store.hasUsers(), hubAccounts }), true;
    }

    if (method === 'POST' && p === '/api/users') {
      /*
       * 建影子账号：预占一个名字（多台设备/多个中枢账号要提前排好绑定时用）。
       * 真正"进人"靠中枢账号首次登录时的自动绑定（routes/hub.mjs → firstUser ?? createUser）。
       */
      const body = await readBody(req);
      const name = checkName(body?.name);
      if (store.nameTaken(name)) throw new UserError(409, 'E3802', `用户名「${name}」已经有人用了`);
      const user = store.createUser({ name });
      return sendJson(res, 201, { user, first: !!user.builtin }), true;
    }

    const one = /^\/api\/users\/([^/]+)$/.exec(p);
    if (!one) return fail(res, 404, 'E2036', '没有这个账号接口'), true;
    const id = decodeURIComponent(one[1]);
    const cur = store.getUser(id);
    if (!cur) throw new UserError(404, 'E3807', '没有这个账号');

    if (method === 'PATCH') {
      const body = await readBody(req);
      let out = cur;

      if (body?.name !== undefined) {
        const name = checkName(body.name);
        if (store.nameTaken(name, id)) throw new UserError(409, 'E3802', `用户名「${name}」已经有人用了`);
        out = store.renameUser(id, name) ?? out;
      }
      if (body?.disabled !== undefined) {
        const want = !!body.disabled;
        if (isBuiltin(cur) && want) throw new UserError(403, 'E3808', '内置账号不能被禁用');
        out = store.setDisabled(id, want) ?? out;
      }
      return sendJson(res, 200, { user: out }), true;
    }

    if (method === 'DELETE') {
      if (isBuiltin(cur)) throw new UserError(403, 'E3808', '内置账号不能删除');
      store.deleteUser(id);
      return sendJson(res, 200, { ok: true, id }), true;
    }

    return fail(res, 405, 'E3812', `账号接口不支持 ${method}`), true;
  } catch (err) {
    if (err instanceof UserError) return fail(res, err.status, err.code, err.message, err.extra), true;
    throw err; // 其余交给 server.mjs 顶层 catch（E5004 那一层）
  }
}
