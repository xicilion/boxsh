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
});
