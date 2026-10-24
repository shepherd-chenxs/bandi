/**
 * 头像落地工序（规范见 docs/头像生成规范.md）：生成 1024 方图 → 裁 256。
 *
 * 方图输入（H==W，标准路径）：窗口 956²——水平居中（可选偏移参数）、顶对齐原图顶
 * （头顶留白全保）、底边距下沿 68px 避开贴底 AI 水印（实测 x≥907/y≥960）。
 * 竖版输入（H>W）：全宽取方框，纵向按「头顶留白 14%」自适应（检测头顶位置）。
 *
 * 用法：node tools/avatar-process.mjs <输入.png> <输出256.png> [水平偏移px，正=右移]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const SRC = process.argv[2];
const OUT = process.argv[3];
const SIZE = 256;        // 输出尺寸
const HEADROOM = 0.14;   // 目标头顶留白（占画面高）
const TAIL = 80;         // 底部安全带：水印贴底，整条裁掉

const buf = fs.readFileSync(SRC);
if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
let off = 8, width = 0, height = 0, colorType = 0;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
  else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  off += 12 + len;
}
const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = width * CH;
const px = Buffer.alloc(stride * height);
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
for (let y = 0; y < height; y++) {
  const f = raw[y * (stride + 1)];
  const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  const dst = px.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
  for (let i = 0; i < stride; i++) {
    const a = i >= CH ? dst[i - CH] : 0, b = prev ? prev[i] : 0, c = prev && i >= CH ? prev[i - CH] : 0, v = src[i];
    dst[i] = f === 0 ? v : f === 1 ? (v + a) & 255 : f === 2 ? (v + b) & 255
      : f === 3 ? (v + ((a + b) >> 1)) & 255 : (v + paeth(a, b, c)) & 255;
  }
}
const at = (x, y) => { const i = (y * width + x) * CH; return [px[i], px[i + 1], px[i + 2]]; };
const dist = (c, b) => Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1]) + Math.abs(c[2] - b[2]);

/* 裁剪窗口：竖版全宽取方、纵向自适应；方图水平居中、底边避水印 */
let X0, Y0, CROP;
if (height > width) {
  CROP = width;
  X0 = 0;
  const bg = at(Math.floor(width * 0.08), Math.floor(width * 0.05));   // 顶部背景取样
  let headTop = 0;
  outer: for (let y = 0; y < height - TAIL; y++) for (let x = 0; x < width; x++) {
    if (dist(at(x, y), bg) > 90) { headTop = y; break outer; }
  }
  const yMax = height - CROP - TAIL;
  Y0 = Math.max(0, Math.min(Math.round(headTop - HEADROOM * CROP), yMax));
} else {
  CROP = Math.min(width, height - 68);   // 方图：底边距下沿 68，避开贴底水印
  X0 = Math.floor((width - CROP) / 2) + (Number(process.argv[4]) || 0);   // 可选水平偏移（正=右移）
  Y0 = 0;
}
console.log(`窗口 ${CROP}² x∈[${X0},${X0 + CROP}] y∈[${Y0},${Y0 + CROP}]（头顶留白目标 ${Math.round(HEADROOM * 100)}%）`);

/* 盒式下采样：输出 1 像素 = 源图上对应矩形块的面积平均 */
const ow = SIZE, oh = SIZE;
const sx = CROP / ow, sy = CROP / oh;
const orow = ow * CH;
const out = Buffer.alloc((orow + 1) * oh);
const acc = new Float64Array(CH);
for (let oy = 0; oy < oh; oy++) {
  out[oy * (orow + 1)] = 0;
  const y0 = Y0 + Math.floor(oy * sy), y1 = Math.min(height, Y0 + Math.ceil((oy + 1) * sy));
  for (let ox = 0; ox < ow; ox++) {
    acc.fill(0);
    const x0 = X0 + Math.floor(ox * sx), x1 = Math.min(width, X0 + Math.ceil((ox + 1) * sx));
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const si = (y * width + x) * CH;
      for (let k = 0; k < CH; k++) acc[k] += px[si + k];
      n++;
    }
    const di = oy * (orow + 1) + 1 + ox * CH;
    for (let k = 0; k < CH; k++) out[di + k] = Math.round(acc[k] / n);
  }
}

/* 编码（手写 CRC32） */
const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(ow, 0); ihdr.writeUInt32BE(oh, 4);
ihdr[8] = 8; ihdr[9] = colorType;
fs.writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`写出 ${OUT}（${width}x${height} → ${ow}x${oh}）`);
