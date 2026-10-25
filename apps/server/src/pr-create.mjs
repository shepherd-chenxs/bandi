/**
 * **PR 交付流程：开发完成 → 建 PR → 审阅 → 合并**（2026-10-25）。
 *
 * 用户的需求一句话：「本地写的代码，我让仓库管家提交的时候能自动建 PR、推到服务端、合并；
 * 别人的 PR 能检测合并；或者我自己点按钮建 PR。」按钮那一半在 §「建 PR 与手动合并」已经做完，
 * 这里补的是**流程那一半**：把"建 PR"接成流程里的动作节点，让一条流程跑到它时平台自己
 * 提交、推送、开 PR，然后把材料交给仓库管理员审阅，最后走 `pr-merge` 的判定表合并。
 *
 * 为什么建 PR 是**平台动作**、不是给员工装技能（2026-10-25 调研结论）：
 *   上游那些 skill / MCP（superpowers 的 finishing-a-development-branch、Claude Code 的
 *   commit-push-pr、GitHub 官方 MCP 的 create_pull_request）都假定**干活的那一方自己有凭据**；
 *   班底的 `agentEnv()` 恰恰删掉 GIT_* / GH_TOKEN。给员工装一个"会建 PR 的技能"等于把令牌发回去，
 *   还绕开合并四闸与 `tools/check-pr.mjs`。所以照旧：**平台执行、员工只出意见**。
 *
 * 复用关系（不写第二份）：
 *   · 建 PR → `git-repos.openPr()`（提交/推送/查重/凭据闸都在里面，和按钮那条路同一个函数）；
 *   · 审阅材料 → `pr-review.pullReviewMaterial()`（和巡检派审阅同一份材料）；
 *   · 审阅提示词 → `pr-review.REVIEW_DETAIL`（只有一份）；
 *   · 合并 → `pr-review` 注册的 `pr-merge` 动作节点（判定表、四闸、SHA 锁、人拍板语义全不动）。
 *
 * 模板里「开发完成」「审阅」两个节点**不点名经办人**（与内建交付流程同一个规矩：技能是
 * "这个人会干什么"，不是"这一步该谁办"）。「审阅」由本模块按**仓库绑的管理员**自动指派；
 * 「开发完成」等人指派 —— 那一步的产出是人/研发自己交的，平台不替用户决定谁来做。
 */
import * as store from './store.mjs';
import * as git from './git-repos.mjs';
import { registerActionNode, finishActionTask, assignCurrentStep } from './workflows.mjs';
import { upsertRepoCard } from './project-tasks.mjs';
import { REVIEW_DETAIL, pullReviewMaterial, rememberReviewedSha } from './pr-review.mjs';

export const PR_DELIVERY_TEMPLATE_ID = 'bandi-pr';
/** 模板里的节点 id：材料塞给谁、建完去哪一步，只认这两个常量（模板被改过就不硬塞） */
const REVIEW_NODE_ID = 'n3';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const DEV_DETAIL = [
  '按这一条流程的目标把代码写完，自测通过后报告：改了哪些文件、怎么验的。',
  '',
  '⚠️ 下一步「建 PR」是**平台动作**：它会把项目目录里**所有未提交的改动**收成一个提交、',
  '推到一条新分支（不会动 base，也不会强推），然后开 PR。所以动手前先确认工作区只含本次改动；',
  '`.env`、私钥这类文件会被凭据闸拦下（要人显式确认才放行）。',
].join('\n');

const MERGE_DETAIL = '平台执行：管理员结论「值得合」+ CI 全绿 + 没碰敏感文件 + 改动 ≤ 400 行，' +
  '且仓库开了「自动合并」才自动合；否则停在这里等你点「通过」——点通过才合并，驳回不合并。';

/**
 * 内建流程模板。x/y 是画布坐标（用户拖过就存下来，不覆盖）。
 * `pr-create` 与 `pr-merge` 都是**动作节点**：没有经办人，引擎到站直接调 handler。
 */
export const PR_DELIVERY_TEMPLATE = {
  id: PR_DELIVERY_TEMPLATE_ID,
  name: '开发完成 → 建 PR → 审阅 → 合并',
  builtIn: true,
  start: 'n1',
  nodes: [
    {
      id: 'n1', name: '开发完成', x: 60, y: 60,
      detail: DEV_DETAIL,
      approve: 'n2', reject: 'end',
    },
    {
      id: 'n2', name: '建 PR', x: 320, y: 60,
      action: 'pr-create',
      detail: '平台执行：把项目目录的改动收成一个提交 → 推一条新分支 → 开 PR → 把材料交给管理员审阅。',
      approve: 'n3', reject: 'end',
    },
    {
      id: 'n3', name: '审阅', x: 580, y: 60,
      detail: REVIEW_DETAIL, // 与「PR 审阅」模板同一份提示词；材料由 pr-create 写进这一步的 detail
      approve: 'n4', reject: 'end',
    },
    {
      id: 'n4', name: '合并', x: 840, y: 60,
      action: 'pr-merge',
      detail: MERGE_DETAIL,
      approve: 'end', reject: 'end',
    },
  ],
};

