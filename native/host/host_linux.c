/*
 * Linux host: WebKitGTK shell around the bundled web assets.
 *
 * Assets are served through a custom URI scheme so the page keeps a stable
 * origin without exposing file system paths. Build with:
 *   cc host_linux.c bridge_core.c cJSON.c $(pkg-config --cflags --libs gtk+-3.0 webkit2gtk-4.1)
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
/*
 * GTK and the POSIX helpers below (readlink, strdup) need the GNU/POSIX
 * declarations, which -std=c11 hides behind __STRICT_ANSI__.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif

#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <libsoup/soup.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>

#include "bridge_core.h"
#include "cJSON.h"

static ea_config g_cfg;
static GtkWidget *g_window = NULL;
static WebKitWebView *g_webview = NULL;
static char *g_bridge_js = NULL;
static char *g_manifest_json = NULL;

static const char *kScheme = "easyapp";

static void log_line(const char *message) {
    fprintf(stderr, "[EasyApp] %s\n", message ? message : "");
}

static void exit_app(void) {
    if (g_window) gtk_widget_destroy(g_window);
}

/* --------------------------------------------------------------- HTTP */

static int http_request(const char *url, const char *method, const char *headers_json,
                        const uint8_t *body, size_t body_len, int timeout_ms,
                        int *status, char **status_text, char **headers_out,
                        uint8_t **body_out, size_t *body_out_len) {
    SoupSession *session = soup_session_new();
    soup_session_set_timeout(session, (guint)(timeout_ms / 1000));

    SoupMessage *msg = soup_message_new(method && *method ? method : "GET", url);
    if (!msg) { g_object_unref(session); return -1; }

    cJSON *hdrs = cJSON_Parse(headers_json ? headers_json : "{}");
    if (cJSON_IsObject(hdrs)) {
        SoupMessageHeaders *request_headers = soup_message_get_request_headers(msg);
        cJSON *h;
        cJSON_ArrayForEach(h, hdrs) {
            if (cJSON_IsString(h))
                soup_message_headers_append(request_headers, h->string, h->valuestring);
        }
    }
    if (hdrs) cJSON_Delete(hdrs);

    GBytes *body_bytes = NULL;
    if (body && body_len) {
        body_bytes = g_bytes_new(body, body_len);
        soup_message_set_request_body_from_bytes(msg, "application/octet-stream", body_bytes);
    }

    GError *error = NULL;
    GBytes *response = soup_session_send_and_read(session, msg, NULL, &error);
    int rc = -1;
    if (response && !error) {
        *status = (int)soup_message_get_status(msg);
        const char *reason = soup_message_get_reason_phrase(msg);
        *status_text = g_strdup(reason ? reason : "");

        cJSON *obj = cJSON_CreateObject();
        SoupMessageHeaders *response_headers = soup_message_get_response_headers(msg);
        SoupMessageHeadersIter iter;
        soup_message_headers_iter_init(&iter, response_headers);
        const char *name, *value;
        while (soup_message_headers_iter_next(&iter, &name, &value))
            cJSON_AddStringToObject(obj, name, value);
        *headers_out = cJSON_PrintUnformatted(obj);
        cJSON_Delete(obj);

        gsize len = 0;
        gconstpointer data = g_bytes_get_data(response, &len);
        *body_out = (uint8_t *)malloc(len + 1);
        if (*body_out) {
            memcpy(*body_out, data, len);
            *body_out_len = len;
            rc = 0;
        }
        g_bytes_unref(response);
    }
    if (error) {
        log_line(error->message);
        g_error_free(error);
    }
    if (body_bytes) g_bytes_unref(body_bytes);
    g_object_unref(msg);
    g_object_unref(session);
    return rc;
}

/* -------------------------------------------------------- file dialogs */

