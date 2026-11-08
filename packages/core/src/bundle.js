/**
 * Bundle loading: accepts a single .html file or a .zip archive and produces a
 * normalised in-memory file tree plus a parsed manifest.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { buildManifest, ManifestError } from './manifest.js';

const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MiB uncompressed
const MAX_FILE_COUNT = 20000;

const CONFIG_NAMES = ['easyapp.json', 'app.json'];

export class BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleError';
  }
}

/** Reject absolute paths, traversal, backslashes and drive letters. */
export function normalizeBundlePath(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new BundleError('Empty file name in archive');
  }
  const cleaned = name.replace(/\\/g, '/');
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) {
    throw new BundleError(`Absolute path in archive is not allowed: ${name}`);
  }
  const parts = [];
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new BundleError(`Path traversal in archive is not allowed: ${name}`);
    }
    parts.push(segment);
  }
  if (parts.length === 0) throw new BundleError(`Invalid path in archive: ${name}`);
  return parts.join('/');
}

function detectEntry(files, preferred) {
  if (preferred && files.has(preferred)) return preferred;
  if (preferred && !files.has(preferred)) {
    // The manifest pointed at a missing file: report it rather than silently guessing.
    throw new BundleError(`Entry file "${preferred}" was not found in the bundle`);
  }
  if (files.has('index.html')) return 'index.html';
  const htmlFiles = [...files.keys()].filter((p) => p.toLowerCase().endsWith('.html'));
  if (htmlFiles.length === 0) {
    throw new BundleError('No .html file found in the bundle');
  }
  // Prefer the shallowest HTML file, then the shortest name.
  htmlFiles.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  return htmlFiles[0];
}

/**
 * Load a bundle from raw bytes.
 * @param {Uint8Array} bytes
 * @param {{filename?: string, overrides?: object}} options
 */
export function loadBundle(bytes, { filename = '', overrides = null } = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length === 0) throw new BundleError('Input file is empty');

  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  /** @type {Map<string, Uint8Array>} */
  let files = new Map();
  let sourceKind;

  if (isZip) {
    sourceKind = 'zip';
    let unzipped;
    try {
      unzipped = unzipSync(bytes);
    } catch (err) {
      throw new BundleError(`Cannot read ZIP archive: ${err.message}`);
    }
    const names = Object.keys(unzipped).filter((n) => !n.endsWith('/'));
    if (names.length > MAX_FILE_COUNT) {
      throw new BundleError(`Too many files in archive (${names.length} > ${MAX_FILE_COUNT})`);
    }
    let total = 0;
    for (const rawName of names) {
      const data = unzipped[rawName];
      total += data.length;
      if (total > MAX_TOTAL_BYTES) {
        throw new BundleError('Archive expands beyond the 200 MiB limit');
      }
      const name = normalizeBundlePath(rawName);
      if (files.has(name)) {
        throw new BundleError(`Duplicate file path in archive: ${name}`);
      }
      files.set(name, data);
    }
    files = stripCommonPrefix(files);
  } else {
    sourceKind = 'html';
    const text = strFromU8(bytes);
    if (!/<html[\s>]|<!doctype html|<body[\s>]|<!--/i.test(text)) {
      throw new BundleError('Input is neither a ZIP archive nor an HTML document');
    }
    const base = (filename || 'index.html').split(/[\\/]/).pop();
    const name = /\.x?html?$/i.test(base) ? base : 'index.html';
    files.set(name, bytes);
  }

  // Optional JSON config inside the bundle.
  let config = null;
  let configPath = null;
  for (const candidate of CONFIG_NAMES) {
    if (files.has(candidate)) {
      try {
        config = JSON.parse(strFromU8(files.get(candidate)));
      } catch (err) {
        throw new ManifestError(`${candidate} is not valid JSON: ${err.message}`, { source: candidate });
      }
      configPath = candidate;
      break;
    }
  }

  const provisionalEntry = overrides?.entry || config?.entry || null;
  let entry;
  if (provisionalEntry) {
    entry = detectEntry(files, normalizeBundlePath(provisionalEntry));
  } else {
    entry = detectEntry(files, null);
  }

  const entryHtml = strFromU8(files.get(entry));
  // Seed the detected entry as the base so a single file named something other
  // than index.html does not fall back to the manifest default. An explicit
  // config/directive/override still wins because it is applied afterwards.
  const { manifest, directives, warnings } = buildManifest({
    html: entryHtml,
    config: { entry, ...(config || {}) },
    overrides,
  });

  // Re-check the entry after directives may have changed it.
  if (manifest.entry !== entry) {
    const resolved = normalizeBundlePath(manifest.entry);
    if (!files.has(resolved)) {
      throw new BundleError(`Entry file "${resolved}" was not found in the bundle`);
    }
    entry = resolved;
  }
  manifest.entry = entry;

  let totalBytes = 0;
  for (const data of files.values()) totalBytes += data.length;

  return {
    files,
    manifest,
    directives,
    warnings,
    entry,
    sourceKind,
    configPath,
    totalBytes,
    fileCount: files.size,
  };
}

/**
 * ZIP archives often wrap everything in a single top-level folder.
 * Strip it so `myapp/index.html` becomes `index.html`.
 */
function stripCommonPrefix(files) {
  if (files.size === 0) return files;
  const names = [...files.keys()];
  const firstSegments = new Set(names.map((n) => n.split('/')[0]));
  if (firstSegments.size !== 1) return files;
  const prefix = [...firstSegments][0];
  if (!names.every((n) => n.startsWith(`${prefix}/`))) return files;
  const stripped = new Map();
  for (const [name, data] of files) stripped.set(name.slice(prefix.length + 1), data);
  return stripped;
}

/** Serialise a file tree back into a ZIP archive. */
export function packZip(files, options = {}) {
  const obj = {};
  const level = options.level ?? 6;
  for (const [name, data] of files) {
    if (typeof data === 'string') {
      obj[name] = [strToU8(data), { level, mtime: EPOCH }];
      continue;
    }
    // fflate interprets any non-Uint8Array object as a nested directory. Values
    // arriving from another realm (e.g. a WebView) fail its instanceof check,
    // so normalise defensively instead of emitting "file/0/", "file/1/" entries.
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    obj[name] = [bytes, { level, mtime: EPOCH }];
  }
  return zipSync(obj, { level });
}

const EPOCH = new Date('1980-01-01T00:00:00Z');

export { strToU8, strFromU8 };
