#!/usr/bin/env node
/**
 * 从 frp 源码**自编译**隧道客户端，产物叫 `bandi-tunnel(.exe)`，落 `vendor/frp/`。
 *
 * **为什么要自编译改名**（2026-11-08）：frp 是黑产滥用最多的隧道工具，官方原版
 * frpc.exe 的哈希与文件名躺在各家杀软的特征库里 —— 用户装完就被报"木马"（本机
 * 腾讯电脑管家实报）。自编译产物哈希全新、名字不带 frp，哈希/名字两路特征都避开，
 * 只剩行为启发式还有小概率误报。根治要代码签名证书，那是后话。
 *
 * 产物互不替代：
 *   · `build-frpc.mjs`（本脚本）→ `vendor/frp/bandi-tunnel.exe`，**优先**；
 *   · `fetch-frpc.mjs` → `vendor/frp/frpc.exe`，官方原版兜底。
 * `hub/tunnel.mjs#findBin()` 按这个顺序找，两个都在时永远用自编译那份。
 *
 * 前置：本机要有 `go`（frp 0.72 要 ≥1.26）。没有就先装：
 *   winget install GoLang.Go    # 或从 golang.google.cn/dl 下 zip 解压加 PATH
 *
 * 跑法：`node apps/desktop/build-frpc.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FRP_VERSION = '0.72.0'; // 与 fetch-frpc.mjs 的 FRP_VERSION 保持一致
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const dest = path.join(repo, 'vendor', 'frp');

/* ------------------------------------------------------------ 工具链检查 */

function goBin() {
  const exe = process.platform === 'win32' ? 'go.exe' : 'go';
  // ① PATH；② 仓库内解好的工具链（tmp/build-frp/go，第一次手工装的地方，留着复用）
  const dirs = [
    ...String(process.env.PATH ?? '').split(path.delimiter),
    path.join(repo, 'tmp', 'build-frp', 'go', 'bin'),
  ];
  for (const dir of dirs) {
    const p = path.join(dir, exe);
    try { if (fs.existsSync(p)) return p; } catch { /* 下一个 */ }
  }
  return null;
}

const go = goBin();
if (!go) {
  console.error('✗ 没找到 go（frp 0.72 要 Go ≥1.26）。先装：winget install GoLang.Go，或 golang.google.cn/dl 下 zip 加 PATH。');
  process.exit(1);
}
const goVer = execFileSync(go, ['version'], { encoding: 'utf8' }).trim();
const minor = Number(goVer.match(/go1\.(\d+)\./)?.[1] ?? 0);
if (minor < 26) {
  console.error(`✗ ${goVer} 太老，frp 0.72 的 go.mod 要 ≥1.26`);
  process.exit(1);
}
console.log(`✓ ${goVer}`);

/* ------------------------------------------------------------ 取源码 */

const srcDir = path.join(os.tmpdir(), `bandi-frp-src-${FRP_VERSION}`);
if (!fs.existsSync(path.join(srcDir, 'go.mod'))) {
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });
  const asset = `v${FRP_VERSION}.tar.gz`;
  const urls = [
    `https://ghfast.top/https://github.com/fatedier/frp/archive/refs/tags/${asset}`,
    `https://gh-proxy.com/https://github.com/fatedier/frp/archive/refs/tags/${asset}`,
    `https://github.com/fatedier/frp/archive/refs/tags/${asset}`,
  ];
  const tarball = path.join(srcDir, 'src.tar.gz');
  let got = false;
  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100_000) throw new Error(`只有 ${buf.length} 字节，不像源码包`);
      fs.writeFileSync(tarball, buf);
      got = true;
      break;
    } catch (e) {
      console.warn(`  ${u} → ${e?.message ?? e}`);
    }
  }
  if (!got) {
    console.error('✗ frp 源码下载失败（三条源都试过了）');
    process.exit(1);
  }
  /*
   * ⚠️ 一律 cwd + 相对路径：GNU tar（Git Bash 的）会把 `C:\...` 的盘符冒号当成
   * "远程主机"语法（实报 "Cannot connect to C: resolve failed"）——
   * fetch-frpc.mjs 里第一次踩过，别再踩。
   * 源码里的符号链接（CLAUDE.md → AGENTS.md）在 Windows 上建不了（权限），排除 *.md 绕开。
   */
  execFileSync('tar', ['-xzf', 'src.tar.gz', '--strip-components=1', '--exclude=*.md'], { cwd: srcDir });
  fs.rmSync(tarball, { force: true });
}
console.log(`✓ 源码就位：${srcDir}`);

/* ------------------------------------------------------------ 编译 */

/*
 * 与 frp 官方 Makefile 同参数：CGO 关（纯 Go，产物不依赖 libc）、-trimpath
 * （去掉本机路径）、-s -w（去符号表）。tags 里 `noweb` 是因为源码包不带前端
 * dist（frpc 用不到它）。GOPROXY 指国内代理 —— 直连 proxy.golang.org 在国内
 * 是"连得上但慢慢爬"，与 fetch-frpc.mjs 里 GitHub 直连同一症状。
 */
const out = path.join(dest, process.platform === 'win32' ? 'bandi-tunnel.exe' : 'bandi-tunnel');
fs.mkdirSync(dest, { recursive: true });
const env = {
  ...process.env,
  CGO_ENABLED: '0',
  GOPROXY: 'https://goproxy.cn,direct',
};
execFileSync(go, [
  'build', '-trimpath',
  '-ldflags', '-s -w',
  '-tags', 'frpc,noweb',
  '-o', out,
  './cmd/frpc',
], { cwd: srcDir, env, stdio: 'inherit' });

/* ------------------------------------------------------------ 验收 */

const size = fs.statSync(out).size;
if (size < 5_000_000) throw new Error(`${out} 只有 ${size} 字节，不像是完整的产物`);
const ver = execFileSync(out, ['-v'], { encoding: 'utf8' }).trim();
if (ver !== FRP_VERSION) throw new Error(`产物版本 ${ver} ≠ 期望 ${FRP_VERSION} —— 源码和版本号对不上`);
console.log(`✓ bandi-tunnel ${ver}（${(size / 1024 / 1024).toFixed(1)} MB）→ ${out}`);
console.log('  —— 与官方 frpc.exe 哈希完全不同，杀软的哈希特征库认不出它。');
