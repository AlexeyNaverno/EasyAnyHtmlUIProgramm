/**
 * UI tests in a simulated DOM. Covers both the server mode and the standalone
 * mode used by the compiled compiler app (APK/EXE), including the native
 * bridge mock.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { webcrypto } from 'node:crypto';
import { unzipSync, strToU8 } from 'fflate';

const UI_HTML = readFileSync('apps/ui/index.html', 'utf8');
const STANDALONE_JS = existsSync('build/ui/app.js') ? readFileSync('build/ui/app.js', 'utf8') : null;

const SAMPLE = '<html><head><!-- easyapp:name Sample -->'
  + '<!-- easyapp:permission internet --></head><body>x</body></html>';

/** Wait for pending promise jobs and timers to settle. */
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** jsdom's File lacks arrayBuffer(); real browsers and WebViews have it. */
function makeFile(window, bytes, name) {
  const file = new window.File([bytes], name, { type: 'text/html' });
  file.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return file;
}

/*
 * The built bundle embeds whatever runtimes existed at build time. Rewrite that
 * preamble so each test controls the device's capabilities explicitly.
 */
function jsWithRuntimes(map) {
  if (!STANDALONE_JS) return null;
  const encoded = {};
  for (const [name, bytes] of Object.entries(map)) {
    encoded[name] = Buffer.from(bytes).toString('base64');
  }
  const replaced = STANDALONE_JS.replace(
    /globalThis\.__EASYAPP_RUNTIMES__ = [^\n]*;/,
    `globalThis.__EASYAPP_RUNTIMES__ = ${JSON.stringify(encoded)};`,
  );
  assert.ok(replaced.includes('__EASYAPP_RUNTIMES__'), 'preamble was rewritten');
  return replaced;
}

/** Minimal opaque stand-ins: packaging treats runtimes as bytes. */
const FAKE_RUNTIMES = {
  'windows-host-x64.exe': strToU8('MZ-host'),
  'windows-installer-x64.exe': strToU8('MZ-setup'),
  'linux-host-x64': strToU8('\u007fELF-host'),
  'android-runtime.dex': (() => { const d = new Uint8Array(112); d.set(strToU8('dex\n035\0'), 0); return d; })(),
};

function makeDom() {
  const dom = new JSDOM(UI_HTML, {
    runScripts: 'outside-only',
    url: 'https://easyapp.internal/',
    pretendToBeVisual: true,
  });
  // jsdom does not implement these Web APIs; every real WebView has them.
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  // jsdom lacks Web Crypto; the WebView and browsers provide it.
  if (!dom.window.crypto || !dom.window.crypto.subtle) {
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto, configurable: true });
  }
  dom.window.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  dom.window.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  dom.window.URL.createObjectURL = () => 'blob:mock';
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLElement.prototype.click = function () {
    this.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  };
  return dom;
}

test('standalone mode: without embedded runtimes only pure-JS targets are offered',
  { skip: !STANDALONE_JS }, async () => {
    const dom = makeDom();
    const { window } = dom;
    const exported = [];

    // Mock the runtime the compiled app would inject.
    window.easyapp = {
      info: () => ({ id: 'org.easyapp.compiler', permissions: ['files'] }),
      hasPermission: (p) => p === 'files',
      files: {
        export: async (name, bytes) => { exported.push({ name, bytes }); return { name }; },
        import: async () => null,
      },
    };
    // No server in a compiled app.
    window.fetch = async () => { throw new Error('no server'); };

    window.eval(jsWithRuntimes({}));
    await settle(120);

    const doc = window.document;
    assert.equal(doc.body.dataset.mode, 'standalone');
    const select = doc.getElementById('target');
    assert.equal(select.value, 'source-project', 'defaults to a target that works offline');
    const disabled = [...select.options].filter((o) => o.disabled).map((o) => o.value);
    assert.ok(disabled.includes('windows-x64'), 'native targets are disabled');
    assert.ok(!disabled.includes('web-bundle'));
    window.close();
  });

test('standalone mode: inspects a bundle and auto-checks permission boxes',
  { skip: !STANDALONE_JS }, async () => {
    const dom = makeDom();
    const { window } = dom;
    window.easyapp = {
      info: () => ({ permissions: ['files'] }),
      hasPermission: (p) => p === 'files',
      files: { export: async () => ({}), import: async () => null },
    };
    window.fetch = async () => { throw new Error('no server'); };
    window.eval(STANDALONE_JS);
    await settle(120);

    // Drive the same path a dropped file takes.
    const bytes = strToU8(SAMPLE);
    const file = makeFile(window, bytes, 'sample.html');
    const input = window.document.getElementById('file');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle(120);

    const doc = window.document;
    assert.equal(doc.getElementById('permInternet').checked, true,
      'the internet directive ticks the checkbox');
    assert.equal(doc.getElementById('permFiles').checked, false);
    assert.match(doc.getElementById('inspectOut').textContent, /Sample/);
    assert.equal(doc.getElementById('buildBtn').disabled, false);
    window.close();
  });

