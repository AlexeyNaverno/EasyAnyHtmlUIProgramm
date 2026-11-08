# EasyAnyHtmlUIProgramm

[![Последний релиз](https://img.shields.io/github/v/release/AlexeyNaverno/EasyAnyHtmlUIProgramm?include_prereleases&sort=semver&label=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7)](https://github.com/AlexeyNaverno/EasyAnyHtmlUIProgramm/releases)
[![Сборка](https://github.com/AlexeyNaverno/EasyAnyHtmlUIProgramm/actions/workflows/build.yml/badge.svg)](https://github.com/AlexeyNaverno/EasyAnyHtmlUIProgramm/actions/workflows/build.yml)
[![Лицензия: GPL v3](https://img.shields.io/badge/%D0%BB%D0%B8%D1%86%D0%B5%D0%BD%D0%B7%D0%B8%D1%8F-GPLv3-blue.svg)](LICENSE)

**Компилятор: один `.html` или `.zip` → готовый `.apk`, `.exe`-установщик или приложение для Linux.**

Вы кладёте веб-файл — получаете нативное приложение, которое работает локально и офлайн.
Права (доступ в интернет, работа с файлами устройства) включаются галочкой в интерфейсе
или комментарием прямо в HTML.

Полностью открытый исходный код, всё собирается из исходников, без проприетарных блобов —
подходит для F-Droid.

```
app.html  ──►  [ EasyApp ]  ──►  MyApp-setup-x64.exe   (Windows, x64 и x86)
                          ├──►  MyApp.apk             (Android 7.0+)
                          └──►  MyApp-linux-x64.zip   (WebKitGTK)
```

---

## 📥 Скачать — [последний релиз](https://github.com/AlexeyNaverno/EasyAnyHtmlUIProgramm/releases)

Готовые сборки лежат в **[Releases](https://github.com/AlexeyNaverno/EasyAnyHtmlUIProgramm/releases)**.
Все файлы собраны из исходников в GitHub Actions, к каждому релизу приложен
`SHA256SUMS.txt`. Сейчас публикуются **пререлизы** — они помечены меткой
`Pre-release` и пригодны для ознакомления, но не считаются стабильными.

| Файл | Что это | Требования |
|---|---|---|
| `EasyApp_Compiler-setup-x64.exe` | Установщик компилятора, Windows 64-бит | WebView2 Runtime (есть в Windows 11) |
| `EasyApp_Compiler-setup-x86.exe` | Установщик компилятора, Windows 32-бит | WebView2 Runtime |
| `EasyApp_Compiler-windows-x64-portable.zip` | Portable-версия, без установки | WebView2 Runtime |
| `EasyApp_Compiler-linux-x64.zip` | Компилятор для Linux, внутри `install.sh` | `libwebkit2gtk-4.1-0`, `libgtk-3-0` |
| `EasyApp_Compiler.apk` | Компилятор для Android | Android 7.0+ (API 24) |
| `EasyApp_Compiler-source.zip` | Исходники этого релиза | Node.js 22+ |
| `Hello_EasyApp-*`, `Files_and_Net_Demo-*` | Примеры уже собранных приложений | по платформе |

Проверка целостности после скачивания:

```bash
sha256sum -c SHA256SUMS.txt
```

> Ссылка [`releases/latest`](https://github.com/AlexeyNaverno/EasyAnyHtmlUIProgramm/releases/latest) указывает только на стабильные
> версии, поэтому пока выходят одни пререлизы, пользуйтесь
> **[списком релизов](https://github.com/AlexeyNaverno/EasyAnyHtmlUIProgramm/releases)** — там самый свежий всегда сверху.

---

## Быстрый старт

```bash
npm install
pip install ziglang          # нужен только для сборки Windows-целей

# что умеет мой компьютер
node apps/cli/src/index.mjs doctor

# собрать .exe-установщик из одного HTML
node apps/cli/src/index.mjs build examples/hello/index.html -t windows-x64

# веб-интерфейс с галочками и кнопкой промта для LLM
node apps/cli/src/index.mjs serve --port 8080
```

Результат появляется в `dist/`. Сборка Windows-установщика занимает ~3 секунды
и даёт файл размером ~260 КБ.

---

## Как объявить права

Достаточно комментариев в `<head>` — файл остаётся обычным валидным HTML,
который можно открыть в браузере:

```html
<!-- easyapp:name Моё приложение -->
<!-- easyapp:id org.example.myapp -->
<!-- easyapp:version 1.0.0 -->
<!-- easyapp:permission internet -->
<!-- easyapp:permission files -->
```

В интерфейсе компилятора эти комментарии **автоматически включают галочки**.
Галочки можно переопределить вручную — они имеют приоритет.

| Право | Что даёт | Как реализуется |
|---|---|---|
| `internet` | HTTP-запросы без ограничений CORS, загрузка внешних ресурсов | `INTERNET` в AndroidManifest; WinHTTP/libsoup в нативном хосте |
| `files` | Импорт и экспорт файлов на устройство через системные диалоги | Storage Access Framework на Android; системные диалоги на ПК |
| *(всегда)* | Настройки и приватные файлы приложения | Песочница, разрешения не нужны |

Без галочки право **физически отсутствует**: на Android оно не попадает
в манифест, на десктопе вызов отклоняется нативным хостом.

Можно использовать и `easyapp.json` в корне ZIP:

```json
{
  "id": "org.example.myapp",
  "name": "Моё приложение",
  "version": "1.0.0",
  "permissions": ["internet", "files"]
}
```

---

## API для вашего приложения

Внутри скомпилированного приложения доступен объект `window.easyapp`:

```js
// Настройки — доступны всегда
await easyapp.storage.set('theme', 'dark');
const theme = await easyapp.storage.get('theme');

// Приватные файлы приложения — доступны всегда (песочница)
await easyapp.privateFiles.write('notes.json', JSON.stringify(data));
const text = await easyapp.privateFiles.readText('notes.json');

// Файлы устройства — нужно право "files"
const picked = await easyapp.files.import({ accept: 'application/json' });
await easyapp.files.export('report.json', JSON.stringify(data));

// Сеть — нужно право "internet", без ограничений CORS
const res = await easyapp.fetch('https://api.example.com/data');
if (res.ok) console.log(await res.json());
```

Все методы возвращают `Promise`, кроме `easyapp.info()` и `easyapp.hasPermission()`.
Каждый вызов повторно проверяется на нативной стороне.

Полный пример: [`examples/files-and-net/`](examples/files-and-net/).

---

## Кнопка «Промт для LLM»

В интерфейсе есть кнопка, которая копирует готовую инструкцию для ChatGPT,
Claude или другой модели: формат бандла, директивы прав, весь API рантайма
и правила совместимости. Вставляете промт, описываете нужное приложение —
модель возвращает код, который сразу собирается.

```bash
node apps/cli/src/index.mjs prompt --lang ru -o prompt.txt
```

Тот же текст доступен через MCP как инструмент `easyapp_packaging_prompt`.

---

## MCP-сервер

Подключение в Claude Desktop, Cursor или любой MCP-клиент:

```json
{
  "mcpServers": {
    "easyapp": {
      "command": "node",
      "args": ["/полный/путь/EasyAnyHtmlUIProgramm/apps/mcp/src/index.mjs"]
    }
  }
}
```

Инструменты:

| Инструмент | Назначение |
|---|---|
| `easyapp_inspect` | разобрать бандл, показать права и проблемы |
| `easyapp_build` | собрать приложение под выбранную цель |
| `easyapp_targets` | список целей и их требований |
| `easyapp_doctor` | какой тулчейн установлен |
| `easyapp_packaging_prompt` | инструкция для LLM |

Реализован протокол MCP `2024-11-05` поверх stdio без сторонних SDK.

---

## Цели сборки

| Цель | Результат | Нужен тулчейн |
|---|---|---|
| `windows-x64` | `.exe`-установщик (ярлыки, «Программы и компоненты», деинсталлятор) | Zig |
| `windows-x86` | то же для 32-битных систем | Zig |
| `windows-portable-x64` | `.zip` без установки | Zig |
| `linux-x64` | `.zip` с нативным хостом и `install.sh` | C-компилятор, WebKitGTK 4.1 |
| `android-apk` | `.apk` (Android 7.0+) | JDK 17/21, Android SDK, Gradle 8.7 |
| `web-bundle` | нормализованный `.zip` с мостом | — |
| `source-project` | полные исходники для ручной сборки и F-Droid | — |

Если тулчейна для Android нет, компилятор **не падает молча**: он сохраняет
готовый Gradle-проект в `dist/`, который можно собрать в Android Studio или CI.

---

## Сам компилятор — тоже приложение

Компилятор собирает **сам себя** тем же движком:

```bash
# 1. Один раз собрать универсальные рантаймы из исходников
node scripts/build-runtimes.mjs
# 2. Собрать компилятор его же движком (рантаймы встраиваются в приложение)
node scripts/build-ui.mjs windows-x64 windows-x86 linux-x64 android-apk
```

### Сборка прямо на телефоне

Приложение-компилятор **доводит сборку до конца на самом устройстве**: `.apk`,
`.exe`, portable и Linux-пакет — без интернета, без ПК и без песочницы с тулчейном.

Это возможно потому, что нативный код не зависит от вашего HTML: хост и
установщик читают `www/__easyapp_manifest.json` уже при запуске, а
`MainActivity` берёт манифест из assets. Поэтому Zig, JDK и Android SDK нужны
**один раз — при сборке самого компилятора**. Дальше остаётся упаковка данных:

| Цель | Что происходит на устройстве |
|---|---|
| Windows `.exe` / portable | готовый хост + ZIP + трейлер установщика |
| Linux | готовый WebKitGTK-хост + ZIP со скриптом установки |
| Android `.apk` | готовый `classes.dex` + манифест AXML + `resources.arsc` + иконка, затем подпись APK v2 |

Никаких дополнительных требований к ОЗУ: это упаковка мегабайт, а не работа
Gradle. Ключ подписи создаётся на устройстве и хранится в приватных файлах
приложения — сохраните его, иначе обновление приложения придётся ставить как новое.

Если какой-то рантайм не встроен в вашу сборку, интерфейс отключает
соответствующую цель и объясняет причину, а не падает молча.

---

## Открытость и F-Droid

* Весь код — GPL-3.0-or-later, зависимости вендорены **исходниками** (`native/third_party/`).
* Никаких бинарных блобов в репозитории: `gradle-wrapper.jar` генерируется, а не коммитится.
* Windows-хост не линкует проприетарный `WebView2Loader.dll` — рантайм находится
  через реестр и загружается по `GetProcAddress`.
* Android-рантайм использует только платформенный SDK, без сторонних библиотек и сервисов Google.
* Метаданные для F-Droid: [`fdroid/org.easyapp.compiler.yml`](fdroid/org.easyapp.compiler.yml).
* **Ваши приложения не обязаны быть GPL**: рантайм имеет исключение по образцу
  GCC Runtime Library Exception — см. [`LICENSE-RUNTIME`](LICENSE-RUNTIME).

---

## Требования к запуску готовых приложений

* **Windows** — Microsoft Edge WebView2 Runtime (предустановлен в Windows 11;
  на Windows 10 обновляется вместе с Edge). Если рантайма нет, приложение
  показывает понятное сообщение со ссылкой.
* **Linux** — `libwebkit2gtk-4.1-0`, `libgtk-3-0`.
* **Android** — 7.0+ (API 24).

---

## Разработка

```bash
npm install
node --test tests/*.test.mjs      # 53 теста, включая проверку реальных PE-файлов
node apps/cli/src/index.mjs serve # интерфейс на http://localhost:8080
```

Структура:

```
packages/core/       ядро: манифест, бандлы, генераторы, промт, тулчейн
packages/core/runtime/bridge.js   JS-мост, встраиваемый в каждое приложение
apps/cli/            командная строка и локальный сервер
apps/ui/             веб-интерфейс (он же автономное приложение)
apps/mcp/            MCP-сервер
native/host/         хосты Windows (WebView2) и Linux (WebKitGTK)
native/installer/    установщик Windows и свой ZIP/inflate
templates/runtime-android/  Kotlin-рантайм и Gradle-проект
fdroid/              метаданные F-Droid
```

CI собирает и тестирует все цели на каждый push, а по тегу `v*` публикует
релиз со всеми артефактами и `SHA256SUMS.txt`.

## Лицензия

GPL-3.0-or-later — см. [LICENSE](LICENSE).
Рантайм, встраиваемый в ваши приложения, — с исключением: [LICENSE-RUNTIME](LICENSE-RUNTIME).
Сторонние компоненты — [NOTICE](NOTICE) и [native/third_party/README.md](native/third_party/README.md).
