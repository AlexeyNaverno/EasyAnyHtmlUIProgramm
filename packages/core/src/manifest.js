/**
 * Manifest and permission directive parsing.
 *
 * Directives are HTML comments so that a plain `.html` file stays a valid,
 * previewable document in any browser:
 *
 *   <!-- easyapp:permission internet -->
 *   <!-- easyapp:permission files -->
 *   <!-- easyapp:name My Application -->
 *   <!-- easyapp:id org.example.myapp -->
 *
 * A JSON block is also accepted:
 *
 *   <!-- easyapp:config { "name": "My App", "permissions": ["internet"] } -->
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Every capability the runtime can expose. Unknown values are rejected. */
export const KNOWN_PERMISSIONS = Object.freeze(['internet', 'files']);

/** Permissions that are always available and never require a directive. */
export const IMPLICIT_PERMISSIONS = Object.freeze(['storage']);

const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const DIRECTIVE_RE = /^\s*easyapp:([a-z-]+)\s*([\s\S]*)$/i;

const DEFAULT_MANIFEST = Object.freeze({
  id: 'org.easyapp.app',
  name: 'EasyApp',
  version: '1.0.0',
  versionCode: 1,
  description: '',
  author: '',
  entry: 'index.html',
  permissions: [],
  orientation: 'unspecified',
  window: { width: 1024, height: 768, resizable: true },
});

export class ManifestError extends Error {
  constructor(message, { line = null, source = null } = {}) {
    super(message);
    this.name = 'ManifestError';
    this.line = line;
    this.source = source;
  }
}

/** Reverse-DNS application id, e.g. `org.example.myapp`. */
export function isValidAppId(id) {
  if (typeof id !== 'string') return false;
  const parts = id.split('.');
  if (parts.length < 2) return false;
  // Each Java/Android package segment must start with a letter and contain
  // only letters, digits and underscores (no keywords check: aapt tolerates it).
  return parts.every((p) => /^[A-Za-z][A-Za-z0-9_]*$/.test(p));
}

