/* routes/git.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。
 * 2026-10-25 加了写侧出口（建 PR / 列 open PR / 手动合并）；编排本体在 ../git-repos.mjs，
 * 这里只做"取那一条记录 + 把错误说人话 + 回写卡片"。 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as status from '../status.mjs';
import { updateProjectTask, afterMerged } from '../project-tasks.mjs';
import * as git from '../git-repos.mjs';
import * as commitMsg from '../commit-msg.mjs';
import * as patrol from '../repo-patrol.mjs';
import { dispatchToThread } from '../dispatch.mjs';

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
 * 谁来修 gate（2026-10-29 用户："我要的是一个按钮，点了 agent 帮我去修"）。
 *
 * 用户不管这事该谁干，平台自己挑最合适的人：**研发 > 仓库管家 > 测试 / 运维 > 内置助理**。
 * 最后垫底的助理也得有 —— "一个员工都没雇"这种新装机不该让按钮直接哑掉。
 * 返回 null 只发生在库里一个员工都没有（正常装机有内置助理，不会走到）。
 */
function pickGateFixer(row) {
  const people = store.listPersonas();
  if (!people.length) return null;
  const byRole = (kw) => people.find((p) => String(p.role ?? '').startsWith(kw));
  return (
    byRole('研发')
    ?? people.find((p) => p.id === row?.keeperPersonaId)
    ?? byRole('测试')
    ?? byRole('运维')
    ?? people.find((p) => p.builtin)
    ?? people[0]
  );
}

/**
 * 给修 gate 的人写的活（brief）。
 *
 * 写法上守两条：
 *   · **说清现场，别说结论** —— 仓库在哪、哪个分支、哪条检查红了、红在哪个 step，让他自己去看；
 *   · **把人话要求显式写出来** —— 不许改 workflow / 删测试骗绿，修完要自己跑到绿再推，
 *     回报只要"什么毛病、怎么改的、过没过"，不贴日志（用户不看代码）。
 * 最后一条"修不动就停下"是防它瞎试：反复乱改比修不好更糟。
 */
function gateFixBrief({ repo, row, pull, detail }) {
  const steps = (detail.jobs ?? []).map(
    (j) => `- ${j.name || '未命名 job'}：${(j.steps ?? []).map((s) => `${s.name}（${s.conclusion}）`).join('、') || '拿不到 step 明细'}`,
  );
  const branch = pull.headRef ?? '当前分支';
  return [
    `「${repo}」这个 PR 的自动检查没过，你帮我修到过为止 —— 我是用户，不看代码，也不用跟我解释报错。`,
    '',
    `仓库：${repo}（本机目录 ${row.localPath}）`,
    `PR：#${pull.number}《${pull.title ?? ''}》`,
    `分支：${branch}（推到这里，它就是这条 PR 的来源）→ ${pull.baseRef ?? '?'}`,
    `没过的检查：${(detail.failed ?? []).join('、') || '未知检查'}`,
    ...(steps.length ? ['红在哪：', ...steps] : []),
    '',
    '怎么做：',
    `1. 先看现场：git -C "${row.localPath}" status —— 有未提交改动就先跟我说一声再动；这里要是脏的，别硬切分支。`,
    `2. 切到 ${branch}、拉最新，在本机把没过的那条检查跑一遍（.github/workflows 里写着它跑什么），先复现同样的失败再动手。`,
    '3. 修根因。不许为了让检查变绿去删测试、跳过检查、改 workflow 绕过去 —— 那样绿了也是假的，我不收。',
    '4. 改完把这条检查在本机跑到绿，相关的检查也过一遍。',
    '5. 提交并推到上面那个分支，gate 会自动重跑。',
    '6. 回我一句人话：是什么毛病、你怎么改的、现在过没过。别贴日志原文。',
    '7. 修不动就停下来说清卡在哪、要我做什么决定 —— 不要反复乱试，也别顺手改无关的东西。',
  ].join('\n');
}

