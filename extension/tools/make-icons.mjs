/* Рисует иконки расширения (16/48/128) — тот же дизайн, что и у десктопа. */
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const S = 2;
const SIZE = 256 * S;

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const px = Buffer.alloc(SIZE * SIZE * 4);
const set = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const na = a / 255;
  const oa = px[i + 3] / 255;
  const ra = na + oa * (1 - na);
  if (ra <= 0) return;
  px[i] = Math.round((r * na + px[i] * oa * (1 - na)) / ra);
  px[i + 1] = Math.round((g * na + px[i + 1] * oa * (1 - na)) / ra);
  px[i + 2] = Math.round((b * na + px[i + 2] * oa * (1 - na)) / ra);
  px[i + 3] = Math.round(ra * 255);
};
const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const GREEN = [29, 185, 84];
const PURPLE = [145, 71, 255];
const u = (v) => v * S;
const PAD = 8 * S;
const RADIUS = 54 * S;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!inRoundedRect(x, y, PAD, PAD, SIZE - PAD - 1, SIZE - PAD - 1, RADIUS)) continue;
    const t = y / SIZE;
    set(x, y, Math.round(24 - 8 * t), Math.round(24 - 8 * t), Math.round(32 - 8 * t), 255);
    const gx = x - SIZE / 2;
    const gy = y - SIZE / 2;
    const gd = Math.sqrt(gx * gx + gy * gy) / (SIZE * 0.55);
    if (gd < 1) set(x, y, PURPLE[0], PURPLE[1], PURPLE[2], Math.round(46 * (1 - gd) * (1 - gd)));
  }
}

const HEAD = { cx: u(104), cy: u(172), rx: u(36), ry: u(27) };
const STEM = { x0: u(133), x1: u(145), y0: u(66), y1: u(174) };
const P0 = { x: u(139), y: u(68) };
const P1 = { x: u(214), y: u(84) };
const P2 = { x: u(196), y: u(150) };

const brush = (x, y, r) => {
  for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++) {
    for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
      const d = Math.sqrt((xx - x) ** 2 + (yy - y) ** 2);
      if (d <= r) set(xx, yy, GREEN[0], GREEN[1], GREEN[2], 255);
      else if (d < r + 2 * S) set(xx, yy, GREEN[0], GREEN[1], GREEN[2], Math.round(255 * (1 - (d - r) / (2 * S))));
    }
  }
};

for (let y = Math.floor(HEAD.cy - HEAD.ry) - 4; y <= HEAD.cy + HEAD.ry + 4; y++) {
  for (let x = Math.floor(HEAD.cx - HEAD.rx) - 4; x <= HEAD.cx + HEAD.rx + 4; x++) {
    const dx = x - HEAD.cx;
    const dy = y - HEAD.cy;
    const ang = -0.35;
    const rx = dx * Math.cos(ang) - dy * Math.sin(ang);
    const ry = dx * Math.sin(ang) + dy * Math.cos(ang);
    const d = (rx / HEAD.rx) ** 2 + (ry / HEAD.ry) ** 2;
    if (d <= 1) set(x, y, GREEN[0], GREEN[1], GREEN[2], 255);
    else if (d < 1.14) set(x, y, GREEN[0], GREEN[1], GREEN[2], Math.round(255 * (1 - (Math.sqrt(d) - 1) / 0.12)));
  }
}
for (let y = STEM.y0; y <= STEM.y1; y++) {
  for (let x = STEM.x0; x <= STEM.x1; x++) set(x, y, GREEN[0], GREEN[1], GREEN[2], 255);
}
for (let i = 0; i <= 60; i++) {
  const t = i / 60;
  const x = (1 - t) ** 2 * P0.x + 2 * (1 - t) * t * P1.x + t * t * P2.x;
  const y = (1 - t) ** 2 * P0.y + 2 * (1 - t) * t * P1.y + t * t * P2.y;
  brush(x, y, u(11) * (1 - 0.25 * t));
}

function encodePNG(outSize) {
  const out = Buffer.alloc(outSize * outSize * 4);
  const k = SIZE / outSize;
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < k; sy++) {
        for (let sx = 0; sx < k; sx++) {
          const i = ((y * k + sy) * SIZE + x * k + sx) * 4;
          const al = px[i + 3];
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * outSize + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a / n);
      }
    }
  }
  const raw = Buffer.alloc(outSize * (outSize * 4 + 1));
  for (let y = 0; y < outSize; y++) {
    raw[y * (outSize * 4 + 1)] = 0;
    out.copy(raw, y * (outSize * 4 + 1) + 1, y * outSize * 4, (y + 1) * outSize * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(outSize, 0);
  ihdr.writeUInt32BE(outSize, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  writeFileSync(file, encodePNG(size));
  console.log('icon ->', file);
}
