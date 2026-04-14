/**
 * mcp.test.mjs — tests for MCP (Model Context Protocol) support.
 *
 * Covers: initialize, tools/list, tools/call, notifications/initialized,
 * full handshake sequence, and error cases.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send raw JSON-RPC 2.0 requests and return parsed JSON responses. */
function mcpRaw(lines, { workers = 1, timeout_ms = 5000 } = {}) {
  const input = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  const r = run(['--rpc', '--workers', String(workers)], input, timeout_ms);
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

/** Send a single MCP request and return the parsed JSON-RPC 2.0 response. */
function mcpOne(req, opts) {
  const resps = mcpRaw([req], opts);
  assert.equal(resps.length, 1, 'expected exactly one response');
  return resps[0];
}

function tmpFile(content = '') {
  const p = path.join(os.tmpdir(),
    `boxsh-mcp-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  if (content !== null) fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

describe('mcp — initialize', () => {
  test('returns valid JSON-RPC 2.0 response', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: {} });
    assert.equal(resp.jsonrpc, '2.0');
    assert.equal(resp.id, 'init-1');
    assert.ok(resp.result, 'expected result field');
    assert.ok(!resp.error, 'unexpected error field');
  });

  test('protocolVersion is 2024-11-05', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'init-2', method: 'initialize', params: {} });
    assert.equal(resp.result.protocolVersion, '2024-11-05');
  });

  test('capabilities includes tools', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'init-3', method: 'initialize', params: {} });
    assert.ok('tools' in resp.result.capabilities, 'capabilities should include tools');
  });

  test('serverInfo has name and version', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'init-4', method: 'initialize', params: {} });
    assert.equal(resp.result.serverInfo.name, 'boxsh');
    assert.equal(typeof resp.result.serverInfo.version, 'string');
    assert.ok(resp.result.serverInfo.version.length > 0);
  });

  test('id is echoed back', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'custom-init-id', method: 'initialize', params: {} });
    assert.equal(resp.id, 'custom-init-id');
  });
});

// ---------------------------------------------------------------------------
// notifications/initialized
// ---------------------------------------------------------------------------

describe('mcp — notifications/initialized', () => {
  test('notification produces no response', () => {
    // Send notification followed by a real request.
    // Only the real request should produce a response.
    const resps = mcpRaw([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'after-notif', method: 'initialize', params: {} },
    ]);
    assert.equal(resps.length, 1, 'notification should not produce a response');
    assert.equal(resps[0].id, 'after-notif');
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe('mcp — tools/list', () => {
  test('returns tools array', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-1', method: 'tools/list' });
    assert.ok(Array.isArray(resp.result.tools), 'expected tools array');
  });

  test('contains exactly 9 tools', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-2', method: 'tools/list' });
    assert.equal(resp.result.tools.length, 9);
  });

  test('tool names include bash, read, write, edit and terminal tools', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-3', method: 'tools/list' });
    const names = resp.result.tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      'bash', 'edit', 'get_terminal_output', 'kill_terminal', 'list_terminals',
      'read', 'run_in_terminal', 'send_to_terminal', 'write',
    ]);
  });

  test('each tool has name, description, and inputSchema', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-4', method: 'tools/list' });
    for (const tool of resp.result.tools) {
      assert.equal(typeof tool.name, 'string', 'tool.name should be string');
      assert.equal(typeof tool.description, 'string', 'tool.description should be string');
      assert.ok(tool.inputSchema, `tool ${tool.name} missing inputSchema`);
      assert.equal(tool.inputSchema.type, 'object', `tool ${tool.name} schema type should be object`);
      assert.ok(tool.inputSchema.properties, `tool ${tool.name} missing properties`);
      assert.ok(Array.isArray(tool.inputSchema.required), `tool ${tool.name} missing required array`);
    }
  });

  test('bash tool schema requires command', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-5', method: 'tools/list' });
    const bash = resp.result.tools.find(t => t.name === 'bash');
    assert.ok(bash, 'bash tool not found');
    assert.ok(bash.inputSchema.required.includes('command'));
    assert.ok('command' in bash.inputSchema.properties);
    assert.ok('timeout' in bash.inputSchema.properties);
  });

  test('read tool schema requires path', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-6', method: 'tools/list' });
    const read = resp.result.tools.find(t => t.name === 'read');
    assert.ok(read);
    assert.ok(read.inputSchema.required.includes('path'));
  });

  test('write tool schema requires path and content', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-7', method: 'tools/list' });
    const write = resp.result.tools.find(t => t.name === 'write');
    assert.ok(write);
    assert.deepEqual(write.inputSchema.required.sort(), ['content', 'path']);
  });

  test('edit tool schema requires path and edits', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-8', method: 'tools/list' });
    const edit = resp.result.tools.find(t => t.name === 'edit');
    assert.ok(edit);
    assert.deepEqual(edit.inputSchema.required.sort(), ['edits', 'path']);
  });

  test('bash tool has outputSchema', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-os1', method: 'tools/list' });
    const bash = resp.result.tools.find(t => t.name === 'bash');
    assert.ok(bash.outputSchema, 'bash should have outputSchema');
    assert.equal(bash.outputSchema.type, 'object');
    assert.deepEqual(bash.outputSchema.required.sort(),
      ['duration_ms', 'exit_code', 'stderr', 'stdout']);
  });

  test('read tool has outputSchema', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-os2', method: 'tools/list' });
    const read = resp.result.tools.find(t => t.name === 'read');
    assert.ok(read.outputSchema, 'read should have outputSchema');
    assert.equal(read.outputSchema.type, 'object');
    assert.ok('content' in read.outputSchema.properties);
    assert.ok('encoding' in read.outputSchema.properties);
    assert.ok('mime_type' in read.outputSchema.properties);
    assert.deepEqual(read.outputSchema.required.sort(),
      ['content', 'encoding', 'mime_type']);
  });

  test('edit tool has outputSchema', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-os3', method: 'tools/list' });
    const edit = resp.result.tools.find(t => t.name === 'edit');
    assert.ok(edit.outputSchema, 'edit should have outputSchema');
    assert.equal(edit.outputSchema.type, 'object');
    assert.deepEqual(edit.outputSchema.required.sort(), ['diff', 'firstChangedLine']);
  });

  test('tools have annotations', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-ann', method: 'tools/list' });
    for (const tool of resp.result.tools) {
      assert.ok(tool.annotations, `${tool.name} should have annotations`);
      assert.equal(typeof tool.annotations.title, 'string');
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
      assert.equal(typeof tool.annotations.destructiveHint, 'boolean');
    }
    const read = resp.result.tools.find(t => t.name === 'read');
    assert.equal(read.annotations.readOnlyHint, true);
    assert.equal(read.annotations.destructiveHint, false);
  });

  test('id is echoed back', () => {
    const resp = mcpOne({ jsonrpc: '2.0', id: 'tl-id', method: 'tools/list' });
    assert.equal(resp.id, 'tl-id');
  });
});

// ---------------------------------------------------------------------------
// tools/call — bash
// ---------------------------------------------------------------------------

describe('mcp — tools/call bash', () => {
  test('executes command and returns stdout', () => {
    const resp = mcpOne({
      jsonrpc: '2.0', id: 'tc-1', method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'echo hello MCP' } },
    });
    assert.ok(resp.result, 'expected result');
    assert.ok(Array.isArray(resp.result.content), 'expected content array');
    assert.equal(resp.result.structuredContent.stdout, 'hello MCP\n');
    assert.equal(resp.result.structuredContent.exit_code, 0);
  });

  test('captures stderr', () => {
    const resp = mcpOne({
      jsonrpc: '2.0', id: 'tc-2', method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'echo ERR >&2' } },
    });
    assert.equal(resp.result.structuredContent.stderr, 'ERR\n');
  });

  test('returns non-zero exit code', () => {
    const resp = mcpOne({
      jsonrpc: '2.0', id: 'tc-3', method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'exit 42' } },
    });
    assert.equal(resp.result.structuredContent.exit_code, 42);
    assert.equal(resp.result.isError, true);
  });

  test('missing command returns error', () => {
    const resp = mcpOne({
      jsonrpc: '2.0', id: 'tc-4', method: 'tools/call',
      params: { name: 'bash', arguments: {} },
    });
    assert.ok(resp.error, 'expected error');
    assert.ok(resp.error.message.includes('command'), `error should mention command: ${resp.error.message}`);
  });
});

// ---------------------------------------------------------------------------
// tools/call — read
// ---------------------------------------------------------------------------

describe('mcp — tools/call read', () => {
  test('reads file content', () => {
    const p = tmpFile('MCP read test\n');
    try {
      const resp = mcpOne({
        jsonrpc: '2.0', id: 'tr-1', method: 'tools/call',
        params: { name: 'read', arguments: { path: p } },
      });
      assert.ok(resp.result, 'expected result');
      assert.ok(Array.isArray(resp.result.content));
      // content[0].text is now a JSON string; structuredContent.content has the file text.
      assert.equal(resp.result.structuredContent.content, 'MCP read test\n');
      assert.equal(resp.result.structuredContent.encoding, 'text');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('offset and limit work', () => {
    const p = tmpFile('a\nb\nc\nd\n');
    try {
      const resp = mcpOne({
        jsonrpc: '2.0', id: 'tr-2', method: 'tools/call',
        params: { name: 'read', arguments: { path: p, offset: 2, limit: 2 } },
      });
      assert.equal(resp.result.structuredContent.content, 'b\nc\n');
      assert.equal(resp.result.structuredContent.truncated, true);
      assert.equal(resp.result.structuredContent.line_count, 2);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('binary file returns metadata encoding', () => {
    const p = path.join(os.tmpdir(),
      `boxsh-mcp-bin-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    fs.writeFileSync(p, buf);
    try {
      const resp = mcpOne({
        jsonrpc: '2.0', id: 'tr-3', method: 'tools/call',
        params: { name: 'read', arguments: { path: p } },
      });
      assert.ok(resp.result, 'expected result');
      // Truncated PNG (8 bytes) — image can't be decoded, falls back to metadata.
      assert.equal(resp.result.structuredContent.encoding, 'metadata');
      assert.equal(resp.result.structuredContent.size, 8);
    } finally { fs.rmSync(p, { force: true }); }
  });
});

