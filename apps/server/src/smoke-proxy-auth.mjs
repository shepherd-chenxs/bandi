/**
 * **反代形态下的鉴权**（IAM §5.3 / §15 的 P0 用例）。
 *
 * 背景：`auth.mjs` 原来只看进程监听地址 —— 只要监听的是回环，`auth.required = false`，
 * 于是**所有**请求（面板、会话、导出、/api/ai）都直接变成 operator。而反代（nginx /
 * cloudflared / frp）恰恰把外部流量转进 `127.0.0.1:8787`。两者一叠加 = 上反代那天全站免登录。
 *
 * 本用例钉住三类启动形态，每类都必须是"要么拒绝，要么照常"：
 *   ① `BANDI_HOST=127.0.0.1 + BANDI_TRUST_PROXY=1`（声明在代理后面）：
 *      - 带转发头的 /api/state、/api/local/status、/api/local/export、/api/ai/*、/api/events
 *        **全部 401**（一个都不许过）；
 *      - 带 root 令牌照样能用（proves setup 在 trustProxy 下也加载/生成了 token）；
 *      - 破坏性动作（算力节点 join）带令牌但**不带 X-Bandi-Local** → E4097，带了才到业务层
 *        （collab/join 2026-11-02 起放宽成 never，不再是 E4097 样本，另有专条断言）。
 *   ② **裸反代漏配**：`BANDI_HOST=127.0.0.1`、不设 trustProxy、不设转发头，只把 Host
 *      换成外部域名（并在 BANDI_ORIGINS 里声明，否则先被 Host 守卫 403）→ **必须 401**（Host 兜底）；
 *      同一台机器上用 `Host: 127.0.0.1` 仍然 200（单机行为一行没变）。
 *   ③ 未声明的外部 Host → 403 E3002（Host 守卫，先于一切）。
 *
 * 隔离：每台一个临时数据目录 + 独立端口，跑完全删。
 * 跑法：node apps/server/src/smoke-proxy-auth.mjs
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

/** 手写请求：Node 的 fetch **不许改 Host**，而 Host 兜底正是被测项之一 */
function raw(port, { method = 'GET', path: p = '/', headers = {}, body = null, timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers, setHost: false, timeout },
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
    if (body) req.write(body);
    req.end();
  });
}

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const codeOf = (r) => json(r.body)?.code ?? '';

async function start({ port, data, env }) {
  const merged = { ...process.env, BANDI_PORT: String(port), BANDI_DATA: data, BANDI_DB: path.join(data, 'bandi.db') };
  for (const [k, v] of Object.entries(env ?? {})) {
    // `null` = **真的不要这个变量**（空串会被 config 当成"显式指定了监听地址"，是另一种形态）
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: merged,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ctx = { port, data, child, log: '' };
  child.stdout.on('data', (d) => (ctx.log += d));
  child.stderr.on('data', (d) => (ctx.log += d));
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const r = await raw(port, { path: '/api/state', headers: { Host: `127.0.0.1:${port}` } });
    if (r.status === 200 || r.status === 401 || r.status === 403) return ctx;
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  throw new Error(`服务没起来（端口 ${port}）\n${ctx.log.slice(-1200)}`);
}

function stop(ctx) {
  try {
    ctx.child.kill();
  } catch { /* 已经退了 */ }
  try {
    fs.rmSync(ctx.data, { recursive: true, force: true });
  } catch { /* Windows 上刚杀进程时偶尔占用，删不掉就算了（临时目录） */ }
}

const tmpOf = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `bandi-${tag}-`));

