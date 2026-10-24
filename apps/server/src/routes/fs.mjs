/* routes/fs.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendJson, fail } from '../http.mjs';

export async function handleFs(req, res, url) {
  if (req.method !== 'GET' || url.pathname !== '/api/fs/dirs') return false;
  const want = String(url.searchParams.get('path') ?? '').trim();
  const dir = want ? path.resolve(want) : os.homedir();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return fail(res, 400, 'E1028', `读不了这个目录：${e.message}`);
  }
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return sendJson(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs });
}

