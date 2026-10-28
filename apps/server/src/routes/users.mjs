/*
 * routes/users.mjs —— 账号、登录与角色分配（2026-10-28 第三刀）。
 *
 * 七个口：
 *   POST   /api/login        → 登录（**免令牌**，见 auth.mjs 的豁免；CSRF 闸照过）
 *   POST   /api/logout       → 退出（**免令牌**，凭据就是那张会话票本身）
 *   GET    /api/me           → 我是谁（operator / user + role.menuKeys）
 *   GET    /api/users        → 账号列表（mayManage，**不含 salt/hash**）
 *   POST   /api/users        → 建账号（mayManage）
 *   PATCH  /api/users/:id    → 改名 / 改密码 / 改角色 / 启用禁用（mayManage）
 *   DELETE /api/users/:id    → 删账号（mayManage）
 *
 * **三条不能松的口径**（任务书 §三）：
 *   1. 登录失败一律「用户名或密码不对」—— 不暴露用户是否存在；
 *      同一 IP + 同一用户名 5 分钟内失败 5 次 → 429（内存计数，重启清零）。
 *   2. 密码 / 会话票**绝不进日志、不回显**；连列表接口都不出现 salt/hash 字段。
 *   3. 内置管理员（第一个账号）不可删、不可改角色、不可禁用；任何时候都不能把
 *      **最后一个管理员**弄没 —— 那是"把自己关在门外"的同义词。
 *
 * 本文件用掉的错误码（E38xx 段，全仓此前都没占用）：
 *   E3801 用户名不能为空 / 超过 20 字      （400）
 *   E3802 用户名已被占用                   （409）
 *   E3803 密码长度不在 8–128               （400）
 *   E3804 角色不存在                       （400）
 *   E3805 用户名或密码不对                 （401）
 *   E3806 登录失败次数过多                 （429）
 *   E3807 账号不存在                       （404）
 *   E3808 内置管理员不可改角色 / 不可禁用 / 不可删（403）
 *   E3809 不能移除最后一个管理员           （409）
 *   E3810 还没登录                         （401）
 *   E3811 只有管理员能管账号               （403）
 *   E3812 账号接口不支持这个方法           （405）
 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as auth from '../auth.mjs';
import * as store from '../store.mjs';

const NAME_MAX = 20;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/** 内置管理员 = 第一个账号：`builtin` + `admin` 角色（判据只在这里和 store 里各一处） */
const isBuiltinAdmin = (u) => !!u?.builtin;

class UserError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ 登录限速 */

/*
 * 内存计数：`ip|用户名` → { n, until }。重启清零 —— 够用（任务书 §三 明确允许）。
 * 为什么不落库：这是**闸**不是**数据**，落库反而给磁盘写压力，也让"重启解锁"
 * 这件好事变成坏事（攻击者会盯着它）。
 */
const FAILS = new Map();
const FAIL_LIMIT = 5;
const FAIL_WINDOW = 5 * 60_000;

function failKey(req, name) {
  const ip = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return `${ip}|${store.normName(name)}`;
}

function tooMany(req, name) {
  const k = failKey(req, name);
  const rec = FAILS.get(k);
  if (!rec) return false;
  if (Date.now() > rec.until) {
    FAILS.delete(k);
    return false;
  }
  return rec.n >= FAIL_LIMIT;
}

function noteFail(req, name) {
  const k = failKey(req, name);
  const now = Date.now();
  const rec = FAILS.get(k);
  if (!rec || now > rec.until) FAILS.set(k, { n: 1, until: now + FAIL_WINDOW });
  else rec.n += 1;
}

function clearFails(req, name) {
  FAILS.delete(failKey(req, name));
}

/* ------------------------------------------------------------------ 校验 */

function checkName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new UserError(400, 'E3801', '用户名不能为空');
  if ([...name].length > NAME_MAX) throw new UserError(400, 'E3801', `用户名最多 ${NAME_MAX} 个字`);
  return name;
}

function checkPassword(raw) {
  const pwd = String(raw ?? '');
  if (pwd.length < PASSWORD_MIN || pwd.length > PASSWORD_MAX) {
    throw new UserError(400, 'E3803', `密码长度要在 ${PASSWORD_MIN}–${PASSWORD_MAX} 之间`);
  }
  return pwd;
}

/** 角色必须存在（`roleId` 指向 roles.id） */
function checkRole(roleId) {
  const role = store.getRole(String(roleId ?? '').trim());
  if (!role) throw new UserError(400, 'E3804', `没有这个角色：${roleId || '(空)'}`);
  return role;
}

/** 给前端的角色摘要（`menuKeys` 是"这个人该看见哪些菜单"的唯一来源） */
function roleBrief(roleId) {
  const r = store.getRole(roleId);
  if (!r) return null;
  return { id: r.id, name: r.name, menuKeys: Array.isArray(r.menuKeys) ? r.menuKeys : [] };
}

function meOf(who) {
  const u = store.getUser(who.userId);
  if (!u) return null;
  return { kind: 'user', user: { id: u.id, name: u.name }, role: roleBrief(u.roleId) };
}

/* ------------------------------------------------------------------ 主体 */

