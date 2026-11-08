/**
 * Locate the generic native runtimes.
 *
 * Resolution order:
 *   1. an explicit directory (EASYAPP_RUNTIMES or the `dir` option)
 *   2. build/runtimes in the repository, produced by scripts/build-runtimes.mjs
 *   3. fall back to invoking the real toolchain and caching nothing
 *
 * The prebuilt files are generated from source when the compiler is built; they
 * are never committed. See docs/ARCHITECTURE.md for why this keeps the project
 * F-Droid compatible.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT, makeWorkDir, cleanup,
  buildWindowsHost, buildWindowsInstaller, buildLinuxHost,
} from './toolchain.js';

export const RUNTIME_NAMES = {
  windowsHost: (arch) => `windows-host-${arch}.exe`,
  windowsInstaller: (arch) => `windows-installer-${arch}.exe`,
  linuxHost: (arch) => `linux-host-${arch}`,
  androidDex: () => 'android-runtime.dex',
};

export function runtimeDir(explicit) {
  return explicit || process.env.EASYAPP_RUNTIMES || join(REPO_ROOT, 'build', 'runtimes');
}

export function hasRuntime(name, dir) {
  return existsSync(join(runtimeDir(dir), name));
}

export function readRuntime(name, dir) {
  const path = join(runtimeDir(dir), name);
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

/** What is available without running any compiler; used by doctor and the UI. */
export function runtimeStatus(dir) {
  return {
    dir: runtimeDir(dir),
    windowsX64: hasRuntime(RUNTIME_NAMES.windowsHost('x64'), dir)
      && hasRuntime(RUNTIME_NAMES.windowsInstaller('x64'), dir),
    windowsX86: hasRuntime(RUNTIME_NAMES.windowsHost('x86'), dir)
      && hasRuntime(RUNTIME_NAMES.windowsInstaller('x86'), dir),
    linuxX64: hasRuntime(RUNTIME_NAMES.linuxHost('x64'), dir),
    androidDex: hasRuntime(RUNTIME_NAMES.androidDex(), dir),
  };
}

/**
 * Windows host + installer bytes, prebuilt when possible.
 * `kind: 'portable'` does not need the installer at all.
 */
export async function getWindowsRuntimes(arch, { kind = 'installer', dir, onLog = () => {} } = {}) {
  const host = readRuntime(RUNTIME_NAMES.windowsHost(arch), dir);
  const installer = kind === 'portable' ? null : readRuntime(RUNTIME_NAMES.windowsInstaller(arch), dir);
  if (host && (kind === 'portable' || installer)) {
    onLog(`Using the prebuilt ${arch} runtime (no compiler needed)`);
    return { host, installer, source: 'prebuilt' };
  }

  onLog(`Prebuilt ${arch} runtime not found; compiling with Zig…`);
  const work = makeWorkDir('easyapp-rt-');
  try {
    const hostPath = join(work, 'host.exe');
    await buildWindowsHost({ arch, outPath: hostPath });
    let installerBytes = null;
    if (kind !== 'portable') {
      const installerPath = join(work, 'setup.exe');
      await buildWindowsInstaller({ arch, outPath: installerPath });
      installerBytes = new Uint8Array(readFileSync(installerPath));
    }
    return {
      host: new Uint8Array(readFileSync(hostPath)),
      installer: installerBytes,
      source: 'toolchain',
    };
  } finally {
    cleanup(work);
  }
}

/** Linux WebKitGTK host bytes, prebuilt when possible. */
export async function getLinuxRuntimes({ arch = 'x64', dir, onLog = () => {} } = {}) {
  const host = readRuntime(RUNTIME_NAMES.linuxHost(arch), dir);
  if (host) {
    onLog('Using the prebuilt Linux runtime (no compiler needed)');
    return { host, source: 'prebuilt' };
  }
  onLog('Prebuilt Linux runtime not found; compiling with the C toolchain…');
  const work = makeWorkDir('easyapp-rt-');
  try {
    const hostPath = join(work, 'app');
    await buildLinuxHost({ outPath: hostPath });
    return { host: new Uint8Array(readFileSync(hostPath)), source: 'toolchain' };
  } finally {
    cleanup(work);
  }
}
