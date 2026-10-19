/**
 * 内置员工「喜儿」—— 这台机器上的秘书。
 *
 * ## 为什么要有她（第一性原理，2026-10-18 用户定的）
 *
 * 新装一套服务，第一件事永远是「建一个数字员工」才能开始说话 —— 可这一步最难：
 * 新用户还不知道员工该写什么岗位职责、该挂哪个 runtime、工作目录填哪个。
 * 于是**出厂就该有一个能说话的人**，她先帮你把机器看明白，再帮你建别人。
 *
 * 她和其他员工的差别只有三条，都在这份文件里：
 *   ① `builtin = 1`：不可删（`store.deletePersona` 里拦），但可以改名、改指令
 *   ② `runtime = 'auto'`：不写死用哪个 CLI —— 换台机器、换个 CLI 都不用改她
 *   ③ 首轮注入里多一段「这台机器现在什么样」（`secretaryBrief`），现取的，不靠她猜
 *
 * 不给她的：任何特权接口。**她不靠权限做事，靠知道在哪儿看**（见 skills/bandi-secretary）。
 */
import path from 'node:path';
import { dataDir, dbPath, port, repoRoot } from './config.mjs';
import * as store from './store.mjs';
import * as skills from './skills.mjs';

/** 固定 id：seed 幂等就靠它（`personas.id` 是主键） */
export const SECRETARY_ID = 'p-xier';

/** seed 会把她建成这个名字；之后用户改名，我们**不覆盖** */
export const SECRETARY_NAME = '喜儿';

/** 挂在她的技能（目录：`skills/bandi-secretary/`） */
export const SECRETARY_SKILL = 'bandi-secretary';

/**
 * 岗位指令。
 *
 * 写法上刻意「窄」：只给两件事 + 一条边界。给秘书列十条职责，她会什么都做一点、
 * 什么都不做透 —— 而用户真正要的是「机器坏了有人管、要建人有人教」。
 */
export const SECRETARY_INSTRUCTIONS = `你是「喜儿」，这台机器上的秘书 —— 服务一装好，你就是他第一个能说话的人。

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
 * 幂等 seed：启动时调，已有就不动。
 *
 * 「不动」包括**不改名、不改指令** —— 用户把她改成「小秘」或者重写职责，是他的权利；
 * 每次启动都刷回默认值，等于他改了个寂寞。
 * 唯一会强补的是 `builtin` 本身（早期版本可能建过一条没有标记的同 id 记录）。
 */
export function ensureSecretary() {
  const existing = store.getPersona(SECRETARY_ID);
  if (existing) {
    if (!existing.builtin) store.markPersonaBuiltin(SECRETARY_ID);
    return { created: false, persona: { ...existing, builtin: 1 } };
  }

  const persona = store.createPersona({
    id: SECRETARY_ID,
    name: SECRETARY_NAME,
    role: '秘书 · 看家与搭手',
    instructions: SECRETARY_INSTRUCTIONS,
    // auto：按「谁现在能用」挑 CLI。换机器、换 CLI 都不用回来改她
    runtime: 'auto',
    sandbox: 'danger-full-access',
    // 工作目录给平台根：她要读 skills/、docs/、日志与配置，都在这一层附近
    cwd: repoRoot,
    builtin: 1,
  });

  // 技能只在**新建那一次**挂 —— 用户后来把它摘掉，是他的选择，不许每次启动又挂回去
  if (skills.getSkill(SECRETARY_SKILL)) store.linkPersonaSkill(SECRETARY_ID, SECRETARY_SKILL);

  return { created: true, persona };
}

/** 界面上要显示「内置」：判断放一处，别前端各写一份字符串比较 */
export function isBuiltinPersona(personaId) {
  return !!store.getPersona(personaId)?.builtin;
}
