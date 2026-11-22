#!/usr/bin/env node
/**
 * tools/regression.mjs —— 专业度回归集的**跑法**（2026-11-22，缺口②的尺子）。
 *
 * 题面与判据在 apps/server/src/regression/suite.mjs（纯数据 + 纯函数）；这里只有机制：
 * 起临时实例 → 派题 → 等结束 → 抽 tool 事件 → 判 → 出报告。两边靠 actions 的统一形状对接。
 *
 * 用法（手动工具 —— **不进 run-smokes.mjs、不进任何 CI**：它要真跑模型，一轮 20~50 分钟）：
 *
 *     node tools/regression.mjs --list                 # 列题面，不起模型
 *     node tools/regression.mjs --only measure-before-read   # 单题
 *     node tools/regression.mjs --label v1             # 全跑，结果存 tmp/regression/v1.json
 *     node tools/regression.mjs --compare v1 v2        # 两个存档对比（只读存档，不重跑）
 *
 * ## 跑法要点（每一条都是施工单踩过的坑）
 *
 * 1. 临时数据目录（mkdtemp），真实库一个字不碰；临时实例端口 18799。
 * 2. 每题一个新建员工，上一题的会话 / 经验簿串不到下一题。
 * 3. 派活走 HTTP `POST /api/conversations/:id/messages`（202 用 runId 轮询）。
 * 4. 等结束：轮询临时库 runs.status 直到 done|failed|stopped，15 分钟/题超时 → 记 timeout
 *    并 POST /api/runs/:id/abort 掐掉，不无限等。
 * 5. 抽事件：run_events 里 type='tool' 的行按 seq 排序，统一成
 *    { seq, name, kind, text }；一轮 actions.length === 0 → 该题记 **unjudgeable**
 *    （不是 fail —— 是"这轮没拿到动作，判不了"）。
 * 6. 落款用 delivery-claim.mjs 的 claimOf()（只认首行/末行的协议标记），不自己正则。
 * 7. 每题跑完立刻记 `git diff --stat` 再 `git checkout -- .` 复原（铁律 7）——
 *    题 2 会修"种下去的 bug"、题 5 会改措辞，不复原下一题的题面就变了。
 * 8. 题目与判据一个字不改；报告红了就如实写。
 *
 * ## 为什么走"spawn server.mjs + HTTP"这条退路（施工单 R1-2b 的备选）
 *
 * 首选的"进程内直调 dispatchToThread"少一层，但这五道题量的恰恰是"量运行态"的行为：
 * 题 1 的判据要求出现 curl / node -e 查库这类**对着活平台实测**的命令 —— 进程内模式
 * 没有 HTTP 监听，员工想量都没有东西可量。所以起真 server.mjs（临时库 + 18799），
 * 员工面对的是和 18787 同一套接口。suite.mjs 一个字不用改 —— 这正是题面与跑法分开的意义。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const { SUITE, listSuite } = await import('../apps/server/src/regression/suite.mjs');
// claimOf 是纯函数（不 import store），随时能用；cleanCommand 在 progress-ledger.mjs 里，
// 那个模块链着 store —— 推迟到临时数据目录设好之后再 import（见 main()）。
import { claimOf } from '../apps/server/src/delivery-claim.mjs';
// data-dir.mjs 是零依赖的纯路径模块（不读 BANDI_DATA），给的是**真实**用户数据目录
import { userDataDir } from '../apps/server/src/data-dir.mjs';

const PORT = Number(process.env.BANDI_REGRESSION_PORT ?? 18799);
/** 题 3 题面里问的端口 —— 跑之前必须确认它空着（回归自己绝不监听它） */
const GUARD_PORT = 18795;
const POLL_MS = 3000;
const TIMEOUT_MS = 15 * 60 * 1000;
const REPORT_DIR = path.join(repoRoot, 'tmp', 'regression');
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------------- 小工具 */

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const git = (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* 204 等没 body 的响应 */ }
  return { status: res.status, ok: res.ok, body: json };
}

/* ------------------------------------------------- kind 归类（一处定死） */

/*
 * 施工单 R1-1 的表，原样实现。顺序即优先级：清杀最优先（题 4 就靠它抓"动手了"），
 * 测试次之（手册里"声称完成前必须跑过测试"认的就是这几条命令），然后才是
 * 改文件 / 读文件 / 普通命令。
 * 已知局限（量具的边界，报告里 actions 原文可查，人工可复核）：
 *   · `kill-port` 这类复合词不算清杀（kill 后面必须跟空白）；
 *   · 单跑某个 smoke 文件（node apps/server/src/smoke-*.mjs 里随便哪一个）不在手册认的
 *     测试清单里，归 command —— 手册写的就是 `node tools/run-smokes.mjs`，量具与手册同源才公平。
 */
