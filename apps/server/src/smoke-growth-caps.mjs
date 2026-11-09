/**
 * smoke-growth-caps.mjs —— 数据增长封顶（2026-11-09）。
 *
 * 三处"按当前设计会无限涨"的补丁，各自钉住行为：
 *   ① 运行事件单条落库 ≤ 64 KB：超出的长字符串截断，**仍是合法 JSON**（重放 / SSE 靠它解析），
 *      type 这类短字段保留；`appendRunEvent` 的返回值就是落库那份（广播与库同源）。
 *   ② 同类拒绝聚合：同一 (IP, 动作, 原因) 在窗口内只落一行，窗口过后补一句"另有 N 次"；
 *      不同动作照常各记一行。窗口用 `BANDI_AUDIT_DENY_WINDOW_MS=80` 缩到毫秒级（只为测）。
 *   ③ 归档保留 1 个月：archive 表超期行删掉、1 个月内的留着；清理本身往主表留 `audit.prune` 痕。
 *
 * 隔离：临时数据目录 + 临时库，不起服务、不碰真实 data/。
 * 跑法：node apps/server/src/smoke-growth-caps.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-growth-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');
process.env.BANDI_AUDIT_DENY_WINDOW_MS = '80';

/*
 * ⚠️ 必须先设环境变量，再动态 import 会读 config 的模块（同 smoke-conversation-delete）：
 * `store/audit.mjs` 在模块求值时读聚合窗口，config 也是 —— 早于这里求值就会指到真库/默认窗口。
 */
const { dbPath } = await import('./config.mjs');
const store = await import('./store.mjs');

if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
  console.log(`✗ 临时库没生效：dbPath=${dbPath} 不在 ${tmp} 下 —— 拒绝继续（避免写进真库）`);
  process.exit(1);
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byteLen = (s) => Buffer.byteLength(s);

// 直查库：验的是事实，不是 store 的返回值
const raw = new DatabaseSync(dbPath);

try {
  console.log('① 运行事件单条 ≤ 64 KB（超了截断，仍是合法 JSON）');
  const dev = store.createPersona({ name: '封顶测试员', runtime: 'codex', cwd: tmp, instructions: '' });
  const conv = store.createConversation({ title: '增长封顶', personaId: dev.id });
  const run = store.createRun({ conversationId: conv.id, runtime: 'codex', personaId: dev.id });

  const bigEvt = {
    type: 'tool',
    name: 'command_execution',
    detail: { id: 'item_1', command: 'dir /s', aggregated_output: 'x'.repeat(200_000) },
  };
  const stored = store.appendRunEvent(run.id, 1, bigEvt);
  const saved = store.listRunEvents(run.id, 0);
  check('appendRunEvent 返回的就是落库那份（SSE 与库同源）', saved.length === 1 && saved[0].evt === stored);
  check('超限事件 ≤ 64 KB', byteLen(stored) <= store.RUN_EVENT_MAX_BYTES, `${byteLen(stored)} B`);
  let parsed = null;
  try { parsed = JSON.parse(stored); } catch { /* 下面看 parsed null */ }
  check('截断后仍是合法 JSON', !!parsed);
  check('type / name 这类短字段保留', parsed?.type === 'tool' && parsed?.name === 'command_execution');
  check('长输出带截断标记', String(parsed?.detail?.aggregated_output ?? '').includes('已截断'));

  // 字段多到压不下来 → 退成壳：至少还能看出"这是什么事件、被截了"
  const many = {};
  for (let i = 0; i < 500; i++) many[`k${i}`] = 'y'.repeat(300);
  const shell = store.appendRunEvent(run.id, 2, { type: 'raw', payload: many });
  const shellParsed = JSON.parse(shell);
  check('极端事件退成壳、仍合法且带原 type', shellParsed.type === 'raw' && shellParsed.truncated === true, `${byteLen(shell)} B`);

  const small = { type: 'text', text: '好' };
  check('小事件原样落库（一个字节都不多）', store.appendRunEvent(run.id, 3, small) === JSON.stringify(small));

  console.log('\n② 同类拒绝聚合（窗口 80ms，只为可测）');
  const denyRows = () => raw.prepare("SELECT action, reason FROM security_events WHERE kind='authz.deny' ORDER BY at, rowid").all();
  const info = { kind: 'authz.deny', action: 'GET /api/state', reason: 'HTTP 401', ip: '127.0.0.1', ua: 'smoke' };
  for (let i = 0; i < 4; i++) store.deny(info);
  check('窗口内 4 次同类 → 只落 1 行', denyRows().length === 1, `rows=${denyRows().length}`);
  await sleep(120);
  store.deny(info);
  const after = denyRows();
  check('窗口过后落第二行', after.length === 2, `rows=${after.length}`);
  check('第二行带「另有 3 次」', /另有 3 次/.test(after[1]?.reason ?? ''), after[1]?.reason);
  store.deny({ ...info, action: 'GET /api/me' });
  check('不同动作不合并', denyRows().length === 3, `rows=${denyRows().length}`);

  console.log('\n③ 归档保留 1 个月（启动时跑；这里直接调 pruneArchive）');
  const day = 86400_000;
  raw
    .prepare('INSERT INTO security_events_archive (id, at, kind, result) VALUES (?, ?, ?, ?)')
    .run('arc-old', new Date(Date.now() - 40 * day).toISOString(), 'authz.deny', 'deny');
  raw
    .prepare('INSERT INTO security_events_archive (id, at, kind, result) VALUES (?, ?, ?, ?)')
    .run('arc-new', new Date(Date.now() - 10 * day).toISOString(), 'write', 'ok');
  const pruned = store.pruneArchive();
  check('超 1 个月的归档行删掉（返回 1）', pruned === 1, `pruned=${pruned}`);
  check('1 个月内的归档行留着', raw.prepare("SELECT COUNT(*) AS n FROM security_events_archive WHERE id='arc-new'").get().n === 1);
  check('清理往主表留了 audit.prune 痕', raw.prepare("SELECT COUNT(*) AS n FROM security_events WHERE kind='audit.prune'").get().n === 1);
  check('再清理一次没有可删的（幂等）', store.pruneArchive() === 0);
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
} finally {
  try { raw.close(); } catch { /* 已关 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ 有 ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
