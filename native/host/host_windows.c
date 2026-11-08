/*
 * Windows host: a minimal WebView2 shell around the bundled web assets.
 *
 * The WebView2 runtime is located dynamically and resolved through
 * GetProcAddress, so no import library or redistributable loader DLL has to be
 * linked or shipped. Only the COM interface declarations from the WebView2 SDK
 * header are used, and COM handlers are written by hand because the Windows
 * Runtime C++ Template Library (WRL) is not available in MinGW.
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
#include <shlwapi.h>
#include <shlobj.h>
#include <winhttp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "WebView2.h"
#include "bridge_core.h"
#include "cJSON.h"

/* WebView2 creates its own window class; we only need a parent frame. */
static const wchar_t *kWindowClass = L"EasyAppHostWindow";
static const char *kAssetOrigin = "https://easyapp.internal";

static ea_config g_cfg;
static HWND g_hwnd = NULL;
static ICoreWebView2Controller *g_controller = NULL;
static ICoreWebView2 *g_webview = NULL;
static ICoreWebView2Environment *g_env = NULL;
static char *g_base_dir = NULL;
static char *g_bridge_js = NULL;

typedef HRESULT(WINAPI *CreateEnvFn)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *,
                                     ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);
static CreateEnvFn pCreateEnv = NULL;

/* ------------------------------------------------------------ utilities */

static wchar_t *utf8_to_wide(const char *s) {
    if (!s) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *out = (wchar_t *)malloc(sizeof(wchar_t) * (size_t)n);
    if (!out) return NULL;
    MultiByteToWideChar(CP_UTF8, 0, s, -1, out, n);
    return out;
}

static char *wide_to_utf8(const wchar_t *s) {
    if (!s) return NULL;
    int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char *out = (char *)malloc((size_t)n);
    if (!out) return NULL;
    WideCharToMultiByte(CP_UTF8, 0, s, -1, out, n, NULL, NULL);
    return out;
}

static void log_line(const char *message) {
    fprintf(stderr, "[EasyApp] %s\n", message ? message : "");
}

/* ------------------------------------------------------- COM ref counting */

/*
 * Every handler below embeds this header as its first member so the same
 * AddRef/Release/QueryInterface implementation can serve all of them.
 */
typedef struct {
    const void *lpVtbl;
    LONG refs;
} ComHeader;

static HRESULT STDMETHODCALLTYPE handler_qi(void *self, REFIID riid, void **out) {
    (void)riid;
    ComHeader *h = (ComHeader *)self;
    InterlockedIncrement(&h->refs);
    *out = self;
    return S_OK;
}
static ULONG STDMETHODCALLTYPE handler_addref(void *self) {
    ComHeader *h = (ComHeader *)self;
    return (ULONG)InterlockedIncrement(&h->refs);
}
static ULONG STDMETHODCALLTYPE handler_release(void *self) {
    ComHeader *h = (ComHeader *)self;
    LONG n = InterlockedDecrement(&h->refs);
    if (n == 0) free(self);
    return (ULONG)n;
}

/* --------------------------------------------------------- script helpers */

static void execute_script_utf8(const char *script) {
    if (!g_webview || !script) return;
    wchar_t *w = utf8_to_wide(script);
    if (!w) return;
    ICoreWebView2_ExecuteScript(g_webview, w, NULL);
    free(w);
}

/* Build `window.__easyappResolve(id, ok, payload);` with a JSON payload. */
static void resolve_message(double id, int ok, const char *payload_json) {
    size_t n = strlen(payload_json) + 128;
    char *script = (char *)malloc(n);
    if (!script) return;
    snprintf(script, n, "window.__easyappResolve(%.0f, %s, %s);",
             id, ok ? "true" : "false", payload_json);
    execute_script_utf8(script);
    free(script);
}

/* ------------------------------------------------------------- HTTP (WinHTTP) */

