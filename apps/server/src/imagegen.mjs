/* imagegen.mjs —— 生图服务（2026-10-23）。
 *
 * 干什么：给数字员工一个「生成图片」的通道 —— 典型用途是生成头像
 * （技能 skills/bandi-avatar 教员工怎么用），设置页「生图服务」配 key。
 *
 * 通道形态：**OpenAI 兼容 images API** 的转发 —— 用户填 Base URL（到 /v1 这级）
 * + API Key + 模型名，SiliconFlow / 火山方舟（豆包）/ 混元 / 自建中转都能接。
 *
 * 凭据口径（对齐 github-token，2026-10-22 定）：
 *   · 存数据目录的 `image-provider.json`（0600 尽力），**不进库、不进日志、不回显**；
 *   · 接口只回掩码（前 2 位 + 18 星 + 后 4 位）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir } from './config.mjs';

const CFG_FILE = path.join(dataDir, 'image-provider.json');
const OUT_DIR = path.join(dataDir, 'generated');

export function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    const baseUrl = String(raw.baseUrl ?? '').trim().replace(/\/+$/, '');
    const apiKey = String(raw.apiKey ?? '');
    const model = String(raw.model ?? '').trim();
    if (!baseUrl || !apiKey || !model) return null;
    return { baseUrl, apiKey, model };
  } catch {
    return null;
  }
}

/** key 掩码：前 2 位 + 18 星 + 后 4 位；太短只给 6 星（跟 git 令牌同一套） */
export function keyHint(key) {
  const t = String(key ?? '');
  if (!t) return '';
  if (t.length < 10) return '*'.repeat(6);
  return `${t.slice(0, 2)}${'*'.repeat(18)}${t.slice(-4)}`;
}

/**
 * 保存配置。apiKey 语义：**键存在且非空才覆盖**（留空 = 保留原 key），
 * 这样界面「改个模型名」不用重新粘贴 key。
 */
export function writeConfig({ baseUrl, apiKey, model }) {
  const prev = JSON.parse(fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : '{}');
  const next = {
    baseUrl: String(baseUrl ?? prev.baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: apiKey ? String(apiKey) : String(prev.apiKey ?? ''),
    model: String(model ?? prev.model ?? '').trim(),
  };
  if (!next.baseUrl || !next.apiKey || !next.model) throw Object.assign(new Error('配置不完整'), { code: 'E2602' });
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 }); }
  catch { fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2)); }
  return next;
}

/** 连通性测试：打 GET /models（不花生图的钱），顺手看配置的模型在不在清单里 */
export async function testConfig() {
  const cfg = readConfig();
  if (!cfg) throw Object.assign(new Error('生图服务未配置'), { code: 'E2601' });
  const r = await fetch(`${cfg.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw Object.assign(new Error(`服务返回 ${r.status}：${text.slice(0, 200)}`), { code: 'E2604' });
  }
  let ids = [];
  try {
    const j = await r.json();
    ids = (j.data ?? j.models ?? []).map((m) => m.id ?? m.name ?? '').filter(Boolean);
  } catch { /* 有的兼容服务 /models 不标准 —— 连通就算过 */ }
  return { ok: true, modelListed: ids.length === 0 ? null : ids.includes(cfg.model), models: ids.length };
}

/**
 * 生成一张图，落盘 <dataDir>/generated/，返回 {file, bytes, model}。
 * 兼容两种回包：b64_json（多数）/ url（兜底下载）。
 *
 * 传 `image`（本机参考图绝对路径）时走 **images/edits**（图生图）——
 * 修改已有头像必须带原图（见 docs/头像生成规范.md：从零生成的风格不可控）。
 * Node 22 原生 FormData+Blob 组 multipart，不手拼边界。
 */
export async function generate({ prompt, size = '1024x1024', image }) {
  const cfg = readConfig();
  if (!cfg) throw Object.assign(new Error('生图服务未配置，先到 设置 → 生图服务 填写'), { code: 'E2601' });
  const text = String(prompt ?? '').trim();
  if (!text) throw Object.assign(new Error('prompt 不能为空'), { code: 'E2603' });

  let r;
  if (image) {
    /*
     * 参考图只认图片扩展名（2026-10-28 安全收口）：images/edits 本来就只吃图片，
     * 这个白名单不砍任何合法用途，但把"传个路径读任意文件再 POST 出去"的
     * 原语（读 token/数据库/密钥文件）收窄成只可能外发图片格式的文件。
     */
    const p = String(image);
    if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(p)) {
      throw Object.assign(new Error(`参考图必须是图片文件（png/jpg/webp/gif/bmp）：${p}`), { code: 'E2603' });
    }
    let ref;
    try { ref = fs.readFileSync(p); } catch {
      throw Object.assign(new Error(`参考图读不到：${image}`), { code: 'E2603' });
    }
    const fd = new FormData();
    fd.append('model', cfg.model);
    fd.append('prompt', text);
    fd.append('image', new Blob([ref], { type: 'image/png' }), 'reference.png');
    fd.append('n', '1');
    fd.append('size', String(size));
    r = await fetch(`${cfg.baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` }, // 不写 Content-Type，fetch 自带 boundary
      body: fd,
      signal: AbortSignal.timeout(300000),
    });
  } else {
    r = await fetch(`${cfg.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, prompt: text, n: 1, size, response_format: 'b64_json' }),
      signal: AbortSignal.timeout(300000),
    });
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    let msg = t;
    try { msg = JSON.parse(t)?.error?.message ?? t; } catch { /* 原文兜底 */ }
    throw Object.assign(new Error(`生图服务返回 ${r.status}：${String(msg).slice(0, 300)}`), { code: 'E2605' });
  }
  const j = await r.json();
  const item = j?.data?.[0] ?? {};
  let buf = null;
  if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64');
  else if (item.url) {
    const dr = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!dr.ok) throw Object.assign(new Error(`下载生成结果失败：${dr.status}`), { code: 'E2606' });
    buf = Buffer.from(await dr.arrayBuffer());
  }
  if (!buf?.length) throw Object.assign(new Error('生图服务没有返回图片数据'), { code: 'E2606' });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(OUT_DIR, `${stamp}-${randomBytes(3).toString('hex')}.png`);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, model: cfg.model };
}
