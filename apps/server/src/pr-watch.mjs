/**
 * 「PR 巡检」——平台里第一个**定时动作**（2026-10-17）。
 *
 * 用户问的是"别人提交一个 PR，我能看到吗"。在那之前平台只能靠人手动跑 `tools/repo-scan.mjs`：
 * 不跑就永远看不见。这个动作把它变成一件**到点自己会做**的事，节拍由「设置 → 定时任务」里那张
 * 任务卡决定（多久一次、开还是关），不是写死在代码里。
 *
 * 一次做两件事，缺一件闭环就不成立：
 *   ① **发现新的** —— 每个已接入仓库的 open PR / issue → 写成值班卡（`upsertRepoCard` 去重，
 *      同一张卡重复巡检只更新标题描述，**绝不覆盖人拖过的状态**）；
 *   ② **收旧状态** —— 已经关联了 PR 的卡，逐张再查一次。PR 在 GitHub 上被合并后不会再出现在
 *      "open" 列表里（①永远发现不了），只有这一半能把卡从「开着」改成「已合并」，
 *      并把「进行中」收成「待确认」。
 *
 * 边界（都写死在这里，不改）：
 *   · **只读** GitHub，不评论、不合、不改分支；
 *   · 卡片状态只按 `afterMerged` 那条规则动（进行中 → 待确认），别的列一律不碰；
 *   · 一次最多查 30 条 open（列表接口的分页上限），卡上关联的 PR 逐张查没有上限但有速率约束 ——
 *     所以节拍默认 30 分钟，别调太密。
 */
import * as store from './store.mjs';
import * as git from './git-repos.mjs';
import { upsertRepoCard, afterMerged } from './project-tasks.mjs';

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
 * 跑一次巡检。`config` 来自任务卡（`{ repo?, projectId? }`），空 = 所有已接入仓库。
 * 返回一句话结论（存进任务的 `lastSummary`，界面上直接显示）。
 */
export async function prScan({ config = {} } = {}) {
  if (!git.readToken()) throw new Error('还没连接 GitHub（设置 → 代码托管）');
  let repos = store.listGitRepos();
  if (config?.repo) repos = repos.filter((r) => r.fullName === config.repo);
  if (!repos.length) {
    throw new Error(config?.repo ? `没有接入仓库 ${config.repo}（设置 → 代码托管）` : '还没有接入任何仓库（设置 → 代码托管）');
  }

  let created = 0;
  let updated = 0;
  let refreshed = 0;
  const failed = [];

  for (const repo of repos) {
    const project = projectForRepo(repo, config);
    if (!project) {
      failed.push(`${repo.fullName}：找不到落到哪个项目`);
      continue;
    }

    let pulls = [];
    try {
      pulls = await git.listOpenPulls(repo.fullName);
    } catch (e) {
      failed.push(`${repo.fullName}：${errMsg(e)}`);
      continue; // 这个仓库连 PR 都拉不到，issue 也没必要试（多半是同一个原因：令牌/权限）
    }
    for (const pr of pulls) {
      const out = upsertRepoCard({ projectId: project.id, ...prCardOf(repo.fullName, pr) });
      out.created ? created++ : out.changed && updated++;
    }

    try {
      for (const issue of await git.listOpenIssues(repo.fullName)) {
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
   */
  const scope = new Set(repos.map((r) => r.fullName));
  for (const t of store.listProjectTasksWithPr()) {
    if (!scope.has(t.prRepo)) continue;
    if (config?.projectId && t.projectId !== config.projectId) continue;
    try {
      const snap = await git.fetchPull(t.prRepo, t.prNumber);
      const next = store.updateProjectTask(t.id, {
        prState: snap.state,
        prTitle: snap.title,
        prCheckedAt: new Date().toISOString(),
      });
      afterMerged(next);
      if (snap.state !== t.prState) refreshed++;
    } catch (e) {
      failed.push(`#${t.prNumber}：${errMsg(e)}`);
    }
  }

  // 一条都没成 = 这次巡检是失败的（别用"成功"把真实原因盖掉）；部分失败只写在结论里
  if (failed.length === repos.length) throw new Error(failed[0]);

  const parts = [`新建 ${created} 张`, `更新 ${updated} 张`, `PR 状态变化 ${refreshed} 张`, `共查 ${repos.length} 个仓库`];
  if (failed.length) parts.push(`${failed.length} 处没查成：${failed[0]}`);
  return { summary: parts.join('，'), created, updated, refreshed, failed };
}
