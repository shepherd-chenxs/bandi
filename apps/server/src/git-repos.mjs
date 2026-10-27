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

/**
 * 给界面看的一小截（**绝不回显完整令牌**）：头 2 位 + 18 个星号 + 尾 4 位。
 *
 * 为什么是这个形状（2026-10-17）：原来只有尾 4 位 —— 认不出是哪一个。
 * 一个 GitHub 账号下往往建了好几个 fine-grained PAT（不同仓库、不同权限），
 * 90 天到期要换的时候，**"当前挂着的是哪一个"才是真正要回答的问题**，
 * 尾 4 位区分不开。头 2 位 + 尾 4 位足够认出来，中间那片星号是明说的"这里还有，但不给你看"。
 * 星号数 2026-10-23 由 6 改 18（用户要求）：掩码看着更像"一长串被盖住了"，不像只空了几格。
 *
 * 星号**固定 18 个**（不按令牌真实长度变）：长度本身是信息 —— 变长变短等于在
 * "报出令牌有多长"，而且每次换令牌界面都会抖一下。
 *
 * 短到头尾就快露完的那种（< 10 位）一个字都不给 —— 那已经不是"掩码"，等于把令牌摊开。
 */
export function tokenHint() {
  const t = readToken();
  if (!t) return null;
  if (t.length < 10) return '******';
  return `${t.slice(0, 2)}${'*'.repeat(18)}${t.slice(-4)}`;
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
  // 换了令牌，之前记下的那个账号就不再可信了（调用方验完身份会重新记一次）
  forgetLogin();
}

export function clearToken() {
  try {
    fs.rmSync(TOKEN_FILE, { force: true });
  } catch {
    /* 删不掉也当没有 */
  }
  forgetLogin();
}

/* ---------------------------------------------------------------- 身份缓存 */

/**
 * 「当前挂着的是哪个 GitHub 账号」—— **记一份**，别每次打开页面都去问 GitHub。
 *
 * 用户实报（2026-10-17）：「代码托管这个页面显示有延迟，估计是连 github 的原因」。
 * 根因就是状态接口每被看一次就同步查一次 `/user`，而国内访问 api.github.com 常常
 * 几秒起步。所以分两件事：
 *   · 页面先用**本地**状态画出来（令牌文件 + 库里的仓库清单 + 这里记的账号）；
 *   · 身份校验在**画完之后**由界面在后台问（`/api/git/whoami`），拿到了只补一小段文本。
 *
 * 为什么落库（`meta.github_login`）而不是只放内存：程序重启后第一次打开页面
 * 也不该空白一下再跳。库里的值只用于**显示**，不做任何鉴权 —— 真假由后台那次校验负责。
 */
const LOGIN_KEY = 'github_login';
const LOGIN_TTL_MS = 10 * 60 * 1000;
let loginCache; // undefined = 还没从库里读；null = 库里也没有

function readLoginCache() {
  if (loginCache !== undefined) return loginCache;
  try {
    const j = store.getMetaValue(LOGIN_KEY) ? JSON.parse(store.getMetaValue(LOGIN_KEY)) : null;
    loginCache = j?.login ? { login: String(j.login), at: Number(j.at) || 0 } : null;
  } catch {
    loginCache = null;
  }
  return loginCache;
}

export function rememberLogin(login) {
  if (!login) return;
  loginCache = { login: String(login), at: Date.now() };
  try {
    store.setMetaValue(LOGIN_KEY, JSON.stringify(loginCache));
  } catch {
    /* 写不进去就只在内存里记着 */
  }
}

export function forgetLogin() {
  loginCache = null;
  try {
    store.setMetaValue(LOGIN_KEY, null);
  } catch {
    /* 同上 */
  }
}

/** 界面首屏能立刻显示的那个名字（没有就是 null，**不代表没连**） */
export function cachedLogin() {
  return readLoginCache()?.login ?? null;
}

/**
 * 验一次身份。
 *
 * `fresh = false`（默认）：10 分钟内验过就直接用记下的 —— 页面后台那次调用
 * 基本不联网、立即返回，不会因为网络慢又拖住什么。
 * `fresh = true`：一定去问 GitHub（刚连上、或用户手动刷新时）。
 */
export async function whoami({ fresh = false, timeoutMs } = {}) {
  const hit = readLoginCache();
  if (!fresh && hit && Date.now() - hit.at < LOGIN_TTL_MS) return { login: hit.login, cached: true };
  const me = await ghFetch('/user', timeoutMs ? { timeoutMs } : {});
  rememberLogin(me.login);
  return { login: me.login, name: me.name ?? null, avatar: me.avatar_url ?? null, cached: false };
}

/* ---------------------------------------------------------------- GitHub API */

/**
 * 每个 GitHub 请求的上限。
 *
 * `fetch` **默认没有超时** —— 一个卡住的请求会把界面一直悬在"取状态…"上（这正是用户
 * 看到的那段延迟）。有了上限，最坏情况是"明确地说没通"，而不是"永远在转"。
 * 8 秒是给克隆之外的管理类调用定的；克隆/拉取走 git 子进程，另有自己的超时。
 */
const GH_TIMEOUT_MS = Number(process.env.BANDI_GH_TIMEOUT_MS ?? 8000);

/**
 * GitHub API 的**根地址**（2026-10-25，`BANDI_GH_API`）。默认 `api.github.com`，指不了别的就没法测。
 *
 * 为什么要留这个口子（两件事都靠它）：
 *   · **验收**：「建 PR」这条链每一步都在打 GitHub，而班底的冒烟铁律是不联网、不要令牌。
 *     光测纯函数等于没测 —— 请求体写错、422 认不出来、拿旧 sha 去合，全都跑不掉。
 *     有了可指的地址，冒烟能在本机起一个假 GitHub（`fixtures/gh-mock.mjs`）把整条链**真跑一遍**。
 *     ⚠️ 不用「覆盖 `globalThis.fetch`」那招（`smoke-schedules.mjs:179`）：本域的 server 是子进程
 *     起的，父进程换掉的 fetch 影响不到它。
 *   · GitHub Enterprise / 自建镜像的用户 —— 班底不该假定全世界只有 github.com。
 *
 * 只接受 http(s)，且只在**明确设了**的时候才偏离默认：不设 = 行为与今天完全一致。
 */
