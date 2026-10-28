/*
 * feishu.mjs —— 飞书通道（2026-10-27）。
 *
 * 干什么：在飞书里给数字员工派活 —— 私聊机器人 = 找**绑定的员工**（设置页可挑，
 * 没挑或挑的人没了就落到系统管家）；群里发 `@员工名 做某事` = 派给那个员工。每条指令回一张**可更新的互动卡片**，
 * 随 run 推进（思考中 / 调工具 / 收尾）刷新，跑完落最终结果。
 *
 * 为什么是**出站 WebSocket 客户端**：飞书事件订阅有长连接模式 —— 我们主动连它，
 * 不需要公网回调地址。班底只听 127.0.0.1、自托管无 HTTPS，webhook 根本没法收，
 * 长连接是唯一贴合的形态。（docs/形态决策.md §十二"不引 WebSocket"说的是
 * **入站**架构 —— 控制面/节点之间用长轮询；这里是对第三方 SaaS 的出站客户端，不冲突。）
 *
 * 零依赖纪律怎么守：不用官方 SDK（要 npm install），自己手写协议 ——
 * 帧格式照抄 larksuite/node-sdk 的 `ws-client/`（源码可读）：
 *   · 先 POST {域名}/callback/ws/endpoint（body {AppID, AppSecret}）拿临时 wss 地址
 *     和 ClientConfig{PingInterval, ReconnectCount, ReconnectInterval, ReconnectNonce}（秒）；
 *   · 帧是 protobuf（pbbp2.Frame，字段号见 encodeFrame/decodeFrame 的注释），
 *     headers 是 [{key,value}] 数组，payload 按 message_id/sum/seq 分片合并；
 *   · 收到事件帧要回 ack（原帧 + payload {code:200}），不回会被重推；
 *   · 心跳 ping 帧（headers type=ping, method=control），pong 带回新配置；
 *   · 断线重连带随机抖动、按服务端下发的次数上限。
 * WebSocket 客户端用 Node 22 自带的全局 WebSocket。
 *
 * 凭据口径（对齐 imagegen / git-token）：存数据目录 `feishu.json`（0600 尽力），
 * **不进库、不进日志、不回显**，接口只回掩码；保存时 secret 留空 = 保留原值。
 *
 * 派活链路完全复用现成的：`persona-task.mjs` 的形状 —— 建/复用会话 →
 * `dispatchToThread`；撞 busy 换 `dispatchEventToThread` 落库排队等补派。
 * 进度归约直接 import 前端的纯逻辑模块 `web/js/run-progress.mjs`（无 DOM），
 * 不另写一份"事件 → 阶段"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';
import * as store from './store.mjs';
import { dispatchToThread, dispatchEventToThread, parseMentions } from './dispatch.mjs';
import { STEWARD_ID } from './steward.mjs';
import { applyRunEvent, createRunProgress, progressView } from '../../web/js/run-progress.mjs';

/* --------------------------------------------------------------- 常量与配置 */

/** 只接中国大陆版飞书（v1）；国际版 Lark 域名不同，要支持时把它变成配置项 */
const DOMAIN = 'https://open.feishu.cn';
/** 官方 SDK 对 appId 的校验式（ws-client/index.ts start()） */
const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/;

const fail = (message, code) => Object.assign(new Error(message), { code });

const cfgFile = () => process.env.BANDI_FEISHU ?? path.join(dataDir, 'feishu.json');
const linksFile = () => process.env.BANDI_FEISHU_LINKS ?? path.join(dataDir, 'feishu-links.json');

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeJson(file, obj, secret = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), secret ? { mode: 0o600 } : undefined);
  } catch {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  }
}

export function readRawConfig() {
  const raw = readJson(cfgFile());
  const ids = Array.isArray(raw.allowOpenIds) ? raw.allowOpenIds.map(String).filter(Boolean) : [];
  return {
    appId: String(raw.appId ?? '').trim(),
    appSecret: String(raw.appSecret ?? ''),
    enabled: raw.enabled === true,
    allowOpenIds: ids,
    p2pPersonaId: String(raw.p2pPersonaId ?? '').trim(),
  };
}

/** secret 掩码：前 2 位 + 18 星 + 后 4 位；太短只给 6 星（与 git 令牌同一套） */
function secretHint(t) {
  const s = String(t ?? '');
  if (!s) return '';
  if (s.length < 10) return '*'.repeat(6);
  return `${s.slice(0, 2)}${'*'.repeat(18)}${s.slice(-4)}`;
}

/** 给界面/路由看的快照：**永不回显原文**。p2pPersonaId 回的是**生效值**（没绑/绑的没了 → 系统管家） */
export function configSnapshot() {
  const cfg = readRawConfig();
  return {
    configured: !!(cfg.appId && cfg.appSecret),
    appId: cfg.appId,
    appSecretHint: secretHint(cfg.appSecret),
    enabled: cfg.enabled,
    allowOpenIds: cfg.allowOpenIds,
    p2pPersonaId: p2pPersona(cfg)?.id ?? '',
  };
}

