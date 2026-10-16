/**
 * 模型级额度的验收（2026-10-15）—— 这个功能此前**没有任何用例覆盖**，
 * 而这次刚把它的 SQL 从 quota.mjs 收口进 store.mjs，所以补上。
 *
 * 验五件事：
 *   ① 额度能存能读，形状对（limitTokens / limitRuns / usedTokens / usedRuns / over）；
 *   ② **整表替换**语义：没提到的模型一律回到"不限制"（这是界面「保存」的含义，最容易做错）；
 *   ③ 不合法/留空/0 一律当"不限制"，不报错（界面上那就是清空一个输入框）；
 *   ④ 顶到上限时 `over` 给出一句人话；
 *   ⑤ v1 的「全站一行」老表能被迁移掉（重建），不让人以为限额还在。
 *
 * 隔离：临时数据目录 + 临时端口，跑完全删。
 * 跑法：node apps/server/src/smoke-quota.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from './config.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8806);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-quota-'));
const DB = path.join(tmp, 'bandi.db');
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

function start() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: DB },
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
      if ((await fetch(base + '/api/state', { signal: AbortSignal.timeout(800) })).ok) return true;
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

const BASE = `http://127.0.0.1:${PORT}`;
const getQuota = async () => (await fetch(BASE + '/api/quota')).json();
const postQuota = async (limits) => {
  const r = await fetch(BASE + '/api/quota', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limits }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const rowOf = (status, id) => (status.models ?? []).find((m) => m.id === id) ?? null;

let ctx = null;
try {
  /* ---- 先把一张 v1 形状的「全站额度」老表塞进去，验迁移 ---- */
  {
    const db = new DatabaseSync(DB);
    db.exec(`CREATE TABLE quotas (
               id           INTEGER PRIMARY KEY,
               dailyTokens  INTEGER,
               dailyRuns    INTEGER,
               updatedAt    TEXT
             )`);
    db.prepare('INSERT INTO quotas (id, dailyTokens, dailyRuns, updatedAt) VALUES (1, 500000, 50, ?)').run(
      new Date().toISOString(),
    );
    db.close();
  }

  ctx = start();
  if (!(await waitUp(BASE))) throw new Error('没起来：' + ctx.log().slice(-500));

  console.log('① v1 的「全站一行」老表被迁移掉，并且提醒了用户');
  check('迁移日志打出来了', /全站额度.*已丢弃/.test(ctx.log()), (ctx.log().match(/\[迁移\].*/) ?? ['(没有)'])[0]);
  const db2 = new DatabaseSync(DB);
  const cols = db2.prepare('PRAGMA table_info(quotas)').all().map((c) => c.name);
  db2.close();
  check('表重建成了模型级（有 model 列，没有 id 列）', cols.includes('model') && !cols.includes('id'), cols.join(','));

  console.log('\n② 存进去、读出来，形状对');
  const saved = await postQuota({ 'model-a': { dailyTokens: 12000, dailyRuns: 7 } });
  check('保存返回 200', saved.status === 200, String(saved.status));
  const a = rowOf(saved.body, 'model-a');
  check('限额读回来了', a?.limitTokens === 12000 && a?.limitRuns === 7, JSON.stringify(a && { t: a.limitTokens, r: a.limitRuns }));
  check('今天还没跑过：用量 0', a?.usedTokens === 0 && a?.usedRuns === 0, `${a?.usedTokens}/${a?.usedRuns}`);
  check('没超：over 是空', a?.over === null, String(a?.over));
  check('数字给人看的形态也给了', a?.limitText === '1.2 万', String(a?.limitText));
  check('认不出模型的那个桶单独摆着', saved.body?.unattributed?.tokens === 0, JSON.stringify(saved.body?.unattributed));

  console.log('\n③ 整表替换：没提到的模型一律回到「不限制」');
  const replaced = await postQuota({ 'model-b': { dailyTokens: 100 } });
  check('model-a 的限额没了', rowOf(replaced.body, 'model-a') === null, JSON.stringify(rowOf(replaced.body, 'model-a')));
  check('model-b 有了', rowOf(replaced.body, 'model-b')?.limitTokens === 100);

  console.log('\n④ 不合法 / 留空 / 0 一律当「不限制」，不报错');
  const junk = await postQuota({
    'model-c': { dailyTokens: 0, dailyRuns: -5 },
    'model-d': { dailyTokens: 'abc', dailyRuns: null },
    '  ': { dailyTokens: 999 }, // 空 id 不该建出一行
  });
  check('请求没被拒（200）', junk.status === 200, String(junk.status));
  check('0 与负数 → 不占行', rowOf(junk.body, 'model-c') === null);
  check('非数字与空 → 不占行', rowOf(junk.body, 'model-d') === null);
  check('空 id 没建出行', !(junk.body?.models ?? []).some((m) => m.id === ''), JSON.stringify((junk.body?.models ?? []).map((m) => m.id)));

  console.log('\n⑤ 顶到上限就给一句人话');
  /*
   * 两种"不限制"要分开看，因为落库形状不同（跟重构前一致，别改语义）：
   *   · 显式填 0        → 化成 null → 两个都是 null → **不占行**
   *   · 填个小于 1 的数  → 取整成 0 → **会占一行**，但 0 在判超时是 falsy，等于不限制
   * 只要"不会误拦"，两种都对；错的是把它当成"有额度"。
   */
  await postQuota({ 'model-g': { dailyTokens: 0, dailyRuns: 0 } });
  check('显式填 0 → 不占行（当成不限制）', rowOf(await getQuota(), 'model-g') === null);
  await postQuota({ 'model-e': { dailyRuns: 0.4 } });
  const e = rowOf(await getQuota(), 'model-e');
  check('小于 1 的次数取整成 0，且不会被当成"有额度"去拦', e === null || (e.limitRuns === 0 && e.over === null), JSON.stringify(e));

  // 直接写一行今天的运行，验"用量算进 over 里"
  const ins = await fetch(BASE + '/api/personas', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '额度验收员', instructions: '', runtime: 'codex' }),
  });
  check('造一个员工以便有真实运行行', ins.status === 201);
  const db3 = new DatabaseSync(DB);
  db3.prepare("INSERT INTO runs (id, conversationId, runtime, model, status, startedAt) VALUES ('r-q','c-q','codex','model-f','完成',?)")
    .run(new Date().toISOString());
  db3.close();
  await postQuota({ 'model-f': { dailyRuns: 1 } });
  const overStatus = await getQuota();
  const f = rowOf(overStatus, 'model-f');
  check('今天的运行被算进了模型账里', f?.usedRuns === 1, String(f?.usedRuns));
  check('到顶了：over 给出一句话', typeof f?.over === 'string' && f.over.length > 0, String(f?.over));
  check('那句话说明了是次数用完了', /次数/.test(String(f?.over ?? '')), String(f?.over));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  await stop(ctx);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