test('standalone mode: builds a source project and saves it through the bridge',
  { skip: !STANDALONE_JS }, async () => {
    const dom = makeDom();
    const { window } = dom;
    const exported = [];
    window.easyapp = {
      info: () => ({ permissions: ['files'] }),
      hasPermission: (p) => p === 'files',
      files: {
        export: async (name, bytes) => { exported.push({ name, bytes }); return { name }; },
        import: async () => null,
      },
    };
    window.fetch = async () => { throw new Error('no server'); };
    window.eval(STANDALONE_JS);
    await settle(120);

    const bytes = strToU8(SAMPLE);
    const file = makeFile(window, bytes, 'sample.html');
    const input = window.document.getElementById('file');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle(100);

    window.document.getElementById('target').value = 'source-project';
    window.document.getElementById('buildBtn').dispatchEvent(
      new window.Event('click', { bubbles: true }),
    );
    await settle(250);

    assert.equal(exported.length, 1, 'the artefact was saved via easyapp.files.export');
    assert.match(exported[0].name, /Sample-source\.zip$/);
    const files = unzipSync(exported[0].bytes);
    assert.ok(files['android/app/build.gradle.kts'], 'embedded template was used');
    // The entry keeps the uploaded file name.
    assert.ok(files['android/app/src/main/assets/www/sample.html']);
    assert.ok(files['android/app/src/main/assets/www/__easyapp_bridge.js']);
    const props = Buffer.from(files['android/gradle.properties']).toString();
    assert.match(props, /allowInternet=true/);
    window.close();
  });

test('standalone mode: a missing runtime is explained, not silently failed',
  { skip: !STANDALONE_JS }, async () => {
    const dom = makeDom();
    const { window } = dom;
    window.easyapp = {
      info: () => ({ permissions: ['files'] }),
      hasPermission: (p) => p === 'files',
      files: { export: async () => ({}), import: async () => null },
    };
    window.fetch = async () => { throw new Error('no server'); };
    window.eval(jsWithRuntimes({}));
    await settle(120);

    const bytes = strToU8(SAMPLE);
    const file = makeFile(window, bytes, 'sample.html');
    const input = window.document.getElementById('file');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle(100);

    const select = window.document.getElementById('target');
    select.value = 'windows-x64'; // force a disabled option
    window.document.getElementById('buildBtn').dispatchEvent(
      new window.Event('click', { bubbles: true }),
    );
    await settle(150);

    const out = window.document.getElementById('buildOut').textContent;
    assert.match(out, /нет встроенного рантайма|ПК/, 'the UI explains the limitation');
    window.close();
  });

test('standalone mode: the LLM prompt button works offline',
  { skip: !STANDALONE_JS }, async () => {
    const dom = makeDom();
    const { window } = dom;
    window.easyapp = {
      info: () => ({ permissions: ['files'] }),
      hasPermission: () => true,
      files: { export: async () => ({}), import: async () => null },
    };
    window.fetch = async () => { throw new Error('no server'); };
    window.eval(STANDALONE_JS);
    await settle(120);

    window.document.getElementById('promptBtn').dispatchEvent(
      new window.Event('click', { bubbles: true }),
    );
    await settle(120);

    assert.equal(window.document.getElementById('promptModal').hidden, false);
    const text = window.document.getElementById('promptText').value;
    assert.match(text, /easyapp:permission/);
    assert.match(text, /window\.easyapp/);
    assert.ok(text.length > 2000);
    window.close();
  });