static int http_request(const char *url, const char *method, const char *headers_json,
                        const uint8_t *body, size_t body_len, int timeout_ms,
                        int *status, char **status_text, char **headers_out,
                        uint8_t **body_out, size_t *body_out_len) {
    int rc = -1;
    wchar_t *wurl = utf8_to_wide(url);
    if (!wurl) return -1;

    URL_COMPONENTS comps;
    ZeroMemory(&comps, sizeof(comps));
    comps.dwStructSize = sizeof(comps);
    wchar_t host[256] = {0}, path[4096] = {0}, extra[4096] = {0};
    comps.lpszHostName = host; comps.dwHostNameLength = 255;
    comps.lpszUrlPath = path; comps.dwUrlPathLength = 4095;
    comps.lpszExtraInfo = extra; comps.dwExtraInfoLength = 4095;

    HINTERNET session = NULL, connection = NULL, request = NULL;
    if (!WinHttpCrackUrl(wurl, 0, 0, &comps)) { free(wurl); return -1; }

    session = WinHttpOpen(L"EasyApp/1.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                          WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) goto done;
    WinHttpSetTimeouts(session, timeout_ms, timeout_ms, timeout_ms, timeout_ms);
    connection = WinHttpConnect(session, host, comps.nPort, 0);
    if (!connection) goto done;

    wchar_t full_path[8192];
    _snwprintf(full_path, 8191, L"%s%s", path, extra);
    full_path[8191] = 0;

    wchar_t *wmethod = utf8_to_wide(method && *method ? method : "GET");
    request = WinHttpOpenRequest(connection, wmethod, full_path, NULL,
                                 WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                 comps.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0);
    free(wmethod);
    if (!request) goto done;

    /* Apply caller-supplied headers. */
    cJSON *hdrs = cJSON_Parse(headers_json ? headers_json : "{}");
    if (cJSON_IsObject(hdrs)) {
        cJSON *h;
        cJSON_ArrayForEach(h, hdrs) {
            if (!cJSON_IsString(h)) continue;
            char line[4096];
            snprintf(line, sizeof(line), "%s: %s", h->string, h->valuestring);
            wchar_t *wline = utf8_to_wide(line);
            if (wline) {
                WinHttpAddRequestHeaders(request, wline, (DWORD)-1,
                                         WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
                free(wline);
            }
        }
    }
    if (hdrs) cJSON_Delete(hdrs);

    if (!WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            (LPVOID)body, (DWORD)body_len, (DWORD)body_len, 0)) goto done;
    if (!WinHttpReceiveResponse(request, NULL)) goto done;

    DWORD code = 0, size = sizeof(code), index = 0;
    WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &code, &size, &index);
    *status = (int)code;

    wchar_t status_buf[256] = {0};
    DWORD status_len = sizeof(status_buf);
    index = 0;
    if (WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_TEXT, WINHTTP_HEADER_NAME_BY_INDEX,
                            status_buf, &status_len, &index)) {
        *status_text = wide_to_utf8(status_buf);
    }

    DWORD all_len = 0;
    index = 0;
    WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                        NULL, &all_len, &index);
    if (all_len > 0) {
        wchar_t *raw = (wchar_t *)malloc(all_len + sizeof(wchar_t));
        if (raw && WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF,
                                       WINHTTP_HEADER_NAME_BY_INDEX, raw, &all_len, &index)) {
            cJSON *obj = cJSON_CreateObject();
            wchar_t *line = raw;
            for (wchar_t *p = raw; ; p++) {
                if (*p == L'\r' || *p == L'\n' || *p == 0) {
                    int end = (*p == 0);
                    wchar_t saved = *p;
                    *p = 0;
                    if (line != p) {
                        wchar_t *colon = wcschr(line, L':');
                        if (colon) {
                            *colon = 0;
                            char *k = wide_to_utf8(line);
                            wchar_t *v = colon + 1;
                            while (*v == L' ') v++;
                            char *val = wide_to_utf8(v);
                            if (k && val) cJSON_AddStringToObject(obj, k, val);
                            free(k); free(val);
                        }
                    }
                    *p = saved;
                    if (end) break;
                    while (*p == L'\r' || *p == L'\n') p++;
                    line = p;
                    if (*p == 0) break;
                    p--; /* compensate for loop increment */
                }
            }
            *headers_out = cJSON_PrintUnformatted(obj);
            cJSON_Delete(obj);
        }
        free(raw);
    }

    /* Read the body. */
    size_t cap = 65536, len = 0;
    uint8_t *buf = (uint8_t *)malloc(cap);
    if (!buf) goto done;
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(request, &avail)) break;
        if (avail == 0) break;
        if (len + avail + 1 > cap) {
            while (len + avail + 1 > cap) cap *= 2;
            uint8_t *nb = (uint8_t *)realloc(buf, cap);
            if (!nb) { free(buf); goto done; }
            buf = nb;
        }
        DWORD read = 0;
        if (!WinHttpReadData(request, buf + len, avail, &read)) break;
        if (read == 0) break;
        len += read;
    }
    *body_out = buf;
    *body_out_len = len;
    rc = 0;

