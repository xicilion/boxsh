/**
 * docker.test.mjs — container-engine contract tests.
 *
 * These tests assert boxsh's Docker self-adaptation.  boxsh inside a
 * container MUST run as a non-root user (docker run --user): the sandbox
 * then uses the same unprivileged userns engine as on the host
 * (CLONE_NEWUSER + CLONE_NEWNS + CLONE_NEWPID + pivot_root + seccomp),
 * giving host-equivalent DAC isolation.  Root containers are rejected with
 * an actionable error before any namespace syscall — see
 * tests/docker-root-reject.test.mjs (the harness runs this file in a
 * --user container).  In the container userns engine /proc is a read-only
 * bind of the container's /proc (fresh procfs mounts are refused inside a
 * nested user namespace) and COW goes through fuse-overlayfs.
 *
 * The entire file skips automatically when not running inside a container, so
 * it is safe to include from tests/index.test.mjs on the host CI matrix.
 *
 * Required container privileges (provided by tests/docker-test.sh):
 *   --user 65534:65534 --security-opt seccomp=unconfined --device /dev/fuse
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, TEMPDIR, toJsonRpc, fromJsonRpc } from './helpers.mjs';

// --- container detection (mirrors src/sandbox.cpp running_in_container) -----

const IN_CONTAINER =
  fs.existsSync('/.dockerenv') ||
  (fs.existsSync('/proc/1/cgroup') &&
    fs.readFileSync('/proc/1/cgroup', 'utf8').split('\n')
      .some(l => l.includes('docker') || l.includes('containerd') || l.includes('kubepods')));

const skip = !IN_CONTAINER && 'not running inside a container — docker tests run in the separate docker-test CI job';

// --- helpers ---------------------------------------------------------------

// A writable directory for the sandbox to bind.  The harness runs the suite
// as the container user (--user 65534), so dirs created here are owned by
// that uid and stay writable inside the sandbox (userns 0 -> 65534) with no
// chown involved.
function makeUserDir(prefix) {
  return fs.mkdtempSync(path.join(TEMPDIR, prefix));
}

function makeCowDirs() {
  const base = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-docker-'));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  return {
    src, dst,
    cleanup: () => {
      // fuse-overlayfs upper/work dirs may have restrictive perms.
      spawnSync('chmod', ['-R', 'u+rwx', base]);
      spawnSync('rm', ['-rf', base]);
    },
  };
}

/** Run boxsh with --sandbox + extra flags, single JSON-RPC request. */
function rpcWith(extraFlags, req, timeout_ms = 10000) {
  const input = JSON.stringify(toJsonRpc(req)) + '\n';
  const r = run(
    ['--rpc', '--workers', '1', '--sandbox', ...extraFlags],
    input,
    timeout_ms,
  );
  assert.equal(r.signal, null, `boxsh killed by signal ${r.signal}\nstderr: ${r.stderr}`);
  const line = r.stdout.trim();
  // sandbox_apply may fail (e.g. missing /dev/fuse); callers inspect stderr.
  if (line.length === 0) {
    return { _no_output: true, stderr: r.stderr, status: r.status };
  }
  return { ...fromJsonRpc(JSON.parse(line)), stderr: r.stderr, status: r.status };
}

function rpcCow(src, dst, cmd, timeout_ms = 10000) {
  return rpcWith(['--bind', `cow:${src}:${dst}`], { id: '1', cmd }, timeout_ms);
}

// ---------------------------------------------------------------------------

