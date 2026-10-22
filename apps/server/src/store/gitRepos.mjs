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


export function addGitRepo({ fullName, owner, name, isPrivate = 0, defaultBranch = null, localPath, language = null }) {
  const row = {
    id: newId('gr'),
    fullName,
    owner,
    name,
    isPrivate: isPrivate ? 1 : 0,
    defaultBranch,
    localPath,
    language,
    addedAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO git_repos (id, fullName, owner, name, isPrivate, defaultBranch, localPath, language, addedAt, lastSyncAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(row.id, row.fullName, row.owner, row.name, row.isPrivate, row.defaultBranch, row.localPath, row.language, row.addedAt);
  return getGitRepo(row.id);
}


export function touchGitRepoSync(id) {
  db.prepare('UPDATE git_repos SET lastSyncAt = ? WHERE id = ?').run(nowIso(), id);
  return getGitRepo(id);
}


export function deleteGitRepo(id) {
  return db.prepare('DELETE FROM git_repos WHERE id = ?').run(id).changes > 0;
}

/*
 * 一小块"任意 key/value"（复用迁移标记位那张 `meta` 表）。
 *
 * 目前只放一件跟代码托管有关的东西：**上次验到的 GitHub 账号**。
 * 为什么值得落库：`api.github.com/user` 在国内常常几秒起步、偶尔干脆不回 ——
 * 打开「代码托管」页面不该等它。先显示本地记住的名字，再在后台验一次；
 * 程序重启之后这条也还在（不然每次启动第一次打开页面又是空白 + 等）。
 */
