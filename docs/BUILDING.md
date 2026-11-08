# Сборка

## Что нужно для какой цели

| Цель | Инструменты | Установка |
|---|---|---|
| Windows x64/x86 | Zig 0.13+ | `pip install ziglang` |
| Linux x64 | C-компилятор, GTK3, WebKitGTK 4.1 | `apt install build-essential libgtk-3-dev libwebkit2gtk-4.1-dev` |
| Android | JDK 17, Android SDK (platform 34, build-tools 34), Gradle 8.7 | см. ниже |
| web-bundle, source-project | только Node 20+ | — |

Проверить, что уже есть:

```bash
node apps/cli/src/index.mjs doctor
```

## Windows

Кросс-компиляция работает из Linux, macOS и Windows — отдельная машина не нужна.

```bash
pip install ziglang
node apps/cli/src/index.mjs build app.html -t windows-x64 -o dist
node apps/cli/src/index.mjs build app.html -t windows-x86 -o dist
```

Если у вас установлен обычный `zig` в PATH, он будет использован автоматически.

## Linux

```bash
sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev
node apps/cli/src/index.mjs build app.html -t linux-x64 -o dist
```

Для Fedora: `sudo dnf install gtk3-devel webkit2gtk4.1-devel`.

Результат — ZIP с бинарником, папкой `www` и `install.sh`. Установка:

```bash
unzip MyApp-linux-x64.zip -d myapp && cd myapp && ./install.sh
```

Скрипт кладёт приложение в `$XDG_DATA_HOME/EasyApp/<id>` и создаёт `.desktop`-запись.
Без установки можно запустить `./run.sh`.

## Android

```bash
# 1. JDK 17
sudo apt install openjdk-17-jdk

# 2. Android command line tools
#    https://developer.android.com/studio#command-tools
export ANDROID_HOME=$HOME/android-sdk
sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"

# 3. Gradle 8.7 (или сгенерируйте wrapper один раз)
node scripts/setup-gradle-wrapper.mjs templates/runtime-android

# 4. Сборка
node apps/cli/src/index.mjs build app.html -t android-apk -o dist
```

APK подписывается debug-ключом. Для релизного ключа передайте параметры
в Gradle (`signingStoreFile`, `signingStorePassword`, `signingKeyAlias`,
`signingKeyPassword`) — они читаются в `app/build.gradle.kts`.

**Если SDK нет**, компилятор сохранит готовый Gradle-проект
(`dist/<App>-android-project.zip`) и объяснит, что делать дальше. Проект можно
открыть в Android Studio или собрать в CI — терять ничего не нужно.

## Gradle wrapper и бинарные блобы

`gradle-wrapper.jar` намеренно не лежит в репозитории: F-Droid требует сборку
из исходников. Скрипт `scripts/setup-gradle-wrapper.mjs` создаёт его локально,
CI делает это сам. Без JAR компилятор автоматически использует системный `gradle`.

## Сборка через CI

`.github/workflows/build.yml` запускается на каждый push и собирает все цели.
`.github/workflows/release.yml` публикует релиз по тегу:

```bash
git tag v0.1.0
git push origin v0.1.0
```

В релиз попадают примеры под все платформы, сам компилятор и `SHA256SUMS.txt`.

## Сборка компилятора как приложения

```bash
node scripts/build-ui.mjs                       # Windows x64/x86 + portable
node scripts/build-ui.mjs android-apk linux-x64 # другие цели
node scripts/build-ui.mjs --assets-only         # только веб-ассеты (для F-Droid)
```

Скрипт собирает UI через esbuild, встраивает Android-шаблон и мост,
затем прогоняет результат через собственный движок компиляции.

## F-Droid

```bash
node scripts/prepare-fdroid.mjs   # ассеты + gradle.properties
cd templates/runtime-android && gradle assembleRelease
```

Метаданные: `fdroid/org.easyapp.compiler.yml`.

## Тесты

```bash
node --test tests/*.test.mjs
```

53 теста: разбор директив и бандлов, защита от traversal, генераторы,
автономное ядро и сквозные сборки с проверкой PE-заголовков и payload
установщика. Тесты Windows-целей пропускаются, если Zig не установлен.
