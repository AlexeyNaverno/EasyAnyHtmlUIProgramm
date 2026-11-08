/*
 * Platform-independent bridge implementation.
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
#include "bridge_core.h"
#include "cJSON.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <errno.h>

#ifdef _WIN32
#include <windows.h>
#include <direct.h>
#define EA_MKDIR(p) _mkdir(p)
#define EA_SEP '\\'
#else
#include <unistd.h>
#include <dirent.h>
#define EA_MKDIR(p) mkdir(p, 0700)
#define EA_SEP '/'
#endif

/* ------------------------------------------------------------------ utils */

static char *xstrdup(const char *s) {
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *p = (char *)malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

static ea_result make_result(int ok, cJSON *payload) {
    ea_result r;
    r.ok = ok;
    r.json = payload ? cJSON_PrintUnformatted(payload) : xstrdup("null");
    if (payload) cJSON_Delete(payload);
    return r;
}

static ea_result make_error(const char *message) {
    cJSON *obj = cJSON_CreateObject();
    cJSON_AddStringToObject(obj, "message", message ? message : "Unknown error");
    return make_result(0, obj);
}

static ea_result make_ok(void) {
    ea_result r;
    r.ok = 1;
    r.json = xstrdup("null");
    return r;
}

void ea_result_free(ea_result *r) {
    if (r && r->json) { free(r->json); r->json = NULL; }
}

char *ea_read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long size = ftell(f);
    if (size < 0) { fclose(f); return NULL; }
    rewind(f);
    char *buf = (char *)malloc((size_t)size + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)size, f);
    fclose(f);
    buf[got] = '\0';
    if (len) *len = got;
    return buf;
}

static int mkdirs(const char *path) {
    char *copy = xstrdup(path);
    if (!copy) return -1;
    for (char *p = copy + 1; *p; p++) {
        if (*p == '/' || *p == '\\') {
            char saved = *p;
            *p = '\0';
            if (EA_MKDIR(copy) != 0 && errno != EEXIST) { /* keep going */ }
            *p = saved;
        }
    }
    int rc = EA_MKDIR(copy);
    if (rc != 0 && errno == EEXIST) rc = 0;
    free(copy);
    return rc;
}

int ea_write_file(const char *path, const uint8_t *data, size_t len) {
    char *copy = xstrdup(path);
    if (!copy) return -1;
    char *slash = strrchr(copy, '/');
    char *bslash = strrchr(copy, '\\');
    if (bslash > slash) slash = bslash;
    if (slash) { *slash = '\0'; mkdirs(copy); }
    free(copy);
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    size_t wrote = fwrite(data, 1, len, f);
    fclose(f);
    return wrote == len ? 0 : -1;
}

char *ea_safe_join(const char *base, const char *rel) {
    if (!rel) return NULL;
    if (rel[0] == '/' || rel[0] == '\\') return NULL;
    if (strchr(rel, '\\')) return NULL;
    if (strlen(rel) >= 2 && rel[1] == ':') return NULL;

    /* Reject any ".." segment. */
    const char *p = rel;
    while (*p) {
        const char *seg = p;
        while (*p && *p != '/') p++;
        size_t n = (size_t)(p - seg);
        if (n == 2 && seg[0] == '.' && seg[1] == '.') return NULL;
        if (*p == '/') p++;
    }

    size_t len = strlen(base) + strlen(rel) + 2;
    char *out = (char *)malloc(len);
    if (!out) return NULL;
    snprintf(out, len, "%s%c%s", base, EA_SEP, rel);
    return out;
}

/* ---------------------------------------------------------------- base64 */

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

