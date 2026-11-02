/**
 * **第一个管理员怎么建**（IAM §8.6，Phase 1 用例）。
 *
 * 原来：`POST /api/users` 在库里零账号时是免令牌的 —— 服务器形态下等于"谁先连上谁当管理员"。
 * 现在：服务器形态（监听非回环 / 声明了 trustProxy）在零账号时会生成 `<数据目录>/setup_code`，
 * 建号必须带 `X-Bandi-Setup`；建成后文件立刻删除（别留成第二个后门）。
 * 单机形态（回环）不生成、不校验 —— "开机建账号"的体验一个字节没变。
 *
 * 五条：
 *   ① 服务器形态零账号 → 生成了 setup_code
 *   ② 不带 `X-Bandi-Setup` → 403 E4098（不是 201）
 *   ③ 带错码 → 403 E4098
 *   ④ 带对码 → 201 + 第一个账号是 admin + 文件被删
 *   ⑤ 建完之后同一个接口不能再"裸建"（没有令牌 → 401/403）
 *   ⑥ 单机形态不生成 setup_code，裸建照旧 201
 *
 * 跑法：node apps/server/src/smoke-bootstrap.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { sleep } from './lifecycle.mjs';

const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

function raw(port, { method = 'GET', path: p = '/', headers = {}, body = null, timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        setHost: false,
        timeout,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => finish({ status: res.statusCode, body: text }));
      },
    );
    req.on('error', (e) => finish({ status: 0, body: String(e?.message ?? e) }));
    req.on('timeout', () => {
      req.destroy();
      finish({ status: 0, body: 'timeout' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const jsonOf = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

async function start({ port, data, env }) {
  const merged = { ...process.env, BANDI_PORT: String(port), BANDI_DATA: data, BANDI_DB: path.join(data, 'bandi.db') };
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const child = spawn(process.execPath, [SERVER], { cwd: repoRoot, env: merged, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const ctx = { port, data, child, log: '' };
  child.stdout.on('data', (d) => (ctx.log += d));
  child.stderr.on('data', (d) => (ctx.log += d));
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const r = await raw(port, { path: '/api/state' });
    if (r.status === 200 || r.status === 401 || r.status === 403) return ctx;
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  throw new Error(`服务没起来（端口 ${port}）\n${ctx.log.slice(-1200)}`);
}

function stop(ctx) {
  try {
    ctx.child.kill();
  } catch { /* 已退 */ }
  try {
    fs.rmSync(ctx.data, { recursive: true, force: true });
  } catch { /* Windows 占用，临时目录无所谓 */ }
}

const tmpOf = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `bandi-${tag}-`));

/* ------------------------------------------------------- 服务器形态 */
console.log('\n[1] 服务器形态（监听 0.0.0.0）+ 零账号');
{
  const port = 8811;
  const data = tmpOf('bootstrap');
  const ctx = await start({ port, data, env: { BANDI_HOST: '0.0.0.0', BANDI_TRUST_PROXY: null } });
  try {
    const file = path.join(data, 'setup_code');
    check('生成了 setup_code（0600）', fs.existsSync(file));
    const code = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';

    const noHeader = await raw(port, { method: 'POST', path: '/api/users', body: { name: '路人甲' } });
    check('不带 X-Bandi-Setup → 403 E4098', noHeader.status === 403 && jsonOf(noHeader.body)?.code === 'E4098', `${noHeader.status} ${jsonOf(noHeader.body)?.code}`);

    const wrong = await raw(port, { method: 'POST', path: '/api/users', body: { name: '路人甲' }, headers: { 'X-Bandi-Setup': 'nope' } });
    check('带错码 → 403 E4098', wrong.status === 403 && jsonOf(wrong.body)?.code === 'E4098', `${wrong.status} ${jsonOf(wrong.body)?.code}`);

    const ok = await raw(port, { method: 'POST', path: '/api/users', body: { name: '老王' }, headers: { 'X-Bandi-Setup': code } });
    const created = jsonOf(ok.body) ?? {};
    check('带对码 → 201 且是管理员', ok.status === 201 && created.user?.roleId === 'admin', `${ok.status} role=${created.user?.roleId}`);
    check('建完 setup_code 被删掉（不留后门）', !fs.existsSync(file));

    const again = await raw(port, { method: 'POST', path: '/api/users', body: { name: '路人乙' } });
    check('建完之后裸建 → 401/403（不再开放）', again.status === 401 || again.status === 403, String(again.status));
  } finally {
    stop(ctx);
  }
}

/* --------------------------------------------------------- 单机形态 */
console.log('\n[2] 单机形态（回环）+ 零账号');
{
  const port = 8812;
  const data = tmpOf('solo-bootstrap');
  const ctx = await start({ port, data, env: { BANDI_HOST: null, BANDI_TRUST_PROXY: null } });
  try {
    check('不生成 setup_code（单机不需要）', !fs.existsSync(path.join(data, 'setup_code')));
    /*
     * 2026-11-01 口径统一（用户：「每个用户都要登录，操作员只是一个身份」）：
     * 零账号时**不再放行进面板当操作员** —— 面板门前移到建号页。从前那种做法会让
     * 「我的」页既没有密码也没有动态验证（operator 没有 users 行，没地方存），
     * 用户在界面上看到的是一个空页 + 一段实现说明。
     * API 一个字节没变：本机脚本/冒烟/CLI 不带凭据照旧是 operator。
     */
    const page = await raw(port, { path: '/', headers: { Accept: 'text/html' } });
    check(
      '零账号抓首页 → 建号页（operator 不再直接进面板）',
      page.status === 200 && page.body.includes('id="signForm"') && !page.body.includes('/app.mjs'),
      String(page.status),
    );
    const api0 = await raw(port, { path: '/api/state' });
    check('同一台机器 API 照旧免鉴权（脚本不带凭据也能用）', api0.status === 200, String(api0.status));
    const r = await raw(port, { method: 'POST', path: '/api/users', body: { name: '老王' } });
    const j = jsonOf(r.body) ?? {};
    check('本机裸建 → 201 且是管理员', r.status === 201 && j.user?.roleId === 'admin', `${r.status} role=${j.user?.roleId}`);
  } finally {
    stop(ctx);
  }
}

console.log(failed ? `\n✗ ${failed} 条不通过\n` : '\n✓ 全部通过\n');
process.exit(failed ? 1 : 0);
