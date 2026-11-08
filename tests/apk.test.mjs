/**
 * APK assembly without the Android SDK.
 *
 * These tests parse the produced bytes back with an independent reader rather
 * than trusting the encoder, and verify the v2 signature with node:crypto.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strToU8 as fStrToU8 } from 'fflate';

import { encodeAxml, ATTR, str, int, bool, ref } from '../packages/core/src/apk/axml.js';
import { encodeArsc } from '../packages/core/src/apk/arsc.js';
import { writeZip } from '../packages/core/src/apk/zip.js';
import { buildAndroidManifest, MIN_SDK, TARGET_SDK, ACTIVITY } from '../packages/core/src/apk/manifest.js';
import { makeLauncherIcon, encodePng } from '../packages/core/src/apk/icon.js';
import { createSignerIdentity, signApkV2, identityToBase64, identityFromBase64 } from '../packages/core/src/apk/sign-v2.js';
import { packageApk } from '../packages/core/src/apk/assemble.js';
import { loadBundle, strToU8 } from '../packages/core/src/bundle.js';
import { readBridge } from '../packages/core/src/compiler.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MANIFEST = {
  id: 'org.test.app', name: 'Тест App', version: '1.2.3', versionCode: 7,
  orientation: 'portrait', permissions: ['internet'],
};

/* A structurally valid DEX header; CI builds the real one with Gradle. */
function fakeDex() {
  const d = new Uint8Array(112);
  d.set(fStrToU8('dex\n035\0'), 0);
  return d;
}

/* ------------------------------------------------------ independent readers */

function readChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let at = 8;                                   // skip the XML table header
  while (at < bytes.length) {
    const type = view.getUint16(at, true);
    const headerSize = view.getUint16(at + 2, true);
    const size = view.getUint32(at + 4, true);
    out.push({ type, headerSize, size, at });
    at += size;
  }
  return out;
}

function readStringPool(bytes, at) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint32(at + 8, true);
  const flags = v.getUint32(at + 16, true);
  const stringsStart = v.getUint32(at + 20, true);
  assert.ok(flags & 0x100, 'pool uses UTF-8');
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const off = at + stringsStart + v.getUint32(at + 28 + i * 4, true);
    let p = off;
    const skipLen = () => { const b = bytes[p]; p += 1; return (b & 0x80) ? ((b & 0x7f) << 8) | bytes[p++] : b; };
    skipLen();                                  // UTF-16 length
    const byteLen = skipLen();
    out.push(new TextDecoder().decode(bytes.subarray(p, p + byteLen)));
  }
  return out;
}

/* --------------------------------------------------------------- AXML */

test('AXML has a valid chunk stream and resource map', () => {
  const bytes = encodeAxml({
    name: 'manifest',
    attrs: [{ name: 'package', value: str('org.test'), android: false },
      { name: 'versionCode', value: int(3) }],
    children: [{ name: 'uses-sdk', attrs: [{ name: 'minSdkVersion', value: int(24) }] }],
  });
  const v = new DataView(bytes.buffer);
  assert.equal(v.getUint16(0, true), 0x0003, 'XML chunk type');
  assert.equal(v.getUint16(2, true), 8, 'XML header size');
  assert.equal(v.getUint32(4, true), bytes.length, 'declared size matches');

  const chunks = readChunks(bytes);
  assert.equal(chunks[0].type, 0x0001, 'string pool first');
  assert.equal(chunks[1].type, 0x0180, 'resource map second');
  assert.equal(chunks.at(-1).type, 0x0101, 'namespace closes last');

  const pool = readStringPool(bytes, chunks[0].at);
  const mapCount = (chunks[1].size - 8) / 4;
  // The first mapCount pool entries must be exactly the mapped attributes.
  for (let i = 0; i < mapCount; i += 1) {
    const id = v.getUint32(chunks[1].at + 8 + i * 4, true);
    assert.equal(id, ATTR[pool[i]], `map entry ${i} matches ${pool[i]}`);
  }
  assert.ok(pool.includes('versionCode'));
  assert.ok(!pool.slice(0, mapCount).includes('package'), 'package has no resource id');
});