/** 私聊绑到谁：配置里挑的人还在就用他，否则落到系统管家 */
function p2pPersona(cfg) {
  return (cfg.p2pPersonaId && store.getPersona(cfg.p2pPersonaId)) || store.getPersona(STEWARD_ID) || null;
}

/**
 * 保存。appSecret 语义与 imagegen 一致：**键存在且非空才覆盖**（留空 = 保留原值），
 * 改白名单不用重贴 secret。allowOpenIds 收的是字符串数组或逗号/空白分隔的一段。
 * p2pPersonaId 同一条纪律：键不给 = 保留原值；给了就校验员工在不在（空串 = 回到系统管家）。
 */
export function saveConfig({ appId, appSecret, enabled, allowOpenIds, p2pPersonaId } = {}) {
  const prev = readRawConfig();
  const next = {
    appId: String(appId ?? prev.appId ?? '').trim(),
    appSecret: appSecret ? String(appSecret) : prev.appSecret,
    enabled: enabled === true,
    allowOpenIds: Array.isArray(allowOpenIds)
      ? allowOpenIds.map((s) => String(s).trim()).filter(Boolean)
      : prev.allowOpenIds,
    p2pPersonaId: p2pPersonaId === undefined ? prev.p2pPersonaId : String(p2pPersonaId ?? '').trim(),
  };
  if (!next.appId || !next.appSecret) throw fail('App ID 和 App Secret 都得填', 'E2061');
  if (!APP_ID_RE.test(next.appId)) throw fail('App ID 不对 —— 它长这样：cli_ 加 16 位十六进制', 'E2062');
  if (next.p2pPersonaId && !store.getPersona(next.p2pPersonaId)) {
    throw fail('要绑定的员工不存在（可能已被删）', 'E2067');
  }
  writeJson(cfgFile(), next, true);
  return next;
}

/** 凭据齐不齐、格式对不对。通过返回 null，不通过返回人话（给路由直接用） */
export function validateCredentials() {
  const cfg = readRawConfig();
  if (!cfg.appId || !cfg.appSecret) return 'App ID 和 App Secret 都得填';
  if (!APP_ID_RE.test(cfg.appId)) return 'App ID 不对 —— 它长这样：cli_ 加 16 位十六进制';
  return null;
}

/* --------------------------------------------------- 飞书 chat ↔ 班底会话 的桥 */

/** 飞书群里的 @员工名 → 哪个员工。匹配逻辑复用 dispatch.parseMentions（按名字长度倒序） */
function matchPersonaMentions(text) {
  const personas = store.listPersonas().filter((p) => p?.name);
  const hits = parseMentions(text, personas);
  let rest = text;
  for (const p of hits) rest = rest.split('@' + p.name).join(' ');
  return { hits, text: rest.replace(/\s+/g, ' ').trim() };
}

/** 群里 @了人 → 那个人的**专属会话**（一个飞书群 × 一个员工 = 一条，删了自动重建） */
function ensureGroupConversation(chatId, persona) {
  const links = readJson(linksFile());
  const key = `${chatId}:${persona.id}`;
  const known = links[key];
  if (known?.conversationId && store.getConversation(known.conversationId)) return known.conversationId;
  const chatName = String(known?.chatName ?? links[`${chatId}:`]?.chatName ?? '').trim();
  const conv = store.createConversation({
    title: `飞书${chatName ? ` · ${chatName}` : ''} · ${persona.name}`,
    personaId: persona.id,
  });
  writeJson(linksFile(), { ...links, [key]: { conversationId: conv.id, chatName: chatName || known?.chatName || '' } });
  return conv.id;
}

/** 第一次收到某个群的消息时，问飞书要一次群名（之后缓存在 links 里） */
async function rememberChatName(chatId) {
  const links = readJson(linksFile());
  const keys = Object.keys(links).filter((k) => k.startsWith(`${chatId}:`));
  if (keys.length && links[keys[0]]?.chatName) return;
  try {
    const j = await feishuApi('GET', `/im/v1/chats/${encodeURIComponent(chatId)}`);
    const name = String(j?.data?.name ?? '').trim();
    if (!name) return;
    const next = { ...links };
    if (keys.length) for (const k of keys) next[k] = { ...next[k], chatName: name };
    else next[`${chatId}:`] = { conversationId: null, chatName: name };
    writeJson(linksFile(), next);
  } catch { /* 要不到名字就用 id 兜底，不拦派活 */ }
}

/* --------------------------------------------------------------- 连接状态 */

const conn = { state: 'stopped', lastError: '', startedAt: null, lastEventAt: null, connectedAt: null };
export function channelStatus() {
  return { ...conn, enabled: readRawConfig().enabled, configured: !validateCredentials() };
}

/* --------------------------------------------------------- protobuf 编解码 */