/* ---------------------------------------------------------------- ① trustProxy */
console.log('\n[1] BANDI_HOST=127.0.0.1 + BANDI_TRUST_PROXY=1（声明在代理后面）');
{
  const port = 8801;
  const data = tmpOf('proxy');
  const base = { Host: `127.0.0.1:${port}` };
  const viaProxy = { Host: `127.0.0.1:${port}`, 'X-Forwarded-For': '1.2.3.4' };
  const ctx = await start({ port, data, env: { BANDI_HOST: '127.0.0.1', BANDI_TRUST_PROXY: '1' } });
  try {
    const token = fs.readFileSync(path.join(data, 'token'), 'utf8').trim();
    check('setup 在 trustProxy 下也生成了 root 令牌', token.length > 20, `${token.slice(0, 4)}…`);

    for (const p of ['/api/state', '/api/local/status', '/api/local/collab/status', '/api/ai/image-config', '/api/events']) {
      const r = await raw(port, { path: p, headers: viaProxy });
      check(`带转发头的 ${p} → 401`, r.status === 401, `${r.status} ${codeOf(r)}`);
    }
    {
      const r = await raw(port, { method: 'POST', path: '/api/local/export', headers: viaProxy });
      check('带转发头的 POST /api/local/export（无凭据）→ 401', r.status === 401, `${r.status} ${codeOf(r)}`);
    }

    // 带令牌：认证照常成立（否则服务器形态的 CLI/脚本全废）
    const okState = await raw(port, { path: '/api/state', headers: { ...base, 'X-Bandi-Token': token } });
    check('本机 + 令牌 → /api/state 200', okState.status === 200, String(okState.status));
    const okProxyState = await raw(port, { path: '/api/state', headers: { ...viaProxy, 'X-Bandi-Token': token } });
    check('带转发头 + 令牌 → /api/state 200（认证不被误杀）', okProxyState.status === 200, String(okProxyState.status));

    // 破坏性动作：位置对了、身份对了，还缺"我在本机"的证明
    // （collab/join 2026-11-02 起放宽成 never，E4097 的样本换成还是 network 档的算力节点 join）
    const secretPath = path.join(data, 'local_secret');
    check('启动了 local_secret（0600）', fs.existsSync(secretPath));
    const secret = fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf8').trim() : '';

    const noSecret = await raw(port, {
      method: 'POST',
      path: '/api/local/join',
      headers: { ...viaProxy, 'X-Bandi-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1', code: 'x' }),
    });
    check('网络 + 令牌 + 无 X-Bandi-Local → E4097', noSecret.status === 403 && codeOf(noSecret) === 'E4097', `${noSecret.status} ${codeOf(noSecret)}`);

    const withSecret = await raw(port, {
      method: 'POST',
      path: '/api/local/join',
      headers: { ...viaProxy, 'X-Bandi-Token': token, 'X-Bandi-Local': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1', code: 'x' }),
    });
    check(
      '网络 + 令牌 + X-Bandi-Local → 过闸（业务失败，不是 4097）',
      withSecret.status !== 403 && codeOf(withSecret) !== 'E4097',
      `${withSecret.status} ${codeOf(withSecret)}`,
    );

    // ⚠️ trustProxy 一设，**连本机也不再免秘密** —— 这是 IAM §5.3 的口径：
    //    "声明了我在代理后面"就等于"回环来源不可信"，此时只有文件秘密能证明本机。
    //    所以 CLI 在本机也要读 local_secret 带头，这是设计如此。
    const localNoSecret = await raw(port, {
      method: 'POST',
      path: '/api/local/join',
      headers: { ...base, 'X-Bandi-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1', code: 'x' }),
    });
    check(
      'trustProxy 下连本机也要秘密 → E4097（不是漏洞，是口径）',
      localNoSecret.status === 403 && codeOf(localNoSecret) === 'E4097',
      `${localNoSecret.status} ${codeOf(localNoSecret)}`,
    );

    const localWithSecret = await raw(port, {
      method: 'POST',
      path: '/api/local/join',
      headers: { ...base, 'X-Bandi-Token': token, 'X-Bandi-Local': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1', code: 'x' }),
    });
    check(
      '本机 + 令牌 + 秘密 → 过闸（CLI 的执行路径）',
      localWithSecret.status !== 403 && codeOf(localWithSecret) !== 'E4097',
      `${localWithSecret.status} ${codeOf(localWithSecret)}`,
    );

    // collab/join 2026-11-02（三十一改）起 secret:'never'：网络来源无秘密也过秘密闸
    //（会落到业务失败 —— 码/地址是假的，这不是 403/E4097 就行）
    const collabJoin = await raw(port, {
      method: 'POST',
      path: '/api/local/collab/join',
      headers: { ...viaProxy, 'X-Bandi-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1', code: 'bi_nosuch' }),
    });
    check(
      'collab/join 网络来源无秘密 → 过秘密闸（业务失败，不是 4097）',
      collabJoin.status !== 403 && codeOf(collabJoin) !== 'E4097',
      `${collabJoin.status} ${codeOf(collabJoin)}`,
    );
  } finally {
    stop(ctx);
  }
}

