/**
 * **代码托管**（GitHub 仓库接入，2026-10-17）。
 *
 * 用户的原话：「我想要他这个代码托管的模块，因为我有很多个 git 仓库」。
 * 所以这里的形态是**仓库是一等资源**：连接 → 挑仓库 → 克隆到本地 → agent 在克隆目录里干活；
 * 项目 / 任务卡**引用**仓库（不把 20 个仓库硬变成 20 个项目）。
 *
 * 凭据（2026-10-17 事故之后的规矩）：
 *   · **一个 fine-grained PAT**，只授权给要接入的那几个仓库（GitHub 侧限定范围）；
 *   · 存在数据目录的 `github-token` 文件里（0600，尽力），**不进库、不进日志、不回显**；
 *   · 克隆/拉取时用 `http.extraheader` 把令牌带在**请求头**里 —— 这样 `.git/config` 里
 *     不会留下带令牌的 URL（那是最常见的泄漏方式）；
 *   · `agentEnv()` 给 agent 子进程用的环境：**删掉一切 GIT_* / GH_TOKEN / GITHUB_TOKEN**，
 *     让 agent 拿不到本机凭据、也起不了交互式认证（上次事故的直接教训）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataDir } from './config.mjs';
import * as store from './store.mjs';

const TOKEN_FILE = path.join(dataDir, 'github-token');
const REPOS_DIR = path.join(dataDir, 'repos');

/** 已接入的仓库清单 */
export function listConnected() {
  return store.listGitRepos();
}

/* ---------------------------------------------------------------- 令牌 */

export function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/** 给界面看的一小截（**绝不回显完整令牌**） */
export function tokenHint() {
  const t = readToken();
  return t ? `…${t.slice(-4)}` : null;
}

export function saveToken(token) {
  const t = String(token ?? '').trim();
  if (!t) throw new Error('令牌是空的');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  try {
    fs.chmodSync(TOKEN_FILE, 0o600); // Windows 上尽力而为
  } catch {
    /* 改不了权限就算了 */
  }
}

export function clearToken() {
  try {
    fs.rmSync(TOKEN_FILE, { force: true });
  } catch {
    /* 删不掉也当没有 */
  }
}

/* ---------------------------------------------------------------- GitHub API */

const ghFetch = async (pathname, { token, method = 'GET', body } = {}) => {
  const t = token ?? readToken();
  if (!t) throw new Error('还没连接 GitHub（先去「设置 → 代码托管」填一个 fine-grained PAT）');
  const r = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'bandi',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 原样带着 */
  }
  if (!r.ok) {
    const msg = data?.message ?? text.slice(0, 200);
    if (r.status === 401) throw new Error('令牌无效或已过期（401）');
    if (r.status === 403) throw new Error(`这个令牌没有权限做这件事（403）：${msg}`);
    if (r.status === 404) throw new Error(`没找到（404）：${msg}`);
    throw new Error(`GitHub ${r.status}：${msg}`);
  }
  return data;
};

/** 拿令牌验一次身份：能读到自己是谁就算连上了 */
export async function verifyToken(token) {
  const me = await ghFetch('/user', { token });
  return { login: me.login, name: me.name ?? null, avatar: me.avatar_url ?? null };
}

/** 账号下能看到的仓库（前 100 个，按最近更新排序）——「添加仓库」列表用 */
export async function listAvailableRepos() {
  const list = await ghFetch('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
  return list.map((r) => ({
    fullName: r.full_name,
    owner: r.owner?.login ?? r.full_name.split('/')[0],
    name: r.name,
    isPrivate: !!r.private,
    defaultBranch: r.default_branch ?? null,
    language: r.language ?? null,
    updatedAt: r.updated_at ?? null,
    cloneUrl: r.clone_url ?? `https://github.com/${r.full_name}.git`,
    description: r.description ?? null,
    // 这个令牌能不能**写**这个仓库（GitHub 的 permissions 告诉我们）。
    // 说明：fine-grained token 永远能**读**所有公开仓库 —— Repository access 限制的是写权限与私有仓库，
    // 所以"只勾了一个仓库、却看见好几个公开仓库"是正常的（2026-10-17 用户问过）。
    canWrite: r.permissions?.push === true,
  }));
}

/* ---------------------------------------------------------------- git 子进程 */

/** 异步跑一个命令（别用 spawnSync 卡住整个控制面） */
function run(file, args, { cwd, env, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      try {
        c.kill();
      } catch {
        /* 已经结束了 */
      }
    }, timeoutMs);
    c.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim() });
    });
    c.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(e.message ?? e) });
    });
  });
}

