/**
 * 「PR 巡检」——平台里第一个**定时动作**（2026-10-17）。
 *
 * 用户问的是"别人提交一个 PR，我能看到吗"。在那之前平台只能靠人手动跑 `tools/repo-scan.mjs`：
 * 不跑就永远看不见。这个动作把它变成一件**到点自己会做**的事，节拍由「设置 → 定时任务」里那张
 * 任务卡决定（多久一次、开还是关），不是写死在代码里。
 *
 * 一次做三件事，缺一件闭环就不成立：
 *   ① **发现新的** —— 每个已接入仓库的 open PR / issue → 写成值班卡（`upsertRepoCard` 去重，
 *      同一张卡重复巡检只更新标题描述，**绝不覆盖人拖过的状态**）；
 *   ② **收旧状态** —— 已经关联了 PR 的卡，逐张再查一次。PR 在 GitHub 上被合并后不会再出现在
 *      "open" 列表里（①永远发现不了），只有这一半能把卡从「开着」改成「已合并」，
 *      并把「进行中」收成「待验收」。同一趟顺手把 **CI 结论**抓回卡上（2026-11-21），
 *      卡在「已阻塞」但有硬证据（PR 合并 / CI 全绿）的，按证据推到「待验收」；
 *   ③ **派审阅** —— 有新提交（headSha 变了）且仓库绑了管理员，才派一次（巡检便宜、审阅贵）。
 *
 * 边界（都写死在这里，不改）：
 *   · **只读** GitHub，不评论、不合、不改分支；
 *   · 卡片状态只按两条规则动：`afterMerged`（进行中 → 待验收）、`advanceByEvidence`
 *     （已阻塞 → 待验收，且必须有客观证据），别的列一律不碰；**永不推到「已完成」**；
 *   · 一次最多查 30 条 open（列表接口的分页上限），卡上关联的 PR 逐张查没有上限但有速率约束 ——
 *     所以节拍默认 30 分钟，别调太密。
 */
import * as store from './store.mjs';
import * as git from './git-repos.mjs';
import { upsertRepoCard, afterMerged, advanceByEvidence } from './project-tasks.mjs';
import { startPrReview, REVIEW_MARK } from './pr-review.mjs';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const errMsg = (e) => clip(String(e?.message ?? e), 160);
/** 路径比较：Windows 上大小写与反斜杠都不该让"同一个目录"认不出来 */
const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * 这个仓库的卡该落到哪个项目。
 *
 * 默认按"项目根 == 仓库克隆目录"对（「建成项目」就是这个形态）；对不上落内置默认项目。
 * `config.projectId` 可以强制指定一个项目 —— 多个仓库写进同一个看板时用得上。
 * **不新建项目**：巡检是只读动作，凭它顺手建出项目来，人会莫名其妙多出一堆空项目。
 */
function projectForRepo(repo, config) {
  const projects = store.listProjects();
  if (config?.projectId) return projects.find((p) => p.id === config.projectId) ?? null;
  const hit = projects.find((p) => normPath(p.root) === normPath(repo.localPath));
  return hit ?? projects.find((p) => p.builtIn) ?? projects[0] ?? null;
}

/** 一张 PR 卡：说清"谁提的、改了什么规模"，并给出该跑的验证命令（人照着跑，不替人下结论） */
function prCardOf(fullName, pr) {
  return {
    key: `pr:${pr.number}`,
    title: `PR #${pr.number} 待审：${clip(pr.title, 60)}`,
    description: [
      `${fullName} ｜ 作者：${pr.author || '?'}${pr.draft ? ' ｜ 草稿' : ''}`,
      '',
      '结论：**待审**（还没人跑过验证）',
      '',
      '要跑的（在仓库根）：',
      '```sh',
      `git fetch origin '+refs/pull/${pr.number}/head:refs/remotes/pr/${pr.number}'`,
      `git worktree add ../bandi-pr-${pr.number} refs/remotes/pr/${pr.number}`,
      `cd ../bandi-pr-${pr.number}`,
      'node tools/check-pr.mjs      # 零依赖 / 地址白名单 / 断言完整性',
      'node tools/run-smokes.mjs    # 不需要真实 CLI 的那批',
      '```',
      '判据、红线（一票否决）、黄线都在 docs/审阅经验.md。',
      '',
      `链接：${pr.url}`,
    ].join('\n'),
    pr: git.prFieldsOf({ url: pr.url, title: pr.title, state: 'open' }),
  };
}

/** 一张 issue 卡：先分类，再由人决定（不值得做 / 广告引流 / 需要澄清） */
function issueCardOf(fullName, issue) {
  return {
    key: `issue:${issue.number}`,
    title: `issue #${issue.number} 待分类：${clip(issue.title, 60)}`,
    description: [
      `${fullName} ｜ 作者：${issue.author || '?'}${issue.labels?.length ? ` ｜ 标签：${issue.labels.join('、')}` : ''}`,
      '',
      '结论：**待分类**（值得做 / 不值得 / 广告引流 / 需要澄清）—— 定了再回复，别晾着。',
      '回复模板见 docs/审阅经验.md 末尾（值得做 / 不值得做 / 广告三类）。',
      '',
      `链接：${issue.url}`,
    ].join('\n'),
    pr: null,
  };
}

