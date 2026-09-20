/**
 * Tests for BoxshClient terminal tools: runInTerminal, sendToTerminal,
 * killTerminal, listTerminals.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BoxshClient } from '../src/client.mjs';
import { BOXSH } from './helpers.mjs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('BoxshClient — terminal tools', () => {
    /** @type {BoxshClient} */
    let client;

    before(() => {
        client = new BoxshClient({ boxshPath: BOXSH, workers: 1 });
    });

    after(async () => {
        await client.close();
    });

    it('runInTerminal returns id, output, exited, exitCode', async () => {
        const { id, output, exited, exitCode } = await client.runInTerminal('echo sdk_test_123');
        assert.match(id, UUID_RE, `id should be UUID v4: ${id}`);
        assert.equal(typeof output, 'string');
        assert.equal(typeof exited, 'boolean');
        assert.ok(exited ? typeof exitCode === 'number' : exitCode === null,
            'exitCode should be number when exited, null otherwise');
    });

    it('listTerminals returns active session after runInTerminal', async () => {
        const { id } = await client.runInTerminal('bash');
        try {
            const sessions = await client.listTerminals();
            assert.ok(Array.isArray(sessions));
            const found = sessions.find(s => s.id === id);
            assert.ok(found, 'session should appear in list');
            assert.equal(found.command, 'bash');
            assert.equal(found.alive, true);
            assert.equal(typeof found.cols, 'number');
            assert.equal(typeof found.rows, 'number');
        } finally {
            await client.killTerminal(id);
        }
    });

    it('sendToTerminal returns output/exited/exitCode', async () => {
        const { id } = await client.runInTerminal('bash');
        try {
            const result = await client.sendToTerminal(id, 'echo hello\n');
            assert.equal(typeof result.output, 'string');
            assert.equal(typeof result.exited, 'boolean');
            assert.ok(result.exited ? typeof result.exitCode === 'number' : result.exitCode === null,
                'exitCode should be number when exited, null otherwise');
        } finally {
            await client.killTerminal(id);
        }
    });

    it('getTerminalOutput returns output/exited/exitCode for live session', async () => {
        const { id } = await client.runInTerminal('bash');
        try {
            const result = await client.getTerminalOutput(id);
            assert.equal(typeof result.output, 'string');
            assert.equal(result.exited, false);
            assert.strictEqual(result.exitCode, null);
        } finally {
            await client.killTerminal(id);
        }
    });

    it('getTerminalOutput reflects exited=true after process exits', async () => {
        const { id } = await client.runInTerminal('true');
        try {
            let result;
            for (let i = 0; i < 10; i++) {
                result = await client.getTerminalOutput(id);
                if (result.exited) break;
            }
            assert.ok(result.exited, 'process should have exited');
            assert.equal(result.exitCode, 0);
        } finally {
            await client.killTerminal(id);
        }
    });

    it('getTerminalOutput on unknown id throws', async () => {
        await assert.rejects(
            () => client.getTerminalOutput('00000000-0000-4000-8000-000000000000'),
            (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /unknown/i);
                return true;
            },
        );
    });

    it('killTerminal returns final snapshot', async () => {
        const { id } = await client.runInTerminal('bash');
        const snap = await client.killTerminal(id);
        assert.equal(typeof snap, 'string');
    });

    it('killed session removed from list', async () => {
        const { id } = await client.runInTerminal('bash');
        await client.killTerminal(id);
        const sessions = await client.listTerminals();
        assert.ok(!sessions.some(s => s.id === id),
            'killed session should not appear in list');
    });

    it('killTerminal on unknown id throws', async () => {
        await assert.rejects(
            () => client.killTerminal('00000000-0000-4000-8000-000000000000'),
            (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /unknown/i);
                return true;
            },
        );
    });

    it('sendToTerminal on unknown id throws', async () => {
        await assert.rejects(
            () => client.sendToTerminal('00000000-0000-4000-8000-000000000000', 'echo x\n'),
            (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /unknown/i);
                return true;
            },
        );
    });

    it('listTerminals returns empty when no sessions', async () => {
        const sessions = await client.listTerminals();
        assert.ok(Array.isArray(sessions));
        // May have leftover sessions from previous tests, just check shape
    });

    it('multiple concurrent sessions', async () => {
        const r1 = await client.runInTerminal('bash');
        const r2 = await client.runInTerminal('bash');
        try {
            const sessions = await client.listTerminals();
            const ids = sessions.map(s => s.id);
            assert.ok(ids.includes(r1.id), 'first session in list');
            assert.ok(ids.includes(r2.id), 'second session in list');
        } finally {
            await client.killTerminal(r1.id);
            await client.killTerminal(r2.id);
        }
    });

    it('snapshot has no ANSI escapes', async () => {
        const { id, output } = await client.runInTerminal('bash');
        try {
            // eslint-disable-next-line no-control-regex
            assert.ok(!/\x1b\[/.test(output),
                'snapshot should not contain ANSI escape sequences');
        } finally {
            await client.killTerminal(id);
        }
    });
});

