/**
 * timeout.test.mjs — tests for the per-request timeout field.
 *
 * The "timeout" JSON field is forwarded to the worker, which uses alarm(2)
 * to kill the grandchild shell.  When the alarm fires, the worker process
 * itself receives SIGALRM and dies; the coordinator detects the crash via
 * POLLHUP and responds with an error, then respawns the worker.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rpc, rpcMany, byId } from './helpers.mjs';

// Helper: assert a response indicates a timeout/crash (not a successful run)
function assertTimedOut(resp) {
  const hasError    = typeof resp.error === 'string' && resp.error.length > 0;
  const signalExit  = resp.exit_code !== 0 && resp.stderr === 'timeout';
  const crashExit   = resp.exit_code < 0;
  assert.ok(hasError || signalExit || crashExit,
    `expected timeout indication, got: ${JSON.stringify(resp)}`);
}

// ---------------------------------------------------------------------------
// Basic timeout behaviour
// ---------------------------------------------------------------------------

describe('timeout — basic behaviour', () => {
  test('command completing within timeout succeeds', () => {
    // sleep 0.05 with timeout:2 — should succeed normally
    const resp = rpc(
      { id: 't', cmd: 'sleep 0.05; echo done', timeout: 2 },
      { timeout_ms: 4000 },
    );
    assert.equal(resp.exit_code, 0);
    assert.equal(resp.stdout, 'done\n');
  });

  test('command exceeding timeout returns error within deadline', () => {
    const start = Date.now();
    const resp  = rpc(
      { id: 't', cmd: 'sleep 30', timeout: 1 },
      { timeout_ms: 6000 },
    );
    const elapsed = Date.now() - start;
    assertTimedOut(resp);
    assert.ok(elapsed < 5000, `took too long: ${elapsed}ms`);
  });

  test('timeout:0 means no timeout — fast command still works', () => {
    const resp = rpc({ id: 't', cmd: 'echo no-timeout', timeout: 0 });
    assert.equal(resp.exit_code, 0);
    assert.equal(resp.stdout, 'no-timeout\n');
  });

  test('timeout field absent means no timeout', () => {
    const resp = rpc({ id: 't', cmd: 'echo fine' });
    assert.equal(resp.exit_code, 0);
    assert.equal(resp.stdout, 'fine\n');
  });
});

// ---------------------------------------------------------------------------
// Deadline accuracy
// ---------------------------------------------------------------------------

describe('timeout — deadline accuracy', () => {
  test('timeout:1 fires within ~2s wall clock', () => {
    const start   = Date.now();
    const resp    = rpc({ id: 't', cmd: 'sleep 60', timeout: 1 }, { timeout_ms: 8000 });
    const elapsed = Date.now() - start;
    assertTimedOut(resp);
    // Should fire well before 3s (1s alarm + coordinator grace)
    assert.ok(elapsed < 4000, `deadline not met: ${elapsed}ms`);
  });

  test('timeout:2 does not fire for sleep 1', () => {
    const resp = rpc(
      { id: 't', cmd: 'sleep 1; echo ok', timeout: 2 },
      { timeout_ms: 6000 },
    );
    assert.equal(resp.exit_code, 0);
    assert.equal(resp.stdout, 'ok\n');
  });
});

// ---------------------------------------------------------------------------
// Recovery after timeout
// ---------------------------------------------------------------------------

describe('timeout — recovery', () => {
  test('request after timeout still succeeds', () => {
    const resps = rpcMany(
      [
        { id: 'to',    cmd: 'sleep 30', timeout: 1 },
        { id: 'after', cmd: 'echo recovered' },
      ],
      { workers: 2, timeout_ms: 10000 },
    );
    assert.equal(resps.length, 2);
    const m = byId(resps);
    assertTimedOut(m['to']);
    assert.equal(m['after'].stdout, 'recovered\n');
  });

  test('multiple timeouts in a row, pool keeps working', () => {
    const resps = rpcMany(
      [
        { id: 'to1',  cmd: 'sleep 30', timeout: 1 },
        { id: 'ok1',  cmd: 'echo ok1' },
        { id: 'to2',  cmd: 'sleep 30', timeout: 1 },
        { id: 'ok2',  cmd: 'echo ok2' },
      ],
      { workers: 2, timeout_ms: 15000 },
    );
    assert.equal(resps.length, 4);
    const m = byId(resps);
    assertTimedOut(m['to1']);
    assertTimedOut(m['to2']);
    assert.equal(m['ok1'].stdout, 'ok1\n');
    assert.equal(m['ok2'].stdout, 'ok2\n');
  });

  test('non-timed-out requests run normally alongside timed-out ones', () => {
    const resps = rpcMany(
      [
        { id: 'fast', cmd: 'echo fast' },
        { id: 'to',   cmd: 'sleep 30', timeout: 1 },
        { id: 'slow', cmd: 'echo slow' },
      ],
      { workers: 3, timeout_ms: 10000 },
    );
    assert.equal(resps.length, 3);
    const m = byId(resps);
    assert.equal(m['fast'].stdout, 'fast\n');
    assert.equal(m['slow'].stdout, 'slow\n');
    assertTimedOut(m['to']);
  });
});

// ---------------------------------------------------------------------------
// Clean timeout path (worker must survive SIGALRM, grandchild must be killed)
// ---------------------------------------------------------------------------

describe('timeout — clean kill path', () => {
  test('timeout response has stderr=timeout and no crash error', () => {
    // When SIGALRM fires the poll() loop must catch EINTR and kill the
    // grandchild cleanly.  The worker process must NOT be killed by SIGALRM
    // (i.e. there should be no "worker crash" error in the response).
    const resp = rpc(
      { id: 't', cmd: 'sleep 30', timeout: 1 },
      { timeout_ms: 6000 },
    );
    assert.equal(resp.stderr, 'timeout', 'expected clean timeout stderr marker');
    assert.equal(resp.exit_code, -1, 'expected exit_code -1 for timeout');
    assert.ok(!resp.error, `expected no crash error, got: ${resp.error}`);
  });

  test('worker is still alive after timeout (no respawn)', () => {
    // After a clean timeout the worker should be ready for the next request
    // immediately (same worker, no crash/respawn round-trip).
    const resps = rpcMany(
      [
        { id: 'to',    cmd: 'sleep 30', timeout: 1 },
        { id: 'after', cmd: 'echo alive' },
      ],
      { workers: 1, timeout_ms: 8000 },
    );
    const m = byId(resps);
    assert.equal(m['to'].stderr, 'timeout');
    assert.ok(!m['to'].error, `worker should not have crashed: ${m['to'].error}`);
    assert.equal(m['after'].stdout, 'alive\n');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('timeout — edge cases', () => {
  test('timeout on a tight loop (CPU-bound) also terminates', () => {
    const start = Date.now();
    const resp  = rpc(
      { id: 't', cmd: 'while true; do :; done', timeout: 1 },
      { timeout_ms: 6000 },
    );
    const elapsed = Date.now() - start;
    assertTimedOut(resp);
    assert.ok(elapsed < 5000, `CPU loop not killed in time: ${elapsed}ms`);
  });

  test('command writing large output before timeout is killed cleanly', () => {
    // Output one line every 100 ms indefinitely — guarantees the 1-second
    // timeout fires before the command finishes on any machine, without
    // flooding the pipe with gigabytes of data.
    const start = Date.now();
    const resp  = rpc(
      { id: 't', cmd: 'while true; do echo x; sleep 0.1; done', timeout: 1 },
      { timeout_ms: 6000 },
    );
    const elapsed = Date.now() - start;
    assertTimedOut(resp);
    assert.ok(elapsed < 5000, `streaming kill took too long: ${elapsed}ms`);
  });
});
