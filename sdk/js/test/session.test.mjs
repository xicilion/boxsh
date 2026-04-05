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
     * Create a BoxshClient backed by a fresh overlay on top of baseDir.
     * Also returns the upperDir for assertions.
     * @param {string} id  Unique label for the overlay directories.
     */
    function makeClient(id) {
        const dir      = path.join(tmpDir, id);
        const upperDir = path.join(dir, 'upper');
        const workDir  = path.join(dir, 'work');
        const mntDir   = path.join(dir, 'mnt');
        fs.mkdirSync(upperDir, { recursive: true });
        fs.mkdirSync(workDir,  { recursive: true });
        fs.mkdirSync(mntDir,   { recursive: true });

        const client = new BoxshClient({
            boxshPath: BOXSH,
            workers:   1,
            sandbox:   true,
            overlay:   { lower: baseDir, upper: upperDir, work: workDir, dst: mntDir },
        });

        return { client, upperDir };
    }

    // =========================================================
    // Shell command execution via BoxshClient
    // =========================================================
    describe('Shell — basic commands', () => {
        it('should execute echo command', async () => {
            const { client } = makeClient('bash-echo');
            const result = await client.exec('echo "hello session"', '/workspace');
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('hello session'));
            await client.close();
        });

        it('should execute ls and list base files', async () => {
            const { client } = makeClient('bash-ls');
            const result = await client.exec('ls', '/workspace');
            assert.ok(result.stdout.includes('README.md'));
            assert.ok(result.stdout.includes('src'));
            await client.close();
        });

        it('should execute cat on base file', async () => {
            const { client } = makeClient('bash-cat');
            const result = await client.exec('cat README.md', '/workspace');
            assert.ok(result.stdout.includes('# Project'));
            await client.close();
        });

        it('should execute grep and find matches', async () => {
            const { client } = makeClient('bash-grep');
            const result = await client.exec('grep -n "export" src/utils.ts', '/workspace');
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('export const x'));
            await client.close();
        });

        it('should execute wc -l', async () => {
            const { client } = makeClient('bash-wc');
            const result = await client.exec('wc -l src/utils.ts', '/workspace');
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('3'));
            await client.close();
        });

        it('should execute head', async () => {
            const { client } = makeClient('bash-head');
            const result = await client.exec('head -n 1 src/utils.ts', '/workspace');
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.trim().includes('export const x = 1'));
            await client.close();
        });

        it('should execute pipeline', async () => {
            const { client } = makeClient('bash-pipe');
            const result = await client.exec(
                'cat src/utils.ts | grep "export" | wc -l',
                '/workspace',
            );
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.trim() === '3');
            await client.close();
        });

        it('should execute find', async () => {
            const { client } = makeClient('bash-find');
            const result = await client.exec('find src -name "*.ts"', '/workspace');
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('index.ts'));
            assert.ok(result.stdout.includes('utils.ts'));
            await client.close();
        });

        it('should cd into subdir and list files', async () => {
            const { client } = makeClient('bash-cd');
            const result = await client.exec('cd src && ls', '/workspace');
            assert.equal(result.exitCode, 0);
            assert.ok(result.stdout.includes('index.ts'));
            await client.close();
        });
    });

    // =========================================================
    // Shell write operations — COW semantics through boxsh
    // =========================================================
    describe('Shell — COW write operations', () => {
        it('should execute mkdir in overlay', async () => {
            const { client, upperDir } = makeClient('bash-mkdir');
            const result = await client.exec('mkdir -p new-dir', '/workspace');
            assert.equal(result.exitCode, 0);
            assert.ok(fs.existsSync(path.join(upperDir, 'new-dir')));
            await client.close();
        });

        it('should write file via redirect into upper layer', async () => {
            const { client, upperDir } = makeClient('bash-redir');
            const result = await client.exec(
                'echo "redirected content" > output.txt',
                '/workspace',
            );
            assert.equal(result.exitCode, 0);
            const content = fs.readFileSync(path.join(upperDir, 'output.txt'), 'utf-8');
            assert.ok(content.includes('redirected content'));
            assert.ok(!fs.existsSync(path.join(baseDir, 'output.txt')));
            await client.close();
        });

        it('should read back written content via shell', async () => {
            const { client } = makeClient('cow-readback');
            await client.exec('echo "new data" > created.txt', '/workspace');
            const result = await client.exec('cat created.txt', '/workspace');
            assert.ok(result.stdout.includes('new data'));
            await client.close();
        });

        it('should show new files in ls after write', async () => {
            const { client } = makeClient('cow-ls');
            await client.exec('echo "x" > extra.txt', '/workspace');
            const result = await client.exec('ls', '/workspace');
            assert.ok(result.stdout.includes('extra.txt'));
            assert.ok(result.stdout.includes('README.md'));
            await client.close();
        });

        it('should detect changes after shell write', async () => {
            const { client, upperDir } = makeClient('cow-changes');
            await client.exec('echo "new" > new-file.txt', '/workspace');
            const changes = getChanges({ upper: upperDir, base: baseDir });
            assert.ok(changes.some((c) => c.path === 'new-file.txt' && c.type === 'added'));
            await client.close();
        });

        it('should not modify base when writing through shell', async () => {
            const { client } = makeClient('cow-base');
            await client.exec('echo "modified" > README.md', '/workspace');
            assert.equal(
                fs.readFileSync(path.join(baseDir, 'README.md'), 'utf-8'),
                '# Project\n',
            );
            const result = await client.exec('cat README.md', '/workspace');
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

            await a.client.exec('echo "a data" > a-file.txt', '/workspace');
            await b.client.exec('echo "b data" > b-file.txt', '/workspace');

            const ra = await a.client.exec('cat b-file.txt 2>/dev/null || true', '/workspace');
            assert.ok(!ra.stdout.includes('b data'));

            const rb = await b.client.exec('cat b-file.txt', '/workspace');
            assert.ok(rb.stdout.includes('b data'));

            assert.equal(fs.existsSync(path.join(a.upperDir, 'b-file.txt')), false);
            assert.equal(fs.existsSync(path.join(b.upperDir, 'a-file.txt')), false);

            await a.client.close();
            await b.client.close();
        });
    });
});
