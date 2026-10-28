/**
 * 运行期切「允许局域网加入」后，局域网来源的写请求必须能过来源闸
 * （2026-11 修的"手机扫码卡正在配对"的回归）。
 *
 * 背景：`allowedOrigins` 曾把局域网地址在**模块导入时**算一次、冻结进 `extraOrigins`。
 * 而开关是运行期生效的（`POST /api/lan` 写 netmode.json + `/api/restart` 原地重听，
 * 不重载模块）—— 用户切完开关，监听已是 0.0.0.0、页面打得开，Origin 白名单还是空的，
 * 局域网写请求全 403 E3001。钉住的边界：
 *   ① 开关关着（启动时 netmode.json allowLan:false）：本机局域网 IP 作 Origin 的写请求
 *      → 403 E3001（外来源照样拦，安全没放宽）；
 *   ② 运行期切开关 + 原地重启：**同样**的 Origin → 不再是 403 E3001
 *      （claim 带瞎码应走到业务层 400 E1702 —— 码格式对但不存在；E1701 是"格式不对"）；
 *   ③ 开了之后陌生来源仍然 403 E3001；不带 Origin 的脚本调用不受影响。
 *
 * 本机拿不到局域网 IPv4（无网卡 / 全 internal）时 skip（打印说明、算通过）。
 * 隔离：临时数据目录 + 8799 端口，跑完全删。
 * 跑法：node apps/server/src/smoke-lan-origin.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { stopRunning, sleep } from './lifecycle.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-lan-origin-'));
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/** 本机第一个非 internal 的 IPv4（就是手机在地址栏里用的那个 IP）；拿不到返回 null */
const lanIp = (() => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
})();

let child = null;
let log = '';
function start() {
  child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BANDI_PORT: String(PORT),
      BANDI_DATA: tmp,
      BANDI_DB: path.join(tmp, 'bandi.db'),
      // 不设 BANDI_HOST —— 监听地址跟着 netmode.json 走，这正是被测的行为
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
}

/** 起没起来：GET /api/state 200（免鉴权）或 401（要令牌）都算 */
async function waitUp(ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) });
      if (r.status === 200 || r.status === 401) return true;
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

/**
 * 原地重启不是瞬时完成的：`POST /api/restart` 回响应后 80ms 才重听。
 * 不用固定 sleep —— 轮询等"重启真发生了"的信号：重启后监听非回环 → 鉴权开
 * → /api/state 从 200 变 401。等到它（或超时）为止。
 */
async function waitRestarted(ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(800) });
      if (r.status === 401) return true; // 鉴权开了 = 重启后的形态
    } catch { /* 正在重听，继续等 */ }
    await sleep(150);
  }
  return false;
}

/**
 * 用真实浏览器形态发一次 claim：带 Origin + X-Bandi（pair-claim.mjs 就是这么发的）。
 * 瞎码 `bp_zzz…`：过了闸也只会 400 E1702（格式对但不存在的码），不会真配对成功。
 * （E1701 是"格式不对" —— `bp_` 前缀就是合法格式，见 pair 路由的校验顺序。）
 */
const BIZ_CODE = 'E1702';
async function claimFrom(origin) {
  const r = await fetch(BASE + '/api/pair/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bandi': '1',
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ token: 'bp_zzzzzzzzzzzz', name: '回归测试手机' }),
    signal: AbortSignal.timeout(3000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 不关本用例的事 */ }
  return { status: r.status, code: json?.code ?? '', error: json?.error ?? '' };
}

