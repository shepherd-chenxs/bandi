/* routes/fs.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendJson, fail } from '../http.mjs';

export async function handleFs(req, res, url) {
  if (req.method !== 'GET' || url.pathname !== '/api/fs/dirs') return false;
  const want = String(url.searchParams.get('path') ?? '').trim();
  /*
   * `files=1` —— 连文件一起列（2026-10-31 加）：私钥路径这种"要选一个文件"的场景
   * （工作台 → 远程连接 → 新建连接）在浏览器里没法用原生文件框（拿不到绝对路径），
   * 只能由服务端列它**自己**的文件系统让用户挑。
   * `hidden=1` —— 连隐藏项一起列（默认不列，免得 `.cache` 之类把列表撑满）：
   * 私钥基本都在 `~/.ssh/` 下，而这个目录本身以点开头。
   */
  const withFiles = url.searchParams.get('files') === '1';
  const withHidden = url.searchParams.get('hidden') === '1';
  const dir = want ? path.resolve(want) : os.homedir();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return fail(res, 400, 'E1028', `读不了这个目录：${e.message}`);
  }
  const keep = (d) => withHidden || !d.name.startsWith('.');
  const dirs = entries
    .filter((d) => d.isDirectory() && keep(d))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // 文件清单只在调用方要的时候给（老调用方不传 files，响应形状一字不变）
  const files = withFiles
    ? entries
        .filter((d) => d.isFile() && keep(d))
        .map((d) => {
          const full = path.join(dir, d.name);
          let size = null;
          try {
            size = fs.statSync(full).size;
          } catch {
            /* 读不到大小就不给，别让一行坏数据挡住整张列表 */
          }
          return { name: d.name, path: full, size };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : undefined;
  const parent = path.dirname(dir);
  return sendJson(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs, ...(files ? { files } : {}) });
}

