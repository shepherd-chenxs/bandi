/**
 * PATH 之外的 PATH —— 探测 CLI 时去哪儿找（2026-11-04）。
 *
 * 为什么单独一个文件：bandi 的运行时 / 外部组件探测（`runtimes.mjs`、`externals.mjs`）
 * 原来只认 `process.env.PATH` —— 那是**本进程启动那一刻**继承下来的快照。两个真实的坑：
 *   · bandi 先启动、CLI 后装 → 装完注册表 PATH 变了，进程里的快照没变，得重启才认；
 *   · GUI 进程的 PATH 本来就缺 —— fnm / nvm 这类版本管理器是按 shell 会话注入的
 *     （bashrc 里的 `fnm env` 对 Windows GUI 进程毫无作用），全局装的 CLI 它根本看不见。
 * 两种情况的症状一模一样：明明装好了，界面上写「未安装」。
 *
 * 解法：探测时**实时**拼一份候选目录 ——
 *   ① 进程自己的 PATH（现状，排最前，行为不变）；
 *   ② 注册表**此刻**的系统 PATH（HKLM）+ 用户 PATH（HKCU）—— 装完即见，不用重启；
 *   ③ macOS 的 `/etc/paths` + `/etc/paths.d/*`（GUI 启动的进程看不到 login shell 的 PATH）；
 *   ④ 各安装器的**固定落点**（npm / fnm / volta / pnpm / yarn / bun / scoop / cargo /
 *      claude 原生安装器）—— 有些目录压根不在任何 PATH 上，光扫 PATH 永远漏。
 *
 * ⚠️ 三条铁律（跟 runtimes.mjs 探测那套一致）：
 *   · 这里**不做任何 stat 过滤**，只出候选 —— 调用方本来就要 stat，别做两遍；
 *   · `reg query` 是 spawn，所以 `pathDirs()` 带 5 秒记忆化 —— 页面加载 / 按钮点不至于连发；
 *   · 任何读取失败都**静默回退**进程 PATH —— 探测是尽力而为，不能因为注册表读不出来
 *     把整个识别搞挂。
 *
 * **零仓库依赖**：`cli-install.mjs`（"库坏了也能装"）也从这里 import `readUserPath`，
 * 所以这个文件只准用 node 内置模块。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WIN = process.platform === 'win32';

/* ------------------------------------------------------------- 读注册表 */

/** reg.exe 的绝对路径 —— PATH 快照里不一定有 System32（这正是本文件要修的那种场景） */
function regExe() {
  const sys = path.join(
    process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
    'System32',
    'reg.exe',
  );
  try {
    return fs.existsSync(sys) ? sys : 'reg';
  } catch {
    return 'reg';
  }
}

/**
 * 读注册表里某个 `Path` 值（**连类型一起读**：REG_SZ 与 REG_EXPAND_SZ 混了，
 * 别人的 %VAR% 就不展开了 —— 这条教训来自 cli-install.mjs，这里原样继承）。
 */
