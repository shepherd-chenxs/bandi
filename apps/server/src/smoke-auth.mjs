/**
 * 访问令牌的验收（2026-10-15）。
 *
 * 规则只有一条，但**不能靠人记**：闸开不开只看**监听地址**。
 *   ① 只监听回环 → 免鉴权（桌面版/单机；"单机不需要 token"是硬约束）；
 *   ② 监听非回环 → **所有请求**都要令牌（服务器）；
 *   ③ 令牌三种带法都认：Cookie（浏览器）、`X-Bandi-Token` 头（节点/脚本）、`?token=`（首次进）；
 *   ④ 没带/带错：API 给 401 JSON（带 `platform: 'bandi'`），浏览器给登录页；
 *   ⑤ **`isUp()` 必须把 401 认成"是班底、只是要令牌"** ——
 *      否则启动器会把它当成"没起来"而再起一个，把现场搞乱；
 *   ⑥ 令牌落盘、重启不变；节点带着令牌能报到、不带会被拒。
 *
 * 隔离：临时数据目录 + 临时端口。
 * 跑法：node apps/server/src/smoke-auth.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { isUp, listeners, stopRunning, sleep } from './lifecycle.mjs';

const P_LOOP = Number(process.env.SMOKE_PORT ?? 8850);
const P_OPEN = P_LOOP + 1;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-auth-'));
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');
const NODE = path.join(repoRoot, 'apps', 'server', 'src', 'node.mjs');
const TOKEN_FILE = path.join(tmp, 'token');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const started = [];
function start(port, extra = {}) {
  const c = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, BANDI_PORT: String(port), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db'), ...extra },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(c);
  let log = '';
  c.stdout.on('data', (d) => (log += d));
  c.stderr.on('data', (d) => (log += d));
  return { child: c, log: () => log };
}

async function waitUp(base, ms = 15000) {
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
  for (const p of [P_LOOP, P_OPEN]) { try { stopRunning(p); } catch { /* 没在跑 */ } }
};

