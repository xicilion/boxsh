/**
 * utf8-crash.test.mjs — reproduce nlohmann::json type_error.316 crash
 * when invalid UTF-8 bytes appear in request fields.
 *
 * The original crash:
 *   libc++abi: terminating due to uncaught exception of type
 *   nlohmann::json_abi_v3_11_3::detail::type_error:
 *   [json.exception.type_error.316] incomplete UTF-8 string; last byte: 0x81
 *
 * nlohmann::json accepts invalid UTF-8 during parse() but throws 316 during
 * dump().  Fields that get echoed back (id, or path in error messages) will
 * trigger the crash when the response is serialized.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BOXSH } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a raw JSON-RPC 2.0 request as a Buffer, with direct control over
 * every byte (no JSON.stringify escaping).
 */
function rawReq({ idBytes, method, params }) {
  // Build JSON manually so we can inject arbitrary bytes into string values.
  const parts = ['{"jsonrpc":"2.0"'];
  if (idBytes !== undefined) {
    parts.push(',"id":');
    parts.push(Buffer.isBuffer(idBytes) ? idBytes : Buffer.from(JSON.stringify(idBytes)));
  }
  if (method !== undefined) {
    parts.push(',"method":');
    parts.push(Buffer.from(JSON.stringify(method)));
  }
  if (params !== undefined) {
    parts.push(',"params":');
    parts.push(Buffer.isBuffer(params) ? params : Buffer.from(JSON.stringify(params)));
  }
  parts.push('}\n');
  return Buffer.concat(parts.map(b => Buffer.isBuffer(b) ? b : Buffer.from(b)));
}

/**
 * A single continuation byte 0x81 — invalid UTF-8 when it appears without a
 * preceding lead byte. This is the exact byte from the crash report.
 */
const BAD_UTF8 = Buffer.from([0x81]);

/**
 * Build a JSON string value with bad bytes injected inside.
 * Produces:  "prefix\x81suffix"  (with proper JSON quotes)
 */
function badString(prefix = '', suffix = '') {
  const pre = Buffer.from('"' + prefix);
  const post = Buffer.from(suffix + '"');
  return Buffer.concat([pre, BAD_UTF8, post]);
}

/**
 * Run boxsh --rpc and check it exits cleanly (no crash).
 * Returns { status, signal, stdout, stderr }.
 */
