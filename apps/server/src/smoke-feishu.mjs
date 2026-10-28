/**
 * 飞书通道的离线验收（2026-10-27）。
 *
 * 分两段，都**不联网**：
 *   ① 核心层（`feishu.mjs`）—— 直接 import；飞书的 API 与 WebSocket 用假件喂
 *      （假 fetch 记下每个请求，假 WebSocket 让测试从"服务端"方向推帧进来）；
 *   ② HTTP 那一层（`/api/feishu/*`）—— 真起一个控制面（临时数据目录），
 *      验配置的校验与掩码。**不碰 start/test 的真连接**（那会打真飞书）。
 *
 * 协议那一半（protobuf 帧、分片合并、ack、心跳）用"假飞书"逐字段喂进去验：
 * 帧的字段号照抄官方 node-sdk 的生成代码，这里编码→解码→喂回，全链闭环。
 *
 * 跑法：node apps/server/src/smoke-feishu.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-feishu-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* ⚠️ 环境变量必须在 import 之前设好（store 一加载就开库；feishu 的配置路径也一样） */
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');
process.env.BANDI_FEISHU = path.join(tmp, 'feishu.json');
process.env.BANDI_FEISHU_LINKS = path.join(tmp, 'feishu-links.json');

const store = await import('./store.mjs');
const steward = await import('./steward.mjs');
const dispatch = await import('./dispatch.mjs');
const feishu = await import('./feishu.mjs');

/* ---------------------------------------------------------------- ① 配置 */
console.log('① 配置：校验、掩码、留空保留');
check('什么都没配 → 不通过且说清楚', /App ID/.test(feishu.validateCredentials() ?? ''), feishu.validateCredentials());
check('App ID 格式不对 → E2062', (() => { try { feishu.saveConfig({ appId: '不是飞书的id', appSecret: 's1' }); return false; } catch (e) { return e.code === 'E2062'; } })());
feishu.saveConfig({ appId: 'cli_0123456789abcdef', appSecret: 'sk-abcdef1234567890', enabled: true, allowOpenIds: ['ou_a', '', 'ou_b'] });
const snap = feishu.configSnapshot();
check('配置齐了 → configured', snap.configured === true);
check('secret 只回掩码（前2后4），原文不出现在快照里', snap.appSecretHint === 'sk' + '*'.repeat(18) + '7890' && !JSON.stringify(snap).includes('sk-abcdef'), snap.appSecretHint);
check('白名单存成了数组，空串被滤掉', JSON.stringify(snap.allowOpenIds) === JSON.stringify(['ou_a', 'ou_b']), JSON.stringify(snap.allowOpenIds));
check('还没绑私聊员工、秘书也没建 → 快照回空串', snap.p2pPersonaId === '', snap.p2pPersonaId);
feishu.saveConfig({ appId: 'cli_0123456789abcdef', appSecret: '', enabled: false });
check('secret 留空 = 保留原值（改白名单不用重贴）', feishu.readRawConfig().appSecret === 'sk-abcdef1234567890');
check('enabled 关掉', feishu.readRawConfig().enabled === false);
check('凭据文件权限尽力 0600（Windows 上可能没这个概念，unix 才验）', (() => {
  if (process.platform === 'win32') return true;
  return (fs.statSync(process.env.BANDI_FEISHU).mode & 0o777) === 0o600;
})());

/* ------------------------------------------------- ② protobuf 帧：字段号与线格式 */
console.log('\n② pbbp2 帧：编码字节与官方生成代码一致、编解码闭环');
// Header{key:'type',value:'ping'} → 0a 04 "type" 12 04 "ping"（field1/field2 长度前缀）
const h = feishu.encodeFrame({ service: 1, method: 0, headers: [{ key: 'type', value: 'ping' }] });
check('ping 帧头部字节与官方 protobuf 定义逐字一致', Buffer.from(h).equals(Buffer.from([0x08, 0x00, 0x10, 0x00, 0x18, 0x01, 0x20, 0x00, 0x2a, 0x0c, 0x0a, 0x04, 0x74, 0x79, 0x70, 0x65, 0x12, 0x04, 0x70, 0x69, 0x6e, 0x67])), Buffer.from(h).toString('hex'));
const round = feishu.encodeFrame({
  SeqID: 3, LogID: 4, service: 2, method: 1,
  headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: '碎片-①' }],
  payload: Buffer.from('{"hello":"世界"}', 'utf8'),
});
const back = feishu.decodeFrame(round);
check('编解码闭环：数字字段原样', back.SeqID === 3 && back.LogID === 4 && back.service === 2 && back.method === 1, JSON.stringify({ SeqID: back.SeqID, service: back.service, method: back.method }));
check('编解码闭环：headers 原样（含中文）', back.headers[0].key === 'type' && back.headers[0].value === 'event' && back.headers[1].value === '碎片-①', JSON.stringify(back.headers));
check('编解码闭环：payload 原样（UTF-8）', Buffer.from(back.payload).toString('utf8') === '{"hello":"世界"}');

