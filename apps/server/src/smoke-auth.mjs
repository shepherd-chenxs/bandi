/**
 * 访问闸的验收（2026-11-07 中枢登录一刀后重写）。
 *
 * 闸现在分**两层**，别混：
 *   · **机器层**（①-⑤、⑦-⑪）：令牌闸开不开只看**监听地址** ——
 *     只监听回环 → API 免鉴权（桌面版/单机；"单机不需要 token"是硬约束）；
 *     监听非回环 → **所有请求**都要令牌（服务器）；
 *     令牌三种带法都认：Cookie（浏览器）、`X-Bandi-Token` 头（节点/脚本）、`?token=`（首次进）；
 *     没带/带错：API 给 401 JSON（带 `platform: 'bandi'`），浏览器给登录页；
 *     **`isUp()` 必须把 401 认成"是班底、只是要令牌"** —— 否则启动器会把它当成"没起来"而再起一个；
 *     令牌落盘、重启不变；节点带着令牌能报到、不带会被拒。
 *   · **人层**（③⑥）：面板 HTML 只给**登录会话**（bandi_sid）。本地账号体系已整体退场
 *     （BANDI_HUB=off 这个选项没了），唯一的登录是中枢账号密码框（POST /hub/login）——
 *     测试把 BANDI_HUB 指到假中枢（hub-stub.mjs），不然就会去连真的 hub.yuancang.space。
 *     **令牌不是人**：operator 抓面板 HTML 也只得到登录页，令牌继续管 API（脚本/CLI/节点）。
 *
 * 隔离：临时数据目录 + 临时端口 + 假中枢。
 * 跑法：node apps/server/src/smoke-auth.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { isUp, stopRunning, sleep } from './lifecycle.mjs';
// 假中枢 + 登录帮手：造人层会话只有一条真路 —— 起个假中枢，让本机把登录表单转给它
import { startHubStub, hubLogin } from './hub-stub.mjs';

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
  /*
   * ⚠️ **剥掉继承来的 BANDI_HOST**（2026-11-03）：run-smokes 给所有子进程钉
   * `BANDI_HOST=127.0.0.1` 当免鉴权底座，而 ⑩ 测的恰恰是"**不给** BANDI_HOST
   * = 缺省 0.0.0.0 + 自动要令牌" —— 不剥的话 ⑩ 拿到的是继承来的回环，永远测不到缺省。
   * 各形态要什么监听地址，用例自己在 extra 里显式给。
   *
   * ⚠️ BANDI_HUB **必须**显式指到假中枢（2026-11-07）：本地登录没了，中枢地址永远有值
   * （内置默认），不指就会去连真的 hub.yuancang.space —— 那不是测试该干的事。
   */
  const { BANDI_HOST: _inheritedHost, ...baseEnv } = process.env;
  const c = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...baseEnv, BANDI_PORT: String(port), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db'), BANDI_HUB: HUB.url, ...extra },
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

/* 假中枢：一个中枢账号（⑥ 的人层会话从它来） */
const HUB = await startHubStub({ deviceId: 'dev_self', accounts: { 甲: { password: '甲-pass-123' } } });