function readRegPath(key) {
  try {
    const out = execFileSync(regExe(), ['query', key, '/v', 'Path'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const m = /Path\s+(REG_[A-Z_]+)\s+([\s\S]*)/i.exec(out);
    if (!m) return { value: '', type: 'REG_EXPAND_SZ', exists: false };
    return { value: m[2].trim(), type: m[1].toUpperCase(), exists: true };
  } catch {
    return { value: '', type: 'REG_EXPAND_SZ', exists: false };
  }
}

/** 读用户级 PATH（HKCU\Environment）—— cli-install.mjs 也用这份（写回去要保持类型） */
export function readUserPath() {
  return readRegPath('HKCU\\Environment');
}

/** 读系统级 PATH（HKLM，Session Manager\Environment）—— 只有读 */
export function readMachinePath() {
  return readRegPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
}

/**
 * 展开 `%VAR%`：REG_EXPAND_SZ 里躺着的是**原始形态**（`%SystemRoot%\system32`），
 * 得自己展开。认不出的原样留着 —— 让 stat 去如实失败，别瞎编。
 */
export function expandRegValue(value) {
  const env = new Map(Object.entries(process.env).map(([k, v]) => [String(k).toLowerCase(), v]));
  return String(value).replace(/%([^%]+)%/g, (whole, name) => env.get(String(name).toLowerCase()) ?? whole);
}

/* ------------------------------------------------- 拼一份"此刻的 PATH 目录" */

const TTL_MS = 5000;
let memo = null;
let memoAt = 0;

/** 切分一份 PATH 串：去首尾空白和尾部斜杠，丢空段 */
function splitPathList(value, sep) {
  return String(value ?? '')
    .split(sep)
    .map((s) => s.trim().replace(/[\\/]+$/, ''))
    .filter(Boolean);
}

/**
 * 探测用的候选目录：进程 PATH ∪ 注册表此刻的系统/用户 PATH（win）∪
 * /etc/paths + /etc/paths.d/*（macOS）。去重（win32 大小写不敏感）、保序。
 * 5 秒记忆化 —— reg query 是 spawn，按钮连点和页面加载别真的连发。
 */
export function pathDirs() {
  if (memo && Date.now() - memoAt < TTL_MS) return memo;
  const out = [];
  const seen = new Set();
  const push = (dir) => {
    const key = WIN ? dir.toLowerCase() : dir;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dir);
  };
  // ① 进程 PATH —— 现状排最前，原行为一字不变
  for (const d of splitPathList(process.env.PATH, path.delimiter)) push(d);
  if (WIN) {
    // ② 注册表**此刻**的系统 / 用户 PATH —— "装完就识别、不用重启 bandi"靠的就是这条
    for (const read of [readMachinePath, readUserPath]) {
      try {
        const cur = read();
        if (!cur.exists) continue;
        for (const d of splitPathList(expandRegValue(cur.value), ';')) push(d);
      } catch { /* 读不出来就算了 —— 回退到进程 PATH，识别照常做 */ }
    }
  } else if (process.platform === 'darwin') {
    // ③ macOS：双击 / Finder 起的进程没有 login shell 的 PATH —— 这两个文件是权威
    try {
      for (const d of splitPathList(fs.readFileSync('/etc/paths', 'utf8'), '\n')) push(d);
      for (const f of fs.existsSync('/etc/paths.d') ? fs.readdirSync('/etc/paths.d') : []) {
        try {
          for (const d of splitPathList(fs.readFileSync(path.join('/etc/paths.d', f), 'utf8'), '\n')) push(d);
        } catch { /* 单个文件读不了不影响别的 */ }
      }
    } catch { /* 没有 /etc/paths 的怪系统就算了 */ }
  }
  memo = out;
  memoAt = Date.now();
  return out;
}

/* ------------------------------------- 安装器的固定落点 —— 不在 PATH 上也得认 */

/**
 * 有些全局 CLI 的家**压根不在任何 PATH 上**：fnm 的 `aliases\default` 是个 junction，
 * 只有跑过 `fnm env` 的那个 shell 会话看得见；claude 原生安装器默默放 `~/.local/bin`。
 * 把已知落点列全 —— 不预过滤存在性，调用方（findOnPath / npmPrefixes）本来就要 stat。
 */
export function wellKnownBins() {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  return WIN
    ? [
        path.join(appData, 'npm'), // npm 在 Windows 的全局 bin（claude.cmd / codex.cmd 都在这）
        path.join(appData, 'fnm', 'aliases', 'default'), // fnm 的 default 别名 —— 稳定 junction，跟默认 Node 版本走
        path.join(localAppData, 'Volta', 'bin'), // Volta 的 shim 目录
        path.join(localAppData, 'pnpm'), // pnpm 全局 bin
        path.join(appData, 'Yarn', 'bin'), // yarn 全局
        path.join(home, '.bun', 'bin'), // bun
        path.join(home, 'scoop', 'shims'), // scoop
        path.join(home, '.cargo', 'bin'), // cargo（codex 也有人这么装）
        path.join(home, '.local', 'bin'), // claude 原生安装器的落点
      ]
    : [
        path.join(home, '.local', 'bin'),
        /*
         * 用户态 Node 的 npm 全局 bin（deploy/README.md「B：用户态装法」的标准落点）。
         * 2026-11-04 补：thinkpad 实测漏了这条 —— claude 装在 `~/.local/node`，
         * 包在 `~/.local/node/lib/node_modules`，但 systemd 的 PATH 不带
         * `~/.local/node/bin`，这里又不认它，探测一个候选都落不进去。
         * 加上之后 npmPrefixes 的形态二（`<bin>/../lib/node_modules`）就能接住。
         */
        path.join(home, '.local', 'node', 'bin'),
        path.join(home, '.cargo', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        '/opt/homebrew/bin', // Apple Silicon 的 brew
        '/usr/local/bin',
      ];
}
