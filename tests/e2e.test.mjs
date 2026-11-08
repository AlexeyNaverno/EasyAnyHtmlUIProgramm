/**
 * End-to-end tests that produce real artefacts and inspect their structure.
 * Windows targets are skipped automatically when Zig is unavailable.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strToU8, zipSync } from 'fflate';

import { compile, inspect } from '../packages/core/src/compiler.js';
import { findZig } from '../packages/core/src/toolchain.js';

const HTML = `<!DOCTYPE html><html><head>
<!-- easyapp:name E2E App -->
<!-- easyapp:id org.easyapp.e2e -->
<!-- easyapp:permission internet -->
</head><body><h1>Test</h1></body></html>`;

const zig = await findZig();
const work = mkdtempSync(join(tmpdir(), 'easyapp-e2e-'));

test('cleanup', () => { rmSync(work, { recursive: true, force: true }); });

/** Read the appended ZIP payload from a generated installer. */
function readInstallerPayload(exe) {
  const buf = Buffer.from(exe);
  assert.equal(buf.subarray(buf.length - 8, buf.length - 4).toString('ascii'), 'EAPK',
    'installer must end with the EAPK trailer');
  const len = buf.readUInt32LE(buf.length - 4);
  assert.ok(len > 0 && len < buf.length - 8, 'payload length must be sane');
  return buf.subarray(buf.length - 8 - len, buf.length - 8);
}

function peInfo(bytes) {
  const buf = Buffer.from(bytes);
  assert.equal(buf.subarray(0, 2).toString('ascii'), 'MZ', 'DOS signature');
  const peOffset = buf.readUInt32LE(0x3c);
  assert.equal(buf.subarray(peOffset, peOffset + 4).toString('binary'), 'PE\0\0', 'PE signature');
  return {
    machine: buf.readUInt16LE(peOffset + 4),
    subsystem: buf.readUInt16LE(peOffset + 24 + 68),
  };
}

test('inspect reports directives and permissions', () => {
  const info = inspect(strToU8(HTML), { filename: 'index.html' });
  assert.equal(info.manifest.name, 'E2E App');
  assert.deepEqual(info.manifest.permissions, ['internet']);
  assert.equal(info.directives.length, 3);
});

test('web-bundle contains the runtime bridge and manifest', async () => {
  const result = await compile(strToU8(HTML), {
    filename: 'index.html', target: 'web-bundle', outDir: work,
  });
  const files = unzipSync(result.bytes);
  assert.ok(files['index.html']);
  assert.ok(files['__easyapp_bridge.js']);
  const manifest = JSON.parse(Buffer.from(files['__easyapp_manifest.json']).toString());
  assert.equal(manifest.id, 'org.easyapp.e2e');
  assert.deepEqual(manifest.permissions, ['internet']);
  // The bridge must expose the documented API surface.
  const bridge = Buffer.from(files['__easyapp_bridge.js']).toString();
  for (const api of ['window.easyapp', 'privateFiles', 'storage', 'fetch', 'files']) {
    assert.ok(bridge.includes(api), `bridge exposes ${api}`);
  }
});

test('source-project contains gradle files, native sources and assets', async () => {
  const result = await compile(strToU8(HTML), {
    filename: 'index.html', target: 'source-project', outDir: work,
  });
  const files = unzipSync(result.bytes);
  const names = Object.keys(files);
  assert.ok(names.includes('android/app/build.gradle.kts'));
  assert.ok(names.includes('android/settings.gradle.kts'));
  assert.ok(names.includes('android/app/src/main/java/org/easyapp/runtime/MainActivity.kt'));
  assert.ok(names.includes('android/app/src/main/assets/www/index.html'));
  assert.ok(names.includes('native/host/host_windows.c'));
  assert.ok(names.includes('native/host/host_linux.c'));
  assert.ok(names.includes('native/installer/tinyzip.c'));
  // Only the requested permission may appear in the generated properties.
  const props = Buffer.from(files['android/gradle.properties']).toString();
  assert.match(props, /allowInternet=true/);
  assert.match(props, /allowFiles=false/);
});