export async function handleUsers(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const touched =
    p === '/api/login' || p === '/api/logout' || p === '/api/me' || p.startsWith('/api/users');
  if (!touched) return false;

  try {
    /* ------------------------------------------------ 登录（免令牌） */
    if (method === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      const name = String(body?.name ?? '').trim();
      const password = String(body?.password ?? '');
      if (!name || !password) throw new UserError(400, 'E3801', '请输入用户名和密码');

      /*
       * 限速先判：**不看用户是否存在**（否则"429 只对存在的用户名出现"本身就是泄漏）。
       */
      if (tooMany(req, name)) {
        throw new UserError(429, 'E3806', `登录失败次数太多，请 ${Math.ceil(FAIL_WINDOW / 60_000)} 分钟后再试`);
      }

      const user = store.userByName(name);
      const ok = store.checkPassword(user, password) && !user.disabled;
      if (!ok) {
        noteFail(req, name);
        // 统一文案：不区分"用户不存在 / 密码错 / 被禁用"（被禁用也不该告诉外人）
        throw new UserError(401, 'E3805', '用户名或密码不对');
      }
      clearFails(req, name);

      const { token } = store.createSession(user.id);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': auth.sessionCookie(token),
      });
      res.end(
        JSON.stringify({
          ok: true,
          kind: 'user',
          user: { id: user.id, name: user.name },
          role: roleBrief(user.roleId),
        }),
      );
      return true;
    }

    /* ------------------------------------------------ 退出（免令牌） */
    if (method === 'POST' && p === '/api/logout') {
      const sid = auth.sessionTokenOf(req);
      if (sid) store.deleteSession(sid);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': auth.clearedSessionCookie(),
      });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    /* ------------------------------------------------ 我是谁 */
    if (method === 'GET' && p === '/api/me') {
      const who = req.bandiAuth;
      if (who?.kind === 'operator') return sendJson(res, 200, { kind: 'operator' }), true;
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
        return sendJson(res, 200, {
          kind: 'device',
          device: d ? { id: d.id, name: d.name, pairedAt: d.pairedAt } : null,
          /*
           * 手机的面板角色（2026-10-28 第四刀）：未分配 = 默认 `mobile`（底部四个 tab），
           * 与今天完全一样。前端 `S.menuKeys` 直接吃它的 menuKeys。
           */
          role: store.roleOrDefault(d?.roleId, store.DEFAULT_PHONE_ROLE),
        }), true;
      }
      throw new UserError(401, 'E3810', '还没登录');
    }

    /* ------------------------------------------------ 以下全部要管理员 */
    if (!auth.mayManage(req)) {
      throw new UserError(403, 'E3811', '只有管理员能管账号');
    }

    if (method === 'GET' && p === '/api/users') {
      return sendJson(res, 200, { users: store.listUsers(), hasUsers: store.hasUsers() }), true;
    }

    if (method === 'POST' && p === '/api/users') {
      const body = await readBody(req);
      const first = !store.hasUsers();
      const name = checkName(body?.name);
      if (store.nameTaken(name)) throw new UserError(409, 'E3802', `用户名「${name}」已经有人用了`);
      const password = checkPassword(body?.password);
      /*
       * 第一个账号**必须**是管理员（store 内部也会强制覆盖），所以它不校验 roleId；
       * 后面的账号必须显式给一个存在的角色 —— 没有"默认只读"这种含糊事。
       */
      if (!first) checkRole(body?.roleId);
      const user = store.createUser({ name, password, roleId: first ? 'admin' : body?.roleId });
      return sendJson(res, 201, { user, first }), true;
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
      if (body?.password !== undefined) {
        out = store.setPassword(id, checkPassword(body.password)) ?? out;
      }
      if (body?.roleId !== undefined) {
        const role = checkRole(body.roleId);
        // 内置管理员不可改角色（防锁死第一道）
        if (isBuiltinAdmin(cur)) throw new UserError(403, 'E3808', '内置管理员不能改角色');
        // 不能把最后一个管理员降级（防锁死第二道：改角色与禁用是同一种"少一个管理员"）
        if (cur.roleId === 'admin' && role.id !== 'admin' && store.countAdmins(id) === 0) {
          throw new UserError(409, 'E3809', '这是最后一个管理员，不能改角色');
        }
        out = store.setRole(id, role.id) ?? out;
      }
      if (body?.disabled !== undefined) {
        const want = !!body.disabled;
        if (isBuiltinAdmin(cur) && want) throw new UserError(403, 'E3808', '内置管理员不能被禁用');
        if (want && cur.roleId === 'admin' && store.countAdmins(id) === 0) {
          throw new UserError(409, 'E3809', '这是最后一个管理员，不能禁用');
        }
        out = store.setDisabled(id, want) ?? out;
      }
      return sendJson(res, 200, { user: out }), true;
    }

    if (method === 'DELETE') {
      if (isBuiltinAdmin(cur)) throw new UserError(403, 'E3808', '内置管理员不能删除');
      if (cur.roleId === 'admin' && store.countAdmins(id) === 0) {
        throw new UserError(409, 'E3809', '这是最后一个管理员，不能删除');
      }
      store.deleteUser(id);
      return sendJson(res, 200, { ok: true, id }), true;
    }

    return fail(res, 405, 'E3812', `账号接口不支持 ${method}`), true;
  } catch (err) {
    if (err instanceof UserError) return fail(res, err.status, err.code, err.message), true;
    throw err; // 其余交给 server.mjs 顶层 catch（E5004 那一层）
  }
}
