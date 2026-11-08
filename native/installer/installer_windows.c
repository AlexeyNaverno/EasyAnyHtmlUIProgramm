/*
 * Minimal Windows installer for generated applications.
 *
 * The payload is a ZIP archive appended to this executable, followed by an
 * 8-byte trailer: "EAPK" + uint32 little-endian payload length. The installer
 * extracts it into %LOCALAPPDATA%\Programs\<AppId>, writes an uninstaller and
 * creates Start Menu / desktop shortcuts.
 *
 * Everything is plain Win32 so the binary builds with MinGW/Zig from source.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later WITH Runtime-exception
 *
 * RUNTIME LIBRARY EXCEPTION
 *
 * This file is part of the EasyApp runtime that the compiler embeds into every
 * generated application. Linking or bundling this runtime with an independent
 * application (your HTML/CSS/JS bundle) does not by itself cause that
 * application to be covered by the GNU GPL. You may distribute generated
 * applications under terms of your choice, provided you comply with the GPL
 * for the runtime itself and keep this notice intact.
 *
 * This exception applies only to the runtime files that are copied into a
 * generated application (this bridge, the native hosts and cJSON). The
 * compiler proper remains under GPL-3.0-or-later without this exception.
 */
#define CINTERFACE
#define COBJMACROS
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <objbase.h>
#include <objidl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "tinyzip.h"

static wchar_t *utf8_to_wide(const char *s) {
    if (!s) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *out = (wchar_t *)malloc(sizeof(wchar_t) * (size_t)n);
    MultiByteToWideChar(CP_UTF8, 0, s, -1, out, n);
    return out;
}

static void fail(const wchar_t *message) {
    MessageBoxW(NULL, message, L"EasyApp Installer", MB_ICONERROR | MB_OK);
    ExitProcess(1);
}

/* Read the appended payload from our own executable image. */
static unsigned char *read_payload(size_t *out_len) {
    char self[MAX_PATH * 2];
    DWORD n = GetModuleFileNameA(NULL, self, sizeof(self));
    if (n == 0 || n >= sizeof(self)) return NULL;

    FILE *f = fopen(self, "rb");
    if (!f) return NULL;
    /* Measure the real file size first: ftell() after seeking to -8 would
       return size-8 and shift the payload window by the trailer length. */
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long total = ftell(f);
    if (total < 8) { fclose(f); return NULL; }
    if (fseek(f, -8, SEEK_END) != 0) { fclose(f); return NULL; }
    char trailer[8];
    if (fread(trailer, 1, 8, f) != 8 || memcmp(trailer, "EAPK", 4) != 0) {
        fclose(f);
        return NULL;
    }
    unsigned int len = (unsigned int)(unsigned char)trailer[4]
                     | ((unsigned int)(unsigned char)trailer[5] << 8)
                     | ((unsigned int)(unsigned char)trailer[6] << 16)
                     | ((unsigned int)(unsigned char)trailer[7] << 24);
    if (len == 0 || (long)len + 8 > total) { fclose(f); return NULL; }
    if (fseek(f, total - 8 - (long)len, SEEK_SET) != 0) { fclose(f); return NULL; }
    unsigned char *buf = (unsigned char *)malloc(len);
    if (!buf) { fclose(f); return NULL; }
    if (fread(buf, 1, len, f) != len) { free(buf); fclose(f); return NULL; }
    fclose(f);
    *out_len = len;
    return buf;
}

