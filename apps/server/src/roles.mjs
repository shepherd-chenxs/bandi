/*
 * roles.mjs —— **岗位与权限**（2026-11-11 定）。**这里是权限的唯一真源**：口径看本文头部，
 * 别再抄进文档 —— 抄一份就会漂（2026-11-24 删掉那份手抄契约的原因）。
 *
 * 一句话口径：**岗位是系统内置对象，权限挂在岗位上；人是"被聘用到某个岗位"。**
 * 代码里凡是"这个人能不能做这件事"，一律 `can(persona, '<权限>')`，
 * **不许再解析 role 文本** —— 以前 `isPmRole(role)` 按「岗位 · 职责」取第一段判，
 * 于是"打四个字就获得建卡权、改个写法就静默失去"（见设计文档第一节）。
 *
 * 本模块是**叶子**：不 import 任何东西 —— 迁移（store/db.mjs 回填旧 role 文本）
 * 也要用它，反向依赖会成环。
 *
 * 加权限 / 加岗位 = 改这里 + 发版。数据库只存 `personas.roleKey`，**不存权限快照**，
 * 所以不会出现"库里的权限和代码对不上"这种漂移。
 */

/** 权限清单：key → 人话。加一条 = 发一次版，界面（只读矩阵）跟着变 */
export const PERMISSIONS = {
  'card.create': '建卡立项（把拆出来的活立成任务卡）',
  'card.split': '拆子卡（团队协作里把主卡拆给群成员）',
  'card.advance': '改自己建的 / 自己当群助手那张团队卡（状态、重跑、改派）',
  'team.coordinate': '当群助手承接团队卡（拆子卡、盯回执、汇总回主卡）',
  /*
   * 交付权（2026-11-19）：把「提交 → 推送 → 开 PR」交给平台一条命令做完。
   * 以前 agent 只能用 shell 一条条拼（9 条命令 = 9 次模型往返 = 6 分钟纯等待，
   * 实报 r-4c85d92c），平台明明有原子动作却没给它通道。权限位就是那道门：
   * 只有该动仓库的岗位拿得到，不是人人可推。
   */
  'repo.deliver': '交付：提交 → 推送 → 开 PR（一条命令，别自己拼 git）',
  // 预留：验收权本期**不下放**，仍是雇主的动作（2026-11-11 用户拍板，见设计文档第三节）
  'task.review': '验收：待验收 → 完成 / 退回（预留，所有岗位默认为空）',
};

/** 项目经理的权限集：建卡 + 拆子卡 + 改自己的卡 + 承接团队卡（2026-10-24 口径不变，只是判据换了） */
const PM_PERMISSIONS = ['card.create', 'card.split', 'card.advance', 'team.coordinate'];

/**
 * 岗位表。`kind`：
 *   · `expert`  —— 专家库里有对应岗位包，可从专家库雇佣；新建员工也可选；
 *   · `builtin` —— 平台保留岗位（系统管家 / 助理），**不进新建员工下拉**，
 *                  只能由平台初始化或专家库雇佣（2026-11-11 用户拍板）。
 *
 * `playbook` = **岗位本命手册**（2026-11-22）：文件在 `roles/packs/<playbook>.md`，
 * 随岗位固定、用户不可见，首轮随派活注入全文（读取见 roles/pack.mjs）。
 *
 * `skills` = **通用技能包**（2026-11-11 Phase 3；2026-11-22 起只装跨岗位通用的方法论）：
 * 雇佣/同步时按它自动挂载，人身上不再各写一份清单。技能名必须存在于技能库（skills/ 下），
 * 挂了不存在的技能会被跳过（缺一个技能不该把雇佣整个弄挂）。空数组是合法的（如 UI、系统管家）。
 */
