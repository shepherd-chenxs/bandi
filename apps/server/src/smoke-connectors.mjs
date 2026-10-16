/**
 * 冒烟测试：连接器这一层的 HTTP 接口（界面用的就是这几个）。
 *
 * 自己起一个服务（换端口、换账本路径），跑完杀掉 —— 不碰 data/connectors.json。
 * 跑法：node apps/server/src/smoke-connectors.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
const PORT = Number(process.env.SMOKE_PORT ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-api-'));
const env = {
  ...process.env,
  BANDI_PORT: String(PORT),
  // 数据目录也指过去：不然这个用例起的那台服务会写进**真实的 data/**（库和账本一起）
  BANDI_DATA: tmp,
  BANDI_CONNECTORS: path.join(tmp, 'connectors.json'),
  BANDI_CONNECTORS_DIR: path.join(tmp, 'generated'),
};

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
}
const api = async (p, opts) => {
  const res = await fetch(BASE + p, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const patch = (p, body) =>
  api(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (c) => (serverLog += c));
child.stderr.on('data', (c) => (serverLog += c));

const cleanup = () => {
  try {
    child.kill();
  } catch {
    /* 已经退了 */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 */
  }
};

try {
  // 等服务起来
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/api/connectors');
      if (r.ok) { up = true; break; }
    } catch {
      /* 还没起 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('服务没起来：' + serverLog.slice(0, 400));

  console.log('① 推荐清单（界面「公开」那一栏）');
  const cat = await api('/api/connectors/catalog');
  check('清单接口 200 且没有读错误', cat.status === 200 && !cat.body.error, cat.body?.error ?? '');
  check('清单里至少 5 条', (cat.body?.catalog ?? []).length >= 5, String((cat.body?.catalog ?? []).length));
  check('清单条目带 installed 标志', cat.body?.catalog?.every((c) => 'installed' in c));
  check('清单条目都写清了来源', cat.body?.catalog?.every((c) => c.source?.ref));

  console.log('\n② 从清单装一条（本机回声）');
  const inst = await post('/api/connectors', { from: 'echo-local' });
  check('装成功（201）', inst.status === 201, JSON.stringify(inst.body?.error ?? ''));
  check('账本里出现了', (await api('/api/connectors')).body.connectors.some((c) => c.id === 'echo-local'));
  check('清单里那条变成已安装', (await api('/api/connectors/catalog')).body.catalog.find((c) => c.id === 'echo-local').installed);

  console.log('\n③ 实探（真把它拉起来走一遍 MCP 握手）');
  const probe = await post('/api/connectors/echo-local/probe');
  check('探测成功', probe.body?.ok === true, probe.body?.error ?? '');
  check('拿回了工具名单且含 echo', (probe.body?.tools ?? []).includes('echo'), JSON.stringify(probe.body?.tools ?? []));

  console.log('\n④ 停用 / 再启用');
  const off = await patch('/api/connectors/echo-local', { enabled: false });
  check('停用成功', off.status === 200 && off.body.connector.enabled === false);
  const on = await patch('/api/connectors/echo-local', { enabled: true });
  check('启用成功', on.status === 200 && on.body.connector.enabled === true);

  console.log('\n⑤ 手工装一条引用不存在环境变量的（应被提前拦下）');
  const bad = await post('/api/connectors', {
    id: 'needs-token',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(repoRoot, 'apps', 'server', 'src', 'fixtures', 'mcp-echo.mjs')],
    env: { TOKEN: 'env:BANDI_NO_SUCH_TOKEN' },
  });
  check('装得上（登记不拦）', bad.status === 201);
  const badProbe = await post('/api/connectors/needs-token/probe');
  check('实探时明确报缺哪个变量', badProbe.body?.ok === false && /BANDI_NO_SUCH_TOKEN/.test(badProbe.body?.error ?? ''), badProbe.body?.error ?? '');

  console.log('\n⑥ 校验与删除');
  const invalid = await post('/api/connectors', { id: '带空格 的名字', transport: 'stdio', command: 'node' });
  check('非法名字被拒（400）', invalid.status === 400);
  const noCmd = await post('/api/connectors', { id: 'no-command', transport: 'stdio' });
  check('stdio 缺可执行文件被拒（400）', noCmd.status === 400);
  const del = await api('/api/connectors/echo-local', { method: 'DELETE' });
  check('删除成功', del.status === 200 && del.body.removed === true);
  check('删完账本里没有了', !(await api('/api/connectors')).body.connectors.some((c) => c.id === 'echo-local'));
  const del2 = await api('/api/connectors/echo-local', { method: 'DELETE' });
  check('删不存在的返回 removed:false 而不是报错', del2.status === 200 && del2.body.removed === false);

  console.log(`\n结论：${failed ? `${failed} 项没通过` : '全通过'}`);
  if (failed) console.log('服务端日志：\n' + serverLog.slice(0, 800));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  console.log('服务端日志：\n' + serverLog.slice(0, 800));
  failed += 1;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
