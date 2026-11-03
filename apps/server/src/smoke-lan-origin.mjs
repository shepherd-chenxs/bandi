/**
 * 局域网来源的写请求必须能过来源闸（2026-11 修的"手机扫码卡正在配对"的回归）。
 *
 * 背景：`allowedOrigins` 曾把局域网地址在**模块导入时**算一次、冻结进 `extraOrigins`。
 * 用户把服务开到对外监听后，页面打得开，Origin 白名单还是空的，局域网写请求全 403 E3001。
 * 2026-11-03 起"对外服务"这一维整个删除：监听**缺省对外**（缺省 0.0.0.0，`BANDI_HOST`
 * 可钉回环调试），本机局域网地址由 `config.lanOrigins()` **恒**现算放行 —— 不再有
 * "开开关才放行"的运行期切换，也没有 `/api/restart` 了。钉住的边界：
 *   ① 回环调试形态（`BANDI_HOST=127.0.0.1` 显式钉，免鉴权）：本机局域网 IP 作 Origin
 *      的写请求 → 放行到业务层（400 E1702，瞎码走到格式校验之后那步），**不再 403 E3001**；
 *   ② 缺省形态（不设 `BANDI_HOST` → 0.0.0.0）：鉴权自动开；免令牌的 claim 照样
 *      放局域网 Origin（E1702 = 到了业务层）、陌生来源仍然 403 E3001（安全没放宽）；
 *   ③ 配对落地页静态依赖：手机此刻还没令牌也要能加载。
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
const TOKEN_FILE = path.join(tmp, 'token');

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
function start(extra = {}) {
  /*
   * ⚠️ **剥掉继承来的 BANDI_HOST**（2026-11-03）：run-smokes 给所有子进程钉
   * `BANDI_HOST=127.0.0.1` 当免鉴权底座，而 ①② 的监听形态都是**本用例的被测项**
   * （① 显式回环调试、② 缺省 0.0.0.0）—— 不剥的话 ② 永远测不到缺省。
   */
  const { BANDI_HOST: _inheritedHost, ...baseEnv } = process.env;
  child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: {
      ...baseEnv,
      BANDI_PORT: String(PORT),
      BANDI_DATA: tmp,
      BANDI_DB: path.join(tmp, 'bandi.db'),
      ...extra,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  log = '';
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

    /* ---------------- ① 回环调试形态：局域网 Origin 也放行（白名单恒算，安全不靠它） */
    console.log('① BANDI_HOST=127.0.0.1（调试形态，免鉴权）—— 局域网 Origin 不再被来源闸拦');
    start({ BANDI_HOST: '127.0.0.1' });
    if (!(await waitUp())) throw new Error('实例没起来：' + log.slice(-500));
    check('服务起在回环（免鉴权的调试形态）', /免鉴权/.test(log), (log.match(/只监听回环.*/) ?? ['(没有)'])[0]);

    const allowedLoop = await claimFrom(lanOrigin);
    check('本机局域网 IP 作 Origin 的 claim → 400 E1702（走到业务层，不再 403 E3001）',
      allowedLoop.status === 400 && allowedLoop.code === BIZ_CODE, `${allowedLoop.status} ${allowedLoop.code} ${allowedLoop.error}`);

    const evilLoop = await claimFrom('http://evil.example.com');
    check('陌生来源仍然 403 E3001（安全没放宽）',
      evilLoop.status === 403 && evilLoop.code === 'E3001', `${evilLoop.status} ${evilLoop.code}`);

    const scriptLike = await claimFrom(null);
    check('不带 Origin 的脚本调用不受影响 → 400 E1702（走到业务层）',
      scriptLike.status === 400 && scriptLike.code === BIZ_CODE, `${scriptLike.status} ${scriptLike.code}`);

    /* ---------------- ② 缺省形态：0.0.0.0 + 鉴权自动开，局域网 Origin 照样放行 */
    console.log('\n② 缺省启动（不设 BANDI_HOST = 0.0.0.0）—— 鉴权自动开，局域网 Origin 要放行');
    try { child?.kill(); } catch { /* 已退 */ }
    await sleep(400);
    try { stopRunning(PORT); } catch { /* 没在跑 */ }
    start({}); // **不**给 BANDI_HOST —— 缺省就该对外听
    if (!(await waitUp())) throw new Error('第二台没起来：' + log.slice(-500));
    check('缺省就对外听 → 鉴权自动开（/api/state 401）', (await fetch(BASE + '/api/state', { signal: AbortSignal.timeout(3000) })).status === 401, '');
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    check('带上令牌照旧能读', (await fetch(BASE + '/api/state', { headers: { 'X-Bandi-Token': token }, signal: AbortSignal.timeout(3000) })).status === 200);

    const allowed = await claimFrom(lanOrigin);
    check('同样的局域网 Origin → 不 403 E3001（400 E1702 = 到了业务层）',
      allowed.status === 400 && allowed.code === BIZ_CODE, `${allowed.status} ${allowed.code} ${allowed.error}`);

    const evil = await claimFrom('http://evil.example.com');
    check('陌生来源仍然 403 E3001（安全没放宽）',
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
