/**
 * 局域网来源的写请求必须能过来源闸（2026-11 那个"局域网写请求全 403"的回归）。
 *
 * 背景：`allowedOrigins` 曾把局域网地址在**模块导入时**算一次、冻结进 `extraOrigins`。
 * 用户把服务开到对外监听后，页面打得开，Origin 白名单还是空的，局域网写请求全 403 E3001。
 * 2026-11-03 起"对外服务"这一维整个删除：监听**缺省对外**（缺省 0.0.0.0，`BANDI_HOST`
 * 可钉回环调试），本机局域网地址由 `config.lanOrigins()` **恒**现算放行 —— 不再有
 * "开开关才放行"的运行期切换，也没有 `/api/restart` 了。钉住的边界：
 *   ① 回环调试形态（`BANDI_HOST=127.0.0.1` 显式钉，免鉴权）：本机局域网 IP 作 Origin
 *      的写请求 → 放行到业务层，**不再 403 E3001**；
 *   ② 缺省形态（不设 `BANDI_HOST` → 0.0.0.0）：鉴权自动开，局域网 Origin 照样放行，
 *      陌生来源仍然 403 E3001（安全没放宽）；
 *   ③ 静态资源（图标）不受数据面闸影响；配对落地页 `/pair` 已随设备令牌体系退场 → 404。
 *
 * 写请求的靶子用 `POST /api/logout`（public、无会话就是空撤一回，零状态零副作用）——
 * 原来的靶子是 `/api/nodes/join`，那条端点 2026-11-09 随多机节点子系统删了；
 * 再往前是 `/api/pair/claim`，2026-11-07 随配对体系删了。
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
 * 用真实浏览器形态发一次写请求：带 Origin + X-Bandi。
 * 靶子是 `POST /api/logout` —— public、没票就是空撤一回，不会留下任何状态。
 * 断言只看"有没有被来源闸拦成 E3001"：被拦 = 失败，别的 4xx/2xx = 到了业务层 = 通过。
 */
async function writeFrom(origin) {
  const r = await fetch(BASE + '/api/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bandi': '1',
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(3000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 不关本用例的事 */ }
  return { status: r.status, code: json?.code ?? '', error: json?.error ?? '' };
}

/** 过了来源闸：不是 403 E3001（业务层的 4xx 都算过） */
const passedOriginGate = (r) => !(r.status === 403 && r.code === 'E3001');

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

    const allowedLoop = await writeFrom(lanOrigin);
    check('本机局域网 IP 作 Origin 的写请求 → 走到业务层（不再 403 E3001）',
      passedOriginGate(allowedLoop), `${allowedLoop.status} ${allowedLoop.code} ${allowedLoop.error}`);

    const evilLoop = await writeFrom('http://evil.example.com');
    check('陌生来源仍然 403 E3001（安全没放宽）',
      evilLoop.status === 403 && evilLoop.code === 'E3001', `${evilLoop.status} ${evilLoop.code}`);

    const scriptLike = await writeFrom(null);
    check('不带 Origin 的脚本调用不受影响 → 走到业务层',
      passedOriginGate(scriptLike), `${scriptLike.status} ${scriptLike.code}`);

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

    const allowed = await writeFrom(lanOrigin);
    check('同样的局域网 Origin → 不 403 E3001（到了业务层）',
      passedOriginGate(allowed), `${allowed.status} ${allowed.code} ${allowed.error}`);

    const evil = await writeFrom('http://evil.example.com');
    check('陌生来源仍然 403 E3001（安全没放宽）',
      evil.status === 403 && evil.code === 'E3001', `${evil.status} ${evil.code}`);

    const local = await writeFrom(`http://127.0.0.1:${PORT}`);
    check('本机源照常放行 → 到了业务层', passedOriginGate(local), `${local.status} ${local.code}`);

    /* ---------------- ③ 静态资源与已退场的配对页 */
    console.log('\n③ 静态资源放行、配对页已退场');
    const ico = await fetch(BASE + '/icons/icon-192.png', { signal: AbortSignal.timeout(3000) });
    check('GET /icons/icon-192.png → 200', ico.status === 200, String(ico.status));
    const gone = await fetch(BASE + '/pair', { signal: AbortSignal.timeout(3000) });
    /* 没有令牌时闸先说话（401），带令牌进来才是 404 —— 两种都证明"这页没了" */
    check('GET /pair 不再是配对页（401 闸 / 404 无此文件）', gone.status === 401 || gone.status === 404, String(gone.status));
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
