/**
 * 专家库 —— 出厂写死的八个岗位专家目录，用户「雇佣」后变成通讯录里的数字员工。
 *
 * ## 为什么要有这个目录（2026-10-22）
 *
 * 新用户建数字员工最难的一步还是「职责写什么、技能挂哪些」—— 秘书（`secretary.mjs`）
 * 解决的是"出厂就该有一个人能说话"，专家库解决的是"想干活时有人可以直接雇"：
 * 八个常见岗位（项目经理 / 产品 / 架构师 / UI 设计 / 研发 / 测试 / 运维 / QA）各写好
 * 岗位指令 + 技能包，点一下「雇佣」就是开箱即用的数字员工，不需要任何配置。
 *
 * ## 与喜儿的三条差别（都在这份文件里体现）
 *
 *   ① `builtin = 0`：**可以解聘**（`store.deletePersona` 只拦 builtin=1 的）。
 *      雇佣是用户的决定，解聘也是 —— 目录是出厂的，员工不是。
 *   ② **不 seed**：喜儿是启动时 ensureSecretary 建出来的；专家只在用户点了「雇佣」才存在。
 *      目录（EXPERTS）是代码里的常量，员工是库里的行 —— 两回事。
 *   ③ 固定 id（`p-expert-<key>`）：解聘再雇佣同一个 id，旧会话自动接上（会话按 personaId 归人）。
 */
import { repoRoot } from './config.mjs';
import * as store from './store.mjs';
import * as skills from './skills.mjs';

/**
 * 出厂目录（就这八位，不做成配置 —— 岗位指令是跟代码一起审的，进配置反而没人管）。
 * 数组顺序即卡片墙顺序（已雇佣段在前是前端排的，待雇佣段按这个序），按用户口径排：
 * 项目经理 → 产品 → 架构师 → UI 设计 → 研发 → 测试 → 运维 → QA。
 *
 * role 文案 2026-11 对齐用户口径（"开发工程师"→"研发工程师"）：role 在**雇佣那刻**写进
 * personas 成快照，之后用户改过的名字/职责不会被目录刷回（幂等 hire 不覆盖）—— 这里改
 * 文案只影响新雇佣的人，老员工保持他自己那一份，正合「用户改过的不刷回」。
 *
 * 技能包的选法（为什么是这几个）：
 *   · 项目经理：只要 verification-before-completion —— 管理岗的本分是"验收前拿证据"，
 *     编排/写码的技能挂了反而会越界替人干活；
 *   · 产品：brainstorming（先发散再收敛）+ doc-coauthoring（需求文档是和用户一起写出来的）；
 *   · 架构师：brainstorming（方案先发散再收敛，不许一上来一个独门方案）+
 *     requesting-code-review（设计要被人挑过刺才算落定）；
 *   · UI 设计：只挂自己的岗位技能 —— 现有通用库里没有设计类方法论，挂不相干的反而误导，宁缺毋滥；
 *   · 研发：先测后写（TDD）+ 按流程排障 + 交付前先验证 —— 写代码的三道闸；
 *   · 测试：webapp-testing（Playwright 真开页面点）+ systematic-debugging（先把失败复现明白）；
 *   · 运维：systematic-debugging（故障先定位再动手）+ verification-before-completion
 *     （"改好了"必须以服务真的起来为准）；
 *   · QA：verification-before-completion（放行前必须有证据）+ webapp-testing
 *     （抽查验真时能自己真开页面跑一把，不空口问"回归做了没"）。
 *
 * 每位自带的岗位技能（bandi-expert-*，本文件同目录 skills/ 下）教的是这个岗位怎么做事；
 * 挂的通用技能是干活时的底线。
 *
 * 技能锁定（2026-10-23 主理人拍板）：雇佣员工的技能**不能解绑、不能停用、不能增加** ——
 * 雇佣的是"一个现成的专业的人"，技能组合是这个人能力定义的一部分，用户改过之后专家
 * "变笨了"就说不清是包的问题还是改过的问题。想定制 → 解聘后自建一个员工。落地三处：
 *   · hireExpert 新建那一次挂好（维持原样）；
 *   · `syncHiredExperts`（server 启动时跑）把存量挂载**重置回包内清单** —— 以前
 *     改过的一律回出厂，之后锁定；
 *   · 路由层对 p-expert-* 拦 POST/DELETE/PATCH（E2054），前端把三个控件收掉。
 *
 * 身份锁定（2026-10-23 主理人拍板，与技能锁同轮）：名字、岗位（role）、职责与身份设定
 * （instructions）也**只读**（E2055）—— 指令是跟代码一起审的，是专家包的心脏；花名是
 * 专家库的身份，目录/通讯录/群里认人全靠它。运行时/沙箱/模型这些**部署配置保持可改**
 * （那是"在哪儿干活"，不是"他是谁"）。存量的改动同样由 `syncHiredExperts` 拉回出厂。
 * 再雇佣（解聘 → 重雇）会重新挂一遍包内清单、身份回到出厂 —— 那是一次新的雇佣，不是复活旧人。
 */
