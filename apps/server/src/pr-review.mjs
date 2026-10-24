/**
 * **PR 审阅与授权合并**（2026-10-23，docs/PRD-2026-10-23-PR审阅与授权合并.md）。
 *
 * 用户的需求一句话：「别人提交了一个 pr，仓库管理员帮我去检查，告诉我它干了什么、
 * 有没有风险、是不是垃圾，我来做决策。我不想看 diff —— 想看 diff 我直接去 GitHub。」
 *
 * 分工写死在这儿：
 *   · **管理员（agent）只有建议权** —— 产出四段结论，绝不让它碰令牌去合并
 *     （agent 环境本来就清过 GIT_*，这是隔离，不是缺陷）；
 *   · **合并是平台动作** —— 注册成流程引擎的动作节点（workflows.registerActionNode），
 *     服务端持令牌调 GitHub，谁授权了、什么时候合的，流程实例本身就是账本；
 *   · **授权 = 合并节点前是否等人确认** —— 用户 2026-10-23 拍板：不做"影子模式"试用期，
 *     授权是随时可收放的权利。勾上 = 审阅通过的 PR 也停在「待验收」等人点；
 *     不勾 = 结论 ✅ 且四条闸全过才自动合。⚠️/🗑️ 无论授权与否都不自动合。
 *
 * 边界：🗑️ 垃圾不进「待验收」列（直接终止实例）；改授权只影响之后的判定，
 * 已停在确认点的实例等人点 —— 状态不回跳，是这个平台一贯的规矩。
 */
import * as store from './store.mjs';
import * as git from './git-repos.mjs';
import { registerActionNode, finishActionTask, startWorkflow, assignCurrentStep, abortWorkflow } from './workflows.mjs';
import { upsertRepoCard } from './project-tasks.mjs';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** 审阅结论在值班卡描述里的标记：巡检看到它就不覆盖描述（FR-10，状态不回跳） */
export const REVIEW_MARK = '【管理员审阅】';

/* ---------------------------------------------------------- 内建流程模板 */

export const PR_REVIEW_TEMPLATE_ID = 'pr-review';

/** 审阅节点给管理员的指令（模板 detail = 平台写的提示词，随内建模板更新） */
const REVIEW_DETAIL = [
  '你是这个仓库的值班管理员。根据下面的材料审这个 PR：它干了什么、有没有风险、是不是垃圾。',
  '你不需要看 diff 全文 —— 材料里的文件清单和 patch 足够判断；想看原文就报链接，让人自己去 GitHub。',
  '',
  '产出固定四段（写进卡里给人看的，说人话）：',
  '1. 干了什么：一句话 + 最多 3 条要点；',
  '2. 改了哪里：按区域点名（tools/、文档、CI…），碰没碰敏感文件（CI 工作流/鉴权/令牌/密钥）要单独明说；',
  '3. 风险：对照判据台账（删测试断言、夹带 package.json、陌生域名、改 CI/鉴权……），没风险要明说「没看出」；',
  '4. 最后一行必须是结论，三选一、原样输出：',
  '   结论：值得合',
  '   结论：垃圾',
  '   结论：拿不准',
  '',
  '拿不准就写拿不准、并指出人该看哪里 —— 不许装懂。垃圾要附一句为什么。',
].join('\n');

export const PR_REVIEW_TEMPLATE = {
  id: PR_REVIEW_TEMPLATE_ID,
  name: 'PR 审阅与合并',
  builtIn: true,
  start: 'n1',
  nodes: [
    {
      id: 'n1', name: '审阅', x: 220, y: 60,
      detail: REVIEW_DETAIL,
      approve: 'n2', reject: 'end', // 材料都不成立 → 直接收尾
      // 不点名经办人：**这个节点派给谁是仓库说了算**（git_repos.keeperPersonaId），
      // 每个仓库绑的管理员可以不一样 —— 模板写死就把多仓库绑死了。到站由 startPrReview 指派。
    },
    {
      id: 'n2', name: '合并', x: 480, y: 60,
      action: 'pr-merge', // 平台自己执行的动作（见 ACTION_NODES），不是聊天任务
      approve: 'end',
      reject: 'end', // 驳回 = 不合并，实例收尾（合没合在卡和任务记录上）
    },
  ],
};