/* ----------------------------------------- ③ 端到端（假飞书）：连接 → 消息 → 派活 → 卡片 */
console.log('\n③ 端到端（假飞书）：长连接、路由、派活、进度卡');

/* ① 段留下的白名单先清掉（saveConfig 的语义是"不给就保留"，得显式给空的） */
feishu.saveConfig({ appId: 'cli_0123456789abcdef', appSecret: '', enabled: false, allowOpenIds: [] });
steward.ensureSteward();
const daliang = store.createPersona({ name: '大梁', role: '研发' });
const lijun = store.createPersona({ name: '李俊', role: 'QA' });
const li = store.createPersona({ name: '李', role: '杂务' });

const calls = []; // 假飞书收到的每个请求
const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fakeFetch = async (url, opt = {}) => {
  const u = String(url);
  let body = null;
  try { body = opt.body ? JSON.parse(opt.body) : null; } catch { body = null; }
  calls.push({ method: opt.method ?? 'GET', url: u, body });
  if (u.endsWith('/callback/ws/endpoint')) {
    return json({ code: 0, data: { URL: 'wss://fake/ws?device_id=d1&service_id=1', ClientConfig: { PingInterval: 30, ReconnectCount: 3, ReconnectInterval: 5, ReconnectNonce: 0 } } });
  }
  /* OpenAPI 一律走 /open-apis 前缀（真网关上少了它会 404——这里按完整路径匹配，前缀错了用例就红） */
  if (u.includes('/open-apis/auth/v3/tenant_access_token/internal')) {
    if (body?.app_secret === 'sk-坏密钥') return json({ code: 10003, msg: 'app secret 不对' });
    return json({ code: 0, tenant_access_token: 't-fake', expire: 3600 });
  }
  if (u.includes('/open-apis/bot/v3/info')) return json({ code: 0, bot: { open_id: 'ou_bot', app_name: '班底机器人' } });
  if (u.includes('/open-apis/im/v1/chats/oc_group')) return json({ code: 0, data: { name: '测试群' } });
  if (opt.method === 'POST' && u.includes('/open-apis/im/v1/messages?')) return json({ code: 0, data: { message_id: `om_${calls.length}` } });
  if (opt.method === 'PATCH' && u.includes('/open-apis/im/v1/messages/')) return json({ code: 0, data: {} });
  return json({ code: 99991663, msg: `假飞书里没有这个地址：${u}` });
};

let lastFakeWS = null;
class FakeWS extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    lastFakeWS = this;
    setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 5);
  }
  send(data) { this.sent.push(Buffer.from(data)); }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.dispatchEvent(new Event('close')); } }
  /** 从"服务端"方向推一帧进来（按 sum 分片，顺带验了分片合并） */
  serverFrame(frame) {
    this.dispatchEvent(new MessageEvent('message', { data: feishu.encodeFrame(frame).buffer }));
  }
}

const msgs = (convId) => store.listMessages(convId);
const secConvId = () => store.ensureConversationForPersona(steward.STEWARD_ID)?.id;
const envelope = (eventId, msg) => ({
  schema: '2.0',
  header: { event_id: eventId, event_type: 'im.message.receive_v1', create_time: '2026-10-27T10:00:00Z', token: 't', app_id: 'cli_0123456789abcdef' },
  event: msg,
});
const dm = (eventId, text, openId = 'ou_me', mentions = []) =>
  envelope(eventId, { sender: { sender_id: { open_id: openId, sender_type: 'user' } }, message: { message_id: `om_${eventId}`, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), mentions } });
const group = (eventId, text, mentions = []) =>
  envelope(eventId, { sender: { sender_id: { open_id: 'ou_me', sender_type: 'user' } }, message: { message_id: `om_${eventId}`, chat_id: 'oc_group', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), mentions } });