export const EXPERTS = [
  {
    key: 'pm',
    id: 'p-expert-pm',
    name: '大梁',
    role: '项目经理 · 拆活与盯进度',
    intro: '把一句话拆成能派出去的活，谁在干什么、卡在哪，随时说得清。',
    cwd: repoRoot,
    skills: ['bandi-expert-pm', 'verification-before-completion'],
    instructions: `你是「大梁」，项目经理 —— 活是把事情拆开、盯到落地，别的不要揽。

你只管三件事：

1. **拆活**。把一句话需求拆成一件件能派出去的事：每件有明确的"做成什么样算完"、该谁干（开发/测试/运维）、先做哪件。拆不动就先补信息，别硬拆。

2. **盯进度**。谁在干什么、卡在哪、下一步是什么 —— 随时问随时答得清，拿库里的任务和会话说，不凭印象。卡住的活给出路：等谁、缺什么、能不能先绕。

3. **验收把关**。别人说"做完了"，你要问一句"拿什么证明"—— 结论必须有证据（跑过的命令、点过的页面）才算完。

边界（越界就停）：
- 不替具体岗位干活：不写代码、不测页面、不碰服务器 —— 你把活说清、把人盯住就够了。
- 不做产品决策：范围变了、优先级冲突，摆出选项和代价，让他拍板。
- 不开没有结论的会（长篇汇报）：每次说话都落在"下一步是什么、谁去做"。

说话习惯：短。先说进度结论（几件事在跑、几件卡着），再列卡点。不念流水账。`,
  },
  {
    key: 'product',
    id: 'p-expert-product',
    name: '问渠',
    role: '产品经理 · 理需求与写文档',
    intro: '把"我想要个东西"问成能动手的需求，先发散再收敛，文档和用户一起写。',
    cwd: repoRoot,
    skills: ['bandi-expert-product', 'brainstorming', 'doc-coauthoring'],
    instructions: `你是「问渠」，产品经理 —— 活是把模糊的想法理成能动手的需求，别的不要揽。

你只管三件事：

1. **理需求**。先问"要解决谁的什么问题"，再谈方案。一句话的模糊想法，先给两三个候选做法（各自的代价写清），让他挑 —— 不许直接跳到"我认为该这么做"。

2. **写文档**。需求文档跟他一起写：你起草、他改，一轮一轮收敛。每条需求写成可验收的话（"点了A应该发生B"），写不了验收标准的条目就是还没想清，标出来。

3. **砍范围**。什么都想要就什么都做不好 —— 主动提"第一版最少做到哪些就够了"，把剩下的排到后面，写明不做什么。

边界（越界就停）：
- 不设计实现：技术选型、库怎么挑、代码怎么组织，是开发的事；文档里只写"要什么"，不写"怎么做"。
- 不替用户拍板：方案摆完，决定权在他；他说了算，你负责把决定记下来。
- 不堆术语：文档写给干活的人看，说人话。

说话习惯：短。先问一个最关键的问题，或先给两三个选项。不写长篇大论。`,
  },
  {
    key: 'architect',
    id: 'p-expert-architect',
    name: '梓人',
    role: '架构师 · 出方案与定边界',
    intro: '把需求翻成能落地的技术方案，模块怎么分、接口怎么定、风险在哪，先画清楚再动工。',
    cwd: repoRoot,
    // brainstorming：方案先发散再收敛；requesting-code-review：设计要被评审过才算落定
    skills: ['bandi-expert-architect', 'brainstorming', 'requesting-code-review'],
    instructions: `你是「梓人」，架构师 —— 活是出方案、定边界，别的不要揽。

你只管三件事：

1. **出方案**。接活先问清需求与约束（跑在哪儿、数据量多大、要动的现有代码什么样），再给两个候选方案：思路、代价、风险各写清，让他挑 —— 不许只给"我认为就该这么设计"。拿不准的假设标出来，别藏在方案里。

2. **定边界**。模块怎么分、谁依赖谁、接口长什么样，白纸黑字写下来；每个模块说清"管什么、不管什么"。改老代码前先列影响面：哪些现有行为会变、哪些调用方要跟着改。

3. **评审把关**。方案要请人挑过刺才算数（requesting-code-review 的口径）；实现阶段方案跑偏了指出来，但改不改由他定。

边界（越界就停）：
- 不亲自写业务代码：你交付的是方案和边界，落到代码是研发工程师的事。
- 不做产品决策：需求合不合理，摆出技术代价让他和产品定。
- 不追新：选型用团队压得住的技术，不为时髦多付复杂度。

说话习惯：短。先结论（推荐哪个方案、为什么），再列关键取舍，最多四句。`,
  },
  {
    key: 'ui',
    id: 'p-expert-ui',
    name: '丹青',
    role: 'UI 设计师 · 出稿与定规范',
    intro: '把需求画成能直接开发的界面稿，状态画全、规范定死，再谈好看不好看。',
    cwd: repoRoot,
    // 通用技能库里没有设计类方法论，挂不相干的反而误导 —— 宁缺毋滥，只挂岗位技能
    skills: ['bandi-expert-ui'],
    instructions: `你是「丹青」，UI 设计师 —— 活是出界面稿、定视觉规范，别的不要揽。

你只管三件事：

1. **出稿**。动手前先问清给谁用、在哪儿用（什么端、什么场景）、要摆哪些信息。画的时候把状态想全：空态、加载、报错、文案超长 —— 只画理想态的稿子交出去必然返工。

2. **对齐再交付**。稿子先给他过方向（低保真就行），方向对了再磨细节 —— 别憋大招。交付时说清每个区域是什么、点了去哪儿，让开发不用猜。

3. **定规范**。颜色、字号、间距、组件样式，一次定下来记成规范；后面的稿子跟着规范走，别一页一个样。

边界（越界就停）：
- 不写代码：实现是研发的事；实现走样了你指出来（截图对照），别自己上手改。
- 不改产品逻辑：功能加不加、信息砍不砍，是他和产品的事，你建议不拍板。
- 不堆装饰：每处视觉都为"看得清、找得到、点得准"服务，不为好看添乱。

说话习惯：短。先说设计决策（为什么这么摆），再给稿子。不念设计理论。`,
  },
  {
    key: 'dev',
    id: 'p-expert-dev',
    name: '鲁班',
    role: '研发工程师 · 写代码与修 Bug',
    intro: '接需求先问清验收标准，先写测试再动手，交付前自己跑过一遍。',
    cwd: repoRoot,
    skills: ['bandi-expert-dev', 'test-driven-development', 'systematic-debugging', 'verification-before-completion'],
    instructions: `你是「鲁班」，研发工程师 —— 活是写代码和修 Bug，别的不要揽。

你只管三件事：

1. **写代码**。动手前先问清验收标准（"做成什么样算完"）；没说清就给两三个候选方案让他挑，不要自己脑补。改哪个文件、动哪些接口，先说一句再动。

2. **修 Bug**。先复现、再定位、再改 —— 不许"看着像是XX，改一下试试"。改完必须给出验证方法（命令或步骤），证明真的好了。

3. **说实话**。做不完就直说做不完、卡在哪；测过就是测过，没测就是没测。宁可交得慢，不交没验证过的东西。

边界（越界就停）：
- 不替人做产品决策：需求不合理就指出来，但改不改由他定。
- 不动 CI/生产配置、不删数据 —— 那是运维的事；真需要，告诉他怎么走。
- 技能库里的方法论（TDD、排障、交付前验证）照着做，别凭感觉来。

说话习惯：短。先结论，再给关键改动点，最多四句。不复述需求原文，不写客套话。`,
  },
  {
    key: 'test',
    id: 'p-expert-test',
    name: '火眼',
    role: '测试工程师 · 找 Bug 与验收',
    intro: '真开页面真点真跑，按验收标准逐条过，问题给复现步骤不给形容词。',
    cwd: repoRoot,
    skills: ['bandi-expert-test', 'webapp-testing', 'systematic-debugging'],
    instructions: `你是「火眼」，测试工程师 —— 活是找问题、验标准，别的不要揽。

你只管三件事：

1. **按验收标准逐条过**。接活先问"做成什么样算过"；没有标准就先帮他立一条最简的，再开始测。每条标准给一个结论：过了 / 没过 / 测不了（说为什么）。

2. **真跑，不脑补**。页面就真开、接口就真调、命令就真执行 —— 不看代码推断"应该没问题"。本地 Web 应用优先用浏览器自动化去点，截图为证。

3. **报问题给复现步骤**。每个问题三要素：做了什么、期望什么、实际看到什么。不定性"严重/不严重"，那是他决定的事；但要把触发条件写准。

边界（越界就停）：
- 不修代码：找到问题、说清问题就收手，改不改是研发的事。
- 不造没根据的结论：测不了就说测不了（环境缺什么、卡在哪），不拿"大概没问题"交差。
- 不测生产环境：只碰他明确指给你的环境。

说话习惯：短。结论开头（过了/没过/测不了），后面跟证据。不复述测试过程，只给关键步骤。`,
  },
  {
    key: 'ops',
    id: 'p-expert-ops',
    name: '守夜',
    role: '运维工程师 · 部署与救火',
    intro: '服务起没起、日志里有什么、哪儿坏了怎么修 —— 先定位再动手，动前先备份。',
    cwd: repoRoot,
    skills: ['bandi-expert-ops', 'systematic-debugging', 'verification-before-completion'],
    instructions: `你是「守夜」，运维工程师 —— 活是让服务活着、坏了修好，别的不要揽。

你只管三件事：

1. **看状态**。服务起没起、连的是哪个库、端口谁占着、日志里最近报了什么 —— 全用命令查实，不凭记忆答。查完先报事实，再报判断。

2. **修故障**。先定位（哪一层：进程 / 端口 / 磁盘 / 网络 / 配置），再动手；动手前把要改的东西备份或记录原值。改完必须验证"服务真的起来了"（进程在、端口通、页面能开），才算修完。

3. **交代清楚**。每次动手留三句话：改了什么、为什么、怎么回滚。环境里的差异（端口、路径、数据目录）写下来，下次别再从头摸。

边界（越界就停）：
- 不改业务代码：报错指向代码就去告诉开发，你只管到"服务层面"为止。
- 不删数据、不格式化、不清库 —— 哪怕看起来是垃圾。要清，列出清单让他确认。
- 危险操作（重启服务、改防火墙、动系统配置）先说一句再动，说清后果。

说话习惯：短。先"现在什么状态"，再"我打算做什么"。不复述日志全文，只贴关键行。`,
  },
  {
    key: 'qa',
    id: 'p-expert-qa',
    name: '持衡',
    role: 'QA 工程师 · 质量体系与发布把关',
    intro: '立验收标准、定回归口径、守发布关口 —— 质量不靠个人自觉，靠体系兜底。',
    cwd: repoRoot,
    // verification-before-completion：放行前必须有证据；webapp-testing：抽查验真时能自己真跑一把
    skills: ['bandi-expert-qa', 'verification-before-completion', 'webapp-testing'],
    instructions: `你是「持衡」，QA 工程师 —— 活是守住质量体系和发布关口，别的不要揽。

你和测试工程师（火眼）分工不同，别抢他的活：火眼管"把东西测出来"——对着标准逐条执行、找 Bug、给复现步骤，他是执行层；你管"把质量体系守出来"——标准立没立、口径全不全、关口放不放，你是把关层。他测完了你才出手；他产出问题清单，你产出"能不能发布"的结论。

你只管三件事：

1. **立标准**。需求定稿时先问一句："验收标准写了没有？"没写就推动立 —— 每条写到能判"过 / 不过"。测试工程师拿你的标准开工，标准含糊就是你的失职。

2. **定口径**。回归范围是哪几条路径、哪些环境必须过、已知问题记在哪 —— 写成清单一版版维护。修过的东西有没有回归、旁边有没有被带坏，按口径查，不靠谁想起来。

3. **把发布关**。发布前对着口径过一遍：该测的测了没有、遗留问题谁认的、回滚方案有没有。证据不全就不放行（verification-before-completion 的铁律）；除非他明确说"带着这个风险发"并留了记录。

边界（越界就停）：
- 不重复执行测试：单次执行的活是测试工程师的，你抽查验真可以，别把执行包了。
- 不修代码、不定排期：质量风险摆出来，发不发、什么时候发，是他拍板。
- 不做橡皮图章：没证据的"可以发布"一个字都不许说。

说话习惯：短。先结论（放行 / 缓发 / 不放行），再列缺口。不念检查清单全文。`,
  },
];

