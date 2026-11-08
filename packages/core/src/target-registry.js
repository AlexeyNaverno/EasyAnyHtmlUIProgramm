/**
 * Descriptions of the build targets, including the toolchain each one needs.
 * The UI renders this list, and `doctor` reports what is available locally.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const TARGETS = Object.freeze([
  {
    id: 'android-apk',
    label: 'Android (.apk)',
    platform: 'android',
    extension: 'apk',
    kind: 'native',
    description: 'Устанавливаемый APK с WebView-рантаймом. Права попадают в AndroidManifest только при включении.',
    requires: ['java17', 'androidSdk'],
    producesProject: true,
  },
  {
    id: 'windows-x64',
    label: 'Windows x64 (.exe установщик)',
    platform: 'windows',
    arch: 'x64',
    extension: 'exe',
    kind: 'installer',
    description: 'Установщик с ярлыками и записью в «Программы и компоненты». Требует WebView2 Runtime на ПК.',
    requires: ['zig'],
    producesProject: true,
  },
  {
    id: 'windows-x86',
    label: 'Windows x86 (.exe установщик)',
    platform: 'windows',
    arch: 'x86',
    extension: 'exe',
    kind: 'installer',
    description: '32-битный установщик для старых систем.',
    requires: ['zig'],
    producesProject: true,
  },
  {
    id: 'windows-portable-x64',
    label: 'Windows x64 (portable .zip)',
    platform: 'windows',
    arch: 'x64',
    extension: 'zip',
    kind: 'portable',
    description: 'Portable-версия без установки: распаковать и запустить.',
    requires: ['zig'],
    producesProject: true,
  },
  {
    id: 'linux-x64',
    label: 'Linux x64 (.tar.gz + .deb)',
    platform: 'linux',
    arch: 'x64',
    extension: 'tar.gz',
    kind: 'native',
    description: 'Нативный WebKitGTK-хост. Нужны gtk+-3.0 и webkit2gtk-4.1 для сборки.',
    requires: ['cc', 'webkit2gtk'],
    producesProject: true,
  },
  {
    id: 'web-bundle',
    label: 'Веб-бандл (.zip)',
    platform: 'web',
    extension: 'zip',
    kind: 'portable',
    description: 'Нормализованный ZIP с рантайм-мостом. Полезно для проверки и ручной сборки.',
    requires: [],
    producesProject: false,
  },
  {
    id: 'source-project',
    label: 'Исходный проект (.zip)',
    platform: 'all',
    extension: 'zip',
    kind: 'source',
    description: 'Полные исходники рантайма и вашего UI для сборки вручную или в CI (подходит для F-Droid).',
    requires: [],
    producesProject: true,
  },
]);

export function getTarget(id) {
  const target = TARGETS.find((t) => t.id === id);
  if (!target) {
    throw new Error(`Unknown target "${id}". Available: ${TARGETS.map((t) => t.id).join(', ')}`);
  }
  return target;
}

export function describeTargets() {
  return TARGETS.map((t) => ({
    id: t.id,
    label: t.label,
    extension: t.extension,
    description: t.description,
    requires: t.requires,
  }));
}
