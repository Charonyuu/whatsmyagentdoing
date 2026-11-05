#!/usr/bin/env node
'use strict';

// Top-down PNG of a scene manifest, without a browser: model footprints,
// blocked areas, working stations (squares) and idle spots (dots).
//   node packs/lib/plan.js packs/christmas/manifest.json out.png

const fs = require('fs');
const zlib = require('zlib');

const [file, out] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const PX = 36, X0 = -6, Y0 = -7, X1 = m.W + 6, Y1 = m.D + 5;
const W = (X1 - X0) * PX, H = (Y1 - Y0) * PX;
const img = Buffer.alloc(W * H * 3, 0x22);

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function rect(x, y, w, d, hex, alpha = 1, outline = false) {
  const c = rgb(hex);
  const ax = Math.round((x - X0) * PX), ay = Math.round((y - Y0) * PX);
  const bx = Math.round((x + w - X0) * PX), by = Math.round((y + d - Y0) * PX);
  for (let j = Math.max(0, ay); j < Math.min(H, by); j++) {
    for (let i = Math.max(0, ax); i < Math.min(W, bx); i++) {
      if (outline && j > ay + 1 && j < by - 2 && i > ax + 1 && i < bx - 2) continue;
      const k = (j * W + i) * 3;
      for (let n = 0; n < 3; n++) img[k + n] = Math.round(img[k + n] * (1 - alpha) + c[n] * alpha);
    }
  }
}
const dot = (x, y, r, hex) => rect(x - r, y - r, 2 * r, 2 * r, hex);

// grid, floors, walkable area
for (const p of m.props.filter((p) => p.special === 'floor')) rect(p.x, p.y, p.w, p.d, p.color, 0.35);
for (const [x0, y0, x1, y1] of m.walk) rect(x0, y0, x1 - x0, y1 - y0, '#3a5a3a', 0.35);
for (let x = Math.ceil(X0); x <= X1; x++) rect(x - 0.01, Y0, 0.02, Y1 - Y0, '#555555', 0.5);
for (let y = Math.ceil(Y0); y <= Y1; y++) rect(X0, y - 0.01, X1 - X0, 0.02, '#555555', 0.5);
rect(0, 0, m.W, m.D, '#ffffff', 0.8, true);
// models (blue), furniture (teal), boxes/specials (grey)
for (const p of m.props) {
  if (p.m) rect(p.x, p.y, p.w, p.d, p.abs ? '#6a7fd0' : '#4f8ff7', p.abs ? 0.25 : 0.55);
  else if (p.f) rect(p.x, p.y, p.w, p.d, '#2bb39a', 0.6);
  else if (p.special === 'fire') dot(p.x, p.y, 0.35, '#ff7a1a');
  else if (p.special === 'lamp') dot(p.x, p.y, 0.08, '#ffe066');
  else if (['box', 'glass', 'glow'].includes(p.special)) rect(p.x, p.y, p.w, p.d, '#aaaaaa', 0.5);
}
for (const [x, y, w, d] of m.solid) rect(x, y, w, d, '#ff4d4d', 0.9, true);
for (const s of m.stations) rect(s.x - 0.18, s.y - 0.18, 0.36, 0.36, s.pose === 'sit' ? '#ffd23f' : '#ff9f1c');
for (const q of m.pois) dot(q.x, q.y, 0.15, '#e85dff');
dot(m.spawn.x, m.spawn.y, 0.22, '#00e0ff');

// PNG: 8-bit RGB, no filtering
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let j = 0; j < H; j++) img.copy(raw, j * (W * 3 + 1) + 1, j * W * 3, (j + 1) * W * 3);
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(out, W, 'x', H);