static int mkdir_recursive(const char *path) {
    char copy[MAX_PATH * 2];
    snprintf(copy, sizeof(copy), "%s", path);
    for (char *p = copy + 1; *p; p++) {
        if (*p == '\\' || *p == '/') {
            char saved = *p; *p = '\0';
            CreateDirectoryA(copy, NULL);
            *p = saved;
        }
    }
    return CreateDirectoryA(copy, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

static char *read_manifest_field(const unsigned char *zip, size_t zip_len, const char *field) {
    size_t len = 0;
    unsigned char *data = tz_extract(zip, zip_len, "www/__easyapp_manifest.json", &len);
    if (!data) return NULL;
    char *text = (char *)malloc(len + 1);
    memcpy(text, data, len);
    text[len] = '\0';
    free(data);
    /* Very small, targeted JSON string scan: avoids a JSON dependency here. */
    char key[128];
    snprintf(key, sizeof(key), "\"%s\"", field);
    char *p = strstr(text, key);
    char *result = NULL;
    if (p) {
        p = strchr(p + strlen(key), ':');
        if (p) {
            p++;
            while (*p == ' ' || *p == '\t') p++;
            if (*p == '"') {
                p++;
                char *end = strchr(p, '"');
                if (end) {
                    size_t n = (size_t)(end - p);
                    result = (char *)malloc(n + 1);
                    memcpy(result, p, n);
                    result[n] = '\0';
                }
            }
        }
    }
    free(text);
    return result;
}

/* Create a .lnk shortcut through IShellLink. */
static void create_shortcut(const char *target, const char *workdir,
                            const char *lnk_path, const char *description) {
    IShellLinkA *link = NULL;
    HRESULT hr = CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER,
                                  &IID_IShellLinkA, (void **)&link);
    if (FAILED(hr) || !link) return;
    IShellLinkA_SetPath(link, target);
    IShellLinkA_SetWorkingDirectory(link, workdir);
    IShellLinkA_SetDescription(link, description);
    IShellLinkA_SetIconLocation(link, target, 0);
    IPersistFile *persist = NULL;
    if (SUCCEEDED(IShellLinkA_QueryInterface(link, &IID_IPersistFile, (void **)&persist)) && persist) {
        wchar_t *wpath = utf8_to_wide(lnk_path);
        if (wpath) {
            IPersistFile_Save(persist, wpath, TRUE);
            free(wpath);
        }
        IPersistFile_Release(persist);
    }
    IShellLinkA_Release(link);
}

static void write_uninstall_registry(const char *app_id, const char *app_name,
                                     const char *install_dir, const char *uninstaller) {
    char key_path[1024];
    snprintf(key_path, sizeof(key_path),
             "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\%s", app_id);
    HKEY key;
    if (RegCreateKeyExA(HKEY_CURRENT_USER, key_path, 0, NULL, 0,
                        KEY_WRITE, NULL, &key, NULL) != ERROR_SUCCESS) return;
    DWORD size = (DWORD)strlen(app_name) + 1;
    RegSetValueExA(key, "DisplayName", 0, REG_SZ, (const BYTE *)app_name, size);
    size = (DWORD)strlen(uninstaller) + 1;
    RegSetValueExA(key, "UninstallString", 0, REG_SZ, (const BYTE *)uninstaller, size);
    RegSetValueExA(key, "QuietUninstallString", 0, REG_SZ, (const BYTE *)uninstaller, size);
    size = (DWORD)strlen(install_dir) + 1;
    RegSetValueExA(key, "InstallLocation", 0, REG_SZ, (const BYTE *)install_dir, size);
    const char *publisher = "EasyApp";
    RegSetValueExA(key, "Publisher", 0, REG_SZ, (const BYTE *)publisher, (DWORD)strlen(publisher) + 1);
    DWORD no_modify = 1;
    RegSetValueExA(key, "NoModify", 0, REG_DWORD, (const BYTE *)&no_modify, sizeof(DWORD));
    RegSetValueExA(key, "NoRepair", 0, REG_DWORD, (const BYTE *)&no_modify, sizeof(DWORD));
    RegCloseKey(key);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE prev, LPSTR cmd_line, int show) {
    (void)instance; (void)prev; (void)show;
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

    int uninstall_mode = strstr(GetCommandLineA(), "--uninstall") != NULL;

    size_t payload_len = 0;
    unsigned char *payload = read_payload(&payload_len);

    char *app_id = payload ? read_manifest_field(payload, payload_len, "id") : NULL;
    char *app_name = payload ? read_manifest_field(payload, payload_len, "name") : NULL;
    if (!app_id) app_id = _strdup("org.easyapp.app");
    if (!app_name) app_name = _strdup("EasyApp");

    const char *local = getenv("LOCALAPPDATA");
    if (!local) local = getenv("APPDATA");
    if (!local) local = ".";

    char install_dir[MAX_PATH * 2];
    snprintf(install_dir, sizeof(install_dir), "%s\\Programs\\%s", local, app_id);

    if (uninstall_mode) {
        char msg[1024];
        snprintf(msg, sizeof(msg), "Remove %s and its program files?\n\nUser data is kept.", app_name);
        wchar_t *wmsg = utf8_to_wide(msg);
        int answer = MessageBoxW(NULL, wmsg, L"Uninstall", MB_YESNO | MB_ICONQUESTION);
        free(wmsg);
        if (answer == IDYES) {
            char link[MAX_PATH * 2];
            const char *appdata = getenv("APPDATA");
            snprintf(link, sizeof(link), "%s\\Microsoft\\Windows\\Start Menu\\Programs\\%s.lnk",
                     appdata ? appdata : local, app_name);
            DeleteFileA(link);
            snprintf(link, sizeof(link), "%s\\%s.lnk", getenv("USERPROFILE") ? getenv("USERPROFILE") : ".", app_name);
            DeleteFileA(link);

            char key_path[1024];
            snprintf(key_path, sizeof(key_path),
                     "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\%s", app_id);
            RegDeleteKeyA(HKEY_CURRENT_USER, key_path);

            /* Remove the install directory recursively. */
            char from[MAX_PATH * 2];
            snprintf(from, sizeof(from), "%s", install_dir);
            size_t flen = strlen(from);
            from[flen + 1] = '\0'; /* SHFileOperation needs double NUL */
            SHFILEOPSTRUCTA op;
            ZeroMemory(&op, sizeof(op));
            op.wFunc = FO_DELETE;
            op.pFrom = from;
            op.fFlags = FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
            SHFileOperationA(&op);
        }
        free(app_id); free(app_name); free(payload);
        CoUninitialize();
        return 0;
    }

    if (!payload) {
        fail(L"This installer is damaged: no payload was found.");
    }

    /* Confirm installation target. */
    char prompt[2048];
    snprintf(prompt, sizeof(prompt), "Install %s?\n\nLocation: %s", app_name, install_dir);
    wchar_t *wprompt = utf8_to_wide(prompt);
    int answer = MessageBoxW(NULL, wprompt, L"EasyApp Installer", MB_OKCANCEL | MB_ICONINFORMATION);
    free(wprompt);
    if (answer != IDOK) { free(payload); free(app_id); free(app_name); return 0; }

    if (!mkdir_recursive(install_dir)) fail(L"Cannot create the installation directory.");

    if (tz_extract_all(payload, payload_len, install_dir) != 0) {
        fail(L"Cannot extract the application files.");
    }

    char exe_path[MAX_PATH * 2], uninstaller[MAX_PATH * 2];
    snprintf(exe_path, sizeof(exe_path), "%s\\%s.exe", install_dir, app_name);
    snprintf(uninstaller, sizeof(uninstaller), "%s\\uninstall.exe", install_dir);

    /* The host binary is stored in the payload as `app.exe`; rename it. */
    char generic_exe[MAX_PATH * 2];
    snprintf(generic_exe, sizeof(generic_exe), "%s\\app.exe", install_dir);
    if (strcmp(generic_exe, exe_path) != 0) {
        DeleteFileA(exe_path);
        MoveFileA(generic_exe, exe_path);
    }

    /* Copy the installer itself as the uninstaller. */
    char self[MAX_PATH * 2];
    GetModuleFileNameA(NULL, self, sizeof(self));
    CopyFileA(self, uninstaller, FALSE);

    const char *appdata = getenv("APPDATA");
    char programs[MAX_PATH * 2];
    snprintf(programs, sizeof(programs), "%s\\Microsoft\\Windows\\Start Menu\\Programs",
             appdata ? appdata : local);
    mkdir_recursive(programs);
    char link[MAX_PATH * 2];
    snprintf(link, sizeof(link), "%s\\%s.lnk", programs, app_name);
    create_shortcut(exe_path, install_dir, link, app_name);

    char desktop[MAX_PATH * 2];
    if (SUCCEEDED(SHGetFolderPathA(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktop))) {
        snprintf(link, sizeof(link), "%s\\%s.lnk", desktop, app_name);
        create_shortcut(exe_path, install_dir, link, app_name);
    }

    char uninstall_cmd[MAX_PATH * 2 + 32];
    snprintf(uninstall_cmd, sizeof(uninstall_cmd), "\"%s\" --uninstall", uninstaller);
    write_uninstall_registry(app_id, app_name, install_dir, uninstall_cmd);

    /* Launch the freshly installed application. */
    HINSTANCE exec_result = ShellExecuteA(NULL, "open", exe_path, NULL, install_dir, SW_SHOW);
    (void)exec_result;

    wchar_t *done = utf8_to_wide("Installation finished.");
    MessageBoxW(NULL, done, L"EasyApp Installer", MB_OK | MB_ICONINFORMATION);
    free(done);

    free(payload); free(app_id); free(app_name);
    CoUninitialize();
    return 0;
}
