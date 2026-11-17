/**
 * **数据库迁移**的验收（2026-11-08 起；结构版本号机制落地当天补的第一条数据迁移）。
 *
 * 验的是 `store/db.mjs` 里那串"启动时跑一次"的迁移：**老库打开一次就该收到当前形态**，
 * 而且再打开一次什么都不该变（幂等）。现在钉的这条是结构版本 1→2：
 *
 *   回话消息的 `meta.progress`（历史"过程收起行"的快照）整体清掉。
 *   2026-11-08 该功能被砍（用户："感觉也没啥用"）：渲染层和写入端都删了，
 *   老库里的副本没有读者，留着只是让 meta 里多一层要人猜的历史层。
 *
 * 验四件事：
 *   ① 清理只动"有 progress"的行：`stopped` 等兄弟字段保留，坏 JSON / 空 meta 不碰；
 *   ② 清完只剩空对象 → meta 置 NULL（不留 `'{}'`）；
 *   ③ 版本号推到 SCHEMA_VERSION，日志报出清理条数；
 *   ④ 第二次启动不再打印迁移（幂等），新库启动也不打印。
 *
 * 隔离：临时数据目录 + 临时库，跑完全删。
 * 跑法：node apps/server/src/smoke-db-migration.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const DB_MODULE = pathToFileURL(path.join(repo, 'apps', 'server', 'src', 'store', 'db.mjs')).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-migrate-'));
const DB = path.join(tmp, 'bandi.db');
const FRESH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-migrate-fresh-'));
const FRESH_DB = path.join(FRESH_DIR, 'bandi.db');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/** 在子进程里打开一次库（= 一次启动），返回 { code, out, err } */
function bootOnce(dbPath, dataDir) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)});`], {
    cwd: repo,
    env: { ...process.env, BANDI_DATA: dataDir, BANDI_DB: dbPath, BANDI_HOST: '127.0.0.1' },
    encoding: 'utf8',
  });
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

const PROGRESS = JSON.stringify({
  status: 'done',
  intent: '',
  steps: [{ v: '运行命令', t: 'git describe --tags', ms: null, s: 'called' }],
  elapsedMs: 27000,
});

let TITLE_DIR = null; // ④ 独立库目录，提到 try 外好让 finally 收得到
try {
  /* 造一个"老库"：messages 表在、几行旧 meta 躺着。 */
  const pre = new DatabaseSync(DB);
  pre.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, runId TEXT, role TEXT NOT NULL,
      text TEXT NOT NULL, createdAt TEXT NOT NULL, personaId TEXT, atts TEXT, meta TEXT,
      senderUserId TEXT, taskId TEXT, parentId TEXT, note TEXT
    );
  `);
  const ins = pre.prepare('INSERT INTO messages (id, conversationId, role, text, createdAt, meta) VALUES (?, ?, ?, ?, ?, ?)');
  const T = '2026-11-08T00:00:00.000Z';
  ins.run('m1', 'c1', 'assistant', 'a', T, JSON.stringify({ stopped: true, progress: JSON.parse(PROGRESS) }));
  ins.run('m2', 'c1', 'assistant', 'b', T, JSON.stringify({ progress: JSON.parse(PROGRESS) }));
  ins.run('m3', 'c1', 'assistant', 'c', T, JSON.stringify({ progress: JSON.parse(PROGRESS), foo: 1 }));
  ins.run('m4', 'c1', 'assistant', 'd', T, JSON.stringify({ stopped: true }));
  ins.run('m5', 'c1', 'assistant', 'e', T, 'not json{');
  ins.run('m6', 'c1', 'assistant', 'f', T, null);
  pre.close();

  console.log('① 老库启动一次：清 progress、其余字段原样');

  /* 第一遍：本地 import 一次（等于启动），把迁移日志抓下来断言条数 */
  process.env.BANDI_DATA = tmp;
  process.env.BANDI_DB = DB;
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(' '));
  const mod = await import(DB_MODULE);
  console.log = origLog;
  const { SCHEMA_VERSION } = mod;

  const rows = Object.fromEntries(
    mod.db.prepare('SELECT id, meta FROM messages ORDER BY id').all().map((r) => [r.id, r.meta]),
  );
  const parse = (v) => (v == null ? null : JSON.parse(v));
  check('带 stopped 的行：progress 清掉、stopped 保留', JSON.stringify(parse(rows.m1)) === '{"stopped":true}', String(rows.m1));
  check('只有 progress 的行：meta 置 NULL（不留 {}）', rows.m2 === null, String(rows.m2));
  check('progress 之外的兄弟字段原样保留', JSON.stringify(parse(rows.m3)) === '{"foo":1}', String(rows.m3));
  check('没有 progress 的行一行不动', rows.m4 === '{"stopped":true}' && rows.m5 === 'not json{' && rows.m6 === null, `${rows.m4} / ${rows.m5} / ${rows.m6}`);
  check('日志报出清理条数（3 条）', logs.some((l) => /\[迁移\] 3 条回话消息清掉过程快照/.test(l)), logs.filter((l) => /迁移/.test(l)).join(' | '));
  check('库的结构版本推到 SCHEMA_VERSION', Number(mod.db.prepare('PRAGMA user_version').get().user_version) === SCHEMA_VERSION, `${mod.db.prepare('PRAGMA user_version').get().user_version} / ${SCHEMA_VERSION}`);

  console.log('\n② 再启动一次：幂等 —— 不重复清理、不重复打印');

  const second = bootOnce(DB, tmp);
  check('第二次启动成功', second.code === 0, second.err.slice(-200));
  check('第二次不再打印这条迁移', !/回话消息清掉过程快照/.test(second.out), second.out.slice(-300));
  const ro = new DatabaseSync(DB, { readOnly: true });
  check('数据跟第一次清完的那份一致', JSON.stringify(ro.prepare('SELECT id, meta FROM messages ORDER BY id').all().map((r) => [r.id, r.meta])) === JSON.stringify(Object.entries(rows).map(([id, meta]) => [id, meta])), '');
  ro.close();

  console.log('\n③ 新库启动：没东西可清，也不打印');

  const fresh = bootOnce(FRESH_DB, FRESH_DIR);
  check('新库启动成功', fresh.code === 0, fresh.err.slice(-200));
  check('新库不打印这条迁移', !/回话消息清掉过程快照/.test(fresh.out), fresh.out.slice(-300));
  const ro2 = new DatabaseSync(FRESH_DB, { readOnly: true });
  check('新库的结构版本也是 SCHEMA_VERSION', Number(ro2.prepare('PRAGMA user_version').get().user_version) === SCHEMA_VERSION, String(ro2.prepare('PRAGMA user_version').get().user_version));
  ro2.close();

  console.log('\n④ 自主交付旧名后缀：从存量标题里摘掉，别的括号不碰（幂等）');

  const OLD = '自主交付（自迭代，无人工拍板）';
  // 独立库：先让 db.mjs 自己建好完整表结构（手搓表会缺索引列），再插数据，再启动验迁移。
  TITLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-migrate-title-'));
  const TITLE_DB = path.join(TITLE_DIR, 'bandi.db');
  const seed = bootOnce(TITLE_DB, TITLE_DIR); // 只为建表
  check('独立库建表启动成功', seed.code === 0, seed.err.slice(-200));
  const TT = '2026-11-16T00:00:00.000Z';
  const pre2 = new DatabaseSync(TITLE_DB);
  // project_tasks 由 store/projects.mjs 建，db.mjs 启动不带它 —— 手搓一张够迁移用的
  pre2.exec('CREATE TABLE IF NOT EXISTS project_tasks (id TEXT PRIMARY KEY, projectId TEXT, title TEXT, status TEXT, createdAt TEXT, updatedAt TEXT)');
  // 直接按各表必填列插，保持简单明了
  pre2.prepare('INSERT INTO conversations (id, title, personaId, createdAt, updatedAt, kind) VALUES (?, ?, ?, ?, ?, ?)').run('c1', `${OLD}「班底」项目并排查设计漏洞`, '', TT, TT, 'group');
  pre2.prepare('INSERT INTO conversations (id, title, personaId, createdAt, updatedAt, kind) VALUES (?, ?, ?, ?, ?, ?)').run('c2', '自主交付（另一个括号不该动）项目', '', TT, TT, 'group'); // 不同文案，必须原样
  pre2.prepare('INSERT INTO workflow_runs (id, templateId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run('w1', 'bandi-self-delivery', `${OLD}「班底」项目`, TT, TT);
  pre2.prepare('INSERT INTO project_tasks (id, projectId, title, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'pj-x', `任务 · ${OLD} · 设计评审`, 'todo', TT, TT);
  pre2.prepare('INSERT INTO notices (id, kind, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run('n1', 'workflow.delivery.report', `流程 · ${OLD}`, TT, TT);
  pre2.close();

  const titlesBoot = bootOnce(TITLE_DB, TITLE_DIR);
  check('独立库启动成功', titlesBoot.code === 0, titlesBoot.err.slice(-200));
  const ro3 = new DatabaseSync(TITLE_DB, { readOnly: true });
  const got = (id, table) => ro3.prepare(`SELECT title FROM ${table} WHERE id = ?`).get(id)?.title;
  check('会话标题：旧名后缀摘掉，其余原样', got('c1', 'conversations') === '自主交付「班底」项目并排查设计漏洞', String(got('c1', 'conversations')));
  check('流程实例 / 卡 / 通知标题同样清理', got('w1', 'workflow_runs') === '自主交付「班底」项目' && got('p1', 'project_tasks') === '任务 · 自主交付 · 设计评审' && got('n1', 'notices') === '流程 · 自主交付', `${got('w1', 'workflow_runs')} / ${got('p1', 'project_tasks')} / ${got('n1', 'notices')}`);
  check('别的括号文案一根手指不碰', got('c2', 'conversations') === '自主交付（另一个括号不该动）项目', String(got('c2', 'conversations')));
  check('日志报出清理条数（4 条）', /\[迁移\] 4 条标题清掉/.test(titlesBoot.out), titlesBoot.out.split('\n').filter((l) => /迁移/.test(l)).join(' | '));
  ro3.close();
  const second2 = bootOnce(TITLE_DB, TITLE_DIR);
  check('再启动一次：不再打印这条迁移（幂等）', !/条标题清掉/.test(second2.out), second2.out.slice(-300));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  try { fs.rmSync(FRESH_DIR, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  if (TITLE_DIR) { try { fs.rmSync(TITLE_DIR, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ } }
}

console.log(`\n结论：${failed ? `${failed} 项没过` : '全通过'}`);
process.exit(failed ? 1 : 0);