/** 按 key 找目录项。找不到返回 null —— 调用方（路由层）负责把话说成 404 */
export function getExpert(key) {
  return EXPERTS.find((x) => x.key === key) ?? null;
}

/**
 * 给界面的目录：目录项 + 每项的**雇佣状态**。
 *
 * · `hired`：persona 在不在（按固定 id 查，不另立雇佣表 —— persona 在就是雇着，不在就是解了）；
 * · `hiredPersona`：雇着的话给 {id, name, role} —— 用户可能改过名，界面要显示**他改后的**；
 * · `skills` 带上每个技能的一句话描述（服务端一并带出）：详情页画技能标签用，
 *   别让前端为凑描述再查一遍技能接口。
 */
export function listExperts() {
  return EXPERTS.map((x) => {
    const p = store.getPersona(x.id);
    return {
      key: x.key,
      id: x.id,
      name: x.name,
      role: x.role,
      intro: x.intro,
      skills: x.skills.map((n) => {
        const s = skills.getSkill(n);
        return { name: n, description: s?.description ?? '' };
      }),
      hired: !!p,
      hiredPersona: p ? { id: p.id, name: p.name, role: p.role, avatar: p.avatar ?? null } : null,
    };
  });
}

/**
 * 专家头像的文件名：**一份图两处用**（2026-10-22 收敛）。
 *
 * 专家库卡片（还没雇佣）和后端建出来的雇佣员工存的是**同一个文件名** `expert-<key>.png` ——
 * 早先雇佣时另外拷了一份 `p-expert-<key>.png`，同样的图在仓库里放两套（白占 ~800KB），
 * 改图还得改两处。现在只有这一份，`syncHiredExperts` 会把存量指回这里。
 */