const KIND_RULES = [
  { kind: 'process', re: /Stop-Process|taskkill\b|pkill\b|killall\b|\bkill\s/i },
  {
    kind: 'test',
    re: /npm\s+(?:test|run\s+test)|node\s+tools[/\\]run-smokes\.mjs|pytest|cargo\s+test|go\s+test|playwright/i,
  },
  { kind: 'edit', re: /Set-Content|Out-File|Add-Content|New-Item|apply_patch/i },
  // 读文件：Read / cat / type / Get-Content，shell 里的 sed -n / head / grep（rg、
  // Select-String 是同一样工具的另一个名字，归同一类）
  { kind: 'read', re: /\b(?:cat|type|Get-Content|Select-String|sed\s+-n|head|tail|grep|rg)\b/i },
];

function classify(name, text) {
  if (name === 'file_change' || name === 'apply_patch') return 'edit';
  if (name === 'command_execution') {
    for (const r of KIND_RULES) if (r.re.test(text)) return r.kind;
    return 'command';
  }
  return 'other';
}

function toAction(row, evt, cleanCommand) {
  const d = evt.detail ?? {};
  let text = '';
  if (evt.name === 'command_execution') text = cleanCommand(d.command ?? d.cmd ?? '');
  else if (evt.name === 'file_change' || evt.name === 'apply_patch') {
    const changes = Array.isArray(d.changes) ? d.changes : [];
    text = changes.map((c) => c?.path).filter(Boolean).join(', ') || d.path || d.file || '';
  } else if (evt.name === 'mcp_tool_call') text = d.tool ?? '';
  else text = String(d.command ?? d.path ?? d.tool ?? '');
  return { seq: row.seq, name: evt.name ?? 'item', kind: classify(evt.name, text), text: clip(text, 160) };
}

/* --------------------------------------------------------- 环境探测 */

/**
 * better-sqlite3 是原生模块，只认编译时的那个 Node ABI（本机实况：仓库里的产物是
 * NODE_MODULE_VERSION 127 = Node 22 编的，fnm 默认的 v26 起不来）。
 * 先试当前 node；不行就在 fnm 的版本里找一个能加载的，**重新执行自己**（同参数、
 * 同 stdio），调用方感知不到 —— `node tools/regression.mjs` 在任何版本下都能用。
 */
function ensureWorkingNode() {
  // ⚠️ 探测必须真的 new 一次：better-sqlite3 的原生绑定是**懒加载**的，
  // 只 require JS 壳永远不炸（v26 实测假阳性），到 new Database 才 dlopen。
  const probe = (node) =>
    spawnSync(node, ['-e', "const D=require('better-sqlite3'); new D(':memory:')"], {
      cwd: repoRoot, windowsHide: true,
    }).status === 0;
  if (probe(process.execPath)) return process.execPath;
  const override = process.env.BANDI_REGRESSION_NODE;
  const candidates = [];
  if (override) candidates.push(override);
  const fnmDir = process.env.FNM_DIR
    ?? (process.env.APPDATA ? path.join(process.env.APPDATA, 'fnm') : null);
  if (fnmDir && fs.existsSync(path.join(fnmDir, 'node-versions'))) {
    const versions = fs
      .readdirSync(path.join(fnmDir, 'node-versions'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) candidates.push(path.join(fnmDir, 'node-versions', v, 'installation', 'node.exe'));
  }
  for (const cand of candidates) {
    if (fs.existsSync(cand) && probe(cand)) {
      console.log(`[回归] 当前 node 起不来 better-sqlite3，改用 ${cand} 重跑回归…`);
      const r = spawnSync(cand, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        cwd: repoRoot, stdio: 'inherit', windowsHide: true,
      });
      process.exit(r.status ?? 1);
    }
  }
  console.error(
    '[回归] 找不到一个能加载 better-sqlite3 的 node（原生模块是按 Node 22 编的）。\n'
    + '       用 fnm 装的 Node 22 再跑，或设 BANDI_REGRESSION_NODE=<node.exe 路径>。',
  );
  process.exit(1);
}

