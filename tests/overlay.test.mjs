/**
 * overlay.test.mjs — tests for --overlay, --proc, --tmpfs sandbox mounts.
 *
 * Overlay tests use RPC mode (--sandbox is applied per worker at fork time).
 * Each test creates its own lower/upper/work/dst directories and cleans up.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { run, BOXSH } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp dir subtree for overlay testing. */
function makeOverlayDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-ovl-'));
  const lower = path.join(base, 'lower');
  const upper = path.join(base, 'upper');
  const work  = path.join(base, 'work');
  const dst   = path.join(base, 'dst');
  fs.mkdirSync(lower);
  fs.mkdirSync(upper);
  fs.mkdirSync(work);
  fs.mkdirSync(dst);
  return {
    lower, upper, work, dst,
    // Use the shell rm -rf: overlayfs leaves kernel-internal entries in
    // the work directory that Node's fs.rmSync cannot always remove.
    cleanup: () => spawnSync('rm', ['-rf', base]),
  };
}

/**
 * Run a single JSON-line RPC request with extra sandbox flags.
 * Returns the parsed response object.
 */
function rpcWith(extraFlags, cmd, timeout_ms = 5000) {
  const input = JSON.stringify({ id: '1', cmd }) + '\n';
  const r = run(
    ['--rpc', '--workers', '1', '--sandbox', ...extraFlags],
    input,
    timeout_ms,
  );
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  const line = r.stdout.trim();
  assert.ok(line.length > 0, `no output; stderr: ${r.stderr}`);
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// --overlay LOWER:UPPER:WORK:DST
// ---------------------------------------------------------------------------

describe('sandbox — overlay mounts', () => {
  test('lower-layer files are visible at the mount point', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      fs.writeFileSync(path.join(lower, 'hello.txt'), 'from-lower\n');
      const resp = rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        `cat ${dst}/hello.txt`,
      );
      assert.equal(resp.exit_code, 0);
      assert.equal(resp.stdout, 'from-lower\n');
    } finally {
      cleanup();
    }
  });

  test('writes go to upper layer; lower is unchanged (copy-on-write)', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      fs.writeFileSync(path.join(lower, 'base.txt'), 'original\n');
      const resp = rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        // Redirect overwrites the file through the overlay.
        `echo modified > ${dst}/base.txt`,
      );
      assert.equal(resp.exit_code, 0);
      // Lower layer must not change.
      assert.equal(
        fs.readFileSync(path.join(lower, 'base.txt'), 'utf8'), 'original\n',
      );
      // Modified copy appears in upper layer (host-visible).
      assert.equal(
        fs.readFileSync(path.join(upper, 'base.txt'), 'utf8'), 'modified\n',
      );
    } finally {
      cleanup();
    }
  });

  test('new files created inside sandbox appear in upper layer', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      const resp = rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        `echo fresh > ${dst}/created.txt`,
      );
      assert.equal(resp.exit_code, 0);
      assert.equal(
        fs.readFileSync(path.join(upper, 'created.txt'), 'utf8'), 'fresh\n',
      );
    } finally {
      cleanup();
    }
  });

  test('lower layer read-only: writes are not reflected in lower', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      // Write a new file through the overlay mount.
      rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        `echo data > ${dst}/newfile.txt`,
      );
      // The lower layer must remain empty.
      assert.deepEqual(fs.readdirSync(lower), []);
    } finally {
      cleanup();
    }
  });

  test('invalid --overlay format is rejected (exit 1)', () => {
    // Only two fields provided instead of four.
    const r = run(['--rpc', '--sandbox', '--overlay', 'only:two'], '');
    assert.equal(r.status, 1);
  });

  test('deleting a lower-layer file hides it inside sandbox, lower unchanged', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      fs.writeFileSync(path.join(lower, 'victim.txt'), 'delete-me\n');
      // rm inside the sandbox should succeed.
      const resp = rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        `rm ${dst}/victim.txt && [ ! -e ${dst}/victim.txt ] && echo gone`,
      );
      assert.equal(resp.exit_code, 0);
      assert.equal(resp.stdout, 'gone\n');
      // Lower layer must still have the original file.
      assert.equal(
        fs.readFileSync(path.join(lower, 'victim.txt'), 'utf8'), 'delete-me\n',
      );
    } finally {
      cleanup();
    }
  });

  test('deleting a lower-layer file leaves a whiteout entry in upper', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      fs.writeFileSync(path.join(lower, 'ghost.txt'), 'ghost\n');
      rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        `rm ${dst}/ghost.txt`,
      );
      // Overlayfs records deletion as a char-device whiteout (0,0) in upper.
      const upperEntries = fs.readdirSync(upper);
      assert.ok(
        upperEntries.includes('ghost.txt'),
        `expected whiteout for ghost.txt in upper, got: [${upperEntries}]`,
      );
      const stat = fs.statSync(path.join(upper, 'ghost.txt'));
      // Whiteout = character device with rdev 0.
      assert.ok(stat.isCharacterDevice(), 'whiteout must be a character device');
      assert.equal(stat.rdev, 0, 'whiteout rdev must be 0');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CWD inside the overlay mount point