/* ------------------------------------------------------------- ② 裸反代漏配 */
console.log('\n[2] 裸反代（未设 trustProxy / 未带转发头，Host 是外部域名）');
{
  const port = 8802;
  const data = tmpOf('bare');
  const extHost = 'bandi.example.com';
  const ctx = await start({
    port,
    data,
    // BANDI_ORIGINS 声明了外部域名：否则请求会先被 Host 守卫挡成 403，测不到 classifySource 这一层
    env: { BANDI_HOST: '127.0.0.1', BANDI_ORIGINS: `http://${extHost}:${port}` },
  });
  try {
    const ext = await raw(port, { path: '/api/state', headers: { Host: `${extHost}:${port}` } });
    check('外部 Host + 无转发头 → 401（Host 兜底生效）', ext.status === 401, `${ext.status} ${codeOf(ext)}`);

    const local = await raw(port, { path: '/api/state', headers: { Host: `127.0.0.1:${port}` } });
    check('同一进程用 127.0.0.1 访问 → 200（单机行为一行没变）', local.status === 200, String(local.status));

    const evil = await raw(port, { path: '/api/state', headers: { Host: 'evil.example.com' } });
    check('未声明的外部 Host → 403 E3002（Host 守卫先挡）', evil.status === 403 && codeOf(evil) === 'E3002', `${evil.status} ${codeOf(evil)}`);
  } finally {
    stop(ctx);
  }
}

/* --------------------------------------------------------------- ③ 单机回归 */
/*
 * "单机"现在是**显式钉出来的调试形态**（2026-11-03 起 BANDI_HOST 缺省 0.0.0.0，
 * "缺省 = 对外 + 自动要令牌"由 smoke-auth ⑨ 钉住）—— 这节钉的是：显式回环时，
 * 单机那套"免鉴权 / 不要秘密 / 零安全痕迹"一行没变。
 */
console.log('\n[3] 单机形态（BANDI_HOST=127.0.0.1 显式钉出来的调试形态）');
{
  const port = 8803;
  const data = tmpOf('solo');
  const ctx = await start({ port, data, env: { BANDI_HOST: '127.0.0.1', BANDI_TRUST_PROXY: null } });
  try {
    const st = await raw(port, { path: '/api/state', headers: { Host: `127.0.0.1:${port}` } });
    const body = json(st.body) ?? {};
    check('本机 /api/state → 200 且 source=loopback', st.status === 200 && body.source === 'loopback', `${st.status} source=${body.source}`);
    check('单机形态 localSecret=not-required', body.localSecret === 'not-required', String(body.localSecret));
    check('单机形态不生成 token 文件（零安全痕迹）', !fs.existsSync(path.join(data, 'token')));

    const probe = await raw(port, {
      method: 'POST',
      path: '/api/local/probe',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '' }),
    });
    check('本机调破坏性接口不需要秘密（过闸到业务层）', probe.status !== 403, `${probe.status} ${codeOf(probe)}`);
  } finally {
    stop(ctx);
  }
}

console.log(failed ? `\n✗ ${failed} 条不通过\n` : '\n✓ 全部通过\n');
process.exit(failed ? 1 : 0);
