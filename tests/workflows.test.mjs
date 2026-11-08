/**
 * Workflow sanity checks.
 *
 * GitHub rejects a workflow outright when a mapping repeats a key, and most
 * YAML loaders silently keep the last one instead of complaining. That exact
 * mistake (a duplicated `if:`) once made the release workflow fail to register
 * with no jobs and no useful error, so it is checked here.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.github/workflows');
const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

/**
 * Find repeated keys in the same YAML mapping using indentation.
 * Block scalars are skipped so prose like "Windows: ..." is not read as a key.
 */
function duplicateKeys(text) {
  const problems = [];
  const stack = [];            /* [{ indent, keys:Set }] */
  let blockIndent = null;      /* inside a | or > scalar */

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;

    if (blockIndent !== null) {
      if (indent > blockIndent) continue;
      blockIndent = null;
    }

    const m = /^(\s*)(?:-\s+)?([A-Za-z_][A-Za-z0-9_.-]*):(?:\s|$)(.*)$/.exec(raw);
    if (!m) continue;

    /* For "- key: value" the mapping starts at the key's column. */
    const dash = /^(\s*)-\s+/.exec(raw);
    const keyIndent = dash ? dash[1].length + 2 : m[1].length;
    const key = m[2];
    const rest = m[3].trim();

    if (dash) {
      /* Every "- key:" begins a fresh mapping, even at the same column. */
      while (stack.length && stack[stack.length - 1].indent >= keyIndent) stack.pop();
      stack.push({ indent: keyIndent, keys: new Set() });
    } else {
      while (stack.length && stack[stack.length - 1].indent > keyIndent) stack.pop();
      if (!stack.length || stack[stack.length - 1].indent < keyIndent) {
        stack.push({ indent: keyIndent, keys: new Set() });
      }
    }
    const scope = stack[stack.length - 1];
    if (scope.keys.has(key)) problems.push({ key, line: i + 1 });
    scope.keys.add(key);

    if (/^[|>][+-]?$/.test(rest)) blockIndent = keyIndent;
  }
  return problems;
}

test('workflow files exist', () => {
  assert.ok(FILES.includes('build.yml'));
  assert.ok(FILES.includes('release.yml'));
});

for (const file of FILES) {
  test(`${file}: no duplicate mapping keys`, () => {
    const problems = duplicateKeys(readFileSync(join(DIR, file), 'utf8'));
    assert.deepEqual(problems, [], `duplicate keys: ${JSON.stringify(problems)}`);
  });
}

test('the duplicate-key detector actually catches the regression', () => {
  const bad = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: actions/setup-java@v5',
    '        if: true',
    '        with:',
    "          java-version: '17'",
    '        if: true',
  ].join('\n');
  assert.deepEqual(duplicateKeys(bad), [{ key: 'if', line: 8 }]);
});

test('the detector ignores colons inside block scalars', () => {
  const ok = [
    'jobs:',
    '  publish:',
    '    steps:',
    '      - name: Notes',
    '        run: |',
    '          echo hi',
    '          Windows: needs WebView2',
    '          Windows: really',
    '      - name: Other',
    '        run: echo done',
  ].join('\n');
  assert.deepEqual(duplicateKeys(ok), []);
});

test('release workflow only publishes on tags or manual dispatch', () => {
  const text = readFileSync(join(DIR, 'release.yml'), 'utf8');
  const on = /^on:\n([\s\S]*?)\npermissions:/m.exec(text);
  assert.ok(on, 'release.yml declares its triggers before permissions');
  assert.match(on[1], /tags:\s*\['v\*'\]/);
  assert.doesNotMatch(on[1], /branches:/, 'release must not run on branch pushes');
});

test('no workflow depends on the failing third-party Android setup action', () => {
  for (const file of FILES) {
    const text = readFileSync(join(DIR, file), 'utf8');
    assert.ok(!text.includes('android-actions/setup-android'),
      `${file} must use the runner's preinstalled SDK`);
  }
});

test('the release builds the compiler for Windows, Linux and Android', () => {
  const text = readFileSync(join(DIR, 'release.yml'), 'utf8');
  const calls = [...text.matchAll(/node scripts\/build-ui\.mjs([^\n]*)/g)]
    .map((m) => m[1])
    .filter((a) => !a.includes('--assets-only'));
  assert.equal(calls.length, 1, 'release self-hosts the compiler exactly once');
  const targets = calls[0];
  for (const needed of ['windows-x64', 'windows-x86', 'linux-x64', 'android-apk']) {
    assert.ok(targets.includes(needed), `release compiler targets include ${needed}`);
  }
});

test('release workflow marks semver prereleases and never makes them latest', () => {
  const text = readFileSync(join(DIR, 'release.yml'), 'utf8');
  assert.match(text, /prerelease:\s*\$\{\{\s*steps\.kind\.outputs\.prerelease\s*\}\}/);
  assert.match(text, /make_latest:\s*false/);
  // The decision step must recognise the semver prerelease suffix.
  assert.match(text, /grep -q '-'/);
  assert.match(text, /prerelease=true/);
  assert.match(text, /prerelease=false/);
});

test('README links to the releases page', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /https:\/\/github\.com\/AlexeyNaverno\/EasyAnyHtmlUIProgramm\/releases/);
  // /releases/latest 404s while only prereleases exist, so the download
  // section must point at the list instead.
  const download = /^## .*Скачать[^\n]*\n([\s\S]*?)\n---$/m.exec(readme);
  assert.ok(download, 'README has a download section');
  assert.match(download[1], /\/releases\)/);
});
