#!/usr/bin/env node
/**
 * MCP server for EasyAnyHtmlUIProgramm.
 *
 * Implements the Model Context Protocol over stdio using newline-delimited
 * JSON-RPC 2.0, with no third-party SDK so the whole tool builds from source.
 *
 * Tools:
 *   easyapp_inspect        — parse an .html/.zip bundle and report permissions
 *   easyapp_build          — compile a bundle for a target
 *   easyapp_targets        — list build targets
 *   easyapp_doctor         — report the available toolchain
 *   easyapp_packaging_prompt — the LLM instructions for authoring a bundle
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';

import { inspect, compile } from '../../../packages/core/src/compiler.js';
import { describeTargets, buildLlmPrompt, KNOWN_PERMISSIONS } from '../../../packages/core/src/index.js';
import { doctor } from '../../../packages/core/src/toolchain.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'easyanyhtmluiprogramm', version: '0.1.0' };

const TOOLS = [
  {
    name: 'easyapp_inspect',
    description:
      'Parse an .html or .zip bundle and report its manifest, requested permissions, '
      + 'entry point and compatibility problems. Call this before building.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a local .html or .zip file' },
        html: { type: 'string', description: 'Inline HTML source (alternative to path)' },
      },
    },
  },
  {
    name: 'easyapp_build',
    description:
      'Compile an .html or .zip bundle into a native artefact. Returns the output path. '
      + 'Use easyapp_targets to list targets and easyapp_doctor to check the toolchain. '
      + 'Without a native toolchain, use web-bundle or source-project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the input .html or .zip file' },
        html: { type: 'string', description: 'Inline HTML source (alternative to path)' },
        target: {
          type: 'string',
          description: 'Build target id',
          default: 'windows-x64',
        },
        outDir: { type: 'string', description: 'Output directory (default ./dist)' },
        name: { type: 'string', description: 'Override the application name' },
        appId: { type: 'string', description: 'Override the application id, e.g. org.example.app' },
        version: { type: 'string', description: 'Override the version, e.g. 1.0.0' },
        permissions: {
          type: 'array',
          items: { type: 'string', enum: KNOWN_PERMISSIONS },
          description: 'Override the permission set. Omit to use the directives in the HTML.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'easyapp_targets',
    description: 'List every supported build target with its toolchain requirements.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'easyapp_doctor',
    description:
      'Report which parts of the native toolchain are installed (Zig, JDK, Android SDK, '
      + 'Gradle, C compiler, WebKitGTK) and what each target needs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'easyapp_packaging_prompt',
    description:
      'Return the full authoring instructions for producing an .html/.zip bundle that this '
      + 'compiler accepts: manifest directives, permissions, the window.easyapp runtime API '
      + 'and compatibility rules. Give this text to an LLM before asking it to write an app.',
    inputSchema: {
      type: 'object',
      properties: {
        lang: { type: 'string', enum: ['ru', 'en'], default: 'ru' },
      },
    },
  },
];

function readInput(args) {
  if (args.html !== undefined) {
    if (typeof args.html !== 'string' || args.html.length === 0) {
      throw new Error('"html" must be a non-empty string');
    }
    return { bytes: new Uint8Array(Buffer.from(args.html, 'utf8')), filename: 'index.html' };
  }
  if (typeof args.path === 'string' && args.path.length > 0) {
    const full = resolve(args.path);
    return { bytes: new Uint8Array(readFileSync(full)), filename: basename(full) };
  }
  throw new Error('Provide either "path" (a local .html/.zip file) or "html" (inline source)');
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'easyapp_targets':
      return { targets: describeTargets() };

    case 'easyapp_doctor': {
      const report = await doctor();
      const hints = [];
      if (!report.zig.available) hints.push('Windows targets need Zig: pip install ziglang');
      if (!report.java.available) hints.push('Android needs JDK 17: apt install openjdk-17-jdk');
      if (!report.androidSdk.available) hints.push('Android needs the SDK and ANDROID_HOME');
      if (!report.webkit2gtk.available) hints.push('Linux needs libgtk-3-dev and libwebkit2gtk-4.1-dev');
      hints.push('Always available without a toolchain: web-bundle, source-project');
      return { ...report, hints };
    }

    case 'easyapp_packaging_prompt':
      return { lang: args.lang || 'ru', prompt: buildLlmPrompt({ lang: args.lang || 'ru' }) };

    case 'easyapp_inspect': {
      const { bytes, filename } = readInput(args);
      const info = inspect(bytes, { filename });
      return info;
    }

    case 'easyapp_build': {
      const { bytes, filename } = readInput(args);
      const overrides = {};
      if (args.name) overrides.name = args.name;
      if (args.appId) overrides.id = args.appId;
      if (args.version) overrides.version = args.version;
      if (Array.isArray(args.permissions)) overrides.permissions = args.permissions;

      const outDir = resolve(args.outDir || 'dist');
      mkdirSync(outDir, { recursive: true });
      const log = [];
      try {
        const result = await compile(bytes, {
          filename,
          target: args.target,
          overrides: Object.keys(overrides).length ? overrides : null,
          outDir,
          onLog: (m) => log.push(m),
        });
        return {
          ok: true, path: result.path, filename: result.filename,
          bytes: result.bytes.length, warnings: result.warnings, log,
        };
      } catch (err) {
        return {
          ok: false, error: err.message, log,
          projectZip: err.projectZip || null,
          hint: 'Run easyapp_doctor to see which toolchain component is missing.',
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ------------------------------------------------------------- JSON-RPC */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;

  // Notifications carry no id and must not be answered.
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, prompts: {}, resources: {} },
          serverInfo: SERVER_INFO,
        });
        return;

      case 'notifications/initialized':
      case 'initialized':
        return;

      case 'ping':
        reply(id, {});
        return;

      case 'tools/list':
        reply(id, { tools: TOOLS });
        return;

      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        try {
          const result = await callTool(name, args);
          reply(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: result && result.ok === false,
          });
        } catch (err) {
          reply(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          });
        }
        return;
      }

      case 'prompts/list':
        reply(id, {
          prompts: [{
            name: 'easyapp_authoring',
            description: 'Instructions for writing an .html/.zip bundle for this compiler',
            arguments: [{ name: 'lang', description: 'ru or en', required: false }],
          }],
        });
        return;

      case 'prompts/get': {
        const lang = params?.arguments?.lang || 'ru';
        reply(id, {
          description: 'EasyApp bundle authoring instructions',
          messages: [{
            role: 'user',
            content: { type: 'text', text: buildLlmPrompt({ lang }) },
          }],
        });
        return;
      }

      case 'resources/list':
        reply(id, {
          resources: [{
            uri: 'easyapp://targets',
            name: 'Build targets',
            description: 'Supported compilation targets and their requirements',
            mimeType: 'application/json',
          }],
        });
        return;

      case 'resources/read': {
        const uri = params?.uri;
        if (uri !== 'easyapp://targets') {
          replyError(id, -32602, `Unknown resource: ${uri}`);
          return;
        }
        reply(id, {
          contents: [{
            uri, mimeType: 'application/json',
            text: JSON.stringify(describeTargets(), null, 2),
          }],
        });
        return;
      }

      default:
        if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (!isNotification) replyError(id, -32603, err.message);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    replyError(null, -32700, 'Parse error');
    return;
  }
  handle(message);
});

process.stderr.write('EasyApp MCP server ready (stdio)\n');
