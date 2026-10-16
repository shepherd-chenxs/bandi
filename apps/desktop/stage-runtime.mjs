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

/** 平台的技能库与已装插件目录：控制面会从仓库根读它们（缺了不致命，但会"少了东西"） */
for (const d of ['skills', 'plugins']) {
  const src = path.join(repo, d);
  if (fs.existsSync(src)) copyTree(src, path.join(out, d));
}

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
  '  skills, plugins',
  '  LICENSE, NOTICE, node-LICENSE.txt  随包分发的许可文本',
]) {
  console.log(line);
}
