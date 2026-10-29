/**
 * 飞书通道的离线验收（2026-10-27 建；2026-10-29 随员工级改造重写）。
 *
 * 分五段，都**不联网**：
 *   ① 迁移 —— 旧平台级 `feishu.json` 迁到员工配置 + .bak 留底，幂等；
 *   ② 员工级配置 —— 按员工保存/校验（E2061/E2062/E2067）、掩码、留空保留原值；
 *   ③ 协议 —— pbbp2 帧编码→解码闭环（与官方 node-sdk 的字段号逐字对齐）；
 *   ④ 端到端（假飞书）—— 两条员工通道并跑、私聊/群聊新路由语义、白名单、去重、
 *      忙排队、进度卡收尾、removePersona 清理、bootSync；
 *   ⑤ HTTP —— /api/personas/:id/feishu 的校验与掩码；旧的 /api/feishu/* 已删（404）。
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

/* ⚠️ 环境变量必须在 import 之前设好（store 一加载就开库；feishu 的配置路径虽然惰性求值，一起设了省心） */
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');
process.env.BANDI_FEISHU = path.join(tmp, 'feishu.json');          // 旧平台级（迁移源）
process.env.BANDI_FEISHU_APPS = path.join(tmp, 'feishu-apps.json'); // 新员工级
process.env.BANDI_FEISHU_LINKS = path.join(tmp, 'feishu-links.json');

const store = await import('./store.mjs');
const steward = await import('./steward.mjs');
const dispatch = await import('./dispatch.mjs');
const feishu = await import('./feishu.mjs');

const readAppsFile = () => JSON.parse(fs.readFileSync(process.env.BANDI_FEISHU_APPS, 'utf8'));

steward.ensureSteward();
const daliang = store.createPersona({ name: '大梁', role: '研发' });
const lijun = store.createPersona({ name: '李俊', role: 'QA' });

/* ------------------------------------------------------- ① 迁移：旧配置 → 员工级 */
console.log('① 迁移：旧 feishu.json → 员工配置 + .bak 留底，幂等');

/* 1a. 绑的人不在（p-ghost）→ 落系统管家。enabled 必须 false —— bootSync 会把 enabled 的
 *     通道真拉起来，此时假件还没注入，会拿真凭据去打真飞书（假凭据被打回，还出外网） */
fs.writeFileSync(
  process.env.BANDI_FEISHU,
  JSON.stringify({ appId: 'cli_0123456789abcdef', appSecret: 'sk-steward-secret-999', enabled: false, allowOpenIds: ['ou_a'], p2pPersonaId: 'p-ghost' }),
);
feishu.bootSync();
const bak1 = process.env.BANDI_FEISHU + '.migrated.bak';
check('绑的人不在 → 迁给了系统管家', readAppsFile()[steward.STEWARD_ID]?.appId === 'cli_0123456789abcdef', JSON.stringify(Object.keys(readAppsFile())));
check('旧文件改名 .migrated.bak 留底（不删）', fs.existsSync(bak1) && !fs.existsSync(process.env.BANDI_FEISHU));

/* 1b. 清掉 .bak 再来一次：绑了大梁 → 迁给大梁（正常路径） */
fs.rmSync(bak1);
fs.writeFileSync(
  process.env.BANDI_FEISHU,
  JSON.stringify({ appId: 'cli_9abcdef012345678', appSecret: 'sk-daliang-legacy-secret', enabled: false, allowOpenIds: ['ou_d'], p2pPersonaId: daliang.id }),
);
feishu.bootSync();
const migrated = readAppsFile()[daliang.id];
check('绑了大梁 → 迁给大梁（appId / secret / 白名单 / enabled 全带上）',
  migrated?.appId === 'cli_9abcdef012345678' && migrated?.appSecret === 'sk-daliang-legacy-secret' && migrated?.enabled === false && JSON.stringify(migrated.allowOpenIds) === JSON.stringify(['ou_d']),
  JSON.stringify(migrated ?? {}));
check('系统管家那份没被第二次迁移覆盖', readAppsFile()[steward.STEWARD_ID]?.appId === 'cli_0123456789abcdef');
check('.bak 再次生成', fs.existsSync(bak1));

/* 1c. 幂等：.bak 在，就算旧文件又冒出来也不迁 */
fs.writeFileSync(process.env.BANDI_FEISHU, JSON.stringify({ appId: 'cli_ffffffffffffffff', appSecret: 'x' }));
feishu.bootSync();
check('.bak 已存在 → 不再迁（幂等）', readAppsFile()[daliang.id]?.appId === 'cli_9abcdef012345678', readAppsFile()[daliang.id]?.appId);

