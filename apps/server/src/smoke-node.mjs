/**
 * 节点报到与掉线的验收（2026-10-15 形态决策 阶段 2 的最小切片）。
 *
 * 验五件事：
 *   ① 一个节点跑起来就能**出站报到**，并在控制面的设备列表里出现成一台设备；
 *   ② 它自报的 agent CLI 进了运行时清单、**可被派活**（但控制面绝不在本机起它们，
 *      因为它们是 remote —— 真派过去的那条路见 smoke-node-jobs.mjs）；
 *   ③ 报到的 id 认文件不认主机名：再报一次还是同一台，不会攒出第二台；
 *   ④ **掉线可发现**：心跳过期后控制面判它离线；
 *   ⑤ 边界清楚：没 id 不许报到、没登记过的心跳 404、节点设备上的运行时改不动。
 *
 * 隔离：临时库 + 临时端口 + 临时节点身份文件，跑完全删，不碰 data/。
 * 跑法：node apps/server/src/smoke-node.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from './config.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8798);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-node-'));
const DB = path.join(tmp, 'bandi.db');
const NODE_STATE = path.join(tmp, 'node.json');
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const NODE = path.join(repoRoot, 'apps', 'server', 'src', 'node.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** 起一次节点（--once：报到 + 心跳一次就退），返回它的输出 */
function runNodeOnce() {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [NODE, '--once'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BANDI_CONTROL_PLANE: BASE,
        BANDI_NODE_STATE: NODE_STATE,
        // 节点自己也需要一个库路径吗？不需要 —— 它不碰库，只用身份文件
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code, out }));
  });
}