/** 路径比较：Windows 上大小写与反斜杠都不该让"同一个目录"认不出来（同 pr-watch） */
const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * 合并一个 PR（两个入口共用：仓库弹窗里那颗按钮、卡上那颗按钮）。
 *
 * 为什么合并前要先查一次 PR：闸的判据（CI、可合并性、head SHA）都挂在**那一刻的 head** 上 ——
 * 拿着列表里那个 sha 去合，期间有人推了新提交就合掉一份没人看过的改动。
 * `fetchPull` 回来才能判断：已经合过 / 已关闭（不是错误，是"没得合"）、草稿（该拦）。
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
    return (
      sendJson(res, 200, {
        connected,
        login: connected ? git.cachedLogin() : null,
        hint: git.tokenHint(),
        // 仓库行上那「巡检」一行要的东西（节拍 / 上次结果）一次带齐，弹窗不再单独请求
        repos: git.listConnected().map((r) => ({ ...r, patrol: patrol.viewOf(r) })),
        patrolPresets: patrol.PRESETS,
      }),
      true
    );
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
    return sendJson(res, 200, { repos: git.listConnected().map((r) => ({ ...r, patrol: patrol.viewOf(r) })) }), true;
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
   * ---- 仓库级巡检（2026-10-29）----
   *
   * 巡检的配置从「定时任务」页搬回仓库行上（用户："这个功能放到代码托管是不是更好"）：
   * 谁审 / 自动合并 / 巡检节拍本来都长在同一个仓库上，分两个页面配就是让人对着两个对象各改一半。
   * **底层仍是 schedule_jobs 里一条 pr-scan 任务**（见 ../repo-patrol.mjs），不另起一套定时。
   * 节拍只收预设 id，校验在 `setPreset` 一处；不认识的直接 400，别存进去了到点却不跑。
   */
  const repoPatrol = /^\/api\/git\/repos\/([^/]+)\/patrol$/.exec(url.pathname);
  if (repoPatrol && req.method === 'POST') {
    const row = store.getGitRepo(decodeURIComponent(repoPatrol[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    const body = await readBody(req);
    try {
      const view = patrol.setPreset(row, String(body.preset ?? ''));
      return sendJson(res, 200, { repo: row, patrol: view }), true;
    } catch (e) {
      return fail(res, 400, 'E1119', String(e?.message ?? e)), true;
    }
  }

  /*
   * 立即巡检一次：与定时任务页那颗「立即执行」同一条路（有任务时）；
   * 还没配过节拍就直接扫一次，**不为了跑一次就建一条任务**。请求成功 ≠ 这次跑成功：
   * 跑挂了是 200 + ok:false（跟 /api/schedules/:id/run 同一口径），"正在跑"才是 400。
   */
  const repoPatrolRun = /^\/api\/git\/repos\/([^/]+)\/patrol\/run$/.exec(url.pathname);
  if (repoPatrolRun && req.method === 'POST') {
    const row = store.getGitRepo(decodeURIComponent(repoPatrolRun[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    let out;
    try {
      out = await patrol.runNow(row);
    } catch (e) {
      return fail(res, 400, 'E1120', String(e?.message ?? e)), true;
    }
    return sendJson(res, 200, out), true;
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
        /*
         * 2026-10-27「PR 区域」：每个 PR 再附一个 checks 汇总，界面才说得清"这条能不能合"
         * （我们的 main 有分支保护，`gate` 不绿合不了）。
         * 逐条查 check-runs 是 N 次请求 —— 开着的 PR 通常 0~2 条，可以接受；
         * 万一某一条查失败，只把那一条降级成 unknown，不让整个列表挂掉。
         */
        const enriched = await Promise.all(
          prs.map(async (p) => {
            let checks = { state: 'unknown', total: 0, failed: [], pending: [] };
            try {
              checks = await git.pullChecks(row.fullName, p.headSha);
            } catch {
              /* 查不到就 unknown（界面显示"检查未知"），不挡合并按钮之外的别的事 */
            }
            return { ...p, taskId: linked.get(p.number) ?? null, checks };
          }),
        );
        return sendJson(res, 200, { prs: enriched, base: row.defaultBranch ?? null }), true;
      } catch (e) {
        return fail(res, 400, 'E1079', String(e.message ?? e)), true;
      }
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        /* 代码托管页的建 PR：**只推已提交的**（includeDirty:false）—— 提交是「提交」按钮的事。
           任务卡那条路（下面 /pr/create）保持默认 true，agent 干完活手上是脏文件。
           两条都要 push:true：`openPr` 的 push 默认 false（只建 PR、不碰推送，留给流程外的人自己推），
           而这两颗按钮的契约是"点一下就该有 PR"，推的是刚提交/已提交的东西，不能让人自己去推送区补一刀。 */
        return sendJson(res, 201, await git.openPr(row, { ...prRequestOf(body), includeDirty: false, push: true })), true;
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

  /* ---- gate 明细 + 重跑（2026-10-29 用户："界面如果不通过就卡住了，得有个修复功能"）----
     红了不再只有一颗干瞪眼的 ✗：GET 看哪条红了、红在哪个 step；POST /rerun 重跑失败的。
     两个动作都先取 PR 拿 headSha —— 行上只传编号，服务端自己对 GitHub，不信任前端传 sha。 */
  const repoPrChecks = /^\/api\/git\/repos\/([^/]+)\/prs\/(\d+)\/checks(\/rerun)?$/.exec(url.pathname);
  if (repoPrChecks) {
    const row = store.getGitRepo(decodeURIComponent(repoPrChecks[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    if (!git.readToken()) return fail(res, 400, 'E1070', '先连接 GitHub（工作台 → 研发 → 代码托管）'), true;
    try {
      const pull = await git.fetchPull(row.fullName, Number(repoPrChecks[2]));
      if (req.method === 'GET') {
        return sendJson(res, 200, await git.gateDetail(row.fullName, pull.headSha)), true;
      }
      if (req.method === 'POST' && repoPrChecks[3]) {
        return sendJson(res, 200, await git.rerunGate(row.fullName, pull.headSha)), true;
      }
    } catch (e) {
      return fail(res, 400, 'E1079', String(e.message ?? e)), true;
    }
    return fail(res, 405, 'E1089', '这个地址只认 GET（gate 明细）和 POST /rerun（重跑失败的检查）'), true;
  }

  /* ---- 「让 AI 帮我修」（2026-10-29 用户："我要的是一个按钮，点了 agent 帮我去修"）----
     用户不看代码、也不关心报错：这里不返回"哪红了"给人读，而是**直接派活** ——
     挑一个研发（pickGateFixer），在他的 1:1 会话里发一段带现场的 brief（gateFixBrief），
     让他自己复现、改、跑到绿、推上去。界面只负责回"已经交给他了"和一句人去哪看进展。
     检查已经绿 / 还在跑时不派活（白烧一次 run），明说没什么可修。 */
  const repoPrFix = /^\/api\/git\/repos\/([^/]+)\/prs\/(\d+)\/fix$/.exec(url.pathname);
  if (repoPrFix && req.method === 'POST') {
    const row = store.getGitRepo(decodeURIComponent(repoPrFix[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    if (!git.readToken()) return fail(res, 400, 'E1070', '先连接 GitHub（工作台 → 研发 → 代码托管）'), true;
    const number = Number(repoPrFix[2]);
    try {
      const pull = await git.fetchPull(row.fullName, number);
      const detail = await git.gateDetail(row.fullName, pull.headSha);
      if (detail.state === 'success') return fail(res, 400, 'E1121', '这条 PR 的检查已经全绿了，不用修'), true;
      if (detail.state === 'pending') return fail(res, 409, 'E1122', '检查还在跑 —— 等它出结果，真红了再让它修'), true;
      if (detail.state !== 'failure' || !(detail.failed ?? []).length) {
        return fail(res, 400, 'E1123', '这会儿没查到失败的检查（可能没配置，也可能状态没读），暂时没得修'), true;
      }
      const who = pickGateFixer(row);
      if (!who) return fail(res, 400, 'E1124', '还没有员工能修代码 —— 先去「专家库」雇一位研发'), true;
      /*
       * 派活要落在"这个仓库"的目录里。仓库根正好是某个项目的根时带上 projectId
       * （dispatch 会用它覆盖 cwd + 可写根）；对不上就靠他默认目录 —— 至少能读、能改，
       * 不硬造项目（同 pr-watch 的规矩：巡检/修复这种动作不该顺手建项目）。
       */
      const project = store.listProjects().find((p) => normPath(p.root) === normPath(row.localPath));
      const conv = store.ensureConversationForPersona(who.id);
      if (!conv) return fail(res, 400, 'E1125', '找不到这个员工的会话'), true;
      const { run } = dispatchToThread(conv.id, gateFixBrief({ repo: row.fullName, row, pull, detail }), {
        projectId: project?.id ?? null,
      });
      return sendJson(res, 202, {
        conversationId: conv.id,
        runId: run.id,
        personaId: who.id,
        personaName: who.name,
        personaRole: who.role ?? null,
      }), true;
    } catch (e) {
      // busy：他手上有活 —— 409 让界面说"他还在忙"，别当成失败
      if (e?.code === 'busy') return fail(res, 409, 'E1126', String(e.message ?? e)), true;
      return fail(res, 400, 'E1127', String(e.message ?? e)), true;
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
        // push:true —— 卡上这条路要"提交 + 推送 + 建 PR"一口气跑完（agent 干完活手上就是脏文件）
        const out = await git.openPr(repoRow, { ...prRequestOf(body, task), push: true });
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

  /*
   * ---- IDE 式一站式（2026-10-27）：分支弹窗 / 改动管理 / 历史 ----
   * 编排本体在 ../git-repos.mjs 的「分支 / 改动 / 历史」段（全本地 git，除 fetch/push），
   * 这里照旧只做"取那一条记录 + 把错误说人话"。错误码从 E1101 起（E1061-E1100 已占）。
   */
  const repoBranches = /^\/api\/git\/repos\/([^/]+)\/branches$/.exec(url.pathname);
  if (req.method === 'GET' && repoBranches) {
    const row = store.getGitRepo(decodeURIComponent(repoBranches[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      return sendJson(res, 200, await git.listBranches(row)), true;
    } catch (e) {
      return fail(res, 400, 'E1101', String(e.message ?? e)), true;
    }
  }

  const repoCheckout = /^\/api\/git\/repos\/([^/]+)\/checkout$/.exec(url.pathname);
  if (req.method === 'POST' && repoCheckout) {
    const row = store.getGitRepo(decodeURIComponent(repoCheckout[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await git.checkoutBranch(row, String(body.branch ?? ''))), true;
    } catch (e) {
      return fail(res, 400, 'E1102', String(e.message ?? e)), true;
    }
  }

  // 新建分支并切过去（分支弹窗「新建分支」）；从当前 HEAD 拉出，脏工作区不管（checkout -b 不动文件）
  const repoBranchNew = /^\/api\/git\/repos\/([^/]+)\/branch$/.exec(url.pathname);
  if (req.method === 'POST' && repoBranchNew) {
    const row = store.getGitRepo(decodeURIComponent(repoBranchNew[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await git.createBranch(row, String(body.name ?? ''))), true;
    } catch (e) {
      return fail(res, 400, 'E1109', String(e.message ?? e)), true;
    }
  }

  const repoCommit = /^\/api\/git\/repos\/([^/]+)\/commit$/.exec(url.pathname);
  if (req.method === 'POST' && repoCommit) {
    const row = store.getGitRepo(decodeURIComponent(repoCommit[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await git.commitAll(row, {
        message: String(body.message ?? ''),
        allowSecrets: !!body.allowSecrets,
        paths: Array.isArray(body.paths) ? body.paths.map(String) : null,
        // 站在 main 上提交时界面会带一个分支名（不带就由服务端给默认名）—— 主分支不收本地提交
        branch: body.branch ? String(body.branch) : null,
      })), true;
    } catch (e) {
      return fail(res, 400, 'E1103', String(e.message ?? e)), true;
    }
  }

  /* 生成提交说明（2026-10-29）：素材自己从 git 取，模型只负责措辞；模型不行就退规则兜底。
     只读接口 —— 不动工作区、不建 run，失败也只影响这一个按钮。 */
  const repoSuggestCommit = /^\/api\/git\/repos\/([^/]+)\/suggest-commit$/.exec(url.pathname);
  if (req.method === 'POST' && repoSuggestCommit) {
    const row = store.getGitRepo(decodeURIComponent(repoSuggestCommit[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await commitMsg.suggestCommitMessage(row, {
        paths: Array.isArray(body.paths) ? body.paths.map(String) : null,
      })), true;
    } catch (e) {
      return fail(res, 400, 'E1113', String(e.message ?? e)), true;
    }
  }

  /* PR 弹窗的「自动填充」（2026-10-29）：没推的提交 + 未提交改动 → 模型拧成标题+描述。
     同 suggest-commit：只读、不建 run、模型不行退规则，失败只影响这一颗按钮。 */
  const repoSuggestPr = /^\/api\/git\/repos\/([^/]+)\/suggest-pr$/.exec(url.pathname);
  if (req.method === 'POST' && repoSuggestPr) {
    const row = store.getGitRepo(decodeURIComponent(repoSuggestPr[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      return sendJson(res, 200, await commitMsg.suggestPrDraft(row)), true;
    } catch (e) {
      return fail(res, 400, 'E1114', String(e.message ?? e)), true;
    }
  }

  const repoPush = /^\/api\/git\/repos\/([^/]+)\/push$/.exec(url.pathname);
  if (req.method === 'POST' && repoPush) {
    const row = store.getGitRepo(decodeURIComponent(repoPush[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      return sendJson(res, 200, await git.pushCurrent(row)), true;
    } catch (e) {
      return fail(res, 400, 'E1104', String(e.message ?? e)), true;
    }
  }

  const repoFetch = /^\/api\/git\/repos\/([^/]+)\/fetch$/.exec(url.pathname);
  if (req.method === 'POST' && repoFetch) {
    const row = store.getGitRepo(decodeURIComponent(repoFetch[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      return sendJson(res, 200, await git.fetchRepo(row)), true;
    } catch (e) {
      return fail(res, 400, 'E1105', String(e.message ?? e)), true;
    }
  }

  const repoLog = /^\/api\/git\/repos\/([^/]+)\/log$/.exec(url.pathname);
  if (req.method === 'GET' && repoLog) {
    const row = store.getGitRepo(decodeURIComponent(repoLog[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      return sendJson(res, 200, await git.recentLog(row)), true;
    } catch (e) {
      return fail(res, 400, 'E1106', String(e.message ?? e)), true;
    }
  }

  const repoDiff = /^\/api\/git\/repos\/([^/]+)\/diff$/.exec(url.pathname);
  if (req.method === 'GET' && repoDiff) {
    const row = store.getGitRepo(decodeURIComponent(repoDiff[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      return sendJson(res, 200, await git.fileDiff(row, url.searchParams.get('path'))), true;
    } catch (e) {
      return fail(res, 400, 'E1107', String(e.message ?? e)), true;
    }
  }

  const repoDiscard = /^\/api\/git\/repos\/([^/]+)\/discard$/.exec(url.pathname);
  if (req.method === 'POST' && repoDiscard) {
    const row = store.getGitRepo(decodeURIComponent(repoDiscard[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await git.discardPaths(row, body.paths)), true;
    } catch (e) {
      return fail(res, 400, 'E1108', String(e.message ?? e)), true;
    }
  }

  /*
   * ---- 分支管理（2026-10-27）：与 base 比较 / 删分支 ----
   * 两个「读」不联网（删远端那一下要 fetch + GitHub，失败原话带回）。
   * 路径用连字符而不是 /branch/delete：跟上面新建分支的 `/branch` 分得开，
   * 也和 `branch-diff` 这一组读起来一致。
   * 逐文件 diff 的 path 由服务端按**当下**对比清单校验（拿旧清单来查一律拒），
   * 前端永远不把 git ref 传进来。
   */
  const repoBranchDiff = /^\/api\/git\/repos\/([^/]+)\/branch-diff$/.exec(url.pathname);
  if (req.method === 'GET' && repoBranchDiff) {
    const row = store.getGitRepo(decodeURIComponent(repoBranchDiff[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      return sendJson(res, 200, await git.compareBranch(row, {
        branch: url.searchParams.get('branch'),
        base: url.searchParams.get('base'),
      })), true;
    } catch (e) {
      return fail(res, 400, 'E1110', String(e.message ?? e)), true;
    }
  }

  const repoBranchDiffFile = /^\/api\/git\/repos\/([^/]+)\/branch-diff\/file$/.exec(url.pathname);
  if (req.method === 'GET' && repoBranchDiffFile) {
    const row = store.getGitRepo(decodeURIComponent(repoBranchDiffFile[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    try {
      return sendJson(res, 200, await git.branchFileDiff(row, {
        branch: url.searchParams.get('branch'),
        base: url.searchParams.get('base'),
        path: url.searchParams.get('path'),
      })), true;
    } catch (e) {
      return fail(res, 400, 'E1111', String(e.message ?? e)), true;
    }
  }

  const repoBranchDelete = /^\/api\/git\/repos\/([^/]+)\/branch-delete$/.exec(url.pathname);
  if (req.method === 'POST' && repoBranchDelete) {
    const row = store.getGitRepo(decodeURIComponent(repoBranchDelete[1]));
    if (!row) return fail(res, 404, 'E1076', '仓库不在清单里'), true;
    const body = await readBody(req);
    try {
      return sendJson(res, 200, await git.deleteBranch(row, {
        branch: String(body.branch ?? ''),
        remote: !!body.remote,
        base: body.base ?? null,
      })), true;
    } catch (e) {
      return fail(res, 400, 'E1112', String(e.message ?? e)), true;
    }
  }

  const one = /^\/api\/git\/repos\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && one) {
    try {
      // 先记下仓库名：移除之后清单里查不到，但它的巡检任务还挂在 schedule_jobs 上
      const row = store.getGitRepo(decodeURIComponent(one[1]));
      const out = git.removeRepo(decodeURIComponent(one[1]));
      const droppedJobs = row ? patrol.forgetRepo(row.fullName) : 0;
      return sendJson(res, 200, { ...out, droppedJobs }), true;
    } catch (e) {
      return fail(res, 404, 'E1066', String(e.message ?? e)), true;
    }
  }

  return fail(res, 404, 'E1067', '没有这个接口'), true;
}

