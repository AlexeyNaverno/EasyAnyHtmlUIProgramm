#!/usr/bin/env node
/**
 * EasyApp command line interface.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parseArgs } from 'node:util';

import { inspect, compile } from '../../../packages/core/src/compiler.js';
import { describeTargets, buildLlmPrompt, KNOWN_PERMISSIONS } from '../../../packages/core/src/index.js';
import { doctor } from '../../../packages/core/src/toolchain.js';

const HELP = `EasyAnyHtmlUIProgramm — компилятор HTML/ZIP в нативные приложения

Использование:
  easyapp inspect <file.html|file.zip>       разобрать бандл и показать права
  easyapp build <file> [опции]               собрать приложение
  easyapp targets                            список целей сборки
  easyapp doctor                             проверить установленный тулчейн
  easyapp prompt [--lang ru|en] [-o file]    промт для LLM
  easyapp serve [--port 8080]                локальный веб-интерфейс

Опции сборки:
  -t, --target <id>       цель (по умолчанию windows-x64)
  -o, --out <dir>         каталог результата (по умолчанию ./dist)
      --name <name>       переопределить имя приложения
      --app-id <id>       переопределить идентификатор (org.example.app)
      --app-version <v>   переопределить версию
      --internet <on|off> принудительно вкл/выкл доступ в интернет
      --files <on|off>    принудительно вкл/выкл доступ к файлам
      --keep-project      сохранить сгенерированный проект
      --json              машиночитаемый вывод

Примеры:
  easyapp build app.html -t windows-x64
  easyapp build site.zip -t android-apk --internet on
  easyapp build app.html -t source-project -o ./out
`;

function fail(message, code = 1) {
  console.error(`Ошибка: ${message}`);
  process.exit(code);
}

function overridesFrom(values) {
  const overrides = {};
  if (values.name) overrides.name = values.name;
  if (values['app-id']) overrides.id = values['app-id'];
  if (values['app-version']) overrides.version = values['app-version'];

  const forced = [];
  let touched = false;
  for (const perm of KNOWN_PERMISSIONS) {
    const raw = values[perm];
    if (raw === undefined) continue;
    touched = true;
    if (!['on', 'off', 'true', 'false'].includes(raw)) {
      fail(`--${perm} ожидает on или off`);
    }
    if (raw === 'on' || raw === 'true') forced.push(perm);
  }
  // Only override the permission set when at least one flag was given; the
  // compiler then treats the flag list as the complete desired set.
  if (touched) overrides.permissions = forced;
  return Object.keys(overrides).length ? overrides : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === '--version' || command === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      target: { type: 'string', short: 't', default: 'windows-x64' },
      out: { type: 'string', short: 'o', default: 'dist' },
      name: { type: 'string' },
      'app-id': { type: 'string' },
      'app-version': { type: 'string' },
      internet: { type: 'string' },
      files: { type: 'string' },
      'keep-project': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      lang: { type: 'string', default: 'ru' },
      port: { type: 'string', default: '8080' },
    },
  });

  switch (command) {
    case 'targets': {
      const targets = describeTargets();
      if (values.json) console.log(JSON.stringify(targets, null, 2));
      else for (const t of targets) {
        console.log(`${t.id.padEnd(24)} ${t.label}`);
        console.log(`${''.padEnd(24)} ${t.description}`);
        if (t.requires.length) console.log(`${''.padEnd(24)} требует: ${t.requires.join(', ')}`);
      }
      return;
    }

    case 'doctor': {
      const report = await doctor();
      if (values.json) { console.log(JSON.stringify(report, null, 2)); return; }
      console.log('Проверка тулчейна:\n');
      const rows = [
        ['Zig (Windows .exe)', report.zig],
        ['JDK 17 (Android)', report.java],
        ['Android SDK', report.androidSdk],
        ['Gradle', report.gradle],
        ['C compiler (Linux)', report.cc],
        ['WebKitGTK 4.1 (Linux)', report.webkit2gtk],
      ];
      for (const [label, info] of rows) {
        const mark = info.available ? 'OK  ' : 'нет ';
        console.log(`  [${mark}] ${label.padEnd(24)} ${info.version || info.path || ''}`);
      }
      console.log('\nПодсказки:');
      if (!report.zig.available) console.log('  Zig:        pip install ziglang   (или https://ziglang.org/download/)');
      if (!report.java.available) console.log('  JDK:        sudo apt install openjdk-17-jdk');
      if (!report.androidSdk.available) console.log('  Android SDK: https://developer.android.com/studio#command-tools, затем export ANDROID_HOME=...');
      if (!report.webkit2gtk.available) console.log('  WebKitGTK:  sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev');
      console.log('\nБез тулчейна доступны цели: web-bundle, source-project.');
      return;
    }

    case 'prompt': {
      const text = buildLlmPrompt({ lang: values.lang });
      if (values.out) {
        writeFileSync(resolve(values.out), text);
        console.log(`Промт сохранён: ${resolve(values.out)}`);
      } else {
        console.log(text);
      }
      return;
    }

    case 'inspect': {
      const file = positionals[0];
      if (!file) fail('укажите файл .html или .zip');
      const bytes = new Uint8Array(readFileSync(resolve(file)));
      const info = inspect(bytes, { filename: basename(file), overrides: overridesFrom(values) });
      if (values.json) { console.log(JSON.stringify(info, null, 2)); return; }
      console.log(`Файл:        ${file}`);
      console.log(`Тип:         ${info.sourceKind}`);
      console.log(`Точка входа: ${info.entry}`);
      console.log(`Файлов:      ${info.fileCount} (${(info.totalBytes / 1024).toFixed(1)} KiB)`);
      console.log(`\nМанифест:`);
      console.log(`  id:          ${info.manifest.id}`);
      console.log(`  name:        ${info.manifest.name}`);
      console.log(`  version:     ${info.manifest.version} (${info.manifest.versionCode})`);
      console.log(`  orientation: ${info.manifest.orientation}`);
      console.log(`  permissions: ${info.manifest.permissions.join(', ') || '(нет)'}`);
      if (info.directives.length) {
        console.log(`\nНайденные директивы:`);
        for (const d of info.directives) console.log(`  строка ${d.line}: easyapp:${d.kind} ${d.value}`);
      }
      if (info.warnings.length) {
        console.log(`\nПредупреждения манифеста:`);
        for (const w of info.warnings) console.log(`  ${w}`);
      }
      if (info.issues.length) {
        console.log(`\nПроверка бандла:`);
        for (const i of info.issues) console.log(`  [${i.level}] ${i.file}: ${i.message}`);
      } else {
        console.log(`\nПроверка бандла: проблем не найдено.`);
      }
      return;
    }

    case 'build': {
      const file = positionals[0];
      if (!file) fail('укажите файл .html или .zip');
      const bytes = new Uint8Array(readFileSync(resolve(file)));
      try {
        const result = await compile(bytes, {
          filename: basename(file),
          target: values.target,
          overrides: overridesFrom(values),
          outDir: resolve(values.out),
          keepProject: values['keep-project'],
          onLog: values.json ? () => {} : (msg) => console.log(`  ${msg}`),
        });
        if (values.json) {
          console.log(JSON.stringify({
            ok: true, path: result.path, filename: result.filename,
            size: result.bytes.length, warnings: result.warnings, log: result.log,
          }, null, 2));
        } else {
          console.log(`\nГотово: ${result.path}`);
          console.log(`Размер: ${(result.bytes.length / 1024).toFixed(1)} KiB`);
        }
      } catch (err) {
        if (values.json) {
          console.log(JSON.stringify({ ok: false, error: err.message, projectZip: err.projectZip || null }, null, 2));
          process.exit(1);
        }
        fail(err.message);
      }
      return;
    }

    case 'serve': {
      const { startServer } = await import('./server.mjs');
      await startServer({ port: Number(values.port) });
      return;
    }

    default:
      fail(`неизвестная команда "${command}". Запустите easyapp help`);
  }
}

main().catch((err) => fail(err.stack || err.message));
