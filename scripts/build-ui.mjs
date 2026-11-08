/**
 * Build the compiler UI into a standalone bundle, then package the compiler
 * itself with its own engine (self-hosting).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from '../packages/core/src/compiler.js';
import { strToU8 } from '../packages/core/src/bundle.js';
import { zipSync } from 'fflate';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const UI = join(ROOT, 'apps/ui');
const OUT = join(ROOT, 'build/ui');

function walk(dir, prefix = '', { skipGenerated = false } = {}) {
  const out = new Map();
  for (const entry of readdirSync(dir)) {
    if (['build', '.gradle', '.git', 'node_modules'].includes(entry)) continue;
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    // Assets and local.properties are produced by prepare-fdroid.mjs; embedding
    // them would duplicate the payload and ship stale files.
    if (skipGenerated && (rel === 'app/src/main/assets' || rel === 'local.properties')) continue;
    if (statSync(full).isDirectory()) {
      for (const [k, v] of walk(full, rel, { skipGenerated })) out.set(k, v);
    } else {
      out.set(rel, new Uint8Array(readFileSync(full)));
    }
  }
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // 1. Bundle the UI modules for a browser/WebView context.
  const result = await build({
    entryPoints: [join(UI, 'app.js')],
    bundle: true,
    format: 'iife',
    target: ['chrome90', 'safari13'],
    write: false,
    minify: true,
    legalComments: 'none',
  });
  const appJs = result.outputFiles[0].text;

  // 2. Embed the Android template and the runtime bridge so the standalone
  //    compiler can emit source projects without a server.
  const templates = walk(join(ROOT, 'templates/runtime-android'), '', { skipGenerated: true });

  // Keys stay relative, matching what buildAndroidProject expects.
  const templateMap = {};
  for (const [name, data] of templates) templateMap[name] = Buffer.from(data).toString('base64');

  const bridgeSource = readFileSync(join(ROOT, 'packages/core/runtime/bridge.js'), 'utf8');

  const preamble = [
    `globalThis.__EASYAPP_TEMPLATES__ = ${JSON.stringify(templateMap)};`,
    `globalThis.__EASYAPP_BRIDGE_SOURCE__ = ${JSON.stringify(bridgeSource)};`,
  ].join('\n');

  writeFileSync(join(OUT, 'app.js'), `${preamble}\n${appJs}`);

  // 3. Copy the static shell, switching the module script to a plain script.
  let html = readFileSync(join(UI, 'index.html'), 'utf8');
  html = html.replace('<script src="./app.js" type="module"></script>', '<script src="./app.js"></script>');
  // The compiler app itself needs file access to read bundles and save results.
  const directives = [
    '<!-- easyapp:name EasyApp Compiler -->',
    '<!-- easyapp:id org.easyapp.compiler -->',
    '<!-- easyapp:version 0.1.0 -->',
    '<!-- easyapp:permission files -->',
    '<!-- easyapp:description Компилятор HTML/ZIP в APK, EXE и Linux -->',
  ].join('\n');
  html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${directives}`);
  writeFileSync(join(OUT, 'index.html'), html);
  writeFileSync(join(OUT, 'style.css'), readFileSync(join(UI, 'style.css')));

  // 4. Package the compiler with its own engine.
  const uiFiles = walk(OUT);
  const zip = zipSync(Object.fromEntries(uiFiles), { level: 6 });
  const distDir = join(ROOT, 'dist/compiler');
  mkdirSync(distDir, { recursive: true });

  const args = process.argv.slice(2);
  // F-Droid builds the APK with its own Gradle invocation, so it only needs the
  // generated web assets, not the packaged artefacts.
  const assetsOnly = args.includes('--assets-only');
  const requested = args.filter((a) => !a.startsWith('--'));
  const targets = requested.length ? requested : ['windows-x64', 'windows-x86', 'windows-portable-x64'];

  console.log(`UI bundle: ${uiFiles.size} files, ${(zip.length / 1024).toFixed(1)} KiB`);
  if (assetsOnly) {
    console.log(`Assets written to ${OUT} (assets-only mode)`);
    return;
  }
  for (const target of targets) {
    process.stdout.write(`\n=== ${target} ===\n`);
    try {
      const res = await compile(zip, {
        filename: 'compiler-ui.zip',
        target,
        outDir: distDir,
        onLog: (m) => console.log(`  ${m}`),
      });
      console.log(`  OK: ${res.filename} (${(res.bytes.length / 1024).toFixed(1)} KiB)`);
    } catch (err) {
      console.log(`  SKIP: ${err.message.split('\n')[0]}`);
      if (err.projectZip) console.log(`  Project: ${err.projectZip}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