char *ea_base64_encode(const uint8_t *data, size_t len) {
    size_t out_len = 4 * ((len + 2) / 3) + 1;
    char *out = (char *)malloc(out_len);
    if (!out) return NULL;
    size_t i, j = 0;
    for (i = 0; i + 2 < len; i += 3) {
        uint32_t v = (uint32_t)(data[i] << 16) | (uint32_t)(data[i + 1] << 8) | data[i + 2];
        out[j++] = B64[(v >> 18) & 63];
        out[j++] = B64[(v >> 12) & 63];
        out[j++] = B64[(v >> 6) & 63];
        out[j++] = B64[v & 63];
    }
    if (i < len) {
        uint32_t v = (uint32_t)(data[i] << 16);
        if (i + 1 < len) v |= (uint32_t)(data[i + 1] << 8);
        out[j++] = B64[(v >> 18) & 63];
        out[j++] = B64[(v >> 12) & 63];
        out[j++] = (i + 1 < len) ? B64[(v >> 6) & 63] : '=';
        out[j++] = '=';
    }
    out[j] = '\0';
    return out;
}

static int b64_index(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

uint8_t *ea_base64_decode(const char *text, size_t *len) {
    if (!text) return NULL;
    size_t n = strlen(text);
    uint8_t *out = (uint8_t *)malloc(n / 4 * 3 + 4);
    if (!out) return NULL;
    size_t out_len = 0;
    int quad[4];
    int qi = 0;
    for (size_t i = 0; i < n; i++) {
        char c = text[i];
        if (c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
        if (c == '=') break;
        int v = b64_index(c);
        if (v < 0) continue;
        quad[qi++] = v;
        if (qi == 4) {
            out[out_len++] = (uint8_t)((quad[0] << 2) | (quad[1] >> 4));
            out[out_len++] = (uint8_t)((quad[1] << 4) | (quad[2] >> 2));
            out[out_len++] = (uint8_t)((quad[2] << 6) | quad[3]);
            qi = 0;
        }
    }
    if (qi == 2) {
        out[out_len++] = (uint8_t)((quad[0] << 2) | (quad[1] >> 4));
    } else if (qi == 3) {
        out[out_len++] = (uint8_t)((quad[0] << 2) | (quad[1] >> 4));
        out[out_len++] = (uint8_t)((quad[1] << 4) | (quad[2] >> 2));
    }
    if (len) *len = out_len;
    return out;
}

/* ------------------------------------------------------------------ mime */

char *ea_mime_for(const char *path) {
    const char *dot = strrchr(path, '.');
    const char *ext = dot ? dot + 1 : "";
    struct { const char *e; const char *m; } table[] = {
        {"html", "text/html; charset=utf-8"}, {"htm", "text/html; charset=utf-8"},
        {"js", "application/javascript; charset=utf-8"}, {"mjs", "application/javascript; charset=utf-8"},
        {"css", "text/css; charset=utf-8"}, {"json", "application/json; charset=utf-8"},
        {"png", "image/png"}, {"jpg", "image/jpeg"}, {"jpeg", "image/jpeg"},
        {"gif", "image/gif"}, {"svg", "image/svg+xml"}, {"webp", "image/webp"},
        {"ico", "image/x-icon"}, {"woff", "font/woff"}, {"woff2", "font/woff2"},
        {"ttf", "font/ttf"}, {"wasm", "application/wasm"},
        {"txt", "text/plain; charset=utf-8"}, {"md", "text/plain; charset=utf-8"},
        {"pdf", "application/pdf"}, {"mp3", "audio/mpeg"}, {"mp4", "video/mp4"},
    };
    for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
        if (strcmp(ext, table[i].e) == 0) return xstrdup(table[i].m);
    }
    return xstrdup("application/octet-stream");
}

/* ---------------------------------------------------------------- config */

static char *path_join2(const char *a, const char *b) {
    size_t n = strlen(a) + strlen(b) + 2;
    char *out = (char *)malloc(n);
    if (out) snprintf(out, n, "%s%c%s", a, EA_SEP, b);
    return out;
}

static char *get_data_dir(const char *app_id) {
#ifdef _WIN32
    const char *base = getenv("LOCALAPPDATA");
    if (!base) base = getenv("APPDATA");
    if (!base) base = ".";
#else
    const char *base = getenv("XDG_DATA_HOME");
    char fallback[4096];
    if (!base) {
        const char *home = getenv("HOME");
        if (!home) home = ".";
        snprintf(fallback, sizeof(fallback), "%s/.local/share", home);
        base = fallback;
    }
#endif
    char *dir = path_join2(base, "EasyApp");
    char *full = path_join2(dir, app_id);
    free(dir);
    mkdirs(full);
    return full;
}

int ea_config_load(ea_config *cfg, const char *base_dir) {
    memset(cfg, 0, sizeof(*cfg));
    cfg->www_dir = path_join2(base_dir, "www");
    char *manifest_path = ea_safe_join(cfg->www_dir, "__easyapp_manifest.json");
    if (!manifest_path) return -1;
    size_t len = 0;
    char *text = ea_read_file(manifest_path, &len);
    free(manifest_path);
    if (!text) return -1;

    cJSON *root = cJSON_Parse(text);
    free(text);
    if (!root) return -1;

    cJSON *id = cJSON_GetObjectItemCaseSensitive(root, "id");
    cJSON *name = cJSON_GetObjectItemCaseSensitive(root, "name");
    cJSON *entry = cJSON_GetObjectItemCaseSensitive(root, "entry");
    cfg->app_id = xstrdup(cJSON_IsString(id) ? id->valuestring : "org.easyapp.app");
    cfg->app_name = xstrdup(cJSON_IsString(name) ? name->valuestring : "EasyApp");
    cfg->entry = xstrdup(cJSON_IsString(entry) ? entry->valuestring : "index.html");

    cJSON *perms = cJSON_GetObjectItemCaseSensitive(root, "permissions");
    if (cJSON_IsArray(perms)) {
        cJSON *p;
        cJSON_ArrayForEach(p, perms) {
            if (!cJSON_IsString(p)) continue;
            if (strcmp(p->valuestring, "internet") == 0) cfg->allow_internet = 1;
            if (strcmp(p->valuestring, "files") == 0) cfg->allow_files = 1;
        }
    }
    cJSON_Delete(root);
    cfg->data_dir = get_data_dir(cfg->app_id);
    return 0;
}

void ea_config_free(ea_config *cfg) {
    free(cfg->app_id); free(cfg->app_name); free(cfg->entry);
    free(cfg->data_dir); free(cfg->www_dir);
    memset(cfg, 0, sizeof(*cfg));
}

/* --------------------------------------------------------------- storage */

static char *storage_path(const ea_config *cfg) {
    return path_join2(cfg->data_dir, "storage.json");
}

static cJSON *storage_load(const ea_config *cfg) {
    char *path = storage_path(cfg);
    size_t len = 0;
    char *text = ea_read_file(path, &len);
    free(path);
    cJSON *obj = text ? cJSON_Parse(text) : NULL;
    free(text);
    if (!cJSON_IsObject(obj)) {
        if (obj) cJSON_Delete(obj);
        obj = cJSON_CreateObject();
    }
    return obj;
}

static int storage_save(const ea_config *cfg, cJSON *obj) {
    char *path = storage_path(cfg);
    char *text = cJSON_PrintUnformatted(obj);
    int rc = ea_write_file(path, (const uint8_t *)text, strlen(text));
    free(text);
    free(path);
    return rc;
}

/* -------------------------------------------------------------- dispatch */

static const char *json_str(cJSON *obj, const char *key, const char *fallback) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(item) ? item->valuestring : fallback;
}

