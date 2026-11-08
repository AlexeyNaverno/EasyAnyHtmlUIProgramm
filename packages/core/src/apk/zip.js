/**
 * ZIP writer with Android's alignment rules.
 *
 * Apps targeting API 30+ must store resources.arsc uncompressed and 4-byte
 * aligned, so this writer pads the local extra field the same way zipalign
 * does. It also reports the central-directory offset, which APK signature
 * scheme v2 needs in order to insert its signing block.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { deflateSync } from 'fflate';
import { Writer, crc32, utf8Bytes } from './binary.js';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORE = 0;
const DEFLATE = 8;
const PAD_ID = 0xd935;          // Android's alignment padding extra field

/* Fixed DOS timestamp (1980-01-01) keeps output reproducible. */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/**
 * @param {Array<{name: string, data: Uint8Array, store?: boolean}>} entries
 * @returns {{bytes: Uint8Array, centralDirOffset: number, eocdOffset: number}}
 */
export function writeZip(entries) {
  const out = new Writer(64 * 1024);
  const central = [];

  for (const entry of entries) {
    const nameBytes = utf8Bytes(entry.name);
    const raw = entry.data;
    const useStore = Boolean(entry.store);
    const comp = useStore ? raw : deflateSync(raw, { level: 9 });
    // Deflate can be counterproductive for tiny or already-compressed files.
    const method = (!useStore && comp.length < raw.length) ? DEFLATE : STORE;
    const body = method === DEFLATE ? comp : raw;
    const sum = crc32(raw);

    const headerAt = out.pos;
    const fixed = 30 + nameBytes.length;
    let pad = (4 - ((headerAt + fixed) % 4)) % 4;
    if (method === STORE) {
      if (pad > 0 && pad < 4) pad += 4;    // an extra header needs four bytes
    } else pad = 0;

    out.u32(LOCAL_SIG).u16(20).u16(UTF8_FLAG).u16(method);
    out.u16(DOS_TIME).u16(DOS_DATE);
    out.u32(sum).u32(body.length).u32(raw.length);
    out.u16(nameBytes.length).u16(pad);
    out.bytes(nameBytes);
    if (pad) {
      out.u16(PAD_ID).u16(pad - 4);
      if (pad > 4) out.zeros(pad - 4);
    }
    const dataAt = out.pos;
    if (method === STORE && dataAt % 4 !== 0) {
      throw new Error(`Alignment failed for ${entry.name}`);
    }
    out.bytes(body);

    central.push({
      nameBytes, method, sum, compSize: body.length, rawSize: raw.length, headerAt,
    });
  }

  const centralDirOffset = out.pos;
  for (const c of central) {
    out.u32(CENTRAL_SIG);
    out.u16(0x031e);                       // made by UNIX, zip 3.0
    out.u16(20).u16(UTF8_FLAG).u16(c.method);
    out.u16(DOS_TIME).u16(DOS_DATE);
    out.u32(c.sum).u32(c.compSize).u32(c.rawSize);
    out.u16(c.nameBytes.length).u16(0).u16(0);
    out.u16(0).u16(0);
    out.u32(0o100644 << 16);               // regular file, rw-r--r--
    out.u32(c.headerAt);
    out.bytes(c.nameBytes);
  }
  const eocdOffset = out.pos;
  const centralSize = eocdOffset - centralDirOffset;

  out.u32(EOCD_SIG);
  out.u16(0).u16(0);
  out.u16(central.length).u16(central.length);
  out.u32(centralSize).u32(centralDirOffset);
  out.u16(0);

  return { bytes: out.done(), centralDirOffset, eocdOffset };
}
