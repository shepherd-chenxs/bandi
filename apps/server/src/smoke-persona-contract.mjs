/**
 * smoke-persona-contract.mjs —— 身份与职责检修（2026-11-09 P0）的验收。
 *
 * 用户实拍：数字员工回复信息一大堆、不利于管理者决策；怀疑"职责与身份设定"起了反作用。
 * P0 的修法是**把行为规则从身份里搬出来、改成每轮注入**：
 *   ① 14 个专家 + 系统管家的出厂身份卡只回答"我是谁"（≤240 字，不写边界/流程/禁令）；
 *   ② 平台行为契约（platformContractBlock）每轮注入，优先级声明高于身份；
 *   ③ 本轮任务合同（taskContractBlock）每轮注入，卡评论区带上卡标题与验收标准；
 *   ④ 汇报口径不再只给项目经理（旧 pmCardBrief 里的那段已搬走）。
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

  console.log('\n② 平台行为契约（每轮注入，优先级高于身份）');
  const contract = dispatch.platformContractBlock();
  check('有"优先级高于身份设定"的声明', /优先级高于身份设定/.test(contract));
  check('结论先行 + ≤3 条依据 + 证据去处 + 已做动作', /结论/.test(contract) && /3 条依据/.test(contract) && /证据不贴在对话里/.test(contract) && /已做完/.test(contract));
  check('Next: 禁令与不空转纪律', /Next:/.test(contract) && /先做完再回话/.test(contract));
  check('不编数 + 删数据/生产/对外发布红线', /不编数/.test(contract) && /删数据/.test(contract) && /对外发布/.test(contract));
  check('指向 bandi-report 模板（首轮技能清单在，这里给全文入口）', /bandi-report/.test(contract));

  console.log('\n③ 本轮任务合同（每轮注入）');
  const tc = dispatch.taskContractBlock();
  check('有目标 / 受众 / 交付 / 验收四段', /目标/.test(tc) && /受众/.test(tc) && /交付/.test(tc) && /验收/.test(tc));
  check('验收钉"结论先行、依据可核、可拍板"', /结论先行/.test(tc) && /可核/.test(tc) && /可拍板/.test(tc));
  const tcc = dispatch.taskContractBlock({ card: { title: '修首页文案' } });
  check('卡评论区派活带上卡标题', /本卡：修首页文案/.test(tcc), tcc.split('\n').pop());

  console.log('\n④ 挂线：每轮派活都拼契约（不是首轮/不是 PM 专属）');
  const src = fs.readFileSync(new URL('./dispatch.mjs', import.meta.url), 'utf8');
  check('startMemberRun 拼了 platformContractBlock + taskContractBlock', /const contractBlock = \[platformContractBlock\(\), taskContractBlock\(\{ card: opts\.card \}\)\]/.test(src));
  check('契约进了 fullTask（每轮交给运行时）', /fullTask = \[[^\]]*contractBlock/.test(src));
  check('旧的"汇报口径"不再只写在 PM 首轮 brief 里', !/【汇报口径｜结论先行】/.test(src));

  const runsSrc = fs.readFileSync(new URL('./runs.mjs', import.meta.url), 'utf8');
  check('运行钥匙提醒里不再重复汇报格式（已在平台契约里）', !/汇报（每轮都算/.test(runsSrc));
} catch (err) {
  failed += 1;
  console.error('\n✗ 冒烟跑挂了：', err?.message ?? err);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ 有 ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
