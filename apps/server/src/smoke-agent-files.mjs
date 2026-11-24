/**
 * **产物发进聊天**通道的验收（2026-11-23）。
 *
 * 病根：员工做出成片 / 图 / 报告，文件落在宝螺输出目录或工作区，bandi 聊天只认
 * <dataDir>/uploads/<会话>/ 下的附件 —— 雇主拿到一个本机路径点不开。
 * 修法：给员工一条工作证接口，把已做好的本地文件登记成本次会话附件，
 * 随回话落库，前端现成的 attsHtmlOf 画成可点 chip。
 *
 * 钉住四件事：
 *   ① 路由登记 + 运行钥匙可达 + 带人话 call（能力清单只读 route-policy）；
 *   ② 每轮注入文本里真的出现这条（登记了但不注入 = 续接会话还是"不知道能发文件"）；
 *   ③ 会话 id 从 run 取、不信客户端传参（防串会话）；目标死锁在 uploads/<会话>/；
 *   ④ 回话落库时带 atts（否则前端画不出 chip）。
 *
 * node apps/server/src/smoke-agent-files.mjs
 */
import fs from 'node:fs';
import { ROUTES } from './security/route-policy.mjs';
import { runCredentialBrief } from './capabilities.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const r = ROUTES.find((x) => x.id === 'agent.files');
const src = fs.readFileSync(new URL('./routes/agent-files.mjs', import.meta.url), 'utf8');
const runsSrc = fs.readFileSync(new URL('./runs.mjs', import.meta.url), 'utf8');

console.log('① 路由登记齐全（运行钥匙可达，带人话 call）');
check('agent.files 已登记', !!r);
check('是 POST', !!r && r.m.includes('POST'));
check('对运行钥匙开放', !!r && r.run === true);
check('有 call 文案', !!r && typeof r.call === 'string' && r.call === 'POST /api/agent/files');
check('note 写清了体格式', !!r && /path/.test(r.note ?? ''));

console.log('\n② 能力清单每轮都注入这条');
const brief = runCredentialBrief();
check('注入文本提到 POST /api/agent/files', brief.includes('POST /api/agent/files'));
check('注入文本写明了怎么带参（{path:…}）', /\{path:/.test(brief));
check('老通道没被挤掉', brief.includes('POST /api/agent/cards/batch'));

console.log('\n③ 安全边界：会话从 run 取、目标锁 uploads、幂等');
check('会话 id 从工作证的 run 取', /getRunRow\(cred\.runId\)/.test(src) && /conversationId/.test(src));
check('不信客户端传的会话 id（body 里没有 convId）', !/body\?\.conversationId|body\.conversationId/.test(src));
check('目标锁在 uploads/<会话>/', /path\.join\(uploadsRoot, convId\)/.test(src));
check('文件名过 safeName 闸', /safeName\(/.test(src));
check('只认普通文件', /statSync\(/.test(src) && /isFile\(\)/.test(src));
check('复制而非移动（不破坏员工产物）', /copyFileSync\(/.test(src));
check('幂等（按 runId + 源路径派生 key）', /sha1/.test(src) && /cred\.runId/.test(src));

console.log('\n④ 回话落库带 atts（前端才画得出可点 chip）');
check('persistReply 的 addMessage 带 atts', /atts:\s*run\.artifactAtts/.test(runsSrc));
check('普通轮次不带（null 兜底）', /artifactAtts\?\.length\s*\?\s*run\.artifactAtts\s*:\s*null/.test(runsSrc));
check('挂暂存的接口写的是 run.artifactAtts', /run\.artifactAtts/.test(src));

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
