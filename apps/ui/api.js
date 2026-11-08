/**
 * API abstraction for the compiler UI.
 *
 * Server mode: talks to the local Node server, which can run native toolchains.
 * Standalone mode: runs the pure-JS core inside the compiled app (WebView) and
 * uses the easyapp bridge for file access. Native targets are unavailable there
 * and the UI explains why instead of failing silently.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  loadBundle, lintBundle, describeTargets, buildLlmPrompt,
  buildWwwTree, buildAndroidProject, normalizeTree, packZip, strToU8,
} from './core-browser.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/* --------------------------------------------------------- server mode */

function serverApi() {
  return {
    mode: 'server',
    canBuildNative: true,
    async targets() {
      const res = await fetch('/api/targets');
      return (await res.json()).targets;
    },
    async doctor() {
      const res = await fetch('/api/doctor');
      return res.json();
    },
    async prompt(lang) {
      const res = await fetch(`/api/prompt?lang=${encodeURIComponent(lang)}`);
      return (await res.json()).prompt;
    },
    async inspect(bytes, filename, overrides) {
      const res = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'x-filename': filename, 'x-overrides': JSON.stringify(overrides || {}) },
        body: bytes,
      });
      return res.json();
    },
    async build(bytes, filename, target, overrides) {
      const res = await fetch('/api/build', {
        method: 'POST',
        headers: {
          'x-filename': filename,
          'x-target': target,
          'x-overrides': JSON.stringify(overrides || {}),
        },
        body: bytes,
      });
      return res.json();
    },
  };
}

/* ----------------------------------------------------- standalone mode */

/** Templates are embedded at build time by scripts/build-ui.mjs. */
function templateTree() {
  const raw = globalThis.__EASYAPP_TEMPLATES__ || {};
  const files = new Map();
  for (const [name, b64] of Object.entries(raw)) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    files.set(name, bytes);
  }
  return files;
}

const BRIDGE_JS = globalThis.__EASYAPP_BRIDGE_SOURCE__ || '';

function inspectBundle(bytes, filename, overrides) {
  const bundle = loadBundle(bytes, { filename, overrides: cleanOverrides(overrides) });
  return {
    ok: true,
    manifest: bundle.manifest,
    entry: bundle.entry,
    fileCount: bundle.fileCount,
    totalBytes: bundle.totalBytes,
    sourceKind: bundle.sourceKind,
    directives: bundle.directives,
    warnings: bundle.warnings,
    issues: lintBundle(bundle),
  };
}

function cleanOverrides(overrides) {
  if (!overrides) return null;
  const out = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0 && k !== 'permissions') continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

async function saveArtefact(filename, bytes) {
  // Prefer the native save dialog; fall back to a browser download.
  if (typeof window.easyapp !== 'undefined' && window.easyapp.hasPermission('files')) {
    await window.easyapp.files.export(filename, bytes);
    return { saved: true, filename };
  }
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { saved: true, filename, blobUrl: url };
}

function standaloneApi() {
  return {
    mode: 'standalone',
    canBuildNative: false,
    async targets() { return describeTargets(); },
    async doctor() {
      return {
        zig: { available: false }, java: { available: false },
        androidSdk: { available: false }, gradle: { available: false },
        cc: { available: false }, webkit2gtk: { available: false },
        standalone: true,
      };
    },
    async prompt(lang) { return buildLlmPrompt({ lang }); },
    async inspect(bytes, filename, overrides) {
      try {
        return inspectBundle(bytes, filename, overrides);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    async build(bytes, filename, target, overrides) {
      const log = [];
      try {
        if (!['web-bundle', 'source-project'].includes(target)) {
          return {
            ok: false,
            error: 'Нативная сборка недоступна в приложении-компиляторе: на устройстве нет '
              + 'Zig, JDK и Android SDK. Соберите «Исходный проект» и запустите сборку на ПК '
              + 'или в GitHub Actions. На ПК запустите: npm run serve',
            log,
          };
        }
        const bundle = loadBundle(bytes, { filename, overrides: cleanOverrides(overrides) });
        log.push(`Бандл: ${bundle.fileCount} файлов, точка входа ${bundle.entry}`);
        log.push(`Права: ${bundle.manifest.permissions.join(', ') || 'нет'}`);
        const issues = lintBundle(bundle);
        for (const i of issues) {
          log.push(`${i.level}: ${i.file}: ${i.message}`);
          if (i.level === 'error') throw new Error('Бандл не прошёл проверку');
        }

        const stem = (bundle.manifest.name || 'EasyApp').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
        let files;
        let outName;
        if (target === 'web-bundle') {
          files = normalizeTree(buildWwwTree(bundle, BRIDGE_JS)).files;
          outName = `${stem}-web.zip`;
        } else {
          const templates = templateTree();
          const android = buildAndroidProject(bundle, BRIDGE_JS, new Map());
          files = new Map();
          for (const [n, d] of templates) files.set(`android/${n}`, d);
          for (const [n, d] of android.files) files.set(`android/${n}`, d);
          files.set('README.md', strToU8(
            `# ${bundle.manifest.name}\n\n`
            + 'Сгенерировано приложением-компилятором EasyAnyHtmlUIProgramm.\n\n'
            + 'Сборка Android: `cd android && ./gradlew assembleDebug`\n'
            + 'Сборка на ПК: используйте CLI из репозитория проекта.\n',
          ));
          outName = `${stem}-source.zip`;
        }
        const zip = packZip(files);
        log.push(`Упаковано ${files.size} файлов, ${(zip.length / 1024).toFixed(1)} KiB`);
        const saved = await saveArtefact(outName, zip);
        log.push(`Сохранено: ${saved.filename}`);
        return {
          ok: true, filename: outName, size: zip.length, log, warnings: [],
          blobUrl: saved.blobUrl || null, savedNatively: !saved.blobUrl,
        };
      } catch (err) {
        return { ok: false, error: err.message, log };
      }
    },
    async pickFile() {
      if (typeof window.easyapp !== 'undefined' && window.easyapp.hasPermission('files')) {
        const picked = await window.easyapp.files.import({ accept: '*/*' });
        if (!picked) return null;
        return { name: picked.name, bytes: picked.data };
      }
      return null; // fall back to the HTML file input
    },
  };
}

/* ---------------------------------------------------------- detection */

export async function createApi() {
  // A compiled app has the native bridge and no HTTP server.
  if (typeof window.easyapp !== 'undefined') return standaloneApi();
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.service === 'easyapp-compiler') return serverApi();
    }
  } catch { /* no server */ }
  return standaloneApi();
}