const get = async (base, p, headers = {}) => {
  const r = await fetch(base + p, { headers, redirect: 'manual' });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

/** POST/DELETE 也顺手包一个（下面那批"每节点令牌"的用例要用） */
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

try {
  /* ---------------------------------------------- ① 回环：免鉴权 */
  console.log('① 只监听回环 → 免鉴权（桌面版/单机那条路）');
  const a = start(P_LOOP, { BANDI_HOST: '127.0.0.1' });
  const baseA = `http://127.0.0.1:${P_LOOP}`;
  if (!(await waitUp(baseA))) throw new Error('回环那台没起来：' + a.log().slice(-400));
  check('不带令牌也能读状态', (await get(baseA, '/api/state')).status === 200);
  check('日志说清了"免鉴权"', /免鉴权/.test(a.log()), (a.log().match(/只监听回环.*/) ?? ['(没有)'])[0]);
  check('回环模式下不生成令牌文件', !fs.existsSync(TOKEN_FILE), TOKEN_FILE);
  check('isUp 认它是"起来了"', await isUp(P_LOOP));
  await cleanup();

  /* ---------------------------------------------- ② 非回环：全要令牌 */
  console.log('\n② 监听非回环 → 所有请求都要令牌');
  const b = start(P_OPEN, { BANDI_HOST: '0.0.0.0' });
  const baseB = `http://127.0.0.1:${P_OPEN}`;
  if (!(await waitUp(baseB))) throw new Error('非回环那台没起来：' + b.log().slice(-400));
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  check('令牌落盘了', token.length > 20, `${token.slice(0, 6)}…（${token.length} 字符）`);
  /*
   * ⚠️ 这一条**反过来**了（2026-10-16）：原来是"日志里打了令牌，与文件一致" ——
   * 理由当时是"自托管单操作员，打出来才找得到"。但日志的真实命运是被贴进聊天、被备份、被同步 ✗，
   * 而那枚令牌是**总机的 master 凭据**（所有节点、所有操作员共用同一枚）—— 贴一次日志 = 交出整套控制权。
   * 现在要钉住的是「**日志里没有令牌**」，同时它得说清令牌在哪儿（不然新用户找不着）。
   */
  const logText = b.log();
  check(
    '启动日志**不打**令牌（日志会被贴出去/被备份）',
    !logText.includes(token) && logText.includes('token 文件'),
    (logText.match(/访问令牌：.+/) ?? ['(没打这一行)'])[0].slice(0, 64),
  );

  console.log('\n③ 不带令牌：API 给 401、浏览器给登录页');
  const noTok = await get(baseB, '/api/state');
  check('API 返回 401', noTok.status === 401, String(noTok.status));
  check('正文带 platform=bandi（给启动器认的）', noTok.json?.platform === 'bandi', JSON.stringify(noTok.json));
  check('错误码是 E4010', noTok.json?.code === 'E4010', String(noTok.json?.code));
  const page = await get(baseB, '/');
  check('浏览器要页面 → 200 登录页', page.status === 200 && page.text.includes('name="token"'), `${page.status}`);
  check('登录页说了令牌在哪', /token/.test(page.text) && /数据目录/.test(page.text));

  console.log('\n④ 三种带法都认');
  check('头 X-Bandi-Token', (await get(baseB, '/api/state', { 'X-Bandi-Token': token })).status === 200);
  const q = await get(baseB, `/?token=${encodeURIComponent(token)}`);
  check('?token= 换 Cookie 并重定向', q.status === 302 && String(q.headers.get('set-cookie') ?? '').includes('bandi_token='), `${q.status}`);
  check('重定向把令牌从地址里摘掉了', (q.headers.get('location') ?? '').includes('token') === false, String(q.headers.get('location')));
  const cookie = String(q.headers.get('set-cookie') ?? '').split(';')[0];
  check('Cookie HttpOnly（JS 偷不走）', /HttpOnly/i.test(String(q.headers.get('set-cookie'))));
  check('带 Cookie 能读', (await get(baseB, '/api/state', { Cookie: cookie })).status === 200);
  check('令牌错的 → 401', (await get(baseB, '/api/state', { 'X-Bandi-Token': 'wrong-token' })).status === 401);
  check('令牌错的 → 登录页会报错', (await get(baseB, '/?token=wrong')).text.includes('令牌不对'));

  console.log('\n⑤ isUp 必须把 401 认成"是班底、只是要令牌"');
  check('isUp(非回环控制面) === true', (await isUp(P_OPEN)) === true);
  check('这也是启动器不会误判的前提（否则会再起一个）', await isUp(P_OPEN));

  console.log('\n⑥ 节点：带令牌能报到，不带会被明确拒绝');
  const runNode = (env) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [NODE, '--once'], {
        cwd: repoRoot,
        env: { ...process.env, BANDI_CONTROL_PLANE: baseB, BANDI_NODE_STATE: path.join(tmp, 'node.json'), ...env },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('exit', (code) => resolve({ code, out }));
    });

  const denied = await runNode({ BANDI_NODE_TOKEN: '' });
  check('不带令牌 → 报到被拒', /报到被拒/.test(denied.out), denied.out.trim().split('\n')[0]);
  check('而且告诉了他该设哪个变量', /BANDI_NODE_TOKEN/.test(denied.out));
  const ok = await runNode({ BANDI_NODE_TOKEN: token });
  check('带令牌 → 报到成功', /报到成功/.test(ok.out), ok.out.trim().split('\n').slice(-2)[0] ?? '');
  const devs = await get(baseB, '/api/devices', { 'X-Bandi-Token': token });
  check('设备列表里能看到这个节点', (devs.json?.devices ?? []).some((d) => d.kind === 'node'), JSON.stringify((devs.json?.devices ?? []).map((d) => d.id)));

  console.log('\n⑦ 令牌重启不变（否则每次重启都得重新登录）');
  await cleanup();
  const c2 = start(P_OPEN, { BANDI_HOST: '0.0.0.0' });
  if (!(await waitUp(baseB))) throw new Error('第二次没起来：' + c2.log().slice(-400));
  check('还是原来那个令牌', fs.readFileSync(TOKEN_FILE, 'utf8').trim() === token);
  check('旧令牌仍然能读', (await get(baseB, '/api/state', { 'X-Bandi-Token': token })).status === 200);
  check('日志标了"不是本次新建"', !/本次新生成/.test(c2.log()), (c2.log().match(/来自 .*/) ?? ['(没有)'])[0]);

  /*
   * ⑧ **每节点令牌 ＋ 权限边界**（2026-10-16）。
   *
   * 这一节是那次改动的**全部意义**：一台节点被翻，不该等于整套被翻；
   * 「忘掉」也该是**真的把它踢出去**，而不是删了记录等它下次心跳回来。
   */
  console.log('\n⑧ 每节点令牌：邀请码加入 → 只能干自己那台的事');
  const op = { 'X-Bandi-Token': token }; // 操作员令牌
  const inv = await send(baseB, '/api/nodes/invites', { headers: op });
  check('操作员能发邀请码', inv.status === 201 && /^bj_/.test(inv.json?.code ?? ''), String(inv.json?.code ?? '').slice(0, 10));
  check('邀请码带过期时间', !!inv.json?.expiresAt, String(inv.json?.expiresAt ?? ''));

  const joinBody = { code: inv.json.code, id: 'node-joined', label: '新机器', hostname: 'new-host', platform: 'linux x64', runtimes: [] };
  const joined = await send(baseB, '/api/nodes/join', { body: joinBody });
  check('凭邀请码加入 → 换回**自己那枚**令牌', joined.status === 201 && /^bn_/.test(joined.json?.token ?? ''), String(joined.json?.token ?? '').slice(0, 8));
  const ntok = joined.json?.token ?? '';
  check('这枚令牌**不是**总机那枚 master', ntok !== token && ntok.length > 20);

  const reuse = await send(baseB, '/api/nodes/join', { body: { ...joinBody, id: 'node-other' } });
  check('邀请码一次性：再用就被拒（401）', reuse.status === 401, `${reuse.status} ${reuse.json?.code ?? ''}`);
  const badCode = await send(baseB, '/api/nodes/join', { body: { code: 'bj_瞎编的', id: 'node-x' } });
  check('瞎编的邀请码进不来', badCode.status === 401, String(badCode.status));

  const nodeHdr = { 'X-Bandi-Token': ntok };
  /*
   * ⚠️ **报到也要测**（2026-10-16 真机迁移时才发现的漏）：`/api/nodes/register` 是**共享**端点
   * （id 在 body 里），我第一版白名单把路径写成 `/api/nodes/<id>/register` —— 那个端点不存在 ✗，
   * 于是节点连报到都过不去。用例当时只测了心跳和领活，没拦住。
   */
  const reg = await send(baseB, '/api/nodes/register', {
    headers: nodeHdr,
    body: { id: 'node-joined', label: '新机器', hostname: 'new-host', platform: 'linux x64', runtimes: [] },
  });
  check('节点令牌能**报到**（共享端点，id 在 body 里）', reg.status === 201, String(reg.status));
  const regOther = await send(baseB, '/api/nodes/register', {
    headers: nodeHdr,
    body: { id: 'node-别人的', label: 'x', hostname: 'x', platform: 'linux x64', runtimes: [] },
  });
  check('但**不许用别人的 id**报到（403）', regOther.status === 403, String(regOther.status));
  check('节点令牌能心跳（它自己的活）', (await send(baseB, '/api/nodes/node-joined/heartbeat', { headers: nodeHdr })).status === 200);
  check('节点令牌能领活', (await send(baseB, '/api/nodes/node-joined/claim', { headers: nodeHdr, body: { waitMs: 200 } })).status === 200);

  /*
   * ⚠️ 下面这几条是**边界**，松一条这次改动就白做：
   */
  const peek = await get(baseB, '/api/devices', nodeHdr);
  check('节点令牌**读不了设备列表**（403）', peek.status === 403, `${peek.status} ${peek.json?.code ?? ''}`);
  check('越界时明确告诉它该用哪枚令牌', /操作员令牌/.test(peek.json?.hint ?? ''), String(peek.json?.hint ?? '').slice(0, 40));
  const other = await send(baseB, '/api/nodes/node-other/heartbeat', { headers: nodeHdr });
  check('节点令牌碰不了**别人那台**（403）', other.status === 403, String(other.status));
  const conv = await get(baseB, '/api/threads', nodeHdr);
  check('对话也读不了', conv.status === 403 || conv.status === 404, String(conv.status));
  check('操作员令牌不受影响（照旧能读设备）', (await get(baseB, '/api/devices', op)).status === 200);

  /* 忘掉 = 真踢出：记录删掉**并吊销令牌** */
  const del = await send(baseB, '/api/nodes/node-joined', { method: 'DELETE', headers: op });
  check('忘掉它 → 顺带吊销它那枚令牌', del.status === 200 && del.json?.revokedTokens === 1, JSON.stringify(del.json));
  const afterDel = await send(baseB, '/api/nodes/node-joined/heartbeat', { headers: nodeHdr });
  check('吊销之后那枚令牌**再也进不来**（这才是"忘掉"该有的样子）', afterDel.status === 401, String(afterDel.status));
  const back = await send(baseB, '/api/nodes/node-joined/heartbeat', { headers: op });
  check('操作员照旧能把一台重新加回来（邀请码那条路还在）', back.status === 404 || back.status === 200, String(back.status));

  /*
   * ⑨ 局域网开关（桌面版那个「允许局域网内的机器加入」）。
   *
   * 这一节要钉的是它的**安全含义**：开关一开，监听地址就变成 0.0.0.0，
   * 于是"只看监听地址"那条规则**自动把鉴权打开** ✓ —— 不需要用户再记得去设令牌。
   * （判据在 config.mjs：它读数据目录里的 netmode.json，所以桌面壳 / 开机自启 / 命令行三种起法都认。）
   */
  console.log('\n⑨ 局域网开关：打开 = 监听 0.0.0.0 + 自动要令牌');
  const NM = path.join(tmp, 'netmode.json');
  fs.writeFileSync(NM, JSON.stringify({ allowLan: true }), 'utf8');
  const P_LAN = P_OPEN + 1;
  const c3 = start(P_LAN, {}); // **不**给 BANDI_HOST —— 让它自己按开关定
  const baseC = `http://127.0.0.1:${P_LAN}`;
  if (!(await waitUp(baseC))) throw new Error('按开关起不来：' + c3.log().slice(-300));
  const lanNoTok = await get(baseC, '/api/state');
  check('不给 BANDI_HOST，开关一开就自动要令牌（401）', lanNoTok.status === 401, String(lanNoTok.status));
  check('带上令牌照旧能读', (await get(baseC, '/api/state', { 'X-Bandi-Token': token })).status === 200);
  const lanInfo = await get(baseC, '/api/lan', { 'X-Bandi-Token': token });
  check('它自己也知道现在听着局域网（boundLan）', lanInfo.json?.boundLan === true, JSON.stringify(lanInfo.json));
  check('靠开关起来的 → explicit=false（这台的监听地址没被命令行指定）', lanInfo.json?.explicit === false, String(lanInfo.json?.explicit));
  /*
   * ⚠️ 云端那台是 `BANDI_HOST=0.0.0.0` 显式起的 —— 开关对它**无效**（env 优先）。
   * 这一条钉住"如实回报"，不然界面会按开关值说"关着 —— 只听本机"，而它明明对外开着 ✗。
   */
  const lanOpen = await get(baseB, '/api/lan', { 'X-Bandi-Token': token });
  check('命令行指定过监听地址的（云端那种）→ explicit=true + 确实对外', lanOpen.json?.explicit === true && lanOpen.json?.boundLan === true, JSON.stringify(lanOpen.json));
  check('那种情况不再说"要重启"（开关本来就管不着它）', lanOpen.json?.restartNeeded === false, String(lanOpen.json?.restartNeeded));
  check('这时候不再提示"要重启"', lanInfo.json?.restartNeeded === false, String(lanInfo.json?.restartNeeded));
  check('并且给出了"让别的机器连这个地址"', (lanInfo.json?.urls ?? []).some((u) => /^http:\/\/\d+\.\d+\.\d+\.\d+:/.test(u)), JSON.stringify(lanInfo.json?.urls ?? []));
  const lanBack = await send(baseC, '/api/lan', { method: 'POST', headers: { 'X-Bandi-Token': token, 'X-Bandi': '1' }, body: { allowLan: false } });
  check('把开关拨回去 → 提示要重启才生效', lanBack.json?.allowLan === false && lanBack.json?.restartNeeded === true, JSON.stringify(lanBack.json));

  /*
   * ⑩ **原地重启**（界面上那颗「重启生效」）—— 2026-10-16 用户问"重启怎么重启？关掉软件吗？"。
   *
   * 要钉住三件事：
   *   ① 改完开关，**不用关掉软件**，打一下这个接口就把监听换过去；
   *   ② 换过去之后鉴权真的生效（不带令牌 401）；
   *   ③ 但**用户自己那个浏览器不能被挡在外面** —— 响应里必须带令牌 Cookie ✓
   *      （第一版忘了：回环形态下压根没生成过令牌，Cookie 设不出来 ✗）。
   */
  console.log('\n⑩ 原地重启：不关软件就把监听换过去');
  /*
   * 两个方向都要走一遍 —— 只走一个方向的话，`from === to`（"不用动"那条路）会被误当成成功 ✗
   * （第一版就是这样，白跑一轮）。
   */
  const restart = async () =>
    fetch(`${baseC}/api/restart`, {
      method: 'POST',
      // ⚠️ 这个实例是**靠开关起的** → 它一直要求令牌 ✓，所以调重启也得带着
      headers: { 'Content-Type': 'application/json', 'X-Bandi': '1', 'X-Bandi-Token': token },
      body: '{}',
    });

  // 方向一：现在开关是"关"、进程还听着局域网 → 重启该换回**只听本机**
  const rs = await restart();
  const rsBody = await rs.json().catch(() => null);
  check('方向一：0.0.0.0 → 127.0.0.1（真的换了，不是"不用动"）', rs.status === 200 && rsBody?.from === '0.0.0.0' && rsBody?.to === '127.0.0.1', JSON.stringify(rsBody));
  await sleep(2500);
  const stOff = await get(baseC, '/api/state');
  check('换回本机之后：不带令牌也能读（回到单机那种免鉴权形态）', stOff.status === 200, String(stOff.status));
  const lanOff = await get(baseC, '/api/lan');
  check('它自己也说回到只听本机了', lanOff.json?.boundLan === false && lanOff.json?.restartNeeded === false, JSON.stringify(lanOff.json));

  // 方向二：打开开关 + 重启 → 鉴权要开，而且响应里必须给令牌 Cookie
  await send(baseC, '/api/lan', { method: 'POST', headers: { 'X-Bandi': '1' }, body: { allowLan: true } });
  const rs2 = await restart();
  const rs2Body = await rs2.json().catch(() => null);
  const rsCookie = String(rs2.headers.get('set-cookie') ?? '').split(';')[0];
  check('方向二：127.0.0.1 → 0.0.0.0', rs2.status === 200 && rs2Body?.from === '127.0.0.1' && rs2Body?.to === '0.0.0.0', JSON.stringify(rs2Body));
  check('响应里带令牌 Cookie（不然用户自己的窗口会被登录页挡住）', /^bandi_token=/.test(rsCookie), rsCookie ? rsCookie.slice(0, 20) + '…' : '(没有)');
  await sleep(2500);
  check('重启后：不带令牌 → 401（鉴权真开了）', (await get(baseC, '/api/state')).status === 401);
  check('重启后：带那个 Cookie → 200（浏览器不用重新登录）', (await get(baseC, '/api/state', { Cookie: rsCookie })).status === 200);
  const lanAfter = await get(baseC, '/api/lan', { Cookie: rsCookie });
  check('重启后它自己也说在听局域网了', lanAfter.json?.boundLan === true && lanAfter.json?.restartNeeded === false, JSON.stringify(lanAfter.json));
  check('页面报的监听地址是**实际**那个（不是启动时那个）', lanAfter.json?.host === '0.0.0.0', String(lanAfter.json?.host));
  const nodeStillOk = await send(baseC, '/api/nodes/register', { headers: { 'X-Bandi-Token': token }, body: { id: 'node-after-restart', label: 'x', hostname: 'x', platform: 'linux x64', runtimes: [] } });
  check('操作员令牌在重启后照旧能用', nodeStillOk.status === 201, String(nodeStillOk.status));
  fs.rmSync(NM, { force: true });
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  await cleanup();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
