/**
 * overlay.test.mjs — tests for --bind cow:SRC:DST sandbox COW mounts.
 *
 * COW tests use RPC mode (--sandbox is applied per worker at fork time).
 * Each test creates its own src/dst directories and cleans up.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { run, BOXSH, TEMPDIR, toJsonRpc, fromJsonRpc } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp dir subtree for COW testing (src = lower, dst = upper+merge). */
function makeCowDirs() {
  const base = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-cow-'));
  const src  = path.join(base, 'src');
  const dst  = path.join(base, 'dst');
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  return {
    src, dst,
    // Overlayfs sets the internal work directory permissions to 0000.
    // chmod first so rm -rf can remove everything.
    cleanup: () => {
      spawnSync('chmod', ['-R', 'u+rwx', base]);
      spawnSync('rm', ['-rf', base]);
    },
  };
}

/**
 * Run a single JSON-line RPC request with extra sandbox flags.
 * Returns the parsed response object.
 */
function rpcWith(extraFlags, cmd, timeout_ms = 5000) {
  const input = JSON.stringify(toJsonRpc({ id: '1', cmd })) + '\n';
  const r = run(
    ['--rpc', '--workers', '1', '--sandbox', ...extraFlags],
    input,
    timeout_ms,
  );
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}`);
  const line = r.stdout.trim();
  assert.ok(line.length > 0, `no output; stderr: ${r.stderr}`);
  return fromJsonRpc(JSON.parse(line));
}

/** Convenience: run with a single --bind cow:SRC:DST flag. */
function rpcCow(src, dst, cmd, timeout_ms = 5000) {
  return rpcWith(['--bind', `cow:${src}:${dst}`], cmd, timeout_ms);
}

// ---------------------------------------------------------------------------
// --bind cow:SRC:DST
// ---------------------------------------------------------------------------

describe('sandbox — cow mounts', () => {
  test('src-layer files are visible at the dst mount point', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.writeFileSync(path.join(src, 'hello.txt'), 'from-src\n');
      const resp = rpcCow(src, dst, `cat ${dst}/hello.txt`);
      assert.equal(resp.exit_code, 0);
      assert.equal(resp.stdout, 'from-src\n');
    } finally {
      cleanup();
    }
  });

  test('writes go to dst; src is unchanged (copy-on-write)', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.writeFileSync(path.join(src, 'base.txt'), 'original\n');
      const resp = rpcCow(src, dst,
        // Redirect overwrites the file through the overlay.
        `echo modified > ${dst}/base.txt`,
      );
      assert.equal(resp.exit_code, 0);
      // src must not change.
      assert.equal(
        fs.readFileSync(path.join(src, 'base.txt'), 'utf8'), 'original\n',
      );
      // Modified copy captured in dst (upper layer, host-visible).
      assert.equal(
        fs.readFileSync(path.join(dst, 'base.txt'), 'utf8'), 'modified\n',
      );
    } finally {
      cleanup();
    }
  });

  test('new files created inside sandbox appear in dst', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      const resp = rpcCow(src, dst, `echo fresh > ${dst}/created.txt`);
      assert.equal(resp.exit_code, 0);
      assert.equal(
        fs.readFileSync(path.join(dst, 'created.txt'), 'utf8'), 'fresh\n',
      );
    } finally {
      cleanup();
    }
  });

  test('src is read-only: writes are not reflected in src', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      // Write a new file through the COW mount.
      rpcCow(src, dst, `echo data > ${dst}/newfile.txt`);
      // The src directory must remain empty.
      assert.deepEqual(fs.readdirSync(src), []);
    } finally {
      cleanup();
    }
  });

  test('invalid --bind cow format is rejected (exit 1)', () => {
    // cow: requires both SRC and DST; only one path provided.
    const r = run(['--rpc', '--sandbox', '--bind', 'cow:only-one-path'], '');
    assert.equal(r.status, 1);
  });

  test('deleting a src-layer file hides it inside sandbox, src unchanged', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.writeFileSync(path.join(src, 'victim.txt'), 'delete-me\n');
      // rm inside the sandbox should succeed.
      const resp = rpcCow(src, dst,
        `rm ${dst}/victim.txt && [ ! -e ${dst}/victim.txt ] && echo gone`,
      );
      assert.equal(resp.exit_code, 0);
      assert.equal(resp.stdout, 'gone\n');
      // src must still have the original file.
      assert.equal(
        fs.readFileSync(path.join(src, 'victim.txt'), 'utf8'), 'delete-me\n',
      );
    } finally {
      cleanup();
    }
  });

  test('deleting a src-layer file leaves a whiteout entry in dst',
    { skip: process.platform === 'darwin' ? 'clonefile COW does not create overlayfs-style whiteout entries' : false },
    () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.writeFileSync(path.join(src, 'ghost.txt'), 'ghost\n');
      rpcCow(src, dst, `rm ${dst}/ghost.txt`);
      // Overlayfs records deletion as a char-device whiteout (0,0) in dst (upper).
      const dstEntries = fs.readdirSync(dst);
      assert.ok(
        dstEntries.includes('ghost.txt'),
        `expected whiteout for ghost.txt in dst, got: [${dstEntries}]`,
      );
      const stat = fs.statSync(path.join(dst, 'ghost.txt'));
      // Whiteout = character device with rdev 0.
      assert.ok(stat.isCharacterDevice(), 'whiteout must be a character device');
      assert.equal(stat.rdev, 0, 'whiteout rdev must be 0');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic workdir and cleanup
// ---------------------------------------------------------------------------

describe('sandbox — cow workdir management',
  { skip: process.platform === 'darwin' ? 'workdir management is Linux overlayfs only' : false },
  () => {

  test('workdir is created at <parent>/.boxsh/<basename>', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      const resp = rpcCow(src, dst, 'echo ok');
      assert.equal(resp.exit_code, 0);
      const parent  = path.dirname(dst);
      const name    = path.basename(dst);
      const workdir = path.join(parent, '.boxsh', name);
      assert.ok(fs.existsSync(workdir),
        `expected workdir at ${workdir}`);
    } finally {
      cleanup();
    }
  });

  test('stale workdir is cleaned up when sibling dst is removed', () => {
    const base = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-cow-'));
    const src  = path.join(base, 'src');
    const dst1 = path.join(base, 'dst1');
    const dst2 = path.join(base, 'dst2');
    fs.mkdirSync(src);
    fs.mkdirSync(dst1);
    fs.mkdirSync(dst2);
    const cleanup = () => {
      spawnSync('chmod', ['-R', 'u+rwx', base]);
      spawnSync('rm', ['-rf', base]);
    };
    try {
      // Run a COW on dst1 to create its workdir.
      rpcCow(src, dst1, 'echo ok');
      const workdir1 = path.join(base, '.boxsh', 'dst1');
      assert.ok(fs.existsSync(workdir1), 'workdir1 should exist after first run');

      // Remove dst1 (simulating user cleanup), but leave stale .boxsh/dst1.
      spawnSync('chmod', ['-R', 'u+rwx', dst1]);
      fs.rmSync(dst1, { recursive: true, force: true });
      assert.ok(fs.existsSync(workdir1), 'stale workdir1 still present before cleanup');

      // Run a COW on dst2 in the same parent — triggers lazy cleanup.
      rpcCow(src, dst2, 'echo ok');

      // Stale workdir1 should have been removed.
      assert.ok(!fs.existsSync(workdir1),
        'stale workdir1 should be cleaned up');
      // dst2 workdir should exist.
      assert.ok(fs.existsSync(path.join(base, '.boxsh', 'dst2')),
        'workdir2 should exist');
    } finally {
      cleanup();
    }
  });

  test('workdir is deterministic and reused across runs', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      // First run.
      rpcCow(src, dst, 'echo first');
      const parent  = path.dirname(dst);
      const name    = path.basename(dst);
      const workdir = path.join(parent, '.boxsh', name);
      assert.ok(fs.existsSync(workdir), 'workdir should exist after first run');

      // Second run reuses the same workdir path (no random suffix).
      rpcCow(src, dst, 'echo second');
      assert.ok(fs.existsSync(workdir), 'workdir should still exist after second run');

      // No stale random-suffix workdirs should appear.
      const siblings = fs.readdirSync(parent).filter(e => e.startsWith('.boxsh-ovl-'));
      assert.equal(siblings.length, 0,
        `no random workdirs should exist, got: [${siblings}]`);
    } finally {
      cleanup();
    }
  });

  test('.boxsh dir is removed when all workdirs are cleaned up', () => {
    const base = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-cow-'));
    const src  = path.join(base, 'src');
    const dst  = path.join(base, 'only');
    fs.mkdirSync(src);
    fs.mkdirSync(dst);
    const cleanup = () => {
      spawnSync('chmod', ['-R', 'u+rwx', base]);
      spawnSync('rm', ['-rf', base]);
    };
    try {
      // Create a workdir for "only".
      rpcCow(src, dst, 'echo ok');
      const dotboxsh = path.join(base, '.boxsh');
      assert.ok(fs.existsSync(dotboxsh), '.boxsh should exist');

      // Remove dst, leaving stale .boxsh/only.
      spawnSync('chmod', ['-R', 'u+rwx', dst]);
      fs.rmSync(dst, { recursive: true, force: true });

      // Create a new dst2 to trigger cleanup in the same parent.
      const dst2 = path.join(base, 'dst2');
      fs.mkdirSync(dst2);
      rpcCow(src, dst2, 'echo ok');

      // Stale "only" workdir should be gone.
      assert.ok(!fs.existsSync(path.join(dotboxsh, 'only')),
        'stale workdir should be removed');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CWD inside the COW src directory
//
// When the process CWD is within the COW src, sandbox_apply() redirects CWD
// to the corresponding path under dst (the overlay merge point) so that
// relative-path writes go through the overlay instead of bypassing it.
// ---------------------------------------------------------------------------

describe('sandbox — cow CWD redirect', () => {
  test('relative write captured in dst when CWD == src', () => {
    // Launch with CWD = src; sandbox redirects CWD to dst.
    const { src, dst, cleanup } = makeCowDirs();
    try {
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '--bind', `cow:${src}:${dst}`, '-c', 'touch newfile'],
        { encoding: 'utf8', cwd: src, timeout: 5000 },
      );
      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      // Write must appear in dst (upper layer), not in src (lower layer).
      assert.ok(fs.existsSync(path.join(dst, 'newfile')),
        'expected newfile in dst (upper layer)');
      assert.ok(!fs.existsSync(path.join(src, 'newfile')),
        'newfile must not appear in src (lower layer)');
    } finally {
      cleanup();
    }
  });

  test('relative write captured in dst when CWD is subdirectory of src', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      // Create a subdirectory in src so the overlay exposes it under dst.
      fs.mkdirSync(path.join(src, 'subdir'));
      // Launch with CWD = src; shell cd into subdir (via dst overlay).
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '--bind', `cow:${src}:${dst}`,
         '-c', `cd ${dst}/subdir && touch canary`],
        { encoding: 'utf8', cwd: src, timeout: 5000 },
      );
      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      // File must be in dst/subdir (upper), not src/subdir (lower).
      assert.ok(fs.existsSync(path.join(dst, 'subdir', 'canary')),
        'expected canary in dst/subdir');
      assert.ok(!fs.existsSync(path.join(src, 'subdir', 'canary')),
        'canary must not appear in src/subdir');
    } finally {
      cleanup();
    }
  });

  test('CWD outside src is not writable without explicit bind', () => {
    // With sandbox hardening, CWD is NOT auto-bound.  Writing to a
    // directory that was not explicitly exposed via --bind must fail.
    const { src, dst, cleanup } = makeCowDirs();
    const outsideDir = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-outside-'));
    try {
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '--bind', `cow:${src}:${dst}`, '-c', `touch ${outsideDir}/outside-file`],
        { encoding: 'utf8', cwd: outsideDir, timeout: 5000 },
      );
      assert.notEqual(r.status, 0, 'touch should fail — outsideDir is not bound');
      // File must NOT exist — sandbox denied the write.
      assert.ok(!fs.existsSync(path.join(outsideDir, 'outside-file')),
        'outside-file must not be created');
    } finally {
      cleanup();
      spawnSync('rm', ['-rf', outsideDir]);
    }
  });

  test('CWD outside src is not readable without explicit bind', () => {
    // Sandbox does not auto-bind CWD.  Listing a directory that was not
    // exposed via --bind must fail.
    const { src, dst, cleanup } = makeCowDirs();
    const outsideDir = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'hidden');
    try {
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '--bind', `cow:${src}:${dst}`, '-c', `ls ${outsideDir}`],
        { encoding: 'utf8', cwd: outsideDir, timeout: 5000 },
      );
      assert.notEqual(r.status, 0, 'ls should fail — outsideDir is not bound');
      assert.ok(!r.stdout.includes('secret.txt'),
        'secret.txt must not be visible');
    } finally {
      cleanup();
      spawnSync('rm', ['-rf', outsideDir]);
    }
  });

  test('sandbox without any bind — CWD is not auto-bound', () => {
    // The host CWD must NOT be automatically bind-mounted into the sandbox.
    const outsideDir = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'marker.txt'), 'host-cwd');
    try {
      // pwd should NOT return outsideDir inside the sandbox.
      const rPwd = spawnSync(
        BOXSH,
        ['--sandbox', '-c', 'pwd'],
        { encoding: 'utf8', cwd: outsideDir, timeout: 5000 },
      );
      assert.equal(rPwd.status, 0);
      assert.notEqual(rPwd.stdout.trim(), outsideDir,
        'CWD inside sandbox must not be the host CWD');

      // Writing via absolute path should fail — CWD directory not bound.
      const rTouch = spawnSync(
        BOXSH,
        ['--sandbox', '-c', `touch ${outsideDir}/new-file`],
        { encoding: 'utf8', cwd: outsideDir, timeout: 5000 },
      );
      assert.notEqual(rTouch.status, 0, 'touch should fail — CWD not bound');
      assert.ok(!fs.existsSync(path.join(outsideDir, 'new-file')),
        'new-file must not be created on host');

      // Reading via absolute path should fail — CWD directory not bound.
      const rCat = spawnSync(
        BOXSH,
        ['--sandbox', '-c', `cat ${outsideDir}/marker.txt`],
        { encoding: 'utf8', cwd: outsideDir, timeout: 5000 },
      );
      assert.notEqual(rCat.status, 0, 'cat should fail — CWD not bound');
      assert.ok(!rCat.stdout.includes('host-cwd'),
        'marker.txt content must not be visible');
    } finally {
      spawnSync('rm', ['-rf', outsideDir]);
    }
  });

  test('sandbox without any bind — CWD is not writable via absolute path', () => {
    const outsideDir = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-outside-'));
    try {
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '-c', `touch ${outsideDir}/outside-file`],
        { encoding: 'utf8', cwd: outsideDir, timeout: 5000 },
      );
      assert.notEqual(r.status, 0, 'touch should fail — no bind mounts');
      assert.ok(!fs.existsSync(path.join(outsideDir, 'outside-file')),
        'outside-file must not be created');
    } finally {
      spawnSync('rm', ['-rf', outsideDir]);
    }
  });

  test('sandbox without any bind — CWD is not readable via absolute path', () => {
    const outsideDir = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'hidden');
    try {
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '-c', `ls ${outsideDir}`],
        { encoding: 'utf8', cwd: outsideDir, timeout: 5000 },
      );
      assert.notEqual(r.status, 0, 'ls should fail — no bind mounts');
      assert.ok(!r.stdout.includes('secret.txt'),
        'secret.txt must not be visible');
    } finally {
      spawnSync('rm', ['-rf', outsideDir]);
    }
  });
});

// ---------------------------------------------------------------------------
// COW copy-up correctness (xino=off)
//
// overlayfs copy-up can fail with EOVERFLOW when the lower filesystem's inode
// numbers exceed what the upper tmpfs can encode (xino feature).  The fix is
// mounting with xino=off.  These tests exercise the copy-up path against the
// real host filesystem as the lower layer, which has large inode numbers.
// ---------------------------------------------------------------------------

describe('sandbox — cow copy-up without EOVERFLOW', () => {
  test('writing a new file into an existing src subdirectory succeeds', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.mkdirSync(path.join(src, 'module'));
      fs.writeFileSync(path.join(src, 'module', 'existing.js'), '// existing\n');
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '--bind', `cow:${src}:${dst}`,
         '-c', `touch "${dst}/module/new1.js" && touch "${dst}/module/new2.js" && echo ok`],
        { encoding: 'utf8', cwd: src, timeout: 5000 },
      );
      assert.equal(r.status, 0,
        `copy-up failed (EOVERFLOW?): exit=${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
      assert.equal(r.stdout.trim(), 'ok');
    } finally {
      cleanup();
    }
  });

  test('copy-up of a src-layer file for modification succeeds', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.writeFileSync(path.join(src, 'config.json'), '{"v":1}\n');
      const r = spawnSync(
        BOXSH,
        ['--sandbox', '--bind', `cow:${src}:${dst}`,
         '-c', `echo '{"v":2}' > "${dst}/config.json" && cat "${dst}/config.json"`],
        { encoding: 'utf8', cwd: src, timeout: 5000 },
      );
      assert.equal(r.status, 0,
        `copy-up of existing file failed: exit=${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /\{"v":2\}/);
      // src must be unchanged (COW guarantee).
      assert.equal(fs.readFileSync(path.join(src, 'config.json'), 'utf8'), '{"v":1}\n');
    } finally {
      cleanup();
    }
  });

  test('--try mode: writing into an existing subdirectory of CWD succeeds', () => {
    // End-to-end via --try: mirrors the fibmod_test.js scenario exactly.
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-xino-'));
    try {
      fs.mkdirSync(path.join(cwd, 'module'));
      fs.writeFileSync(path.join(cwd, 'module', 'seed.js'), '// seed\n');
      const r = spawnSync(
        BOXSH,
        ['--try', '-c',
         `touch module/check1.js && touch module/check2.js && echo ok`],
        { encoding: 'utf8', cwd, timeout: 5000 },
      );
      assert.equal(r.status, 0,
        `--try copy-up failed: exit=${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
      assert.equal(r.stdout.trim(), 'ok');
      // Host module/ must be untouched.
      assert.deepEqual(fs.readdirSync(path.join(cwd, 'module')), ['seed.js']);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });
});

