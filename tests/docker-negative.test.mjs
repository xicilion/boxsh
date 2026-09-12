/**
 * docker-negative.test.mjs — error-reporting contract for the container engine.
 *
 * Run ONLY inside a --user 65534 container that lacks /dev/fuse (the
 * negative-path invocation in tests/docker-test.sh).  It asserts that a COW
 * request fails with an actionable error mentioning --device /dev/fuse,
 * rather than a bare exit-status or a silent crash.  (Root containers never
 * reach the COW step — they are rejected up front; see
 * docker-root-reject.test.mjs.)
 *
 * Not registered in tests/index.test.mjs: the normal CI container provides
 * /dev/fuse, so this would skip there anyway.  Kept as a standalone file so
 * the dev script can run it in a deliberately-degraded container.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, TEMPDIR, toJsonRpc } from './helpers.mjs';

const IN_CONTAINER =
  fs.existsSync('/.dockerenv') ||
  (fs.existsSync('/proc/1/cgroup') &&
    fs.readFileSync('/proc/1/cgroup', 'utf8').split('\n')
      .some(l => l.includes('docker') || l.includes('containerd') || l.includes('kubepods')));

const HAS_DEV_FUSE = fs.existsSync('/dev/fuse');

function makeCowDirs() {
  // Deliberately create the COW dirs on the container's OWN root filesystem
  // (overlay2): the kernel overlay mount fails there (overlay-on-overlay),
  // forcing the fuse-overlayfs path — which is what this test must exercise
  // without /dev/fuse.  On a plain host bind (e.g. /src/temp) the kernel
  // overlay would succeed and the test would not be testing anything.  The
  // suite runs as --user 65534, so /tmp (overlay rootfs, world-writable)
  // is usable without any chown.
  const base = fs.mkdtempSync('/tmp/boxsh-docker-neg-');
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  return {
    src, dst,
    cleanup: () => {
      spawnSync('chmod', ['-R', 'u+rwx', base]);
      spawnSync('rm', ['-rf', base]);
    },
  };
}

describe('docker-negative — COW without /dev/fuse', () => {
  test('COW request reports actionable /dev/fuse error', {
    skip: (!IN_CONTAINER && 'not running inside a container') ||
          (HAS_DEV_FUSE && '/dev/fuse present — run this file in a container without --device /dev/fuse'),
  }, () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      const input = JSON.stringify(toJsonRpc({ id: '1', cmd: `echo x > ${dst}/file` })) + '\n';
      const r = run(
        ['--rpc', '--workers', '1', '--sandbox', '--bind', `cow:${src}:${dst}`],
        input,
        10000,
      );
      // sandbox_apply fails before the RPC loop starts → non-zero exit, no
      // JSON-RPC stdout.  The actionable error must reach stderr.
      assert.notEqual(r.status, 0,
        `expected boxsh to fail without /dev/fuse, got exit ${r.status}`);
      const msg = r.stderr + r.stdout;
      assert.ok(msg.includes('/dev/fuse'),
        `expected /dev/fuse hint in error output, got:\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('host-mount destination without /dev/fuse: works, or fails actionably', {
    skip: (!IN_CONTAINER && 'not running inside a container') ||
          (HAS_DEV_FUSE && '/dev/fuse present — run this file in a container without --device /dev/fuse'),
  }, () => {
    // Destination on the harness bind mount (the workspace-data layout).  On
    // macOS/Docker (virtiofs) the kernel overlay comes up read-only there, so
    // this is the path that needs fuse-overlayfs — without /dev/fuse boxsh
    // must report the actionable hint instead of failing somewhere deep.  On
    // plain Linux filesystems the kernel overlay is used and the request must
    // succeed with a writable merge point.  Both outcomes are acceptable; a
    // silent broken COW (read-only merge, EROFS on write) is not.
    //
    // Unlike the COW dirs above these live on the harness bind mount (TEMPDIR):
    // the filesystem type decides which engine boxsh needs, and this is the
    // mount that is virtiofs on macOS/Docker.
    const base = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-docker-neg-hostmount-'));
    const src = path.join(base, 'src');
    const dst = path.join(base, 'dst');
    fs.mkdirSync(src);
    fs.mkdirSync(dst);
    const cleanup = () => {
      spawnSync('chmod', ['-R', 'u+rwx', base]);
      spawnSync('rm', ['-rf', base]);
    };
    try {
      fs.writeFileSync(path.join(src, 'seed.txt'), 'seed\n');
      const input = JSON.stringify(toJsonRpc({
        id: '1',
        cmd: `cat ${dst}/seed.txt && echo written > ${dst}/new.txt`,
      })) + '\n';
      const r = run(
        ['--rpc', '--workers', '1', '--sandbox', '--bind', `cow:${src}:${dst}`],
        input,
        10000,
      );
      const msg = r.stderr + r.stdout;

      if (r.status !== 0) {
        assert.ok(msg.includes('/dev/fuse'),
          'a COW that cannot be mounted must name the missing /dev/fuse, got:'
          + `\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
        assert.ok(!/Read-only file system|EROFS/.test(msg),
          'the failure must be reported up front, not as an EROFS on write:'
          + `\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
      } else {
        assert.ok(fs.existsSync(path.join(dst, 'new.txt')),
          'a successful request must have written through the COW mount');
        assert.equal(fs.readFileSync(path.join(src, 'seed.txt'), 'utf8'), 'seed\n');
      }
    } finally {
      cleanup();
    }
  });
});
