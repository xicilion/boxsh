/**
 * docker-root-reject.test.mjs — root containers must be rejected.
 *
 * Rootful Docker runs the container's real root as the host's root, so a
 * sandbox left as root would have no isolation (system files writable, RW
 * bind mounts would accept root-owned setuid binaries that persist on the
 * host).  boxsh therefore refuses EVERY sandbox request in a root container
 * with an actionable error — before any namespace syscall, so no special
 * container privileges are needed to observe the refusal.  Non-sandbox
 * shells keep working.
 *
 * This is the regression contract that replaced the auto-drop privilege
 * machinery (docker-vuln.test.mjs): the sandbox process can never be root,
 * so it can never plant root-owned files or write root-owned system state —
 * not because the drop is correct, but because the run is refused outright.
 *
 * Run by tests/docker-test.sh in a ROOT container (no --cap-add, no --user).
 * The whole file skips unless running as uid 0 inside a container.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run } from './helpers.mjs';

// --- container + root detection (mirrors src/sandbox.cpp) ------------------

const IN_CONTAINER =
  fs.existsSync('/.dockerenv') ||
  (fs.existsSync('/proc/1/cgroup') &&
    fs.readFileSync('/proc/1/cgroup', 'utf8').split('\n')
      .some(l => l.includes('docker') || l.includes('containerd') || l.includes('kubepods')));

const skip = !IN_CONTAINER && 'not running inside a container — root-rejection tests run in the separate docker-test CI job';
const skipNotRoot = process.getuid?.() !== 0 &&
  'not uid 0 — run this file in a ROOT container (no --user)';

describe('docker — root containers are rejected', { skip }, () => {
  test('--sandbox refuses with an actionable error before any engine runs',
    { skip: skipNotRoot }, () => {
      const r = run(['--sandbox', '--bind', 'wr:/src', '-c', 'echo ran'],
        '', 10000);
      assert.notEqual(r.status, 0,
        `expected refusal, got exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('must run as a non-root user'),
        `expected non-root-user error, got:\nstderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('--user'),
        `expected actionable --user hint, got:\nstderr: ${r.stderr}`);
      // Fail closed: the command must never run, and the engine must never
      // start (no root sandbox, not even a silent attempt).
      assert.ok(!r.stdout.includes('ran'),
        'command ran despite the root-container refusal');
      assert.ok(!r.stderr.includes('host-equivalent userns engine'),
        'engine started despite the root-container refusal');
    });

  test('--rpc --sandbox refuses before the RPC loop starts',
    { skip: skipNotRoot }, () => {
      const input = JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo rpc-ran' } } }) + '\n';
      const r = run(['--rpc', '--workers', '1', '--sandbox'], input, 10000);
      assert.notEqual(r.status, 0,
        `expected refusal, got exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      // Refusal happens before the RPC loop → no JSON-RPC output at all.
      assert.equal(r.stdout.trim(), '',
        `expected no RPC output on refusal, got: ${r.stdout}`);
      assert.ok(r.stderr.includes('must run as a non-root user'),
        `expected non-root-user error, got:\nstderr: ${r.stderr}`);
    });

  test('--try refuses as well (no sandboxed shell on the cwd)',
    { skip: skipNotRoot }, () => {
      const r = run(['--try', '-c', 'echo ran'], '', 10000);
      assert.notEqual(r.status, 0,
        `expected refusal, got exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.ok(r.stderr.includes('must run as a non-root user'),
        `expected non-root-user error, got:\nstderr: ${r.stderr}`);
      assert.ok(!r.stdout.includes('ran'),
        'command ran despite the root-container refusal');
    });

  test('non-sandbox shells still work in a root container',
    { skip: skipNotRoot }, () => {
      // Only sandbox requests are refused — plain boxsh (dash) is unaffected.
      const r = run(['-c', 'echo plain-ok'], '', 10000);
      assert.equal(r.status, 0,
        `plain shell failed; stderr: ${r.stderr}`);
      assert.equal(r.stdout.trim(), 'plain-ok');
    });
});