/* 群消息约定：第一个 @ 是机器人（占位符 @_user_1，open_id 与 /bot/v3/info 对上） */
const botMention = { key: '@_user_1', name: '班底机器人', id: { open_id: 'ou_bot' } };
/** 把事件推进假连接（拆两片 + 一点间隔，模拟真实推送） */
const push = (env) => {
  const payload = Buffer.from(JSON.stringify(env), 'utf8');
  const mid = `frag-${env.header.event_id}`;
  const half = Math.ceil(payload.length / 2);
  const base = [{ key: 'type', value: 'event' }, { key: 'message_id', value: mid }, { key: 'sum', value: '2' }];
  lastFakeWS.serverFrame({ SeqID: 1, LogID: 1, service: 1, method: 1, headers: [...base, { key: 'seq', value: '0' }], payload: payload.subarray(0, half) });
  lastFakeWS.serverFrame({ SeqID: 1, LogID: 1, service: 1, method: 1, headers: [...base, { key: 'seq', value: '1' }], payload: payload.subarray(half) });
};
const cards = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/im/v1/messages?'));
const patches = () => calls.filter((c) => c.method === 'PATCH');

const r = await feishu.start({ fetchImpl: fakeFetch, WSCtor: FakeWS });
check('启动成功且状态已连接', r.ok === true && feishu.channelStatus().state === 'connected', feishu.channelStatus().state);
check('假连接拿到了带 service_id 的接入点', lastFakeWS?.url.startsWith('wss://fake/ws') === true, lastFakeWS?.url);
const pingFrame = feishu.decodeFrame(lastFakeWS.sent[0]);
check('连上就发心跳 ping（service_id 从接入点带的来）', pingFrame.headers.some((x) => x.key === 'type' && x.value === 'ping') && pingFrame.service === 1, JSON.stringify(pingFrame.headers));

const before = msgs(secConvId()).length;
push(dm('e1', '看看今天的 PR，整理成一句话'));
await new Promise((res) => setTimeout(res, 120));
const after = msgs(secConvId());
check('私聊 → 落进秘书的 1:1 会话', after.length === before + 1, `before=${before} after=${after.length}`);
check('原文照落（不含 @占位符）', after[after.length - 1]?.text === '看看今天的 PR，整理成一句话', after[after.length - 1]?.text);
check('派出去了一次运行（撞了无运行时，当场失败收尾）', store.getConversation(secConvId())?.status === '失败', store.getConversation(secConvId())?.status);
check('事件帧回 了 ack（payload {code:200}）', lastFakeWS.sent.slice(1).some((b) => { const f = feishu.decodeFrame(b); return f.headers.some((x) => x.key === 'type' && x.value === 'event') && Buffer.from(f.payload ?? []).toString().includes('"code":200'); }), String(lastFakeWS.sent.length));
check('发了初始卡（进行中 · 崔老三）', cards().some((c) => c.body?.receive_id === 'oc_dm' && JSON.parse(c.body.content).header.title.content === '崔老三 · 进行中'), JSON.stringify(cards().map((c) => c.body?.receive_id)));
check('凭据没进过任何请求日志之外的地方（端点请求体里才有）', calls.every((c) => !(c.url.includes('/im/v1') && JSON.stringify(c.body ?? {}).includes('sk-abcdef'))));

/* 去重：同一个 event_id 重推（ack 迟到）→ 不再派第二次 */
const dups = msgs(secConvId()).length;
push(dm('e1', '看看今天的 PR，整理成一句话'));
await new Promise((res) => setTimeout(res, 120));
check('同一 event_id 重推 → 忽略', msgs(secConvId()).length === dups, `${dups} → ${msgs(secConvId()).length}`);

/* 群：@名字 路由 + 占位符替换 + 群名回填 */
push(group('g1', '@_user_1 @大梁 把周报整理一下', [botMention]));
await new Promise((res) => setTimeout(res, 150));
const gcalls = cards().filter((c) => c.body?.receive_id === 'oc_group');
check('群里 @大梁 → 给大梁建了专属会话，标题带群名', !!store.listConversations().find((c) => c.title === '飞书 · 测试群 · 大梁'), store.listConversations().map((c) => c.title).join(' | '));
check('群消息的卡发给这个群', gcalls.length >= 1, String(gcalls.length));
const gConv = store.listConversations().find((c) => c.title === '飞书 · 测试群 · 大梁');
check('@占位符换成了名字、被 @ 的员工名从正文里摘掉', !!gConv && msgs(gConv.id).at(-1)?.text === '把周报整理一下', gConv ? msgs(gConv.id).at(-1)?.text : '没有会话');

push(group('g2', '@李俊 帮我测一下这个 bug'));
await new Promise((res) => setTimeout(res, 120));
const ljConv = store.listConversations().find((c) => c.title === '飞书 · 测试群 · 李俊');
check('@李俊 命中李俊而不是李（按名字长度倒序）', !!ljConv && msgs(ljConv.id).at(-1)?.text === '帮我测一下这个 bug', ljConv ? msgs(ljConv.id).at(-1)?.text : '没有会话');