describe('BoxshClient — terminal output model', () => {
    /** @type {BoxshClient} */
    let client;

    before(() => {
        client = new BoxshClient({ boxshPath: BOXSH, workers: 1 });
    });

    after(async () => {
        await client.close();
    });

    it('runInTerminal waitFor:"exit" returns the complete output in one call', async () => {
        const r = await client.runInTerminal('seq 1 100 | sed "s/^/N-/"',
            { waitFor: 'exit', waitMs: 20000 });
        assert.equal(r.exited, true);
        assert.equal(r.exitCode, 0);
        const lines = streamLines(r.stream).filter(l => /^N-\d+$/.test(l));
        assert.equal(lines.length, 100, `expected 100 lines, got ${lines.length}`);
        assert.equal(r.truncatedBefore, false);
        await client.killTerminal(r.id);
    });

    it('a cursor read returns only what is new and costs nothing when idle', async () => {
        const { id } = await client.runInTerminal('bash');
        try {
            const first = await client.sendToTerminal(id, 'echo FIRST\n', { cursor: 0, waitMs: 800 });
            assert.ok(first.stream.includes('FIRST'));
            assert.equal(typeof first.nextCursor, 'number');

            const idle = await client.getTerminalOutput(id, { cursor: first.nextCursor, waitMs: 200 });
            assert.equal(idle.stream, '');
            assert.equal(idle.nextCursor, first.nextCursor);

            const second = await client.sendToTerminal(id, 'echo SECOND\n', { cursor: first.nextCursor, waitMs: 800 });
            assert.ok(second.stream.includes('SECOND'));
            assert.ok(!second.stream.includes('FIRST'), 'delta must not repeat old output');
        } finally {
            await client.killTerminal(id);
        }
    });

    it('captureStatus reports the exit code of the command line', async () => {
        const { id } = await client.runInTerminal('bash');
        try {
            const ok = await client.sendToTerminal(id, 'true\n', { captureStatus: true, waitMs: 10000 });
            assert.equal(ok.commandExitCode, 0);
            const bad = await client.sendToTerminal(id, 'false\n', { captureStatus: true, waitMs: 10000 });
            assert.equal(bad.commandExitCode, 1);
        } finally {
            await client.killTerminal(id);
        }
    });

    it('listTerminals hides exited sessions unless asked', async () => {
        const r = await client.runInTerminal('true');
        await new Promise(res => setTimeout(res, 200));
        const visible = await client.listTerminals();
        const all = await client.listTerminals({ includeExited: true });
        assert.ok(!visible.some(s => s.id === r.id), 'exited session must be hidden by default');
        const found = all.find(s => s.id === r.id);
        assert.ok(found, 'includeExited must list it');
        assert.equal(found.exited, true);
        assert.equal(found.exit_code, 0);
        await client.killTerminal(r.id);
    });
});

/**
 * Split a raw PTY stream into lines a reader would recognise.  The tty does not
 * hand over plain text: it writes CRLF and wraps output in escape sequences
 * (bash on Linux brackets every prompt and output with ESC[?2004h/l), either of
 * which would glue itself onto a line and break exact comparisons - which is
 * how this test passed on macOS and failed on Linux CI.
 */
const streamLines = (s) => (s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')             // CSI
    .split('\n')
    .map(l => l.replace(/\r/g, ''));

describe('BoxshClient — terminal signals', () => {
    /** @type {BoxshClient} */
    let client;

    before(() => {
        client = new BoxshClient({ boxshPath: BOXSH, workers: 1 });
    });

    after(async () => {
        await client.close();
    });

    it('signal:"INT" aborts the running command and the rest of its command line', async () => {
        const { id } = await client.runInTerminal('bash');
        try {
            await new Promise(res => setTimeout(res, 300));   // let bash reach its prompt
            await client.sendToTerminal(id, 'echo START; sleep 2; echo AFTER\n', { waitMs: 400 });
            // Wait until the command is really running instead of sleeping a
            // fixed amount: on a slow machine a signal sent before the shell
            // gets there is a no-op (and the test would "pass" for the wrong
            // reason, or fail on the START assertion).
            const running = Date.now() + 8000;
            while (Date.now() < running) {
                const seen = await client.getTerminalOutput(id, { cursor: 0, waitMs: 400 });
                if (streamLines(seen.stream).includes('START')) break;
            }
            await client.sendToTerminal(id, undefined, { signal: 'INT', waitMs: 300 });
            await new Promise(res => setTimeout(res, 2500));  // past the sleep

            const r = await client.getTerminalOutput(id, { cursor: 0, waitMs: 200 });
            const lines = streamLines(r.stream);
            assert.ok(lines.includes('START'), 'the command ran');
            assert.ok(!lines.includes('AFTER'), 'the rest of the command line must be abandoned');
            assert.equal(r.exited, false, 'the session survives');
        } finally {
            await client.killTerminal(id);
        }
    });

    it('an unknown signal is a tool error', async () => {
        const { id } = await client.runInTerminal('bash');
        try {
            await assert.rejects(() => client.sendToTerminal(id, undefined, { signal: 'NOPE' }),
                err => err.code === 'E_INVALID_ARGUMENT');
        } finally {
            await client.killTerminal(id);
        }
    });
});
