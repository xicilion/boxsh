/**
 * tool-contract.test.mjs — the tool result contract
 * (docs/analysis-tool-result-contract.md).
 *
 * Verifies, without any external dependency:
 *   1. descriptors: every tool has title/description/inputSchema/outputSchema
 *      and the descriptions stay in sync with the implementation;
 *   2. schema conformance: real results validate against each tool's
 *      outputSchema (subset validator from helpers.mjs);
 *   3. error model: isError + content.text + structuredContent {code,message};
 *   4. old-client readability: content alone is enough (no JSON dumps);
 *   5. the bash text budget (head+tail reduction, full data in structured).
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  run, rpc, rpcRaw, rpcMany, schemaErrors, makePng, BoxshSession,
} from './helpers.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dir, 'fixture', name);

const TOOL_NAMES = [
  'bash', 'read', 'view_image', 'write', 'edit',
  'run_in_terminal', 'send_to_terminal', 'get_terminal_output',
  'kill_terminal', 'list_terminals',
];

/** Stable error codes from the contract document. */
const ERROR_CODES = [
  'E_INVALID_ARGUMENT', 'E_NOT_FOUND', 'E_NOT_TEXT', 'E_NOT_IMAGE',
  'E_UNSUPPORTED_FORMAT', 'E_TOO_LARGE', 'E_TIMEOUT', 'E_SANDBOX', 'E_INTERNAL',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tools = null;
function toolsList() {
  if (!tools) {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 'tl', method: 'tools/list' }) + '\n';
    const r = run(['--rpc'], line);
    tools = JSON.parse(r.stdout.trim()).result.tools;
  }
  return tools;
}

const toolByName = (name) => toolsList().find(t => t.name === name);

const structuredOf = (raw) => raw.result.structuredContent ?? {};
const textOf = (raw) => (raw.result.content ?? []).filter(c => c.type === 'text')
  .map(c => c.text).join('\n');

/** Assert a raw response is a well-formed tool error. */
function assertErrorShape(raw, label) {
  assert.ok(!raw.error, `${label}: expected a tool error, got JSON-RPC error: ${JSON.stringify(raw.error)}`);
  assert.equal(raw.result?.isError, true, `${label}: expected isError=true`);
  const sc = structuredOf(raw);
  assert.ok(typeof sc.code === 'string', `${label}: missing structuredContent.code`);
  assert.ok(ERROR_CODES.includes(sc.code),
    `${label}: unknown error code ${sc.code}; known codes: ${ERROR_CODES.join(', ')}`);
  assert.ok(typeof sc.message === 'string' && sc.message.length > 0,
    `${label}: missing structuredContent.message`);
  const text = textOf(raw);
  assert.ok(text.startsWith(sc.code + ': '),
    `${label}: text must start with "<CODE>: ", got ${JSON.stringify(text.slice(0, 60))}`);
  assert.ok(text.includes(sc.message), `${label}: text must contain the message`);
}

/** Assert a successful result validates against its tool's outputSchema. */
function assertSchemaConformance(toolName, raw) {
  const tool = toolByName(toolName);
  const errors = schemaErrors(tool.outputSchema, structuredOf(raw));
  assert.deepEqual(errors, [],
    `${toolName}: structuredContent violates outputSchema: ${errors.join('; ')}`);
}

/** Old-client readability: the first content block is readable text. */
function assertReadableText(toolName, raw) {
  const content = raw.result.content;
  assert.ok(Array.isArray(content) && content.length > 0 && content[0].type === 'text',
    `${toolName}: first content block must be text`);
  const text = content[0].text;
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, `${toolName}: text must not be empty`);
}

// ---------------------------------------------------------------------------
// 1. Descriptors
// ---------------------------------------------------------------------------

