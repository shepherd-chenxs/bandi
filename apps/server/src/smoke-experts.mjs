/**
 * 专家库的验收（2026-10-22）。
 *
 * 只走**接口层**：目录在哪、雇了会发生什么、解聘删的是什么留的是什么、
 * 乱来的 key 会不会被好言相送 —— 这些都是人踩接口时才暴露的，函数层的幂等
 * 逻辑顺带在断言里覆盖（重复 hire 不重建）。
 *
 * 隔离：临时数据目录 + 独立端口，不碰 data/ 里的真账。
 * 跑法：node apps/server/src/smoke-experts.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-experts-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const PORT = Number(process.env.SMOKE_PORT ?? 8798);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (b) => { serverLog += b.toString(); });
child.stderr.on('data', (b) => { serverLog += b.toString(); });

const req = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers ?? {}) } });
  const text = await r.text();
  let b = null;
  try {
    b = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, b };
};

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(BASE + '/api/state')).ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('控制面起来了', up);
  if (!up) console.log(serverLog.split('\n').slice(-15).join('\n'));

  if (up) {
    /* ------------------------------- ① 目录：十四位，全都没雇佣 */
    console.log('\n① 目录：出厂十四位（秘书 + 技术轨八 + 内容轨五）、没人被偷偷雇佣（专家不 seed）');
    const d0 = await req('/api/experts');
    check('GET /api/experts → 200', d0.status === 200, String(d0.status));
    const list0 = d0.b?.experts ?? [];
    check('目录就是 14 位', list0.length === 14, list0.map((x) => x.key).join(','));
    check('头一个就是喜儿（2026-10-23 入驻，key=xier）', list0[0]?.key === 'xier', list0.map((x) => x.key).join(','));
    check('技术轨八位跟在后面（按用户口径排）', ['pm', 'lijun', 'architect', 'ui', 'jiahui', 'test', 'machao', 'qa'].every((k, i) => list0[i + 1]?.key === k), list0.map((x) => x.key).join(','));
    check('账号运营（季风）已撤出目录（改派系统管家）', !list0.some((x) => x.key === 'operator'), list0.map((x) => x.key).join(','));
    check('全都是未雇佣', list0.every((x) => x.hired === false && x.hiredPersona === null));
    check('固定 id（解聘再雇佣靠它接旧会话）', list0.every((x) => x.id === `p-expert-${x.key}`), list0.map((x) => x.id).join(','));
    check('每人都有名字 / 岗位 / 一句话简介', list0.every((x) => x.name && x.role && x.intro));
    check('技能都带 description（前端画标签不用再查技能接口）', list0.every((x) => x.skills.length >= 1 && x.skills.every((s) => s.name && s.description)));
    check('出厂员工只有内置管家一个（专家目录 ≠ 员工）', (await req('/api/state')).b.personas.every((p) => p.id !== 'p-expert-jiahui'));

    /* ------------------------------- ② 雇佣 jiahui：人进来、技能挂好 */
    console.log('\n② 雇佣：变成数字员工、技能开箱即挂');
    const h = await req('/api/experts/jiahui/hire', { method: 'POST' });
    check('第一次雇佣 → 201', h.status === 201, `${h.status} ${JSON.stringify(h.b?.code)}`);
    check('id 是固定那个', h.b?.persona?.id === 'p-expert-jiahui', h.b?.persona?.id);
    check('builtin = 0（解聘要删得掉）', h.b?.persona?.builtin === 0);
    check('岗位写上了', !!h.b?.persona?.role, h.b?.persona?.role);
    check('职责指令不是空壳', String(h.b?.persona?.instructions ?? '').length > 100);
    check('runtime = auto', h.b?.persona?.runtime === 'auto', h.b?.persona?.runtime);
    check('cwd = 平台根', h.b?.persona?.cwd === repoRoot, h.b?.persona?.cwd);

    const st = await req('/api/state');
    check('他进了通讯录', (st.b?.personas ?? []).some((p) => p.id === 'p-expert-jiahui'));
    const d1 = await req('/api/experts');
    const dev1 = (d1.b?.experts ?? []).find((x) => x.key === 'jiahui');
    check('目录里 hired:true', dev1?.hired === true);
    check('hiredPersona 给了改名前的名字和 id', dev1?.hiredPersona?.id === 'p-expert-jiahui' && !!dev1?.hiredPersona?.name, JSON.stringify(dev1?.hiredPersona));

    // 技能：直接查库（persona_skills 是唯一真源），少绕一层接口
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(tmp, 'bandi.db'), { readOnly: true });
    const linked = db.prepare('SELECT skillName FROM persona_skills WHERE personaId = ?').all('p-expert-jiahui').map((r) => r.skillName);
    db.close();
    check('岗位技能挂上了', linked.includes('bandi-expert-dev'), linked.join(',') || '(空)');
    check('通用技能也挂上了', ['test-driven-development', 'systematic-debugging', 'verification-before-completion'].every((s) => linked.includes(s)), linked.join(','));
    check('没挂目录之外的技能', linked.every((s) => dev1.skills.some((x) => x.name === s)), linked.join(','));

    /* ------------------------------- ③ 幂等：重复雇佣不报错不重复建 */
    console.log('\n③ 幂等：重复雇佣 → 200、不重建');
    const before = (await req('/api/state')).b.personas.length;
    const h2 = await req('/api/experts/jiahui/hire', { method: 'POST' });
    check('重复雇佣 → 200（不是报错）', h2.status === 200, String(h2.status));
    check('返回的还是同一个人', h2.b?.persona?.id === 'p-expert-jiahui');
    check('人数没变', (await req('/api/state')).b.personas.length === before, `${before}`);
    const h3 = await req('/api/experts/jiahui/hire', { method: 'POST' });
    check('连按三次也一样', h3.status === 200 && h3.b?.persona?.id === 'p-expert-jiahui');

    /* ------------------------------- ④ 解聘：人走、会话留 */
    console.log('\n④ 解聘：人从通讯录走、聊天记录留、目录退回未雇佣');
    const conv = await req('/api/conversations', { method: 'POST', body: JSON.stringify({ personaId: 'p-expert-jiahui', title: '和 嘉辉' }) });
    check('雇佣后能开会话（他就是个普通员工）', conv.status === 201, JSON.stringify(conv.b?.code));
    const convId = conv.b?.conversation?.id;
    const f = await req('/api/experts/jiahui/fire', { method: 'POST' });
    check('解聘 → 200 {removed:true}', f.status === 200 && f.b?.removed === true, JSON.stringify(f.b));
    check('人从通讯录没了', !(await req('/api/state')).b.personas.some((p) => p.id === 'p-expert-jiahui'));
    const d2 = await req('/api/experts');
    check('目录退回 hired:false', (d2.b?.experts ?? []).find((x) => x.key === 'jiahui')?.hired === false);
    const convAfter = await req(`/api/conversations/${encodeURIComponent(convId)}`);
    check('会话保留（解聘 ≠ 清聊天记录）', convAfter.status === 200, String(convAfter.status));

    /* ------------------------------- ⑤ 再雇佣：同一 id，旧会话接上 */
    console.log('\n⑤ 再雇佣：同一个 id、旧会话自动接上');
    const h4 = await req('/api/experts/jiahui/hire', { method: 'POST' });
    check('再雇佣 → 201', h4.status === 201, String(h4.status));
    check('还是同一个 id', h4.b?.persona?.id === 'p-expert-jiahui');
    const convAgain = await req(`/api/conversations/${encodeURIComponent(convId)}`);
    check('旧会话还在（按 personaId 归人，人回来了就接上）', convAgain.status === 200, String(convAgain.status));
    // 收尾解掉，别把状态带进后面的用例
    await req('/api/experts/jiahui/fire', { method: 'POST' });

    /* ------------------------------- ⑥ 乱来的 key：404 + 专家域错误码 */
    console.log('\n⑥ 未知 key：404 + E2051，hire / fire 都拦');
    const bad1 = await req('/api/experts/nope/hire', { method: 'POST' });
    check('hire 未知 key → 404', bad1.status === 404, String(bad1.status));
    check('错误码 E2051（专家域专用，全仓没撞号）', bad1.b?.code === 'E2051', bad1.b?.code);
    check('提示是中文、说得清', String(bad1.b?.error ?? '').includes('专家库'), bad1.b?.error);
    const bad2 = await req('/api/experts/nope/fire', { method: 'POST' });
    check('fire 未知 key → 404 + E2051', bad2.status === 404 && bad2.b?.code === 'E2051', `${bad2.status} ${bad2.b?.code}`);
    const bad3 = await req('/api/experts/jiahui/hire', { method: 'GET' });
    check('方法不对 → 405 + E2052（不是 500）', bad3.status === 405 && bad3.b?.code === 'E2052', `${bad3.status} ${bad3.b?.code}`);

    /* ------------------------------- ⑦ 解聘没雇佣的：不炸 */
    console.log('\n⑦ 解聘没雇佣的：removed:false，不报错');
    const f2 = await req('/api/experts/test/fire', { method: 'POST' });
    check('没雇佣就解聘 → 200 {removed:false}', f2.status === 200 && f2.b?.removed === false, JSON.stringify(f2.b));
    const f3 = await req('/api/experts/test/fire', { method: 'POST' });
    check('连解两次也一样', f3.status === 200 && f3.b?.removed === false);

    /* ------------------------------- ⑧ 全家桶：十四位都能雇能解 */
    console.log('\n⑧ 十四位各雇一轮再全解：目录行为一致');
    const ALL_KEYS = ['xier', 'pm', 'lijun', 'architect', 'ui', 'jiahui', 'test', 'machao', 'qa', 'keeper', 'editor', 'copywriter', 'analyst', 'director'];
    for (const k of ALL_KEYS) {
      const r = await req(`/api/experts/${k}/hire`, { method: 'POST' });
      check(`雇佣 ${k} → 201`, r.status === 201 && r.b?.persona?.id === `p-expert-${k}`, `${r.status}`);
    }
    const nAfter = (await req('/api/state')).b.personas.filter((p) => p.id.startsWith('p-expert-')).length;
    check('十四位都在通讯录', nAfter === 14, String(nAfter));
    for (const k of ALL_KEYS) {
      const r = await req(`/api/experts/${k}/fire`, { method: 'POST' });
      check(`解聘 ${k} → removed:true`, r.status === 200 && r.b?.removed === true);
    }
    const d3 = await req('/api/experts');
    check('目录全部退回未雇佣', (d3.b?.experts ?? []).every((x) => x.hired === false));
    check('通讯录回到只剩内置管家', (await req('/api/state')).b.personas.map((p) => p.id).join(',') === 'p-cuilaosan');

    /* ------------------------------- ⑨ 群助手保护：还是群助手时不许解聘 */
    console.log('\n⑨ 群助手保护：解聘被 409 E2053 拦下、人还在；群解散后畅通');
    await req('/api/experts/jiahui/hire', { method: 'POST' });
    // 走建群的正路：建群时直接指定他当群助手（前端「发起群聊」就是这个接口）
    const grp = await req('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ title: '开发群', assistantPersonaId: 'p-expert-jiahui' }),
    });
    check('建群 + 指定他为群助手 → 201', grp.status === 201, JSON.stringify(grp.b?.code));
    const gid = grp.b?.group?.id ?? grp.b?.group?.groupId;

    const blocked = await req('/api/experts/jiahui/fire', { method: 'POST' });
    check('还是群助手就解聘 → 409（不是 500）', blocked.status === 409, `${blocked.status} ${blocked.b?.code ?? ''}`);
    check('错误码 E2053（E2051/E2052 之后顺位，全仓无撞号）', blocked.b?.code === 'E2053', blocked.b?.code);
    check('提示说清了要先换掉群助手', String(blocked.b?.error ?? '').includes('群助手'), blocked.b?.error);
    check('带回群名单（控制台/详情用）', Array.isArray(blocked.b?.groups) && blocked.b.groups.some((g) => g.id === gid), JSON.stringify(blocked.b?.groups));
    check('人还在通讯录（没被删半截）', (await req('/api/state')).b.personas.some((p) => p.id === 'p-expert-jiahui'));
    check('目录里他还是 hired:true', (await req('/api/experts')).b.experts.find((x) => x.key === 'jiahui')?.hired === true);

    // 出路二选一：解散群（不抹记录）。解散后再来解聘，畅通
    const dz = await req(`/api/groups/${encodeURIComponent(gid)}`, { method: 'DELETE' });
    check('解散群 → 200', dz.status === 200, String(dz.status));
    const f4 = await req('/api/experts/jiahui/fire', { method: 'POST' });
    check('群没了 → 解聘畅通（removed:true）', f4.status === 200 && f4.b?.removed === true, JSON.stringify(f4.b));
    check('这次人真的从通讯录没了', !(await req('/api/state')).b.personas.some((p) => p.id === 'p-expert-jiahui'));
    check('目录退回 hired:false', (await req('/api/experts')).b.experts.find((x) => x.key === 'jiahui')?.hired === false);
  }
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 临时目录，删不掉就算了 */
  }
}

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
