/*
 * Tiny ZIP reader used by the installer. Supports stored (0) and deflate (8)
 * entries, which is all the compiler ever produces.
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
#ifndef EASYAPP_TINYZIP_H
#define EASYAPP_TINYZIP_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Extract one entry. Returns malloc'd bytes (NUL terminated) or NULL. */
unsigned char *tz_extract(const unsigned char *zip, size_t zip_len,
                          const char *name, size_t *out_len);

/* Extract every entry into `dest_dir`, creating subdirectories. 0 on success. */
int tz_extract_all(const unsigned char *zip, size_t zip_len, const char *dest_dir);

/* Raw DEFLATE decompression. Returns malloc'd buffer or NULL. */
unsigned char *tz_inflate(const unsigned char *src, size_t src_len,
                          size_t expected_len, size_t *out_len);

#ifdef __cplusplus
}
#endif

#endif /* EASYAPP_TINYZIP_H */