/** 幂等：没有就建；是内建的就把审阅指令刷成最新（连线/坐标是用户的，永不覆盖） */
export function ensurePrReviewTemplate() {
  const cur = store.getWorkflowTemplate(PR_REVIEW_TEMPLATE_ID);
  if (!cur) {
    store.upsertWorkflowTemplate(PR_REVIEW_TEMPLATE);
    return;
  }
  if (!cur.builtIn) return; // 用户改过/接管了，别动
  let touched = false;
  const nodes = JSON.parse(cur.nodes || '[]').map((n) => {
    if (n.id === 'n1' && n.detail !== REVIEW_DETAIL) {
      touched = true;
      return { ...n, detail: REVIEW_DETAIL };
    }
    return n;
  });
  if (touched) store.upsertWorkflowTemplate({ id: cur.id, name: cur.name, nodes, builtIn: true });
}

/* ---------------------------------------------------------- 纯函数（冒烟直接钉） */

/**
 * 从管理员回复里解析结论。**取最后一次出现**（模型有时先给过程再给结论）。
 * 解析不到一律按「拿不准」—— 宁可多问一句人，不可错合一个 PR（PRD 第七节）。
 */
export function parseVerdict(finalText) {
  const re = /结论\s*[:：]\s*(值得合|垃圾|拿不准)/g;
  let m;
  let last = null;
  while ((m = re.exec(String(finalText ?? '')))) last = m[1];
  if (last === '值得合') return 'worth';
  if (last === '垃圾') return 'spam';
  return 'unsure';
}

/** 敏感文件：CI 工作流 / 鉴权 / 令牌 / 密钥 / 环境变量。命中 = 自动合并的闸不过 */
const SENSITIVE_RE = /(^|\/)(\.github|\.workflows)(\/|$)|(^|\/)(auth|token|secret|credential|password|passwd|api_?key)([._-]|$)|(^|\/)\.env/i;

/** 这批改动文件里有没有敏感路径；返回命中的文件名（写进卡，让人一眼看到碰了什么） */
export function touchSensitive(files) {
  return (files ?? []).map((f) => f.filename ?? '').filter((fn) => fn && SENSITIVE_RE.test(fn));
}

/** 自动合并的改动量上限（additions+deletions）。估算值：一个 PRD 里写明的可调阈值 */
export const MAX_CHANGE_LINES = 400;

/**
 * 合并四条闸（PRD 第六节判定表）——**纯函数**，冒烟钉它。
 * @returns {{ pass: boolean, reasons: string[] }} 没过的话 reasons 是说人话的原因清单
 */
export function evaluateGates({ verdict, checksState = 'none', files = [], additions = 0, deletions = 0, maxLines = MAX_CHANGE_LINES } = {}) {
  const reasons = [];
  if (verdict !== 'worth') reasons.push('管理员结论不是「值得合」');
  if (checksState !== 'success') {
    reasons.push(checksState === 'none' ? '没有 CI 检查结果（没绿不算过 —— 闸门的规矩）' : 'CI 有没过的检查');
  }
  const sensitive = touchSensitive(files);
  if (sensitive.length) reasons.push(`碰了敏感文件：${sensitive.slice(0, 3).join('、')}`);
  const lines = Number(additions) + Number(deletions);
  if (lines > maxLines) reasons.push(`改动量 ${lines} 行超过上限 ${maxLines} 行`);
  return { pass: reasons.length === 0, reasons };
}

