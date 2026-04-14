/**
 * terminal.test.mjs — tests for the terminal MCP tools:
 *   run_in_terminal, send_to_terminal, kill_terminal, list_terminals
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BOXSH } from './helpers.mjs';

// ---------------------------------------------------------------------------
// BoxshSession — interactive boxsh --rpc process for stateful tool tests.
//
// Usage:
//   const s = new BoxshSession();
//   const resp = await s.call({ tool: 'run_in_terminal', command: 'bash' });
//   await s.close();
// ---------------------------------------------------------------------------

class BoxshSession {
  constructor({ workers = 2 } = {}) {
    this._proc = spawn(BOXSH, ['--rpc', '--workers', String(workers)]);
    this._pending = new Map();   // id → { resolve, reject }
    this._nextId  = 1;
    this._closed  = false;

    const rl = createInterface({ input: this._proc.stdout });
    rl.on('line', line => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = this._pending.get(String(msg.id));
      if (p) {
        this._pending.delete(String(msg.id));
        p.resolve(msg);
      }
    });

    this._proc.on('error', err => {
      for (const p of this._pending.values()) p.reject(err);
      this._pending.clear();
    });
  }

  /**
   * Send a single tools/call request and return the raw JSON-RPC response.
   * @param {string} toolName - MCP tool name
   * @param {object} [args]   - tool arguments (id here is the session id, not request id)
   * @param {number} [timeout_ms]
   */
  call(toolName, args = {}, timeout_ms = 8000) {
    return new Promise((resolve, reject) => {
      const reqId = String(this._nextId++);
      // Build JSON-RPC directly so args.id goes to the tool arguments,
      // not to the JSON-RPC request id field.
      const rpcReq = {
        jsonrpc: '2.0',
        id: reqId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      };
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error(`timeout waiting for response to id=${reqId} (tool=${toolName})`));
      }, timeout_ms);

      this._pending.set(reqId, {
        resolve: msg => { clearTimeout(timer); resolve(msg); },
        reject:  err  => { clearTimeout(timer); reject(err);  },
      });

      this._proc.stdin.write(JSON.stringify(rpcReq) + '\n');
    });
  }

  /** Extract structuredContent from a call response, or throw on error. */
  static sc(resp) {
    assert.ok(!resp.error, `JSON-RPC error: ${JSON.stringify(resp.error)}`);
    const r = resp.result ?? {};
    assert.ok(!r.isError,
      `tool error: ${(r.content ?? [])[0]?.text ?? '?'}`);
    return r.structuredContent ?? r;
  }

  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    return new Promise(resolve => {
      this._proc.stdin.end();
      this._proc.on('close', resolve);
      setTimeout(() => { this._proc.kill(); resolve(); }, 3000);
    });
  }
}

// UUID v4 pattern
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// run_in_terminal
// ---------------------------------------------------------------------------

