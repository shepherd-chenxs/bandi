/*
 * routes/users.mjs —— 账号、登录与角色分配（2026-10-28 第三刀）。
 *
 * 七个口：
 *   POST   /api/login        → 登录（**免令牌**，见 auth.mjs 的豁免；CSRF 闸照过。
 *                               2026-10-31 起未设密码的账号留空密码即进入——免密登录）
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
 *   E3803 密码非空时长度不在 8–128（2026-10-31 起密码可空 = 未设密码，见 checkPassword）  （400）
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
  constructor(status, code, message, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
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
  /*
   * 密码**可空**（2026-10-31 用户拍板，参照电脑的本地账户）：空 = 未设密码，
   * 这种账号登不进 /api/login（远程登录天然被关），只作为本机身份参与署名/派活；
   * 要远程登录就在这里补一个 8–128 位的密码。非空时照旧校验长度。
   */
  const pwd = String(raw ?? '');
  if (pwd && (pwd.length < PASSWORD_MIN || pwd.length > PASSWORD_MAX)) {
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
  // hasPassword / hasTotp 给「我的」页用：免密账号的改密码弹窗不显示"当前密码"格，
  // 动态验证行据此显示 开启/关闭
  return { kind: 'user', user: { id: u.id, name: u.name, hasPassword: u.hasPassword, hasTotp: u.hasTotp }, role: roleBrief(u.roleId) };
}

/* ------------------------------------------------------------------ 主体 */

