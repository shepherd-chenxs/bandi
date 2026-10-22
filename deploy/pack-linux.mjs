#!/usr/bin/env node
/**
 * 打 Linux 离线安装包（2026-10-22）。
 *
 *   node deploy/pack-linux.mjs [--node 22.22.2] [--out dist]
 *
 * 产物：dist/bandi-linux-x64-v<版本>.tar.gz，解压后 `sudo sh install.sh` 一条命令装好。
 * 包内容（服务端运行时的**完整**依赖面，见各处 repoRoot 引用）：
 *   bandi/node                    随包的 Linux node 二进制（install-cli 认 repoRoot/node）
 *   bandi/apps/server/src         服务端（剔除 smoke-* / fixtures —— 只是测试用）
 *   bandi/apps/web                前端静态文件（webDir）
 *   bandi/apps/server/catalog     连接器目录（catalogRoot）
 *   bandi/skills                  技能（skillsRoot）
 *   bandi/plugins                 插件（pluginsRoot）
 *   bandi/deploy                  systemd 模板 / 用户态脚本 / README
 *   bandi/version.json            版本号（local-mode 在安装根找它，与 NSIS 同一约定）
 *   bandi/install.sh              安装脚本
 *
 * 随包 node 下载：nodejs.org 优先，npmmirror 兜底（国内网络友好）；下载一次进 tmp 缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const arg = (k, dflt) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const version = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'desktop', 'version.json'), 'utf8')).version;
const nodeVer = String(arg('node', process.version.replace(/^v/, ''))).replace(/^v/, '');
const outDir = path.resolve(root, arg('out', 'dist'));
const stage = path.resolve(root, 'tmp', 'pack-linux');

const say = (s) => console.log(s);
const die = (s) => {
  console.error(`✗ ${s}`);
  process.exit(1);
};

say(`班底 v${version} · node v${nodeVer} · 产物 ${outDir}`);

/* ------------------------------------------------------------- 随包 node */

const cache = path.join(stage, `node-v${nodeVer}-linux-x64.tar.gz`);
if (!fs.existsSync(cache)) {
  const urls = [
    `https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-linux-x64.tar.gz`,
    `https://registry.npmmirror.com/-/binary/node/v${nodeVer}/node-v${nodeVer}-linux-x64.tar.gz`,
  ];
  fs.mkdirSync(stage, { recursive: true });
  let ok = false;
  for (const url of urls) {
    try {
      say(`下载随包 node：${url}`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(cache, Buffer.from(await r.arrayBuffer()));
      ok = true;
      break;
    } catch (e) {
      say(`  失败（${e.message ?? e}），换下一个源`);
    }
  }
  if (!ok) die(`node v${nodeVer} 下载失败 —— 检查网络，或手动把 node-v${nodeVer}-linux-x64.tar.gz 放到 ${cache}`);
} else {
  say(`随包 node 用缓存：${cache}`);
}

/* ----------------------------------------------------------- 摆暂存目录 */

const pkg = path.join(stage, 'bandi');
fs.rmSync(pkg, { recursive: true, force: true });
fs.mkdirSync(path.join(pkg, 'apps', 'server'), { recursive: true });

// 整目录拷（服务端运行时依赖面）
for (const dir of ['apps/web', 'apps/server/catalog', 'skills', 'plugins', 'deploy']) {
  const src = path.join(root, dir);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(pkg, dir), { recursive: true });
}

// 服务端源码：剔除测试件（smoke-* 只在开发机上跑）
fs.cpSync(path.join(root, 'apps/server/src'), path.join(pkg, 'apps/server/src'), {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    if (base === 'fixtures') return false;
    if (/^smoke-.*\.mjs$/.test(base)) return false;
    return true;
  },
});

// 版本号放安装根（local-mode 在 repoRoot/version.json 找它）
fs.writeFileSync(path.join(pkg, 'version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
// 安装脚本放包根（解压即见：cd bandi && sudo sh install.sh）
fs.copyFileSync(path.join(root, 'deploy', 'install.sh'), path.join(pkg, 'install.sh'));

// 随包 node：从缓存的 tar.gz 里抽 bin/node 单文件（`bandi/node`，install-cli 认这个位置）
// ⚠️ tar 一律用 **cwd + 相对路径** 调：GNU tar 把 `e:\...` 的盘符冒号当成"远程主机"语法
//    （实报 "Cannot connect to e: resolve failed"），相对路径里没有冒号，天然绕开。
const nodeExtract = path.join(stage, `node-v${nodeVer}-linux-x64`);
fs.rmSync(nodeExtract, { recursive: true, force: true });
fs.mkdirSync(nodeExtract, { recursive: true });
execFileSync('tar', ['-xzf', path.basename(cache), '-C', path.basename(nodeExtract), `node-v${nodeVer}-linux-x64/bin/node`], { cwd: stage });
fs.copyFileSync(path.join(nodeExtract, 'node-v' + nodeVer + '-linux-x64', 'bin', 'node'), path.join(pkg, 'node'));
fs.rmSync(nodeExtract, { recursive: true, force: true });

/* ---------------------------------------------------------------- 打 tar */

fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `bandi-linux-x64-v${version}.tar.gz`);
fs.rmSync(out, { force: true });
// ⚠️ -C stage bandi：包根是 bandi/，解压即得 bandi/install.sh —— 安装脚本依赖这个布局
const outRel = path.relative(stage, out).split(path.sep).join('/');
execFileSync('tar', ['-czf', outRel, 'bandi'], { cwd: stage });

const size = fs.statSync(out).size;
const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
say('');
say(`✓ ${out}`);
say(`  ${(size / 1048576).toFixed(1)} MB · sha256 ${sha.slice(0, 16)}…`);
say('  服务器上：tar xzf bandi-linux-x64-*.tar.gz && cd bandi && sudo sh install.sh');