function runRaw(inputBuf, workers = 1) {
  return spawnSync(BOXSH, ['--rpc', '--workers', String(workers)], {
    input: inputBuf,
    timeout: 5000,
    encoding: 'buffer',  // return buffers so we can inspect raw output
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UTF-8 crash resilience', () => {
  // ── Scenario 1: invalid UTF-8 in request id ────────────────────────
  // The id is echoed back verbatim in every response via j["id"] = resp.id.
  // If the id string contains invalid UTF-8, dump() throws type_error.316.

  test('invalid UTF-8 in request id does not crash boxsh', () => {
    const req = rawReq({
      idBytes: badString('bad-id'),
      method: 'tools/list',  // quick protocol method, no worker needed
    });

    const r = runRaw(req);
    // Must not crash — no signal, process exits normally.
    assert.equal(r.signal, null,
      `boxsh crashed with signal ${r.signal}. stderr: ${r.stderr?.toString()}`);
    assert.ok(r.status !== null, 'boxsh exited normally');
  });

  // ── Scenario 2: invalid UTF-8 in bash command output ───────────────
  // Commands that emit binary output to stdout/stderr must not crash.

  test('binary stdout from bash command does not crash boxsh', () => {
    // printf emits raw bytes; \x81 is the invalid continuation byte.
    const req = rawReq({
      idBytes: Buffer.from('"ok-id"'),
      method: 'tools/call',
      params: Buffer.from(
        '{"name":"bash","arguments":{"command":"printf \'\\\\x81\'"}}'),
    });

    const r = runRaw(req);
    assert.equal(r.signal, null,
      `boxsh crashed with signal ${r.signal}. stderr: ${r.stderr?.toString()}`);
    assert.ok(r.status !== null, 'boxsh exited normally');

    // stdout should contain a valid JSON response (not truncated/corrupted).
    const outStr = r.stdout?.toString('utf8') || '';
    assert.ok(outStr.trim().length > 0, 'boxsh produced no stdout');
    // Should be parseable.
    assert.doesNotThrow(() => JSON.parse(outStr.trim()));
  });

  // ── Scenario 3: invalid UTF-8 in read tool path ────────────────────
  // The path appears in error messages, which go through
  // rpc_serialize_response → j.dump().

  test('invalid UTF-8 in read tool path does not crash boxsh', () => {
    const pathWithBadByte = badString('/nonexistent-');

    // Build the params JSON manually.
    const paramsParts = [
      Buffer.from('{"name":"read","arguments":{"path":'),
      pathWithBadByte,
      Buffer.from('}}'),
    ];
    const params = Buffer.concat(paramsParts);

    const req = rawReq({
      idBytes: Buffer.from('"ok"'),
      method: 'tools/call',
      params,
    });

    const r = runRaw(req);
    assert.equal(r.signal, null,
      `boxsh crashed with signal ${r.signal}. stderr: ${r.stderr?.toString()}`);
    assert.ok(r.status !== null, 'boxsh exited normally');

    const outStr = r.stdout?.toString('utf8') || '';
    assert.ok(outStr.trim().length > 0, 'boxsh produced no stdout');
    assert.doesNotThrow(() => JSON.parse(outStr.trim()));
  });

  // ── Scenario 4: invalid UTF-8 in write tool path ────────────────────
  // Same risk as read — path appears in error messages.

  test('invalid UTF-8 in write tool path does not crash boxsh', () => {
    const pathWithBadByte = badString('/readonly-dir/nonexistent-');

    const paramsParts = [
      Buffer.from('{"name":"write","arguments":{"path":'),
      pathWithBadByte,
      Buffer.from(',"content":"hello"}}'),
    ];
    const params = Buffer.concat(paramsParts);

    const req = rawReq({
      idBytes: Buffer.from('"ok"'),
      method: 'tools/call',
      params,
    });

    const r = runRaw(req);
    assert.equal(r.signal, null,
      `boxsh crashed with signal ${r.signal}. stderr: ${r.stderr?.toString()}`);
    assert.ok(r.status !== null, 'boxsh exited normally');

    const outStr = r.stdout?.toString('utf8') || '';
    assert.ok(outStr.trim().length > 0, 'boxsh produced no stdout');
    assert.doesNotThrow(() => JSON.parse(outStr.trim()));
  });

  // ── Scenario 5: invalid UTF-8 in bash tool error path ──────────────
  // When a bash command fails, the error text goes through
  // rpc_serialize_response.  E.g. when stderr contains binary garbage.

  test('binary stderr from failed bash command does not crash boxsh', () => {
    // Command that writes binary to stderr and exits non-zero.
    const req = rawReq({
      idBytes: Buffer.from('"ok-id"'),
      method: 'tools/call',
      params: Buffer.from(
        '{"name":"bash","arguments":{"command":"printf \'\\\\x81\' >&2; exit 1"}}'),
    });

    const r = runRaw(req);
    assert.equal(r.signal, null,
      `boxsh crashed with signal ${r.signal}. stderr: ${r.stderr?.toString()}`);
    assert.ok(r.status !== null, 'boxsh exited normally');

    const outStr = r.stdout?.toString('utf8') || '';
    assert.ok(outStr.trim().length > 0, 'boxsh produced no stdout');
    assert.doesNotThrow(() => JSON.parse(outStr.trim()));
  });

  // ── Scenario 6: multiple concurrent requests with bad UTF-8 ────────
  // Exercise the detached-thread try/catch path.

  test('multiple concurrent requests with bad UTF-8 ids do not crash boxsh', () => {
    const lines = [];
    // Mix of good and bad requests.
    for (let i = 0; i < 10; i++) {
      if (i % 3 === 0) {
        lines.push(rawReq({
          idBytes: badString(`bad-${i}-`),
          method: 'tools/call',
          params: Buffer.from(
            `{"name":"bash","arguments":{"command":"echo ok${i}"}}`),
        }));
      } else {
        lines.push(rawReq({
          idBytes: Buffer.from(`"good-${i}"`),
          method: 'tools/call',
          params: Buffer.from(
            `{"name":"bash","arguments":{"command":"echo ok${i}"}}`),
        }));
      }
    }

    const input = Buffer.concat(lines);
    const r = runRaw(input, /*workers=*/4);
    assert.equal(r.signal, null,
      `boxsh crashed with signal ${r.signal}. stderr: ${r.stderr?.toString()}`);
    assert.ok(r.status !== null, 'boxsh exited normally');

    // All responses should be valid JSON lines (or at minimum, none crashed).
    const outStr = r.stdout?.toString('utf8') || '';
    const responseLines = outStr.trim().split('\n').filter(Boolean);
    assert.ok(responseLines.length > 0, 'boxsh produced no responses');
    for (const line of responseLines) {
      assert.doesNotThrow(() => JSON.parse(line),
        `unparseable response: ${line.substring(0, 200)}`);
    }
  });
});
