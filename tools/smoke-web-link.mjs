/**
 * 「连不上模型」这条状态的纯函数验收（2026-11-19，起因：用户实报
 * "连不上模型，要让我直接能看到你在重连，我看到会处理的"）。
 *
 * 钉住四件事：
 *   ① 运行级 error 里的通道特征 → 进 `link`，**不进** `error`（红字不能永久驻留）；
 *   ② `linkWaitMs` 随时间走（"已等 43 秒"是每秒重画算出来的，不是事件带的）；
 *   ③ 任何非 error 事件 = 通道回来了 → link 清空 + 闪一帧"连上了"；
 *   ④ 到收尾还没恢复 → 结论行说得出来"模型没连上"，不是干巴巴的"出错了"。
 *
 * 顺带钉住反向：真·任务错误（401 / 语法错）**不许**被当成通道问题。
 * 纯逻辑、无 DOM：node tools/smoke-web-link.mjs
 */
import { applyRunEvent, createRunProgress, fmtSince, linkText, progressView, waitText } from '../apps/web/js/run-progress.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const SEC = 1000;
const now = Date.parse('2026-11-19T18:40:00.000Z');
const at = (s) => now + s * SEC;

const RELINK = (n, t = 5) => ({
  type: 'error',
  message: `Reconnecting... ${n}/${t}  WorkBuddy AI: ECONNRESET (502: you can retry your request)`,
});

const mk = () => createRunProgress({ startedAt: now - 60 * SEC, now });

/* ---------------------------------------------- ① 重连事件 → link，不是 error */
console.log('\n① 重连中：进 link、不进 error（红字不能常驻，重连成功它就骗人了）');

const s1 = mk();
applyRunEvent(s1, { type: 'status', phase: 'turn_start' }, at(0));
applyRunEvent(s1, RELINK(1), at(1));

check('link 有值', !!s1.link, JSON.stringify(s1.link?.attempt));
check('抠出了重连轮次 1/5', s1.link.attempt === 1 && s1.link.total === 5, `${s1.link?.attempt}/${s1.link?.total}`);
check('state.error 是空的（不写红字）', s1.error === '', JSON.stringify(s1.error));
check('phase 不是 error（它还在自救，不是"出错了"）', s1.phase !== 'error', s1.phase);

const v1 = progressView(s1, at(43));
check('linkWaitMs = 42 秒（事件在 1 秒时落）', v1.linkWaitMs === 42 * SEC, String(v1.linkWaitMs));
check('文案里能给"已等 42 秒"', fmtSince(v1.linkWaitMs) === '42 秒', fmtSince(v1.linkWaitMs));
check(
  '卡片那一行：连不上模型 · 正在重连 1/5 · 已等 42 秒',
  linkText(v1) === '连不上模型 · 正在重连 1/5 · 已等 42 秒',
  linkText(v1),
);
check('重连期间不算 justRecovered', v1.justRecovered === false);

applyRunEvent(s1, RELINK(2), at(60));
check('第二次重连换成了 2/5', s1.link.attempt === 2, String(s1.link?.attempt));
check('计时从**最近一次**重连算起（已等 3 秒）', progressView(s1, at(63)).linkWaitMs === 3 * SEC, String(progressView(s1, at(63)).linkWaitMs));

/* ---------------------------------------------- ② 长时间重连不被"卡住"盖掉 */
console.log('\n② 重连拖到 8 分钟：仍是"连不上模型在重连"，不许被"可能卡住了"顶掉');

applyRunEvent(s1, RELINK(5), at(2));
const v2 = progressView(s1, at(2 + 8 * 60));
check('8 分钟没别的事件 → stalled 也成立了', v2.stalled === true, String(v2.stalled));
check('但 link 仍非空（界面按 link 报重连，不报卡住）', !!v2.link, '');
check('已等多久说得出来', fmtSince(v2.linkWaitMs) === '8 分钟', fmtSince(v2.linkWaitMs));
check('8 分钟那一行报的是重连，不是卡住', /^连不上模型 · 正在重连 5\/5 · 已等 8 分钟$/.test(linkText(v2)), linkText(v2));

/* ---------------------------------------------- ③ 恢复 */
console.log('\n③ 通道回来了：link 清空，闪一帧"连上了"，6 秒后让位');

