/**
 * rpc-basics.test.mjs — tests for the JSON-line RPC protocol layer.
 *
 * Covers: request/response structure, field semantics, protocol robustness,
 * JSON encoding correctness, and CLI flags.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run, rpc, rpcMany, byId, toJsonRpc, fromJsonRpc } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe('rpc — response shape', () => {
  test('response is a single JSON line (no trailing spaces)', () => {
    const r = run(['--rpc', '--workers', '1'],
      JSON.stringify(toJsonRpc({ id: 't', cmd: 'true' })) + '\n');
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  });

  test('response object has required fields', () => {
    const resp = rpc({ id: 'shape', cmd: 'true' });
    assert.ok('id'          in resp, 'missing id');
    assert.ok('exit_code'   in resp, 'missing exit_code');
    assert.ok('stdout'      in resp, 'missing stdout');
    assert.ok('stderr'      in resp, 'missing stderr');
    assert.ok('duration_ms' in resp, 'missing duration_ms');
  });

  test('id field is a string', () => {
    const resp = rpc({ id: 'str-check', cmd: 'true' });
    assert.equal(typeof resp.id, 'string');
  });

  test('exit_code field is a number', () => {
    const resp = rpc({ id: 't', cmd: 'true' });
    assert.equal(typeof resp.exit_code, 'number');
  });

  test('stdout and stderr fields are strings', () => {
    const resp = rpc({ id: 't', cmd: 'true' });
    assert.equal(typeof resp.stdout, 'string');
    assert.equal(typeof resp.stderr, 'string');
  });

  test('duration_ms field is a non-negative number', () => {
    const resp = rpc({ id: 't', cmd: 'true' });
    assert.equal(typeof resp.duration_ms, 'number');
    assert.ok(resp.duration_ms >= 0);
  });

  test('no extra top-level fields on success', () => {
    const resp = rpc({ id: 't', cmd: 'true' });
    const allowed = new Set(['id', 'exit_code', 'stdout', 'stderr', 'duration_ms', 'content']);
    for (const k of Object.keys(resp)) {
      assert.ok(allowed.has(k), `unexpected field: ${k}`);
    }
  });

  test('error field present on dispatch failure, absent on success', () => {
    const ok  = rpc({ id: 'ok',  cmd: 'true' });
    const bad = rpc({ id: 'bad', foo: 'no-cmd' });
    assert.ok(!('error' in ok),   'error field should be absent on success');
    assert.ok('error' in bad,     'error field should be present on parse failure');
    assert.equal(typeof bad.error, 'string');
  });
});

// ---------------------------------------------------------------------------
// id field
// ---------------------------------------------------------------------------

describe('rpc — id field', () => {
  test('id is echoed back verbatim', () => {
    const id = 'my-unique-id-99';
    assert.equal(rpc({ id, cmd: 'true' }).id, id);
  });

  test('numeric-looking id is returned as string', () => {
    const resp = rpc({ id: '12345', cmd: 'true' });
    assert.equal(resp.id, '12345');
    assert.equal(typeof resp.id, 'string');
  });

  test('missing id returns empty string', () => {
    assert.equal(rpc({ cmd: 'true' }).id, '');
  });

  test('id with special characters is preserved', () => {
    const id = 'req/test:001#a';
    assert.equal(rpc({ id, cmd: 'true' }).id, id);
  });

  test('long id is preserved', () => {
    const id = 'x'.repeat(200);
    assert.equal(rpc({ id, cmd: 'true' }).id, id);
  });
});

// ---------------------------------------------------------------------------
// exit_code field
// ---------------------------------------------------------------------------

describe('rpc — exit_code', () => {
  for (const code of [0, 1, 2, 5, 42, 126, 127]) {
    test(`exit_code ${code}`, () => {
      assert.equal(rpc({ id: `ec${code}`, cmd: `exit ${code}` }).exit_code, code);
    });
  }

  test('exit_code from last command in sequence', () => {
    assert.equal(rpc({ id: 't', cmd: 'true; false' }).exit_code, 1);
    assert.equal(rpc({ id: 't', cmd: 'false; true' }).exit_code, 0);
  });

  test('pipeline exit_code is from last stage', () => {
    assert.equal(rpc({ id: 't', cmd: 'true | false' }).exit_code, 1);
  });
});

// ---------------------------------------------------------------------------
// stdout / stderr capture
// ---------------------------------------------------------------------------

describe('rpc — stdout/stderr capture', () => {
  test('stdout captured', () => {
    assert.equal(rpc({ id: 't', cmd: 'echo captured' }).stdout, 'captured\n');
  });

  test('stderr captured', () => {
    const resp = rpc({ id: 't', cmd: 'echo err >&2' });
    assert.equal(resp.stdout, '');
    assert.equal(resp.stderr, 'err\n');
  });

  test('stdout and stderr are independent', () => {
    const resp = rpc({ id: 't', cmd: 'echo OUT; echo ERR >&2' });
    assert.equal(resp.stdout, 'OUT\n');
    assert.equal(resp.stderr, 'ERR\n');
  });

  test('stdout with multiple lines', () => {
    const resp = rpc({ id: 't', cmd: 'printf "a\\nb\\nc\\n"' });
    assert.equal(resp.stdout, 'a\nb\nc\n');
  });

  test('stdout with no trailing newline', () => {
    const resp = rpc({ id: 't', cmd: 'printf "no-newline"' });
    assert.equal(resp.stdout, 'no-newline');
  });

  test('empty stdout and stderr on true', () => {
    const resp = rpc({ id: 't', cmd: 'true' });
    assert.equal(resp.stdout, '');
    assert.equal(resp.stderr, '');
  });

  test('stdout with special characters is JSON-safe', () => {
    const resp = rpc({ id: 't', cmd: 'printf \'"hello"\\t\\\\world\\n\'' });
    assert.equal(resp.stdout, '"hello"\t\\world\n');
  });

  test('stdout with unicode is preserved', () => {
    const resp = rpc({ id: 't', cmd: 'printf "héllo wörld\\n"' });
    assert.equal(resp.stdout, 'héllo wörld\n');
  });

  test('large stdout (64 KB) is captured completely', () => {
    // Generate exactly 65536 'A' chars + newline via shell
    const resp = rpc(
      { id: 't', cmd: 'dd if=/dev/zero bs=65536 count=1 2>/dev/null | tr "\\0" A' },
      { timeout_ms: 8000 },
    );
    assert.equal(resp.exit_code, 0);
    assert.equal(resp.stdout.length, 65536);
    assert.ok(resp.stdout.split('').every(c => c === 'A'));
  });
});

// ---------------------------------------------------------------------------
// duration_ms accuracy
// ---------------------------------------------------------------------------

describe('rpc — duration_ms', () => {
  test('near-instant command has low duration', () => {
    const resp = rpc({ id: 't', cmd: 'true' });
    assert.ok(resp.duration_ms < 500, `duration_ms too high: ${resp.duration_ms}`);
  });

  test('sleep 0.1 duration >= 90ms', () => {
    const resp = rpc({ id: 't', cmd: 'sleep 0.1' }, { timeout_ms: 3000 });
    assert.ok(resp.duration_ms >= 90,
      `expected >= 90ms, got ${resp.duration_ms}`);
  });

  test('sleep 0.1 duration < 500ms (no excessive overhead)', () => {
    const resp = rpc({ id: 't', cmd: 'sleep 0.1' }, { timeout_ms: 3000 });
    assert.ok(resp.duration_ms < 500,
      `unexpectedly long: ${resp.duration_ms}ms`);
  });
});

// ---------------------------------------------------------------------------
// Protocol robustness
// ---------------------------------------------------------------------------

describe('rpc — protocol robustness', () => {
  test('invalid JSON → error response (no crash)', () => {
    const r = run(['--rpc', '--workers', '1'], 'not json at all\n');
    const resp = JSON.parse(r.stdout.trim());
    assert.ok(resp.error?.message?.includes('parse_error'));
  });

  test('JSON array (not object) → error response', () => {
    const r = run(['--rpc', '--workers', '1'], '[1,2,3]\n');
    const resp = JSON.parse(r.stdout.trim());
    assert.ok(typeof resp.error?.message === 'string' && resp.error.message.length > 0);
  });

  test('missing method field → error response', () => {
    const resp = rpc({ id: 'x', foo: 'bar' });
    assert.ok(resp.error?.includes('parse_error'));
  });

  test('cmd with non-string value → error response', () => {
    const r = run(['--rpc', '--workers', '1'],
      JSON.stringify({ jsonrpc: '2.0', id: 't', method: 'exec', params: { cmd: 42 } }) + '\n');
    const resp = JSON.parse(r.stdout.trim());
    assert.ok(typeof resp.error?.message === 'string' && resp.error.message.length > 0);
  });

  test('blank lines between requests are skipped', () => {
    const input = '\n\n' + JSON.stringify(toJsonRpc({ id: 'skip', cmd: 'echo ok' })) + '\n\n';
    const r = run(['--rpc', '--workers', '1'], input);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(fromJsonRpc(JSON.parse(lines[0])).stdout, 'ok\n');
  });

  test('multiple requests → one response per request', () => {
    const resps = rpcMany([
      { id: 'a', cmd: 'echo A' },
      { id: 'b', cmd: 'echo B' },
      { id: 'c', cmd: 'echo C' },
    ]);
    assert.equal(resps.length, 3);
  });

  test('valid request after invalid one is still processed', () => {
    const input = 'BAD JSON\n' + JSON.stringify(toJsonRpc({ id: 'good', cmd: 'echo ok' })) + '\n';
    const r = run(['--rpc', '--workers', '1'], input);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const parsed = lines.map(l => fromJsonRpc(JSON.parse(l)));
    const good = parsed.find(p => p.id === 'good');
    assert.ok(good, 'good request should still be processed');
    assert.equal(good.stdout, 'ok\n');
  });

  test('EOF on stdin causes clean exit', () => {
    const r = run(['--rpc', '--workers', '1'], '');
    assert.equal(r.signal, null);
    assert.equal(r.status, 0);
  });
});

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

describe('rpc — CLI flags', () => {
  test('--help exits 0 and prints usage', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.ok(r.stderr.includes('Usage') || r.stderr.includes('usage') ||
              r.stdout.includes('Usage'));
  });

  test('--workers 1 is accepted', () => {
    const resp = rpc({ id: 't', cmd: 'echo w1' }, { workers: 1 });
    assert.equal(resp.stdout, 'w1\n');
  });

  test('--workers 8 starts and processes requests', () => {
    const resp = rpc({ id: 't', cmd: 'echo w8' }, { workers: 8 });
    assert.equal(resp.stdout, 'w8\n');
  });

  test('--shell /bin/sh is accepted', () => {
    const r = run(['--rpc', '--workers', '1', '--shell', '/bin/sh'],
      JSON.stringify(toJsonRpc({ id: 't', cmd: 'echo custom-shell' })) + '\n');
    const resp = fromJsonRpc(JSON.parse(r.stdout.trim()));
    assert.equal(resp.stdout, 'custom-shell\n');
  });
});
