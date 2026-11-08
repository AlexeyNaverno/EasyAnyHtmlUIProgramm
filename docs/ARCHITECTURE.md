# Архитектура

## Принцип

Один и тот же веб-бандл превращается в нативное приложение на трёх платформах.
Логика прав едина: она объявляется один раз в манифесте и проверяется нативным
хостом при каждом вызове.

```
                    ┌──────────────────────────┐
 .html / .zip ─────►│ packages/core            │
                    │  manifest.js  директивы  │
                    │  bundle.js    ZIP/HTML   │
                    │  targets.js   генераторы │
                    └────────────┬─────────────┘
                                 │ www/ + __easyapp_manifest.json + bridge.js
             ┌───────────────────┼───────────────────┐
             ▼                   ▼                   ▼
      Android (Kotlin)     Windows (C)          Linux (C)
      WebView + SAF        WebView2 + WinHTTP   WebKitGTK + libsoup
             │                   │                   │
             └───────────────────┴───────────────────┘
                        window.easyapp API
```

## Слои

### 1. Ядро (`packages/core`)

Чистый JavaScript без обращений к файловой системе, кроме модуля `toolchain.js`.
Это позволяет использовать одно ядро и в Node (CLI, сервер), и внутри
WebView (автономное приложение-компилятор).

* `manifest.js` — парсит `<!-- easyapp:… -->` и `easyapp.json`, валидирует,
  применяет приоритет: **директивы > конфиг > значения по умолчанию**,
  а поверх всего — переопределения из UI.
* `bundle.js` — принимает HTML или ZIP, нормализует пути, снимает общую
  папку-обёртку, защищает от path traversal и zip-бомб (лимит 200 МиБ).
* `targets.js` — собирает дерево `www/`, переписывает абсолютные пути
  `/style.css` → `./style.css`, генерирует Gradle-проект, линтует бандл.
* `toolchain.js` — находит и запускает реальные тулчейны (Zig, cc, Gradle).
* `compiler.js` — сквозной сценарий: бандл → артефакт.

### 2. Мост (`packages/core/runtime/bridge.js`)

Единственный файл, который встраивается во все платформы. Даёт
`window.easyapp` и общается с хостом через `window.__easyappTransport(json)`.
Ответ приходит вызовом `window.__easyappResolve(id, ok, payload)`.

Двоичные данные передаются в base64 — это проще и надёжнее, чем
разные механизмы бинарных каналов на трёх платформах.

### 3. Нативные хосты

| | Android | Windows | Linux |
|---|---|---|---|
| Движок | `android.webkit.WebView` | WebView2 (Edge) | WebKitGTK 4.1 |
| Ассеты | `shouldInterceptRequest` для `https://appassets.easyapp.internal` | `WebResourceRequested` для `https://easyapp.internal` | схема `easyapp://` |
| Сеть | `HttpURLConnection` | WinHTTP | libsoup3 |
| Файлы | SAF (`ACTION_OPEN_DOCUMENT`) | `IFileOpenDialog` / `IFileSaveDialog` | `GtkFileChooserDialog` |
| Хранилище | `SharedPreferences` + `filesDir` | `%LOCALAPPDATA%\EasyApp\<id>` | `$XDG_DATA_HOME/EasyApp/<id>` |

Общая C-логика моста вынесена в `native/host/bridge_core.c` и используется
и Windows-, и Linux-хостом: платформенно-зависимы только колбэки
(HTTP, диалоги, лог, выход).

## Почему именно так

**Локальный origin вместо `file://`.** Страница отдаётся с фиктивного
`https://`-адреса (илисобственной схемы). Это даёт стабильный origin, при котором
работают `fetch`, ES-модели и Web Storage, и при этом не открывает доступ
к файловой системе.

**Внедрение моста до скриптов страницы.** На Android мост вставляется прямо
в HTML-ответ в `shouldInterceptRequest`, на Windows — через
`AddScriptToExecuteOnDocumentCreated`, на Linux — `WebKitUserScript`
с `INJECT_AT_DOCUMENT_START`. Если внедрять в `onPageFinished`, переменная
`window.easyapp` появится слишком поздно и код приложения её не увидит.

**WebView2 без проприетарного лоадера.** Хост ищет установленный Evergreen
рантайм в реестре и берёт `CreateCoreWebView2EnvironmentWithOptions`
через `GetProcAddress`. Это убирает `WebView2Loader.dll` из поставки
и позволяет собирать всё из исходников через Zig/MinGW.

**COM-обработчики вручную.** WRL (`Microsoft::WRL::Callback`) доступен только
в MSVC. Хост написан на C с `CINTERFACE`, обработчики событий реализованы
обычными структурами с таблицами функций — это собирается и MinGW, и Zig.

**Свой inflate в установщике.** `native/installer/tinyzip.c` реализует
RFC 1951 и чтение ZIP по APPNOTE, чтобы установщик не тянул zlib
и оставался одним маленьким бинарником (~160 КБ).

## Модель безопасности

1. **Права проверяются дважды.** Мост отказывает сразу для понятной ошибки,
   хост проверяет повторно — обойти это из JavaScript нельзя.
2. **Сеть физически отсутствует без права.** На Android нет `INTERNET`
   в манифесте; на десктопе блокируются и навигация, и подргрузка ресурсов.
3. **Приватные файлы в песочнице.** `ea_safe_join` и `safeAssetPath` отсекают
   `..`, абсолютные пути и обратные слеши; на Android дополнительно проверяется
   `canonicalPath`.
4. **Файлы устройства — только через диалог.** Приложение не получает
   произвольный доступ к диску: пользователь выбирает конкретный файл.
5. **Схема URL ограничена.** Нативный HTTP-клиент принимает только `http`/`https`.
6. **Входной бандл не может подменить рантайм.** Файлы `__easyapp_*` из архива
   игнорируются и перезаписываются настоящими.

## Формат установщика Windows

```
[ setup.exe stub ][ ZIP payload ][ "EAPK" ][ uint32 LE length ]
```

Заглушка читает последние 8 байт своего образа, находит длину payload,
распаковывает его в `%LOCALAPPDATA%\Programs\<appId>`, создаёт ярлыки,
пишет ключ деинсталляции и копирует себя как `uninstall.exe`.
При запуске с `--uninstall` удаляет файлы и записи, сохраняя данные пользователя.
