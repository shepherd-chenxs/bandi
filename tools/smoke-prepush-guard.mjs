/**
 * **pre-push 闸**的验收（2026-11-13，数字员工拿回 git 能力之后补）。
 *
 * 为什么必须有这条：能力一放开，"推上去收不回来"的三件事就全靠这个钩子挡 ——
 * 直推 main、改写远端历史、推凭据文件。判据写错了不报错，等你发现时东西已经在 GitHub 上了。
 *
 * 两层验证：
 *   ① 纯判定（judgeRef / parseRefLines）：不碰 git，把边界情况摆齐（.env.example 要放过）；
 *   ② **真的推一遍**：临时 bare 仓库当远端，跑三次 push —— 直推 main 被拦、
 *      带 .env 的分支被拦、正常分支放行，并且审计文件里留下记录。
 *
 * 跑法：node tools/smoke-prepush-guard.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const HOOK_JS = path.join(repo, 'apps', 'server', 'src', 'git-hooks', 'pre-push.mjs');

const { judgeRef, parseRefLines, isProtectedRef } = await import(pathToFileURL(HOOK_JS).href);

let bad = 0;
const check = (ok, msg, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${detail ? ' — ' + detail : ''}`);
  if (!ok) bad += 1;
};

console.log('① 纯判定');
check(isProtectedRef('refs/heads/main') && isProtectedRef('refs/heads/master'), 'main / master 算受保护');
check(!isProtectedRef('refs/heads/feat/x'), '普通分支不算');
check(judgeRef({ remoteRef: 'refs/heads/main', files: [] }).some((s) => /受保护分支/.test(s)), '直推 main 给理由');
check(judgeRef({ remoteRef: 'refs/heads/feat/x', force: true }).some((s) => /改写远端已有历史/.test(s)), '非快进（force）给理由');
check(judgeRef({ remoteRef: 'refs/heads/feat/x', files: ['.env'] }).length === 1, '.env 被拦');
check(judgeRef({ remoteRef: 'refs/heads/feat/x', files: ['apps/x/id_rsa'] }).length === 1, '私钥被拦');
check(judgeRef({ remoteRef: 'refs/heads/feat/x', files: ['.env.example', 'docs/a.md'] }).length === 0, '.env.example / 普通文件放过');
check(judgeRef({ remoteRef: 'refs/heads/feat/x', files: ['src/app.mjs'] }).length === 0, '正常改动放行');
/* v2（2026-11-13）：文件名只做初筛 —— 名字像凭据的普通文件内容说了算（secret-paths.mjs 自己被自己拦过一回） */
check(judgeRef({ remoteRef: 'refs/heads/feat/x', files: ['src/secret-paths.mjs'], contents: { 'src/secret-paths.mjs': 'const RE = /token/;\n' } }).length === 0, '名字像凭据、内容干净 → 放行');
check(judgeRef({ remoteRef: 'refs/heads/feat/x', files: ['src/token-store.json'], contents: { 'src/token-store.json': '{"token":"sk-proj-abcdefghijklmnopqrstuvwx"}' } }).length === 1, '内容扫出密钥 → 拦');
check(judgeRef({ remoteRef: 'refs/heads/feat/x', files: ['tests/fixtures/token.json'], contents: { 'tests/fixtures/token.json': '{"token":"sk-proj-abcdefghijklmnopqrstuvwx"}' } }).length === 0, 'tests/fixtures 里的假密钥是应该存在的 → 放行');
const lines = parseRefLines('refs/heads/x abc refs/heads/x 0000000000000000000000000000000000000000\n\n  \n');
check(lines.length === 1 && lines[0].remoteSha.startsWith('0000'), '解析 pre-push 输入（跳过空行）');

console.log('\n② 真的推一遍（临时 bare 远端）');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-prepush-'));
const remote = path.join(tmp, 'origin.git');
const work = path.join(tmp, 'work');
const hooks = path.join(tmp, 'hooks');
const log = path.join(tmp, 'pushes.jsonl');
const git = (args, opts = {}) => spawnSync('git', args, { cwd: work, encoding: 'utf8', windowsHide: true, ...opts });

spawnSync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
spawnSync('git', ['init', '-q', '-b', 'main', work], { windowsHide: true });
fs.mkdirSync(hooks, { recursive: true });
fs.writeFileSync(
  path.join(hooks, 'pre-push'),
  `#!/bin/sh\nexec "${process.execPath}" "${HOOK_JS}" "$@"\n`,
  'utf8',
);
git(['config', 'core.hooksPath', hooks]);
git(['config', 'user.email', 'smoke@example.com']);
git(['config', 'user.name', 'smoke']);
git(['remote', 'add', 'origin', remote]);
fs.writeFileSync(path.join(work, 'a.txt'), 'hello\n');
git(['add', '-A']);
git(['commit', '-qm', 'init']);

const pushEnv = { ...process.env, BANDI_HOOK_LOG: log, BANDI_RUN_ID: 'run-smoke' };

const pushMain = git(['push', 'origin', 'main'], { env: pushEnv });
check(pushMain.status !== 0 && /受保护分支/.test(pushMain.stderr ?? ''), '直推 main 被闸拦下（且说清原因）');

git(['checkout', '-qb', 'feat/ok']);
fs.writeFileSync(path.join(work, 'b.txt'), 'ok\n');
git(['add', '-A']);
git(['commit', '-qm', 'feat ok']);
const pushOk = git(['push', 'origin', 'feat/ok'], { env: pushEnv });
check(pushOk.status === 0, '正常分支放行', (pushOk.stderr ?? '').split('\n').pop());

// v2：名字像凭据、内容干净 → 真的推也要放行（钩子自己读 blob 内容来判）
git(['checkout', '-qb', 'feat/wordy']);
fs.writeFileSync(path.join(work, 'token-bucket.mjs'), 'export const refill = 10;\n');
git(['add', '-A']);
git(['commit', '-qm', 'wordy clean']);
const pushWordy = git(['push', 'origin', 'feat/wordy'], { env: pushEnv });
check(pushWordy.status === 0, '名字像凭据、内容干净 → 放行', (pushWordy.stderr ?? '').split('\n').pop());

git(['checkout', '-qb', 'feat/secret']);
fs.writeFileSync(path.join(work, '.env'), 'TOKEN=1\n');
git(['add', '-f', '.env']);
git(['commit', '-qm', 'oops secret']);
const pushSecret = git(['push', 'origin', 'feat/secret'], { env: pushEnv });
check(pushSecret.status !== 0 && /凭据/.test(pushSecret.stderr ?? ''), '带 .env 的分支被拦');

check(fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim().split('\n').length >= 3, '每次推送都留了审计（含被拦的）');
const rec = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.ok === false);
check(rec?.runId === 'run-smoke' && Array.isArray(rec.problems) && rec.problems.length > 0, '审计里带 runId 与被拦原因');

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录删不掉不影响结论 */
}
console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全过');
process.exit(bad ? 1 : 0);
