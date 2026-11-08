/**
 * Little-endian binary writing and Android resource string pools.
 *
 * Shared by the AXML (binary XML) and resources.arsc encoders. Everything here
 * is pure and browser-safe so APK assembly can run inside the compiler app.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Growable little-endian byte writer. */
export class Writer {
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  reserve(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v) { this.reserve(1); this.view.setUint8(this.pos, v & 0xff); this.pos += 1; return this; }
  u16(v) { this.reserve(2); this.view.setUint16(this.pos, v & 0xffff, true); this.pos += 2; return this; }
  u32(v) { this.reserve(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this; }
  i32(v) { this.reserve(4); this.view.setInt32(this.pos, v | 0, true); this.pos += 4; return this; }

  bytes(b) { this.reserve(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }

  zeros(n) { this.reserve(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; return this; }

  /** NUL-terminated UTF-16LE, padded to a fixed byte width. */
  utf16Fixed(str, byteWidth) {
    const units = [];
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      } else units.push(cp);
    }
    const max = byteWidth / 2 - 1;
    const kept = units.slice(0, max);
    this.reserve(byteWidth);
    for (const u of kept) this.u16(u);
    this.zeros(byteWidth - kept.length * 2);
    return this;
  }

  /** Pad with zeros to a four-byte boundary, as every ResChunk requires. */
  align4() {
    const pad = (4 - (this.pos % 4)) % 4;
    if (pad) this.zeros(pad);
    return this;
  }

  patchU32(at, v) { this.view.setUint32(at, v >>> 0, true); return this; }

  done() { return this.buf.slice(0, this.pos); }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32, used by both ZIP and PNG. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

/** Number of UTF-16 code units, which is what the pool's first length holds. */
function utf16Length(str) {
  let n = 0;
  for (const ch of str) n += ch.codePointAt(0) > 0xffff ? 2 : 1;
  return n;
}

/* Android encodes pool lengths as one byte, or two when the high bit is set. */
function writeLength(w, len) {
  if (len < 0x80) w.u8(len);
  else { w.u8(((len >> 8) & 0x7f) | 0x80); w.u8(len & 0xff); }
}

export const UTF8_FLAG = 0x100;
export const RES_STRING_POOL_TYPE = 0x0001;
export const STRING_POOL_HEADER_SIZE = 28;

/**
 * Encode a ResStringPool chunk using UTF-8.
 * Duplicate strings share an entry so indices stay stable and small.
 * @returns {{chunk: Uint8Array, index: Map<string, number>}}
 */
export function stringPool(strings) {
  const unique = [];
  const index = new Map();
  for (const s of strings) {
    if (!index.has(s)) { index.set(s, unique.length); unique.push(s); }
  }

  const data = new Writer(256);
  const offsets = [];
  for (const s of unique) {
    offsets.push(data.pos);
    const bytes = utf8Bytes(s);
    writeLength(data, utf16Length(s));
    writeLength(data, bytes.length);
    data.bytes(bytes);
    data.u8(0);
  }
  data.align4();

  const stringsStart = STRING_POOL_HEADER_SIZE + unique.length * 4;
  const total = stringsStart + data.pos;
  const w = new Writer(total);
  w.u16(RES_STRING_POOL_TYPE).u16(STRING_POOL_HEADER_SIZE).u32(total);
  w.u32(unique.length).u32(0);          // stringCount, styleCount
  w.u32(UTF8_FLAG);
  w.u32(stringsStart).u32(0);           // stringsStart, stylesStart
  for (const off of offsets) w.u32(off);
  w.bytes(data.done());
  return { chunk: w.done(), index };
}

/** Wrap a payload in a ResChunk header of the given type. */
export function chunk(type, headerSize, body) {
  const w = new Writer(headerSize + body.length);
  w.u16(type).u16(headerSize).u32(headerSize + body.length);
  return { writer: w, total: headerSize + body.length };
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