done:
    if (request) WinHttpCloseHandle(request);
    if (connection) WinHttpCloseHandle(connection);
    if (session) WinHttpCloseHandle(session);
    free(wurl);
    return rc;
}

/* ------------------------------------------------------------- file dialogs */

static char *file_import(const char *accept) {
    (void)accept;
    char *result = NULL;
    IFileOpenDialog *dialog = NULL;
    HRESULT hr = CoCreateInstance(&CLSID_FileOpenDialog, NULL, CLSCTX_INPROC_SERVER,
                                  &IID_IFileOpenDialog, (void **)&dialog);
    if (FAILED(hr) || !dialog) return NULL;
    DWORD options = 0;
    IFileOpenDialog_GetOptions(dialog, &options);
    IFileOpenDialog_SetOptions(dialog, options | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST);
    if (SUCCEEDED(IFileOpenDialog_Show(dialog, g_hwnd))) {
        IShellItem *item = NULL;
        if (SUCCEEDED(IFileOpenDialog_GetResult(dialog, &item)) && item) {
            PWSTR path = NULL;
            if (SUCCEEDED(IShellItem_GetDisplayName(item, SIGDN_FILESYSPATH, &path)) && path) {
                result = wide_to_utf8(path);
                CoTaskMemFree(path);
            }
            IShellItem_Release(item);
        }
    }
    IFileOpenDialog_Release(dialog);
    return result;
}

static char *file_export(const char *suggested_name) {
    char *result = NULL;
    IFileSaveDialog *dialog = NULL;
    HRESULT hr = CoCreateInstance(&CLSID_FileSaveDialog, NULL, CLSCTX_INPROC_SERVER,
                                  &IID_IFileSaveDialog, (void **)&dialog);
    if (FAILED(hr) || !dialog) return NULL;
    DWORD options = 0;
    IFileSaveDialog_GetOptions(dialog, &options);
    IFileSaveDialog_SetOptions(dialog, options | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT);
    wchar_t *wname = utf8_to_wide(suggested_name);
    if (wname) { IFileSaveDialog_SetFileName(dialog, wname); free(wname); }
    if (SUCCEEDED(IFileSaveDialog_Show(dialog, g_hwnd))) {
        IShellItem *item = NULL;
        if (SUCCEEDED(IFileSaveDialog_GetResult(dialog, &item)) && item) {
            PWSTR path = NULL;
            if (SUCCEEDED(IShellItem_GetDisplayName(item, SIGDN_FILESYSPATH, &path)) && path) {
                result = wide_to_utf8(path);
                CoTaskMemFree(path);
            }
            IShellItem_Release(item);
        }
    }
    IFileSaveDialog_Release(dialog);
    return result;
}

static void exit_app(void) {
    PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
}

static ea_host_callbacks g_callbacks = {
    http_request, file_import, file_export, exit_app, log_line
};

/* ------------------------------------------------------- bridge (UI thread) */

/*
 * Bridge calls arrive on the UI thread. File dialogs must run there, while HTTP
 * would block the message loop, so requests are handed to a worker thread and
 * the reply is marshalled back with PostMessage.
 */
