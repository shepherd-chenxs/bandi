/**
 * **经验簿**的验收（2026-11-22，缺口①：员工没有长期记忆）。
 *
 * 钉住的不是"功能能跑"，而是**它的边界**——这块最容易退化成"又一个垃圾上下文"：
 *   ① 只收两类（口径 / 坑），正文超长截断，每人 200 条上限按"用得少的先删"淘汰；
 *   ② 同一个坑反复犯 = **一条 hits+1**，不是五条各说一遍（否则注入时全是重复）；
 *   ③ 采集只认平台核对写下的通知（kind='audit'），建卡失败那类不记成"他的坑"；
 *      同一个 run 收尾被重放也不该把次数刷成 2；
 *   ④ 注入有配额（口径 4 / 事实 3 / 坑 3）且按本轮任务相关度取；一条都没有时**不印空壳**；
 *   ⑤ 事实层只从**跑通**那一轮抽（命令 / 重启 / 常改文件），按仓库隔离，重复只累次数，
 *      只改过一次的文件不进注入；
 *   ⑥ 接口写入口径窄：第三类 400、清空要显式 ?all=1、不能跨人删；事实层只读 + 删。
 *
 * 跑法：node apps/server/src/smoke-experience.mjs
 * 隔离：临时数据目录 + 临时库 + 临时端口，跑完关库删目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '..', '..', '..');
const url = (rel) => pathToFileURL(path.join(repoRoot, 'apps', 'server', 'src', rel)).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-experience-'));
const DATA = path.join(tmp, 'data');
fs.mkdirSync(DATA, { recursive: true });
const PORT = Number(process.env.SMOKE_PORT ?? 8853);
const BASE = `http://127.0.0.1:${PORT}`;
process.env.BANDI_DATA = DATA;
process.env.BANDI_DB = path.join(DATA, 'bandi.db');
process.env.BANDI_HOST = '127.0.0.1'; // 回环 = 操作员，省掉每处带令牌
process.env.BANDI_PORT = String(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const store = await import(url('store.mjs'));
const exp = await import(url('experience.mjs'));

let db = null;
try {
  const me = store.createPersona({ name: '经验簿验收员', role: '研发工程师', roleKey: 'dev' });
  const other = store.createPersona({ name: '路人', role: '研发工程师', roleKey: 'dev' });
  const conv = store.createConversation({ kind: 'direct', title: '经验簿验收', personaId: me.id });

  console.log('① 只收两类、超长截断、重复合并不新增行');
  {
    check('一条都没有时注入块是空串（不印空壳）', exp.experienceBlock(me.id) === '');
    const a = store.addPersonaNote({ personaId: me.id, kind: 'repo', text: '服务端改完必须重启  才生效' });
    const b = store.addPersonaNote({ personaId: me.id, kind: 'repo', text: '服务端改完必须重启 才生效' });
    check('同一条口径重复写 → 合并、hits=2', a.merged === false && b.merged === true && b.note.hits === 2);
    check('只留一条（不是两行各说一遍）', store.listPersonaNotes(me.id, { kind: 'repo' }).length === 1);

    let rejected = '';
    try {
      store.addPersonaNote({ personaId: me.id, kind: 'diary', text: '今天聊了什么' });
    } catch (e) {
      rejected = e.message;
    }
    check('第三类（"日志/日记"）写不进去', /只有两类/.test(rejected), rejected);

    const long = store.addPersonaNote({ personaId: me.id, kind: 'repo', text: 'A'.repeat(500) });
    check('正文超 300 字被截断（超长说明它该是一份文档）', long.note.text.length <= 300, `${long.note.text.length} 字`);
    store.deletePersonaNote(long.note.id);

    for (let i = 0; i < 8; i += 1) store.addPersonaNote({ personaId: me.id, kind: 'pitfall', text: `填充坑 ${i}` });
    store.prunePersonaNotes(me.id, 3);
    check('超上限按"用得少的先删"，只留 3 条', store.listPersonaNotes(me.id, { limit: 50 }).length === 3);
    store.deletePersonaNotes(me.id);
  }

  console.log('② 采集：只从核对结论里取，反复犯只累次数');
  {
    const mk = (title, detail, kind = 'audit', i = 0) => {
      const run = store.createRun({ conversationId: conv.id, runtime: 'codex', personaId: me.id });
      store.addNotice({
        kind,
        title,
        detail,
        personaId: me.id,
        conversationId: conv.id,
        runId: run.id,
        dedupeKey: `smoke:${i}:${run.id}`,
      });
      return run;
    };
    const t = '【判据核对】声称完成，但岗位判据里的动作没有发生';
    const r1 = mk(t, '· 完成前跑过测试 —— 跑过的命令里没有：npm test', 'audit', 1);
    const r2 = mk(t, '· 完成前跑过测试 —— 跑过的命令里没有：pytest / npm run lint', 'audit', 2);
    const got1 = exp.harvest({ run: r1 });
    const got2 = exp.harvest({ run: r2 });
    check('第一条坑记下了', got1.length === 1 && got1[0].hits === 1);
    check(
      '同一个坑再犯一次 → 合并成一条、次数变 2（证据不同也不该长成两行）',
      got2.length === 1 && got2[0].merged === true && got2[0].hits === 2,
      got2[0]?.text,
    );
    check(
      '经验簿里的坑不带"这一轮的证据"（命令清单会变，只留"是哪一类错"）',
      !/npm test|pytest/.test(store.listPersonaNotes(me.id, { kind: 'pitfall' })[0]?.text ?? ''),
    );
    check('同一个 run 重放采集 → 不刷次数', exp.harvest({ run: r2 }).length === 0);
    const r3 = mk('建卡失败：E2059', '又失败了', 'card.create.failed', 3);
    check('建卡失败不记成"他的坑"（那是我方的问题）', exp.harvest({ run: r3 }).length === 0);
  }

  console.log('③ 注入：三类分开、有配额、按次数/相关度排、有总长上限');
  {
    store.addPersonaNote({ personaId: me.id, kind: 'repo', text: '服务端改完必须重启（18787 是壳拉起的）' });
    const block = exp.experienceBlock(me.id);
    check('块里同时有"口径"和"坑"两栏', /这个团队的口径/.test(block) && /踩过的坑/.test(block));
    check('反复犯的那条标了次数', /（2 次）/.test(block), block.match(/（\d+ 次）/)?.[0] ?? '');

    store.deletePersonaNotes(me.id);
    for (let i = 0; i < 12; i += 1) store.addPersonaNote({ personaId: me.id, kind: 'repo', text: `口径 ${i}` });
    for (let i = 0; i < 12; i += 1) store.addPersonaNote({ personaId: me.id, kind: 'pitfall', text: `坑 ${i}` });
    const big = exp.experienceBlock(me.id);
    const lines = big.split('\n').filter((l) => l.startsWith('  - '));
    check('口径只带 4 条、坑只带 3 条（7 行，不是 24 行）', lines.length === 7, `${lines.length} 行`);
    check('整块不超过上限（超了就不是提醒而是墙）', big.length <= exp.INJECT.blockMax + 1, `${big.length} 字`);
    check('路人的经验簿不受影响（按人隔离）', exp.experienceBlock(other.id) === '');
  }

  console.log('④ 事实层：只从跑通那轮抽、按仓库隔离、重复只累次数');
  {
    store.deletePersonaFacts(me.id);
    const ROOT = 'E:/Repo/One';
    const mkRun = (status) => {
      const row = store.createRun({ conversationId: conv.id, runtime: 'codex', personaId: me.id });
      return { id: row.id, personaId: me.id, status, root: ROOT, conversationId: conv.id };
    };
    const push = (runId, evt) => {
      const seq = store.maxRunSeq(runId) + 1;
      store.appendRunEvent(runId, seq, evt);
    };

    const okRun = mkRun('done');
    push(okRun.id, { type: 'tool', name: 'command_execution', detail: { command: 'node tools/run-smokes.mjs' } });
    push(okRun.id, { type: 'tool', name: 'command_execution', detail: { command: 'bandi restart' } });
    push(okRun.id, {
      type: 'tool',
      name: 'apply_patch',
      detail: {
        changes: [
          { path: 'E:/Repo/One/apps/server/src/a.mjs' },
          { path: 'E:/Repo/One/apps/server/src/a.mjs' },
          { path: 'E:/Repo/One/tmp/scratch.mjs' },
          { path: 'E:/Other/repo/b.mjs' },
        ],
      },
    });
    const got = exp.harvestFacts({ run: okRun });
    const kinds = store.listPersonaFacts(me.id).map((f) => f.kind).sort();
    check('跑通一轮 → 抽出命令 / 重启 / 常改文件', got.length === 3 && kinds.join(',') === 'command,path,restart', kinds.join(','));
    check(
      '临时目录与别的仓库的路径不记（按仓库根过滤）',
      store.listPersonaFacts(me.id).filter((f) => f.kind === 'path').map((f) => f.text).join() === '常改：apps/server/src/a.mjs',
    );
    check('同一个 run 重放采集 → 不刷次数', exp.harvestFacts({ run: okRun }).length === 0);

    const failRun = mkRun('failed');
    push(failRun.id, { type: 'tool', name: 'command_execution', detail: { command: 'npm test' } });
    check('没跑通的那轮不抽（没验证过的命令不进长期记忆）', exp.harvestFacts({ run: failRun }).length === 0);

    // 第二轮再跑一遍同样的命令与文件：hits 累加，不新增行
    const again = mkRun('done');
    push(again.id, { type: 'tool', name: 'command_execution', detail: { command: 'node tools/run-smokes.mjs' } });
    push(again.id, { type: 'tool', name: 'apply_patch', detail: { changes: [{ path: 'E:/Repo/One/apps/server/src/a.mjs' }] } });
    exp.harvestFacts({ run: again });
    const hit = store.listPersonaFacts(me.id).find((f) => f.text.startsWith('冒烟验证'));
    check('同一件事第二轮 → 一条 hits=2（不是两行）', hit?.hits === 2, `hits=${hit?.hits}`);

    // 别的仓库的事实不能带进这个仓的注入
    store.addPersonaFact({ personaId: me.id, scope: 'E:/Repo/Two', kind: 'command', text: '测试：npm test' });
    const recalled = exp.memoryBlock({ personaId: me.id, query: '帮我跑一下冒烟验证', root: ROOT });
    check('注入带上了该仓的事实', /冒烟验证/.test(recalled) && /重启/.test(recalled) && /常改：apps\/server\/src\/a\.mjs/.test(recalled));
    check('别的仓的事实不串进来', !/npm test/.test(recalled));
    check(
      '按本轮任务相关度排：最相关的第一条',
      recalled.split('\n').find((l) => l.startsWith('  - ') && /冒烟验证|重启|常改/.test(l))?.includes('冒烟验证'),
      recalled.split('\n').find((l) => l.startsWith('  - ') && /冒烟验证|重启|常改/.test(l)) ?? '',
    );

    store.deletePersonaFacts(me.id);
    const first = mkRun('done');
    push(first.id, { type: 'tool', name: 'apply_patch', detail: { changes: [{ path: 'E:/Repo/One/only-once.mjs' }] } });
    exp.harvestFacts({ run: first });
    check(
      '只改过一次的文件不进注入（多半是这一轮的临时脚本）',
      !/only-once\.mjs/.test(exp.memoryBlock({ personaId: me.id, query: 'only-once', root: ROOT })),
    );
  }

  console.log('⑤ 接口：写入口径窄，删要指得准');
  {
    await import(url('server.mjs'));
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      try {
        up = (await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(600) })).ok;
      } catch {
        await sleep(150);
      }
    }
    if (!up) throw new Error('控制面没起来');
    db = store;

    const base = `/api/personas/${encodeURIComponent(me.id)}/notes`;
    const send = async (method, rel, body) => {
      const r = await fetch(BASE + rel, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    const created = await send('POST', base, { text: '静态资源直读，改完不用重启', kind: 'repo' });
    check('POST 记一条口径 → 201', created.status === 201, String(created.status));
    const again = await send('POST', base, { text: '静态资源直读，改完不用重启', kind: 'repo' });
    check('重复 POST → 200 且 merged（同一条不涨行数）', again.status === 200 && again.body.merged === true);

    const bad = await send('POST', base, { text: '今天聊了什么', kind: 'diary' });
    check('第三类 → 400（不是悄悄当成口径存下）', bad.status === 400, bad.body?.error ?? '');
    const empty = await send('POST', base, { text: '   ' });
    check('空正文 → 400', empty.status === 400);

    const listed = await send('GET', base);
    check('GET 能列出条目', listed.status === 200 && (listed.body.notes ?? []).length > 0);

    const noteId = (listed.body.notes ?? [])[0]?.id;
    const cross = await send('DELETE', `/api/personas/${encodeURIComponent(other.id)}/notes/${noteId}`);
    check('不能跨人删（id 对但人不符 → 404）', cross.status === 404);

    const allRefused = await send('DELETE', base);
    check('不带 ?all=1 的清空请求被拒（防手滑）', allRefused.status === 400);
    const gone = await send('DELETE', `${base}/${noteId}`);
    check('删一条 → 200', gone.status === 200 && gone.body.removed === 1);
    const wiped = await send('DELETE', `${base}?all=1`);
    check('?all=1 → 清空并回条数', wiped.status === 200 && typeof wiped.body.removed === 'number');

    const missing = await send('GET', `/api/personas/${encodeURIComponent('p-nope')}/notes`);
    check('员工不存在 → 404', missing.status === 404);

    // 事实层：只读 + 删，没有手写入口
    const fbase = `/api/personas/${encodeURIComponent(me.id)}/facts`;
    store.deletePersonaFacts(me.id); // 前一段留下的 only-once 不参与这一段的计数
    store.addPersonaFact({ personaId: me.id, kind: 'command', text: '测试：npm test' });
    const fList = await send('GET', fbase);
    check('GET facts 能列出平台事实', fList.status === 200 && (fList.body.facts ?? []).length === 1);
    const fPost = await send('POST', fbase, { text: '手写事实' });
    check('事实层没有 POST（人写的东西走口径）', fPost.status >= 400, String(fPost.status));
    const fid = (fList.body.facts ?? [])[0]?.id;
    const fCross = await send('DELETE', `/api/personas/${encodeURIComponent(other.id)}/facts/${fid}`);
    check('事实不能跨人删（id 对但人不符 → 404）', fCross.status === 404);
    const fAllRefused = await send('DELETE', fbase);
    check('事实清空也要显式 ?all=1（防手滑）', fAllRefused.status === 400);
    const fGone = await send('DELETE', `${fbase}/${fid}`);
    check('删一条事实 → 200', fGone.status === 200 && fGone.body.removed === 1);
    store.addPersonaFact({ personaId: me.id, kind: 'restart', text: '重启：bandi restart' });
    const fWiped = await send('DELETE', `${fbase}?all=1`);
    check('事实 ?all=1 → 清空并回条数', fWiped.status === 200 && fWiped.body.removed === 1);
  }

  console.log('⑥ 接线：注入位置、召回依据与采集时机（读源码钉住，别只看单测）');
  {
    const dispatchSrc = fs.readFileSync(path.join(repoRoot, 'apps', 'server', 'src', 'dispatch.mjs'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs'), 'utf8');
    check(
      '经验簿排在任务之后、方法论之前（先知道活是什么，再提醒栽过哪）',
      /\[cardBlock, task, expBlock, attBlock, stylePrefBlock\(\), inlineSkillsBlock/.test(dispatchSrc),
    );
    const iClaim = serverSrc.indexOf('taskClaimAudit.reconcile');
    const iCrit = serverSrc.indexOf('criteriaAudit.reconcile');
    const iHarvest = serverSrc.indexOf('experience.harvest');
    const iHarvestFacts = serverSrc.indexOf('experience.harvestFacts');
    check(
      '采集注册在两个核对之后（先有结论再抄进经验簿）',
      iClaim > 0 && iCrit > iClaim && iHarvest > iCrit,
      `${iClaim} < ${iCrit} < ${iHarvest}`,
    );
    check('事实采集在经验簿之后注册（两块各记各的，谁失败都不挡对方）', iHarvestFacts > iHarvest);
    check(
      '注入走 memoryBlock 且带本轮任务做召回、带仓库根做隔离',
      /memoryBlock\(\{\s*personaId: member\.personaId,\s*query: matchText,\s*root: member\.cwd \|\| repoRoot,/.test(dispatchSrc),
    );
    check('召回依据与技能内联用同一份 matchText（不额外引入群聊历史）', /planSkillInline\(matchText, skillNames\)/.test(dispatchSrc));
  }
} catch (e) {
  console.error('  冒烟自身出错：', e?.stack ?? e);
  failed += 1;
} finally {
  try {
    db?.closeDb?.();
  } catch {
    /* 关不掉也走清理 */
  }
  await sleep(80);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 库里还有句柄（Windows 上常见）→ 留在临时目录，不因此判失败 */
  }
}

console.log(`\n结论：${failed ? `✗ ${failed} 条没过` : '✓ 全部通过'}`);
process.exit(failed ? 1 : 0);
