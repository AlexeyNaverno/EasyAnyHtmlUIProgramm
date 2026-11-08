#!/usr/bin/env node
/**
 * Run a build command in CI, echoing its output and turning compiler errors
 * into GitHub annotations so failures are readable straight from the check
 * summary (no need to download the raw log).
 *
 * Usage: node scripts/ci-run.mjs -- <command> [args...]
 * Outside GitHub Actions it behaves like a transparent pass-through.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const args = sep === -1 ? argv : argv.slice(sep + 1);
if (args.length === 0) {
  console.error('Usage: node scripts/ci-run.mjs -- <command> [args...]');
  process.exit(2);
}

/* Workflow-command data must escape these, or the annotation is truncated. */
function escapeData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

const isCi = process.env.GITHUB_ACTIONS === 'true';
const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

let captured = '';
const LIMIT = 512 * 1024;
function collect(chunk, stream) {
  stream.write(chunk);
  if (captured.length < LIMIT) captured += chunk.toString();
}
child.stdout.on('data', (d) => collect(d, process.stdout));
child.stderr.on('data', (d) => collect(d, process.stderr));

child.on('error', (err) => {
  console.error(`Cannot start "${args[0]}": ${err.message}`);
  process.exit(127);
});

child.on('close', (code) => {
  if (code !== 0 && isCi) {
    /* Surface the lines that explain the failure. Keep the original order. */
    const lines = captured.split(/\r?\n/);
    const interesting = lines.filter((l) =>
      /error:|error [A-Z]|fatal error|undefined reference|Cannot find|not found|No such file|FAILURE:|What went wrong|Execution failed|Caused by:|^\s*e:\s|^not ok |AssertionError|ERR_ASSERTION|Cannot find module|SyntaxError|TypeError|ReferenceError/i.test(l));
    const chosen = (interesting.length ? interesting : lines.filter(Boolean)).slice(0, 25);
    for (const line of chosen) {
      const text = line.trim().slice(0, 900);
      if (text) console.log(`::error::${escapeData(text)}`);
    }
    if (lines.length > chosen.length) {
      console.log(`::notice::${escapeData(`${args.join(' ')} failed with code ${code}; see the job log for full output.`)}`);
    }
  }
  process.exit(code === null ? 1 : code);
});
