/**
 * tools.test.mjs — tests for the built-in RPC tools: read, write, edit.
 *
 * Each test uses a unique temp file and cleans up after itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rpc, rpcSandboxed } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpFile(content = '') {
  const p = path.join(os.tmpdir(), `boxsh-tool-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  if (content !== null) fs.writeFileSync(p, content, 'utf8');
  return p;
}

/** Extract the text content from a non-read tool response. */
function text(resp) {
  assert.ok(Array.isArray(resp.content), 'response.content is not an array');
  assert.ok(resp.content.length > 0, 'response.content is empty');
  return resp.content[0].text;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe('tool — read', () => {
  test('reads entire file', () => {
    const p = tmpFile('hello\nworld\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.content, 'hello\nworld\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('offset skips leading lines', () => {
    const p = tmpFile('line1\nline2\nline3\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p, offset: 2 });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.content, 'line2\nline3\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('limit caps number of lines returned', () => {
    const p = tmpFile('a\nb\nc\nd\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p, limit: 2 });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.content, 'a\nb\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('offset + limit together', () => {
    const p = tmpFile('a\nb\nc\nd\ne\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p, offset: 2, limit: 2 });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.content, 'b\nc\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('missing file returns error', () => {
    const resp = rpc({ id: '1', tool: 'read', path: '/nonexistent/boxsh-test-file' });
    assert.ok(resp.error, 'expected an error for missing file');
    assert.match(resp.error, /read:/);
  });

  test('response includes encoding and mime_type for text', () => {
    const p = tmpFile('x\ny\nz\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.encoding, 'text');
      assert.equal(typeof resp.mime_type, 'string');
      assert.ok(resp.mime_type.startsWith('text/'), `expected text/* mime, got ${resp.mime_type}`);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('response includes line_count', () => {
    const p = tmpFile('x\ny\nz\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.ok(resp.line_count >= 3, 'expected line_count >= 3');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('truncated field is false when not truncated', () => {
    const p = tmpFile('a\nb\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.truncated, false);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('truncated field is true when limit reached', () => {
    const p = tmpFile('a\nb\nc\nd\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p, limit: 2 });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.truncated, true);
      assert.equal(resp.line_count, 2);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('truncated returns total_lines and next_offset', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const p = tmpFile(lines);
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p, limit: 10 });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.truncated, true);
      assert.equal(resp.line_count, 10);
      assert.equal(resp.total_lines, 100);
      assert.equal(resp.next_offset, 11);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('truncated with offset returns correct next_offset', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const p = tmpFile(lines);
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p, offset: 20, limit: 10 });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.truncated, true);
      assert.equal(resp.line_count, 10);
      assert.equal(resp.total_lines, 100);
      assert.equal(resp.next_offset, 30);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('non-truncated response has no total_lines or next_offset', () => {
    const p = tmpFile('a\nb\nc\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.truncated, false);
      assert.equal(resp.total_lines, undefined);
      assert.equal(resp.next_offset, undefined);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('default line limit truncates large files', () => {
    // Generate 3000 lines — exceeds the 2000 default.
    const lines = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const p = tmpFile(lines);
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.truncated, true);
      assert.equal(resp.line_count, 2000);
      assert.equal(resp.total_lines, 3000);
      assert.equal(resp.next_offset, 2001);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('byte limit truncates before line limit', () => {
    // Each line ~100 bytes → 600 lines ≈ 60KB, exceeds 50KB limit before 2000 lines.
    const longLine = 'x'.repeat(99);
    const lines = Array.from({ length: 600 }, () => longLine).join('\n') + '\n';
    const p = tmpFile(lines);
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.truncated, true);
      assert.ok(resp.line_count < 600, `expected fewer than 600 lines, got ${resp.line_count}`);
      assert.ok(resp.line_count > 0, 'expected at least 1 line');
      assert.equal(resp.total_lines, 600);
      assert.equal(resp.next_offset, resp.line_count + 1);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('reads binary image as metadata (truncated image)', () => {
    // Create a small PNG-like binary file (too small for stb to decode).
    const p = path.join(os.tmpdir(),
      `boxsh-bin-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                             0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]);
    fs.writeFileSync(p, buf);
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      // Truncated PNG — stb can't decode, falls back to metadata.
      assert.equal(resp.encoding, 'metadata');
      assert.equal(resp.mime_type, 'image/png');
      assert.equal(resp.size, 16);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('binary file has mime_type and size', () => {
    const p = path.join(os.tmpdir(),
      `boxsh-bin-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
    // Use a GIF header to ensure detection identifies it as binary.
    const buf = Buffer.from('GIF89a' + '\x00'.repeat(58));
    fs.writeFileSync(p, buf);
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.encoding, 'metadata');
      assert.equal(typeof resp.mime_type, 'string');
      assert.equal(resp.size, 64);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('ELF binary detected correctly', () => {
    const p = path.join(os.tmpdir(),
      `boxsh-elf-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
    // ELF magic header.
    const buf = Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00,
                             0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    fs.writeFileSync(p, buf);
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.encoding, 'metadata');
      assert.ok(resp.mime_type.includes('elf') || resp.mime_type.includes('executable') ||
                resp.mime_type.includes('octet'), `expected binary mime, got ${resp.mime_type}`);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('JSON file detected as text', () => {
    const p = path.join(os.tmpdir(),
      `boxsh-json-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, '{"key": "value"}\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.encoding, 'text');
      assert.equal(resp.content, '{"key": "value"}\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('empty file reads as text', () => {
    const p = tmpFile('');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(resp.encoding, 'text');
      assert.equal(resp.content, '');
    } finally { fs.rmSync(p, { force: true }); }
  });
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe('tool — write', () => {
  test('creates a new file with given content', () => {
    const p = path.join(os.tmpdir(), `boxsh-write-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    try {
      const resp = rpc({ id: '1', tool: 'write', path: p, content: 'top secret\n' });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(fs.readFileSync(p, 'utf8'), 'top secret\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('writing to an existing file returns error', () => {
    const p = tmpFile('old content\n');
    try {
      const resp = rpc({ id: '1', tool: 'write', path: p, content: 'new content\n' });
      assert.ok(resp.error, 'expected error for existing file');
      assert.match(resp.error, /already exists/);
      // File must be unchanged.
      assert.equal(fs.readFileSync(p, 'utf8'), 'old content\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('confirmation message mentions bytes written', () => {
    const p = path.join(os.tmpdir(), `boxsh-write-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    try {
      const content = 'abc';
      const resp = rpc({ id: '1', tool: 'write', path: p, content });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.match(text(resp), /3/); // "written 3 bytes"
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('write to non-writable path returns error', () => {
    const resp = rpc({ id: '1', tool: 'write', path: '/no_permission_dir_xyz/file.txt', content: 'x' });
    assert.ok(resp.error, 'expected error for non-writable path');
    assert.match(resp.error, /write:/);
  });

  test('write auto-creates parent directories', () => {
    const base = path.join(os.tmpdir(), `boxsh-mkdir-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const p = path.join(base, 'sub', 'dir', 'file.txt');
    try {
      const resp = rpc({ id: '1', tool: 'write', path: p, content: 'hello\n' });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(fs.readFileSync(p, 'utf8'), 'hello\n');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  test('write auto-create dirs still rejects existing file', () => {
    const base = path.join(os.tmpdir(), `boxsh-mkdir2-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const p = path.join(base, 'file.txt');
    try {
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(p, 'old\n');
      const resp = rpc({ id: '1', tool: 'write', path: p, content: 'new\n' });
      assert.ok(resp.error, 'expected error for existing file');
      assert.match(resp.error, /already exists/);
      assert.equal(fs.readFileSync(p, 'utf8'), 'old\n');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe('tool — edit', () => {
  test('single edit replaces text and confirms with diff', () => {
    const p = tmpFile('hello world\n');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'world', newText: 'earth' }] });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(fs.readFileSync(p, 'utf8'), 'hello earth\n');
      assert.ok(resp.diff?.includes('-hello world'), 'diff should show removed line');
      assert.ok(resp.diff?.includes('+hello earth'), 'diff should show added line');
      assert.equal(resp.firstChangedLine, 1);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('multiple edits applied correctly', () => {
    const p = tmpFile('foo\nbar\nbaz\n');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [
          { oldText: 'foo', newText: 'FOO' },
          { oldText: 'baz', newText: 'BAZ' },
        ] });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      const result = fs.readFileSync(p, 'utf8');
      assert.ok(result.includes('FOO'), 'expected FOO in result');
      assert.ok(result.includes('BAZ'), 'expected BAZ in result');
      assert.ok(result.includes('bar'), 'expected bar unchanged');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('ambiguous oldText returns error', () => {
    const p = tmpFile('repeat\nrepeat\n');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'repeat', newText: 'once' }] });
      assert.ok(resp.error, 'expected error for ambiguous oldText');
      assert.match(resp.error, /not unique/);
      // File must be unchanged.
      assert.equal(fs.readFileSync(p, 'utf8'), 'repeat\nrepeat\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('missing oldText returns error', () => {
    const p = tmpFile('hello\n');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'goodbye', newText: 'hi' }] });
      assert.ok(resp.error, 'expected error for missing oldText');
      assert.match(resp.error, /not found/);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('edit missing file returns error', () => {
    const resp = rpc({ id: '1', tool: 'edit', path: '/no/such/file.txt',
      edits: [{ oldText: 'x', newText: 'y' }] });
    assert.ok(resp.error, 'expected error for missing file');
    assert.match(resp.error, /edit:/);
  });

  test('edit CRLF file with LF oldText', () => {
    const p = tmpFile(null);
    fs.writeFileSync(p, 'hello\r\nworld\r\n', 'binary');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'hello\nworld', newText: 'hi\nearth' }] });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      const result = fs.readFileSync(p, 'binary');
      assert.equal(result, 'hi\r\nearth\r\n', 'CRLF should be preserved');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('edit CRLF file preserves line endings throughout', () => {
    const p = tmpFile(null);
    fs.writeFileSync(p, 'aaa\r\nbbb\r\nccc\r\n', 'binary');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'bbb', newText: 'BBB' }] });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      const result = fs.readFileSync(p, 'binary');
      assert.equal(result, 'aaa\r\nBBB\r\nccc\r\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('edit BOM file matches oldText without BOM', () => {
    const p = tmpFile(null);
    fs.writeFileSync(p, '\xEF\xBB\xBFhello world\n', 'binary');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'hello', newText: 'hi' }] });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      const result = fs.readFileSync(p, 'binary');
      assert.ok(result.startsWith('\xEF\xBB\xBF'), 'BOM should be preserved');
      assert.equal(result, '\xEF\xBB\xBFhi world\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('edit BOM + CRLF file works correctly', () => {
    const p = tmpFile(null);
    fs.writeFileSync(p, '\xEF\xBB\xBFfoo\r\nbar\r\n', 'binary');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'foo\nbar', newText: 'FOO\nBAR' }] });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      const result = fs.readFileSync(p, 'binary');
      assert.equal(result, '\xEF\xBB\xBFFOO\r\nBAR\r\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('fuzzy match with trailing whitespace difference', () => {
    const p = tmpFile(null);
    // File has trailing spaces on lines.
    fs.writeFileSync(p, 'hello   \nworld  \n');
    try {
      // oldText has no trailing whitespace — fuzzy should match.
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'hello\nworld', newText: 'hi\nearth' }] });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      const result = fs.readFileSync(p, 'utf8');
      assert.equal(result, 'hi\nearth\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('fuzzy match with tabs as trailing whitespace', () => {
    const p = tmpFile(null);
    fs.writeFileSync(p, 'aaa\t\nbbb\n');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'aaa\nbbb', newText: 'AAA\nBBB' }] });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(fs.readFileSync(p, 'utf8'), 'AAA\nBBB\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('exact match preferred over fuzzy', () => {
    const p = tmpFile('hello\nworld\n');
    try {
      // Exact match exists — should not need fuzzy.
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'hello\nworld', newText: 'hi\nearth' }] });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(fs.readFileSync(p, 'utf8'), 'hi\nearth\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('fuzzy match still enforces uniqueness', () => {
    const p = tmpFile(null);
    // Two identical blocks after stripping whitespace.
    fs.writeFileSync(p, 'dup  \ndup  \n');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'dup', newText: 'unique' }] });
      assert.ok(resp.error, 'expected uniqueness error');
      assert.match(resp.error, /not unique/);
    } finally { fs.rmSync(p, { force: true }); }
  });
});

// ---------------------------------------------------------------------------
// parse errors
// ---------------------------------------------------------------------------

describe('tool — protocol errors', () => {
  test('unknown tool name returns parse error', () => {
    const resp = rpc({ id: '1', tool: 'magic', path: '/tmp/x' });
    assert.ok(resp.error, 'expected error for unknown tool');
    assert.match(resp.error, /unknown tool/);
  });

  test('read tool missing path returns parse error', () => {
    const resp = rpc({ id: '1', tool: 'read' });
    assert.ok(resp.error, 'expected error for missing path');
  });

  test('write tool missing content returns parse error', () => {
    const resp = rpc({ id: '1', tool: 'write', path: '/tmp/x' });
    assert.ok(resp.error, 'expected error for missing content');
  });
});

// ---------------------------------------------------------------------------
// isError consistency — all tool errors set isError: true in raw response
// ---------------------------------------------------------------------------

describe('tool — isError consistency', () => {
  test('read missing file sets isError in raw response', () => {
    const resp = rpc({ id: '1', tool: 'read', path: '/nonexistent/boxsh-test-file' });
    assert.ok(resp.isError === true, 'expected isError to be true');
    assert.ok(resp.error, 'expected error text');
  });

  test('write existing file sets isError in raw response', () => {
    const p = tmpFile('existing\n');
    try {
      const resp = rpc({ id: '1', tool: 'write', path: p, content: 'overwrite\n' });
      assert.ok(resp.isError === true, 'expected isError to be true');
      assert.ok(resp.error, 'expected error text');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('edit missing file sets isError in raw response', () => {
    const resp = rpc({ id: '1', tool: 'edit', path: '/nonexistent/boxsh-test-file',
      edits: [{ oldText: 'x', newText: 'y' }] });
    assert.ok(resp.isError === true, 'expected isError to be true');
    assert.ok(resp.error, 'expected error text');
  });

  test('edit missing oldText sets isError in raw response', () => {
    const p = tmpFile('hello\n');
    try {
      const resp = rpc({ id: '1', tool: 'edit', path: p,
        edits: [{ oldText: 'goodbye', newText: 'hi' }] });
      assert.ok(resp.isError === true, 'expected isError to be true');
      assert.ok(resp.error, 'expected error text');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('bash non-zero exit sets isError with structuredContent', () => {
    const resp = rpc({ id: '1', cmd: 'exit 42' });
    assert.ok(resp.isError === true, 'expected isError to be true');
    assert.equal(resp.exit_code, 42);
    assert.equal(typeof resp.duration_ms, 'number');
  });

  test('bash command failure sets isError with stderr', () => {
    const resp = rpc({ id: '1', cmd: 'cat /nonexistent/boxsh-test-file' });
    assert.ok(resp.isError === true, 'expected isError to be true');
    assert.equal(resp.exit_code, 1);
    assert.ok(resp.stderr.length > 0, 'expected non-empty stderr');
  });
});

// ---------------------------------------------------------------------------
// Sandbox isolation (--sandbox mode)
//
// In sandbox mode the tool child applies sandbox_apply() before executing.
// /tmp inside the sandbox is a fresh tmpfs, so writes there MUST NOT affect
// the host /tmp.
// ---------------------------------------------------------------------------

describe('tool — sandbox isolation', () => {
  test('write tool in sandbox does not modify host /tmp', () => {
    // Create a sentinel file on the host /tmp.
    const sentinel = path.join(os.tmpdir(),
      `boxsh-sandbox-sentinel-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    const original = 'HOST_ORIGINAL\n';
    fs.writeFileSync(sentinel, original, 'utf8');
    try {
      // In sandboxed mode, /tmp is a fresh tmpfs — the sentinel path does not
      // exist there.  The write will either fail (path not found) or succeed
      // but write into the sandbox tmpfs, leaving the host file untouched.
      rpcSandboxed({ id: '1', tool: 'write', path: sentinel, content: 'SANDBOXED\n' });
      // Either way: host file must still contain the original content.
      assert.equal(fs.readFileSync(sentinel, 'utf8'), original,
        'host file was modified — tool ran outside the sandbox!');
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  });

  test('read tool in sandbox cannot read host-only files',
    { skip: process.platform === 'darwin' ? 'macOS lacks mount namespace isolation; host tempdir files remain readable' : false },
    () => {
    // Write a secret to a path the sandbox exposes only as an isolated /tmp.
    const secret = path.join(os.tmpdir(),
      `boxsh-sandbox-secret-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(secret, 'TOP_SECRET\n', 'utf8');
    try {
      // The sandbox /tmp is a fresh empty tmpfs, so this path should not exist.
      const resp = rpcSandboxed({ id: '1', tool: 'read', path: secret });
      // If it returned content it must NOT be the secret.
      if (!resp.error) {
        const content = resp.content?.[0]?.text ?? '';
        assert.notEqual(content, 'TOP_SECRET\n',
          'sandboxed tool read the host secret file!');
      }
      // An error response (file not found) is the expected happy path.
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });
});
