/**
 * terminal-stream.test.mjs — the session output model:
 *
 *   * the raw log (lossless bytes + absolute cursor) next to the screen view;
 *   * wait semantics (wait_for / wait_ms) so a one-shot command can be run and
 *     collected in a single call;
 *   * capture_status (per-command exit code in a persistent shell session);
 *   * lifecycle: exited sessions are hidden and reaped, and sessions are capped.
 *
 * These are the behaviours the round-3 evaluation of the terminal tools found
 * missing (silent output loss above the viewport, no completion signal, no
 * exit code, no reaping) — see plans/terminal-session-unification-plan-2026-09-20.md.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BoxshSession } from './helpers.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Split a raw PTY stream into lines (the tty writes CRLF). */
const streamLines = (s) => (s ?? '').split('\n').map(l => l.replace(/\r$/, ''));

/** Assert a raw response is a tool error carrying `code`. */
function assertToolError(resp, code) {
  assert.ok(!resp.error, `expected a tool error, got JSON-RPC error: ${JSON.stringify(resp.error)}`);
  const r = resp.result ?? {};
  assert.equal(r.isError, true, 'expected isError=true');
  const sc = r.structuredContent ?? {};
  assert.equal(sc.code, code, `expected ${code}, got ${sc.code} (${sc.message})`);
}