//
// When the overlay mount point equals or contains the process CWD, the
// kernel's stored (dentry, vfsmount) pair for CWD still points at the lower
// layer after mount().  sandbox_apply() refreshes CWD via chdir() so that
// relative-path writes go through the overlay instead of bypassing it.
// ---------------------------------------------------------------------------

describe('sandbox — overlay CWD refresh', () => {
  test('relative write captured in upper when CWD == mount point', () => {
    // Set up: lower has one existing file; we write a new file via relative path.
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      // dst is the overlay mount point.  Run boxsh with dst as CWD so that
      // the relative path 'touch newfile' exercises the CWD == mount case.
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '--overlay', `${lower}:${upper}:${work}:${dst}`, '-c', 'touch newfile'],
        { encoding: 'utf8', cwd: dst, timeout: 5000 },
      );
      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      // Write must appear in upper, not bypass to lower.
      assert.ok(fs.existsSync(path.join(upper, 'newfile')),
        'expected newfile in upper layer');
      assert.ok(!fs.existsSync(path.join(lower, 'newfile')),
        'newfile must not appear in lower layer');
    } finally {
      cleanup();
    }
  });

  test('relative write captured in upper when CWD is subdirectory of mount point', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      // Create a subdirectory in lower so the overlay exposes it under dst.
      fs.mkdirSync(path.join(lower, 'subdir'));
      // Launch boxsh with dst as CWD; let the shell cd into the subdir so
      // that the relative write happens with CWD = dst/subdir (inside the
      // overlay mount tree).
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '--overlay', `${lower}:${upper}:${work}:${dst}`,
         '-c', `cd ${dst}/subdir && touch canary`],
        { encoding: 'utf8', cwd: dst, timeout: 5000 },
      );
      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      // The file should be captured in upper/subdir, not escape to lower/subdir.
      assert.ok(fs.existsSync(path.join(upper, 'subdir', 'canary')),
        'expected canary in upper/subdir');
      assert.ok(!fs.existsSync(path.join(lower, 'subdir', 'canary')),
        'canary must not appear in lower/subdir');
    } finally {
      cleanup();
    }
  });

  test('CWD outside mount point is unaffected', () => {
    // Sanity check: when CWD is not under the overlay, normal writes still work.
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-outside-'));
    try {
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '--overlay', `${lower}:${upper}:${work}:${dst}`, '-c', 'touch outside-file'],
        { encoding: 'utf8', cwd: outsideDir, timeout: 5000 },
      );
      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      // File written relative to outsideDir is visible there (not via overlay).
      assert.ok(fs.existsSync(path.join(outsideDir, 'outside-file')),
        'expected outside-file to exist in outsideDir');
      // upper must remain empty (no write went through overlay).
      assert.deepEqual(fs.readdirSync(upper), []);
    } finally {
      cleanup();
      spawnSync('rm', ['-rf', outsideDir]);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-layer lower (session branching)
//
// overlayfs supports multiple lower directories separated by colons.
// This is the foundation for session checkpointing and branching:
//
//   session A: --overlay base:upper_a:work_a:dst
//   branch A1: --overlay upper_a:base:upper_a1:work_a1:dst
//   branch B:  --overlay upper_a:base:upper_b:work_b:dst
//
// Both branches see upper_a's modifications merged on top of base, but
// new writes go to their own upper directories.
// ---------------------------------------------------------------------------

describe('sandbox — multi-layer overlay (session branching)', () => {
  /** Create a deeper temp dir tree for multi-layer tests. */
  function makeMultiLayerDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-ml-'));
    const dirs = {};
    for (const name of ['base', 'upper_a', 'work_a', 'upper_a1', 'work_a1', 'upper_b', 'work_b', 'dst']) {
      dirs[name] = path.join(root, name);
      fs.mkdirSync(dirs[name]);
    }
    dirs.cleanup = () => spawnSync('rm', ['-rf', root]);
    return dirs;
  }

  test('branch sees both base and upper_a files merged', () => {
    const d = makeMultiLayerDirs();
    try {
      // base has one file, upper_a has another
      fs.writeFileSync(path.join(d.base,    'from-base.txt'),    'base\n');
      fs.writeFileSync(path.join(d.upper_a, 'from-session.txt'), 'session-a\n');

      // Branch A1: lower = upper_a:base (upper_a on top of base)
      const resp = rpcWith(
        ['--overlay', `${d.upper_a}:${d.base}:${d.upper_a1}:${d.work_a1}:${d.dst}`],
        `cat ${d.dst}/from-base.txt && cat ${d.dst}/from-session.txt`,
      );
      assert.equal(resp.exit_code, 0);
      assert.equal(resp.stdout, 'base\nsession-a\n');
    } finally {
      d.cleanup();
    }
  });

  test('upper_a modifications override base in branch', () => {
    const d = makeMultiLayerDirs();
    try {
      // Same file in both layers — upper_a should win
      fs.writeFileSync(path.join(d.base,    'config.txt'), 'original\n');
      fs.writeFileSync(path.join(d.upper_a, 'config.txt'), 'modified-by-a\n');

      const resp = rpcWith(
        ['--overlay', `${d.upper_a}:${d.base}:${d.upper_a1}:${d.work_a1}:${d.dst}`],
        `cat ${d.dst}/config.txt`,
      );
      assert.equal(resp.exit_code, 0);
      assert.equal(resp.stdout, 'modified-by-a\n');
    } finally {
      d.cleanup();
    }
  });

  test('branch writes go to new upper, not to upper_a or base', () => {
    const d = makeMultiLayerDirs();
    try {
      fs.writeFileSync(path.join(d.base, 'readme.txt'), 'hello\n');

      const resp = rpcWith(
        ['--overlay', `${d.upper_a}:${d.base}:${d.upper_a1}:${d.work_a1}:${d.dst}`],
        `echo branch-write > ${d.dst}/new.txt`,
      );
      assert.equal(resp.exit_code, 0);

      // New file appears only in upper_a1
      assert.equal(
        fs.readFileSync(path.join(d.upper_a1, 'new.txt'), 'utf8'),
        'branch-write\n',
      );
      // base and upper_a are untouched
      assert.ok(!fs.existsSync(path.join(d.base,    'new.txt')));
      assert.ok(!fs.existsSync(path.join(d.upper_a, 'new.txt')));
    } finally {
      d.cleanup();
    }
  });

  test('two branches from same parent diverge independently', () => {
    const d = makeMultiLayerDirs();
    try {
      fs.writeFileSync(path.join(d.base, 'shared.txt'), 'base\n');
      fs.writeFileSync(path.join(d.upper_a, 'shared.txt'), 'session-a\n');

      // Branch A1 writes one thing
      const r1 = rpcWith(
        ['--overlay', `${d.upper_a}:${d.base}:${d.upper_a1}:${d.work_a1}:${d.dst}`],
        `echo a1 > ${d.dst}/branch.txt && cat ${d.dst}/shared.txt`,
      );
      assert.equal(r1.exit_code, 0);
      assert.equal(r1.stdout, 'session-a\n');

      // Branch B writes something different
      const r2 = rpcWith(
        ['--overlay', `${d.upper_a}:${d.base}:${d.upper_b}:${d.work_b}:${d.dst}`],
        `echo b > ${d.dst}/branch.txt && cat ${d.dst}/shared.txt`,
      );
      assert.equal(r2.exit_code, 0);
      assert.equal(r2.stdout, 'session-a\n');

      // Each branch has its own version of branch.txt
      assert.equal(fs.readFileSync(path.join(d.upper_a1, 'branch.txt'), 'utf8'), 'a1\n');
      assert.equal(fs.readFileSync(path.join(d.upper_b,  'branch.txt'), 'utf8'), 'b\n');

      // upper_a is completely untouched
      assert.ok(!fs.existsSync(path.join(d.upper_a, 'branch.txt')));
    } finally {
      d.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// --tmpfs DST[:OPTS]
// ---------------------------------------------------------------------------

describe('sandbox — tmpfs mounts', () => {
  test('tmpfs is writable (/tmp shadowed by fresh tmpfs)', () => {
    // Mount a fresh tmpfs over /tmp — safe in the private mount namespace.
    const resp = rpcWith(
      ['--tmpfs', '/tmp'],
      'echo hello > /tmp/test.txt && cat /tmp/test.txt',
    );
    assert.equal(resp.exit_code, 0);
    assert.equal(resp.stdout, 'hello\n');
  });

  test('tmpfs with size option mounts successfully', () => {
    const resp = rpcWith(
      ['--tmpfs', '/tmp:size=16m'],
      'echo sized > /tmp/f && cat /tmp/f',
    );
    assert.equal(resp.exit_code, 0);
    assert.equal(resp.stdout, 'sized\n');
  });
});

// ---------------------------------------------------------------------------
// Lower-layer mutation after mount
//
// overlayfs does NOT snapshot the lower directory — it is a live view.
// Whether a newly added lower-layer file is visible within the SAME mounted
// instance depends on kernel dentry caching:
//
//   • If a process previously did a stat/access check for the file (creating
//     a *negative* dentry — "this file does not exist"), the kernel caches
//     that result and the new file remains invisible until the cache expires.
//
//   • If no such check was made (e.g. only a directory listing was done),
//     the new file IS visible immediately.
//
// A NEW sandbox session (fresh overlay mount) always sees the current state
// of the lower directory, regardless of negative dentries.
// ---------------------------------------------------------------------------

describe('sandbox — overlay lower-layer mutation after mount', () => {
  test('new lower file visible in same session when no negative dentry cached', async () => {
    // Request 1 lists the directory (no negative dentry for late.txt is created).
    // The host then adds late.txt to lower.
    // Request 2 should see it because the dentry cache has no negative entry.
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      const proc = spawn(BOXSH, [
        '--rpc', '--workers', '1', '--sandbox',
        '--overlay', `${lower}:${upper}:${work}:${dst}`,
      ]);

      const responses = [];
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', l => { if (l.trim()) responses.push(JSON.parse(l)); });

      const waitFor = (n) => new Promise(resolve => {
        const check = () => { if (responses.length >= n) resolve(); else setTimeout(check, 20); };
        check();
      });

      // Request 1: list the directory (does NOT create a negative dentry).
      proc.stdin.write(JSON.stringify({ id: '1', cmd: `ls ${dst}; echo listed` }) + '\n');
      await waitFor(1);

      // Host adds a file to lower while the overlay is still mounted.
      fs.writeFileSync(path.join(lower, 'late.txt'), 'appeared\n');

      // Request 2: the new file should be visible (no negative dentry blocking it).
      proc.stdin.write(JSON.stringify({ id: '2', cmd: `cat ${dst}/late.txt` }) + '\n');
      proc.stdin.end();
      await waitFor(2);

      assert.equal(responses[0].exit_code, 0);
      assert.equal(responses[1].exit_code, 0, 'newly added lower file should be visible when no negative dentry was cached');
      assert.equal(responses[1].stdout, 'appeared\n');
    } finally {
      cleanup();
    }
  });

  test('negative dentry hides new lower file within same session', async () => {
    // Request 1 checks whether late.txt exists ([ ! -e ... ]), which causes
    // the kernel to cache a negative dentry ("late.txt does not exist").
    // Even after the host adds the file to lower, the same session cannot
    // see it because cat hits the cached negative dentry.
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      const proc = spawn(BOXSH, [
        '--rpc', '--workers', '1', '--sandbox',
        '--overlay', `${lower}:${upper}:${work}:${dst}`,
      ]);

      const responses = [];
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', l => { if (l.trim()) responses.push(JSON.parse(l)); });

      const waitFor = (n) => new Promise(resolve => {
        const check = () => { if (responses.length >= n) resolve(); else setTimeout(check, 20); };
        check();
      });

      // Request 1: access a non-existent path, creating a negative dentry.
      proc.stdin.write(JSON.stringify({ id: '1', cmd: `[ ! -e ${dst}/late.txt ] && echo absent` }) + '\n');
      await waitFor(1);

      // Host adds the file to lower.
      fs.writeFileSync(path.join(lower, 'late.txt'), 'appeared\n');

      // Request 2: the cached negative dentry makes the file invisible.
      proc.stdin.write(JSON.stringify({ id: '2', cmd: `cat ${dst}/late.txt` }) + '\n');
      proc.stdin.end();
      await waitFor(2);

      assert.equal(responses[0].exit_code, 0);
      assert.equal(responses[1].exit_code, 1,
        'negative dentry should hide the new lower file within the same mounted session');
    } finally {
      cleanup();
    }
  });

  test('host modifies a lower file that has NOT been copied up — new session sees new content', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      fs.writeFileSync(path.join(lower, 'mutable.txt'), 'v1\n');
      // Confirm v1 is visible (no copy-up yet).
      const r1 = rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        `cat ${dst}/mutable.txt`,
      );
      assert.equal(r1.stdout, 'v1\n');
      assert.deepEqual(fs.readdirSync(upper), [], 'upper must still be empty — no copy-up');

      // Host updates lower directly (simulates upstream commit).
      fs.writeFileSync(path.join(lower, 'mutable.txt'), 'v2\n');

      // New sandbox invocation using the same lower/upper/work: sees v2.
      const r2 = rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        `cat ${dst}/mutable.txt`,
      );
      assert.equal(r2.stdout, 'v2\n',
        'lower mutation visible in new sandbox session when file was not copied up');
    } finally {
      cleanup();
    }
  });

  test('host modifies a lower file that HAS been copied up — sandbox keeps its own upper copy', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      fs.writeFileSync(path.join(lower, 'owned.txt'), 'lower-original\n');
      // First session: sandbox writes to the file, triggering copy-up.
      const r1 = rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        `echo sandbox-edit > ${dst}/owned.txt`,
      );
      assert.equal(r1.exit_code, 0);
      // Confirm copy-up happened.
      assert.ok(fs.existsSync(path.join(upper, 'owned.txt')), 'copy-up must have occurred');

      // Host now modifies lower (simulates upstream diverging).
      fs.writeFileSync(path.join(lower, 'owned.txt'), 'lower-updated\n');

      // Second session reuses the same upper: should see the upper copy, not lower.
      const r2 = rpcWith(
        ['--overlay', `${lower}:${upper}:${work}:${dst}`],
        `cat ${dst}/owned.txt`,
      );
      assert.equal(r2.stdout, 'sandbox-edit\n',
        'after copy-up, lower mutation must NOT override the upper copy');
    } finally {
      cleanup();
    }
  });
});
