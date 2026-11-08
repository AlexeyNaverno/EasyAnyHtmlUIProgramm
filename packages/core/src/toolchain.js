/**
 * Toolchain discovery and native build drivers.
 *
 * Every builder shells out to a real, open-source toolchain. Nothing is
 * downloaded implicitly at build time: `doctor` tells the user what to install.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');

export function run(cmd, args, { cwd, env, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    if (quiet) {
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
    }
    child.on('error', (err) => {
      reject(new Error(`Cannot start "${cmd}": ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(
        `"${cmd} ${args.join(' ')}" exited with code ${code}` +
        (quiet && stderr ? `\n${stderr.slice(-4000)}` : ''),
      ));
    });
  });
}

async function probe(cmd, args) {
  try {
    const { stdout, stderr } = await run(cmd, args, { quiet: true });
    const text = (stdout.trim() || stderr.trim());
    return { available: true, version: text.split('\n')[0].slice(0, 120) };
  } catch {
    return { available: false, version: null };
  }
}

/** Resolve the Zig compiler: a real binary or the `ziglang` Python wheel. */
export async function findZig() {
  const direct = await probe('zig', ['version']);
  if (direct.available) return { cmd: 'zig', args: [], ...direct };
  const py = process.env.PYTHON || 'python3';
  const viaPy = await probe(py, ['-m', 'ziglang', 'version']);
  if (viaPy.available) return { cmd: py, args: ['-m', 'ziglang'], ...viaPy };
  return { available: false, version: null };
}

/**
 * Gradle 8.7 runs on JDK 8..21. Newer JDKs make it abort with a cryptic
 * "IllegalArgumentException: <version>", so detect the mismatch up front.
 */
export const GRADLE_MAX_JDK = 21;

export function parseJavaMajor(version) {
  if (!version) return null;
  const m = /(\d+)(?:\.(\d+))?/.exec(version);
  if (!m) return null;
  const first = Number(m[1]);
  // Legacy scheme: 1.8.0_402 means Java 8.
  return first === 1 ? Number(m[2] || 0) : first;
}

export function jdkSupportedByGradle(major) {
  return major === null || (major >= 8 && major <= GRADLE_MAX_JDK);
}

export async function doctor() {
  const zig = await findZig();
  const java = await probe('java', ['-version']);
  const javac = await probe('javac', ['-version']);
  const cc = await probe('cc', ['--version']);
  const gradle = await probe('gradle', ['--version']);
  const pkgConfig = await probe('pkg-config', ['--exists', 'webkit2gtk-4.1']);
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
  const javaMajor = parseJavaMajor(javac.version || java.version);

  return {
    zig: { available: zig.available, version: zig.version },
    java: {
      available: java.available && javac.available,
      version: javac.version || java.version,
      major: javaMajor,
      gradleSupported: jdkSupportedByGradle(javaMajor),
    },
    androidSdk: { available: Boolean(androidHome && existsSync(androidHome)), path: androidHome },
    gradle: { available: gradle.available, version: gradle.version },
    cc: { available: cc.available, version: cc.version },
    webkit2gtk: { available: pkgConfig.available },
  };
}

/** Copy the template directory into a map of relative path -> bytes. */
export function readTemplateTree(relRoot) {
  const root = join(REPO_ROOT, relRoot);
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '.gradle' || entry === 'build' || entry === '.git') continue;
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.set(rel, new Uint8Array(readFileSync(full)));
    }
  };
  walk(root, '');
  return files;
}