const cleanup = async () => {
  try { child?.kill(); } catch { /* 已退 */ }
  await sleep(400);
  try { stopRunning(PORT); } catch { /* 没在跑 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
};

try {
  if (!lanIp) {
    console.log('ⓘ 本机没有非 internal 的 IPv4 网卡（容器 / 无局域网环境），这个用例没有意义 —— skip。');
  } else {
    const lanOrigin = `http://${lanIp}:${PORT}`;
    console.log(`ⓘ 本机局域网 IP：${lanIp}（Origin 用 ${lanOrigin}）`);

    /* ---------------- ① 开关关着：局域网来源照样被来源闸拦（安全基线） */
    console.log('① allowLan:false 启动 —— 局域网来源的写请求必须被拦');
    fs.writeFileSync(path.join(tmp, 'netmode.json'), JSON.stringify({ allowLan: false }), 'utf8');
    start();
    if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));
    check('服务起在回环（listen 127.0.0.1）', !/监听 0\.0\.0\.0/.test(log));

    const blocked = await claimFrom(lanOrigin);
    check('局域网 IP 作 Origin 的 claim → 403 E3001（没开开关就该拦）',
      blocked.status === 403 && blocked.code === 'E3001', `${blocked.status} ${blocked.code} ${blocked.error}`);

    const scriptLike = await claimFrom(null);
    check('不带 Origin 的脚本调用不受影响 → 400 E1702（走到业务层）',
      scriptLike.status === 400 && scriptLike.code === BIZ_CODE, `${scriptLike.status} ${scriptLike.code}`);

    /* ---------------- ② 运行期切开关 + 原地重启：同样的 Origin 不再被拦 */
    console.log('\n② 运行期切总机（/api/lan + /api/restart，不重开进程）—— 局域网来源要放行');
    const setLan = await fetch(BASE + '/api/lan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowLan: true }),
      signal: AbortSignal.timeout(3000),
    });
    check('POST /api/lan {allowLan:true} → 200', setLan.status === 200, String(setLan.status));

    const doRestart = await fetch(BASE + '/api/restart', { method: 'POST', signal: AbortSignal.timeout(3000) });
    check('POST /api/restart → 200', doRestart.status === 200, String(doRestart.status));
    const restarted = await waitRestarted();
    check('重启真的发生了（鉴权开了 = /api/state 变 401）', restarted, restarted ? '' : '10 秒内没等到');

    const allowed = await claimFrom(lanOrigin);
    check('切开关后**同样**的局域网 Origin → 不再 403 E3001（400 E1702 = 到了业务层）',
      !(allowed.status === 403 && allowed.code === 'E3001') && allowed.status === 400 && allowed.code === BIZ_CODE,
      `${allowed.status} ${allowed.code} ${allowed.error}`);

    const evil = await claimFrom('http://evil.example.com');
    check('开了开关后陌生来源仍然 403 E3001（安全没放宽）',
      evil.status === 403 && evil.code === 'E3001', `${evil.status} ${evil.code}`);

    const local = await claimFrom(`http://127.0.0.1:${PORT}`);
    check('本机源照常放行 → 400 E1702', local.status === 400 && local.code === BIZ_CODE,
      `${local.status} ${local.code}`);

    /* ---------------- ③ 落地页静态依赖：手机此刻还没令牌也要能加载 */
    /*
     * 2026-10-28 修「扫码卡在正在配对」：`/pair` 本身免令牌，但它引的
     * `/js/pair-claim.mjs` 当时走的是非 /api GET —— guard 把它当"没令牌的页面"回了
     * **登录页 HTML**（Content-Type: text/html），浏览器按 module 执行失败，页面永远
     * 停在静态那屏「正在配对…」。这几条把那次的根因钉住。
     */
    console.log('\n③ 配对落地页静态依赖（手机还没有令牌）');
    const page = await fetch(BASE + '/pair?token=bp_x', { signal: AbortSignal.timeout(3000) });
    const pageType = page.headers.get('content-type') ?? '';
    await page.text();
    check('GET /pair → 200 HTML（落地页免令牌）', page.status === 200 && /text\/html/.test(pageType), `${page.status} ${pageType}`);
    const mod = await fetch(BASE + '/js/pair-claim.mjs', { signal: AbortSignal.timeout(3000) });
    const modType = mod.headers.get('content-type') ?? '';
    await mod.text();
    check('GET /js/pair-claim.mjs → 200 + JS（不是登录页 HTML，否则模块执行失败卡在「正在配对」）',
      mod.status === 200 && /javascript/.test(modType), `${mod.status} ${modType}`);
    const ico = await fetch(BASE + '/icons/icon-192.png', { signal: AbortSignal.timeout(3000) });
    check('GET /icons/icon-192.png → 200', ico.status === 200, String(ico.status));
    const apiStill = await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(3000) });
    check('对照：/api/state 仍然 401（数据面没顺手放开）', apiStill.status === 401, String(apiStill.status));
  }
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  await cleanup();
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
