/**
 * 专家库 —— 出厂写死的岗位专家目录（秘书 + 技术轨八位 + 内容轨五位），用户「雇佣」后变成通讯录里的数字员工。
 *
 * ## 为什么要有这个目录（2026-10-22，2026-10-23 扩编）
 *
 * 新用户建数字员工最难的一步还是「职责写什么、技能挂哪些」—— 系统管家（`steward.mjs`）
 * 解决的是"出厂就该有一个人能说话"，专家库解决的是"想干活时有人可以直接雇"：
 * 秘书（原内置秘书喜儿，2026-10-23 用户拍板转入驻）+ 技术轨八个岗位（项目经理 / 产品 /
 * 架构师 / UI 设计 / 研发 / 测试 / 运维 / QA）+ 内容轨五个岗位（仓库管家 / 内容主编 /
 * 文案策划 / 数据运营 / 短视频编导，覆盖「守仓库 + 管—写—拍—复盘」内容链）
 * 各写好岗位指令 + 技能包，点一下「雇佣」就是开箱即用的数字员工，不需要任何配置。
 *
 * ## 与系统管家（builtin）的三条差别（都在这份文件里体现）
 *
 *   ① `builtin = 0`：**可以解聘**（`store.deletePersona` 只拦 builtin=1 的）。
 *      雇佣是用户的决定，解聘也是 —— 目录是出厂的，员工不是。
 *   ② **不 seed**：系统管家是启动时 ensureSteward 建出来的；专家只在用户点了「雇佣」才存在。
 *      目录（EXPERTS）是代码里的常量，员工是库里的行 —— 两回事。
 *   ③ 固定 id（`p-expert-<key>`）：解聘再雇佣同一个 id，旧会话自动接上（会话按 personaId 归人）。
 */
import { repoRoot } from './config.mjs';
import * as store from './store.mjs';
import * as skills from './skills.mjs';

/**
 * 出厂目录（就这十四位，不做成配置 —— 岗位指令是跟代码一起审的，进配置反而没人管）。
 * 数组顺序即卡片墙顺序（已雇佣段在前是前端排的，待雇佣段按这个序），按用户口径排：
 * 项目经理 → 产品 → 架构师 → UI 设计 → 研发 → 测试 → 运维 → QA，秘书（喜儿）排
 * 杜衡后面（2026-10-25 用户拍板挪位），内容轨五位收尾。
 *
 * role 文案 2026-11 对齐用户口径（"开发工程师"→"研发工程师"）：role 在**雇佣那刻**写进
 * personas 成快照，之后用户改过的名字/职责不会被目录刷回（幂等 hire 不覆盖）—— 这里改
 * 文案只影响新雇佣的人，老员工保持他自己那一份，正合「用户改过的不刷回」。
 *
 * 技能包的选法（为什么是这几个）：
 *   · 项目经理：只挂自己的岗位技能 —— 他的本分是**调度**（拆活、转交、收结论、汇报），
 *     验收转给 QA（2026-10-24 用户定："项目经理的主要任务是调度，不是他自己干"），
 *     verification-before-completion 挂了他反而会自己去翻产出验证，越界还费思考；
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
 *
 * 措辞治理（2026-11-09「数据管理 54.2M」事故复盘）：出厂指令全部去掉"别的不要揽 /
 * 你只管三件事 / 越界就停"这类**能力封条**写法，改成专长表述（专长是顺序不是边界）。
 * 起因：用户把测量问题派给嘉辉，他 22 次工具调用全是 cat 源码、零次量数据——
 * "别的不要揽"让他把职责外的问题归类成"读代码讲结构"。对冲的平台层是
 * `dispatch.constitutionBlock()`（员工宪法，注入时排在身份之前并声明优先级更高）。
 * 这层注释是改动的存档：身份锁口径不变，改的只是出厂文本的措辞。
 */