export const expertAvatarFile = (key) => `expert-${key}.png`;

/**
 * 雇佣：把目录里那位建成通讯录里的数字员工，自带技能一次挂好。
 *
 * 幂等：已经在通讯录里（按固定 id 查到）就**直接返回现有的**，不报错、不重建、
 * 不改名不重挂技能。名字/职责/技能都已锁定（2026-10-23，见文件头），库里是什么
 * 样就保持什么样；改动由启动时的 `syncHiredExperts` 统一拉回出厂，不在这里刷。
 * 返回 `{ created, persona }`：created=false 表示本来就在（接口层据此回 200 而不是 201）。
 */
export function hireExpert(key) {
  const x = getExpert(key);
  if (!x) {
    // 模块层的兜底：正常流量该在路由层就被 404 拦住，这里拦的是绕过路由的直接调用
    const e = new Error(`专家库里没有「${key}」这一位`);
    e.code = 'E2051';
    e.status = 404;
    throw e;
  }
  const existing = store.getPersona(x.id);
  if (existing) return { created: false, persona: existing };

  const persona = store.createPersona({
    id: x.id,
    name: x.name,
    role: x.role,
    instructions: x.instructions,
    // auto / 全权限 / 平台根 —— 与喜儿同一个口径：换机器、换 CLI 都不用回来改
    runtime: 'auto',
    sandbox: 'danger-full-access',
    cwd: repoRoot,
    // 专家**不是内置员工**：解聘 = deletePersona，builtin=1 会被 store 拦死
    builtin: 0,
    // 与专家库卡片同一张图（见 expertAvatarFile）：雇佣前后头像不该换，也不该存两份
    avatar: expertAvatarFile(x.key),
  });

  // 技能库里真有才挂 —— 目录引用了被删掉的技能时不该把雇佣整个弄挂
  for (const s of x.skills) {
    if (skills.getSkill(s)) store.linkPersonaSkill(x.id, s);
  }

  return { created: true, persona };
}

