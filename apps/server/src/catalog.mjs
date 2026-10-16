import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './config.mjs';

/**
 * 推荐清单（「公开」那一栏的来源）。
 *
 * 这不是"市场"：市场要审核、分发、版本、结算，一个人维护不了。
 * 它就是一份**随仓库走的 JSON**，每条写清楚"从哪来、怎么起、要什么凭据"。
 * 等真有生态了，把 listCatalog() 换成读远端 registry 即可，形状不用动。
 *
 * 清单条目 = 连接器登记的一份模板，多两个字段：
 *   · `requires` 缺哪个环境变量就装不起来（界面据此提示）
 *   · `category` 界面分组（生产力 / 开发 / 个人…）
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '..', 'catalog', 'connectors.json');

/** `${repo}` / `${cwd}` 在安装时替换成真实路径 */
function substitute(text) {
  return String(text)
    .replace(/\$\{repo\}/g, repoRoot)
    .replace(/\$\{cwd\}/g, repoRoot);
}

/** 上一次读清单失败的原因（读不到就说读不到，不让界面显示成"清单是空的"） */
let readError = null;

export function catalogError() {
  return readError;
}

export function listCatalog() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    readError = null;
  } catch (err) {
    readError = `推荐清单读不了（${path.basename(FILE)}）：${String(err?.message ?? err)}`;
    return [];
  }
  if (!Array.isArray(raw)) {
    readError = '推荐清单的形状不对：顶层应该是一个数组';
    return [];
  }
  return raw
    .filter((e) => e && typeof e.id === 'string')
    .map((e) => ({
      id: e.id,
      label: String(e.label ?? e.id),
      category: String(e.category ?? '其他'),
      description: String(e.description ?? ''),
      source: { kind: String(e.source?.kind ?? 'manual'), ref: String(e.source?.ref ?? '') },
      transport: e.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      command: e.command ? substitute(e.command) : '',
      args: Array.isArray(e.args) ? e.args.map(substitute) : [],
      cwd: e.cwd ? substitute(e.cwd) : '',
      url: e.url ? substitute(e.url) : '',
      env: e.env && typeof e.env === 'object' ? { ...e.env } : {},
      requires: Array.isArray(e.requires) ? e.requires.map(String) : [],
      note: String(e.note ?? ''),
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
}

export function getCatalog(id) {
  return listCatalog().find((e) => e.id === id) ?? null;
}