#define WM_APP_RESOLVE (WM_APP + 1)

typedef struct {
    double id;
    int ok;
    char *payload;
} ResolveJob;

typedef struct {
    char *message;
} BridgeJob;

static DWORD WINAPI bridge_worker(LPVOID param) {
    BridgeJob *job = (BridgeJob *)param;
    cJSON *msg = cJSON_Parse(job->message);
    double id = 0;
    if (msg) {
        cJSON *id_item = cJSON_GetObjectItemCaseSensitive(msg, "id");
        if (cJSON_IsNumber(id_item)) id = id_item->valuedouble;
        cJSON_Delete(msg);
    }
    ea_result r = ea_bridge_dispatch(&g_cfg, &g_callbacks, job->message);
    ResolveJob *rj = (ResolveJob *)malloc(sizeof(ResolveJob));
    if (rj) {
        rj->id = id;
        rj->ok = r.ok;
        rj->payload = r.json; /* ownership moves */
        if (!PostMessageW(g_hwnd, WM_APP_RESOLVE, 0, (LPARAM)rj)) {
            free(rj->payload); free(rj);
            ea_result_free(&r);
        }
    } else {
        ea_result_free(&r);
    }
    free(job->message);
    free(job);
    return 0;
}

static void handle_bridge_message(const char *json) {
    BridgeJob *job = (BridgeJob *)malloc(sizeof(BridgeJob));
    if (!job) return;
    job->message = _strdup(json);
    HANDLE thread = CreateThread(NULL, 0, bridge_worker, job, 0, NULL);
    if (thread) CloseHandle(thread);
    else { free(job->message); free(job); }
}

/* -------------------------------------------------- WebView2 event handlers */

/* WebMessageReceived: forwards `window.chrome.webview.postMessage` payloads. */
typedef struct {
    ComHeader header;
} WebMessageHandler;

static HRESULT STDMETHODCALLTYPE wm_invoke(ICoreWebView2WebMessageReceivedEventHandler *This,
                                           ICoreWebView2 *sender,
                                           ICoreWebView2WebMessageReceivedEventArgs *args) {
    (void)This; (void)sender;
    LPWSTR raw = NULL;
    if (SUCCEEDED(ICoreWebView2WebMessageReceivedEventArgs_TryGetWebMessageAsString(args, &raw)) && raw) {
        char *utf8 = wide_to_utf8(raw);
        if (utf8) { handle_bridge_message(utf8); free(utf8); }
        CoTaskMemFree(raw);
    }
    return S_OK;
}

static const ICoreWebView2WebMessageReceivedEventHandlerVtbl wm_vtbl = {
    (void *)handler_qi, (void *)handler_addref, (void *)handler_release, (void *)wm_invoke
};

/* NavigationStarting: enforce the network permission for external navigation. */
typedef struct { ComHeader header; } NavHandler;

static HRESULT STDMETHODCALLTYPE nav_invoke(ICoreWebView2NavigationStartingEventHandler *This,
                                            ICoreWebView2 *sender,
                                            ICoreWebView2NavigationStartingEventArgs *args) {
    (void)This; (void)sender;
    LPWSTR uri = NULL;
    if (FAILED(ICoreWebView2NavigationStartingEventArgs_get_Uri(args, &uri)) || !uri) return S_OK;
    char *u = wide_to_utf8(uri);
    if (u) {
        size_t origin_len = strlen(kAssetOrigin);
        int is_local = strncmp(u, kAssetOrigin, origin_len) == 0;
        if (!is_local && !g_cfg.allow_internet) {
            ICoreWebView2NavigationStartingEventArgs_put_Cancel(args, TRUE);
        }
        free(u);
    }
    CoTaskMemFree(uri);
    return S_OK;
}

static const ICoreWebView2NavigationStartingEventHandlerVtbl nav_vtbl = {
    (void *)handler_qi, (void *)handler_addref, (void *)handler_release, (void *)nav_invoke
};

