/**
 * **岗位本命手册**（2026-11-22）：读 `roles/packs/<key>.md`、缓存、生成注入块。
 *
 * 为什么单独一个文件：`roles.mjs` 是叶子（不 import 任何东西，迁移也要用它），
 * 文件系统依赖只能落在这一层 —— 岗位表里只留一个 `playbook` key。
 *
 * 三条约定：
 *   · 文件不存在 → 返回空串 / null（宁可少一段，不能让派活挂掉）；
 *   · 进程内缓存（按 key），文件 mtime 或大小变了才重读（开发时改了立刻生效）；
 *   · 只读一次全文返回，不做截断 —— 本轮是等价重构：以前模型可以 Read 全文，现在原样注入。
 */
import fs from 'node:fs';
import path from 'node:path';

const PACKS_DIR = path.join(import.meta.dirname, 'packs');

const packCache = new Map(); // key → { mtimeMs, size, body, meta }

/** 目录名要当路径用，必须收紧（与 roles.mjs 的 key 口径一致：字母数字开头，后接字母数字/点/下划线/连字符） */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 极简 frontmatter 解析：只认顶层的 `键: 值`，与 skills.mjs 同一口径 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

/** 按 key 读一份（带 mtime/size 缓存）。找不到返回 null */
function readPack(roleKey) {
  const key = String(roleKey ?? '').trim();
  if (!SAFE_KEY.test(key)) return null;
  const file = path.join(PACKS_DIR, `${key}.md`);

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null; // 文件不存在：宁可少一段，不能让派活挂掉
  }

  const hit = packCache.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  const rec = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    // frontmatter 原样留在文件里（界面要用 name/description），注入只取正文
    body: body.trim(),
    meta: { name: meta.name || key, description: meta.description || '' },
  };
  packCache.set(key, rec);
  return rec;
}

/** 正文（去掉 frontmatter），找不到返回 '' */
export function rolePackBody(roleKey) {
  return readPack(roleKey)?.body ?? '';
}

/** { name, description } 供界面用，找不到返回 null */
export function rolePackMeta(roleKey) {
  const rec = readPack(roleKey);
  return rec ? { ...rec.meta } : null;
}

/** 注入用文本，找不到返回 ''（形状固定，别再发挥） */
export function rolePackBlock(roleKey) {
  const body = rolePackBody(roleKey);
  if (!body) return '';
  return ['【你的岗位手册 · 平台内置，随岗位固定；下面是这个岗位的做事方法，按它做】', body].join('\n');
}
