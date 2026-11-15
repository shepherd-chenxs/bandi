/*
 * agent-git.mjs —— 给**有研发职责**的数字员工发一把 git 能力（2026-11-13 试点）。
 *
 * 为什么改：以前 agentEnv() 把 `GIT_*`/`GH_TOKEN` 全删掉 —— 治理被实现成了阉割：
 * 员工能改代码、能 commit，但推不了、开不了 PR，于是**任何 git 失败都只能落到人头上**
 * （2026-11-13 实报：base 分支名错，员工看得见错，却没有能力去 fetch/换 base）。
 *
 * 现在的分工（用户 2026-11-13 拍板的三层）：
 *   · 能力层：**发**岗位凭据 —— 用平台的 fine-grained PAT，经 `http.extraheader` 只注入这一次运行，
 *     不落 `.git/config`、不进日志；运行结束随进程消失。
 *   · 规则层：`core.hooksPath` 指向固定钩子目录，`pre-push` 挡三类（直推 main、改写远端历史、
 *     推凭据文件，见 apps/server/src/git-hooks/pre-push.mjs）。
 *   · 审计层：钩子把每次推送写进 `<数据目录>/agent-pushes.jsonl`（带 runId / personaId）。
 *
 * 边界说清楚：
 *   · 这**不是**安全沙箱 —— agent 是 danger-full-access，`--no-verify` 能绕钩子、能自己读环境变量。
 *     它解决的是"正常干活时不用人接手"，与 pr-create（平台侧、可审计）并存，不互相替代。
 *   · **默认只给研发岗**（roleKey = dev）。别的岗位照旧拿不到凭据 —— 要开先加进 GIT_ROLES，
 *     并且明说理由：给谁能力 = 谁可以自己对外推东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, repoRoot } from './config.mjs';
import { readToken, repoForCwd } from './git-repos.mjs';

/** 试点范围：只有这些岗位的运行动能拿到 git 凭据（2026-11-13 用户拍板"先试研发岗"） */
const GIT_ROLES = new Set(['dev']);

const HOOKS_DIR = () => path.join(dataDir, 'git-hooks');
const HOOK_JS = () => path.join(repoRoot, 'apps', 'server', 'src', 'git-hooks', 'pre-push.mjs');
const PUSH_LOG = () => path.join(dataDir, 'agent-pushes.jsonl');

/**
 * 落钩子（幂等，每次覆盖写 —— 平台升级后钩子跟着升级，不留旧版本在用户目录里）。
 *
 * `pre-push` 是个 sh 包装：git 在 Windows 上也用 sh 跑钩子，而逻辑写在 Node 里
 * （判据要与平台共用 secret-paths.mjs，用 sh 重写一遍必跑偏）。
 */
function ensureHooks() {
  const dir = HOOKS_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const body = `#!/bin/sh\n# 班底生成（apps/server/src/agent-git.mjs）—— 别手改，升级会覆盖\nexec "${process.execPath}" "${HOOK_JS()}" "$@"\n`;
  const file = path.join(dir, 'pre-push');
  let cur = '';
  try {
    cur = fs.readFileSync(file, 'utf8');
  } catch {
    /* 没有就写 */
  }
  if (cur !== body) fs.writeFileSync(file, body, 'utf8');
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* Windows 上无所谓，git 用 sh 解释 */
  }
  return dir;
}

/** 这把令牌的 extraheader 值（base64 只是编码，不是加密 —— 别打印它） */
function authHeader(token) {
  return 'Authorization: Basic ' + Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

/**
 * 给这次运行拼 git 相关的环境变量。
 *
 * @param {{ runId?: string, personaId?: string, roleKey?: string, cwd?: string }} p
 * @returns {Record<string,string>} 空对象 = 这次不给（非研发岗 / 没接仓库 / 没配令牌）
 */
export function agentGitEnv({ runId = null, personaId = null, roleKey = '', cwd = '' } = {}) {
  if (!GIT_ROLES.has(String(roleKey ?? ''))) return {};
  const token = readToken();
  if (!token) return {};
  const repo = cwd ? repoForCwd(cwd) : null;
  // 只给我们接过的仓库发（等于 GitHub 侧也限了范围）：随手一个本地目录不在试点内
  if (!repo) return {};
  const hooks = ensureHooks();
  return {
    BANDI_RUN_ID: String(runId ?? ''),
    BANDI_PERSONA_ID: String(personaId ?? ''),
    BANDI_HOOK_LOG: PUSH_LOG(),
    // 用 git 的 GIT_CONFIG_* 逐条注入：不改 .git/config、不改全局配置，子进程结束就没了。
    // 注意 agentEnv() 会删掉所有 GIT_* —— 所以这串必须在它**之后**合并（runs.mjs 的合并顺序）。
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: authHeader(token),
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: hooks,
  };
}

/** 检查用：这次能不能给（界面/冒烟要看原因，不要只看结果） */
export function agentGitStatus({ roleKey = '', cwd = '' } = {}) {
  if (!GIT_ROLES.has(String(roleKey ?? ''))) return { ok: false, why: `岗位 ${roleKey || '(空)'} 不在试点范围（${[...GIT_ROLES].join(', ')}）` };
  if (!readToken()) return { ok: false, why: '平台还没配 GitHub 令牌（工作台 → 研发 → 代码托管）' };
  if (!cwd || !repoForCwd(cwd)) return { ok: false, why: '这个目录不是已接入的仓库' };
  return { ok: true, why: '' };
}

/**
 * 贴进任务末尾的一段话（只在真的发了 git 能力时贴）。
 *
 * 为什么必须明说：员工以前接到的口径是"代码动作归平台，你只改文件"（那时确实没凭据）。
 * 不说清楚，它照旧不会推、失败了照旧报"没权限"，等于白给。
 */
export function gitAbilityBrief() {
  return [
    '【git 能力 · 本轮有效】这一步你**可以直接操作 git**（推的是岗位身份，不是雇主的个人账号）：',
    '- 能 `git fetch origin`、`git push origin <你的分支>`。推不上去先自己查（`git ls-remote --heads origin`、`git log --oneline origin/main..HEAD`、`git merge-base`），别直接报"没权限"就停。',
    '- 会被 pre-push 闸拦下的三件事：**直推 main/master**、**改写远端已有历史**（非快进 / force）、**推 .env 或私钥类文件**。名字像凭据的普通文件会先扫内容，干净自动放行；扫出密钥特征就把文件挪出改动或挪进 tests/fixtures。被拦就自己收拾好再推；不要用 `--no-verify` 绕闸。',
    '- 建 PR 仍然归平台（动作节点 / 工作台「建 PR」）：推完分支把**分支名 + 一句改了什么**写进小结，平台会用它开 PR。',
  ].join('\n');
}