/*
 * WebResourceRequested: serve bundled assets from memory for our fake origin.
 * This keeps the page on a stable https:// origin (so localStorage, fetch and
 * modules work) without exposing any real file system path.
 */
typedef struct { ComHeader header; } ResourceHandler;

static HRESULT STDMETHODCALLTYPE res_invoke(ICoreWebView2WebResourceRequestedEventHandler *This,
                                            ICoreWebView2 *sender,
                                            ICoreWebView2WebResourceRequestedEventArgs *args) {
    (void)This; (void)sender;
    ICoreWebView2WebResourceRequest *request = NULL;
    if (FAILED(ICoreWebView2WebResourceRequestedEventArgs_get_Request(args, &request)) || !request)
        return S_OK;

    LPWSTR uri = NULL;
    ICoreWebView2WebResourceRequest_get_Uri(request, &uri);
    ICoreWebView2WebResourceRequest_Release(request);
    if (!uri) return S_OK;

    char *u = wide_to_utf8(uri);
    CoTaskMemFree(uri);
    if (!u) return S_OK;

    size_t origin_len = strlen(kAssetOrigin);
    if (strncmp(u, kAssetOrigin, origin_len) != 0) {
        /* External subresource: block unless internet was granted. */
        if (!g_cfg.allow_internet) {
            ICoreWebView2WebResourceRequestedEventArgs_put_Response(args, NULL);
        }
        free(u);
        return S_OK;
    }

    /* Strip origin, query and fragment, then percent-decode. */
    char *rel = u + origin_len;
    if (*rel == '/') rel++;
    char *q = strpbrk(rel, "?#");
    if (q) *q = '\0';
    if (*rel == '\0') rel = g_cfg.entry;

    char decoded[4096];
    DWORD decoded_len = sizeof(decoded);
    if (FAILED(UrlCanonicalizeA(rel, decoded, &decoded_len, 0))) {
        snprintf(decoded, sizeof(decoded), "%s", rel);
    }

    char *path = ea_safe_join(g_cfg.www_dir, decoded);
    size_t len = 0;
    char *data = path ? ea_read_file(path, &len) : NULL;

    IStream *stream = NULL;
    int status = 200;
    const char *reason = "OK";
    char *mime = ea_mime_for(decoded);

    if (!data) {
        status = 404; reason = "Not Found";
        free(mime);
        mime = _strdup("text/plain; charset=utf-8");
        data = _strdup("Not found");
        len = strlen(data);
    }

    /* SHCreateMemStream copies the buffer, so `data` can be freed afterwards. */
    stream = SHCreateMemStream((const BYTE *)data, (UINT)len);
    if (stream) {
        wchar_t headers[512];
        _snwprintf(headers, 511, L"Content-Type: %S\r\nAccess-Control-Allow-Origin: *\r\n", mime);
        headers[511] = 0;
        ICoreWebView2WebResourceResponse *response = NULL;
        wchar_t *wreason = utf8_to_wide(reason);
        HRESULT rhr = ICoreWebView2Environment_CreateWebResourceResponse(
            g_env, stream, status, wreason ? wreason : L"OK", headers, &response);
        free(wreason);
        if (SUCCEEDED(rhr) && response) {
            ICoreWebView2WebResourceRequestedEventArgs_put_Response(args, response);
            ICoreWebView2WebResourceResponse_Release(response);
        }
        IStream_Release(stream);
    }
    free(mime); free(data); free(path); free(u);
    return S_OK;
}

static const ICoreWebView2WebResourceRequestedEventHandlerVtbl res_vtbl = {
    (void *)handler_qi, (void *)handler_addref, (void *)handler_release, (void *)res_invoke
};

/* Controller-created: size the view, install handlers and navigate. */
typedef struct { ComHeader header; } ControllerHandler;

