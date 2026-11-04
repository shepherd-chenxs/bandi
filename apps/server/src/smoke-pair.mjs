/**
 * 手机配对链路的验收（2026-11 手机端增量，T01）。
 *
 * 钉住的是设计 §3.2/§3.3 的那套边界：
 *   ① 操作员发一次性邀请码（9 位数字，2026-11-01 起的主路径；旧 bp_ 长令牌仍认）
 *      → claim 换长期设备令牌（bd_，Cookie bandi_token）；
 *   ② 一次性：同一个码第二次 claim → 409 E4701；瞎编的码 → 400 E1702；格式不对 → 400 E1701；
 *   ③ 设备令牌的白名单：读 200；PATCH 卡改 status 200；改 title → 403 E3702（字段级闸）；
 *      DELETE 卡 → 403 E4033（白名单外）；POST 卡评论 execute → 403 E3702（只许便签）；
 *   ④ 设备管理只对操作员开（403 E3701）；踢出（revoke）后原令牌 401 E4010；
 *   ⑤ 一机一刀（2026-11-01）：新 claim 顶掉旧设备（行删光）；同一 clientKey 重配复用同一行；
 *   ⑥ 回环形态（免鉴权）下 operator 动作照常可用 —— 单机自测不被自己的闸挡住。
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
  check('操作员能发邀请码（9 位数字）', inv.status === 200 && /^\d{9}$/.test(inv.json?.code ?? ''), String(inv.json?.code ?? ''));
  check('配对码带过期时间', !!inv.json?.expiresAt, String(inv.json?.expiresAt ?? ''));
  check('给出候选地址（urls）', Array.isArray(inv.json?.urls) && inv.json.urls.length >= 1, JSON.stringify(inv.json?.urls ?? []));

  /* ----------------------------- ② claim：换 bd_ 令牌 */
  console.log('\n② claim：一次性码换设备令牌');
  const claim = async (code, extra = {}) =>
    send(baseB, '/api/pair/claim', { body: { code, name: '测试手机', ...extra }, headers: { 'X-Bandi': '1' } });
  const bad1 = await claim('hello');
  check('格式不对的码 → 400 E1701', bad1.status === 400 && bad1.json?.code === 'E1701', `${bad1.status} ${bad1.json?.code ?? ''}`);
  const bad2 = await claim('bp_zzzzzzzzzzzz');
  check('瞎编的码 → 400 E1702', bad2.status === 400 && bad2.json?.code === 'E1702', `${bad2.status} ${bad2.json?.code ?? ''}`);

  const ok1 = await claim(inv.json.code, { clientKey: 'key-first-device-001' });
  const devCookie = String(ok1.headers.get('set-cookie') ?? '').split(';')[0];
  // v2.8：claim 与登录对齐一并种 bandi_csrf（E4099 双提交）—— 设备 jar 也要
  // cookie+头两样都带（模拟浏览器：JS 读 cookie 再放头里）
  const devCsrfC = (ok1.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('bandi_csrf=')) ?? '';
  check('claim 一并种了 bandi_csrf（非 HttpOnly）', !!devCsrfC && !/httponly/i.test(devCsrfC), devCsrfC.slice(0, 30));
  const devJar = [devCookie, devCsrfC].filter(Boolean).join('; ');
  const devCSRF = devCsrfC ? { 'X-Bandi-CSRF': decodeURIComponent(devCsrfC.split('=')[1]) } : {};
  check('claim 成功 → 200 + deviceId', ok1.status === 200 && !!ok1.json?.deviceId, JSON.stringify(ok1.json));
  check('Cookie 是 bandi_token=bd_…（HttpOnly）', /^bandi_token=bd_/.test(devCookie) && /HttpOnly/i.test(String(ok1.headers.get('set-cookie'))), devCookie.slice(0, 26));
  // 网页发的写请求（带 Origin）必须带 X-Bandi: 1，否则 guardWrite 拦 403 ——
  // 原 断言写成 `… === 403 || ok1.status === 200`（恒真，2026-11 QA 复核修正）
  const noXBandi = await send(baseB, '/api/pair/claim', {
    body: { token: 'bp_x', name: 'x' },
    headers: { Origin: `http://127.0.0.1:${P_OPEN}` },
  });
  check('带 Origin 但缺 X-Bandi 的 claim → 403（CSRF 闸真在拦）', noXBandi.status === 403, String(noXBandi.status));


  const again = await claim(inv.json.code);
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
  /*
   * PWA manifest 的两条硬要求（2026-11-03 锁竖屏时补的）：
   *   · MIME 必须是 JSON 系 —— `application/octet-stream` 会让 Chrome 整份 manifest 作废
   *     （没图标、不是独立窗口、横屏照转）；
   *   · orientation 必须是竖屏 —— 这就是"手机端锁定竖屏"在 PWA 那条路上的唯一开关。
   */
  const mf = await get(baseB, '/manifest.webmanifest', { Cookie: devCookie });
  check(
    'manifest 的 Content-Type 是 application/manifest+json',
    /application\/manifest\+json/.test(mf.headers.get('content-type') ?? ''),
    String(mf.headers.get('content-type')),
  );
  check(
    'manifest 声明竖屏（orientation: portrait-primary）',
    /^portrait/.test(String(mf.json?.orientation ?? '')),
    String(mf.json?.orientation ?? '（没有 orientation）'),
  );
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
  const ab = await send(baseB, '/api/runs/__no_such_run__/abort', { headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF } });
  check('POST /api/runs/:id/abort → 200（过了权限闸，不是 403）', ab.status === 200, `${ab.status} ${ab.json?.code ?? ''}`);

  /*
   * 反例：QA 已验证有效的面**一条都不许放开**（设计 §3.3.1.2 那张 403 清单）。
   * 注意 `/api/pair/devices` 这类走的是 decide() 的 E4033；`runtime-skills` 是
   * "前缀匹配顺带放行"最容易踩的坑，必须单独钉住。
   */
  console.log('\n②.6 反例：受限视图碰不到的面必须仍 403（未登记的是 404 E4090）');
  const forbiddenGets = [
    ['/api/pair/devices', '设备清单（含 IP/最近活跃）'],
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
  // v2.8：裸 /api/status 没登记（本来就只有 /api/status/projects 有 handler）——
  // 默认拒绝 doctrine 下它在认证之前就 404 E4090，连 403 都轮不到
  const rStatus = await get(baseB, '/api/status', { Cookie: devCookie });
  check('GET /api/status → 404 E4090（未登记默认拒绝，项目进度账本）', rStatus.status === 404 && rStatus.json?.code === 'E4090', `${rStatus.status} ${rStatus.json?.code ?? ''}`);
  // 2026-11-04 补登 PUT /api/prefs（用户实报 E4090：设置页「言简意赅」开关打不通）。
  // 登录用户可改全体沟通偏好，但设备仍不给 —— 设备打它应是 403 E4033，不再是 404。
  const putPrefs = await send(baseB, '/api/prefs', { method: 'PUT', headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF }, body: { replyStyle: 'concise' } });
  check('PUT /api/prefs → 403 E4033（设备令牌：改全体偏好不是设备的事）', putPrefs.status === 403 && putPrefs.json?.code === 'E4033', `${putPrefs.status} ${putPrefs.json?.code ?? ''}`);
  const postPersona = await send(baseB, '/api/personas', { headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF }, body: { name: '越权员工' } });
  check('POST /api/personas → 403（受限视图没有这个写）', postPersona.status === 403, `${postPersona.status} ${postPersona.json?.code ?? ''}`);

  /* ----------------------------- ③ 设备令牌的读与写 */
  console.log('\n③ 设备令牌：白名单内的读与写');
  check('读 /api/state → 200', (await get(baseB, '/api/state', { Cookie: devCookie })).status === 200);
  /*
   * 手机「发消息」的第一步（2026-11-03 实机报 E4033）：通讯录点人进详情 → 「发消息」，
   * 与这个人**还没聊过**时要先建一段会话（chat.mjs openDirectChat 的 ③ 分支）。
   * 这条不放行的话，症状是"聊过的能发、没聊过的报 E4033"，极容易被当成按钮坏了。
   */
  const devState = await get(baseB, '/api/state', { Cookie: devCookie });
  const somePersona = devState.json?.personas?.[0]?.id;
  if (somePersona) {
    const mkConv = await send(baseB, '/api/conversations', { headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF }, body: { personaId: somePersona, title: '手机开聊' } });
    check('手机建会话（发消息第一步）→ 201', mkConv.status === 201 && !!mkConv.json?.conversation?.id, `${mkConv.status} ${mkConv.json?.code ?? ''}`);
  } else {
    check('手机建会话（发消息第一步）→ 201', false, 'state 里没有员工，没法验');
  }
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
  const patchOk = await send(baseB, taskUrl, { method: 'PATCH', headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF }, body: { status: '已完成' } });
  check('手机改卡状态（审批）→ 200', patchOk.status === 200 && patchOk.json?.task?.status === '已完成', String(patchOk.status));
  const patchTitle = await send(baseB, taskUrl, { method: 'PATCH', headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF }, body: { title: '改标题' } });
  check('手机改卡标题 → 403 E3702（字段级闸）', patchTitle.status === 403 && patchTitle.json?.code === 'E3702', `${patchTitle.status} ${patchTitle.json?.code ?? ''}`);
  const patchMore = await send(baseB, taskUrl, { method: 'PATCH', headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF }, body: { status: '待办', note: 'x', description: '越权' } });
  check('手机多传字段 → 403 E3702', patchMore.status === 403 && patchMore.json?.code === 'E3702', `${patchMore.status} ${patchMore.json?.code ?? ''}`);
  const del = await send(baseB, taskUrl, { method: 'DELETE', headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF } });
  check('手机删卡 → 403 E4033（白名单外）', del.status === 403 && del.json?.code === 'E4033', `${del.status} ${del.json?.code ?? ''}`);
  const noteOk = await send(baseB, taskUrl + '/comments', { headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF }, body: { text: '驳回：缺验收单', mode: 'note' } });
  // 这张验收卡没指定执行人 → E1061"先指定执行人"。拿到 E1061（而不是 E3702/E4033）
  // 就证明设备的档位闸已经放行 note、请求真走到了业务逻辑 —— 这正是要验收的。
  check('手机留便签（note）过了档位闸（400 E1061 = 卡没执行人）', noteOk.status === 400 && noteOk.json?.code === 'E1061', `${noteOk.status} ${noteOk.json?.code ?? ''}`);
  const execNo = await send(baseB, taskUrl + '/comments', { headers: { Cookie: devJar, 'X-Bandi': '1', ...devCSRF }, body: { text: '干活', mode: 'execute' } });
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

  /* ----------------------------- ⑤ 一机一刀：断开 / 连回来 / 复用（2026-11-01） */
  console.log('\n⑤ 一机一刀：断开连接 ≠ 取消配对');
  const devRowId = devRow.id;
  const inv3 = await send(baseB, '/api/pair/tokens', { headers: op });
  const ok3 = await send(baseB, '/api/pair/claim', {
    body: { code: inv3.json.code, name: '第二台手机', clientKey: 'key-second-device-01' },
    headers: { 'X-Bandi': '1' },
  });
  check('第二台手机 claim → 200（新 deviceId）', ok3.status === 200 && !!ok3.json?.deviceId && ok3.json.deviceId !== devRowId, JSON.stringify(ok3.json));
  const secondCookie = String(ok3.headers.get('set-cookie') ?? '').split(';')[0];
  const afterEvict = await get(baseB, '/api/state', { Cookie: devCookie });
  check('旧手机的令牌立刻失效 → 401', afterEvict.status === 401 && afterEvict.json?.code === 'E4010', `${afterEvict.status} ${afterEvict.json?.code ?? ''}`);
  const devsAfterEvict = await get(baseB, '/api/pair/devices', op);
  const oldRow = (devsAfterEvict.json?.devices ?? []).find((d) => d.id === devRowId);
  check('旧手机只是「已断开」：行还在、带 disconnectedAt、令牌归零',
    !!oldRow && !!oldRow.disconnectedAt && oldRow.tokenCount === 0,
    JSON.stringify(oldRow ? { disconnectedAt: oldRow.disconnectedAt, tokenCount: oldRow.tokenCount } : null));
  check('列表里 2 条记录（1 在用 + 1 已断开）', devsAfterEvict.json?.devices?.length === 2, String(devsAfterEvict.json?.devices?.length ?? 0));

  /* 有人在用时连不回来 */
  const busy = await send(baseB, '/api/pair/resume', { body: { clientKey: 'key-first-device-001' }, headers: { 'X-Bandi': '1' } });
  check('别的手机在用 → 连回来被拒 409 E1705', busy.status === 409 && busy.json?.code === 'E1705', `${busy.status} ${busy.json?.code ?? ''}`);

  /* 断开第二台 → 第一台能连回来（不用重新扫码） */
  const dis = await send(baseB, `/api/pair/devices/${encodeURIComponent(ok3.json.deviceId)}/disconnect`, { headers: op });
  check('断开连接 → 200', dis.status === 200, `${dis.status} ${dis.json?.code ?? ''}`);
  const back = await send(baseB, '/api/pair/resume', { body: { clientKey: 'key-first-device-001' }, headers: { 'X-Bandi': '1' } });
  check('断开的手机凭 clientKey 连回来 → 200（同一 deviceId）', back.status === 200 && back.json?.deviceId === devRowId, JSON.stringify(back.json));
  const backCookie = String(back.headers.get('set-cookie') ?? '').split(';')[0];
  check('连回来后新令牌能读 /api/state', (await get(baseB, '/api/state', { Cookie: backCookie })).status === 200);
  const devsAfterBack = await get(baseB, '/api/pair/devices', op);
  const backRow = (devsAfterBack.json?.devices ?? []).find((d) => d.id === devRowId);
  check('连回来后 disconnectedAt 清空', !!backRow && backRow.disconnectedAt === null, JSON.stringify(backRow?.disconnectedAt ?? null));

  /* 同一台手机重配：复用同一行，并让前一台转成已断开 */
  const inv4 = await send(baseB, '/api/pair/tokens', { headers: op });
  const ok4 = await send(baseB, '/api/pair/claim', {
    body: { code: inv4.json.code, name: '第二台手机', clientKey: 'key-second-device-01' },
    headers: { 'X-Bandi': '1' },
  });
  check('同一台手机（同 clientKey）重配 → 复用同一 deviceId', ok4.status === 200 && ok4.json?.deviceId === ok3.json.deviceId, JSON.stringify(ok4.json));
  const devsAfterReuse = await get(baseB, '/api/pair/devices', op);
  check('重配不新增记录（仍 2 条）', devsAfterReuse.json?.devices?.length === 2, String(devsAfterReuse.json?.devices?.length ?? 0));
  check('被顶下去的又变回「已断开」', (devsAfterReuse.json?.devices ?? []).find((d) => d.id === devRowId)?.disconnectedAt !== null, '');
  const secondCookie2 = String(ok4.headers.get('set-cookie') ?? '').split(';')[0];
  check('第二台手机重新在用（重配发的令牌可用）', (await get(baseB, '/api/state', { Cookie: secondCookie2 })).status === 200);
  check('第二台手机的旧令牌已作废（同一台设备只留一把钥匙）', (await get(baseB, '/api/state', { Cookie: secondCookie })).status === 401);

  /* 没配过的 clientKey：不能凭猜连进来 */
  const ghost = await send(baseB, '/api/pair/resume', { body: { clientKey: 'key-never-paired-99' }, headers: { 'X-Bandi': '1' } });
  check('没配过的 clientKey → 404 E1706', ghost.status === 404 && ghost.json?.code === 'E1706', `${ghost.status} ${ghost.json?.code ?? ''}`);

  /* ----------------------------- ⑤.5 手机自己断开（2026-11-02：/api/pair/leave） */
  console.log('\n⑤.5 手机自己断开：/api/pair/leave（记录留着，能连回来）');
  /* ok4 的 jar：设备令牌 + bandi_csrf（写请求要双提交） */
  const jar4 = (ok4.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  const csrfCookie4 = jar4.find((c) => c.startsWith('bandi_csrf=')) ?? '';
  const dev4 = { Cookie: jar4.filter((c) => /^bandi_(token|csrf)=/.test(c)).join('; '),
    ...(csrfCookie4 ? { 'X-Bandi-CSRF': decodeURIComponent(csrfCookie4.split('=')[1]) } : {}) };

  const leaveOp = await send(baseB, '/api/pair/leave', { headers: op });
  check('操作员调 leave → 403 E2702（这个口只给手机身份）',
    leaveOp.status === 403 && leaveOp.json?.code === 'E2702', `${leaveOp.status} ${leaveOp.json?.code ?? ''}`);

  const leaveOk = await send(baseB, '/api/pair/leave', { headers: dev4 });
  check('手机自己断开 → 200 且收走令牌', leaveOk.status === 200 && (leaveOk.json?.revoked ?? 0) >= 1, JSON.stringify(leaveOk.json));
  check('断开后旧令牌立刻失效（/api/state 401）', (await get(baseB, '/api/state', { Cookie: secondCookie2 })).status === 401);

  const devsAfterLeave = await get(baseB, '/api/pair/devices', op);
  const leaveRow = (devsAfterLeave.json?.devices ?? []).find((d) => d.id === ok4.json.deviceId);
  check('电脑端看到的是「已断开」：行留着、disconnectedAt 有值、令牌归零',
    !!leaveRow && !!leaveRow.disconnectedAt && leaveRow.tokenCount === 0,
    JSON.stringify(leaveRow ? { disconnectedAt: leaveRow.disconnectedAt, tokenCount: leaveRow.tokenCount } : null));

  const backAfterLeave = await send(baseB, '/api/pair/resume', { body: { clientKey: 'key-second-device-01' }, headers: { 'X-Bandi': '1' } });
  check('断开 ≠ 取消配对：同机 clientKey 还能连回来（同一 deviceId）',
    backAfterLeave.status === 200 && backAfterLeave.json?.deviceId === ok4.json.deviceId, JSON.stringify(backAfterLeave.json));

  /* ----------------------------- ⑤.7 设备绑人（2026-11-03） */
  /*
   * 钉住三件事：
   *   ① **谁发的码，手机就归谁** —— 码上带 userId，claim 时继承到设备行；
   *   ② 设备说的话**署到人头上** —— `/api/me` 与 actorUser 都认得出归属人；
   *   ③ **归属人失效 = 手机失效** —— 禁用那个人，那台手机下一次请求就 401
   *      （在此之前「禁用」只禁掉了浏览器，手机照连，等于没禁）。
   */
  console.log('\n⑤.7 设备绑人：谁发的码，手机就归谁');
  const jarOf = (res) =>
    (res.headers.getSetCookie?.() ?? [String(res.headers.get('set-cookie') ?? '')])
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ');
  const csrfOf = (jar) => {
    const m = /bandi_csrf=([^;]*)/.exec(jar);
    return m ? { 'X-Bandi-CSRF': decodeURIComponent(m[1]) } : {};
  };

  // 这台实例还没有账号：先建第一个（= 内置管理员），再建一个普通管理员当"小李"
  const setupCode = fs.readFileSync(path.join(tmp + '-' + P_OPEN, 'setup_code'), 'utf8').trim();
  const mkBoss = await send(baseB, '/api/users', {
    body: { name: '老王', password: 'wang-pass-123' },
    headers: { ...op, 'X-Bandi-Setup': setupCode, 'X-Bandi': '1' },
  });
  check('建第一个账号 → 201', mkBoss.status === 201, `${mkBoss.status} ${mkBoss.json?.code ?? ''}`);
  const bossLogin = await send(baseB, '/api/login', { body: { name: '老王', password: 'wang-pass-123' }, headers: { 'X-Bandi': '1' } });
  const bossJar = jarOf(bossLogin);
  check('老王登录 → 拿到会话', bossLogin.status === 200 && /bandi_sid=/.test(bossJar), String(bossLogin.status));

  const mkLi = await send(baseB, '/api/users', {
    body: { name: '小李', password: 'li-pass-1234', roleId: 'admin' },
    headers: { Cookie: bossJar, 'X-Bandi': '1', ...csrfOf(bossJar) },
  });
  check('建「小李」→ 201', mkLi.status === 201, `${mkLi.status} ${mkLi.json?.code ?? ''}`);
  const liId = mkLi.json?.user?.id;
  const liLogin = await send(baseB, '/api/login', { body: { name: '小李', password: 'li-pass-1234' }, headers: { 'X-Bandi': '1' } });
  const liJar = jarOf(liLogin);
  check('小李登录 → 拿到会话', liLogin.status === 200 && /bandi_sid=/.test(liJar), String(liLogin.status));

  const invLi = await send(baseB, '/api/pair/tokens', { headers: { Cookie: liJar, 'X-Bandi': '1', ...csrfOf(liJar) } });
  check('小李发码 → 码上写明归属人（owner=小李）', invLi.status === 200 && invLi.json?.owner?.name === '小李', JSON.stringify(invLi.json?.owner ?? null));

  const claimLi = await send(baseB, '/api/pair/claim', {
    body: { code: invLi.json.code, name: '小李的手机', clientKey: 'key-li-phone-0001' },
    headers: { 'X-Bandi': '1' },
  });
  check('小李的码被扫 → 200，回执里带归属人', claimLi.status === 200 && claimLi.json?.owner === '小李', JSON.stringify(claimLi.json));
  const liPhoneJar = jarOf(claimLi);
  const liPhoneCookie = liPhoneJar.split('; ').filter((c) => /^bandi_(token|csrf)=/.test(c)).join('; ');

  const mePhone = await get(baseB, '/api/me', { Cookie: liPhoneCookie });
  check('手机问「我是谁」→ 带出归属人小李', mePhone.status === 200 && mePhone.json?.kind === 'device' && mePhone.json?.user?.name === '小李', JSON.stringify(mePhone.json?.user ?? null));

  /*
   * 归属的真正效果：**手机上说的话落到人头上**。
   * 走便签（note）这条路 —— 它只落一条消息、不派活、不叫醒任何员工，
   * 所以不用真起一个 CLI 就能验到"署名是谁"（上线时最容易错的就是这一环：
   * 归属写进了设备行，但 actorUser 没认，结果还是 null）。
   */
  const personaOwn = (await get(baseB, '/api/state', { Cookie: bossJar })).json?.personas?.[0]?.id;
  const projOwn = await send(baseB, '/api/projects', {
    method: 'POST',
    headers: { Cookie: bossJar, 'X-Bandi': '1', ...csrfOf(bossJar) },
    body: { name: '归属验收', root: path.join(tmp, 'proj-own') },
  });
  const cardOwn = await send(baseB, `/api/projects/${encodeURIComponent(projOwn.json?.project?.id ?? '')}/tasks`, {
    method: 'POST',
    headers: { Cookie: bossJar, 'X-Bandi': '1', ...csrfOf(bossJar) },
    body: { title: '谁批的卡', personaId: personaOwn },
  });
  const noteOwn = await send(baseB, `/api/projects/tasks/${encodeURIComponent(cardOwn.json?.task?.id ?? '')}/comments`, {
    headers: { Cookie: liPhoneCookie, 'X-Bandi': '1', ...csrfOf(liPhoneCookie) },
    body: { text: '驳回：缺验收单', mode: 'note' },
  });
  check(
    '手机上留的便签**署到「小李」头上**（以前是 null = 一台设备在说话）',
    noteOwn.status === 201 && noteOwn.json?.message?.senderUserId === liId,
    `${noteOwn.status} ${JSON.stringify(noteOwn.json?.message?.senderUserId ?? null)}`,
  );

  /*
   * 手机**建卡**（2026-11-03 放开白名单后补的回归）："人不在电脑前想起一件事要派下去"
   * 是手机端的核心场景。之前 route-policy 里 `POST /api/projects/:id/tasks` 没有
   * `device: true`，手机建卡吃 403 E4033 —— 而报错 toast 被弹窗盖住（shell.mjs toast
   * 注释），实机上表现成「点创建没反应」，坑了一下午。断言钉两件事：
   * 白名单真放行了、建卡人署到归属人头上。
   */
  const phoneCard = await send(baseB, `/api/projects/${encodeURIComponent(projOwn.json?.project?.id ?? '')}/tasks`, {
    method: 'POST',
    headers: { Cookie: liPhoneCookie, 'X-Bandi': '1', ...csrfOf(liPhoneCookie) },
    body: { title: '手机上建的一张卡' },
  });
  check('手机建卡 → 201（白名单放行 POST tasks）', phoneCard.status === 201, `${phoneCard.status} ${JSON.stringify(phoneCard.json?.error ?? phoneCard.json?.code ?? '')}`);
  check(
    '手机建的卡，创建人**署到「小李」头上**（createdByUserId = 归属人）',
    phoneCard.json?.task?.createdByUserId === liId,
    JSON.stringify(phoneCard.json?.task?.createdByUserId ?? null),
  );

  /*
   * 审批归因（2026-11-03，补绑人的另一半）：手机上批卡 = **归属人**批的。
   * PATCH 状态走 routes/project.mjs → actorUser（设备=归属人）→ statusByUserId，
   * 卡详情页的「状态改动」行就靠这两列。
   */
  const approveOwn = await send(baseB, `/api/projects/tasks/${encodeURIComponent(cardOwn.json?.task?.id ?? '')}`, {
    method: 'PATCH',
    headers: { Cookie: liPhoneCookie, 'X-Bandi': '1', ...csrfOf(liPhoneCookie) },
    body: { status: '已完成' },
  });
  check('手机上批卡 → 200', approveOwn.status === 200, `${approveOwn.status} ${JSON.stringify(approveOwn.json?.error ?? approveOwn.json?.code ?? '')}`);
  check(
    '批卡的人记到了「小李」头上（statusByUserId + statusAt）',
    approveOwn.json?.task?.statusByUserId === liId && !!approveOwn.json?.task?.statusAt,
    JSON.stringify({ by: approveOwn.json?.task?.statusByUserId, at: approveOwn.json?.task?.statusAt }),
  );
  const bossApprove = await send(baseB, `/api/projects/tasks/${encodeURIComponent(cardOwn.json?.task?.id ?? '')}`, {
    method: 'PATCH',
    headers: { Cookie: bossJar, 'X-Bandi': '1', ...csrfOf(bossJar) },
    body: { status: '待办' },
  });
  check(
    '桌面端再改一次 → 署名**换成操作的人**（不是小李）',
    bossApprove.json?.task?.statusByUserId && bossApprove.json?.task?.statusByUserId !== liId,
    JSON.stringify({ by: bossApprove.json?.task?.statusByUserId }),
  );

  const devsOwned = await get(baseB, '/api/pair/devices', op);
  const liRow = (devsOwned.json?.devices ?? []).find((d) => d.id === claimLi.json?.deviceId);
  check('设备列表里能看到「使用者 = 小李」', liRow?.ownerName === '小李', JSON.stringify(liRow ? { ownerName: liRow.ownerName, userId: liRow.userId } : null));

  /*
   * ③ 禁用小李 → 那台手机立刻进不来（这是"绑人"真正的安全价值）。
   * 语义是**冻结不是吊销**：令牌还留着，重新启用后同一台手机接着用，不用重新扫码 ——
   * 与「断开连接」（吊销令牌、要 resume）刻意分开。
   */
  const disLi = await send(baseB, `/api/users/${encodeURIComponent(liId)}`, {
    method: 'PATCH',
    body: { disabled: true },
    headers: { Cookie: bossJar, 'X-Bandi': '1', ...csrfOf(bossJar) },
  });
  check('禁用小李 → 200', disLi.status === 200, `${disLi.status} ${disLi.json?.code ?? ''}`);
  check('禁用后那台手机立刻 401（以前它照连）', (await get(baseB, '/api/state', { Cookie: liPhoneCookie })).status === 401);
  const reOn = await send(baseB, `/api/users/${encodeURIComponent(liId)}`, {
    method: 'PATCH',
    body: { disabled: false },
    headers: { Cookie: bossJar, 'X-Bandi': '1', ...csrfOf(bossJar) },
  });
  check('重新启用 → 200', reOn.status === 200, `${reOn.status} ${reOn.json?.code ?? ''}`);
  check('冻结不是吊销：启用后同一台手机接着用（不用重扫）', (await get(baseB, '/api/state', { Cookie: liPhoneCookie })).status === 200);

  // 换人复用同一台手机：老板发的码把这部手机认到老王名下（复用行要改归属）
  const invBoss = await send(baseB, '/api/pair/tokens', { headers: { Cookie: bossJar, 'X-Bandi': '1', ...csrfOf(bossJar) } });
  const claimAgain = await send(baseB, '/api/pair/claim', {
    body: { code: invBoss.json.code, name: '小李的手机', clientKey: 'key-li-phone-0001' },
    headers: { 'X-Bandi': '1' },
  });
  check(
    '同一台手机换成老王的码重配 → 复用同一行、归属改成老王',
    claimAgain.status === 200 && claimAgain.json?.deviceId === claimLi.json?.deviceId && claimAgain.json?.owner === '老王',
    JSON.stringify(claimAgain.json),
  );

  /* ----------------------------- ⑤.9 扫码页的 csrf 自愈（2026-11-03 实机 E4099 回归） */
  /*
   * bandi_csrf 只活 1 天（Max-Age=86400），bandi_sid / bandi_token 活 30 天 / 1 年 ——
   * "凭据还在、csrf 先过期"是常态而非意外。/pair 分支若排在补种之前提前 return，
   * 扫码页就成了唯一自愈不了、又偏偏最需要自愈的页面：手机 jar 里有旧凭据、没有 csrf，
   * claim 是"带 Cookie 凭据的写请求" → 403 E4099（配对失败）；而手机没有地址栏，
   * 用户唯一的动作就是"重新扫码"，死循环。放在 ⑤.9 是因为下面的 claim 会新建设备、
   * 把前面的设备 jar 顶掉 —— 不能插在 ②.5 之前。两条断言钉住：
   *   a) GET /pair 必须顺手补种 bandi_csrf；
   *   b) "旧凭据 + 补种出的 csrf"的 claim 必须能过 —— 不能逼用户去清 Cookie。
   */
  console.log('\n⑤.9 扫码页的 csrf 自愈：旧凭据 + 过期 csrf 也能配对');
  const pairPage = await get(baseB, '/pair', { Accept: 'text/html' });
  const healedCsrf = (pairPage.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('bandi_csrf=')) ?? '';
  check('GET /pair 顺手补种 bandi_csrf（扫码页自愈）', pairPage.status === 200 && !!healedCsrf, `${pairPage.status} ${healedCsrf.slice(0, 26)}`);
  const healInv = await send(baseB, '/api/pair/tokens', { headers: op });
  const staleClaim = await send(baseB, '/api/pair/claim', {
    body: { code: healInv.json.code, name: '旧凭据手机', clientKey: 'key-stale-csrf-01' },
    // 模拟真实浏览器：补种出的 bandi_csrf 会被存进 jar 并随请求自动带上（和头是同一个值）
    headers: {
      'X-Bandi': '1',
      Cookie: `bandi_token=bd_stale_from_yesterday; ${healedCsrf}`,
      'X-Bandi-CSRF': decodeURIComponent(healedCsrf.split('=')[1]),
    },
  });
  check('旧凭据 + 补种出的 csrf → claim 照常过（不用清 Cookie）', staleClaim.status === 200, `${staleClaim.status} ${staleClaim.json?.code ?? ''}`);

  /* ----------------------------- ⑥ 回环形态（免鉴权）照常可用 */
  console.log('\n⑥ 回环形态（单机免鉴权）：operator 动作照常可用');
  const a = start(P_LOOP, { BANDI_HOST: '127.0.0.1' });
  const baseA = `http://127.0.0.1:${P_LOOP}`;
  if (!(await waitUp(baseA))) throw new Error('回环实例没起来：' + a.log().slice(-400));
  const inv2 = await send(baseA, '/api/pair/tokens');
  check('免鉴权下发码 → 200', inv2.status === 200 && /^\d{9}$/.test(inv2.json?.code ?? ''), String(inv2.json?.code ?? ''));
  const ok2 = await send(baseA, '/api/pair/claim', { body: { code: inv2.json.code, name: '回环手机' }, headers: { 'X-Bandi': '1' } });
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
