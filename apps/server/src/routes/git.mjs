/* routes/git.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。
 * 2026-10-25 加了写侧出口（建 PR / 列 open PR / 手动合并）；编排本体在 ../git-repos.mjs，
 * 这里只做"取那一条记录 + 把错误说人话 + 回写卡片"。 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as status from '../status.mjs';
import { updateProjectTask, afterMerged } from '../project-tasks.mjs';
import * as git from '../git-repos.mjs';

/**
 * 请求体 → `git.openPr` 的参数（两个入口共用一份：仓库行上直接建、从任务卡上建）。
 *
 * 默认值写在这儿而不是 git-repos 里，因为"标题从哪来"是**入口**的事：
 * 仓库行上标题就是人敲的那句，卡上则卡标题就是最自然的默认标题。
 */
function prRequestOf(body = {}, task = null) {
  const title = String(body.title ?? task?.title ?? '').trim();
  return {
    title,
    body: String(body.body ?? ''),
    base: body.base ? String(body.base) : null,
    branch: body.branch ? String(body.branch) : null,
    message: body.message ? String(body.message) : title || null,
    draft: !!body.draft,
    paths: Array.isArray(body.paths) && body.paths.length ? body.paths.map(String) : null,
    allowSecrets: !!body.allowSecrets,
  };
}

/**
 * 合并一个 PR（两个入口共用：仓库弹窗里那颗按钮、卡上那颗按钮）。
 *
 * 为什么合并前要先查一次 PR：闸的判据（CI、可合并性、head SHA）都挂在**那一刻的 head** 上 ——
 * 拿着列表里那个 sha 去合，期间有人推了新提交就合掉一份没人看过的改动。
 * `fetchPull` 回来才能判断：已经合过 / 已关闭（不是错误，是"没得合"），草稿（该拦）。
 * 合完把挂在它上面的卡统一收一遍（`afterMerged`：只把「进行中」转「待验收」，别的列不碰）。
 */
async function mergeOne(repo, number, body = {}, taskId = null) {
  const method = ['merge', 'squash', 'rebase'].includes(body.method) ? body.method : 'merge';
  const pull = await git.fetchPull(repo, number);
  if (pull.state === 'merged') return { merged: false, already: true, pr: pull, note: `PR #${number} 已经在 GitHub 上合过了` };
  if (pull.state === 'closed') return { merged: false, already: true, pr: pull, note: `PR #${number} 已经关闭了，合不了` };
  if (pull.draft && !body.allowDraft) throw new Error(`PR #${number} 还是草稿 —— 草稿不该被合并，先去 GitHub 上标为可审阅（或者你确认要合，界面里带上理由）`);

  const out = await git.mergePull(repo, number, { mergeMethod: method, sha: pull.headSha });
  /*
   * 这里带 `sha` 与 `pr-review.mergeShaFor` 说"人点通过不带锁"**不矛盾**，差别在 sha 的新鲜度：
   *   · 这一发是**刚 fetch 回来的当前 head**（上面那行 `git.fetchPull`）—— 锁的是"从读到发"
   *     这几百毫秒里有人挤进来推提交（TOCTOU），人看到的还是他点的那一份；
   *   · 流程里那颗「通过」拿的是**几分钟/几小时前那次审阅**产出的 sha —— 那种锁会把人锁死
   *     （重试永远撞 409，而重跑审阅要烧额度）。
   * 一句话：**现查的就锁，隔夜的别锁。**
   */
  if (!out.merged) throw new Error(out.message || 'GitHub 没说合上了，也没报错 —— 当没合处理');

  let branchDeleted = null;
  let branchNote = null;
  if (body.deleteBranch && pull.headRef) {
    // 只删平台自己拉出来的分支：`feature/foo` 那种是人的分支，删了是砸人正在干的活
    if (!/^bandi\//.test(pull.headRef)) {
      branchNote = `没删源分支 ${pull.headRef}：那不是平台建的分支（只删 bandi/ 开头的）`;
    } else {
      try {
        await git.deleteRemoteBranch(repo, pull.headRef);
        branchDeleted = pull.headRef;
      } catch (e) {
        // 删失败不谎报 —— 但**合并本身已经成了**，不能因此把整单报成失败（那会让人以为没合）
        branchNote = `已合并，但源分支 ${pull.headRef} 没删掉：${String(e?.message ?? e).slice(0, 120)}`;
        console.warn(`[代码托管] 合并后删分支 ${pull.headRef} 没成：${e?.message ?? e}`);
      }
    }
  }

  /*
   * **本地收尾**（2026-10-25）：切回 base、拉最新、删本地源分支。
   * PR 是在 GitHub 上合的，本地克隆不会自己变 —— 不做的话人还停在已合并的旧分支上。
   * 收尾失败**不影响合并结论**（GitHub 上已经合了），只把原因带回界面。
   */
  let local = null;
  try {
    local = await git.settleAfterMerge(repo, { base: pull.baseRef, head: pull.headRef, headSha: pull.headSha });
  } catch (e) {
    local = { settled: false, skipped: 'error', note: `合并成功，但本地收尾没成：${String(e?.message ?? e).slice(0, 160)}` };
    console.warn(`[代码托管] 合并后本地收尾没成：${e?.message ?? e}`);
  }

  const touched = [];
  for (const t of store.listProjectTasksWithPr()) {
    if (t.prRepo !== repo || Number(t.prNumber) !== number) continue;
    const next = store.updateProjectTask(t.id, { prState: 'merged', prTitle: pull.title, prCheckedAt: new Date().toISOString() });
    afterMerged(next);
    touched.push(t.id);
  }
  const task = taskId ? store.getProjectTask(taskId) : null;
  const notes = [branchNote, local?.note].filter(Boolean);
  return {
    merged: true,
    pr: { ...pull, state: 'merged' },
    method,
    branchDeleted,
    local,
    note: notes.length ? notes.join('；') : null,
    task,
    touchedTasks: touched,
  };
}

