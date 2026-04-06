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

/** Extract the text content from a tool response. */
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
      assert.equal(text(resp), 'hello\nworld\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('offset skips leading lines', () => {
    const p = tmpFile('line1\nline2\nline3\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p, offset: 2 });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(text(resp), 'line2\nline3\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('limit caps number of lines returned', () => {
    const p = tmpFile('a\nb\nc\nd\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p, limit: 2 });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(text(resp), 'a\nb\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('offset + limit together', () => {
    const p = tmpFile('a\nb\nc\nd\ne\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p, offset: 2, limit: 2 });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(text(resp), 'b\nc\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('missing file returns error', () => {
    const resp = rpc({ id: '1', tool: 'read', path: '/nonexistent/boxsh-test-file' });
    assert.ok(resp.error, 'expected an error for missing file');
    assert.match(resp.error, /read:/);
  });

  test('response includes details with line_count', () => {
    const p = tmpFile('x\ny\nz\n');
    try {
      const resp = rpc({ id: '1', tool: 'read', path: p });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.ok(resp.details?.truncation?.line_count >= 3, 'expected line_count >= 3');
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

  test('overwrites an existing file', () => {
    const p = tmpFile('old content\n');
    try {
      const resp = rpc({ id: '1', tool: 'write', path: p, content: 'new content\n' });
      assert.ok(!resp.error, `unexpected error: ${resp.error}`);
      assert.equal(fs.readFileSync(p, 'utf8'), 'new content\n');
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('confirmation message mentions bytes written', () => {
    const p = tmpFile('');
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
      assert.ok(resp.details?.diff?.includes('-hello world'), 'diff should show removed line');
      assert.ok(resp.details?.diff?.includes('+hello earth'), 'diff should show added line');
      assert.equal(resp.details?.firstChangedLine, 1);
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

  test('read tool in sandbox cannot read host-only files', () => {
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