ea_result ea_bridge_dispatch(const ea_config *cfg, const ea_host_callbacks *cb,
                             const char *message_json) {
    cJSON *msg = cJSON_Parse(message_json);
    if (!msg) return make_error("Invalid JSON message");

    const char *method = json_str(msg, "method", "");
    cJSON *p = cJSON_GetObjectItemCaseSensitive(msg, "params");
    if (!cJSON_IsObject(p)) p = cJSON_CreateObject();

    ea_result result;

    if (strcmp(method, "app.log") == 0) {
        if (cb->log) cb->log(json_str(p, "message", ""));
        result = make_ok();
    } else if (strcmp(method, "app.exit") == 0) {
        if (cb->exit_app) cb->exit_app();
        result = make_ok();
    } else if (strncmp(method, "storage.", 8) == 0) {
        cJSON *store = storage_load(cfg);
        const char *key = json_str(p, "key", "");
        if (strcmp(method, "storage.get") == 0) {
            cJSON *v = cJSON_GetObjectItemCaseSensitive(store, key);
            cJSON *payload = cJSON_CreateString(cJSON_IsString(v) ? v->valuestring : "");
            result = make_result(1, payload);
        } else if (strcmp(method, "storage.set") == 0) {
            const char *value = json_str(p, "value", "");
            cJSON_DeleteItemFromObjectCaseSensitive(store, key);
            cJSON_AddStringToObject(store, key, value);
            result = storage_save(cfg, store) == 0 ? make_ok() : make_error("Cannot write storage");
        } else if (strcmp(method, "storage.remove") == 0) {
            cJSON_DeleteItemFromObjectCaseSensitive(store, key);
            result = storage_save(cfg, store) == 0 ? make_ok() : make_error("Cannot write storage");
        } else if (strcmp(method, "storage.keys") == 0) {
            cJSON *arr = cJSON_CreateArray();
            cJSON *item;
            cJSON_ArrayForEach(item, store) cJSON_AddItemToArray(arr, cJSON_CreateString(item->string));
            result = make_result(1, arr);
        } else {
            result = make_error("Unknown storage method");
        }
        cJSON_Delete(store);
    } else if (strncmp(method, "private.", 8) == 0) {
        char *priv = path_join2(cfg->data_dir, "files");
        mkdirs(priv);
        const char *rel = json_str(p, "path", "");
        char *full = ea_safe_join(priv, rel);
        if (!full && strcmp(method, "private.list") != 0) {
            result = make_error("Unsafe path");
        } else if (strcmp(method, "private.read") == 0) {
            size_t len = 0;
            char *data = ea_read_file(full, &len);
            if (!data) {
                result = make_error("File not found");
            } else {
                char *b64 = ea_base64_encode((const uint8_t *)data, len);
                cJSON *payload = cJSON_CreateObject();
                cJSON_AddStringToObject(payload, "data", b64);
                free(b64); free(data);
                result = make_result(1, payload);
            }
        } else if (strcmp(method, "private.write") == 0) {
            size_t len = 0;
            uint8_t *data = ea_base64_decode(json_str(p, "data", ""), &len);
            int rc = ea_write_file(full, data, len);
            free(data);
            result = rc == 0 ? make_ok() : make_error("Cannot write file");
        } else if (strcmp(method, "private.remove") == 0) {
            result = remove(full) == 0 ? make_ok() : make_error("Cannot remove file");
        } else if (strcmp(method, "private.list") == 0) {
            const char *dir = full ? full : priv;
            cJSON *arr = cJSON_CreateArray();
#ifdef _WIN32
            char pattern[4096];
            snprintf(pattern, sizeof(pattern), "%s\\*", dir);
            WIN32_FIND_DATAA fd;
            HANDLE h = FindFirstFileA(pattern, &fd);
            if (h != INVALID_HANDLE_VALUE) {
                do {
                    if (strcmp(fd.cFileName, ".") && strcmp(fd.cFileName, ".."))
                        cJSON_AddItemToArray(arr, cJSON_CreateString(fd.cFileName));
                } while (FindNextFileA(h, &fd));
                FindClose(h);
            }
#else
            DIR *d = opendir(dir);
            if (d) {
                struct dirent *ent;
                while ((ent = readdir(d)) != NULL) {
                    if (strcmp(ent->d_name, ".") && strcmp(ent->d_name, ".."))
                        cJSON_AddItemToArray(arr, cJSON_CreateString(ent->d_name));
                }
                closedir(d);
            }
#endif
            result = make_result(1, arr);
        } else {
            result = make_error("Unknown private file method");
        }
        free(full);
        free(priv);
    } else if (strcmp(method, "net.request") == 0) {
        if (!cfg->allow_internet) {
            result = make_error("Permission \"internet\" is not granted for this application");
        } else if (!cb->http_request) {
            result = make_error("HTTP is unavailable on this host");
        } else {
            const char *url = json_str(p, "url", "");
            if (strncmp(url, "http://", 7) != 0 && strncmp(url, "https://", 8) != 0) {
                result = make_error("Only http and https requests are allowed");
            } else {
                const char *encoding = json_str(p, "bodyEncoding", "utf8");
                uint8_t *body = NULL;
                size_t body_len = 0;
                cJSON *body_item = cJSON_GetObjectItemCaseSensitive(p, "body");
                if (cJSON_IsString(body_item)) {
                    if (strcmp(encoding, "base64") == 0) {
                        body = ea_base64_decode(body_item->valuestring, &body_len);
                    } else {
                        body_len = strlen(body_item->valuestring);
                        body = (uint8_t *)xstrdup(body_item->valuestring);
                    }
                }
                cJSON *headers = cJSON_GetObjectItemCaseSensitive(p, "headers");
                char *headers_json = headers ? cJSON_PrintUnformatted(headers) : xstrdup("{}");
                cJSON *timeout = cJSON_GetObjectItemCaseSensitive(p, "timeout");
                int timeout_ms = cJSON_IsNumber(timeout) ? (int)timeout->valuedouble : 30000;

                int status = 0;
                char *status_text = NULL, *headers_out = NULL;
                uint8_t *body_out = NULL;
                size_t body_out_len = 0;
                int rc = cb->http_request(url, json_str(p, "method", "GET"), headers_json,
                                          body, body_len, timeout_ms, &status, &status_text,
                                          &headers_out, &body_out, &body_out_len);
                free(body); free(headers_json);
                if (rc != 0) {
                    result = make_error("Network request failed");
                } else {
                    cJSON *payload = cJSON_CreateObject();
                    cJSON_AddNumberToObject(payload, "status", status);
                    cJSON_AddStringToObject(payload, "statusText", status_text ? status_text : "");
                    cJSON *hdr = headers_out ? cJSON_Parse(headers_out) : NULL;
                    cJSON_AddItemToObject(payload, "headers", cJSON_IsObject(hdr) ? hdr : cJSON_CreateObject());
                    char *b64 = ea_base64_encode(body_out ? body_out : (const uint8_t *)"", body_out_len);
                    cJSON_AddStringToObject(payload, "body", b64 ? b64 : "");
                    free(b64);
                    result = make_result(1, payload);
                }
                free(status_text); free(headers_out); free(body_out);
            }
        }
    } else if (strcmp(method, "files.import") == 0 || strcmp(method, "files.export") == 0) {
        if (!cfg->allow_files) {
            result = make_error("Permission \"files\" is not granted for this application");
        } else if (strcmp(method, "files.import") == 0) {
            char *path = cb->file_import ? cb->file_import(json_str(p, "accept", "*/*")) : NULL;
            if (!path) {
                result = make_ok(); /* cancelled -> null */
            } else {
                size_t len = 0;
                char *data = ea_read_file(path, &len);
                if (!data) {
                    result = make_error("Cannot read the selected file");
                } else {
                    const char *slash = strrchr(path, '/');
                    const char *bslash = strrchr(path, '\\');
                    if (bslash > slash) slash = bslash;
                    cJSON *payload = cJSON_CreateObject();
                    cJSON_AddStringToObject(payload, "name", slash ? slash + 1 : path);
                    char *b64 = ea_base64_encode((const uint8_t *)data, len);
                    cJSON_AddStringToObject(payload, "data", b64 ? b64 : "");
                    free(b64); free(data);
                    result = make_result(1, payload);
                }
                free(path);
            }
        } else {
            const char *name = json_str(p, "name", "file.bin");
            char *path = cb->file_export ? cb->file_export(name) : NULL;
            if (!path) {
                result = make_error("Export cancelled");
            } else {
                size_t len = 0;
                uint8_t *data = ea_base64_decode(json_str(p, "data", ""), &len);
                int rc = ea_write_file(path, data, len);
                free(data);
                if (rc == 0) {
                    cJSON *payload = cJSON_CreateObject();
                    cJSON_AddStringToObject(payload, "name", name);
                    result = make_result(1, payload);
                } else {
                    result = make_error("Cannot write the selected file");
                }
                free(path);
            }
        }
    } else {
        result = make_error("Unknown method");
    }

    cJSON_Delete(msg);
    return result;
}