test('AXML rejects an unknown Android attribute instead of emitting junk', () => {
  assert.throws(() => encodeAxml({
    name: 'manifest', attrs: [{ name: 'notAnAttribute', value: str('x') }],
  }), /Unknown Android attribute/);
});

/* --------------------------------------------------------------- arsc */

test('resources.arsc round-trips ids and values', () => {
  const { bytes, ids } = encodeArsc({
    packageName: 'org.test.app',
    resources: [
      { type: 'string', name: 'app_name', value: 'Тест App' },
      { type: 'drawable', name: 'ic_launcher', value: 'res/drawable/ic_launcher.png' },
    ],
  });
  const v = new DataView(bytes.buffer);
  assert.equal(v.getUint16(0, true), 0x0002, 'table chunk');
  assert.equal(v.getUint32(4, true), bytes.length);
  assert.equal(v.getUint32(8, true), 1, 'one package');

  const poolAt = 12;
  const poolSize = v.getUint32(poolAt + 4, true);
  const values = readStringPool(bytes, poolAt);
  assert.deepEqual(values, ['Тест App', 'res/drawable/ic_launcher.png']);

  const pkgAt = poolAt + poolSize;
  assert.equal(v.getUint16(pkgAt, true), 0x0200, 'package chunk');
  assert.equal(v.getUint16(pkgAt + 2, true), 288, 'package header size');
  assert.equal(v.getUint32(pkgAt + 8, true), 0x7f, 'application package id');

  assert.equal(ids.get('string/app_name'), 0x7f010000);
  assert.equal(ids.get('drawable/ic_launcher'), 0x7f020000);

  // Walk the type chunks and confirm each entry points at the right string.
  let at = pkgAt + 288;
  const pkgEnd = pkgAt + v.getUint32(pkgAt + 4, true);
  at += v.getUint32(at + 4, true);              // skip typeStrings pool
  at += v.getUint32(at + 4, true);              // skip keyStrings pool
  const seen = [];
  while (at < pkgEnd) {
    const type = v.getUint16(at, true);
    const size = v.getUint32(at + 4, true);
    if (type === 0x0201) {
      const count = v.getUint32(at + 12, true);
      const entriesStart = v.getUint32(at + 16, true);
      assert.equal(v.getUint32(at + 20, true), 64, 'config size');
      for (let i = 0; i < count; i += 1) {
        const e = at + entriesStart + v.getUint32(at + 84 + i * 4, true);
        assert.equal(v.getUint16(e, true), 8, 'entry size');
        assert.equal(v.getUint16(e + 8, true), 8, 'Res_value size');
        assert.equal(v.getUint8(e + 11), 3, 'value is a string');
        seen.push(values[v.getUint32(e + 12, true)]);
      }
    }
    at += size;
  }
  assert.deepEqual(seen, ['Тест App', 'res/drawable/ic_launcher.png']);
});

/* --------------------------------------------------------- manifest */

test('manifest grants INTERNET only when the permission is present', () => {
  const withNet = buildAndroidManifest(MANIFEST);
  const without = buildAndroidManifest({ ...MANIFEST, permissions: [] });
  const decode = (b) => new TextDecoder('utf-8', { fatal: false }).decode(b);
  assert.ok(decode(withNet.axml).includes('android.permission.INTERNET')
    || readStringPool(withNet.axml, 8).includes('android.permission.INTERNET'));
  assert.ok(!readStringPool(without.axml, 8).includes('android.permission.INTERNET'));
});