static HRESULT STDMETHODCALLTYPE ctrl_invoke(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *This,
                                             HRESULT result, ICoreWebView2Controller *controller) {
    (void)This;
    if (FAILED(result) || !controller) {
        MessageBoxW(g_hwnd, L"Failed to create the WebView2 controller.", L"EasyApp", MB_ICONERROR);
        return S_OK;
    }
    g_controller = controller;
    ICoreWebView2Controller_AddRef(controller);
    ICoreWebView2Controller_get_CoreWebView2(controller, &g_webview);
    if (!g_webview) return S_OK;
    ICoreWebView2_AddRef(g_webview);

    RECT bounds;
    GetClientRect(g_hwnd, &bounds);
    ICoreWebView2Controller_put_Bounds(controller, bounds);

    ICoreWebView2Settings *settings = NULL;
    if (SUCCEEDED(ICoreWebView2_get_Settings(g_webview, &settings)) && settings) {
        ICoreWebView2Settings_put_IsStatusBarEnabled(settings, FALSE);
        ICoreWebView2Settings_put_AreDefaultContextMenusEnabled(settings, FALSE);
        ICoreWebView2Settings_put_IsWebMessageEnabled(settings, TRUE);
        ICoreWebView2Settings_put_AreDevToolsEnabled(settings, FALSE);
        ICoreWebView2Settings_Release(settings);
    }

    WebMessageHandler *wm = (WebMessageHandler *)calloc(1, sizeof(WebMessageHandler));
    wm->header.lpVtbl = &wm_vtbl; wm->header.refs = 1;
    EventRegistrationToken token;
    ICoreWebView2_add_WebMessageReceived(g_webview,
        (ICoreWebView2WebMessageReceivedEventHandler *)wm, &token);

    NavHandler *nav = (NavHandler *)calloc(1, sizeof(NavHandler));
    nav->header.lpVtbl = &nav_vtbl; nav->header.refs = 1;
    ICoreWebView2_add_NavigationStarting(g_webview,
        (ICoreWebView2NavigationStartingEventHandler *)nav, &token);

    ResourceHandler *res = (ResourceHandler *)calloc(1, sizeof(ResourceHandler));
    res->header.lpVtbl = &res_vtbl; res->header.refs = 1;
    wchar_t filter[256];
    _snwprintf(filter, 255, L"%S/*", kAssetOrigin);
    filter[255] = 0;
    ICoreWebView2_AddWebResourceRequestedFilter(g_webview, filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    /* Also observe external requests so the internet permission is enforced. */
    ICoreWebView2_AddWebResourceRequestedFilter(g_webview, L"*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    ICoreWebView2_add_WebResourceRequested(g_webview,
        (ICoreWebView2WebResourceRequestedEventHandler *)res, &token);

    /* Inject the manifest and transport before any page script runs. */
    char *manifest_path = ea_safe_join(g_cfg.www_dir, "__easyapp_manifest.json");
    size_t mlen = 0;
    char *manifest = manifest_path ? ea_read_file(manifest_path, &mlen) : NULL;
    free(manifest_path);
    if (!manifest) manifest = _strdup("{\"permissions\":[]}");

    size_t boot_len = strlen(manifest) + strlen(g_bridge_js ? g_bridge_js : "") + 512;
    char *boot = (char *)malloc(boot_len);
    snprintf(boot, boot_len,
             "window.__EASYAPP_MANIFEST__ = %s;"
             "window.__easyappTransport = function (json) { window.chrome.webview.postMessage(json); };"
             "%s",
             manifest, g_bridge_js ? g_bridge_js : "");
    wchar_t *wboot = utf8_to_wide(boot);
    if (wboot) {
        ICoreWebView2_AddScriptToExecuteOnDocumentCreated(g_webview, wboot, NULL);
        free(wboot);
    }
    free(boot); free(manifest);

    char url[4096];
    snprintf(url, sizeof(url), "%s/%s", kAssetOrigin, g_cfg.entry);
    wchar_t *wurl = utf8_to_wide(url);
    if (wurl) { ICoreWebView2_Navigate(g_webview, wurl); free(wurl); }

    ShowWindow(g_hwnd, SW_SHOW);
    return S_OK;
}

static const ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl ctrl_vtbl = {
    (void *)handler_qi, (void *)handler_addref, (void *)handler_release, (void *)ctrl_invoke
};

/* Environment-created: ask for a controller. */
typedef struct { ComHeader header; } EnvHandler;

static HRESULT STDMETHODCALLTYPE env_invoke(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *This,
                                            HRESULT result, ICoreWebView2Environment *env) {
    (void)This;
    if (FAILED(result) || !env) {
        MessageBoxW(g_hwnd,
                    L"WebView2 runtime is not available.\n\n"
                    L"Install the Microsoft Edge WebView2 Evergreen Runtime, then start the app again.",
                    L"EasyApp", MB_ICONERROR);
        PostQuitMessage(1);
        return S_OK;
    }
    g_env = env;
    ICoreWebView2Environment_AddRef(env);

    ControllerHandler *ch = (ControllerHandler *)calloc(1, sizeof(ControllerHandler));
    ch->header.lpVtbl = &ctrl_vtbl; ch->header.refs = 1;
    ICoreWebView2Environment_CreateCoreWebView2Controller(
        env, g_hwnd, (ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *)ch);
    return S_OK;
}

static const ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandlerVtbl env_vtbl = {
    (void *)handler_qi, (void *)handler_addref, (void *)handler_release, (void *)env_invoke
};

/* -------------------------------------------------------- runtime discovery */

/*
 * Locate the Evergreen WebView2 runtime and resolve its factory export. The
 * client GUID is documented by Microsoft for the Evergreen runtime.
 */
static int load_webview2_runtime(void) {
    const wchar_t *client_guid = L"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const wchar_t *roots[] = {
        L"SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\",
        L"SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\",
    };
    for (int i = 0; i < 2; i++) {
        wchar_t key_path[512];
        _snwprintf(key_path, 511, L"%s%s", roots[i], client_guid);
        key_path[511] = 0;
        HKEY roots_key[] = { HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER };
        for (int k = 0; k < 2; k++) {
            HKEY key;
            if (RegOpenKeyExW(roots_key[k], key_path, 0, KEY_READ, &key) != ERROR_SUCCESS) continue;
            wchar_t version[64] = {0};
            DWORD vlen = sizeof(version);
            DWORD type = 0;
            LONG rc = RegQueryValueExW(key, L"pv", NULL, &type, (BYTE *)version, &vlen);
            RegCloseKey(key);
            if (rc != ERROR_SUCCESS || version[0] == 0 || wcscmp(version, L"0.0.0.0") == 0) continue;

            const wchar_t *bases[] = {
                L"%s\\Microsoft\\EdgeWebView\\Application\\%s\\EmbeddedBrowserWebView.dll"
            };
            (void)bases;
            wchar_t program_files[MAX_PATH] = {0}, program_files_x86[MAX_PATH] = {0}, local_app[MAX_PATH] = {0};
            GetEnvironmentVariableW(L"ProgramFiles", program_files, MAX_PATH);
            GetEnvironmentVariableW(L"ProgramFiles(x86)", program_files_x86, MAX_PATH);
            GetEnvironmentVariableW(L"LOCALAPPDATA", local_app, MAX_PATH);
            const wchar_t *dirs[] = { program_files_x86, program_files, local_app };
            for (int d = 0; d < 3; d++) {
                if (dirs[d][0] == 0) continue;
                wchar_t dll[MAX_PATH * 2];
                _snwprintf(dll, MAX_PATH * 2 - 1,
                           L"%s\\Microsoft\\EdgeWebView\\Application\\%s\\EmbeddedBrowserWebView.dll",
                           dirs[d], version);
                dll[MAX_PATH * 2 - 1] = 0;
                HMODULE mod = LoadLibraryW(dll);
                if (!mod) continue;
                pCreateEnv = (CreateEnvFn)(void *)GetProcAddress(mod, "CreateCoreWebView2EnvironmentWithOptions");
                if (pCreateEnv) return 0;
                FreeLibrary(mod);
            }
        }
    }
    /* Fall back to a loader placed next to the executable, if present. */
    HMODULE mod = LoadLibraryW(L"WebView2Loader.dll");
    if (mod) {
        pCreateEnv = (CreateEnvFn)(void *)GetProcAddress(mod, "CreateCoreWebView2EnvironmentWithOptions");
        if (pCreateEnv) return 0;
    }
    return -1;
}

