#!/usr/bin/env node
/**
 * 取一份 Node 运行时放进 `apps/desktop/binaries/` —— 桌面安装包要**自带** Node。
 *
 * 为什么必须自带：`v1.0.0` 的 B2「不许要求用户自装运行时」。终端用户机器上不该有、
 * 也不该被要求装 Node；装完即用是这个产品的底线。
 *
 * 为什么不进版本控制：`node.exe` 有 **80 MB**，塞进 git 会把仓库撑坏（也会把 clone 拖死）。
 * 所以"怎么拿到它"只有一个入口 —— 这个脚本；**打包前跑一次**即可。
 *
 * 跑法：
 *   node apps/desktop/fetch-node.mjs            # 用脚本里的默认版本
 *   node apps/desktop/fetch-node.mjs 22.21.0    # 指定版本
 *
 * 下载源：先 npmmirror（国内快、实测可达），失败再回官方 nodejs.org。
 * 解压只取 `node.exe` 一个成员 —— 整包解开要 150 MB 且多半用不上。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 与开发机保持一致，省得"开发能跑、用户机上不行"这种最难查的问题 */
const DEFAULT_VERSION = '22.21.0';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, 'binaries');

/** 目标平台。Windows x64 是首发（B6）；其它平台加一行就行 */
const TARGETS = {
  'win-x64': { slug: 'win-x64', ext: 'zip', member: 'node.exe', out: 'node.exe' },
  'linux-x64': { slug: 'linux-x64', ext: 'tar.gz', member: 'bin/node', out: 'node' },
  'darwin-arm64': { slug: 'darwin-arm64', ext: 'tar.gz', member: 'bin/node', out: 'node' },
};

const key = process.env.BANDI_NODE_TARGET || (process.platform === 'win32' ? 'win-x64' : null);
const target = key ? TARGETS[key] : null;
if (!target) {
  console.error(`没有为 ${process.platform}/${process.arch} 配目标。显式指定：BANDI_NODE_TARGET=win-x64`);
  process.exit(2);
}

const version = process.argv[2] || process.env.BANDI_NODE_VERSION || DEFAULT_VERSION;
const base = `node-v${version}-${target.slug}`;
const archive = `${base}.${target.ext}`;
/** 两个下载源：先 npmmirror（国内快），失败再回官方。 */
const sources = [
  `https://npmmirror.com/mirrors/node/v${version}`,
  `https://nodejs.org/dist/v${version}`,
];
/** 摘要清单的回退位置 —— 镜像上那份取不到时回官方取。 */
const SHASUMS_FALLBACK = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;

const outFile = path.join(OUT_DIR, target.out);
fs.mkdirSync(OUT_DIR, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-node-'));
const local = path.join(tmp, archive);

try {
  let got = false;
  let source = null;
  for (const base of sources) {
    const url = `${base}/${archive}`;
    console.log(`下载 ${url}`);
    const r = spawnSync('curl', ['-fSL', '-m', '600', '--retry', '2', '-o', local, url], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (r.status === 0 && fs.existsSync(local) && fs.statSync(local).size > 1024 * 1024) {
      got = true;
      source = base;
      console.log(`  好了（${(fs.statSync(local).size / 1024 / 1024).toFixed(1)} MB）`);
      break;
    }
    console.log(`  这个源不行（退出码 ${r.status}），换下一个`);
  }
  if (!got) {
    console.error('两个源都没下下来。检查网络，或手工把 node.exe 放到 ' + OUT_DIR);
    process.exit(1);
  }

  // 摘要校验：**下载源与校验源分开** —— 镜像只负责快，准不准由官方那份清单说了算。
  // 镜像上没有清单就回官方取；两处都取不到才失败（要冒险可用 BANDI_NODE_SKIP_VERIFY=1）。
  if (process.env.BANDI_NODE_SKIP_VERIFY === '1') {
    console.warn('⚠️  跳过了 sha256 校验（BANDI_NODE_SKIP_VERIFY=1）—— 只在你亲自核过这个包时才这么干');
  } else {
    const sumsLocal = path.join(tmp, 'SHASUMS256.txt');
    let sums = null;
    for (const url of [`${source}/SHASUMS256.txt`, SHASUMS_FALLBACK]) {
      const s = spawnSync('curl', ['-fSL', '-m', '60', '--retry', '2', '-o', sumsLocal, url], {
        stdio: 'inherit',
        windowsHide: true,
      });
      if (s.status === 0 && fs.existsSync(sumsLocal)) {
        sums = url;
        break;
      }
      console.log(`  取不到 ${url}，换下一个`);
    }
    if (!sums) {
      console.error('摘要清单两处都没取到，不敢用。换网络重跑；确认过风险再用 BANDI_NODE_SKIP_VERIFY=1 跳过。');
      process.exit(1);
    }
    const want = fs
      .readFileSync(sumsLocal, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find((cols) => cols[1] === archive)?.[0];
    const gotHash = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
    if (!want) {
      console.error(`清单 ${sums} 里没有 ${archive} 这一行 —— 不敢用。`);
      process.exit(1);
    }
    if (want.toLowerCase() !== gotHash) {
      console.error(`sha256 对不上，已中止：\n  清单 ${want}\n  实际 ${gotHash}`);
      process.exit(1);
    }
    console.log(`  ✓ sha256 与官方清单一致（${gotHash.slice(0, 16)}…）`);
  }

  // 只解一个成员：整包解开是 150 MB，其中 npm / corepack / 头文件这里都用不到
  console.log(`只取 ${base}/${target.member}`);
  const x = spawnSync(
    'tar',
    ['-xf', local, '-C', OUT_DIR, '--strip-components=1', `${base}/${target.member}`],
    { stdio: 'inherit', windowsHide: true },
  );
  if (x.status !== 0 || !fs.existsSync(outFile)) {
    console.error('解压没成功（退出码 ' + x.status + '）');
    process.exit(1);
  }
  console.log(`✓ ${outFile}  ${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB`);

  // **Node 的 LICENSE 必须一起取**：安装包把 node.exe 分发给用户，就欠一份 Node 的许可声明
  // （那份文件里还写着它自己的一长串第三方：OpenSSL / V8 / npm / ICU…）。
  // 取不到就**别打包** —— "少一个文件也能装"正是许可缺口能被漏过去的原因。
  console.log(`只取 ${base}/LICENSE`);
  const lx = spawnSync(
    'tar',
    ['-xf', local, '-C', OUT_DIR, '--strip-components=1', `${base}/LICENSE`],
    { stdio: 'inherit', windowsHide: true },
  );
  const licTmp = path.join(OUT_DIR, 'LICENSE');
  const licOut = path.join(OUT_DIR, 'node-LICENSE.txt');
  if (lx.status !== 0 || !fs.existsSync(licTmp) || fs.statSync(licTmp).size < 100) {
    console.error('没取到 Node 的 LICENSE —— 不能就这么打包：再分发 node.exe 必须带许可声明。');
    process.exit(1);
  }
  fs.rmSync(licOut, { force: true }); // Windows 上 rename 到已存在的文件会失败
  fs.renameSync(licTmp, licOut);
  console.log(`✓ ${licOut}  ${(fs.statSync(licOut).size / 1024).toFixed(1)} KB`);
  console.log('  下一步：node apps/desktop/stage-runtime.mjs && cd apps/desktop && npx tauri build');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}
