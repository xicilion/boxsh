/**
 * docker-cow-hostmount.test.mjs — COW whose destination lives on the *host
 * bind mount* (the workspace layout agent-app/devspace uses).
 *
 * Why this file exists (2026-09-13 regression): on macOS/Docker the host data
 * directory is mounted through virtiofs.  Inside a user namespace the kernel
 * cannot store overlayfs metadata on such a filesystem, but instead of failing
 * the mount it returns a mount whose superblock is *read-only*
 * (`mountinfo: overlay ro,...`).  boxsh used to accept that as success, so
 * reads worked and every write below the COW failed with EROFS — silently, no
 * fallback, no hint.  boxsh now detects the read-only result, unmounts it,
 * drops the kernel's leftover `work/` entry and falls back to fuse-overlayfs.
 *
 * The suite puts both the lower and the destination on the harness bind mount
 * (`/src/temp` — the same mount the other suites use), so:
 *   - on macOS/Docker (virtiofs) it exercises the read-only-overlay fallback;
 *   - on Linux runners it exercises the plain kernel-overlay path.
 * Either way COW writes must succeed, and the destination must never be left
 * on a silently read-only mount.
 *
 * The second test guards the workdir contract: boxsh's lazy cleanup assumes
 * the overlay workdir lives at `<dst parent>/.boxsh/<dst basename>`, so a
 * second sandbox generation on the same destination must still be able to
 * copy-up (a renamed/removed workdir breaks copy-up with ENOENT).
 *
 * The remaining tests cover the surrounding contract of that fallback:
 *   - the merge point is never left on a read-only mount (mountinfo probe from
 *     inside the sandbox — the exact pre-patch failure, which passed the
 *     trivial checks and only broke on the first write);
 *   - copy-up fidelity: nested content, symlinks, modes, large files,
 *     deletion (whiteout) with the lower layer untouched;
 *   - `getChanges` reports exactly the real change set on such an upper
 *     (fuse-overlayfs writes OCI `.wh.` markers and opaque-dir markers);
 *   - several COW mounts in one run, destinations created on demand, stale
 *     workdir cleanup (including a mode-000 kernel leftover), and the
 *     automanaged `--try` flow on a directory that lives on the host mount.
 *
 * Skips when not running inside a container (docker engine contract only).
 *
 * Required container privileges (provided by tests/docker-test.sh):
 *   --user <non-root> --security-opt seccomp=unconfined --device /dev/fuse
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TEMPDIR, toJsonRpc, fromJsonRpc, run, BOXSH } from './helpers.mjs';
import { getChanges } from '../sdk/js/src/changes.mjs';

// --- container detection (mirrors src/sandbox.cpp running_in_container) -----

const IN_CONTAINER =
  fs.existsSync('/.dockerenv') ||
  (fs.existsSync('/proc/1/cgroup') &&
    fs.readFileSync('/proc/1/cgroup', 'utf8').split('\n')
      .some(l => l.includes('docker') || l.includes('containerd') || l.includes('kubepods')));

const skip = !IN_CONTAINER && 'not running inside a container — docker tests run in the separate docker-test CI job';

// --- helpers -----------------------------------------------------------------

/** <base>/<store> pair on the harness bind mount (host data dir equivalent). */
function makeHostMountCowDirs(prefix) {
  const root = fs.mkdtempSync(path.join(TEMPDIR, prefix));
  const src = path.join(root, 'base');
  const dst = path.join(root, 'store');
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  return {
    src, dst,
    cleanup: () => {
      // The overlay workdir may be mode 000; chmod first.
      spawnSync('chmod', ['-R', 'u+rwx', root]);
      spawnSync('rm', ['-rf', root]);
    },
  };
}

