#!/usr/bin/env node
/**
 * 跑「不需要真实 CLI / 模型 / 网络」的那批冒烟 —— PR 闸门与本地自查**共用同一份清单**。
 *
 * 为什么是清单而不是 glob 所有 `smoke-*.mjs`：
 *   · 少数用例要真实 agent CLI 与模型（烧 token，GitHub runner 上也没有）→ 必须显式排除并写明原因；
 *   · 新加了 `smoke-*.mjs` 却忘了登记？这里会**报错** —— 不然"新用例从来不跑"没人会发现。
 *
 * 跑法：
 *   node tools/run-smokes.mjs                   # 全量（PR 门禁跑的就是这一条）
 *   node tools/run-smokes.mjs --only=pr-create  # 只跑文件名/路径含这个子串的（修红时先跑这一条，最慢也就几十秒）
 *   node tools/run-smokes.mjs --list            # 只列清单，不跑
 * 退出码：0 全通过 / 1 有用例没过 / 2 清单与目录对不上（含 --only 一个都没选中）
 *
 * 2026-10-30 改（"修 gate 要跑很久"）：失败时不再只给 ✗ 行 + 15 行尾巴，
 * 而是带上**断言的 文件:行号**、**只跑这一条的复现命令**、**完整输出的落盘路径**。
 * 原来这三样都没有，agent 只能把 3 分半的全量再跑一遍去把日志头尾各看一次。
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
  'apps/server/src/smoke-feishu.mjs',
  'apps/server/src/smoke-git-repos.mjs',
  'apps/server/src/smoke-group-dissolve.mjs',
  'apps/server/src/smoke-group-mentions.mjs',
  'apps/server/src/smoke-lan-join.mjs',
  'apps/server/src/smoke-lan-origin.mjs',
  'apps/server/src/smoke-lifecycle.mjs',
  'apps/server/src/smoke-node.mjs',
  'apps/server/src/smoke-node-jobs.mjs',
  'apps/server/src/smoke-node-panel.mjs',
  'apps/server/src/smoke-node-task.mjs',
  'apps/server/src/smoke-pair.mjs',
  'apps/server/src/smoke-personas.mjs',
  'apps/server/src/smoke-plugin-blocks.mjs',
  'apps/server/src/smoke-pr-create.mjs',
  'apps/server/src/smoke-pr-link.mjs',
  'apps/server/src/smoke-pr-review.mjs',
  'apps/server/src/smoke-project-profile.mjs',
  'apps/server/src/smoke-project-tasks.mjs',
  'apps/server/src/smoke-quota.mjs',
  'apps/server/src/smoke-repo-cards.mjs',
  'apps/server/src/smoke-repo-patrol.mjs',
  'apps/server/src/smoke-run-events.mjs',
  'apps/server/src/smoke-run-progress.mjs',
  'apps/server/src/smoke-runtime-heal.mjs',
  'apps/server/src/smoke-roles.mjs',
  'apps/server/src/smoke-device-roles.mjs',
  'apps/server/src/smoke-users.mjs',
  'apps/server/src/smoke-schedules.mjs',
  'apps/server/src/smoke-steward.mjs',
  'apps/server/src/smoke-ssh.mjs',
  'apps/server/src/smoke-status.mjs',
  'apps/server/src/smoke-stop-keep.mjs',
  'apps/server/src/smoke-stop-watchdog.mjs',
  'apps/server/src/smoke-task-comments.mjs',
  'apps/server/src/smoke-task-flow.mjs',
  'apps/server/src/smoke-task-run-sync.mjs',
  'apps/server/src/smoke-workflows.mjs',
  'apps/desktop/smoke-shell.mjs',
  'tools/smoke-help-pop.mjs',
  // 2026-10-30：分支角标（↙N 蓝 / ↗N 绿）在合并里被误退回"单色、不带数字" —— 钉进清单
  'tools/smoke-branch-badge.mjs',
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

/* ------------------------------------------------- 参数：只跑一条 / 只列清单 */

/*
 * 修红的人（或 agent）第一步永远该是"只跑红的那一条"，不是全量。
 * 全量 3 分半，单条多数 1 秒级；先跑一条能把"复现"的成本压到可忽略。
 */
const argv = process.argv.slice(2);
const onlyArg = (() => {
  const i = argv.findIndex((a) => a === '--only' || a.startsWith('--only='));
  if (i < 0) return null;
  const a = argv[i];
  const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : String(argv[i + 1] ?? '');
  return v.trim() || null;
})();

if (argv.includes('--list') || argv.includes('-l')) {
  console.log(`要跑的 ${RUN.length} 个（另跳过 ${Object.keys(SKIP).length} 个 = 要真实 CLI / 模型）：`);
  for (const f of RUN) console.log('  ' + f);
  process.exit(0);
}

const targets = onlyArg ? RUN.filter((f) => f.includes(onlyArg)) : RUN;
if (onlyArg && !targets.length) {
  console.error(`--only=${onlyArg} 一个都没选中 —— 清单里没有含这个子串的路径。`);
  console.error('常用：--only=smoke-pr-create / --only=pr / --only=task / --only=run-progress；先 --list 看全清单。');
  process.exit(2);
}