/*
 * pbbp2 的线格式（字段号照抄官方 node-sdk ws-client/proto-buf/pbbp2.js 的生成代码）：
 *   Header: key=1 string, value=2 string
 *   Frame:  SeqID=1 uint64, LogID=2 uint64, service=3 int32, method=4 int32,
 *           headers=5 repeated Header, payloadEncoding=6, payloadType=7, payload=8 bytes
 * method：0=control（ping/pong），1=data（事件/卡片）。wire type：0=varint，2=长度前缀。
 */
const METHOD_CONTROL = 0;
const METHOD_DATA = 1;

function pbVarint(out, n) {
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function pbTag(out, field, wireType) {
  pbVarint(out, (field << 3) | wireType);
}

function pbLenDelim(out, field, bytes) {
  pbTag(out, field, 2);
  pbVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

function pbString(out, field, s) {
  pbLenDelim(out, field, Array.from(Buffer.from(String(s), 'utf8')));
}

function encodeHeader(header) {
  const out = [];
  if (header.key != null) pbString(out, 1, header.key);
  if (header.value != null) pbString(out, 2, header.value);
  return out;
}

export function encodeFrame(frame) {
  const out = [];
  pbTag(out, 1, 0);
  pbVarint(out, frame.SeqID ?? 0);
  pbTag(out, 2, 0);
  pbVarint(out, frame.LogID ?? 0);
  pbTag(out, 3, 0);
  pbVarint(out, frame.service ?? 0);
  pbTag(out, 4, 0);
  pbVarint(out, frame.method ?? 0);
  for (const h of frame.headers ?? []) pbLenDelim(out, 5, encodeHeader(h));
  if (frame.payload != null) pbLenDelim(out, 8, Array.from(frame.payload));
  return Uint8Array.from(out);
}

export function decodeFrame(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let pos = 0;
  const frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [], payload: null };
  const readVarint = () => {
    let v = 0;
    let shift = 1;
    for (;;) {
      const b = u8[pos++];
      v += (b & 0x7f) * shift;
      if (!(b & 0x80)) return v;
      shift *= 128;
    }
  };
  const readBytes = () => {
    const len = readVarint();
    const part = u8.subarray(pos, pos + len);
    pos += len;
    return part;
  };
  while (pos < u8.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const v = readVarint();
      if (field === 1) frame.SeqID = v;
      else if (field === 2) frame.LogID = v;
      else if (field === 3) frame.service = v;
      else if (field === 4) frame.method = v;
    } else if (wt === 2) {
      const part = readBytes();
      if (field === 5) {
        const h = { key: '', value: '' };
        let hp = 0;
        while (hp < part.length) {
          const htag = part[hp++];
          if ((htag & 7) !== 2) break;
          const hlen = part[hp++];
          const text = Buffer.from(part.subarray(hp, hp + hlen)).toString('utf8');
          hp += hlen;
          if ((htag >>> 3) === 1) h.key = text;
          else if ((htag >>> 3) === 2) h.value = text;
        }
        frame.headers.push(h);
      } else if (field === 6 || field === 7 || field === 9) {
        /* payloadEncoding / payloadType / LogIDNew：发的时候不写，收的时候忽略 */
      } else if (field === 8) {
        frame.payload = part;
      }
    } else {
      break; // 认不得的字段类型：别硬啃，剩下的当损坏帧丢弃
    }
  }
  return frame;
}

/* ------------------------------------------------------------ 事件分片与去重 */

/** 分片缓存：message_id → {buffer: Array(sum), at}。10 秒没拼齐就丢（与官方 SDK 同口径） */
const fragments = new Map();
/** event_id 去重：飞书是 at-least-once，ack 迟了会被重推 */
const seenEvents = new Map();

function mergeFragments(headers, payload) {
  const messageId = String(headers.message_id ?? '');
  const sum = Number(headers.sum ?? 1);
  const seq = Number(headers.seq ?? 0);
  if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) return null;
  if (sum === 1) return Buffer.from(payload ?? []).toString('utf8');
  let slot = fragments.get(messageId);
  if (!slot || slot.buffer.length !== sum) {
    slot = { buffer: new Array(sum).fill(null), at: Date.now() };
    fragments.set(messageId, slot);
  }
  slot.buffer[seq] = payload;
  if (!slot.buffer.every((p) => p != null)) return null;
  fragments.delete(messageId);
  return Buffer.concat(slot.buffer.map((p) => Buffer.from(p))).toString('utf8');
}

function pruneCaches() {
  const now = Date.now();
  for (const [k, v] of fragments) if (now - v.at > 10000) fragments.delete(k);
  for (const [k, t] of seenEvents) if (now - t > 5 * 60 * 1000) seenEvents.delete(k);
}

/* ------------------------------------------------------------- 飞书 API 客户端 */

let deps = null; // { fetchImpl, WSCtor } —— start() 时注入，测试换假件
const theFetch = (...a) => (deps?.fetchImpl ?? fetch)(...a);

