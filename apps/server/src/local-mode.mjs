/**
 * 本机身份（2026-10-20，设计 §3.1 / §4.3）。
 *
 * 多机节点子系统（加入总机 / 退出 / 探测 / 通讯录 / node.json 身份）已于 2026-11-09
 * 整体删除 —— 本文件只剩两件仍然全局要用的东西：
 *   · `instanceId()`     —— 本机实例 id（UDP 应答去重键、反代注入给前端的标记）；
 *   · `platformVersion()` —— 平台版本号（`/api/hello`、`bandi status`）。
 * 另有 `LocalError`：`routes/local.mjs` 的错误翻译还认它。
 *
 * ⚠️ **绝对不许 import `store.mjs`**（设计 §3.1 那段长注释）：
 *   `store.mjs` 一 import 就 `new DatabaseSync(dbPath)` 并跑迁移 —— 谁在"库还没建 /
 *   库被占着"的时刻要用本文件（`bandi status` 等），就会在最需要它的时候炸。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, repoRoot } from './config.mjs';

const INSTANCE_FILE = path.join(dataDir, 'instance.json');

/**
 * 「探 / 加入 / 退出」这类失败**带 HTTP 状态 + 错误码**往上抛（设计 §5.10 那张表）。
 *
 * 为什么做一个类而不是直接 `throw new Error`：handler 要把它原样翻成
 * `fail(res, status, code, 中文)`；用 `message` 里塞 JSON 那种做法，下一个人一定会写歪。
 */
export class LocalError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.name = 'LocalError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------- instance.json（本机实例 id） */

let cachedInstanceId = null;

/**
 * 本机实例 id（`inst-<uuid>`），跨重启稳定 —— UDP 应答的去重键、反代注入给前端的标记。
 *
 * 读不到 / 写不进 → **进程内生成一次**并告警（设计 §4.3 最后一条）：
 * 一个身份文件写不进去，不该让整个服务起不来。
 */
export function instanceId() {
  if (cachedInstanceId) return cachedInstanceId;
  try {
    const j = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'));
    if (j?.instanceId) {
      cachedInstanceId = String(j.instanceId);
      return cachedInstanceId;
    }
  } catch {
    /* 没有 / 坏了：下面生成一个 */
  }
  const id = `inst-${crypto.randomUUID()}`;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(INSTANCE_FILE, `${JSON.stringify({ instanceId: id, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn(`[本机] 实例 id 写不进 ${INSTANCE_FILE}：${e?.message ?? e} —— 本次运行临时用一个`);
  }
  cachedInstanceId = id;
  return id;
}

/**
 * 平台版本号（读 `apps/desktop/version.json`；读不到给 null —— 不编）。
 *
 * 两个位置都认（2026-10-22）：源码检出在 `apps/desktop/version.json`，**安装版**则被
 * `bundle.resources` 摊在安装目录根上（`version.json`）—— 只认前一个的话，装出来的
 * 那份 `/api/hello` 和 `bandi status` 会一直显示"版本未知"（静默、只在装完才看出来）。
 */
let cachedVersion;
export function platformVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  for (const p of [path.join(repoRoot, 'apps', 'desktop', 'version.json'), path.join(repoRoot, 'version.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j?.version) {
        cachedVersion = String(j.version);
        return cachedVersion;
      }
    } catch { /* 换下一个位置 */ }
  }
  cachedVersion = null;
  return cachedVersion;
}
