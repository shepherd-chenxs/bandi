/* store/gitRepos.mjs —— 2026-10-22 由 store.mjs 按域拆出。SQL 只在 store/ 目录内。 */

import { db, newId, nowIso } from './db.mjs';

export function listGitRepos() {
  return db.prepare('SELECT * FROM git_repos ORDER BY addedAt DESC').all();
}


export function getGitRepo(id) {
  return db.prepare('SELECT * FROM git_repos WHERE id = ?').get(id) ?? null;
}


export function getGitRepoByPath(localPath) {
  return db.prepare('SELECT * FROM git_repos WHERE localPath = ?').get(localPath) ?? null;
}


export function getGitRepoByFullName(fullName) {
  return db.prepare('SELECT * FROM git_repos WHERE fullName = ?').get(fullName) ?? null;
}


/*
 * 从 **GitHub 认的 owner/name** 反查这一行（2026-11-20）。
 *
 * 为什么不能只查 fullName：fullName 是显示名（「本地代码托管」接进来时可能就是一个目录名
 * `bandi`），而 PR 巡检 / 流程里传来的是 owner/name。身份落库之后 ghRef 才是那张对得上的脸；
 * fullName 也一起查，是给回填之前的老行留的退路。
 */
export function getGitRepoByRef(ref) {
  const s = String(ref ?? '').trim();
  return db.prepare('SELECT * FROM git_repos WHERE ghRef = ? OR fullName = ?').get(s, s) ?? null;
}


/* 仓库管理员固定张坤（2026-11-20 用户："仓库管理员默认张坤、不允许改"）。
   新增仓库直接写上，界面不再给修改入口；历史空值由 db.mjs 那次回填补齐。 */
export const DEFAULT_KEEPER_ID = 'p-expert-zhangkun';

export function addGitRepo({
  fullName,
  owner,
  name,
  isPrivate = 0,
  defaultBranch = null,
  localPath,
  language = null,
  ghRef = null,
  remoteUrl = null,
}) {
  const row = {
    id: newId('gr'),
    fullName,
    owner,
    name,
    isPrivate: isPrivate ? 1 : 0,
    defaultBranch,
    localPath,
    language,
    ghRef,
    remoteUrl,
    addedAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO git_repos (id, fullName, owner, name, isPrivate, defaultBranch, localPath, language, ghRef, remoteUrl, addedAt, lastSyncAt, keeperPersonaId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    row.id,
    row.fullName,
    row.owner,
    row.name,
    row.isPrivate,
    row.defaultBranch,
    row.localPath,
    row.language,
    row.ghRef,
    row.remoteUrl,
    row.addedAt,
    DEFAULT_KEEPER_ID,
  );
  return getGitRepo(row.id);
}


/*
 * 仓库身份（2026-11-20 用户："如果我本地仓库改个名字是不是就找不到了？这显然不合理的吧"）。
 *
 * ghRef / remoteUrl 是**接入时**从远端解析出来的一次性事实，之后跟着仓库行走，
 * 不再随 localPath 的目录名现推。PATCH 语义：不传的字段不动。
 */
export function setGitRepoIdentity(id, { ghRef, remoteUrl } = {}) {
  if (ghRef !== undefined) db.prepare('UPDATE git_repos SET ghRef = ? WHERE id = ?').run(ghRef || null, id);
  if (remoteUrl !== undefined) db.prepare('UPDATE git_repos SET remoteUrl = ? WHERE id = ?').run(remoteUrl || null, id);
  return getGitRepo(id);
}


/* 目录重定位：只改指针，身份（ghRef/remoteUrl）不跟着路径走 */
export function setGitRepoPath(id, localPath) {
  db.prepare('UPDATE git_repos SET localPath = ? WHERE id = ?').run(localPath, id);
  return getGitRepo(id);
}


export function touchGitRepoSync(id) {
  db.prepare('UPDATE git_repos SET lastSyncAt = ? WHERE id = ?').run(nowIso(), id);
  return getGitRepo(id);
}


export function deleteGitRepo(id) {
  return db.prepare('DELETE FROM git_repos WHERE id = ?').run(id).changes > 0;
}

/*
 * 仓库的**值班设置**（2026-10-23，PR 审阅与授权合并）。
 *
 * 两个字段一起收：绑定管理员（keeperPersonaId）和授权合并（autoMerge）是一张
 * 设置单上的两行，界面上也是一起存的 —— 分两个接口只会让人问"为什么改一个要发两次"。
 * 传 null / 不传 = 不动那一个字段（PATCH 语义）；传空字符串 = 明确解绑管理员。
 */
export function updateGitRepoSettings(id, { keeperPersonaId, autoMerge } = {}) {
  const cur = getGitRepo(id);
  if (!cur) throw new Error('仓库不在清单里');
  if (keeperPersonaId !== undefined) {
    db.prepare('UPDATE git_repos SET keeperPersonaId = ? WHERE id = ?').run(keeperPersonaId || null, id);
  }
  if (autoMerge !== undefined) {
    db.prepare('UPDATE git_repos SET autoMerge = ? WHERE id = ?').run(autoMerge ? 1 : 0, id);
  }
  return getGitRepo(id);
}

/*
 * 一小块"任意 key/value"（复用迁移标记位那张 `meta` 表）。
 *
 * 目前只放一件跟代码托管有关的东西：**上次验到的 GitHub 账号**。
 * 为什么值得落库：`api.github.com/user` 在国内常常几秒起步、偶尔干脆不回 ——
 * 打开「代码托管」页面不该等它。先显示本地记住的名字，再在后台验一次；
 * 程序重启之后这条也还在（不然每次启动第一次打开页面又是空白 + 等）。
 */
