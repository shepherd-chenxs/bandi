/*
 * routes/roles.mjs —— 角色与菜单的管理口（2026-10-28 第二刀）。
 *
 * 五个口，全部**先过 `auth.mayManage`**（只有操作员能管角色与菜单）：
 *   GET    /api/menus        → { menus: MENU_CATALOG }   菜单目录（字典，给勾选界面用）
 *   GET    /api/roles        → { roles: [...] }          角色 + 它勾了哪些 key
 *   POST   /api/roles        → 201 自建角色
 *   PATCH  /api/roles/:id    → 200 改名字 / 改菜单（任选）
 *   DELETE /api/roles/:id    → 200 删自建角色
 *
 * **本刀只做数据与管理页**：不下发、不接登录、不改任何现有渲染 —— 配置先存着，
 * 第三刀接入登录后才会真的影响界面（页面上那句说明必须留着）。
 *
 * 本文件用掉的错误码（§五 领的号段，全仓此前都没占用）：
 *   E1113 角色名不能为空 / 超过 30 字        （400）
 *   E1114 菜单项不认识                       （400）
 *   E1115 角色名重复                         （409）
 *   E1116 menuKeys 不是数组 / 显式传了 null   （400）
 *   E1117 PATCH 里没有任何可改字段            （400）
 *   E1118 这个路径不支持该请求方法            （405）
 *   E2068 角色不存在                         （404）
 *   E2069 内置角色不能删                     （403）
 *   E2070 内置「管理员」不可改               （403）
 *   E3703 不是操作员                         （403）
 *
 * ⚠️ 一个码只表达一件事（仓库口径）：上面 E1116 / E1117 / E1118 原本挤在一起过，
 * 分开之后前端和文档才能靠码判断，不用解析文案。
 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as auth from '../auth.mjs';
import * as store from '../store.mjs';
import { MENU_CATALOG, isMenuKey, sortMenuKeys } from '../menus.mjs';

/** 本模块的失败一律抛它，handler 里一处翻成 `fail(res, status, code, 中文)` */
class RoleError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const NAME_MAX = 30;

/** 名字：去空白、非空、≤30 字（按**字符**数，别用 length —— 中文按 UTF-16 也算一个） */
function normName(input) {
  const name = String(input ?? '').trim();
  if (!name) throw new RoleError(400, 'E1113', '角色名不能为空');
  if ([...name].length > NAME_MAX) throw new RoleError(400, 'E1113', `角色名最多 ${NAME_MAX} 个字，这个有 ${[...name].length} 个`);
  return name;
}

/**
 * 菜单 key 数组：必须是数组、每项都在目录里、去重后**按目录顺序**落库。
 * 有一个不认识就整份拒绝并**把那个 key 写进文案**（静默丢掉 = 用户以为勾上了）。
 * 空数组合法（= 这个角色什么都看不到）。
 */
function normMenuKeys(input) {
  if (input === undefined) return null; // 调用方判"没传"
  // 显式 null 不等于"没传"：它在 PATCH 里会被读成"清空全部菜单"，那是另一个意思，必须拒绝
  if (input === null) throw new RoleError(400, 'E1116', 'menuKeys 必须是数组（清空就传 []）');
  if (!Array.isArray(input)) throw new RoleError(400, 'E1116', 'menuKeys 必须是数组（比如 ["messages","contacts"]）');
  const out = [];
  for (const raw of input) {
    const key = String(raw ?? '').trim();
    if (!isMenuKey(key)) throw new RoleError(400, 'E1114', `菜单项不认识：${key || '(空)'}`);
    if (!out.includes(key)) out.push(key);
  }
  return sortMenuKeys(out);
}

const ADMIN_ID = 'admin';

export async function handleRoles(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  if (!p.startsWith('/api/menus') && !p.startsWith('/api/roles')) return false;

  // 五个口同一道闸：非操作员（手机设备令牌、节点令牌）一律进不来
  if (!auth.mayManage(req)) return fail(res, 403, 'E3703', '只有操作员能管角色与菜单'), true;

  try {
    if (method === 'GET' && p === '/api/menus') {
      return sendJson(res, 200, { menus: MENU_CATALOG }), true;
    }

    if (method === 'GET' && p === '/api/roles') {
      return sendJson(res, 200, { roles: store.listRoles() }), true;
    }

    if (method === 'POST' && p === '/api/roles') {
      const body = await readBody(req);
      const name = normName(body?.name);
      const menuKeys = normMenuKeys(body?.menuKeys ?? []);
      if (store.roleNameTaken(name)) throw new RoleError(409, 'E1115', `已经有一个叫「${name}」的角色了，换个名字`);
      const role = store.createRole({ name, menuKeys });
      console.log(`[角色] 新建「${name}」（${role.id}）· ${role.menuKeys.length} 个菜单`);
      return sendJson(res, 201, { role }), true;
    }

    const one = /^\/api\/roles\/([^/]+)$/.exec(p);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const cur = store.getRole(id);

      if (method === 'PATCH') {
        const body = await readBody(req);
        // 内置「管理员」：名字和菜单都不给改（防锁死 —— 它恒等于目录全集）
        if (id === ADMIN_ID) throw new RoleError(403, 'E2070', '内置「管理员」不可修改（它的菜单恒等于全部菜单）');
        if (!cur) throw new RoleError(404, 'E2068', `没有这个角色：${id}`);
        const next = {};
        if (body?.name !== undefined) {
          const name = normName(body.name);
          if (store.roleNameTaken(name, id)) throw new RoleError(409, 'E1115', `已经有一个叫「${name}」的角色了，换个名字`);
          next.name = name;
        }
        if (body?.menuKeys !== undefined) next.menuKeys = normMenuKeys(body.menuKeys);
        if (!Object.keys(next).length) throw new RoleError(400, 'E1117', 'PATCH 里既没有 name 也没有 menuKeys，没什么可改的');
        const role = store.updateRole(id, next);
        return sendJson(res, 200, { role }), true;
      }

      if (method === 'DELETE') {
        const out = store.deleteRole(id);
        if (out.ok) {
          console.log(`[角色] 删除 ${id}`);
          return sendJson(res, 200, { ok: true, id }), true;
        }
        if (out.reason === 'builtin') throw new RoleError(403, 'E2069', `「${cur?.name ?? id}」是内置角色，不能删（可以改它的菜单）`);
        throw new RoleError(404, 'E2068', `没有这个角色：${id}`);
      }

      return fail(res, 405, 'E1118', `角色接口不支持 ${method}`), true;
    }

    return fail(res, 404, 'E2068', `没有这个角色接口：${p}`), true;
  } catch (err) {
    if (err instanceof RoleError) return fail(res, err.status, err.code, err.message), true;
    throw err; // 其余交给 server.mjs 顶层 catch（E5004 那一层）
  }
}
