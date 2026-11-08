/**
 * API abstraction for the compiler UI.
 *
 * Server mode: talks to the local Node server, which can run native toolchains.
 * Standalone mode: runs the pure-JS core inside the compiled app (WebView) and
 * uses the easyapp bridge for file access. Native targets work there too when
 * the generic runtimes are embedded at build time: the hosts, installer and
 * Android DEX do not depend on the user's bundle, so packaging needs no Zig,
 * JDK or Android SDK on the device. Targets whose runtime is missing are
 * disabled with an explanation rather than failing silently.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  loadBundle, lintBundle, describeTargets, buildLlmPrompt,
  buildWwwTree, buildAndroidProject, normalizeTree, packZip, strToU8,
  packageWindows, packageLinux, packageApk, safeStem,
  identityToBase64, identityFromBase64,
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

/* ------------------------------------------------- embedded native runtimes */

const RUNTIME_FILES = {
  windowsX64: ['windows-host-x64.exe', 'windows-installer-x64.exe'],
  windowsX86: ['windows-host-x86.exe', 'windows-installer-x86.exe'],
  linuxX64: ['linux-host-x64'],
  android: ['android-runtime.dex'],
};

function decodeBase64(b64) {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

let runtimeCache = null;
function embeddedRuntimes() {
  if (runtimeCache) return runtimeCache;
  runtimeCache = new Map();
  for (const [name, b64] of Object.entries(globalThis.__EASYAPP_RUNTIMES__ || {})) {
    runtimeCache.set(name, decodeBase64(b64));
  }
  return runtimeCache;
}

const hasAll = (names) => names.every((n) => embeddedRuntimes().has(n));

/** Which targets this build of the app can finish on its own. */
function standaloneAvailability() {
  return {
    'windows-x64': hasAll(RUNTIME_FILES.windowsX64),
    'windows-x86': hasAll(RUNTIME_FILES.windowsX86),
    'windows-portable-x64': embeddedRuntimes().has('windows-host-x64.exe'),
    'linux-x64': hasAll(RUNTIME_FILES.linuxX64),
    'android-apk': hasAll(RUNTIME_FILES.android),
    'web-bundle': true,
    'source-project': true,
  };
}

/* The signing key must survive restarts or apps cannot be updated in place. */
const IDENTITY_FILE = 'signing-identity.json';

async function loadIdentity() {
  try {
    if (typeof window.easyapp !== 'undefined' && window.easyapp.privateFiles) {
      const text = await window.easyapp.privateFiles.readText(IDENTITY_FILE);
      return identityFromBase64(JSON.parse(text));
    }
    const text = localStorage.getItem('easyapp.signingIdentity');
    if (text) return identityFromBase64(JSON.parse(text));
  } catch { /* first run, or unreadable: a new key will be created */ }
  return null;
}

async function storeIdentity(identity) {
  const text = JSON.stringify(identityToBase64(identity));
  try {
    if (typeof window.easyapp !== 'undefined' && window.easyapp.privateFiles) {
      await window.easyapp.privateFiles.write(IDENTITY_FILE, enc.encode(text));
      return;
    }
    localStorage.setItem('easyapp.signingIdentity', text);
  } catch { /* storage may be unavailable; the APK is still produced */ }
}

/** Build a native artefact from embedded runtimes. Returns null if unsupported. */
async function buildNative(bundle, target, log) {
  const rt = embeddedRuntimes();
  if (target === 'windows-x64' || target === 'windows-x86' || target === 'windows-portable-x64') {
    const arch = target === 'windows-x86' ? 'x86' : 'x64';
    const kind = target === 'windows-portable-x64' ? 'portable' : 'installer';
    log.push(`Встроенный рантайм Windows ${arch}: компилятор не требуется`);
    return packageWindows(bundle, BRIDGE_JS, {
      host: rt.get(`windows-host-${arch}.exe`),
      installer: rt.get(`windows-installer-${arch}.exe`),
    }, { arch, kind });
  }
  if (target === 'linux-x64') {
    log.push('Встроенный рантайм Linux: компилятор не требуется');
    return packageLinux(bundle, BRIDGE_JS, { host: rt.get('linux-host-x64') }, { arch: 'x64' });
  }
  if (target === 'android-apk') {
    log.push('Встроенный рантайм Android: Android SDK не требуется');
    const identity = await loadIdentity();
    if (identity) log.push('Использую сохранённый ключ подписи');
    const res = await packageApk(bundle, BRIDGE_JS, {
      dex: rt.get('android-runtime.dex'), identity,
    });
    if (res.identityCreated) {
      await storeIdentity(res.identity);
      log.push('Создан ключ подписи и сохранён в приватных файлах приложения');
      log.push('Сохраните его: без этого ключа нельзя выпустить обновление приложения');
    }
    return res;
  }
  return null;
}

function standaloneApi() {
  return {
    mode: 'standalone',
    canBuildNative: Object.entries(standaloneAvailability())
      .some(([id, ok]) => ok && !['web-bundle', 'source-project'].includes(id)),
    availability: standaloneAvailability(),
    async targets() { return describeTargets(); },
    async doctor() {
      // Report the embedded runtime rather than pretending a toolchain exists.
      const a = standaloneAvailability();
      const embedded = (ok) => ({ available: ok, embedded: ok });
      return {
        zig: embedded(a['windows-x64'] || a['windows-x86']),
        java: embedded(a['android-apk']),
        androidSdk: embedded(a['android-apk']),
        gradle: embedded(a['android-apk']),
        cc: embedded(a['linux-x64']),
        webkit2gtk: embedded(a['linux-x64']),
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
        const bundle = loadBundle(bytes, { filename, overrides: cleanOverrides(overrides) });
        log.push(`Бандл: ${bundle.fileCount} файлов, точка входа ${bundle.entry}`);
        log.push(`Права: ${bundle.manifest.permissions.join(', ') || 'нет'}`);
        const issues = lintBundle(bundle);
        for (const i of issues) {
          log.push(`${i.level}: ${i.file}: ${i.message}`);
          if (i.level === 'error') throw new Error('Бандл не прошёл проверку');
        }

        if (!['web-bundle', 'source-project'].includes(target)) {
          if (!standaloneAvailability()[target]) {
            return {
              ok: false,
              error: 'В этой сборке приложения нет встроенного рантайма для выбранной цели. '
                + 'Соберите «Исходный проект» и запустите сборку на ПК или в GitHub Actions, '
                + 'либо возьмите релиз компилятора со встроенными рантаймами.',
              log,
            };
          }
          const res = await buildNative(bundle, target, log);
          for (const w of res.warnings || []) log.push(`warning: ${w}`);
          log.push(`Готово: ${res.filename}, ${(res.bytes.length / 1024).toFixed(1)} KiB`);
          const saved = await saveArtefact(res.filename, res.bytes);
          log.push(`Сохранено: ${saved.filename}`);
          return {
            ok: true, filename: res.filename, size: res.bytes.length, log,
            warnings: res.warnings || [], blobUrl: saved.blobUrl || null,
            savedNatively: !saved.blobUrl,
          };
        }

        const stem = safeStem(bundle.manifest.name);
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
