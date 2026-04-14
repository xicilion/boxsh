/**
 * sandbox-security.test.mjs — Security boundary tests for boxsh sandbox.
 *
 * Verifies that the sandbox correctly prevents:
 *   Phase 1 — Symlink-based escape attempts
 *   Phase 2 — mv/rename bypass of RO binds
 *   Phase 3 — Network namespace isolation
 *   Phase 4 — Process lifecycle / orphan cleanup
 *   Phase 5 — Privilege escalation prevention
 *   Phase 6 — PID namespace isolation (Linux)
 *   Phase 7 — /proc information leakage (Linux)
 *   Phase 8 — ptrace protection (Linux)
 *   Phase 9 — PID 1 zombie reaping (Linux)
 *   Phase 10 — Dangerous dotfile write protection (Linux)
 *   Phase 11 — seccomp syscall filtering (Linux)
 *   Phase 12 — Symlink TOCTOU attacks in sandbox mode (Linux)
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

// ============================================================================
// Phase 6 — PID namespace isolation (Linux)
// ============================================================================

describe('Phase 6 — PID namespace isolation', () => {

  test('sandbox cannot see host processes via ps',
    { skip: !IS_LINUX },
    () => {
    // If PID namespace is isolated, ps should show very few processes
    // (only the sandbox's own processes), not the full host process list.
    const r = spawnSync(BOXSH, ['--sandbox', '-c',
      'ps aux 2>/dev/null | wc -l',
    ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
    assert.equal(r.status, 0, r.stderr);
    const lineCount = parseInt(r.stdout.trim(), 10);
    // A properly isolated PID ns should have very few processes (< 10).
    // An unisolated sandbox will see all host processes (typically 50+).
    assert.ok(lineCount < 10,
      `SECURITY BUG: sandbox sees ${lineCount} processes — host PID namespace is exposed!`);
  });

  test('sandbox cannot send signals to host processes',
    { skip: !IS_LINUX },
    () => {
    // Get the PID of the current Node.js test process (host).
    // The sandbox should not be able to signal it.
    const hostPid = process.pid;
    const r = spawnSync(BOXSH, ['--sandbox', '-c',
      `kill -0 ${hostPid} 2>&1; echo EXIT=$?`,
    ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      r.stdout.includes('EXIT=1') || r.stdout.includes('No such process'),
      `SECURITY BUG: sandbox can signal host PID ${hostPid}! Got: ${r.stdout}`);
  });

  test('sandbox PID 1 is the sandbox init, not host init',
    { skip: !IS_LINUX },
    () => {
    // In a proper PID namespace, PID 1 should be the sandbox's own init
    // process, not the host systemd/init.
    const r = spawnSync(BOXSH, ['--sandbox', '-c',
      'cat /proc/1/cmdline 2>&1 | tr "\\0" " "; echo',
    ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
    assert.equal(r.status, 0, r.stderr);
    // If PID ns is isolated, /proc/1/cmdline should be the sandbox process
    // (dash or boxsh), not systemd/init.
    assert.ok(
      !r.stdout.includes('systemd') && !r.stdout.includes('/sbin/init'),
      `SECURITY BUG: /proc/1 is host init, PID namespace not isolated! Got: ${r.stdout}`);
  });
});

// ============================================================================
// Phase 7 — /proc information leakage (Linux)
// ============================================================================

describe('Phase 7 — /proc information leakage', () => {

  test('sandbox cannot read host process environ via /proc',
    { skip: !IS_LINUX },
    () => {
    // Set a secret env var in the host, then try to read it from sandbox
    // via /proc/<host_pid>/environ.
    const hostPid = process.pid;
    const r = spawnSync(BOXSH, ['--sandbox', '-c',
      `cat /proc/${hostPid}/environ 2>&1; echo EXIT=$?`,
    ], {
      encoding: 'utf8', timeout: 8000, cwd: TEMPDIR,
      env: { ...process.env, BOXSH_SECRET_TOKEN: 'leaked_credential_12345' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      !r.stdout.includes('leaked_credential_12345'),
      `SECURITY BUG: sandbox can read host process environment variables!`);
  });

  test('sandbox cannot enumerate host PIDs in /proc',
    { skip: !IS_LINUX },
    () => {
    // In a proper PID ns with its own /proc mount, ls /proc should show
    // only the sandbox's own PIDs, not hundreds of host PIDs.
    const r = spawnSync(BOXSH, ['--sandbox', '-c',
      'ls -d /proc/[0-9]* 2>/dev/null | wc -l',
    ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
    assert.equal(r.status, 0, r.stderr);
    const pidCount = parseInt(r.stdout.trim(), 10);
    // A properly isolated /proc should show very few PIDs (< 10).
    assert.ok(pidCount < 10,
      `SECURITY BUG: /proc exposes ${pidCount} PIDs — host /proc is mounted!`);
  });

  test('sandbox cannot read host process cmdline',
    { skip: !IS_LINUX },
    () => {
    const hostPid = process.pid;
    const r = spawnSync(BOXSH, ['--sandbox', '-c',
      `cat /proc/${hostPid}/cmdline 2>&1; echo EXIT=$?`,
    ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      r.stdout.includes('No such file') || r.stdout.includes('EXIT=1') ||
      !r.stdout.includes('node'),
      `SECURITY BUG: sandbox can read host process cmdline via /proc!`);
  });
});

// ============================================================================
// Phase 8 — ptrace protection (Linux)
// ============================================================================

describe('Phase 8 — ptrace protection', () => {

  test('process inside sandbox is not dumpable (PR_GET_DUMPABLE)',
    { skip: !IS_LINUX },
    () => {
    // PR_GET_DUMPABLE should return 0 if ptrace protection is applied.
    const r = spawnSync(BOXSH, ['--sandbox', '-c',
      'python3 -c "import ctypes; libc=ctypes.CDLL(None); print(libc.prctl(4,0,0,0,0))"',
    ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim() === '0',
      `SECURITY BUG: sandbox process is dumpable (ptrace-able)! PR_GET_DUMPABLE=${r.stdout.trim()}`);
  });
});

// ============================================================================
// Phase 9 — PID 1 reaper: orphan processes must not become zombies
// ============================================================================

describe('Phase 9 — PID 1 zombie reaping', () => {

  test('orphaned grandchild processes are reaped (no zombies)',
    { skip: !IS_LINUX },
    () => {
    // Create a child that spawns a grandchild, then the child exits.
    // The grandchild becomes an orphan re-parented to PID 1.
    // After the grandchild exits, PID 1 must reap it — otherwise it
    // stays as a zombie (<defunct>).
    //
    // Strategy:
    //   1. sh spawns a background sub-shell that itself spawns a
    //      short-lived sleep, then the sub-shell exits immediately.
    //   2. Wait a moment for the grandchild to finish.
    //   3. Check /proc for any zombie (Z state) processes.
    const r = spawnSync(BOXSH, ['--sandbox', '-c', [
      // Spawn a sub-shell that creates a grandchild and exits immediately
      '( (sleep 0.3 ; exit 0) & exit 0 )',
      // Wait for the grandchild to finish
      'sleep 0.8',
      // Count zombie processes (state Z in /proc/*/stat)
      'zombies=0',
      'for f in /proc/[0-9]*/stat; do',
      '  if [ -f "$f" ] 2>/dev/null; then',
      '    state=$(cat "$f" 2>/dev/null | sed "s/.*) //" | cut -c1)',
      '    if [ "$state" = "Z" ]; then zombies=$((zombies+1)); fi',
      '  fi',
      'done',
      'echo "ZOMBIES=$zombies"',
    ].join('\n')], {
      encoding: 'utf8', timeout: 15000, cwd: TEMPDIR,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const m = r.stdout.match(/ZOMBIES=(\d+)/);
    assert.ok(m, `unexpected output: ${r.stdout}`);
    assert.equal(m[1], '0',
      `BUG: PID 1 is not reaping orphans — found ${m[1]} zombie(s)!\n${r.stdout}`);
  });
});

