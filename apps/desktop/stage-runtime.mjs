#!/usr/bin/env node
/**
 * 把**运行时**摊到 `apps/desktop/runtime/` 下 —— 安装包要带上它，否则装出来的只有一张错误页。
 *
 * 为什么需要这一步：`bundle.resources` 的源路径必须落在 `apps/desktop/` 里（不能往外跳），
 * 而运行时散在 `apps/server/`、`apps/web/`、`apps/desktop/shell.mjs`。
 * 所以先在 `runtime/` 里拼一份**与仓库同构**的迷你树：
 *
 *     runtime/apps/desktop/shell.mjs
 *     runtime/apps/server/**            ← 控制面
 *     runtime/apps/web/**               ← 界面
 *     runtime/skills/**  runtime/plugins/**
 *
 * 再让资源映射 `"runtime/apps" → "apps"` 把它装到安装目录的 `apps/` 下。
 * 于是**安装后的目录形状与仓库一模一样**，`find_root()` 与 `shell.mjs` 里那些
 * 相对 import / 相对路径**一行都不用改** —— 少一处"安装版特供逻辑"，就少一处只有装完才暴露的坑。
 *
 * 跑法：`node apps/desktop/stage-runtime.mjs`（`fetch-node.mjs` 之后、`tauri build` 之前）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const out = path.join(here, 'runtime');

/** 不进安装包的东西：测试用例、开发产物。**别偷懒用整目录拷**，那样会把 target 也卷进来。 */
const EXCLUDE_FILE = [/^smoke-.*\.mjs$/];
const EXCLUDE_DIR = new Set(['node_modules', 'target', 'binaries', '.git']);

let files = 0;
let bytes = 0;