export const ROLES = [
  { key: 'pm', name: '项目经理', kind: 'expert', permissions: PM_PERMISSIONS,
    playbook: 'pm',
    skills: ['verification-before-completion', 'bandi-report'] },
  { key: 'qa', name: 'QA 工程师', kind: 'expert', permissions: [],
    playbook: 'qa',
    skills: ['verification-before-completion', 'webapp-testing'] },
  { key: 'product', name: '产品经理', kind: 'expert', permissions: [],
    playbook: 'product',
    skills: ['brainstorming', 'doc-coauthoring'] },
  { key: 'architect', name: '架构师', kind: 'expert', permissions: [],
    playbook: 'architect',
    skills: ['brainstorming', 'requesting-code-review'] },
  { key: 'ui', name: 'UI 设计师', kind: 'expert', permissions: [],
    playbook: 'ui',
    skills: [] },
  { key: 'dev', name: '研发工程师', kind: 'expert', permissions: [],
    playbook: 'dev',
    skills: ['bandi-repo', 'test-driven-development', 'systematic-debugging', 'verification-before-completion'] },
  { key: 'test', name: '测试工程师', kind: 'expert', permissions: [],
    playbook: 'test',
    skills: ['bandi-repo', 'webapp-testing', 'systematic-debugging'] },
  { key: 'ops', name: '运维工程师', kind: 'expert', permissions: [],
    playbook: 'ops',
    skills: ['systematic-debugging', 'verification-before-completion'] },
  { key: 'editor', name: '内容主编', kind: 'expert', permissions: [],
    playbook: 'editor',
    skills: ['brainstorming'] },
  { key: 'analyst', name: '数据运营', kind: 'expert', permissions: [],
    playbook: 'analyst',
    skills: ['verification-before-completion'] },
  { key: 'copywriter', name: '文案策划', kind: 'expert', permissions: [],
    playbook: 'copywriter',
    skills: ['doc-coauthoring'] },
  { key: 'director', name: '短视频编导', kind: 'expert', permissions: [],
    playbook: 'director',
    skills: ['brainstorming'] },
  { key: 'repo-keeper', name: '仓库管家', kind: 'expert', permissions: ['repo.deliver'],
    playbook: 'repo-keeper',
    skills: ['bandi-git', 'verification-before-completion'] },
  { key: 'assistant', name: '助理', kind: 'builtin', permissions: [],
    playbook: 'assistant',
    skills: ['bandi-report'] },
  { key: 'steward', name: '系统管家', kind: 'builtin', permissions: [],
    playbook: 'steward',
    skills: [] },
];

const BY_KEY = new Map(ROLES.map((r) => [r.key, r]));

/** 按 key 找岗位；找不到返回 null（调用的地方负责把话说清楚，别硬猜） */
export const roleOf = (key) => BY_KEY.get(String(key ?? '')) ?? null;

/** 这个岗位的**通用技能包**（2026-11-11 Phase 3）：雇佣/同步时自动挂载；未知岗位 → [] */
export const roleSkills = (key) => roleOf(key)?.skills ?? [];

/** 岗位本命手册的 key（没有 playbook 的岗位返回 null） */
export const rolePlaybook = (key) => roleOf(key)?.playbook ?? null;

/** 这个岗位在不在内置清单里（给路由校验用） */
export const isRoleKey = (key) => BY_KEY.has(String(key ?? ''));

/** 展示名：岗位 key → 名称；没设岗位/认不出来 → null（调用方自己决定写「未设岗位」） */
export const roleNameOf = (key) => roleOf(key)?.name ?? null;

/** 权限判定的**唯一入口**：这个人（persona 行）有没有这条权限 */
export function can(persona, permission) {
  const role = roleOf(persona?.roleKey);
  return !!role && role.permissions.includes(permission);
}

/** 这个岗位有没有这条权限（给界面/冒烟按岗位断言用） */
export function roleCan(roleKey, permission) {
  const role = roleOf(roleKey);
  return !!role && role.permissions.includes(permission);
}

/** 下发给界面的只读清单（岗位 + 权限说明 + 岗位技能包） */
export function publicRoles() {
  return ROLES.map(({ key, name, kind, permissions, skills }) => ({ key, name, kind, permissions, skills }));
}

/**
 * **旧 role 文本 → 岗位 key**（迁移期用）。
 *
 * 2026-11-11 之前 `personas.role` 是自由文本，前端按「岗位 · 职责」两段展示
 * （`head(role)` 取第一段）。这里只做一次映射：
 *   · 库存里的 15 个出厂岗位名都能对上；
 *   · 「岗位 · 职责」取 `' · '` 前一段；带别名（研发 / 架构 / 产品…）也认；
 *   · 认不出来 → `null`（= 没有岗位、没有任何权限；界面提示重新选岗）。
 *
 * 映射不上的不猜 —— 猜错比空着更糟（空着只是没权限，猜错是把权限给了不该给的人）。
 * 本函数只服务迁移与过渡期的创建/编辑；Phase 2 前端换成岗位下拉后，这两处也不再用它。
 */
const LEGACY_ROLE_KEYS = {
  '项目经理': 'pm',
  '产品经理': 'product',
  '架构师': 'architect',
  'UI 设计师': 'ui',
  '研发工程师': 'dev',
  '测试工程师': 'test',
  'QA 工程师': 'qa',
  '运维工程师': 'ops',
  '内容主编': 'editor',
  '数据运营': 'analyst',
  '文案策划': 'copywriter',
  '短视频编导': 'director',
  '仓库管家': 'repo-keeper',
  '助理': 'assistant',
  '系统管家': 'steward',
  // 简写别名：存量自由文本里出现过「研发」「架构」这类写法（冒烟里也有）
  '研发': 'dev',
  '测试': 'test',
  '架构': 'architect',
  '产品': 'product',
  '运维': 'ops',
  '设计': 'ui',
  'UI': 'ui',
  'QA': 'qa',
};

export function legacyRoleKey(role) {
  const head = String(role ?? '').split(' · ')[0].trim();
  if (!head) return null;
  return LEGACY_ROLE_KEYS[head] ?? null;
}