/**
 * 保证内建模板存在（幂等）。**第一次建出来就发布** —— 不然它在「工作台 → 流程」里点不开，
 * 用户还得先去设计器里找半天。用户后来手动下架了就不管，不跟人的操作抢。
 */
export function ensurePrDeliveryTemplate() {
  const cur = store.getWorkflowTemplate(PR_DELIVERY_TEMPLATE_ID);
  if (!cur) {
    store.upsertWorkflowTemplate(PR_DELIVERY_TEMPLATE);
    store.setTemplatePublished(PR_DELIVERY_TEMPLATE_ID, true);
    return store.getWorkflowTemplate(PR_DELIVERY_TEMPLATE_ID);
  }
  if (!cur.builtIn) return cur; // 用户接管了（改过 id 不算接管，builtIn 是平台写的）—— 不动

  /*
   * 已有模板：只补**平台后来新增的东西**，用户改过的一律不动（与 ensureBuiltInTemplate 同一规矩）：
   *   · detail 是平台写的提示词（审阅那份随 pr-review 更新）；
   *   · 老模板没坐标时补坐标（画布上会叠在一起）。
   * 连线（approve/reject）、点名（personaId）、manual 都是用户的选择，永不覆盖。
   */
  let touched = false;
  const byId = new Map(PR_DELIVERY_TEMPLATE.nodes.map((n) => [n.id, n]));
  const nodes = (() => {
    try {
      return JSON.parse(cur.nodes || '[]');
    } catch {
      return [];
    }
  })().map((n) => {
    const ref = byId.get(n.id);
    if (!ref) return n;
    const next = { ...n };
    if (ref.detail && ref.detail !== next.detail) {
      next.detail = ref.detail;
      touched = true;
    }
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      next.x = ref.x;
      next.y = ref.y;
      touched = true;
    }
    return next;
  });
  if (touched) store.upsertWorkflowTemplate({ id: cur.id, name: cur.name, nodes, builtIn: !!cur.builtIn });
  return store.getWorkflowTemplate(PR_DELIVERY_TEMPLATE_ID);
}

/* ------------------------------------------------------------ 动作节点：建 PR */

/** PR 标题：流程名就是最好的一句；太长就截（GitHub 标题不限制，但卡片上要能一行读完） */
function prTitleOf(run) {
  return clip(run?.title || '自动建 PR', 72) || '自动建 PR';
}

