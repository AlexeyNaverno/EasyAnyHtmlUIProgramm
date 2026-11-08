/**
 * Android binary XML (AXML) encoder.
 *
 * Produces the compiled AndroidManifest.xml that PackageManager reads. Written
 * from the format described by AOSP's ResourceTypes.h so APK assembly needs no
 * aapt2 on the device.
 *
 * Attribute resource ids were taken from AOSP public-final.xml
 * (frameworks/base/core/res/res/values), not guessed.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Writer, stringPool, concat } from './binary.js';

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

export const ATTR = {
  theme: 0x01010000,
  label: 0x01010001,
  icon: 0x01010002,
  name: 0x01010003,
  permission: 0x01010006,
  protectionLevel: 0x01010009,
  debuggable: 0x0101000f,
  exported: 0x01010010,
  screenOrientation: 0x0101001e,
  configChanges: 0x0101001f,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
  allowBackup: 0x01010280,
  required: 0x0101028e,
  hardwareAccelerated: 0x010102d3,
  supportsRtl: 0x010103af,
  extractNativeLibs: 0x010104ea,
  usesCleartextTraffic: 0x010104ec,
  roundIcon: 0x0101052c,
  appCategory: 0x01010545,
  compileSdkVersion: 0x01010572,
  compileSdkVersionCodename: 0x01010573,
};

const RES_XML_TYPE = 0x0003;
const RES_XML_START_NAMESPACE = 0x0100;
const RES_XML_END_NAMESPACE = 0x0101;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const RES_XML_RESOURCE_MAP = 0x0180;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;
const NO_ENTRY = 0xffffffff;

/* Attribute value constructors. */
export const str = (value) => ({ kind: 'string', value: String(value) });
export const int = (value) => ({ kind: 'int', value: value | 0 });
export const hex = (value) => ({ kind: 'hex', value: value >>> 0 });
export const bool = (value) => ({ kind: 'bool', value: Boolean(value) });
export const ref = (value) => ({ kind: 'ref', value: value >>> 0 });

/**
 * @param {object} root  { name, attrs: [{ name, value, android?:bool }], children: [] }
 * @returns {Uint8Array} compiled AXML
 */
export function encodeAxml(root) {
  /*
   * The resource map is indexed by string-pool index, so every attribute name
   * that has a resource id must occupy the first slots of the pool.
   */
  const attrNames = [];
  const others = [];
  const seenAttr = new Set();
  const seenOther = new Set();
  const pushOther = (s) => { if (!seenOther.has(s)) { seenOther.add(s); others.push(s); } };

  pushOther('android');
  pushOther(ANDROID_NS);

  const walk = (el) => {
    pushOther(el.name);
    for (const a of el.attrs || []) {
      if (a.android !== false) {
        if (ATTR[a.name] === undefined) throw new Error(`Unknown Android attribute: ${a.name}`);
        if (!seenAttr.has(a.name)) { seenAttr.add(a.name); attrNames.push(a.name); }
      } else pushOther(a.name);
      if (a.value && a.value.kind === 'string') pushOther(a.value.value);
    }
    for (const c of el.children || []) walk(c);
  };
  walk(root);

  const { chunk: pool, index } = stringPool([...attrNames, ...others]);
  const idx = (s) => {
    const i = index.get(s);
    if (i === undefined) throw new Error(`String missing from pool: ${s}`);
    return i;
  };

  const parts = [pool];

  const map = new Writer(attrNames.length * 4 + 8);
  map.u16(RES_XML_RESOURCE_MAP).u16(8).u32(8 + attrNames.length * 4);
  for (const n of attrNames) map.u32(ATTR[n]);
  parts.push(map.done());

  const nsPrefix = idx('android');
  const nsUri = idx(ANDROID_NS);

  const node = (w, type) => { w.u16(type).u16(16); };

  const startNs = new Writer(24);
  node(startNs, RES_XML_START_NAMESPACE);
  startNs.u32(24);                       // chunk size
  startNs.u32(1).u32(NO_ENTRY);          // lineNumber, comment
  startNs.u32(nsPrefix).u32(nsUri);
  parts.push(startNs.done());

  const emit = (el) => {
    const attrs = el.attrs || [];
    const size = 16 + 20 + attrs.length * 20;
    const w = new Writer(size);
    node(w, RES_XML_START_ELEMENT);
    w.u32(size);
    w.u32(1).u32(NO_ENTRY);              // lineNumber, comment
    w.u32(NO_ENTRY).u32(idx(el.name));   // element namespace, name
    w.u16(20);                           // attributeStart (relative to attrExt)
    w.u16(20);                           // attributeSize
    w.u16(attrs.length);
    w.u16(0).u16(0).u16(0);              // idIndex, classIndex, styleIndex

    for (const a of attrs) {
      const android = a.android !== false;
      w.u32(android ? nsUri : NO_ENTRY);
      w.u32(idx(a.name));
      const v = a.value;
      let raw = NO_ENTRY;
      let dataType;
      let data;
      switch (v.kind) {
        case 'string': dataType = TYPE_STRING; data = idx(v.value); raw = data; break;
        case 'int': dataType = TYPE_INT_DEC; data = v.value >>> 0; break;
        case 'hex': dataType = TYPE_INT_HEX; data = v.value >>> 0; break;
        case 'bool': dataType = TYPE_INT_BOOLEAN; data = v.value ? 0xffffffff : 0; break;
        case 'ref': dataType = TYPE_REFERENCE; data = v.value >>> 0; break;
        default: throw new Error(`Unsupported attribute value kind: ${v.kind}`);
      }
      w.u32(raw);
      w.u16(8).u8(0).u8(dataType).u32(data);
    }
    parts.push(w.done());

    for (const c of el.children || []) emit(c);

    const e = new Writer(24);
    node(e, RES_XML_END_ELEMENT);
    e.u32(24);
    e.u32(1).u32(NO_ENTRY);
    e.u32(NO_ENTRY).u32(idx(el.name));
    parts.push(e.done());
  };
  emit(root);

  const endNs = new Writer(24);
  node(endNs, RES_XML_END_NAMESPACE);
  endNs.u32(24);
  endNs.u32(1).u32(NO_ENTRY);
  endNs.u32(nsPrefix).u32(nsUri);
  parts.push(endNs.done());

  const body = concat(parts);
  const head = new Writer(8);
  head.u16(RES_XML_TYPE).u16(8).u32(8 + body.length);
  return concat([head.done(), body]);
}
