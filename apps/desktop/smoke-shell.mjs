/**
 * 桌面薄壳「Node 那一半」（`shell.mjs`）的验收。
 *
 * 它与 Rust 那半之间只有三行协议，所以必须钉死。验八件事：
 *   ① 没有控制面时：起一个，报 `READY <url> 1`（1 = 是我们起的）；
 *   ② 已经有控制面时：复用，报 `READY <url> 0`；
 *   ③ 收到 STOP 时，**还有别的窗口在用就不停** —— 这条最容易做错：
 *      壳一退，把另一个还开着的窗口的服务杀了（2026-10-22 实报的
 *      `ERR_CONNECTION_REFUSED` 就是它）—— 也可能反过来把用户命令行的实例杀掉；
 *   ④ **壳直接没了（stdin 关闭）**，自己起的那个也要收掉 —— 这是壳崩溃时的安全网；
 *   ⑤ 不指定端口时**自己挑**一个，并记进数据目录（桌面版没人关心端口，但不能撞别人）；
 *   ⑥ 探测起点被**别人的程序**占着时：跳过它换一个，而且**不碰人家**；
 *   ⑦ 再开一个壳：复用**自己**那一个，而不是在隔壁再起一个控制面；
 *   ⑧ 复用的那个，退出时不许停。
 *
 * 隔离：临时数据目录 + 临时端口。
 * 跑法：node apps/desktop/smoke-shell.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isUp, listeners, sleep } from '../server/src/lifecycle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.join(here, 'shell.mjs');
const PORT = Number(process.env.SMOKE_PORT ?? 8816);
const BASE = Number(process.env.SMOKE_BASE_PORT ?? 8821);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-shell-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const kids = [];
const spawned = [];

function startShell(extraEnv = {}) {
  const c = spawn(process.execPath, [SHELL], {
    env: { ...process.env, BANDI_DATA: tmp, BANDI_PORT: String(PORT), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  kids.push(c);
  const st = { child: c, out: '', err: '', protocol: [] };
  c.stdout.setEncoding('utf8');
  c.stderr.setEncoding('utf8');
  c.stdout.on('data', (d) => {
    st.out += d;
    for (const line of st.out.split('\n')) {
      if (line.startsWith('BANDI_SHELL ')) {
        const t = line.trim();
        if (st.protocol.at(-1) !== t) st.protocol.push(t);
      }
    }
  });
  c.stderr.on('data', (d) => (st.err += d));
  st.exited = new Promise((r) => c.on('exit', (code) => r(code)));
  return st;
}

const waitFor = async (st, pred, ms = 25000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred(st)) return true;
    await sleep(150);
  }
  return false;
};

const readyOf = (st) => st.protocol.find((l) => l.startsWith('BANDI_SHELL READY ')) ?? null;
/** 协议行里的 URL **不带尾斜杠**（就是 urlOf(port) 的原样），后面跟一个空格再接标记 */
const onPort = (line, port) => !!line && line.includes(`:${port} `);

