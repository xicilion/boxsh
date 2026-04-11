/**
 * protocol-regression.test.mjs — regression tests for protocol bugs we fixed.
 *
 * Covers: id type preservation, Content-Length transport, initialize handshake,
 * protocol error vs tool error distinction.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run, BOXSH } from './helpers.mjs';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send raw JSON-RPC lines and return parsed responses. */
function mcpRaw(lines, opts = {}) {
  const input = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  const r = run(['--rpc', '--workers', String(opts.workers ?? 1)],
    input, opts.timeout_ms ?? 5000);
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  return r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** Send raw bytes as stdin (for Content-Length tests). */
function mcpBytes(input, opts = {}) {
  const r = spawnSync(BOXSH, ['--rpc', '--workers', String(opts.workers ?? 1)], {
    input: Buffer.from(input, 'utf8'),
    timeout: opts.timeout_ms ?? 5000,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  return r.stdout; // Buffer — preserves byte offsets for Content-Length parsing
}

/** Build a Content-Length framed message from a JSON object. */
function frame(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Parse Content-Length framed responses from raw Buffer output. */
function parseFramedResponses(raw) {
  // Work with Buffer throughout to match byte-based Content-Length values.
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const SEP = Buffer.from('\r\n\r\n');
  const results = [];
  let pos = 0;
  while (pos < buf.length) {
    const hdrEnd = buf.indexOf(SEP, pos);
    if (hdrEnd === -1) break;
    const hdr = buf.slice(pos, hdrEnd).toString('utf8');
    const m = hdr.match(/Content-Length:\s*(\d+)/i);
    if (!m) break;
    const len = parseInt(m[1], 10);
    const bodyStart = hdrEnd + 4;
    const body = buf.slice(bodyStart, bodyStart + len).toString('utf8');
    results.push(JSON.parse(body));
    pos = bodyStart + len;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Content-Length transport mode
// ---------------------------------------------------------------------------

describe('protocol — Content-Length transport', () => {
  test('single framed request gets framed response', () => {
    const req = { jsonrpc: '2.0', id: 'cl-1', method: 'initialize', params: {} };
    const raw = mcpBytes(frame(req));
    assert.ok(raw.includes('Content-Length:'), 'response should use Content-Length framing');
    const resps = parseFramedResponses(raw);
    assert.equal(resps.length, 1);
    assert.equal(resps[0].id, 'cl-1');
    assert.equal(resps[0].result.protocolVersion, '2024-11-05');
  });

  test('multiple framed requests get framed responses', () => {
    const input = [
      frame({ jsonrpc: '2.0', id: 'cl-m1', method: 'initialize', params: {} }),
      frame({ jsonrpc: '2.0', id: 'cl-m2', method: 'tools/list' }),
      frame({ jsonrpc: '2.0', id: 'cl-m3', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo framed' } } }),
    ].join('');
    const raw = mcpBytes(input);
    const resps = parseFramedResponses(raw);
    assert.equal(resps.length, 3);
    assert.equal(resps[0].id, 'cl-m1');
    assert.equal(resps[1].id, 'cl-m2');
    assert.equal(resps[2].id, 'cl-m3');
    assert.equal(resps[2].result.structuredContent.stdout, 'framed\n');
  });

  test('framed notification produces no response', () => {
    const input = [
      frame({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      frame({ jsonrpc: '2.0', id: 'cl-n1', method: 'initialize', params: {} }),
    ].join('');
    const raw = mcpBytes(input);
    const resps = parseFramedResponses(raw);
    assert.equal(resps.length, 1);
    assert.equal(resps[0].id, 'cl-n1');
  });

  test('Content-Length with unicode body is handled correctly', () => {
    const req = { jsonrpc: '2.0', id: 'cl-u', method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'printf "héllo"' } } };
    const raw = mcpBytes(frame(req));
    const resps = parseFramedResponses(raw);
    assert.equal(resps.length, 1);
    assert.equal(resps[0].result.structuredContent.stdout, 'héllo');
  });
});

// ---------------------------------------------------------------------------
// ID type preservation (JSON-RPC 2.0: id can be string, number, or null)
// ---------------------------------------------------------------------------

describe('protocol — id type preservation', () => {
  test('string id is preserved', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'my-string-id', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'true' } } },
    ]);
    assert.equal(resps[0].id, 'my-string-id');
    assert.equal(typeof resps[0].id, 'string');
  });

  test('numeric id is preserved as number', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 42, method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'true' } } },
    ]);
    assert.equal(resps[0].id, 42);
    assert.equal(typeof resps[0].id, 'number');
  });

  test('null id is preserved', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: null, method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'true' } } },
    ]);
    assert.equal(resps[0].id, null);
  });

  test('zero id is preserved as number', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 0, method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'true' } } },
    ]);
    assert.strictEqual(resps[0].id, 0);
    assert.equal(typeof resps[0].id, 'number');
  });

  test('negative numeric id is preserved', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: -1, method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'true' } } },
    ]);
    assert.strictEqual(resps[0].id, -1);
  });

  test('numeric id in Content-Length mode is preserved', () => {
    const req = { jsonrpc: '2.0', id: 99, method: 'initialize', params: {} };
    const raw = mcpBytes(frame(req));
    const resps = parseFramedResponses(raw);
    assert.equal(resps[0].id, 99);
    assert.equal(typeof resps[0].id, 'number');
  });

  test('missing id returns null in response', () => {
    // JSON-RPC 2.0: if id is absent the field defaults to null/empty.
    const resps = mcpRaw([
      { jsonrpc: '2.0', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'true' } } },
    ]);
    // id should be null (no id was sent)
    assert.equal(resps[0].id, null);
  });
});

