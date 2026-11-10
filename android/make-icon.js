// 生成 app 图标：圆角渐变方块 + 白色对勾。没有设计资源，纯像素画。
const zlib = require("zlib");
const fs = require("fs");

const S = 192;
const px = Buffer.alloc(S * S * 4);

function lerp(a, b, t) { return a + (b - a) * t; }
function roundedDist(x, y, r) {
  // 到圆角矩形边界的有符号距离，用来做抗锯齿
  const cx = Math.min(Math.max(x, r), S - r);
  const cy = Math.min(Math.max(y, r), S - r);
  return Math.hypot(x - cx, y - cy) - r;
}
function segDist(px_, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px_ - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px_ - (x1 + dx * t), py - (y1 + dy * t));
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // 底：蓝色渐变，左上亮一点
    const t = (x + y) / (2 * S);
    let r = lerp(64, 37, t), g = lerp(132, 99, t), b = lerp(247, 235, t);
    let a = 255;

    // 圆角：外圈做 1px 抗锯齿，边缘透明
    const d = roundedDist(x + .5, y + .5, 44);
    if (d > 0) a = Math.max(0, 255 * (1 - d));
    // 顶部一层高光
    if (y < S * 0.5) {
      const k = (1 - y / (S * 0.5)) * 16;
      r += k; g += k; b += k;
    }
    // 对勾
    const d1 = segDist(x + .5, y + .5, 56, 100, 86, 130);
    const d2 = segDist(x + .5, y + .5, 86, 130, 138, 68);
    const dc = Math.min(d1, d2);
    const w = 9;
    if (dc < w + 1) {
      const k = dc <= w ? 1 : Math.max(0, 1 - (dc - w));
      r = lerp(r, 255, k); g = lerp(g, 255, k); b = lerp(b, 255, k);
    }
    px[i] = Math.round(Math.min(255, r));
    px[i + 1] = Math.round(Math.min(255, g));
    px[i + 2] = Math.round(Math.min(255, b));
    px[i + 3] = Math.round(a);
  }
}

// RGBA → PNG
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crcTable = chunk._t || (chunk._t = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let c = -1;
  for (const byte of body) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ -1) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0))
]);
fs.writeFileSync(process.argv[2] || "app/res/drawable/icon.png", png);
console.log("icon written", png.length, "bytes");