/** Semver-ish `1.2.3` (1-4 numeric components). */
export function isValidVersion(v) {
  return typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Extract `easyapp:` directives from HTML source.
 * Returns { directives, config } where config is the merged JSON block (if any).
 */
export function parseDirectives(html) {
  const directives = [];
  let config = null;

  for (const match of html.matchAll(COMMENT_RE)) {
    const body = match[1];
    const dm = DIRECTIVE_RE.exec(body);
    if (!dm) continue;

    const kind = dm[1].toLowerCase();
    const value = dm[2].trim();
    const line = lineOf(html, match.index);

    if (kind === 'config') {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch (err) {
        throw new ManifestError(
          `easyapp:config contains invalid JSON: ${err.message}`,
          { line, source: 'directive' },
        );
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ManifestError('easyapp:config must be a JSON object', {
          line,
          source: 'directive',
        });
      }
      config = config ? { ...config, ...parsed } : parsed;
      directives.push({ kind, value: '[object]', line });
      continue;
    }

    directives.push({ kind, value, line });
  }

  return { directives, config };
}

/**
 * Build a manifest from an optional config object plus HTML directives.
 * Directives win over the config file, because they sit next to the code.
 */
export function buildManifest({ html = '', config = null, overrides = null } = {}) {
  const { directives, config: inlineConfig } = parseDirectives(html);

  const manifest = {
    ...DEFAULT_MANIFEST,
    window: { ...DEFAULT_MANIFEST.window },
    permissions: [],
  };

  const warnings = [];
  const applyObject = (obj, origin) => {
    if (!obj) return;
    for (const [key, value] of Object.entries(obj)) {
      switch (key) {
        case 'permissions':
          if (!Array.isArray(value)) {
            throw new ManifestError('permissions must be an array', { source: origin });
          }
          for (const p of value) addPermission(manifest, p, origin, warnings);
          break;
        case 'window':
          if (value && typeof value === 'object') {
            manifest.window = { ...manifest.window, ...value };
          }
          break;
        case 'id':
        case 'name':
        case 'version':
        case 'description':
        case 'author':
        case 'entry':
        case 'orientation':
          manifest[key] = String(value);
          break;
        case 'versionCode': {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) {
            throw new ManifestError('versionCode must be a positive integer', { source: origin });
          }
          manifest.versionCode = n;
          break;
        }
        default:
          warnings.push(`Unknown manifest key "${key}" in ${origin} (ignored)`);
      }
    }
  };

  applyObject(config, 'config file');
  applyObject(inlineConfig, 'easyapp:config');

  for (const d of directives) {
    switch (d.kind) {
      case 'config':
        break;
      case 'permission':
        for (const p of d.value.split(/[\s,]+/).filter(Boolean)) {
          addPermission(manifest, p, `directive at line ${d.line}`, warnings);
        }
        break;
      case 'name':
      case 'id':
      case 'version':
      case 'description':
      case 'author':
      case 'entry':
      case 'orientation':
        manifest[d.kind] = d.value;
        break;
      case 'versioncode':
        manifest.versionCode = Number(d.value);
        break;
      default:
        warnings.push(`Unknown directive "easyapp:${d.kind}" at line ${d.line} (ignored)`);
    }
  }

  // Explicit UI overrides have the highest priority.
  if (overrides) {
    if (overrides.permissions) {
      manifest.permissions = [];
      for (const p of overrides.permissions) addPermission(manifest, p, 'UI override', warnings);
    }
    for (const key of ['id', 'name', 'version', 'entry', 'description', 'author']) {
      if (overrides[key] !== undefined && overrides[key] !== '') manifest[key] = overrides[key];
    }
    if (overrides.versionCode !== undefined) manifest.versionCode = Number(overrides.versionCode);
  }

  manifest.permissions = [...new Set(manifest.permissions)].sort();

  validateManifest(manifest);
  return { manifest, directives, warnings };
}

function addPermission(manifest, raw, origin, warnings) {
  const p = String(raw).trim().toLowerCase();
  if (!p) return;
  if (IMPLICIT_PERMISSIONS.includes(p)) {
    warnings.push(`Permission "${p}" is always granted; the directive in ${origin} is redundant`);
    return;
  }
  if (!KNOWN_PERMISSIONS.includes(p)) {
    throw new ManifestError(
      `Unknown permission "${p}" in ${origin}. Known: ${KNOWN_PERMISSIONS.join(', ')}`,
      { source: origin },
    );
  }
  if (!manifest.permissions.includes(p)) manifest.permissions.push(p);
}

export function validateManifest(manifest) {
  if (!isValidAppId(manifest.id)) {
    throw new ManifestError(
      `Invalid application id "${manifest.id}". Use reverse-DNS, e.g. org.example.myapp`,
      { source: 'manifest.id' },
    );
  }
  if (!isValidVersion(manifest.version)) {
    throw new ManifestError(
      `Invalid version "${manifest.version}". Use numeric form like 1.0.0`,
      { source: 'manifest.version' },
    );
  }
  if (!Number.isInteger(manifest.versionCode) || manifest.versionCode < 1) {
    throw new ManifestError('versionCode must be a positive integer', { source: 'manifest.versionCode' });
  }
  if (!manifest.name.trim()) {
    throw new ManifestError('Application name must not be empty', { source: 'manifest.name' });
  }
  if (!['unspecified', 'portrait', 'landscape'].includes(manifest.orientation)) {
    throw new ManifestError(
      `Invalid orientation "${manifest.orientation}". Use unspecified, portrait or landscape`,
      { source: 'manifest.orientation' },
    );
  }
  if (manifest.entry.startsWith('/') || manifest.entry.includes('..')) {
    throw new ManifestError('entry must be a relative path inside the bundle', { source: 'manifest.entry' });
  }
  return manifest;
}

export { DEFAULT_MANIFEST };
