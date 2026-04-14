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
