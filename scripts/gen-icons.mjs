// Generates the extension icons (static/icons/icon-{16,32,48,128}.png) with no dependencies:
// shapes are rendered as anti-aliased signed-distance fields into an RGBA buffer and encoded as PNG
// with node:zlib. Design (kineReqLens, Kinebot brand): blue (#1a3ac9) rounded square, white lens ring with the
// green dot-and-line of the "o" in "kinebot" inside, and an amber handle ending in the amber dot of its "k".
//
//   node scripts/gen-icons.mjs            -> writes static/icons/*.png
//   import { renderIcon, encodePng } ...  -> reusable (e.g. previews)
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

export const SIZES = [16, 32, 48, 128];

// ---------------------------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO-HDLC), as used by PNG and ZIP. */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return out;
}

/** Encode straight-alpha RGBA pixels (Uint8Array, width*height*4) as a PNG file. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Filter type 4 (Paeth) per scanline compresses smooth gradients well.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 4;
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= 4 ? rgba[i - 4] : 0;
      const b = y > 0 ? rgba[i - stride] : 0;
      const c = x >= 4 && y > 0 ? rgba[i - stride - 4] : 0;
      raw[rowStart + 1 + x] = (rgba[i] - paeth(a, b, c)) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------------------------------------
// Signed distance fields (pixel units; negative inside)
// ---------------------------------------------------------------------------------------------

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/** Distance to a segment, minus half the stroke width (round caps). */
function sdCapsule(px, py, ax, ay, bx, by, halfWidth) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  return Math.hypot(pax - bax * h, pay - bay * h) - halfWidth;
}

/** Polyline stroke = union of capsules. */
function sdPolyline(px, py, points, halfWidth) {
  let d = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    d = Math.min(d, sdCapsule(px, py, ax, ay, bx, by, halfWidth));
  }
  return d;
}

function quad(p0, c, p1, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return pts;
}

/**
 * A curly brace "{" inside the box (x0, y0, w, h) as a smooth polyline; `mirror` draws "}".
 * Shape: arm from the top-right curls into a vertical stem, which pinches to a tip at mid-height.
 */
function bracePoints(x0, y0, w, h, mirror) {
  const X = (fx) => (mirror ? x0 + w - fx * w : x0 + fx * w);
  const Y = (fy) => y0 + fy * h;
  const stem = 0.42;
  const pts = [
    ...quad([X(1), Y(0)], [X(stem), Y(0)], [X(stem), Y(0.2)], 10),
    ...quad([X(stem), Y(0.36)], [X(stem), Y(0.5)], [X(0), Y(0.5)], 10),
    ...quad([X(0), Y(0.5)], [X(stem), Y(0.5)], [X(stem), Y(0.64)], 10),
    ...quad([X(stem), Y(0.8)], [X(stem), Y(1)], [X(1), Y(1)], 10),
  ];
  return pts;
}

// ---------------------------------------------------------------------------------------------
// Icon rendering
// ---------------------------------------------------------------------------------------------

const ACCENT_TOP = [0x2a, 0x4d, 0xe0]; // a touch lighter than the accent
const ACCENT_BOTTOM = [0x12, 0x2c, 0xb0]; // a touch darker
const WHITE = [255, 255, 255];
const GREEN = [0x1b, 0xb8, 0x52];
const AMBER = [0xf2, 0xae, 0x1f];

/** Coverage of a shape from its signed distance, anti-aliased over ~1 px. */
function coverage(d) {
  return Math.max(0, Math.min(1, 0.5 - d));
}