/* --------------------------------- ② 员工级配置：校验、掩码、留空保留 */
console.log('\n② 员工级配置：按员工保存、E2061/E2062/E2067、掩码、留空保留');
/* 校验用例都打在李俊身上 —— 他没配过（大梁 ① 里被迁了一份，prev 有值，"没填齐"测不出来） */
check('员工不存在 → E2067', (() => { try { feishu.savePersonaConfig('p-ghost', { appId: 'cli_0123456789abcdef', appSecret: 's' }); return false; } catch (e) { return e.code === 'E2067'; } })());
check('App ID / Secret 没填齐 → E2061', (() => { try { feishu.savePersonaConfig(lijun.id, { appId: 'cli_0123456789abcdef' }); return false; } catch (e) { return e.code === 'E2061'; } })());
check('App ID 格式不对 → E2062', (() => { try { feishu.savePersonaConfig(lijun.id, { appId: '不是飞书的id', appSecret: 's1' }); return false; } catch (e) { return e.code === 'E2062'; } })());
feishu.savePersonaConfig(daliang.id, { appId: 'cli_0123456789abcdef', appSecret: 'sk-abcdef1234567890', enabled: false, allowOpenIds: ['ou_a', '', 'ou_b'] });
let snap = feishu.personaConfigSnapshot(daliang.id);
check('配置齐了 → configured', snap.configured === true);
check('secret 只回掩码（前2后4），原文不出现在快照里', snap.appSecretHint === 'sk' + '*'.repeat(18) + '7890' && !JSON.stringify(snap).includes('sk-abcdef'), snap.appSecretHint);
check('白名单存成了数组，空串被滤掉', JSON.stringify(snap.allowOpenIds) === JSON.stringify(['ou_a', 'ou_b']), JSON.stringify(snap.allowOpenIds));
check('别的员工互不串台（李俊还是没配）', feishu.personaConfigSnapshot(lijun.id).configured === false);
feishu.savePersonaConfig(daliang.id, { appId: 'cli_0123456789abcdef', appSecret: '', enabled: false });
check('secret 留空 = 保留原值（改白名单不用重贴）', readAppsFile()[daliang.id].appSecret === 'sk-abcdef1234567890');
/* ① 迁进来时带了一份白名单（['ou_d']），② 又存了 ['ou_a','ou_b'] —— 先清空，④ 的私聊/群聊才不会被拦 */
feishu.savePersonaConfig(daliang.id, { appId: 'cli_0123456789abcdef', appSecret: '', enabled: false, allowOpenIds: [] });
check('凭据文件权限尽力 0600（Windows 上可能没这个概念，unix 才验）', (() => {
  if (process.platform === 'win32') return true;
  return (fs.statSync(process.env.BANDI_FEISHU_APPS).mode & 0o777) === 0o600;
})());

/* --------------------------------- ③ protobuf 帧：字段号与线格式 */
console.log('\n③ pbbp2 帧：编码字节与官方生成代码一致、编解码闭环');
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

/* ------------------------- ④ 端到端（假飞书）：员工通道并跑、路由、派活、卡片 */
console.log('\n④ 端到端（假飞书）：员工通道、私聊直派、群聊只认 @自己、白名单、卡片');

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
  if (u.includes('/open-apis/bot/v3/info')) return json({ code: 0, bot: { open_id: 'ou_bot', app_name: '大梁的机器人' } });
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
const daliangConvId = () => store.ensureConversationForPersona(daliang.id)?.id;
const stewardConvId = () => store.ensureConversationForPersona(steward.STEWARD_ID)?.id;
const envelope = (eventId, msg) => ({
  schema: '2.0',
  header: { event_id: eventId, event_type: 'im.message.receive_v1', create_time: '2026-10-29T10:00:00Z', token: 't', app_id: 'cli_0123456789abcdef' },
  event: msg,
});
const dm = (eventId, text, openId = 'ou_me', mentions = []) =>
  envelope(eventId, { sender: { sender_id: { open_id: openId, sender_type: 'user' } }, message: { message_id: `om_${eventId}`, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), mentions } });
const group = (eventId, text, mentions = []) =>
  envelope(eventId, { sender: { sender_id: { open_id: 'ou_me', sender_type: 'user' } }, message: { message_id: `om_${eventId}`, chat_id: 'oc_group', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), mentions } });