// ---------------------------------------------------------------------------
// fuse-overlayfs fallback
//
// On XFS with inode numbers > 2^31, kernel overlayfs fails with EINVAL in a
// user namespace.  boxsh should automatically fall back to fuse-overlayfs.
// ---------------------------------------------------------------------------

describe('sandbox — fuse-overlayfs fallback', () => {
  // Skip the entire suite if fuse-overlayfs is not installed.
  const hasFuseOverlayfs = spawnSync('which', ['fuse-overlayfs']).status === 0;

  /** Create COW dirs under TEMPDIR (XFS, large inodes) to trigger fallback. */
  function makeFuseDirs() {
    const base = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-fuse-'));
    const src  = path.join(base, 'src');
    const dst  = path.join(base, 'dst');
    fs.mkdirSync(src); fs.mkdirSync(dst);
    return { src, dst, cleanup: () => spawnSync('rm', ['-rf', base]) };
  }

  test('single cow on XFS falls back to fuse-overlayfs',
    { skip: !hasFuseOverlayfs && 'fuse-overlayfs not installed' }, () => {
    const { src, dst, cleanup } = makeFuseDirs();
    try {
      fs.writeFileSync(path.join(src, 'hello.txt'), 'fuse-src\n');
      const resp = rpcCow(src, dst, `cat ${dst}/hello.txt`);
      assert.equal(resp.exit_code, 0, `cmd failed; stderr: ${resp.stderr}`);
      assert.equal(resp.stdout, 'fuse-src\n');
    } finally {
      cleanup();
    }
  });

  test('fuse-overlayfs COW: writes go to dst, src unchanged',
    { skip: !hasFuseOverlayfs && 'fuse-overlayfs not installed' }, () => {
    const { src, dst, cleanup } = makeFuseDirs();
    try {
      fs.writeFileSync(path.join(src, 'data.txt'), 'original\n');
      const resp = rpcCow(src, dst,
        `echo modified > ${dst}/data.txt && echo new > ${dst}/new.txt`,
      );
      assert.equal(resp.exit_code, 0, `cmd failed; stderr: ${resp.stderr}`);
      assert.equal(fs.readFileSync(path.join(src, 'data.txt'), 'utf8'), 'original\n');
      assert.equal(fs.readFileSync(path.join(dst, 'data.txt'), 'utf8'), 'modified\n');
      assert.equal(fs.readFileSync(path.join(dst, 'new.txt'), 'utf8'), 'new\n');
    } finally {
      cleanup();
    }
  });

  test('--try mode on XFS directory uses fuse-overlayfs',
    { skip: !hasFuseOverlayfs && 'fuse-overlayfs not installed' }, () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-fuse-try-'));
    try {
      fs.writeFileSync(path.join(cwd, 'seed.txt'), 'host\n');
      const r = spawnSync(
        BOXSH,
        ['--try', '-c', 'echo sandbox > seed.txt && cat seed.txt'],
        { encoding: 'utf8', cwd, timeout: 10000 },
      );
      assert.equal(r.status, 0,
        `--try failed: exit=${r.status}\nstderr: ${r.stderr}`);
      assert.equal(r.stdout.trim(), 'sandbox');
      // Host file must be untouched.
      assert.equal(fs.readFileSync(path.join(cwd, 'seed.txt'), 'utf8'), 'host\n');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });
});