let server = null;
try {
  server = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: DB },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let slog = '';
  server.stdout.on('data', (c) => (slog += c));
  server.stderr.on('data', (c) => (slog += c));

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/state')).ok) break; } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('① 一个节点出站报到');
  const before = await get('/api/devices');
  check('一开始只有本机一台设备', before.body?.devices?.length === 1, '实际 ' + before.body?.devices?.length);

  const ran = await runNodeOnce();
  check('节点进程正常退出', ran.code === 0, 'exit=' + ran.code);
  console.log('   节点说：' + ran.out.trim().split(/\r?\n/).join(' | '));
  check('控制面日志里记了这次报到', /\[节点\] 报到：/.test(slog), (slog.match(/\[节点\].*/) ?? ['(没记)'])[0]);

  const after = await get('/api/devices');
  const node = (after.body?.devices ?? []).find((d) => d.kind === 'node');
  check('设备列表里多了一台节点', !!node, JSON.stringify((after.body?.devices ?? []).map((d) => `${d.id}:${d.kind}`)));
  if (!node) throw new Error('没报到成设备，后面没法验');
  check('它是在线状态', node.online === true, String(node.online));
  check('带了机器名与平台', !!node.label && !!node.platform, `${node.label} / ${node.platform}`);
  check('告诉节点多久心跳一次', node.heartbeatSeconds === 15, String(node.heartbeatSeconds));
  console.log(`   节点自报 ${node.runtimeCount} 个运行时`);

  console.log('\n② 节点自报的运行时：**可被派活**，但控制面不会在本机起它');
  const detail = await get('/api/devices/' + encodeURIComponent(node.id));
  check('能点进去看详情', detail.status === 200 && !!detail.body?.device, String(detail.status));
  const remoteRts = detail.body?.device?.runtimes ?? [];
  check('自报的运行时条数与 runtimeCount 一致', remoteRts.length === node.runtimeCount, `${remoteRts.length} vs ${node.runtimeCount}`);
  /*
   * 2026-10-15 领活做完之后，语义**故意变了**：这些运行时从"只读"变成"可派活"。
   * 原来那条断言（enabled 一律 false）守的是"别拿着别人家的路径在本机 spawn" ——
   * 现在那件事由 `remote: true` + runs.startRun 的分支保证（见 smoke-node-jobs.mjs：
   * 派给它的活真的跑到节点上去了，而不是在本机起进程）。
   */
  check('全都标着"远程"（这是控制面不在本机起它的依据）', remoteRts.every((r) => r.remote === true));
  check('而且**可派**（员工能绑到它们上）', remoteRts.every((r) => r.enabled === true));
  check('id 带节点前缀（一眼看得出活会落到哪台机器）', remoteRts.every((r) => String(r.id).startsWith(node.id + ':')));
  const localRts = (await get('/api/runtimes')).body?.runtimes ?? [];
  /*
   * 本机也接一个运行时，这条断言才**不是空转**：要验的是"远端条目没把本机那几条顶掉"。
   * 本机清单在临时数据目录里本来是空的 —— 空的话怎么断言都过，等于没验。
   */
  const FAKE = path.join(repoRoot, 'apps', 'server', 'src', 'fixtures', 'fake-agent.js');
  const madeLocal = await post('/api/devices/local/runtimes', { family: 'codex', label: '本机的假 CLI', path: FAKE });
  check('本机运行时接得上（等下要用它验"没被顶掉"）', madeLocal.status === 201 || madeLocal.status === 200, String(madeLocal.status));
  const localIds = ((await get('/api/devices/local')).body?.device?.runtimes ?? []).map((r) => r.id);
  const both = (await get('/api/runtimes')).body?.runtimes ?? [];
  check(
    '本机自己的运行时一个不少（远端条目没把它们顶掉）',
    localIds.length > 0 && localIds.every((id) => both.some((l) => l.id === id)),
    `本机 ${localIds.join(',') || '(空的)'}`,
  );
  check('远端的也都在（同一份清单里并存）', remoteRts.every((r) => both.some((l) => l.id === r.id)));

  console.log('\n②b 重命名机器：名字是**人起的**，主机名是**那台机器的事实**');
  const dev0 = (await get('/api/devices/' + encodeURIComponent(node.id))).body.device;
  check('没改名时：名字就是它的主机名', dev0.label === dev0.hostname && dev0.renamed === false, `${dev0.label} / ${dev0.hostname}`);
  const rn = await post(`/api/devices/${encodeURIComponent(node.id)}/rename`, { label: '备用机·杭州' });
  check('改名成功', rn.status === 200 && rn.body?.device?.label === '备用机·杭州', `${rn.status} ${rn.body?.device?.label}`);
  check('主机名**没被动**', rn.body?.device?.hostname === dev0.hostname, `${rn.body?.device?.hostname}`);
  check('标着"是人起的名字"', rn.body?.device?.renamed === true);

  /*
   * ⚠️ 这条是这次改名的**真正要害**：那台机器下次报到时会带自己的主机名上来，
   * 而它的名字必须**挺住**（否则用户改完名，机器一重启就白改）。
   * 见 store.upsertNode 里那条 `CASE WHEN nodes.renamed = 1`。
   */
  await runNodeOnce();
  const devAfter = (await get('/api/devices/' + encodeURIComponent(node.id))).body.device;
  check('那台机器重新报到之后，名字还在', devAfter.label === '备用机·杭州', devAfter.label);
  check('它自报的主机名照样更新', devAfter.hostname === dev0.hostname, devAfter.hostname);
  const rtLabel = (devAfter.runtimes ?? [])[0]?.label ?? '';
  check('运行时的显示名也跟着改了（员工下拉里看到的就是这个）', rtLabel.includes('备用机·杭州'), rtLabel);

  const back = await post(`/api/devices/${encodeURIComponent(node.id)}/rename`, { label: '' });
  check('传空 = 恢复成主机名', back.body?.device?.label === dev0.hostname && back.body?.device?.renamed === false, `${back.body?.device?.label}`);
  await runNodeOnce(); // 复原之后也重新报到一次，后面几段拿到的是干净状态

  console.log('\n②c 远端运行时"能不能起"由**那台机器**说了算，控制面不许在本机判');
  /*
   * 这是 2026-10-16 用户实报的：控制面在火山（Linux）上，看着笔记本报来的
   * `D:\AppData\...`，`existsSync` 必然 false —— 三个运行时全被标成「班底起不来」。
   * 本机看是好的（两边路径恰好都存在），一放到云端就露馅。
   */
  const NOWHERE = 'Z:\\绝对不存在的目录\\codex.js';
  await post('/api/nodes/register', {
    id: 'node-fakecheck',
    label: '假节点',
    hostname: 'fake-host',
    platform: 'linux x64',
    runtimes: [
      { family: 'codex', label: '那边有、本机没有', path: NOWHERE, usable: true },
      { family: 'claude', label: '那边自己说起不来', path: NOWHERE, usable: false },
    ],
  });
  const fdev = (await get('/api/devices/node-fakecheck')).body.device;
  const frt = (r) => (fdev.runtimes ?? []).find((x) => x.family === r);
  check('这个路径在本机确实不存在', !fs.existsSync(NOWHERE), NOWHERE);
  check(
    '但控制面照样认它可用（用节点自报的，不在本机 existsSync）',
    frt('codex')?.pathExists === true && frt('codex')?.launchable === true,
    JSON.stringify({ pathExists: frt('codex')?.pathExists, launchable: frt('codex')?.launchable }),
  );
  check('那边自报"起不来"的，控制面如实转达', frt('claude')?.launchable === false, String(frt('claude')?.launchable));

  /*
   * 心跳**捎带**运行时清单（2026-10-16 加）：在那台机器上装完 CLI，这边不用等它重启就该变。
   * 原来清单只在报到时上报 —— 用户看到的是"我明明装了，页面上还是 0"，只能重启节点。
   */
  await post('/api/nodes/node-fakecheck/heartbeat', {
    runtimes: [{ family: 'claude', label: '新装的', path: '/usr/local/bin/claude', usable: true }],
  });
  const afterHb = (await get('/api/devices/node-fakecheck')).body.device;
  check(
    '心跳带上来的清单生效了（装了新 CLI 不用重启节点）',
    afterHb.runtimeCount === 1 && afterHb.runtimes[0]?.family === 'claude',
    `count=${afterHb.runtimeCount}`,
  );
  await fetch(BASE + '/api/nodes/node-fakecheck', { method: 'DELETE' });

  console.log('\n③ 身份认文件不认主机名：再报一次还是同一台');
  await runNodeOnce();
  const again = await get('/api/devices');
  const nodeCount = (again.body?.devices ?? []).filter((d) => d.kind === 'node').length;
  check('设备数没变成 3（没攒出第二台）', again.body?.devices?.length === 2, '实际 ' + again.body?.devices?.length);
  check('节点仍然只有一台', nodeCount === 1, String(nodeCount));
  const nodeIdAfter = (again.body?.devices ?? []).find((d) => d.kind === 'node')?.id;
  check('还是原来那个 id', nodeIdAfter === node.id, `${nodeIdAfter} vs ${node.id}`);

  console.log('\n④ 掉线可发现：心跳过期就判离线');
  const db = new DatabaseSync(DB);
  db.prepare('UPDATE nodes SET lastSeenAt = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), node.id);
  db.close();
  const stale = await get('/api/devices');
  const staleNode = (stale.body?.devices ?? []).find((d) => d.kind === 'node');
  check('60 秒没心跳 → 离线', staleNode?.online === false, String(staleNode?.online));
  const listNodes = await get('/api/nodes');
  check('节点清单接口给出判据（心跳 15 秒、45 秒算掉线）',
    listNodes.body?.heartbeatSeconds === 15 && listNodes.body?.offlineAfterSeconds === 45,
    JSON.stringify({ hb: listNodes.body?.heartbeatSeconds, off: listNodes.body?.offlineAfterSeconds }));

  console.log('\n⑤ 边界：该拒的都拒掉');
  check('报到不带 id → 400', (await post('/api/nodes/register', {})).status === 400);
  check('没登记过的心跳 → 404', (await post('/api/nodes/node-不存在/heartbeat')).status === 404);
  const guard = await post(`/api/devices/${encodeURIComponent(node.id)}/runtimes`, { family: 'codex', path: 'x' });
  check('节点设备上加运行时 → 400（要改得去那台机器上改）', guard.status === 400, `${guard.status} ${guard.body?.code ?? ''}`);
  check('拒绝理由说得清，而且不把"能派活"和"能编辑"混为一谈', String(guard.body?.error ?? '').includes('只读'), String(guard.body?.error ?? ''));
  check('本机设备不受影响（仍然有运行时权限）', (await get('/api/devices/local')).status === 200);
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  try { server?.kill(); } catch { /* 已经退了 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
