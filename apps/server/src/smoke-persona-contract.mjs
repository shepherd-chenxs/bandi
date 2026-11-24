/**
 * smoke-persona-contract.mjs —— 身份与职责检修（2026-11-09 P0）的验收。
 *
 * 用户实拍：数字员工回复信息一大堆、不利于管理者决策；怀疑"职责与身份设定"起了反作用。
 * P0 的修法是**把行为规则从身份里搬出来、改成每轮注入**：
 *   ① 15 个专家 + 系统管家的出厂身份卡只回答"我是谁"（≤240 字，不写边界/流程/禁令）；
 *   ② 平台行为契约（platformContractBlock）每轮注入，优先级声明高于身份；
 *   ③ 本轮任务合同（taskContractBlock）每轮注入，卡评论区带上卡标题与验收标准；
 *   ④ 汇报口径不再只给项目经理（旧 pmCardBrief 里的那段已搬走）；
 *   ⑤ P5 交付形态（2026-11-09）：问问题先直接回答（多问拆答、权责分层、每个判断落源），
 *      任务合同按形态给交付/验收（问答 → 答案/每一问；做事 → 结论先行/可核/可拍板）。
 *      真实事故：pt-7c6d4229「数字员工的权限问题」被答成"钥匙怎么发"的工作报告 + 4 处事实错。
 *   ⑥ **2026-11-12 反向修正**：⑤ 里"每个判断落源"把堵错的成本转嫁成了回复体积（用户实报
 *      "每个人回复都是一大堆依据"）。依据降为兜底（默认不写，只在追问 / 改变决定 / 不可逆确认时附，
 *      一行以内），第一行改三态结论（顺利 / 有问题 / 卡住），并要求交代"要不要他动手"；
 *      验收同步改为"用过程代替结论算没交付"。防错的底线（真源 / 未验证 / 不编数）保留在第 4 条。
 *
 * 隔离：临时数据目录 + 临时库，不起服务、不碰真实 data/。
 * 跑法：node apps/server/src/smoke-persona-contract.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-persona-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

// ⚠️ 必须先设环境变量，再动态 import 会读 config 的模块（同 smoke-conversation-delete）
const { dbPath } = await import('./config.mjs');
const experts = await import('./experts.mjs');
const dispatch = await import('./dispatch.mjs');
const repoRootOfApp = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const steward = await import('./steward.mjs');

if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(tmp).toLowerCase())) {
  console.log(`✗ 临时库没生效：dbPath=${dbPath} 不在 ${tmp} 下 —— 拒绝继续（避免写进真库）`);
  process.exit(1);
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const BANNED = /核心三件事|分寸（|只管|不要揽|别的不要揽|红线/;

try {
  console.log('① 出厂身份卡只回答"我是谁"（≤240 字，不写边界/流程/禁令）');
  check('专家目录还是 15 位', experts.EXPERTS.length === 15, String(experts.EXPERTS.length));
  const tooLong = experts.EXPERTS.filter((x) => x.instructions.length > 240).map((x) => `${x.name}:${x.instructions.length}`);
  check('15 张身份卡都 ≤240 字', tooLong.length === 0, tooLong.join(', '));
  const bannedHit = experts.EXPERTS.filter((x) => BANNED.test(x.instructions)).map((x) => x.name);
  check('身份卡里没有"只管/别揽/核心三件事/红线"这类边界话术', bannedHit.length === 0, bannedHit.join(', '));
  check('系统管家身份卡也 ≤200 字', steward.STEWARD_INSTRUCTIONS.length <= 200, `${steward.STEWARD_INSTRUCTIONS.length} 字`);
  check('系统管家身份卡没有边界话术', !BANNED.test(steward.STEWARD_INSTRUCTIONS));

  console.log('\n② 平台行为契约（每轮注入，优先级高于身份；2026-11-12 改为 10 条 + 三态结论）');
  const contract = dispatch.platformContractBlock();
  check('有"优先级高于身份设定"的声明', /优先级高于身份设定/.test(contract));
  check('总纲：每轮只办"结果是什么 + 要不要他出手"',
    /三秒内知道/.test(contract) && /(要不要他出手|要不要他动手)/.test(contract));
  check('① 第一行 = 结论，按三态写（顺利 / 有问题 / 卡住）',
    /第一行\s*=\s*结论/.test(contract) && /顺利/.test(contract) && /有问题/.test(contract) && /卡住/.test(contract),
    contract.split('\n').find((l) => /三态/.test(l)) ?? '');
  check('① 问问题 → 第一行直接回答（谁 / 哪个 / 能不能 / 归谁）',
    /第一行/.test(contract) && /直接回答/.test(contract) && /谁/.test(contract) && /哪个/.test(contract) && /能不能/.test(contract) && /归谁/.test(contract),
    contract.split('\n').find((l) => /直接回答/.test(l)) ?? '');
  check('① 问答题不许拿工作报告顶替答案 + 指向 bandi-report',
    /(答案|结论)/.test(contract) && /(工作报告|工作汇报)/.test(contract) && /bandi-report/.test(contract));
  // 2026-11-19 用户实报（「为什么总是有"不用你动"这句话，很奇怪」）：这句以前是**模板**，现在改成
  // 例外 —— 只在他可能以为要自己动手时说，一轮最多一次；顺利态直接给结果，句尾不许挂它。
  check('② 归谁动手：默认不写，「不用你动」是例外不是结语',
    /归谁动手：默认不写/.test(contract) && /(例外|不是结语)/.test(contract) && /(一轮最多一次|能不说就不说)/.test(contract) && /(给权限|拍板)/.test(contract) && /(那我要干嘛|没交付)/.test(contract),
    contract.split('\n').find((l) => /归谁动手/.test(l)) ?? '');
  check('② 顺利态第一行直接给结果，模板里不再有「顺利，不用你动」',
    !/顺利，不用你动/.test(contract) && /顺利[^\n]*直接说结果/.test(contract),
    contract.split('\n').find((l) => /三态/.test(l)) ?? '');
  check('③ 依据默认不写，只三种情况附（追问 / 改变决定 / 不可逆确认）',
    /依据默认不写/.test(contract) && /为什么/.test(contract) && /改变他的决定/.test(contract) && /确认/.test(contract),
    contract.split('\n').find((l) => /依据默认不写/.test(l)) ?? '');
  check('③ 依据不进第一行、附就一行以内；整轮超过 5 行先删依据',
    /(一行以内|一行内)/.test(contract) && /超过 5 行/.test(contract) && /先删依据/.test(contract));
  check('④ 要附就附真的：真源 + 行号可翻 + 未验证（防 pt-7c6d4229 复发）',
    /只引真源/.test(contract) && /未验证/.test(contract) && /(函数名|不写估算行号)/.test(contract) && /apps\/desktop\/runtime/.test(contract));
  check('⑤ 多问拆答，但每问一句（不再摊四层机制）',
    /(多问|拆答)/.test(contract) && /逐条答/.test(contract) && /(每问一句|每条一个结论)/.test(contract) && !/归属方/.test(contract));
  // P4 交付声明协议（2026-11-09）：P5 起标记单独放**最后一行**（第一行留给答案/结果）。
  check('④ 交付声明：跑完 ≠ 完成，标记单独放最后一行 [完成] / [受阻]',
    /\[完成\]/.test(contract) && /\[受阻\]/.test(contract) && /跑完[^。\n]*≠/.test(contract) && /最后一行/.test(contract),
    contract.split('\n').find((l) => /\[完成\]/.test(l)) ?? '');
  check('④ 交付声明：平台只按这个标记判卡状态 / 不写标记不进待验收 / 没做完不许写 / 不替雇主宣布',
    /只按这个标记判/.test(contract) && /卡/.test(contract) && /不写标记/.test(contract) && /待验收/.test(contract) &&
      /没做完不许写/.test(contract) && /不许替雇主宣布/.test(contract));
  check('⑤ 问进度只答台账（状态/更新/下一步，不追细节）', /只答台账/.test(contract) && /(不要|别)为了补细节/.test(contract));
  check('⑤ 够答即回（别为"更完整"继续翻）', /够答即回/.test(contract));
  check('⑥ 不空转（先做完再回话）+ Next: 禁令', /(不空转|先做完再回话)/.test(contract) && /Next:/.test(contract));
  check('⑥ 不编数 + 不猜接口（别 foreach 试路径）', /不编数/.test(contract) && /不猜接口/.test(contract) && /foreach/.test(contract));
  check('⑦ 红线：删数据 / 动生产 / 对外发布', /删数据/.test(contract) && /(动生产|生产)/.test(contract) && /对外发布/.test(contract));

  console.log('\n②-a 要雇主拍板必须 @ 群主（2026-11-16 用户："这种要我决策的事情，要@我"；2026-11-21 实报：照抄「雇主本人」= 谁也没 @ 到）');
  check('⑨ 红线请雇主拍板 → 回话里 @ 群主', /红线/.test(contract) && /@ 群主/.test(contract) && /请他拍板/.test(contract));
  check('⑩ 拍板 / 决策 / 确认 / 授权 / 卡住等人 → 必须 @ 群主，不带 @ = 没交付',
    /拍板 \/ 决策 \/ 确认/.test(contract) && /@ 群主/.test(contract) && /没叫到他/.test(contract));
  {
    // 群主名注入群聊 prompt：让 AI 知道 @ 谁（续接轮也要有，不只首轮）
    const grp = dispatch.buildGroupTask({
      thread: { kind: 'group', title: '测试群' }, // 不带 ownerUserId → 走"群主是真人"兜底文案（本 smoke 不 boot store）
      member: { personaId: 'p-x', instructions: '' },
      trigger: { text: '卡住了' },
      contextMessages: [],
      firstTime: false,
    });
    check('群聊 prompt 每轮带群主提示（续接轮也有，不只首轮）', /群主/.test(grp) && /拍板/.test(grp) && /@/.test(grp), grp.split('\n').find((l) => /群主/.test(l)) ?? '');
  }

  console.log('\n②-b 过程决策是本职（2026-11-14 甲方口径：我只要结果，别拿过程问我）');
  check('⑪ 方案 / 设计 / 实现 / 派下一张卡 = 自己定，不问雇主',
    /过程决策是你的本职/.test(contract) && /要不要给下游派下一张卡/.test(contract) && /不要拿这些问雇主/.test(contract));
  check('⑪ 中间产物最多一行路径，不许"你先看看"',
    /落盘归档/.test(contract) && /最多一行路径/.test(contract) && /你先看看/.test(contract));
  check('⑪ 只剩三种情况找雇主：红线 / 真阻塞 / 交验收',
    /三种情况找他/.test(contract) && /真阻塞/.test(contract) && /交验收/.test(contract));
  check('⑪ "要不要我继续 / 要不要我派 / 你先看文档吗" = 没交付',
    /要不要我继续/.test(contract) && /算没交付/.test(contract));
check('⑪ 对雇主用用户视角：代码路径 / 构建指令不进对雇主的回话（2026-11-15 验收实报）',
  /用户视角/.test(contract) && /(代码路径|构建编译指令)/.test(contract) && /不进对雇主的回话/.test(contract));
check('⑪ 建卡轮：卡票就是交付，回话一行即止（别再发安排叙述）',
  /卡票就是交付/.test(contract) && /一行即止/.test(contract));

  console.log('\n②-c 统筹块：派下一张卡不用请示（PM 本职，2026-11-14 李俊实报）');
  const pm = dispatch.pmDispatchBlock({ persona: { id: 'p-pm' }, thread: { kind: 'group', members: [] }, project: { name: 'x' } });
  check('⑦ 方案定了直接建卡派下游（统筹本职）', /派下一张卡不用请示/.test(pm) && /统筹本职/.test(pm), pm.split('\n').at(-1) ?? '');
  check('⑦ 派卡不请示、回话一行即止（卡票即交付，安排叙述=重复）', /不用请示/.test(pm) && /一行即止/.test(pm) && /功课/.test(pm));

  console.log('\n②b 仓库地图（2026-11-19 三改：不给结构它每次都要从 0 摸）');
  const brief = dispatch.repoBriefBlock(repoRootOfApp);
  check('给了 cwd 与顶层目录', /cwd = /.test(brief) && /apps\//.test(brief), brief.split('\n')[1] ?? '');
  check('列出子目录与脚本数（省掉一次 Glob）', /apps\/\s+——/.test(brief) && /\(\d+\)/.test(brief),
    (brief.split('\n').find((l) => l.startsWith('- apps/')) ?? ''));
  check('写了"Read 不能读目录"', /Read` 只能读\*\*文件\*\*/.test(brief));
  check('写了"同一条别查第二遍"', /不要查第二遍/.test(brief));
  check('写了"判架构读到哪里够，别全仓扫"', /不要全仓扫/.test(brief));
  // 上限从 2000 抬到 2200（2026-11-19）：加了"命令报错=结论作废"这条实报规矩后正好顶到 2000，
  // 零余量意味着下一次微调就红。这个数的本意是"别把地图写成目录树"，不是卡字数。
  check('体积可控（≤2200 字，别把地图写成目录树）', brief.length <= 2200, `${brief.length} 字`);
  check('给不存在/空路径时安静返回空串', dispatch.repoBriefBlock('X:////nope') === '' && dispatch.repoBriefBlock('') === '');

  /*
   * ②c 仓库状态实测（2026-11-19 实报「为什么张坤告诉我是一致的」）：
   * 分支上有一个没进 main 的提交，它拿"工作区干净 + 与同名分支同步 + 没 open PR"答了"一致"。
   * 钉住的是：领先数必须由平台算出来，且结论必须跟着领先数变 —— 干净的工作区不能把结论带偏。
   */
  console.log('\n②c 仓库状态实测（不能拿"工作区干净"回答"和仓库一致吗"）');
  const gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-gitstate-'));
  const G = (...args) => execFileSync('git', args, { cwd: gitRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const Gc = (msg) => G('-c', 'user.name=smoke', '-c', 'user.email=smoke@local', 'commit', '-m', msg);
  try {
    G('init', '-b', 'main');
    fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'a\n');
    G('add', '-A');
    Gc('init');
    // 造出 origin/main 这个远端引用（不联网络）
    G('update-ref', 'refs/remotes/origin/main', G('rev-parse', 'HEAD'));

    const clean = dispatch.gitStateBlock(gitRepo);
    check('干净且等于 main → 判定"与主线一致"', /领先 0 个提交/.test(clean) && /代码与主线一致/.test(clean), clean.split('\n').find((l) => /平台判定/.test(l)) ?? '');
    check('把三个假信号点名（干净/同名分支/无 open PR）', /不等于\*\*已并入主线/.test(clean) && /没有 open PR/.test(clean));

    G('checkout', '-b', 'feat/x');
    fs.writeFileSync(path.join(gitRepo, 'b.txt'), 'b\n');
    G('add', '-A');
    Gc('feat: 新增 b');
    const ahead1 = dispatch.gitStateBlock(gitRepo);
    check('分支上多一个提交 → 领先 1，并列出该提交', /领先 1 个提交/.test(ahead1) && /新增 b/.test(ahead1), ahead1.split('\n').find((l) => /没进 main/.test(l)) ?? '');
    check('领先时不许说"一致"/"不需要建 PR"', /要开 PR/.test(ahead1) && /不能说「和仓库一致」/.test(ahead1));

    fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'a changed\n');
    const dirty = dispatch.gitStateBlock(gitRepo);
    check('有未提交改动就直说（脏不影响领先数）', /有 1 个改动没提交/.test(dirty) && /领先 1 个提交/.test(dirty));
    check('体积可控（≤1500 字）', ahead1.length <= 1500, `${ahead1.length} 字`);

    check('非 git 目录安静返回空串', dispatch.gitStateBlock(os.tmpdir()) === '' || !fs.existsSync(path.join(os.tmpdir(), '.git')));
    check('空路径返回空串', dispatch.gitStateBlock('') === '');
  } finally {
    try { fs.rmSync(gitRepo, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  }

  console.log('\n③ 交付形态判定（P5 新增 dispatch.guessDeliveryKind：问答 → answer / 做事 → do / 判不了 → null）');
  check('guessDeliveryKind 是导出函数', typeof dispatch.guessDeliveryKind === 'function');
  const kindOf = (t) => dispatch.guessDeliveryKind(t);
  const permQ = '关于数字员工的权限问题（数字员工能调用哪些api，分别是什么权限），是给特定数字员工的还是全员平权';
  check('权限多问 → answer（不是"发钥匙"式的做事）', kindOf(permQ) === 'answer', String(kindOf(permQ)));
  check('修时区（改代码 + 提交）→ do',
    kindOf('修时区：任务卡页时间显示慢8小时（projects.mjs 共8处）…改完提交') === 'do',
    String(kindOf('修时区：任务卡页时间显示慢8小时（projects.mjs 共8处）…改完提交')));
  check('部署 → do', kindOf('把爻鉴部署到阿里云服务器') === 'do', String(kindOf('把爻鉴部署到阿里云服务器')));
  check('"为什么…？" → answer', kindOf('为什么时间会慢8小时？') === 'answer', String(kindOf('为什么时间会慢8小时？')));
  check('"怎么改这个bug？" → null（形态混合/判不了，不硬猜）', kindOf('怎么改这个bug？') === null, String(kindOf('怎么改这个bug？')));
  check('空串 → null', kindOf('') === null, String(kindOf('')));

  console.log('\n④ 本轮任务合同（每轮注入；P5 起按交付形态给交付与验收）');
  const tc = dispatch.taskContractBlock();
  check('无参：仍有目标 / 受众 / 交付 / 验收四段', /目标/.test(tc) && /受众/.test(tc) && /交付/.test(tc) && /验收/.test(tc));
  check('无参：默认验收不把"结论先行"硬塞给问答题',
    !/结论先行/.test(tc) && /(逐条|依据可核|有交代)/.test(tc), tc.split('\n').find((l) => /验收/.test(l)) ?? '');
  const answerCard = {
    title: '数字员工的权限问题',
    description: '关于数字员工的权限问题（数字员工能调用哪些api，分别是什么权限），是给特定数字员工的还是全员平权',
    status: 'doing',
    projectName: '班底',
    source: 'board',
  };
  const tca = dispatch.taskContractBlock({ card: answerCard });
  check('answer 卡：目标带卡标题 + 项目', /目标：「数字员工的权限问题」/.test(tca) && /项目：班底/.test(tca), tca.split('\n').slice(0, 3).join(' / '));
  check('answer 卡：交付形态 = 问答（第一行直接回答）', /交付形态/.test(tca) && /(问答|回答)/.test(tca) && /第一行/.test(tca));
  check('answer 卡：交付要"答案"、验收要"每一问"', /答案/.test(tca) && /每一问/.test(tca), tca.split('\n').filter((l) => /交付|验收/.test(l)).join(' / '));
  const tcd = dispatch.taskContractBlock({ card: { title: '修时区', description: '修时区，改完提交', source: 'board' } });
  check('do 卡：验收钉"第一行结果/卡点 + 说清要不要他动手"',
    /第一行/.test(tcd) && /(结果|卡点)/.test(tcd) && /动手/.test(tcd) && /用过程代替结论/.test(tcd), tcd.split('\n').find((l) => /验收/.test(l)) ?? '');
  const tcc = dispatch.taskContractBlock({ card: { title: '修首页文案', description: '标题改短', status: 'doing', projectName: '班底' } });
  check('评论卡（非 board）：仍带卡标题 + 项目', /「修首页文案」/.test(tcc) && /项目：班底/.test(tcc));
  check('评论卡：验收仍指向卡描述逐条验（不复制长文）', /按【你正在办的任务卡】里的任务描述逐条验/.test(tcc) && !/标题改短/.test(tcc));
  check('评论卡：也带交付形态提示', /交付形态/.test(tcc));
  const tcw = dispatch.taskContractBlock({ workflow: { nodeName: '写代码', visit: 2, detail: '按验收标准实现并通过自测' } });
  check('流程派活带节点名 / 第几次到站 / 本步要求',
    /流程节点：写代码/.test(tcw) && /第 2 次到站/.test(tcw) && /本步要求：按验收标准实现/.test(tcw), tcw.split('\n').slice(2, 4).join(' / '));
  const tcp = dispatch.taskContractBlock({ project: { name: '甲项目' } });
  check('普通聊天带项目名', /项目：甲项目/.test(tcp));

  console.log('\n⑤ 挂线：每轮派活都拼契约（不是首轮/不是 PM 专属）');
  const src = fs.readFileSync(new URL('./dispatch.mjs', import.meta.url), 'utf8');
  // getWorkflowTaskById：2026-11-13 交接快照记的修复（dispatch 改用按主键查的那个函数），断言跟着对齐
  check('按 opts.taskId 现查 workflow_tasks（流程节点进入合同）', /opts\.taskId \? store\.getWorkflowTaskById\(opts\.taskId\)/.test(src));
  check('startMemberRun 拼了 taskContractBlock（卡/流程/项目/台账都传）',
    /taskContractBlock\(\{[\s\S]{0,200}?card: opts\.card[\s\S]{0,200}?workflow: workflowTask[\s\S]{0,200}?project[\s\S]{0,200}?tasks: myTasks[\s\S]{0,120}?\}\)/.test(src));
  check('platformContractBlock 拆进 standing（out-of-band，不再混任务文本）',
    /const standing = \[[\s\S]*?platformContractBlock\(\)/.test(src) && /standing,/.test(src));
  check('契约进了 fullTask（每轮交给运行时）', /fullTask = \[[^\]]*contractBlock/.test(src));
  check('每轮按本人查未完成任务台账（P3a，所有员工通用）', /store\.listMyOpenTasks\(member\.personaId, 5\)/.test(src));
  check('旧的"汇报口径"不再只写在 PM 首轮 brief 里', !/【汇报口径｜结论先行】/.test(src));

  const runsSrc = fs.readFileSync(new URL('./runs.mjs', import.meta.url), 'utf8');
  check('运行钥匙提醒里不再重复汇报格式（已在平台契约里）', !/汇报（每轮都算/.test(runsSrc));
  // P5（2026-11-09）：这层是**操作说明**，不是权限/交付说明 —— 查台账那段与平台契约重复，
  // 且被问"权限归谁"时模型会把它当答案素材复读。只留"怎么用钥匙"，故断言它不再带台账口径。
  /*
   * P5（2026-11-09）：这层是**操作说明**，不是权限/交付说明 —— 查台账那段与平台契约重复，
   * 且被问"权限归谁"时模型会把它当答案素材复读。只留"怎么用钥匙"。
   *
   * 2026-11-19 修正口径：只留"怎么用密钥"**不够**。实报 r-3e67b107 里那段只说了
   * `BANDI_RUN_TOKEN`，没说基址在 `BANDI_CONTROL_URL`，模型为了找入口连试 6 次命令，
   * 45.6 秒里 34 秒耗在这上面。所以判据从"别提接口"改成"三样齐全"：
   * 基址 + 头名 + 能调的清单（清单由 route-policy 的 run:true 生成，不是手写第二份）。
   * 同时仍然不许出现"要查全部卡就调 X"这种**诱导句** —— 那类话才是昨天的真凶。
   */
  const briefSrc = fs.readFileSync(new URL('./capabilities.mjs', import.meta.url), 'utf8');
  check(
    '运行钥匙提醒说清"怎么用"（基址 + 头名 + 别抄旧值）',
    /BANDI_RUN_TOKEN/.test(briefSrc) &&
      /BANDI_CONTROL_URL/.test(briefSrc) &&
      /X-Bandi-Run-Token/.test(briefSrc) &&
      /别抄历史命令/.test(briefSrc),
  );
  check('能力清单由路由表生成，不是手写第二份', /from '\.\/security\/route-policy\.mjs'/.test(briefSrc));
  // 查**运行时输出**而不是源码：capabilities.mjs 的注释里留着那句旧文案当反例，
  // 源码断言会被注释误伤（第一版就踩了）。
  const briefText = (await import('./capabilities.mjs')).runCredentialBrief({ pm: false });
  check('运行时文案里没有"要查全部卡就调…"的诱导句', !/要查全部卡/.test(briefText));
  check('运行时文案带基址变量与头名', /BANDI_CONTROL_URL/.test(briefText) && /X-Bandi-Run-Token/.test(briefText));
  console.log('\n⑥ 任务台账：每个员工都能看到自己未完的卡（P3a，不是只给某个人）');
  const store = await import('./store.mjs');
  const dev = store.createPersona({ name: '台账测试员', runtime: 'codex', cwd: tmp, instructions: '' });
  const other = store.createPersona({ name: '另一个员工', runtime: 'codex', cwd: tmp, instructions: '' });
  const proj = store.createProject({ name: '台账项目', root: tmp });
  const mk = (title, status, assigneePersonaId = dev.id) =>
    store.createProjectTask({ projectId: proj.id, title, status, assigneePersonaId });
  mk('卡A（待办）', 'todo');
  mk('卡B（进行中）', 'doing');
  mk('已完成卡', 'done');
  mk('已取消卡', 'cancelled');
  mk('别人的卡', 'todo', other.id);
  const rows = store.listMyOpenTasks(dev.id, 5);
  check('只列自己的未完卡（排除已完成/已取消/别人的）',
    rows.length === 2 && rows.every((r) => r.title.startsWith('卡')), JSON.stringify(rows.map((r) => r.title)));
  const g = store.createGroup({ title: '台账群', assistantPersonaId: dev.id });
  // createGroup 返回的是群的**会话行**（建群顺手建一段群会话）；群本身的 id 在 groupId
  store.createProjectTask({ projectId: proj.id, title: '团队卡', status: 'todo', assigneeGroupId: g.groupId });
  const rows2 = store.listMyOpenTasks(dev.id, 5);
  check('群助手看得到自己群的团队卡', rows2.some((r) => r.title === '团队卡'), JSON.stringify(rows2.map((r) => r.title)));
  const ledger = dispatch.taskContractBlock({ tasks: rows2 });
  check('任务台账进了合同（卡号 / 标题 / 状态）',
    /你的任务台账/.test(ledger) && /团队卡/.test(ledger) && /待办/.test(ledger) && /pt-/.test(ledger));
  const emptyLedger = dispatch.taskContractBlock({ tasks: [] });
  check('没有未完卡时也说清楚（不让去仓库翻）', /当前没有未完的卡/.test(emptyLedger));
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ 有 ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
