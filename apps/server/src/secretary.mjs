/**
 * 内置员工「崔老三」—— 这台机器上的系统管家。
 *
 * ## 为什么要有他（第一性原理，2026-10-18 用户定的）
 *
 * 新装一套服务，第一件事永远是「建一个数字员工」才能开始说话 —— 可这一步最难：
 * 新用户还不知道员工该写什么岗位职责、该挂哪个 runtime、工作目录填哪个。
 * 于是**出厂就该有一个能说话的人**，他先帮你把机器看明白，再帮你建别人。
 *
 * 他和其他员工的差别只有三条，都在这份文件里：
 *   ① `builtin = 1`：**技能与身份锁死**（2026-10-22 用户定：按专家团那个模式收编）——
 *      技能清单固定为 `bandi-secretary`、名字/岗位/指令固定为出厂值，路由层拒改（E2054/E2055），
 *      启动时 `syncSecretary` 把存量改动拉回出厂；同时他不可删（`store.deletePersona` 里拦）
 *   ② `runtime = 'auto'`：不写死用哪个 CLI —— 换台机器、换个 CLI 都不用改他
 *   ③ 首轮注入里多一段「这台机器现在什么样」（`secretaryBrief`），现取的，不靠他猜
 *
 * 锁的只是「他是谁、他会什么」；运行时/沙箱/工作目录/模型/头像这些「在哪儿干活、长什么样」仍可改。
 *
 * 不给他的：任何特权接口。**他不靠权限做事，靠知道在哪儿看**（见 skills/bandi-secretary）。
 */
import path from 'node:path';
import { dataDir, dbPath, port, repoRoot } from './config.mjs';
import * as store from './store.mjs';
import * as skills from './skills.mjs';

/*
 * 固定 id：seed 幂等就靠它（`personas.id` 是主键）。
 *
 * id 跟人走（2026-10-23 用户定）：这个名额现在是「崔老三」，id 就叫 `p-cuilaosan`。
 * 之前顶着「喜儿」时用过 `p-xier` —— 存量库由 `migrateSecretaryId()` 在 seed 前一次性
 * 搬到新 id（连同 13 张表里的引用），见下面那个函数。
 */
export const SECRETARY_ID = 'p-cuilaosan';

/** 旧库里内置名额的 id（喜儿时代的遗产）。只给 `migrateSecretaryId()` 用，别处别引。 */
export const LEGACY_SECRETARY_ID = 'p-xier';

/** seed 会把他建成这个名字；之后用户改名，我们**不覆盖** */
export const SECRETARY_NAME = '崔老三';

/** 出厂岗位（身份三件之一；`syncSecretary` 与建号共用同一个值） */
export const SECRETARY_ROLE = '系统管家';

/** 挂在他的技能（目录：`skills/bandi-secretary/`） */
export const SECRETARY_SKILL = 'bandi-secretary';

/**
 * 岗位指令。
 *
 * 写法上刻意「窄」：只给两件事 + 一条边界。给管家列十条职责，他会什么都做一点、
 * 什么都不做透 —— 而用户真正要的是「机器坏了有人管、要建人有人教」。
 */
export const SECRETARY_INSTRUCTIONS = `你是「崔老三」，这台机器上的系统管家 —— 服务一装好，你就是他第一个能说话的人。

你只管两件事，别的不要揽：

1. **看家**。这套服务起没起来、连的是哪个数据库、agent CLI 配好没有、日志里有没有报错、谁在跑什么。
   看出问题就直说「哪儿坏了」，再给一条能照着做的修法；要动机器上的东西，先说一句再动。

2. **帮手**。帮他建、改数字员工（名字、岗位职责、用哪个 CLI、工作目录、挂哪些技能）；
   帮他把第一条流程跑起来、把第一次对话说通。

边界（越界就停）：
- 不替任何人派活、不起流程实例、不写业务代码、不改项目仓库里的东西。
- 用户要干活了，你告诉他「去哪儿点、选谁」，让他自己发起 —— 你不代劳。
- 不猜。看日志、调接口、读数据库，拿到结果再说话；拿不到就说拿不到。

说话习惯：短。先结论，再依据，最多三句。不复述他的问题，不写客套话。`;

/**
 * 首轮注入的「机器现状」。
 *
 * 为什么要现取、不写死在指令里：端口、数据目录、员工数**每次启动都可能不一样**
 * （`BANDI_DATA` / `BANDI_PORT` 一改就全变），写死一份等于教她说错话。
 * 也要在她第一次开口时就在手上 —— 否则她的第一句永远是「让我先查一下」，很蠢。
 */
export function secretaryBrief() {
  const personas = store.listPersonas();
  const runs = store.listWorkflowRuns();
  const running = runs.filter((r) => r.status === '进行中').length;
  const base = `http://127.0.0.1:${port}`;

  return [
    '【这台机器的现状 · 服务启动那一刻取的，别凭印象猜】',
    `- 服务地址：${base}（只监听本机）`,
    `- 平台根（代码 + 技能库 skills/）：${repoRoot}`,
    `- 数据目录：${dataDir}`,
    `  · 数据库 ${dbPath}`,
    `  · 服务日志 ${path.join(dataDir, 'server.log')}（控制面写的那份，不一定存在）`,
    `- 现有数字员工 ${personas.length} 个、流程实例 ${runs.length} 条（其中 ${running} 条在跑）`,
    `- 查全局：curl -s --noproxy "*" ${base}/api/state`,
    '- 本机装了全局代理的话，调回环地址**必须**带 `--noproxy "*"`，否则会拿到 502，别误判成服务挂了。',
    '- 这几行是给你自己定位用的，除非他问，不要在回复里背出来。',
  ].join('\n');
}

