/**
 * The LLM prompt shown by the "Prompt for LLM" button and exposed over MCP.
 * It is generated from the same permission constants the compiler enforces, so
 * it can never drift from the implementation.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { KNOWN_PERMISSIONS } from './manifest.js';

export const PROMPT_VERSION = '1';

export function buildLlmPrompt({ lang = 'ru' } = {}) {
  return lang === 'en' ? promptEn() : promptRu();
}

function promptRu() {
  return `# Задача: подготовить веб-приложение для компилятора EasyAnyHtmlUIProgramm

Ты готовишь UI и логику приложения, которое будет скомпилировано в нативные
установщики: Android .apk, Windows .exe и Linux. Компилятор принимает ОДИН
файл: либо .html, либо .zip. Верни готовый код, следуя правилам ниже.

## 1. Формат входного файла

Вариант A — один .html файл: весь CSS и JS внутри (inline). Внешние CDN
не использовать: приложение должно работать полностью офлайн.

Вариант B — .zip архив со структурой:

\`\`\`
index.html          <- точка входа (обязательно)
style.css
app.js
assets/logo.png
easyapp.json        <- необязательный конфиг
\`\`\`

Требования к архиву:
- Все пути относительные, без ведущего "/" и без "..".
- Точка входа: index.html в корне (или укажи entry в манифесте).
- Никаких сборщиков, npm и внешних зависимостей во время выполнения.
- Ссылки на ресурсы только относительные: "./style.css", а не "/style.css".

## 2. Права доступа

Права объявляются комментарием в HTML и продублированы галочками в компиляторе.
Доступные права: ${KNOWN_PERMISSIONS.map((p) => `\`${p}\``).join(', ')}.

Вставь в \`<head>\` файла index.html нужные строки:

\`\`\`html
<!-- easyapp:permission internet -->
<!-- easyapp:permission files -->
<!-- easyapp:name Моё приложение -->
<!-- easyapp:id org.example.myapp -->
<!-- easyapp:version 1.0.0 -->
\`\`\`

Правила:
- \`internet\` — нужен, если приложение обращается к сети.
- \`files\` — нужен для импорта/экспорта файлов на устройство через системные диалоги.
- НЕ запрашивай права, которые не используются: без галочки код не получит доступ.
- \`id\` — обратный DNS, только латиница, цифры и точка, минимум два сегмента.

Альтернатива комментариям — easyapp.json:

\`\`\`json
{
  "id": "org.example.myapp",
  "name": "Моё приложение",
  "version": "1.0.0",
  "versionCode": 1,
  "entry": "index.html",
  "permissions": ["internet", "files"],
  "orientation": "unspecified"
}
\`\`\`

## 3. API рантайма (объект window.easyapp)

Объект доступен только внутри скомпилированного приложения. Всегда проверяй
его наличие, чтобы страница оставалась работоспособной в обычном браузере.

\`\`\`js
const native = typeof window.easyapp !== 'undefined';

// Информация о приложении и выданных правах
easyapp.info();                    // { id, name, permissions, ... }
easyapp.hasPermission('internet'); // true/false

// Хранилище настроек (доступно всегда, без прав)
await easyapp.storage.set('theme', 'dark');
const theme = await easyapp.storage.get('theme');
await easyapp.storage.remove('theme');
await easyapp.storage.keys();      // ['theme', ...]

// Приватные файлы приложения (доступны всегда, песочница)
await easyapp.privateFiles.write('notes.json', JSON.stringify(data));
const text = await easyapp.privateFiles.readText('notes.json');
await easyapp.privateFiles.list();
await easyapp.privateFiles.remove('notes.json');

// Файлы устройства — требует право "files"
const picked = await easyapp.files.import({ accept: 'application/json' });
// picked = { name, data: Uint8Array } или null, если пользователь отменил
await easyapp.files.export('report.json', JSON.stringify(data));
await easyapp.files.exportText('note.txt', 'текст');

// Сеть — требует право "internet". Не ограничен CORS.
const res = await easyapp.fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ q: 'test' }),
});
if (res.ok) { const data = await res.json(); }

easyapp.log('отладочное сообщение');
easyapp.exit();
\`\`\`

Все методы асинхронные (Promise), кроме info() и hasPermission().
Каждый вызов проверяется на нативной стороне: при отсутствии права будет
отклонён с понятной ошибкой — оберни вызовы в try/catch.

## 4. Обязательные правила совместимости

1. Офлайн-first: приложение работает без сети, если право internet не нужно.
2. Адаптивная вёрстка: один UI работает и на телефоне, и на десктопе.
   Используй \`<meta name="viewport" content="width=device-width, initial-scale=1">\`.
3. Никаких \`window.open\`, \`alert\`-блокировок и всплывающих окон.
4. Не используй \`localStorage\` для важных данных — применяй \`easyapp.storage\`
   (localStorage может быть очищен рантаймом).
5. Не обращайся к \`file://\` и абсолютным путям файловой системы.
6. Все ресурсы внутри бандла; шрифты и картинки локальные.
7. Экранируй пользовательский ввод, не используй eval и innerHTML с данными извне.
8. Обрабатывай отмену диалогов файлов (возвращается null).

## 5. Что вернуть

Верни:
1. Полный код \`index.html\` (и остальных файлов, если это ZIP).
2. Список необходимых прав с обоснованием.
3. Краткую инструкцию: какие галочки включить в компиляторе.

Если я прошу ZIP — опиши содержимое каждого файла отдельным блоком кода с
указанием имени файла, чтобы я мог собрать архив.

## 6. Мини-пример каркаса

\`\`\`html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- easyapp:name Пример -->
  <!-- easyapp:id org.example.demo -->
  <!-- easyapp:version 1.0.0 -->
  <!-- easyapp:permission files -->
  <title>Пример</title>
  <style>body{font-family:system-ui;margin:16px}</style>
</head>
<body>
  <button id="save">Сохранить файл</button>
  <script>
    document.getElementById('save').onclick = async () => {
      if (!window.easyapp) return alert('Запустите скомпилированное приложение');
      try {
        await easyapp.files.exportText('hello.txt', 'Привет!');
      } catch (e) {
        alert('Не сохранено: ' + e.message);
      }
    };
  </script>
</body>
</html>
\`\`\`

Теперь дождись моего описания приложения и подготовь код по этим правилам.`;
}

function promptEn() {
  return `# Task: prepare a web app for the EasyAnyHtmlUIProgramm compiler

You are writing the UI and logic of an app that will be compiled into native
installers: Android .apk, Windows .exe and Linux. The compiler accepts ONE file:
either .html or .zip. Return working code following the rules below.

## 1. Input format

Option A — a single .html file with all CSS and JS inline. No CDNs: the app must
work fully offline.

Option B — a .zip archive:

\`\`\`
index.html          <- entry point (required)
style.css
app.js
assets/logo.png
easyapp.json        <- optional config
\`\`\`

Archive rules: relative paths only, no leading "/" and no "..". The entry point
is index.html at the root (or set \`entry\` in the manifest). No bundlers, npm or
runtime dependencies. Reference assets as "./style.css", never "/style.css".

## 2. Permissions

Declare permissions as HTML comments; the compiler mirrors them as checkboxes.
Available: ${KNOWN_PERMISSIONS.map((p) => `\`${p}\``).join(', ')}.

Put the needed lines into \`<head>\`:

\`\`\`html
<!-- easyapp:permission internet -->
<!-- easyapp:permission files -->
<!-- easyapp:name My App -->
<!-- easyapp:id org.example.myapp -->
<!-- easyapp:version 1.0.0 -->
\`\`\`

Request only what you actually use. \`id\` must be reverse-DNS with at least two
segments. An \`easyapp.json\` file may be used instead of comments.

## 3. Runtime API (window.easyapp)

Available only inside the compiled app; always feature-detect it.

\`\`\`js
easyapp.info();                     // { id, name, permissions, ... }
easyapp.hasPermission('internet');

await easyapp.storage.set('k', 'v'); // always allowed
await easyapp.storage.get('k');
await easyapp.storage.keys();

await easyapp.privateFiles.write('a.json', JSON.stringify(data)); // sandboxed
await easyapp.privateFiles.readText('a.json');

const f = await easyapp.files.import({ accept: 'application/json' }); // needs "files"
await easyapp.files.export('out.json', JSON.stringify(data));         // needs "files"

const res = await easyapp.fetch('https://api.example.com/x');         // needs "internet"
if (res.ok) console.log(await res.json());                            // not CORS-limited
\`\`\`

All methods return Promises except info() and hasPermission(). Calls are
re-checked natively and reject with a clear error when a permission is missing.

## 4. Compatibility rules

Offline-first; responsive layout with a viewport meta tag; no popups; use
\`easyapp.storage\` instead of localStorage for important data; no \`file://\` or
absolute paths; bundle every asset; escape user input; handle dialog
cancellation (null).

## 5. Deliverable

Return the full file contents, the list of required permissions with a
justification, and which compiler checkboxes to enable. Wait for my app
description, then produce the code.`;
}