describe('docker — container engine', { skip }, () => {
  test('sandbox runs the unprivileged userns engine as the container user', () => {
    const work = makeUserDir('boxsh-docker-drop-');
    try {
      const r = run(['--sandbox', '--bind', `wr:${work}`, '-c', 'echo ok'],
        '', 10000);
      assert.equal(r.status, 0,
        `sandbox shell failed; stderr: ${r.stderr}`);
      assert.equal(r.stdout.trim(), 'ok');
      // Engine notices must be emitted so users can confirm the engine.
      assert.ok(r.stderr.includes('host-equivalent userns engine'),
        `expected userns engine notice on stderr, got: ${r.stderr}`);
    } finally {
      spawnSync('rm', ['-rf', work]);
    }
  });

  test('COW via fuse-overlayfs: writes go to dst, src untouched (task.flow scenario)', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.writeFileSync(path.join(src, 'task.flow'), 'original\n');
      const resp = rpcCow(src, dst,
        `echo modified > ${dst}/task.flow && echo new > ${dst}/extra.flow`);
      assert.equal(resp.exit_code, 0,
        `cmd failed; stderr: ${resp.stderr}\nstdout: ${resp.stdout}`);
      // Source must be untouched — this is the core COW guarantee.
      assert.equal(fs.readFileSync(path.join(src, 'task.flow'), 'utf8'),
        'original\n');
      // Writes land in the destination (fuse-overlayfs upper layer).
      assert.equal(fs.readFileSync(path.join(dst, 'task.flow'), 'utf8'),
        'modified\n');
      assert.equal(fs.readFileSync(path.join(dst, 'extra.flow'), 'utf8'),
        'new\n');
    } finally {
      cleanup();
    }
  });

  test('COW src-layer files are readable at the dst mount point', () => {
    const { src, dst, cleanup } = makeCowDirs();
    try {
      fs.writeFileSync(path.join(src, 'readme.txt'), 'from-src\n');
      const resp = rpcCow(src, dst, `cat ${dst}/readme.txt`);
      assert.equal(resp.exit_code, 0,
        `cmd failed; stderr: ${resp.stderr}`);
      assert.equal(resp.stdout, 'from-src\n');
    } finally {
      cleanup();
    }
  });

  test('write tool can create a file at the sandbox root (task.flow upload regression)', () => {
    // Regression for the "task.flow upload fails" symptom: when sandbox_apply
    // succeeds the RPC loop starts and the write tool must work.  /task.flow
    // lives on the fresh tmpfs root inside the sandbox.
    const work = makeUserDir('boxsh-docker-write-');
    try {
      const resp = rpcWith(
        ['--bind', `wr:${work}`],
        { id: '1', tool: 'write', path: '/task.flow', content: 'uploaded\n' },
      );
      assert.ok(!resp.error, `write tool failed: ${resp.error}`);
      assert.ok(resp.content && resp.content.some(c => c.text && c.text.includes('bytes')),
        `unexpected write response: ${JSON.stringify(resp)}`);
    } finally {
      spawnSync('rm', ['-rf', work]);
    }
  });

  test('sandbox isolation still holds: host /etc/hostname not the live root', () => {
    // After pivot_root the sandbox root is a fresh tmpfs.  A file we write at
    // /marker.flow must be visible, but the host root must not leak through.
    const work = makeUserDir('boxsh-docker-iso-');
    try {
      const r = run(['--sandbox', '--bind', `wr:${work}`, '-c',
        'echo sandbox > /marker.flow && test -f /marker.flow && echo present'],
        '', 10000);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.stdout.trim(), 'present');
      // The marker must NOT exist on the host filesystem (it was inside the ns).
      assert.ok(!fs.existsSync('/marker.flow'),
        'sandbox leaked a file to the host root');
    } finally {
      spawnSync('rm', ['-rf', work]);
    }
  });

  test('system mounts are read-only in container mode (no inter-sandbox leakage)', () => {
    // The container userns engine sandbox is an unprivileged uid, so kernel
    // DAC already protects root-owned system files.  The system bind mounts
    // (/usr, /etc, /var, /run) are additionally pinned explicitly read-only
    // (defense in depth) — one sandbox must never modify shared container
    // state that other sandboxes see, breaking inter-sandbox isolation.
    const work = makeUserDir('boxsh-docker-ro-');
    const probes = [
      '/var/.boxsh_ro_probe',
      '/usr/local/.boxsh_ro_probe',
      '/etc/.boxsh_ro_probe',
      '/run/.boxsh_ro_probe',
    ];

    // Pre-condition: probes must not pre-exist on the container FS.
    for (const p of probes) {
      assert.ok(!fs.existsSync(p),
        `pre-condition failed: ${p} already exists on container FS`);
    }

    try {
      for (const p of probes) {
        const r = run(['--sandbox', '--bind', `wr:${work}`, '-c', `touch ${p}`], '', 10000);
        // touch must fail — the bind must be read-only.
        assert.notEqual(r.status, 0,
          `expected touch ${p} to fail inside sandbox, got status ${r.status}\n` +
          `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
        // The error should mention read-only / EROFS.
        const combined = `${r.stdout}\n${r.stderr}`;
        assert.ok(/read-only|readonly|EROFS/i.test(combined),
          `expected read-only error for ${p}, got: ${combined}`);
        // CRITICAL: the write must NOT leak to the container FS.
        assert.ok(!fs.existsSync(p),
          `LEAK: ${p} was created on the container FS — ` +
          `system mount is writable, violating inter-sandbox isolation`);
      }
    } finally {
      // Defensive cleanup — should be a no-op on pass.
      for (const p of probes) {
        try { fs.unlinkSync(p); } catch { /* already absent */ }
      }
      spawnSync('rm', ['-rf', work]);
    }
  });
});
