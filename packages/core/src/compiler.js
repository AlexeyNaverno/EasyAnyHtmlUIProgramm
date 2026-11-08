/**
 * High-level compilation pipeline: bundle in, artefact out.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

import { loadBundle } from './bundle.js';
import { getTarget } from './target-registry.js';
import {
  buildWwwTree, buildAndroidProject, normalizeTree, lintBundle,
} from './targets.js';
import { packZip, strToU8 } from './bundle.js';
import {
  REPO_ROOT, readTemplateTree, makeWorkDir, writeTree, cleanup, buildAndroidApk,
} from './toolchain.js';
import { getWindowsRuntimes, getLinuxRuntimes } from './runtimes.js';
import { packageWindows, packageLinux } from './packaging.js';

const BRIDGE_PATH = join(REPO_ROOT, 'packages/core/runtime/bridge.js');

export function readBridge() {
  return readFileSync(BRIDGE_PATH, 'utf8');
}

/** Load and validate an input file without building anything. */
export function inspect(bytes, { filename = '', overrides = null } = {}) {
  const bundle = loadBundle(bytes, { filename, overrides });
  const issues = lintBundle(bundle);
  return {
    manifest: bundle.manifest,
    entry: bundle.entry,
    fileCount: bundle.fileCount,
    totalBytes: bundle.totalBytes,
    sourceKind: bundle.sourceKind,
    directives: bundle.directives,
    warnings: bundle.warnings,
    issues,
  };
}

function safeName(name) {
  return String(name).replace(/[^\w.\- ]+/g, '_').trim().replace(/\s+/g, '_') || 'EasyApp';
}

/**
 * Compile a bundle for one target.
 * @returns {Promise<{path: string, filename: string, bytes: Uint8Array, warnings: string[], log: string[]}>}
 */
export async function compile(bytes, {
  filename = '',
  target: targetId,
  overrides = null,
  outDir = join(process.cwd(), 'dist'),
  keepProject = false,
  onLog = () => {},
} = {}) {
  const target = getTarget(targetId);
  const bundle = loadBundle(bytes, { filename, overrides });
  const bridgeJs = readBridge();
  const log = [];
  const say = (msg) => { log.push(msg); onLog(msg); };

  const issues = lintBundle(bundle);
  for (const w of bundle.warnings) say(`warning: ${w}`);
  for (const issue of issues) {
    say(`${issue.level}: ${issue.file}: ${issue.message}`);
    if (issue.level === 'error') {
      throw new Error(`Bundle failed validation: ${issue.file}: ${issue.message}`);
    }
  }

  mkdirSync(outDir, { recursive: true });
  const stem = safeName(bundle.manifest.name);
  say(`Bundle: ${bundle.fileCount} files, ${(bundle.totalBytes / 1024).toFixed(1)} KiB, entry ${bundle.entry}`);
  say(`Permissions: ${bundle.manifest.permissions.join(', ') || '(none)'}`);
  say(`Target: ${target.label}`);

  /* ---------------------------------------------------- source project */
  if (targetId === 'source-project') {
    const files = new Map();
    for (const [name, data] of readTemplateTree('templates/runtime-android')) {
      files.set(`android/${name}`, data);
    }
    const android = buildAndroidProject(bundle, bridgeJs, new Map());
    for (const [name, data] of android.files) files.set(`android/${name}`, data);
    for (const [name, data] of readTemplateTree('native')) files.set(`native/${name}`, data);
    files.set('README.md', strToU8(sourceProjectReadme(bundle)));
    const zip = packZip(files);
    const outName = `${stem}-source.zip`;
    const path = join(outDir, outName);
    writeFileSync(path, zip);
    say(`Written ${path}`);
    return { path, filename: outName, bytes: zip, warnings: android.warnings, log, projectDir: null };
  }

  /* -------------------------------------------------------- web bundle */
  if (targetId === 'web-bundle') {
    const normalized = normalizeTree(buildWwwTree(bundle, bridgeJs));
    const zip = packZip(normalized.files);
    const outName = `${stem}-web.zip`;
    const path = join(outDir, outName);
    writeFileSync(path, zip);
    say(`Written ${path}`);
    return { path, filename: outName, bytes: zip, warnings: normalized.warnings, log, projectDir: null };
  }

  /* ----------------------------------------------------------- Android */
  if (targetId === 'android-apk') {
    const template = readTemplateTree('templates/runtime-android');
    const project = buildAndroidProject(bundle, bridgeJs, template);
    for (const w of project.warnings) say(`warning: ${w}`);
    const projectDir = keepProject ? join(outDir, `${stem}-android`) : makeWorkDir('easyapp-android-');
    writeTree(projectDir, project.files);
    say(`Android project: ${projectDir}`);
    try {
      const apkPath = await buildAndroidApk({ projectDir, release: false });
      const outName = `${stem}.apk`;
      const path = join(outDir, outName);
      const data = new Uint8Array(readFileSync(apkPath));
      writeFileSync(path, data);
      say(`Written ${path}`);
      return {
        path, filename: outName, bytes: data, warnings: project.warnings, log,
        projectDir: keepProject ? projectDir : null,
      };
    } catch (err) {
      // The project is still valuable: keep it so the user can build in CI.
      const fallbackDir = join(outDir, `${stem}-android-project`);
      if (projectDir !== fallbackDir) writeTree(fallbackDir, project.files);
      const zip = packZip(project.files);
      const zipPath = join(outDir, `${stem}-android-project.zip`);
      writeFileSync(zipPath, zip);
      say(`APK build unavailable: ${err.message}`);
      say(`Saved a buildable project instead: ${zipPath}`);
      const e = new Error(
        `${err.message}\n\nThe Android project was exported to ${zipPath}. `
        + 'Build it with Android Studio, "./gradlew assembleDebug", or the included GitHub Actions workflow.',
      );
      e.projectZip = zipPath;
      e.partial = true;
      throw e;
    } finally {
      if (!keepProject) cleanup(projectDir);
    }
  }

  /* ----------------------------------------------------------- Windows */
  if (target.platform === 'windows') {
    // The host and installer are generic: they read the manifest at run time.
    // Prebuilt runtimes make this step pure packaging, so it also works inside
    // the compiler's own Android app where no C toolchain exists.
    const runtimes = await getWindowsRuntimes(target.arch, { kind: target.kind, onLog: say });
    const res = packageWindows(bundle, bridgeJs, runtimes, { arch: target.arch, kind: target.kind });
    for (const w of res.warnings) say(`warning: ${w}`);
    const path = join(outDir, res.filename);
    writeFileSync(path, res.bytes);
    say(`Written ${path} (${(res.bytes.length / 1024).toFixed(1)} KiB)`);
    return {
      path, filename: res.filename, bytes: res.bytes,
      warnings: res.warnings, log, projectDir: null, runtimeSource: runtimes.source,
    };
  }

  /* ------------------------------------------------------------- Linux */
  if (target.platform === 'linux') {
    const runtimes = await getLinuxRuntimes({ arch: target.arch, onLog: say });
    const res = packageLinux(bundle, bridgeJs, runtimes, { arch: target.arch });
    for (const w of res.warnings) say(`warning: ${w}`);
    const path = join(outDir, res.filename);
    writeFileSync(path, res.bytes);
    say(`Written ${path}`);
    return {
      path, filename: res.filename, bytes: res.bytes,
      warnings: res.warnings, log, projectDir: null, runtimeSource: runtimes.source,
    };
  }

  throw new Error(`Target "${targetId}" is not implemented`);
}


