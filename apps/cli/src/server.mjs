/**
 * Local web UI server for the compiler.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

import { inspect, compile } from '../../../packages/core/src/compiler.js';
import { describeTargets, buildLlmPrompt } from '../../../packages/core/src/index.js';
import { doctor, REPO_ROOT } from '../../../packages/core/src/toolchain.js';

const UI_DIR = join(REPO_ROOT, 'apps/ui');
const MAX_UPLOAD = 220 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readBody(req, limit = MAX_UPLOAD) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Upload exceeds the 220 MiB limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** In-memory artefact store so the browser can download build results. */
const artefacts = new Map();

export async function startServer({ port = 8080, host = '0.0.0.0', outDir = null } = {}) {
  const outputDir = outDir || join(process.cwd(), 'dist');
  await mkdir(outputDir, { recursive: true });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    try {
      /* ------------------------------------------------------- API */
      if (path === '/api/health') {
        return json(res, 200, { ok: true, service: 'easyapp-compiler' });
      }

      if (path === '/api/targets') {
        return json(res, 200, { targets: describeTargets() });
      }

      if (path === '/api/doctor') {
        return json(res, 200, await doctor());
      }

      if (path === '/api/prompt') {
        const lang = url.searchParams.get('lang') || 'ru';
        return json(res, 200, { prompt: buildLlmPrompt({ lang }), lang });
      }

      if (path === '/api/inspect' && req.method === 'POST') {
        const body = await readBody(req);
        const filename = req.headers['x-filename'] || 'upload.html';
        let overrides = null;
        const rawOverrides = req.headers['x-overrides'];
        if (rawOverrides) {
          try { overrides = JSON.parse(rawOverrides); } catch { /* ignore */ }
        }
        try {
          const info = inspect(new Uint8Array(body), { filename, overrides });
          return json(res, 200, { ok: true, ...info });
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      }

      if (path === '/api/build' && req.method === 'POST') {
        const body = await readBody(req);
        const filename = req.headers['x-filename'] || 'upload.html';
        const target = req.headers['x-target'] || 'windows-x64';
        let overrides = null;
        const rawOverrides = req.headers['x-overrides'];
        if (rawOverrides) {
          try { overrides = JSON.parse(rawOverrides); } catch { /* ignore */ }
        }
        const logs = [];
        try {
          const result = await compile(new Uint8Array(body), {
            filename, target, overrides, outDir: outputDir,
            onLog: (msg) => logs.push(msg),
          });
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          artefacts.set(id, {
            filename: result.filename,
            bytes: result.bytes,
            created: Date.now(),
          });
          // Keep the store bounded.
          if (artefacts.size > 20) {
            const oldest = [...artefacts.entries()].sort((a, b) => a[1].created - b[1].created)[0];
            artefacts.delete(oldest[0]);
          }
          return json(res, 200, {
            ok: true, id, filename: result.filename, size: result.bytes.length,
            path: result.path, warnings: result.warnings, log: logs,
            downloadUrl: `/api/download/${id}`,
          });
        } catch (err) {
          return json(res, 400, {
            ok: false, error: err.message, log: logs,
            projectZip: err.projectZip || null, partial: Boolean(err.partial),
          });
        }
      }

      if (path.startsWith('/api/download/')) {
        const id = path.slice('/api/download/'.length);
        const item = artefacts.get(id);
        if (!item) return json(res, 404, { ok: false, error: 'Artefact not found or expired' });
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': item.bytes.length,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(item.filename)}"`,
        });
        return res.end(Buffer.from(item.bytes));
      }

      /* ---------------------------------------------------- static UI */
      let rel = path === '/' ? '/index.html' : path;
      // Serve the shared runtime bridge so the UI can preview generated apps.
      if (rel.startsWith('/runtime/')) {
        const file = join(REPO_ROOT, 'packages/core/runtime', rel.slice('/runtime/'.length));
        if (!file.startsWith(join(REPO_ROOT, 'packages/core/runtime')) || !existsSync(file)) {
          return json(res, 404, { ok: false, error: 'Not found' });
        }
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        return res.end(data);
      }

      const file = resolve(join(UI_DIR, rel));
      if (!file.startsWith(resolve(UI_DIR)) || !existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      return res.end(data);
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, resolveListen);
  });

  const actual = server.address().port;
  console.log(`Компилятор запущен: http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`);
  console.log(`Результаты сборки сохраняются в: ${outputDir}`);
  return server;
}