test('manifest carries sdk levels, activity and orientation', () => {
  const { axml } = buildAndroidManifest(MANIFEST);
  const pool = readStringPool(axml, 8);
  for (const s of ['manifest', 'uses-sdk', 'application', 'activity', 'intent-filter',
    ACTIVITY, 'android.intent.action.MAIN', 'android.intent.category.LAUNCHER',
    'minSdkVersion', 'targetSdkVersion', 'versionName', 'screenOrientation']) {
    assert.ok(pool.includes(s), `pool contains ${s}`);
  }
  assert.equal(MIN_SDK, 24);
  assert.equal(TARGET_SDK, 34);

  // Find the versionCode attribute and check its typed value.
  const v = new DataView(axml.buffer);
  const chunks = readChunks(axml);
  const mapCount = (chunks[1].size - 8) / 4;
  const vcIndex = pool.indexOf('versionCode');
  assert.ok(vcIndex < mapCount);
  let found = null;
  for (const c of chunks.filter((c) => c.type === 0x0102)) {
    const attrCount = v.getUint16(c.at + 16 + 12, true);
    for (let i = 0; i < attrCount; i += 1) {
      const a = c.at + 16 + 20 + i * 20;
      if (v.getUint32(a + 4, true) === vcIndex) {
        found = { type: v.getUint8(a + 15), data: v.getUint32(a + 16, true) };
      }
    }
  }
  assert.deepEqual(found, { type: 0x10, data: 7 }, 'versionCode is a decimal int');
});

/* ------------------------------------------------------------- icon */

test('launcher icon is a well-formed PNG', () => {
  const png = makeLauncherIcon(48);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(png.buffer, png.byteOffset);
  assert.equal(v.getUint32(8, false), 13, 'IHDR length');
  assert.equal(v.getUint32(16, false), 48, 'width');
  assert.equal(v.getUint32(20, false), 48, 'height');
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 6, 'RGBA');
  assert.equal(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4)), 'IEND');
});

test('PNG encoder accepts arbitrary pixels', () => {
  const png = encodePng(2, 2, new Uint8Array(16).fill(255));
  assert.ok(png.length > 40);
});

/* -------------------------------------------------------------- zip */

test('zip aligns stored entries and keeps CRCs valid', () => {
  const entries = [
    { name: 'AndroidManifest.xml', data: strToU8('<manifest/>'.repeat(20)) },
    { name: 'resources.arsc', data: new Uint8Array(751).fill(7), store: true },
    { name: 'assets/www/index.html', data: strToU8('<html>hi</html>') },
  ];
  const { bytes } = writeZip(entries);
  const files = unzipSync(bytes);              // independent CRC + inflate check
  assert.deepEqual(Object.keys(files).sort(), entries.map((e) => e.name).sort());
  assert.deepEqual(files['resources.arsc'], entries[1].data);

  const v = new DataView(bytes.buffer, bytes.byteOffset);
  let at = 0;
  while (v.getUint32(at, true) === 0x04034b50) {
    const method = v.getUint16(at + 8, true);
    const compSize = v.getUint32(at + 18, true);
    const nameLen = v.getUint16(at + 26, true);
    const extraLen = v.getUint16(at + 28, true);
    const dataAt = at + 30 + nameLen + extraLen;
    if (method === 0) assert.equal(dataAt % 4, 0, 'stored entry is 4-byte aligned');
    at = dataAt + compSize;
  }
});

/* ------------------------------------------------------------- sign */

