/**
 * cancel.test.mjs — notifications/cancelled and notification silence.
 *
 * The official SDK sends `notifications/cancelled {requestId, reason}` when a
 * tool call times out, and boxsh used to answer with a protocol error carrying
 * `"id": null` (which clients reject as a schema violation) while the command
 * kept running.  A cancelled request now gets no reply at all, and what it was
 * running is stopped.
 *
 * These tests drive boxsh with raw JSON-RPC lines so they stay dependency-free.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BOXSH } from './helpers.mjs';

/** Split a raw PTY stream into lines, dropping what the tty adds around it. */
const streamLines = (s) => (s ?? '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .split('\n')
  .map(l => l.replace(/\r/g, ''));

/** Spawned boxsh whose every output line is kept, with id-based lookup. */
class RawServer {
  constructor(args = []) {
    this.proc = spawn(BOXSH, ['--rpc', '--workers', '2', ...args]);
    this.lines = [];
    this.byId = new Map();
    this._buf = Buffer.alloc(0);
    this._waiters = [];
    this.proc.stdout.on('data', d => {
      this._buf = Buffer.concat([this._buf, d]);
      let nl;
      while ((nl = this._buf.indexOf(0x0a)) !== -1) {
        const raw = this._buf.subarray(0, nl).toString('utf8');
        this._buf = this._buf.subarray(nl + 1);
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        this.lines.push(msg);
        if (msg.id !== undefined && msg.id !== null) this.byId.set(String(msg.id), msg);
        for (const w of [...this._waiters]) w();
      }
    });
  }

  send(obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }
  call(tool, args, id) {
    this.send({ jsonrpc: '2.0', id: String(id), method: 'tools/call',
                params: { name: tool, arguments: args } });
  }
  response(id) { return this.byId.get(String(id)); }

  /** Wait until `pred()` (or `ms` passes); returns whether it came true. */
  async waitFor(pred, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await new Promise(r => {
        const t = setTimeout(() => { this._waiters = this._waiters.filter(w => w !== done); r(); }, 25);
        const done = () => { clearTimeout(t); r(); };
        this._waiters.push(done);
      });
    }
    return pred();
  }
  close() { this.proc.stdin.end(); setTimeout(() => this.proc.kill(), 500); }
}

const tempFile = () => {
  const p = path.join(os.tmpdir(), `boxsh-cancel-${process.pid}-${Math.random().toString(16).slice(2)}`);
  return p;
};