/**
 * 取一条 PR 上**自动检查**的结论，归成卡上的三列（2026-11-21）。
 *
 * 为什么必须在巡检里做、而不是在 run 收尾时做：CI 是**异步**的 —— 员工刚 push 完就收尾，
 * 那一刻检查通常还在排队。收尾时同步查一次，拿到的永远是 pending，还会拖慢收尾。
 * 巡检每 30 分钟一轮，正好承担"回头看"的角色。
 *
 * 查不到就返回 `{}`（**保留上一次结论**）：接口抖动、令牌没勾 Actions 权限，都不该把
 * 已有的"全绿"抹成"未知" —— 那等于凭空销毁证据。
 */
async function ciFieldsOf(ref, headSha) {
  if (!headSha) return {};
  try {
    const c = await git.pullChecks(ref, headSha);
    if (c.state === 'unknown') return {};
    return {
      prCiState: c.state,
      // 只有红的时候才写名单；其它状态必须**清空**，否则界面上会出现"全绿 + 一串红名字"
      prCiFailed: c.state === 'failure' ? (c.failed ?? []).slice(0, 5).map((n) => clip(n, 40)).join('、') || null : null,
      prCiAt: new Date().toISOString(),
    };
  } catch {
    // 静默：CI 是附加信息，查不到不该让这轮 PR 刷新失败（也不该污染 failed 汇总）
    return {};
  }
}

/**
 * 跑一次巡检。`config` 来自任务卡（`{ repo?, projectId? }`），空 = 所有已接入仓库。
 * 返回一句话结论（存进任务的 `lastSummary`，界面上直接显示）。
 */