test('v2 signature verifies and the content digest matches', async () => {
  const identity = await createSignerIdentity({ commonName: 'Unit Test' });
  const zip = writeZip([
    { name: 'AndroidManifest.xml', data: strToU8('manifest-bytes') },
    { name: 'resources.arsc', data: new Uint8Array(300).fill(1), store: true },
  ]);
  const apk = await signApkV2(zip, identity);

  const v = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  const eocdAt = apk.length - 22;
  assert.equal(v.getUint32(eocdAt, true), 0x06054b50);
  const cdOffset = v.getUint32(eocdAt + 16, true);
  assert.equal(new TextDecoder().decode(apk.subarray(cdOffset - 16, cdOffset)), 'APK Sig Block 42');

  const readU64 = (at) => Number(v.getBigUint64(at, true));
  const sizeTail = readU64(cdOffset - 24);
  const blockStart = cdOffset - (sizeTail + 8);
  assert.equal(readU64(blockStart), sizeTail, 'both size fields agree');

  let at = blockStart + 8;
  const pairLen = readU64(at); at += 8;
  assert.equal(v.getUint32(at, true), 0x7109871a, 'v2 block id');
  at += 4;
  const value = apk.subarray(at, at + pairLen - 4);

  const dv = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const rd = (b, d, i) => { const n = d.getUint32(i, true); return [b.subarray(i + 4, i + 4 + n), i + 4 + n]; };
  const vv = dv;
  let [signers] = rd(value, vv, 0);
  const sv = new DataView(signers.buffer, signers.byteOffset, signers.byteLength);
  let [signer] = rd(signers, sv, 0);
  const gv = new DataView(signer.buffer, signer.byteOffset, signer.byteLength);
  let [signedData, j] = rd(signer, gv, 0);
  let [sigs] = rd(signer, gv, j);
  const sg = new DataView(sigs.buffer, sigs.byteOffset, sigs.byteLength);
  let [sig0] = rd(sigs, sg, 0);
  const s0 = new DataView(sig0.buffer, sig0.byteOffset, sig0.byteLength);
  assert.equal(s0.getUint32(0, true), 0x0103, 'RSA PKCS1 SHA-256');
  const [sigBytes] = rd(sig0, s0, 4);

  const cert = new X509Certificate(Buffer.from(identity.certificate));
  assert.match(cert.subject, /CN=Unit Test/);
  const key = cert.publicKey;
  assert.ok(cryptoVerify('sha256', Buffer.from(signedData), key, Buffer.from(sigBytes)),
    'signature over signed-data verifies');

  // Recompute the chunked content digest independently.
  const dv2 = new DataView(signedData.buffer, signedData.byteOffset, signedData.byteLength);
  let [digests] = rd(signedData, dv2, 0);
  const dd = new DataView(digests.buffer, digests.byteOffset, digests.byteLength);
  let [d0] = rd(digests, dd, 0);
  const d0v = new DataView(d0.buffer, d0.byteOffset, d0.byteLength);
  const [claimed] = rd(d0, d0v, 4);

  const patched = apk.slice(eocdAt);
  new DataView(patched.buffer, patched.byteOffset).setUint32(16, blockStart, true);
  const h = createHash('sha256');
  for (const section of [apk.subarray(0, blockStart), apk.subarray(cdOffset, eocdAt), patched]) {
    for (let i = 0; i < section.length; i += 1 << 20) {
      const chunk = section.subarray(i, Math.min(i + (1 << 20), section.length));
      const prefix = Buffer.alloc(5);
      prefix[0] = 0xa5;
      prefix.writeUInt32LE(chunk.length, 1);
      h.update(prefix);
      h.update(chunk);
    }
  }
  assert.deepEqual(new Uint8Array(h.digest()), claimed, 'content digest matches');
});

test('identity survives base64 storage and can sign again', async () => {
  const identity = await createSignerIdentity();
  const restored = identityFromBase64(JSON.parse(JSON.stringify(identityToBase64(identity))));
  assert.deepEqual(restored.certificate, identity.certificate);
  const zip = writeZip([{ name: 'a.txt', data: strToU8('x') }]);
  const a = await signApkV2(zip, identity);
  const b = await signApkV2(zip, restored);
  assert.deepEqual(a, b, 'same key produces the same signature');
});

/* --------------------------------------------------------- assemble */

