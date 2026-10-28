/**
 * 手机配对链路的验收（2026-11 手机端增量，T01）。
 *
 * 钉住的是设计 §3.2/§3.3 的那套边界：
 *   ① 操作员发一次性配对码（bp_，5 分钟）→ claim 换长期设备令牌（bd_，Cookie bandi_token）；
 *   ② 一次性：同一个码第二次 claim → 409 E4701；瞎编的码 → 400 E1702；格式不对 → 400 E1701；
 *   ③ 设备令牌的白名单：读 200；PATCH 卡改 status 200；改 title → 403 E3702（字段级闸）；
 *      DELETE 卡 → 403 E4033（白名单外）；POST 卡评论 execute → 403 E3702（只许便签）；
 *   ④ 设备管理只对操作员开（403 E3701）；踢出（revoke）后原令牌 401 E4010；
 *   ⑤ 回环形态（免鉴权）下 operator 动作照常可用 —— 单机自测不被自己的闸挡住。
 *
 * 隔离：临时数据目录 + 临时端口（对齐 smoke-auth.mjs 的 spawn 模式）。
 * 跑法：node apps/server/src/smoke-pair.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { stopRunning, sleep } from './lifecycle.mjs';

const P_OPEN = Number(process.env.SMOKE_PORT ?? 8860);
const P_LOOP = P_OPEN + 1;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-pair-'));
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const started = [];
function start(port, extra = {}) {
  const c = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(port), BANDI_DATA: tmp + '-' + port, BANDI_DB: path.join(tmp + '-' + port, 'bandi.db'), ...extra },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(c);
  let log = '';
  c.stdout.on('data', (d) => (log += d));
  c.stderr.on('data', (d) => (log += d));
  return { child: c, log: () => log };
}

async function waitUp(base, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(base + '/api/state', { signal: AbortSignal.timeout(800) });
      if (r.status === 200 || r.status === 401) return true; // 401 也算起来了（要令牌那种）
    } catch { /* 还没起 */ }
    await sleep(200);
  }
  return false;
}

const cleanup = async () => {
  for (const c of started) { try { c.kill(); } catch { /* 已退 */ } }
  await sleep(400);
  for (const p of [P_OPEN, P_LOOP]) { try { stopRunning(p); } catch { /* 没在跑 */ } }
};

const get = async (base, p, headers = {}) => {
  const r = await fetch(base + p, { headers, redirect: 'manual' });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

const send = async (base, p, { method = 'POST', body = {}, headers = {} } = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

/**
 * 探一条 SSE（不读正文）：只看响应头就 abort —— `fetch` 在头到齐时就 resolve，
 * 所以长连接不会把用例挂住。给 `/api/events` 这种"必须 200 但不能 readText"的口用。
 */
const sseProbe = async (base, p, headers = {}, ms = 1500) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(base + p, { headers, signal: ctrl.signal, redirect: 'manual' });
    const out = { status: r.status, type: String(r.headers.get('content-type') ?? '') };
    r.body?.cancel?.().catch(() => {}); // 头到手就收线：别让长连接留在用例里
    return out;
  } catch {
    return { status: 0, type: '' };
  } finally {
    clearTimeout(timer);
  }
};

