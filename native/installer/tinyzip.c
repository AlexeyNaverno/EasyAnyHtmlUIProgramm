/*
 * Tiny ZIP + DEFLATE reader. Written from the format specifications
 * (RFC 1951 for DEFLATE, APPNOTE for ZIP) so the installer needs no external
 * compression library and builds entirely from source.
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
#ifndef _WIN32
/* Keep mkdir/opendir/readdir visible when compiled with -std=c11. */
#define _POSIX_C_SOURCE 200809L
#endif

#include "tinyzip.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>

#ifdef _WIN32
#include <windows.h>
#include <direct.h>
#define TZ_MKDIR(p) _mkdir(p)
#else
#define TZ_MKDIR(p) mkdir(p, 0755)
#endif

/* ------------------------------------------------------------ bit reader */

typedef struct {
    const unsigned char *data;
    size_t len;
    size_t pos;
    unsigned int bitbuf;
    int bitcount;
    int error;
} BitReader;

static int br_bits(BitReader *br, int count) {
    while (br->bitcount < count) {
        if (br->pos >= br->len) { br->error = 1; return 0; }
        br->bitbuf |= (unsigned int)br->data[br->pos++] << br->bitcount;
        br->bitcount += 8;
    }
    int value = (int)(br->bitbuf & ((1u << count) - 1u));
    br->bitbuf >>= count;
    br->bitcount -= count;
    return value;
}

/* --------------------------------------------------------- huffman decode */

#define MAXBITS 15
#define MAXLCODES 286
#define MAXDCODES 30
#define MAXCODES (MAXLCODES + MAXDCODES)
#define FIXLCODES 288

typedef struct {
    short count[MAXBITS + 1];
    short symbol[1 << MAXBITS];
} Huffman;

/* Build a decoding table from a list of code lengths (zlib "puff" approach). */
static int huffman_build(Huffman *h, const short *lengths, int n) {
    int symbol, len;
    for (len = 0; len <= MAXBITS; len++) h->count[len] = 0;
    for (symbol = 0; symbol < n; symbol++) h->count[lengths[symbol]]++;
    if (h->count[0] == n) return 0; /* no codes */

    int left = 1;
    for (len = 1; len <= MAXBITS; len++) {
        left <<= 1;
        left -= h->count[len];
        if (left < 0) return left; /* over-subscribed */
    }

    short offs[MAXBITS + 1];
    offs[1] = 0;
    for (len = 1; len < MAXBITS; len++) offs[len + 1] = offs[len] + h->count[len];
    for (symbol = 0; symbol < n; symbol++)
        if (lengths[symbol] != 0) h->symbol[offs[lengths[symbol]]++] = (short)symbol;
    return left;
}