/** 令牌走请求头（**别拼进 URL** —— 那会被写进 .git/config，等于泄漏） */
function gitAuthArgs() {
  const t = readToken();
  if (!t) return [];
  return ['-c', `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${t}`, 'utf8').toString('base64')}`];
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

/** 仓库本地目录：`<数据目录>/repos/<owner>__<name>`；只允许落在这个目录里 */
export function localPathFor(fullName) {
  const [owner, name] = String(fullName).split('/');
  if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) throw new Error(`仓库名不合法：${fullName}`);
  return path.join(REPOS_DIR, `${owner}__${name}`);
}

const isGitRepo = (dir) => {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
};

/**
 * 接入一个仓库：克隆到本地（已经克隆过的就拉一下），并记进表。
 * 返回表里的那一行。
 */
/**
 * remote 地址跟 `owner/name` 是不是同一个仓库（https / ssh / 带 .git 都算）。
 * 只用来给个提醒，**不拿它当闸门** —— 有人故意改 remote（fork、镜像）也是合理的。
 */
function sameRepo(url, fullName) {
  const u = String(url ?? '')
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
  return u.endsWith('/' + String(fullName).toLowerCase());
}

/**
 * 接入一个仓库。
 *
 * `localPath`：**本地已经有克隆**时直接用它 —— 不另建一份（用户实报：点了接入又在别处克隆一份，
 * 白占盘、还容易两边不同步）。会核对 origin 指向是不是这个仓库；不一致只**提示**不拦（fork/镜像也合理）。
 */
export async function connectRepo(fullName, info = null, localPath = null) {
  const clean = String(fullName ?? '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error(`仓库名写成 owner/name：${clean}`);
  if (store.getGitRepoByFullName(clean)) throw new Error('这个仓库已经接入过了');

  /*
   * 元数据**懒加载 + 容错**：本地已有目录这条路不该依赖联网。
   * 私有仓库常见情况：令牌没给它授权（GitHub 只默认开放公开仓库）→ 查 /repos 会 404；
   * 这时仍然要能接入（不克隆、只用本地目录），私有状态就不知道（存 0，界面不显示"私有"）。
   */
  let meta = info;
  const getMeta = async () => {
    if (meta) return meta;
    try {
      meta = await ghFetch(`/repos/${clean}`);
    } catch {
      meta = null;
    }
    return meta;
  };
  const record = (dir, note, warning = null, m = null) => {
    const row = store.addGitRepo({
      fullName: clean,
      owner: m?.owner?.login ?? clean.split('/')[0],
      name: m?.name ?? clean.split('/')[1],
      isPrivate: m?.private ? 1 : 0,
      defaultBranch: m?.default_branch ?? null,
      localPath: dir,
      language: m?.language ?? null,
    });
    return { repo: store.touchGitRepoSync(row.id), note, warning };
  };

  /* **用本地已有目录**：不克隆，只核对一下 */
  if (localPath) {
    const dir = path.resolve(String(localPath).trim());
    if (!fs.existsSync(dir)) throw new Error(`本地目录不存在：${dir}`);
    if (!isGitRepo(dir)) throw new Error(`这个目录不是 git 仓库（没有 .git）：${dir}`);
    const dup = store.getGitRepoByPath(dir);
    if (dup) throw new Error(`这个目录已经接给仓库 ${dup.fullName} 了`);
    const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir, env: GIT_ENV });
    let warning = null;
    if (origin.code !== 0) warning = '这个目录没有 origin（不是从 GitHub 克隆的）—— 接入后「同步」不可用';
    else if (!sameRepo(origin.out, clean)) warning = `本地 origin 指向 ${origin.out}，跟 ${clean} 不一致（fork 或镜像？）`;
    const m = await getMeta();
    if (!m) warning = (warning ? warning + '；' : '') + '令牌读不到这个仓库（私有仓库要授权才读得到元数据），已按本地信息接入';
    // 默认分支：查不到就用本地 HEAD
    if (!m) {
      const head = await run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, env: GIT_ENV });
      meta = { default_branch: head.code === 0 ? head.out : null };
    }
    return record(dir, '使用本地已有目录（没有另建克隆）', warning, m ?? meta);
  }
  const meta2 = await getMeta();
  if (!meta2) throw new Error('令牌读不到这个仓库（私有仓库要在令牌的 Repository access 里勾上它）');
  meta = meta2;
  const dir = localPathFor(clean);
  const url = meta.clone_url ?? `https://github.com/${clean}.git`;
  fs.mkdirSync(REPOS_DIR, { recursive: true });

  let note = '';
  if (isGitRepo(dir)) {
    const r = await run('git', [...gitAuthArgs(), 'fetch', '--prune', 'origin'], { cwd: dir, env: GIT_ENV });
    if (r.code !== 0) throw new Error(`本地已有目录、但拉取失败：${r.out.split('\n').slice(-3).join(' ')}`);
    note = '本地已有克隆，已拉取';
  } else if (fs.existsSync(dir)) {
    throw new Error(`目录已存在但不是 git 仓库：${dir}（手动挪走再试）`);
  } else {
    const r = await run('git', [...gitAuthArgs(), 'clone', '--quiet', url, dir], { env: GIT_ENV });
    if (r.code !== 0) throw new Error(`克隆失败：${r.out.split('\n').slice(-3).join(' ')}`);
    note = '已克隆';
  }

  return record(dir, note);
}

