/**
 * helpers.mjs — shared utilities for all boxsh test files.
 *
 * Import with:
 *   import { run, rpc, rpcMany, rpcConcurrent, BOXSH } from './helpers.mjs';
 */

import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the boxsh binary. Override with BOXSH env-var. */
export const BOXSH =
  process.env.BOXSH ?? path.resolve(__dir, '../build/boxsh');

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
  const line = JSON.stringify(req) + '\n';
  const r = run(['--rpc', '--workers', String(workers)], line, timeout_ms);
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  const trimmed = r.stdout.trim();
  assert.ok(trimmed.length > 0, 'boxsh produced no stdout');
  return JSON.parse(trimmed);
}

/**
 * Run boxsh in --rpc mode with multiple requests (written all at once via stdin).
 * Returns array of parsed responses in arrival order.
 * @param {object[]} requests
 * @param {{ workers?: number, timeout_ms?: number }} [opts]
 * @returns {object[]}
 */
export function rpcMany(requests, { workers = 4, timeout_ms = 8000 } = {}) {
  const input = requests.map(r => JSON.stringify(r)).join('\n') + '\n';
  const r = run(['--rpc', '--workers', String(workers)], input, timeout_ms);
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  return r.stdout
    .trim()
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l));
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
      if (line.trim()) responses.push(JSON.parse(line));
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
      proc.stdin.write(JSON.stringify(req) + '\n');
    }
    proc.stdin.end();
  });
}