let a = null;
let f = null;
let alien = null;
try {
  console.log('① 没有控制面时：起一个，并标明"是我们起的"');
  a = startShell();
  if (!(await waitFor(a, (s) => !!readyOf(s)))) throw new Error('壳 A 没报 READY：' + a.err.slice(-400));
  const ra = readyOf(a);
  check('协议行格式对', /^BANDI_SHELL READY http:\/\/127\.0\.0\.1:\d+ [01]$/.test(ra), ra);
  check('末尾标记 = 1（我们起的，退出要收）', ra.endsWith(' 1'), ra);
  check('控制面真的活着', await isUp(PORT));
  check('它把数据目录落在指定的地方', fs.existsSync(path.join(tmp, 'bandi.db')), tmp);

  console.log('\n② 已经有控制面时：复用，标明"不是我们起的"');
  const b = startShell();
  if (!(await waitFor(b, (s) => !!readyOf(s)))) throw new Error('壳 B 没报 READY：' + b.err.slice(-400));
  const rb = readyOf(b);
  check('末尾标记 = 0（本来就在跑，退出不许停）', rb.endsWith(' 0'), rb);
  check('日志说清了"我是第 2 个窗口"，且收不收按"还有谁在用"算', /第 2 个窗口/.test(b.err), (b.err.match(/\[壳\].*已经在跑.*/) ?? [''])[0]);

  console.log('\n③ 给 B 发 STOP：**不许停**别人起的控制面');
  b.child.stdin.write('STOP\n');
  const codeB = await Promise.race([b.exited, sleep(8000).then(() => 'timeout')]);
  check('B 退出了', codeB !== 'timeout', String(codeB));
  await sleep(800);
  check('控制面**还活着**（这条错了就是"壳一退把用户的活服务杀了"）', await isUp(PORT));

  console.log('\n④ 给 A 发 STOP：它起的，就该收掉');
  a.child.stdin.write('STOP\n');
  const codeA = await Promise.race([a.exited, sleep(10000).then(() => 'timeout')]);
  check('A 退出了', codeA !== 'timeout', String(codeA));
  await sleep(1000);
  check('控制面停了', (await isUp(PORT)) === false);
  check('端口空了', listeners(PORT).length === 0, listeners(PORT).join(','));

  console.log('\n⑤ 壳**直接没了**（stdin 关闭）也要收摊 —— 壳崩溃时的安全网');
  const d = startShell();
  if (!(await waitFor(d, (s) => !!readyOf(s)))) throw new Error('壳 D 没报 READY：' + d.err.slice(-400));
  check('D 起来了并有控制面', (await isUp(PORT)) === true);
  d.child.stdin.end(); // 模拟壳进程消失
  const codeD = await Promise.race([d.exited, sleep(10000).then(() => 'timeout')]);
  check('D 自己退出了', codeD !== 'timeout', String(codeD));
  await sleep(1000);
  check('它起的控制面被收掉了', (await isUp(PORT)) === false);

  /* -------------------------------------------- 自己挑端口（BANDI_PORT 不指定） */

  console.log('\n⑥ 不指定端口时：**自己挑**一个，并且记下来');
  const noPort = { BANDI_PORT: '', BANDI_PORT_BASE: String(BASE) }; // 空 = 没指定
  const portFile = path.join(tmp, 'port');
  fs.rmSync(portFile, { force: true }); // 先清掉，保证是"第一次"的样子
  const e = startShell(noPort);
  if (!(await waitFor(e, (s) => !!readyOf(s)))) throw new Error('壳 E 没报 READY：' + e.err.slice(-400));
  const re = readyOf(e);
  check('挑到了探测起点 ' + BASE, onPort(re, BASE), re);
  check('标明是"我们起的"', re.endsWith(' 1'), re);
  check('控制面在这个端口上活着', await isUp(BASE));
  check('端口记进了数据目录', fs.readFileSync(portFile, 'utf8').trim() === String(BASE), fs.readFileSync(portFile, 'utf8').trim());
  e.child.stdin.write('STOP\n');
  await Promise.race([e.exited, sleep(8000)]);
  await sleep(900);

  console.log('\n⑦ 起点被**别人的程序**占着：跳过它换个端口，而且不碰人家');
  alien = spawn(
    process.execPath,
    ['-e', `require('http').createServer((q,s)=>s.end('not-bandi')).listen(${BASE})`],
    { stdio: 'ignore', windowsHide: true },
  );
  spawned.push(alien);
  await sleep(900);
  check('别人的程序占住了起点', listeners(BASE).includes(alien.pid), listeners(BASE).join(','));
  f = startShell(noPort);
  if (!(await waitFor(f, (s) => !!readyOf(s)))) throw new Error('壳 F 没报 READY：' + f.err.slice(-400));
  const rf = readyOf(f);
  check('跳过 ' + BASE + '，选了下一位', onPort(rf, BASE + 1), rf);
  check('别人的程序**还活着**', alien.exitCode === null, 'exitCode=' + alien.exitCode);
  check('它还占着原端口', listeners(BASE).includes(alien.pid));

  console.log('\n⑧ 再开一个壳：复用**自己**那一个，而不是在隔壁再起一个');
  const g = startShell(noPort);
  if (!(await waitFor(g, (s) => !!readyOf(s)))) throw new Error('壳 G 没报 READY：' + g.err.slice(-400));
  check('复用了同一个端口', onPort(readyOf(g), BASE + 1), readyOf(g));
  check('标明"复用了已有的"（READY … 0）', readyOf(g).endsWith(' 0'), readyOf(g));
  g.child.stdin.write('STOP\n');
  await Promise.race([g.exited, sleep(8000)]);
  await sleep(800);
  check('G 退出后控制面还在（它是 F 起的）', await isUp(BASE + 1));
  f.child.stdin.write('STOP\n');
  await Promise.race([f.exited, sleep(8000)]);
  await sleep(1000);
  check('F 退出后它起的控制面被收掉了', (await isUp(BASE + 1)) === false);

  console.log('\n⑨ 环境退化（PATH 里没有 powershell）时，**照样要收掉自己起的进程**');
  /*
   * powershell 在 `System32\WindowsPowerShell\v1.0` 下，**不在 System32 本身** ——
   * 只留 System32 与 Windows 就能造出"读不到命令行"的情形。
   * 真踩过：那时按"端口上是谁"去收，判成外人 → 拒绝清理 → 留下孤儿控制面。
   */
  const barePort = PORT + 3;
  const h = startShell({ BANDI_PORT: String(barePort), PATH: 'C:\\Windows\\System32;C:\\Windows' });
  if (!(await waitFor(h, (s) => !!readyOf(s)))) throw new Error('壳 H 没报 READY：' + h.err.slice(-400));
  check('环境退化下也起来了', await isUp(barePort));
  h.child.stdin.end(); // 壳没了
  const codeH = await Promise.race([h.exited, sleep(10000).then(() => 'timeout')]);
  check('H 自己退出了', codeH !== 'timeout', String(codeH));
  await sleep(1200);
  check('它起的控制面被收掉了（靠 PID，不靠重新识别）', (await isUp(barePort)) === false);
  check(
    '日志说清了是"按记录处理"',
    /按记录处理|命令行核对过/.test(h.err),
    h.err.split('\n').filter((l) => l.includes('退出（')).pop() ?? '',
  );
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  for (const c of [...kids, ...spawned]) { try { c.kill(); } catch { /* 已退 */ } }
  await sleep(600);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