let tokenCache = { token: '', expiresAt: 0 };

/** 凭据被拒时按错误码给一句能照做的话（21001 是实测踩过的：应用没发布上线/被管理后台策略拦） */
function tokenDenialHint(code) {
  if (code === 21001) return ' —— 应用多半还没发布上线：开发者后台 → 版本管理与发布 → 创建版本并发布（可用范围要有你）；或被企业管理后台的策略拦了';
  if (code === 10003) return ' —— App Secret 不对，回开发者后台「凭证与基础信息」重新复制';
  return '';
}

/** tenant_access_token：自建应用拿应用身份的唯一一步，缓存到过期前 2 分钟 */
export async function tenantToken() {
  const cfg = readRawConfig();
  if (!cfg.appId || !cfg.appSecret) throw fail('App ID 和 App Secret 都得填', 'E2061');
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const r = await theFetch(`${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j?.code !== 0 || !j?.tenant_access_token) {
    throw fail(`飞书不肯发令牌：code=${j?.code} ${String(j?.msg ?? '').slice(0, 160)}${tokenDenialHint(j?.code)}`, 'E2064');
  }
  tokenCache = { token: j.tenant_access_token, expiresAt: Date.now() + (Number(j.expire ?? 3600) - 120) * 1000 };
  return tokenCache.token;
}

/** 带鉴权的飞书 OpenAPI 调用；401 类错误清一次令牌缓存重试。
 *  路径统一从这里补 `/open-apis` 前缀（调用方只写 `/im/v1/...` 这一级）——
 *  2026-10-28 实测踩过：前缀漏了网关回 404 "404 page not found"（非 JSON），令牌却是好的，极具迷惑性。
 *  报错带 HTTP 状态码和原文片段——飞书偶尔回非标准 JSON（HTML 错误页/空体），
 *  不记原文的话日志里只剩一个看不懂的 code=undefined。 */
async function feishuApi(method, pathWithQuery, body) {
  const call = async (token) =>
    theFetch(`${DOMAIN}/open-apis${pathWithQuery}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  let r = await call(await tenantToken());
  let text = await r.text().catch(() => '');
  let j = null;
  try {
    j = JSON.parse(text);
  } catch { /* 非 JSON：错误信息里带原文 */ }
  if (j?.code === 99991663 || j?.code === 99991661) {
    tokenCache = { token: '', expiresAt: 0 };
    r = await call(await tenantToken());
    text = await r.text().catch(() => '');
    j = null;
    try {
      j = JSON.parse(text);
    } catch { /* 同上 */ }
  }
  if (j?.code !== 0) {
    const detail = j ? `${j.code ?? '(无 code)'} ${String(j.msg ?? '')}` : `非 JSON：${text.slice(0, 200)}`;
    throw fail(`飞书接口 ${method} ${pathWithQuery.split('?')[0]} → HTTP ${r.status}，${detail}`.slice(0, 400), 'E2064');
  }
  return j;
}

/** 给一个飞书会话（chat_id）发一张互动卡片，回 message_id（后面 PATCH 更新它） */
async function sendCard(chatId, card) {
  const j = await feishuApi('POST', '/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });
  return j?.data?.message_id ?? null;
}

/** 更新已发出的卡片内容（飞书允许改卡片，不允许改普通消息） */
async function updateCard(messageId, card) {
  await feishuApi('PATCH', `/im/v1/messages/${encodeURIComponent(messageId)}`, { content: JSON.stringify(card) });
}

/* --------------------------------------------------------------- 卡片样式 */

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * 进度卡。状态词与颜色：排队=grey，进行中=blue，已完成=green，失败=red，已停止=grey。
 * v1 不带按钮（拍板按钮第二版），elements 只有一块 markdown + 一行 note。
 */
function buildCard({ personaName, status, detail }) {
  const tpl = status === '已完成' ? 'green' : status === '失败' ? 'red' : status === '进行中' ? 'blue' : 'grey';
  return {
    config: { wide_screen_mode: true },
    header: { template: tpl, title: { tag: 'plain_text', content: `${personaName} · ${status}` } },
    elements: [
      { tag: 'markdown', content: detail },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '班底 · 飞书通道' }] },
    ],
  };
}

/** 不跟着 run 走的一次性提示卡（非文字消息提醒之类） */
const plainCard = (detail) => buildCard({ personaName: '班底', status: '收到', detail });

function progressDetail(instruction, view) {
  const lines = [`**指令**：${clip(instruction, 200)}`];
  const step = view.currentStep ?? view.lastStep;
  const doing = step ? `${step.verb}${step.target ? ` ${step.target}` : ''}` : view.info;
  lines.push(`**进度**：${view.phaseText}${doing ? ` —— ${clip(doing, 80)}` : ''}（第 ${view.stepCount || 0} 步 · 用时 ${fmtMs(view.elapsedMs)}）`);
  return lines.join('\n');
}

