// Generates cover.png (800x534) for gladys-intellifire: plain Node, no dependency.
// A fireplace with its glass, a gas flame, a thermometer and local network waves
// on a warm dark gradient (no brand logo). Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [60 + 40 * t, 24 + 20 * t, 30 + 16 * t]);
  }
}
const rect = (x0, y0, w, h, color, alpha = 1) => {
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, color, alpha);
};
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// A flame: a teardrop, wide at the bottom, pointed at the top.
const flame = (cx, base, height, width, color, alpha = 1) => {
  const top = Math.round(base - height);
  for (let y = top; y <= base; y += 1) {
    const u = (y - top) / (base - top);
    const half = width * u ** 0.8 * Math.sqrt(Math.max(0, 1 - u ** 4));
    for (let x = Math.round(cx - half); x <= cx + half; x += 1) set(x, y, color, alpha);
  }
};
const arc = (cx, cy, r, width, from, to) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const angle = Math.atan2(y - cy, x - cx);
      if (angle < from || angle > to) continue;
      const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
      if (d < width) set(x, y, [255, 255, 255], Math.min(1, width - d) * 0.85);
    }
  }
};
// The fireplace: a stone frame, a dark firebox behind glass, a mantel.
rect(200, 120, 400, 330, [120, 104, 96]);
rect(170, 100, 460, 26, [90, 70, 60]);
rect(240, 170, 320, 240, [24, 16, 18]);
rect(240, 170, 320, 240, [170, 210, 240], 0.08);
// Logs and flames.
rect(280, 370, 240, 22, [92, 56, 36]);
for (const [cx, h, w] of [
  [330, 150, 46],
  [400, 190, 58],
  [470, 140, 44],
]) {
  flame(cx, 372, h, w, [255, 120, 30], 0.95);
  flame(cx, 372, h * 0.7, w * 0.6, [255, 200, 60], 0.95);
  flame(cx, 372, h * 0.35, w * 0.3, [120, 170, 255], 0.9);
}
// A thermometer at the right.
rect(672, 160, 18, 170, [255, 255, 255], 0.9);
disc(681, 340, 20, [255, 255, 255], 0.9);
rect(677, 220, 8, 120, [230, 70, 50]);
disc(681, 340, 14, [230, 70, 50]);
// Local network waves at the top left.
for (const r of [24, 44, 64]) arc(110, 110, r, 5, -2.4, -0.75);
disc(110, 110, 8, [255, 255, 255]);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
