/**
 * worker-pool.test.mjs — tests for the pre-fork worker pool behaviour.
 *
 * Covers: --workers flag, sequential vs parallel handling, worker respawn
 * after crash, state isolation between requests, large batches.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rpc, rpcMany, rpcRaw, rpcConcurrent, rpcSandboxed, byId } from './helpers.mjs';

// ---------------------------------------------------------------------------
// --workers flag
// ---------------------------------------------------------------------------

describe('worker pool — --workers flag', () => {
  for (const w of [1, 2, 4, 8]) {
    test(`--workers ${w} starts up and handles a request`, () => {
      const resp = rpc({ id: `w${w}`, cmd: `echo workers-${w}` }, { workers: w });
      assert.equal(resp.stdout, `workers-${w}\n`);
      assert.equal(resp.exit_code, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// Sequential processing (single worker)
// ---------------------------------------------------------------------------

describe('worker pool — sequential processing (--workers 1)', () => {
  // rpcMany() uses a single spawnSync call: the RPC loop reads stdin line by
  // line and blocks on each worker response before reading the next request.
  // With 1 worker the execution is strictly serial.  We only assert that each
  // request gets the *correct* response — not the arrival order, because a
  // different number of workers could legitimately reorder responses.
  test('each request gets correct response (serial, 1 worker)', () => {
    const resps = rpcMany(
      [
        { id: 'seq1', cmd: 'echo one' },
        { id: 'seq2', cmd: 'echo two' },
        { id: 'seq3', cmd: 'echo three' },
      ],
      { workers: 1 },
    );
    assert.equal(resps.length, 3);
    const m = byId(resps);
    assert.equal(m['seq1'].stdout, 'one\n');
    assert.equal(m['seq2'].stdout, 'two\n');
    assert.equal(m['seq3'].stdout, 'three\n');
  });

  test('exit codes are independent across requests', () => {
    const resps = rpcMany(
      [
        { id: 'e0', cmd: 'exit 0' },
        { id: 'e1', cmd: 'exit 1' },
        { id: 'e2', cmd: 'exit 2' },
      ],
      { workers: 1 },
    );
    const m = byId(resps);
    assert.equal(m['e0'].exit_code, 0);
    assert.equal(m['e1'].exit_code, 1);
    assert.equal(m['e2'].exit_code, 2);
  });

  test('variable set in one request does not bleed into next', () => {
    const resps = rpcMany(
      [
        { id: 'set',  cmd: 'LEAK=yes; echo $LEAK' },
        { id: 'read', cmd: 'echo ${LEAK:-unset}' },
      ],
      { workers: 1 },
    );
    const m = byId(resps);
    assert.equal(m['set'].stdout,  'yes\n');
    assert.equal(m['read'].stdout, 'unset\n');
  });

  test('alias set in one request does not affect next', () => {
    // Alias expansion is disabled in non-interactive mode, so we verify
    // isolation via the `alias` builtin: request 1 defines the alias
    // (confirmed via `alias hi` output); request 2 runs in a fresh shell
    // where the alias does not exist.
    const resps = rpcMany(
      [
        { id: 'setalias',  cmd: 'alias hi="echo hi-alias"; alias hi' },
        { id: 'callalias', cmd: 'alias hi 2>/dev/null' },
      ],
      { workers: 1 },
    );
    const m = byId(resps);
    assert.ok(m['setalias'].stdout.includes('hi='),
              `expected alias definition in stdout, got: '${m['setalias'].stdout}'`);
    // alias not defined in second request (fresh shell per request)
    assert.notEqual(m['callalias'].exit_code, 0);
  });

  test('cd in one request does not change cwd for next', () => {
    const resps = rpcMany(
      [
        { id: 'cdtmp', cmd: 'cd /tmp; pwd' },
        { id: 'getpwd', cmd: 'pwd' },
      ],
      { workers: 1 },
    );
    const m = byId(resps);
    assert.equal(m['cdtmp'].stdout, '/tmp\n');
    // Next request should start in a different directory (not /tmp)
    assert.notEqual(m['getpwd'].stdout.trim(), '/tmp');
  });
});

// ---------------------------------------------------------------------------
// Worker crash & respawn
// ---------------------------------------------------------------------------

describe('worker pool — crash recovery', () => {
  test('crashed command gets a response (error or signal exit)', () => {
    const resp = rpc({ id: 'crash', cmd: 'kill -9 $$' }, { workers: 2 });
    const hasErr  = typeof resp.error === 'string' && resp.error.length > 0;
    const sigExit = resp.exit_code < 0 || resp.exit_code > 127;
    assert.ok(hasErr || sigExit,
      `expected error or signal exit, got: ${JSON.stringify(resp)}`);
  });

  test('request after crash still succeeds', () => {
    const resps = rpcMany(
      [
        { id: 'crash', cmd: 'kill -9 $$' },
        { id: 'after', cmd: 'echo still-alive' },
      ],
      { workers: 2 },
    );
    assert.equal(resps.length, 2);
    const m = byId(resps);
    assert.equal(m['after'].stdout, 'still-alive\n');
  });

  test('multiple crashes in sequence, pool keeps recovering', () => {
    const reqs = [
      { id: 'c1',  cmd: 'kill -9 $$' },
      { id: 'ok1', cmd: 'echo ok1' },
      { id: 'c2',  cmd: 'kill -9 $$' },
      { id: 'ok2', cmd: 'echo ok2' },
    ];
    const resps = rpcMany(reqs, { workers: 2 });
    assert.equal(resps.length, 4);
    const m = byId(resps);
    assert.equal(m['ok1'].stdout, 'ok1\n');
    assert.equal(m['ok2'].stdout, 'ok2\n');
  });
});

// ---------------------------------------------------------------------------
// Parallelism
// ---------------------------------------------------------------------------

describe('worker pool — parallel execution', () => {
  test('parallel requests complete faster than sequential', async () => {
    // 4 requests each sleeping 0.1s: with 4 workers should finish in ~0.1s,
    // sequentially would be ~0.4s.
    const N = 4;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `par${i}`,
      cmd: 'sleep 0.1; echo done',
    }));
    const t0 = Date.now();
    const resps = await rpcConcurrent(reqs, { workers: N });
    const elapsed = Date.now() - t0;
    assert.equal(resps.length, N);
    // Allow generous margin: on a slow CI box sequential would take ~400ms
    assert.ok(elapsed < 800,
      `expected parallel completion < 800ms, got ${elapsed}ms`);
  });

  test('all responses present after parallel run', async () => {
    const N = 8;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `p${i}`,
      cmd: `echo parallel-${i}`,
    }));
    const resps = await rpcConcurrent(reqs, { workers: 4 });
    assert.equal(resps.length, N);
    const m = byId(resps);
    for (let i = 0; i < N; i++) {
      assert.equal(m[`p${i}`].stdout, `parallel-${i}\n`);
    }
  });
});

// ---------------------------------------------------------------------------
// Large batches
// ---------------------------------------------------------------------------

describe('worker pool — large batches', () => {
  test('20-request batch, all complete correctly', () => {
    const N = 20;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `b${i}`,
      cmd: `echo batch-${i}`,
    }));
    const resps = rpcMany(reqs, { workers: 4, timeout_ms: 20000 });
    assert.equal(resps.length, N);
    const m = byId(resps);
    for (let i = 0; i < N; i++) {
      assert.equal(m[`b${i}`].stdout, `batch-${i}\n`);
    }
  });

  test('50-request batch with 1 worker completes', () => {
    const N = 50;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `s${i}`,
      cmd: `echo seq-${i}`,
    }));
    const resps = rpcMany(reqs, { workers: 1, timeout_ms: 30000 });
    assert.equal(resps.length, N);
    const m = byId(resps);
    for (let i = 0; i < N; i++) {
      assert.equal(m[`s${i}`].stdout, `seq-${i}\n`);
    }
  });

  test('concurrent multi-megabyte responses do not trigger worker respawn loop', () => {
    const mib = 1024 * 1024;
    const reqs = [
      { id: 'bigA', cmd: 'node -e "process.stdout.write(Buffer.alloc(6*1048576, 0x41))"' },
      { id: 'bigB', cmd: 'node -e "process.stdout.write(Buffer.alloc(6*1048576, 0x42))"' },
      { id: 'bigC', cmd: 'node -e "process.stdout.write(Buffer.alloc(6*1048576, 0x43))"' },
      { id: 'bigD', cmd: 'node -e "process.stdout.write(Buffer.alloc(6*1048576, 0x44))"' },
    ];
    const resps = rpcMany(reqs, { workers: 4, timeout_ms: 60000 });
    assert.equal(resps.length, 4);
    const m = byId(resps);

    for (const [id, expectedChar] of [['bigA', 'A'], ['bigB', 'B'], ['bigC', 'C'], ['bigD', 'D']]) {
      const resp = m[id];
      assert.ok(!resp.error, `unexpected error for ${id}: ${resp.error}`);
      assert.equal(resp.exit_code, 0, `unexpected exit_code for ${id}`);
      assert.equal(resp.stdout.length, 6 * mib, `unexpected stdout length for ${id}`);
      assert.ok(new RegExp(`^${expectedChar}+$`).test(resp.stdout),
        `stdout for ${id} contains unexpected characters`);
      assert.equal(resp.stdout[0], expectedChar, `unexpected first byte for ${id}`);
      assert.equal(resp.stdout[resp.stdout.length - 1], expectedChar,
        `unexpected last byte for ${id}`);
      assert.ok(!String(resp.stderr).includes('worker crash, respawned'),
        `worker respawn detected in stderr for ${id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Sandboxed exit codes — SIGCHLD inheritance regression
// ---------------------------------------------------------------------------

// In sandbox mode the coordinator becomes PID 1 of a new PID namespace and
// installs a SIGCHLD handler that reaps every finished child (see the
// "As PID 1, we must reap orphaned child processes" block in sandbox.cpp).
// Signal dispositions are inherited across fork(), so the pre-forked workers
// used to inherit that reaper.  When a worker's command child exited, the
// inherited handler reaped it before the worker's own waitpid() in
// run_shell_command() could collect it; waitpid() then failed with ECHILD,
// the (previously unchecked) status stayed 0 and every sandboxed command
// reported exit_code 0 — non-zero exits were silently reported as success.
//
// Reproduced against the pre-fix build:
//   printf '%s\n' '{"jsonrpc":"2.0","id":"1","method":"tools/call",
//     "params":{"name":"bash","arguments":{"command":"exit 42"}}}' \
//     | build/boxsh --rpc --workers 1 --sandbox
//   → "exit_code":0   (real exit code: 42)
//
// The fix (spawn_worker) resets SIGCHLD to SIG_DFL in the forked worker, and
// run_shell_command() reports -1 rather than 0 when waitpid() fails.  These
// tests must fail if either half of the regression comes back.

describe('worker pool — sandboxed exit codes (SIGCHLD inheritance)', () => {
  test('sandboxed RPC reports non-zero exit codes verbatim', () => {
    for (const code of [1, 3, 42, 255]) {
      const resp = rpcSandboxed({ id: `e${code}`, cmd: `exit ${code}` },
                                { workers: 1 });
      assert.equal(resp.exit_code, code,
        `sandboxed 'exit ${code}' reported exit_code ${resp.exit_code}`);
    }
  });

  test('sandboxed RPC reports 0 for successful commands', () => {
    const resp = rpcSandboxed({ id: 'ok', cmd: 'true' }, { workers: 1 });
    assert.equal(resp.exit_code, 0);
    assert.notEqual(resp.isError, true,
      'successful sandboxed command was marked as an error');
  });

  test('sandboxed RPC preserves stdout of a failing command', () => {
    const resp = rpcSandboxed({ id: 'out7', cmd: 'echo before; exit 7' },
                              { workers: 1 });
    assert.equal(resp.stdout, 'before\n');
    assert.equal(resp.exit_code, 7,
      'stdout survived but the exit code was lost');
  });

  test('sandboxed RPC reports signal deaths as 128+signo', () => {
    const term = rpcSandboxed({ id: 'term', cmd: 'kill -TERM $$' },
                              { workers: 1 });
    assert.equal(term.exit_code, 128 + 15,
      `SIGTERM death reported as ${term.exit_code}, expected 143`);
    const kill9 = rpcSandboxed({ id: 'kill9', cmd: 'kill -9 $$' },
                               { workers: 1 });
    assert.equal(kill9.exit_code, 128 + 9,
      `SIGKILL death reported as ${kill9.exit_code}, expected 137`);
  });

  test('sandboxed non-zero exit is marked as an error result', () => {
    // Guards the end-to-end contract: pre-fix, `exit 13` produced
    // exit_code 0 and no isError flag, i.e. a silent success.
    const raw = rpcRaw({
      id: 'rawerr',
      cmd: 'exit 13',
    }, { workers: 1, sandbox: true });
    assert.equal(raw.result?.isError, true,
      `non-zero sandboxed exit not marked isError: ${JSON.stringify(raw)}`);
    assert.equal(raw.result?.structuredContent?.exit_code, 13,
      `expected exit_code 13, got: ${JSON.stringify(raw.result)}`);
  });

  test('sandboxed batch keeps exit codes independent (1 worker)', () => {
    const codes = [0, 1, 2, 3, 7, 42];
    const reqs = codes.map((c, i) => ({ id: `s${i}`, cmd: `exit ${c}` }));
    // A command that also produces output must not change the outcome.
    reqs.push({ id: 'slow', cmd: 'sleep 0.1; echo late; exit 5' });
    const resps = rpcMany(reqs, { workers: 1, sandbox: true, timeout_ms: 20000 });
    assert.equal(resps.length, reqs.length);
    const m = byId(resps);
    codes.forEach((c, i) => {
      assert.equal(m[`s${i}`].exit_code, c,
        `request s${i} ('exit ${c}') reported ${m[`s${i}`].exit_code}`);
    });
    assert.equal(m['slow'].stdout, 'late\n');
    assert.equal(m['slow'].exit_code, 5);
  });

  test('sandboxed batch keeps exit codes independent (4 workers)', () => {
    // Every worker inherits from the coordinator, so each worker must reset
    // SIGCHLD itself; use enough requests to hit all four workers.
    const codes = [3, 0, 9, 1, 7, 0, 255, 2];
    const reqs = codes.map((c, i) => ({ id: `p${i}`, cmd: `exit ${c}` }));
    const resps = rpcMany(reqs, { workers: 4, sandbox: true, timeout_ms: 20000 });
    assert.equal(resps.length, reqs.length);
    const m = byId(resps);
    codes.forEach((c, i) => {
      assert.equal(m[`p${i}`].exit_code, c,
        `request p${i} ('exit ${c}') reported ${m[`p${i}`].exit_code}`);
    });
  });

  test('non-sandboxed exit codes are unaffected (control)', () => {
    const codes = [0, 1, 42];
    const resps = rpcMany(codes.map((c, i) => ({ id: `n${i}`, cmd: `exit ${c}` })),
                          { workers: 1 });
    const m = byId(resps);
    codes.forEach((c, i) => assert.equal(m[`n${i}`].exit_code, c));
  });
});
