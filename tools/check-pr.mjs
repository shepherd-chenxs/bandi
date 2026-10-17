#!/usr/bin/env node
/**
 * PR 闸门里**确定性的那一半**：不靠模型判断，直接对着 diff 查策略。
 *
 * 只查机器能一句话判死的（宁可少而准）：
 *   ① **零依赖铁律** —— 不许新增 package.json / 锁文件 / node_modules（本仓库零依赖是硬约束）
 *   ② **地址白名单** —— 代码与配置里新增的外部地址必须在白名单里；文档里的只提示
 *   ③ **断言完整性** —— 不许删冒烟用例、不许删用例里的 check(...)
 *   ④ **需要人看**（只提示不拦）—— 改 CI 工作流、鉴权/沙箱/数据目录、base_url 这类关键词
 *
 * "这段逻辑对不对"不在这里判 —— 那留给人和 agent，硬编码进 CI 只会天天误杀。
 * **白名单要加东西，在 PR 里写明理由**（那是人审的事）。
 *
 * 用法：
 *   BASE_SHA=<base commit> node tools/check-pr.mjs   # CI 里由 workflow 给（PR 的 base.sha）
 *   node tools/check-pr.mjs                          # 本地：拿工作区跟 HEAD 比
 * 退出码：0 没有硬违规 / 1 有硬违规
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_SHA || process.env.BASE_REF || '';
const head = 'HEAD';
const range = BASE ? [`${BASE}`, head] : [head]; // 本地不给 base → 比工作区

const git = (args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`git ${args.join(' ')} 失败：${(r.stderr ?? '').trim()}`);
    process.exit(2);
  }
  return r.stdout ?? '';
};

/**
 * 白名单 = 这个项目**本来就在用**的地址。新增任何一个都要在 PR 里说明理由。
 * 加它之前先问：这个域名是我们自己的服务/官方的源，还是别人家的中转站？
 */
const HOST_ALLOW = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'nodejs.org',
  'registry.npmjs.org',
  'registry.npmmirror.com',
  'schema.tauri.app',
  'tauri.app',
  'usemagpie.ai',
  '127.0.0.1',
  'localhost',
];

/** 改了这些 = 需要人看一眼（提示，不拦） */
const NEEDS_EYE = [
  /^\.github\/workflows\//,
  /^apps\/server\/src\/auth\.mjs$/,
  /^apps\/server\/src\/config\.mjs$/,
  /^apps\/server\/src\/store\.mjs$/,
  /^apps\/server\/src\/ssh-registry\.mjs$/,
  /^apps\/desktop\/installer-hooks\.nsh$/,
  /^apps\/desktop\/tauri\.conf\.json$/,
];

/** 新增行里出现这些词 = 提示人看（地址/凭据相关） */
const RISKY_WORD = /\b(base_?url|baseURL|BASE_URL|api_?key|apiKey|GATEWAY_KEY|personal_access_token|PRIVATE KEY)\b/i;

const errors = [];
const notices = [];
const err = (file, line, msg) => errors.push({ file, line, msg });
const note = (file, msg) => notices.push({ file, msg });

/* ------------------------------------------------------------ 收集 diff */

const nameStatus = git(['diff', '--name-status', ...range, '--'])
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [status, ...rest] = l.split(/\t/);
    return { status, file: rest.join('\t') };
  });

const changedFiles = nameStatus.map((x) => x.file);

// 逐行过 diff（-U0 只出改动行；带 +/- 与 @@ 行号）
const added = new Map(); // file → [{ line, text }]
const removed = new Map();
{
  const diff = git(['diff', '-U0', ...range, '--']);
  let file = null;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6);
      if (!added.has(file)) added.set(file, []);
      if (!removed.has(file)) removed.set(file, []);
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      added.get(file).push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      removed.get(file).push({ line: 0, text: raw.slice(1) });
    }
  }
}

const isDoc = (f) => /\.(md|txt|rst)$/i.test(f);

/* -------------------------------------------------------------- ① 零依赖 */

const DEP_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|node_modules\/)/;
for (const { status, file } of nameStatus) {
  if (status.startsWith('D')) continue;
  if (DEP_FILE.test(file)) {
    err(file, 0, `新增依赖面：${file}。本仓库**零依赖**是硬约束（见 docs/架构.md 技术选型）——要么去掉它，要么在 PR 里说明为什么必须破例。`);
  }
}

/* -------------------------------------------------------- ② 地址白名单 */

const URL_RE = /https?:\/\/([A-Za-z0-9.-]+)/g;
const hostAllowed = (h) => HOST_ALLOW.includes(h) || h.endsWith('.usemagpie.ai');
for (const [file, list] of added) {
  for (const { line, text } of list) {
    for (const m of text.matchAll(URL_RE)) {
      const host = m[1];
      if (hostAllowed(host)) continue;
      if (isDoc(file)) note(file, `新增外部链接（文档，仅提示）：${host}`);
      else err(file, line, `新增了白名单外的地址：${host} —— 中转站/网关这类必须说明来路（白名单在 tools/check-pr.mjs）`);
    }
    if (RISKY_WORD.test(text)) note(file, `新增行里出现地址/凭据相关字样（第 ${line} 行）：${text.trim().slice(0, 80)}`);
  }
}

/* -------------------------------------------------------- ③ 断言完整性 */

for (const { status, file } of nameStatus) {
  if (!/smoke-.*\.mjs$/.test(file)) continue;
  if (status.startsWith('D')) {
    err(file, 0, '删掉了整个冒烟用例 —— 这要人拍板（用例是别人的验收依据）');
    continue;
  }
  const gone = (removed.get(file) ?? []).filter((x) => /\bcheck\s*\(/.test(x.text));
  if (gone.length) {
    err(file, 0, `删掉了 ${gone.length} 条 check(...) 断言 —— 测试被放松，需要人确认（新增断言没问题，删的不行）`);
  }
}

/* ------------------------------------------------------ ④ 需要人看一眼 */

for (const file of changedFiles) {
  if (NEEDS_EYE.some((re) => re.test(file))) note(file, '这个文件改了 —— 需要人看一眼（CI 工作流 / 鉴权 / 沙箱 / 数据目录 / 打包钩子）');
}

/* ------------------------------------------------------------------ 输出 */

const mode = BASE ? `对比 ${BASE.slice(0, 8)}…HEAD` : '对比 HEAD（工作区）';
console.log(`PR 闸门（确定性检查）· ${mode}`);
console.log(`改动文件 ${changedFiles.length} 个`);

if (notices.length) {
  console.log(`\n要看一眼（不拦，${notices.length} 条）：`);
  for (const n of notices) {
    console.log(`  · ${n.file} —— ${n.msg}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning file=${n.file}::${n.msg}`);
  }
}

if (errors.length) {
  console.log(`\n硬违规（${errors.length} 条）—— 不修就不该合：`);
  for (const e of errors) {
    const where = e.line ? `${e.file}:${e.line}` : e.file;
    console.log(`  ✗ ${where} —— ${e.msg}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error file=${e.file}${e.line ? `,line=${e.line}` : ''}::${e.msg}`);
  }
  console.log('\n结论：有硬违规。');
  process.exit(1);
}

console.log('\n结论：确定性检查都过了（逻辑对不对仍要人 / agent 看）。');
