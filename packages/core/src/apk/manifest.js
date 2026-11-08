/**
 * Build the compiled AndroidManifest.xml and resources.arsc for a bundle.
 *
 * Mirrors templates/runtime-android/app/src/main/AndroidManifest*.xml, but
 * emitted as binary chunks so no aapt2 is needed on the device. The activity
 * theme points straight at the framework theme that the template's AppTheme
 * inherits from, which keeps the appearance identical without shipping a style
 * resource.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { encodeAxml, ATTR, str, int, hex, bool, ref } from './axml.js';
import { encodeArsc } from './arsc.js';

export const MIN_SDK = 24;          // Android 7.0, first version with APK sig v2
export const TARGET_SDK = 34;
export const COMPILE_SDK = 34;
export const ACTIVITY = 'org.easyapp.runtime.MainActivity';
export const ICON_PATH = 'res/drawable/ic_launcher.png';

/* android:style/Theme.Material.Light.NoActionBar, from AOSP public-final.xml */
const FRAMEWORK_THEME = 0x01030241;

/* orientation|screenSize|keyboardHidden|uiMode, same set as the template */
const CONFIG_CHANGES = 0x0020 | 0x0080 | 0x0200 | 0x0400;

const ORIENTATION = { unspecified: -1, landscape: 0, portrait: 1 };

const a = (name, value) => ({ name, value, android: true });
const el = (name, attrs = [], children = []) => ({ name, attrs, children });

/**
 * @param {object} manifest  validated application manifest
 * @returns {{axml: Uint8Array, arsc: Uint8Array, resourceIds: Map<string, number>, iconPath: string}}
 */
export function buildAndroidManifest(manifest) {
  const allowInternet = manifest.permissions.includes('internet');

  const { bytes: arsc, ids } = encodeArsc({
    packageName: manifest.id,
    resources: [
      { type: 'string', name: 'app_name', value: manifest.name },
      { type: 'drawable', name: 'ic_launcher', value: ICON_PATH },
    ],
  });

  const children = [
    el('uses-sdk', [
      a('minSdkVersion', int(MIN_SDK)),
      a('targetSdkVersion', int(TARGET_SDK)),
    ]),
  ];

  // Only "internet" needs a manifest permission; file access uses SAF.
  if (allowInternet) {
    children.push(el('uses-permission', [a('name', str('android.permission.INTERNET'))]));
  }

  children.push(el('application', [
    a('label', ref(ids.get('string/app_name'))),
    a('icon', ref(ids.get('drawable/ic_launcher'))),
    a('theme', ref(FRAMEWORK_THEME)),
    a('allowBackup', bool(true)),
    a('usesCleartextTraffic', bool(false)),
    a('hardwareAccelerated', bool(true)),
    a('supportsRtl', bool(true)),
    a('extractNativeLibs', bool(false)),
  ], [
    el('activity', [
      a('name', str(ACTIVITY)),
      a('exported', bool(true)),
      a('configChanges', hex(CONFIG_CHANGES)),
      a('screenOrientation', int(ORIENTATION[manifest.orientation] ?? -1)),
    ], [
      el('intent-filter', [], [
        el('action', [a('name', str('android.intent.action.MAIN'))]),
        el('category', [a('name', str('android.intent.category.LAUNCHER'))]),
      ]),
    ]),
  ]));

  const root = el('manifest', [
    { name: 'package', value: str(manifest.id), android: false },
    a('versionCode', int(manifest.versionCode)),
    a('versionName', str(manifest.version)),
    a('compileSdkVersion', int(COMPILE_SDK)),
    a('compileSdkVersionCodename', str(String(COMPILE_SDK))),
  ], children);

  return { axml: encodeAxml(root), arsc, resourceIds: ids, iconPath: ICON_PATH };
}

export { ATTR };