export async function handleUsers(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const touched =
    p === '/api/login' || p === '/api/login/otp' || p === '/api/logout' || p === '/api/me'
    || p === '/api/me/password' || p.startsWith('/api/me/otp') || p.startsWith('/api/users');
  if (!touched) return false;

  try {
    /* ------------------------------------------------ 登录（免令牌） */
    if (method === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      const name = String(body?.name ?? '').trim();
      const password = String(body?.password ?? '');
      // 密码可空（2026-10-31 用户拍板）：免密账号留空即进入，所以只强求用户名
      if (!name) throw new UserError(400, 'E3801', '请输入用户名');

      /*
       * 限速先判：**不看用户是否存在**（否则"429 只对存在的用户名出现"本身就是泄漏）。
       */
      if (tooMany(req, name)) {
        throw new UserError(429, 'E3806', `登录失败次数太多，请 ${Math.ceil(FAIL_WINDOW / 60_000)} 分钟后再试`);
      }

      const user = store.userByName(name);
      /*
       * scrypt **总是跑一次**（时间上不区分"用户不存在 / 未设密码 / 密码错"），然后三选一：
       *   · 未设密码的账号（hash=''）+ 密码留空 → 免密进入（电脑的本地账户同款，任何机器都行）；
       *   · 设了密码的 → 定长比对；
       *   · 免密账号输了密码 / 密码错 → 401，文案统一，不泄漏"这个账号没设密码"。
       */
      const pwOk = store.checkPassword(user, password);
      const blankOk = !!user && !user.hash && password === '';
      const ok = !!user && !user.disabled && (blankOk || pwOk);
      if (!ok) {
        noteFail(req, name);
        // 统一文案：不区分"用户不存在 / 密码错 / 被禁用 / 没设密码"（被禁用也不该告诉外人）
        throw new UserError(401, 'E3805', '用户名或密码不对');
      }
      /*
       * **两段式登录 · 第一段**（2026-10-31 二改，仿 yaojian-ruoyi）：
       * 密码对了、账号又开了动态验证 → **先不发会话**，发一张 5 分钟/5 次的一次性凭据，
       * 前端拿 otpToken 去 /api/login/otp 交动态码。密码与账号状态校验仍只在第一段做一遍。
       */
      if (store.isEnabled(user.id)) {
        clearFails(req, name);
        const otpToken = store.createChallenge(user.id);
        return sendJson(res, 200, { ok: true, needOtp: true, otpToken }), true;
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

    /* ------------------------------------------------ 两段式登录 · 第二段（免令牌） */
    if (method === 'POST' && p === '/api/login/otp') {
      /*
       * 提交动态码（6 位）或恢复码（8 位），通过才发正式会话。
       * 与参考项目同口径：凭据 5 分钟过期、最多试 5 次（超了就作废，重新登录）。
       */
      const body = await readBody(req);
      const ch = store.getChallenge(body?.otpToken);
      if (!ch) throw new UserError(401, 'E3823', '验证已过期或不存在，请重新登录');
      if (ch.tries >= store.CHALLENGE_MAX_ATTEMPTS) {
        store.dropChallenge(ch);
        throw new UserError(429, 'E3824', '验证码错误次数过多，请重新登录');
      }
      const user = store.getUser(ch.userId);
      if (!user || user.disabled) {
        store.dropChallenge(ch);
        throw new UserError(401, 'E3810', '账号状态异常，请重新登录');
      }
      if (!store.verify(user.id, body?.code)) {
        const tries = store.bumpChallengeTries(ch);
        // 最后一次机会用掉 = 当场作废，别让它还能再试
        if (tries >= store.CHALLENGE_MAX_ATTEMPTS) store.dropChallenge(ch);
        throw new UserError(401, 'E3820', '动态验证码或恢复码错误');
      }
      store.dropChallenge(ch);
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
      /*
       * **两张票一起清**（2026-10-31）：除了登录会话票，还要让浏览器丢掉访问令牌 Cookie ——
       * 否则一个填过令牌的浏览器永远被"令牌优先"放进面板，退出登录退了个寂寞，
       * 也永远走不到登录页（当天实报）。脚本用头带令牌，不受 Cookie 影响。
       */
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': [auth.clearedSessionCookie(), auth.clearedTokenCookie()],
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

    /* ------------------------------------------------ 动态验证（自助，2026-10-31 二改） */
    /*
     * 仿 yaojian-ruoyi 的绑定流，**四步分四个口**，别再合回"先落库再确认"：
     *   GET  /api/me/otp/status          → { enabled, bindTime, recoveryLeft }
     *   POST /api/me/otp/bind            → { secret, uri }（**不落库**）
     *   POST /api/me/otp/bind/confirm    → 动态码通过才落库，返回一次性恢复码
     *   POST /api/me/otp/unbind          → 需当前有效动态码或恢复码
     *
     * 全部只认**会话里**那个 userId（不从 body 拿 id）；操作员/节点/手机没有"自己的验证器"。
     */
    if (p.startsWith('/api/me/otp')) {
      const who = req.bandiAuth;
      if (who?.kind !== 'user') throw new UserError(401, 'E3810', '还没登录');
      const me = store.getUser(who.userId);
      if (!me) throw new UserError(401, 'E3810', '这个账号已经不在了，请重新登录');

      if (method === 'GET' && p === '/api/me/otp/status') {
        const otp = store.getOtp(me.id);
        return sendJson(res, 200, otp
          ? { enabled: true, bindTime: otp.bindTime ?? null, recoveryLeft: otp.recoveryLeft }
          : { enabled: false, bindTime: null, recoveryLeft: 0 }), true;
      }

      if (method === 'POST') {
        const body = await readBody(req);

        // 第一步：出密钥与 otpauth URI —— **不落库**（confirm 通过才生效，扫了没确认就什么都不留）
        if (p === '/api/me/otp/bind') {
          if (store.isEnabled(me.id)) throw new UserError(409, 'E3821', '已绑定动态验证，请先解绑');
          const secret = store.generateSecret();
          return sendJson(res, 200, { secret, uri: store.otpauthUri(secret, me.name) }), true;
        }

        // 第二步：动态码校验通过才落库，并**一次性**返回 10 个恢复码（库里只有哈希）
        if (p === '/api/me/otp/bind/confirm') {
          const secret = String(body?.secret ?? '').trim();
          if (!secret) throw new UserError(400, 'E3822', '缺少密钥，请重新发起绑定');
          if (store.isEnabled(me.id)) throw new UserError(409, 'E3821', '已绑定动态验证，请先解绑');
          if (!store.verifyTotp(secret, body?.code)) {
            throw new UserError(401, 'E3820', '动态验证码错误，请确认验证器时间与输入');
          }
          const recoveryCodes = store.saveBinding(me.id, secret);
          return sendJson(res, 200, {
            ok: true,
            recoveryCodes, // 仅此一次，前端必须让用户抄下来
            user: store.getUser(me.id),
          }), true;
        }

        // 解绑：要当前有效动态码或恢复码（手机丢了也不该被别人顺手关掉）
        if (p === '/api/me/otp/unbind') {
          if (!store.isEnabled(me.id)) throw new UserError(400, 'E3825', '当前未绑定动态验证');
          if (!store.verify(me.id, body?.code)) {
            throw new UserError(401, 'E3820', '动态验证码或恢复码错误');
          }
          store.removeBinding(me.id);
          return sendJson(res, 200, { ok: true, user: store.getUser(me.id) }), true;
        }
      }
      return fail(res, 404, 'E2036', '没有这个动态验证接口'), true;
    }

    /* ------------------------------------------------ 改自己的密码（2026-10-31「我的」页） */
    if (method === 'POST' && p === '/api/me/password') {
      /*
       * **自助改密码** —— 与 PATCH /api/users/:id 的区别：这里只认**会话里**那个 userId
       * （不从 body/path 拿 id，想改别人没有入口），且不需要管理员（mayManage）。
       * 操作员（令牌 / 回环）、节点、手机设备没有"自己的账号"，一律 401。
       */
      const who = req.bandiAuth;
      if (who?.kind !== 'user') throw new UserError(401, 'E3810', '还没登录');
      const cur = store.getUser(who.userId);
      if (!cur) throw new UserError(401, 'E3810', '这个账号已经不在了，请重新登录');
      const body = await readBody(req);
      // getUser 按 red line 不带 hash；验当前密码走归一名字查询（带 salt/hash），口径与登录一致
      const full = store.userByName(cur.name);
      const current = String(body?.current ?? '');
      // 免密账号没有"当前密码"可验 —— 只有设了密码的才要求先验旧的
      if (full?.hash && !store.checkPassword(full, current)) {
        throw new UserError(401, 'E3805', '当前密码不对');
      }
      const next = String(body?.password ?? '');
      if (next && (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX)) {
        throw new UserError(400, 'E3803', `密码长度要在 ${PASSWORD_MIN}–${PASSWORD_MAX} 之间`);
      }
      const user = store.setPassword(cur.id, next); // 空串 = 改回免密（store 的口径）
      /*
       * setPassword 会作废**全部**会话（改密码 = 别处登过的都下线，防锁死的口径不变）——
       * 但**这台浏览器**正在改密码，把人家也踢出去就是"改完密码自己进了登录页"。
       * 当场补一张新票随 Set-Cookie 带回去，别人的会话照旧全下线。
       */
      const { token } = store.createSession(cur.id);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': auth.sessionCookie(token),
      });
      res.end(JSON.stringify({ ok: true, user }));
      return true;
    }

    /* ------------------------------------------------ 以下全部要管理员 */
    /*
     * **首次引导直建**（2026-10-31 改）：一个账号都没有时，**登录页直接建第一个账号** ——
     * 公网服务器上"先拿令牌进来再到设置里建号"那套走不通（人不在那台机器旁边）。
     * 代价是"谁先到谁占管理员"，换来的是部署完浏览器直接就能进；建完这条路立刻关死。
     *
     * ⚠️ 判据只有一条：**库里还没有任何账号**。回环形态下 operator 恒真（免鉴权），
     * 光靠 `!mayManage` 关不住 —— 实测建完第一个账号后无凭据还能继续建（2026-10-31 自查发现）。
     */
    if (!(method === 'POST' && p === '/api/users' && !store.hasUsers()) && !auth.mayManage(req)) {
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
      /*
       * 建第一个账号 = **首次开机设置**（2026-10-31）：顺手给创建者发一张登录会话票
       * （Set-Cookie bandi_sid，写法与 /api/login 相同）。回环桌面那边鉴权本来就免，
       * 这张票真正起作用的地方是"同一台机器以后改听局域网"——
       * 浏览器切到非回环地址时它就是凭据，不用再登录一次。
       */
      if (first) {
        const { token } = store.createSession(user.id);
        res.writeHead(201, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': auth.sessionCookie(token),
        });
        res.end(JSON.stringify({ user, first }));
        return true;
      }
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
    if (err instanceof UserError) return fail(res, err.status, err.code, err.message, err.extra), true;
    throw err; // 其余交给 server.mjs 顶层 catch（E5004 那一层）
  }
}
