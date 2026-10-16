/**
 * 控制面起停（`lifecycle.mjs`）的验收 —— 2026-10-15 抽成共用模块后补上。
 *
 * 这份逻辑现在被**两条路**共用：`start.mjs`（命令行双击）与桌面薄壳（`shell.mjs`）。
 * 合起来之前它只长在 start.mjs 里、一处都没测过；而它的两条约束都是"出事就是大事"：
 *
 *   ① **只结束我们自己的服务** —— 端口被别的程序占着时，一个都不许动；
 *   ② **僵死才重启** —— 端口上是我们自己的进程但它不响应，才收掉重起。
 *
 * 验六件事：起来 / 复用 / 僵死重启 / 强制重启 / **别人的进程绝不碰** / 停干净。
 *
 * 隔离：临时数据目录 + 临时端口，跑完全删。
 * 跑法：node apps/server/src/smoke-lifecycle.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { ensureRunning, stopRunning, isUp, listeners, urlOf, sleep } from './lifecycle.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8813);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-lifecycle-'));
const LOG = path.join(tmp, 'server.log');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const ENTRY_ARG = path.join('apps', 'server', 'src', 'server.mjs'); // 让命令行"看起来像我们"
const spawned = [];

/** 造一个**占着端口但永不响应**的进程。argv 里带上我们的入口，才能被认成"我们自己的" */
function fakeHanging(port, looksLikeOurs) {
  const code = looksLikeOurs
    ? `require('net').createServer(()=>{}).listen(${port})` // 接了连接但一个字都不回 → isUp 为 false
    : `require('http').createServer((q,s)=>s.end('hi')).listen(${port})`; // 别人的服务
  const args = ['-e', code];
  if (looksLikeOurs) args.push(ENTRY_ARG);
  const c = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'ignore', windowsHide: true });
  spawned.push(c);
  return c;
}

let alien = null;
try {
  console.log('① 起（第一次）');
  const r1 = await ensureRunning({ port: PORT, dataDir: tmp, logFile: LOG });
  check('结果是 started', r1.action === 'started', r1.action + ' ' + (r1.reason ?? ''));
  check('接口真的活着', await isUp(PORT));
  check('日志落在指定的数据目录里', fs.existsSync(LOG), LOG);
  check('数据目录里建出了库', fs.existsSync(path.join(tmp, 'bandi.db')));
  check('返回的 URL 是回环地址', r1.url === urlOf(PORT), r1.url);

  console.log('\n② 再起一次：已经在跑就**不重启**（这是默认行为）');
  const r2 = await ensureRunning({ port: PORT, dataDir: tmp, logFile: LOG });
  check('结果是 already', r2.action === 'already', r2.action);
  check('PID 还是原来那个（没被重启）', (r2.pids ?? [])[0] === r1.pid, `${(r2.pids ?? [])[0]} vs ${r1.pid}`);

  console.log('\n③ 强制重启：收掉自己人再起，并如实说是"强制重启"');
  const r3 = await ensureRunning({ port: PORT, dataDir: tmp, logFile: LOG, force: true });
  check('结果是 started', r3.action === 'started', r3.action);
  check('替换掉了旧进程', r3.replaced?.includes(r1.pid), JSON.stringify(r3.replaced));
  check('标明是 forced（不是僵死）', r3.forced === true, String(r3.forced));
  check('重启后接口活着', await isUp(PORT));

  console.log('\n④ 僵死：端口上是**我们自己的**进程、但它不响应 → 收掉重起，且不说是 forced');
  stopRunning(PORT);
  await sleep(800);
  const hang = fakeHanging(PORT, true);
  await sleep(900);
  check('假僵死进程确实占着端口', listeners(PORT).length > 0, listeners(PORT).join(','));
  check('但它不响应（isUp 为假）', (await isUp(PORT)) === false);
  const r4 = await ensureRunning({ port: PORT, dataDir: tmp, logFile: LOG });
  check('结果是 started', r4.action === 'started', r4.action);
  check('把僵死那个收掉了', r4.replaced?.length > 0, JSON.stringify(r4.replaced));
  check('标明不是 forced（是僵死判定的）', r4.forced === false, String(r4.forced));
  check('僵死进程真没了', hang.exitCode !== null || !listeners(PORT).includes(hang.pid), `exitCode=${hang.exitCode}`);
  check('新服务活着', await isUp(PORT));

  console.log('\n⑤ **别人的进程绝不碰**（这条出事就是大事）');
  stopRunning(PORT);
  await sleep(800);
  alien = fakeHanging(PORT, false);
  await sleep(900);
  const alienPid = alien.pid;
  check('别人的服务占着端口', listeners(PORT).includes(alienPid), listeners(PORT).join(','));
  const r5 = await ensureRunning({ port: PORT, dataDir: tmp, logFile: LOG });
  check('结果是 alien（不启动、不杀）', r5.action === 'alien', r5.action);
  await sleep(400);
  check('别人的进程**还活着**', alien.exitCode === null, `exitCode=${alien.exitCode}`);
  check('而且它还在占着端口', listeners(PORT).includes(alienPid));
  check('alien 里报了它是谁', r5.alien?.length === 1, JSON.stringify(r5.alien?.map((a) => a.pid)));

  console.log('\n⑥ 停：只停我们自己的');
  const s1 = stopRunning(PORT);
  check('没动别人的进程', s1.alien === 1 && s1.stopped === 0, JSON.stringify(s1));
  await sleep(400);
  check('别人的进程依然活着', alien.exitCode === null);
  alien.kill();
  await sleep(600);

  // 起一个真的，再停干净
  await ensureRunning({ port: PORT, dataDir: tmp, logFile: LOG });
  check('起了个真的', await isUp(PORT));
  const s2 = stopRunning(PORT);
  check('停掉了 1 个', s2.stopped === 1, JSON.stringify(s2));
  await sleep(900);
  check('接口没了', (await isUp(PORT)) === false);
  check('端口空了', listeners(PORT).length === 0, listeners(PORT).join(','));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  try { stopRunning(PORT); } catch { /* 已经停了 */ }
  for (const c of spawned) { try { c.kill(); } catch { /* 已退 */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