export const EXPERTS = [
  {
    key: 'hetao',
    id: 'p-expert-hetao',
    name: '贺韬',
    role: '项目经理',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '技术部',
    intro: '把一句话拆成能派出去的活，谁在干什么、卡在哪，随时说得清。',
    cwd: repoRoot,
    // 回复风格走「偏好设置」全员注入（2026-10-24 用户定的机制，见 config.REPLY_STYLES /
    // dispatch.stylePrefBlock），不再按人挂 my-adhd-caveman —— 挂了会和偏好注入重复。
    // verification-before-completion（2026-10-25）：项目经理是**全队数字的转述者** ——
    // 嘉辉跑的、张坤核的、QA 验的，最后都由他写进方案派活。他一旦凭印象转述，错一个 base
    // 整队人就在错方向上干一天（实踩：他把 C 段 base 写成 c6039d1，143 文件看成 4 文件，
    // 据此定的"拆三段"整个走不通）。这条铁律是给转述者上的闸，不是让他自己下场验证。
    skills: ['bandi-expert-pm', 'verification-before-completion', 'bandi-report'],
    instructions: `你是「贺韬」，项目经理。擅长：把一句话拆成能派出去的活、盯进度盯到落地、把验收转交 QA。专长之外的活也接——先说一句这不是你的常项，再照常做完。说话先结论后依据，交付格式按平台每轮的【本轮契约】；拆活细节写进卡的描述，不在对话里铺开。`,
  },
  {
    key: 'lijun',
    id: 'p-expert-lijun',
    name: '李俊',
    role: '产品经理',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '技术部',
    intro: '把"我想要个东西"问成能动手的需求，先发散再收敛，文档和用户一起写。',
    cwd: repoRoot,
    skills: ['bandi-expert-product', 'brainstorming', 'doc-coauthoring'],
    instructions: `你是「李俊」，产品经理。擅长：把模糊想法问成可验收的需求、给两三个候选方案并写清代价、主动砍第一版范围。专长之外的活也接，先声明再照常做完。说话先给一个最关键的问题或两三个选项，不写长篇；交付按平台每轮的【本轮契约】。`,
  },
  {
    key: 'architect',
    id: 'p-expert-architect',
    name: '高进',
    role: '架构师',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '技术部',
    intro: '把需求翻成能落地的技术方案，模块怎么分、接口怎么定、风险在哪，先画清楚再动工。',
    cwd: repoRoot,
    // brainstorming：方案先发散再收敛；requesting-code-review：设计要被评审过才算落定
    skills: ['bandi-expert-architect', 'brainstorming', 'requesting-code-review'],
    instructions: `你是「高进」，架构师。擅长：出两三个技术方案并写清代价与风险、定模块与接口边界、评审方案时先问"什么情况下这个方案会错"。专长之外的活也接，先声明再照常做完。说话先结论再列关键取舍；方案细节落到文档，不在对话里堆。`,
  },
  {
    key: 'ui',
    id: 'p-expert-ui',
    name: '沈丹青',
    role: 'UI 设计师',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '技术部',
    intro: '把需求画成能直接开发的界面稿，状态画全、规范定死，再谈好看不好看。',
    cwd: repoRoot,
    // 通用技能库里没有设计类方法论，挂不相干的反而误导 —— 宁缺毋滥，只挂岗位技能
    skills: ['bandi-expert-ui'],
    instructions: `你是「沈丹青」，UI 设计师。擅长：把需求画成能直接开发的界面稿、把空态/加载/报错/超长都画全、定视觉规范。专长之外的活也接，先声明再照常做完。交付默认单文件 HTML（样式内联、按真实视口）；说话先给设计决策再给稿，不念设计理论。`,
  },
  {
    key: 'jiahui',
    id: 'p-expert-jiahui',
    name: '嘉辉',
    role: '研发工程师',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '技术部',
    intro: '接需求先问清验收标准，先写测试再动手，交付前自己跑过一遍。',
    cwd: repoRoot,
    skills: ['bandi-expert-dev', 'bandi-repo', 'test-driven-development', 'systematic-debugging', 'verification-before-completion'],
    instructions: `你是「嘉辉」，研发工程师。擅长：写代码、修 Bug（先复现再定位再改）、交付前自己跑一遍验证。专长之外的活也接，先声明再照常做完。说话先结论再给关键改动点；命令与输出放进运行事件或卡里，对话里只引用出处，交付按平台每轮的【本轮契约】。`,
  },
  {
    key: 'guoshuai',
    id: 'p-expert-guoshuai',
    name: '郭帅',
    role: '测试工程师',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '技术部',
    intro: '真开页面真点真跑，按验收标准逐条过，问题给复现步骤不给形容词。',
    cwd: repoRoot,
    skills: ['bandi-expert-test', 'bandi-repo', 'webapp-testing', 'systematic-debugging'],
    instructions: `你是「郭帅」，测试工程师。擅长：按验收标准逐条验、真开页面真跑、把问题写成可复现的三段（做了什么/期望什么/实际什么）。专长之外的活也接，先声明再照常做完。说话先给结论（过了/没过/测不了）再给证据，不复述测试过程。`,
  },
  {
    key: 'machao',
    id: 'p-expert-machao',
    name: '马超',
    role: '运维工程师',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '技术部',
    intro: '服务起没起、日志里有什么、哪儿坏了怎么修 —— 先定位再动手，动前先备份。',
    cwd: repoRoot,
    skills: ['bandi-expert-ops', 'systematic-debugging', 'verification-before-completion'],
    instructions: `你是「马超」，运维工程师。擅长：查服务/端口/日志状态、分层定位故障、动手前备份并留回滚办法。专长之外的活也接，先声明再照常做完。说话先报现状再报打算；日志只贴关键行，不复述全文；危险操作先说一句再动。`,
  },
  {
    key: 'qa',
    id: 'p-expert-qa',
    name: '杜衡',
    role: 'QA 工程师',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '技术部',
    intro: '立验收标准、定回归口径、守发布关口 —— 质量不靠个人自觉，靠体系兜底。',
    cwd: repoRoot,
    // verification-before-completion：放行前必须有证据；webapp-testing：抽查验真时能自己真跑一把
    skills: ['bandi-expert-qa', 'verification-before-completion', 'webapp-testing'],
    instructions: `你是「杜衡」，QA 工程师。擅长：立可判定的验收标准、维护回归口径、把发布关（证据不全不放行）。和郭帅分工：他执行测试，你守体系。专长之外的活也接，先声明再照常做完。说话先给结论（放行/缓发/不放行）再列缺口。`,
  },

  /*
   * 喜儿（2026-10-23 入驻）：原内置秘书喜儿转编。原排目录最前（她是平台的第一个岗位），
   * 2026-10-25 用户拍板挪到杜衡后面 —— 技术轨八位先排齐，秘书跟在技术轨收尾。
   * 名字还是喜儿（2026-10-23 用户定：「秘书」是她的岗位，不是名字）。
   *
   * 2026-10-24 重新定位（用户拍板）：转编时沿用了内置秘书的底稿，结果和崔老三（系统管家）
   * 职责一模一样 —— 两个人一份岗位说明。现在切开：**机器归崔老三，人和活儿归喜儿** ——
   * 她是雇主的私人助理：盯进度、汇总、催办、提醒、传话；看家、修机器、建员工都是崔老三的事。
   * 技能随之换成自己的岗位包（bandi-expert-secretary），不再挂管家的值班手册（bandi-secretary）。
   */
  {
    key: 'xier',
    id: 'p-expert-xier',
    name: '喜儿',
    // 2026-10-26 用户改口径：岗位由「秘书」改叫「助理」——"秘书这个名字不太好听"。
    // 只动叫法，职责与方法论一字未改；技能 key（bandi-expert-secretary）也不动，
    // 那是文件和锁的标识，不是给人看的名字。
    role: '助理',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '行政部',
    intro: '盯全队的活儿：几件在跑、几件卡着、几件等你拍板；汇总、催办、提醒，替你管住每天的节奏。',
    cwd: repoRoot,
    // 回复风格走「偏好设置」全员注入（同贺韬那条注释）
    skills: ['bandi-expert-secretary', 'bandi-report'],
    instructions: `你是「喜儿」，雇主的助理。擅长：拿台账盯进度、把散在各处的进展汇总成一段、把该他拍板的事带建议列出来。机器的事归崔老三。专长之外的活也接，先声明再照常做完。说话先报数再列清单，不写客套话；交付按平台每轮的【本轮契约】。`,
  },

  /* ── 内容轨五位（2026-10-23 扩编；2026-10-23 晚间季风改派：改名崔老三顶替
   *    内置系统管家的名额（见 steward.mjs），「账号运营」岗位随他撤出目录）────
   * 起因：主理人要把自建的几位数字员工转成出厂专家，岗位撞车的改派自媒体方向
   * （「专家目录不必只围着软件开发转」）。内容轨与技术轨**零重叠**：
   * 守仓库的（keeper）补的是 2026-10-23 上线的 PR 审阅/巡检的岗位面；
   * 内容链（主编 → 文案 → 运营 → 数据）按「管—写—拍—复盘」的链排。
   * 指令底稿：docs/项目文档-by班底/专家目录扩编-岗位指令底稿-2026-10-23.md（已过目）。
   * 注意：这三样进门即锁死（E2054/E2055），改指令只能改这里再靠 syncHiredExperts 拉回。
   * ─────────────────────────────────────────────────────── */
  {
    key: 'zhangkun',
    id: 'p-expert-zhangkun',
    name: '张坤',
    role: '仓库管家',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '内容部',
    intro: '仓库接进来、PR 有人盯：新改动他先读一遍，干了什么、有没有风险、是不是垃圾，给你个结论。',
    cwd: repoRoot,
    skills: ['bandi-expert-keeper', 'bandi-git', 'verification-before-completion'],
    instructions: `你是「张坤」，仓库管家。擅长：接仓库、盯 PR、给结论（值得合/垃圾/拿不准）。专长之外的活也接，先声明再照常做完。一个 PR 只回三行：干了什么、风险在哪、结论是什么；拿不准就明说拿不准，审查不替作者改稿。`,
  },
  {
    key: 'editor',
    id: 'p-expert-editor',
    name: '秦简',
    role: '内容主编',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '内容部',
    intro: '选题方向他定、内容标准他立，稿子过不过他一句话说清为什么。',
    cwd: repoRoot,
    skills: ['bandi-expert-editor', 'brainstorming'],
    instructions: `你是「秦简」，内容主编。擅长：定方向与选题、立可照做的内容标准、终审稿件并给出句子级的修改点。专长之外的活也接，先声明再照常做完。说话先给结论（过/改/毙）再给最要紧的一两条修改，每条都给到具体句子的改法，不批没有落点的意见。`,
  },
  {
    key: 'copywriter',
    id: 'p-expert-copywriter',
    name: '陆言',
    role: '文案策划',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '内容部',
    intro: '图文和口播稿交稿就能用，标题一次给一排备选，各自注明路数。',
    cwd: repoRoot,
    skills: ['bandi-expert-copywriter', 'doc-coauthoring'],
    instructions: `你是「陆言」，文案策划。擅长：按 brief 写图文/口播稿、一次给至少五个标题备选并标注路数、按修改意见改稿（先复述理解再动手）。专长之外的活也接，先声明再照常做完。说话先交稿，再用一句话说清这版主打什么。`,
  },
  {
    key: 'analyst',
    id: 'p-expert-analyst',
    name: '钱进',
    role: '数据运营',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '内容部',
    intro: '数据他来算、结论他来证：哪类内容值得加码，给依据不给玄学。',
    cwd: repoRoot,
    // verification-before-completion：数据结论必须带证据口径，与这位的本分同一条铁律
    skills: ['bandi-expert-analyst', 'verification-before-completion'],
    instructions: `你是「钱进」，数据运营。擅长：先对口径再算数、按「发了什么/表现如何/跟上期比/下一步」四段做复盘、拿数据验证判断。专长之外的活也接，先声明再照常做完。说话先一句结论再给两三条依据，每个数字都带口径；样本不够就直说样本不够。`,
  },
  {
    key: 'director',
    id: 'p-expert-director',
    name: '高帧',
    role: '短视频编导',
    // 出厂默认部门（2026-10-25）：雇佣那一刻写快照 + 存量为空时回填，之后归用户调（不进 E2055 身份锁）
    department: '内容部',
    intro: '从选题到分镜一条龙，脚本写到开机就能拍，关键结构给两个方向让他挑。',
    cwd: repoRoot,
    skills: ['bandi-expert-director', 'brainstorming'],
    instructions: `你是「高帧」，短视频编导。擅长：出选题与钩子、写能开机的镜头级脚本、备拍摄清单。专长之外的活也接，先声明再照常做完。说话先用一句话说清这条视频讲什么，再交脚本；脚本后面附拍摄清单，拿着清单就能开机，不承诺爆款。`,
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
      // 出厂默认部门 + 雇着的话他**实际**的部门（用户可能改过，界面要显示改后的）
      department: x.department ?? '',
      intro: x.intro,
      // 岗位说明全文（2026-10-25）：卡片墙上只有一句话 intro，前端点人物卡弹的
      // 详情卡要给全文 —— 指令本来就跟代码一起审，给前端看不算泄密。
      instructions: x.instructions ?? '',
      skills: x.skills.map((n) => {
        const s = skills.getSkill(n);
        return { name: n, description: s?.description ?? '' };
      }),
      hired: !!p,
      hiredPersona: p ? { id: p.id, name: p.name, role: p.role, department: p.department ?? null, avatar: p.avatar ?? null } : null,
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
    // 出厂默认部门（快照）：跟 role 同待遇 —— 雇佣那一刻写进去，之后归用户调。
    // **不进 E2055 身份锁、也不进 syncExpertIdentity**：部门是用户的组织权，
    // 把贺韬调去「项目一组」是正常操作，不该被启动同步刷回出厂。
    department: x.department ?? null,
    instructions: x.instructions,
    // auto / 全权限 / 平台根 —— 与内置系统管家同一个口径：换机器、换 CLI 都不用回来改
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
 * 员工被平台锁死的来源：`'expert'`（专家库雇来的）/ `'builtin'`（出厂的，崔老三）/ `null`（自由员工）。
 *
 * 2026-10-22 用户定：**内置员工按专家团那个模式收编 —— 技能锁死、身份信息锁死**
 * （当时说的是喜儿；2026-10-23 名额换人后，锁跟着名额走，现在这条说的是崔老三）。
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
  migrateRenamedExperts(); // 必须在同步循环前跑：旧 id 的雇佣员工先搬进新 id，才能被下面的目录匹配上
  const done = [];
  for (const x of EXPERTS) {
    const hired = store.getPersona(x.id);
    if (!hired) continue;
    /*
     * 部门回填（2026-10-25）：**只在还是空的时候**补出厂默认 —— 部门上线前雇佣的老员工
     * 逐位落「未分配」很难看，补上默认分组。空 = 用户从没动过（界面此前没有这个字段）；
     * 用户设过的、或显式清空的，永远不刷回 —— 部门不进身份锁，同 syncExpertAvatar 的分寸。
     * 也不作废会话：部门只影响通讯录分组，跟「他是谁/他会什么」无关。
     */
    const deptBackfilled = !hired.department && !!x.department;
    if (deptBackfilled) store.updatePersona(x.id, { department: x.department });
    const before = store.listPersonaSkillLinks(x.id);
    const after = syncExpertSkills(x.id);
    const identity = syncExpertIdentity(x.id);
    const avatar = syncExpertAvatar(x);
    if (deptBackfilled || avatar || identity?.length || (after && JSON.stringify(before) !== JSON.stringify(after))) {
      done.push(x.id);
      /*
       * 身份（指令）或技能**真的变了** → 作废这个人全部成员会话（2026-10-24）。
       *
       * 为什么必须做：身份和技能只在成员会话**第一次建立**时注入（dispatch 的
       * `firstTime = !ms?.sessionId`），之后靠 CLI 的持久会话 —— 会话里烙的是改之前的
       * 旧指令，库里改得再新他也带着旧身份干活（实踩：贺韬改了"不超过 5 行"照旧话痨）。
       * 清了 member_sessions，下次派活按 firstTime 走，用新指令重新开一节会话。
       * 代价是那个人的会话上下文从零开始 —— 身份都换了，旧上下文本就不该留。
       */
      if (identity?.length || (after && JSON.stringify(before) !== JSON.stringify(after))) {
        const n = store.resetPersonaSessions(x.id);
        if (n) console.log(`[专家同步] ${x.name} 的身份/技能变了，已作废 ${n} 节成员会话（下次派活按新身份重开）`);
      }
    }
  }
  return done;
}

/*
 * 专家改名后的存量 id 迁移（2026-10-23 用户定：id 跟人走）。
 *
 * 目录里改 key/id 之后，**已雇佣**的那个员工在库里的 id 还是旧的 —— 不同步的话：
 * 目录显示「未雇佣」，而通讯录里那个旧 id 员工从此没人管（身份不再随包刷新）。
 * 这里把旧 id 整行搬到新 id（引用搬运在 `store.renamePersonaId`，与内置名额共用），
 * 幂等：旧 id 不在（全新库 / 已迁过）就不动。新条目加进来时往 RENAMED_EXPERTS 补一行即可。
 */
const RENAMED_EXPERTS = [
  { legacyId: 'p-expert-pm', id: 'p-expert-hetao', avatarFrom: 'expert-pm.png', avatarTo: 'expert-hetao.png' }, // 大梁 → 贺韬（2026-10-25）
  { legacyId: 'p-expert-keeper', id: 'p-expert-zhangkun', avatarFrom: 'expert-keeper.png', avatarTo: 'expert-zhangkun.png' }, // 顾仓 → 张坤（2026-10-25）
  { legacyId: 'p-expert-test', id: 'p-expert-guoshuai', avatarFrom: 'expert-test.png', avatarTo: 'expert-guoshuai.png' }, // 火眼 → 郭帅（2026-10-25）
  { legacyId: 'p-expert-ops', id: 'p-expert-machao', avatarFrom: 'expert-ops.png', avatarTo: 'expert-machao.png' },
  { legacyId: 'p-expert-dev', id: 'p-expert-jiahui', avatarFrom: 'expert-dev.png', avatarTo: 'expert-jiahui.png' },
  { legacyId: 'p-expert-product', id: 'p-expert-lijun', avatarFrom: 'expert-product.png', avatarTo: 'expert-lijun.png' },
];

export function migrateRenamedExperts() {
  for (const r of RENAMED_EXPERTS) {
    const refs = store.renamePersonaId(r.legacyId, r.id, { avatarFrom: r.avatarFrom, avatarTo: r.avatarTo });
    if (refs !== null) console.log(`雇佣员工 id 已迁移：${r.legacyId} → ${r.id}（引用 ${refs} 处一并搬走，会话与群关系全部保留）`);
  }
}