function fmtMs(ms) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* --------------------------------------------------------------- run 跟踪 */

/*
 * 每条飞书指令一张卡，跟着 run 走。轮询 `store.listRunEvents`（事件已全落库）——
 * 不挂 runs.onRunFinish 钩子是因为轮询自己就能看到终止事件 `__done`，
 * 一个机制管全程，不用两头接。服务重启会丢跟踪（卡片停在最后一次刷新），
 * 与群排队同口径：要"必须不丢"的活走任务卡，不在这儿。
 */
const POLL_MS = 4000;
const tracked = new Map(); // runId → entry

function trackRun({ run, chatId, personaName, instruction }) {
  if (!run?.id || tracked.size > 200) return;
  const entry = {
    chatId,
    personaName,
    instruction,
    messageId: null,
    sending: false,
    state: createRunProgress({ startedAt: Date.now() }),
    finalText: '',
    finalError: '',
    sinceSeq: 0,
    lastSentAt: 0,
    lastKey: '',
    timer: null,
  };
  tracked.set(run.id, entry);
  // 先发初始卡；message_id 回来才开始 PATCH（发失败就只留日志，不拦派活本身）
  sendCard(chatId, buildCard({ personaName, status: '进行中', detail: progressDetail(instruction, progressView(entry.state)) }))
    .then((id) => {
      entry.messageId = id;
      entry.lastSentAt = Date.now();
    })
    .catch((e) => console.warn(`[飞书] 初始卡发不出去：${e?.message ?? e}`));
  entry.timer = setInterval(() => pollRun(run.id), POLL_MS);
  entry.timer.unref?.();
}

async function pollRun(runId) {
  const entry = tracked.get(runId);
  if (!entry) return;
  try {
    for (const row of store.listRunEvents(runId, entry.sinceSeq)) {
      let evt = null;
      try {
        evt = JSON.parse(row.evt);
      } catch {
        continue;
      }
      entry.sinceSeq = Math.max(entry.sinceSeq, row.seq);
      if (evt.type === '__done') {
        entry.finalText = String(evt.finalText ?? '');
        entry.finalError = String(evt.error ?? '');
      }
      applyRunEvent(entry.state, evt);
    }
    const view = progressView(entry.state);
    if (entry.state.done) {
      clearInterval(entry.timer);
      tracked.delete(runId);
      if (!entry.messageId) return;
      const st = String(entry.state.status ?? '');
      const status = st === '完成' ? '已完成' : st === '已停止' ? '已停止' : '失败';
      let detail = `**指令**：${clip(entry.instruction, 200)}\n`;
      if (status === '已完成') detail += `**结果**：\n${clip(entry.finalText, 800) || '（没有正文，到会话里看）'}`;
      else detail += `**原因**：${clip(entry.finalError || entry.finalText || entry.state.error || '到会话里看详情', 400)}`;
      await updateCard(entry.messageId, buildCard({ personaName: entry.personaName, status, detail }));
      return;
    }
    // 还在跑：状态有变化才刷，且至少隔 3 秒（别追着飞书限频跑）
    const step = view.currentStep ?? view.lastStep;
    const key = `${view.phaseText}|${view.stepCount}|${step ? step.verb + step.target : view.info}`;
    if (key === entry.lastKey || Date.now() - entry.lastSentAt < 3000 || !entry.messageId || entry.sending) return;
    entry.lastKey = key;
    entry.lastSentAt = Date.now();
    entry.sending = true;
    try {
      await updateCard(entry.messageId, buildCard({ personaName: entry.personaName, status: '进行中', detail: progressDetail(entry.instruction, view) }));
    } finally {
      entry.sending = false;
    }
  } catch (e) {
    console.warn(`[飞书] 进度卡更新失败：${e?.message ?? e}`);
  }
}

/* ------------------------------------------------------------ 消息 → 派活 */

/** 机器人自己的 open_id（/bot/v3/info，问一次缓存一辈子；要不到就空 —— 剔除只是锦上添花） */
let botIdCache = null;
async function botOpenId() {
  if (botIdCache !== null) return botIdCache;
  try {
    const j = await feishuApi('GET', '/bot/v3/info');
    botIdCache = String(j?.bot?.open_id ?? '');
  } catch (e) {
    botIdCache = '';
    console.warn(`[飞书] 取机器人 open_id 失败：${e?.message ?? e}`);
  }
  return botIdCache;
}

