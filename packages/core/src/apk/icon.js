/**
 * Launcher icon generation.
 *
 * The Gradle path uses a vector drawable, but the on-device path needs raster
 * bytes and must not depend on a renderer. Draw a simple code-bracket mark and
 * encode it as PNG with fflate's deflate, so this stays pure and browser-safe.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { zlibSync } from 'fflate';
import { crc32 } from './binary.js';

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

/** Encode RGBA pixels as a PNG. */
export function encodePng(width, height, rgba) {
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace

  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowAt = y * (1 + width * 4);
    raw[rowAt] = 0;                       // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowAt + 1);
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * A rounded indigo square with a white `</>` mark.
 * @param {number} size edge length in pixels (192 suits xxxhdpi launchers)
 */
export function makeLauncherIcon(size = 192) {
  const rgba = new Uint8Array(size * size * 4);
  const s = size / 192;                       // design coordinates are 192-based
  const radius = 36 * s;
  const half = (10 * s) / 2;
  const segments = [
    [78, 66, 54, 96], [54, 96, 78, 126],      // "<"
    [114, 66, 138, 96], [138, 96, 114, 126],  // ">"
    [104, 60, 88, 132],                       // "/"
  ].map(([x1, y1, x2, y2]) => [x1 * s, y1 * s, x2 * s, y2 * s]);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Rounded-rectangle coverage, antialiased at the edge.
      const cx = Math.max(radius, Math.min(size - radius, px));
      const cy = Math.max(radius, Math.min(size - radius, py));
      const cornerDist = Math.hypot(px - cx, py - cy);
      const inside = (px >= radius && px <= size - radius) || (py >= radius && py <= size - radius);
      const bg = inside ? 1 : clamp01(radius + 0.5 - cornerDist);

      let glyph = 0;
      for (const [x1, y1, x2, y2] of segments) {
        glyph = Math.max(glyph, clamp01(half + 0.5 - distToSegment(px, py, x1, y1, x2, y2)));
      }

      // Indigo background, white mark on top.
      const r = Math.round(0x4f + (255 - 0x4f) * glyph);
      const g = Math.round(0x46 + (255 - 0x46) * glyph);
      const b = Math.round(0xe5 + (255 - 0xe5) * glyph);
      const at = (y * size + x) * 4;
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = Math.round(bg * 255);
    }
  }
  return encodePng(size, size, rgba);
}