/* 群消息约定：@机器人自己 的 mention，open_id 与 /bot/v3/info 对上 */
const botMention = { key: '@_user_1', name: '大梁的机器人', id: { open_id: 'ou_bot' } };
const otherBotMention = { key: '@_user_2', name: '李俊的机器人', id: { open_id: 'ou_other_bot' } };
/** 把事件推进"当前那条"假连接（拆两片 + 一点间隔，模拟真实推送） */
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
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const r = await feishu.startPersona(daliang.id, { fetchImpl: fakeFetch, WSCtor: FakeWS });
check('大梁的通道启动成功且状态已连接', r.ok === true && feishu.personaChannelStatus(daliang.id).state === 'connected', feishu.personaChannelStatus(daliang.id).state);
check('假连接拿到了带 service_id 的接入点', lastFakeWS?.url.startsWith('wss://fake/ws') === true, lastFakeWS?.url);
const pingFrame = feishu.decodeFrame(lastFakeWS.sent[0]);
check('连上就发心跳 ping（service_id 从接入点带的来）', pingFrame.headers.some((x) => x.key === 'type' && x.value === 'ping') && pingFrame.service === 1, JSON.stringify(pingFrame.headers));

/* 私聊：直接派给这条通道自己的员工（大梁），不再有"绑定"概念 */
const before = msgs(daliangConvId()).length;
push(dm('e1', '看看今天的 PR，整理成一句话'));
await wait(120);
const after = msgs(daliangConvId());
check('私聊 → 直接落进大梁的 1:1 会话', after.length === before + 1, `before=${before} after=${after.length}`);
check('原文照落（不含 @占位符）', after[after.length - 1]?.text === '看看今天的 PR，整理成一句话', after[after.length - 1]?.text);
check('派出去了一次运行（撞了无运行时，当场失败收尾）', store.getConversation(daliangConvId())?.status === '失败', store.getConversation(daliangConvId())?.status);
check('事件帧回了 ack（payload {code:200}）', lastFakeWS.sent.slice(1).some((b) => { const f = feishu.decodeFrame(b); return f.headers.some((x) => x.key === 'type' && x.value === 'event') && Buffer.from(f.payload ?? []).toString().includes('"code":200'); }), String(lastFakeWS.sent.length));
check('发了初始卡（进行中 · 大梁）', cards().some((c) => c.body?.receive_id === 'oc_dm' && JSON.parse(c.body.content).header.title.content === '大梁 · 进行中'), JSON.stringify(cards().map((c) => c.body?.receive_id)));
check('凭据没进过 OpenAPI 请求（端点请求体里才有）', calls.every((c) => !(c.url.includes('/im/v1') && JSON.stringify(c.body ?? {}).includes('sk-abcdef'))));

/* 去重：同一个 event_id 重推（ack 迟到）→ 不再派第二次 */
const dups = msgs(daliangConvId()).length;
push(dm('e1', '看看今天的 PR，整理成一句话'));
await wait(120);
check('同一 event_id 重推 → 忽略', msgs(daliangConvId()).length === dups, `${dups} → ${msgs(daliangConvId()).length}`);

/* 群：只在 @机器人自己 时响应，正文剔掉 @自己 后派给自己的员工 */
const groupConvs = () => store.listConversations().filter((c) => c.title.startsWith('飞书'));
push(group('g1', '@_user_1 把周报整理一下', [botMention]));
await wait(150);
const gConv = groupConvs().find((c) => c.title === '飞书 · 测试群 · 大梁');
check('群里 @自己 → 给大梁建了专属会话，标题带群名', !!gConv, groupConvs().map((c) => c.title).join(' | '));
check('群消息的卡发给这个群', !!gConv && cards().some((c) => c.body?.receive_id === 'oc_group'), String(cards().filter((c) => c.body?.receive_id === 'oc_group').length));
check('@自己的占位符从正文里剔掉', !!gConv && msgs(gConv.id).at(-1)?.text === '把周报整理一下', gConv ? msgs(gConv.id).at(-1)?.text : '没有会话');

/* 群：@别的员工的 bot → 不归这个 bot 管（那个员工有自己的 bot） */
const gCountAfterG1 = groupConvs().length;
push(group('g2', '@_user_2 帮我测一下这个 bug', [otherBotMention]));
await wait(120);
check('群里 @别的员工的 bot → 不响应', groupConvs().length === gCountAfterG1, String(groupConvs().length));

/* 群：没 @ 机器人 → 不响应 */
push(group('g3', '大家早上好，今天天气不错'));
await wait(120);
check('群里没 @ 机器人 → 不响应', groupConvs().length === gCountAfterG1);

