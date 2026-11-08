// Generates public/icons/icon-{180,192,512}.png: a paraglider wing drawn as a question mark. The
// canopy is the curl, one riser is the stem and the pilot is the dot. public/icons/icon.svg is the
// same drawing. Node built-ins only (zlib for the PNG deflate stream). Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BG = [0x16, 0x36, 0x5c];
const FG = [0xf2, 0xf6, 0xfb];
const DOT = [0xf5, 0xb8, 0x3d];
const FAINT_ALPHA = 0.45;

// Everything is drawn in a 512 x 512 design space, then sampled 3x3 per pixel for smooth edges.
// Canopy: the region between two quadratic beziers from (120,250) to (392,250).
const TOP_CY = 40;
const BOTTOM_CY = 120;
// The stem: a cubic from the right wingtip down to the center, as a 24-wide round-capped stroke.
const STEM = sampleCubic({ x: 392, y: 250 }, { x: 400, y: 312 }, { x: 256, y: 296 }, { x: 256, y: 352 });
// The faint left riser, 9 wide.
const RISER = [{ x: 120, y: 250 }, { x: 256, y: 352 }];
const PILOT = { x: 256, y: 420, r: 28 };

function bezierY(t, p0y, cy, p2y) {
  return (1 - t) * (1 - t) * p0y + 2 * (1 - t) * t * cy + t * t * p2y;
}

function sampleCubic(p0, p1, p2, p3, n = 64) {
  const points = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3;
    points.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return points;
}

function nearPolyline(x, y, points, halfWidth) {
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(x, y, points[i - 1], points[i]) <= halfWidth) return true;
  }
  return false;
}

function inCanopy(x, y) {
  if (x < 120 || x > 392) return false;
  const t = (x - 120) / 272; // x is linear in t for a symmetric bezier with these control points
  return y >= bezierY(t, 250, TOP_CY, 250) && y <= bezierY(t, 250, BOTTOM_CY, 250);
}

/** The color at (x, y), painting back to front. */
function colorAt(x, y) {
  if (Math.hypot(x - PILOT.x, y - PILOT.y) <= PILOT.r) return DOT;
  if (inCanopy(x, y) || nearPolyline(x, y, STEM, 12)) return FG;
  if (nearPolyline(x, y, RISER, 4.5)) return BG.map((c, i) => c + (FG[i] - c) * FAINT_ALPHA);
  return BG;
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
      const sum = [0, 0, 0];
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const color = colorAt((px + (sx + 0.5) / 3) * scale, (py + (sy + 0.5) / 3) * scale);
          for (let c = 0; c < 3; c++) sum[c] += color[c];
        }
      }
      for (let c = 0; c < 3; c++) row[1 + px * 3 + c] = Math.round(sum[c] / 9);
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
