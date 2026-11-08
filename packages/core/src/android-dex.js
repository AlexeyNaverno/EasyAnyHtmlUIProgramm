/**
 * Produce the generic Android runtime DEX.
 *
 * The runtime activity reads its manifest from assets and never references R or
 * BuildConfig, so the compiled code is identical for every generated app. Build
 * it once with the real Android toolchain, then reuse the DEX on devices that
 * have no SDK.
 *
 * Node-only: this is a build-time step, never part of the browser bundle.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

import { loadBundle, strToU8 } from './bundle.js';
import { buildAndroidProject } from './targets.js';
import {
  readTemplateTree, makeWorkDir, writeTree, cleanup, buildAndroidApk,
} from './toolchain.js';
import { RUNTIME_NAMES } from './runtimes.js';

/**
 * @param {{outDir: string, onLog?: (m: string) => void}} options
 * @returns {Promise<string>} path of the written android-runtime.dex
 */
export async function buildAndroidDex({ outDir, onLog = () => {} }) {
  // A placeholder bundle: its contents never reach the DEX.
  const bundle = loadBundle(strToU8(
    '<!-- easyapp:name EasyApp Runtime --><!-- easyapp:id org.easyapp.runtime -->'
    + '<html><head><title>runtime</title></head><body></body></html>',
  ), { filename: 'index.html' });

  const bridge = readFileSync(
    join(new URL('.', import.meta.url).pathname, '../runtime/bridge.js'), 'utf8',
  );
  const project = buildAndroidProject(bundle, bridge, readTemplateTree('templates/runtime-android'));

  const work = makeWorkDir('easyapp-dex-');
  try {
    writeTree(work, project.files);
    onLog('Building the runtime with Gradle…');
    const apkPath = await buildAndroidApk({ projectDir: work, release: true });
    const files = unzipSync(new Uint8Array(readFileSync(apkPath)));
    const dexNames = Object.keys(files).filter((n) => /^classes\d*\.dex$/.test(n)).sort();
    if (dexNames.length === 0) throw new Error('Gradle produced no classes.dex');
    if (dexNames.length > 1) {
      throw new Error(
        `Runtime split into ${dexNames.length} DEX files (${dexNames.join(', ')}); `
        + 'the on-device packager expects exactly one. Reduce runtime dependencies.',
      );
    }
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, RUNTIME_NAMES.androidDex());
    writeFileSync(out, files[dexNames[0]]);
    onLog(`Runtime DEX: ${files[dexNames[0]].length} bytes`);
    return out;
  } finally {
    cleanup(work);
  }
}
