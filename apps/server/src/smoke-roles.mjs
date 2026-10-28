/**
 * 角色与菜单（2026-10-28 第二刀）的验收。
 *
 * 这一刀只做「数据 + 管理页 + 预览」：角色与它勾的菜单落库、内置角色有保护、
 * 现有界面一行不变。钉住的边界：
 *   ① 菜单目录由服务端给（每项 key/label/group 齐全）；
 *   ② 三个内置角色恒在（admin / operator / node-ops）；
 *   ③ 自建角色能建、能查；不认识的 key 与重名都要有明确错误码；
 *   ④ 改菜单**落库**：重启服务后还在（不是内存里的一张表）；
 *   ⑤ 内置保护：admin 不可改（E2070）、内置不可删（E2069）、自建可删；
 *   ⑥ 两边的 key 集合必须**完全一致**（menus.mjs 的目录 vs 前端 roles.mjs 的 MENU_KEYS）；
 *   ⑦ 不越权：非回环形态下这些口要令牌（沿用既有鉴权，没为它们开口子）。
 *
 * 隔离：临时数据目录 + 临时端口，跑完全删，不碰 data/。
 * 跑法：node apps/server/src/smoke-roles.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { sleep, stopRunning } from './lifecycle.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-roles-'));
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const TOKEN = 'smoke-roles-token';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

let child = null;
let log = '';
function start(extraEnv = {}) {
  log = '';
  child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BANDI_PORT: String(PORT),
      BANDI_DATA: tmp,
      BANDI_DB: path.join(tmp, 'bandi.db'),
      ...extraEnv,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
}

/** 起没起来：`/api/hello` 免令牌（非回环形态下也是它最省事） */
async function waitUp(ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/hello', { signal: AbortSignal.timeout(800) });
      if (r.status === 200) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

/** 带令牌与 `X-Bandi`（写请求的来源闸认这个头，见 http.mjs 的 guardWrite） */
const call = async (method, p, body, headers = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Bandi': '1',
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function stopAll() {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(500);
  try { stopRunning(PORT); } catch { /* 没在跑 */ }
  await sleep(300);
}

const cleanup = async () => {
  await stopAll();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
};

try {
  start();
  if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));

  /* ============ ① 菜单目录 ============ */
  console.log('① GET /api/menus —— 菜单目录由服务端给');
  const menus = await call('GET', '/api/menus');
  const catalog = Array.isArray(menus.body?.menus) ? menus.body.menus : [];
  check('200 且目录非空', menus.status === 200 && catalog.length > 0, `${menus.status} · ${catalog.length} 项`);
  check('每项都有 key / label / group',
    catalog.every((m) => typeof m.key === 'string' && m.key && typeof m.label === 'string' && m.label && typeof m.group === 'string' && m.group),
    JSON.stringify(catalog.find((m) => !m.key || !m.label || !m.group) ?? ''));
  check('两组都在（面板 / 节点配置）', new Set(catalog.map((m) => m.group)).size === 2,
    [...new Set(catalog.map((m) => m.group))].join('、'));

  /* ============ ② 三个内置角色 ============ */
  console.log('\n② GET /api/roles —— 三个内置角色恒在');
  const roles0 = await call('GET', '/api/roles');
  const list0 = Array.isArray(roles0.body?.roles) ? roles0.body.roles : [];
  const byId = (id) => list0.find((r) => r.id === id);
  check('200', roles0.status === 200, String(roles0.status));
  check('admin / operator / node-ops 都在且 builtin=1',
    ['admin', 'operator', 'node-ops'].every((id) => byId(id)?.builtin === true),
    list0.map((r) => `${r.id}:${r.builtin ? '内置' : '自建'}`).join(' '));
  check('admin 的菜单 = 目录全集（不落库，恒等于全部 key）',
    JSON.stringify(byId('admin')?.menuKeys) === JSON.stringify(catalog.map((m) => m.key)),
    `${byId('admin')?.menuKeys?.length} vs ${catalog.length}`);
  check('operator 预置面板五项', (byId('operator')?.menuKeys ?? []).length === 5, (byId('operator')?.menuKeys ?? []).join(','));
  check('node-ops 预置节点配置六项', (byId('node-ops')?.menuKeys ?? []).length === 6, (byId('node-ops')?.menuKeys ?? []).join(','));

  /* ============ ③ 建自建角色 + 校验 ============ */
  console.log('\n③ POST /api/roles —— 建一个「只读」');
  const made = await call('POST', '/api/roles', { name: '只读', menuKeys: ['messages', 'contacts'] });
  check('201 且回了角色行', made.status === 201 && !!made.body?.role?.id, `${made.status} ${made.body?.role?.id ?? ''}`);
  check('builtin=0', made.body?.role?.builtin === false, String(made.body?.role?.builtin));
  const customId = made.body?.role?.id ?? '';
  const afterCreate = (await call('GET', '/api/roles')).body?.roles ?? [];
  check('GET 能看到它，且 menuKeys 对得上',
    JSON.stringify(afterCreate.find((r) => r.id === customId)?.menuKeys) === JSON.stringify(['messages', 'contacts']),
    JSON.stringify(afterCreate.find((r) => r.id === customId)?.menuKeys));

  const badKey = await call('POST', '/api/roles', { name: '瞎勾', menuKeys: ['messages', 'node.xxx'] });
  check('不认识的 key → 400 E1114，且文案带那个 key',
    badKey.status === 400 && badKey.body?.code === 'E1114' && String(badKey.body?.error ?? '').includes('node.xxx'),
    `${badKey.status} ${badKey.body?.code ?? ''} ${badKey.body?.error ?? ''}`);
  const notArray = await call('POST', '/api/roles', { name: '不是数组', menuKeys: 'messages' });
  check('menuKeys 不是数组 → 400 E1116', notArray.status === 400 && notArray.body?.code === 'E1116',
    `${notArray.status} ${notArray.body?.code ?? ''}`);
  const emptyName = await call('POST', '/api/roles', { name: '   ', menuKeys: [] });
  check('空名字 → 400 E1113', emptyName.status === 400 && emptyName.body?.code === 'E1113',
    `${emptyName.status} ${emptyName.body?.code ?? ''}`);
  const dup = await call('POST', '/api/roles', { name: '只读', menuKeys: [] });
  check('重名 → 409 E1115', dup.status === 409 && dup.body?.code === 'E1115', `${dup.status} ${dup.body?.code ?? ''}`);
  const emptyOk = await call('POST', '/api/roles', { name: '空菜单', menuKeys: [] });
  check('空数组合法（= 什么都看不到）', emptyOk.status === 201 && (emptyOk.body?.role?.menuKeys ?? null)?.length === 0,
    `${emptyOk.status}`);

  /* ============ ④ 改菜单要落库 ============ */
  console.log('\n④ PATCH 改菜单 → 重启 → 还在（落库，不是内存）');
  const patched = await call('PATCH', `/api/roles/${encodeURIComponent(customId)}`, { menuKeys: ['messages', 'contacts', 'experts'] });
  check('PATCH → 200 且回新的三项目录', patched.status === 200 &&
    JSON.stringify(patched.body?.role?.menuKeys) === JSON.stringify(['messages', 'contacts', 'experts']),
    `${patched.status} ${JSON.stringify(patched.body?.role?.menuKeys)}`);
  await stopAll();
  start();
  if (!(await waitUp())) throw new Error('重启后实例没起来：' + log.slice(-500));
  const afterRestart = (await call('GET', '/api/roles')).body?.roles ?? [];
  check('重启后改动还在', JSON.stringify(afterRestart.find((r) => r.id === customId)?.menuKeys) ===
    JSON.stringify(['messages', 'contacts', 'experts']),
    JSON.stringify(afterRestart.find((r) => r.id === customId)?.menuKeys));
  check('重启没有把内置角色的菜单刷回出厂值（seed 幂等）',
    JSON.stringify(afterRestart.find((r) => r.id === 'operator')?.menuKeys) ===
      JSON.stringify(['messages', 'contacts', 'experts', 'workbench', 'settings']),
    JSON.stringify(afterRestart.find((r) => r.id === 'operator')?.menuKeys));

  /* ============ ⑤ 内置保护 ============ */
  console.log('\n⑤ 内置保护');
  const patchAdmin = await call('PATCH', '/api/roles/admin', { name: '老大' });
  check('PATCH admin → 403 E2070', patchAdmin.status === 403 && patchAdmin.body?.code === 'E2070',
    `${patchAdmin.status} ${patchAdmin.body?.code ?? ''}`);
  const patchAdminMenus = await call('PATCH', '/api/roles/admin', { menuKeys: ['messages'] });
  check('PATCH admin 的菜单 → 403 E2070', patchAdminMenus.status === 403 && patchAdminMenus.body?.code === 'E2070',
    `${patchAdminMenus.status} ${patchAdminMenus.body?.code ?? ''}`);
  const delAdmin = await call('DELETE', '/api/roles/admin');
  check('DELETE admin → 403 E2069', delAdmin.status === 403 && delAdmin.body?.code === 'E2069',
    `${delAdmin.status} ${delAdmin.body?.code ?? ''}`);
  const delBuiltin = await call('DELETE', '/api/roles/node-ops');
  check('DELETE 其它内置 → 403 E2069', delBuiltin.status === 403 && delBuiltin.body?.code === 'E2069',
    `${delBuiltin.status} ${delBuiltin.body?.code ?? ''}`);
  const renameBuiltin = await call('PATCH', '/api/roles/operator', { name: '值班员' });
  check('内置（非 admin）可以改名', renameBuiltin.status === 200 && renameBuiltin.body?.role?.name === '值班员',
    `${renameBuiltin.status} ${renameBuiltin.body?.role?.name ?? ''}`);
  const delCustom = await call('DELETE', `/api/roles/${encodeURIComponent(customId)}`);
  check('DELETE 自建 → 200', delCustom.status === 200 && delCustom.body?.ok === true, String(delCustom.status));
  const gone = ((await call('GET', '/api/roles')).body?.roles ?? []).some((r) => r.id === customId);
  check('删完就查不到了', gone === false);
  const delMissing = await call('DELETE', '/api/roles/role-nope');
  check('删不存在的 → 404 E2068', delMissing.status === 404 && delMissing.body?.code === 'E2068',
    `${delMissing.status} ${delMissing.body?.code ?? ''}`);

  /* ============ ⑥ 两边 key 集合必须一致 ============ */
  console.log('\n⑥ 静态对比：menus.mjs 的目录 === 前端 roles.mjs 的 MENU_KEYS');
  const menuSrc = fs.readFileSync(path.join(repoRoot, 'apps', 'server', 'src', 'menus.mjs'), 'utf8');
  const roleSrc = fs.readFileSync(path.join(repoRoot, 'apps', 'web', 'js', 'roles.mjs'), 'utf8');
  const serverKeys = [...menuSrc.matchAll(/\{\s*key:\s*'([^']+)'/g)].map((m) => m[1]);
  const block = (() => {
    const b = roleSrc.indexOf('export const MENU_KEYS');
    const e = roleSrc.indexOf('});', b);
    return b >= 0 && e > b ? roleSrc.slice(b, e) : '';
  })();
  const webKeys = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
  const onlyServer = serverKeys.filter((k) => !webKeys.includes(k));
  const onlyWeb = webKeys.filter((k) => !serverKeys.includes(k));
  check(`服务端 ${serverKeys.length} 个 key / 前端 ${webKeys.length} 个`, serverKeys.length > 0 && webKeys.length > 0);
  check('没有"只在服务端"的 key', onlyServer.length === 0, onlyServer.join(','));
  check('没有"只在前端"的 key', onlyWeb.length === 0, onlyWeb.join(','));

  /* ============ ⑦ 不越权 ============ */
  /*
   * 非回环形态（`BANDI_HOST=0.0.0.0`）= 服务端自己会开令牌闸（auth.setup 看监听地址）。
   * 这里不新开任何口子：**没令牌 401、带对令牌 200**，说明这五个口只是普通受保护接口。
   */
  console.log('\n⑦ 非回环形态：这些口要令牌（沿用既有鉴权）');
  await stopAll();
  start({ BANDI_HOST: '0.0.0.0', BANDI_TOKEN: TOKEN });
  if (!(await waitUp())) throw new Error('非回环实例没起来：' + log.slice(-500));
  const noToken = await fetch(BASE + '/api/roles', { signal: AbortSignal.timeout(5000) });
  check('不带令牌 GET /api/roles → 401', noToken.status === 401, String(noToken.status));
  await noToken.text();
  const wrong = await fetch(BASE + '/api/roles', {
    headers: { 'X-Bandi-Token': 'not-the-token' },
    signal: AbortSignal.timeout(5000),
  });
  check('错令牌 → 401', wrong.status === 401, String(wrong.status));
  await wrong.text();
  const withToken = await fetch(BASE + '/api/roles', {
    headers: { 'X-Bandi-Token': TOKEN },
    signal: AbortSignal.timeout(5000),
  });
  const withTokenBody = await withToken.json().catch(() => null);
  check('对令牌 → 200 且拿到角色表', withToken.status === 200 && Array.isArray(withTokenBody?.roles), String(withToken.status));
  const postNoToken = await fetch(BASE + '/api/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bandi': '1' },
    body: JSON.stringify({ name: '偷建', menuKeys: [] }),
    signal: AbortSignal.timeout(5000),
  });
  check('不带令牌 POST /api/roles → 401（写侧也没漏）', postNoToken.status === 401, String(postNoToken.status));
  await postNoToken.text();
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  await cleanup();
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