/** 给管理员的审阅材料：标题/作者/规模/描述 + 文件清单（带截短后的 patch） */
export function buildMaterial({ pull, files }) {
  const fileLines = (files ?? [])
    .map((f) => `- ${f.filename}（+${f.additions}/-${f.deletions}${f.patch ? '' : '，无 patch'}）${f.patch ? `\n\`\`\`diff\n${f.patch}\n\`\`\`` : ''}`)
    .join('\n');
  return [
    `标题：${pull.title}`,
    `作者：${pull.author || '?'}${pull.draft ? '（草稿）' : ''} ｜ 改动：+${pull.additions}/-${pull.deletions}，${pull.changedFiles} 个文件`,
    pull.body ? `描述：${clip(pull.body, 800)}` : '描述：（空）',
    '',
    '文件：',
    fileLines || '（一个文件都没有）',
  ].join('\n');
}

/* ---------------------------------------------------------- 发起审阅 */

/**
 * 给一个新 PR 起审阅流程。巡检发现新 head.sha 且仓库绑了管理员时调。
 * 返回实例视图；失败往上抛（调用方决定卡上怎么写、要不要下个节拍重试）。
 */
export async function startPrReview({ repo, pr, projectId }) {
  const row = store.getGitRepoByFullName(repo);
  const keeperId = row?.keeperPersonaId;
  if (!keeperId || !store.getPersona(keeperId)) throw new Error(`仓库 ${repo} 没绑管理员（或绑的人已删）`);

  // 材料现在取：审的是这一刻的 PR；推了新提交 sha 会变，自然走"新改动"重新审
  const pull = await git.fetchPull(repo, pr.number);
  const files = await git.listPullFiles(repo, pr.number);
  const material = buildMaterial({ pull, files });

  const run = startWorkflow({
    templateId: PR_REVIEW_TEMPLATE_ID,
    title: `PR #${pr.number} 审阅：${clip(pull.title, 40)}`,
    intent: material,
    projectId: projectId ?? null,
    autoStart: false, // 第一步还没点名，硬起会标「已阻塞」——下面指派完马上就派
    pr: { repo, number: pr.number },
  });
  assignCurrentStep(run.id, keeperId); // 指派即派活（引擎既有语义）
  return run;
}

/* ---------------------------------------------------------- 合并动作节点 */

/** 从审阅任务的结果里拿管理员全文（result 是 resultOf 的 JSON，见 workflows.resultOf） */
function reviewTextOf(runId) {
  const tasks = store.listWorkflowTasks(runId).filter((t) => t.nodeId === 'n1');
  const last = tasks[tasks.length - 1];
  if (!last?.result) return '';
  try {
    return JSON.parse(last.result)?.finalText ?? '';
  } catch {
    return '';
  }
}

/** 把管理员结论写回值班卡（upsert 去重、不碰人拖过的状态 —— 复用值班卡的全部规矩）。
 *  conclusion 为空 = 只同步 PR 状态（合并/关闭），描述一个字不动 —— 别把人看过的分析冲掉。 */
function updateCardWithReview({ projectId, repo, number, prState, conclusion }) {
  if (!projectId) return;
  const card = store.getProjectTaskByExternalKey(projectId, `pr:${number}`);
  const prev = card?.description ?? '';
  const description = conclusion
    ? `${prev.split(REVIEW_MARK)[0].trimEnd()}\n\n${REVIEW_MARK}\n${conclusion}`.trim()
    : prev;
  upsertRepoCard({
    projectId,
    key: `pr:${number}`,
    title: card?.title ?? `PR #${number} 待审`,
    description,
    pr: git.prFieldsOf({ url: `https://github.com/${repo}/pull/${number}`, title: card?.prTitle ?? '', state: prState }),
  }); // upsertRepoCard 内部已做 afterMerged（进行中 → 待验收），不用再收一遍
}