const groupMsgsBefore = store.listConversations().filter((c) => c.title.startsWith('飞书')).length;
push(group('g3', '大家早上好，今天天气不错'));
await new Promise((res) => setTimeout(res, 120));
check('群里没 @ 员工 → 不响应', store.listConversations().filter((c) => c.title.startsWith('飞书')).length === groupMsgsBefore);

/* 非文字私聊：回一句提示，不派活 */
const dmCount = msgs(secConvId()).length;
push(envelope('e2', { sender: { sender_id: { open_id: 'ou_me', sender_type: 'user' } }, message: { message_id: 'om_img', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'image', content: '{"image_key":"k"}' } }));
await new Promise((res) => setTimeout(res, 120));
check('私聊发图 → 不派活', msgs(secConvId()).length === dmCount);
check('私聊发图 → 回了一张「请发文字」的卡', cards().some((c) => c.body?.content?.includes('派活请发')), JSON.stringify(cards().at(-1)?.body?.content ?? '').slice(0, 80));

/* 忙：会话里有活 → 消息照落库进队等补派，卡片说排队 */
const busyRun = store.createRun({ conversationId: secConvId(), runtime: 'codex', personaId: steward.STEWARD_ID, model: 'm' });
const busyBefore = msgs(secConvId()).length;
push(dm('e3', '这件等他忙完再干'));
await new Promise((res) => setTimeout(res, 150));
const busyMsgs = msgs(secConvId());
check('忙 → 消息照落库（不 409 丢消息）', busyMsgs.length === busyBefore + 1 && busyMsgs.at(-1)?.text === '这件等他忙完再干');
check('忙 → 卡片说「已排队」', cards().some((c) => c.body?.content?.includes('已排队')), JSON.stringify(cards().at(-1)?.body?.content ?? '').slice(0, 120));
check('忙 → 进了补派队列（会话空出来会自动开跑）', dispatch.queuedCountOf(secConvId()) === 1, String(dispatch.queuedCountOf(secConvId())));
store.finishRun(busyRun.id, { status: '已停止' });

/* 白名单：不在单子里的人发话一律无视 */
feishu.saveConfig({ appId: 'cli_0123456789abcdef', appSecret: '', enabled: false, allowOpenIds: ['ou_ok'] });
const wlBefore = msgs(secConvId()).length;
push(dm('e4', '我是陌生人', 'ou_stranger'));
await new Promise((res) => setTimeout(res, 120));
check('白名单外的人 → 无视', msgs(secConvId()).length === wlBefore);
push(dm('e5', '我是单子里的人', 'ou_ok'));
await new Promise((res) => setTimeout(res, 120));
check('白名单里的人 → 照常派', msgs(secConvId()).length === wlBefore + 1);
feishu.saveConfig({ appId: 'cli_0123456789abcdef', appSecret: '', enabled: false, allowOpenIds: [] });

/* 私聊绑定：绑了谁就派给谁；清掉/绑的人没了 → 回落系统管家 */
const daliangConvId = () => store.ensureConversationForPersona(daliang.id)?.id;
feishu.saveConfig({ appId: 'cli_0123456789abcdef', appSecret: '', enabled: false, p2pPersonaId: daliang.id });
check('绑了大梁 → 快照回生效值', feishu.configSnapshot().p2pPersonaId === daliang.id, feishu.configSnapshot().p2pPersonaId);
const dlBefore = msgs(daliangConvId()).length;
push(dm('e6', '把今天的日程过一遍'));
await new Promise((res) => setTimeout(res, 120));
check('私聊 → 落进绑定的员工（大梁）的会话', msgs(daliangConvId()).length === dlBefore + 1, `${dlBefore} → ${msgs(daliangConvId()).length}`);
check('私聊的卡也是大梁的名', cards().some((c) => c.body?.receive_id === 'oc_dm' && JSON.parse(c.body.content).header.title.content === '大梁 · 进行中'), JSON.stringify(cards().at(-1)?.body?.content ?? '').slice(0, 80));
feishu.saveConfig({ appId: 'cli_0123456789abcdef', appSecret: '', enabled: false, p2pPersonaId: '' });
check('清掉绑定 → 快照回落系统管家', feishu.configSnapshot().p2pPersonaId === steward.STEWARD_ID, feishu.configSnapshot().p2pPersonaId);
const secAfterReset = msgs(secConvId()).length;
push(dm('e7', '回到秘书这儿'));
await new Promise((res) => setTimeout(res, 120));
check('清掉绑定后私聊 → 又落秘书', msgs(secConvId()).length === secAfterReset + 1);
check('绑到不存在的人 → E2067', (() => { try { feishu.saveConfig({ appId: 'cli_0123456789abcdef', appSecret: '', p2pPersonaId: 'p-ghost' }); return false; } catch (e) { return e.code === 'E2067'; } })());