/** Run boxsh with --sandbox + extra flags, single JSON-RPC request. */
function rpcWith(extraFlags, req, timeoutMs = 15000) {
  const input = JSON.stringify(toJsonRpc(req)) + '\n';
  const r = run(['--rpc', '--workers', '1', '--sandbox', ...extraFlags], input, timeoutMs);
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}\nstderr: ${r.stderr}`);
  const line = r.stdout.trim();
  if (line.length === 0) {
    return { _noOutput: true, error: r.stderr, status: r.status, boxshStderr: r.stderr };
  }
  return { ...fromJsonRpc(JSON.parse(line)), boxshStderr: r.stderr, status: r.status };
}
function rpcCow(src, dst, cmd) {
  return rpcWith(['--bind', `cow:${src}:${dst}`], { id: '1', cmd });
}

/**
 * Superblock options of one /proc/self/mountinfo line.
 *
 * Format: `<id> <parent> <maj:min> <root> <mountpoint> <mount-opts> [<optional
 * fields>] - <fstype> <source> <super-opts>`; only the superblock options
 * (after the ` - ` separator) tell whether the filesystem is writable — the
 * per-mount option field still says `rw` when the kernel handed back a
 * read-only overlay, which is exactly how the regression stayed hidden.
 *
 * @returns {string|null} superblock options, or null when the line is malformed
 */
function superOptionsOf(line) {
  const sep = line.indexOf(' - ');
  if (sep < 0) return null;
  return line.slice(sep + 3).split(' ').slice(2).join(' ') || null;
}

/**
 * Mount state of `dst`'s COW merge view, read from *inside* a sandbox that has
 * the very same COW mount.  The merge view only exists inside the sandbox, so
 * the probe must create it itself.
 *
 * Returns null when mountinfo has no entry for `dst` — callers must treat that
 * as a broken probe, never as a pass (an empty match would make the
 * read-only check vacuous).
 */
function cowMountState(src, dst) {
  const probe = rpcCow(src, dst, `grep -F " ${dst} " /proc/self/mountinfo`);
  if (probe.exit_code !== 0) return null;
  const line = (probe.stdout ?? '').trim().split('\n')[0];
  const superOpts = line ? superOptionsOf(line) : null;
  return superOpts ? { line, superOpts } : null;
}

// --- the regression ----------------------------------------------------------

describe('docker — COW on a host bind mount (workspace data layout)', { skip }, () => {
  test('copy-up and new-file writes succeed; lower layer stays untouched', () => {
    const { src, dst, cleanup } = makeHostMountCowDirs('boxsh-hostmount-cow-');
    try {
      fs.writeFileSync(path.join(src, 'README.md'), 'original\n');

      const resp = rpcCow(src, dst,
        `cat ${dst}/README.md && echo modified > ${dst}/README.md && echo new > ${dst}/new.txt`);

      assert.equal(resp.exit_code, 0,
        'writes inside the COW sandbox must succeed.  A silently read-only '
        + 'kernel overlay (virtiofs host mount) fails here with EROFS.\n'
        + `cmd stdout: ${resp.stdout}\ncmd stderr: ${resp.stderr}\nboxsh stderr: ${resp.boxshStderr}`);

      // Writes land in the destination (upper layer).
      assert.equal(fs.readFileSync(path.join(dst, 'README.md'), 'utf8'), 'modified\n');
      assert.equal(fs.readFileSync(path.join(dst, 'new.txt'), 'utf8'), 'new\n');
      // The lower layer is never modified — core COW guarantee.
      assert.equal(fs.readFileSync(path.join(src, 'README.md'), 'utf8'), 'original\n');

      // When the kernel overlay came up read-only, boxsh must have announced
      // the fuse-overlayfs fallback (the regression's observable signal).  On
      // plain Linux filesystems the kernel overlay is used directly and no
      // fallback notice is expected.
      if (/mounted read-only/.test(resp.boxshStderr)) {
        assert.ok(/trying fuse-overlayfs/.test(resp.boxshStderr),
          `read-only kernel overlay must trigger the fuse fallback notice, got: ${resp.boxshStderr}`);
      }
    } finally {
      cleanup();
    }
  });

  test('a second sandbox generation on the same destination can still copy-up', () => {
    // Guards the workdir contract: the overlay workdir must stay at
    // `<dst parent>/.boxsh/<dst basename>` (boxsh's lazy cleanup removes
    // `.boxsh/*` entries whose sibling destination is gone), otherwise the
    // second generation copy-up fails with ENOENT.
    const { src, dst, cleanup } = makeHostMountCowDirs('boxsh-hostmount-gen2-');
    try {
      fs.writeFileSync(path.join(src, 'README.md'), 'original\n');

      const first = rpcCow(src, dst, `echo first > ${dst}/first.txt`);
      assert.equal(first.exit_code, 0,
        `first sandbox write failed: ${first.stderr}\nboxsh stderr: ${first.boxshStderr}`);

      const second = rpcCow(src, dst, `cat ${dst}/README.md && echo second-edit > ${dst}/README.md`);
      assert.equal(second.exit_code, 0,
        'second sandbox copy-up failed (broken/renamed overlay workdir?)'
        + `\ncmd stderr: ${second.stderr}\nboxsh stderr: ${second.boxshStderr}`);

      assert.equal(fs.readFileSync(path.join(dst, 'first.txt'), 'utf8'), 'first\n');
      assert.equal(fs.readFileSync(path.join(dst, 'README.md'), 'utf8'), 'second-edit\n');
      assert.equal(fs.readFileSync(path.join(src, 'README.md'), 'utf8'), 'original\n');
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // The merge point must be writable — the direct assertion of the regression
  // -------------------------------------------------------------------------

  test('the COW merge point is never left on a read-only mount', () => {
    const { src, dst, cleanup } = makeHostMountCowDirs('boxsh-hostmount-ro-');
    try {
      fs.writeFileSync(path.join(src, 'README.md'), 'original\n');

      const mount = cowMountState(src, dst);
      assert.ok(mount,
        `no mountinfo entry for ${dst} inside the sandbox — the probe is vacuous, `
        + 'the COW mount is missing entirely');
      assert.ok(!/(^|,)ro(,|$)/.test(mount.superOpts),
        `the COW merge point sits on a read-only superblock: ${mount.line}\n`
        + 'Pre-patch, the kernel overlay was accepted as-is on virtiofs: the '
        + 'per-mount field says rw, the superblock says ro, and every write '
        + 'below the merge fails with EROFS.');
      assert.match(mount.superOpts, /(^|,)rw(,|$)/,
        `expected a writable superblock, got: ${mount.line}`);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Copy-up fidelity on the host mount
  // -------------------------------------------------------------------------

  test('nested content, symlinks, modes, large files and deletion all survive', () => {
    const { src, dst, cleanup } = makeHostMountCowDirs('boxsh-hostmount-fidelity-');
    try {
      // Deterministic large file: 256 KiB of A..Z, so the copy-up data path is
      // exercised and any slice can be predicted from the original bytes.
      const big = Buffer.alloc(262144);
      for (let i = 0; i < big.length; i++) big[i] = 65 + (i % 26);
      fs.writeFileSync(path.join(src, 'big.bin'), big);
      fs.writeFileSync(path.join(src, 'README.md'), 'original\n');
      fs.mkdirSync(path.join(src, 'nested', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(src, 'nested', 'deep', 'file.txt'), 'deep-content\n');
      fs.symlinkSync('README.md', path.join(src, 'link.txt'));

      const resp = rpcCow(src, dst, [
        `cat ${dst}/README.md`,                                  // read through lower
        `echo modified > ${dst}/README.md`,                      // copy-up + write
        `chmod 600 ${dst}/README.md`,                            // metadata copy
        `cat ${dst}/nested/deep/file.txt`,                       // nested copy-up read
        `(dd if=${dst}/big.bin bs=16 skip=6250 count=1 2>/dev/null; echo)`,  // large copy-up read
        `mkdir -p ${dst}/made/dir && echo m > ${dst}/made/dir/f`,      // new directory tree
        `ln -s new.txt ${dst}/link2.txt`,                        // symlink in upper
        `rm ${dst}/nested/deep/file.txt`,                        // whiteout
        `[ ! -e ${dst}/nested/deep/file.txt ] && echo RM-OK`,
      ].join(' && '));

      assert.equal(resp.exit_code, 0,
        `COW operations failed on the host mount:\ncmd stdout: ${resp.stdout}\n`
        + `cmd stderr: ${resp.stderr}\nboxsh stderr: ${resp.boxshStderr}`);

      assert.equal(resp.stdout, [
        'original',
        'deep-content',
        big.subarray(100000, 100016).toString('latin1'),
        'RM-OK',
      ].join('\n') + '\n');

      // Upper layer (host side): modified copy with the mode we set.
      const copied = fs.statSync(path.join(dst, 'README.md'));
      assert.equal(fs.readFileSync(path.join(dst, 'README.md'), 'utf8'), 'modified\n');
      assert.equal(copied.mode & 0o777, 0o600, 'copy-up must preserve the mode');

      // New files, directories and symlinks land in the upper layer.
      assert.equal(fs.readFileSync(path.join(dst, 'made/dir/f'), 'utf8'), 'm\n');
      assert.equal(fs.readlinkSync(path.join(dst, 'link2.txt')), 'new.txt');

      // The deleted lower file is hidden, and represented as a whiteout —
      // either the kernel overlay char device (0,0) or an OCI `.wh.` marker.
      const victim = path.join(dst, 'nested/deep/file.txt');
      if (fs.existsSync(victim)) {
        const st = fs.lstatSync(victim);
        assert.ok(st.isCharacterDevice?.() && st.rdev === 0,
          'a hidden lower file may only remain as a 0,0 whiteout char device');
      } else {
        assert.ok(fs.existsSync(path.join(dst, 'nested/deep/.wh.file.txt')),
          'expected a whiteout (char device or .wh. marker) for the deleted file');
      }

      // Core COW guarantee: the lower layer is untouched, including modes.
      assert.equal(fs.readFileSync(path.join(src, 'README.md'), 'utf8'), 'original\n');
      assert.equal(fs.statSync(path.join(src, 'README.md')).mode & 0o777, 0o644);
      assert.equal(fs.readFileSync(path.join(src, 'nested/deep/file.txt'), 'utf8'), 'deep-content\n');
      assert.ok(!fs.existsSync(path.join(src, 'made')), 'lower must not gain directories');
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // The change report must describe the same reality on both COW engines
  // -------------------------------------------------------------------------

  test('getChanges reports exactly the real changes (no phantom whiteouts)', () => {
    const { src, dst, cleanup } = makeHostMountCowDirs('boxsh-hostmount-changes-');
    try {
      fs.writeFileSync(path.join(src, 'README.md'), 'original\n');
      fs.mkdirSync(path.join(src, 'nested', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(src, 'nested', 'deep', 'file.txt'), 'deep-content\n');

      const resp = rpcCow(src, dst, [
        `echo modified > ${dst}/README.md`,
        `echo new > ${dst}/new.txt`,
        `mkdir -p ${dst}/made/dir && echo m > ${dst}/made/dir/f`,
        `rm ${dst}/nested/deep/file.txt`,
      ].join(' && '));
      assert.equal(resp.exit_code, 0,
        `cmd failed: ${resp.stderr}\nboxsh stderr: ${resp.boxshStderr}`);

      // fuse-overlayfs (macOS/Docker virtiofs) writes OCI `.wh.<name>` markers
      // and `.wh..wh..opq` opaque-dir markers; kernel overlay writes 0,0 char
      // devices.  Neither representation may leak into the report.
      const changes = getChanges({ upper: dst, base: src });
      const expected = [
        { path: 'made', type: 'added' },
        { path: 'made/dir', type: 'added' },
        { path: 'made/dir/f', type: 'added' },
        { path: 'new.txt', type: 'added' },
        { path: 'nested/deep/file.txt', type: 'deleted' },
        { path: 'README.md', type: 'modified' },
      ];
      const byPath = (a, b) => a.path.localeCompare(b.path);
      assert.deepEqual(changes.slice().sort(byPath), expected.slice().sort(byPath));
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Several mounts, on-demand destinations, workdir bookkeeping
  // -------------------------------------------------------------------------

  test('several COW mounts in one run are each writable with their own workdir', () => {
    const root = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-hostmount-multi-'));
    const src = path.join(root, 'base');
    const dstA = path.join(root, 'store-a');
    const dstB = path.join(root, 'store-b');
    const cleanup = () => {
      spawnSync('chmod', ['-R', 'u+rwx', root]);
      spawnSync('rm', ['-rf', root]);
    };
    try {
      fs.mkdirSync(src);
      fs.mkdirSync(dstA);
      fs.mkdirSync(dstB);
      fs.writeFileSync(path.join(src, 'shared.txt'), 'lower\n');

      const resp = rpcWith(
        ['--bind', `cow:${src}:${dstA}`, '--bind', `cow:${src}:${dstB}`],
        { id: '1', cmd: [
          `grep -F -e " ${dstA} " -e " ${dstB} " /proc/self/mountinfo`,
          `cat ${dstA}/shared.txt && cat ${dstB}/shared.txt`,
          `echo a > ${dstA}/a.txt`,
          `echo b > ${dstB}/b.txt`,
        ].join(' && ') });

      assert.equal(resp.exit_code, 0,
        `multiple COW mounts failed: ${resp.stderr}\nboxsh stderr: ${resp.boxshStderr}`);

      const lines = resp.stdout.trim().split('\n');
      const mountLines = lines.filter(l => l.includes(' - ')
        && (l.includes(dstA) || l.includes(dstB)));
      assert.equal(mountLines.length, 2,
        `expected a mountinfo entry per COW mount, got:\n${resp.stdout}`);
      for (const line of mountLines) {
        const superOpts = superOptionsOf(line);
        assert.ok(superOpts && !/(^|,)ro(,|$)/.test(superOpts),
          `mount left on a read-only superblock: ${line}`);
      }
      assert.equal(lines.filter(l => l === 'lower').length, 2,
        `both mounts must read the lower layer, got:\n${resp.stdout}`);

      // Writes are isolated per destination; the lower layer is untouched.
      assert.equal(fs.readFileSync(path.join(dstA, 'a.txt'), 'utf8'), 'a\n');
      assert.equal(fs.readFileSync(path.join(dstB, 'b.txt'), 'utf8'), 'b\n');
      assert.ok(!fs.existsSync(path.join(dstA, 'b.txt')));
      assert.ok(!fs.existsSync(path.join(dstB, 'a.txt')));
      assert.equal(fs.readFileSync(path.join(src, 'shared.txt'), 'utf8'), 'lower\n');

      // Workdir bookkeeping: one entry per live destination, same parent.
      assert.ok(fs.existsSync(path.join(root, '.boxsh', 'store-a')));
      assert.ok(fs.existsSync(path.join(root, '.boxsh', 'store-b')));
    } finally {
      cleanup();
    }
  });

  test('a destination that does not exist yet is created on the host mount', () => {
    const root = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-hostmount-newdst-'));
    const src = path.join(root, 'base');
    const dst = path.join(root, 'created-on-demand');
    const cleanup = () => {
      spawnSync('chmod', ['-R', 'u+rwx', root]);
      spawnSync('rm', ['-rf', root]);
    };
    try {
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'seed.txt'), 'seed\n');
      assert.ok(!fs.existsSync(dst), 'pre-condition: dst must not exist yet');

      const resp = rpcCow(src, dst,
        `cat ${dst}/seed.txt && echo fresh > ${dst}/f.txt && ls ${dst}`);
      assert.equal(resp.exit_code, 0,
        `COW with an on-demand destination failed: ${resp.stderr}\nboxsh stderr: ${resp.boxshStderr}`);

      assert.ok(fs.statSync(dst).isDirectory(), 'boxsh must create the destination');
      assert.equal(fs.readFileSync(path.join(dst, 'f.txt'), 'utf8'), 'fresh\n');
      assert.equal(fs.readFileSync(path.join(src, 'seed.txt'), 'utf8'), 'seed\n');
      // The initial COW state is created inside the destination, but the
      // runtime workdir lives next to it (never pollutes the upper layer).
      assert.deepEqual(fs.readdirSync(path.join(root, '.boxsh')), ['created-on-demand']);
      assert.ok(!fs.existsSync(path.join(dst, '.boxsh')),
        'the runtime workdir must live next to dst, not inside it');
    } finally {
      cleanup();
    }
  });

  test('stale workdirs are removed, live ones are kept (mode-000 kernel leftover)', () => {
    const root = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-hostmount-stale-'));
    const src = path.join(root, 'base');
    const live = path.join(root, 'live');
    const dotboxsh = path.join(root, '.boxsh');
    const deadWork = path.join(dotboxsh, 'dead', 'work');
    const cleanup = () => {
      // The mode-000 leftover must be made traversable before rm can descend.
      try { fs.chmodSync(path.join(dotboxsh, 'dead'), 0o700); } catch { /* absent */ }
      try { fs.chmodSync(deadWork, 0o700); } catch { /* absent */ }
      spawnSync('chmod', ['-R', 'u+rwx', root]);
      spawnSync('rm', ['-rf', root]);
    };
    try {
      fs.mkdirSync(src);
      fs.mkdirSync(live);
      fs.writeFileSync(path.join(src, 'x.txt'), 'x\n');

      // Workdir of a destination the user deleted, holding the internal
      // `work` directory the kernel overlay leaves behind (mode 000).
      fs.mkdirSync(deadWork, { recursive: true });
      fs.chmodSync(deadWork, 0o000);
      // Workdir of a destination that still exists — must survive cleanup.
      fs.mkdirSync(path.join(dotboxsh, 'live'), { recursive: true });

      const resp = rpcCow(src, live, `echo live > ${live}/x.txt && cat ${live}/x.txt`);
      assert.equal(resp.exit_code, 0,
        `stale-workdir run failed: ${resp.stderr}\nboxsh stderr: ${resp.boxshStderr}`);

      assert.ok(!fs.existsSync(path.join(dotboxsh, 'dead')),
        'stale workdir (dead sibling) must be removed, including its mode-000 work dir');
      assert.ok(fs.existsSync(path.join(dotboxsh, 'live')),
        'workdir of a live sibling must be kept (it is reused, not recreated)');
      assert.equal(fs.readFileSync(path.join(live, 'x.txt'), 'utf8'), 'live\n');
      assert.equal(fs.readFileSync(path.join(src, 'x.txt'), 'utf8'), 'x\n');
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // The automanaged --try flow on a directory that lives on the host mount
  // -------------------------------------------------------------------------

  test('--try on a host-mount CWD writes to the try workdir, CWD untouched', () => {
    const root = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-hostmount-try-'));
    const cwd = path.join(root, 'workspace');
    let tryDir = null;
    const cleanup = () => {
      // --try creates siblings (.boxsh-try-*) and may leave mode-000 workdirs.
      for (const dir of [cwd, tryDir, root].filter(Boolean)) {
        spawnSync('chmod', ['-R', 'u+rwx', dir]);
      }
      spawnSync('sh', ['-c',
        `for d in "${root}"/.boxsh-try-*; do chmod -R u+rwx "$d" 2>/dev/null; rm -rf "$d"; done`]);
      spawnSync('rm', ['-rf', root]);
    };
    try {
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, 'keep.txt'), 'hello\n');

      const home = fs.existsSync(os.homedir()) ? os.homedir() : TEMPDIR;
      const r = spawnSync(BOXSH, ['--try', '-c', 'echo inside > made.txt && cat keep.txt && pwd'], {
        encoding: 'utf8', cwd, timeout: 15000,
        env: { ...process.env, HOME: home },
      });
      assert.equal(r.status, 0, `--try failed on the host mount: ${r.stderr}`);

      const match = r.stderr.match(/changes will be saved in (\S+)/);
      assert.ok(match, `--try must announce its workdir, got stderr:\n${r.stderr}`);
      tryDir = match[1];

      assert.equal(r.stdout, `hello\n${tryDir}\n`,
        `--try must run in the COW workdir, got stdout:\n${r.stdout}`);
      assert.equal(fs.readFileSync(path.join(tryDir, 'made.txt'), 'utf8'), 'inside\n');
      assert.ok(!fs.existsSync(path.join(cwd, 'made.txt')),
        '--try must not write to the real directory');
      assert.equal(fs.readFileSync(path.join(cwd, 'keep.txt'), 'utf8'), 'hello\n');
    } finally {
      cleanup();
    }
  });
});