const GH_API = (() => {
  const raw = String(process.env.BANDI_GH_API ?? '').trim().replace(/\/+$/, '');
  if (!raw) return 'https://api.github.com';
  if (!/^https?:\/\//i.test(raw)) throw new Error(`BANDI_GH_API 要写成 http(s):// 开头的地址：${raw}`);
  return raw;
})();

const ghFetch = async (pathname, { token, method = 'GET', body, timeoutMs = GH_TIMEOUT_MS } = {}) => {
  const t = token ?? readToken();
  if (!t) throw new Error('还没连接 GitHub（先去「工作台 → 研发 → 代码托管」填一个 fine-grained PAT）');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let r;
  let text;
  try {
    r = await fetch(`${GH_API}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'bandi',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ac.signal,
    });
    text = await r.text();
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`GitHub 没在 ${Math.round(timeoutMs / 1000)} 秒内回应（网络或代理的问题）`);
    throw new Error(`连不上 GitHub：${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 原样带着 */
  }
  if (!r.ok) {
    const msg = data?.message ?? text.slice(0, 200);
    // **状态码挂在错误上**（2026-10-25）：建/合的分支处理要靠它。
    // 原来调用方用「消息里有没有 '403' 这几个字符」判 —— 那太脆：GitHub 的 404 消息里
    // 完全可能出现一串数字（sha、限额、issue 号），误判就会把"没权限"这种要人换令牌的信号
    // 报成别的原因。文案照旧给人看，`status` 给代码看。
    const err = new Error(
      r.status === 401
        ? '令牌无效或已过期（401）'
        : r.status === 403
          ? `这个令牌没有权限做这件事（403）：${msg}`
          : r.status === 404
            ? `没找到（404）：${msg}`
            : `GitHub ${r.status}：${msg}`,
    );
    err.status = r.status;
    err.githubMessage = String(msg ?? '');
    throw err;
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

/** 异步跑一个命令（别用 spawnSync 卡住整个控制面）
 *
 * `trim: false` 给**机器格式**的输出用（`git status -z`）：它第一条记录可能以空格开头
 * （` M path`），默认 trim 会把那个空格吃掉、整条记录错位。人看的输出才该 trim。 */
function run(file, args, { cwd, env, timeoutMs = 300000, trim = true } = {}) {
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
      resolve({ code, out: trim ? out.trim() : out });
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
 * 这个目录在哪个**已接入仓库**里？（2026-10-22，节点工作空间）
 *
 * 派活给节点时，控制面用它判断"这个 cwd 能不能让节点自己 clone"：
 * 命中就把 `{fullName, branch}` 记进活里，节点照着在自己那台机器上 clone/pull。
 * 分支读 `.git/HEAD`（一次同步文件读，不 spawn git）—— 那是总机现在停在的分支，
 * 节点对齐它，干完的改动才落在同一条线上。
 *
 * 只认已接入清单里的仓库（localPath 是它们 clone 的落点）—— 用户随便指的一个
 * 目录里哪怕真有 .git，总机也不知道它的 remote，冒然发给节点去 clone 是猜。
 * 不在仓库里返回 null，调用方去走路径映射那一路。
 */
export function repoForCwd(cwd) {
  if (!cwd) return null;
  const canon = (p) => String(p ?? '').trim().replace(/[\\/]+/g, '/');
  const cw = canon(cwd);
  if (!cw) return null;
  const win = process.platform === 'win32';
  for (const r of store.listGitRepos()) {
    const lp = canon(r.localPath);
    if (!lp) continue;
    const inside = win
      ? cw.toLowerCase() === lp.toLowerCase() || cw.toLowerCase().startsWith(lp.toLowerCase() + '/')
      : cw === lp || cw.startsWith(lp + '/');
    if (!inside) continue;
    let branch = null;
    try {
      const head = fs.readFileSync(path.join(lp, '.git', 'HEAD'), 'utf8').trim();
      const m = /^ref: refs\/heads\/(.+)$/.exec(head);
      if (m) branch = m[1];
    } catch {
      /* HEAD 读不到（裸仓库/异常克隆）就不带分支 —— 节点按默认分支处理 */
    }
    return { fullName: r.fullName, branch };
  }
  return null;
}

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
  if (r.code !== 0) {
    const out = String(r.out ?? '');
    // 两种最常见的失败先翻译成人话（2026-10-27，分支弹窗「更新项目」实测撞上）：
    // 新建的本地分支还没推过、没有 upstream；本地和远端各有各的提交。
    if (/no tracking information/i.test(out)) {
      throw new Error('当前分支还没推上去过、没有上游 —— 先推一次（「推送」或建 PR），之后就能拉了');
    }
    if (/not possible to fast-forward|divergent/i.test(out)) {
      throw new Error('本地和远端分叉了（各有各的提交），拉不动 —— 先把你的提交推出去，或去那个目录把历史理一下');
    }
    throw new Error(`拉取没成功：${out.split('\n').slice(-4).join(' ')}`);
  }
  return store.touchGitRepoSync(row.id);
}

/**
 * **合并之后的本地收尾**（2026-10-25）：切回 base、拉最新、删掉本地源分支。
 *
 * 为什么必须做：PR 是在 GitHub 上合的，本地克隆不会自己变 —— 不收尾，人还停在源分支上，
 * 本地 main 也是旧的，下一个任务从旧代码开始（用户实问「合并完还要自己切回 main、拉更新，
 * 能不能集成到平台」）。自动合并（pr-review.doMerge）与手动合并（routes/git.mjs mergeOne）
 * 共用这一处，不再各写一份。
 *
 * 保守边界（宁可不收，也不把人正在干的活搅了）：
 *   · 工作区有未提交改动 → 不动，只说明（正在写代码的树基本都不干净，这一条就是护栏）；
 *   · 当前分支既不是 PR 源分支、也不是 base → 不动（人在别的分支上干活）；
 *   · `pull --ff-only` 分叉就失败，不硬合；
 *   · 删本地分支：只删 `bandi/` 开头、且本地 HEAD 与 PR 的 headSha 完全一致的（没有本地独有提交）；
 *     对不上就留着并说明 —— 删分支可以，删掉没推过的提交不行。
 *
 * @param {string} repo fullName
 * @param {{base?: string, head?: string|null, headSha?: string|null, deleteLocal?: boolean}} opts
 *        base 缺省用仓库记录的默认分支；head 为空 = 「当前分支就是要收的那条」（手动「回 base」按钮）
 */
export async function settleAfterMerge(repo, { base = null, head = null, headSha = null, deleteLocal = true } = {}) {
  const row = store.getGitRepoByFullName(repo);
  if (!row?.localPath || !isGitRepo(row.localPath)) {
    return { settled: false, skipped: 'no-local', note: '本地没有这个仓库的克隆，没动本地' };
  }

  let st;
  try {
    st = await workState(row);
  } catch (e) {
    return { settled: false, skipped: 'status-failed', note: `读不到本地状态，没动：${String(e?.message ?? e).slice(0, 120)}` };
  }
  if (st.detached) return { settled: false, skipped: 'detached', note: '本地不在任何分支上（detached HEAD），没动' };
  if (st.dirtyCount) {
    return { settled: false, skipped: 'dirty', note: `本地还有 ${st.dirtyCount} 个未提交改动，没替你切分支（先自己处理掉再来）` };
  }

  const baseName = String(base || row.defaultBranch || '').trim();
  if (!baseName) return { settled: false, skipped: 'no-base', note: '不知道 base 是哪个分支，没动本地' };

  // 手动「回 base」：head 空 = 当前这条分支就是要离开的那条；自动合并：只认 PR 的源分支
  const from = head || st.branch;
  if (st.branch !== baseName && st.branch !== from) {
    return { settled: false, skipped: 'other-branch', note: `本地当前在 ${st.branch}，不是这条 PR 的分支，没动` };
  }

  let switched = false;
  if (st.branch !== baseName) {
    const co = await gitIn(row.localPath, ['checkout', baseName], { timeoutMs: GIT_FAST_MS });
    if (co.code !== 0) {
      return { settled: false, skipped: 'checkout-failed', note: `切回 ${baseName} 没成：${co.out.split('\n').slice(-3).join(' ')}` };
    }
    switched = true;
  }

  /*
   * 显式写 `origin <base>`：本地 main 不一定设置过 upstream（手动接入的克隆、测试仓库都常见），
   * 裸 `git pull` 会在这种仓库上直接失败（"There is no tracking information"）。
   * 目标分支已经明确了，就不该再依赖 upstream 配置。
   */
  const pull = await gitIn(row.localPath, ['pull', '--ff-only', 'origin', baseName], { timeoutMs: GIT_PUSH_MS });
  const pulled = pull.code === 0;
  const upToDate = pulled && /Already up[- ]to[- ]date/i.test(pull.out);
  let pullNote = null;
  if (!pulled) pullNote = `拉取没成功：${pull.out.split('\n').slice(-3).join(' ')}`;

  let deleted = null;
  let deleteNote = null;
  const branchToDelete = from && from !== baseName && /^bandi\//.test(from) ? from : null;
  if (deleteLocal && branchToDelete) {
    let okToDelete = false;
    if (headSha) {
      // 自动合并：本地这条分支的 HEAD 必须**正好**是 PR 的 head —— 有本地独有提交就别删
      const sha = await gitIn(row.localPath, ['rev-parse', branchToDelete], { timeoutMs: GIT_FAST_MS });
      okToDelete = sha.code === 0 && sha.out === headSha;
      if (!okToDelete) deleteNote = `本地分支 ${branchToDelete} 上有没推过的提交，没删`;
    } else {
      // 手动「回 base」：pull 成功后 main 已包含它，`-D` 后再交给 git 的合并检查兜底
      okToDelete = pulled;
    }
    if (okToDelete) {
      // 自动合并传了 headSha（已核对过提交就是 PR 的那个）→ 可以 -D；
      // 手动「回 base」没有 PR sha → 用 -d，让 git 自己检查"已合并"再删，避免误删没推过的提交
      const del = await gitIn(row.localPath, ['branch', headSha ? '-D' : '-d', branchToDelete], { timeoutMs: GIT_FAST_MS });
      if (del.code === 0) deleted = branchToDelete;
      else deleteNote = `本地分支 ${branchToDelete} 没删掉：${del.out.split('\n').slice(-2).join(' ')}`;
    } else if (!deleteNote) {
      deleteNote = `本地分支 ${branchToDelete} 没删（本地 ${baseName} 还没包含它）`;
    }
  }

  const bits = [switched ? `已切回 ${baseName}` : `已在 ${baseName}`];
  if (pulled) bits.push(upToDate ? '本地是最新的' : '已拉取最新');
  if (pullNote) bits.push(pullNote);
  if (deleted) bits.push(`删了本地分支 ${deleted}`);
  if (deleteNote) bits.push(deleteNote);
  return { settled: true, base: baseName, switched, pulled, deleted, note: bits.join('，') };
}

/** 从清单移除（**不删本地目录** —— 里面可能有你没推的东西） */
export function removeRepo(id) {
  const row = store.getGitRepo(id);
  if (!row) throw new Error('仓库不在清单里');
  store.deleteGitRepo(id);
  return { removed: row, keptPath: row.localPath };
}

/* ---------------------------------------------------------------- 分支 / 改动 / 历史（2026-10-27） */

/**
 * **IDE 式一站式**的本地 git 操作：分支弹窗（列分支/切分支/拉取更新）、
 * 改动管理（单文件 diff / 单文件丢弃 / 普通提交 / 推送）、最近提交历史。
 *
 * 与建 PR 那套的关系：凭据闸（`findSecretPaths`）、提交身份（`commitIdentityArgs`）、
 * 推送翻译（拒收/没权限）**同一套**，不另写一份 —— 两处话说得不一样，人才会疑惑哪边是真的。
 * 全部**只读本地 git**（除了 fetch/push 要联网），界面上点下去就该有反应。
 */

/**
 * 列出本地分支、远程跟踪分支、最近切过的分支、标签（不联网；分支弹窗点开才调）。
 * 「最近」从 HEAD reflog 的 checkout 记录派生（IDE 分支弹窗同款），只留本地分支、去重、限 6 条；
 * 标签按创建时间倒序、限 30 条（清单是给人挑的，不是全量导出）。
 */
export async function listBranches(row) {
  const cwd = row.localPath;
  if (!isGitRepo(cwd)) throw new Error(`本地目录不是 git 仓库（没有 .git）：${cwd}`);
  const headRef = await gitIn(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const local = await gitIn(cwd, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']);
  if (local.code !== 0) throw new Error(`读本地分支失败：${local.out.split('\n').slice(-3).join(' ')}`);
  const remote = await gitIn(cwd, ['for-each-ref', 'refs/remotes', '--format=%(refname:short)']);
  const tags = await gitIn(cwd, ['for-each-ref', 'refs/tags', '--format=%(refname:short)', '--sort=-creatordate']);
  const current = headRef.code === 0 ? headRef.out : null;
  const localNames = local.out.split('\n').map((s) => s.trim()).filter(Boolean);
  const rl = await gitIn(cwd, ['reflog', '--format=%gs', '-n', '80']);
  const recent = [];
  if (rl.code === 0) {
    for (const line of rl.out.split('\n')) {
      const m = /^checkout: moving from .+ to (.+)$/.exec(String(line).trim());
      if (!m) continue;
      const to = m[1];
      if (to === current || recent.includes(to) || !localNames.includes(to)) continue;
      recent.push(to);
      if (recent.length >= 6) break;
    }
  }
  return {
    current,
    local: localNames,
    // `origin/HEAD` 是"默认分支指向哪"的别名，不是真分支 —— `refname:short` 下它输出裸
    // `origin`（不带 /HEAD 后缀），所以还要排除不含 `/` 的条目（远程分支短名必有 远程名/分支）
    remote: remote.code === 0
      ? remote.out.split('\n').map((s) => s.trim()).filter((s) => s && s.includes('/') && !/\/HEAD$/.test(s))
      : [],
    recent,
    tags: tags.code === 0 ? tags.out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30) : [],
  };
}

/**
 * 新建分支并切过去（IDE 的「新建分支」）：从**当前 HEAD**拉出。
 * 故意**不做脏工作区闸**：`checkout -b` 不动任何文件，把没提交的改动顺手带到新分支上
 * 正是"干到一半想开新线"的用法（IDE 也这样）；真正会动文件的 checkout（切已有分支）
 * 才在 checkoutBranch 里拦。detached HEAD 也能建（从当前那个 commit 拉出，是 recovery 正路）。
 */
export async function createBranch(row, name) {
  const cwd = row.localPath;
  if (!isGitRepo(cwd)) throw new Error(`本地目录不是 git 仓库（没有 .git）：${cwd}`);
  const b = assertBranchName(name);
  const co = await gitIn(cwd, ['checkout', '-b', b], { timeoutMs: GIT_FAST_MS });
  if (co.code !== 0) {
    const out = String(co.out ?? '');
    if (/already exists/i.test(out)) throw new Error(`本地已经有分支 ${b} 了 —— 换个名字，或直接在清单里切过去`);
    throw new Error(`建分支没成：${out.split('\n').slice(-3).join(' ')}`);
  }
  return { created: b };
}

/**
 * 切分支（分支弹窗点某一条；标签也走这里 —— `git checkout <tag>` 会进游离 HEAD，
 * 由界面的确认框提前说清，提交/推送在 detached 下各自有明确报错）。
 *
 * 护栏与 `settleAfterMerge` 同一套：脏工作区**不动**、原话带回；git 失败原话带回。
 * 远程分支（`origin/x`）剥掉前缀交给裸 `git checkout` —— git 自己会 dwim 出本地跟踪分支；
 * 本地已有同名分支时就是普通切换，两种情况一条命令都覆盖。
 */
export async function checkoutBranch(row, name) {
  const cwd = row.localPath;
  if (!isGitRepo(cwd)) throw new Error(`本地目录不是 git 仓库（没有 .git）：${cwd}`);
  const target = assertBranchName(String(name ?? '').trim().replace(/^origin\//, ''));
  const st = await workState(row);
  if (st.branch === target) return { switched: false, branch: target, note: `已经在这个分支上了` };
  if (st.dirtyCount) {
    throw new Error(`本地还有 ${st.dirtyCount} 个未提交改动，没替你切分支（先提交或丢弃，再切）`);
  }
  const co = await gitIn(cwd, ['checkout', target], { timeoutMs: GIT_FAST_MS });
  if (co.code !== 0) throw new Error(`切到 ${target} 没成：${co.out.split('\n').slice(-3).join(' ')}`);
  return { switched: true, branch: target };
}

/**
 * 普通提交（**不建 PR、不推送**）：把工作区全部改动收到当前分支上。
 * 与建 PR 共用凭据闸 —— 界面上"就是要提交"和建 PR 弹窗里那颗是一个意思。
 */
export async function commitAll(row, { message, allowSecrets = false, paths = null } = {}) {
  const msg = String(message ?? '').trim();
  if (!msg) throw new Error('提交说明是空的 —— 一句话说清这次改了什么');
  const st = await workState(row);
  if (st.detached) throw new Error('当前不在任何分支上（detached HEAD）—— 先在那个目录 checkout 回一个分支再提交');
  if (!st.dirtyCount) throw new Error('工作区是干净的，没有可提交的改动');
  /* 勾选提交（2026-10-27，用户："加选择框允许选择提交"）：paths 给了就只收勾选的，
     模式与 commitAndPush 同款 —— 对不上（期间文件变了）直接拒，别静默改提交内容。 */
  const subset = Array.isArray(paths) && paths.length > 0;
  const picked = subset ? st.dirty.filter((f) => paths.includes(f.path)) : st.dirty;
  if (subset && picked.length !== paths.length) {
    throw new Error('选中的文件和工作区对不上了（期间有人动过）—— 重新看一次改动再提交');
  }
  const secrets = findSecretPaths(picked.map((f) => f.path));
  if (secrets.length && !allowSecrets) {
    throw new Error(`改动里有看着像凭据的文件：${secrets.slice(0, 4).join('、')}${secrets.length > 4 ? ` 等 ${secrets.length} 个` : ''} —— 一旦提交就进历史了。确认可以提交，再带上"就是要提交"`);
  }
  const idArgs = await commitIdentityArgs(row.localPath);
  const addTargets = addTargetsOf(picked);
  // 全是"已暂存的删除"时 targets 为空：整提（非子集）补一把 -A 兜底；子集时什么都不 add
  //（勾的都在 index 里了，再 -A 会把没勾的也带上）
  const addArgs = addTargets.length ? ['add', '-A', '--', ...addTargets] : subset ? null : ['add', '-A'];
  if (addArgs) {
    const add = await gitIn(row.localPath, addArgs, { timeoutMs: GIT_FAST_MS });
    if (add.code !== 0) throw new Error(`git add 没成：${add.out.split('\n').slice(-3).join(' ')}`);
  }
  const commit = await gitIn(row.localPath, [...idArgs, 'commit', '-m', msg]);
  if (commit.code !== 0) throw new Error(`提交没成：${commit.out.split('\n').slice(-4).join(' ')}`);
  const sha = await gitIn(row.localPath, ['rev-parse', 'HEAD']);
  return { committed: { sha: sha.code === 0 ? sha.out : null, subject: msg }, branch: st.branch, files: picked.length };
}

/**
 * 把 `git push` 的失败输出翻译成人话（**纯函数**，冒烟直接钉）。
 *
 * 2026-10-27 实报：人往 `main` 直接推，被 GitHub 规则集拒了，应用却按"非快进"那档说
 * 「远端有本地没有的提交 —— 先点同步」，完全反了（本地其实是领先的）。原始输出长这样：
 *
 *   remote: - Changes must be made through a pull request.
 *   remote: - Required status check "gate" is expected.
 *   ! [remote rejected] main -> main (push declined due to repository rule violations)
 *
 * 所以**先认"保护规则"这一档**（它同样带 `[remote rejected]`，必须先于非快进判断），
 * 并把 `remote:` 里的规则原话带上 —— 人得知道挡他的是"必须走 PR"还是"gate 没过"。
 *
 * @param {string} out  git push 的输出（stdout + stderr）
 * @param {{branch?: string|null, remote?: string, base?: string|null, rejectedHint?: 'sync'|'rename'}} opts
 */
export function translatePushFailure(out, { branch = null, remote = 'origin', base = null, rejectedHint = 'sync' } = {}) {
  const text = String(out ?? '');
  const raw = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' ');
  const ruleLines = text
    .split('\n')
    .map((l) => l.replace(/^remote:\s*/, '').trim())
    .filter((l) => l && /\b(pull request|required status check|repository rule|protected branch)\b/i.test(l))
    .slice(0, 3);
  const rules = ruleLines.length ? `（${ruleLines.join('；')}）` : '';

  // ① 分支保护 / ruleset —— 不是"你落后了"，是"这个分支不许直接推"
  if (/push declined due to repository rule|must be made through a pull request|protected branch|required status check|GH006/i.test(text)) {
    const who = `${remote}${branch ? ` 的 ${branch}` : ''}`;
    return base && branch === base
      ? `推不上去：${who} 是 base 分支、有保护规则${rules} —— 不能直接推。改成切一条新分支推上去、建 PR，等 gate 检查绿了再合并。平台**不会强推**，也绕不过保护。原始信息：${raw}`
      : `推不上去：${who} 分支有保护规则${rules} —— 不能直接推。改成推一条新分支、建 PR（平台不会强推，也绕不过保护）。原始信息：${raw}`;
  }
  // ② 快进不了：远端有你本地没有的提交（这才是"先同步"那种）
  if (/rejected|non-fast-forward/i.test(text)) {
    return rejectedHint === 'rename'
      ? `远端已经有一个不同的 ${branch ?? '同名'} 分支（推送被拒）。平台**不会强推** —— 换一个分支名，或先在那个目录把分支理干净。原始信息：${raw}`
      : `远端有本地没有的提交（推送被拒）—— 先点「同步」拉一次；分叉了同步不动就去那个目录理历史。平台**不会强推**。原始信息：${raw}`;
  }
  // ③ 权限
  if (/Permission denied|403|Authentication failed|invalid credentials|Write access/i.test(text)) {
    return `推不上去：这个令牌对 ${remote} 没有 Contents: write（或在 Repository access 里没选中它）。原始信息：${raw}`;
  }
  return `推送失败：${text.trim() || 'git 没给原因'}`;
}

/**
 * 推送当前分支（普通 push，**绝不强推**）。
 * 与 commitAndPush 只有一处不同：建 PR 只往新分支推，这里推的就是人现在站的分支 ——
 * 这是人自己的明确动作，平台不替他挑分支，也不拦"直接推 main"（单人仓库这是常态）；
 * 但**仓库自己的规则**（分支保护）会拒，拒了就说清楚是规则挡的（2026-10-27）。
 */
export async function pushCurrent(row) {
  const st = await workState(row);
  if (!st.hasRemote) throw new Error('这个目录没有 origin（手动接入的本地克隆要先把 origin 指回 GitHub）—— 没有 origin 就推不上去');
  if (st.detached) throw new Error('当前不在任何分支上（detached HEAD）—— 先 checkout 回一个分支再推');
  const push = await gitIn(row.localPath, [...gitAuthArgs(), 'push', '--set-upstream', 'origin', `refs/heads/${st.branch}:refs/heads/${st.branch}`], { timeoutMs: GIT_PUSH_MS });
  if (push.code !== 0) {
    throw new Error(
      translatePushFailure(String(push.out ?? ''), { branch: st.branch, base: row.defaultBranch ?? null }),
    );
  }
  return { pushed: st.branch };
}

/** `fetch --prune origin`：给分支弹窗的「拉取更新」用 —— 刷新远程分支清单，不动工作区 */
export async function fetchRepo(row) {
  if (!isGitRepo(row.localPath)) throw new Error(`本地目录不是 git 仓库（没有 .git）：${row.localPath}`);
  const r = await gitIn(row.localPath, [...gitAuthArgs(), 'fetch', '--prune', 'origin'], { timeoutMs: GIT_PUSH_MS });
  if (r.code !== 0) throw new Error(`拉取没成功：${r.out.split('\n').slice(-3).join(' ')}`);
  return { fetched: true };
}

/** HEAD 最近 N 条提交（不联网）。空仓库（一条提交都没有）不算错，回空清单 */
export async function recentLog(row, limit = 50) {
  const cwd = row.localPath;
  if (!isGitRepo(cwd)) throw new Error(`本地目录不是 git 仓库（没有 .git）：${cwd}`);
  const n = Math.max(1, Math.min(Number(limit) || 50, 200));
  const log = await gitIn(cwd, ['log', `--max-count=${n}`, '--date=iso-local', '--pretty=format:%h%x09%an%x09%ad%x09%s']);
  if (log.code !== 0) return { commits: [], note: log.out.split('\n').filter(Boolean).slice(-1)[0] ?? null };
  const commits = log.out.split('\n').filter(Boolean).map((line) => {
    const [sha, author, date, ...rest] = line.split('\t');
    return { sha, author, date, subject: rest.join('\t') };
  });
  return { commits };
}

/**
 * 丢弃指定文件的未提交改动（IDE 的 Rollback）。
 *
 * path 必须在**当下**的工作区清单里 —— 拿着旧清单来丢，要么文件刚被提交/丢弃过，
 * 要么是乱传的路径，都拒。处置按 porcelain 的 X 列分派（Y 列只是工作区态，restore 全兜住）：
 *   · `??` 未跟踪 → `git clean -f`（"丢弃"一个新文件 = 删掉它）；
 *   · `A` 新增（已暂存、HEAD 里没有）→ `git rm -f`（index + 工作区一起清）；
 *   · `R`/`C` 重命名/复制 → 新路径同上，旧路径 `checkout HEAD --` 恢复；
 *   · 其余（M/D/T 或仅工作区态）→ `checkout HEAD --`（index 和工作区一起回到 HEAD）。
 */
export async function discardPaths(row, paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).map((p) => String(p ?? '').trim()).filter(Boolean);
  if (!list.length) throw new Error('没有要丢弃的文件');
  const st = await workState(row);
  if (!st.dirtyCount) throw new Error('工作区是干净的，没有可丢弃的改动');
  const known = new Map(st.dirty.map((f) => [f.path, f]));
  const unknown = list.filter((p) => !known.has(p));
  if (unknown.length) throw new Error(`这些文件不在当前改动清单里（可能刚被提交/丢弃过，刷新一下）：${unknown.slice(0, 3).join('、')}`);
  const discarded = [];
  for (const p of list) {
    const f = known.get(p);
    const xy = String(f.status ?? '');
    const steps = [];
    if (xy === '??') steps.push([['clean', '-f', '--', p]]);
    else if (xy[0] === 'R' || xy[0] === 'C') {
      steps.push([['rm', '-f', '-q', '--', p]], [['checkout', 'HEAD', '--', f.from]]);
    } else if (xy[0] === 'A') steps.push([['rm', '-f', '-q', '--', p]]);
    else steps.push([['checkout', 'HEAD', '--', p]]);
    for (const [args] of steps) {
      const r = await gitIn(row.localPath, args, { timeoutMs: GIT_FAST_MS });
      if (r.code !== 0) throw new Error(`丢弃 ${p} 没成：${r.out.split('\n').slice(-2).join(' ')}`);
    }
    discarded.push(p);
  }
  return { discarded };
}

/**
 * 单个未提交文件的 diff（人看的 unified diff，只读）。
 *
 * 统一用 `git diff HEAD`：把已暂存和未暂存合成"相对 HEAD"的一份，跟 IDE 的 Local Changes
 * 一个口径 —— 分开看 staged/unstaged 对这个界面太细了。未跟踪的文件 diff HEAD 看不见，
 * 先 `add -N`（intent-to-add，轻量登记、不算真暂存，提交时 `add -A` 照样收编）再看。
 */
export async function fileDiff(row, path) {
  const p = String(path ?? '');
  const st = await workState(row);
  const f = st.dirty.find((x) => x.path === p || x.from === p);
  if (!f) throw new Error('这个文件不在当前改动清单里（可能刚被提交/丢弃过，刷新一下）');
  const xy = String(f.status ?? '');
  if (xy === '??') {
    const n = await gitIn(row.localPath, ['add', '-N', '--', f.path], { timeoutMs: GIT_FAST_MS });
    if (n.code !== 0) throw new Error(`登记新文件没成：${n.out.split('\n').slice(-2).join(' ')}`);
  }
  const paths = f.from ? [f.path, f.from] : [f.path];
  const d = await gitIn(row.localPath, ['diff', 'HEAD', '--no-color', '--', ...paths], { timeoutMs: GIT_FAST_MS });
  if (d.code !== 0) throw new Error(`读 diff 没成：${d.out.split('\n').slice(-2).join(' ')}`);
  return { path: f.path, status: xy, diff: d.out };
}

/* ---------------------------------------------------------------- 分支管理（2026-10-27） */

/**
 * 分支名 → 本地 / 远端**已存在**的那个 ref（口径与 `listBranches` 一致）。
 *
 * 名字先过 `assertBranchName`，再由这里拼成 `refs/heads/…` / `refs/remotes/origin/…` ——
 * 绝不把调用方给的字符串直接当 git 参数或路径。远端只认 `origin/` 一种写法
 * （界面「远程分支」那一组给的就是 `origin/x`）。
 */
async function branchRefOf(cwd, rawName) {
  const n = String(rawName ?? '').trim();
  if (!n) throw new Error('没说哪个分支');
  if (n.startsWith('origin/')) {
    const short = assertBranchName(n.slice('origin/'.length));
    const ref = `refs/remotes/origin/${short}`;
    const r = await gitIn(cwd, ['rev-parse', '--verify', '--quiet', ref], { timeoutMs: GIT_FAST_MS });
    if (r.code !== 0 || !r.out) throw new Error(`找不到远端分支 origin/${short}（先点「更新项目」拉一次）`);
    return { ref, name: `origin/${short}` };
  }
  const short = assertBranchName(n);
  const ref = `refs/heads/${short}`;
  const r = await gitIn(cwd, ['rev-parse', '--verify', '--quiet', ref], { timeoutMs: GIT_FAST_MS });
  if (r.code !== 0 || !r.out) throw new Error(`本地没有分支 ${short}（先点「更新项目」拉一次，或看远端分支列表）`);
  return { ref, name: short };
}

/** 远端合并判断的基准：`origin/<base>` 在就用它（远端为准），否则退回本地 base */
async function remoteBaseRef(cwd, baseName) {
  const ob = await gitIn(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseName}`], { timeoutMs: GIT_FAST_MS });
  if (ob.code === 0 && ob.out) return `refs/remotes/origin/${baseName}`;
  return (await branchRefOf(cwd, baseName)).ref;
}

/**
 * **与 base 比较**（只读，IDE 的 Compare with Branch 同款）。
 *
 * 用三点 diff `base...branch`：从两条分支**分叉点**算到 branch 的改动 —— 这才是
 * "这条分支相对 base 改了什么"，两点 diff 会把 base 后来的提交也倒着显示成改动。
 *
 * 返回里带中括号 ref（`baseRef` / `targetRef`），逐文件 diff 复用同一个基准，
 * 不再让前端传 ref 进来（那是把 git 参数交给浏览器）。
 */
export async function compareBranch(row, { branch = null, base = null } = {}) {
  const cwd = row.localPath;
  if (!isGitRepo(cwd)) throw new Error(`本地目录不是 git 仓库（没有 .git）：${cwd}`);
  const baseName = String(base || row.defaultBranch || '').trim();
  if (!baseName) throw new Error('仓库没记默认分支（base）—— 先在仓库设置里填一个');
  const st = await workState(row);
  const target = await branchRefOf(cwd, branch || st.branch || '');
  const baseRef = await branchRefOf(cwd, baseName);
  if (target.ref === baseRef.ref) throw new Error(`和 base（${baseName}）是同一个分支 —— 没有可比的改动`);
  const ns = await gitIn(
    cwd,
    ['-c', 'core.quotepath=false', 'diff', '--name-status', '--no-color', `${baseRef.ref}...${target.ref}`],
    { timeoutMs: GIT_FAST_MS },
  );
  if (ns.code !== 0) throw new Error(`读对比清单没成：${ns.out.split('\n').slice(-2).join(' ')}`);
  const files = ns.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code, a, b] = line.split('\t');
      const kind = String(code ?? '');
      const moved = kind.startsWith('R') || kind.startsWith('C');
      return { code: kind, status: kind[0] || 'M', path: moved ? b : a, from: moved ? a : null };
    });
  const short = await gitIn(cwd, ['diff', '--shortstat', `${baseRef.ref}...${target.ref}`], { timeoutMs: GIT_FAST_MS });
  return {
    base: baseName,
    branch: target.name,
    baseRef: baseRef.ref,
    targetRef: target.ref,
    files,
    shortstat: String(short.out ?? '').trim() || null,
  };
}

/** 对比里单个文件的 diff（path 必须**当下**还在对比清单里 —— 拿旧清单来查一律拒） */
export async function branchFileDiff(row, { branch = null, base = null, path } = {}) {
  const p = String(path ?? '');
  if (!p) throw new Error('要指定文件');
  const cmp = await compareBranch(row, { branch, base });
  const f = cmp.files.find((x) => x.path === p || x.from === p);
  if (!f) throw new Error('这个文件不在对比清单里（可能刚变过，刷新一下再试）');
  const paths = f.from && f.from !== f.path ? [f.path, f.from] : [f.path];
  const d = await gitIn(row.localPath, ['diff', '--no-color', `${cmp.baseRef}...${cmp.targetRef}`, '--', ...paths], {
    timeoutMs: GIT_FAST_MS,
  });
  if (d.code !== 0) throw new Error(`读 diff 没成：${d.out.split('\n').slice(-2).join(' ')}`);
  return { path: f.path, status: f.code, diff: d.out };
}

/**
 * **删分支**（本地 / 远端）。删分支 = 扔提交的最后一道口子，所以护栏比别的动作更紧：
 *
 *   · 不能删 base 分支；
 *   · 本地不能删**当前所在**的分支（要先切走 —— 和 checkout 的脏工作区护栏同一个出发点）；
 *   · 必须**已合并进 base**（`merge-base --is-ancestor` 先挡一道，`git branch -d` 再兜一道）——
 *     没合并的分支一律不删，"删分支把活扔了"不在平台的能力范围内；
 *   · 远端只删 `bandi/` 开头的（平台自己拉的）；还得先确认**没有开着的 PR** ——
 *     删掉 PR 的 head 分支等于把那个 PR 弄成"无从查看"，先合/关再删；
 *   · 删远端前先 fetch，合并判断用的是**刚拉到的** origin/<base>，不吃过期引用。
 */
export async function deleteBranch(row, { branch, remote = false, base = null } = {}) {
  const cwd = row.localPath;
  if (!isGitRepo(cwd)) throw new Error(`本地目录不是 git 仓库（没有 .git）：${cwd}`);
  const raw = String(branch ?? '').trim();
  const askRemote = !!remote || raw.startsWith('origin/');
  const name = assertBranchName(raw.replace(/^origin\//, ''));
  const baseName = String(base || row.defaultBranch || '').trim();
  if (!baseName) throw new Error('仓库没记默认分支（base）—— 先在仓库设置里填一个');
  if (name === baseName) throw new Error(`不能删 base 分支（${baseName}）`);

  if (askRemote) {
    if (!/^bandi\//.test(name)) throw new Error(`远端只删平台自己建的分支（bandi/ 开头）；${name} 不是，要删请去 GitHub 上删`);
    if (!readToken()) throw new Error('先连接 GitHub 才能删远端分支（令牌只存本机）');
    const open = await findOpenPullForHead(row.fullName, name, row.owner).catch(() => null);
    if (open) throw new Error(`这条分支上还有开着的 PR #${open.number} —— 先把它合掉或关掉，再删分支`);
    const f = await gitIn(cwd, [...gitAuthArgs(), 'fetch', '--prune', 'origin'], { timeoutMs: GIT_PUSH_MS });
    if (f.code !== 0) throw new Error(`拉远端分支状态没成（查网络 / 令牌）：${f.out.split('\n').slice(-2).join(' ')}`);
    const rref = `refs/remotes/origin/${name}`;
    const exist = await gitIn(cwd, ['rev-parse', '--verify', '--quiet', rref], { timeoutMs: GIT_FAST_MS });
    if (exist.code !== 0 || !exist.out) throw new Error(`远端已经没有 ${name} 了（可能刚被人删掉）—— 刷新一下`);
    const merged = await gitIn(cwd, ['merge-base', '--is-ancestor', rref, await remoteBaseRef(cwd, baseName)], {
      timeoutMs: GIT_FAST_MS,
    });
    if (merged.code !== 0) throw new Error(`${name} 还有没合并进 ${baseName} 的提交 —— 先合并（建 PR）再删，别用删分支丢代码`);
    await deleteRemoteBranch(row.fullName, name);
    return { deleted: name, remote: true };
  }

  const st = await workState(row);
  if (st.branch === name) throw new Error(`不能删当前所在的分支（${name}）—— 先切到别的分支`);
  const ref = `refs/heads/${name}`;
  const exist = await gitIn(cwd, ['rev-parse', '--verify', '--quiet', ref], { timeoutMs: GIT_FAST_MS });
  if (exist.code !== 0 || !exist.out) throw new Error(`本地没有分支 ${name}（可能刚删过）—— 刷新一下`);
  const baseRef = await branchRefOf(cwd, baseName);
  const merged = await gitIn(cwd, ['merge-base', '--is-ancestor', ref, baseRef.ref], { timeoutMs: GIT_FAST_MS });
  if (merged.code !== 0) throw new Error(`${name} 还有没合并进 ${baseName} 的提交 —— 先合并（建 PR）再删，别用删分支丢代码`);
  const del = await gitIn(cwd, ['branch', '-d', name], { timeoutMs: GIT_FAST_MS });
  if (del.code !== 0) throw new Error(`删分支没成：${del.out.split('\n').slice(-2).join(' ')}`);
  return { deleted: name, remote: false };
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

/**
 * 把「巡检报上来的 PR 信息」归一成卡片上的那五个字段（2026-10-17）。
 *
 * 巡检脚本（`tools/repo-scan.mjs`）手里是 GitHub 的原始形状（`html_url` / `state` / `merged_at`），
 * 卡片要的是另一套。解析不出来的**返回 null** —— 让调用方按"这次没带 PR"处理，
 * 绝不写半截字段进库：少一个 `prNumber`，界面就会画出「PR null」这种没名字的标签。
 */
export function prFieldsOf(pr) {
  const ref = parsePrRef(pr?.url ?? pr?.ref ?? '');
  if (!ref) return null;
  const state = ['open', 'merged', 'closed'].includes(pr?.state) ? pr.state : 'open';
  const title = String(pr?.title ?? '').trim();
  return {
    prRepo: ref.repo,
    prNumber: ref.number,
    prState: state,
    prTitle: title || null,
    prCheckedAt: new Date().toISOString(),
  };
}

/**
 * 列出一个仓库**开着的** PR（走平台令牌，私有仓库也能列）。
 *
 * 给「PR 巡检」定时任务用（2026-10-17）。和 `fetchPull` 的分工：
 *   · 这里是**清单**（列表接口，一次 30 条，不逐条查详情 —— 那是 30 次请求）；
 *   · 单条状态（尤其 merged）只有 `fetchPull` 知道：列表里关掉/合掉的 PR 根本不会出现。
 * 所以巡检是"列表发现新的 + 按卡上记的再查一遍旧的"，两件事都得有。
 */
export async function listOpenPulls(repo) {
  const list = await ghFetch(`/repos/${repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`);
  return (Array.isArray(list) ? list : []).map((p) => ({
    number: Number(p.number),
    title: String(p.title ?? ''),
    url: p.html_url ?? `https://github.com/${repo}/pull/${p.number}`,
    author: p.user?.login ?? '',
    draft: !!p.draft,
    // head.sha：这次改动**最新的提交号**。「新 PR」的判定就靠它 —— PR 改描述不算新，
    // 推了新提交（sha 变了）才算新改动、才值得再烧一次模型去审。
    headSha: p.head?.sha ?? null,
    /*
     * 2026-10-27「PR 区域」：把"这条 PR 从哪来、能不能合"摆到行上（原来只有编号/标题/作者）。
     *   · baseRef / headRef → 行上写 `head → base`；
     *   · mergeable / mergeableState → 合并按钮能不能按（conflict / behind / blocked / draft）；
     *   · mergeable 是 GitHub 懒计算的：刚建/刚推可能先回 null，界面按"未知"处理，别当成"能合"。
     */
    baseRef: p.base?.ref ?? null,
    headRef: p.head?.ref ?? null,
    mergeable: typeof p.mergeable === 'boolean' ? p.mergeable : null,
    mergeableState: p.mergeable_state ?? null,
    updatedAt: p.updated_at ?? null,
  }));
}

/**
 * GitHub 的 check-runs → 一个能放在 PR 行上的结论（**纯函数**，冒烟直接钉）。
 *
 * 为什么归约成一句话就够：界面只需要回答"现在能不能合" —— gate 绿了没、是不是还在跑、
 * 红了是哪条。逐条 check 的细节去 GitHub 看，不在这个列表里摊。
 *
 * 优先级：有任何失败结论 → failure；还有没跑完的 → pending；一条都没有 → none；全绿 → success。
 */
export function summarizeChecks(runs) {
  const list = Array.isArray(runs) ? runs : [];
  if (!list.length) return { state: 'none', total: 0, failed: [], pending: [] };
  const failed = list
    .filter((r) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(r.conclusion))
    .map((r) => r.name)
    .filter(Boolean);
  const pending = list
    .filter((r) => r.conclusion === null || r.conclusion === undefined)
    .map((r) => r.name)
    .filter(Boolean);
  const total = list.length;
  if (failed.length) return { state: 'failure', total, failed, pending };
  if (pending.length) return { state: 'pending', total, failed: [], pending };
  return { state: 'success', total, failed: [], pending: [] };
}

/** 查一条提交的 checks 汇总（PR 区每行用；失败降级成 unknown，不挡别的 PR 显示） */
export async function pullChecks(repo, sha) {
  if (!sha) return { state: 'unknown', total: 0, failed: [], pending: [] };
  const data = await ghFetch(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  return summarizeChecks(data?.check_runs);
}

/** 列出开着的 issue（剔除 PR —— GitHub 的 issues 接口把 PR 也当 issue 返回） */
export async function listOpenIssues(repo) {
  const list = await ghFetch(`/repos/${repo}/issues?state=open&per_page=30&sort=updated&direction=desc`);
  return (Array.isArray(list) ? list : [])
    .filter((x) => !x.pull_request)
    .map((x) => ({
      number: Number(x.number),
      title: String(x.title ?? ''),
      url: x.html_url ?? '',
      author: x.user?.login ?? '',
      labels: (x.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    }));
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
    // —— 审阅与合并闸需要的（2026-10-23，PRD 第五节/第六节）——
    headSha: pr.head?.sha ?? null,
    author: pr.user?.login ?? '',
    body: pr.body ?? '',
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    changedFiles: Number(pr.changed_files ?? 0),
    draft: !!pr.draft,
    mergeableState: pr.mergeable_state ?? null,
  };
}

/**
 * 列出一个 PR 的**改动文件**（审阅的素材，不是给人看的 diff —— 人看 diff 去 GitHub）。
 *
 * 每个文件带上 GitHub 返回的 patch（超过一定大小的文件 GitHub 不给 patch，那就只报文件名）。
 * patch 在这里**截短**：给模型的是判断素材不是全文，单文件 1200 字、总量 24000 字封顶，
 * 再大的 PR 说明它本来就该人多花时间看，而不是让模型硬吞。
 */
export async function listPullFiles(repo, number) {
  const list = await ghFetch(`/repos/${repo}/pulls/${number}/files?per_page=50`);
  let budget = 24000;
  return (Array.isArray(list) ? list : []).map((f) => {
    let patch = typeof f.patch === 'string' ? f.patch : null;
    if (patch && patch.length > 1200) patch = patch.slice(0, 1199) + '…（截短）';
    if (patch && patch.length > budget) {
      patch = null;
    } else if (patch) {
      budget -= patch.length;
    }
    return {
      filename: f.filename ?? '',
      status: f.status ?? 'modified',
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
      patch,
    };
  });
}

/**
 * 这个提交上 CI 跑得怎么样（合并闸第 2 条的判据来源）。
 *
 * 归一成三档：success（全绿）/ failure（有红的）/ none（**什么检查都没配**）。
 * ⚠️ 「跑着呢」(pending) 也归进 failure 档的语义 —— 闸的规矩是"没有绿就不算过"，
 * 引用 PRD 第六节：没有 CI 状态不算过，不然绕过安检门的合并就成了常态。
 */
export async function getChecks(repo, sha) {
  if (!sha) return { state: 'none' };
  let runs = [];
  try {
    const data = await ghFetch(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    runs = Array.isArray(data?.check_runs) ? data.check_runs : [];
  } catch {
    /* check-runs 拿不到（老令牌/仓库禁用 Actions）就按"没有 CI"算，别让闸卡死 */
    return { state: 'none' };
  }
  if (!runs.length) return { state: 'none' };
  if (runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled' || r.status !== 'completed')) {
    return { state: 'failure', failed: runs.filter((r) => r.conclusion && r.conclusion !== 'success').map((r) => r.name).slice(0, 3) };
  }
  return { state: 'success' };
}

/**
 * 合并一个 PR（2026-10-23；2026-10-25 起与 `createPull` 并列为平台两处写 GitHub 的地方）。
 *
 * 谁能走到这儿由调用方管（流程合并节点的判据表 / 「工作台 → 研发 → 代码托管」上的人点按钮），
 * 这里只管把 API 调了、把结果说人话：
 *   · 405「not mergeable」多半是冲突或分支保护 —— 原样带回，别翻译成"系统错误"；
 *   · 403 是令牌没有 contents:write —— 那是**该等人换令牌**的明确信号，带上原话；
 *   · 409 是给了 `sha` 但 head 期间变了（有人推了新提交）—— 必须让人重看，别盲重试。
 */
export async function mergePull(repo, number, { commitTitle = null, mergeMethod = 'merge', sha = null } = {}) {
  const body = { merge_method: mergeMethod };
  if (commitTitle) body.commit_title = commitTitle;
  // 乐观锁：拿闸判据看下的那个 head SHA 去合，期间有人推提交就撞 409，而不是合掉一份没看过的改动
  if (sha) body.sha = sha;
  try {
    const data = await ghFetch(`/repos/${repo}/pulls/${number}/merge`, { method: 'PUT', body });
    return { merged: !!data.merged, message: data.message ?? '', sha: data.sha ?? null };
  } catch (e) {
    if (e?.status === 409) throw new Error('这个 PR 在你看的这段时间里被人推了新提交（409）：刷新后重看再合');
    if (e?.status === 405 || /not mergeable/i.test(String(e?.githubMessage ?? ''))) throw new Error(`GitHub 拒绝合并（405）：${e?.githubMessage ?? e?.message ?? e} —— 多半是有冲突、或分支保护（必需检查/必需审阅）没过`);
    if (e?.status === 403) throw new Error(`令牌没有合并权限（403）：${e?.githubMessage ?? e.message}——去 GitHub 给这个 PAT 勾上 contents:write 再换一次（现在挂的是 ${tokenHint() ?? '没令牌'}）`);
    throw e;
  }
}

/* ---------------------------------------------------------------- 建 PR（写侧，2026-10-25） */

/**
 * 「员工在克隆目录里改完 → 平台上点一下出 PR」缺的那半截。
 *
 * 为什么做在服务端、而不是给员工装一个会建 PR 的技能（2026-10-25 用户问"github 上有没有现成的"）：
 *   · 令牌只在这侧 —— `agentEnv()` 把 `GIT_*`/`GH_TOKEN`/`GITHUB_TOKEN` 全删了（2026-10-17 事故后的规矩），
 *     让员工拿 `gh` 建 PR 等于把凭据发回去，还绕开 `tools/check-pr.mjs` 与合并四闸；
 *   · 建/合是**外部可见且难收回**的动作，账要落在平台（卡上五个字段 + 流程实例），不能只留在会话里；
 *   · 零依赖：用已有的 `fetch` + `spawn git`，不引 octokit、不要求装 gh。
 *
 * 沿用其**交互**约定，实现全部自研：收尾分支的"先确认 base、别默认强推、没测绿不结"来自
 * obra/superpowers 的 `finishing-a-development-branch`（MIT）；PR 正文该带"改了什么 + 怎么验的"
 * 来自 create-pr-with-evidence 那条契约。
 */

/** 只读本地 git 的命令上限（一次状态查询不该把人挂在网络/磁盘上） */
const GIT_FAST_MS = 20000;
/** push 的上限：大仓库第一次推一个分支，比一次状态查询慢得多 */
const GIT_PUSH_MS = 180000;

/**
 * 分支名的规矩（git 的 ref 规则里最容易撞的那几条，先在服务端挡一道）。
 * 挡住比让 push 报一堆英文强。
 */
export function assertBranchName(name) {
  const b = String(name ?? '').trim();
  if (!b) throw new Error('分支名是空的');
  if (b.length > 100) throw new Error(`分支名太长（${b.length} 个字符，上限 100）`);
  if (/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(b)) throw new Error('分支名不能有空格和 ~ ^ : ? * [ ] \\ 这些字符');
  if (b.startsWith('/') || b.endsWith('/') || b.includes('//')) throw new Error('分支名不能以 / 开头或结尾，也不能有连续的 //');
  if (b.startsWith('.') || b.endsWith('.') || b.includes('..')) throw new Error('分支名不能以 . 开头/结尾，也不能有 ..');
  if (b.includes('@{')) throw new Error('分支名不能含 @{（git 保留）');
  if (b.endsWith('.lock')) throw new Error('分支名不能以 .lock 结尾（git 保留）');
  if (/^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|refs)$/i.test(b)) throw new Error(`分支名不能叫 ${b}（git 保留）`);
  return b;
}

/**
 * 建议分支名：`bandi/<标题的 ASCII 短串>-<时间戳>`。
 * 中文标题进不了分支名（会被折空），那就只剩时间戳 —— 时间戳保证两次建 PR 不撞名。
 */
export function suggestBranchName(title, at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `bandi/${slug ? slug + '-' : ''}${stamp}`;
}

/**
 * **凭据闸**（推上去就收不回来：git 历史里的 secret 只能靠强推抹，公开仓库抹不掉）。
 *
 * 与 `pr-review.mjs` 的 `SENSITIVE_RE` 不是一回事：那条管"自动合并要严"（CI 配置也算敏感），
 * 这条管"别把私钥推到公开仓库"。`.github/workflows/` 在这条里**不算**凭据 —— 那是正常改动。
 */
const SECRET_PATH_RE =
  /(^|\/)\.env(\.|$)|\.(pem|p12|pfx|key|kdbx|keystore)$|(^|\/)(id_rsa|id_ecdsa|id_ed25519|\.npmrc|\.netrc)(\.|$)|[\w.-]*(token|secret|credential|passwd|password)[\w.-]*$/i;
/** 模板类放过：`.env.example` 是要提交的东西，拦它等于逼人绕开平台 */
const SECRET_EXEMPT_RE = /\.(example|sample|template|dist|txt|md)$/i;

/** 这批路径里哪些像凭据（返回路径清单；空数组 = 干净） */
export function findSecretPaths(paths) {
  return (paths ?? []).map((p) => String(p ?? '')).filter((p) => p && SECRET_PATH_RE.test(p) && !SECRET_EXEMPT_RE.test(p));
}

/**
 * 解析 `git status --porcelain -z`。
 *
 * 为什么用 `-z`：文件名里可以有空格、中文、引号，按行切会把一个路径切成两半；
 * 重命名/复制的记录在 `-z` 下是**两条** NUL 结尾的字段（新路径在前、原路径在后），必须连着读，
 * 否则下一行会被当成一条独立记录、路径错位。
 */
export function parseStatusZ(raw) {
  const parts = String(raw ?? '').split('\0').filter((s) => s !== '');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    let rec = parts[i];
    /*
     * 防御（2026-10-25 实报）：调用方如果对 -z 输出做了 trim，第一条记录会从 `" M apps/…"`
     * 变成 `"M apps/…"` —— 第三位不再是分隔空格，slice(3) 会吃掉路径首字母
     * （弹窗把 apps/… 显示成 pps/…，提交时 git add 报 pathspec 不存在）。
     * 正常记录的第 3 位**一定**是空格；不是就补回来（第 2 位是空格的才可能是被 trim 的）。
     */
    if (i === 0 && rec.length > 2 && rec[1] === ' ' && rec[2] !== ' ') rec = ` ${rec}`;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    const entry = { status: xy, path };
    // 重命名/复制：X（index）或 Y（worktree）任一列是 R/C 都要把下一条源路径读掉
    // （`R ` 已暂存重命名、` R` 未暂存重命名都是这个形状；只认 X 列会把源路径错当成一条独立记录）
    if (/[RC]/.test(xy)) entry.from = parts[++i];
    out.push(entry);
  }
  return out;
}

/** 跑一次 git（合并 stdout/stderr；超时后由 run() 掐掉）。`trim` 只有机器格式（-z）才关 */
const gitIn = async (cwd, args, { timeoutMs = GIT_FAST_MS, env = GIT_ENV, trim = true } = {}) => run('git', args, { cwd, env, timeoutMs, trim });

/**
 * 提交身份：仓库（含全局）配了就用配好的，**没配才兜底**。
 * 兜底用 GitHub 的 noreply 邮箱，这样提交能归到账号上、又不用把真实邮箱写进代码里。
 */
async function commitIdentityArgs(cwd) {
  const args = [];
  const name = await gitIn(cwd, ['config', 'user.name']);
  if (name.code !== 0 || !name.out) args.push('-c', `user.name=${cachedLogin() || 'bandi'}`);
  const email = await gitIn(cwd, ['config', 'user.email']);
  if (email.code !== 0 || !email.out) {
    const login = cachedLogin();
    args.push('-c', `user.email=${login ? `${login}@users.noreply.github.com` : 'bandi@localhost'}`);
  }
  return args;
}

/** base 分支：库里的 defaultBranch → origin/HEAD → main（都拿不到就说清楚，不猜） */
async function resolveBase(row, askedBase) {
  if (askedBase) return assertBranchName(askedBase);
  if (row.defaultBranch) return row.defaultBranch;
  const head = await gitIn(row.localPath, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.out) return head.out.replace(/^origin\//, '');
  throw new Error('不知道要合进哪个分支（仓库没记默认分支、本地也没有 origin/HEAD）——在弹窗里填一个 base');
}

/**
 * 本地工作区状态（**不联网**：全读本地 git，界面上那颗按钮点下去要立刻有反应）。
 *
 * `ahead` 可能为 null —— 本地还没有 `origin/<base>` 这个引用（刚接入没同步过），
 * 这时候不能报"0 个提交领先"（那是假话），要报"不知道"并让人先点同步。
 */
export async function workState(row) {
  const cwd = row.localPath;
  if (!isGitRepo(cwd)) throw new Error(`本地目录不是 git 仓库（没有 .git）：${cwd}`);
  const origin = await gitIn(cwd, ['remote', 'get-url', 'origin']);
  const hasRemote = origin.code === 0 && !!origin.out;
  const headRef = await gitIn(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = headRef.code === 0 ? headRef.out : null;
  const base = row.defaultBranch || null;

  /*
   * ⚠️ **trim:false**：`-z` 的第一条记录可以以空格开头（" M path"）。run() 默认 trim 会
   * 吃掉那个空格，记录整体错位、路径首字母被 slice(3) 切掉 —— 2026-10-25 实报：
   * 弹窗把 `apps/...` 显示成 `pps/...`，提交时 `git add` 报 pathspec 不存在。
   */
  const st = await gitIn(cwd, ['status', '--porcelain', '--untracked-files=all', '-z'], { trim: false });
  if (st.code !== 0) throw new Error(`读工作区状态失败：${st.out.split('\n').slice(-3).join(' ')}`);
  const dirty = parseStatusZ(st.out);

  let ahead = null;
  let aheadCommits = [];
  let behind = null;
  let baseKnown = false;
  if (base && branch) {
    const verify = await gitIn(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]);
    baseKnown = verify.code === 0 && verify.out !== '';
    if (baseKnown) {
      const count = await gitIn(cwd, ['rev-list', '--count', `origin/${base}..HEAD`]);
      if (count.code === 0) ahead = Number(count.out) || 0;
      const log = await gitIn(cwd, ['log', '--format=%h %s', `origin/${base}..HEAD`, '-n', '20']);
      if (log.code === 0) aheadCommits = log.out.split('\n').filter(Boolean).map((l) => ({ sha: l.slice(0, 7), subject: l.slice(8) }));
      const back = await gitIn(cwd, ['rev-list', '--count', `HEAD..origin/${base}`]);
      if (back.code === 0) behind = Number(back.out) || 0;
    }
  }

  /*
   * 上游（`@{u}`）与"已提交、还没推送"的计数（2026-10-27 用户实报：提交完没推，界面看不出来）。
   *
   * 和上面的 `ahead` **不是一回事**：ahead 是"领先 base 几条"，已经推过的分支照样算领先；
   * 这里要的是"本地有多少提交到不了上游" —— 只有 `@{u}..HEAD` 才是真没推的。
   * `upstream` 为 null = 没设上游（新分支还没推过，或远端分支被删了）；界面据此说"还没推到远端"。
   */
  let upstream = null;
  let unpushed = null;
  let unpulled = null;
  if (branch) {
    const up = await gitIn(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (up.code === 0 && up.out) {
      upstream = up.out;
      const a = await gitIn(cwd, ['rev-list', '--count', '@{u}..HEAD']);
      if (a.code === 0) unpushed = Number(a.out) || 0;
      const b = await gitIn(cwd, ['rev-list', '--count', 'HEAD..@{u}']);
      if (b.code === 0) unpulled = Number(b.out) || 0;
    }
  }

  return {
    fullName: row.fullName,
    localPath: cwd,
    branch,
    detached: !branch,
    hasRemote,
    originUrl: hasRemote ? origin.out : null,
    base,
    baseKnown,
    ahead,
    aheadCommits,
    behind,
    upstream,
    unpushed,
    unpulled,
    dirty,
    dirtyCount: dirty.length,
    secrets: findSecretPaths(dirty.map((f) => f.path)),
    // 默认分支名由服务端给（`bandi/<名>-<时间戳>`）：规则只留一处，界面和人敲的是同一套
    suggest: suggestBranchName(row.name),
    canShip: dirty.length > 0 || (ahead ?? 0) > 0,
  };
}

/**
 * 把工作区条目变成 `git add -A --` 的 pathspec（2026-10-25）。
 *
 * 不能无脑把 `path` 和 `from` 都塞进去 —— 用户实报过一次：
 *   · `R `（**已暂存**的重命名）：旧路径已经不在工作区，index 里已经是删除，
 *     传它会 fatal `pathspec ... did not match any files`；只加新路径即可（index 仍会认成 rename）。
 *   · `D `（已暂存的删除）：同理，index 已经是删除，传它也会 fatal；跳过。
 *   · ` R`（工作区侧重命名、还没暂存，如 `git add -N` 之后）：旧路径**必须**一起带上，
 *     否则提交出来是"新增一份 + 旧文件还在"。
 *   · ` D`（未暂存删除）：传路径是对的（`git add -A` 认 index 里的旧记录，把删除记下）。
 */
function addTargetsOf(entries) {
  const targets = [];
  for (const f of entries) {
    const xy = String(f.status ?? '');
    if (xy === 'D ') continue; // 已暂存的删除：index 已经记着，不需要再 add
    if (xy[0] === 'R' || xy[0] === 'C') {
      targets.push(f.path); // 已暂存的重命名/复制：只加新路径，旧路径的删除已在 index
      continue;
    }
    if (f.from) targets.push(f.path, f.from);
    else targets.push(f.path);
  }
  return targets;
}

/**
 * 把工作区改动收成一个提交并推上去（**建 PR 的前半截**，不碰 GitHub API）。
 *
 * 三条硬规矩（都是"推上去收不回来"那一类）：
 *   · 只在新分支上提交，绝不往 base 上提交（`assertBranchName` + base 同名直接拒）；
 *   · 推不上去就**说清楚**，绝不 `--force`（远端同名分支不是你的，多半是别人的活）；
 *   · 看着像凭据的文件先挡住，除非调用方明说 `allowSecrets`（界面上那颗"就是要提交"）。
 */
export async function commitAndPush(row, { branch = null, message = null, paths = null, allowSecrets = false, base = null } = {}) {
  const st = await workState(row);
  if (!st.hasRemote) throw new Error('这个目录没有 origin（手动接入的本地克隆要先把 origin 指回 GitHub）—— 没有 origin 就推不上去');
  if (st.detached) throw new Error('当前不在任何分支上（detached HEAD）—— 先在那个目录 checkout 回一个分支');

  const picked = Array.isArray(paths) && paths.length ? st.dirty.filter((f) => paths.includes(f.path)) : st.dirty;
  if (Array.isArray(paths) && paths.length && picked.length !== paths.length) {
    throw new Error('选中的文件和工作区对不上了（期间有人动过）—— 重新看一次改动再提交');
  }
  const secrets = findSecretPaths(picked.map((f) => f.path));
  if (secrets.length && !allowSecrets) {
    throw new Error(`改动里有看着像凭据的文件：${secrets.slice(0, 4).join('、')}${secrets.length > 4 ? ` 等 ${secrets.length} 个` : ''} —— 推上去就收不回来。确认那是可以公开的（例如 .env.example），再带上"就是要提交"`);
  }

  const targetBase = await resolveBase(row, base);
  let branchName = branch ? assertBranchName(branch) : null;
  let committed = null;

  if (picked.length) {
    if (!branchName) branchName = suggestBranchName(message || row.name);
    if (branchName === targetBase) throw new Error(`新分支不能和 base 同名（${branchName}）—— 换个名字，不然没有可比的东西`);
    if (branchName !== st.branch) {
      const create = await gitIn(row.localPath, ['checkout', '-b', branchName]);
      if (create.code !== 0) {
        // 分支已经存在就切过去继续用（同一个分支上补一次提交是常态），但**不动它的历史**
        const reuse = await gitIn(row.localPath, ['checkout', branchName]);
        if (reuse.code !== 0) throw new Error(`切到分支 ${branchName} 没成：${(create.out || reuse.out).split('\n').slice(-3).join(' ')}`);
      }
    }
    const idArgs = await commitIdentityArgs(row.localPath);
    const addTargets = addTargetsOf(picked);
    const add = await gitIn(row.localPath, ['add', '-A', '--', ...addTargets], { timeoutMs: GIT_PUSH_MS });
    if (add.code !== 0) throw new Error(`git add 没成：${add.out.split('\n').slice(-3).join(' ')}`);
    const msg = String(message ?? branchName).trim() || branchName;
    const commit = await gitIn(row.localPath, [...idArgs, 'commit', '-m', msg]);
    if (commit.code !== 0) throw new Error(`提交没成：${commit.out.split('\n').slice(-4).join(' ')}`);
    const sha = await gitIn(row.localPath, ['rev-parse', 'HEAD']);
    committed = { sha: sha.code === 0 ? sha.out : null, subject: msg };
  } else {
    // 工作区是干净的：那就用当前分支上**已经提交但没推**的东西
    if (!branchName) branchName = st.branch;
    if (branchName === targetBase) throw new Error(`你现在就在 base（${targetBase}）上，工作区又是干净的 —— 没东西可提，先切个分支或改点东西`);
    if (!st.ahead) throw new Error(st.baseKnown ? '工作区是干净的，当前分支也没有领先 base 的提交 —— 没东西可推' : `工作区是干净的，而且本地还没有 origin/${targetBase} 这个引用 —— 先点「同步」拉一次再说`);
    if (branchName !== st.branch) {
      // 换了个名字：从当前 HEAD 拉出来（不动原来的分支指针），否则 push 会报"src refspec 不存在"
      const create = await gitIn(row.localPath, ['branch', branchName, st.branch || 'HEAD']);
      if (create.code !== 0) throw new Error(`建分支 ${branchName} 没成：${create.out.split('\n').slice(-3).join(' ')}`);
    }
  }

  const push = await gitIn(row.localPath, [...gitAuthArgs(), 'push', '--set-upstream', 'origin', `refs/heads/${branchName}:refs/heads/${branchName}`], { timeoutMs: GIT_PUSH_MS });
  if (push.code !== 0) {
    throw new Error(
      translatePushFailure(String(push.out ?? ''), {
        branch: branchName,
        base: targetBase,
        rejectedHint: 'rename',
      }),
    );
  }

  return { branch: branchName, base: targetBase, committed, files: picked };
}

/**
 * 建 PR 前**先查重**（同一个 head 分支再点一次不该撞 422，也不该建出两个 PR）。
 * `head` 过滤的格式是 `owner:branch`（GitHub 文档口径）。
 */
export async function findOpenPullForHead(repo, branch, owner = null) {
  const who = owner || String(repo).split('/')[0];
  const list = await ghFetch(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${who}:${branch}`)}`);
  const hit = (Array.isArray(list) ? list : [])[0];
  if (!hit) return null;
  return normalizePull(repo, hit);
}

/** 把 GitHub 的 PR 形状归成平台内部那一份（`fetchPull` 同族，字段少几个不影响显示） */
function normalizePull(repo, pr) {
  return {
    repo,
    number: Number(pr.number),
    title: pr.title ?? '',
    state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
    url: pr.html_url ?? `https://github.com/${repo}/pull/${pr.number}`,
    headRef: pr.head?.ref ?? null,
    headSha: pr.head?.sha ?? null,
    baseRef: pr.base?.ref ?? null,
    author: pr.user?.login ?? '',
    draft: !!pr.draft,
  };
}

/**
 * 建 PR（`POST /repos/{owner}/{repo}/pulls`）。
 *
 * 422 是这个接口最常撞的，分三档翻译成人话（逐字文案社区常见、官方文档未列，按语义判）：
 *   · head 与 base 之间没有提交 —— 多半是选错 base；
 *   · 同 head 已有 open PR —— 那就该走「查重」那条路，撞上了说明是并发；
 *   · 别的 422（base 不存在等）原样带回。
 * 403 是**权限没勾**，与合并的 403 不是同一个：这里要说 `Pull requests: Read and write`。
 */
export async function createPull(repo, { head, base, title, body = '', draft = false }) {
  const t = String(title ?? '').trim();
  if (!t) throw new Error('PR 标题不能是空的');
  if (!head || !base) throw new Error('要说清源分支和 base');
  if (head === base) throw new Error(`源分支和 base 是同一个（${base}）—— GitHub 没有可比的东西`);
  try {
    const pr = await ghFetch(`/repos/${repo}/pulls`, { method: 'POST', body: { title: t, head, base, body: String(body ?? ''), draft: !!draft } });
    return { pr: normalizePull(repo, pr), created: true };
  } catch (e) {
    const m = String(e?.githubMessage ?? e?.message ?? e);
    // 422 在这个接口最常撞，分三档翻译成人话（逐字文案是社区常见、官方文档只列 422，
    // 所以按**语义**判、并且把原话带回 —— 认不出来时人说得出到底撞了哪个）
    if (e?.status === 422 && /No commits between/i.test(m)) {
      throw new Error(`这两个分支之间没有提交（${base} … ${head}）—— 要么改动没提交，要么 base 选错了：${m}`);
    }
    if (e?.status === 422 && /already exists/i.test(m)) {
      const existing = await findOpenPullForHead(repo, head).catch(() => null);
      if (existing) return { pr: existing, created: false };
      throw new Error(`这个分支已经有一个 open PR 了：${m}`);
    }
    if (e?.status === 403) throw new Error(`令牌没有建 PR 的权限（403）：${m} —— 这个 PAT 要勾上 Pull requests: Read and write（现在挂的是 ${tokenHint() ?? '没令牌'}）`);
    throw e;
  }
}

/** 列一个仓库开着的 PR（建 PR 弹窗与合并入口共用；上限 30 条，走的是 `listOpenPulls`） */
export async function listPullsForRepo(repo) {
  return listOpenPulls(repo);
}

/** 合完删源分支（可选，对应 `gh pr merge --delete-branch`）；失败不谎报成功 */
export async function deleteRemoteBranch(repo, branch) {
  const b = assertBranchName(branch);
  await ghFetch(`/repos/${repo}/git/refs/heads/${b}`, { method: 'DELETE' });
  return { deleted: b };
}

/**
 * 一句话跑完整条「本地改动 → 分支 → 推送 → PR」，建出来的 PR 立刻写进任务卡。
 *
 * 编排放在这里（不是放在 routes 里）有两个理由：
 *   · 以后流程引擎的动作节点（`pr-create`）要复用同一条路，不能出现第二份"怎么建 PR"；
 *   · 顺序是有讲究的：推送成功才建 PR、建之前必查重、建完第一件事是把 URL 落到卡上
 *     （网络在中间断了，人至少知道这个 PR 可能已经存在）。
 */
export async function openPr(row, { title, body, base, branch, message, draft, paths, allowSecrets } = {}) {
  const pushed = await commitAndPush(row, { branch, message: message ?? title, paths, allowSecrets, base });
  const existing = await findOpenPullForHead(row.fullName, pushed.branch, row.owner);
  if (existing) return { pr: existing, created: false, ...pushed };
  const out = await createPull(row.fullName, {
    head: pushed.branch,
    base: pushed.base,
    title: title || pushed.branch,
    body: body ?? '',
    draft: !!draft,
  });
  return { ...out, ...pushed };
}
