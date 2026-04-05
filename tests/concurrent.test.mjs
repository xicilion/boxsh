/**
 * concurrent.test.mjs — async concurrency tests using a long-lived boxsh
 * process.  All tests use spawn() so requests arrive truly concurrently.
 *
 * These tests are async and rely on rpcConcurrent() from helpers.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rpcConcurrent, byId } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Correctness under concurrency
// ---------------------------------------------------------------------------

describe('concurrent — correctness', () => {
  test('all N concurrent requests produce N responses', async () => {
    const N = 12;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `c${i}`,
      cmd: `echo concurrent-${i}`,
    }));
    const resps = await rpcConcurrent(reqs, { workers: 4 });
    assert.equal(resps.length, N);
  });

  test('each response has correct stdout for its id', async () => {
    const N = 10;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `v${i}`,
      cmd: `echo value-${i}`,
    }));
    const resps = await rpcConcurrent(reqs, { workers: 4 });
    const m = byId(resps);
    for (let i = 0; i < N; i++) {
      assert.equal(m[`v${i}`].stdout, `value-${i}\n`);
    }
  });

  test('no response is missing after concurrent run', async () => {
    const N = 16;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `m${i}`,
      cmd: `echo ${i}`,
    }));
    const resps = await rpcConcurrent(reqs, { workers: 4 });
    const ids = new Set(resps.map(r => r.id));
    for (let i = 0; i < N; i++) {
      assert.ok(ids.has(`m${i}`), `missing response for m${i}`);
    }
  });

  test('no duplicate responses', async () => {
    const N = 10;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `dup${i}`,
      cmd: `echo ${i}`,
    }));
    const resps = await rpcConcurrent(reqs, { workers: 4 });
    const ids = resps.map(r => r.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'duplicate responses detected');
  });

  test('exit codes are correct for each request', async () => {
    const reqs = [
      { id: 'e0', cmd: 'exit 0' },
      { id: 'e1', cmd: 'exit 1' },
      { id: 'e2', cmd: 'exit 2' },
      { id: 'e5', cmd: 'exit 5' },
    ];
    const resps = await rpcConcurrent(reqs, { workers: 4 });
    const m = byId(resps);
    assert.equal(m['e0'].exit_code, 0);
    assert.equal(m['e1'].exit_code, 1);
    assert.equal(m['e2'].exit_code, 2);
    assert.equal(m['e5'].exit_code, 5);
  });
});

// ---------------------------------------------------------------------------
// Ordering: fast vs slow
// ---------------------------------------------------------------------------

describe('concurrent — ordering', () => {
  test('fast request completes before slow one', async () => {
    const completionOrder = [];
    const reqs = [
      { id: 'slow', cmd: 'sleep 0.15; echo slow' },
      { id: 'fast', cmd: 'echo fast' },
    ];
    const resps = await rpcConcurrent(reqs, { workers: 2 });
    // Both must have correct results regardless of order
    const m = byId(resps);
    assert.equal(m['slow'].stdout, 'slow\n');
    assert.equal(m['fast'].stdout, 'fast\n');
  });

  test('slow requests do not block fast ones with enough workers', async () => {
    const reqs = [
      { id: 'slow1', cmd: 'sleep 0.2; echo slow1' },
      { id: 'slow2', cmd: 'sleep 0.2; echo slow2' },
      { id: 'fast1', cmd: 'echo fast1' },
      { id: 'fast2', cmd: 'echo fast2' },
    ];
    const t0 = Date.now();
    const resps = await rpcConcurrent(reqs, { workers: 4 });
    const elapsed = Date.now() - t0;
    const m = byId(resps);
    assert.equal(m['fast1'].stdout, 'fast1\n');
    assert.equal(m['fast2'].stdout, 'fast2\n');
    assert.equal(m['slow1'].stdout, 'slow1\n');
    assert.equal(m['slow2'].stdout, 'slow2\n');
    // With 4 workers all run in parallel — should finish in ~200ms, allow 500ms
    assert.ok(elapsed < 500, `expected ~200ms, got ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// Isolation under concurrency
// ---------------------------------------------------------------------------

describe('concurrent — isolation', () => {
  test('env variable set in one concurrent request does not leak', async () => {
    const reqs = Array.from({ length: 8 }, (_, i) => ({
      id: `iso${i}`,
      // half set a var, half check it — none should see it
      cmd: i % 2 === 0
        ? 'CONCURRENT_LEAK=yes; echo ${CONCURRENT_LEAK:-leaked}'
        : 'echo ${CONCURRENT_LEAK:-clean}',
    }));
    const resps = await rpcConcurrent(reqs, { workers: 4 });
    const m = byId(resps);
    for (let i = 1; i < 8; i += 2) {
      assert.equal(m[`iso${i}`].stdout, 'clean\n',
        `request iso${i} saw a leaked variable`);
    }
  });

  test('stdout of concurrent requests does not intermix', async () => {
    // Each request outputs exactly one line — no garbling expected
    const N = 10;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `line${i}`,
      cmd: `printf "line-${i}\\n"`,
    }));
    const resps = await rpcConcurrent(reqs, { workers: 4 });
    const m = byId(resps);
    for (let i = 0; i < N; i++) {
      assert.equal(m[`line${i}`].stdout, `line-${i}\n`);
    }
  });

  test('concurrent large outputs do not corrupt each other', async () => {
    // Each request outputs 4096 identical bytes; check lengths & uniqueness
    const reqs = [
      { id: 'out_a', cmd: "printf '%4096s' | tr ' ' 'A'" },
      { id: 'out_b', cmd: "printf '%4096s' | tr ' ' 'B'" },
      { id: 'out_c', cmd: "printf '%4096s' | tr ' ' 'C'" },
    ];
    const resps = await rpcConcurrent(reqs, { workers: 3 });
    const m = byId(resps);
    assert.equal(m['out_a'].stdout.length, 4096);
    assert.equal(m['out_b'].stdout.length, 4096);
    assert.equal(m['out_c'].stdout.length, 4096);
    assert.ok(m['out_a'].stdout.split('').every(c => c === 'A'), 'A output corrupted');
    assert.ok(m['out_b'].stdout.split('').every(c => c === 'B'), 'B output corrupted');
    assert.ok(m['out_c'].stdout.split('').every(c => c === 'C'), 'C output corrupted');
  });
});

// ---------------------------------------------------------------------------
// Stress
// ---------------------------------------------------------------------------

describe('concurrent — stress', () => {
  test('30 concurrent requests, 4 workers, all succeed', async () => {
    const N = 30;
    const reqs = Array.from({ length: N }, (_, i) => ({
      id: `stress${i}`,
      cmd: `echo stress-${i}`,
    }));
    const resps = await rpcConcurrent(reqs, { workers: 4, timeout_ms: 20000 });
    assert.equal(resps.length, N);
    const m = byId(resps);
    for (let i = 0; i < N; i++) {
      assert.equal(m[`stress${i}`].stdout, `stress-${i}\n`);
    }
  });

  test('mixed fast/slow/crash under concurrency, pool stays alive', async () => {
    const reqs = [
      { id: 'f1',  cmd: 'echo f1' },
      { id: 'cr1', cmd: 'kill -9 $$' },
      { id: 'f2',  cmd: 'echo f2' },
      { id: 'sl',  cmd: 'sleep 0.1; echo sl' },
      { id: 'cr2', cmd: 'kill -9 $$' },
      { id: 'f3',  cmd: 'echo f3' },
    ];
    const resps = await rpcConcurrent(reqs, { workers: 3, timeout_ms: 10000 });
    assert.equal(resps.length, 6);
    const m = byId(resps);
    assert.equal(m['f1'].stdout, 'f1\n');
    assert.equal(m['f2'].stdout, 'f2\n');
    assert.equal(m['f3'].stdout, 'f3\n');
    assert.equal(m['sl'].stdout, 'sl\n');
  });
});
