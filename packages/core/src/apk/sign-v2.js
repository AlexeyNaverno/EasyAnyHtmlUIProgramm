/**
 * APK Signature Scheme v2.
 *
 * minSdk is 24 and v2 exists since Android 7.0, so a v2-only signature is
 * enough; targetSdk 34 actually requires v2 (a v1-only APK is rejected). That
 * removes the need for JAR signing and PKCS#7 on the device.
 *
 * Keys are generated per installation and kept by the caller, so apps signed by
 * different users do not share a key that ships inside an open-source binary.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Writer, concat } from './binary.js';
import { buildTbsCertificate } from './der.js';

const SIG_RSA_PKCS1_SHA256 = 0x0103;
const V2_BLOCK_ID = 0x7109871a;
const MAGIC = 'APK Sig Block 42';
const CHUNK_SIZE = 1024 * 1024;

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('Web Crypto is required to sign an APK');
  return c.subtle;
}

/** u32 little-endian length prefix, the encoding used throughout the block. */
function lp(bytes) {
  const w = new Writer(4 + bytes.length);
  w.u32(bytes.length).bytes(bytes);
  return w.done();
}

const lpSeq = (items) => lp(concat(items.map(lp)));

function u64(w, value) {
  w.u32(value >>> 0).u32(Math.floor(value / 0x100000000));
}

/**
 * Generate a signing identity. Persist all three fields to reuse it for
 * updates; losing it means the app can no longer be updated in place.
 */
export async function createSignerIdentity({ commonName = 'EasyApp' } = {}) {
  const s = subtle();
  const pair = await s.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify']);

  const pkcs8 = new Uint8Array(await s.exportKey('pkcs8', pair.privateKey));
  const spki = new Uint8Array(await s.exportKey('spki', pair.publicKey));

  const serial = new Uint8Array(16);
  globalThis.crypto.getRandomValues(serial);
  serial[0] &= 0x7f;                       // keep the INTEGER positive
  if (serial[0] === 0) serial[0] = 1;

  const { tbs, certificate } = buildTbsCertificate({ spki, serial, commonName });
  const signature = new Uint8Array(await s.sign('RSASSA-PKCS1-v1_5', pair.privateKey, tbs));
  return { pkcs8, spki, certificate: certificate(signature) };
}

async function importPrivateKey(pkcs8) {
  return subtle().importKey('pkcs8', pkcs8, {
    name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256',
  }, false, ['sign']);
}

/**
 * v2 content digest, per AOSP ApkSigningBlockUtils.computeOneMbChunkContentDigests:
 *
 *   1. Split each section into consecutive 1 MiB chunks. Empty sections
 *      contribute no chunks at all.
 *   2. chunkDigest = SHA-256(0xa5 || uint32le(chunk length) || chunk)
 *   3. digest = SHA-256(0x5a || uint32le(chunk count) || chunkDigests in order)
 *
 * The second level is easy to miss and produces a signature that apksigner
 * rejects with "CHUNKED_SHA256 digest mismatch". Hashing chunk by chunk also
 * keeps peak memory at one chunk instead of a copy of the whole APK.
 */
async function contentDigest(sections) {
  const s = subtle();
  const chunkDigests = [];
  for (const section of sections) {
    for (let at = 0; at < section.length; at += CHUNK_SIZE) {
      const chunk = section.subarray(at, Math.min(at + CHUNK_SIZE, section.length));
      const buf = new Uint8Array(5 + chunk.length);
      buf[0] = 0xa5;
      new DataView(buf.buffer).setUint32(1, chunk.length, true);
      buf.set(chunk, 5);
      chunkDigests.push(new Uint8Array(await s.digest('SHA-256', buf)));
    }
  }
  const top = new Uint8Array(5 + chunkDigests.length * 32);
  top[0] = 0x5a;
  new DataView(top.buffer).setUint32(1, chunkDigests.length, true);
  chunkDigests.forEach((d, i) => top.set(d, 5 + i * 32));
  return new Uint8Array(await s.digest('SHA-256', top));
}

/**
 * Sign an assembled APK.
 * @param {{bytes: Uint8Array, centralDirOffset: number, eocdOffset: number}} zip
 * @param {{pkcs8: Uint8Array, spki: Uint8Array, certificate: Uint8Array}} identity
 * @returns {Promise<Uint8Array>} the signed APK
 */
export async function signApkV2(zip, identity) {
  const { bytes, centralDirOffset, eocdOffset } = zip;
  const s = subtle();

  /*
   * The signing block is inserted at the original central-directory offset, so
   * for digest purposes the EOCD keeps pointing there. In the emitted file the
   * EOCD points past the block, which is how a verifier finds it.
   */
  const eocd = bytes.slice(eocdOffset);
  new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength)
    .setUint32(16, centralDirOffset, true);

  const digest = await contentDigest([
    bytes.subarray(0, centralDirOffset),
    bytes.subarray(centralDirOffset, eocdOffset),
    eocd,
  ]);

  const digestEntry = concat([new Writer(4).u32(SIG_RSA_PKCS1_SHA256).done(), lp(digest)]);
  const signedData = concat([
    lpSeq([digestEntry]),
    lpSeq([identity.certificate]),
    lpSeq([]),                            // no additional attributes
  ]);

  const key = await importPrivateKey(identity.pkcs8);
  const signature = new Uint8Array(await s.sign('RSASSA-PKCS1-v1_5', key, signedData));
  const signatureEntry = concat([new Writer(4).u32(SIG_RSA_PKCS1_SHA256).done(), lp(signature)]);

  const signer = concat([lp(signedData), lpSeq([signatureEntry]), lp(identity.spki)]);
  const value = lpSeq([signer]);

  const pair = new Writer(12 + value.length);
  u64(pair, 4 + value.length);
  pair.u32(V2_BLOCK_ID).bytes(value);
  const pairs = pair.done();

  const block = new Writer(pairs.length + 32);
  u64(block, pairs.length + 24);
  block.bytes(pairs);
  u64(block, pairs.length + 24);
  for (let i = 0; i < MAGIC.length; i += 1) block.u8(MAGIC.charCodeAt(i));
  const signingBlock = block.done();

  const outEocd = eocd.slice();
  new DataView(outEocd.buffer, outEocd.byteOffset, outEocd.byteLength)
    .setUint32(16, centralDirOffset + signingBlock.length, true);

  return concat([
    bytes.subarray(0, centralDirOffset),
    signingBlock,
    bytes.subarray(centralDirOffset, eocdOffset),
    outEocd,
  ]);
}

/** Serialise an identity for storage (all fields are plain bytes). */
export function identityToBase64(identity) {
  const enc = (b) => {
    let s = '';
    for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
    return btoa(s);
  };
  return {
    pkcs8: enc(identity.pkcs8),
    spki: enc(identity.spki),
    certificate: enc(identity.certificate),
  };
}

export function identityFromBase64(obj) {
  const dec = (s) => {
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  };
  return { pkcs8: dec(obj.pkcs8), spki: dec(obj.spki), certificate: dec(obj.certificate) };
}
