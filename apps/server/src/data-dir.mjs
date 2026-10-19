/**
 * 本机**用户数据目录** —— 命令行与桌面壳共用的唯一默认（2026-10-18 起）。
 *
 * 为什么单独一个文件：这个路径以前有两份实现 —— `config.mjs`（命令行/服务端，默认
 * `<仓库>/data`）和 `shell.mjs`（桌面壳，默认用户目录）—— 于是同一台机器上"命令行连仓库
 * 空库、桌面壳连用户目录"，看错库是常事。现在只留这一份，谁要默认谁来 import。
 *
 * 只回答"用户数据该在哪儿"：不创建目录、不读 `BANDI_DATA`（那是调用方的判断）。
 * 放 `<仓库>/data` 的后果见 `config.mjs` 顶部注释（安装目录不可写/升级被覆盖）。
 */
import os from 'node:os';
import path from 'node:path';

export function userDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'bandi');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'bandi');
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'bandi');
}
