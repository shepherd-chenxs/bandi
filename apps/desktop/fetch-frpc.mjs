#!/usr/bin/env node
/**
 * 把 `frpc` 取到 `vendor/frp/` —— 外网访问（中枢转发）要它，缺了只是这台机器"外面连不进来"。
 *
 * **2026-11-08 起，本脚本降级为兜底**：优先用 `build-frpc.mjs` 自编译的
 * `bandi-tunnel(.exe)`（哈希全新，杀软认不出）；官方原版 frpc 的哈希在杀软特征库里，
 * 装了就报"木马"（本机腾讯电脑管家实报）。`hub/tunnel.mjs#findBin()` 两个名字都认，
 * bandi-tunnel 在前。
 *
 * 为什么需要这一步：`hub/tunnel.mjs` 的 `findBin()` 只认三处 —— `BANDI_FRPC` 环境变量、
 * `<repoRoot>/vendor/frp/frpc`、PATH。用户机器上没有 frp 也不会装，只能随包带。
 *
 * 为什么落在 `vendor/` 而不是 `binaries/`：`findBin()` 用 **repoRoot** 推相对路径。
 * 开发时 repoRoot 是仓库根，装完是安装目录（`runtime/vendor` 被映射成 `vendor/`）——
 * 两处同一个相对位置，于是"开发能跑 / 装完不能跑"这类只有装完才暴露的坑不会出现。
 *
 * 跑法（打包前）：
 *   node apps/desktop/fetch-frpc.mjs                  # 取宿主平台那份，放 vendor/frp/
 *   node apps/desktop/fetch-frpc.mjs --target linux-x64 --out <目录>
 * 也可以 `import { fetchFrpc }` 在别的打包脚本里调（deploy/pack-linux.mjs 就是这么用的：
 * 那台机器打包在 Windows 上跑，要打的是 **linux** 的 frpc）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** frp 版本。**升降版本只改这一行** —— 资产名、下载地址、License 路径都从这里推。 */
export const FRP_VERSION = '0.72.0';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

/** 平台 → frp 资产名里的那段（`<os>_<arch>`）；不认识的组合直接报错，别猜一个装上去 */
const TARGETS = {
  'win32-x64': 'windows_amd64',
  'win32-arm64': 'windows_arm64',
  'linux-x64': 'linux_amd64',
  'linux-arm64': 'linux_arm64',
  'darwin-x64': 'darwin_amd64',
  'darwin-arm64': 'darwin_arm64',
};

/** 宿主平台怎么叫（`--target` 不传时用它） */
export function hostTarget() {
  const t = `${process.platform}-${process.arch}`;
  if (!TARGETS[t]) throw new Error(`没有给 ${t} 准备的 frpc（支持的：${Object.keys(TARGETS).join(', ')}）`);
  return t;
}

/**
 * 下载并摊开 frpc。
 *
 * @param {{ target?: string, outDir?: string, quiet?: boolean }} [opts]
 * @returns {Promise<{ bin: string, version: string, outDir: string }>}
 */
