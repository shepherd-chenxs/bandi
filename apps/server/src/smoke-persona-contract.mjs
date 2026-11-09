/**
 * smoke-persona-contract.mjs —— 身份与职责检修（2026-11-09 P0）的验收。
 *
 * 用户实拍：数字员工回复信息一大堆、不利于管理者决策；怀疑"职责与身份设定"起了反作用。
 * P0 的修法是**把行为规则从身份里搬出来、改成每轮注入**：
 *   ① 14 个专家 + 系统管家的出厂身份卡只回答"我是谁"（≤240 字，不写边界/流程/禁令）；
 *   ② 平台行为契约（platformContractBlock）每轮注入，优先级声明高于身份；
 *   ③ 本轮任务合同（taskContractBlock）每轮注入，卡评论区带上卡标题与验收标准；
 *   ④ 汇报口径不再只给项目经理（旧 pmCardBrief 里的那段已搬走）；
 *   ⑤ P5 交付形态（2026-11-09）：问问题先直接回答（多问拆答、权责分层、每个判断落源），
 *      任务合同按形态给交付/验收（问答 → 答案/每一问；做事 → 结论先行/可核/可拍板）。
 *      真实事故：pt-7c6d4229「数字员工的权限问题」被答成"钥匙怎么发"的工作报告 + 4 处事实错。
 *
 * 隔离：临时数据目录 + 临时库，不起服务、不碰真实 data/。
 * 跑法：node apps/server/src/smoke-persona-contract.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-persona-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

// ⚠️ 必须先设环境变量，再动态 import 会读 config 的模块（同 smoke-conversation-delete）
const { dbPath } = await import('./config.mjs');
const experts = await import('./experts.mjs');
const dispatch = await import('./dispatch.mjs');
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
  check('专家目录还是 14 位', experts.EXPERTS.length === 14, String(experts.EXPERTS.length));
  const tooLong = experts.EXPERTS.filter((x) => x.instructions.length > 240).map((x) => `${x.name}:${x.instructions.length}`);
  check('14 张身份卡都 ≤240 字', tooLong.length === 0, tooLong.join(', '));
  const bannedHit = experts.EXPERTS.filter((x) => BANNED.test(x.instructions)).map((x) => x.name);
  check('身份卡里没有"只管/别揽/核心三件事/红线"这类边界话术', bannedHit.length === 0, bannedHit.join(', '));
  check('系统管家身份卡也 ≤200 字', steward.STEWARD_INSTRUCTIONS.length <= 200, `${steward.STEWARD_INSTRUCTIONS.length} 字`);
  check('系统管家身份卡没有边界话术', !BANNED.test(steward.STEWARD_INSTRUCTIONS));

  console.log('\n② 平台行为契约（每轮注入，优先级高于身份；P5 重写为 7 条）');
  const contract = dispatch.platformContractBlock();
  check('有"优先级高于身份设定"的声明', /优先级高于身份设定/.test(contract));
  check('① 先判这一轮要交什么：问问题还是做事',
    /先判/.test(contract) && /(问问题|问答)/.test(contract) && /(做事|办事)/.test(contract));
  check('① 问问题 → 第一行直接回答（谁 / 哪个 / 能不能 / 归谁）',
    /第一行/.test(contract) && /直接回答/.test(contract) && /谁/.test(contract) && /哪个/.test(contract) && /能不能/.test(contract) && /归谁/.test(contract),
    contract.split('\n').find((l) => /直接回答/.test(l)) ?? '');
  check('① 问答题不许拿工作报告顶替答案 + 指向 bandi-report',
    /答案/.test(contract) && /(工作报告|工作汇报)/.test(contract) && /bandi-report/.test(contract));
  check('② 多问拆答 + 权责四层（归属方 / 授予方 / 持有者 / 能改的人）',
    /(多问|拆答|拆开|逐问|一问一答)/.test(contract) && /归属方/.test(contract) && /授予方/.test(contract) && /持有者/.test(contract) && /能改的人/.test(contract));
  check('③ 每个判断落源（文件:行 / 接口 / 数据）+ 查不到写"未验证"',
    /(落源|出处)/.test(contract) && /文件:行/.test(contract) && /(接口|数据)/.test(contract) && /未验证/.test(contract) && /(几条|哪些)/.test(contract));
  check('③ 证据放运行事件或卡里（不贴在对话里）',
    /(运行事件|事件)/.test(contract) && /(卡片|卡里|卡上)/.test(contract));
  // P4 交付声明协议（2026-11-09）：只认回话第一个非空行；P5 第 4 条字面保留「跑完 ≠ 完成」
  check('④ 交付声明：跑完 ≠ 完成，只认第一行 [完成] / [受阻]',
    /\[完成\]/.test(contract) && /\[受阻\]/.test(contract) && /跑完[^。\n]*≠/.test(contract) && /第一行/.test(contract),
    contract.split('\n').find((l) => /\[完成\]/.test(l)) ?? '');
  check('④ 交付声明：平台只按第一行判卡状态 / 没做完不许写 [完成] / 不许替雇主宣布验收通过',
    /只按第一行判/.test(contract) && /卡/.test(contract) && /没做完不许写/.test(contract) && /不许替雇主宣布/.test(contract));
  check('⑤ 问进度只答台账（状态/更新/下一步，不追细节）', /只答台账/.test(contract) && /(不要|别)为了补细节/.test(contract));
  check('⑤ 够答即回（别为"更完整"继续翻）', /够答即回/.test(contract));
  check('⑥ 不空转（先做完再回话）+ Next: 禁令', /(不空转|先做完再回话)/.test(contract) && /Next:/.test(contract));
  check('⑥ 不编数 + 不猜接口（别 foreach 试路径）', /不编数/.test(contract) && /不猜接口/.test(contract) && /foreach/.test(contract));
  check('⑦ 红线：删数据 / 动生产 / 对外发布', /删数据/.test(contract) && /(动生产|生产)/.test(contract) && /对外发布/.test(contract));

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
    status: '进行中',
    projectName: '班底',
    source: 'board',
  };
  const tca = dispatch.taskContractBlock({ card: answerCard });
  check('answer 卡：目标带卡标题 + 项目', /目标：「数字员工的权限问题」/.test(tca) && /项目：班底/.test(tca), tca.split('\n').slice(0, 3).join(' / '));
  check('answer 卡：交付形态 = 问答（第一行直接回答）', /交付形态/.test(tca) && /(问答|回答)/.test(tca) && /第一行/.test(tca));
  check('answer 卡：交付要"答案"、验收要"每一问"', /答案/.test(tca) && /每一问/.test(tca), tca.split('\n').filter((l) => /交付|验收/.test(l)).join(' / '));
  const tcd = dispatch.taskContractBlock({ card: { title: '修时区', description: '修时区，改完提交', source: 'board' } });
  check('do 卡：验收仍钉"结论先行、依据可核、可拍板"',
    /结论先行/.test(tcd) && /可核/.test(tcd) && /可拍板/.test(tcd), tcd.split('\n').find((l) => /验收/.test(l)) ?? '');
  const tcc = dispatch.taskContractBlock({ card: { title: '修首页文案', description: '标题改短', status: '进行中', projectName: '班底' } });
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
  check('按 opts.taskId 现查 workflow_tasks（流程节点进入合同）', /opts\.taskId \? store\.getWorkflowTask\(opts\.taskId\)/.test(src));
  check('startMemberRun 拼了 platformContractBlock + 结构化 taskContractBlock（卡/流程/项目/台账都传）',
    /const contractBlock = \[[\s\S]*?platformContractBlock\(\),[\s\S]*?taskContractBlock\(\{[\s\S]{0,200}?card: opts\.card[\s\S]{0,200}?workflow: workflowTask[\s\S]{0,200}?project[\s\S]{0,200}?tasks: myTasks[\s\S]{0,120}?\}\)/.test(src));
  check('契约进了 fullTask（每轮交给运行时）', /fullTask = \[[^\]]*contractBlock/.test(src));
  check('每轮按本人查未完成任务台账（P3a，所有员工通用）', /store\.listMyOpenTasks\(member\.personaId, 5\)/.test(src));
  check('旧的"汇报口径"不再只写在 PM 首轮 brief 里', !/【汇报口径｜结论先行】/.test(src));

  const runsSrc = fs.readFileSync(new URL('./runs.mjs', import.meta.url), 'utf8');
  check('运行钥匙提醒里不再重复汇报格式（已在平台契约里）', !/汇报（每轮都算/.test(runsSrc));
  // P5（2026-11-09）：这层是**操作说明**，不是权限/交付说明 —— 查台账那段与平台契约重复，
  // 且被问"权限归谁"时模型会把它当答案素材复读。只留"怎么用钥匙"，故断言它不再带台账口径。
  const briefSrc = runsSrc.match(/function runCredentialBrief[\s\S]*?\n\}/)?.[0] ?? '';
  check('运行钥匙提醒只讲"怎么用钥匙"（P5 起不再复读查台账）',
    /BANDI_RUN_TOKEN/.test(briefSrc) && /不要抄历史命令/.test(briefSrc) && !/api\/tasks/.test(briefSrc));
  console.log('\n⑥ 任务台账：每个员工都能看到自己未完的卡（P3a，不是只给某个人）');
  const store = await import('./store.mjs');
  const dev = store.createPersona({ name: '台账测试员', runtime: 'codex', cwd: tmp, instructions: '' });
  const other = store.createPersona({ name: '另一个员工', runtime: 'codex', cwd: tmp, instructions: '' });
  const proj = store.createProject({ name: '台账项目', root: tmp });
  const mk = (title, status, assigneePersonaId = dev.id) =>
    store.createProjectTask({ projectId: proj.id, title, status, assigneePersonaId });
  mk('卡A（待办）', '待办');
  mk('卡B（进行中）', '进行中');
  mk('已完成卡', '已完成');
  mk('已取消卡', '已取消');
  mk('别人的卡', '待办', other.id);
  const rows = store.listMyOpenTasks(dev.id, 5);
  check('只列自己的未完卡（排除已完成/已取消/别人的）',
    rows.length === 2 && rows.every((r) => r.title.startsWith('卡')), JSON.stringify(rows.map((r) => r.title)));
  const g = store.createGroup({ title: '台账群', assistantPersonaId: dev.id });
  // createGroup 返回的是群的**会话行**（建群顺手建一段群会话）；群本身的 id 在 groupId
  store.createProjectTask({ projectId: proj.id, title: '团队卡', status: '待办', assigneeGroupId: g.groupId });
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
