/* routes/git.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as status from '../status.mjs';
import { updateProjectTask, afterMerged } from '../project-tasks.mjs';
import * as git from '../git-repos.mjs';

export async function handleGit(req, res, url) {
  // 这个 handler 管两类路径：/api/git/*（代码托管）与 /api/projects/tasks/:id/pr*（PR 联动）
  const isPrRoute = /^\/api\/projects\/tasks\/[^/]+\/pr(\/refresh)?$/.test(url.pathname);
  if (!url.pathname.startsWith('/api/git/') && !isPrRoute) return false;

  /*
   * 状态**只读本机**（2026-10-17 改）：connected / hint / 仓库清单全在本地文件和库里，
   * 登录名用上次验到的那一个（`meta.github_login`）。
   *
   * 原来这里每次都 `await git.verifyToken()` —— 页面每打开一次就往 api.github.com 打一次，
   * 国内网络下界面就悬在"取代码托管状态…"好几秒（用户实报："这个页面显示有延迟"）。
   * 现在身份校验挪到 `/api/git/whoami`，由界面**画完之后再在后台问**。
   */
  if (req.method === 'GET' && url.pathname === '/api/git/status') {
    const connected = !!git.readToken();
    return sendJson(res, 200, { connected, login: connected ? git.cachedLogin() : null, hint: git.tokenHint(), repos: git.listConnected() }), true;
  }

  /*
   * 后台验一次身份（界面首屏画完之后才调）。
   *
   * **失败也回 200**：这不是"操作失败"，只是"这次没问到"——页面已经用本地状态画完了，
   * 回 200 + `error` 让它安静地不改那行字，而不是弹一个错误块把整页弄成失败态。
   * 令牌明确失效（401）时顺手把记住的名字清掉，下次页面就不再显示一个已死的账号。
   */
  if (req.method === 'GET' && url.pathname === '/api/git/whoami') {
    if (!git.readToken()) return sendJson(res, 200, { connected: false, login: null }), true;
    try {
      const me = await git.whoami({ fresh: url.searchParams.get('fresh') === '1' });
      return sendJson(res, 200, { connected: true, login: me.login, name: me.name ?? null, cached: !!me.cached }), true;
    } catch (e) {
      const msg = String(e.message ?? e);
      if (msg.includes('401')) git.forgetLogin();
      return sendJson(res, 200, { connected: true, login: git.cachedLogin(), error: msg }), true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/git/token') {
    const body = await readBody(req);
    const token = String(body.token ?? '').trim();
    if (!token) return fail(res, 400, 'E1061', '令牌是空的');
    let me;
    try {
      me = await git.verifyToken(token);
    } catch (e) {
      return fail(res, 400, 'E1062', String(e.message ?? e)), true;
    }
    git.saveToken(token);
    git.rememberLogin(me.login); // 刚验过，页面下次打开就能立刻显示 @名字
    return sendJson(res, 200, { connected: true, login: me.login, hint: git.tokenHint() }), true;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/git/token') {
    git.clearToken();
    return sendJson(res, 200, { connected: false }), true;
  }

  if (req.method === 'GET' && url.pathname === '/api/git/available') {
    try {
      const list = await git.listAvailableRepos();
      const connected = new Set(git.listConnected().map((r) => r.fullName));
      return sendJson(res, 200, { repos: list.map((r) => ({ ...r, connected: connected.has(r.fullName) })) }), true;
    } catch (e) {
      return fail(res, 400, 'E1063', String(e.message ?? e)), true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/git/repos') {
    return sendJson(res, 200, { repos: git.listConnected() }), true;
  }

  if (req.method === 'POST' && url.pathname === '/api/git/repos') {
    const body = await readBody(req);
    try {
      const out = await git.connectRepo(String(body.fullName ?? ''), null, body.localPath ? String(body.localPath) : null);
      return sendJson(res, 201, out), true;
    } catch (e) {
      return fail(res, 400, 'E1064', String(e.message ?? e)), true;
    }
  }

  /* ---- PR 联动：卡片 ↔ GitHub PR ------------------------------------- */

  const prOf = /^\/api\/projects\/tasks\/([^/]+)\/pr(\/refresh)?$/.exec(url.pathname);
  if (prOf) {
    const taskId = decodeURIComponent(prOf[1]);
    const task = store.getProjectTask(taskId);
    if (!task) return fail(res, 404, 'E1068', '任务不存在'), true;

    // 关联：body { url }（也接受 owner/name#123）
    if (req.method === 'POST' && !prOf[2]) {
      const body = await readBody(req);
      const ref = git.parsePrRef(body.url ?? body.pr ?? '');
      if (!ref) return fail(res, 400, 'E1069', '看不懂这个 PR：贴链接，或写成 owner/name#123'), true;
      if (!git.readToken()) return fail(res, 400, 'E1070', '先连接 GitHub（设置 → 代码托管）'), true;
      let snap;
      try {
        snap = await git.fetchPull(ref.repo, ref.number);
      } catch (e) {
        return fail(res, 400, 'E1071', `查不到这个 PR：${e.message}`), true;
      }
      const next = store.updateProjectTask(taskId, {
        prRepo: ref.repo,
        prNumber: ref.number,
        prState: snap.state,
        prTitle: snap.title,
        prCheckedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { task: afterMerged(next), pr: snap }), true;
    }

    // 刷新：重新查一次
    if (req.method === 'POST' && prOf[2]) {
      if (!task.prRepo || !task.prNumber) return fail(res, 400, 'E1072', '这张卡还没关联 PR'), true;
      let snap;
      try {
        snap = await git.fetchPull(task.prRepo, task.prNumber);
      } catch (e) {
        return fail(res, 400, 'E1073', `查不到这个 PR：${e.message}`), true;
      }
      const next = store.updateProjectTask(taskId, {
        prState: snap.state,
        prTitle: snap.title,
        prCheckedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { task: afterMerged(next), pr: snap }), true;
    }

    // 取消关联
    if (req.method === 'DELETE') {
      const next = store.updateProjectTask(taskId, {
        prRepo: null,
        prNumber: null,
        prState: null,
        prTitle: null,
        prCheckedAt: null,
      });
      return sendJson(res, 200, { task: next }), true;
    }
  }

  /*
   * 批量刷新：所有关联了 PR 的卡（看板工具栏上的「刷新 PR（n）」）。
   *
   * `?projectId=` 只查某个项目 —— 项目看板上那颗按钮写的是"本板 n 张"，就该只动这几张
   * （不然数字对不上：按钮说 2 张，背后刷了 20 张别的项目的卡）。全局面板不带它，查全部。
   * 上限 50 张：一次点下去串行查 GitHub，几百张会卡到人以为点了没反应。
   */
  if (req.method === 'POST' && url.pathname === '/api/git/prs/refresh') {
    if (!git.readToken()) return fail(res, 400, 'E1074', '先连接 GitHub（设置 → 代码托管）'), true;
    const only = url.searchParams.get('projectId');
    let updated = 0;
    const failed = [];
    for (const t of store
      .listProjectTasksWithPr()
      .filter((x) => !only || x.projectId === only)
      .slice(0, 50)) {
      try {
        const snap = await git.fetchPull(t.prRepo, t.prNumber);
        const next = store.updateProjectTask(t.id, {
          prState: snap.state,
          prTitle: snap.title,
          prCheckedAt: new Date().toISOString(),
        });
        afterMerged(next);
        updated++;
      } catch (e) {
        failed.push({ id: t.id, error: String(e.message ?? e) });
      }
    }
    return sendJson(res, 200, { updated, failed }), true;
  }

  const syncOne = /^\/api\/git\/repos\/([^/]+)\/sync$/.exec(url.pathname);
  if (req.method === 'POST' && syncOne) {
    try {
      return sendJson(res, 200, { repo: await git.syncRepo(decodeURIComponent(syncOne[1])) }), true;
    } catch (e) {
      return fail(res, 400, 'E1065', String(e.message ?? e)), true;
    }
  }

  const one = /^\/api\/git\/repos\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && one) {
    try {
      return sendJson(res, 200, git.removeRepo(decodeURIComponent(one[1]))), true;
    } catch (e) {
      return fail(res, 404, 'E1066', String(e.message ?? e)), true;
    }
  }

  return fail(res, 404, 'E1067', '没有这个接口'), true;
}