static char *run_dialog(GtkFileChooserAction action, const char *suggested_name) {
    GtkWidget *dialog = gtk_file_chooser_dialog_new(
        action == GTK_FILE_CHOOSER_ACTION_OPEN ? "Import file" : "Export file",
        GTK_WINDOW(g_window), action,
        "_Cancel", GTK_RESPONSE_CANCEL,
        action == GTK_FILE_CHOOSER_ACTION_OPEN ? "_Open" : "_Save", GTK_RESPONSE_ACCEPT,
        NULL);
    if (suggested_name)
        gtk_file_chooser_set_current_name(GTK_FILE_CHOOSER(dialog), suggested_name);
    char *result = NULL;
    if (gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT)
        result = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(dialog));
    gtk_widget_destroy(dialog);
    return result;
}

static char *file_import(const char *accept) {
    (void)accept;
    return run_dialog(GTK_FILE_CHOOSER_ACTION_OPEN, NULL);
}

static char *file_export(const char *name) {
    return run_dialog(GTK_FILE_CHOOSER_ACTION_SAVE, name);
}

static ea_host_callbacks g_callbacks = {
    http_request, file_import, file_export, exit_app, log_line
};

/* -------------------------------------------------------------- bridge */

static void execute_js(const char *script) {
    if (!g_webview) return;
    webkit_web_view_evaluate_javascript(g_webview, script, -1, NULL, NULL, NULL, NULL, NULL);
}

typedef struct {
    char *message;
} BridgeJob;

/* Run the blocking part off the UI thread, then resolve on the UI thread. */
typedef struct {
    double id;
    int ok;
    char *payload;
} ResolveJob;

static gboolean resolve_on_ui(gpointer data) {
    ResolveJob *rj = (ResolveJob *)data;
    size_t n = strlen(rj->payload) + 128;
    char *script = (char *)malloc(n);
    if (script) {
        snprintf(script, n, "window.__easyappResolve(%.0f, %s, %s);",
                 rj->id, rj->ok ? "true" : "false", rj->payload);
        execute_js(script);
        free(script);
    }
    free(rj->payload);
    free(rj);
    return G_SOURCE_REMOVE;
}

/*
 * File dialogs must run on the UI thread, so `files.*` calls are dispatched
 * synchronously here while everything else goes to a worker thread.
 */
static gpointer bridge_worker(gpointer data) {
    BridgeJob *job = (BridgeJob *)data;
    cJSON *msg = cJSON_Parse(job->message);
    double id = 0;
    if (msg) {
        cJSON *id_item = cJSON_GetObjectItemCaseSensitive(msg, "id");
        if (cJSON_IsNumber(id_item)) id = id_item->valuedouble;
        cJSON_Delete(msg);
    }
    ea_result r = ea_bridge_dispatch(&g_cfg, &g_callbacks, job->message);
    ResolveJob *rj = (ResolveJob *)malloc(sizeof(ResolveJob));
    rj->id = id;
    rj->ok = r.ok;
    rj->payload = r.json;
    g_idle_add(resolve_on_ui, rj);
    free(job->message);
    free(job);
    return NULL;
}

static void on_script_message(WebKitUserContentManager *manager,
                              WebKitJavascriptResult *result, gpointer user_data) {
    (void)manager; (void)user_data;
    JSCValue *value = webkit_javascript_result_get_js_value(result);
    if (!jsc_value_is_string(value)) return;
    char *text = jsc_value_to_string(value);
    if (!text) return;

    /* Dialogs need the UI thread; other calls are handled by a worker. */
    if (strstr(text, "\"files.") != NULL) {
        cJSON *msg = cJSON_Parse(text);
        double id = 0;
        if (msg) {
            cJSON *id_item = cJSON_GetObjectItemCaseSensitive(msg, "id");
            if (cJSON_IsNumber(id_item)) id = id_item->valuedouble;
            cJSON_Delete(msg);
        }
        ea_result r = ea_bridge_dispatch(&g_cfg, &g_callbacks, text);
        ResolveJob *rj = (ResolveJob *)malloc(sizeof(ResolveJob));
        rj->id = id; rj->ok = r.ok; rj->payload = r.json;
        resolve_on_ui(rj);
    } else {
        BridgeJob *job = (BridgeJob *)malloc(sizeof(BridgeJob));
        job->message = g_strdup(text);
        GThread *thread = g_thread_new("easyapp-bridge", bridge_worker, job);
        if (thread) g_thread_unref(thread);
    }
    g_free(text);
}