/** PR 正文：把流程的起因带上，人点进 GitHub 就知道为什么有这个 PR */
function prBodyOf(run) {
  return [
    run?.intent ? `改动说明：${clip(run.intent, 800)}` : '',
    '',
    `由流程「${clip(run?.title, 60)}」自动创建（实例 ${run?.id}）。`,
    '提交与推送由平台执行；合并要过管理员审阅与四道闸。',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/**
 * `pr-create` 的 handler。成功 → 收尾并按出口推进（到「审阅」）。
 *
 * 两个"建完 PR 之后的动作"必须放在 `finishActionTask` **之后**：
 * 那时流程才真的走到审阅节点、那一步的任务才存在，材料/指派才有地方放。
 * 也不能吞掉失败去假装建好了 —— 推不上去、凭据闸、403 都原样抛给引擎标「失败」。
 */
async function runCreateNode({ runId, task }) {
  const run = store.getWorkflowRun(runId);
  if (!run.projectId) {
    throw new Error('这条流程没挂项目 —— 建 PR 要在项目的目录里提交（发起流程时选一个项目）');
  }
  const project = store.getProject(run.projectId);
  if (!project) throw new Error('这条流程挂的项目已经不在了 —— 找不到要提交的目录');

  const found = git.repoForCwd(project.root);
  if (!found) {
    throw new Error(`项目目录不在任何已接入的仓库里：${project.root} —— 去「设置 → 代码托管」把它接进来`);
  }
  const row = store.getGitRepoByFullName(found.fullName);
  if (!row) throw new Error(`仓库 ${found.fullName} 已经不在清单里了 —— 去「设置 → 代码托管」重新接一次`);
  if (!git.readToken()) throw new Error('还没连接 GitHub（设置 → 代码托管）—— 建 PR 要用令牌');
  if (!row.localPath) throw new Error(`仓库 ${row.fullName} 没有本地目录 —— 先接入/克隆一份再跑`);

  /*
   * **重试不再建第二个**：如果上一次已经把 PR 建出来、只是在收尾那几步挂了，
   * run 上已经记着 repo/number —— 直接沿用它。工作区这时通常已经干净，
   * 再走一次 openPr 只会报"没东西可提"，把一件已经成的事说成失败。
   */
  let pr;
  let created = false;
  if (run.prRepo && run.prNumber) {
    const n = Number(run.prNumber);
    pr = {
      repo: run.prRepo,
      number: n,
      title: '',
      url: `https://github.com/${run.prRepo}/pull/${n}`,
    };
  } else {
    const out = await git.openPr(row, { title: prTitleOf(run), body: prBodyOf(run) });
    pr = {
      repo: row.fullName,
      number: out.pr.number,
      title: out.pr.title || prTitleOf(run),
      url: out.pr.url,
    };
    created = out.created;
    store.setWorkflowRunPr(runId, { repo: row.fullName, number: out.pr.number });
  }
  const title = pr.title || prTitleOf(run);

  /*
   * 看板：给这个 PR 写一张「仓库值班」卡（`pr:<n>` 与巡检同一套去重键）。
   * 后面审阅结论、合并状态都写在这张卡上 —— 从流程建出来的 PR 不该在别处另起一张卡。
   * 写卡失败不影响建 PR 这件事：PR 已经真在 GitHub 上了，卡只是可视化。
   */
  try {
    // 用 `owner/name#n` 喂给 prFieldsOf（它同时认这种写法）—— 不拿 pr.url 去解析：
    // 假件/GitHub Enterprise 的域名不是 github.com，按链接解析会悄悄得到 null，卡就没了。
    const fields = git.prFieldsOf({ ref: `${pr.repo}#${pr.number}`, title, state: 'open' });
    if (fields) {
      upsertRepoCard({
        projectId: run.projectId,
        key: `pr:${pr.number}`,
        title: `PR #${pr.number}：${clip(title, 60)}`,
        description: `由流程「${clip(run.title, 40)}」自动建。`,
        pr: fields,
      });
    }
  } catch (e) {
    console.warn(`流程建 PR 之后写卡没成（不影响 PR 本身）：${e?.message ?? e}`);
  }

  // 审阅材料现在取：给管理员的是"这一刻的 PR"；取不到就照实写进材料里，别让审阅变成瞎猜
  let material = '';
  try {
    const review = await pullReviewMaterial(row.fullName, pr.number);
    material = review.material;
    // 自动合并的 SHA 锁只认**管理员看的那一份**（与巡检派审阅同一个写法，见 pr-review.rememberReviewedSha）
    rememberReviewedSha(runId, review.pull.headSha);
  } catch (e) {
    material = `（审阅材料没取到：${String(e?.message ?? e).slice(0, 200)} —— 去 GitHub 看这个 PR：${pr.url}）`;
  }

  finishActionTask(runId, task, {
    ok: true,
    result: {
      state: 'done',
      summary: `已建 PR #${pr.number}：${clip(title, 60)}`,
      artifacts: [pr.url],
      error: null,
    },
    note: `已建 PR #${pr.number}（${created ? '新分支' : '沿用上次'}）—— 下一步交给审阅`,
  });

  /*
   * 模板被人改过（审阅节点不是 n3、或者被删了）就不硬塞材料/指派：
   * 照旧留给她自己指派 —— 猜一个节点塞材料比不塞更糟（材料会出现在不相干的人那里）。
   *
   * ⚠️ 这一段在 `finishActionTask` **之后**，必须自己兜住异常：那一步已经把任务收成
   * 「已完成」、流程也推到审阅节点了；这里再往上抛，引擎会把**已完成的建 PR 任务**改成
   * 「失败」，账面和事实就对不上了。出了岔子只记日志 —— PR 已经真在 GitHub 上了。
   */
  try {
    const after = store.getWorkflowRun(runId);
    if (!after || after.status !== '进行中' || after.currentNodeId !== REVIEW_NODE_ID) return;
    const reviewTask = store.listWorkflowTasks(runId).at(-1);
    if (!reviewTask) return;

    store.updateWorkflowTask(reviewTask.id, { detail: `${REVIEW_DETAIL}\n\n【审阅材料】\n${material}` });

    const keeperId = row.keeperPersonaId;
    if (keeperId && store.getPersona(keeperId)) {
      try {
        // 指派即派活（引擎既有语义）。管理员正忙时 startCurrentStep 会退回「待办」并抛 busy，
        // 30 秒的节拍会再派 —— 这不是失败，别把已经建好的 PR 标红。
        assignCurrentStep(runId, keeperId);
      } catch (e) {
        console.warn(`PR #${pr.number} 已建好，但审阅暂时没派给管理员：${e?.message ?? e}`);
      }
    } else {
      store.updateWorkflowTask(reviewTask.id, {
        note: `PR #${pr.number} 已建好。这个仓库没绑管理员 —— 去「设置 → 代码托管」给它选一个，回来在这步点指派；也可以直接指派个人`,
      });
    }
  } catch (e) {
    console.warn(`PR #${pr.number} 已建好，但把材料/指派交给审阅节点时出了岔子：${e?.message ?? e}`);
  }
}

registerActionNode('pr-create', { run: runCreateNode });