export function makeWorkDir(prefix = 'easyapp-') {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeTree(root, files) {
  for (const [rel, data] of files) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
}

export function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/* ------------------------------------------------------------ Windows */

const WIN_LIBS = [
  '-lole32', '-loleaut32', '-luser32', '-lshlwapi', '-lversion',
  '-ladvapi32', '-lwinhttp', '-lshell32', '-lgdi32',
];

export async function buildWindowsHost({ arch = 'x64', outPath, icon = null }) {
  const zig = await findZig();
  if (!zig.available) {
    throw new Error('Zig was not found. Install it with "pip install ziglang" or from https://ziglang.org/download/');
  }
  const target = arch === 'x86' ? 'x86-windows-gnu' : 'x86_64-windows-gnu';
  const args = [
    ...zig.args, 'cc', '-target', target, '-std=c11', '-O2',
    `-I${join(REPO_ROOT, 'native/third_party/webview2')}`,
    `-I${join(REPO_ROOT, 'native/third_party/cjson')}`,
    `-I${join(REPO_ROOT, 'native/host')}`,
  ];
  if (icon) {
    // A compiled .res is produced by the caller; zig cc links it directly.
    args.push(icon);
  }
  args.push(
    join(REPO_ROOT, 'native/host/host_windows.c'),
    join(REPO_ROOT, 'native/host/bridge_core.c'),
    join(REPO_ROOT, 'native/third_party/cjson/cJSON.c'),
    '-o', outPath,
    ...WIN_LIBS,
    '-Wl,--subsystem,windows',
  );
  await run(zig.cmd, args, { quiet: true });
  return outPath;
}

export async function buildWindowsInstaller({ arch = 'x64', outPath }) {
  const zig = await findZig();
  if (!zig.available) throw new Error('Zig was not found. Install it with "pip install ziglang".');
  const target = arch === 'x86' ? 'x86-windows-gnu' : 'x86_64-windows-gnu';
  await run(zig.cmd, [
    ...zig.args, 'cc', '-target', target, '-std=c11', '-O2',
    `-I${join(REPO_ROOT, 'native/installer')}`,
    join(REPO_ROOT, 'native/installer/installer_windows.c'),
    join(REPO_ROOT, 'native/installer/tinyzip.c'),
    '-o', outPath,
    '-lole32', '-loleaut32', '-luser32', '-lshlwapi', '-lshell32', '-ladvapi32', '-lgdi32',
    '-Wl,--subsystem,windows',
  ], { quiet: true });
  return outPath;
}

/* -------------------------------------------------------------- Linux */

export async function buildLinuxHost({ outPath }) {
  const cc = process.env.CC || 'cc';
  const pkgs = ['gtk+-3.0', 'webkit2gtk-4.1'];
  let flags;
  try {
    const { stdout } = await run('pkg-config', ['--cflags', '--libs', ...pkgs], { quiet: true });
    flags = stdout.trim().split(/\s+/);
  } catch {
    throw new Error(
      'WebKitGTK development files were not found.\n'
      + 'Debian/Ubuntu: sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev\n'
      + 'Fedora: sudo dnf install gtk3-devel webkit2gtk4.1-devel',
    );
  }
  await run(cc, [
    '-std=c11', '-O2',
    `-I${join(REPO_ROOT, 'native/host')}`,
    `-I${join(REPO_ROOT, 'native/third_party/cjson')}`,
    join(REPO_ROOT, 'native/host/host_linux.c'),
    join(REPO_ROOT, 'native/host/bridge_core.c'),
    join(REPO_ROOT, 'native/third_party/cjson/cJSON.c'),
    '-o', outPath,
    ...flags,
    '-lm',
  ], { quiet: true });
  return outPath;
}

/* ------------------------------------------------------------ Android */

export async function buildAndroidApk({ projectDir, release = false, signing = null }) {
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidHome || !existsSync(androidHome)) {
    throw new Error(
      'Android SDK was not found. Set ANDROID_HOME, or build the generated project in CI.\n'
      + 'Install: https://developer.android.com/studio#command-tools (cmdline-tools + platform 34 + build-tools)',
    );
  }
  const javac = await probe('javac', ['-version']);
  const javaMajor = parseJavaMajor(javac.version);
  if (!process.env.EASYAPP_SKIP_JDK_CHECK && !jdkSupportedByGradle(javaMajor)) {
    throw new Error(
      `JDK ${javaMajor} is too new for Gradle 8.7 (supported: 8-${GRADLE_MAX_JDK}).\n`
      + 'Install JDK 17 or 21 and point JAVA_HOME at it, for example:\n'
      + '  export JAVA_HOME=/usr/lib/jvm/temurin-17-jdk-amd64\n'
      + 'Set EASYAPP_SKIP_JDK_CHECK=1 to try anyway.',
    );
  }
  writeFileSync(join(projectDir, 'local.properties'), `sdk.dir=${androidHome}\n`);

  const gradlew = process.platform === 'win32'
    ? join(projectDir, 'gradlew.bat')
    : join(projectDir, 'gradlew');
  // The wrapper script alone is not enough: gradle-wrapper.jar is a binary and
  // is deliberately not committed (F-Droid builds from source). Use the wrapper
  // only when the JAR is present, otherwise fall back to a system Gradle.
  const wrapperJar = join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  const useWrapper = existsSync(gradlew) && existsSync(wrapperJar);
  const cmd = useWrapper ? gradlew : 'gradle';
  if (!useWrapper) {
    const g = await probe('gradle', ['--version']);
    if (!g.available) {
      throw new Error(
        'Gradle was not found. Install Gradle 8.7+ (https://gradle.org/install/) '
        + 'or run "gradle wrapper" once inside the project to create gradle-wrapper.jar.',
      );
    }
  } else if (process.platform !== 'win32') {
    await run('chmod', ['+x', gradlew], { quiet: true });
  }

  const args = [release ? 'assembleRelease' : 'assembleDebug', '--no-daemon', '--console=plain'];
  if (signing) {
    args.push(
      `-PsigningStoreFile=${signing.storeFile}`,
      `-PsigningStorePassword=${signing.storePassword}`,
      `-PsigningKeyAlias=${signing.keyAlias}`,
      `-PsigningKeyPassword=${signing.keyPassword}`,
    );
  }
  await run(cmd, args, { cwd: projectDir });

  const flavor = release ? 'release' : 'debug';
  const outDir = join(projectDir, 'app', 'build', 'outputs', 'apk', flavor);
  if (!existsSync(outDir)) throw new Error(`Gradle produced no APK in ${outDir}`);
  const apk = readdirSync(outDir).find((f) => f.endsWith('.apk'));
  if (!apk) throw new Error(`No .apk found in ${outDir}`);
  return join(outDir, apk);
}

export { existsSync, readFileSync, writeFileSync, mkdirSync, join };