/** Create a session and always hand back its id for cleanup. */
async function withSession(s, args, fn) {
  const started = BoxshSession.sc(await s.call('run_in_terminal', args));
  try {
    return await fn(started);
  } finally {
    await s.call('kill_terminal', { id: started.id }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// wait semantics
// ---------------------------------------------------------------------------

describe('terminal — wait_for / wait_ms', () => {
  test('wait_for:"exit" returns the complete output and exit code in one call', async () => {
    const s = new BoxshSession();
    try {
      const t0 = Date.now();
      const r = BoxshSession.sc(await s.call('run_in_terminal', {
        command: 'seq 1 100 | sed "s/^/N-/"',
        wait_for: 'exit',
        wait_ms: 20000,
      }));
      const lines = streamLines(r.stream).filter(l => /^N-\d+$/.test(l));
      assert.equal(r.exited, true, 'process should have exited within the wait');
      assert.equal(r.exit_code, 0);
      assert.equal(lines.length, 100, `expected all 100 lines in one call, got ${lines.length}`);
      assert.equal(lines[0], 'N-1');
      assert.equal(lines[99], 'N-100');
      assert.equal(r.truncated_before, false);
      assert.ok(Date.now() - t0 < 20000, 'must not wait for the full budget');
      await s.call('kill_terminal', { id: r.id });
    } finally {
      await s.close();
    }
  });

  test('a one-shot command that exits immediately reports exited=true up front', async () => {
    const s = new BoxshSession();
    try {
      const r = BoxshSession.sc(await s.call('run_in_terminal', { command: 'true' }));
      assert.equal(r.exited, true, 'exited must be settled when the process is gone');
      assert.equal(r.exit_code, 0);
    } finally {
      await s.close();
    }
  });

  test('wait_for:"none" does not wait', async () => {
    const s = new BoxshSession();
    try {
      const t0 = Date.now();
      const r = BoxshSession.sc(await s.call('run_in_terminal', {
        command: 'sleep 30', wait_for: 'none',
      }));
      const elapsed = Date.now() - t0;
      assert.equal(r.exited, false);
      assert.ok(elapsed < 1000, `wait_for:"none" took ${elapsed}ms`);
      await s.call('kill_terminal', { id: r.id });
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// raw log (lossless channel)
// ---------------------------------------------------------------------------

describe('terminal — raw output log', () => {
  test('the raw stream keeps what the screen scrolled off', async () => {
    const s = new BoxshSession();
    try {
      await withSession(s, { command: 'bash' }, async ({ id }) => {
        await s.call('send_to_terminal', { id, command: "seq 1 60 | sed 's/^/SEQ-/'\n" });
        await sleep(400);

        const screen = BoxshSession.sc(await s.call('get_terminal_output', { id }));
        const stream = BoxshSession.sc(await s.call('get_terminal_output', { id, cursor: 0 }));

        const seen = streamLines(stream.stream)
          .map(l => (l.match(/SEQ-(\d+)/) ?? [])[1])
          .filter(Boolean).map(Number);
        const missing = [];
        for (let i = 1; i <= 60; i++) if (!seen.includes(i)) missing.push(i);
        assert.deepEqual(missing, [], `raw stream lost lines: ${missing.join(',')}`);
        assert.ok(!screen.output.includes('SEQ-1\n'),
          'the screen is only a view — the first lines are expected to be gone');
        assert.equal(stream.first_cursor, 0);
        assert.ok(stream.next_cursor >= 60 * 5);
        assert.equal(stream.truncated_before, false);
        assert.equal(stream.total_bytes, stream.next_cursor);
      });
    } finally {
      await s.close();
    }
  });

  test('a cursor read returns only what arrived after it', async () => {
    const s = new BoxshSession();
    try {
      await withSession(s, { command: 'bash' }, async ({ id }) => {
        const first = BoxshSession.sc(await s.call('send_to_terminal', {
          id, command: 'echo FIRST\n', cursor: 0, wait_ms: 800,
        }));
        assert.ok(first.stream.includes('FIRST'), 'first delta holds the first command');

        const idle = BoxshSession.sc(await s.call('get_terminal_output', {
          id, cursor: first.next_cursor, wait_ms: 300,
        }));
        assert.equal(idle.stream, '', 'an idle poll must return no bytes');
        assert.equal(idle.next_cursor, first.next_cursor);

        const second = BoxshSession.sc(await s.call('send_to_terminal', {
          id, command: 'echo SECOND\n', cursor: first.next_cursor, wait_ms: 800,
        }));
        assert.ok(second.stream.includes('SECOND'), 'second delta holds the new output');
        assert.ok(!second.stream.includes('FIRST'), 'delta must not repeat old output');
      });
    } finally {
      await s.close();
    }
  });

  test('output beyond the log limit is reported, never silently dropped', async () => {
    const s = new BoxshSession();
    try {
      const r = BoxshSession.sc(await s.call('run_in_terminal', {
        command: 'seq 1 200000', wait_for: 'exit', wait_ms: 30000, cursor: 0,
      }));
      assert.equal(r.exited, true);
      assert.ok(r.total_bytes > 1024 * 1024, `expected > 1 MiB of output, got ${r.total_bytes}`);
      assert.equal(r.truncated_before, true, 'cursor:0 must report that earlier bytes are gone');
      assert.ok(r.dropped_bytes > 0, 'dropped_bytes must count what the log no longer keeps');
      assert.ok(r.first_cursor > 0, 'first_cursor must point at the oldest retained byte');
      assert.equal(r.first_cursor + r.stream.length, r.next_cursor);
      await s.call('kill_terminal', { id: r.id });
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// capture_status
// ---------------------------------------------------------------------------

describe('terminal — capture_status', () => {
  test('reports the exit code of each command line in a persistent shell', async () => {
    const s = new BoxshSession();
    try {
      await withSession(s, { command: 'bash' }, async ({ id }) => {
        const ok = BoxshSession.sc(await s.call('send_to_terminal', {
          id, command: 'echo ok\n', capture_status: true, wait_ms: 10000,
        }));
        assert.equal(ok.command_exit_code, 0);

        const bad = BoxshSession.sc(await s.call('send_to_terminal', {
          id, command: 'false\n', capture_status: true, wait_ms: 10000,
        }));
        assert.equal(bad.command_exit_code, 1);

        const sub = BoxshSession.sc(await s.call('send_to_terminal', {
          id, command: 'sh -c "exit 7"\n', capture_status: true, wait_ms: 10000,
        }));
        assert.equal(sub.command_exit_code, 7);

        // The session's own state is untouched by the probe.
        assert.equal(sub.exited, false);
        assert.equal(sub.exit_code, null);
      });
    } finally {
      await s.close();
    }
  });

  test('the probe leaves no trace in the text or in the stream', async () => {
    const s = new BoxshSession();
    try {
      await withSession(s, { command: 'bash' }, async ({ id }) => {
        const resp = await s.call('send_to_terminal', {
          id, command: 'printf "tail-without-newline"\n',
          capture_status: true, wait_ms: 10000,
        });
        const text = (resp.result.content ?? []).map(c => c.text).join('\n');
        const r = BoxshSession.sc(resp);
        assert.ok(text.includes('tail-without-newline'), 'command output must survive');
        assert.ok(!/boxsh-status/.test(text), `probe marker leaked into text: ${JSON.stringify(text.slice(-200))}`);
        assert.ok(!/boxsh-status/.test(r.stream ?? ''), 'probe marker leaked into the stream');
        assert.ok(!/boxsh-status/.test(r.output ?? ''), 'probe echo leaked into the screen');
        assert.ok(!/\x1b/.test(text), 'text must not carry escape sequences');
      });
    } finally {
      await s.close();
    }
  });

  test('without capture_status no exit code is invented', async () => {
    const s = new BoxshSession();
    try {
      await withSession(s, { command: 'bash' }, async ({ id }) => {
        const r = BoxshSession.sc(await s.call('send_to_terminal', {
          id, command: 'false\n', wait_ms: 800,
        }));
        assert.equal(r.command_exit_code, undefined);
      });
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PTY window size
// ---------------------------------------------------------------------------

describe('terminal — PTY window size', () => {
  test('rows/cols are applied to the PTY, not only to the screen', async () => {
    const s = new BoxshSession();
    try {
      await withSession(s, { command: 'bash', rows: 30, cols: 90 }, async ({ id }) => {
        const r = BoxshSession.sc(await s.call('send_to_terminal', {
          id, command: 'stty size\n', cursor: 0, wait_ms: 1500,
        }));
        assert.match(r.stream, /30 90/, `stty size must report "30 90": ${JSON.stringify(r.stream)}`);
      });
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

describe('terminal — lifecycle', () => {
  test('list_terminals hides exited sessions unless asked', async () => {
    const s = new BoxshSession();
    try {
      const r = BoxshSession.sc(await s.call('run_in_terminal', { command: 'true' }));
      await sleep(200);
      const visible = BoxshSession.sc(await s.call('list_terminals', {}));
      const all = BoxshSession.sc(await s.call('list_terminals', { include_exited: true }));
      assert.ok(!visible.sessions.some(x => x.id === r.id),
        'an exited session must not show up by default');
      const found = all.sessions.find(x => x.id === r.id);
      assert.ok(found, 'include_exited:true must list it');
      assert.equal(found.exited, true);
      assert.equal(found.exit_code, 0);
      assert.ok(typeof found.total_bytes === 'number');
      await s.call('kill_terminal', { id: r.id });
    } finally {
      await s.close();
    }
  });

  test('exited sessions are reaped after --session-ttl', async () => {
    const s = new BoxshSession({ args: ['--session-ttl', '1'] });
    try {
      const r = BoxshSession.sc(await s.call('run_in_terminal', { command: 'true' }));
      await sleep(1500);
      const all = BoxshSession.sc(await s.call('list_terminals', { include_exited: true }));
      assert.ok(!all.sessions.some(x => x.id === r.id), 'the session should have been reaped');
      const resp = await s.call('get_terminal_output', { id: r.id });
      assertToolError(resp, 'E_NOT_FOUND');
    } finally {
      await s.close();
    }
  });

  test('--max-sessions bounds live sessions with E_TOO_MANY_SESSIONS', async () => {
    const s = new BoxshSession({ args: ['--max-sessions', '2'] });
    const ids = [];
    try {
      for (let i = 0; i < 2; i++)
        ids.push(BoxshSession.sc(await s.call('run_in_terminal', { command: 'bash' })).id);
      const resp = await s.call('run_in_terminal', { command: 'bash' });
      assertToolError(resp, 'E_TOO_MANY_SESSIONS');
    } finally {
      for (const id of ids) await s.call('kill_terminal', { id }).catch(() => {});
      await s.close();
    }
  });

  test('kill_terminal returns the final output, the exit code and whether it had to signal', async () => {
    const s = new BoxshSession();
    try {
      const live = BoxshSession.sc(await s.call('run_in_terminal', { command: 'bash' }));
      await s.call('send_to_terminal', { id: live.id, command: 'echo BEFORE-KILL\n', wait_ms: 600 });
      const killed = BoxshSession.sc(await s.call('kill_terminal', { id: live.id }));
      assert.equal(killed.killed, true, 'a running session has to be signalled');
      assert.ok(killed.stream.includes('BEFORE-KILL'), 'final output must be returned');
      assert.equal(typeof killed.exit_code, 'number');

      const gone = BoxshSession.sc(await s.call('run_in_terminal', { command: 'true' }));
      await sleep(200);
      const already = BoxshSession.sc(await s.call('kill_terminal', { id: gone.id }));
      assert.equal(already.killed, false, 'an exited session needs no signal');
      assert.equal(already.exit_code, 0);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// argument validation
// ---------------------------------------------------------------------------

describe('terminal — argument validation', () => {
  test('bad arguments are E_INVALID_ARGUMENT tool errors', async () => {
    const s = new BoxshSession();
    try {
      assertToolError(await s.call('run_in_terminal', { command: 'bash', rows: 0 }),
        'E_INVALID_ARGUMENT');
      assertToolError(await s.call('run_in_terminal', { command: 'bash', cols: 5000 }),
        'E_INVALID_ARGUMENT');
      assertToolError(await s.call('run_in_terminal', { command: 'bash', wait_for: 'soon' }),
        'E_INVALID_ARGUMENT');
      assertToolError(await s.call('run_in_terminal', { command: 'bash', wait_ms: 99999999 }),
        'E_INVALID_ARGUMENT');
      const live = BoxshSession.sc(await s.call('run_in_terminal', { command: 'bash' }));
      try {
        assertToolError(await s.call('get_terminal_output', { id: live.id, cursor: -1 }),
          'E_INVALID_ARGUMENT');
        assertToolError(await s.call('send_to_terminal', {
          id: live.id, command: 'x\n', capture_status: 'yes',
        }), 'E_INVALID_ARGUMENT');
      } finally {
        await s.call('kill_terminal', { id: live.id });
      }
    } finally {
      await s.close();
    }
  });
});