export async function prScan({ config = {} } = {}) {
  if (!git.readToken()) throw new Error('还没连接 GitHub（工作台 → 研发 → 代码托管）');
  let repos = store.listGitRepos();
  if (config?.repo) repos = repos.filter((r) => r.fullName === config.repo);
  if (!repos.length) {
    throw new Error(config?.repo ? `没有接入仓库 ${config.repo}（工作台 → 研发 → 代码托管）` : '还没有接入任何仓库（工作台 → 研发 → 代码托管）');
  }

  let created = 0;
  let updated = 0;
  let refreshed = 0;
  let reviewed = 0;
  const failed = [];
  /*
   * **GitHub 身份要先换成 `owner/name`**（2026-11-21 实修）。
   *
   * `git_repos.fullName` 对「本地代码托管」接进来的行可能只是目录名（`bandi`），
   * 而 GitHub API 的路径必须是 `owner/name` —— `repoApiPath('bandi')` 会当场报
   * E1205「这行仓库没有 GitHub 身份」。2026-11-20 已经把身份落进 `ghRef` 并给了
   * `githubRefOf()`，但**这里没跟着改**：巡检一直拿着 fullName 去打接口，
   * 于是每 30 分钟失败一次，卡上的 `prState` 永远停在 null（界面上就是「状态未知」）。
   * 收口：这一轮先算好 `fullName → 引用` 的表，下面所有 API 调用都用引用。
   */
  const refOf = new Map();
  for (const repo of repos) {
    let ref = repo.fullName;
    try {
      ref = (await git.githubRefOf(repo)) || repo.fullName;
    } catch {
      /* 解不出来就按 fullName 试，让 repoApiPath 去说 E1205（比静默跳过有用） */
    }
    refOf.set(repo.fullName, ref);
  }

  for (const repo of repos) {
    const project = projectForRepo(repo, config);
    if (!project) {
      failed.push(`${repo.fullName}：找不到落到哪个项目`);
      continue;
    }
    // 仓库绑了管理员（且人在）才走"审阅"这条路；没绑就完全是 2026-10-17 的老行为
    const keeperOk = !!(repo.keeperPersonaId && store.getPersona(repo.keeperPersonaId));
    const ref = refOf.get(repo.fullName) ?? repo.fullName;

    let pulls = [];
    try {
      pulls = await git.listOpenPulls(ref);
    } catch (e) {
      failed.push(`${repo.fullName}：${errMsg(e)}`);
      continue; // 这个仓库连 PR 都拉不到，issue 也没必要试（多半是同一个原因：令牌/权限）
    }
    for (const pr of pulls) {
      const card = prCardOf(repo.fullName, pr);
      /*
       * **别冲掉管理员写过的结论**（2026-10-23，FR-10）：这张卡上已经有「管理员审阅」
       * 段落的话，描述原样保住 —— 巡检的模板文本（"结论：待审"）只该管还没审过的卡。
       * 没这条，审完的卡下个节拍就被打回"待审"，管理员等于白审。
       */
      const existing = store.getProjectTaskByExternalKey(project.id, card.key);
      if (existing?.description?.includes(REVIEW_MARK)) card.description = existing.description;
      const out = upsertRepoCard({ projectId: project.id, ...card });
      out.created ? created++ : out.changed && updated++;

      /*
       * **新改动才审**（PRD 第七节：巡检便宜、审阅才花钱，两者频率解耦）：
       * 以 head.sha 为准 —— PR 改描述不算新，推了新提交才算。seen 记在 meta 表
       * （`prseen:{repo}#{n}`），跨重启。
       *   · 派审失败不记 seen：下个节拍重试（busy/网络抖动都是暂时的）；
       *   · 草稿、没绑管理员：记 seen 但不审 —— 别每个节拍都惦记同一件事。
       */
      const seenKey = `prseen:${repo.fullName}#${pr.number}`;
      if (pr.headSha && store.getMetaValue(seenKey) !== pr.headSha) {
        if (keeperOk && !pr.draft) {
          try {
            await startPrReview({ repo: ref, pr, projectId: project.id });
            store.setMetaValue(seenKey, pr.headSha);
            reviewed++;
          } catch (e) {
            failed.push(`PR #${pr.number} 审阅没派出去：${errMsg(e)}`);
          }
        } else {
          store.setMetaValue(seenKey, pr.headSha);
        }
      }
    }

    try {
      for (const issue of await git.listOpenIssues(ref)) {
        const out = upsertRepoCard({ projectId: project.id, ...issueCardOf(repo.fullName, issue) });
        out.created ? created++ : out.changed && updated++;
      }
    } catch (e) {
      failed.push(`${repo.fullName} 的 issue：${errMsg(e)}`);
    }
  }

  /*
   * ② 收旧状态。只查**这次范围内的仓库**：一个仓库一个任务卡的话，
   * 别的仓库那些卡不该被这个任务顺手刷（那是另一个任务的职责，也会多烧请求）。
   *
   * 范围里**两种写法都收**（2026-11-21）：`fullName` 是老卡写的本地目录名，
   * `ghRef` 是 2026-11-20 起写进卡里的 `owner/name` —— 只认其中一种，另一半的卡就永远刷不到
   * （pt-4b6bf1ec 的 `prRepo` 正好是 `shepherd-chenxs/bandi`，旧 scope 只装 `bandi`，直接被跳过）。
   */
  const scope = new Set();
  for (const r of repos) {
    scope.add(r.fullName);
    scope.add(refOf.get(r.fullName) ?? r.fullName);
  }
  let evidenceAdvanced = 0;
  for (const t of store.listProjectTasksWithPr()) {
    if (!scope.has(t.prRepo)) continue;
    if (config?.projectId && t.projectId !== config.projectId) continue;
    try {
      // 卡上的 prRepo 也可能只是目录名：查之前统一换成 owner/name
      const row = store.getGitRepoByRef(t.prRepo);
      const ref = row ? ((await git.githubRefOf(row)) || t.prRepo) : t.prRepo;
      const snap = await git.fetchPull(ref, t.prNumber);
      const next = store.updateProjectTask(t.id, {
        // 顺手把卡上的仓库写法归一到 owner/name，下次不用再解
        prRepo: ref,
        prState: snap.state,
        prTitle: snap.title,
        prCheckedAt: new Date().toISOString(),
        ...(await ciFieldsOf(ref, snap.headSha)),
      });
      afterMerged(next);
      /*
       * 「进行中」归 afterMerged 管；**「已阻塞」的卡归这里**（2026-11-21）。
       * 这一条补的是实报 pt-4b6bf1ec 那种账：活干完了、PR 合了，但员工漏写 `[完成]`，
       * 卡在「已阻塞」躺着没人动 —— 以前巡检只刷事实、从不据此推进。
       */
      if (advanceByEvidence(next) !== next) evidenceAdvanced++;
      if (snap.state !== t.prState) refreshed++;
    } catch (e) {
      failed.push(`#${t.prNumber}：${errMsg(e)}`);
    }
  }

  // 一条都没成 = 这次巡检是失败的（别用"成功"把真实原因盖掉）；部分失败只写在结论里
  if (failed.length === repos.length) throw new Error(failed[0]);

  const parts = [
    `新建 ${created} 张`,
    `更新 ${updated} 张`,
    `PR 状态变化 ${refreshed} 张`,
    reviewed ? `新派出审阅 ${reviewed} 个` : null,
    evidenceAdvanced ? `按证据转待验收 ${evidenceAdvanced} 张` : null,
    `共查 ${repos.length} 个仓库`,
  ].filter(Boolean);
  if (failed.length) parts.push(`${failed.length} 处没查成：${failed[0]}`);
  return { summary: parts.join('，'), created, updated, refreshed, reviewed, evidenceAdvanced, failed };
}