/** 拉一下已接入的仓库（fast-forward；分叉了就说清楚） */
export async function syncRepo(id) {
  const row = store.getGitRepo(id);
  if (!row) throw new Error('仓库不在清单里');
  const r = await run('git', [...gitAuthArgs(), 'pull', '--ff-only'], { cwd: row.localPath, env: GIT_ENV });
  if (r.code !== 0) throw new Error(`拉取没成功：${r.out.split('\n').slice(-4).join(' ')}`);
  return store.touchGitRepoSync(row.id);
}

/** 从清单移除（**不删本地目录** —— 里面可能有你没推的东西） */
export function removeRepo(id) {
  const row = store.getGitRepo(id);
  if (!row) throw new Error('仓库不在清单里');
  store.deleteGitRepo(id);
  return { removed: row, keptPath: row.localPath };
}

/* ---------------------------------------------------------------- agent 的环境 */

/**
 * 给 agent 子进程的环境：**把本机凭据相关的东西全拿掉**（2026-10-17 事故的直接教训）。
 *
 * 删的是：`GIT_*`（凭据助手/配置/询问口令）、`GH_TOKEN`/`GITHUB_TOKEN`、`GCM_*`。
 * 加的是：`GIT_TERMINAL_PROMPT=0`（不许交互式要口令）、`GCM_INTERACTIVE=never`。
 *
 * ⚠️ 说清楚它**不解决**什么：Windows 凭据管理器是"同用户任何进程都能读"的，
 * 真要隔离得换用户/容器跑。这是"把最容易的路堵上"，不是完整沙箱。
 */
export function agentEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^GIT_/i.test(k) || /^GIT_/i.test(k) || /^GCM_/i.test(k) || /^GH_TOKEN$/i.test(k) || /^GITHUB_TOKEN$/i.test(k)) delete env[k];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/* ---------------------------------------------------------------- PR 联动 */

/** 从「PR 链接」或「owner/name#123」解析 { repo, number }；解析不出返回 null */
export function parsePrRef(input) {
  const s = String(input ?? '').trim();
  let m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(s);
  if (m) return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (m) return { repo: m[1], number: Number(m[2]) };
  return null;
}

/** 查一个 PR 的当前状态（走平台令牌）；state 归一成 open / merged / closed */
export async function fetchPull(repo, number) {
  const pr = await ghFetch(`/repos/${repo}/pulls/${number}`);
  return {
    repo,
    number: Number(number),
    title: pr.title ?? '',
    state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
    mergedAt: pr.merged_at ?? null,
    url: pr.html_url ?? `https://github.com/${repo}/pull/${number}`,
    headRef: pr.head?.ref ?? null,
  };
}
