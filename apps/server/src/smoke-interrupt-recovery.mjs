/** 中断恢复验收：证明服务重启后，未完成步骤回到待办并自动续跑。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-recovery-'));
const root = process.cwd();
const dataDir = path.join(tmp, 'data');
const port = 18997;

function spawnServer(env = {}) {
  return execFileSync(process.execPath, ['apps/server/src/server.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      BANDI_DATA: dataDir,
      BANDI_PORT: String(port),
      BANDI_HOST: '127.0.0.1',
      BANDI_NO_BROWSER: '1',
      BANDI_RECOVERY_TEST: '1',
      ...env,
    },
  });
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('① 模拟重启：服务启动时存在一个“进行中”的流程步骤');
  const dbPath = path.join(dataDir, 'bandi.db');
  const dbInit = path.join(tmp, 'seed.mjs');
  fs.writeFileSync(dbInit, `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('${dbPath.replace(/\\/g, '\\\\')}');
db.exec(\`CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, templateId TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, currentStep INTEGER DEFAULT 0, threadId TEXT,
  intent TEXT, note TEXT, projectId TEXT, prRepo TEXT, prNumber INTEGER,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
); CREATE TABLE workflow_tasks (
  id TEXT PRIMARY KEY, runId TEXT NOT NULL, nodeId TEXT NOT NULL,
  nodeName TEXT NOT NULL, visit INTEGER DEFAULT 1, detail TEXT,
  assigneePersonaId TEXT, status TEXT, decision TEXT, note TEXT,
  result TEXT, conversationId TEXT, agentRunId TEXT, startedAt TEXT, endedAt TEXT
); CREATE TABLE workflow_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, steps TEXT, nodes TEXT,
  startNode TEXT, publishedAt TEXT, archivedAt TEXT, builtIn INTEGER,
  autonomous INTEGER, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);\`);
db.prepare("INSERT INTO workflow_runs VALUES ('wf-r', 't-r', '恢复验收', 'doing', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
db.prepare("INSERT INTO workflow_tasks (id, runId, nodeId, nodeName, visit, detail, status, startedAt) VALUES ('wt-r', 'wf-r', 'n1', '第一步', 1, '中断前任务', 'doing', ?)").run(new Date().toISOString());
db.close();
`, 'utf8');
  execFileSync(process.execPath, [dbInit], { encoding: 'utf8' });

  let log = '';
  try {
    log = spawnServer();
  } catch (err) {
    log = String(err?.stdout ?? '');
  }
  check('服务能启动', log.includes('班底平台：http://127.0.0.1:18997'));
  check('识别中断步骤', log.includes('[中断恢复] 找到 1 个上次中断的工作流任务'));
  check('恢复为待办', log.includes('[中断恢复] 已放回 1 个中断步骤，等待自动续跑'));
} catch (err) {
    check('服务启动不抛异常', false, String(err?.message ?? err));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n❌ ${failed} 项未通过` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
