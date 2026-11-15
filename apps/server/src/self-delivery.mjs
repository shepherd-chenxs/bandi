/**
 * **自主交付流程（数字员工自主迭代，无人工拍板）**（2026-11-13）。
 *
 * 口径：「把活派给数字员工，看它干，随时接管」里的「自主」—— 一条流程起完后，
 * 节点按岗位自动指派、跑完自动往下走，全程不让人逐步点「通过」。最后的一步是
 * 项目经理（PM）写汇报，落进信箱给雇主看；雇主再在面板上择时合并 PR / 上线。
 *
 * 为什么没有「部署」节点：交付物是 PR + 报告，不是线上版本；合并/部署保留给人，
 * 契约「部署永远要人下令」不冲突（自主模板不含部署节点，也不绕过那个硬闸）。
 *
 * 节点不点具体人，只点岗位（roleKey）—— 引擎到站时按岗位找一个该岗位的员工办，
 * 忙了退回待办、30 秒节拍重试，跨机器也能复用（不硬编 personaId）。
 *
 * 跨步骤交接靠项目文档落盘（docs/模板/*.md），下游节点读目录拿上游产出：
 *   spec.md（需求） → plan.md（方案/排期） → 代码改动 → PR → 汇报。
 *
 * 节点出口都是二值 approve/reject，没有条件表达式；驳回走连线回前一步，
 * 超过 MAX_VISITS 终止并写信箱。
 */
import * as store from './store.mjs';

const END = 'end'; // 与 workflows.mjs 的 END 同一口径：出口指向流程终点

export const SELF_DELIVERY_TEMPLATE_ID = 'bandi-self-delivery';

/** 审阅/评审节点的提示词（与 pr-review 复用同一语义，只给评审意见） */
const EVAL_DETAIL = [
  '阅读项目目录里上一步产出的文档（docs/模板/plan.md、docs/模板/spec.md），',
  '把设计上的漏洞、风险点、缺失的验收场景逐条列出来。',
  '',
  '产出：在 plan.md 末尾追加「评审意见」章节，每条带【风险/建议/可行】标记；',
  '结论写「已评审」或「需修改」。',
].join('\n');

export const SELF_DELIVERY_TEMPLATE = {
  id: SELF_DELIVERY_TEMPLATE_ID,
  name: '自主交付（自迭代，无人工拍板）',
  builtIn: true,
  start: 'n1',
  autonomous: true,
  nodes: [
    {
      id: 'n1', name: '需求澄清与范围定义', x: 60, y: 60,
      roleKey: 'pm',
      detail: [
        '把这次要做的东西谈清楚：目标、边界、验收标准、不做什么。',
        '产出按 docs/模板/spec.md 的骨架写进 docs/模板/spec.md（放 docs/模板/），',
        '每条验收场景要能执行、能复现。这份 spec 是后面所有步骤的共识基准。',
        '约束：这是「自主交付」模板，不设部署节点，不绕过"部署永远要人下令"；',
        '交付物是 PR + 报告，合并/上线由雇主择时操作。',
      ].join('\n'),
      approve: 'n2', reject: END,
    },
    {
      id: 'n2', name: '方案设计', x: 340, y: 60,
      roleKey: 'architect',
      detail: [
        '读 docs/模板/spec.md，把需求拆成任务、给出排期和版本号。',
        '方案按 docs/模板/plan.md 写进 docs/模板/plan.md；列出改哪些文件、',
        '哪些是设计漏洞可能出现的地方、怎么回滚。',
        '任务拆成看板上的卡（卡描述格式按 docs/模板/task.md），每张卡标覆盖的场景编号。',
      ].join('\n'),
      approve: 'n3', reject: 'n1',
    },
    {
      id: 'n3', name: '设计评审（找设计漏洞）', x: 620, y: 60,
      // L-01：评审与施工不可同岗（原 roleKey 'dev' 与 n4 施工同岗 → 自评自查）。
      // 设计评审改由架构师岗办，与 n4 施工（dev）拉开岗位独立性。
      roleKey: 'architect',
      detail: EVAL_DETAIL,
      approve: 'n4', reject: 'n2',
    },
    {
      id: 'n4', name: '施工实现', x: 900, y: 60,
      roleKey: 'dev',
      detail: [
        '按 plan.md 实现，自测通过后报告：改了哪些文件、怎么验的。',
        '工作区只保留本次改动（.env、私钥等不会被平台代提交，凭据闸会拦下）。',
        '产出：代码改动 + 改动清单（方便下一步「提 PR」把材料收进提交）。',
      ].join('\n'),
      approve: 'n5', reject: 'n3',
    },
    {
      id: 'n5', name: '自测与收敛', x: 620, y: 240,
      roleKey: 'test',
      detail: [
        '按卡的验收标准逐条验证，给出通过/不通过，以及证据（跑了什么、看到什么）。',
        '最后对照 spec.md 做一遍收敛检查：逐条场景与实现比对，',
        '结论写「已收敛」或差异清单，差异必须回填到卡或 spec.md。',
      ].join('\n'),
      approve: 'n6', reject: 'n4',
    },
    {
      id: 'n6', name: '提交 PR', x: 900, y: 240,
      action: 'pr-create',
      detail: [
        '平台动作：把项目目录的改动收成一个提交 → 推一条新分支 → 开 PR → 把材料交给评审。',
        '不会动 base 分支、不会强推；凭据闸会拦下 .env/私钥这类文件（要人显式确认才放行）。',
        '建完后进入下一步「汇报」，PR 链接随产出附在汇报里。',
      ].join('\n'),
      approve: 'n7', reject: 'n4',
    },
    {
      id: 'n7', name: '汇报给雇主', x: 620, y: 420,
      roleKey: 'pm',
      detail: [
        '汇总这次自主交付的全部产出：方案在哪、改了什么、自测结论、PR 链接。',
        '在回话最后一行写交付声明 `[完成]`（平台据此把任务标「待验收」并汇报信箱）。',
        '不要自己合并 PR、不要部署上线、不要花钱 —— 合并/上线由雇主在面板上择时操作。',
      ].join('\n'),
      approve: END, reject: END,
    },
  ],
};

