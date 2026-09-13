/**
 * helpers.mjs — shared utilities for all boxsh test files.
 *
 * Import with:
 *   import { run, rpc, rpcMany, rpcConcurrent, BOXSH } from './helpers.mjs';
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// Keep child-process output deterministic across direct and aggregated test
// runs. Some runners/terminals export FORCE_COLOR, which makes nested Node
// invocations print ANSI-colored numbers (for example console.log(42)).
delete process.env.FORCE_COLOR;
delete process.env.CLICOLOR_FORCE;
process.env.NO_COLOR = '1';
process.env.NODE_DISABLE_COLORS = '1';

/** Absolute path to the boxsh binary. Override with BOXSH env-var. */
export const BOXSH = path.resolve(
  process.env.BOXSH ?? path.join(__dir, '../build/boxsh'),
);

/**
 * Workspace temp dir — lives under $HOME on the same XFS volume, so newly
 * allocated inodes carry large 64-bit numbers.  Use this instead of
 * os.tmpdir() whenever the lower layer of an overlay must have realistic
 * (large) inode numbers in order to exercise the EOVERFLOW copy-up path.
 */
export const TEMPDIR = path.resolve(__dir, '../temp');
fs.mkdirSync(TEMPDIR, { recursive: true });

// Remove all boxsh-* subdirs created under TEMPDIR when the process exits.
// This is a belt-and-suspenders cleanup: each test already has its own
// try/finally, but this handler catches anything left behind by aborted runs.
// Also cleans up .boxsh-try-* dirs created by --try mode in TEMPDIR and its
// parent (--try creates temp dirs as siblings of CWD for same-volume cloning).
process.on('exit', () => {
  const cleanDirs = [TEMPDIR, path.dirname(TEMPDIR)];
  for (const dir of cleanDirs) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('boxsh-') || entry.startsWith('.boxsh-try-')) {
          const p = path.join(dir, entry);
          // Overlayfs sets work directory permissions to 0000; chmod first.
          spawnSync('chmod', ['-R', 'u+rwx', p]);
          fs.rmSync(p, { recursive: true, force: true });
        }
      }
    } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a flat test request into MCP JSON-RPC 2.0 tools/call format.
 * @param {object} req  e.g. {id, cmd, timeout} or {id, tool: 'read', path, ...}
 * @returns {object} JSON-RPC 2.0 request
 */
export function toJsonRpc(req) {
  const { id, tool, cmd, timeout, sandbox, ...rest } = req;
  if (tool) {
    // Built-in tool: read, write, edit → tools/call
    return {
      jsonrpc: '2.0', id: id ?? '',
      method: 'tools/call',
      params: { name: tool, arguments: rest },
    };
  } else if (cmd !== undefined) {
    // Shell command → tools/call bash
    const args = { command: cmd };
    if (timeout !== undefined) args.timeout = timeout;
    return {
      jsonrpc: '2.0', id: id ?? '',
      method: 'tools/call',
      params: { name: 'bash', arguments: args },
    };
  }
  // Invalid request for testing error paths — omit method.
  return { jsonrpc: '2.0', id: id ?? '' };
}

/**
 * Unwrap a JSON-RPC 2.0 response into a flat object compatible with old tests.
 * Flattens structuredContent so that e.g. r.exit_code, r.stdout, r.diff work.
 * For failures (isError=true) the readable message is exposed as r.error, and
 * the stable error code (r.code) comes from structuredContent when present.
 * @param {object} raw  JSON-RPC 2.0 response
 * @returns {object}
 */
export function fromJsonRpc(raw) {
  if (raw.error) {
    return { id: raw.id ?? '', error: raw.error.message ?? '' };
  }
  const result = raw.result ?? {};
  const { structuredContent, ...rest } = result;
  const flat = { id: raw.id ?? '', ...rest, ...(structuredContent ?? {}) };

  if (result.isError) {
    // Tool errors carry {code, message}; a non-zero command exit does not.
    if (structuredContent && typeof structuredContent.message === 'string') {
      flat.error = structuredContent.message;
    } else if (Array.isArray(result.content)) {
      const text = result.content.filter(c => c.type === 'text')
        .map(c => c.text).join('\n');
      if (text) flat.error = text;
    }
  }

  return flat;
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validation
//
// boxsh's outputSchema descriptors stay inside a small, documented subset so
// that the test suite can validate real tool results without pulling in an
// external dependency (the repo has no root package.json; CI runs `node
// --test` only).
//
// Supported keywords: anyOf, type (string or array of strings), enum,
// properties, required, items. Everything else is ignored.
// ---------------------------------------------------------------------------

const JSON_TYPE_NAMES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];

function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value; // object | string | boolean
}

function matchesSchemaType(type, value) {
  const actual = jsonTypeOf(value);
  if (type === actual) return true;
  // An integer satisfies "number"; a number like 1.5 does not satisfy "integer".
  if (type === 'number' && actual === 'integer') return true;
  return false;
}