/* 非文字私聊：回一句提示，不派活 */
const dmCount = msgs(daliangConvId()).length;
push(envelope('e2', { sender: { sender_id: { open_id: 'ou_me', sender_type: 'user' } }, message: { message_id: 'om_img', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'image', content: '{"image_key":"k"}' } }));
await wait(120);
check('私聊发图 → 不派活', msgs(daliangConvId()).length === dmCount);
check('私聊发图 → 回了一张「请发文字」的卡', cards().some((c) => c.body?.content?.includes('派活请发')), JSON.stringify(cards().at(-1)?.body?.content ?? '').slice(0, 80));

/* 忙：会话里有活 → 消息照落库进队等补派，卡片说排队 */
const busyRun = store.createRun({ conversationId: daliangConvId(), runtime: 'codex', personaId: daliang.id, model: 'm' });
const busyBefore = msgs(daliangConvId()).length;
push(dm('e3', '这件等他忙完再干'));
await wait(150);
const busyMsgs = msgs(daliangConvId());
check('忙 → 消息照落库（不 409 丢消息）', busyMsgs.length === busyBefore + 1 && busyMsgs.at(-1)?.text === '这件等他忙完再干');
check('忙 → 卡片说「已排队」', cards().some((c) => c.body?.content?.includes('已排队')), JSON.stringify(cards().at(-1)?.body?.content ?? '').slice(0, 120));
check('忙 → 进了补派队列（会话空出来会自动开跑）', dispatch.queuedCountOf(daliangConvId()) === 1, String(dispatch.queuedCountOf(daliangConvId())));
store.finishRun(busyRun.id, { status: '已停止' });

/* 白名单：每个 bot 用**自己的** allowOpenIds 过滤 */
feishu.savePersonaConfig(daliang.id, { appId: 'cli_0123456789abcdef', appSecret: '', enabled: false, allowOpenIds: ['ou_ok'] });
const wlBefore = msgs(daliangConvId()).length;
push(dm('e4', '我是陌生人', 'ou_stranger'));
await wait(120);
check('白名单外的人 → 无视', msgs(daliangConvId()).length === wlBefore);
push(dm('e5', '我是单子里的人', 'ou_ok'));
await wait(120);
check('白名单里的人 → 照常派', msgs(daliangConvId()).length === wlBefore + 1);
feishu.savePersonaConfig(daliang.id, { appId: 'cli_0123456789abcdef', appSecret: '', enabled: false, allowOpenIds: [] });

/* 第二条员工通道：Map 里一人一份，互不串台 */
feishu.savePersonaConfig(steward.STEWARD_ID, { appId: 'cli_0123456789abcdef', appSecret: 'sk-steward-secret-999', enabled: false, allowOpenIds: [] });
const r2 = await feishu.startPersona(steward.STEWARD_ID);
check('系统管家的通道也起来了（两条并跑）', r2.ok === true && feishu.personaChannelStatus(steward.STEWARD_ID).state === 'connected');
check('两条通道状态各自独立', feishu.personaChannelStatus(daliang.id).state === 'connected' && feishu.personaChannelStatus(steward.STEWARD_ID).state === 'connected', `${feishu.personaChannelStatus(daliang.id).state}/${feishu.personaChannelStatus(steward.STEWARD_ID).state}`);
const secBefore = msgs(stewardConvId()).length;
const dlBefore2 = msgs(daliangConvId()).length;
push(dm('e6', '这条是发给管家的')); // lastFakeWS 现在是管家那条连接
await wait(120);
check('私聊派给通道对应的员工（管家），不串到大梁', msgs(stewardConvId()).length === secBefore + 1 && msgs(daliangConvId()).length === dlBefore2, `steward ${msgs(stewardConvId()).length}/${secBefore} daliang ${msgs(daliangConvId()).length}/${dlBefore2}`);

/* 进度卡收尾：轮询看到 __done → PATCH 终卡（失败 + 原因） */
await wait(4600);
const lastPatches = patches();
check('运行收尾后 PATCH 了进度卡（终态）', lastPatches.length >= 1, String(lastPatches.length));
/* e6 把管家也拉进来派了一单 —— 终卡里找大梁那张（steward 那张是「崔老三 · 失败」，不算错） */
const daliangFin = lastPatches.map((p) => (p.body?.content ? JSON.parse(p.body.content) : null)).find((c) => c?.header?.title?.content === '大梁 · 失败');
check('终卡是红色「失败」并带上原因（这台机器没有运行时）', daliangFin?.header?.template === 'red' && /运行时/.test(daliangFin?.elements?.[0]?.content ?? ''), JSON.stringify(daliangFin?.header ?? {}));

