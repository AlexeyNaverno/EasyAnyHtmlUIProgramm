/**
 * Generate gradle-wrapper.jar for a project using a system Gradle.
 * The JAR is a build artefact, never committed: F-Droid builds from source and
 * `gradle wrapper` reproduces it deterministically from the pinned version.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { run } from '../packages/core/src/toolchain.js';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const dir = resolve(process.argv[2] || 'templates/runtime-android');
if (!existsSync(join(dir, 'settings.gradle.kts'))) {
  console.error(`Not a Gradle project: ${dir}`);
  process.exit(1);
}
try {
  await run('gradle', ['wrapper', '--gradle-version', '8.7', '--distribution-type', 'bin'], { cwd: dir });
  console.log(`Wrapper generated in ${dir}`);
} catch (err) {
  console.error(`Cannot generate the wrapper: ${err.message}`);
  console.error('Install Gradle 8.7+ first, or let CI do it (the release workflow does).');
  process.exit(1);
}
