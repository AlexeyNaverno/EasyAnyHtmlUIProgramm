/**
 * Minimal DER encoding, enough for a self-signed X.509 certificate.
 *
 * APK signature scheme v2 carries the signer's certificate, so assembling an
 * APK on a device needs one. The public key itself comes from Web Crypto as
 * SPKI, which avoids hand-encoding RSA parameters.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { concat, utf8Bytes } from './binary.js';

function lengthBytes(n) {
  if (n < 0x80) return new Uint8Array([n]);
  const out = [];
  let v = n;
  while (v > 0) { out.unshift(v & 0xff); v = Math.floor(v / 256); }
  return new Uint8Array([0x80 | out.length, ...out]);
}

export function tlv(tag, content) {
  return concat([new Uint8Array([tag]), lengthBytes(content.length), content]);
}

export const sequence = (...parts) => tlv(0x30, concat(parts));
export const set = (...parts) => tlv(0x31, concat(parts));

/** Positive INTEGER from a number. */
export function integer(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('integer() expects a non-negative integer');
  const bytes = [];
  let v = n;
  do { bytes.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, new Uint8Array(bytes));
}

/** Positive INTEGER from raw big-endian bytes. */
export function integerBytes(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let body = bytes.subarray(start);
  if (body[0] & 0x80) body = concat([new Uint8Array([0]), body]);
  return tlv(0x02, body);
}

export const nullValue = () => new Uint8Array([0x05, 0x00]);

export function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...stack);
  }
  return tlv(0x06, new Uint8Array(out));
}

export const bitString = (bytes) => tlv(0x03, concat([new Uint8Array([0]), bytes]));
export const octetString = (bytes) => tlv(0x04, bytes);
export const utf8String = (s) => tlv(0x0c, utf8Bytes(s));
export const printableString = (s) => tlv(0x13, utf8Bytes(s));
export const utcTime = (s) => tlv(0x17, utf8Bytes(s));
/** [n] EXPLICIT wrapper around already-encoded content. */
export const explicit = (n, content) => tlv(0xa0 | n, content);

export const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
export const OID_COMMON_NAME = '2.5.4.3';

export const sha256RsaAlg = () => sequence(oid(OID_SHA256_RSA), nullValue());

/**
 * Self-signed certificate suitable for APK signing. Android does not validate
 * the chain for installation; it only needs a well-formed certificate whose
 * public key matches the signature.
 *
 * @param {Uint8Array} spki        SubjectPublicKeyInfo from Web Crypto
 * @param {Uint8Array} serial      positive serial number bytes
 * @param {string} commonName
 * @returns {Promise<{tbs: Uint8Array, certificate: (signature: Uint8Array) => Uint8Array}>}
 */
export function buildTbsCertificate({ spki, serial, commonName = 'EasyApp' }) {
  const name = sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(commonName))));
  const validity = sequence(utcTime('200101000000Z'), utcTime('491231235959Z'));
  const tbs = sequence(
    explicit(0, integer(2)),        // version 3
    integerBytes(serial),
    sha256RsaAlg(),
    name,                           // issuer == subject: self-signed
    validity,
    name,
    spki,
  );
  return {
    tbs,
    certificate: (signature) => sequence(tbs, sha256RsaAlg(), bitString(signature)),
  };
}