/**
 * 把输出里那条 ✗ 的断言文案，回到用例源码里找出它的 `文件:行`。
 *
 * 为什么要在 runner 里干这件事：check() 打的是"中文标签 + 实际值"，
 * 没有行号 —— agent 拿到 797 行的用例文件只能靠肉眼把标签和代码对上；
 * 而标签文本本身就在 check('...' 的字面量里，反查一次就够。
 * 找不到（标签被拆行/拼出来）就返回 null，别硬猜一个错行号。
 */
function whereIs(file, outLine) {
  const label = outLine.trim().replace(/^✗\s*/, '').split(' — ')[0].trim();
  if (!label) return null;
  let src = '';
  try {
    src = fs.readFileSync(path.join(repo, file), 'utf8');
  } catch {
    return null;
  }
  const needle = label.length > 24 ? label.slice(0, 24) : label;
  const idx = src.split('\n').findIndex((l) => l.includes(needle));
  return idx >= 0 ? `${file}:${idx + 1}` : null;
}

/** GitHub 注解的属性值和正文要转义，否则带逗号/百分号的断言会把注解切坏 */
const ghEscape = (s) =>
  String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/,/g, '%2C').replace(/:/g, '%3A');

/* ------------------------------------------------------------------ 开跑 */

/*
 * 先跑**前端的静态自检**（不需要浏览器）：路由表与 setRoute 调用必须对得上。
 * 放这儿是因为 CI 只调这一个入口 —— 单开一个 workflow 步骤容易漏。
 * `--only` 时不跑：那时人只想知道那一条用例红不红，路由自检红了只会添乱。
 */
if (!onlyArg) {
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
}

console.log(onlyArg ? `\n只跑 ${targets.length} 个（--only=${onlyArg}）：` : `\n跑 ${targets.length} 个：`);

const failed = [];
const results = [];
for (const f of targets) {
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
     * 失败时先**把每条 ✗ 捞出来并标上位置**（2026-10-17：CI 上只看得到 15 行尾巴，
     * 失败的那条恰好被截掉，只能靠再跑一遍才能问出"到底是哪一项"；
     * 2026-10-30：光问出哪一项还不够，还得知道它在用例的哪一行 —— 见 whereIs）。
     *
     * 只认**行首就是 ✗** 的那种：用例里的分段标题也可能带 ✗（比如「PR 行上那颗 ✗ 的落点」），
     * 那是小节名不是失败项，算进来会把 agent 往错的地方带。
     */
    const bad = out.split('\n').filter((l) => /^\s*✗\s/.test(l) || /跑挂了/.test(l));
    const hits = bad.map((l) => ({ at: whereIs(f, l), line: l.trim() }));

    // 完整输出落盘：尾部 15 行只够看结论，翻上下文不该再花一次全量重跑
    const logPath = path.join(repo, 'tmp', `smoke-fail-${path.basename(f, '.mjs')}.log`);
    let logRel = null;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, out + '\n', 'utf8');
      logRel = rel(logPath);
    } catch {
      /* 落盘失败不影响结论 */
    }

    if (hits.length) {
      console.log(`    ---- 没过的断言（${hits.length} 条，带 文件:行）----`);
      for (const h of hits) console.log(`    ${h.at ? '@' + h.at : '@?（标签跨行了，自己搜一下）'}  ${h.line}`);
    } else {
      console.log('    ---- 没有 ✗ 行：用例多半是抛异常挂的，看下面的尾部 ----');
    }
    if (logRel) console.log(`    ---- 完整输出（${out.length} 字节）----\n    ${logRel}`);
    const tail = out.split('\n').slice(-15).join('\n');
    console.log('    ---- 输出尾部 ----');
    console.log(
      tail
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n'),
    );

    // CI 上把每条失败断言变成一条注解：PR 页面直接点到 文件:行，不用翻日志
    if (process.env.GITHUB_ACTIONS) {
      if (!hits.length) console.log(`::error file=${f}::冒烟用例没过：${path.basename(f)}`);
      for (const h of hits) {
        const [file, line] = (h.at ?? f).split(':');
        console.log(`::error file=${file}${line ? `,line=${line}` : ''}::${ghEscape(h.line)}`);
      }
    }
  }
}

const slow = results.filter((r) => r.ms > 60000).map((r) => `${path.basename(r.f)} ${(r.ms / 1000).toFixed(0)}s`);
if (slow.length) console.log(`\n（偏慢的：${slow.join('、')}）`);

console.log(`\n结论：${failed.length ? `${failed.length} 个没过 —— ${failed.join('、')}` : `${targets.length} 个全通过`}`);

/*
 * 结论之后直接给"下一步"，是这次改动的重点：
 * 原来到这里就结束了，agent 只能自己猜"我该跑什么、日志在哪"，
 * 于是把全量再跑一遍 —— 那 3 分半是纯等待。
 */
if (failed.length) {
  console.log('\n只跑没过的那几条（不用全量重跑）：');
  for (const f of failed) {
    console.log(`  node ${f}`);
    console.log(`  （= CI 里的同一条：node tools/run-smokes.mjs --only=${path.basename(f, '.mjs')}）`);
  }
  console.log('\n先看失败断言上的 @文件:行 —— 打开那十行就够定位，别从头读整个用例。');
}
process.exit(failed.length ? 1 : 0);