test('packageApk produces the entries Android needs', async () => {
  const bundle = loadBundle(strToU8(
    '<!-- easyapp:name Тест App --><!-- easyapp:id org.test.app -->'
    + '<!-- easyapp:permission internet --><html><body>hi</body></html>',
  ), { filename: 'index.html' });
  const res = await packageApk(bundle, readBridge(), { dex: fakeDex() });
  // Cyrillic collapses to an underscore, the Latin part survives.
  assert.equal(res.filename, '__App.apk');
  assert.ok(res.identityCreated);
  const files = unzipSync(res.bytes);
  for (const name of ['AndroidManifest.xml', 'classes.dex', 'resources.arsc',
    'res/drawable/ic_launcher.png', 'assets/www/index.html',
    'assets/www/__easyapp_bridge.js', 'assets/www/__easyapp_manifest.json']) {
    assert.ok(files[name], `APK contains ${name}`);
  }
  assert.deepEqual(files['classes.dex'], fakeDex());
  const manifest = JSON.parse(new TextDecoder().decode(files['assets/www/__easyapp_manifest.json']));
  assert.deepEqual(manifest.permissions, ['internet']);
});

test('packageApk rejects a missing or malformed DEX', async () => {
  const bundle = loadBundle(strToU8('<html>x</html>'), { filename: 'index.html' });
  await assert.rejects(() => packageApk(bundle, readBridge(), {}), /DEX is missing/);
  await assert.rejects(() => packageApk(bundle, readBridge(), { dex: strToU8('not a dex file') }),
    /not a DEX file/);
});

test('APK modules stay browser-safe', () => {
  for (const f of ['binary', 'axml', 'arsc', 'manifest', 'icon', 'zip', 'sign-v2', 'assemble', 'der']) {
    const src = readFileSync(join(ROOT, `packages/core/src/apk/${f}.js`), 'utf8');
    assert.ok(!/from\s+'node:/.test(src), `${f}.js must not import node builtins`);
  }
});

/* ------------------------------------------- compile() integration */

test('compile() takes the prebuilt Android path without any SDK', async () => {
  const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const { compile } = await import('../packages/core/src/compiler.js');

  const rt = mkdtempSync(pjoin(tmpdir(), 'easyapp-rt-test-'));
  const out = mkdtempSync(pjoin(tmpdir(), 'easyapp-out-test-'));
  const keyFile = pjoin(rt, 'identity.json');
  const savedRt = process.env.EASYAPP_RUNTIMES;
  const savedKey = process.env.EASYAPP_SIGNING_IDENTITY;
  const savedHome = process.env.ANDROID_HOME;
  try {
    writeFileSync(pjoin(rt, 'android-runtime.dex'), fakeDex());
    process.env.EASYAPP_RUNTIMES = rt;
    process.env.EASYAPP_SIGNING_IDENTITY = keyFile;
    delete process.env.ANDROID_HOME;          // prove no SDK is consulted

    const input = strToU8('<!-- easyapp:name Prebuilt App -->'
      + '<!-- easyapp:id org.prebuilt.app --><html><body>x</body></html>');
    const logs = [];
    const res = await compile(input, {
      filename: 'index.html', target: 'android-apk', outDir: out, onLog: (m) => logs.push(m),
    });
    assert.equal(res.runtimeSource, 'prebuilt');
    assert.equal(res.filename, 'Prebuilt_App.apk');
    assert.ok(logs.some((l) => /no SDK needed/.test(l)), 'logs explain the fast path');
    assert.ok(existsSync(keyFile), 'signing key was persisted');
    const files = unzipSync(res.bytes);
    assert.ok(files['classes.dex']);
    assert.ok(files['assets/www/index.html']);

    // A second build must reuse the key so the app can be updated in place.
    const second = await compile(input, {
      filename: 'index.html', target: 'android-apk', outDir: out, onLog: () => {},
    });
    assert.deepEqual(second.bytes, res.bytes, 'same key and input give a reproducible APK');
  } finally {
    if (savedRt === undefined) delete process.env.EASYAPP_RUNTIMES; else process.env.EASYAPP_RUNTIMES = savedRt;
    if (savedKey === undefined) delete process.env.EASYAPP_SIGNING_IDENTITY; else process.env.EASYAPP_SIGNING_IDENTITY = savedKey;
    if (savedHome !== undefined) process.env.ANDROID_HOME = savedHome;
    rmSync(rt, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