// ============================================================================
// Phase 10 — Dangerous dotfile write protection
// ============================================================================

describe('Phase 10 — dangerous dotfile write protection', () => {

  // When $HOME is exposed read-write inside the sandbox (e.g. --bind wr:$HOME),
  // the sandbox must still prevent writes to shell config files (.bashrc, etc.)
  // and tool config files (.gitconfig, .mcp.json) that could be used for
  // persistent backdoors surviving sandbox teardown.

  const dangerousFiles = [
    '.bashrc',
    '.bash_profile',
    '.profile',
    '.zshrc',
    '.gitconfig',
  ];

  for (const dotfile of dangerousFiles) {
    test(`cannot write to ~/${dotfile} even with wr:$HOME bind`,
      () => {
      const marker = `BOXSH_PROBE_${Date.now()}`;
      const r = spawnSync(BOXSH, [
        '--sandbox', '--bind', `wr:${HOME}`, '-c',
        `echo ${marker} >> ~/${dotfile} 2>&1; echo STATUS=$?`,
      ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
      assert.equal(r.status, 0, `boxsh crashed: ${r.stderr}`);

      // The write must have been denied.
      assert.ok(
        r.stdout.includes('Read-only') || r.stdout.includes('Permission denied') ||
        r.stdout.includes('Operation not permitted') || r.stdout.includes('STATUS=1') ||
        r.stdout.includes('STATUS=2'),
        `SECURITY BUG: sandbox allowed write to ~/${dotfile}!\n${r.stdout}`);

      // Double-check: the marker must NOT appear in the real host file.
      const hostFile = path.join(HOME, dotfile);
      if (fs.existsSync(hostFile)) {
        const content = fs.readFileSync(hostFile, 'utf8');
        assert.ok(!content.includes(marker),
          `SECURITY BUG: marker written to real host ~/${dotfile}!`);
      }
    });
  }

  test('cannot write to .git/hooks/ even with wr:$HOME bind',
    { skip: 'requires path-pattern blocking (seccomp or FS walk)' },
    () => {
    // Create a temp git repo under HOME to test .git/hooks protection.
    const repoDir = path.join(TEMPDIR, `boxsh-git-hooks-test-${process.pid}`);
    try {
      spawnSync('git', ['init', repoDir], { encoding: 'utf8' });
      const marker = `BOXSH_HOOK_PROBE_${Date.now()}`;
      const hookPath = path.join(repoDir, '.git/hooks/pre-commit');
      const r = spawnSync(BOXSH, [
        '--sandbox', '--bind', `wr:${HOME}`, '-c',
        `echo '#!/bin/sh\necho ${marker}' > ${hookPath} 2>&1; echo STATUS=$?`,
      ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
      assert.equal(r.status, 0, `boxsh crashed: ${r.stderr}`);

      assert.ok(
        r.stdout.includes('Read-only') || r.stdout.includes('Permission denied') ||
        r.stdout.includes('Operation not permitted') || r.stdout.includes('STATUS=1') ||
        r.stdout.includes('STATUS=2'),
        `SECURITY BUG: sandbox allowed write to .git/hooks/!\n${r.stdout}`);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Phase 11 — seccomp syscall filtering (Linux)
// ============================================================================

describe('Phase 11 — seccomp syscall filtering', () => {

  test('sandbox blocks AF_UNIX socket creation',
    { skip: !IS_LINUX || process.env.BUILD_ARCH === 'ia32' },
    () => {
    // AF_UNIX sockets can be used to connect to Docker daemon, SSH agent,
    // or D-Bus.  The sandbox should block socket(AF_UNIX, ...).
    const r = spawnSync(BOXSH, ['--sandbox', '-c',
      // Use python3 to attempt creating a Unix domain socket.
      `python3 -c "
import socket, sys
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    print('UNIX_SOCKET=allowed')
    s.close()
except OSError as e:
    print(f'UNIX_SOCKET=blocked ({e})')
"`,
    ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
    assert.equal(r.status, 0, `boxsh crashed: ${r.stderr}`);
    assert.ok(r.stdout.includes('UNIX_SOCKET=blocked'),
      `SECURITY BUG: sandbox allows AF_UNIX socket creation!\n${r.stdout}`);
  });

  test('sandbox blocks io_uring syscalls',
    { skip: !IS_LINUX || process.env.BUILD_ARCH === 'ia32' },
    () => {
    // io_uring can bypass seccomp filters applied to regular syscalls.
    // The sandbox should block io_uring_setup (syscall 425 on x86_64).
    const r = spawnSync(BOXSH, ['--sandbox', '-c',
      `python3 -c "
import ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)

# io_uring_setup = syscall 425 on x86_64
SYS_io_uring_setup = 425
ret = libc.syscall(SYS_io_uring_setup, 1, ctypes.c_void_p(0))
import ctypes.util
errno_val = ctypes.get_errno()
if ret < 0 and errno_val in (1, 38):  # EPERM or ENOSYS
    print('IO_URING=blocked')
else:
    # EFAULT (14) means the syscall was allowed but faulted on NULL params
    print(f'IO_URING=allowed (ret={ret}, errno={errno_val})')
"`,
    ], { encoding: 'utf8', timeout: 8000, cwd: TEMPDIR });
    assert.equal(r.status, 0, `boxsh crashed: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('IO_URING=blocked') || r.stdout.includes('IO_URING=unsupported'),
      `SECURITY BUG: sandbox allows io_uring syscalls!\n${r.stdout}`);
  });
});

// ============================================================================
// Phase 12 — Symlink TOCTOU attacks in sandbox mode
// ============================================================================

describe('Phase 12 — symlink TOCTOU attacks in sandbox mode', () => {

  // In --sandbox --bind wr:DIR mode, the writable directory is directly on the
  // host filesystem.  If the sandbox process creates a symlink inside the
  // writable area pointing to a protected path (e.g. ~/.ssh/authorized_keys),
  // writing to that symlink would modify the real host file.
  //
  // This is distinct from Phase 1 (--try mode) where overlay captures writes.

  test('symlink inside wr bind pointing to protected file is blocked',
    { skip: !IS_LINUX },
    () => {
    const workDir = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-symlink-'));
    const secretFile = path.join(TEMPDIR, `boxsh-secret-${process.pid}.txt`);
    try {
      fs.writeFileSync(secretFile, 'SECRET_DATA\n');
      const r = spawnSync(BOXSH, [
        '--sandbox', '--bind', `wr:${workDir}`, '-c',
        // Create a symlink inside the writable dir that points to the secret
        `ln -sf ${secretFile} ${workDir}/evil-link && ` +
        `echo INJECTED > ${workDir}/evil-link 2>&1; echo STATUS=$?`,
      ], { encoding: 'utf8', timeout: 8000, cwd: workDir });
      assert.equal(r.status, 0, `boxsh crashed: ${r.stderr}`);

      // The host secret file must NOT have been modified.
      const content = fs.readFileSync(secretFile, 'utf8');
      assert.equal(content, 'SECRET_DATA\n',
        `SECURITY BUG: symlink TOCTOU attack modified host file!\n` +
        `Host file now contains: ${content}\nstdout: ${r.stdout}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(secretFile, { force: true });
    }
  });

  test('directory replacement with symlink cannot redirect writes',
    { skip: !IS_LINUX },
    () => {
    // Attack: remove a protected directory and replace it with a symlink
    // to a sensitive directory.  Subsequent writes should not follow the link.
    const workDir = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-dirsym-'));
    const targetDir = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-target-'));
    const subDir = path.join(workDir, 'subdir');
    fs.mkdirSync(subDir);
    try {
      const r = spawnSync(BOXSH, [
        '--sandbox', '--bind', `wr:${workDir}`, '-c',
        // Remove subdir, create symlink to target, then write through it
        `rm -rf ${subDir} && ` +
        `ln -sf ${targetDir} ${subDir} && ` +
        `echo PWNED > ${subDir}/injected.txt 2>&1; echo STATUS=$?`,
      ], { encoding: 'utf8', timeout: 8000, cwd: workDir });
      assert.equal(r.status, 0, `boxsh crashed: ${r.stderr}`);

      // The target directory must NOT contain the injected file.
      assert.ok(
        !fs.existsSync(path.join(targetDir, 'injected.txt')),
        `SECURITY BUG: directory symlink replacement allowed write to ` +
        `target dir outside writable bind!\nstdout: ${r.stdout}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
