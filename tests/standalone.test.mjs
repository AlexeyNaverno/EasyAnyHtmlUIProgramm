/**
 * Tests for the browser-safe core used by the compiled compiler app.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

import {
  loadBundle, lintBundle, buildWwwTree, buildAndroidProject, normalizeTree,
  packZip, strToU8, describeTargets, buildLlmPrompt, KNOWN_PERMISSIONS,
} from '../apps/ui/core-browser.js';
import { readBridge } from '../packages/core/src/compiler.js';

const HTML = '<html><head><!-- easyapp:permission files --></head><body>x</body></html>';

test('browser core parses bundles without node builtins', () => {
  const bundle = loadBundle(strToU8(HTML), { filename: 'index.html' });
  assert.deepEqual(bundle.manifest.permissions, ['files']);
  assert.equal(lintBundle(bundle).filter((i) => i.level === 'error').length, 0);
});

test('browser core can emit a web bundle identical in structure to the CLI', () => {
  const bundle = loadBundle(strToU8(HTML), { filename: 'index.html' });
  const files = normalizeTree(buildWwwTree(bundle, readBridge())).files;
  const zip = packZip(files);
  const out = unzipSync(zip);
  assert.ok(out['__easyapp_bridge.js']);
  assert.ok(out['__easyapp_manifest.json']);
  assert.ok(out['index.html']);
});

test('browser core can emit an android project', () => {
  const bundle = loadBundle(strToU8(HTML), { filename: 'index.html' });
  const { files } = buildAndroidProject(bundle, readBridge(), new Map());
  assert.ok(files.has('gradle.properties'));
  assert.ok(files.has('app/src/main/assets/www/index.html'));
  assert.match(new TextDecoder().decode(files.get('gradle.properties')), /allowFiles=true/);
});

test('browser core exposes targets and the LLM prompt', () => {
  assert.ok(describeTargets().length >= 5);
  for (const p of KNOWN_PERMISSIONS) assert.ok(buildLlmPrompt({ lang: 'ru' }).includes(p));
});

test('browser core module graph contains no node: imports', () => {
  const source = readFileSync(new URL('../apps/ui/core-browser.js', import.meta.url), 'utf8');
  const deps = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const dep of deps) {
    assert.ok(!dep.startsWith('node:'), `${dep} is a node builtin`);
    const text = readFileSync(new URL(dep, new URL('../apps/ui/core-browser.js', import.meta.url)), 'utf8');
    assert.ok(!/from\s+'node:/.test(text), `${dep} imports a node builtin`);
  }
});

test('standalone UI bundle embeds templates and the bridge', { skip: !existsSync('build/ui/app.js') }, () => {
  const js = readFileSync('build/ui/app.js', 'utf8');
  assert.match(js, /__EASYAPP_TEMPLATES__/);
  assert.match(js, /__EASYAPP_BRIDGE_SOURCE__/);
  // The Android template must be embedded for offline project generation.
  const match = js.match(/__EASYAPP_TEMPLATES__\s*=\s*(\{.*?\});/s);
  assert.ok(match, 'template map is present');
  const map = JSON.parse(match[1]);
  assert.ok(map['app/build.gradle.kts'], 'gradle build file embedded');
  assert.ok(map['app/src/main/java/org/easyapp/runtime/MainActivity.kt'], 'runtime embedded');
  const gradle = Buffer.from(map['app/build.gradle.kts'], 'base64').toString();
  assert.match(gradle, /allowInternet/);
});