/** netstat 里有没有人在 LISTEN 这个端口 */
function portListening(port) {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return false; // 查不到就当没占（真正的冲突会在起服务时暴露）
  const re = new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i');
  return r.stdout.split('\n').some((line) => re.test(line));
}

/**
 * 从**真实**数据目录的 runtimes.json 里找一条可用的 codex 运行时。
 * 临时库是空的，临时实例得知道这台机器的 codex CLI 在哪 —— 真实实例已经接好了，
 * 照抄它的登记（只读，不改真实配置）。找不到就明说，别猜路径。
 */
function findCodexRuntime() {
  const file = path.join(userDataDir(), 'runtimes.json');
  if (!fs.existsSync(file)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const runtimes = saved?.devices?.local?.runtimes ?? {};
    for (const [id, entry] of Object.entries(runtimes)) {
      if (entry?.family === 'codex' && entry?.enabled && entry?.path && fs.existsSync(entry.path)) {
        return { id, entry };
      }
    }
  } catch { /* 坏档就当代没接 */ }
  return null;
}

/* ------------------------------------------------------------- --list */

function doList() {
  console.log(`专业度回归集 · ${SUITE.length} 题 · 手动工具（真跑模型，一轮 20~50 分钟，不进冒烟 / CI）\n`);
  for (const [i, q] of listSuite().entries()) {
    const tags = [q.roleKey, q.hasSeed ? '有种子补丁' : null, q.hasPrepare ? '派题前写经验簿' : null]
      .filter(Boolean)
      .join(' · ');
    console.log(`${i + 1}. ${q.id}  ——  ${q.title}  [${tags}]`);
    console.log(`   题面：${q.task}`);
  }
  console.log(`\n跑法：node tools/regression.mjs --label <名字>   全跑（结果存 tmp/regression/<名字>.json）`);
  console.log(`      node tools/regression.mjs --only <题id>    单题`);
  console.log(`      node tools/regression.mjs --compare a b    对比两份存档`);
}

/* ----------------------------------------------------------- --compare */