/**
 * 保证模板存在并已发布（幂等）。与 pr-create.mjs 的 ensurePrDeliveryTemplate 同一规矩：
 * 第一次建出来就发布，不然在「工作台 → 流程」里点不开；用户后来手动下架了就不管。
 */
export function ensureSelfDeliveryTemplate() {
  const cur = store.getWorkflowTemplate(SELF_DELIVERY_TEMPLATE_ID);
  if (!cur) {
    store.upsertWorkflowTemplate(SELF_DELIVERY_TEMPLATE);
    store.setTemplatePublished(SELF_DELIVERY_TEMPLATE_ID, true);
    return store.getWorkflowTemplate(SELF_DELIVERY_TEMPLATE_ID);
  }
  if (!cur.builtIn) return cur; // 用户接管了 —— 不动
  // 旧库升级到 v10 时这条模板已存在、新列默认是 0，终态/受阻会漏汇报 —— 补成 1。
  // 内建模板的自主标记由平台维护（新建走 upsert 带 autonomous:true）；用户接管会清 builtIn，
  // 上面已 return，所以这里不会覆盖用户的模板。
  if (!cur.autonomous) {
    store.setTemplateAutonomous(SELF_DELIVERY_TEMPLATE_ID, true);
  }

  /*
   * 已有模板：只补平台后来新增的东西（detail、坐标），用户改过的一律不动。
   * 连线（approve/reject）、点名（roleKey/personaId）、manual 都是用户的选择，永不覆盖。
   */
  let touched = false;
  const byId = new Map(SELF_DELIVERY_TEMPLATE.nodes.map((n) => [n.id, n]));
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
  // L-07：模板版本升级时新增节点补入（只加不改，保留用户已改节点），避免运行时节点悬空。
  const curIds = new Set(nodes.map((n) => n.id));
  const missing = SELF_DELIVERY_TEMPLATE.nodes.filter((ref) => !curIds.has(ref.id));
  if (missing.length) {
    nodes.push(...missing.map((ref) => ({ ...ref })));
    touched = true;
  }
  if (touched) store.upsertWorkflowTemplate({ id: cur.id, name: cur.name, nodes, builtIn: !!cur.builtIn });
  return store.getWorkflowTemplate(SELF_DELIVERY_TEMPLATE_ID);
}
