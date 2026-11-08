/**
 * Core compiler tests. Run with: node --test tests/*.test.mjs
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8, unzipSync } from 'fflate';

import {
  buildManifest, parseDirectives, isValidAppId, isValidVersion, ManifestError,
} from '../packages/core/src/manifest.js';
import { loadBundle, normalizeBundlePath, BundleError } from '../packages/core/src/bundle.js';
import {
  normalizeHtmlPaths, buildWwwTree, buildAndroidProject, lintBundle,
} from '../packages/core/src/targets.js';
import { buildLlmPrompt } from '../packages/core/src/prompt.js';
import { getTarget, describeTargets, TARGETS } from '../packages/core/src/target-registry.js';
import { KNOWN_PERMISSIONS } from '../packages/core/src/index.js';

const HTML = '<html><head><title>t</title></head><body>hi</body></html>';

/* ------------------------------------------------------------ manifest */

test('parses permission directives from HTML comments', () => {
  const html = `<head>
    <!-- easyapp:permission internet -->
    <!-- easyapp:permission files -->
    <!-- easyapp:name MyApp -->
    <!-- easyapp:id com.example.app -->
  </head>`;
  const { manifest, directives } = buildManifest({ html });
  assert.deepEqual(manifest.permissions, ['files', 'internet']);
  assert.equal(manifest.name, 'MyApp');
  assert.equal(manifest.id, 'com.example.app');
  assert.equal(directives.length, 4);
  assert.equal(directives[0].line, 2);
});

test('multiple permissions on one line and comma separated', () => {
  const { manifest } = buildManifest({ html: '<!-- easyapp:permission internet, files -->' });
  assert.deepEqual(manifest.permissions, ['files', 'internet']);
});

test('JSON config block is merged', () => {
  const html = '<!-- easyapp:config {"name":"From JSON","permissions":["internet"]} -->';
  const { manifest } = buildManifest({ html });
  assert.equal(manifest.name, 'From JSON');
  assert.deepEqual(manifest.permissions, ['internet']);
});

test('directives take priority over the config file', () => {
  const { manifest } = buildManifest({
    html: '<!-- easyapp:name FromDirective -->',
    config: { name: 'FromConfig', permissions: ['files'] },
  });
  assert.equal(manifest.name, 'FromDirective');
  assert.deepEqual(manifest.permissions, ['files']);
});

test('UI overrides win over everything', () => {
  const { manifest } = buildManifest({
    html: '<!-- easyapp:permission internet --><!-- easyapp:name Original -->',
    overrides: { permissions: ['files'], name: 'Overridden' },
  });
  assert.deepEqual(manifest.permissions, ['files']);
  assert.equal(manifest.name, 'Overridden');
});

test('empty permission override clears all permissions', () => {
  const { manifest } = buildManifest({
    html: '<!-- easyapp:permission internet -->',
    overrides: { permissions: [] },
  });
  assert.deepEqual(manifest.permissions, []);
});

test('unknown permission is rejected', () => {
  assert.throws(
    () => buildManifest({ html: '<!-- easyapp:permission camera -->' }),
    /Unknown permission "camera"/,
  );
});

test('invalid JSON in config block reports a clear error', () => {
  assert.throws(
    () => buildManifest({ html: '<!-- easyapp:config {oops} -->' }),
    /invalid JSON/,
  );
});

test('duplicate permissions are deduplicated', () => {
  const { manifest } = buildManifest({
    html: '<!-- easyapp:permission internet --><!-- easyapp:permission internet -->',
  });
  assert.deepEqual(manifest.permissions, ['internet']);
});