/** 判定表 + （授权时）执行合并。跑在动作节点上，异步 —— 挂了引擎兜底标「失败」 */
async function runMergeNode({ runId, task }) {
  const run = store.getWorkflowRun(runId);
  const repo = run.prRepo;
  const number = Number(run.prNumber);
  if (!repo || !number) throw new Error('这条实例没记 PR（老实例或数据缺损）—— 没法执行合并');

  const text = reviewTextOf(runId);
  const verdict = parseVerdict(text);

  // PR 现在的状态可能已经变了（被人在 GitHub 上合了/关了）—— 以现在为准
  const pull = await git.fetchPull(repo, number);
  if (pull.state === 'merged') {
    updateCardWithReview({ projectId: run.projectId, repo, number, prState: 'merged', conclusion: verdictConclusionText(text, verdict, '已在 GitHub 上合并，流程收尾。') });
    return finishActionTask(runId, task, { ok: true, note: `PR #${number} 已经合并过了，收尾` });
  }
  if (pull.state === 'closed') {
    updateCardWithReview({ projectId: run.projectId, repo, number, prState: 'closed', conclusion: verdictConclusionText(text, verdict, 'PR 已在 GitHub 上关闭，流程收尾。') });
    return finishActionTask(runId, task, { ok: true, note: `PR #${number} 已关闭，没合（也合不了）` });
  }

  const files = await git.listPullFiles(repo, number);
  const checks = await git.getChecks(repo, pull.headSha);
  const gates = evaluateGates({
    verdict,
    checksState: checks.state,
    files,
    additions: pull.additions,
    deletions: pull.deletions,
  });

  // 结论先落卡 —— 无论后面走哪条分支，人都该在卡上直接看到管理员的判断
  updateCardWithReview({ projectId: run.projectId, repo, number, prState: 'open', conclusion: verdictConclusionText(text, verdict, '') });

  /* 🗑️ 垃圾：不进「待验收」列，实例直接终止（PRD 第六节判定表第一行） */
  if (verdict === 'spam') {
    store.updateWorkflowTask(task.id, {
      status: '已完成',
      decision: '通过',
      note: '管理员结论：垃圾，不合并',
      endedAt: store.nowIso(),
    });
    abortWorkflow(runId, '管理员结论：垃圾 —— 不合并，流程终止');
    return;
  }

  /* ⚠️ 拿不准 / 闸没过 / 没授权：一律停在「待验收」，等人拍板 */
  if (verdict === 'unsure') {
    store.updateWorkflowTask(task.id, {
      status: '待验收',
      note: '管理员拿不准，请你过目（卡上有它的分析）。点「通过」合并，点「驳回」不合并',
      endedAt: null,
    });
    store.touchWorkflowRun(runId);
    return;
  }
  if (!gates.pass) {
    store.updateWorkflowTask(task.id, {
      status: '待验收',
      note: `管理员觉得值得合，但自动合并的闸没过：${gates.reasons.join('；')}。你确认没问题就点「通过」`,
      endedAt: null,
    });
    store.touchWorkflowRun(runId);
    return;
  }
  const repoRow = store.getGitRepoByFullName(repo);
  if (!repoRow?.autoMerge) {
    store.updateWorkflowTask(task.id, {
      status: '待验收',
      note: '审阅通过、四条闸全过。点「通过」就合并；想全自动，去「设置 → 代码托管」给这个仓库勾上「自动合并」',
      endedAt: null,
    });
    store.touchWorkflowRun(runId);
    return;
  }

  // 全过 + 已授权：自动合。人不用在场，但账（任务记录）照样一笔不少
  await doMerge({ runId, task, repo, number, byHuman: false });
}

/** 拿结论段落：管理员全文 + 解析出的档位（写卡用，人先看结论再看分析） */
function verdictConclusionText(text, verdict, suffix) {
  const label = verdict === 'worth' ? '✅ 值得合' : verdict === 'spam' ? '🗑️ 垃圾' : '⚠️ 拿不准';
  const body = clip(text, 1600);
  return `${label}${suffix ? ` —— ${suffix}` : ''}\n${body}`;
}

/** 真正调合并 API 的一段（自动与人点「通过」共用这一条路 —— 授权的差别在**谁放行**，不在执行） */
async function doMerge({ runId, task, repo, number, byHuman }) {
  const out = await git.mergePull(repo, number, { commitTitle: null });
  if (!out.merged) throw new Error(out.message || 'GitHub 没说合上了，也没报错 —— 当没合处理');
  updateCardWithReview({ projectId: store.getWorkflowRun(runId)?.projectId, repo, number, prState: 'merged', conclusion: '' });
  return finishActionTask(runId, task, {
    ok: true,
    result: { state: '已合并', summary: `PR #${number} 已${byHuman ? '（人拍板）' : '（授权自动）'}合并`, artifacts: [`https://github.com/${repo}/pull/${number}`] },
    note: `已合并 PR #${number}${byHuman ? '（人拍板）' : '（授权自动）'}`,
  });
}

/** 人点「通过」= 授权执行。只有「通过」接手；「驳回」让引擎走默认出口（不合并、收尾） */
function onMergeDecide({ runId, task, decision }) {
  if (decision !== '通过') return false;
  const run = store.getWorkflowRun(runId);
  const repo = run?.prRepo;
  const number = Number(run?.prNumber);
  store.updateWorkflowTask(task.id, { status: '进行中', decision: null, note: null, endedAt: null });
  store.touchWorkflowRun(runId);
  doMerge({ runId, task, repo, number, byHuman: true }).catch((e) => {
    store.updateWorkflowTask(task.id, {
      status: '失败',
      note: `合并没成：${String(e?.message ?? e).slice(0, 240)}`,
      endedAt: store.nowIso(),
    });
    store.touchWorkflowRun(runId);
  });
  return true;
}

registerActionNode('pr-merge', { run: runMergeNode, onDecide: onMergeDecide });