static int huffman_decode(BitReader *br, const Huffman *h) {
    int len, code = 0, first = 0, count, index = 0;
    for (len = 1; len <= MAXBITS; len++) {
        code |= br_bits(br, 1);
        if (br->error) return -1;
        count = h->count[len];
        if (code - count < first) return h->symbol[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
    }
    return -1; /* ran out of codes */
}

static const short LENS[29] = {3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258};
static const short LEXT[29] = {0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0};
static const short DISTS[30] = {1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577};
static const short DEXT[30] = {0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13};

static int inflate_codes(BitReader *br, const Huffman *lc, const Huffman *dc,
                         unsigned char *out, size_t out_cap, size_t *out_len) {
    size_t len = *out_len;
    for (;;) {
        int symbol = huffman_decode(br, lc);
        if (symbol < 0) return -1;
        if (symbol < 256) {
            if (len >= out_cap) return -1;
            out[len++] = (unsigned char)symbol;
        } else if (symbol == 256) {
            *out_len = len;
            return 0;
        } else {
            symbol -= 257;
            if (symbol >= 29) return -1;
            int length = LENS[symbol] + br_bits(br, LEXT[symbol]);
            int dsym = huffman_decode(br, dc);
            if (dsym < 0 || dsym >= 30) return -1;
            unsigned int dist = (unsigned int)(DISTS[dsym] + br_bits(br, DEXT[dsym]));
            if (br->error || dist > len) return -1;
            if (len + (size_t)length > out_cap) return -1;
            while (length--) {
                out[len] = out[len - dist];
                len++;
            }
        }
    }
}

static int inflate_block(BitReader *br, const Huffman *lc, const Huffman *dc,
                         unsigned char *out, size_t out_cap, size_t *out_len) {
    /* Stored block: skip to the byte boundary and copy raw. */
    br->bitbuf = 0;
    br->bitcount = 0;
    if (br->pos + 4 > br->len) return -1;
    unsigned int len = (unsigned int)br->data[br->pos] | ((unsigned int)br->data[br->pos + 1] << 8);
    unsigned int nlen = (unsigned int)br->data[br->pos + 2] | ((unsigned int)br->data[br->pos + 3] << 8);
    br->pos += 4;
    if ((len ^ 0xffffu) != nlen) return -1;
    if (br->pos + len > br->len) return -1;
    if (*out_len + len > out_cap) return -1;
    memcpy(out + *out_len, br->data + br->pos, len);
    br->pos += len;
    *out_len += len;
    (void)lc; (void)dc;
    return 0;
}

unsigned char *tz_inflate(const unsigned char *src, size_t src_len,
                          size_t expected_len, size_t *out_len) {
    if (expected_len > 512u * 1024u * 1024u) return NULL;
    unsigned char *out = (unsigned char *)malloc(expected_len + 1);
    if (!out) return NULL;

    BitReader br = { src, src_len, 0, 0, 0, 0 };
    size_t produced = 0;
    int last = 0;

    do {
        last = br_bits(&br, 1);
        int type = br_bits(&br, 2);
        if (br.error) { free(out); return NULL; }

        if (type == 0) {
            if (inflate_block(&br, NULL, NULL, out, expected_len, &produced) != 0) { free(out); return NULL; }
        } else if (type == 1 || type == 2) {
            Huffman lc, dc;
            if (type == 1) {
                short lengths[FIXLCODES];
                int i;
                for (i = 0; i < 144; i++) lengths[i] = 8;
                for (; i < 256; i++) lengths[i] = 9;
                for (; i < 280; i++) lengths[i] = 7;
                for (; i < FIXLCODES; i++) lengths[i] = 8;
                huffman_build(&lc, lengths, FIXLCODES);
                for (i = 0; i < MAXDCODES; i++) lengths[i] = 5;
                huffman_build(&dc, lengths, MAXDCODES);
            } else {
                static const short ORDER[19] = {16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15};
                int nlen = br_bits(&br, 5) + 257;
                int ndist = br_bits(&br, 5) + 1;
                int ncode = br_bits(&br, 4) + 4;
                if (br.error || nlen > MAXLCODES || ndist > MAXDCODES) { free(out); return NULL; }
                short lengths[MAXCODES];
                memset(lengths, 0, sizeof(lengths));
                for (int i = 0; i < ncode; i++) lengths[ORDER[i]] = (short)br_bits(&br, 3);
                for (int i = ncode; i < 19; i++) lengths[ORDER[i]] = 0;
                Huffman clh;
                if (huffman_build(&clh, lengths, 19) != 0) { free(out); return NULL; }
                int index = 0;
                while (index < nlen + ndist) {
                    int symbol = huffman_decode(&br, &clh);
                    if (symbol < 0) { free(out); return NULL; }
                    if (symbol < 16) {
                        lengths[index++] = (short)symbol;
                    } else {
                        int rep = 0, value = 0;
                        if (symbol == 16) {
                            if (index == 0) { free(out); return NULL; }
                            value = lengths[index - 1];
                            rep = 3 + br_bits(&br, 2);
                        } else if (symbol == 17) {
                            rep = 3 + br_bits(&br, 3);
                        } else {
                            rep = 11 + br_bits(&br, 7);
                        }
                        if (br.error || index + rep > nlen + ndist) { free(out); return NULL; }
                        while (rep--) lengths[index++] = (short)value;
                    }
                }
                if (lengths[256] == 0) { free(out); return NULL; }
                if (huffman_build(&lc, lengths, nlen) < 0 ||
                    huffman_build(&dc, lengths + nlen, ndist) < 0) { free(out); return NULL; }
            }
            if (inflate_codes(&br, &lc, &dc, out, expected_len, &produced) != 0) { free(out); return NULL; }
        } else {
            free(out);
            return NULL;
        }
    } while (!last);

    out[produced] = '\0';
    if (out_len) *out_len = produced;
    return out;
}

/* -------------------------------------------------------------- ZIP parse */

static unsigned int rd16(const unsigned char *p) {
    return (unsigned int)p[0] | ((unsigned int)p[1] << 8);
}
static unsigned int rd32(const unsigned char *p) {
    return (unsigned int)p[0] | ((unsigned int)p[1] << 8)
         | ((unsigned int)p[2] << 16) | ((unsigned int)p[3] << 24);
}

/* Locate the End Of Central Directory record. */
static long find_eocd(const unsigned char *zip, size_t len) {
    if (len < 22) return -1;
    size_t back = len - 22;
    size_t limit = len > 22 + 65535 ? len - 22 - 65535 : 0;
    for (long i = (long)back; i >= (long)limit; i--) {
        if (rd32(zip + i) == 0x06054b50u) return i;
    }
    return -1;
}

/* Iterate central directory entries; returns next offset or -1. */
typedef struct {
    char name[1024];
    unsigned int method;
    unsigned int comp_size;
    unsigned int uncomp_size;
    unsigned int local_offset;
} ZipEntry;

static int read_entry(const unsigned char *zip, size_t len, size_t off, ZipEntry *e) {
    if (off + 46 > len || rd32(zip + off) != 0x02014b50u) return -1;
    unsigned int name_len = rd16(zip + off + 28);
    unsigned int extra_len = rd16(zip + off + 30);
    unsigned int comment_len = rd16(zip + off + 32);
    if (name_len >= sizeof(e->name)) return -1;
    if (off + 46 + name_len > len) return -1;
    e->method = rd16(zip + off + 10);
    e->comp_size = rd32(zip + off + 20);
    e->uncomp_size = rd32(zip + off + 24);
    e->local_offset = rd32(zip + off + 42);
    memcpy(e->name, zip + off + 46, name_len);
    e->name[name_len] = '\0';
    return (int)(off + 46 + name_len + extra_len + comment_len);
}

static unsigned char *extract_entry(const unsigned char *zip, size_t len,
                                    const ZipEntry *e, size_t *out_len) {
    size_t off = e->local_offset;
    if (off + 30 > len || rd32(zip + off) != 0x04034b50u) return NULL;
    unsigned int name_len = rd16(zip + off + 26);
    unsigned int extra_len = rd16(zip + off + 28);
    size_t data_off = off + 30 + name_len + extra_len;
    if (data_off + e->comp_size > len) return NULL;

    if (e->method == 0) {
        unsigned char *out = (unsigned char *)malloc(e->uncomp_size + 1);
        if (!out) return NULL;
        memcpy(out, zip + data_off, e->uncomp_size);
        out[e->uncomp_size] = '\0';
        if (out_len) *out_len = e->uncomp_size;
        return out;
    }
    if (e->method == 8) {
        return tz_inflate(zip + data_off, e->comp_size, e->uncomp_size, out_len);
    }
    return NULL;
}

unsigned char *tz_extract(const unsigned char *zip, size_t zip_len,
                          const char *name, size_t *out_len) {
    long eocd = find_eocd(zip, zip_len);
    if (eocd < 0) return NULL;
    unsigned int count = rd16(zip + eocd + 10);
    size_t off = rd32(zip + eocd + 16);
    ZipEntry e;
    for (unsigned int i = 0; i < count; i++) {
        int next = read_entry(zip, zip_len, off, &e);
        if (next < 0) return NULL;
        if (strcmp(e.name, name) == 0) return extract_entry(zip, zip_len, &e, out_len);
        off = (size_t)next;
    }
    return NULL;
}

static int safe_relative(const char *name) {
    if (!*name) return 0;
    if (name[0] == '/' || name[0] == '\\') return 0;
    if (strstr(name, "..")) return 0;
    if (strchr(name, '\\')) return 0;
    if (strlen(name) > 1 && name[1] == ':') return 0;
    return 1;
}

static void make_dirs(char *path) {
    for (char *p = path + 1; *p; p++) {
        if (*p == '/' || *p == '\\') {
            char saved = *p; *p = '\0';
            TZ_MKDIR(path);
            *p = saved;
        }
    }
}

int tz_extract_all(const unsigned char *zip, size_t zip_len, const char *dest_dir) {
    long eocd = find_eocd(zip, zip_len);
    if (eocd < 0) return -1;
    unsigned int count = rd16(zip + eocd + 10);
    size_t off = rd32(zip + eocd + 16);
    ZipEntry e;
    for (unsigned int i = 0; i < count; i++) {
        int next = read_entry(zip, zip_len, off, &e);
        if (next < 0) return -1;
        off = (size_t)next;

        size_t nlen = strlen(e.name);
        if (nlen && (e.name[nlen - 1] == '/')) continue; /* directory entry */
        if (!safe_relative(e.name)) continue;             /* skip unsafe paths */

        char path[4096];
        snprintf(path, sizeof(path), "%s/%s", dest_dir, e.name);
        make_dirs(path);

        size_t len = 0;
        unsigned char *data = extract_entry(zip, zip_len, &e, &len);
        if (!data) return -1;
        FILE *f = fopen(path, "wb");
        if (!f) { free(data); return -1; }
        size_t wrote = fwrite(data, 1, len, f);
        fclose(f);
        free(data);
        if (wrote != len) return -1;
    }
    return 0;
}
