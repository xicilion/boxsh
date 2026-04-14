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

const __dir = path.dirname(fileURLToPath(import.meta.url));

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
 * For tool execution errors (isError=true without structuredContent), extracts
 * the error text from content into r.error for backward compatibility.
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

  // Tool execution errors: isError=true, no structuredContent.
  if (result.isError && !structuredContent && Array.isArray(result.content)) {
    const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (text) flat.error = text;
  }

  return flat;
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
 * @param {{ workers?: number, timeout_ms?: number }} [opts]
 * @returns {object[]}
 */
export function rpcMany(requests, { workers = 4, timeout_ms = 8000 } = {}) {
  const input = requests.map(r => JSON.stringify(toJsonRpc(r))).join('\n') + '\n';
  const r = run(['--rpc', '--workers', String(workers)], input, timeout_ms);
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