try {
  /* ---------------------------------------------- ① 回环：免鉴权 */
  console.log('① 只监听回环 → API 免鉴权（桌面版/单机那条路）');
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

  console.log('\n③ 不带令牌：API 给 401、浏览器给中枢登录页');
  const noTok = await get(baseB, '/api/state');
  check('API 返回 401', noTok.status === 401, String(noTok.status));
  check('正文带 platform=bandi（给启动器认的）', noTok.json?.platform === 'bandi', JSON.stringify(noTok.json));
  check('错误码是 E4010', noTok.json?.code === 'E4010', String(noTok.json?.code));
  /*
   * 2026-11-07 改口径：本地账号体系退场，登录页只剩**一张** —— 中枢账号密码框。
   * 「登录即注册」：没有单独的注册按钮，页脚写明「提交就自动创建」（routes/hub.mjs
   * 的 mode 注释同口径），没有"零账号给建号页"的分支了。这里钉的是「给的是中枢登录页、且不泄面板」。
   */
  const page = await get(baseB, '/');
  check('浏览器要页面 → 200 中枢登录页（零账号也是它）', page.status === 200 && page.text.includes('action="/hub/login"'), `${page.status}`);
  check('登录页有手机号+密码输入框，注册没有独立按钮（登录即注册）',
    page.text.includes('name="username"') && page.text.includes('type="password"')
    && page.text.includes('提交就自动创建') && !page.text.includes('value="register"'));
  check('不是面板（/app.mjs 不出现在登录页）', !page.text.includes('/app.mjs'));
  /*
   * **壳不该看到登录页**（2026-11-08）：原生壳在 UA 末尾带 `BandiShell/<版本>`，
   * 它出现在这里说明**本机会话过期了**（12 小时绝对 / 30 分钟空闲），而不是"有人要登录"。
   * 壳握着 30 天的中枢会话，随时能重签一张票，所以服务端改道 /hub/expired 由壳静默重进。
   *
   * 钉三件事：① 带壳标记 → 302（不是 200 登录页）；② 落点能让壳认出来；
   * ③ 兜底页本身能开（壳没接住时不至于 401/白屏）。浏览器那条路在上面已经钉住了。
   */
  const shellUa = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 BandiShell/1.5.21';
  const shellPage = await get(baseB, '/', { 'user-agent': shellUa, accept: 'text/html' });
  check('壳要页面 → 302（不发登录页）', shellPage.status === 302, String(shellPage.status));
  check('改道到哪里：/hub/expired', (shellPage.headers.get('location') ?? '') === '/hub/expired', String(shellPage.headers.get('location')));
  const expiredPage = await get(baseB, '/hub/expired', { 'user-agent': shellUa, accept: 'text/html' });
  check('兜底页能开、不要求登录（200 + 正在重新连接）',
    expiredPage.status === 200 && expiredPage.text.includes('正在重新连接'),
    `${expiredPage.status}`);
  check('兜底页里没有登录表单（别在这儿把人拦下来）', !expiredPage.text.includes('action="/hub/login"'));
  /*
   * ⚠️ 静态资源**不能**吃到登录页 HTML（2026-11-02 三十三改）：/app.mjs 这类非页面请求
   * 没有 Accept: text/html，落到 401 JSON —— 回成 HTML 的话浏览器按 module 执行必然报
   * 语法错误，看起来像"文件没部署上"，比 401 难查得多。
   */
  const staticNoTok = await get(baseB, '/app.mjs');
  check('静态文件没凭据 → 401 JSON E4010（不是登录页 HTML）',
    staticNoTok.status === 401 && staticNoTok.json?.code === 'E4010' && /application\/json/.test(staticNoTok.headers.get('content-type') ?? ''),
    `${staticNoTok.status} ${staticNoTok.headers.get('content-type')}`);

  console.log('\n④ 三种带法都认');
  check('头 X-Bandi-Token', (await get(baseB, '/api/state', { 'X-Bandi-Token': token })).status === 200);
  const q = await get(baseB, `/?token=${encodeURIComponent(token)}`);
  check('?token= 换 Cookie 并重定向', q.status === 302 && String(q.headers.get('set-cookie') ?? '').includes('bandi_token='), `${q.status}`);
  check('重定向把令牌从地址里摘掉了', (q.headers.get('location') ?? '').includes('token') === false, String(q.headers.get('location')));
  const cookie = String(q.headers.get('set-cookie') ?? '').split(';')[0];
  check('Cookie HttpOnly（JS 偷不走）', /HttpOnly/i.test(String(q.headers.get('set-cookie'))));
  check('带 Cookie 能读', (await get(baseB, '/api/state', { Cookie: cookie })).status === 200);
  check('令牌错的 → 401', (await get(baseB, '/api/state', { 'X-Bandi-Token': 'wrong-token' })).status === 401);
  /*
   * 错令牌不许换出面板（口径随 2026-11-07 一刀更新）：**令牌不是人** —— 面板 HTML 只给
   * 登录会话，带令牌/错令牌抓首页一律得到中枢登录页。令牌继续管 API（上面那些 200）。
   */
  const badPage = await get(baseB, '/?token=wrong');
  check('错令牌 → 还是登录页，不是面板',
    badPage.status === 200 && badPage.text.includes('action="/hub/login"') && !badPage.text.includes('/app.mjs'));
  const tokPage = await get(baseB, '/', { Cookie: cookie });
  check('对令牌抓首页**同样**是登录页（令牌不是"我"，登录只认会话）',
    tokPage.status === 200 && tokPage.text.includes('action="/hub/login"') && !tokPage.text.includes('/app.mjs'));

  console.log('\n⑤ isUp 必须把 401 认成"是班底、只是要令牌"');
  check('isUp(非回环控制面) === true', (await isUp(P_OPEN)) === true);
  check('这也是启动器不会误判的前提（否则会再起一个）', await isUp(P_OPEN));

  /*
   * ⑥ **人走中枢**（2026-11-07）：/hub/login 是唯一的登录。
   *
   * 表单提交到本机 /hub/login → 主机转给假中枢认人 → 绑本地影子用户 → 发 bandi_sid。
   * 失败（中枢拒绝）原地回登录页；成功进面板。这一节也钉住"面板 vs 登录页"的分界线：
   * 同一台服务器，有没有会话就是两种页面。
   */
  console.log('\n⑥ 人走中枢：POST /hub/login 全链（假中枢）');
  const badLogin = await hubLogin(baseB, { username: '甲', password: 'not-the-password', origin: baseB });
  check('错密码 → 401 原地回登录页（中枢的拒绝，本机不遮）',
    badLogin.status === 401 && badLogin.html.includes('action="/hub/login"'), `HTTP ${badLogin.status}`);
  const okLogin = await hubLogin(baseB, { username: '甲', password: '甲-pass-123', origin: baseB });
  check('对的账号密码 → 302 回首页 + bandi_sid',
    okLogin.status === 302 && okLogin.location === '/' && !!okLogin.sid, `HTTP ${okLogin.status}`);
  const panel = await get(baseB, '/', { Cookie: `bandi_sid=${okLogin.sid}`, Accept: 'text/html' });
  check('带着中枢会话 → 面板本体（<title>班底</title>）',
    panel.status === 200 && panel.text.includes('<title>班底</title>') && panel.text.includes('/app.mjs'), String(panel.status));
  const meHub = await get(baseB, '/api/me', { Cookie: `bandi_sid=${okLogin.sid}` });
  check('/api/me → kind=user（本地影子账号随登录自动建好）',
    meHub.json?.kind === 'user' && meHub.json?.user?.name === '甲', JSON.stringify(meHub.json ?? {}));
  const anon = await get(baseB, '/');
  check('同一台服务器，没会话就还是登录页（面板只给登录的人）',
    anon.status === 200 && anon.text.includes('action="/hub/login"') && !anon.text.includes('/app.mjs'));

  console.log('\n⑦ 节点：带令牌能报到，不带会被明确拒绝');
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

  console.log('\n⑧ 令牌重启不变（否则每次重启都得重新登录）');
  await cleanup();
  const c2 = start(P_OPEN, { BANDI_HOST: '0.0.0.0' });
  if (!(await waitUp(baseB))) throw new Error('第二次没起来：' + c2.log().slice(-400));
  check('还是原来那个令牌', fs.readFileSync(TOKEN_FILE, 'utf8').trim() === token);
  check('旧令牌仍然能读', (await get(baseB, '/api/state', { 'X-Bandi-Token': token })).status === 200);
  check('日志标了"不是本次新建"', !/本次新生成/.test(c2.log()), (c2.log().match(/来自 .*/) ?? ['(没有)'])[0]);

  /*
   * ⑨ **每节点令牌 ＋ 权限边界**（2026-10-16）。
   *
   * 这一节是那次改动的**全部意义**：一台节点被翻，不该等于整套被翻；
   * 「忘掉」也该是**真的把它踢出去**，而不是删了记录等它下次心跳回来。
   */
  console.log('\n⑨ 每节点令牌：邀请码加入 → 只能干自己那台的事');
  /*
   * 角色位（2026-11-01 晚）：发邀请码要求这台是**总机**（`acceptNodes:true`）——
   * 监听地址（缺省 0.0.0.0）是启动配置的事，跟"收不收节点"再无关联。
   */
  fs.writeFileSync(path.join(tmp, 'netmode.json'), JSON.stringify({ acceptNodes: true }, null, 2), 'utf8');
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
   * ⑩ **缺省对外监听**（2026-11-03：不给 BANDI_HOST 就是 0.0.0.0）。
   *
   * "对外服务"这一维整个删了：监听地址是启动配置（缺省 0.0.0.0，`BANDI_HOST` 可钉具体
   * 地址），界面上没有开关、没有「重启」。这一节钉住**缺省路径**：什么都不配，起来就
   * 在听局域网 —— 于是"只看监听地址"那条规则**自动把鉴权打开** ✓，不需要用户记得设令牌。
   */
  console.log('\n⑩ 缺省对外监听：不给 BANDI_HOST = 0.0.0.0 + 自动要令牌');
  const P_LAN = P_OPEN + 1;
  const c3 = start(P_LAN, {}); // **不**给 BANDI_HOST —— 缺省就该对外听
  const baseC = `http://127.0.0.1:${P_LAN}`;
  if (!(await waitUp(baseC))) throw new Error('缺省起不来：' + c3.log().slice(-300));
  const lanNoTok = await get(baseC, '/api/state');
  check('不给 BANDI_HOST 也对外听 → 自动要令牌（401）', lanNoTok.status === 401, String(lanNoTok.status));
  check('带上令牌照旧能读', (await get(baseC, '/api/state', { 'X-Bandi-Token': token })).status === 200);
  const lanInfo = await get(baseC, '/api/lan', { 'X-Bandi-Token': token });
  check('它自己也知道现在听着局域网（boundLan）', lanInfo.json?.boundLan === true, JSON.stringify(lanInfo.json));
  check('报的监听地址是实际那个（0.0.0.0）', lanInfo.json?.host === '0.0.0.0', String(lanInfo.json?.host));
  check('并且给出了"让别的机器连这个地址"', (lanInfo.json?.urls ?? []).some((u) => /^http:\/\/\d+\.\d+\.\d+\.\d+:/.test(u)), JSON.stringify(lanInfo.json?.urls ?? []));
  check('/api/lan 响应不再有 restartNeeded（中间态的字段一起陪葬）', lanInfo.json != null && !('restartNeeded' in lanInfo.json), Object.keys(lanInfo.json ?? {}).join(','));
  /*
   * "对外"的不变量不能只在回环上验（2026-11-03 补）：鉴权开是因为**监听对外**，
   * 那就该真的从局域网地址走一遍 —— 匿名被挡、带令牌能通、配对页照开。
   * （urls 取本机真实网卡地址，本机连自己的局域网地址不需要任何外部条件。）
   */
  const lanUrl = (lanInfo.json?.urls ?? []).find((u) => u.startsWith('http://'));
  const lanAnon = await get(lanUrl, '/api/state');
  check('从局域网地址进来同样要令牌（鉴权跟来源无关，只跟"对外"有关）', lanAnon.status === 401, String(lanAnon.status));
  check('局域网地址带令牌照常能读', (await get(lanUrl, '/api/state', { 'X-Bandi-Token': token })).status === 200);
  /*
   * 匿名抓首页 = 中枢账号登录页（2026-11-07：配对页随设备令牌体系退场，手机浏览器与
   * 桌面走同一张登录页）。顺带钉住「所有 HTML 响应之前必须补种 CSRF Cookie」——
   * 那是 E4099 的病根，与页面本身叫什么无关。
   */
  const loginPage = await get(lanUrl, '/');
  check('匿名开首页 → 200 HTML 登录页', loginPage.status === 200 && /text\/html/.test(loginPage.headers.get('content-type') ?? ''), String(loginPage.status));
  check('登录页响应带着补种的 CSRF Cookie（E4099 的病根钉住）', /bandi_csrf=/.test(loginPage.headers.get('set-cookie') ?? ''), loginPage.headers.get('set-cookie') ?? '(无)');
  check('匿名 POST 写接口也被挡（对外形态下写比读更不能裸）', (await send(lanUrl, '/api/projects', { headers: {} })).status === 401, '401 才对');
  /*
   * 老客户端（旧界面 / 旧脚本）可能还在发 `allowLan`。已删的键必须**写不回配置**
   * （patch 不认它 → netmode.json 不长出这个键），接口本身照回 200 —— 状态不漂移，
   * 老调用方也不炸。
   */
  const lanLegacy = await send(baseC, '/api/lan', { method: 'POST', headers: { 'X-Bandi-Token': token, 'X-Bandi': '1' }, body: { allowLan: false } });
  const nmAfter = JSON.parse(fs.readFileSync(path.join(tmp, 'netmode.json'), 'utf8'));
  check(
    '老客户端发 allowLan → 200 且键被忽略（不写回 netmode.json）',
    lanLegacy.status === 200 && !('allowLan' in nmAfter),
    JSON.stringify(nmAfter),
  );
  check('netmode.json 也不长出 restartNeeded 这种已删的键', !('restartNeeded' in nmAfter), JSON.stringify(nmAfter));

  /*
   * ⑪ 「重启生效」整个下线（2026-11-03）。
   *
   * 监听地址不再随运行期开关变 —— `/api/restart` 连接口一起删了。要钉住两件事：
   *   ① 接口真没了（路由权限清单默认拒绝，E4090）—— 谁按老文档打它，得得到明确的"没有"；
   *   ② 角色切换**立刻生效**，没有"改了还没生效"的中间态 —— 那个中间态正是这次删掉的
   *      第三态的根，`restartNeeded` / `allowLan` 字段也不许再出现在响应里。
   *   （这里的"角色"是**机器**的总机/分机角色，与人登录后的权限无关 —— 人登录即全权。）
   */
  console.log('\n⑪ /api/restart 已删；机器角色切换立刻生效，没有"重启"中间态');
  const rs = await send(baseC, '/api/restart', { headers: { 'X-Bandi-Token': token, 'X-Bandi': '1' } });
  check('POST /api/restart → E4090（接口已删，默认拒绝）', rs.json?.code === 'E4090', JSON.stringify(rs.json));
  check('GET /api/restart 也一样是 E4090（不是只拦 POST）', (await get(baseC, '/api/restart', { 'X-Bandi-Token': token })).json?.code === 'E4090');
  const toBranch = await send(baseC, '/api/lan', { method: 'POST', headers: { 'X-Bandi-Token': token, 'X-Bandi': '1' }, body: { acceptNodes: false } });
  check('切分机 → 立刻生效（role 变 branch，不用重启）', toBranch.status === 200 && toBranch.json?.role === 'branch', JSON.stringify(toBranch.json));
  check('响应里没有 allowLan / restartNeeded 这种中间态字段', toBranch.json != null && !('allowLan' in toBranch.json) && !('restartNeeded' in toBranch.json), Object.keys(toBranch.json ?? {}).join(','));
  const toHub = await send(baseC, '/api/lan', { method: 'POST', headers: { 'X-Bandi-Token': token, 'X-Bandi': '1' }, body: { acceptNodes: true } });
  check('切回总机 → role 变 hub', toHub.status === 200 && toHub.json?.role === 'hub', String(toHub.json?.role));
  check('操作员令牌照旧能用（角色切了个来回，鉴权不受影响）', (await get(baseC, '/api/state', { 'X-Bandi-Token': token })).status === 200);
  const lanFinal = await get(baseC, '/api/lan', { 'X-Bandi-Token': token });
  check('角色切了个来回，监听地址纹丝不动（监听归启动配置管，跟角色无关）', lanFinal.json?.host === '0.0.0.0', String(lanFinal.json?.host));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  await cleanup();
  try { await HUB.close(); } catch { /* 已经关了 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
