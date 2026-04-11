/**
 * Tests for BoxshClient with overlay — sandbox execution, COW semantics,
 * and multi-client isolation.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BoxshClient } from '../src/client.mjs';
import { getChanges, formatChanges } from '../src/changes.mjs';
import { BOXSH } from './helpers.mjs';

// =========================================================================
// Tool error handling (no sandbox needed — tests run against bare boxsh)
// =========================================================================

describe('BoxshClient — tool error handling', () => {
    /** @type {BoxshClient} */
    let client;
    const tmpDir = path.join(os.tmpdir(), `boxsh-sdk-errors-${Date.now()}`);

    before(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
        client = new BoxshClient({ boxshPath: BOXSH, workers: 1 });
    });

    after(async () => {
        await client.close();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('read() throws on missing file', async () => {
        await assert.rejects(
            () => client.read('/nonexistent/boxsh-test-file'),
            (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /read:/);
                return true;
            },
        );
    });

    it('write() creates a new file successfully', async () => {
        const p = path.join(tmpDir, 'new-file.txt');
        await client.write(p, 'hello\n');
        assert.equal(fs.readFileSync(p, 'utf8'), 'hello\n');
    });

    it('write() throws on existing file', async () => {
        const p = path.join(tmpDir, 'existing.txt');
        fs.writeFileSync(p, 'original\n');
        await assert.rejects(
            () => client.write(p, 'overwrite\n'),
            (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /already exists/);
                return true;
            },
        );
        // File must be unchanged.
        assert.equal(fs.readFileSync(p, 'utf8'), 'original\n');
    });

    it('edit() throws on missing file', async () => {
        await assert.rejects(
            () => client.edit('/nonexistent/boxsh-test-file', [{ oldText: 'x', newText: 'y' }]),
            (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /edit:/);
                return true;
            },
        );
    });

    it('edit() throws when oldText not found', async () => {
        const p = path.join(tmpDir, 'edit-notfound.txt');
        fs.writeFileSync(p, 'hello\n');
        await assert.rejects(
            () => client.edit(p, [{ oldText: 'goodbye', newText: 'hi' }]),
            (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /not found/);
                return true;
            },
        );
    });

    it('edit() succeeds on valid replacement', async () => {
        const p = path.join(tmpDir, 'edit-ok.txt');
        fs.writeFileSync(p, 'hello world\n');
        const result = await client.edit(p, [{ oldText: 'world', newText: 'earth' }]);
        assert.equal(fs.readFileSync(p, 'utf8'), 'hello earth\n');
        assert.ok(result.diff.includes('-hello world'));
        assert.ok(result.diff.includes('+hello earth'));
    });

    it('exec() does not throw on non-zero exit code', async () => {
        const result = await client.exec('exit 42');
        assert.equal(result.exitCode, 42);
    });

    it('exec() returns stderr on failure', async () => {
        const result = await client.exec('cat /nonexistent/boxsh-test-file');
        assert.equal(result.exitCode, 1);
        assert.ok(result.stderr.length > 0);
    });
});