/* ------------------------------------------------------------ window proc */

static LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_SIZE:
            if (g_controller) {
                RECT bounds;
                GetClientRect(hwnd, &bounds);
                ICoreWebView2Controller_put_Bounds(g_controller, bounds);
            }
            return 0;
        case WM_APP_RESOLVE: {
            ResolveJob *rj = (ResolveJob *)lp;
            if (rj) {
                resolve_message(rj->id, rj->ok, rj->payload ? rj->payload : "null");
                free(rj->payload);
                free(rj);
            }
            return 0;
        }
        case WM_CLOSE:
            DestroyWindow(hwnd);
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wp, lp);
    }
}

static char *exe_dir(void) {
    char path[MAX_PATH * 2];
    DWORD n = GetModuleFileNameA(NULL, path, sizeof(path));
    if (n == 0 || n >= sizeof(path)) return _strdup(".");
    char *slash = strrchr(path, '\\');
    if (slash) *slash = '\0';
    return _strdup(path);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE prev, LPSTR cmd_line, int show) {
    (void)prev; (void)cmd_line; (void)show;
    SetProcessDPIAware();
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) return 1;

    g_base_dir = exe_dir();
    if (ea_config_load(&g_cfg, g_base_dir) != 0) {
        MessageBoxW(NULL, L"Cannot read www/__easyapp_manifest.json next to the executable.",
                    L"EasyApp", MB_ICONERROR);
        return 1;
    }

    char *bridge_path = ea_safe_join(g_cfg.www_dir, "__easyapp_bridge.js");
    size_t blen = 0;
    g_bridge_js = bridge_path ? ea_read_file(bridge_path, &blen) : NULL;
    free(bridge_path);

    if (load_webview2_runtime() != 0) {
        MessageBoxW(NULL,
                    L"Microsoft Edge WebView2 Runtime was not found.\n\n"
                    L"Install it from https://developer.microsoft.com/microsoft-edge/webview2/\n"
                    L"and start this application again.",
                    L"EasyApp", MB_ICONERROR);
        return 1;
    }

    WNDCLASSEXW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = wnd_proc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    wc.lpszClassName = kWindowClass;
    wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
    RegisterClassExW(&wc);

    wchar_t *title = utf8_to_wide(g_cfg.app_name);
    g_hwnd = CreateWindowExW(0, kWindowClass, title ? title : L"EasyApp",
                             WS_OVERLAPPEDWINDOW,
                             CW_USEDEFAULT, CW_USEDEFAULT, 1024, 768,
                             NULL, NULL, instance, NULL);
    free(title);
    if (!g_hwnd) return 1;

    /* Keep the runtime's user data inside the per-app directory. */
    wchar_t *wdata = utf8_to_wide(g_cfg.data_dir);
    EnvHandler *eh = (EnvHandler *)calloc(1, sizeof(EnvHandler));
    eh->header.lpVtbl = &env_vtbl; eh->header.refs = 1;
    hr = pCreateEnv(NULL, wdata, NULL,
                    (ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *)eh);
    free(wdata);
    if (FAILED(hr)) {
        MessageBoxW(g_hwnd, L"Failed to initialise the WebView2 environment.", L"EasyApp", MB_ICONERROR);
        return 1;
    }

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_webview) ICoreWebView2_Release(g_webview);
    if (g_controller) ICoreWebView2Controller_Release(g_controller);
    if (g_env) ICoreWebView2Environment_Release(g_env);
    free(g_bridge_js);
    ea_config_free(&g_cfg);
    free(g_base_dir);
    CoUninitialize();
    return (int)msg.wParam;
}