const s3 = mk();
applyRunEvent(s3, RELINK(3), at(0));
applyRunEvent(s3, { type: 'thinking', text: '嗯，先看仓库' }, at(10));
check('任何非 error 事件都算通了 → link 清空', s3.link === null, JSON.stringify(s3.link));
check('记下恢复时刻', s3.recoveredAt === at(10), String(s3.recoveredAt));
check('恢复后 3 秒：justRecovered', progressView(s3, at(13)).justRecovered === true);
check('恢复后那一行不再报重连（空串）', linkText(progressView(s3, at(13))) === '', linkText(progressView(s3, at(13))));
check('恢复 7 秒后：不再闪（回到正常日志）', progressView(s3, at(17)).justRecovered === false);
check('恢复后 state.error 仍是空的（不留下假故障）', s3.error === '', s3.error);

/* ---------------------------------------------- ④ 到收尾都没连上 */
console.log('\n④ 一直没连上就收尾：结论行写得出原因');

const s4 = mk();
applyRunEvent(s4, RELINK(5), at(0));
applyRunEvent(s4, { type: '__done', status: 'failed', elapsedMs: 12 * SEC }, at(12));
const v4 = progressView(s4, at(12));
check('link 已清（不会定格成"还在重连"）', v4.link === null, '');
check('error 写明"模型没连上"', /模型没连上/.test(v4.error), v4.error);
check('带上真因', /ECONNRESET|502/.test(v4.error), v4.error);
check('是失败态（不是 done）', v4.phase === 'error' && v4.done === true, `${v4.phase}/${v4.done}`);

/* ---------------------------------------------- ⑤ 反向：真错误不许冒充通道问题 */
console.log('\n⑤ 反向：任务自己的错（401 / 语法错 / 工具报错）不许进 link');

for (const [label, evt] of [
  ['账号 401', { type: 'error', message: "WorkBuddy refused this account's sign-in (401)" }],
  ['代码报错', { type: 'error', message: 'SyntaxError: Unexpected token in JSON at position 3' }],
  ['权限被拒', { type: 'error', message: 'permission denied: EACCES' }],
]) {
  const s = mk();
  applyRunEvent(s, evt, at(1));
  check(`${label}：走老路（error 有值、link 空）`, s.link === null && s.error !== '', `${s.link}/${s.error.slice(0, 30)}`);
}

const s6 = mk();
applyRunEvent(s6, { type: 'tool_call', callId: 'x', tool: 'shell', input: { command: 'curl https://x' } }, at(0.5));
applyRunEvent(s6, { type: 'tool_result', callId: 'x', status: 'error', result: 'curl: (28) ETIMEDOUT' }, at(1));
check('工具自己超时（tool_result）不算通道断', s6.link === null && s6.steps[0]?.error.includes('ETIMEDOUT'), JSON.stringify(s6.steps[0]?.status));

/* ---------------------------------------------- ⑥ 静默期：等模型回话 vs 走了一半停住 */
console.log('\n⑥ 静默期两种说法不能混（用户实拍："他这个是在尝试连接吗"）');

const q = progressView(mk(), at(64));
check('一步没走 + 静默 → 「等模型回话」', waitText(q) === '等模型回话 · 已等 1 分 4 秒', waitText(q));
check('不说"还没有动作"（那句像在说它偷懒）', !/还没有动作/.test(waitText(q)), waitText(q));

const s7 = mk();
applyRunEvent(s7, { type: 'tool', name: 'shell', input: { command: 'ls' } }, at(5));
const q2 = progressView(s7, at(95));
check('走过一步后停住 → 「最后动作在 N 前」', /^最后动作在 1 分钟前$/.test(waitText(q2)), waitText(q2));

/* ---------------------------------------------- ⑦ fmtSince 各档 */
console.log('\n⑦ 时长说人话');
check('5 秒', fmtSince(5 * SEC) === '5 秒', fmtSince(5 * SEC));
check('59 秒', fmtSince(59 * SEC) === '59 秒', fmtSince(59 * SEC));
check('2 分 10 秒', fmtSince(130 * SEC) === '2 分 10 秒', fmtSince(130 * SEC));
check('5 分钟整', fmtSince(300 * SEC) === '5 分钟', fmtSince(300 * SEC));
check('1 小时 5 分', fmtSince(3900 * SEC) === '1 小时 5 分', fmtSince(3900 * SEC));

console.log(failed === 0 ? '\n全过' : `\n${failed} 项未过`);
process.exit(failed === 0 ? 0 : 1);