describe('BoxshClient — overlay sandbox', () => {
    const tmpDir  = path.join(os.tmpdir(), `boxsh-sdk-session-${Date.now()}`);
    const baseDir = path.join(tmpDir, 'project');

    before(() => {
        fs.mkdirSync(path.join(baseDir, 'src'),  { recursive: true });
        fs.mkdirSync(path.join(baseDir, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(baseDir, 'README.md'),     '# Project\n');
        fs.writeFileSync(path.join(baseDir, 'src/index.ts'),  'console.log("hello")\n');
        fs.writeFileSync(path.join(baseDir, 'src/utils.ts'),
            'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
        fs.writeFileSync(path.join(baseDir, 'docs/guide.md'), '# Guide\n');
    });

    after(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    /**
     * Create a BoxshClient backed by a fresh COW bind on top of baseDir.
     * Also returns the dstDir for assertions.
     * @param {string} id  Unique label for the COW directories.
     */
    function makeClient(id) {
        const dir    = path.join(tmpDir, id);
        const dstDir = path.join(dir, 'dst');
        fs.mkdirSync(dstDir, { recursive: true });

        const client = new BoxshClient({
            boxshPath: BOXSH,
            workers:   1,
            sandbox:   true,
            binds:     [{ mode: 'cow', src: baseDir, dst: dstDir }],
        });

        return { client, upperDir: dstDir, cwd: dstDir };
    }

    // =========================================================
    // Shell command execution via BoxshClient
    // =========================================================
    describe('Shell — basic commands', () => {
        it('should execute echo command', async () => {
            const { client, cwd } = makeClient('bash-echo');
            const result = await client.exec('echo "hello session"', cwd);
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('hello session'));
            await client.close();
        });

        it('should execute ls and list base files', async () => {
            const { client, cwd } = makeClient('bash-ls');
            const result = await client.exec('ls', cwd);
            assert.ok(result.stdout.includes('README.md'));
            assert.ok(result.stdout.includes('src'));
            await client.close();
        });

        it('should execute cat on base file', async () => {
            const { client, cwd } = makeClient('bash-cat');
            const result = await client.exec('cat README.md', cwd);
            assert.ok(result.stdout.includes('# Project'));
            await client.close();
        });

        it('should execute grep and find matches', async () => {
            const { client, cwd } = makeClient('bash-grep');
            const result = await client.exec('grep -n "export" src/utils.ts', cwd);
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('export const x'));
            await client.close();
        });

        it('should execute wc -l', async () => {
            const { client, cwd } = makeClient('bash-wc');
            const result = await client.exec('wc -l src/utils.ts', cwd);
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('3'));
            await client.close();
        });

        it('should execute head', async () => {
            const { client, cwd } = makeClient('bash-head');
            const result = await client.exec('head -n 1 src/utils.ts', cwd);
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.trim().includes('export const x = 1'));
            await client.close();
        });

        it('should execute pipeline', async () => {
            const { client, cwd } = makeClient('bash-pipe');
            const result = await client.exec(
                'cat src/utils.ts | grep "export" | wc -l',
                cwd,
            );
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.trim() === '3');
            await client.close();
        });

        it('should execute find', async () => {
            const { client, cwd } = makeClient('bash-find');
            const result = await client.exec('find src -name "*.ts"', cwd);
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('index.ts'));
            assert.ok(result.stdout.includes('utils.ts'));
            await client.close();
        });

        it('should cd into subdir and list files', async () => {
            const { client, cwd } = makeClient('bash-cd');
            const result = await client.exec('cd src && ls', cwd);
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('index.ts'));
            await client.close();
        });
    });

    // =========================================================
    // Shell write operations — COW semantics through boxsh
    // =========================================================
    describe('Shell — COW write operations', () => {
        it('should execute mkdir in cow layer', async () => {
            const { client, upperDir, cwd } = makeClient('bash-mkdir');
            const result = await client.exec('mkdir -p new-dir', cwd);
            assert.equal(result.exitCode, 0);
            assert.ok(fs.existsSync(path.join(upperDir, 'new-dir')));
            await client.close();
        });

        it('should write file via redirect into dst layer', async () => {
            const { client, upperDir, cwd } = makeClient('bash-redir');
            const result = await client.exec(
                'echo "redirected content" > output.txt',
                cwd,
            );
            assert.equal(result.exitCode, 0);
            const content = fs.readFileSync(path.join(upperDir, 'output.txt'), 'utf-8');
            assert.ok(content.includes('redirected content'));
            assert.ok(!fs.existsSync(path.join(baseDir, 'output.txt')));
            await client.close();
        });

        it('should read back written content via shell', async () => {
            const { client, cwd } = makeClient('cow-readback');
            await client.exec('echo "new data" > created.txt', cwd);
            const result = await client.exec('cat created.txt', cwd);
            assert.ok(result.stdout.includes('new data'));
            await client.close();
        });

        it('should show new files in ls after write', async () => {
            const { client, cwd } = makeClient('cow-ls');
            await client.exec('echo "x" > extra.txt', cwd);
            const result = await client.exec('ls', cwd);
            assert.ok(result.stdout.includes('extra.txt'));
            assert.ok(result.stdout.includes('README.md'));
            await client.close();
        });

        it('should detect changes after shell write', async () => {
            const { client, upperDir, cwd } = makeClient('cow-changes');
            await client.exec('echo "new" > new-file.txt', cwd);
            const changes = getChanges({ upper: upperDir, base: baseDir });
            assert.ok(changes.some((c) => c.path === 'new-file.txt' && c.type === 'added'));
            await client.close();
        });

        it('should not modify base when writing through shell', async () => {
            const { client, cwd } = makeClient('cow-base');
            await client.exec('echo "modified" > README.md', cwd);
            assert.equal(
                fs.readFileSync(path.join(baseDir, 'README.md'), 'utf-8'),
                '# Project\n',
            );
            const result = await client.exec('cat README.md', cwd);
            assert.ok(result.stdout.includes('modified'));
            await client.close();
        });
    });

    // =========================================================
    // Multi-client shell isolation
    // =========================================================
    describe('Multi-client shell isolation', () => {
        it('shell writes in one client should not be visible in another', async () => {
            const a = makeClient('bash-iso-a');
            const b = makeClient('bash-iso-b');

            await a.client.exec('echo "a data" > a-file.txt', a.cwd);
            await b.client.exec('echo "b data" > b-file.txt', b.cwd);

            const ra = await a.client.exec('cat b-file.txt 2>/dev/null || true', a.cwd);
            assert.ok(!ra.stdout.includes('b data'));

            const rb = await b.client.exec('cat b-file.txt', b.cwd);
            assert.ok(rb.stdout.includes('b data'));

            assert.equal(fs.existsSync(path.join(a.upperDir, 'b-file.txt')), false);
            assert.equal(fs.existsSync(path.join(b.upperDir, 'a-file.txt')), false);

            await a.client.close();
            await b.client.close();
        });
    });
});
