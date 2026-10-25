#!/usr/bin/env node
/**
 * 跑「不需要真实 CLI / 模型 / 网络」的那批冒烟 —— PR 闸门与本地自查**共用同一份清单**。
 *
 * 为什么是清单而不是 glob 所有 `smoke-*.mjs`：
 *   · 少数用例要真实 agent CLI 与模型（烧 token，GitHub runner 上也没有）→ 必须显式排除并写明原因；
 *   · 新加了 `smoke-*.mjs` 却忘了登记？这里会**报错** —— 不然"新用例从来不跑"没人会发现。
 *
 * 跑法：node tools/run-smokes.mjs
 * 退出码：0 全通过 / 1 有用例没过 / 2 清单与目录对不上
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(repo, p).split(path.sep).join('/');

/** 要跑的：都不碰真实 data/、不要真实 CLI、不联网 */
const RUN = [
  'apps/server/src/smoke-agent-cards.mjs',
  'apps/server/src/smoke-auth.mjs',
  'apps/server/src/smoke-autostart.mjs',
  'apps/server/src/smoke-chat-to-board.mjs',
  'apps/server/src/smoke-connectors.mjs',
  'apps/server/src/smoke-conversation-delete.mjs',
  'apps/server/src/smoke-events.mjs',
  'apps/server/src/smoke-data-dir.mjs',
  'apps/server/src/smoke-experts.mjs',
  'apps/server/src/smoke-git-repos.mjs',
  'apps/server/src/smoke-group-dissolve.mjs',
  'apps/server/src/smoke-group-mentions.mjs',
  'apps/server/src/smoke-lan-join.mjs',
  'apps/server/src/smoke-lifecycle.mjs',
  'apps/server/src/smoke-node.mjs',
  'apps/server/src/smoke-node-jobs.mjs',
  'apps/server/src/smoke-node-task.mjs',
  'apps/server/src/smoke-personas.mjs',
  'apps/server/src/smoke-plugin-blocks.mjs',
  'apps/server/src/smoke-pr-create.mjs',
  'apps/server/src/smoke-pr-link.mjs',
  'apps/server/src/smoke-pr-review.mjs',
  'apps/server/src/smoke-project-profile.mjs',
  'apps/server/src/smoke-project-tasks.mjs',
  'apps/server/src/smoke-quota.mjs',
  'apps/server/src/smoke-repo-cards.mjs',
  'apps/server/src/smoke-run-events.mjs',
  'apps/server/src/smoke-runtime-heal.mjs',
  'apps/server/src/smoke-schedules.mjs',
  'apps/server/src/smoke-secretary.mjs',
  'apps/server/src/smoke-ssh.mjs',
  'apps/server/src/smoke-status.mjs',
  'apps/server/src/smoke-stop-watchdog.mjs',
  'apps/server/src/smoke-task-comments.mjs',
  'apps/server/src/smoke-task-run-sync.mjs',
  'apps/server/src/smoke-workflows.mjs',
  'apps/desktop/smoke-shell.mjs',
  'tools/smoke-help-pop.mjs',
];

/** 不跑的：写明原因（要真实 CLI / 模型，会烧 token） */
const SKIP = {
  'apps/server/src/smoke-codex.mjs': '要真实 Codex CLI 与模型',
  'apps/server/src/smoke-dsh.mjs': '要真实 dsh 与模型',
  'apps/server/src/smoke-mcp.mjs': '② 真起 codex / dsh 让模型调 MCP 工具',
  'apps/server/src/smoke-plugin-e2e.mjs': '要 codex 真去 tool_search 调到工具',
};

/* ------------------------------------------- 清单完整性：不许有"没人管的用例" */

const dirs = ['apps/server/src', 'apps/desktop', 'tools'];
const found = dirs.flatMap((d) =>
  fs
    .readdirSync(path.join(repo, d))
    .filter((f) => /^smoke-.*\.mjs$/.test(f))
    .map((f) => `${d}/${f}`),
);
const known = new Set([...RUN, ...Object.keys(SKIP)]);
const unregistered = found.filter((f) => !known.has(f));
const vanished = [...known].filter((f) => !fs.existsSync(path.join(repo, f)));

if (unregistered.length || vanished.length) {
  if (unregistered.length) {
    console.error('这些冒烟用例没登记（要么加进 RUN，要么写进 SKIP 并说明原因）：');
    for (const f of unregistered) console.error('  - ' + f);
  }
  if (vanished.length) {
    console.error('清单里写了、但文件不在了：');
    for (const f of vanished) console.error('  - ' + f);
  }
  process.exit(2);
}

/* ------------------------------------------------------------------ 开跑 */

/*
 * 先跑**前端的静态自检**（不需要浏览器）：路由表与 setRoute 调用必须对得上。
 * 放这儿是因为 CI 只调这一个入口 —— 单开一个 workflow 步骤容易漏。
 */
const routes = spawnSync(process.execPath, [path.join(repo, 'tools', 'check-routes.mjs')], {
  cwd: repo,
  stdio: 'inherit',
});
if (routes.status !== 0) {
  console.error('✗ 前端路由自检没过（见上）');
  process.exit(1);
}

console.log(`跳过 ${Object.keys(SKIP).length} 个（要真实 CLI / 模型）：`);
for (const [f, why] of Object.entries(SKIP)) console.log(`  · ${path.basename(f)} —— ${why}`);
console.log(`\n跑 ${RUN.length} 个：`);

const failed = [];
const results = [];
for (const f of RUN) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [f], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  console.log(`  ${ok ? '✓' : '✗'} ${path.basename(f)}  ${(ms / 1000).toFixed(1)}s`);
  results.push({ f, ok, ms });
  if (!ok) {
    failed.push(f);
    const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
    /*
     * 失败时先**把每条 ✗ 捞出来**（2026-10-17：CI 上只看得到 15 行尾巴，
     * 而失败的那条恰好被截掉，只能靠再跑一遍才能问出"到底是哪一项"）。
     */
    const bad = out.split('\n').filter((l) => /✗|跑挂了/.test(l));
    if (bad.length) {
      console.log('    ---- 没过的那几项 ----');
      for (const l of bad) console.log('    ' + l.trim());
    }
    const tail = out.split('\n').slice(-15).join('\n');
    console.log('    ---- 输出尾部 ----');
    console.log(
      tail
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n'),
    );
    if (process.env.GITHUB_ACTIONS) console.log(`::error file=${f}::冒烟用例没过：${path.basename(f)}`);
  }
}

const slow = results.filter((r) => r.ms > 60000).map((r) => `${path.basename(r.f)} ${(r.ms / 1000).toFixed(0)}s`);
if (slow.length) console.log(`\n（偏慢的：${slow.join('、')}）`);

console.log(`\n结论：${failed.length ? `${failed.length} 个没过 —— ${failed.join('、')}` : `${RUN.length} 个全通过`}`);
process.exit(failed.length ? 1 : 0);
