/**
 * Pure packaging layer: the path that runs on a phone with no toolchain.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

import {
  packageWindows, packageLinux, wrapInstaller, safeStem, linuxInstallScript,
} from '../packages/core/src/packaging.js';
import { loadBundle, strToU8, strFromU8 } from '../packages/core/src/bundle.js';
import { readBridge } from '../packages/core/src/compiler.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = '<!-- easyapp:name Test App --><!-- easyapp:id org.test.app -->'
  + '<html><head><title>t</title></head><body>hi</body></html>';
const bundle = () => loadBundle(strToU8(HTML), { filename: 'index.html' });
const bridge = readBridge();

/* A stand-in for the real runtime: packaging must treat it as opaque bytes. */
const fakeHost = strToU8('MZ-host-binary');
const fakeSetup = strToU8('MZ-installer-stub');

test('packaging module stays browser-safe', () => {
  const src = readFileSync(join(ROOT, 'packages/core/src/packaging.js'), 'utf8');
  assert.ok(!/from\s+'node:/.test(src), 'must not import node builtins');
  assert.ok(!/toolchain\.js/.test(src), 'must not import the toolchain drivers');
});

test('safeStem mirrors CLI artefact naming', () => {
  assert.equal(safeStem('My App'), 'My_App');
  // Non-ASCII names collapse to underscores but stay filesystem-safe.
  assert.equal(safeStem('Привет мир'), '___');
  assert.ok(!/[\\/:*?"<>|]/.test(safeStem('Привет мир')));
  assert.equal(safeStem('a/b:c'), 'a_b_c');
  assert.equal(safeStem('   '), 'EasyApp');
});

test('wrapInstaller writes stub || zip || EAPK || uint32le length', () => {
  const zip = strToU8('payload-zip-bytes');
  const out = wrapInstaller(fakeSetup, zip);
  assert.equal(out.length, fakeSetup.length + zip.length + 8);
  const tail = out.subarray(out.length - 8);
  assert.equal(strFromU8(tail.subarray(0, 4)), 'EAPK');
  assert.equal(new DataView(tail.buffer, tail.byteOffset, 8).getUint32(4, true), zip.length);
  // The stub must be recoverable byte for byte.
  assert.deepEqual(out.subarray(0, fakeSetup.length), fakeSetup);
});

test('windows installer packages the payload without any compiler', () => {
  const res = packageWindows(bundle(), bridge, { host: fakeHost, installer: fakeSetup },
    { arch: 'x64', kind: 'installer' });
  assert.equal(res.filename, 'Test_App-setup-x64.exe');
  const len = new DataView(res.bytes.buffer, res.bytes.byteOffset).getUint32(res.bytes.length - 4, true);
  const zipStart = res.bytes.length - 8 - len;
  const files = unzipSync(res.bytes.subarray(zipStart, res.bytes.length - 8));
  assert.deepEqual(files['app.exe'], fakeHost);
  assert.ok(files['www/index.html']);
  assert.ok(files['www/__easyapp_bridge.js']);
  const manifest = JSON.parse(strFromU8(files['www/__easyapp_manifest.json']));
  assert.equal(manifest.id, 'org.test.app');
});

test('windows portable omits the installer wrapper', () => {
  const res = packageWindows(bundle(), bridge, { host: fakeHost },
    { arch: 'x86', kind: 'portable' });
  assert.equal(res.filename, 'Test_App-windows-x86-portable.zip');
  const files = unzipSync(res.bytes);
  assert.deepEqual(files['app.exe'], fakeHost);
  assert.ok(files['www/index.html']);
  // No EAPK trailer: a portable zip is a plain zip.
  assert.notEqual(strFromU8(res.bytes.subarray(res.bytes.length - 8, res.bytes.length - 4)), 'EAPK');
});

test('packaging refuses to run without the runtime it needs', () => {
  assert.throws(() => packageWindows(bundle(), bridge, {}, { arch: 'x64' }), /host runtime is missing/);
  assert.throws(() => packageWindows(bundle(), bridge, { host: fakeHost }, { arch: 'x64' }),
    /installer runtime is missing/);
  assert.throws(() => packageLinux(bundle(), bridge, {}), /host runtime is missing/);
});

test('linux archive carries the host, launchers and desktop entry', () => {
  const res = packageLinux(bundle(), bridge, { host: fakeHost });
  assert.equal(res.filename, 'Test_App-linux-x64.zip');
  const files = unzipSync(res.bytes);
  assert.deepEqual(files['app'], fakeHost);
  assert.ok(files['www/index.html']);
  assert.ok(files['Test_App.desktop']);
  assert.match(strFromU8(files['run.sh']), /exec "\$\(dirname "\$0"\)\/app"/);
  const install = strFromU8(files['install.sh']);
  assert.match(install, /^#!\/bin\/sh/);
  assert.match(install, /org\.test\.app/);
  assert.match(install, /chmod \+x/);
});

test('install script targets the per-user data directory', () => {
  const script = linuxInstallScript(bundle());
  assert.match(script, /XDG_DATA_HOME:-\$HOME\/\.local\/share/);
  assert.match(script, /EasyApp\/org\.test\.app/);
});

test('packaging is deterministic for identical input', () => {
  const a = packageWindows(bundle(), bridge, { host: fakeHost, installer: fakeSetup });
  const b = packageWindows(bundle(), bridge, { host: fakeHost, installer: fakeSetup });
  assert.deepEqual(a.bytes, b.bytes, 'same input must give byte-identical output');
});