// ---------------------------------------------------------------------------
// Initialize handshake
// ---------------------------------------------------------------------------

describe('protocol — initialize handshake', () => {
  test('echoes client protocolVersion', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'iv-1', method: 'initialize',
        params: { protocolVersion: '2024-11-05' } },
    ]);
    assert.equal(resps[0].result.protocolVersion, '2024-11-05');
  });

  test('falls back to default version when client omits protocolVersion', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'iv-2', method: 'initialize', params: {} },
    ]);
    assert.equal(resps[0].result.protocolVersion, '2024-11-05');
  });

  test('echoes non-standard protocolVersion from client', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'iv-3', method: 'initialize',
        params: { protocolVersion: '2025-03-26' } },
    ]);
    assert.equal(resps[0].result.protocolVersion, '2025-03-26');
  });

  test('initialize response has correct structure', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'iv-4', method: 'initialize', params: {} },
    ]);
    const r = resps[0].result;
    assert.ok(r.capabilities, 'missing capabilities');
    assert.ok(r.capabilities.tools, 'missing capabilities.tools');
    assert.ok(r.serverInfo, 'missing serverInfo');
    assert.equal(r.serverInfo.name, 'boxsh');
    assert.ok(r.serverInfo.version);
  });

  test('initialize works in Content-Length mode', () => {
    const raw = mcpBytes(frame({
      jsonrpc: '2.0', id: 'iv-cl', method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    }));
    const resps = parseFramedResponses(raw);
    assert.equal(resps.length, 1);
    assert.equal(resps[0].result.protocolVersion, '2024-11-05');
    assert.equal(resps[0].result.serverInfo.name, 'boxsh');
  });
});

// ---------------------------------------------------------------------------
// Protocol error vs tool execution error
// ---------------------------------------------------------------------------

describe('protocol — error distinction', () => {
  test('invalid JSON returns JSON-RPC error (not result with isError)', () => {
    const r = run(['--rpc', '--workers', '1'], 'not-json\n');
    const resp = JSON.parse(r.stdout.trim());
    // Must be a JSON-RPC error response, not a result.
    assert.ok(resp.error, 'expected error field for invalid JSON');
    assert.ok(!resp.result, 'should not have result field');
    assert.equal(typeof resp.error.code, 'number');
    assert.equal(typeof resp.error.message, 'string');
  });

  test('unknown method returns JSON-RPC error', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'unk-1', method: 'nonexistent', params: {} },
    ]);
    assert.ok(resps[0].error, 'expected error for unknown method');
    assert.ok(!resps[0].result, 'should not have result for unknown method');
    assert.ok(resps[0].error.message.includes('unknown method'));
  });

  test('unknown tool returns JSON-RPC error', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'unk-2', method: 'tools/call',
        params: { name: 'nonexistent', arguments: {} } },
    ]);
    assert.ok(resps[0].error, 'expected error for unknown tool');
    assert.ok(!resps[0].result);
    assert.ok(resps[0].error.message.includes('unknown tool'));
  });

  test('missing method returns JSON-RPC error', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'no-method' },
    ]);
    assert.ok(resps[0].error, 'expected error for missing method');
    assert.ok(!resps[0].result);
  });

  test('non-zero exit code returns result with isError (not JSON-RPC error)', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'te-1', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'exit 1' } } },
    ]);
    // Must be a result (with isError), not a JSON-RPC error.
    assert.ok(resps[0].result, 'expected result for tool error');
    assert.ok(!resps[0].error, 'should not have JSON-RPC error');
    assert.equal(resps[0].result.isError, true);
    assert.ok(Array.isArray(resps[0].result.content));
    assert.equal(resps[0].result.structuredContent.exit_code, 1);
  });

  test('successful command returns result without isError', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'te-2', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo ok' } } },
    ]);
    assert.ok(resps[0].result);
    assert.ok(!resps[0].error);
    assert.ok(!resps[0].result.isError, 'isError should not be set on success');
    assert.equal(resps[0].result.structuredContent.exit_code, 0);
  });

  test('MCP content array is always present in tool result', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'ct-1', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo hello' } } },
    ]);
    const content = resps[0].result.content;
    assert.ok(Array.isArray(content), 'content must be array');
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    assert.equal(typeof content[0].text, 'string');
  });

  test('protocol error after valid request does not corrupt stream', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'ok-1', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo first' } } },
      { jsonrpc: '2.0', id: 'bad-1' },  // missing method
      { jsonrpc: '2.0', id: 'ok-2', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo second' } } },
    ]);
    assert.equal(resps.length, 3);
    // Protocol errors are synchronous and may arrive before async bash results.
    // Match by id instead of assuming order.
    const byId = Object.fromEntries(resps.map(r => [r.id, r]));
    // ok-1: success
    assert.ok(byId['ok-1'].result);
    assert.equal(byId['ok-1'].result.structuredContent.stdout, 'first\n');
    // bad-1: protocol error
    assert.ok(byId['bad-1'].error);
    // ok-2: success (stream not corrupted)
    assert.ok(byId['ok-2'].result);
    assert.equal(byId['ok-2'].result.structuredContent.stdout, 'second\n');
  });
});