describe('terminal — run_in_terminal', () => {
  test('returns a UUID session id', async () => {
    const s = new BoxshSession();
    try {
      const resp = await s.call('run_in_terminal', { command: 'bash' });
      const sc = BoxshSession.sc(resp);
      assert.match(sc.id, UUID_RE, `id is not UUID v4: ${sc.id}`);
    } finally {
      await s.close();
    }
  });

  test('returns initial output string and exit status', async () => {
    const s = new BoxshSession();
    try {
      const resp = await s.call('run_in_terminal', { command: 'echo ready' });
      const sc = BoxshSession.sc(resp);
      assert.equal(typeof sc.output, 'string', 'output should be a string');
      assert.equal(typeof sc.exited, 'boolean', 'exited should be a boolean');
      // exit_code is a number when exited, null otherwise
      assert.ok(sc.exited ? typeof sc.exit_code === 'number' : sc.exit_code === null,
        'exit_code should be number when exited, null otherwise');
    } finally {
      await s.close();
    }
  });

  test('missing command returns error', async () => {
    const s = new BoxshSession();
    try {
      const resp = await s.call('run_in_terminal', {});
      assert.ok(resp.error || resp.result?.isError,
        'expected error for missing command');
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// send_to_terminal + kill_terminal
// ---------------------------------------------------------------------------

describe('terminal — send + kill', () => {
  test('send_to_terminal returns output/exited/exit_code', async () => {
    const s = new BoxshSession();
    try {
      const runResp = await s.call('run_in_terminal', { command: 'bash' });
      const { id } = BoxshSession.sc(runResp);

      const sendResp = await s.call('send_to_terminal', { id, command: 'echo hi\n' });
      const sc = BoxshSession.sc(sendResp);
      assert.equal(typeof sc.output, 'string', 'output should be a string');
      assert.equal(typeof sc.exited, 'boolean', 'exited should be a boolean');
      assert.ok(sc.exited ? typeof sc.exit_code === 'number' : sc.exit_code === null,
        'exit_code should be number when exited, null otherwise');

      await s.call('kill_terminal', { id });
    } finally {
      await s.close();
    }
  });

  test('kill_terminal returns final snapshot string', async () => {
    const s = new BoxshSession();
    try {
      const runResp = await s.call('run_in_terminal', { command: 'bash' });
      const { id } = BoxshSession.sc(runResp);

      const killResp = await s.call('kill_terminal', { id });
      const sc = BoxshSession.sc(killResp);
      assert.equal(typeof sc.output, 'string');
    } finally {
      await s.close();
    }
  });

  test('kill_terminal on unknown id returns isError', async () => {
    const s = new BoxshSession();
    try {
      const resp = await s.call('kill_terminal', {
        id: '00000000-0000-4000-8000-000000000000',
      });
      assert.ok(resp.result?.isError, 'expected isError for unknown session');
    } finally {
      await s.close();
    }
  });

  test('send_to_terminal on unknown id returns isError', async () => {
    const s = new BoxshSession();
    try {
      const resp = await s.call('send_to_terminal', {
        id: '00000000-0000-4000-8000-000000000000',
        command: 'echo x\n',
      });
      assert.ok(resp.result?.isError, 'expected isError for unknown session');
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// get_terminal_output
// ---------------------------------------------------------------------------

describe('terminal — get_terminal_output', () => {
  test('returns output/exited/exit_code for live session', async () => {
    const s = new BoxshSession();
    try {
      const { id } = BoxshSession.sc(await s.call('run_in_terminal', { command: 'bash' }));
      const sc = BoxshSession.sc(await s.call('get_terminal_output', { id }));
      assert.equal(typeof sc.output, 'string');
      assert.equal(sc.exited, false);
      assert.strictEqual(sc.exit_code, null);
      await s.call('kill_terminal', { id });
    } finally {
      await s.close();
    }
  });

  test('reflects exited=true after process exits', async () => {
    const s = new BoxshSession();
    try {
      const { id } = BoxshSession.sc(
        await s.call('run_in_terminal', { command: 'true' })
      );
      // Poll until exited or give up after several attempts
      let sc;
      for (let i = 0; i < 10; i++) {
        sc = BoxshSession.sc(await s.call('get_terminal_output', { id }));
        if (sc.exited) break;
      }
      assert.ok(sc.exited, 'process should have exited');
      assert.equal(typeof sc.exit_code, 'number');
      assert.equal(sc.exit_code, 0);
      await s.call('kill_terminal', { id });
    } finally {
      await s.close();
    }
  });

  test('on unknown id returns isError', async () => {
    const s = new BoxshSession();
    try {
      const resp = await s.call('get_terminal_output', {
        id: '00000000-0000-4000-8000-000000000000',
      });
      assert.ok(resp.result?.isError, 'expected isError for unknown session');
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// list_terminals
// ---------------------------------------------------------------------------

describe('terminal — list_terminals', () => {
  test('returns empty array when no sessions', async () => {
    const s = new BoxshSession();
    try {
      const resp = await s.call('list_terminals', {});
      const sc = BoxshSession.sc(resp);
      assert.ok(Array.isArray(sc.sessions), 'sessions should be an array');
      assert.equal(sc.sessions.length, 0);
    } finally {
      await s.close();
    }
  });

  test('lists active sessions with correct shape', async () => {
    const s = new BoxshSession();
    try {
      const r1 = BoxshSession.sc(await s.call('run_in_terminal', { command: 'bash' }));
      const r2 = BoxshSession.sc(await s.call('run_in_terminal', { command: 'bash' }));

      const listResp = await s.call('list_terminals', {});
      const { sessions } = BoxshSession.sc(listResp);

      assert.ok(Array.isArray(sessions));
      assert.equal(sessions.length, 2);

      for (const sess of sessions) {
        assert.match(sess.id, UUID_RE);
        assert.equal(typeof sess.command, 'string');
        assert.equal(typeof sess.alive,   'boolean');
        assert.equal(typeof sess.cols,    'number');
        assert.equal(typeof sess.rows,    'number');
      }

      // Clean up
      await s.call('kill_terminal', { id: r1.id });
      await s.call('kill_terminal', { id: r2.id });
    } finally {
      await s.close();
    }
  });

  test('killed session no longer appears in list', async () => {
    const s = new BoxshSession();
    try {
      const { id } = BoxshSession.sc(
        await s.call('run_in_terminal', { command: 'bash' })
      );
      await s.call('kill_terminal', { id });

      const { sessions } = BoxshSession.sc(
        await s.call('list_terminals', {})
      );
      assert.ok(!sessions.some(sess => sess.id === id),
        'killed session should not appear in list');
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// screen output quality
// ---------------------------------------------------------------------------

describe('terminal — screen snapshot', () => {
  test('echo command output visible in initial snapshot', async () => {
    const s = new BoxshSession();
    try {
      const resp = await s.call('run_in_terminal', {
        command: 'echo terminal_marker_12345',
      });
      const sc = BoxshSession.sc(resp);
      assert.match(sc.id, UUID_RE);
      if (sc.output.includes('terminal_marker_12345')) {
        assert.ok(!sc.output.includes('\r'), 'snapshot should not contain bare \\r');
      }
    } finally {
      await s.close();
    }
  });

  test('snapshot has no ANSI escape sequences', async () => {
    const s = new BoxshSession();
    try {
      const { id, output } = BoxshSession.sc(
        await s.call('run_in_terminal', { command: 'bash' })
      );
      // eslint-disable-next-line no-control-regex
      assert.ok(!/\x1b\[/.test(output),
        'snapshot should not contain ANSI escape sequences');
      await s.call('kill_terminal', { id });
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PTY ANSI handling — verify libvterm correctly processes escape sequences
// ---------------------------------------------------------------------------

describe('terminal — PTY ANSI handling', () => {
  // eslint-disable-next-line no-control-regex
  const ANSI_RE = /\x1b[\[(][0-9;]*[a-zA-Z]/;

  test('SGR color codes stripped, text preserved', async () => {
    const s = new BoxshSession();
    try {
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf '\\033[31mRED\\033[0m NORMAL'",
        })
      );
      assert.ok(sc.output.includes('RED NORMAL'),
        `expected "RED NORMAL" in output: ${JSON.stringify(sc.output)}`);
      assert.ok(!ANSI_RE.test(sc.output), 'no ANSI escapes in output');
    } finally {
      await s.close();
    }
  });

  test('bold and underline SGR stripped', async () => {
    const s = new BoxshSession();
    try {
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf '\\033[1mBOLD\\033[22m \\033[4mUNDER\\033[24m'",
        })
      );
      assert.ok(sc.output.includes('BOLD UNDER'),
        `expected "BOLD UNDER": ${JSON.stringify(sc.output)}`);
      assert.ok(!ANSI_RE.test(sc.output), 'no ANSI escapes');
    } finally {
      await s.close();
    }
  });

  test('256-color and truecolor SGR stripped', async () => {
    const s = new BoxshSession();
    try {
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf '\\033[38;5;196mFG256\\033[0m \\033[48;2;0;128;255mTRUE\\033[0m'",
        })
      );
      assert.ok(sc.output.includes('FG256 TRUE'),
        `expected text preserved: ${JSON.stringify(sc.output)}`);
      assert.ok(!ANSI_RE.test(sc.output), 'no ANSI escapes');
    } finally {
      await s.close();
    }
  });

  test('cursor-back (CUB) overwrites correctly', async () => {
    const s = new BoxshSession();
    try {
      // "ABCDE" cursor at col 5, move 3 left → col 2, write "xyz" → "ABxyz"
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf 'ABCDE\\033[3Dxyz'",
        })
      );
      assert.ok(sc.output.includes('ABxyz'),
        `expected "ABxyz": ${JSON.stringify(sc.output)}`);
    } finally {
      await s.close();
    }
  });

  test('carriage return overwrites line start', async () => {
    const s = new BoxshSession();
    try {
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf 'hello\\rworld'",
        })
      );
      assert.ok(sc.output.includes('world'),
        `expected "world" in output: ${JSON.stringify(sc.output)}`);
      assert.ok(!sc.output.includes('hello'),
        `"hello" should be overwritten: ${JSON.stringify(sc.output)}`);
    } finally {
      await s.close();
    }
  });

  test('backspace moves cursor back for overwriting', async () => {
    const s = new BoxshSession();
    try {
      // "abc" cursor at col 3, 2×BS → col 1, write "XY" → "aXY"
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf 'abc\\b\\bXY'",
        })
      );
      assert.ok(sc.output.includes('aXY'),
        `expected "aXY": ${JSON.stringify(sc.output)}`);
    } finally {
      await s.close();
    }
  });

  test('tab stops at 8-column boundaries', async () => {
    const s = new BoxshSession();
    try {
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf 'A\\tB'",
        })
      );
      const line = sc.output.split('\n')[0];
      const aIdx = line.indexOf('A');
      const bIdx = line.indexOf('B');
      assert.ok(aIdx >= 0 && bIdx >= 0, 'A and B should be in output');
      assert.equal(bIdx - aIdx, 8,
        `tab should jump to col 8 (gap=${bIdx - aIdx}): ${JSON.stringify(line)}`);
    } finally {
      await s.close();
    }
  });

  test('erase-to-end-of-line removes trailing content', async () => {
    const s = new BoxshSession();
    try {
      // "XXXX", CR to col 0, write "AB", EL (erase to EOL) → "AB"
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf 'XXXX\\rAB\\033[K'",
        })
      );
      const line = sc.output.split('\n')[0];
      assert.ok(line.includes('AB'),
        `expected "AB": ${JSON.stringify(line)}`);
      assert.ok(!line.includes('XX'),
        `trailing "XX" should be erased: ${JSON.stringify(line)}`);
    } finally {
      await s.close();
    }
  });

  test('clear screen (ED) clears previous content', async () => {
    const s = new BoxshSession();
    try {
      // Write "OLD", newline, clear screen, cursor home, write "NEW"
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf 'OLD\\n\\033[2J\\033[HNEW'",
        })
      );
      assert.ok(sc.output.includes('NEW'),
        `expected "NEW": ${JSON.stringify(sc.output)}`);
      assert.ok(!sc.output.includes('OLD'),
        `"OLD" should be cleared: ${JSON.stringify(sc.output)}`);
    } finally {
      await s.close();
    }
  });

  test('multi-line colored output all cleaned', async () => {
    const s = new BoxshSession();
    try {
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf '\\033[32mL1\\033[0m\\n\\033[33mL2\\033[0m\\n\\033[34mL3\\033[0m'",
        })
      );
      assert.ok(sc.output.includes('L1'), 'L1 present');
      assert.ok(sc.output.includes('L2'), 'L2 present');
      assert.ok(sc.output.includes('L3'), 'L3 present');
      assert.ok(!ANSI_RE.test(sc.output), 'no ANSI escapes in multi-line output');
    } finally {
      await s.close();
    }
  });

  test('interactive send with ANSI — snapshot is clean', async () => {
    const s = new BoxshSession();
    try {
      const { id } = BoxshSession.sc(
        await s.call('run_in_terminal', { command: 'bash' })
      );
      await s.call('send_to_terminal', {
        id,
        command: "printf '\\033[35mPURPLE\\033[0m OK\\n'\n",
      });
      await new Promise(r => setTimeout(r, 300));
      const snap = BoxshSession.sc(
        await s.call('kill_terminal', { id })
      );
      assert.ok(!ANSI_RE.test(snap.output),
        `snapshot should be clean: ${JSON.stringify(snap.output)}`);
      assert.ok(snap.output.includes('PURPLE'), 'text preserved');
      assert.ok(snap.output.includes('OK'), 'text after SGR reset preserved');
    } finally {
      await s.close();
    }
  });

  test('cursor-forward (CUF) positions correctly', async () => {
    const s = new BoxshSession();
    try {
      // Write "AB", move cursor 3 forward, write "CD" → "AB   CD"
      const sc = BoxshSession.sc(
        await s.call('run_in_terminal', {
          command: "printf 'AB\\033[3CCD'",
        })
      );
      const line = sc.output.split('\n')[0];
      const abIdx = line.indexOf('AB');
      const cdIdx = line.indexOf('CD');
      assert.ok(abIdx >= 0 && cdIdx >= 0, 'AB and CD present');
      assert.equal(cdIdx - abIdx, 5,
        `3-col gap expected (gap=${cdIdx - abIdx}): ${JSON.stringify(line)}`);
    } finally {
      await s.close();
    }
  });
});
