// Regenerates the PWA icons in public/. Run from the repo root:
//
//   bun run apps/hub/scripts/icons.ts
//
// The mark is the same thing the dashboard draws - a day's temperature curve
// with its high picked out - so the installed app's icon and its content agree.
// Everything is rasterised here rather than shipped as SVG because iOS wants a
// PNG for its home-screen icon and Android's maskable slot is a raster contract
// too; a hand-rolled encoder keeps that from costing the app a dependency.

const OUT = new URL('../public/', import.meta.url);

const GROUND = [0x0b, 0x0f, 0x15] as const;
const CURVE = [0x2a, 0x93, 0xcc] as const;
const PEAK = [0xcc, 0x7e, 0x2f] as const;

type Rgb = readonly [number, number, number];

const SUPERSAMPLE = 4;

// A day's temperature: coldest before dawn, peaking mid-afternoon. The mark
// shows a little under one full cycle (SPAN), so it ends mid-afternoon's
// descent rather than symmetrically back where it started.
const SPAN = 0.88;

/** Height of the curve at `t` across the mark, 0 at the bottom of the box. */
function curveAt(t: number): number {
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * (t * SPAN - 0.15));
}

const PEAK_T = 0.65 / SPAN;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function roundedRectCovers(
  x: number,
  y: number,
  size: number,
  radius: number,
): boolean {
  const near = (v: number) => Math.min(v, size - v);
  const dx = radius - near(x);
  const dy = radius - near(y);
  if (dx <= 0 || dy <= 0) return true;
  return dx * dx + dy * dy <= radius * radius;
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : clamp01(((px - ax) * vx + (py - ay) * vy) / len);
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

function render(size: number, options: { rounded: boolean; inset: number }) {
  const pixels = new Uint8Array(size * size * 4);

  // The mark's content box, and the polyline through it.
  const pad = size * options.inset;
  const boxX = pad;
  const boxY = pad;
  const boxSize = size - pad * 2;
  const stroke = boxSize * 0.115;
  const steps = 64;
  const curve: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    curve.push([
      boxX + t * boxSize,
      boxY + boxSize * (0.86 - curveAt(t) * 0.58),
    ]);
  }
  const peak: [number, number] = [
    boxX + PEAK_T * boxSize,
    boxY + boxSize * (0.86 - curveAt(PEAK_T) * 0.58),
  ];
  const peakRadius = boxSize * 0.085;

  const radius = size * 0.22;
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let ground = 0;
      let line = 0;
      let dot = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;

          if (!options.rounded || roundedRectCovers(x, y, size, radius)) {
            ground++;
          }

          const toPeak = Math.hypot(x - peak[0], y - peak[1]);
          if (toPeak <= peakRadius) {
            dot++;
            continue;
          }
          // A ground-coloured ring keeps the dot legible where it sits on the
          // curve it marks.
          if (toPeak <= peakRadius + stroke * 0.34) continue;

          let onLine = false;
          for (let i = 1; i < curve.length && !onLine; i++) {
            const d = distanceToSegment(
              x,
              y,
              curve[i - 1][0],
              curve[i - 1][1],
              curve[i][0],
              curve[i][1],
            );
            onLine = d <= stroke / 2;
          }
          if (onLine) line++;
        }
      }

      const alpha = ground / samples;
      let rgb: Rgb = GROUND;
      const lineAlpha = line / samples;
      const dotAlpha = dot / samples;
      if (dotAlpha > 0 || lineAlpha > 0) {
        const mark: Rgb = dotAlpha >= lineAlpha ? PEAK : CURVE;
        const cover = Math.max(dotAlpha, lineAlpha);
        rgb = [
          GROUND[0] + (mark[0] - GROUND[0]) * cover,
          GROUND[1] + (mark[1] - GROUND[1]) * cover,
          GROUND[2] + (mark[2] - GROUND[2]) * cover,
        ];
      }

      const at = (py * size + px) * 4;
      pixels[at] = Math.round(rgb[0]);
      pixels[at + 1] = Math.round(rgb[1]);
      pixels[at + 2] = Math.round(rgb[2]);
      pixels[at + 3] = Math.round(alpha * 255);
    }
  }

  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

function encodePng(pixels: Uint8Array, size: number): Uint8Array {
  const stride = size * 4;
  // One filter byte per scanline; filter 0 (None) throughout - these icons are
  // flat colour, so the extra prediction buys nothing.
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw.set(
      pixels.subarray(y * stride, (y + 1) * stride),
      y * (stride + 1) + 1,
    );
  }

  // Bun.deflateSync emits a raw deflate stream; PNG wants it wrapped in zlib.
  const deflated = Bun.deflateSync(raw);
  const zlib = new Uint8Array(deflated.length + 6);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib.set(deflated, 2);
  new DataView(zlib.buffer).setUint32(zlib.length - 4, adler32(raw));

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, size);
  header.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, inset: 0.18 },
  { file: 'icon-512.png', size: 512, rounded: true, inset: 0.18 },
  // Android crops a maskable icon to whatever shape the launcher uses, so the
  // mark has to stay inside the safe circle and the ground has to fill the
  // whole square.
  { file: 'icon-maskable-512.png', size: 512, rounded: false, inset: 0.28 },
  // iOS masks the home-screen icon itself; a pre-rounded one gets rounded twice.
  { file: 'apple-touch-icon.png', size: 180, rounded: false, inset: 0.18 },
];

for (const icon of ICONS) {
  const png = encodePng(
    render(icon.size, { rounded: icon.rounded, inset: icon.inset }),
    icon.size,
  );
  await Bun.write(new URL(icon.file, OUT), png);
  console.info(`wrote ${icon.file} (${icon.size}px, ${png.length} bytes)`);
}