/** 一条飞书消息进班底：路由 → 派活 → 开卡跟踪 */
async function handleFeishuMessage(event) {
  const msg = event.message ?? {};
  console.log(`[飞书] 收到${msg.chat_type === 'p2p' ? '私聊' : '群'}消息（类型 ${msg.message_type}）`);
  const sender = event.sender ?? {};
  const chatId = String(msg.chat_id ?? '');
  const chatType = String(msg.chat_type ?? '');
  if (!chatId) return;

  // 白名单（open_id 列表）：空 = 不限制。非白名单的人发话一律无视
  const cfg = readRawConfig();
  const openId = String(sender?.sender_id?.open_id ?? '');
  if (cfg.allowOpenIds.length && (!openId || !cfg.allowOpenIds.includes(openId))) {
    console.log(`[飞书] ${openId || '未知用户'} 不在白名单里，忽略`);
    return;
  }

  // 只认文字。别的类型在私聊里回一句，群里不打扰
  if (msg.message_type !== 'text') {
    if (chatType === 'p2p') {
      try {
        await sendCard(chatId, plainCard('收到的是图片/文件/富文本 —— 派活请发**文字**'));
      } catch { /* 尽力而为 */ }
    }
    return;
  }

  let text = '';
  try {
    text = String(JSON.parse(String(msg.content ?? '{}')).text ?? '');
  } catch {
    return;
  }
  if (!text.trim()) return;
  // 飞书的 @ 在正文里是 @_user_N 占位符，换成看得懂的名字；**机器人自己的 @ 剔掉**
  //（群里 "机器人 @大梁 干活" 这句话给员工的正文不该带着 @机器人 的噪音）
  const botId = await botOpenId();
  for (const m of Array.isArray(msg.mentions) ? msg.mentions : []) {
    if (!m?.key) continue;
    const isBot = !!botId && String(m?.id?.open_id ?? '') === botId;
    text = text.split(m.key).join(isBot ? ' ' : '@' + String(m.name ?? ''));
  }
  text = text.replace(/[ \t]+/g, ' ').trim();
  if (!text) return;

  // 路由：私聊 → 绑定的员工（没绑/绑的没了 → 系统管家）；群 → @了谁谁干活，没 @（或没匹配到员工）不响应
  let persona = null;
  if (chatType === 'p2p') {
    persona = p2pPersona(cfg);
    if (!persona) {
      console.warn('[飞书] 私聊找不到要派给的人（系统管家也不在了），派不了活');
      return;
    }
  } else {
    if (!text.includes('@')) return;
    const { hits, text: rest } = matchPersonaMentions(text);
    if (!hits.length) return; // 群里只响应 @员工名
    persona = hits[0];
    text = rest || text; // 只 @ 了没说事：把原文给它（至少留个痕）
    await rememberChatName(chatId); // 第一次见到这个群时问一次群名，之后走缓存
  }

  if (chatType === 'p2p') {
    const conversationId = store.ensureConversationForPersona(persona.id)?.id;
    if (!conversationId) {
      console.warn('[飞书] 建不了会话，这条消息派不出去');
      return;
    }
    try {
      const { run } = dispatchToThread(conversationId, text, {});
      trackRun({ run, chatId, personaName: persona.name, instruction: text });
    } catch (e) {
      if (e?.code !== 'busy') throw e;
      await queueBusyInstruction({ conversationId, persona, text, chatId });
    }
  } else {
    await dispatchGroupInstruction({ persona, text, chatId });
  }
}

/** 忙：消息照落库进队，等会话空出来补派（结果在会话里看，这张卡不跟 run 了） */
async function queueBusyInstruction({ conversationId, persona, text, chatId }) {
  const r = dispatchEventToThread(conversationId, text, { personaId: persona.id });
  try {
    await sendCard(
      chatId,
      buildCard({
        personaName: persona.name,
        status: r?.queuedLater ? '已排队' : '收到',
        detail:
          `**指令**：${clip(text, 200)}\n` +
          (r?.queuedLater
            ? '**状态**：他手上有活在跑，这条已排队，轮到会自动开跑（结果到班底会话里看）'
            : '**状态**：已交给班底（结果到会话里看）'),
      }),
    );
  } catch { /* 尽力而为 */ }
}

/** 群里派活：员工专属会话 → 派活开卡跟踪；撞 busy 落库排队。正文派活和选人卡点按钮共用 */
async function dispatchGroupInstruction({ persona, text, chatId }) {
  await rememberChatName(chatId); // 建会话前把群名拿到，标题才带得上群名（有缓存，基本不耗时）
  const conversationId = ensureGroupConversation(chatId, persona);
  if (!conversationId) {
    console.warn('[飞书] 建不了会话，这条消息派不出去');
    return;
  }
  try {
    const { run } = dispatchToThread(conversationId, text, {});
    trackRun({ run, chatId, personaName: persona.name, instruction: text });
  } catch (e) {
    if (e?.code !== 'busy') throw e;
    queueBusyInstruction({ conversationId, persona, text, chatId }).catch(() => {});
  }
}

/* ------------------------------------------------------------- 长连接循环 */

let ws = null;
let closed = true;
let generation = 0;
let pingTimer = null;
let reconnectTimer = null;
let wsCfg = { url: '', serviceId: 0, pingInterval: 30000, reconnectCount: -1, reconnectInterval: 5000, reconnectNonce: 0 };

