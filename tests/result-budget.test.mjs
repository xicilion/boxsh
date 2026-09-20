/**
 * result-budget.test.mjs — the encoded-size budget for one tool result.
 *
 * A client's stdio read buffer is a hard wall: the official MCP SDK keeps 10 MiB
 * and, on overflow, clears the buffer *and* closes the transport, after which
 * every request fails with "Not connected".  boxsh therefore sizes what it sends
 * by the *encoded* bytes (JSON escaping turns a NUL byte into "\u0000"), not by
 * the raw output: 2 MB of binary output is a 12 MB message, while 8 MB of plain
 * text is an 8 MB message.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BOXSH, makePng } from './helpers.mjs';

const tempFiles = [];
after(() => {
  for (const f of tempFiles) { try { fs.unlinkSync(f); } catch { /* gone */ } }
});

/** Run one tools/call and return the raw response line length + parsed message. */
function callRaw(tool, args, serverArgs = [], timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BOXSH, ['--rpc', '--workers', '1', ...serverArgs]);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`timeout calling ${tool}`));
    }, timeoutMs);
    proc.stdout.on('data', d => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      clearTimeout(timer);
      proc.stdin.end();
      const line = buf.subarray(0, nl);
      resolve({ bytes: line.length, msg: JSON.parse(line.toString('utf8')), proc });
    });
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: '1', method: 'tools/call',
      params: { name: tool, arguments: args },
    }) + '\n');
  });
}

async function bash(command, serverArgs = []) {
  const { bytes, msg } = await callRaw('bash', { command, timeout: 60 }, serverArgs);
  assert.ok(!msg.error, `unexpected protocol error: ${JSON.stringify(msg.error)}`);
  return { bytes, sc: msg.result?.structuredContent ?? {}, msg };
}

describe('result budget — encoded size', () => {
  test('binary output whose escaping would triple the size is cut to fit', async () => {
    // 2 MB of NUL bytes escapes to 12.3 MB: this is the payload shape that
    // killed the client before the budget existed.
    const { bytes, sc } = await bash('head -c 2000000 /dev/zero');
    assert.ok(bytes <= 8 * 1024 * 1024, `line must fit the 8 MiB default, got ${bytes}`);
    assert.equal(sc.result_truncated, true, 'the caller must be told');
    assert.equal(sc.stdout_truncated, true);
    assert.ok(sc.stdout_dropped_bytes > 0, 'the dropped byte count must be reported');
    assert.ok(sc.result_dropped_bytes >= sc.stdout_dropped_bytes);
    assert.ok(sc.stdout.includes('omitted to fit the result budget'),
      'the cut value explains itself');
    assert.equal(sc.exit_code, 0);
  });

  test('a large text result keeps both ends and stays under the budget', async () => {
    const budget = 262144;
    const { bytes, sc } = await bash('yes hello | head -c 400002',
      ['--max-result-bytes', String(budget)]);
    assert.ok(bytes <= budget, `line ${bytes} must fit budget ${budget}`);
    assert.equal(sc.result_truncated, true);
    assert.match(sc.stdout, /^hello\nhello\n/, 'the head of the output survives');
    assert.match(sc.stdout, /hello\n$/, 'and so does the tail');
    assert.ok(sc.stdout.includes('omitted to fit the result budget'), 'the cut is marked');
    assert.ok(sc.stdout.length > budget / 4, 'the budget should actually be used');
  });

  test('the model-facing text keeps a usable preview of its own', async () => {
    const { msg } = await callRaw('bash', { command: 'seq 1 1000000', timeout: 60 },
      ['--max-result-bytes', '262144']);
    const text = msg.result.content[0].text;
    assert.ok(text.length > 8192, `text preview too small: ${text.length}`);
    assert.match(text, /^1\n2\n3\n/, 'the text still starts with the output');
    assert.ok(text.includes('result truncated'), 'the text says it was cut');
  });

  test('a result that fits is untouched', async () => {
    const { bytes, sc } = await bash('echo small', ['--max-result-bytes', '4096']);
    assert.ok(bytes < 4096);
    assert.equal(sc.result_truncated, undefined);
    assert.equal(sc.stdout, 'small\n');
  });

  test('--max-result-bytes 0 disables the budget (for hosts that raise the buffer)', async () => {
    const { bytes, sc } = await bash('head -c 1000000 /dev/zero', ['--max-result-bytes', '0']);
    assert.ok(bytes > 5 * 1024 * 1024, `expected the raw 6 MB message, got ${bytes}`);
    assert.equal(sc.result_truncated, undefined);
    assert.equal(sc.stdout.length, 1000000);
  });

  test('a terminal stream is trimmed by the same budget', async () => {
    const budget = 262144;
    const serverArgs = ['--max-result-bytes', String(budget), '--session-log-limit', '4194304'];
    // Create the session, then flood it with NULs (which the log keeps raw).
    const proc = spawn(BOXSH, ['--rpc', '--workers', '1', ...serverArgs]);
    const send = (tool, args) => new Promise((resolve, reject) => {
      const id = String(Math.floor(Math.random() * 1e6));
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('timeout')), 60000);
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        proc.stdout.off('data', onData);
        clearTimeout(timer);
        resolve(JSON.parse(buf.subarray(0, nl).toString('utf8')));
      };
      proc.stdout.on('data', onData);
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args },
      }) + '\n');
    });
    try {
      const created = await send('run_in_terminal', { command: 'bash' });
      const id = created.result.structuredContent.id;
      await send('send_to_terminal', { id, command: 'head -c 2000000 /dev/zero\n', wait_ms: 2500 });
      const read = await send('get_terminal_output', { id, cursor: 0, wait_ms: 500 });
      const line = JSON.stringify(read).length;
      const sc = read.result.structuredContent;
      assert.ok(line <= budget, `terminal result ${line} must fit budget ${budget}`);
      assert.equal(sc.result_truncated, true);
      assert.equal(sc.stream_truncated, true);
      assert.ok(sc.stream_dropped_bytes > 0);
      await send('kill_terminal', { id });
    } finally {
      proc.stdin.end();
      setTimeout(() => proc.kill(), 500);
    }
  });

  test('an image that cannot fit the budget is reported, not sent broken', async () => {
    const png = path.join(os.tmpdir(), `boxsh-budget-${process.pid}.png`);
    tempFiles.push(png);
    fs.writeFileSync(png, makePng(600, 600));     // comfortably larger than 64 KiB
    const { msg } = await callRaw('view_image', { path: png },
      ['--max-result-bytes', '65536'], 30000);
    const content = msg.result?.content ?? [];
    assert.equal(msg.result?.isError, true, 'must fail rather than deliver a broken image');
    assert.ok(!content.some(c => c.type === 'image'), 'no image block may be sent');
    assert.equal(msg.result.structuredContent.code, 'E_TOO_LARGE');
  });
});