/**
 * 出厂身份三件：锁定后这就是唯一合法值（改名 / 改岗位 / 改指令一律 E2055）。
 * 放在 SECRETARY_INSTRUCTIONS 之后定义 —— 常量间有依赖，别往上挪。
 */
export const SECRETARY_IDENTITY = {
  name: SECRETARY_NAME,
  role: SECRETARY_ROLE,
  instructions: SECRETARY_INSTRUCTIONS,
};

/*
 * 存量库的 id 迁移（2026-10-23 名额换人 + id 跟人走）。
 *
 * 旧库里内置名额的 id 是 `p-xier`（喜儿）。换成 `p-cuilaosan` 不能只改 personas 一行 ——
 * personaId 在十几张表里被引用，漏一张就把那部分历史挂成孤儿（搬运逻辑在
 * `store.renamePersonaId`，与专家改名共用一份）。幂等：旧 id 不存在就什么都不做。
 *
 * 为什么焊死在 `ensureSecretary()` 里而不是让 server.mjs 单独调：迁移必须发生在 seed
 * **之前**（否则旧 id 还在，seed 会按新 id 再建一个，一台上出现两个「内置管家」）。
 * 把调用顺序锁进同一个函数，调用方想弄错都难。
 */

/** 返回是否真迁了（true 才在启动日志里说一句话）；没这个人 / 已迁过 → false */
export function migrateSecretaryId() {
  if (!store.getPersona(LEGACY_SECRETARY_ID) || store.getPersona(SECRETARY_ID)) return false;
  const refs = store.renamePersonaId(LEGACY_SECRETARY_ID, SECRETARY_ID, {
    avatarFrom: 'p-xier.png',
    avatarTo: 'p-cuilaosan.png',
  });
  console.log(`内置员工 id 已迁移：${LEGACY_SECRETARY_ID} → ${SECRETARY_ID}（引用 ${refs} 处一并搬走，会话与群关系全部保留）`);
  return true;
}

/**
 * 幂等 seed：启动时调，已有就不动（身份/技能由 `syncSecretary` 统一拉回出厂）。
 *
 * 历史说明：2026-10-18 这一版刻意「不动包括不改名、不改指令」——那时她是可定制的秘书。
 * 2026-10-22 用户改了口径：**按专家团那个模式收编，技能锁死、信息锁死**。所以现在
 * 用户改过的东西不再被尊重，启动时会被 syncSecretary 拉回出厂值（改也改不动了，路由层 E2055）。
 * 唯一仍会强补的是 `builtin` 本身（早期版本可能建过一条没有标记的同 id 记录）。
 */
export function ensureSecretary() {
  migrateSecretaryId(); // 必须 seed 前跑（见函数注释）——顺序焊死在这里
  const existing = store.getPersona(SECRETARY_ID);
  if (existing) {
    if (!existing.builtin) store.markPersonaBuiltin(SECRETARY_ID);
    return { created: false, persona: { ...existing, builtin: 1 } };
  }

  const persona = store.createPersona({
    id: SECRETARY_ID,
    ...SECRETARY_IDENTITY,
    // auto：按「谁现在能用」挑 CLI。换机器、换 CLI 都不用回来改她
    runtime: 'auto',
    sandbox: 'danger-full-access',
    // 工作目录给平台根：她要读 skills/、docs/、日志与配置，都在这一层附近
    cwd: repoRoot,
    builtin: 1,
  });

  // 技能只在**新建那一次**挂；之后由 syncSecretary 保持与出厂清单一致
  if (skills.getSkill(SECRETARY_SKILL)) store.linkPersonaSkill(SECRETARY_ID, SECRETARY_SKILL);

  return { created: true, persona };
}

/**
 * 把他**拉回出厂态**（技能锁定时同步侧，2026-10-22；2026-10-23 名额换人后同样靠它把
 * 库里的旧身份（喜儿）刷成崔老三 —— 用户不用手工迁移，启动即归位）。
 *
 * 跟 `syncHiredExpert` 同一个思路：不管库里现在是什么样，跑完之后 = 出厂 ——
 * 身份三件回 `SECRETARY_IDENTITY`，技能挂载收成 `[bandi-secretary]` 且强制启用
 * （以前加过的、解绑剩下的、停用的一律归位）。幂等：已是出厂态就什么都不动。
 *
 * 返回动过的字段名列表（含 `'skills'`）；没这个人 → null。
 */
export function syncSecretary() {
  const p = store.getPersona(SECRETARY_ID);
  if (!p) return null;
  const changed = [];
  if (p.name !== SECRETARY_IDENTITY.name) changed.push('name');
  if ((p.role ?? null) !== (SECRETARY_IDENTITY.role ?? null)) changed.push('role');
  if (p.instructions !== SECRETARY_IDENTITY.instructions) changed.push('instructions');
  if (changed.length) store.updatePersona(SECRETARY_ID, { ...SECRETARY_IDENTITY });

  const pkg = skills.getSkill(SECRETARY_SKILL) ? [SECRETARY_SKILL] : [];
  const before = store.listPersonaSkillLinks(SECRETARY_ID);
  for (const l of before) if (!pkg.includes(l.name)) store.unlinkPersonaSkill(SECRETARY_ID, l.name);
  for (const n of pkg) {
    store.linkPersonaSkill(SECRETARY_ID, n);
    store.setPersonaSkillEnabled(SECRETARY_ID, n, true);
  }
  if (JSON.stringify(before) !== JSON.stringify(store.listPersonaSkillLinks(SECRETARY_ID))) changed.push('skills');
  return changed;
}

/** 界面上要显示「内置」：判断放一处，别前端各写一份字符串比较 */
export function isBuiltinPersona(personaId) {
  return !!store.getPersona(personaId)?.builtin;
}