test('unknown directive produces a warning, not a failure', () => {
  const { warnings } = buildManifest({ html: '<!-- easyapp:bogus value -->' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unknown directive/);
});

test('ordinary HTML comments are ignored', () => {
  const { directives, manifest } = buildManifest({ html: '<!-- just a note --><p>x</p>' });
  assert.equal(directives.length, 0);
  assert.deepEqual(manifest.permissions, []);
});

test('app id validation', () => {
  assert.equal(isValidAppId('org.example.app'), true);
  assert.equal(isValidAppId('com.example'), true);
  assert.equal(isValidAppId('single'), false);
  assert.equal(isValidAppId('org.1example.app'), false);
  assert.equal(isValidAppId('org.example-app'), false);
  assert.equal(isValidAppId('org..app'), false);
});

test('version validation', () => {
  assert.equal(isValidVersion('1.0.0'), true);
  assert.equal(isValidVersion('2.5'), true);
  assert.equal(isValidVersion('1.0.0-beta'), false);
  assert.throws(() => buildManifest({ html: '<!-- easyapp:version abc -->' }), /Invalid version/);
});

test('invalid app id in directive is rejected', () => {
  assert.throws(() => buildManifest({ html: '<!-- easyapp:id bad-id -->' }), /Invalid application id/);
});

test('path traversal in entry is rejected', () => {
  assert.throws(() => buildManifest({ html: '<!-- easyapp:entry ../evil.html -->' }), /relative path/);
});

/* -------------------------------------------------------------- bundle */

test('loads a single HTML file', () => {
  const bundle = loadBundle(strToU8(HTML), { filename: 'page.html' });
  assert.equal(bundle.sourceKind, 'html');
  assert.equal(bundle.entry, 'page.html');
  assert.equal(bundle.fileCount, 1);
});

test('loads a ZIP and finds index.html', () => {
  const zip = zipSync({
    'index.html': strToU8(HTML),
    'style.css': strToU8('body{}'),
  });
  const bundle = loadBundle(zip, { filename: 'app.zip' });
  assert.equal(bundle.sourceKind, 'zip');
  assert.equal(bundle.entry, 'index.html');
  assert.equal(bundle.fileCount, 2);
});

test('strips a single wrapping directory in a ZIP', () => {
  const zip = zipSync({
    'myapp/index.html': strToU8(HTML),
    'myapp/assets/a.css': strToU8('a{}'),
  });
  const bundle = loadBundle(zip);
  assert.equal(bundle.entry, 'index.html');
  assert.ok(bundle.files.has('assets/a.css'));
});

test('reads easyapp.json from the bundle', () => {
  const zip = zipSync({
    'index.html': strToU8(HTML),
    'easyapp.json': strToU8(JSON.stringify({ name: 'Zipped', permissions: ['files'] })),
  });
  const bundle = loadBundle(zip);
  assert.equal(bundle.manifest.name, 'Zipped');
  assert.deepEqual(bundle.manifest.permissions, ['files']);
  assert.equal(bundle.configPath, 'easyapp.json');
});

test('rejects path traversal in archive entries', () => {
  assert.throws(() => normalizeBundlePath('../evil.txt'), BundleError);
  assert.throws(() => normalizeBundlePath('/etc/passwd'), BundleError);
  assert.throws(() => normalizeBundlePath('C:\\windows\\x'), BundleError);
  assert.equal(normalizeBundlePath('a/./b.txt'), 'a/b.txt');
  assert.equal(normalizeBundlePath('a\\b.txt'), 'a/b.txt');
});

test('rejects an empty input', () => {
  assert.throws(() => loadBundle(new Uint8Array(0)), /empty/i);
});

test('rejects a ZIP without any HTML', () => {
  const zip = zipSync({ 'readme.txt': strToU8('nothing') });
  assert.throws(() => loadBundle(zip), /No \.html file/);
});

test('missing declared entry is reported', () => {
  const zip = zipSync({
    'index.html': strToU8('<!-- easyapp:entry missing.html -->' + HTML),
  });
  assert.throws(() => loadBundle(zip), /was not found/);
});

test('non-HTML non-ZIP input is rejected', () => {
  assert.throws(() => loadBundle(strToU8('random plain text file')), /neither a ZIP/);
});

/* ------------------------------------------------------------- targets */

test('rewrites absolute asset paths to relative', () => {
  const { html, warnings } = normalizeHtmlPaths(
    '<link href="/style.css"><script src="/app.js"></script><img src="https://x/y.png">',
  );
  assert.match(html, /href="\.\/style\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /https:\/\/x\/y\.png/); // external URLs untouched
  assert.equal(warnings.length, 2);
});

test('leaves protocol-relative URLs alone', () => {
  const { html } = normalizeHtmlPaths('<script src="//cdn.example/x.js"></script>');
  assert.match(html, /src="\/\/cdn\.example/);
});

test('rewrites absolute CSS url()', () => {
  const { html } = normalizeHtmlPaths('<style>a{background:url(/img/bg.png)}</style>');
  assert.match(html, /url\(\.\/img\/bg\.png\)/);
});

test('www tree always contains the runtime files', () => {
  const bundle = loadBundle(strToU8(HTML), { filename: 'index.html' });
  const tree = buildWwwTree(bundle, 'BRIDGE_SOURCE');
  assert.ok(tree.has('__easyapp_bridge.js'));
  assert.ok(tree.has('__easyapp_manifest.json'));
  const manifest = JSON.parse(new TextDecoder().decode(tree.get('__easyapp_manifest.json')));
  assert.equal(manifest.entry, 'index.html');
});

test('input cannot shadow runtime files', () => {
  const zip = zipSync({
    'index.html': strToU8(HTML),
    '__easyapp_bridge.js': strToU8('malicious()'),
  });
  const bundle = loadBundle(zip);
  const tree = buildWwwTree(bundle, 'REAL_BRIDGE');
  assert.equal(new TextDecoder().decode(tree.get('__easyapp_bridge.js')), 'REAL_BRIDGE');
});

test('android project selects permissions through gradle properties', () => {
  const bundle = loadBundle(
    strToU8('<!-- easyapp:permission internet -->' + HTML),
    { filename: 'index.html' },
  );
  const { files } = buildAndroidProject(bundle, 'BRIDGE', new Map());
  const props = new TextDecoder().decode(files.get('gradle.properties'));
  assert.match(props, /allowInternet=true/);
  assert.match(props, /allowFiles=false/);
  assert.ok(files.has('app/src/main/assets/www/index.html'));
  assert.ok(files.has('app/src/main/assets/www/__easyapp_manifest.json'));
});

test('lint flags network use without the permission', () => {
  const bundle = loadBundle(
    strToU8('<html><body><script>fetch("https://x")</script></body></html>'),
    { filename: 'index.html' },
  );
  const issues = lintBundle(bundle);
  assert.ok(issues.some((i) => /internet/.test(i.message)));
});

test('lint treats external CDN as an error when offline', () => {
  const bundle = loadBundle(
    strToU8('<html><head><script src="https://cdn.example/lib.js"></script></head><body>x</body></html>'),
    { filename: 'index.html' },
  );
  const issues = lintBundle(bundle);
  assert.ok(issues.some((i) => i.level === 'error' && /offline/.test(i.message)));
});

test('lint downgrades CDN to a warning when internet is granted', () => {
  const bundle = loadBundle(
    strToU8('<html><head><!-- easyapp:permission internet -->'
      + '<script src="https://cdn.example/lib.js"></script></head><body>x</body></html>'),
    { filename: 'index.html' },
  );
  const issues = lintBundle(bundle);
  const cdn = issues.find((i) => /External resource/.test(i.message));
  assert.equal(cdn.level, 'warning');
});

/* ------------------------------------------------------- registry/prompt */

test('every target is resolvable and documented', () => {
  for (const t of TARGETS) {
    assert.equal(getTarget(t.id).id, t.id);
    assert.ok(t.description.length > 10);
  }
  assert.throws(() => getTarget('nope'), /Unknown target/);
  assert.equal(describeTargets().length, TARGETS.length);
});

test('LLM prompt documents every known permission and API entry', () => {
  for (const lang of ['ru', 'en']) {
    const prompt = buildLlmPrompt({ lang });
    for (const perm of KNOWN_PERMISSIONS) {
      assert.ok(prompt.includes(perm), `${lang} prompt mentions ${perm}`);
    }
    assert.ok(prompt.includes('easyapp:permission'));
    assert.ok(prompt.includes('window.easyapp'));
    assert.ok(prompt.length > 1000);
  }
});

test('prompt defaults to Russian', () => {
  assert.match(buildLlmPrompt(), /Задача/);
});

/* ------------------------------------------------- packZip regressions */

test('packZip normalises non-Uint8Array values instead of making directories', async () => {
  const { packZip } = await import('../packages/core/src/bundle.js');
  const { unzipSync } = await import('fflate');
  // A plain array and a string must become file entries, not "name/0/", "name/1/".
  const files = new Map([
    ['from-array.txt', [104, 105]],
    ['from-string.txt', 'hi'],
    ['from-bytes.txt', new Uint8Array([121])],
  ]);
  const out = unzipSync(packZip(files));
  assert.deepEqual(Object.keys(out).sort(), ['from-array.txt', 'from-bytes.txt', 'from-string.txt']);
  assert.equal(Buffer.from(out['from-array.txt']).toString(), 'hi');
  assert.equal(Buffer.from(out['from-string.txt']).toString(), 'hi');
  assert.equal(Buffer.from(out['from-bytes.txt']).toString(), 'y');
});

/* --------------------------------------------------- JDK compatibility */

test('parseJavaMajor understands modern and legacy version schemes', async () => {
  const { parseJavaMajor, jdkSupportedByGradle, GRADLE_MAX_JDK } =
    await import('../packages/core/src/toolchain.js');
  assert.equal(parseJavaMajor('javac 17.0.11'), 17);
  assert.equal(parseJavaMajor('openjdk version "25.0.5" 2026-10-20'), 25);
  assert.equal(parseJavaMajor('javac 1.8.0_402'), 8);
  assert.equal(parseJavaMajor('javac 21'), 21);
  assert.equal(parseJavaMajor(''), null);
  assert.equal(parseJavaMajor(null), null);
  assert.equal(parseJavaMajor('no digits here'), null);

  assert.equal(jdkSupportedByGradle(17), true);
  assert.equal(jdkSupportedByGradle(GRADLE_MAX_JDK), true);
  // JDK 25 is what broke CI: Gradle 8.7 aborts on its version string.
  assert.equal(jdkSupportedByGradle(25), false);
  assert.equal(jdkSupportedByGradle(7), false);
  // Unknown version must not block the build.
  assert.equal(jdkSupportedByGradle(null), true);
});

test('doctor reports the JDK major and Gradle compatibility', async () => {
  const { doctor } = await import('../packages/core/src/toolchain.js');
  const report = await doctor();
  assert.ok('major' in report.java);
  assert.equal(typeof report.java.gradleSupported, 'boolean');
});
