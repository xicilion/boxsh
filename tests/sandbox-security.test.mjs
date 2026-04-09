/**
 * sandbox-security.test.mjs — Security boundary tests for boxsh sandbox.
 *
 * Verifies that the sandbox correctly prevents:
 *   Phase 1 — Symlink-based escape attempts
 *   Phase 2 — mv/rename bypass of RO binds
 *   Phase 3 — Network namespace isolation
 *   Phase 4 — Process lifecycle / orphan cleanup
 *   Phase 5 — Privilege escalation prevention
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BOXSH, TEMPDIR } from './helpers.mjs';

const IS_MACOS = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const HOME = os.homedir();

function tryRun(cwd, cmd, timeout_ms = 8000) {
  return spawnSync(BOXSH, ['--try', '-c', cmd], {
    encoding: 'utf8',
    cwd,
    timeout: timeout_ms,
  });
}

// ============================================================================
// Phase 1 — Symlink-based escape attempts
// ============================================================================

describe('Phase 1 — Symlink escape prevention', () => {

  test('write through symlink to $HOME sibling is blocked', () => {
    const cwd = fs.mkdtempSync(path.join(HOME, '.boxsh-cwd-'));
    const sib = fs.mkdtempSync(path.join(HOME, '.boxsh-sib-'));
    fs.writeFileSync(path.join(sib, 'data.txt'), 'original\n');
    fs.symlinkSync(path.join(sib, 'data.txt'), path.join(cwd, 'link'));
    try {
      const r = tryRun(cwd, 'echo evil > link 2>&1; echo EXIT:$?');
      assert.equal(r.status, 0, r.stderr);
      // Write must be blocked — host file unchanged.
      assert.equal(
        fs.readFileSync(path.join(sib, 'data.txt'), 'utf8'),
        'original\n',
        'SECURITY BUG: write through symlink reached host sibling!',
      );
    } finally {
      spawnSync('rm', ['-rf', cwd, sib]);
    }
  });

  test('symlink to $HOME sibling is readable (RO bind)', () => {
    const cwd = fs.mkdtempSync(path.join(HOME, '.boxsh-cwd-'));
    const sib = fs.mkdtempSync(path.join(HOME, '.boxsh-sib-'));
    fs.writeFileSync(path.join(sib, 'data.txt'), 'visible\n');
    fs.symlinkSync(path.join(sib, 'data.txt'), path.join(cwd, 'link'));
    try {
      const r = tryRun(cwd, 'cat link');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'visible\n');
    } finally {
      spawnSync('rm', ['-rf', cwd, sib]);
    }
  });

  test('symlink pointing to /etc/passwd cannot be overwritten', () => {
    const cwd = fs.mkdtempSync(path.join(HOME, '.boxsh-cwd-'));
    fs.symlinkSync('/etc/passwd', path.join(cwd, 'link-passwd'));
    try {
      const r = tryRun(cwd, 'echo pwned > link-passwd 2>&1; echo EXIT:$?');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        r.stdout.includes('EXIT:1') || r.stdout.includes('EXIT:2') ||
        r.stdout.includes('Permission denied') || r.stdout.includes('not permitted'),
        `Expected write to /etc/passwd via symlink to fail, got: ${r.stdout}`,
      );
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('directory symlink to parent cannot widen write scope', () => {
    // Create CWD with a symlink pointing to its parent.
    // Writes through that symlink should not reach the parent.
    const parent = fs.mkdtempSync(path.join(HOME, '.boxsh-parent-'));
    const cwd = path.join(parent, 'child');
    fs.mkdirSync(cwd);
    fs.symlinkSync(parent, path.join(cwd, 'escape'));
    try {
      const r = tryRun(cwd, 'echo pwned > escape/injected.txt 2>&1; echo EXIT:$?');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        !fs.existsSync(path.join(parent, 'injected.txt')),
        'SECURITY BUG: dir symlink to parent allowed write to host!',
      );
    } finally {
      spawnSync('rm', ['-rf', parent]);
    }
  });
});

// ============================================================================
// Phase 2 — mv/rename bypass of RO binds
// ============================================================================

describe('Phase 2 — mv/rename bypass prevention', () => {

  test('mv from RO-bound $HOME sibling to COW area is blocked', () => {
    const cwd = fs.mkdtempSync(path.join(HOME, '.boxsh-cwd-'));
    const sib = fs.mkdtempSync(path.join(HOME, '.boxsh-sib-'));
    fs.writeFileSync(path.join(sib, 'data.txt'), 'important\n');
    try {
      const r = tryRun(cwd,
        `mv ${sib}/data.txt ./stolen.txt 2>&1; echo MV_EXIT:$?`);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('MV_EXIT:1'),
        `Expected mv from RO sibling to fail, got: ${r.stdout}`);
      // Host file must remain.
      assert.ok(fs.existsSync(path.join(sib, 'data.txt')),
        'SECURITY BUG: mv from RO bind moved the host file!');
    } finally {
      spawnSync('rm', ['-rf', cwd, sib]);
    }
  });

  test('mv within COW area works normally', () => {
    const cwd = fs.mkdtempSync(path.join(HOME, '.boxsh-cwd-'));
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'content\n');
    try {
      const r = tryRun(cwd,
        'mv a.txt b.txt 2>&1; echo MV_EXIT:$?; cat b.txt');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('MV_EXIT:0'),
        `Expected mv within COW to succeed, got: ${r.stdout}`);
      assert.ok(r.stdout.includes('content'),
        'File content should be preserved after mv');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('rename host directory from RO bind is blocked', () => {
    const cwd = fs.mkdtempSync(path.join(HOME, '.boxsh-cwd-'));
    const sib = fs.mkdtempSync(path.join(HOME, '.boxsh-sib-'));
    fs.writeFileSync(path.join(sib, 'secret.txt'), 'data\n');
    try {
      const r = tryRun(cwd,
        `mv ${sib} ./captured 2>&1; echo MV_EXIT:$?`);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('MV_EXIT:1'),
        `Expected mv of RO dir to fail, got: ${r.stdout}`);
      assert.ok(fs.existsSync(sib),
        'SECURITY BUG: host directory was moved by the sandbox!');
    } finally {
      spawnSync('rm', ['-rf', cwd, sib]);
    }
  });
});

// ============================================================================
// Phase 3 — Network namespace isolation (--new-net-ns)
// ============================================================================

describe('Phase 3 — Network isolation', () => {

  test('--new-net-ns blocks outbound TCP connections', () => {
    const r = spawnSync(BOXSH, [
      '--sandbox', '--new-net-ns', '-c',
      'python3 -c "import socket; s=socket.socket(); s.settimeout(2); s.connect((\\\"1.1.1.1\\\",80))" 2>&1; echo EXIT:$?',
    ], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      r.stdout.includes('EXIT:1') || r.stdout.includes('not permitted') ||
      r.stdout.includes('Network is unreachable'),
      `Expected network to be blocked, got: ${r.stdout}`,
    );
  });

  test('--new-net-ns blocks DNS resolution', () => {
    const r = spawnSync(BOXSH, [
      '--sandbox', '--new-net-ns', '-c',
      'python3 -c "import socket; socket.getaddrinfo(\\\"example.com\\\",80)" 2>&1; echo EXIT:$?',
    ], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      r.stdout.includes('EXIT:1') || r.stdout.includes('not permitted') ||
      r.stdout.includes('Name or service not known') ||
      r.stdout.includes('nodename nor servname'),
      `Expected DNS to fail, got: ${r.stdout}`,
    );
  });

  test('sandbox without --new-net-ns allows network (baseline)', () => {
    // Verify that network works without the flag so we know the tests
    // above are detecting actual isolation, not a broken environment.
    const r = spawnSync(BOXSH, [
      '--sandbox', '-c',
      'python3 -c "import socket; s=socket.socket(); s.settimeout(3); s.connect((\\\"1.1.1.1\\\",80)); print(\\\"OK\\\")" 2>&1',
    ], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('OK'),
      `Expected network to work without --new-net-ns, got: ${r.stdout}`);
  });
});

// ─── Phase 4: Process lifecycle / orphan cleanup ───────────────────────────
describe('Phase 4 — Process lifecycle', () => {
  test('background process is reaped after sandbox exits', () => {
    // Launch a long sleep in the background, then exit the sandbox.
    // After the sandbox process terminates, the background sleep should
    // no longer be running (the sandbox should kill its children).
    const marker = `boxsh_orphan_test_${Date.now()}`;
    const r = spawnSync(BOXSH, [
      '--try', '-c',
      // Use exec to rename the sleep so we can identify it later
      `sh -c 'sleep 120 &' && echo ${marker}_$$`,
    ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });

    // Give a moment for cleanup
    spawnSync('sleep', ['0.5']);

    // Check if any sleep 120 processes from our sandbox are still alive
    const ps = spawnSync('ps', ['aux'], { encoding: 'utf8' });
    const orphans = ps.stdout.split('\n').filter(line =>
      line.includes('sleep 120') && !line.includes('grep')
    );

    // Clean up any orphans we find (best effort)
    for (const line of orphans) {
      const pid = line.trim().split(/\s+/)[1];
      if (pid) try { process.kill(Number(pid), 'SIGKILL'); } catch {}
    }

    assert.equal(orphans.length, 0,
      `Orphan "sleep 120" processes found after sandbox exit: ${orphans.join('\n')}`);
  });

  test('zombie processes are reaped inside sandbox', () => {
    // Fork a child that exits immediately — verify the sandbox's init
    // process reaps zombies so they don't accumulate.
    const r = tryRun(TEMPDIR, [
      'python3 -c "',
      'import subprocess, time;',
      'p = subprocess.Popen([\\\"sleep\\\", \\\"0\\\"]);',
      'time.sleep(0.3);',
      'import os; st = os.waitpid(p.pid, os.WNOHANG);',
      'print(\\\"reaped\\\" if st[0] != 0 else \\\"zombie\\\")',
      '"',
    ].join(''));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('reaped'),
      `Expected zombie to be reaped, got: ${r.stdout}`);
  });
});

// ─── Phase 5: Privilege escalation prevention ──────────────────────────────
describe('Phase 5 — Privilege escalation prevention', () => {
  test('chmod setuid bit is denied by Seatbelt',
    { skip: IS_LINUX && 'Linux user namespaces allow setuid on owned files' },
    () => {
    const r = tryRun(TEMPDIR,
      'cp /bin/echo ./test_suid && chmod 4755 ./test_suid 2>&1; echo EXIT=$?');
    // Seatbelt should deny the setuid bit change
    assert.ok(
      r.stdout.includes('Operation not permitted') || r.stdout.includes('EXIT=1'),
      `Expected chmod 4755 to be denied, got: ${r.stdout}`);
  });

  test('mknod device creation is denied', () => {
    const r = tryRun(TEMPDIR,
      'mknod ./fake_null c 1 3 2>&1; echo EXIT=$?');
    assert.ok(
      r.stdout.includes('Operation not permitted') ||
      r.stdout.includes('Permission denied') ||
      r.stdout.includes('EXIT=1'),
      `Expected mknod to be denied, got: ${r.stdout}`);
  });

  test('cannot write to /etc or other system directories', () => {
    const r = tryRun(TEMPDIR,
      'touch /etc/boxsh_test 2>&1; echo EXIT=$?');
    assert.ok(
      r.stdout.includes('Permission denied') ||
      r.stdout.includes('Read-only') ||
      r.stdout.includes('Operation not permitted') ||
      r.stdout.includes('EXIT=1'),
      `Expected write to /etc to be denied, got: ${r.stdout}`);
  });
});
