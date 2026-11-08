# Vendored third-party sources

Everything here is **source code** under a permissive licence, vendored so the
project builds offline and satisfies the F-Droid "build from source" rule.
No prebuilt binaries are committed.

## cJSON

- Path: `cjson/`
- Upstream: https://github.com/DaveGamble/cJSON (tag `v1.7.18`)
- Licence: MIT (`cjson/LICENSE`)
- Used by: the native bridge on Windows and Linux for JSON parsing.

## WebView2 SDK headers

- Path: `webview2/`
- Upstream: Microsoft Edge WebView2 SDK, `WebView2.h` and `EventToken.h`
  (interface declarations only, version 1.0.664.37)
- Licence: BSD-3-Clause (`webview2/LICENSE.txt`)
- Used by: `native/host/host_windows.c`

Only the COM **interface declarations** are vendored. The proprietary
`WebView2Loader.dll` and its import library are deliberately **not** used:
the host locates the installed Evergreen runtime through the registry and
resolves `CreateCoreWebView2EnvironmentWithOptions` with `GetProcAddress`.
Therefore no Microsoft binary is linked into or shipped with generated apps.

The WebView2 runtime itself is a system component on the end-user machine
(preinstalled on Windows 11, evergreen-updated on Windows 10). It is not part
of this project and not redistributed by it.

## Gradle wrapper scripts

`templates/runtime-android/gradlew` and `gradlew.bat` come from Gradle 8.7
(Apache-2.0). The `gradle-wrapper.jar` binary is **not** committed; it is
regenerated with `node scripts/setup-gradle-wrapper.mjs` or by CI.
