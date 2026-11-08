/**
 * Pure artefact assembly: bundle + prebuilt runtime bytes -> shippable file.
 *
 * The native runtimes are generic. The Windows host and installer read the
 * application id, name and permissions from `www/__easyapp_manifest.json` at
 * run time, and the Linux host does the same, so nothing in the compiled C
 * depends on the user's HTML. That means the C toolchain is only needed once,
 * when the compiler itself is built. Packaging a user's app afterwards is pure
 * data manipulation and runs anywhere, including inside the compiler's own
 * Android app.
 *
 * This module must stay browser-safe: no node:fs, no node:path, no toolchain.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { packZip, strToU8 } from './bundle.js';
import { buildDesktopPayload, buildLinuxExtras } from './targets.js';

/** Mirror of the CLI's artefact naming so both paths agree. */
export function safeStem(name) {
  return String(name).replace(/[^\w.\- ]+/g, '_').trim().replace(/\s+/g, '_') || 'EasyApp';
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Installer layout: stub || ZIP || "EAPK" || uint32le(zip length).
 * The stub finds the payload by reading the last eight bytes of itself.
 */
export function wrapInstaller(stub, payloadZip) {
  const trailer = new Uint8Array(8);
  trailer.set(strToU8('EAPK'), 0);
  new DataView(trailer.buffer).setUint32(4, payloadZip.length, true);
  return concatBytes([stub, payloadZip, trailer]);
}

/**
 * Build a Windows artefact from prebuilt runtime binaries.
 * @param {object} bundle    loaded bundle
 * @param {string} bridgeJs  injected bridge source
 * @param {object} runtimes  { host: Uint8Array, installer?: Uint8Array }
 * @param {object} options   { arch: 'x64'|'x86', kind: 'installer'|'portable' }
 */
export function packageWindows(bundle, bridgeJs, runtimes, { arch = 'x64', kind = 'installer' } = {}) {
  if (!runtimes || !runtimes.host) throw new Error('Windows host runtime is missing');
  const stem = safeStem(bundle.manifest.name);
  const payload = buildDesktopPayload(bundle, bridgeJs, {
    hostBinary: runtimes.host, hostName: 'app.exe',
  });

  if (kind === 'portable') {
    return {
      filename: `${stem}-windows-${arch}-portable.zip`,
      bytes: payload.zip,
      warnings: payload.warnings,
    };
  }
  if (!runtimes.installer) throw new Error('Windows installer runtime is missing');
  return {
    filename: `${stem}-setup-${arch}.exe`,
    bytes: wrapInstaller(runtimes.installer, payload.zip),
    warnings: payload.warnings,
  };
}

/** Per-user install script shipped inside the Linux archive. */
export function linuxInstallScript(bundle) {
  const m = bundle.manifest;
  return `#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs ${m.name} for the current user.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="\${XDG_DATA_HOME:-$HOME/.local/share}/EasyApp/${m.id}"
mkdir -p "$TARGET"
cp -r "$DIR/www" "$TARGET/"
cp "$DIR/app" "$TARGET/app"
chmod +x "$TARGET/app"
mkdir -p "\${XDG_DATA_HOME:-$HOME/.local/share}/applications"
cat > "\${XDG_DATA_HOME:-$HOME/.local/share}/applications/${m.id}.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=${m.name}
Exec=$TARGET/app
Terminal=false
Categories=Utility;
DESKTOP
echo "Installed. Launch '${m.name}' from your application menu, or run: $TARGET/app"
`;
}

/** Build a Linux archive from a prebuilt WebKitGTK host. */
export function packageLinux(bundle, bridgeJs, runtimes, { arch = 'x64' } = {}) {
  if (!runtimes || !runtimes.host) throw new Error('Linux host runtime is missing');
  const stem = safeStem(bundle.manifest.name);
  const payload = buildDesktopPayload(bundle, bridgeJs, {
    hostBinary: runtimes.host, hostName: 'app',
  });
  const files = new Map(payload.files);
  files.set(`${stem}.desktop`, strToU8(buildLinuxExtras(bundle).desktop));
  files.set('install.sh', strToU8(linuxInstallScript(bundle)));
  files.set('run.sh', strToU8('#!/bin/sh\nexec "$(dirname "$0")/app" "$@"\n'));
  return {
    filename: `${stem}-linux-${arch}.zip`,
    bytes: packZip(files),
    warnings: payload.warnings,
  };
}
