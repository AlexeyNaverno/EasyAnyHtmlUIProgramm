/*
 * Platform-independent bridge logic shared by the Windows and Linux hosts.
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
#ifndef EASYAPP_BRIDGE_CORE_H
#define EASYAPP_BRIDGE_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char *app_id;
    char *app_name;
    char *entry;
    int allow_internet;
    int allow_files;
    char *data_dir;   /* writable per-user directory */
    char *www_dir;    /* directory holding the bundled web assets */
} ea_config;

/* Result of a bridge call. `json` is heap allocated and must be freed. */
typedef struct {
    int ok;
    char *json;
} ea_result;

/* Initialise configuration from the manifest next to the executable. */
int ea_config_load(ea_config *cfg, const char *base_dir);
void ea_config_free(ea_config *cfg);

/*
 * Dispatch a bridge message. Returns a result whose `json` field is the payload
 * (or an error object). File dialogs and HTTP are delegated to the host through
 * the callbacks below so this file stays free of platform code.
 */
typedef struct {
    /* Perform an HTTP request. Implementation returns malloc'd body. */
    int (*http_request)(const char *url, const char *method,
                        const char *headers_json,
                        const uint8_t *body, size_t body_len,
                        int timeout_ms,
                        int *status, char **status_text,
                        char **headers_out,
                        uint8_t **body_out, size_t *body_out_len);
    /* Show an open dialog. Returns malloc'd path or NULL when cancelled. */
    char *(*file_import)(const char *accept);
    /* Show a save dialog. Returns malloc'd path or NULL when cancelled. */
    char *(*file_export)(const char *suggested_name);
    /* Close the main window. */
    void (*exit_app)(void);
    /* Write a log line. */
    void (*log)(const char *message);
} ea_host_callbacks;

ea_result ea_bridge_dispatch(const ea_config *cfg, const ea_host_callbacks *cb,
                             const char *message_json);

void ea_result_free(ea_result *r);

/* Helpers exposed for the platform layers. */
char *ea_read_file(const char *path, size_t *len);
int ea_write_file(const char *path, const uint8_t *data, size_t len);
char *ea_base64_encode(const uint8_t *data, size_t len);
uint8_t *ea_base64_decode(const char *text, size_t *len);
char *ea_mime_for(const char *path);
/* Resolve `rel` inside `base`, rejecting traversal. Returns malloc'd path. */
char *ea_safe_join(const char *base, const char *rel);

#ifdef __cplusplus
}
#endif

#endif /* EASYAPP_BRIDGE_CORE_H */