/**
 * Validate a value against a boxsh outputSchema (subset — see above).
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]} list of human-readable violations (empty = valid)
 */
export function schemaErrors(schema, value, path = '$') {
  const errors = [];

  if (schema.anyOf) {
    const ok = schema.anyOf.some(s => schemaErrors(s, value, path).length === 0);
    if (!ok) errors.push(`${path}: value does not match any anyOf branch`);
    return errors;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) {
      if (!JSON_TYPE_NAMES.includes(t))
        errors.push(`${path}: schema uses unsupported type "${t}"`);
    }
    if (!types.some(t => matchesSchemaType(t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${jsonTypeOf(value)}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value)))
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);

  if (jsonTypeOf(value) === 'object' && (schema.properties || schema.required)) {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key))
        errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(value, key))
        errors.push(...schemaErrors(subschema, value[key], `${path}.${key}`));
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errors.push(...schemaErrors(schema.items, item, `${path}[${i}]`));
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Test image fixtures
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Build a real (decodable) 8-bit RGB PNG of the given size.
 * Uses node's zlib, so the suite needs no image library.
 * @param {number} width
 * @param {number} height
 * @param {{ solid?: boolean }} [opts]  solid = single colour (tiny file)
 * @returns {Buffer}
 */
export function makePng(width, height, { solid = false } = {}) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      if (solid) {
        raw[p] = 0x40; raw[p + 1] = 0x80; raw[p + 2] = 0xc0;
      } else {
        raw[p]     = (x * 7 + y) & 0xff;
        raw[p + 1] = (x + y * 5) & 0xff;
        raw[p + 2] = (x ^ y) & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Build a PNG that *declares* large dimensions while carrying almost no image
 * data: the IHDR (with a valid CRC) says width×height, the IDAT is a tiny
 * deflate stream that cannot produce those scanlines.
 *
 * Used to exercise the decode-time resource guard: a decoder that trusts IHDR
 * will try to allocate width×height×channels before discovering the data is
 * bad ("decompression bomb").  Never call makePng() with huge dimensions — it
 * allocates the full pixel buffer.
 *
 * @param {number} width
 * @param {number} height
 * @param {{ colourType?: number }} [opts]
 * @returns {Buffer}
 */
export function makePngDeclared(width, height, { colourType = 2 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                // bit depth
  ihdr[9] = colourType;       // 2 = truecolour (3 bytes/pixel)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(1024, 0x11))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Synchronous helpers
// ---------------------------------------------------------------------------

/**
 * Run boxsh synchronously.
 * @param {string[]} args
 * @param {string}   [input]         stdin text
 * @param {number}   [timeout_ms]
 * @returns {{ stdout: string, stderr: string, status: number|null, signal: string|null }}
 */
export function run(args, input = '', timeout_ms = 5000) {
  return spawnSync(BOXSH, args, {
    input,
    timeout: timeout_ms,
    encoding: 'utf8',
    // MAX_OUTPUT_BYTES in worker_pool.cpp caps each stream at 10 MiB; the
    // serialized JSON response can therefore reach ~25 MiB.  Raise maxBuffer
    // well above that so spawnSync never kills boxsh due to buffer overflow.
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Like rpc() but returns the untouched JSON-RPC 2.0 response, so tests can
 * assert on the exact MCP shape (content array, structuredContent, isError).
 * @param {object} req
 * @param {{ workers?: number, timeout_ms?: number, sandbox?: boolean }} [opts]
 * @returns {object}
 */
export function rpcRaw(req, { workers = 2, timeout_ms = 5000, sandbox = false } = {}) {
  const line = JSON.stringify(toJsonRpc(req)) + '\n';
  const args = ['--rpc', '--workers', String(workers)];
  if (sandbox) args.push('--sandbox');
  const r = run(args, line, timeout_ms);
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  const trimmed = r.stdout.trim();
  assert.ok(trimmed.length > 0, 'boxsh produced no stdout');
  return JSON.parse(trimmed);
}

/**
 * Run boxsh in --rpc mode with a single JSON request.
 * Asserts that boxsh exits cleanly and returns a non-empty response.
 * @param {object} req
 * @param {{ workers?: number, timeout_ms?: number }} [opts]
 * @returns {object} parsed JSON response
 */
export function rpc(req, { workers = 2, timeout_ms = 5000 } = {}) {
  const line = JSON.stringify(toJsonRpc(req)) + '\n';
  const r = run(['--rpc', '--workers', String(workers)], line, timeout_ms);
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  const trimmed = r.stdout.trim();
  assert.ok(trimmed.length > 0, 'boxsh produced no stdout');
  return fromJsonRpc(JSON.parse(trimmed));
}

/**
 * Like rpc() but runs with --sandbox so tool child processes apply the sandbox.
 * @param {object} req
 * @param {{ workers?: number, timeout_ms?: number }} [opts]
 * @returns {object} parsed JSON response
 */
export function rpcSandboxed(req, { workers = 2, timeout_ms = 8000 } = {}) {
  const line = JSON.stringify(toJsonRpc(req)) + '\n';
  const r = run(['--rpc', '--sandbox', '--workers', String(workers)], line, timeout_ms);
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  const trimmed = r.stdout.trim();
  assert.ok(trimmed.length > 0, 'boxsh produced no stdout');
  return fromJsonRpc(JSON.parse(trimmed));
}

/**
 * Run boxsh in --rpc mode with multiple requests (written all at once via stdin).
 * Returns array of parsed responses in arrival order.
 * @param {object[]} requests
 * @param {{ workers?: number, timeout_ms?: number, sandbox?: boolean }} [opts]
 * @returns {object[]}
 */
export function rpcMany(requests, { workers = 4, timeout_ms = 8000, sandbox = false } = {}) {
  const input = requests.map(r => JSON.stringify(toJsonRpc(r))).join('\n') + '\n';
  const args = ['--rpc', '--workers', String(workers)];
  if (sandbox) args.push('--sandbox');
  const r = run(args, input, timeout_ms);
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  return r.stdout
    .trim()
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => fromJsonRpc(JSON.parse(l)));
}

/**
 * Index an array of responses by their id field for easy lookup.
 * @param {object[]} resps
 * @returns {Record<string, object>}
 */
export function byId(resps) {
  return Object.fromEntries(resps.map(r => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Interactive session (stateful tool tests: terminals, MCP handshakes)
// ---------------------------------------------------------------------------

/**
 * A long-running `boxsh --rpc` process for tests that need several tools to
 * share one server instance (e.g. terminal sessions).
 *
 * Usage:
 *   const s = new BoxshSession();
 *   const resp = await s.call('run_in_terminal', { command: 'bash' });
 *   await s.close();
 */
export class BoxshSession {
  constructor({ workers = 2 } = {}) {
    this._proc = spawn(BOXSH, ['--rpc', '--workers', String(workers)]);
    this._pending = new Map();   // id → { resolve, reject }
    this._nextId  = 1;
    this._closed  = false;

    const rl = createInterface({ input: this._proc.stdout });
    rl.on('line', line => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = this._pending.get(String(msg.id));
      if (p) {
        this._pending.delete(String(msg.id));
        p.resolve(msg);
      }
    });

    this._proc.on('error', err => {
      for (const p of this._pending.values()) p.reject(err);
      this._pending.clear();
    });
  }

  /**
   * Send a single tools/call request and return the raw JSON-RPC response.
   * @param {string} toolName - MCP tool name
   * @param {object} [args]   - tool arguments (args.id is the terminal session id)
   * @param {number} [timeout_ms]
   */
  call(toolName, args = {}, timeout_ms = 8000) {
    return new Promise((resolve, reject) => {
      const reqId = String(this._nextId++);
      // Build JSON-RPC directly so args.id goes to the tool arguments,
      // not to the JSON-RPC request id field.
      const rpcReq = {
        jsonrpc: '2.0',
        id: reqId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      };
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error(`timeout waiting for response to id=${reqId} (tool=${toolName})`));
      }, timeout_ms);

      this._pending.set(reqId, {
        resolve: msg => { clearTimeout(timer); resolve(msg); },
        reject:  err  => { clearTimeout(timer); reject(err);  },
      });

      this._proc.stdin.write(JSON.stringify(rpcReq) + '\n');
    });
  }

  /** Extract structuredContent from a call response, or throw on error. */
  static sc(resp) {
    assert.ok(!resp.error, `JSON-RPC error: ${JSON.stringify(resp.error)}`);
    const r = resp.result ?? {};
    assert.ok(!r.isError,
      `tool error: ${(r.content ?? [])[0]?.text ?? '?'}`);
    return r.structuredContent ?? r;
  }

  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    return new Promise(resolve => {
      this._proc.stdin.end();
      this._proc.on('close', resolve);
      setTimeout(() => { this._proc.kill(); resolve(); }, 3000);
    });
  }
}

// ---------------------------------------------------------------------------
// Async helper (spawn-based, for concurrency tests)
// ---------------------------------------------------------------------------

/**
 * Send requests to a single long-running boxsh --rpc process via stdin,
 * collecting all response lines asynchronously.
 * @param {object[]} requests
 * @param {{ workers?: number, timeout_ms?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export function rpcConcurrent(requests, { workers = 4, timeout_ms = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BOXSH, ['--rpc', '--workers', String(workers)]);
    const responses = [];
    const rl = createInterface({ input: proc.stdout });

    rl.on('line', line => {
      if (line.trim()) responses.push(fromJsonRpc(JSON.parse(line)));
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`rpcConcurrent timed out after ${timeout_ms}ms`));
    }, timeout_ms);

    proc.on('close', () => {
      clearTimeout(timer);
      resolve(responses);
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    for (const req of requests) {
      proc.stdin.write(JSON.stringify(toJsonRpc(req)) + '\n');
    }
    proc.stdin.end();
  });
}
