/**
 * 台账核对（task-claim-audit）—— 2026-11-14 用户拍板"做"的硬校验。
 *
 * 背景：贺韬报「已派研发实现卡给嘉辉（pt-8c1b3d2f doing）」，台账里根本没有这张卡
 * —— 提示词压不住模型的虚构，这里用确定性核对兜底。
 *
 * 冒烟范围：
 *   ① claimedCards 的句子归组与完成声明抽取（隔句的"已完成"不算这张卡的）；
 *   ② auditRunReply 对真台账：存在性 + 完成声明两档不一致都能抓到，对得上的不误报；
 *   ③ auditAndNotify 真的发更正进会话（必落库）+ 同一处 10 分钟去重。
 * dispatchEventToThread 会尝试唤醒经办人 —— 冒烟里没接运行时，起跑失败按它的
 * "不抛错"口径走，更正消息照常落库（这正是要断言的东西）。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-claim-audit-'));
/* BANDI_DATA / BANDI_DB 必须在 import 之前设好（store 在 import 时开库） */
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' — ' + detail}`);
  if (!ok) failed += 1;
};

const store = await import('./store.mjs');
const audit = await import('./task-claim-audit.mjs');

console.log('\n① 声称抽取：句子归组，完成词只算同句的卡');
const parsed = audit.claimedCards(
  '已派研发实现卡给嘉辉（pt-8c1b3d2f doing）。\npt-41cda6ce 标记完成。\n设计稿见 pt-5dcfd24c。',
);
check('三张卡都抽到', parsed.length === 3, JSON.stringify(parsed));
check('虚构卡无完成词、PRD 卡有完成声明',
  parsed.find((c) => c.id === 'pt-8c1b3d2f')?.doneClaim === false &&
    parsed.find((c) => c.id === 'pt-41cda6ce')?.doneClaim === true,
  JSON.stringify(parsed));
const crossSentence = audit.claimedCards('pt-41cda6ce 在嘉辉手上。\n验收已完成，等下一轮。');
check('隔句的"已完成"不算这张卡的完成声明（防误报）',
  crossSentence.find((c) => c.id === 'pt-41cda6ce')?.doneClaim === false, JSON.stringify(crossSentence));

console.log('\n② 对真台账核对：存在性 + 完成声明');
const project = store.createProject({ name: '爻鉴', root: tmp });
const persona = store.createPersona({ name: '贺韬', role: '项目经理' });
const other = store.createPersona({ name: '沈丹青', role: 'UI 设计师' });
const doneCard = store.createProjectTask({ projectId: project.id, title: 'PRD 落盘', status: 'done' });
const reviewCard = store.createProjectTask({ projectId: project.id, title: 'IA 稿', status: 'review', createdBy: persona.id });
const conv = store.ensureConversationForPersona(persona.id);
check('夹具就位：done 卡 / review 卡 / 会话', !!doneCard && !!reviewCard && !!conv, `${doneCard?.id}/${reviewCard?.id}`);

const run = { conversationId: conv.id, personaId: persona.id, finalText: `已派研发实现卡给嘉辉（pt-8c1b3d2f doing）。` };
const m1 = audit.auditRunReply({ run });
check('虚构卡号 → 存在性不一致', m1.length === 1 && m1[0].kind === 'missing' && m1[0].id === 'pt-8c1b3d2f', JSON.stringify(m1));

const run2 = { conversationId: conv.id, personaId: persona.id, finalText: `卡 ${doneCard.id} 标记完成。` };
check('真 done 卡声称完成 → 不误报', audit.auditRunReply({ run: run2 }).length === 0, JSON.stringify(audit.auditRunReply({ run: run2 })));

const run3 = { conversationId: conv.id, personaId: persona.id, finalText: `卡 ${reviewCard.id} 标记完成。` };
const m3 = audit.auditRunReply({ run: run3 });
check('声称已完成、台账还在待验收 → 状态不一致（21:46 实报的形态）',
  m3.length === 1 && m3[0].kind === 'status' && m3[0].actual === 'review', JSON.stringify(m3));

console.log('\n②-b 执行声明：声称"已执行"必须有本轮 tool 事件佐证（崔老三关机虚报）');
const runWithTool = store.createRun({ conversationId: conv.id, runtime: 'rt-fake', personaId: persona.id });
store.appendRunEvent(runWithTool.id, 1, { type: 'tool', name: 'Bash', input: { command: 'shutdown /s /t 1800' } });
const lieText = '已执行 `shutdown /s /t 1800`（30 分钟后自动关机）。';
check('真调过工具的"已执行" → 不误报',
  audit.auditRunReply({ run: { conversationId: conv.id, personaId: persona.id, id: runWithTool.id, finalText: lieText } }).length === 0,
  JSON.stringify(audit.auditRunReply({ run: { conversationId: conv.id, personaId: persona.id, id: runWithTool.id, finalText: lieText } })));
const m4 = audit.auditRunReply({ run: { conversationId: conv.id, personaId: persona.id, id: 'run-no-tools', finalText: lieText } });
check('没调工具就报"已执行" → 抓（thinking 里想过不算）',
  m4.length === 1 && m4[0].kind === 'exec' && /没有任何工具调用/.test(m4[0].line), JSON.stringify(m4));
const pastRef = { conversationId: conv.id, personaId: persona.id, id: 'run-no-tools', finalText: '昨天已执行 `shutdown /s /t 1800`，本次无需重复。' };
check('历史引用（昨天已执行）→ 不算本轮声明', audit.auditRunReply({ run: pastRef }).length === 0, JSON.stringify(audit.auditRunReply({ run: pastRef })));

console.log('\n②-c 文件路径核对：声称落盘的文件必须真的存在（沈丹青实报的形态）');
// 夹具：项目根 = tmp，造一个真实存在的文件 + 一个绝对路径引用
fs.mkdirSync(path.join(tmp, 'doc'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'doc', '元仓-产品设计.md'), '内容', 'utf8');
const realRel = 'doc/元仓-产品设计.md';
const runFileOk = { conversationId: conv.id, personaId: persona.id, finalText: `PRD 已落盘：${realRel}（10KB）。` };
check('真落盘的相对路径 → 不误报', audit.auditRunReply({ run: runFileOk }).length === 0,
  JSON.stringify(audit.auditRunReply({ run: runFileOk })));
const runFileAbs = { conversationId: conv.id, personaId: persona.id, finalText: `PRD 已落盘：${path.join(tmp, 'doc', '元仓-产品设计.md')}。` };
check('真落盘的绝对路径（落在注册项目根里）→ 不误报', audit.auditRunReply({ run: runFileAbs }).length === 0,
  JSON.stringify(audit.auditRunReply({ run: runFileAbs })));
const runFileGhost = { conversationId: conv.id, personaId: persona.id, finalText: '稿件已落盘可验，证据：doc/元仓-信息架构稿.md、.workbuddy/preview/yuancang-hi.html。' };
const mFile = audit.auditRunReply({ run: runFileGhost });
check('声称落盘但文件不存在 → 抓（沈丹青实报的形态）',
  mFile.length === 2 && mFile.every((x) => x.kind === 'file'), JSON.stringify(mFile));
const runFuture = { conversationId: conv.id, personaId: persona.id, finalText: '我建议复制一份到 doc/元仓-预览稿.html，你双击打开。' };
check('提案句（建议复制到某路径）→ 不当"已落盘"抓', audit.auditRunReply({ run: runFuture }).length === 0,
  JSON.stringify(audit.auditRunReply({ run: runFuture })));
// 2026-11-15 张坤实报的误报形态：否定式诊断（查了、均不可用）—— 路径是"报告不存在"，
// 不是"声称存在"，绝不能核对
const runNegative = {
  conversationId: conv.id,
  personaId: persona.id,
  finalText: '已查：git 命令、C:\\Program Files\\Git\\bin\\git.exe、C:\\Program Files (x86)\\Git\\bin\\git.exe 均不可用',
};
check('否定式诊断（查了、均不可用）→ 不当"声称存在"抓（2026-11-15 误报回归）',
  audit.auditRunReply({ run: runNegative }).length === 0, JSON.stringify(audit.auditRunReply({ run: runNegative })));

console.log('\n④ 卡停留升级：review 停 4h / blocked 停 24h 没人管 → 信箱催一把');
const pt = await import('./project-tasks.mjs');
const { db: dbh } = await import('./store/db.mjs');
const stale = store.createProjectTask({ projectId: project.id, title: '停在待验收的老卡', status: 'review' });
dbh.prepare('UPDATE project_tasks SET updatedAt = ? WHERE id = ?')
  .run(new Date(Date.now() - 6 * 3600 * 1000).toISOString(), stale.id); // 拨回 6 小时前，模拟停留
const escalated = pt.escalateStaleCards({ reviewHours: 4, blockedHours: 24 });
check('review 停 6 小时 → 信箱升级一条', escalated.length === 1 && /停在「待验收」/.test(escalated[0]?.title ?? ''),
  JSON.stringify(escalated.map((n) => n.title)));
check('节流：10 分钟内再扫 → 不重复', pt.escalateStaleCards({ reviewHours: 4, blockedHours: 24 }).length === 0, '');
// 跨节流窗口 + 跨重启的去重：dedupeKey 落在通知上（同 key 合并成一条，count 叠加）
const laterSweep = pt.escalateStaleCards({ reviewHours: 4, blockedHours: 24, nowMs: Date.now() + 11 * 60 * 1000 });
check('跨节流窗口再扫 → 同一轮停留不重复发（escalatedKeys 挡住）', laterSweep.length === 0, JSON.stringify(laterSweep));
check('升级通知带 dedupeKey（跨重启也合并，不刷屏）',
  (escalated[0]?.dedupeKey ?? '').startsWith('escalate:review:'), escalated[0]?.dedupeKey ?? '');
check('信箱里这条升级已存在 → 再扫也不再发（跨重启的重复也挡住）',
  pt.escalateStaleCards({ reviewHours: 4, blockedHours: 24, nowMs: Date.now() + 21 * 60 * 1000 }).length === 0, '');

console.log('\n⑤ 同题去重：15 分钟内别人刚建的同题卡 → 指路（贺韬/嘉辉实报）');
const fresh = store.createProjectTask({ projectId: project.id, title: '元仓页视觉与信息架构改版方案', status: 'todo', createdBy: other.id });
check('别人 15 分钟内建的同题卡 → 命中并指路', pt.findRecentSameTitle({ projectId: project.id, title: ' 元仓页视觉与信息架构改版方案 ', exceptPersonaId: 'p-other' })?.id === fresh.id, '');
check('本人重建 → 不拦（有意重建是合法的）', pt.findRecentSameTitle({ projectId: project.id, title: '元仓页视觉与信息架构改版方案', exceptPersonaId: other.id }) === null, '');
store.updateProjectTask(fresh.id, { createdBy: other.id });
check('换人签名后仍命中（按 createdBy 判）', pt.findRecentSameTitle({ projectId: project.id, title: '元仓页视觉与信息架构改版方案', exceptPersonaId: 'p-third' })?.id === fresh.id, '');

console.log('\n⑥ 上下文更新闸：同事的新发言落在回复期间 → 简报提醒');
const freshMod = await import('./freshness.mjs');
// createGroup 直接返回第一段群会话（带 kind='group' / members）
const groupConv = store.createGroup({ title: '核对用群', assistantPersonaId: persona.id, memberIds: [other.id] });
const groupConvId = groupConv.id;
const runG = { conversationId: groupConvId, personaId: persona.id, watermark: 0 };
const peerMsg = store.addMessage({ conversationId: groupConvId, role: 'assistant', personaId: other.id, text: '元仓的数据来源我定了：本地记录，不走后端。' });
const replyMsg = store.addMessage({ conversationId: groupConvId, role: 'assistant', personaId: persona.id, text: '已收到。' });
const peers = freshMod.stalePeersOf({ run: runG, message: replyMsg });
check('同事新发言 → 检出并列名', !!peers && peers.length === 1 && peers[0].name === '沈丹青', JSON.stringify(peers));
check('简报说明"没变就不用回"（不制造确认噪音）', /没变就不用回/.test(freshMod.freshnessBrief(peers)), '');
const gateRun = { conversationId: groupConvId, personaId: persona.id, watermark: 0, finalText: '已收到。' };
const gateMsg = replyMsg;const beforeN = store.listMessages(groupConvId).length;
freshMod.freshnessGate({ run: gateRun, message: gateMsg });
const msgsAfter = store.listMessages(groupConvId);
check('闸触发知会条（列出谁说了什么；不带 @ —— 不唤醒任何人）',
  msgsAfter.length === beforeN + 1 && /上下文更新/.test(msgsAfter.at(-1).text) &&
    /沈丹青/.test(msgsAfter.at(-1).text) && !/@/.test(msgsAfter.at(-1).text),
  (msgsAfter.at(-1).text ?? '').slice(0, 120));
freshMod.freshnessGate({ run: gateRun, message: gateMsg });
check('5 分钟冷却：紧接着再来一次不重复发', store.listMessages(groupConvId).length === beforeN + 1, '');

console.log('\n③ 核对处置：把账做平 / 打回本人真做 / 打回不动才升级信箱');
// ③-1 状态类：验收人（建卡人）声称完成 → 验收决定已用文字表达，程序照办落 done —— 谎言被"做实"
const m3run = { conversationId: conv.id, personaId: persona.id, finalText: `卡 ${reviewCard.id} 标记完成。` };
audit.reconcile({ run: m3run });
check('验收人（建卡人）声称完成 → 程序落 done（把账做平）',
  store.getProjectTask(reviewCard.id).status === 'done', store.getProjectTask(reviewCard.id).status);
// ③-2 越权无效：非建卡人声称别人的卡完成 → 卡不动（真验收人自然会处理，平台不替他收货）
const cardX = store.createProjectTask({ projectId: project.id, title: '别人的卡', status: 'review', createdBy: persona.id });
const otherRun = { conversationId: conv.id, personaId: other.id, finalText: `卡 ${cardX.id} 标记完成。` };
audit.reconcile({ run: otherRun });
check('非建卡人声称完成 = 越权无效 → 卡不动（不改账）',
  store.getProjectTask(cardX.id).status === 'review', store.getProjectTask(cardX.id).status);
// ③-3 存在类：虚构派卡 → 打回本人真建（简报落库 @他）；再犯 → 升级信箱（最后手段，不是第一反应）
const beforeMsgs = store.listMessages(conv.id).length;
audit.reconcile({ run });
const afterBounce = store.listMessages(conv.id);
check('虚构派卡 → 打回本人真建（简报落库，不是给雇主的信）',
  afterBounce.length === beforeMsgs + 1 && /把它做掉/.test(afterBounce.at(-1).text),
  (afterBounce.at(-1).text ?? '').slice(0, 110));
const beforeNotice = store.listNotices().length;
audit.reconcile({ run });
check('打回后仍未建 → 升级信箱（最后手段）', store.listNotices().length === beforeNotice + 1, '');
audit.reconcile({ run });
check('信箱按 run 去重（不刷屏）', store.listNotices().length === beforeNotice + 1, '');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 库句柄还开着，删不掉就算了 */ }
if (failed) { console.log(`\n✗ ${failed} 项没过`); process.exit(1); }
console.log('\n✓ 全部通过');