try {
  /* ----------------------------- ① 非回环（鉴权开）：发码 → 换令牌 */
  console.log('① 操作员发配对码，手机凭码换长期令牌');
  const b = start(P_OPEN, { BANDI_HOST: '0.0.0.0' });
  const baseB = `http://127.0.0.1:${P_OPEN}`;
  if (!(await waitUp(baseB))) throw new Error('实例没起来：' + b.log().slice(-400));
  const token = fs.readFileSync(path.join(tmp + '-' + P_OPEN, 'token'), 'utf8').trim();
  const op = { 'X-Bandi-Token': token };

  const noTok = await send(baseB, '/api/pair/tokens');
  check('不带令牌发码 → 401', noTok.status === 401, String(noTok.status));

  const inv = await send(baseB, '/api/pair/tokens', { headers: op });
  check('操作员能发配对码', inv.status === 200 && /^bp_/.test(inv.json?.token ?? ''), String(inv.json?.token ?? '').slice(0, 8));
  check('配对码带过期时间', !!inv.json?.expiresAt, String(inv.json?.expiresAt ?? ''));
  check('给出候选地址（urls）', Array.isArray(inv.json?.urls) && inv.json.urls.length >= 1, JSON.stringify(inv.json?.urls ?? []));

  /* ----------------------------- ② claim：换 bd_ 令牌 */
  console.log('\n② claim：一次性码换设备令牌');
  const claim = async (tk, extra = {}) =>
    send(baseB, '/api/pair/claim', { body: { token: tk, name: '测试手机', ...extra }, headers: { 'X-Bandi': '1' } });
  const bad1 = await claim('hello');
  check('格式不对的码 → 400 E1701', bad1.status === 400 && bad1.json?.code === 'E1701', `${bad1.status} ${bad1.json?.code ?? ''}`);
  const bad2 = await claim('bp_zzzzzzzzzzzz');
  check('瞎编的码 → 400 E1702', bad2.status === 400 && bad2.json?.code === 'E1702', `${bad2.status} ${bad2.json?.code ?? ''}`);

  const ok1 = await claim(inv.json.token);
  const devCookie = String(ok1.headers.get('set-cookie') ?? '').split(';')[0];
  check('claim 成功 → 200 + deviceId', ok1.status === 200 && !!ok1.json?.deviceId, JSON.stringify(ok1.json));
  check('Cookie 是 bandi_token=bd_…（HttpOnly）', /^bandi_token=bd_/.test(devCookie) && /HttpOnly/i.test(String(ok1.headers.get('set-cookie'))), devCookie.slice(0, 26));
  // 网页发的写请求（带 Origin）必须带 X-Bandi: 1，否则 guardWrite 拦 403 ——
  // 原 断言写成 `… === 403 || ok1.status === 200`（恒真，2026-11 QA 复核修正）
  const noXBandi = await send(baseB, '/api/pair/claim', {
    body: { token: 'bp_x', name: 'x' },
    headers: { Origin: `http://127.0.0.1:${P_OPEN}` },
  });
  check('带 Origin 但缺 X-Bandi 的 claim → 403（CSRF 闸真在拦）', noXBandi.status === 403, String(noXBandi.status));

  const again = await claim(inv.json.token);
  check('同一个码第二次 claim → 409 E4701', again.status === 409 && again.json?.code === 'E4701', `${again.status} ${again.json?.code ?? ''}`);

  /*
   * ②.5 **设备令牌完整拉起工作台**（设计 §3.3.1，QA 第 1 轮 P0 的回归断言）。
   *
   * 这一节的由来：第一版白名单把"手机能不能加载页面"漏了 —— 扫码成功但 `/`、`/app.mjs`
   * 全是 403 E4033，页面白屏到底。口径定死：**静态资源无条件放行**（代码不是数据），
   * /api 白名单表见 §3.3.1.2。这里按"手机真打开一次工作台"的顺序逐条打。
   */
  console.log('\n②.5 设备令牌完整拉起工作台（静态 + 启动链）');
  for (const p of ['/', '/app.mjs', '/style.css', '/js/mobile.mjs', '/manifest.webmanifest']) {
    const r = await get(baseB, p, { Cookie: devCookie });
    check(`静态 GET ${p} → 200（不再 E4033 白屏）`, r.status === 200, String(r.status));
  }
  for (const p of ['/api/state', '/api/skills', '/api/workflows', '/api/web-version', '/api/prefs']) {
    const r = await get(baseB, p, { Cookie: devCookie });
    check(`启动链 GET ${p} → 200`, r.status === 200, `${r.status} ${r.json?.code ?? ''}`);
  }
  // 员工详情 + 项目看板（浏览口径）：白名单按**路径段精确匹配**，这两条要通
  const anyPersona = (await get(baseB, '/api/state', { Cookie: devCookie })).json?.personas?.[0]?.id;
  if (anyPersona) {
    const pd = await get(baseB, `/api/personas/${encodeURIComponent(anyPersona)}`, { Cookie: devCookie });
    check('员工详情 GET /api/personas/:id → 200', pd.status === 200, String(pd.status));
  }

  /*
   * ②.5b SSE 两条（2026-10-28 修 P0）：「边跑边看 / 后台刷新」靠它们。
   * 只验权限与内容类型，不真跑一个会话（那要真 CLI）。单运行流用不存在的 runId
   * 探 —— 期望 404（过了权限闸），不是 403 E4033。
   */
  console.log('\n②.5b 设备令牌的 SSE（手机端「边跑边看」）');
  const ev = await sseProbe(baseB, '/api/events', { Cookie: devCookie });
  check('GET /api/events → 200 + text/event-stream（不再是 403）', ev.status === 200 && /text\/event-stream/.test(ev.type), `${ev.status} ${ev.type}`);
  const st = await get(baseB, '/api/runs/__no_such_run__/stream', { Cookie: devCookie });
  check('GET /api/runs/:id/stream → 404（过了权限闸，不是 403）', st.status === 404, `${st.status} ${st.json?.code ?? ''}`);
  const ab = await send(baseB, '/api/runs/__no_such_run__/abort', { headers: { Cookie: devCookie, 'X-Bandi': '1' } });
  check('POST /api/runs/:id/abort → 200（过了权限闸，不是 403）', ab.status === 200, `${ab.status} ${ab.json?.code ?? ''}`);

  /*
   * 反例：QA 已验证有效的面**一条都不许放开**（设计 §3.3.1.2 那张 403 清单）。
   * 注意 `/api/pair/devices` 这类走的是 decide() 的 E4033；`runtime-skills` 是
   * "前缀匹配顺带放行"最容易踩的坑，必须单独钉住。
   */
  console.log('\n②.6 反例：受限视图碰不到的面必须仍 403');
  const forbiddenGets = [
    ['/api/pair/devices', '设备清单（含 IP/最近活跃）'],
    ['/api/status', '项目进度账本'],
    ['/api/experts', '专家库（含磁盘路径）'],
    ['/api/plugins', '插件目录（含磁盘路径）'],
    ['/api/personas/p-xier/runtime-skills', '员工技能编辑视图（前缀匹配陷阱）'],
    ['/api/connectors', '连接器凭据信息'],
    ['/api/devices', '设备/网络配置'],
  ];
  for (const [p, why] of forbiddenGets) {
    const r = await get(baseB, p, { Cookie: devCookie });
    check(`GET ${p} → 403（${why}）`, r.status === 403, `${r.status} ${r.json?.code ?? ''}`);
  }
  const putPrefs = await send(baseB, '/api/prefs', { method: 'PUT', headers: { Cookie: devCookie, 'X-Bandi': '1' }, body: { replyStyle: 'concise' } });
  check('PUT /api/prefs → 403（读放行、写不放行）', putPrefs.status === 403, `${putPrefs.status} ${putPrefs.json?.code ?? ''}`);
  const postPersona = await send(baseB, '/api/personas', { headers: { Cookie: devCookie, 'X-Bandi': '1' }, body: { name: '越权员工' } });
  check('POST /api/personas → 403（受限视图没有这个写）', postPersona.status === 403, `${postPersona.status} ${postPersona.json?.code ?? ''}`);

  /* ----------------------------- ③ 设备令牌的读与写 */
  console.log('\n③ 设备令牌：白名单内的读与写');
  check('读 /api/state → 200', (await get(baseB, '/api/state', { Cookie: devCookie })).status === 200);
  const me = await get(baseB, '/api/pair/me', { Cookie: devCookie });
  check('/api/pair/me 说自己是设备', me.json?.kind === 'device' && me.json?.device?.name === '测试手机', JSON.stringify(me.json));
  const meOp = await get(baseB, '/api/pair/me', op);
  check('/api/pair/me 对操作员说 operator', meOp.json?.kind === 'operator', JSON.stringify(meOp.json));

  const proj = await send(baseB, '/api/projects', { method: 'POST', headers: { ...op, 'X-Bandi': '1' }, body: { name: '配对验收', root: path.join(tmp, 'proj') } });
  check('操作员建项目（准备一张卡）', proj.status === 201, String(proj.status));
  const card = await send(baseB, `/api/projects/${encodeURIComponent(proj.json.project.id)}/tasks`, { method: 'POST', headers: { ...op, 'X-Bandi': '1' }, body: { title: '审批验收卡' } });
  check('操作员建任务卡', card.status === 201, String(card.status));
  const taskUrl = `/api/projects/tasks/${encodeURIComponent(card.json.task.id)}`;

  check('读卡详情 → 200', (await get(baseB, taskUrl, { Cookie: devCookie })).status === 200);
  const patchOk = await send(baseB, taskUrl, { method: 'PATCH', headers: { Cookie: devCookie, 'X-Bandi': '1' }, body: { status: '已完成' } });
  check('手机改卡状态（审批）→ 200', patchOk.status === 200 && patchOk.json?.task?.status === '已完成', String(patchOk.status));
  const patchTitle = await send(baseB, taskUrl, { method: 'PATCH', headers: { Cookie: devCookie, 'X-Bandi': '1' }, body: { title: '改标题' } });
  check('手机改卡标题 → 403 E3702（字段级闸）', patchTitle.status === 403 && patchTitle.json?.code === 'E3702', `${patchTitle.status} ${patchTitle.json?.code ?? ''}`);
  const patchMore = await send(baseB, taskUrl, { method: 'PATCH', headers: { Cookie: devCookie, 'X-Bandi': '1' }, body: { status: '待办', note: 'x', description: '越权' } });
  check('手机多传字段 → 403 E3702', patchMore.status === 403 && patchMore.json?.code === 'E3702', `${patchMore.status} ${patchMore.json?.code ?? ''}`);
  const del = await send(baseB, taskUrl, { method: 'DELETE', headers: { Cookie: devCookie, 'X-Bandi': '1' } });
  check('手机删卡 → 403 E4033（白名单外）', del.status === 403 && del.json?.code === 'E4033', `${del.status} ${del.json?.code ?? ''}`);
  const noteOk = await send(baseB, taskUrl + '/comments', { headers: { Cookie: devCookie, 'X-Bandi': '1' }, body: { text: '驳回：缺验收单', mode: 'note' } });
  // 这张验收卡没指定执行人 → E1061"先指定执行人"。拿到 E1061（而不是 E3702/E4033）
  // 就证明设备的档位闸已经放行 note、请求真走到了业务逻辑 —— 这正是要验收的。
  check('手机留便签（note）过了档位闸（400 E1061 = 卡没执行人）', noteOk.status === 400 && noteOk.json?.code === 'E1061', `${noteOk.status} ${noteOk.json?.code ?? ''}`);
  const execNo = await send(baseB, taskUrl + '/comments', { headers: { Cookie: devCookie, 'X-Bandi': '1' }, body: { text: '干活', mode: 'execute' } });
  check('手机发执行评论 → 403 E3702（只许便签）', execNo.status === 403 && execNo.json?.code === 'E3702', `${execNo.status} ${execNo.json?.code ?? ''}`);
  check('手机读设备列表（/api/devices）→ 403 E4033', (await get(baseB, '/api/devices', { Cookie: devCookie })).status === 403);

  /* ----------------------------- ④ 设备管理：只对操作员开 + 踢出 */
  console.log('\n④ 设备管理：列表与踢出');
  const devListAsDev = await get(baseB, '/api/pair/devices', { Cookie: devCookie });
  // /api/pair/devices 不在设备白名单里 → 认证层先拦（E4033），根本到不了 handler；
  // handler 里那条 E3701 是给"节点 panel 令牌"这类别的非操作员身份准备的。
  check('设备令牌看设备列表 → 403（白名单外）', devListAsDev.status === 403 && ['E4033', 'E3701'].includes(devListAsDev.json?.code), `${devListAsDev.status} ${devListAsDev.json?.code ?? ''}`);
  const devList = await get(baseB, '/api/pair/devices', op);
  const devRow = (devList.json?.devices ?? []).find((d) => d.name === '测试手机');
  check('操作员能看到已配对设备', devList.status === 200 && !!devRow, JSON.stringify((devList.json?.devices ?? []).map((d) => d.name)));
  check('设备行带 lastSeenAt（活跃被记录了）', !!devRow?.lastSeenAt, String(devRow?.lastSeenAt ?? ''));
  check('设备行带 tokenCount=1（列表能分辨在用/已踢出）', devRow?.tokenCount === 1, String(devRow?.tokenCount ?? ''));
  const noDev = await send(baseB, `/api/pair/devices/md_not_exists/revoke`, { headers: op });
  check('踢出不存在的设备 → 404 E2701', noDev.status === 404 && noDev.json?.code === 'E2701', `${noDev.status} ${noDev.json?.code ?? ''}`);
  const revoke = await send(baseB, `/api/pair/devices/${encodeURIComponent(devRow.id)}/revoke`, { headers: op });
  check('踢出 → 200，吊销了令牌', revoke.status === 200 && (revoke.json?.revoked ?? 0) >= 1, JSON.stringify(revoke.json));
  const devList2 = await get(baseB, '/api/pair/devices', op);
  const kickedRow = (devList2.json?.devices ?? []).find((d) => d.id === devRow.id);
  check('踢出后列表里那台 tokenCount=0（界面显示「已踢出」，不是原样还在）', kickedRow?.tokenCount === 0, String(kickedRow?.tokenCount ?? 'missing'));
  const afterRevoke = await get(baseB, '/api/state', { Cookie: devCookie });
  check('被踢出后原令牌 → 401 E4010', afterRevoke.status === 401 && afterRevoke.json?.code === 'E4010', `${afterRevoke.status} ${afterRevoke.json?.code ?? ''}`);

  /* ----------------------------- ⑤ 回环形态（免鉴权）照常可用 */
  console.log('\n⑤ 回环形态（单机免鉴权）：operator 动作照常可用');
  const a = start(P_LOOP, { BANDI_HOST: '127.0.0.1' });
  const baseA = `http://127.0.0.1:${P_LOOP}`;
  if (!(await waitUp(baseA))) throw new Error('回环实例没起来：' + a.log().slice(-400));
  const inv2 = await send(baseA, '/api/pair/tokens');
  check('免鉴权下发码 → 200', inv2.status === 200 && /^bp_/.test(inv2.json?.token ?? ''), String(inv2.status));
  const ok2 = await send(baseA, '/api/pair/claim', { body: { token: inv2.json.token, name: '回环手机' }, headers: { 'X-Bandi': '1' } });
  check('免鉴权下 claim → 200', ok2.status === 200 && !!ok2.json?.deviceId, JSON.stringify(ok2.json));
  const cookie2 = String(ok2.headers.get('set-cookie') ?? '').split(';')[0];
  check('设备令牌在回环形态照常能读', (await get(baseA, '/api/state', { Cookie: cookie2 })).status === 200);
  check('免鉴权下设备列表照常可看', (await get(baseA, '/api/pair/devices')).status === 200);
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  await cleanup();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