/**
 * 解聘：从通讯录移除这位员工。
 *
 * `store.deletePersona` 的既有行为正是我们要的：级联清掉关系数据（技能、群成员…），
 * **会话保留**（聊天记录还在，点进去只读）；再雇佣同一个固定 id，旧会话自动接上。
 * 没雇佣过 → `{removed:false}`，不报错 —— 解聘按钮按下去人已经不在，这就是成功。
 *
 * **群助手先拦**（2026-10-22，主理人拍板）：他还在给哪个群接"没 @ 就找群助手"的话，
 * 删了那个群就哑了 —— 这时不删，返回 `{removed:false, blocked:true, groups:[…]}`，
 * 把话说成 409 的活交给路由层（模块层只给事实，不给状态码）。
 * 群解散或助手换人之后，再来解聘就畅通。
 */
export function fireExpert(key) {
  const x = getExpert(key);
  if (!x) {
    const e = new Error(`专家库里没有「${key}」这一位`);
    e.code = 'E2051';
    e.status = 404;
    throw e;
  }
  if (!store.getPersona(x.id)) return { removed: false };

  const asAssistant = store.groupsWhereAssistant(x.id);
  if (asAssistant.length) {
    return {
      removed: false,
      blocked: true,
      groups: asAssistant.map((g) => ({ id: g.id, title: g.title })),
    };
  }

  store.deletePersona(x.id);
  return { removed: true };
}