function clearTimers() {
  if (pingTimer) clearTimeout(pingTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  pingTimer = reconnectTimer = null;
}

/** 第一步：拿临时接入点（POST /callback/ws/endpoint）。凭据错误不可重试，系统忙可重试 */
async function pullEndpoint() {
  const cfg = readRawConfig();
  const r = await theFetch(`${DOMAIN}/callback/ws/endpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', locale: 'zh' },
    body: JSON.stringify({ AppID: cfg.appId, AppSecret: cfg.appSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j?.code !== 0 || !j?.data?.URL) {
    const retryable = j?.code === 1000040343 || j?.code === 1;
    throw Object.assign(new Error(`拿接入点失败：code=${j?.code} ${String(j?.msg ?? '').slice(0, 160)}`), {
      retryable,
      code: j?.code,
    });
  }
  const u = new URL(j.data.URL);
  const cc = j.data.ClientConfig ?? {};
  wsCfg = {
    url: j.data.URL,
    serviceId: Number(u.searchParams.get('service_id') ?? 0),
    pingInterval: Number(cc.PingInterval ?? 30) * 1000,
    reconnectCount: Number(cc.ReconnectCount ?? -1),
    reconnectInterval: Number(cc.ReconnectInterval ?? 5) * 1000,
    reconnectNonce: Number(cc.ReconnectNonce ?? 0) * 1000,
  };
  return wsCfg.url;
}

/** 连一次：endpoint → WebSocket。成功 true；失败 false（reason 已写进 conn.lastError） */
function connectOnce(url) {
  return new Promise((resolve) => {
    let settled = false;
    const WSCtor = deps?.WSCtor ?? globalThis.WebSocket;
    if (!WSCtor) {
      conn.lastError = '这个 Node 没有 WebSocket（要 Node 22+）';
      return resolve(false);
    }
    let sock;
    try {
      sock = new WSCtor(url);
    } catch (e) {
      conn.lastError = `连不上：${e?.message ?? e}`;
      return resolve(false);
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.lastError = '握手超时（15 秒没连上）';
      try { sock.close(); } catch { /* 尽力 */ }
      resolve(false);
    }, 15000);
    timer.unref?.();
    sock.binaryType = 'arraybuffer';
    sock.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws = sock;
      resolve(true);
    });
    sock.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.lastError = conn.lastError || 'WebSocket 连接失败（凭据不对或网络不通）';
      resolve(false);
    });
  });
}

function sendFrame(frame) {
  if (ws?.readyState === 1) {
    try {
      ws.send(encodeFrame(frame));
    } catch (e) {
      console.warn(`[飞书] 发帧失败：${e?.message ?? e}`);
    }
  }
}

function pingLoop() {
  if (closed) return;
  if (ws?.readyState === 1) {
    sendFrame({
      SeqID: 0,
      LogID: 0,
      service: wsCfg.serviceId,
      method: METHOD_CONTROL,
      headers: [{ key: 'type', value: 'ping' }],
    });
  }
  pingTimer = setTimeout(pingLoop, wsCfg.pingInterval);
  pingTimer.unref?.();
}

function onFrame(frame) {
  conn.lastEventAt = Date.now();
  const headers = Object.fromEntries((frame.headers ?? []).map((h) => [h.key, h.value]));

  if (frame.method === METHOD_CONTROL) {
    if (headers.type !== 'pong' || !frame.payload) return;
    try {
      const pong = JSON.parse(Buffer.from(frame.payload).toString('utf8'));
      wsCfg = {
        ...wsCfg,
        pingInterval: Number(pong.PingInterval ?? wsCfg.pingInterval / 1000) * 1000,
        reconnectCount: Number(pong.ReconnectCount ?? wsCfg.reconnectCount),
        reconnectInterval: Number(pong.ReconnectInterval ?? wsCfg.reconnectInterval / 1000) * 1000,
        reconnectNonce: Number(pong.ReconnectNonce ?? wsCfg.reconnectNonce / 1000) * 1000,
      };
    } catch { /* pong 坏了不致命：下一个 ping 还会来 */ }
    return;
  }

  if (frame.method !== METHOD_DATA) return;

  // 先 ack 再处理（不管后面认不认这种帧 —— 不回执的帧会被服务端重推个没完）
  sendFrame({
    SeqID: frame.SeqID,
    LogID: frame.LogID,
    service: frame.service,
    method: METHOD_DATA,
    headers: [...(frame.headers ?? []), { key: 'biz_rt', value: '0' }],
    payload: Buffer.from(JSON.stringify({ code: 200 }), 'utf8'),
  });

  if (headers.type !== 'event') return; // card 回调（拍板按钮）是第二版的事：ack 掉、先不处理

  const merged = mergeFragments(headers, frame.payload);
  if (!merged) return;
  pruneCaches();
  let envelope = null;
  try {
    envelope = JSON.parse(merged);
  } catch (e) {
    console.warn(`[飞书] 事件不是合法 JSON：${e?.message ?? e}`);
    return;
  }
  const eventId = String(envelope?.header?.event_id ?? '');
  if (eventId) {
    if (seenEvents.has(eventId)) return;
    seenEvents.set(eventId, Date.now());
  }
  const evtType = String(envelope?.header?.event_type ?? '');
  if (evtType !== 'im.message.receive_v1') return;
  handleFeishuMessage(envelope.event ?? {}).catch((e) =>
    console.error(`[飞书] 处理消息失败：${e?.message ?? e}`),
  );
}

function communicate() {
  ws.addEventListener('message', (ev) => {
    try {
      const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
      onFrame(decodeFrame(data));
    } catch (e) {
      console.warn(`[飞书] 坏帧：${e?.message ?? e}`);
    }
  });
  ws.addEventListener('close', () => {
    ws = null;
    if (!closed) {
      conn.state = 'reconnecting';
      scheduleReconnect(generation);
    }
  });
  ws.addEventListener('error', () => { /* close 会跟着来，重连走那条路 */ });
}

async function tryConnect(gen) {
  conn.state = 'connecting';
  try {
    await pullEndpoint();
  } catch (e) {
    conn.lastError = e?.message ?? String(e);
    return { ok: false, retryable: e?.retryable === true };
  }
  const ok = await connectOnce(wsCfg.url);
  if (!ok) return { ok: false, retryable: true };
  conn.state = 'connected';
  conn.connectedAt = Date.now();
  conn.lastError = '';
  communicate();
  // 旧连接的心跳链还在排着队 —— 不清掉的话每重连一次就多一条链，ping 越发越密
  if (pingTimer) clearTimeout(pingTimer);
  pingLoop();
  return { ok: true };
}

function scheduleReconnect(gen) {
  if (closed || gen !== generation) return;
  const jitter = wsCfg.reconnectNonce ? Math.random() * wsCfg.reconnectNonce : 0;
  reconnectTimer = setTimeout(() => loopReconnect(gen, 0), jitter);
  reconnectTimer.unref?.();
}

async function loopReconnect(gen, count) {
  if (closed || gen !== generation) return;
  const r = await tryConnect(gen);
  if (closed || gen !== generation) return;
  if (r.ok) return;
  if (!r.retryable || (wsCfg.reconnectCount >= 0 && count + 1 >= wsCfg.reconnectCount)) {
    conn.state = 'failed';
    conn.lastError = conn.lastError || '重连次数用完了，去设置页手动启动';
    return;
  }
  conn.state = 'reconnecting';
  reconnectTimer = setTimeout(() => loopReconnect(gen, count + 1), wsCfg.reconnectInterval);
  reconnectTimer.unref?.();
}

/**
 * 启动通道（幂等）。等第一次连接出结果再回来 —— 成功 `{ok:true}`；
 * 可重试的失败不抛错、转入后台重连（`{ok:false, retrying:true}`）；
 * 凭据问题抛 E2061/E2062。
 * `deps` 给测试换假件：`{ fetchImpl, WSCtor }`。
 */
export async function start(d = {}) {
  deps = { fetchImpl: d.fetchImpl ?? deps?.fetchImpl ?? fetch, WSCtor: d.WSCtor ?? deps?.WSCtor ?? globalThis.WebSocket };
  const bad = validateCredentials();
  if (bad) throw fail(bad, 'E2061');
  if (!closed) return { ok: conn.state === 'connected', status: channelStatus() };
  closed = false;
  conn.startedAt = Date.now();
  const gen = ++generation;
  const r = await tryConnect(gen);
  if (closed) return { ok: false, status: channelStatus() };
  if (!r.ok) {
    if (!r.retryable) {
      closed = true;
      conn.state = 'failed';
      throw fail(conn.lastError, 'E2066');
    }
    conn.state = 'reconnecting';
    scheduleReconnect(gen);
    return { ok: false, retrying: true, status: channelStatus() };
  }
  return { ok: true, status: channelStatus() };
}

/** 停通道。closed 标志让在飞的重连循环与迟到的事件处理全部失效 */
export function stop() {
  closed = true;
  generation += 1;
  clearTimers();
  try {
    ws?.close();
  } catch { /* 尽力 */ }
  ws = null;
  conn.state = 'stopped';
  conn.lastError = '';
}

/** 连通性测试（设置页「测试连接」）：只拿一次令牌，不花生不钱，不动通道状态 */
export async function testConnection() {
  const bad = validateCredentials();
  if (bad) throw fail(bad, 'E2061');
  tokenCache = { token: '', expiresAt: 0 };
  await tenantToken();
  return { ok: true };
}

/** 开机同步：配置开着且凭据齐就自启（server.mjs 启动时调一次） */
export function bootSync() {
  const cfg = readRawConfig();
  if (!cfg.enabled) return;
  start().catch((e) => console.warn(`[飞书] 开机自启没成（不影响启动）：${e?.message ?? e}`));
}
