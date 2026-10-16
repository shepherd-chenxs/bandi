/**
 * 「路径自愈」的验收（2026-10-16）。
 *
 * 背景（用户实报"本地和服务端状态对不上"）：桌面版看**本机**说「班底起不来」，
 * 云端看**同一个节点的同一台机器**说「在线」—— 因为节点每次心跳都现探、永远新鲜，
 * 而控制面记的是"接进来那一刻的路径"，CLI 升级后那条就成了 `.cmd` shim（班底起不动）。
 *
 * 三条要钉住：
 *   ① 记的路径不能用了、同一族又探得到能用的 → **自动切过去**，旧值留在 `healedFrom`；
 *   ② 切完**不抖**（第二次加载不再改），而且**能落盘**（重启还在）；
 *   ③ ⚠️ **不许递归**：第一版在 `loadDevices()` 的栈里调了 `saveRuntime`，而它内部又会
 *      `loadDevices()` —— 控制面进程活着、CPU 一直涨、端口不响应、日志一声不吭。
 *      所以这里每个请求都带超时：**挂住就是失败**（这正是不写这条用例会漏掉的那种 bug）。
 *
 * 跑法：node apps/server/src/smoke-runtime-heal.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = 8884;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-heal-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
/** 带超时的请求：挂住 = 失败（递归那次的症状就是请求永远不回） */
const get = async (p) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(BASE + p, { signal: ac.signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    clearTimeout(t);
  }
};

const server = spawn(process.execPath, [path.join(ROOT, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await get('/api/state')).status === 200) break; } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  // 这台机器上探得到哪个族，就用哪个族来验（探不到就跳过，别拿别人的环境当前提）
  const fams = (await get('/api/runtime-families')).body.families;
  const usable = fams.find((f) => f.installed && f.detectedPath);
  console.log(`本机探到可用的族：${fams.filter((f) => f.installed).map((f) => f.id).join(' ') || '（一个都没有）'}\n`);

  if (!usable) {
    check('本机一个 CLI 都没有，这条用例跳过（不是失败）', true, '没有可比对的探测结果');
  } else {
    const BROKEN = path.join(tmp, '根本不存在', 'cli.cmd');
    console.log(`① 接一条**路径不能用**的运行时（${usable.id}）`);
    const made = await fetch(`${BASE}/api/devices/local/runtimes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: usable.id, label: '自愈用例', path: BROKEN }),
    }).then((r) => r.json());
    const rid = made?.runtime?.id ?? made?.id;
    // 建的时候会 resolveCliPath，可能已经被掰到别处 —— 直接改回坏路径，模拟"当年接的那个现在没了"
    fs.writeFileSync(
      path.join(tmp, 'runtimes.json'),
      JSON.stringify(
        { devices: { local: { runtimes: { [rid]: { family: usable.id, label: '自愈用例', enabled: true, path: BROKEN } } } } },
        null,
        2,
      ),
      'utf8',
    );
    check('坏路径已经写进配置', fs.readFileSync(path.join(tmp, 'runtimes.json'), 'utf8').includes('cli.cmd'));

    console.log('\n② 加载一次 —— 应该自己切到探测到的那个');
    const dev1 = (await get('/api/devices/local')).body.device;
    const r1 = dev1.runtimes.find((r) => r.id === rid);
    check('切到了探测到的路径', r1?.path === usable.detectedPath, `${r1?.path}`);
    check('现在能起了（launchable）', r1?.launchable === true, String(r1?.launchable));
    check('旧值留了痕（healedFrom）', !!r1?.healedFrom, String(r1?.healedFrom));
    check('配置真落盘了', fs.readFileSync(path.join(tmp, 'runtimes.json'), 'utf8').includes(path.basename(usable.detectedPath)));

    console.log('\n③ 再加载两次 —— 不抖、不递归（挂住就是失败）');
    const dev2 = (await get('/api/devices/local')).body.device;
    const r2 = dev2.runtimes.find((r) => r.id === rid);
    const dev3 = (await get('/api/devices/local')).body.device;
    const r3 = dev3.runtimes.find((r) => r.id === rid);
    check('路径稳定，不再变', r2?.path === r1.path && r3?.path === r1.path, `${r2?.path}`);
    check('痕迹还在（能从配置里读回来）', r3?.healedFrom === r1.healedFrom, String(r3?.healedFrom));

    console.log('\n④ 用户手工改一次路径 —— 痕迹该消失');
    await fetch(`${BASE}/api/devices/local/runtimes/${encodeURIComponent(rid)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: usable.detectedPath }),
    });
    const dev4 = (await get('/api/devices/local')).body.device;
    check('手工改过之后不再标「路径已更正」', !dev4.runtimes.find((r) => r.id === rid)?.healedFrom);
  }

  console.log('\n⑤ 服务还活着（递归那次的症状是端口不响应）');
  check('健康检查仍然 200', (await get('/api/state')).status === 200);
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  if (String(err?.name) === 'AbortError') console.log('（请求超时 = 请求挂住了，多半是又递归了）');
  console.log(log.slice(-400));
  failed += 1;
} finally {
  try { server.kill(); } catch { /* 退了 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
