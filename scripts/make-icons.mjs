// Generates public/icons/icon-{180,192,512}.png: a paraglider wing arc on a solid background.
// Node built-ins only (zlib for the PNG deflate stream). Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BG = [0x16, 0x36, 0x5c];
const FG = [0xf2, 0xf6, 0xfb];

// Everything is drawn in a 512 x 512 design space, then sampled 3x3 per pixel for smooth edges.
// Wing: the region between two curves, each a quadratic bezier from (96,300) to (416,300).
const TOP = { cx: 256, cy: 90 }; // top curve control point (outer arc)
const BOT = { cx: 256, cy: 262 }; // bottom curve control point (trailing edge)

function bezierY(t, p0y, cy, p2y) {
  return (1 - t) * (1 - t) * p0y + 2 * (1 - t) * t * cy + t * t * p2y;
}

/** Is (x, y) inside the wing or on a suspension line? */
function inMark(x, y) {
  if (x >= 96 && x <= 416) {
    const t = (x - 96) / 320; // x is linear in t for a symmetric bezier with these control points
    const top = bezierY(t, 300, TOP.cy, 300);
    const bottom = bezierY(t, 300, BOT.cy, 300);
    if (y >= top && y <= bottom) return true;
  }
  // Lines from the wing's underside to the pilot at (256, 392).
  const pilot = { x: 256, y: 392 };
  for (const start of [{ x: 256, y: 300 }, { x: 176, y: 282 }, { x: 336, y: 282 }]) {
    if (distanceToSegment(x, y, start, pilot) <= 5) return true;
  }
  return false;
}

function distanceToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const scale = 512 / size;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB
    for (let px = 0; px < size; px++) {
      let covered = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const x = (px + (sx + 0.5) / 3) * scale;
          const y = (py + (sy + 0.5) / 3) * scale;
          if (inMark(x, y)) covered++;
        }
      }
      const f = covered / 9;
      for (let c = 0; c < 3; c++) {
        row[1 + px * 3 + c] = Math.round(BG[c] + (FG[c] - BG[c]) * f);
      }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png(size));
  console.log(`wrote ${file}`);
}
