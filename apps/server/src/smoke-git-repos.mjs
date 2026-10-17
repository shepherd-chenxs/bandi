/**
 * 代码托管（GitHub 仓库接入）的离线验收（2026-10-17）。
 *
 * 这条链路里**需要网络的那半截**（真的连 GitHub、真的克隆）不在冒烟里跑 —— CI 没有令牌、也不该联网。
 * 这里只验**不联网就该对**的部分，以及一个最容易出事的点：**令牌不落库、不回显、不进环境**。
 *
 * 跑法：node apps/server/src/smoke-git-repos.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-git-'));
const PORT = Number(process.env.SMOKE_PORT ?? 8891);
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const req = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers ?? {}) } });
  const text = await r.text();
  let b = null;
  try {
    b = JSON.parse(text);
  } catch {
    /* 非 JSON 原样带着 */
  }
  return { status: r.status, b, text };
};

/* --------------------------------------------------------- 起一个控制面 */

const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(BASE + '/api/git/status')).ok) {
      up = true;
      break;
    }
  } catch {
    /* 还没起 */
  }
  await new Promise((r) => setTimeout(r, 250));
}
check('控制面起来了', up);
if (!up) {
  console.log(fs.readFileSync(logPath, 'utf8').split('\n').slice(-12).join('\n'));
  child.kill();
  process.exit(1);
}

try {
  console.log('\n① 没连接时：状态诚实、清单为空、别的动作都说清楚');
  const st = await req('/api/git/status');
  check('status 200 且 connected=false', st.status === 200 && st.b.connected === false, JSON.stringify(st.b?.connected));
  check('返回里没有令牌字段（只有 hint）', !JSON.stringify(st.b).includes('token') || st.b.hint === null);
  const list = await req('/api/git/repos');
  check('仓库清单是空的', list.status === 200 && (list.b.repos ?? []).length === 0);
  const avail = await req('/api/git/available');
  check('没连接就拉清单 → 400 并提示去连 GitHub', avail.status === 400 && /GitHub/.test(avail.b?.error ?? ''), avail.b?.error);
  const emptyTok = await req('/api/git/token', { method: 'POST', body: JSON.stringify({ token: '   ' }) });
  check('空令牌 → 400', emptyTok.status === 400, String(emptyTok.status));
  const delUnknown = await req('/api/git/repos/gr-不存在', { method: 'DELETE' });
  check('移除不存在的仓库 → 404', delUnknown.status === 404, String(delUnknown.status));
  const unknownRoute = await req('/api/git/nope');
  check('未知 /api/git 路径 → 404（不是落到别的 handler）', unknownRoute.status === 404, String(unknownRoute.status));

  console.log('\n② 令牌只在数据目录那个文件里：落盘 0600、读出可用、接口只给后 4 位');
  process.env.BANDI_DATA = tmp;
  const git = await import('./git-repos.mjs');
  git.saveToken('ghp_smoke1234abcd');
  const tokenFile = path.join(tmp, 'github-token');
  check('令牌文件写出来了', fs.existsSync(tokenFile));
  check('readToken 读得到', git.readToken() === 'ghp_smoke1234abcd');
  check('tokenHint 只给后 4 位', git.tokenHint() === '…abcd', String(git.tokenHint()));
  check('令牌没进数据库（表里没有 token 列）', !fs.readFileSync(path.join(tmp, 'bandi.db')).includes('ghp_smoke1234abcd'));
  const st2 = await req('/api/git/status');
  check('再查 status：connected=true、hint 只给后 4 位', st2.b.connected === true && st2.b.hint === '…abcd', JSON.stringify(st2.b?.hint));
  check('status 里绝不出现完整令牌', !JSON.stringify(st2.b).includes('ghp_smoke1234abcd'));
  git.clearToken();
  check('断开后令牌文件没了', !fs.existsSync(tokenFile));

  console.log('\n③ agent 的环境：本机凭据相关的变量全被拿掉');
  process.env.GIT_ASKPASS = 'C:/leak/askpass.exe';
  process.env.GIT_CONFIG_GLOBAL = 'C:/leak/gitconfig';
  process.env.GH_TOKEN = 'ghp_leak';
  process.env.GITHUB_TOKEN = 'ghp_leak2';
  process.env.GCM_INTERACTIVE = 'always';
  const env = git.agentEnv();
  check('GIT_ASKPASS 被删', env.GIT_ASKPASS === undefined);
  check('GIT_CONFIG_GLOBAL 被删', env.GIT_CONFIG_GLOBAL === undefined);
  check('GH_TOKEN / GITHUB_TOKEN 被删', env.GH_TOKEN === undefined && env.GITHUB_TOKEN === undefined);
  check('强制关掉交互式认证', env.GIT_TERMINAL_PROMPT === '0' && env.GCM_INTERACTIVE === 'never');
  // ⚠️ Windows 上环境变量真名常常是 `Path`（大小写），别只查 PATH
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  check('普通环境变量不受影响（PATH 还在）', !!pathKey && String(env[pathKey]).length > 0, String(pathKey));
  console.log('\n④ 本地已有目录：直接用它，不再克隆（用户实报的那件事）');
  const { execFileSync } = await import('node:child_process');
  const mkLocal = (name, origin) => {
    const dir = path.join(tmp, name);
    execFileSync('git', ['init', '-q', dir]);
    if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
    return dir;
  };
  const info = (n) => ({
    owner: { login: 'smoke' },
    name: n,
    private: false,
    default_branch: 'main',
    language: null,
    clone_url: `https://github.com/smoke/${n}.git`,
  });
  const local1 = mkLocal('local1', 'https://github.com/smoke/demo.git');
  const out1 = await git.connectRepo('smoke/demo', info('demo'), local1);
  check('接入用的是本地目录（没另建克隆）', out1.repo.localPath === local1, out1.repo.localPath);
  check('数据目录里没有冒出一份克隆', !fs.existsSync(path.join(tmp, 'repos', 'smoke__demo')));
  check('备注说明用了本地已有目录', /本地已有目录/.test(out1.note ?? ''), out1.note);
  check('origin 一致 → 不警告', out1.warning === null, String(out1.warning));
  let dupErr = '';
  try {
    await git.connectRepo('smoke/demo2', info('demo2'), local1);
  } catch (e) {
    dupErr = e.message;
  }
  check('同一个目录不许接给两个仓库', /已经接给/.test(dupErr), dupErr);
  const notGit = fs.mkdtempSync(path.join(tmp, 'notgit-'));
  let notGitErr = '';
  try {
    await git.connectRepo('smoke/demo3', info('demo3'), notGit);
  } catch (e) {
    notGitErr = e.message;
  }
  check('不是 git 仓库 → 拒绝并说清楚', /不是 git 仓库/.test(notGitErr), notGitErr);
  const local2 = mkLocal('local2', 'https://github.com/someone/else.git');
  const out2 = await git.connectRepo('smoke/demo4', info('demo4'), local2);
  check('origin 不一致 → 仍然接入（fork/镜像也合理）', out2.repo.localPath === local2);
  check('但要给警告说清楚', /不一致/.test(out2.warning ?? ''), String(out2.warning));

} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 */
  }
}

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
