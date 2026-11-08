/**
 * Browser-safe re-exports of the compiler core.
 * This module must never import node:fs or the native toolchain drivers.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
export { loadBundle, normalizeBundlePath, packZip, strToU8, strFromU8, BundleError } from '../../packages/core/src/bundle.js';
export { buildManifest, parseDirectives, KNOWN_PERMISSIONS, ManifestError } from '../../packages/core/src/manifest.js';
export { lintBundle, buildWwwTree, buildAndroidProject, normalizeTree, normalizeHtmlPaths } from '../../packages/core/src/targets.js';
export { describeTargets, TARGETS, getTarget } from '../../packages/core/src/target-registry.js';
export { buildLlmPrompt } from '../../packages/core/src/prompt.js';