test('server mode: uses the HTTP API when no native bridge exists',
  { skip: !STANDALONE_JS }, async () => {
    const dom = makeDom();
    const { window } = dom;
    const calls = [];
    window.fetch = async (url, options) => {
      calls.push(String(url));
      if (String(url).includes('/api/health')) {
        return { ok: true, json: async () => ({ service: 'easyapp-compiler' }) };
      }
      if (String(url).includes('/api/targets')) {
        return { ok: true, json: async () => ({ targets: [
          { id: 'windows-x64', label: 'Windows x64', description: 'd', requires: ['zig'] },
          { id: 'web-bundle', label: 'Web', description: 'd', requires: [] },
        ] }) };
      }
      if (String(url).includes('/api/doctor')) {
        return { ok: true, json: async () => ({ zig: { available: true } }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };
    window.eval(STANDALONE_JS);
    await settle(150);

    assert.equal(window.document.body.dataset.mode, 'server');
    assert.ok(calls.some((c) => c.includes('/api/targets')));
    const select = window.document.getElementById('target');
    assert.equal(select.value, 'windows-x64', 'native targets are the default on a PC');
    assert.ok([...select.options].every((o) => !o.disabled), 'nothing is disabled');
    window.close();
  });

/* ------------------------------- on-device native builds (the whole point) */

/** Standalone DOM with a bridge that records exports and private files. */
function deviceDom(runtimes) {
  const dom = makeDom();
  const { window } = dom;
  const exported = [];
  const privateFiles = new Map();
  window.easyapp = {
    info: () => ({ id: 'org.easyapp.compiler', permissions: ['files'] }),
    hasPermission: (p) => p === 'files',
    files: {
      export: async (name, bytes) => { exported.push({ name, bytes }); return { name }; },
      import: async () => null,
    },
    privateFiles: {
      readText: async (p) => {
        if (!privateFiles.has(p)) throw new Error('not found');
        return privateFiles.get(p);
      },
      write: async (p, bytes) => { privateFiles.set(p, new TextDecoder().decode(bytes)); },
    },
  };
  window.fetch = async () => { throw new Error('no server'); };
  return { dom, window, exported, privateFiles, js: jsWithRuntimes(runtimes) };
}

async function dropSample(window) {
  const file = makeFile(window, strToU8(SAMPLE), 'sample.html');
  const input = window.document.getElementById('file');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle(120);
}

async function clickBuild(window, target, wait = 400) {
  window.document.getElementById('target').value = target;
  window.document.getElementById('buildBtn').dispatchEvent(
    new window.Event('click', { bubbles: true }),
  );
  await settle(wait);
  return window.document.getElementById('buildOut').textContent;
}

test('on-device: builds a Windows installer with no toolchain present',
  { skip: !STANDALONE_JS }, async () => {
    const { window, exported, js } = deviceDom({
      'windows-host-x64.exe': FAKE_RUNTIMES['windows-host-x64.exe'],
      'windows-installer-x64.exe': FAKE_RUNTIMES['windows-installer-x64.exe'],
    });
    window.eval(js);
    await settle(150);

    const select = window.document.getElementById('target');
    const disabled = [...select.options].filter((o) => o.disabled).map((o) => o.value);
    assert.ok(!disabled.includes('windows-x64'), 'embedded runtime enables the target');
    assert.ok(disabled.includes('android-apk'), 'a target without a runtime stays disabled');

    await dropSample(window);
    const out = await clickBuild(window, 'windows-x64');
    assert.equal(exported.length, 1, `artefact saved through the bridge; UI said: ${out}`);
    assert.match(exported[0].name, /Sample-setup-x64\.exe$/);

    const bytes = exported[0].bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(bytes.length - 4, true);
    assert.equal(new TextDecoder().decode(bytes.subarray(bytes.length - 8, bytes.length - 4)), 'EAPK');
    const files = unzipSync(bytes.subarray(bytes.length - 8 - len, bytes.length - 8));
    assert.deepEqual(files['app.exe'], FAKE_RUNTIMES['windows-host-x64.exe']);
    assert.ok(files['www/sample.html']);
    assert.match(out, /компилятор не требуется/);
    window.close();
  });

test('on-device: builds and signs an APK, persisting the key',
  { skip: !STANDALONE_JS }, async () => {
    const { window, exported, privateFiles, js } = deviceDom({
      'android-runtime.dex': FAKE_RUNTIMES['android-runtime.dex'],
    });
    window.eval(js);
    await settle(150);

    assert.equal(window.document.getElementById('target').value, 'android-apk',
      'a phone defaults to the APK target');
    await dropSample(window);
    const out = await clickBuild(window, 'android-apk', 1500);
    assert.equal(exported.length, 1, `APK saved through the bridge; UI said: ${out}`);
    assert.match(exported[0].name, /Sample\.apk$/);

    const files = unzipSync(exported[0].bytes);
    for (const n of ['AndroidManifest.xml', 'classes.dex', 'resources.arsc',
      'res/drawable/ic_launcher.png', 'assets/www/sample.html']) {
      assert.ok(files[n], `APK contains ${n}`);
    }
    assert.ok(privateFiles.has('signing-identity.json'), 'signing key persisted for updates');
    assert.match(out, /Android SDK не требуется/);

    // A second build must reuse the stored key rather than creating a new one.
    await clickBuild(window, 'android-apk', 900);
    assert.equal(exported.length, 2);
    assert.deepEqual(exported[1].bytes, exported[0].bytes, 'reproducible with the same key');
    window.close();
  });

test('on-device: toolchain badges say the runtime is embedded, not installed',
  { skip: !STANDALONE_JS }, async () => {
    const { window, js } = deviceDom({
      'windows-host-x64.exe': FAKE_RUNTIMES['windows-host-x64.exe'],
      'windows-installer-x64.exe': FAKE_RUNTIMES['windows-installer-x64.exe'],
    });
    window.eval(js);
    await settle(150);
    window.document.getElementById('target').value = 'windows-x64';
    window.document.getElementById('target').dispatchEvent(
      new window.Event('change', { bubbles: true }),
    );
    await settle(80);
    const badges = window.document.getElementById('toolchain').textContent;
    assert.match(badges, /встроен/, 'the UI does not claim Zig is installed');
    window.close();
  });