/* removePersona：停通道 + 删配置（删员工/解聘时路由层调的就是它） */
feishu.removePersona(daliang.id);
check('removePersona → 通道停了', feishu.personaChannelStatus(daliang.id).state === 'stopped');
check('removePersona → 配置没了（快照回到未配置）', feishu.personaConfigSnapshot(daliang.id).configured === false && feishu.personaConfigSnapshot(daliang.id).appId === '');
check('removePersona 幂等（再删一次不炸）', (() => { feishu.removePersona(daliang.id); return true; })());
check('另一条通道不受牵连', feishu.personaChannelStatus(steward.STEWARD_ID).state === 'connected');

/* bootSync：enabled 的逐个拉起（stopAll 后再验，防止复用已连接的通道） */
feishu.savePersonaConfig(steward.STEWARD_ID, { appId: 'cli_0123456789abcdef', appSecret: '', enabled: true });
feishu.stopAll();
check('stopAll → 全部回到已停止', feishu.personaChannelStatus(steward.STEWARD_ID).state === 'stopped' && feishu.personaChannelStatus(daliang.id).state === 'stopped');
feishu.bootSync(); // 管家 enabled=true → 应自启；大梁配置已删 → 无事发生
await wait(120);
check('bootSync → enabled 的员工通道被拉起', feishu.personaChannelStatus(steward.STEWARD_ID).state === 'connected', feishu.personaChannelStatus(steward.STEWARD_ID).state);
feishu.stopAll();

/* ------------------------------------------------------- ⑤ HTTP：员工级路由的校验与掩码 */
console.log('\n⑤ HTTP /api/personas/:id/feishu：校验、掩码；旧 /api/feishu/* 已删');
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
    BANDI_FEISHU_APPS: path.join(tmp2, 'feishu-apps.json'),
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
  const sid = steward.STEWARD_ID;
  const feishuUrl = `/api/personas/${encodeURIComponent(sid)}/feishu`;
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await req('/api/hello')).status === 200) { up = true; break; }
    } catch { /* 还没起 */ }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  if (!up) {
    // 起不来就别让人干瞪眼：把子进程日志倒出来（首启要装 CLI/种子员工，偶尔超过 10 秒）
    try { console.log('---- server.log ----\n' + fs.readFileSync(logPath, 'utf8')); } catch { /* 没有就算了 */ }
  }
  check('控制面起来了', up);
  if (up) {
    const empty = await req(feishuUrl);
    check('没配置 → configured=false，secret 掩码是空串', empty.status === 200 && empty.b.configured === false && empty.b.appSecretHint === '');
    check('状态字段在（默认 stopped）', empty.b.status?.state === 'stopped', empty.b.status?.state);

    check('员工不存在 → 404 E2008', (await req('/api/personas/p-ghost/feishu')).status === 404);

    const bad = await req(feishuUrl, { method: 'PUT', body: JSON.stringify({ appId: 'cli_错', appSecret: 's' }) });
    check('App ID 格式不对 → 400 E2062', bad.status === 400 && bad.b.code === 'E2062', JSON.stringify(bad.b));

    const missing = await req(feishuUrl, { method: 'PUT', body: JSON.stringify({ appId: 'cli_0123456789abcdef' }) });
    check('缺 secret → 400 E2061', missing.status === 400 && missing.b.code === 'E2061', JSON.stringify(missing.b));

    const okPut = await req(feishuUrl, {
      method: 'PUT',
      body: JSON.stringify({ appId: 'cli_0123456789abcdef', appSecret: 'sk-http-secret-123456', enabled: false, allowOpenIds: ['ou_x'] }),
    });
    check('配置齐 → 200 且 secret 回掩码', okPut.status === 200 && okPut.b.appSecretHint === 'sk' + '*'.repeat(18) + '3456' && okPut.b.configured === true, okPut.b.appSecretHint);
    check('原文不出现在响应里', !JSON.stringify(okPut.b).includes('sk-http-secret'));

    const again = await req(feishuUrl, { method: 'PUT', body: JSON.stringify({ appId: 'cli_0123456789abcdef', appSecret: '', enabled: false }) });
    check('留空 secret 保存 → 掩码不变（保留原值）', again.status === 200 && again.b.appSecretHint === 'sk' + '*'.repeat(18) + '3456');

    check('不认识的接口 → 404 E2065', (await req(feishuUrl + '/whatever', { method: 'POST', body: '{}' })).status === 404);
    check('stop 永远可以调（幂等）', (await req(feishuUrl + '/stop', { method: 'POST', body: '{}' })).status === 200);

    /* 旧平台级路由已删：落到通用 404（E2036），不再是 E2065 */
    const oldGone = await req('/api/feishu/config');
    check('旧 /api/feishu/config → 404（接口已删）', oldGone.status === 404, JSON.stringify(oldGone.b));
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