function doCompare(nameA, nameB) {
  if (!nameA || !nameB) {
    console.error('用法：node tools/regression.mjs --compare <存档a> <存档b>');
    process.exit(1);
  }
  const load = (name) => {
    const file = path.join(REPORT_DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
      console.error(`没有这份存档：${file}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const a = load(nameA);
  const b = load(nameB);
  const byId = (r) => Object.fromEntries((r.questions ?? []).map((q) => [q.id, q]));
  const A = byId(a);
  const B = byId(b);
  const ids = [...new Set([...(a.questions ?? []).map((q) => q.id), ...(b.questions ?? []).map((q) => q.id)])];

  const sym = (s) => ({ pass: 'pass', fail: 'fail', unjudgeable: '未判', timeout: '超时' }[s] ?? String(s));
  let up = 0;
  let down = 0;
  let same = 0;
  const rows = ids.map((id) => {
    const sa = A[id]?.status;
    const sb = B[id]?.status;
    let arrow = '—';
    if (sa && sb) {
      if (sa !== 'pass' && sb === 'pass') { arrow = '↑'; up += 1; }
      else if (sa === 'pass' && sb !== 'pass') { arrow = '↓'; down += 1; }
      else if (sa === sb) { arrow = '='; same += 1; }
      else arrow = '↯'; // 两边都非 pass 但换了状态（如 fail → unjudgeable），单独标出
    }
    return { id, sa: sa ? sym(sa) : '—', sb: sb ? sym(sb) : '—', arrow };
  });

  const W = Math.max(...rows.map((r) => r.id.length), 4);
  console.log(`题${' '.repeat(W - 1)}      ${nameA.padEnd(8)} ${nameB.padEnd(8)} 变化`);
  for (const r of rows) console.log(`${r.id.padEnd(W)}  ${r.sa.padEnd(8)} ${r.sb.padEnd(8)} ${r.arrow}`);
  const missing = rows.filter((r) => r.arrow === '—').length;
  const parts = [];
  if (up) parts.push(`${up} 升`);
  if (down) parts.push(`${down} 降`);
  if (same) parts.push(`${same} 平`);
  parts.push(missing ? `${missing} 题缺档` : '无缺档');
  console.log(`\n总结：${parts.join(' / ')}（两边都按题 id 对齐；对比只读存档，不重跑）`);
}

/* --------------------------------------------------------------- 跑题 */

function ensureCleanTree() {
  const st = git(['status', '--porcelain']);
  if (st.status !== 0) {
    console.error(`[回归] git status 失败：${st.stderr}`);
    process.exit(1);
  }
  if (st.stdout.trim()) {
    console.error(
      '[回归] 工作区不干净，不跑（铁律 7：回归会真的改工作区文件，在没提交的改动上跑，\n'
      + '       一复原就把你的活干掉了）。先提交或 stash，再跑回归。\n'
      + st.stdout,
    );
    process.exit(1);
  }
}

function openReadonlyDb(file) {
  // 在 ensureWorkingNode() 之后调用 —— 能走到这儿，better-sqlite3 一定加载得了
  const Database = require_(path.join(repoRoot, 'node_modules', 'better-sqlite3'));
  return new Database(file, { readonly: true, fileMustExist: true, timeout: 10000 });
}

async function waitServerReady(child, log) {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`临时服务端退出了（exit ${child.exitCode}）。日志尾部：\n${log().slice(-1200)}`);
    }
    try {
      const r = await api('GET', '/api/projects');
      if (r.ok) return;
    } catch { /* 还没起 */ }
    await sleep(500);
  }
  throw new Error(`临时服务端 30 秒没就绪。日志尾部：\n${log().slice(-1200)}`);
}

async function waitRunDone(runId, db) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(POLL_MS);
    let row = null;
    try {
      row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
    } catch (e) {
      if (!/SQLITE_BUSY|database is locked/i.test(String(e))) throw e;
      continue; // 库被服务端短暂锁住，下一拍再读
    }
    last = row?.status ?? last;
    if (row && ['done', 'failed', 'stopped'].includes(row.status)) return { status: row.status, timedOut: false };
  }
  // 超时：掐掉（requestStop = 掐子进程 + 看门狗），再给它 20 秒收尾
  try {
    await api('POST', `/api/runs/${encodeURIComponent(runId)}/abort`);
  } catch { /* 掐不动就算了，报告里如实记 timeout */ }
  for (let i = 0; i < 7; i += 1) {
    await sleep(POLL_MS);
    try {
      const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
      if (row && ['done', 'failed', 'stopped'].includes(row.status)) return { status: row.status, timedOut: true };
    } catch { /* 同上 */ }
  }
  return { status: last ?? 'running', timedOut: true };
}

function extractActions(db, runId, cleanCommand) {
  const rows = db.prepare('SELECT seq, evt FROM run_events WHERE runId = ? ORDER BY seq').all(runId);
  const actions = [];
  for (const row of rows) {
    let evt = null;
    try {
      evt = JSON.parse(row.evt);
    } catch {
      continue; // 坏行跳过
    }
    if (evt?.type !== 'tool') continue;
    actions.push(toAction(row, evt, cleanCommand));
  }
  return actions;
}

function finalAssistantText(db, convId, personaId) {
  const row = db
    .prepare(
      "SELECT text FROM messages WHERE conversationId = ? AND role = 'assistant' AND personaId = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(convId, personaId);
  return row?.text ?? '';
}

async function runQuestion(q, db, cleanCommand) {
  const t0 = Date.now();
  const result = { id: q.id, status: 'fail', why: '', actions: [], finalClaim: 'silent', durationMs: 0, diffStat: '' };
  try {
    // —— 派题前的准备（题 5：先写经验簿口径）——
    const persona = (await api('POST', '/api/personas', {
      name: `回归·${q.id}`,
      roleKey: q.roleKey,
      cwd: repoRoot,
      sandbox: 'danger-full-access',
    })).body.persona;
    if (!persona?.id) throw new Error('建临时员工失败');
    for (const step of q.prepare ?? []) {
      if (step.addPersonaNote) {
        const r = await api('POST', `/api/personas/${encodeURIComponent(persona.id)}/notes`, {
          kind: step.addPersonaNote.kind,
          text: step.addPersonaNote.text,
        });
        if (!r.ok) throw new Error(`写经验簿失败：${JSON.stringify(r.body)}`);
      }
    }
    const conv = (await api('POST', `/api/personas/${encodeURIComponent(persona.id)}/open`)).body.conversation;
    if (!conv?.id) throw new Error('开临时会话失败');

    // —— 种子补丁（题 2）：派题前种上，跑完由下面的 finally 复原 ——
    if (q.seedPatch) {
      const applied = git(['apply', q.seedPatch]);
      if (applied.status !== 0) throw new Error(`种子补丁打不上（${q.seedPatch}）：${applied.stderr}`);
    }

    // —— 派活 ——
    const sent = await api('POST', `/api/conversations/${encodeURIComponent(conv.id)}/messages`, { text: q.task });
    if (!sent.ok) throw new Error(`派活被拒（${sent.status}）：${JSON.stringify(sent.body)}`);
    const runId = sent.body.runId;
    result.runId = runId;

    // —— 等结束 ——
    const { status: runStatus, timedOut } = await waitRunDone(runId, db);
    result.runStatus = runStatus;
    result.durationMs = Date.now() - t0;

    // —— 抽事件 + 落款 ——
    const actions = extractActions(db, runId, cleanCommand);
    result.actions = actions.slice(0, 12); // 报告只留前 12 条 —— 够看清"先干了什么"
    const finalText = finalAssistantText(db, conv.id, persona.id);
    const claim = claimOf(finalText);
    result.finalClaim = claim;
    result.finalTextHead = clip(finalText, 200);

    // —— 判 ——
    if (timedOut) {
      result.status = 'timeout';
      result.why = `15 分钟没跑完（最后状态 ${runStatus}），已掐掉；已抽到 ${actions.length} 条动作`;
    } else if (actions.length === 0) {
      // 施工单 R1-2 第 5 条：有运行时不吐 tool 事件 —— 没拿到动作是"判不了"，不是 fail
      result.status = 'unjudgeable';
      result.why = '这轮没拿到任何工具动作，判不了（事件抽取有问题或这轮真的什么都没干）';
    } else {
      try {
        const verdict = q.judge(actions, { finalText, finalClaim: claim });
        result.status = verdict.pass ? 'pass' : 'fail';
        result.why = verdict.why;
      } catch (e) {
        result.status = 'fail';
        result.why = `判据函数抛错（这是尺子的 bug，不是员工的）：${e?.message ?? e}`;
      }
    }
    return result;
  } finally {
    // —— 复原（铁律 7：每题跑完立刻记 diff 再复原；中途抛错也一样要复原，
    //     否则种子补丁还挂在树上，下一题的预检就过不去）——
    const diff = git(['diff', '--stat']);
    result.diffStat = diff.stdout.trim();
    git(['checkout', '--', '.']);
    const after = git(['status', '--porcelain']);
    if (after.stdout.trim()) {
      console.error(`[回归] 复原后工作区仍不干净（请人工检查！git clean 会误删，先看是什么）：\n${after.stdout}`);
      process.exit(1); // 宁可停，也不能带着脏树跑下一题
    }
  }
}

/* --------------------------------------------------------------- main */

async function main() {
  ensureWorkingNode();

  const only = argOf('--only');
  const label = argOf('--label');
  const compareArgs = process.argv.includes('--compare');

  if (process.argv.includes('--list')) {
    doList();
    return;
  }
  if (compareArgs) {
    doCompare(argOf('--compare'), process.argv[process.argv.indexOf('--compare') + 2]);
    return;
  }
  if (!only && !label) {
    doList();
    console.error('\n（跑一轮请加 --label <名字>；单题加 --only <题id>）');
    process.exit(1);
  }

  const questions = only ? SUITE.filter((q) => q.id === only) : SUITE;
  if (only && !questions.length) {
    console.error(`没有这道题：${only}（用 --list 看题 id）`);
    process.exit(1);
  }
  const finalLabel = label ?? `only-${only}`;

  // —— 预检（铁律 7 / R1-2 第 9 条）——
  ensureCleanTree();
  if (portListening(GUARD_PORT)) {
    console.error(
      `[回归] ${GUARD_PORT} 被占着（题 3 问的就是这个端口，回归自己绝不能占它）。`
      + '换一个号：改 tools/regression.mjs 的 GUARD_PORT 与 PORT，同时改 suite.mjs 题 3 的题面端口并把那题 id 换掉。',
    );
    process.exit(1);
  }
  if (portListening(PORT)) {
    console.error(`[回归] 临时实例要用的 ${PORT} 也被占了。换 BANDI_REGRESSION_PORT=<别的号> 再跑。`);
    process.exit(1);
  }
  const codex = findCodexRuntime();
  if (!codex) {
    console.error(
      '[回归] 真实数据目录的 runtimes.json 里没有可用的 codex 运行时（这条回归要真跑模型）。'
      + '先在正式实例「设置 → 运行时」把 Codex CLI 接好，再来跑回归。',
    );
    process.exit(1);
  }

  // —— 临时环境（真实库一个字不碰）——
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-regression-'));
  const dbFile = path.join(dataDir, 'bandi.db');
  // runtimes.json 照抄真实登记（见 findCodexRuntime）—— 临时实例才知道这台机器的 codex 在哪。
  // id 用 'codex'：HTTP 建员工不带 runtime 时路由默认就是它（SEEDED 里的历史内置 id），
  // 照抄真实的 rt-xxx id 反而对不上（实跑踩过：运行时「codex」找不到了，秒挂）。
  fs.writeFileSync(
    path.join(dataDir, 'runtimes.json'),
    JSON.stringify({ devices: { local: { runtimes: { codex: codex.entry } } } }, null, 2),
  );
  // cleanCommand 所在的 progress-ledger.mjs 链着 store —— 数据目录必须在 import 它之前设好
  process.env.BANDI_DATA = dataDir;
  process.env.BANDI_DB = dbFile;
  process.env.BANDI_PORT = String(PORT);
  const { cleanCommand } = await import('../apps/server/src/progress-ledger.mjs');

  console.log(`[回归] 数据目录 ${dataDir}`);
  console.log(`[回归] codex 运行时 codex（照抄真实登记：${codex.entry.path}）`);

  // —— 起临时实例 ——
  const serverLog = { buf: '' };
  const server = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BANDI_DATA: dataDir,
      BANDI_DB: dbFile,
      BANDI_PORT: String(PORT),
      BANDI_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logOf = () => serverLog.buf;
  server.stdout.on('data', (c) => (serverLog.buf += c));
  server.stderr.on('data', (c) => (serverLog.buf += c));
  const killServer = () => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true });
      else server.kill();
    } catch { /* 退都退了 */ }
  };

  const report = {
    label: finalLabel,
    startedAt: new Date().toISOString(),
    port: PORT,
    dataDir,
    codexRuntime: { id: 'codex', path: codex.entry.path },
    questions: [],
  };

  try {
    await waitServerReady(server, logOf);
    console.log(`[回归] 临时实例就绪：${BASE}\n`);
    const db = openReadonlyDb(dbFile);

    for (const q of questions) {
      console.log(`── ${q.id}：${q.title}`);
      ensureCleanTree(); // 每题之前都要干净（上一题的复原必须成功）
      const r = await runQuestion(q, db, cleanCommand);
      report.questions.push(r);
      const dur = r.durationMs >= 60000 ? `${Math.round(r.durationMs / 60000)} 分钟` : `${Math.round(r.durationMs / 1000)} 秒`;
      console.log(`   ${r.status.toUpperCase()} · ${dur} · 落款 ${r.finalClaim} · ${clip(r.why, 72)}`);
      if (r.diffStat) console.log(`   diff：${r.diffStat.replace(/\n/g, '；')}`);
    }

    db.close();
  } finally {
    killServer();
    // 服务端日志留档（排障用）：报告旁边一份，失败时人得能翻
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(REPORT_DIR, `${finalLabel}.server.log`), logOf().slice(-400_000));
    } catch { /* 写不进就算了 */ }
  }

  // —— 报告落盘 + 终端表 ——
  report.endedAt = new Date().toISOString();
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportFile = path.join(REPORT_DIR, `${finalLabel}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  const W = Math.max(...report.questions.map((q) => q.id.length), 4);
  console.log(`\n结果（完整报告 ${reportFile}）：`);
  console.log(`题${' '.repeat(W - 1)}    状态        落款      用时`);
  for (const r of report.questions) {
    const dur = r.durationMs >= 60000 ? `${Math.round(r.durationMs / 60000)}m` : `${Math.round(r.durationMs / 1000)}s`;
    console.log(`${r.id.padEnd(W)}  ${r.status.padEnd(10)} ${r.finalClaim.padEnd(9)} ${dur.padEnd(6)}`);
  }
  const counts = report.questions.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  console.log(
    `\n小结：${report.questions.length} 题 —— pass ${counts.pass ?? 0} / fail ${counts.fail ?? 0} /`
    + ` unjudgeable ${counts.unjudgeable ?? 0} / timeout ${counts.timeout ?? 0}`,
  );
  const undetermined = (counts.unjudgeable ?? 0) + (counts.timeout ?? 0);
  if (undetermined * 2 > report.questions.length) {
    console.error('[回归] unjudgeable/timeout 过半 —— 事件抽取有问题，回头修跑法再跑，这轮结果不可信');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('[回归] 跑挂了：', e?.message ?? e);
  process.exit(1);
});