/* ------------------------------------------------------- asset scheme */

static void on_uri_request(WebKitURISchemeRequest *request, gpointer user_data) {
    (void)user_data;
    const char *path = webkit_uri_scheme_request_get_path(request);
    if (!path || !*path || strcmp(path, "/") == 0) path = g_cfg.entry;
    while (*path == '/') path++;

    char *decoded = g_uri_unescape_string(path, NULL);
    const char *rel = decoded ? decoded : path;
    char *full = ea_safe_join(g_cfg.www_dir, rel);

    size_t len = 0;
    char *data = full ? ea_read_file(full, &len) : NULL;
    char *mime = ea_mime_for(rel);

    if (!data) {
        GError *err = g_error_new_literal(g_quark_from_string("easyapp"), 404, "Not found");
        webkit_uri_scheme_request_finish_error(request, err);
        g_error_free(err);
    } else {
        GInputStream *stream = g_memory_input_stream_new_from_data(data, (gssize)len, g_free);
        webkit_uri_scheme_request_finish(request, stream, (gint64)len, mime);
        g_object_unref(stream);
    }
    free(mime);
    free(full);
    if (decoded) g_free(decoded);
}

/* Block external navigation and subresources unless internet was granted. */
static gboolean on_decide_policy(WebKitWebView *web_view,
                                 WebKitPolicyDecision *decision,
                                 WebKitPolicyDecisionType type, gpointer user_data) {
    (void)web_view; (void)user_data;
    if (g_cfg.allow_internet) return FALSE;

    if (type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) {
        WebKitNavigationAction *action = webkit_navigation_policy_decision_get_navigation_action(
            WEBKIT_NAVIGATION_POLICY_DECISION(decision));
        WebKitURIRequest *req = webkit_navigation_action_get_request(action);
        const char *uri = webkit_uri_request_get_uri(req);
        if (g_str_has_prefix(uri, "easyapp:")) return FALSE;
        webkit_policy_decision_ignore(decision);
        return TRUE;
    }
    if (type == WEBKIT_POLICY_DECISION_TYPE_RESPONSE) {
        WebKitURIResponse *response = webkit_response_policy_decision_get_response(
            WEBKIT_RESPONSE_POLICY_DECISION(decision));
        const char *uri = webkit_uri_response_get_uri(response);
        if (g_str_has_prefix(uri, "easyapp:")) return FALSE;
        webkit_policy_decision_ignore(decision);
        return TRUE;
    }
    return FALSE;
}

static void on_load_changed(WebKitWebView *web_view, WebKitLoadEvent event, gpointer data) {
    (void)data;
    if (event == WEBKIT_LOAD_FINISHED) {
        size_t n = strlen(g_manifest_json) + strlen(g_bridge_js ? g_bridge_js : "") + 512;
        char *boot = (char *)malloc(n);
        snprintf(boot, n,
                 "window.__EASYAPP_MANIFEST__ = %s;%s",
                 g_manifest_json, g_bridge_js ? g_bridge_js : "");
        webkit_web_view_evaluate_javascript(web_view, boot, -1, NULL, NULL, NULL, NULL, NULL);
        free(boot);
    }
}