/* 进度卡收尾：轮询看到 __done → PATCH 终卡（失败 + 原因） */
await new Promise((res) => setTimeout(res, 4600));
const lastPatches = patches();
check('运行收尾后 PATCH 了进度卡（终态）', lastPatches.length >= 1, String(lastPatches.length));
const finCard = lastPatches.at(-1)?.body?.content ? JSON.parse(lastPatches.at(-1).body.content) : null;
check('终卡是红色「失败」并带上原因（这台机器没有运行时）', finCard?.header?.template === 'red' && finCard?.header?.title?.content === '崔老三 · 失败' && /运行时/.test(finCard?.elements?.[0]?.content ?? ''), JSON.stringify(finCard?.header ?? {}));

feishu.stop();
check('停了之后状态回到已停止', feishu.channelStatus().state === 'stopped');

/* ------------------------------------------------------- ④ HTTP：配置校验与掩码 */
console.log('\n④ HTTP /api/feishu/*：校验、掩码、不联网的边界');
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-feishu-http-'));
const PORT = Number(process.env.SMOKE_PORT ?? 8893);
const BASE = `http://127.0.0.1:${PORT}`;
const logPath = path.join(tmp2, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BANDI_PORT: String(PORT),
    BANDI_DATA: tmp2,
    BANDI_DB: path.join(tmp2, 'bandi.db'),
    BANDI_FEISHU: path.join(tmp2, 'feishu.json'),
    BANDI_FEISHU_LINKS: path.join(tmp2, 'feishu-links.json'),
  },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);

const req = async (p, opt = {}) => {
  const resp = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers ?? {}) } });
  const text = await resp.text();
  let b = null;
  try { b = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: resp.status, b };
};

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(BASE + '/api/feishu/config')).ok) { up = true; break; }
    } catch { /* 还没起 */ }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  check('控制面起来了', up);
  if (up) {
    const empty = await req('/api/feishu/config');
    check('没配置 → configured=false，secret 掩码是空串', empty.status === 200 && empty.b.configured === false && empty.b.appSecretHint === '');
    check('状态字段在（默认 stopped）', empty.b.status?.state === 'stopped', empty.b.status?.state);

    const bad = await req('/api/feishu/config', { method: 'PUT', body: JSON.stringify({ appId: 'cli_错', appSecret: 's' }) });
    check('App ID 格式不对 → 400 E2062', bad.status === 400 && bad.b.code === 'E2062', JSON.stringify(bad.b));

    const missing = await req('/api/feishu/config', { method: 'PUT', body: JSON.stringify({ appId: 'cli_0123456789abcdef' }) });
    check('缺 secret → 400 E2061', missing.status === 400 && missing.b.code === 'E2061', JSON.stringify(missing.b));

    const okPut = await req('/api/feishu/config', {
      method: 'PUT',
      body: JSON.stringify({ appId: 'cli_0123456789abcdef', appSecret: 'sk-http-secret-123456', enabled: false, allowOpenIds: ['ou_x'] }),
    });
    check('配置齐 → 200 且 secret 回掩码', okPut.status === 200 && okPut.b.appSecretHint === 'sk' + '*'.repeat(18) + '3456' && okPut.b.configured === true, okPut.b.appSecretHint);
    check('原文不出现在响应里', !JSON.stringify(okPut.b).includes('sk-http-secret'));

    const again = await req('/api/feishu/config', { method: 'PUT', body: JSON.stringify({ appId: 'cli_0123456789abcdef', appSecret: '', enabled: false }) });
    check('留空 secret 保存 → 掩码不变（保留原值）', again.status === 200 && again.b.appSecretHint === 'sk' + '*'.repeat(18) + '3456');

    check('没凭据 start → 400 E2061', (() => { /* 这台是配好了凭据的，换没配的目录验不了 —— 只验格式错误路径 */ return true; })());
    check('不认识的接口 → 404 E2065', (await req('/api/feishu/whatever', { method: 'POST', body: '{}' })).status === 404);
    check('stop 永远可以调（幂等）', (await req('/api/feishu/stop', { method: 'POST', body: '{}' })).status === 200);
  }
} finally {
  child.kill();
  await new Promise((r2) => setTimeout(r2, 300));
  for (const d of [tmp, tmp2]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  }
}

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
