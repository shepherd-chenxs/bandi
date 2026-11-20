/**
 * **交付动作**的验收（2026-11-19）。
 *
 * 病根：agent 是"发文本命令"型，一串确定性的运维流程要拆成 6 条命令 = 6 次模型往返，
 * 每次 40–60 秒；实报 r-4c85d92c 一整轮 15 分钟里 6 分钟是纯等待，命令本身只跑 6 秒。
 * 修法不是催它快点，是**平台提供动作**：一条命令做完一串，只回结论不回日志。
 *
 * 钉住四件事：
 *   ① 两条动作登记在路由表里、运行钥匙可达、带人话 call（能力清单只读这张表）；
 *   ② 权限位 `repo.deliver` 只给仓库管家 —— 不是人人能把东西推上去；
 *   ③ 能力清单注入文本里**真的出现**这两条（登记了但没注入 = 它还是不知道有通道）；
 *   ④ 交付**只到 PR 为止**，绝不自动合并（合并要等 CI 结论，不能一条命令带过）。
 *
 * node apps/server/src/smoke-agent-deliver.mjs
 */
import fs from 'node:fs';
import { ROUTES } from './security/route-policy.mjs';
import { ROLES, PERMISSIONS } from './roles.mjs';
import { runCredentialBrief } from './capabilities.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const byId = (id) => ROUTES.find((r) => r.id === id);
const src = fs.readFileSync(new URL('./routes/agent-deliver.mjs', import.meta.url), 'utf8');

console.log('① 两条动作登记齐全（运行钥匙可达，且带人话 call）');
for (const id of ['agent.gate', 'agent.deliver']) {
  const r = byId(id);
  check(`${id} 已登记`, !!r);
  check(`${id} 是 POST`, !!r && r.m.includes('POST'));
  check(`${id} 对运行钥匙开放`, !!r && r.run === true);
  check(`${id} 有 call 文案`, !!r && typeof r.call === 'string' && r.call.includes('/api/'));
  check(`${id} 有 note`, !!r && typeof r.note === 'string' && r.note.length > 10);
}

console.log('\n② 交付权只给仓库管家');
check('权限表里有 repo.deliver', Object.prototype.hasOwnProperty.call(PERMISSIONS, 'repo.deliver'));
const keeper = ROLES.find((r) => r.key === 'repo-keeper');
const pm = ROLES.find((r) => r.key === 'pm');
const dev = ROLES.find((r) => r.key === 'dev');
check('仓库管家有 repo.deliver', !!keeper && keeper.permissions.includes('repo.deliver'));
check('项目经理没有 repo.deliver', !!pm && !pm.permissions.includes('repo.deliver'));
check('研发工程师没有 repo.deliver', !!dev && !dev.permissions.includes('repo.deliver'));

console.log('\n③ 能力清单注入文本里真的出现这两条');
const brief = runCredentialBrief();
check('注入文本提到 POST /api/agent/gate', brief.includes('POST /api/agent/gate'));
check('注入文本提到 POST /api/agent/deliver', brief.includes('POST /api/agent/deliver'));
check('注入文本仍保留原有接口（没把老通道挤掉）', brief.includes('POST /api/agent/cards/batch'));

console.log('\n④ 只到 PR 为止，绝不自动合并');
check('源码不调合并', !/\.mergePull\(|mergeOne\(|pulls\/\$\{[^}]*\}\/merge/.test(src));
check('源码走的是 openPr（和界面按钮同一条路）', /git\.openPr\(/.test(src));
check('源码里带 push: true（提交/推送一起做，别让它另发一条命令）', /push:\s*true/.test(src));

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