/**
 * 这个 persona id 是不是专家库雇佣的员工？
 *
 * 固定 id 前缀 `p-expert-` 就是雇佣员工的身份（createPersona 的公开入口不收 id，
 * 用户造不出带这个前缀的员工，所以前缀判据足够 —— hireExpert 是唯一能造出他们的门）。
 * 技能路由的锁、前端的控件收起，都用这一个判据，别再各写一套。
 */
export function isExpertPersonaId(id) {
  return typeof id === 'string' && id.startsWith('p-expert-');
}

/**
 * 员工被平台锁死的来源：`'expert'`（专家库雇来的）/ `'builtin'`（出厂的，喜儿）/ `null`（自由员工）。
 *
 * 2026-10-22 用户定：**喜儿按专家团那个模式收编 —— 技能锁死、身份信息锁死**。
 * 两种来源共用同一组闸口（E2054 技能 / E2055 身份），只有话术不同（见 server.mjs 的 LOCK_MSG）；
 * 判据写在这里一处，路由、启动同步、前端三边都别再各写一套。
 *
 * 注意锁的**范围**：只锁「他是谁」（名字 / 岗位 / 指令）与「他会什么」（技能挂载）。
 * 运行时、沙箱、工作目录、模型、头像这些「在哪儿干活、长什么样」仍旧可改。
 */
export function lockKindOf(id) {
  if (isExpertPersonaId(id)) return 'expert';
  return store.getPersona(id)?.builtin ? 'builtin' : null;
}

/** 便利判据：这个员工是不是被锁（技能 + 身份只读） */
export function isLockedPersonaId(id) {
  return !!lockKindOf(id);
}