export async function handleGit(req, res, url) {
  // 这个 handler 管两类路径：/api/git/*（代码托管）与 /api/projects/tasks/:id/pr*（PR 联动）
  const isPrRoute = /^\/api\/projects\/tasks\/[^/]+\/pr(\/refresh|\/create|\/merge)?$/.test(url.pathname);
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

  /*
   * 仓库的值班设置（2026-10-23，PR 审阅与授权合并）：绑定管理员 + 授权自动合并。
   * 两件事是一张设置单（PATCH 语义：不传的字段不动）；管理员必须是真人（数字员工），
   * 别等巡检到点才发现绑的是个已经删掉的人。
   */
  const repoSettings = /^\/api\/git\/repos\/([^/]+)\/settings$/.exec(url.pathname);
  if (repoSettings && req.method === 'POST') {
    const body = await readBody(req);
    const id = decodeURIComponent(repoSettings[1]);
    if (!store.getGitRepo(id)) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    const keeper = body.keeperPersonaId;
    if (keeper !== undefined && keeper && !store.getPersona(keeper)) {
      return fail(res, 400, 'E1077', '选的那个管理员已经不在了，换一个'), true;
    }
    const row = store.updateGitRepoSettings(id, {
      keeperPersonaId: keeper,
      autoMerge: body.autoMerge === undefined ? undefined : !!body.autoMerge,
    });
    return sendJson(res, 200, { repo: row }), true;
  }

  /*
   * ---- 建 PR 的写侧出口（2026-10-25）----
   *
   * 三颗按钮对应三个接口：看改动（只读本地 git）、列开着的 PR（GitHub 读）、
   * 建 PR / 合并（GitHub 写）。为什么把「看改动」单开一个接口：点「建 PR」弹窗要**立刻**
   * 显示现在在哪个分支、有几个文件没提交、有没有看着像凭据的东西 —— 这些都是本地事实，
   * 不该等一次网络往返（跟 `/api/git/status` 先画本地、后台再验身份是同一个道理）。
   */
  const repoChanges = /^\/api\/git\/repos\/([^/]+)\/changes$/.exec(url.pathname);
  if (repoChanges && req.method === 'GET') {
    const row = store.getGitRepo(decodeURIComponent(repoChanges[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      return sendJson(res, 200, { state: await git.workState(row) }), true;
    } catch (e) {
      return fail(res, 400, 'E1079', String(e.message ?? e)), true;
    }
  }

  // 同一个路径两个方法：GET 列开着的 PR（读），POST 建 PR（写）—— 照 `prOf` 那样一条正则分方法
  const repoPrs = /^\/api\/git\/repos\/([^/]+)\/prs$/.exec(url.pathname);
  if (repoPrs) {
    const row = store.getGitRepo(decodeURIComponent(repoPrs[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    if (!git.readToken()) return fail(res, 400, 'E1070', '先连接 GitHub（工作台 → 研发 → 代码托管）'), true;
    if (req.method === 'GET') {
      try {
        const prs = await git.listPullsForRepo(row.fullName);
        // 已经挂在某张卡上的 PR 标出来：界面上"这张卡有 PR 了"和"这个 PR 没人管"是两件事
        const linked = new Map(store.listProjectTasksWithPr().filter((t) => t.prRepo === row.fullName).map((t) => [Number(t.prNumber), t.id]));
        return sendJson(res, 200, { prs: prs.map((p) => ({ ...p, taskId: linked.get(p.number) ?? null })) }), true;
      } catch (e) {
        return fail(res, 400, 'E1079', String(e.message ?? e)), true;
      }
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        return sendJson(res, 201, await git.openPr(row, prRequestOf(body))), true;
      } catch (e) {
        return fail(res, 400, 'E1078', String(e.message ?? e)), true;
      }
    }
    return fail(res, 405, 'E1089', '这个地址只认 GET（列开着的 PR）和 POST（建 PR）'), true;
  }

  const repoMergePr = /^\/api\/git\/repos\/([^/]+)\/prs\/(\d+)\/merge$/.exec(url.pathname);
  if (repoMergePr && req.method === 'POST') {
    const row = store.getGitRepo(decodeURIComponent(repoMergePr[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    if (!git.readToken()) return fail(res, 400, 'E1070', '先连接 GitHub（工作台 → 研发 → 代码托管）'), true;
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await mergeOne(row.fullName, Number(repoMergePr[2]), body)), true;
    } catch (e) {
      return fail(res, 400, 'E1088', String(e.message ?? e)), true;
    }
  }

  /* ---- PR 联动：卡片 ↔ GitHub PR ------------------------------------- */

  const prOf = /^\/api\/projects\/tasks\/([^/]+)\/pr(\/refresh|\/create|\/merge)?$/.exec(url.pathname);
  if (prOf) {
    const taskId = decodeURIComponent(prOf[1]);
    const task = store.getProjectTask(taskId);
    if (!task) return fail(res, 404, 'E1068', '任务不存在'), true;

    /*
     * **从这张卡建 PR**（2026-10-25）：项目目录就是那个仓库的克隆，所以不必先选仓库 ——
     * 卡 → 项目 → 目录 → 已接入仓库，一条链推得出唯一答案；推不出来就说清楚缺哪一环
     * （E1079 那三条原因分开写，因为"没接入仓库"和"没连 GitHub"要做的动作不一样）。
     */
    if (req.method === 'POST' && prOf[2] === '/create') {
      const body = await readBody(req);
      const project = task.projectId ? store.getProject(task.projectId) : null;
      if (!project) return fail(res, 400, 'E1079', '这张卡没挂项目 —— 不知道在哪个目录里提交。先在「工作台 → 研发 → 代码托管」上那个仓库行里点「建 PR」'), true;
      const row = git.repoForCwd(project.root);
      if (!row) return fail(res, 400, 'E1079', `项目目录不在任何已接入的仓库里：${project.root} —— 去「工作台 → 研发 → 代码托管」把它接进来`), true;
      if (!git.readToken()) return fail(res, 400, 'E1070', '先连接 GitHub（工作台 → 研发 → 代码托管）'), true;
      const repoRow = store.getGitRepoByFullName(row.fullName);
      try {
        const out = await git.openPr(repoRow, prRequestOf(body, task));
        const next = store.updateProjectTask(taskId, {
          prRepo: repoRow.fullName,
          prNumber: out.pr.number,
          prState: out.pr.state,
          prTitle: out.pr.title,
          prCheckedAt: new Date().toISOString(),
        });
        return sendJson(res, 201, { task: afterMerged(next), pr: out.pr, created: out.created, branch: out.branch, base: out.base, commit: out.committed }), true;
      } catch (e) {
        return fail(res, 400, 'E1078', String(e.message ?? e)), true;
      }
    }

    // 从这张卡合并它关联的 PR（人不走流程、直接在卡上点一下的那条路）
    if (req.method === 'POST' && prOf[2] === '/merge') {
      if (!task.prRepo || !task.prNumber) return fail(res, 400, 'E1072', '这张卡还没关联 PR'), true;
      if (!git.readToken()) return fail(res, 400, 'E1070', '先连接 GitHub（工作台 → 研发 → 代码托管）'), true;
      const body = await readBody(req);
      try {
        return sendJson(res, 200, await mergeOne(task.prRepo, task.prNumber, body, taskId)), true;
      } catch (e) {
        return fail(res, 400, 'E1088', String(e.message ?? e)), true;
      }
    }

    // 关联：body { url }（也接受 owner/name#123）
    if (req.method === 'POST' && !prOf[2]) {
      const body = await readBody(req);
      const ref = git.parsePrRef(body.url ?? body.pr ?? '');
      if (!ref) return fail(res, 400, 'E1069', '看不懂这个 PR：贴链接，或写成 owner/name#123'), true;
      if (!git.readToken()) return fail(res, 400, 'E1070', '先连接 GitHub（工作台 → 研发 → 代码托管）'), true;
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
    if (!git.readToken()) return fail(res, 400, 'E1074', '先连接 GitHub（工作台 → 研发 → 代码托管）'), true;
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

  /*
   * 「回 base / 回 main」那颗按钮（2026-10-25）：给"在 GitHub 网页上直接合了 PR"兜底。
   * 与合并后的自动收尾走同一个 `settleAfterMerge`：切回默认分支 → pull --ff-only → 删本地 bandi/ 分支。
   * 工作区不干净 / 当前在别的分支 → 400 原话带回，界面 toast 显示（不当成"成功"）。
   */
  const backOne = /^\/api\/git\/repos\/([^/]+)\/back$/.exec(url.pathname);
  if (req.method === 'POST' && backOne) {
    const row = store.getGitRepo(decodeURIComponent(backOne[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      const local = await git.settleAfterMerge(row.fullName, { base: row.defaultBranch });
      return sendJson(res, 200, { repo: row, local }), true;
    } catch (e) {
      return fail(res, 400, 'E1100', String(e.message ?? e)), true;
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