describe('tool contract — descriptors', () => {
  test('exposes exactly the documented tool set', () => {
    assert.deepEqual(toolsList().map(t => t.name).sort(), [...TOOL_NAMES].sort());
  });

  test('every tool carries title, description, inputSchema and outputSchema', () => {
    for (const t of toolsList()) {
      assert.equal(typeof t.title, 'string', `${t.name}: missing title`);
      assert.ok(t.title.length > 0, `${t.name}: empty title`);
      assert.equal(typeof t.description, 'string', `${t.name}: missing description`);
      assert.ok(t.description.length > 20, `${t.name}: description too short`);
      assert.equal(t.inputSchema?.type, 'object', `${t.name}: inputSchema must be an object schema`);
      assert.equal(t.outputSchema?.type, 'object', `${t.name}: outputSchema must be an object schema`);
      assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean',
        `${t.name}: missing annotations.readOnlyHint`);
    }
  });

  test('inputSchema declares its required arguments', () => {
    assert.deepEqual(toolByName('bash').inputSchema.required, ['command']);
    assert.deepEqual(toolByName('read').inputSchema.required, ['path']);
    assert.deepEqual(toolByName('view_image').inputSchema.required, ['path']);
    assert.deepEqual(toolByName('write').inputSchema.required, ['path', 'content']);
    assert.deepEqual(toolByName('edit').inputSchema.required, ['path', 'edits']);
  });

  test('descriptions carry no stale wording', () => {
    for (const t of toolsList()) {
      assert.ok(!/binary files are returned as base64/i.test(t.description),
        `${t.name}: stale "binary as base64" wording`);
      assert.ok(!/nine tools/i.test(t.description), `${t.name}: stale tool count`);
    }
    // read no longer serves binary data at all.
    const read = toolByName('read');
    assert.ok(!/base64/i.test(read.description), 'read must not advertise base64 output');
    assert.match(read.description, /view_image/, 'read should point at view_image');
    // bash must not promise JSON.
    assert.ok(!/json/i.test(toolByName('bash').description),
      'bash description must not promise JSON');
  });

  test('file-tool descriptors declare the hardened behaviour', () => {
    // Contract §2.5/§四: the model only sees these strings, so the guarantees
    // added on 2026-09-14 must be visible.
    for (const name of ['read', 'view_image', 'write', 'edit']) {
      const schema = toolByName(name).inputSchema;
      assert.equal(schema.properties.path.minLength, 1,
        `${name}: inputSchema.path must require a non-empty path`);
    }
    const read = toolByName('read');
    assert.match(read.description, /regular files/i,
      'read must state that FIFOs/sockets are rejected');
    // read results gained file_size / empty_reason: they must be declared.
    assert.ok(read.outputSchema.properties.file_size, 'read outputSchema must declare file_size');
    assert.deepEqual(read.outputSchema.properties.empty_reason.enum,
      ['empty_file', 'offset_beyond_eof']);
    assert.ok(read.outputSchema.required.includes('file_size'),
      'file_size is always returned and must be required');
    assert.match(toolByName('write').description, /in place/i,
      'write must state that the write is in place');
    assert.match(toolByName('edit').description, /no-op|no op/i,
      'edit must mention that a no-op edit leaves the file untouched');
  });

  test('outputSchema stays inside the documented keyword subset', () => {
    const allowed = new Set([
      'type', 'properties', 'required', 'items', 'enum', 'anyOf', 'description',
    ]);
    const walk = (node, pathStr) => {
      if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${pathStr}[${i}]`)); return; }
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        assert.ok(allowed.has(k), `${pathStr}: unsupported JSON Schema keyword "${k}"`);
        if (k === 'properties') {
          // Property names are data, not keywords.
          for (const [name, sub] of Object.entries(v)) walk(sub, `${pathStr}.${name}`);
        } else {
          walk(v, `${pathStr}.${k}`);
        }
      }
    };
    for (const t of toolsList()) walk(t.outputSchema, `${t.name}.outputSchema`);
  });

  test('annotations match the contract table', () => {
    // readOnlyHint / destructiveHint per docs/analysis-tool-result-contract.md §4
    const expected = {
      bash: [false, true],
      read: [true, false],
      view_image: [true, false],
      write: [false, true],
      edit: [false, true],
      run_in_terminal: [false, true],
      send_to_terminal: [false, true],
      get_terminal_output: [true, false],
      kill_terminal: [false, true],
      list_terminals: [true, false],
    };
    for (const t of toolsList()) {
      const [readOnly, destructive] = expected[t.name];
      assert.equal(t.annotations.readOnlyHint, readOnly,
        `${t.name}: readOnlyHint mismatch`);
      assert.equal(t.annotations.destructiveHint, destructive,
        `${t.name}: destructiveHint mismatch`);
    }
  });

  test('numeric arguments are validated instead of silently ignored', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-args-'));
    const p = path.join(tmp, 'a.txt');
    fs.writeFileSync(p, 'one\ntwo\n');
    try {
      // bash timeout: built as a raw request because the flat test helper
      // treats top-level `timeout` as a legacy field, not a tool argument.
      const rawResp = JSON.parse(run(['--rpc'], JSON.stringify({
        jsonrpc: '2.0', id: '1', method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'true', timeout: '5' } },
      }) + '\n').stdout.trim());
      assert.ok(rawResp.error, 'timeout as string: expected a protocol error');
      assert.match(rawResp.error.message, /must be/i);

      for (const [label, args] of [
        ['offset as string', { path: p, offset: '2' }],
        ['limit zero',       { path: p, limit: 0 }],
      ]) {
        const resp = rpc({ id: '1', tool: 'read', ...args });
        assert.ok(resp.error, `${label}: expected a protocol error`);
        assert.match(resp.error, /must be/i, `${label}: message should explain the value`);
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// 2. Schema conformance — success paths
// ---------------------------------------------------------------------------

describe('tool contract — success results match outputSchema', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-contract-'));

  after(() => fs.rmSync(tmpdir, { recursive: true, force: true }));

  const textFile = path.join(tmpdir, 'sample.txt');
  fs.writeFileSync(textFile, 'alpha\nbeta\ngamma\n');
  const editFile = path.join(tmpdir, 'edit.txt');
  fs.writeFileSync(editFile, 'one\ntwo\n');

  const cases = [
    ['bash',          { command: 'echo contract-ok' }],
    ['read',          { path: textFile }],
    ['view_image',    { path: fixture('fixture.png') }],
    ['write',         { path: path.join(tmpdir, 'written.txt'), content: 'hello\n' }],
    ['edit',          { path: editFile, edits: [{ oldText: 'two', newText: 'TWO' }] }],
    ['list_terminals', {}],
  ];

  for (const [name, args] of cases) {
    test(`${name} result satisfies its outputSchema`, () => {
      const raw = rpcRaw({ id: '1', tool: name, ...args });
      assert.ok(!raw.result.isError, `${name}: unexpected error: ${textOf(raw)}`);
      assertSchemaConformance(name, raw);
      assertReadableText(name, raw);
    });
  }

  test('terminal tools satisfy their outputSchema across a session', async () => {
    const s = new BoxshSession();
    try {
      const started = await s.call('run_in_terminal', { command: 'bash' });
      assertSchemaConformance('run_in_terminal', started);
      assertReadableText('run_in_terminal', started);
      const id = structuredOf(started).id;
      assert.equal(structuredOf(started).exit_code, null,
        'a live session must report exit_code null');

      const sent = await s.call('send_to_terminal', { id, command: 'echo contract\n' });
      assertSchemaConformance('send_to_terminal', sent);
      assert.equal(structuredOf(sent).id, id, 'send_to_terminal must echo the session id');

      const polled = await s.call('get_terminal_output', { id });
      assertSchemaConformance('get_terminal_output', polled);
      assert.equal(structuredOf(polled).id, id, 'get_terminal_output must echo the session id');

      const listed = await s.call('list_terminals', {});
      assertSchemaConformance('list_terminals', listed);
      const entry = structuredOf(listed).sessions.find(x => x.id === id);
      assert.ok(entry, 'started session must be listed');
      assert.equal(entry.alive, true);
      assert.equal(entry.exited, false);
      assert.equal(entry.exit_code, null);

      const killed = await s.call('kill_terminal', { id });
      assertSchemaConformance('kill_terminal', killed);
      assert.equal(structuredOf(killed).killed, true);
      assert.equal(structuredOf(killed).id, id);
    } finally {
      await s.close();
    }
  });

  test('list_terminals text is a human-readable list', () => {
    const raw = rpcRaw({ id: '1', tool: 'list_terminals' });
    assert.equal(textOf(raw), '(no terminal sessions)\n');
  });
});

// ---------------------------------------------------------------------------
// 3. Error model
// ---------------------------------------------------------------------------

describe('tool contract — error model', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-contract-err-'));
  after(() => fs.rmSync(tmpdir, { recursive: true, force: true }));

  const textFile = path.join(tmpdir, 'plain.txt');
  fs.writeFileSync(textFile, 'just text\n');

  test('read: missing file → E_NOT_FOUND', () => {
    assertErrorShape(rpcRaw({ id: '1', tool: 'read', path: '/nonexistent/boxsh-read' }),
      'read missing file');
  });

  test('read: image → E_NOT_IMAGE pointing at view_image', () => {
    const raw = rpcRaw({ id: '1', tool: 'read', path: fixture('fixture.png') });
    assertErrorShape(raw, 'read image');
    assert.equal(structuredOf(raw).code, 'E_NOT_IMAGE');
    assert.match(structuredOf(raw).message, /view_image/);
  });

  test('read: binary → E_NOT_TEXT with mime and size detail', () => {
    const p = path.join(tmpdir, 'blob.bin');
    fs.writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00,
                                     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const raw = rpcRaw({ id: '1', tool: 'read', path: p });
    assertErrorShape(raw, 'read binary');
    const sc = structuredOf(raw);
    assert.equal(sc.code, 'E_NOT_TEXT');
    assert.equal(typeof sc.detail?.mime, 'string');
    assert.equal(sc.detail?.size, fs.statSync(p).size);
  });

  test('read: invalid UTF-8 text file → E_NOT_TEXT', () => {
    const p = path.join(tmpdir, 'latin1.txt');
    fs.writeFileSync(p, Buffer.from('caf\xe9 latin-1 text\n', 'latin1'));
    const raw = rpcRaw({ id: '1', tool: 'read', path: p });
    assertErrorShape(raw, 'read invalid utf8');
    assert.equal(structuredOf(raw).code, 'E_NOT_TEXT');
  });

  test('read: directory → E_INVALID_ARGUMENT', () => {
    const raw = rpcRaw({ id: '1', tool: 'read', path: tmpdir });
    assertErrorShape(raw, 'read directory');
    assert.equal(structuredOf(raw).code, 'E_INVALID_ARGUMENT');
    assert.match(structuredOf(raw).message, /directory/);
  });

  test('view_image: directory → E_INVALID_ARGUMENT', () => {
    const raw = rpcRaw({ id: '1', tool: 'view_image', path: tmpdir });
    assertErrorShape(raw, 'view_image directory');
    assert.equal(structuredOf(raw).code, 'E_INVALID_ARGUMENT');
  });

  test('view_image: missing file → E_NOT_FOUND', () => {
    const raw = rpcRaw({ id: '1', tool: 'view_image', path: '/nonexistent/boxsh-img.png' });
    assertErrorShape(raw, 'view_image missing');
    assert.equal(structuredOf(raw).code, 'E_NOT_FOUND');
  });

  test('view_image: non-image → E_NOT_IMAGE', () => {
    const raw = rpcRaw({ id: '1', tool: 'view_image', path: textFile });
    assertErrorShape(raw, 'view_image text');
    assert.equal(structuredOf(raw).code, 'E_NOT_IMAGE');
  });

  test('write: invalid base64 → E_INVALID_ARGUMENT', () => {
    const raw = rpcRaw({ id: '1', tool: 'write',
      path: path.join(tmpdir, 'bad.bin'), content: '!!!not-base64!!!', encoding: 'base64' });
    assertErrorShape(raw, 'write bad base64');
    assert.equal(structuredOf(raw).code, 'E_INVALID_ARGUMENT');
  });

  test('edit: missing file → E_NOT_FOUND', () => {
    const raw = rpcRaw({ id: '1', tool: 'edit', path: '/nonexistent/boxsh-edit.txt',
      edits: [{ oldText: 'a', newText: 'b' }] });
    assertErrorShape(raw, 'edit missing file');
    assert.equal(structuredOf(raw).code, 'E_NOT_FOUND');
  });

  test('edit: unmatched oldText → E_INVALID_ARGUMENT', () => {
    const raw = rpcRaw({ id: '1', tool: 'edit', path: textFile,
      edits: [{ oldText: 'not-in-file', newText: 'x' }] });
    assertErrorShape(raw, 'edit unmatched');
    assert.equal(structuredOf(raw).code, 'E_INVALID_ARGUMENT');
  });

  test('terminal tools report an unknown session as E_NOT_FOUND', async () => {
    const s = new BoxshSession();
    const unknown = '00000000-0000-4000-8000-000000000000';
    const calls = [
      ['send_to_terminal',    { id: unknown, command: 'ls\n' }],
      ['get_terminal_output', { id: unknown }],
      ['kill_terminal',       { id: unknown }],
    ];
    try {
      for (const [name, args] of calls) {
        const raw = await s.call(name, args);
        assertErrorShape(raw, name);
        assert.equal(structuredOf(raw).code, 'E_NOT_FOUND');
      }
    } finally {
      await s.close();
    }
  });

  test('bash non-zero exit is an error but keeps the command result shape', () => {
    const raw = rpcRaw({ id: '1', tool: 'bash', command: 'echo partial; exit 42' });
    assert.equal(raw.result.isError, true, 'non-zero exit must set isError');
    const sc = structuredOf(raw);
    assert.equal(sc.exit_code, 42);
    assert.equal(sc.stdout, 'partial\n');
    assert.equal(sc.code, undefined, 'command results carry no error code');
    assertSchemaConformance('bash', raw);
  });
});

// ---------------------------------------------------------------------------
// 4. Readability / no JSON dumps
// ---------------------------------------------------------------------------

describe('tool contract — text is a model representation', () => {
  test('bash text is the command output, not a JSON dump', () => {
    const raw = rpcRaw({ id: '1', tool: 'bash', command: 'echo alpha; echo beta' });
    const text = textOf(raw);
    assert.ok(!text.startsWith('{'), 'text must not be a JSON object');
    assert.ok(text.includes('alpha') && text.includes('beta'));
  });

  test('bash labels stderr and reports the exit code', () => {
    const raw = rpcRaw({ id: '1', tool: 'bash',
      command: 'echo out; echo err >&2; exit 7' });
    const text = textOf(raw);
    assert.match(text, /\[stdout\]\nout\n\[stderr\]\nerr\n\[exit code: 7\]/);
  });

  test('bash says "(no output)" for a silent success', () => {
    const raw = rpcRaw({ id: '1', tool: 'bash', command: 'true' });
    assert.equal(textOf(raw), '(no output)\n');
  });

  test('read text is the file body plus a paging hint when truncated', () => {
    const p = path.join(os.tmpdir(), `boxsh-contract-page-${process.pid}.txt`);
    fs.writeFileSync(p, Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
    try {
      const raw = rpcRaw({ id: '1', tool: 'read', path: p, limit: 5 });
      const text = textOf(raw);
      assert.ok(text.startsWith('line1\nline2\nline3\nline4\nline5\n'));
      assert.match(text, /\[truncated: showing lines 1-5 of 40; continue with offset=6\]/);
      assert.equal(structuredOf(raw).next_offset, 6);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('read caps a single line that exceeds the byte budget', () => {
    const p = path.join(os.tmpdir(), `boxsh-contract-longline-${process.pid}.txt`);
    fs.writeFileSync(p, 'x'.repeat(200 * 1024) + '\n' + 'second line\n');
    try {
      const raw = rpcRaw({ id: '1', tool: 'read', path: p });
      const text = textOf(raw);
      const sc = structuredOf(raw);
      assert.ok(Buffer.byteLength(text) <= 51 * 1024,
        `one-line file must stay within the budget, got ${Buffer.byteLength(text)}`);
      assert.match(text, /\[truncated: line 1 is longer than the 50 KiB per-call limit/);
      assert.equal(sc.truncated, true);
      assert.equal(sc.line_count, 1);
      assert.equal(sc.next_offset, 2);
      // No data is lost from the caller's point of view: bash can read the rest.
      assert.match(text, /use bash/);
    } finally { fs.rmSync(p, { force: true }); }
  });

  test('terminal tools do not dump JSON', async () => {
    const s = new BoxshSession();
    try {
      const started = await s.call('run_in_terminal', { command: 'bash' });
      assert.ok(!textOf(started).startsWith('{'), 'run_in_terminal text must be readable');
      assert.match(textOf(started), /^terminal [0-9a-f-]+ \(bash\)/);
      const id = structuredOf(started).id;
      const killed = await s.call('kill_terminal', { id });
      assert.match(textOf(killed), new RegExp(`^terminal ${id} killed`));
      const listed = await s.call('list_terminals', {});
      assert.ok(!textOf(listed).startsWith('{'), 'list_terminals text must be readable');
      assert.ok(!textOf(listed).startsWith('['), 'list_terminals text must not be a JSON array');
    } finally {
      await s.close();
    }
  });

  test('write and edit confirmations are one readable line', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-contract-line-'));
    try {
      const f = path.join(tmpdir, 'x.txt');
      const w = rpcRaw({ id: '1', tool: 'write', path: f, content: 'abc' });
      assert.equal(textOf(w), `write: ${f} (created, 3 bytes)`);
      assert.equal(structuredOf(w).created, true);

      const w2 = rpcRaw({ id: '2', tool: 'write', path: f, content: 'abcde' });
      assert.equal(structuredOf(w2).created, false);
      assert.match(textOf(w2), /overwrote existing, 5 bytes/);

      const e = rpcRaw({ id: '3', tool: 'edit', path: f,
        edits: [{ oldText: 'abcde', newText: 'a\nb\nc\nd\ne' }] });
      assert.equal(textOf(e), `edit: ${f} (+5 -1, first change at line 1)`);
      assert.equal(structuredOf(e).lines_added, 5);
      assert.equal(structuredOf(e).lines_removed, 1);
      assert.equal(structuredOf(e).first_changed_line, 1);
    } finally { fs.rmSync(tmpdir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// 5. bash text budget
// ---------------------------------------------------------------------------

describe('tool contract — bash text budget', () => {
  test('large output is reduced in text but complete in structuredContent', () => {
    // ~1.4 MB of stdout: well past the 50 KiB text budget.
    const raw = rpcRaw({ id: '1', tool: 'bash', command: 'seq 1 200000' },
      { timeout_ms: 20000 });
    const text = textOf(raw);
    const sc = structuredOf(raw);

    assert.ok(sc.stdout.length > 1024 * 1024, 'structured stdout must hold everything');
    assert.ok(sc.stdout.startsWith('1\n2\n'), 'structured stdout must be the raw stream');
    assert.ok(text.length < 64 * 1024,
      `text must stay within the budget, got ${text.length} bytes`);
    assert.match(text, /\[truncated: \d+ bytes of \d+ omitted\]/);
    assert.ok(text.startsWith('1\n2\n'), 'text must keep the head');
    assert.ok(text.trimEnd().endsWith('200000'), 'text must keep the tail');
  });

  test('small output is not reduced', () => {
    const raw = rpcRaw({ id: '1', tool: 'bash', command: 'echo small' });
    assert.equal(textOf(raw), 'small\n');
    assert.ok(!/truncated/.test(textOf(raw)));
  });
});

// ---------------------------------------------------------------------------
// 6. Protocol / handshake
// ---------------------------------------------------------------------------

describe('tool contract — protocol', () => {
  test('initialize advertises the 2025-06-18 baseline and a static tool list', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 'i', method: 'initialize',
                                  params: {} }) + '\n';
    const r = JSON.parse(run(['--rpc'], line).stdout.trim());
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.equal(r.result.capabilities.tools.listChanged, false);
  });

  test('initialize echoes known legacy protocol versions', () => {
    for (const version of ['2024-11-05', '2025-03-26']) {
      const line = JSON.stringify({ jsonrpc: '2.0', id: 'i', method: 'initialize',
        params: { protocolVersion: version } }) + '\n';
      const r = JSON.parse(run(['--rpc'], line).stdout.trim());
      assert.equal(r.result.protocolVersion, version);
    }
  });

  test('legacy clients still get a readable error text without structured parsing', () => {
    const raw = rpcRaw({ id: '1', tool: 'read', path: fixture('fixture.png') });
    assert.ok(textOf(raw).startsWith('E_NOT_IMAGE: '), 'text must lead with the code');
    assert.ok(textOf(raw).includes('view_image'), 'text must say what to use instead');
  });

  test('image data stays out of structuredContent', () => {
    const resp = rpc({ id: '1', tool: 'view_image', path: fixture('fixture.png') });
    assert.equal(resp.encoding, 'image');
    assert.ok(!('data' in resp), 'base64 must not leak into structuredContent');
  });

  test('makePng fixture is a real decodable PNG', () => {
    // Guards the test helper itself (used by the resize assertions).
    const p = path.join(os.tmpdir(), `boxsh-contract-png-${process.pid}.png`);
    fs.writeFileSync(p, makePng(64, 32));
    try {
      const raw = rpcRaw({ id: '1', tool: 'view_image', path: p });
      assert.ok(!raw.result.isError, `generated PNG failed to decode: ${textOf(raw)}`);
      assert.equal(structuredOf(raw).width, 64);
      assert.equal(structuredOf(raw).height, 32);
    } finally { fs.rmSync(p, { force: true }); }
  });
});