test('android target exports a buildable project when the SDK is missing', async () => {
  // Force the "no SDK" path so the result does not depend on the machine:
  // CI runners ship a full Android SDK, where this would otherwise build an APK.
  const saved = { home: process.env.ANDROID_HOME, root: process.env.ANDROID_SDK_ROOT };
  delete process.env.ANDROID_HOME;
  delete process.env.ANDROID_SDK_ROOT;
  try {
    await assert.rejects(
    () => compile(strToU8(HTML), { filename: 'index.html', target: 'android-apk', outDir: work }),
    (err) => {
      // With no SDK the compiler must still hand back a usable project.
      assert.ok(err.projectZip, 'a project ZIP is produced as a fallback');
      const files = unzipSync(new Uint8Array(readFileSync(err.projectZip)));
      assert.ok(files['app/src/main/AndroidManifest.internet.xml']);
      assert.ok(files['app/src/main/AndroidManifest.xml']);
      assert.ok(files['app/src/main/assets/www/index.html']);
      assert.ok(files['gradle.properties']);
      return true;
      },
    );
  } finally {
    if (saved.home === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = saved.home;
    if (saved.root === undefined) delete process.env.ANDROID_SDK_ROOT;
    else process.env.ANDROID_SDK_ROOT = saved.root;
  }
});

test('windows x64 installer embeds a valid PE host and payload', { skip: !zig.available }, async () => {
  const result = await compile(strToU8(HTML), {
    filename: 'index.html', target: 'windows-x64', outDir: work,
  });
  assert.match(result.filename, /setup-x64\.exe$/);
  const outer = peInfo(result.bytes);
  assert.equal(outer.machine, 0x8664, 'installer targets x86_64');
  assert.equal(outer.subsystem, 2, 'installer is a GUI application');

  const payload = readInstallerPayload(result.bytes);
  const files = unzipSync(new Uint8Array(payload));
  assert.ok(files['app.exe'], 'host binary is bundled');
  assert.ok(files['www/index.html']);
  assert.ok(files['www/__easyapp_bridge.js']);
  const host = peInfo(files['app.exe']);
  assert.equal(host.machine, 0x8664);
  assert.equal(host.subsystem, 2);

  const manifest = JSON.parse(Buffer.from(files['www/__easyapp_manifest.json']).toString());
  assert.deepEqual(manifest.permissions, ['internet']);
});

test('windows x86 installer targets i386', { skip: !zig.available }, async () => {
  const result = await compile(strToU8(HTML), {
    filename: 'index.html', target: 'windows-x86', outDir: work,
  });
  assert.equal(peInfo(result.bytes).machine, 0x14c, 'installer targets i386');
  const files = unzipSync(new Uint8Array(readInstallerPayload(result.bytes)));
  assert.equal(peInfo(files['app.exe']).machine, 0x14c, 'host targets i386');
});

test('windows portable ZIP has no installer wrapper', { skip: !zig.available }, async () => {
  const result = await compile(strToU8(HTML), {
    filename: 'index.html', target: 'windows-portable-x64', outDir: work,
  });
  const files = unzipSync(result.bytes);
  assert.ok(files['app.exe']);
  assert.ok(files['www/index.html']);
  assert.equal(peInfo(files['app.exe']).machine, 0x8664);
});

test('permission overrides reach the compiled payload', { skip: !zig.available }, async () => {
  const result = await compile(strToU8(HTML), {
    filename: 'index.html', target: 'windows-portable-x64', outDir: work,
    overrides: { permissions: ['files'] },
  });
  const files = unzipSync(result.bytes);
  const manifest = JSON.parse(Buffer.from(files['www/__easyapp_manifest.json']).toString());
  assert.deepEqual(manifest.permissions, ['files'], 'override replaces the directive set');
});

test('ZIP input with multiple files compiles end to end', { skip: !zig.available }, async () => {
  const zip = zipSync({
    'index.html': strToU8('<html><head><link rel="stylesheet" href="/style.css"></head>'
      + '<body><script src="./app.js"></script></body></html>'),
    'style.css': strToU8('body{margin:0}'),
    'app.js': strToU8('console.log(1)'),
  });
  const result = await compile(zip, {
    filename: 'app.zip', target: 'windows-portable-x64', outDir: work,
  });
  const files = unzipSync(result.bytes);
  assert.ok(files['www/style.css']);
  assert.ok(files['www/app.js']);
  const html = Buffer.from(files['www/index.html']).toString();
  assert.match(html, /href="\.\/style\.css"/, 'absolute path was normalised');
  assert.ok(result.warnings.some((w) => /style\.css/.test(w)));
});

test('a bundle with a blocking lint error is refused', async () => {
  const bad = '<html><head><script src="https://cdn.example/x.js"></script></head><body>x</body></html>';
  await assert.rejects(
    () => compile(strToU8(bad), { filename: 'index.html', target: 'web-bundle', outDir: work }),
    /failed validation/,
  );
});
