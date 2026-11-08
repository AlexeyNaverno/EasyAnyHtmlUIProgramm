#!/usr/bin/env node
/**
 * Verify APKs produced by the pure-JS packager using the real Android tools.
 *
 * The AXML, resources.arsc and v2 signature encoders are hand-written, so they
 * are checked against aapt2, zipalign and apksigner rather than only against our
 * own readers. Requires ANDROID_HOME with build-tools installed.
 *
 * Usage: node scripts/verify-apk.mjs <dir-or-apk> [...]
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node scripts/verify-apk.mjs <dir-or-apk> [...]');
  process.exit(2);
}

const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!home || !existsSync(home)) {
  console.error('ANDROID_HOME is not set; cannot verify with the Android tools');
  process.exit(2);
}

const btRoot = join(home, 'build-tools');
const versions = readdirSync(btRoot).filter((v) => /^\d/.test(v))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
if (!versions.length) { console.error('No build-tools installed'); process.exit(2); }
const bt = join(btRoot, versions[0]);
console.log(`Using build-tools ${versions[0]}`);

const apks = [];
for (const arg of args) {
  if (!existsSync(arg)) { console.error(`error: ${arg} does not exist`); process.exitCode = 1; continue; }
  if (statSync(arg).isDirectory()) {
    for (const f of readdirSync(arg)) if (f.endsWith('.apk')) apks.push(join(arg, f));
  } else apks.push(arg);
}
if (!apks.length) { console.error('error: no APK files found'); process.exit(1); }

let failed = 0;
const badging = new Map();

function run(tool, toolArgs, { capture = false } = {}) {
  const path = join(bt, tool);
  const res = spawnSync(path, toolArgs, { encoding: 'utf8' });
  if (res.error) { console.error(`error: cannot run ${tool}: ${res.error.message}`); return { ok: false }; }
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (!capture) process.stdout.write(out);
  if (res.status !== 0) {
    // Print every line so ci-run.mjs can turn it into an annotation.
    for (const line of out.split(/\r?\n/).filter(Boolean)) console.error(`error: ${tool}: ${line}`);
    return { ok: false, out };
  }
  return { ok: true, out };
}

for (const apk of apks) {
  console.log(`\n=== ${apk} ===`);
  const badge = run('aapt2', ['dump', 'badging', apk], { capture: true });
  if (!badge.ok) { failed += 1; continue; }
  badging.set(apk, badge.out);
  for (const line of badge.out.split('\n')) {
    if (/^(package|application-label|sdkVersion|targetSdkVersion|uses-permission|launchable-activity)/.test(line)) {
      console.log(`  ${line}`);
    }
  }
  if (!run('zipalign', ['-c', '4', apk]).ok) failed += 1;
  if (!run('apksigner', ['verify', '--verbose', '--print-certs', apk]).ok) failed += 1;
}

/* The permission gate is a core promise: check it with aapt2, not with our code. */
const hello = [...badging].find(([p]) => /Hello/i.test(p));
const net = [...badging].find(([p]) => /Files_and_Net|Files.and.Net/i.test(p));
if (hello && net) {
  const has = ([, text]) => /uses-permission:.*android\.permission\.INTERNET/.test(text);
  if (has(hello)) { console.error('error: Hello must not request INTERNET'); failed += 1; }
  else if (!has(net)) { console.error('error: Files_and_Net_Demo must request INTERNET'); failed += 1; }
  else console.log('\nPermission gating verified by aapt2');
}

console.log(`\n${apks.length} APK(s) checked, ${failed} failure(s)`);
if (failed) process.exitCode = 1;
