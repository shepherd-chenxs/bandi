/**
 * 头像转 WebP（2026-11-08）。
 *
 * 为什么要这个：`apps/web/avatars/` 里 23 张 **256×256 PNG，平均 93 KB、合计 2.1 MB**，
 * 而它们实际最大只显示 58px（style.css `.hero .avatar` 58px、`.p-head .avatar` 52px、
 * `.mavatar` 48px、列表里 38px）。256² 照片存 PNG 本身就是 90 KB 起步 —— PNG 是无损
 * 格式，对照片基本压不动，这不是 `avatar-process.mjs` 的问题，是格式选错了。
 *
 * 代价有多大：局域网 100Mbps 完全无感，但外网走中转 / 阿里云 3Mbps（375 KB/s）时，
 * 一屏拉 20 张头像就是 1.86 MB ≈ **5 秒**，比整个应用外壳（brotli 后 595 KB）还贵，
 * 而且每进一次列表就重来一遍（头像不在 SW 预缓存清单里）。
 *
 * 做法：**不动原 PNG**（`personas.avatar` 存的是文件名，数据库里引用的还是 `.png`），
 * 只在旁边生成同名 `.webp`。服务端 `serveStatic` 按 `Accept: image/webp` 做内容协商，
 * 老客户端仍拿 PNG，`onerror` 兜底逻辑一位都不用改。
 *
 * 尺寸取 160：最大显示 58px（手机 2x/3x 屏 → 116/174），160 覆盖 2.7x，
 * 再大就是白花带宽。质量 82 在头像这种小图上和原图肉眼无差。
 *
 * 用法：
 *   npm i --no-save sharp && node tools/avatar-webp.mjs
 *   参数 --force 强制重转（默认只在 PNG 比 WebP 新时才转）
 *
 * 需要 sharp（仓库其余工具是零依赖手写编解码，但 WebP 的 VP8L 编码器手写不现实，
 * 这里接受一个仅在"加头像时"才装一次的开发期依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'apps/web/avatars');
const SIZE = 160;
const QUALITY = 82;
const FORCE = process.argv.includes('--force');

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('缺少 sharp。先装一次（不进 package.json）：\n  npm i --no-save sharp');
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((f) => /\.(png|jpe?g)$/i.test(f));
if (!files.length) {
  console.log('没有可转的图片');
  process.exit(0);
}

let n = 0, before = 0, after = 0, skipped = 0;
for (const f of files.sort()) {
  const src = path.join(DIR, f);
  const out = path.join(DIR, f.replace(/\.(png|jpe?g)$/i, '.webp'));
  const s = fs.statSync(src);
  before += s.size;

  const stale = FORCE || !fs.existsSync(out) || fs.statSync(out).mtimeMs < s.mtimeMs;
  if (!stale) {
    after += fs.statSync(out).size;
    skipped++;
    continue;
  }

  const buf = await sharp(src)
    .resize(SIZE, SIZE, { fit: 'cover', position: 'top' })
    .webp({ quality: QUALITY, effort: 6 })
    .toBuffer();
  fs.writeFileSync(out, buf);
  after += buf.length;
  n++;
  console.log(`  ${f.padEnd(26)} ${(s.size / 1024).toFixed(0).padStart(4)} KB → ${(buf.length / 1024).toFixed(1).padStart(5)} KB`);
}

const pct = before ? (1 - after / before) * 100 : 0;
console.log(
  `\n转换 ${n} 张，跳过 ${skipped} 张\n` +
    `合计 ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB（省 ${pct.toFixed(0)}%）\n` +
    `3Mbps（375 KB/s）下满屏头像传输：${(before / 1024 / 375).toFixed(1)}s → ${(after / 1024 / 375).toFixed(1)}s`,
);
