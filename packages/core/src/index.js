/**
 * Public API of the EasyApp compiler core.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  KNOWN_PERMISSIONS,
  IMPLICIT_PERMISSIONS,
  DEFAULT_MANIFEST,
  ManifestError,
  parseDirectives,
  buildManifest,
  validateManifest,
  isValidAppId,
  isValidVersion,
} from './manifest.js';

export {
  BundleError,
  loadBundle,
  normalizeBundlePath,
  packZip,
  strToU8,
  strFromU8,
} from './bundle.js';

export {
  buildWwwTree,
  buildDesktopPayload,
  buildAndroidProject,
  buildLinuxExtras,
  normalizeHtmlPaths,
  normalizeTree,
  lintBundle,
} from './targets.js';

export { buildLlmPrompt, PROMPT_VERSION } from './prompt.js';

export { TARGETS, getTarget, describeTargets } from './target-registry.js';