/** Geometry for a size: small sizes use thicker relative strokes and drop the braces for legibility. */
function geometry(size) {
  const s = size;
  const small = size < 24;
  const pad = small ? 0 : s * 0.03;
  const lens = { cx: s * 0.44, cy: s * 0.44, r: s * (small ? 0.255 : 0.265) };
  const ring = Math.max(1.6, s * (small ? 0.11 : 0.075));
  const handle = Math.max(2.2, s * (small ? 0.16 : 0.12));
  return {
    bg: { cx: s / 2, cy: s / 2, hw: s / 2 - pad, hh: s / 2 - pad, r: s * 0.22 },
    lens,
    ringHalf: ring / 2,
    handleHalf: handle / 2,
    handle: {
      ax: lens.cx + (lens.r + ring * 0.2) * Math.SQRT1_2,
      ay: lens.cy + (lens.r + ring * 0.2) * Math.SQRT1_2,
      bx: s * 0.76,
      by: s * 0.76,
    },
    braces: null,
    /** Green "o" dot in the lens centre and its line to the ring. */
    dot: { r: lens.r * (small ? 0.42 : 0.36), lineHalf: Math.max(0.9, s * (small ? 0.06 : 0.045)) },
    /** Amber knob at the end of the handle. */
    knob: { r: Math.max(2, s * (small ? 0.13 : 0.1)) },
  };
}

/** Render one icon as straight-alpha RGBA. */
export function renderIcon(size) {
  const g = geometry(size);
  const out = new Uint8Array(size * size * 4);
  const braceSets = [];
  if (g.braces) {
    const { w, h, gap } = g.braces;
    const y0 = g.lens.cy - h / 2;
    braceSets.push(bracePoints(g.lens.cx - gap - w, y0, w, h, false));
    braceSets.push(bracePoints(g.lens.cx + gap, y0, w, h, true));
  }

  // 3x3 supersampling on top of SDF anti-aliasing keeps the small sizes crisp but smooth.
  const SS = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let gC = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const [pr, pg, pb, pa] = shade(px, py, size, g, braceSets, SS);
          r += pr;
          gC += pg;
          b += pb;
          a += pa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const i = (y * size + x) * 4;
      if (alpha > 0) {
        // Accumulated values are premultiplied; convert back to straight alpha.
        out[i] = Math.round(r / n / alpha);
        out[i + 1] = Math.round(gC / n / alpha);
        out[i + 2] = Math.round(b / n / alpha);
      }
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

/** Premultiplied color of one sample. */
function shade(px, py, size, g, braceSets, ss) {
  // Distances are scaled by the supersampling factor so coverage() spans one sub-sample.
  const k = ss;
  const bgCov = coverage(sdRoundRect(px, py, g.bg.cx, g.bg.cy, g.bg.hw, g.bg.hh, g.bg.r) * k);
  if (bgCov <= 0) return [0, 0, 0, 0];

  const t = Math.max(0, Math.min(1, (px + py) / (2 * size)));
  let color = ACCENT_TOP.map((c, i) => c + (ACCENT_BOTTOM[i] - c) * t);

  // Glass: faint white tint inside the lens.
  const inside = coverage(sdCircle(px, py, g.lens.cx, g.lens.cy, g.lens.r) * k);
  color = mix(color, WHITE, inside * 0.14);

  const ring = coverage((Math.abs(sdCircle(px, py, g.lens.cx, g.lens.cy, g.lens.r)) - g.ringHalf) * k);
  color = mix(color, WHITE, ring);
  // Green dot + line to the right side of the ring (the "o" of kinebot).
  const dot = coverage(sdCircle(px, py, g.lens.cx, g.lens.cy, g.dot.r) * k);
  const line = coverage(sdCapsule(px, py, g.lens.cx, g.lens.cy, g.lens.cx + g.lens.r, g.lens.cy, g.dot.lineHalf) * k);
  color = mix(color, GREEN, Math.max(dot, line));
  // Amber handle with a round knob (the "k" of kinebot).
  const handle = coverage(sdCapsule(px, py, g.handle.ax, g.handle.ay, g.handle.bx, g.handle.by, g.handleHalf) * k);
  const knob = coverage(sdCircle(px, py, g.handle.bx, g.handle.by, g.knob.r) * k);
  color = mix(color, AMBER, Math.max(handle, knob));
  return [color[0] * bgCov, color[1] * bgCov, color[2] * bgCov, bgCov];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = path.join(root, 'static', 'icons');
  await mkdir(outDir, { recursive: true });
  for (const size of SIZES) {
    const file = path.join(outDir, `icon-${size}.png`);
    const png = encodePng(size, size, renderIcon(size));
    await writeFile(file, png);
    console.log(`[kinereqlens] ${path.relative(root, file)} (${png.length} bytes)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