// ---------------------------------------------------------------------------
// tools/call — write
// ---------------------------------------------------------------------------

describe('mcp — tools/call write', () => {
  test('writes file content', () => {
    const p = path.join(os.tmpdir(),
      `boxsh-mcp-write-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    try {
      const resp = mcpOne({
        jsonrpc: '2.0', id: 'tw-1', method: 'tools/call',
        params: { name: 'write', arguments: { path: p, content: 'MCP write\n' } },
      });
      assert.ok(resp.result, 'expected result');
      assert.equal(fs.readFileSync(p, 'utf8'), 'MCP write\n');
    } finally { fs.rmSync(p, { force: true }); }
  });
});

// ---------------------------------------------------------------------------
// tools/call — edit
// ---------------------------------------------------------------------------

describe('mcp — tools/call edit', () => {
  test('edits file with oldText/newText', () => {
    const p = tmpFile('hello world\n');
    try {
      const resp = mcpOne({
        jsonrpc: '2.0', id: 'te-1', method: 'tools/call',
        params: {
          name: 'edit',
          arguments: {
            path: p,
            edits: [{ oldText: 'world', newText: 'MCP' }],
          },
        },
      });
      assert.ok(resp.result, 'expected result');
      assert.equal(fs.readFileSync(p, 'utf8'), 'hello MCP\n');
    } finally { fs.rmSync(p, { force: true }); }
  });
});

// ---------------------------------------------------------------------------
// tools/call — error cases
// ---------------------------------------------------------------------------

describe('mcp — tools/call errors', () => {
  test('missing params.name returns error', () => {
    const resp = mcpOne({
      jsonrpc: '2.0', id: 'te-err-1', method: 'tools/call',
      params: { arguments: { command: 'echo x' } },
    });
    assert.ok(resp.error, 'expected error');
    assert.ok(resp.error.message.includes('params.name'));
  });

  test('unknown tool name returns error', () => {
    const resp = mcpOne({
      jsonrpc: '2.0', id: 'te-err-2', method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    });
    assert.ok(resp.error, 'expected error');
    assert.ok(resp.error.message.includes('unknown'));
  });

  test('write tool via tools/call missing content returns error', () => {
    const resp = mcpOne({
      jsonrpc: '2.0', id: 'te-err-3', method: 'tools/call',
      params: { name: 'write', arguments: { path: '/tmp/x' } },
    });
    assert.ok(resp.error, 'expected error');
    assert.ok(resp.error.message.includes('content'));
  });

  test('edit tool via tools/call missing edits returns error', () => {
    const resp = mcpOne({
      jsonrpc: '2.0', id: 'te-err-4', method: 'tools/call',
      params: { name: 'edit', arguments: { path: '/tmp/x' } },
    });
    assert.ok(resp.error, 'expected error');
  });
});

// ---------------------------------------------------------------------------
// Full MCP handshake sequence
// ---------------------------------------------------------------------------

describe('mcp — full handshake', () => {
  test('initialize → notification → tools/list → tools/call', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'h-1', method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'h-2', method: 'tools/list' },
      { jsonrpc: '2.0', id: 'h-3', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo handshake' } } },
    ]);
    // Notification produces no response, so we expect 3 responses.
    assert.equal(resps.length, 3, `expected 3 responses, got ${resps.length}`);

    // initialize
    assert.equal(resps[0].id, 'h-1');
    assert.equal(resps[0].result.protocolVersion, '2024-11-05');

    // tools/list
    assert.equal(resps[1].id, 'h-2');
    assert.equal(resps[1].result.tools.length, 9);

    // tools/call
    assert.equal(resps[2].id, 'h-3');
    assert.equal(resps[2].result.structuredContent.stdout, 'handshake\n');
  });

  test('multiple tools/call requests in sequence', () => {
    const resps = mcpRaw([
      { jsonrpc: '2.0', id: 'mix-1', method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 'mix-2', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo first' } } },
      { jsonrpc: '2.0', id: 'mix-3', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'echo second' } } },
    ]);
    assert.equal(resps.length, 3);
    assert.equal(resps[0].result.protocolVersion, '2024-11-05');
    assert.equal(resps[1].result.structuredContent.stdout, 'first\n');
    assert.equal(resps[2].result.structuredContent.stdout, 'second\n');
  });
});
