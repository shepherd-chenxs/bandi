/**
 * **给数字员工发 git 能力**的验收（2026-11-13 试点，用户拍板"先试研发岗"）。
 *
 * 钉住五件事：
 *   ① 只有研发岗（roleKey=dev）拿得到 —— 别的岗位不能因为"顺手"就有对外推代码的能力；
 *   ② 只对**已接入的仓库目录**发（等于 GitHub 侧范围也限住了），随便一个本地目录不发；
 *   ③ 没配平台令牌就不发，且原因说得出来（不是静默失败）；
 *   ④ 发的内容形状对：`http.extraheader`（令牌不落 .git/config）+ `core.hooksPath` 指向固定钩子目录；
 *   ⑤ 钩子真的落盘了，且里面调的是仓库里那份 pre-push.mjs（判据跟平台共用）。
 *
 * 隔离：临时数据目录 + 临时库，跑完删目录。
 * 跑法：node apps/server/src/smoke-agent-git.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const repo = path.resolve(here, '..', '..', '..');
const url = (rel) => pathToFileURL(path.join(repo, 'apps', 'server', 'src', rel)).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-agent-git-'));
const DATA = path.join(tmp, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.BANDI_DATA = DATA;

const store = await import(url('store.mjs'));
const { agentGitEnv, agentGitStatus, gitAbilityBrief } = await import(url('agent-git.mjs'));

let bad = 0;
const check = (ok, msg, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${detail ? ' — ' + detail : ''}`);
  if (!ok) bad += 1;
};

const workdir = path.join(tmp, 'repo');
fs.mkdirSync(workdir, { recursive: true });

console.log('① 岗位闸：只有研发岗拿得到');
check(Object.keys(agentGitEnv({ runId: 'r1', personaId: 'p1', roleKey: 'pm', cwd: workdir })).length === 0, '项目经理（pm）不发');
check(Object.keys(agentGitEnv({ runId: 'r1', personaId: 'p1', roleKey: '', cwd: workdir })).length === 0, '岗位空着不发');
check(/不在试点范围/.test(agentGitStatus({ roleKey: 'pm', cwd: workdir }).why), '不发时能说清原因（不是静默）');

console.log('\n② 没配令牌 / 目录没接入：都不发');
check(Object.keys(agentGitEnv({ runId: 'r1', personaId: 'p1', roleKey: 'dev', cwd: workdir })).length === 0, '没令牌不发');
check(/代码托管/.test(agentGitStatus({ roleKey: 'dev', cwd: workdir }).why), '原因指向「代码托管」配置');

fs.writeFileSync(path.join(DATA, 'github-token'), 'ghp_smoke_token_123456\n', 'utf8');
check(Object.keys(agentGitEnv({ runId: 'r1', personaId: 'p1', roleKey: 'dev', cwd: workdir })).length === 0, '目录没接入仓库也不发（仅限已接入仓库）');

console.log('\n③ 研发岗 + 已接入仓库 + 有令牌：发，且形状对');
store.addGitRepo({ fullName: 'smoke/repo', owner: 'smoke', name: 'repo', defaultBranch: 'main', localPath: workdir });
const env = agentGitEnv({ runId: 'run-42', personaId: 'p-dev', roleKey: 'dev', cwd: workdir });
check(env.GIT_CONFIG_COUNT === '2', '用 GIT_CONFIG_* 逐条注入（不改 .git/config、不改全局配置）', env.GIT_CONFIG_COUNT);
check(env.GIT_CONFIG_KEY_0 === 'http.https://github.com/.extraheader', '令牌走请求头（不落 .git/config）');
check(/^Authorization: Basic [A-Za-z0-9+/=]+$/.test(env.GIT_CONFIG_VALUE_0 ?? ''), '头部是 Basic（x-access-token:令牌）');
check(!String(env.GIT_CONFIG_VALUE_0 ?? '').includes('ghp_smoke_token_123456'), '明文令牌不出现在配置值里', 'base64 编码，不是回显');
check(env.GIT_CONFIG_KEY_1 === 'core.hooksPath', '钩子目录走 core.hooksPath');
check(fs.existsSync(path.join(env.GIT_CONFIG_VALUE_1, 'pre-push')), 'pre-push 钩子已落盘');
const hookFile = fs.readFileSync(path.join(env.GIT_CONFIG_VALUE_1, 'pre-push'), 'utf8');
check(hookFile.includes('git-hooks') && hookFile.includes('pre-push.mjs'), '钩子调的是仓库里那份 pre-push.mjs（判据与平台共用）');
check(env.BANDI_RUN_ID === 'run-42' && env.BANDI_PERSONA_ID === 'p-dev', '带上 runId / personaId（审计用）');
check(!!env.BANDI_HOOK_LOG, '给了推送审计落点（agent-pushes.jsonl）');
check(/git fetch|git push/.test(gitAbilityBrief()), '任务里会明说"你现在能推"（不说等于白给）');
check(/--no-verify/.test(gitAbilityBrief()), '明说"不要绕闸"');

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* Windows 上库句柄可能还没放（进程马上退出），临时目录留给人看也无妨 */
}
console.log(bad ? `\n✗ ${bad} 项没过` : '\n✓ 全过');
process.exit(bad ? 1 : 0);
