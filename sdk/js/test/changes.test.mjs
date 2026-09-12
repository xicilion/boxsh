/**
 * Tests for getChanges() upper-layer parsing.
 *
 * The change report must describe the same reality no matter which COW engine
 * wrote the upper layer:
 *   - kernel overlayfs  → deletion = char-device whiteout (0/0)
 *   - fuse-overlayfs    → deletion = OCI `.wh.<name>` marker file, plus
 *                         `.wh..wh..opq` opaque-directory markers and
 *                         `.wh..wh.plnk` hardlink indexes as reserved metadata
 *
 * boxsh falls back to fuse-overlayfs whenever the kernel overlay cannot store
 * overlay metadata (macOS/Docker virtiofs host mounts are the common case), so
 * the fuse encoding is the normal one on those platforms and the reserved
 * metadata must never leak into the report as phantom changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getChanges, formatChanges } from '../src/changes.mjs';

// =========================================================================
// Helpers
// =========================================================================

/**
 * Write a tree of files below `root`.
 * @param {string} root
 * @param {Record<string, string|null>} entries  relPath → content, null = dir
 */
function writeTree(root, entries) {
    fs.mkdirSync(root, { recursive: true });
    for (const [rel, content] of Object.entries(entries)) {
        const p = path.join(root, rel);
        if (content === null) {
            fs.mkdirSync(p, { recursive: true });
            continue;
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
}

function makeRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-changes-'));
}

const byPath = (a, b) => a.path.localeCompare(b.path);

// =========================================================================
// Deletion encodings
// =========================================================================

describe('getChanges — whiteout encodings', () => {
    it('reports OCI .wh. markers (fuse-overlayfs) as deletions', () => {
        const root = makeRoot();
        try {
            const base = path.join(root, 'base');
            const upper = path.join(root, 'upper');
            writeTree(base, {
                'ghost.txt': 'ghost\n',
                'nested/deep.txt': 'deep\n',
            });
            writeTree(upper, {
                '.wh.ghost.txt': '',
                'nested/.wh.deep.txt': '',
            });

            const changes = getChanges({ upper, base });
            assert.deepEqual(changes.slice().sort(byPath), [
                { path: 'ghost.txt', type: 'deleted' },
                { path: 'nested/deep.txt', type: 'deleted' },
            ].sort(byPath));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('ignores reserved fuse-overlayfs metadata (no phantom changes)', () => {
        const root = makeRoot();
        try {
            const base = path.join(root, 'base');
            const upper = path.join(root, 'upper');
            writeTree(base, { 'kept.txt': 'kept\n', 'made/': null });
            writeTree(upper, {
                'kept.txt': 'kept-changed\n',
                // A directory created inside the sandbox is marked opaque; the
                // hardlink index lives in its own reserved directory.
                'made/.wh..wh..opq': '',
                'made/file.txt': 'new\n',
                '.wh..wh.plnk/0/00000001': '',
            });

            const changes = getChanges({ upper, base });
            const paths = changes.map(c => c.path);
            assert.ok(!paths.some(p => p.includes('.wh.')),
                `reserved metadata must not appear in the report, got: ${JSON.stringify(changes)}`);
            assert.deepEqual(changes.slice().sort(byPath), [
                { path: 'kept.txt', type: 'modified' },
                { path: 'made/file.txt', type: 'added' },
            ].sort(byPath));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('an opaque marker hides the lower content of its directory', () => {
        const root = makeRoot();
        try {
            const base = path.join(root, 'base');
            const upper = path.join(root, 'upper');
            writeTree(base, {
                'd/a.txt': 'a\n',
                'd/b.txt': 'b\n',
            });
            // `echo changed > d/a.txt && rm d/b.txt` after `mkdir -p d` in the
            // sandbox: the upper directory is opaque, so the untouched lower
            // entry is hidden even though no whiteout exists for it.
            writeTree(upper, {
                'd/.wh..wh..opq': '',
                'd/a.txt': 'a-changed\n',
            });

            const changes = getChanges({ upper, base });
            assert.deepEqual(changes.slice().sort(byPath), [
                { path: 'd/a.txt', type: 'modified' },
                { path: 'd/b.txt', type: 'deleted' },
            ].sort(byPath));
            assert.equal(formatChanges(changes), 'M\td/a.txt\nD\td/b.txt\n');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