static char *exe_dir(void) {
    char path[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", path, sizeof(path) - 1);
    if (n <= 0) return g_strdup(".");
    path[n] = '\0';
    char *slash = strrchr(path, '/');
    if (slash) *slash = '\0';
    return g_strdup(path);
}

int main(int argc, char **argv) {
    gtk_init(&argc, &argv);

    char *base = exe_dir();
    if (ea_config_load(&g_cfg, base) != 0) {
        fprintf(stderr, "Cannot read www/__easyapp_manifest.json next to the executable.\n");
        g_free(base);
        return 1;
    }
    g_free(base);

    char *bridge_path = ea_safe_join(g_cfg.www_dir, "__easyapp_bridge.js");
    size_t blen = 0;
    g_bridge_js = bridge_path ? ea_read_file(bridge_path, &blen) : NULL;
    free(bridge_path);

    char *manifest_path = ea_safe_join(g_cfg.www_dir, "__easyapp_manifest.json");
    size_t mlen = 0;
    g_manifest_json = manifest_path ? ea_read_file(manifest_path, &mlen) : NULL;
    free(manifest_path);
    if (!g_manifest_json) g_manifest_json = strdup("{\"permissions\":[]}");

    /* Register the asset scheme before creating the view. */
    WebKitWebContext *context = webkit_web_context_get_default();
    webkit_web_context_register_uri_scheme(context, kScheme, on_uri_request, NULL, NULL);
    WebKitSecurityManager *security = webkit_web_context_get_security_manager(context);
    webkit_security_manager_register_uri_scheme_as_secure(security, kScheme);
    webkit_security_manager_register_uri_scheme_as_local(security, kScheme);
    webkit_security_manager_register_uri_scheme_as_cors_enabled(security, kScheme);

    WebKitUserContentManager *ucm = webkit_user_content_manager_new();
    webkit_user_content_manager_register_script_message_handler(ucm, "easyapp");
    g_signal_connect(ucm, "script-message-received::easyapp", G_CALLBACK(on_script_message), NULL);

    /* Inject the transport before page scripts execute. */
    char *bootstrap = g_strdup_printf(
        "window.__EASYAPP_MANIFEST__ = %s;"
        "window.__easyappTransport = function (json) {"
        "  window.webkit.messageHandlers.easyapp.postMessage(json);"
        "};", g_manifest_json);
    WebKitUserScript *script = webkit_user_script_new(
        bootstrap, WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES,
        WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, NULL, NULL);
    webkit_user_content_manager_add_script(ucm, script);
    webkit_user_script_unref(script);
    g_free(bootstrap);

    g_window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(g_window), g_cfg.app_name);
    gtk_window_set_default_size(GTK_WINDOW(g_window), 1024, 768);
    g_signal_connect(g_window, "destroy", G_CALLBACK(gtk_main_quit), NULL);

    g_webview = WEBKIT_WEB_VIEW(webkit_web_view_new_with_user_content_manager(ucm));

    WebKitSettings *settings = webkit_web_view_get_settings(g_webview);
    webkit_settings_set_enable_javascript(settings, TRUE);
    webkit_settings_set_enable_developer_extras(settings, FALSE);
    webkit_settings_set_allow_file_access_from_file_urls(settings, FALSE);
    webkit_settings_set_allow_universal_access_from_file_urls(settings, FALSE);
    webkit_settings_set_enable_write_console_messages_to_stdout(settings, TRUE);

    g_signal_connect(g_webview, "decide-policy", G_CALLBACK(on_decide_policy), NULL);
    g_signal_connect(g_webview, "load-changed", G_CALLBACK(on_load_changed), NULL);

    gtk_container_add(GTK_CONTAINER(g_window), GTK_WIDGET(g_webview));

    char *url = g_strdup_printf("%s:///%s", kScheme, g_cfg.entry);
    webkit_web_view_load_uri(g_webview, url);
    g_free(url);

    gtk_widget_show_all(g_window);
    gtk_main();

    free(g_bridge_js);
    free(g_manifest_json);
    ea_config_free(&g_cfg);
    return 0;
}
