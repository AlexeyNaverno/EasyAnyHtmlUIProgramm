/**
 * Assemble a signed APK from a bundle and a prebuilt runtime DEX.
 *
 * MainActivity.kt reads everything it needs from assets/www/__easyapp_manifest.json
 * and never touches R or BuildConfig, so one generic classes.dex serves every
 * generated app. What changes per app is the manifest, the resource table, the
 * icon and the assets, all of which are produced here without aapt2, d8 or the
 * Android SDK.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { buildWwwTree, normalizeTree } from '../targets.js';
import { safeStem } from '../packaging.js';
import { buildAndroidManifest, ICON_PATH } from './manifest.js';
import { makeLauncherIcon } from './icon.js';
import { writeZip } from './zip.js';
import { signApkV2, createSignerIdentity } from './sign-v2.js';

/**
 * @param {object} bundle    loaded bundle
 * @param {string} bridgeJs  bridge source
 * @param {object} options
 * @param {Uint8Array} options.dex       generic runtime classes.dex
 * @param {object} [options.identity]    reuse to keep updates installable
 * @param {Uint8Array} [options.icon]    override the generated launcher icon
 * @returns {Promise<{filename, bytes, warnings, identity, identityCreated}>}
 */
export async function packageApk(bundle, bridgeJs, { dex, identity = null, icon = null } = {}) {
  if (!dex || !dex.length) throw new Error('Android runtime DEX is missing');
  if (dex.length < 4 || String.fromCharCode(...dex.subarray(0, 3)) !== 'dex') {
    throw new Error('Android runtime is not a DEX file');
  }

  const normalized = normalizeTree(buildWwwTree(bundle, bridgeJs));
  const { axml, arsc } = buildAndroidManifest(bundle.manifest);

  const entries = [
    { name: 'AndroidManifest.xml', data: axml },
    { name: 'classes.dex', data: dex },
    // API 30+ requires resources.arsc to be stored uncompressed and aligned.
    { name: 'resources.arsc', data: arsc, store: true },
    { name: ICON_PATH, data: icon || makeLauncherIcon(192), store: true },
  ];
  for (const [name, data] of normalized.files) {
    entries.push({ name: `assets/www/${name}`, data });
  }

  const zip = writeZip(entries);
  let signer = identity;
  let identityCreated = false;
  if (!signer) {
    signer = await createSignerIdentity({ commonName: bundle.manifest.name || 'EasyApp' });
    identityCreated = true;
  }
  const bytes = await signApkV2(zip, signer);

  return {
    filename: `${safeStem(bundle.manifest.name)}.apk`,
    bytes,
    warnings: normalized.warnings,
    identity: signer,
    identityCreated,
  };
}