function copyTree(src, dst, { filter } = {}) {
  const st = fs.statSync(src);
  if (st.isFile()) {
    if (EXCLUDE_FILE.some((re) => re.test(path.basename(src)))) return;
    if (filter && !filter(src)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    files += 1;
    bytes += st.size;
    return;
  }
  if (EXCLUDE_DIR.has(path.basename(src))) return;
  for (const name of fs.readdirSync(src)) {
    copyTree(path.join(src, name), path.join(dst, name), { filter });
  }
}

fs.rmSync(out, { recursive: true, force: true });

/** apps 下只要这三块：壳的 Node 半、控制面、前端。desktop 的 Rust 源码/Cargo 一律不要。 */
copyTree(path.join(repo, 'apps', 'server'), path.join(out, 'apps', 'server'));
copyTree(path.join(repo, 'apps', 'web'), path.join(out, 'apps', 'web'));
fs.mkdirSync(path.join(out, 'apps', 'desktop'), { recursive: true });
copyTree(path.join(here, 'shell.mjs'), path.join(out, 'apps', 'desktop', 'shell.mjs'));

/*
 * 第三方运行时依赖（2026-11-20）：控制面 `import DatabaseSync from 'better-sqlite3'`，
 * 安装包里必须带它和它的两个运行时依赖，否则装出来的软件一启动就
 * `Cannot find package 'better-sqlite3'` —— 开发机上因为仓库根有 node_modules，
 * 这个缺口一直没暴露。落点 `apps/node_modules/`：安装后目录与仓库同构，
 * Node 从 `apps/server/src/store/db.mjs` 往上找正好命中。
 *
 * 只拷运行时用得着的：`deps/`（SQLite C 源码，9.5 MB）和 `src/`（C++ 源码）不进包，
 * 真正要的只有 `lib/` + `build/Release/*.node`；`prebuild-install` 只在 npm install
 * 时用，也不进包。
 *
 * ⚠️ `.node` 是原生模块，ABI 跟着 Node 版本走：必须用 `fetch-node.mjs` 取的 22.x
 * 装 / `npm rebuild better-sqlite3` 过，版本错位就是 NODE_MODULE_VERSION 不匹配。
 * 这里只验文件在不在，ABI 由构建环境保证。
 */
const RUNTIME_PACKAGES = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
const runtimeNm = path.join(out, 'apps', 'node_modules');
/** 编译期才用得到的物料：SQLite/C++ 源码与构建脚本，装到用户机器上纯属占地方。 */
const buildOnly = (p) => /[\\/](deps|src)[\\/]/.test(p) || /[\\/]binding\.gyp$/.test(p);
for (const pkg of RUNTIME_PACKAGES) {
  const from = path.join(repo, 'node_modules', pkg);
  if (!fs.existsSync(from)) {
    console.error(`缺 ${from}\n  —— 先「npm ci」再跑本脚本（第三方运行时依赖要跟着进包）。`);
    process.exit(1);
  }
  copyTree(from, path.join(runtimeNm, pkg), { filter: (f) => !buildOnly(f) });
}
const addon = path.join(runtimeNm, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(addon)) {
  console.error(`缺 ${addon}\n  —— better-sqlite3 的原生模块没编出来：npm rebuild better-sqlite3 后重跑。`);
  process.exit(1);
}

/**
 * 第三方许可文本（2026-11-20）：better-sqlite3 与它的运行时依赖都是 MIT，
 * 随包分发就得带版权与许可声明（MIT 的硬要求）。三份原文摊进 `runtime/third-party/`，
 * 由 `bundle.resources` 映射到安装目录的 `third-party/`，NOTICE 里点名它们在哪。
 */
const THIRD_PARTY = [
  ['better-sqlite3', 'better-sqlite3-LICENSE.txt'],
  ['bindings', 'bindings-LICENSE.md'],
  ['file-uri-to-path', 'file-uri-to-path-LICENSE.txt'],
];
fs.mkdirSync(path.join(out, 'third-party'), { recursive: true });
for (const [pkg, name] of THIRD_PARTY) {
  const lic = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
    .map((n) => path.join(repo, 'node_modules', pkg, n))
    .find((p) => fs.existsSync(p));
  if (!lic) {
    console.error(`缺 ${pkg} 的 LICENSE（node_modules/${pkg}/）—— 许可文本必须随包，缺了直接失败。`);
    process.exit(1);
  }
  fs.copyFileSync(lic, path.join(out, 'third-party', name));
  files += 1;
  bytes += fs.statSync(path.join(out, 'third-party', name)).size;
}

/**
 * 平台的技能库与已装插件目录：控制面会从仓库根读它们（缺了不致命，但会"少了东西"）。
 * plugins 目录**必须落一个空壳**：tauri.conf.json 把 runtime/plugins 列为必打资源，
 * 全新 clone 没装过插件时根目录没有 plugins/，缺了这个目录 tauri build 直接失败
 * （2026-11-24 实测：`resource path 'runtime\plugins' doesn't exist`）。
 */
for (const d of ['skills', 'plugins']) {
  const src = path.join(repo, d);
  if (fs.existsSync(src)) copyTree(src, path.join(out, d));
  else fs.mkdirSync(path.join(out, d), { recursive: true });
}

/**
 * 外网隧道客户端（frpc）**不再随包分发**（2026-11-08 用户决定：需要时另外装，不内置）。
 *
 * 原来的做法是把 vendor/frp 拷进安装目录的 vendor/，控制面再 spawn 它。现在班底
 * 一行隧道进程管理都没有了 —— 装出来的版本不会带任何隧道二进制，也不会去 PATH 里找。
 * 要外网访问，自己装一套 frp 指向本机控制面端口即可（域名写进 <数据目录>/tunnel.json
 * 让 Host/Origin 闸认它）。
 */

/**
 * 随包分发的许可文本 —— **这三份一个都不能少**，它们在 `tauri.conf.json` 的
 * `bundle.resources` 里各有映射，装完落在安装目录根上。
 *
 *   · `LICENSE`           自己的（Apache-2.0 第 4 条：给用户一份许可副本）
 *   · `NOTICE`            自己的署名与第三方说明（同条 d 款：保留 NOTICE）
 *   · `node-LICENSE.txt`  Node 的（安装包把 node.exe 一起分发，就必须带它的许可声明）
 *
 * 少了前两个是许可缺口，少了第三个是**再分发 Node 而不带声明**。所以这里缺文件直接失败，
 * 不做"少一个也能装"的兜底 —— 那种兜底正是缺口被漏过去的方式。
 */
for (const [src, dst] of [
  [path.join(repo, 'LICENSE'), path.join(out, 'LICENSE')],
  [path.join(repo, 'NOTICE'), path.join(out, 'NOTICE')],
  [path.join(here, 'binaries', 'node-LICENSE.txt'), path.join(out, 'node-LICENSE.txt')],
]) {
  if (!fs.existsSync(src)) {
    console.error(`缺 ${src}\n  —— LICENSE / NOTICE 必须在仓库根；node-LICENSE.txt 由 fetch-node.mjs 取。先跑它再跑本脚本。`);
    process.exit(1);
  }
  fs.copyFileSync(src, dst);
  files += 1;
  bytes += fs.statSync(dst).size;
}

console.log(`✓ 摊好 runtime/：${files} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);
for (const line of [
  '  apps/server    控制面',
  '  apps/web       界面',
  '  apps/desktop/shell.mjs  壳的 Node 半',
  '  apps/node_modules  better-sqlite3 + bindings + file-uri-to-path',
  '  skills, plugins',
  '  LICENSE, NOTICE, node-LICENSE.txt  随包分发的许可文本',
  '  third-party/   better-sqlite3 等三份 MIT 许可原文',
]) {
  console.log(line);
}
