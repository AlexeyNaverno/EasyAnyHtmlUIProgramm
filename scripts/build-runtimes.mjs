#!/usr/bin/env node
/**
 * Build the generic native runtimes from source, once.
 *
 * The runtimes do not depend on any user bundle, so they can be compiled ahead
 * of time and embedded into the compiler app. Packaging a user's HTML then
 * needs no C toolchain, no JDK and no Android SDK on the device.
 *
 * Nothing produced here is committed: F-Droid and CI regenerate it from source.
 *
 * Usage:
 *   node scripts/build-runtimes.mjs [--strict] [--out DIR] [name...]
 * Names: windows-x64 windows-x86 linux-x64 android   (default: all available)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  REPO_ROOT, buildWindowsHost, buildWindowsInstaller, buildLinuxHost, findZig,
} from '../packages/core/src/toolchain.js';
import { RUNTIME_NAMES } from '../packages/core/src/runtimes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const outIdx = args.indexOf('--out');
const OUT = outIdx === -1 ? join(REPO_ROOT, 'build', 'runtimes') : args[outIdx + 1];
const outValueIdx = outIdx === -1 ? -1 : outIdx + 1;
const requested = args.filter((a, i) => !a.startsWith('--') && i !== outValueIdx);
const wanted = requested.length ? requested : ['windows-x64', 'windows-x86', 'linux-x64', 'android'];

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const entries = [];
const failures = [];

/* Zig writes debug side files next to the output; they are not runtimes. */
function dropSideFiles(path) {
  for (const suffix of ['.pdb', '.lib']) {
    const side = path.replace(/\.exe$/, '') + suffix;
    if (existsSync(side)) rmSync(side, { force: true });
  }
}

function record(name, path, tool) {
  dropSideFiles(path);
  const bytes = new Uint8Array(readFileSync(path));
  entries.push({ name, file: name, bytes: bytes.length, sha256: sha256(bytes), builtWith: tool });
  console.log(`  OK: ${name} (${(bytes.length / 1024).toFixed(1)} KiB)`);
}

async function attempt(label, fn) {
  console.log(`\n=== ${label} ===`);
  try {
    await fn();
    return true;
  } catch (err) {
    failures.push({ label, message: err.message });
    console.log(`  ${strict ? 'FAILED' : 'SKIP'}: ${err.message.split('\n')[0]}`);
    return false;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const zig = await findZig();

  for (const arch of ['x64', 'x86']) {
    if (!wanted.includes(`windows-${arch}`)) continue;
    await attempt(`windows-${arch}`, async () => {
      if (!zig.available) throw new Error('Zig was not found (pip install ziglang)');
      const host = join(OUT, RUNTIME_NAMES.windowsHost(arch));
      const setup = join(OUT, RUNTIME_NAMES.windowsInstaller(arch));
      await buildWindowsHost({ arch, outPath: host });
      record(RUNTIME_NAMES.windowsHost(arch), host, `zig ${zig.version}`);
      await buildWindowsInstaller({ arch, outPath: setup });
      record(RUNTIME_NAMES.windowsInstaller(arch), setup, `zig ${zig.version}`);
    });
  }

  if (wanted.includes('linux-x64')) {
    await attempt('linux-x64', async () => {
      const host = join(OUT, RUNTIME_NAMES.linuxHost('x64'));
      await buildLinuxHost({ outPath: host });
      record(RUNTIME_NAMES.linuxHost('x64'), host, process.env.CC || 'cc');
    });
  }

  if (wanted.includes('android')) {
    await attempt('android', async () => {
      const { buildAndroidDex } = await import('../packages/core/src/android-dex.js');
      const dex = await buildAndroidDex({ outDir: OUT });
      record(RUNTIME_NAMES.androidDex(), dex, 'gradle + d8');
    });
  }

  const manifest = {
    generatedBy: 'scripts/build-runtimes.mjs',
    note: 'Generic runtimes built from source; they contain no user data.',
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeFileSync(join(OUT, 'runtimes.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n${entries.length} runtime file(s) in ${OUT}`);

  if (failures.length) {
    console.log(`${failures.length} target(s) unavailable: ${failures.map((f) => f.label).join(', ')}`);
    if (strict) {
      for (const f of failures) console.error(`\n--- ${f.label} ---\n${f.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