export async function fetchFrpc({ target = hostTarget(), outDir, quiet = false } = {}) {
  const slug = TARGETS[target];
  if (!slug) throw new Error(`不支持的 target：${target}（支持的：${Object.keys(TARGETS).join(', ')}）`);
  const dest = path.resolve(outDir ?? path.join(repo, 'vendor', 'frp'));
  const isWin = target.startsWith('win32');
  const exeName = isWin ? 'frpc.exe' : 'frpc';
  const binPath = path.join(dest, exeName);

  fs.mkdirSync(dest, { recursive: true });

  const versionFile = path.join(dest, '.frp-version');
  const stamped = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  if (fs.existsSync(binPath) && stamped === `${FRP_VERSION}/${slug}`) {
    if (!quiet) console.log(`frpc 已就位（v${FRP_VERSION} ${slug}）：${binPath}`);
    return { bin: binPath, version: FRP_VERSION, outDir: dest };
  }

  const ext = isWin ? 'zip' : 'tar.gz';
  const asset = `frp_${FRP_VERSION}_${slug}.${ext}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-frpc-'));
  try {
    const archive = path.join(tmp, asset);
    await download(asset, archive);

    /*
     * 解包：tar.gz 用系统 tar；zip（Windows 版的资产）**不能用 tar** ——
     * Git Bash 里的 `tar` 是 GNU tar，不认 zip（实报 "This does not look like a tar archive"），
     * 所以先走 unzip，没有就借 PowerShell 的 Expand-Archive。
     * ⚠️ 一律 cwd + 相对路径：GNU tar 会把 `e:\...` 的盘符冒号当成"远程主机"语法。
     */
    const dirName = `frp_${FRP_VERSION}_${slug}`;
    extract(asset, dirName, tmp);
    /*
     * 别按固定路径取（`<dirName>/frpc`）：zip 里本来就有一层同名目录，`unzip -d dirName`
     * 会解成 `dirName/dirName/frpc.exe`，而 tar 解成 `dirName/frpc`。递归找一次，
     * 两种打包方式都对得上。
     */
    const srcBin = findFile(path.join(tmp, dirName), exeName);
    if (!srcBin) throw new Error(`包解开后没找到 ${exeName}（${asset} 的结构变了？）`);

    fs.rmSync(binPath, { force: true }); // Windows 上覆盖正在运行的 exe 会 EBUSY，先删
    fs.copyFileSync(srcBin, binPath);
    if (!isWin) fs.chmodSync(binPath, 0o755);
    /*
     * 拷完立刻核对一次体积：Windows 上杀毒软件对新出现的"隧道类 exe"有实时扫描，
     * 真有被直接隔离掉的情况 —— 那种失败如果拖到后面 exec，报的会是 ENOENT，
     * 看起来像"路径写错了"，实际是文件已经不在了。
     */
    const copied = fs.statSync(binPath).size;
    if (copied < 1_000_000) throw new Error(`${binPath} 只有 ${copied} 字节，不像是完整的 frpc（被杀毒软件拦了？）`);

    /*
     * License 随二进制一起发（Apache-2.0 第 4 条：再分发必须带许可副本）。
     * 放在 frpc 旁边、和 frpc 一起进安装包的 `vendor/frp/`，不占安装根的位置。
     */
    const license = path.join(dest, 'frp-LICENSE.txt');
    if (!fs.existsSync(license)) {
      try {
        const r = await fetchWithFallback([
          `https://raw.githubusercontent.com/fatedier/frp/v${FRP_VERSION}/LICENSE`,
        ]);
        if (r) fs.writeFileSync(license, r);
      } catch {
        console.warn('⚠️ frp 的 LICENSE 没取到 —— 再分发前必须补上（Apache-2.0 §4）');
      }
    }

    fs.writeFileSync(versionFile, `${FRP_VERSION}/${slug}\n`);

    // 只有宿主平台那份能跑；交叉取（打 Linux 包时取 linux 版）不验，免得报假错
    if (target === hostTarget()) {
      const out = execFileSync(binPath, ['-v'], { encoding: 'utf8' }).trim();
      if (!quiet) console.log(`✓ frpc ${out}（${slug}）→ ${binPath}`);
    } else if (!quiet) {
      console.log(`✓ frpc v${FRP_VERSION}（${slug}）→ ${binPath}`);
    }
    return { bin: binPath, version: FRP_VERSION, outDir: dest };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 在解开的目录里递归找某个文件名（深度很浅，就不写迭代了） */
function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

/**
 * 解包。zip（Windows 版资产）**不能交给 tar** —— Git Bash 里的 `tar` 是 GNU tar，
 * 不认 zip（实报 "This does not look like a tar archive"）。所以：
 *   .tar.gz → 系统 tar；.zip → unzip，没有就借 PowerShell 的 Expand-Archive。
 * ⚠️ 一律 cwd + 相对路径：GNU tar 会把 `e:\...` 的盘符冒号当成"远程主机"语法。
 */
function extract(archive, dirName, cwd) {
  if (archive.endsWith('.zip')) {
    try {
      execFileSync('unzip', ['-qq', '-o', archive, '-d', dirName], { cwd });
      return;
    } catch {
      if (process.platform !== 'win32') throw new Error(`解压 ${archive} 失败（需要 unzip）`);
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${dirName}'`,
      ], { cwd });
      return;
    }
  }
  execFileSync('tar', ['-xzf', archive, '-C', dirName], { cwd });
}

/**
 * 官方地址 + 两个常用镜像。
 *
 * **镜像优先**（2026-11-08 实测）：国内直连 github release 不是"连不上"，而是"连上了慢慢爬"
 * —— 40 秒只走 635 KB，14 MB 的包要十几分钟，肉眼看就是卡住；同一个包走 ghfast 36 秒。
 * 所以顺序是 镜像 → 镜像 → 官方，官方那条给足 120 秒（海外网络下它反而最快）。
 */
async function download(asset, to) {
  const urls = [
    `https://ghfast.top/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${asset}`,
    `https://gh-proxy.com/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${asset}`,
    `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${asset}`,
  ];
  const errs = [];
  for (const u of urls) {
    try {
      /*
       * 逐个地址设超时：不带超时的话，慢到"看起来卡住"的那条会一直挂着不换下一条。
       * 官方那条放宽到 120 秒 —— 跨境带宽差的时候，它是能到、只是慢。
       */
      const ms = u.includes('github.com/fatedier') ? 120_000 : 90_000;
      const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      // 200KB 以下基本是错误页 / 重定向壳，不是真包（frp 资产都是几 MB）
      if (buf.length < 200_000) throw new Error(`只有 ${buf.length} 字节，不像安装包`);
      fs.writeFileSync(to, buf);
      return;
    } catch (e) {
      errs.push(`${u} → ${e?.message ?? e}`);
    }
  }
  throw new Error(`frpc 下载失败：\n  ${errs.join('\n  ')}`);
}

async function fetchWithFallback(urls) {
  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (r.ok) return await r.text();
    } catch { /* 下一个 */ }
  }
  return null;
}

/* 直接跑才执行下载；被 import（pack-linux）时只导出函数 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const pick = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    await fetchFrpc({ target: pick('--target'), outDir: pick('--out') });
  } catch (e) {
    console.error(`✗ ${e?.message ?? e}`);
    process.exit(1);
  }
}
