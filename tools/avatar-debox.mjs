/**
 * 修补头顶黑色矩形瑕疵：x∈[112,195] y∈[0,34] 的纯黑杆状物 → 用左侧等宽背景条
 * 水平翻转贴入（暗角亮度分布对称，翻转后左右边缘自然衔接）。
 * 用法：node tmp/avatar-debox.mjs <输入.png> <输出.png>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const SRC = process.argv[2], OUT = process.argv[3];
const RX0 = 112, RX1 = 195, RY1 = 34;      // 瑕疵矩形范围
const SX0 = 16;                             // 背景条来源 x 起点（宽 84）

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

/* 贴背景条：行 y、列 x∈[RX0,RX1] ← 源列 (SX0 + RX1 - x)（水平翻转） */
const W = RX1 - RX0 + 1;
for (let y = 0; y <= RY1; y++) {
  for (let x = RX0; x <= RX1; x++) {
    const sx = SX0 + (RX1 - x);
    const di = (y * width + x) * CH, si = (y * width + sx) * CH;
    for (let k = 0; k < CH; k++) px[di + k] = px[si + k];
  }
}
console.log(`已贴背景条 ${W}x${RY1 + 1}`);

/* 编码（每行带 0 filter 字节） */
const out = Buffer.alloc((stride + 1) * height);
for (let y = 0; y < height; y++) {
  out[y * (stride + 1)] = 0;
  px.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
}
const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; ihdr[9] = colorType;
fs.writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`写出 ${OUT}`);