function sourceProjectReadme(bundle) {
  const m = bundle.manifest;
  const fence = '```';
  return [
    `# ${m.name} — исходный проект`,
    '',
    'Сгенерировано EasyAnyHtmlUIProgramm.',
    '',
    '- `android/` — Gradle-проект Android.',
    '- `native/` — исходники десктоп-хостов (Windows WebView2, Linux WebKitGTK) и установщика.',
    '',
    `Права: ${m.permissions.join(', ') || 'нет'}`,
    `Идентификатор: ${m.id}`,
    `Версия: ${m.version}`,
    '',
    '## Сборка Android',
    '',
    fence + 'sh',
    'cd android',
    'export ANDROID_HOME=/path/to/android-sdk',
    './gradlew assembleDebug',
    '# APK: app/build/outputs/apk/debug/app-debug.apk',
    fence,
    '',
    '## Сборка Windows',
    '',
    fence + 'sh',
    'zig cc -target x86_64-windows-gnu -std=c11 -O2 \\',
    '  -Inative/third_party/webview2 -Inative/third_party/cjson -Inative/host \\',
    '  native/host/host_windows.c native/host/bridge_core.c native/third_party/cjson/cJSON.c \\',
    '  -o app.exe -lole32 -loleaut32 -luser32 -lshlwapi -lversion -ladvapi32 -lwinhttp -lshell32 -lgdi32 \\',
    '  -Wl,--subsystem,windows',
    fence,
    '',
    '## Сборка Linux',
    '',
    fence + 'sh',
    'cc -std=c11 -O2 -Inative/host -Inative/third_party/cjson \\',
    '  native/host/host_linux.c native/host/bridge_core.c native/third_party/cjson/cJSON.c \\',
    '  -o app $(pkg-config --cflags --libs gtk+-3.0 webkit2gtk-4.1) -lm',
    fence,
    '',
    'Веб-ассеты лежат в `android/app/src/main/assets/www/`. Для десктопа положите их',
    'в каталог `www/` рядом с бинарником.',
    '',
  ].join('\n');
}