describe('MCP cancellation', () => {
  test('cancelling a running command stops it and sends no reply', async () => {
    const marker = tempFile();
    const s = new RawServer(['--command-timeout', '0']);
    try {
      // A command that would run for 30s and reports each second.
      s.call('bash', { command: `for i in $(seq 1 30); do echo tick >> ${marker}; sleep 1; done; echo DONE`, timeout: 0 }, 'cmd');
      assert.ok(await s.waitFor(() => fs.existsSync(marker) &&
        fs.readFileSync(marker, 'utf8').trim().split('\n').length >= 2, 8000),
        'the command should have started');

      s.notify('notifications/cancelled', { requestId: 'cmd', reason: 'Request timed out' });

      // No reply for the cancelled id - MCP gives a cancelled request none.
      await new Promise(r => setTimeout(r, 1500));
      assert.equal(s.response('cmd'), undefined, 'a cancelled request must not be answered');

      // The command's process group is gone: the marker stops growing and the
      // trailing `echo DONE` never runs.
      const ticks = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0);
      const after = ticks();
      await new Promise(r => setTimeout(r, 2500));
      assert.equal(ticks(), after, 'the command must not keep running');
      assert.ok(!fs.readFileSync(marker, 'utf8').includes('DONE'), 'the rest never ran');

      // ...and the pool is still usable (the worker was respawned).
      s.call('bash', { command: 'echo after-cancel' }, 'next');
      assert.ok(await s.waitFor(() => s.response('next'), 15000), 'a later request must work');
      assert.equal(s.response('next').result.structuredContent.stdout, 'after-cancel\n');
    } finally {
      s.close();
      try { fs.unlinkSync(marker); } catch { /* gone */ }
    }
  });

  test('cancelling a terminal command interrupts it but keeps the session', async () => {
    const s = new RawServer();
    try {
      s.call('run_in_terminal', { command: 'bash' }, 'run');
      assert.ok(await s.waitFor(() => s.response('run'), 10000));
      const session = s.response('run').result.structuredContent.id;

      // capture_status makes this call "run this command line", so cancelling it
      // is expected to stop that command.
      s.call('send_to_terminal',
        { id: session, command: 'sleep 20; echo NEVER\n', capture_status: true, wait_ms: 300000 }, 'send');
      // Give the call time to be dispatched *and* the shell time to start the
      // command: a cancel that arrives first matches nothing (and is a no-op by
      // design), which would make the rest of this test meaningless.
      await new Promise(r => setTimeout(r, 700));
      s.notify('notifications/cancelled', { requestId: 'send', reason: 'cancelled' });
      await new Promise(r => setTimeout(r, 1000));
      assert.equal(s.response('send'), undefined, 'no reply for the cancelled call');

      // The session survived and is usable again.
      s.call('send_to_terminal', { id: session, command: 'echo ALIVE\n', wait_ms: 2000 }, 'alive');
      assert.ok(await s.waitFor(() => s.response('alive'), 15000), 'the session must still answer');
      assert.ok(streamLines(s.response('alive').result.structuredContent.stream).includes('ALIVE'));

      // ...and the interrupted command never ran to its echo.  Whole lines only:
      // the tty echoes the command line, so a substring check would match the
      // echo of `... echo NEVER` itself.
      s.call('get_terminal_output', { id: session, cursor: 0, wait_ms: 500 }, 'read');
      assert.ok(await s.waitFor(() => s.response('read'), 5000));
      assert.ok(!streamLines(s.response('read').result.structuredContent.stream).includes('NEVER'),
        'the cancelled command must not run to completion');

      s.call('kill_terminal', { id: session }, 'kill');
      await s.waitFor(() => s.response('kill'), 5000);
    } finally {
      s.close();
    }
  });

  test('notifications are never answered (including unknown ones)', async () => {
    const s = new RawServer();
    try {
      s.notify('notifications/initialized');
      s.notify('notifications/progress', { progressToken: 'x', progress: 1, total: 2 });
      s.notify('notifications/unknown/thing', { whatever: true });
      await new Promise(r => setTimeout(r, 800));
      assert.deepEqual(s.lines, [], `notifications must produce no output, got ${JSON.stringify(s.lines)}`);

      // The connection is healthy afterwards.
      s.call('bash', { command: 'echo ok' }, 'after');
      assert.ok(await s.waitFor(() => s.response('after'), 10000));
      assert.equal(s.response('after').result.structuredContent.stdout, 'ok\n');
    } finally {
      s.close();
    }
  });

  test('cancelling an unknown or already finished request is a no-op', async () => {
    const s = new RawServer();
    try {
      s.call('bash', { command: 'echo finished' }, 'done');
      assert.ok(await s.waitFor(() => s.response('done'), 10000));

      s.notify('notifications/cancelled', { requestId: 'done' });
      s.notify('notifications/cancelled', { requestId: 'never-seen' });
      await new Promise(r => setTimeout(r, 500));

      s.call('bash', { command: 'echo still-here' }, 'again');
      assert.ok(await s.waitFor(() => s.response('again'), 10000));
      assert.equal(s.response('again').result.structuredContent.stdout, 'still-here\n');
      assert.equal(s.lines.filter(l => l.id === null || l.id === undefined).length, 0,
        'no stray protocol errors');
    } finally {
      s.close();
    }
  });
});
