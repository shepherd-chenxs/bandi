#!/usr/bin/env node
/*
 * git pre-push 守卫（2026-11-13，数字员工 git 能力试点）。
 *
 * 背景：平台以前是**把 git 凭据从 agent 环境里删掉**（agentEnv），员工因此能改不能推、
 * 失败也不会自救。改成"发岗位凭据 + 推之前过闸"之后，规则从"你没有能力"变成
 * "你能推，但这三条不许"：
 *
 *   ① 不许直接推 main / master（要合进去只能走 PR + 审批）；
 *   ② 不许改写远端已有历史（非快进 / force push）—— 推上去就收不回来；
 *   ③ 不许推凭据（.env / 私钥类按约定就该是凭据的文件直接拦；名字像凭据的普通文件先扫
 *      内容，干净放行 —— 判据与平台共用 secret-paths.mjs v2，2026-11-13 它自己被自己
 *      的名字拦过一回，别再只看名字）。
 *
 * 绕不绕得过要说清楚：`git push --no-verify` 能绕过钩子。这条**不是安全边界**，
 * 是"正常干活时自动守规矩"的通道 —— agent 是 danger-full-access，本来就能绕；
 * 真正不可绕的那条路（平台 pr-create + 分支保护）仍然在。
 *
 * 平台通过 `core.hooksPath` 把这个目录挂给 agent 的 git（见 apps/server/src/agent-git.mjs），
 * 所以钩子里能拿到 BANDI_RUN_ID / BANDI_HOOK_LOG；人自己手敲 git 时没有这些变量，照常放行（只挡规则那条）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifySecretSuspects, scanContentForSecrets } from '../secret-paths.mjs';

const ZERO = /^0+$/;

/** 这些远端分支只收 PR，不收直推 */
export function isProtectedRef(ref) {
  return /^refs\/heads\/(main|master)$/i.test(String(ref ?? ''));
}

/**
 * 解析 pre-push 的 stdin：每行 `<local ref> <local sha> <remote ref> <remote sha>`。
 * 删除远端分支时 local sha 是 0（那种直接放行 —— 删分支不是我们的闸管的事）。
 */
export function parseRefLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter((r) => r.localRef && r.remoteRef && !ZERO.test(r.localSha ?? ''));
}

/**
 * 纯判定（跑测试用，不碰 git）：
 * 给定一条要推的 ref + 它的改动文件 + 是否非快进 + 名字像凭据那批文件的内容（可选），
 * 回拒绝理由数组（空 = 放行）。
 *
 * `contents`：{ 路径: 文本|null }，只给"名字像凭据"那批。v2（2026-11-13，secret-paths.mjs
 * 被自己的名字拦过一回）：文件名只能说明"像"，说明不了"是" —— 实锤档（.env/私钥类）
 * 直接拦；像凭据档**内容说了算**，内容给不出的（纯判定/二进制/已删除）不凭名字拦。
 */
export function judgeRef({ remoteRef = '', files = [], force = false, contents = null } = {}) {
  const why = [];
  if (isProtectedRef(remoteRef)) why.push(`${remoteRef.replace('refs/heads/', '')} 是受保护分支：请推到自己的分支，再开 PR 合进去`);
  if (force) why.push('这次推送会改写远端已有历史（非快进）—— 推上去就收不回来，先合一次再推');
  const { keyfiles, wordy } = classifySecretSuspects(files);
  if (keyfiles.length) {
    why.push(
      `改动里有按约定就该是凭据的文件：${keyfiles.slice(0, 4).join('、')}${keyfiles.length > 4 ? ` 等 ${keyfiles.length} 个` : ''}` +
        ' —— 这一档推上去就收不回来，没有放行口令：把它移出这次改动（要提交模板就改名成 .env.example 这类）',
    );
  }
  const hits = [];
  for (const p of wordy) {
    const text = contents?.[p];
    if (typeof text !== 'string') continue;
    const w = scanContentForSecrets(p, text);
    if (w) hits.push(`${p}：${w}`);
  }
  if (hits.length) {
    why.push(
      `内容扫描发现像真实密钥的东西：${hits.slice(0, 4).join('；')}${hits.length > 4 ? ` 等 ${hits.length} 个` : ''}` +
        ' —— 提交即泄露：挪进 tests/fixtures 这类豁免位、改占位值，或回平台让雇主显式确认放行',
    );
  }
  return why;
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, ...opts });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim() };
}

/**
 * 这条 ref 会带上去哪些文件（老分支：remote..local；新分支：所有远端都没有的提交）。
 *
 * 新分支不能只靠跟 origin/main 找合并基点 —— 基点不在（裸远端还没有 main）时，
 * **`git diff` 不认 `--not --remotes`**（那是 rev-list 的语法，给 diff 只会得到空输出、
 * exit 0，2026-11-13 实报：带 .env 的新分支就这么从闸底下溜了过去）。
 * 基点不在就逐条 diff-tree 这批未推送的提交，并起来的文件清单一个不少。
 */
