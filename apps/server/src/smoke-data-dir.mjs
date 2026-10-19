/**
 * 数据落点与远程访问的验收（2026-10-15 起；2026-10-18 加默认目录回归）。
 *
 * 验五件事：
 *   ⓪ **不设 `BANDI_DATA` 时默认落本机用户目录** —— 命令行与桌面壳同一个默认，不再有"两套库"；
 *   ① `BANDI_DATA` 真的被认 —— 库和其它运行时数据落在指的那个目录，不碰 `<仓库>/data`；
 *   ② `BANDI_HOST` 能放开监听，而且**本机地址照样连得上**；
 *   ③ `BANDI_ORIGINS` 一配，远端浏览器来的写请求才不是 403 ——
 *      不配的话页面能看、一动手就全被拒（改前 `allowedOrigins` 写死成 127.0.0.1/localhost）；
 *   ④ 陌生来源、缺 X-Bandi 头照样挡掉；非本机监听会打「还没鉴权」的警告。
 *
 * 隔离：全程用临时数据目录 + 临时端口，跑完全删。
 * 跑法：node apps/server/src/smoke-data-dir.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './config.mjs';

const P1 = Number(process.env.SMOKE_PORT ?? 8804);
const P2 = P1 + 1;
const HOST_ORIGIN = `http://192.168.1.9:${P2}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-data-'));
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/**
 * 在**干净环境**（去掉 BANDI_DATA / BANDI_DB）里问 `config.mjs`：默认数据目录是哪儿。
 * 不启服务、不建库 —— 只验默认值本身，不能拿真实库试。
 */
function defaultDataDirFromChild() {
  const env = { ...process.env };
  delete env.BANDI_DATA;
  delete env.BANDI_DB;
  const url = pathToFileURL(path.join(repoRoot, 'apps', 'server', 'src', 'config.mjs')).href;
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); process.stdout.write(m.dataDir);`],
    { cwd: repoRoot, env, encoding: 'utf8' },
  );
  if (r.status !== 0) return `(失败：${String(r.stderr).slice(-300)})`;
  return String(r.stdout).trim();
}

/** 期望的默认目录（独立算一遍，不复用被测实现）。 */
const expectedDefault = (() => {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'bandi');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'bandi');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'bandi');
})();

function start(port, extra = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(port), BANDI_DATA: tmp, ...extra },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  return { child, log: () => log };
}

async function waitUp(base, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(base + '/api/state', { signal: AbortSignal.timeout(800) });
      // 401 也算起来了：监听非回环的控制面**要求令牌**（详见 smoke-auth.mjs）
      if (r.ok || r.status === 401) return true;
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function stop(ctx) {
  if (!ctx || ctx.child.exitCode !== null) return;
  const done = new Promise((r) => ctx.child.once('exit', r));
  ctx.child.kill();
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
}

/**
 * 写请求带 Origin（模拟浏览器）。返回状态码：
 *   401 = 没带令牌，被**鉴权**闸拦下；403 = 被**来源**闸拦下；400 = 两道都过了，只是参数不对。
 */
async function writeWithOrigin(base, origin, { header = true, token = '' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (header) headers['X-Bandi'] = '1';
  if (token) headers['X-Bandi-Token'] = token;
  const r = await fetch(base + '/api/personas', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '' }), // 空名字 → 过闸也只会 400，不会真建东西
  });
  return r.status;
}

let ctx = null;
try {
  console.log('⓪ 不设 BANDI_DATA 时：默认落本机用户目录（命令行与桌面壳同一个默认）');
  const def = defaultDataDirFromChild();
  check('默认 = 用户数据目录', def === expectedDefault, def);
  check('默认不是 <仓库>/data', def !== path.join(repoRoot, 'data'), def);

  console.log('\n① BANDI_DATA：数据真的落在指的那个目录');
  ctx = start(P1);
  const base1 = `http://127.0.0.1:${P1}`;
  if (!(await waitUp(base1))) throw new Error('没起来：' + ctx.log().slice(-500));
  check('服务起来了', true);
  check('库建在临时数据目录里', fs.existsSync(path.join(tmp, 'bandi.db')), path.join(tmp, 'bandi.db'));
  check('启动日志把数据目录打出来了', ctx.log().includes(`数据目录：${tmp}`), (ctx.log().match(/数据目录：.*/) ?? ['(没有)'])[0]);
  check('默认只听本机（没打"非本机监听"那句）', !/监听 0\.0\.0\.0|监听 ::/.test(ctx.log()));

  console.log('\n② 写请求的来源闸：本机放行，陌生来源挡掉');
  check('本机源 → 过闸（400 是参数问题，不是被拦）', (await writeWithOrigin(base1, `http://127.0.0.1:${P1}`)) === 400);
  check('陌生来源 → 403', (await writeWithOrigin(base1, 'http://evil.example.com')) === 403);
  check('本机源但缺 X-Bandi 头 → 403', (await writeWithOrigin(base1, `http://127.0.0.1:${P1}`, { header: false })) === 403);
  await stop(ctx);
  ctx = null;

  console.log('\n③ BANDI_HOST + BANDI_ORIGINS：放开监听，并把远端来源加进白名单');
  ctx = start(P2, { BANDI_HOST: '0.0.0.0', BANDI_ORIGINS: HOST_ORIGIN });
  const base2 = `http://127.0.0.1:${P2}`;
  if (!(await waitUp(base2))) throw new Error('没起来：' + ctx.log().slice(-500));
  check('监听 0.0.0.0 后，本机地址照样连得上', true);
  check('日志里点出了允许的来源', ctx.log().includes(HOST_ORIGIN), (ctx.log().match(/允许的来源：.*/) ?? ['(没有)'])[0]);
  /*
   * 2026-10-15 起：监听非回环的控制面**要求访问令牌**（auth.mjs）。
   * 这里把"要令牌"这件事本身也钉住 —— 它是"放到公网之后的第一道闸"。
   */
  const token = fs.readFileSync(path.join(tmp, 'token'), 'utf8').trim();
  check('非本机监听会生成并要求令牌', /访问令牌：/.test(ctx.log()) && token.length > 20, `token=${token.slice(0, 6)}…`);
  const noTok = await fetch(base2 + '/api/state', { signal: AbortSignal.timeout(3000) });
  check('不带令牌读状态 → 401（回环之外一律要令牌）', noTok.status === 401, String(noTok.status));

  console.log('\n④ 配了白名单 ＋ 带上令牌，远端来源才动得了手');
  check('白名单来源 + 令牌 → 过闸（400 而不是 401/403）', (await writeWithOrigin(base2, HOST_ORIGIN, { token })) === 400);
  check('白名单外仍然 403', (await writeWithOrigin(base2, 'http://evil.example.com', { token })) === 403);
  check('白名单内但缺 X-Bandi 头 → 403', (await writeWithOrigin(base2, HOST_ORIGIN, { header: false, token })) === 403);
  check('本机源 + 令牌仍然放行', (await writeWithOrigin(base2, `http://127.0.0.1:${P2}`, { token })) === 400);
  check(
    '来源对、X-Bandi 也有，但没令牌 → 401（鉴权排在来源闸前面）',
    (await writeWithOrigin(base2, HOST_ORIGIN)) === 401,
  );
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  await stop(ctx);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