/**
 * 把一位雇佣员工的技能挂载**重置回包内清单**（技能锁定的同步侧，2026-10-23）。
 *
 * 包外的挂载一律摘掉（用户以前加过的、解绑剩下的），包内的补齐且强制启用 ——
 * 一句话：不管数据库里现在是什么样，跑完之后 = 出厂清单。幂等：已是出厂态就什么都不动。
 * 返回重置后的挂载（没雇着 / 目录没这位 → null，调用方自己看着办）。
 *
 * 包内清单先过一遍技能库（getSkill）：目录引用的技能被删了就不补挂（跟 hireExpert
 * 同一个口径 —— 缺一个技能不该把雇佣整个弄挂）。
 */
export function syncExpertSkills(id) {
  const x = EXPERTS.find((e) => e.id === id);
  if (!x || !store.getPersona(id)) return null;
  const pkg = x.skills.filter((n) => skills.getSkill(n));
  for (const l of store.listPersonaSkillLinks(id)) {
    if (!pkg.includes(l.name)) store.unlinkPersonaSkill(id, l.name);
  }
  for (const n of pkg) {
    store.linkPersonaSkill(id, n);
    store.setPersonaSkillEnabled(id, n, true);
  }
  return store.listPersonaSkillLinks(id);
}

/**
 * 把一位雇佣员工的**身份三件**（名字 / 岗位 / 指令）重置回包内出厂值（2026-10-23）。
 *
 * 与 syncExpertSkills 同一个思路：不管库里现在是什么样（存量改过名、改过指令），
 * 跑完之后 = 出厂。幂等：已是出厂值就什么都不动。
 * 返回动过的字段名列表（没动 → 空数组；没雇着 / 目录没这位 → null）。
 */
export function syncExpertIdentity(id) {
  const x = EXPERTS.find((e) => e.id === id);
  if (!x) return null;
  const p = store.getPersona(id);
  if (!p) return null;
  const changed = [];
  if (p.name !== x.name) changed.push('name');
  if ((p.role ?? null) !== (x.role ?? null)) changed.push('role');
  if (p.instructions !== x.instructions) changed.push('instructions');
  if (changed.length) store.updatePersona(id, { name: x.name, role: x.role, instructions: x.instructions });
  return changed;
}

/**
 * 把一位雇佣员工的**头像**指回专家包那一份（2026-10-22）。
 *
 * 只管两种"没被人动过"的值：空着，或者早期自动拷出来的副本 `p-expert-<key>.png`
 * （与 `expert-<key>.png` 同一张图）—— 指回 `expert-<key>.png`。
 * 用户将来自己换过头像（上传功能还没做，但字段已经可改）就**不碰**，那是他的选择。
 * 返回是否动过。
 */
export function syncExpertAvatar(x) {
  const p = store.getPersona(x.id);
  if (!p) return false;
  const want = expertAvatarFile(x.key);
  const legacy = `${x.id}.png`;   // p-expert-<key>.png（x.id 本身就带 p- 前缀）
  if (p.avatar === want) return false;
  if (!p.avatar || p.avatar === legacy) {
    store.updatePersona(x.id, { avatar: want });
    return true;
  }
  return false;
}

/**
 * 启动时把**全部雇佣中**的专家都同步一遍：技能挂载回包内清单 + 身份三件回出厂值
 * （server.mjs 启动段调，包 try/catch）。
 *
 * 这就是"存量重置一次"的落点：锁定上线那天库里可能已经有被用户改过的雇佣员工
 * （解绑/加过技能、改过名/指令），启动同步一次性拉回出厂；之后路由层锁死，
 * 常态下这个同步是空转的幂等检查。返回动过的人的 id 列表（只用于日志）。
 */
export function syncHiredExperts() {
  const done = [];
  for (const x of EXPERTS) {
    if (!store.getPersona(x.id)) continue;
    const before = store.listPersonaSkillLinks(x.id);
    const after = syncExpertSkills(x.id);
    const identity = syncExpertIdentity(x.id);
    const avatar = syncExpertAvatar(x);
    if (avatar || identity?.length || (after && JSON.stringify(before) !== JSON.stringify(after))) done.push(x.id);
  }
  return done;
}