function changedFiles({ localSha, remoteSha }) {
  if (!ZERO.test(remoteSha ?? '')) {
    const d = git(['diff', '--name-only', `${remoteSha}..${localSha}`]);
    return d.ok ? d.out.split('\n').filter(Boolean) : [];
  }
  const mb = git(['merge-base', localSha, 'origin/main']);
  if (mb.ok && mb.out) {
    const d = git(['diff', '--name-only', `${mb.out}..${localSha}`]);
    if (d.ok) return d.out.split('\n').filter(Boolean);
  }
  // ⚠️ 正向引用必须写在 --not 前面：rev-list 的 --not 会把它**后面**的引用全部取反，
  // 写成 `--not --remotes <sha>` 连 sha 自己都被排除掉，输出永远为空
  const revs = git(['rev-list', localSha, '--not', '--remotes']);
  if (!revs.ok) return [];
  const names = new Set();
  for (const rev of revs.out.split('\n').filter(Boolean)) {
    const d = git(['diff-tree', '--name-only', '--no-commit-id', '-r', '--root', '-m', rev]);
    if (d.ok) for (const n of d.out.split('\n').filter(Boolean)) names.add(n);
  }
  return [...names];
}

/**
 * 名字像凭据那档的内容（v2：内容说了算）。
 * null = 没法扫（太大 / 二进制 / 这次提交里已删除）—— 判定层对 null 不凭名字拦，
 * 但会留进审计（平台侧能看到"哪些是没扫就放行的"）。
 */
function blobText(sha, file) {
  const size = git(['cat-file', '-s', `${sha}:${file}`]);
  const n = Number(size.out);
  if (!size.ok || !(n > 0) || n > 1024 * 1024) return null;
  const show = git(['show', `${sha}:${file}`], { maxBuffer: 8 * 1024 * 1024 });
  if (!show.ok) return null;
  if (show.out.includes('\x00')) return null; // 二进制没法按文本扫
  return show.out;
}

/** 非快进判定：远端已有的 sha 不是本地 sha 的祖先 = 改写历史 */
function isForcePush({ localSha, remoteSha }) {
  if (ZERO.test(remoteSha ?? '')) return false;
  const anc = git(['merge-base', '--is-ancestor', remoteSha, localSha]);
  return !anc.ok;
}

/** 留一条审计（平台按 BANDI_HOOK_LOG 指的位置收；没有就不写） */
function audit(record) {
  const file = process.env.BANDI_HOOK_LOG;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    /* 审计写不进去不该拦住推 —— 规则仍然照判 */
  }
}

function main() {
  const stdin = fs.readFileSync(0, 'utf8');
  const refs = parseRefLines(stdin);
  if (!refs.length) return 0;

  const problems = [];
  const pushed = [];
  const secretNotes = [];
  for (const r of refs) {
    const force = isForcePush(r);
    const files = changedFiles(r);
    pushed.push({ ref: r.remoteRef, sha: r.localSha, force, files: files.length });
    // 名字像凭据的那批先取内容（v2：内容说了算；取不到的不凭名字拦，留进审计）
    const contents = {};
    for (const p of classifySecretSuspects(files).wordy) {
      const text = blobText(r.localSha, p);
      contents[p] = text;
      if (text === null) secretNotes.push(`${r.remoteRef} ${p} 内容没法扫（二进制/太大/已删除），按名字放行`);
      else if (!scanContentForSecrets(p, text)) secretNotes.push(`${r.remoteRef} ${p} 名字像凭据、内容干净，放行`);
    }
    for (const why of judgeRef({ remoteRef: r.remoteRef, files, force, contents })) problems.push(`${r.remoteRef}：${why}`);
  }

  audit({
    at: new Date().toISOString(),
    runId: process.env.BANDI_RUN_ID ?? null,
    personaId: process.env.BANDI_PERSONA_ID ?? null,
    cwd: process.cwd(),
    pushed,
    ok: problems.length === 0,
    problems,
    secretNotes,
  });

  if (!problems.length) return 0;
  process.stderr.write(
    `\n[班底 pre-push 闸] 这次推送被拦下了：\n  - ${problems.join('\n  - ')}\n` +
      `（再确认一遍改动；规则见 apps/server/src/git-hooks/pre-push.mjs）\n\n`,
  );
  return 1;
}

// 只有被 git 当钩子直接执行时才跑主流程（import 进来跑测试不受影响）
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) process.exit(main());
