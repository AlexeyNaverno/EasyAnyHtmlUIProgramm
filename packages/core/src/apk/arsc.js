/**
 * Android resource table (resources.arsc) encoder.
 *
 * Emits a minimal but valid table so a generated APK can carry its own label
 * and icon without aapt2. Only default-configuration string values are needed:
 * every entry points at a string in the global pool, which for a drawable is
 * the path of the file inside the APK.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Writer, stringPool, concat } from './binary.js';

const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const TABLE_HEADER_SIZE = 12;
const PACKAGE_HEADER_SIZE = 288;   /* includes typeIdOffset, added in Android O */
const CONFIG_SIZE = 64;            /* ResTable_config as emitted for API 26+ */
const TYPE_HEADER_SIZE = 20 + CONFIG_SIZE;
const TYPE_SPEC_HEADER_SIZE = 16;
const TYPE_STRING = 0x03;
const APP_PACKAGE_ID = 0x7f;

/**
 * @param {object} options
 * @param {string} options.packageName  application id, stored in the table
 * @param {Array<{type: string, name: string, value: string}>} options.resources
 * @returns {{bytes: Uint8Array, ids: Map<string, number>}}
 */
export function encodeArsc({ packageName, resources }) {
  if (!resources.length) throw new Error('resources.arsc needs at least one entry');

  /* Types keep first-appearance order; ids are 1-based within the package. */
  const types = [];
  const byType = new Map();
  for (const r of resources) {
    if (!byType.has(r.type)) {
      const entry = { name: r.type, id: types.length + 1, entries: [] };
      types.push(entry);
      byType.set(r.type, entry);
    }
    byType.get(r.type).entries.push(r);
  }

  const { chunk: valuePool, index: valueIndex } = stringPool(resources.map((r) => r.value));
  const { chunk: typePool } = stringPool(types.map((t) => t.name));
  const { chunk: keyPool, index: keyIndex } = stringPool(resources.map((r) => r.name));

  const ids = new Map();
  const chunks = [];

  for (const t of types) {
    const count = t.entries.length;

    const spec = new Writer(TYPE_SPEC_HEADER_SIZE + count * 4);
    spec.u16(RES_TABLE_TYPE_SPEC_TYPE).u16(TYPE_SPEC_HEADER_SIZE)
      .u32(TYPE_SPEC_HEADER_SIZE + count * 4);
    spec.u8(t.id).u8(0).u16(0);
    spec.u32(count);
    for (let i = 0; i < count; i += 1) spec.u32(0);   /* no spec flags */
    chunks.push(spec.done());

    /* Every entry is a fixed 16 bytes: ResTable_entry followed by Res_value. */
    const entryBytes = count * 16;
    const entriesStart = TYPE_HEADER_SIZE + count * 4;
    const total = entriesStart + entryBytes;
    const w = new Writer(total);
    w.u16(RES_TABLE_TYPE_TYPE).u16(TYPE_HEADER_SIZE).u32(total);
    w.u8(t.id).u8(0).u16(0);
    w.u32(count);
    w.u32(entriesStart);
    w.u32(CONFIG_SIZE);
    w.zeros(CONFIG_SIZE - 4);                        /* default configuration */
    for (let i = 0; i < count; i += 1) w.u32(i * 16);
    t.entries.forEach((r, i) => {
      w.u16(8).u16(0).u32(keyIndex.get(r.name));     /* size, flags, key */
      w.u16(8).u8(0).u8(TYPE_STRING).u32(valueIndex.get(r.value));
      ids.set(`${t.name}/${r.name}`, (APP_PACKAGE_ID << 24) | (t.id << 16) | i);
    });
    chunks.push(w.done());
  }

  const typeStringsAt = PACKAGE_HEADER_SIZE;
  const keyStringsAt = typeStringsAt + typePool.length;
  const body = concat([typePool, keyPool, ...chunks]);
  const packageSize = PACKAGE_HEADER_SIZE + body.length;

  const pkg = new Writer(packageSize);
  pkg.u16(RES_TABLE_PACKAGE_TYPE).u16(PACKAGE_HEADER_SIZE).u32(packageSize);
  pkg.u32(APP_PACKAGE_ID);
  pkg.utf16Fixed(packageName, 256);
  pkg.u32(typeStringsAt);
  pkg.u32(types.length);                             /* lastPublicType */
  pkg.u32(keyStringsAt);
  pkg.u32(Math.max(...types.map((t) => t.entries.length)));  /* lastPublicKey */
  pkg.u32(0);                                        /* typeIdOffset */
  pkg.bytes(body);

  const tableSize = TABLE_HEADER_SIZE + valuePool.length + packageSize;
  const table = new Writer(tableSize);
  table.u16(RES_TABLE_TYPE).u16(TABLE_HEADER_SIZE).u32(tableSize);
  table.u32(1);                                      /* one package */
  table.bytes(valuePool);
  table.bytes(pkg.done());

  return { bytes: table.done(), ids };
}
