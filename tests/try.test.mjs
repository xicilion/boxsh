/**
 * try.test.mjs — tests for the --try quick-sandbox mode.
 *
 * --try is a shorthand that automatically enables --sandbox and mounts the
 * current directory as a COW overlay backed by a fresh temp directory.  The
 * original directory is never modified; all writes go to the temp upper layer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BOXSH, TEMPDIR } from './helpers.mjs';

// In containers the default HOME may not exist (e.g. /nonexistent for uid
// 65534); fall back to TEMPDIR so the $HOME-sibling isolation tests run
// identically on host and in containers.
const HOMEDIR = os.homedir();
const HOME_FALLBACK = fs.existsSync(HOMEDIR) ? HOMEDIR : TEMPDIR;

// Container detection (mirrors src/sandbox.cpp running_in_container).
// In a container, the process runs as root without CLONE_NEWUSER, so Unix
// permission-based protections (e.g. /root 0700, /usr root-owned) do not
// apply — root can access and write anywhere.
const IN_CONTAINER =
  fs.existsSync('/.dockerenv') ||
  (fs.existsSync('/proc/1/cgroup') &&
    fs.readFileSync('/proc/1/cgroup', 'utf8').split('\n')
      .some(l => l.includes('docker') || l.includes('containerd') || l.includes('kubepods')));

// ---------------------------------------------------------------------------
// Helper: run boxsh --try with a given CWD and -c command.
// ---------------------------------------------------------------------------

function tryRun(cwd, cmd, timeout_ms = 5000) {
  return spawnSync(BOXSH, ['--try', '-c', cmd], {
    encoding: 'utf8',
    cwd,
    timeout: timeout_ms,
    // --try binds $HOME read-only; make sure it points at a real directory
    // even in containers (where the default HOME may not exist).
    env: { ...process.env, HOME: HOME_FALLBACK },
  });
}

/** Extract the save directory path printed by --try to stderr.
 * Returns the full dst path (e.g. /tmp/boxsh-try-XXXXXX/work).
 * Handles both /tmp/... and /private/tmp/... (macOS symlink resolution). */
function parseTmpdir(stderr) {
  const m = stderr.match(/changes will be saved in (\S+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Basic behaviour
// ---------------------------------------------------------------------------

describe('--try mode', () => {
  test('exits 0 and prints temp dir path to stderr', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'true');
      assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
      assert.match(r.stderr, /changes will be saved in .+boxsh-try-/);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('appears as root inside the sandbox',
    { skip: process.platform === 'darwin' ? 'Linux user namespaces not available on macOS' : false },
    () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'whoami');
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), 'root');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('CWD inside sandbox is the COW work directory', () => {
    // --try mounts CWD as COW src; the process starts in dst (the merge view).
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'pwd');
      assert.equal(r.status, 0);
      const dst = parseTmpdir(r.stderr);
      assert.ok(dst, 'could not parse dst from stderr');
      assert.equal(r.stdout.trim(), dst);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  // ---------------------------------------------------------------------------
  // COW isolation
  // ---------------------------------------------------------------------------

  test('new file written inside sandbox appears in upper, not in real CWD', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'touch sandbox-new-file');
      assert.equal(r.status, 0, r.stderr);
      const tmpdir = parseTmpdir(r.stderr);
      assert.ok(tmpdir, 'could not parse tmpdir from stderr');

      assert.ok(fs.existsSync(path.join(tmpdir, 'sandbox-new-file')),
        'new file must appear in dst (upper layer)');
      assert.ok(!fs.existsSync(path.join(cwd, 'sandbox-new-file')),
        'new file must not appear in real CWD');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('existing file modified inside sandbox: upper has copy, original unchanged', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    const original = 'original content\n';
    fs.writeFileSync(path.join(cwd, 'data.txt'), original);
    try {
      const r = tryRun(cwd, 'echo modified > data.txt');
      assert.equal(r.status, 0, r.stderr);
      const tmpdir = parseTmpdir(r.stderr);
      assert.ok(tmpdir, 'could not parse tmpdir from stderr');

      // Original must be untouched.
      assert.equal(fs.readFileSync(path.join(cwd, 'data.txt'), 'utf8'), original);
      // Modified copy in dst (upper layer).
      assert.equal(
        fs.readFileSync(path.join(tmpdir, 'data.txt'), 'utf8'),
        'modified\n',
      );
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('existing file is visible and readable inside sandbox', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello\n');
    try {
      const r = tryRun(cwd, 'cat hello.txt');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'hello\n');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('file deleted inside sandbox leaves whiteout in upper, original intact',
    { skip: process.platform === 'darwin' ? 'clonefile COW does not create overlayfs-style whiteout entries' : false },
    () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    fs.writeFileSync(path.join(cwd, 'victim.txt'), 'delete me\n');
    try {
      const r = tryRun(cwd, 'rm victim.txt && [ ! -e victim.txt ] && echo gone');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'gone');

      // Original preserved.
      assert.equal(
        fs.readFileSync(path.join(cwd, 'victim.txt'), 'utf8'),
        'delete me\n',
      );
      // Whiteout in dst (upper layer).
      const tmpdir = parseTmpdir(r.stderr);
      const wh = fs.statSync(path.join(tmpdir, 'victim.txt'));
      assert.ok(wh.isCharacterDevice() && wh.rdev === 0, 'expected whiteout entry');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  // ---------------------------------------------------------------------------
  // Temp directory is retained after exit
  // ---------------------------------------------------------------------------

  test('temp directory is retained after the shell exits', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'touch keep-me');
      assert.equal(r.status, 0, r.stderr);
      const tmpdir = parseTmpdir(r.stderr);
      assert.ok(tmpdir, 'could not parse tmpdir from stderr');
      assert.ok(fs.existsSync(tmpdir), 'temp directory must be retained after exit');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  // ---------------------------------------------------------------------------
  // Exit code propagation
  // ---------------------------------------------------------------------------

  test('propagates non-zero exit code from the shell', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'exit 42');
      assert.equal(r.status, 42);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });
});

// ---------------------------------------------------------------------------
// Sandbox isolation
//
// --sandbox always pivots into a fresh tmpfs root.  Only the paths explicitly
// mounted (auto system dirs + user --bind) are accessible.  Every
// other path on the host is unreachable from inside.
//
// IMPORTANT: Tests in this suite deliberately use os.homedir() for CWD and
// sibling directories.  Using os.tmpdir() would give a false sense of
// security: sandbox /tmp is a fresh tmpfs, so /tmp siblings are naturally
// hidden regardless of any isolation logic.  The real attack surface is
// directories that share a parent with and are bind-mounted alongside CWD --
// e.g. $HOME siblings when /home is bind-mounted by --try.
// ---------------------------------------------------------------------------

describe('--try mode — sandbox isolation', () => {
  // ---- /tmp-based siblings (sanity check, passes by fresh-tmpfs isolation) ----

  test('sibling temp dir in /tmp is inaccessible — fresh tmpfs hides it',
    { skip: process.platform === 'darwin' ? 'macOS lacks tmpfs mount namespace; os.tmpdir() siblings remain visible' : false },
    () => {
    // Both dirs live in host /tmp.  Sandbox /tmp is fresh tmpfs so sibling is
    // naturally hidden.  This test validates the /tmp isolation mechanism, NOT
    // the overlay isolation.
    const cwd     = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    fs.writeFileSync(path.join(sibling, 'sibling-secret.txt'), 'should-not-see');
    try {
      const r = tryRun(cwd, `stat "${path.join(sibling, 'sibling-secret.txt')}" 2>&1; echo exit:$?`);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        r.stdout.includes('No such file') || r.stdout.includes('exit:1'),
        `expected sibling to be inaccessible, got: ${r.stdout}`,
      );
    } finally {
      spawnSync('rm', ['-rf', cwd, sibling]);
    }
  });

  // ---- $HOME-based siblings (the real-world attack surface) ----

  test('sibling directory under $HOME is readable inside sandbox (RO bind)', () => {
    // $HOME is bind-mounted read-only, so all directories under $HOME
    // (including siblings of CWD) are readable inside the sandbox.
    const HOME    = HOME_FALLBACK;
    const cwd     = fs.mkdtempSync(path.join(HOME, '.boxsh-test-cwd-'));
    const sibling = fs.mkdtempSync(path.join(HOME, '.boxsh-test-sib-'));
    fs.writeFileSync(path.join(sibling, 'visible.txt'), 'readable-in-sandbox');
    try {
      const r = tryRun(cwd, `cat "${path.join(sibling, 'visible.txt')}" 2>&1; echo exit:$?`);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        r.stdout.includes('readable-in-sandbox') && r.stdout.includes('exit:0'),
        `expected sibling under $HOME to be readable via home overlay, got: ${r.stdout}`,
      );
    } finally {
      spawnSync('rm', ['-rf', cwd, sibling]);
    }
  });

  test('sandbox delete in $HOME sibling does not reach host (RO bind)', () => {
    // $HOME is bind-mounted read-only: deletes inside the sandbox are blocked
    // with EPERM; the real file on the host is untouched.
    const HOME    = HOME_FALLBACK;
    const cwd     = fs.mkdtempSync(path.join(HOME, '.boxsh-test-cwd-'));
    const sibling = fs.mkdtempSync(path.join(HOME, '.boxsh-test-sib-'));
    fs.writeFileSync(path.join(sibling, 'victim.txt'), 'important-data');
    try {
      tryRun(cwd, `rm -f "${path.join(sibling, 'victim.txt')}" 2>&1`);
      assert.ok(
        fs.existsSync(path.join(sibling, 'victim.txt')),
        `SECURITY BUG: sandbox delete reached host $HOME sibling!`,
      );
    } finally {
      spawnSync('rm', ['-rf', cwd, sibling]);
    }
  });

  test('sandbox create in $HOME sibling does not reach host (RO bind)', () => {
    // New files created in $HOME inside the sandbox are blocked with EPERM
    // (read-only bind); they do not appear on the host filesystem.
    const HOME    = HOME_FALLBACK;
    const cwd     = fs.mkdtempSync(path.join(HOME, '.boxsh-test-cwd-'));
    const sibling = fs.mkdtempSync(path.join(HOME, '.boxsh-test-sib-'));
    try {
      tryRun(cwd, `echo payload > "${path.join(sibling, 'injected.txt')}" 2>&1`);
      assert.ok(
        !fs.existsSync(path.join(sibling, 'injected.txt')),
        `SECURITY BUG: sandbox create reached host $HOME sibling!`,
      );
    } finally {
      spawnSync('rm', ['-rf', cwd, sibling]);
    }
  });

  test('sandbox overwrite in $HOME sibling does not reach host (RO bind)', () => {
    // Overwrites in $HOME inside the sandbox are blocked with EPERM
    // (read-only bind); the original file on the host remains unchanged.
    const HOME    = HOME_FALLBACK;
    const cwd     = fs.mkdtempSync(path.join(HOME, '.boxsh-test-cwd-'));
    const sibling = fs.mkdtempSync(path.join(HOME, '.boxsh-test-sib-'));
    const victim  = path.join(sibling, 'config.txt');
    fs.writeFileSync(victim, 'original\n');
    try {
      tryRun(cwd, `echo evil > "${victim}" 2>&1`);
      assert.equal(
        fs.readFileSync(victim, 'utf8'),
        'original\n',
        `SECURITY BUG: sandbox overwrite reached host $HOME sibling!`,
      );
    } finally {
      spawnSync('rm', ['-rf', cwd, sibling]);
    }
  });

  // ---- auto-included system dirs ----

  test('/root is not present inside the sandbox',
    { skip: IN_CONTAINER && 'container runs as root without CLONE_NEWUSER; /root is accessible (host engine relies on userns UID remapping to hide /root)' },
    () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'ls /root 2>&1; echo exit:$?');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        r.stdout.includes('No such file') || r.stdout.includes('exit:1') || r.stdout.includes('exit:2'),
        `expected /root to be hidden, got: ${r.stdout}`,
      );
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/usr is auto-included: /usr/bin/ls is accessible',
    { skip: process.platform === 'darwin' ? '/usr/bin/ls does not exist on macOS (ls is at /bin/ls)' : false },
    () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'ls /usr/bin/ls');
      assert.equal(r.status, 0, `expected /usr/bin/ls to be accessible: ${r.stderr}`);
      assert.equal(r.stdout.trim(), '/usr/bin/ls');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/proc is auto-included: /proc/self/status is readable',
    { skip: process.platform === 'darwin' ? '/proc does not exist on macOS' : false },
    () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'head -1 /proc/self/status');
      assert.equal(r.status, 0, `expected /proc to be accessible: ${r.stderr}`);
      assert.match(r.stdout, /^Name:/);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/dev/null and /dev/zero are auto-included', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'echo test > /dev/null && head -c 4 /dev/zero | wc -c');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), '4');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/etc/resolv.conf is auto-included when present on host', () => {
    if (!fs.existsSync('/etc/resolv.conf')) return; // not on host — skip
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'cat /etc/resolv.conf');
      assert.equal(r.status, 0, `expected /etc/resolv.conf to be accessible: ${r.stderr}`);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/usr is write-protected by Unix permissions',
    { skip: IN_CONTAINER && 'container runs as root without CLONE_NEWUSER; root can write to /usr (host engine relies on userns UID remapping for this protection)' },
    () => {
    const cwd    = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    const marker = `/usr/boxsh-write-test-${process.pid}`;
    try {
      // Inside the sandbox we appear as root, but that maps to our real uid
      // on the host.  Root-owned /usr files must reject our writes.
      const r = tryRun(cwd, `touch "${marker}" 2>&1; echo exit:$?`);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        r.stdout.includes('Permission denied') || r.stdout.includes('exit:1'),
        `expected /usr write to be denied, got: ${r.stdout}`,
      );
      assert.ok(!fs.existsSync(marker), 'marker must not appear on host /usr');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/tmp inside sandbox is a fresh tmpfs — host /tmp siblings are not visible',
    { skip: process.platform === 'darwin' ? 'macOS lacks mount namespace isolation; /tmp writes go to the real filesystem' : false },
    () => {
    const cwd      = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    const sentinel = path.join(os.tmpdir(), `boxsh-sentinel-${process.pid}`);
    const probe    = `/tmp/boxsh-sandbox-write-${process.pid}`;
    fs.writeFileSync(sentinel, 'host-only');
    try {
      // Sentinel is a sibling of CWD in host /tmp — must not appear inside sandbox.
      const r1 = tryRun(cwd, `stat "${sentinel}" 2>&1; echo exit:$?`);
      assert.equal(r1.status, 0, r1.stderr);
      assert.ok(
        r1.stdout.includes('No such file') || r1.stdout.includes('exit:1'),
        `expected host /tmp sentinel to be invisible, got: ${r1.stdout}`,
      );
      // Writes to sandbox /tmp must not create files on host.
      const r2 = tryRun(cwd, `touch "${probe}" && echo ok`);
      assert.equal(r2.status, 0, r2.stderr);
      assert.equal(r2.stdout.trim(), 'ok');
      assert.ok(!fs.existsSync(probe), 'sandbox /tmp write must not appear on host');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
      fs.rmSync(sentinel, { force: true });
    }
  });

  test('$HOME is accessible as COW overlay even when CWD is outside $HOME', () => {
    // When CWD is in /tmp (outside $HOME), the home overlay is still mounted
    // so $HOME directories are readable inside the sandbox.
    if (!fs.existsSync('/home')) return; // not on host — skip
    const cwd     = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    const homeDir = fs.mkdtempSync(path.join(HOME_FALLBACK, '.boxsh-test-'));
    fs.writeFileSync(path.join(homeDir, 'marker.txt'), 'visible-via-overlay');
    try {
      const r = tryRun(cwd, `cat "${path.join(homeDir, 'marker.txt')}" 2>&1; echo exit:$?`);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        r.stdout.includes('visible-via-overlay') && r.stdout.includes('exit:0'),
        `expected $HOME to be accessible via COW overlay, got: ${r.stdout}`,
      );
    } finally {
      spawnSync('rm', ['-rf', cwd, homeDir]);
    }
  });
});

// ---------------------------------------------------------------------------
// Overlay write protection
//
// --try mounts the CWD as a COW overlay.  All writes inside the sandbox go
// to the upper layer and never reach the lower (host CWD).  Directories
// outside the overlay are also unreachable — no cross-directory leakage.
// ---------------------------------------------------------------------------

describe('--try mode — overlay write protection', () => {
  test('three mutation types (modify, delete, create) leave host CWD unchanged', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    fs.writeFileSync(path.join(cwd, 'important.txt'), 'original\n');
    try {
      // All three writes are captured by the overlay upper layer.
      const r = tryRun(cwd,
        'echo overwritten > important.txt && rm important.txt && touch brand-new.txt');
      assert.equal(r.status, 0, r.stderr);
      // Host CWD must be completely untouched.
      assert.equal(
        fs.readFileSync(path.join(cwd, 'important.txt'), 'utf8'),
        'original\n',
        'existing file must remain unmodified on host',
      );
      assert.ok(!fs.existsSync(path.join(cwd, 'brand-new.txt')),
        'newly created file must not appear in host CWD',
      );
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('sibling directory of CWD is unreadable from inside sandbox',
    { skip: process.platform === 'darwin' ? 'macOS lacks mount namespace isolation; os.tmpdir() siblings remain readable' : false },
    () => {
    const cwd     = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    fs.writeFileSync(path.join(sibling, 'confidential.txt'), 'secret-data');
    try {
      const r = tryRun(cwd,
        `cat "${path.join(sibling, 'confidential.txt')}" 2>&1; echo exit:$?`);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        r.stdout.includes('No such file') || r.stdout.includes('exit:1'),
        `expected sibling file to be unreachable, got: ${r.stdout}`,
      );
    } finally {
      spawnSync('rm', ['-rf', cwd, sibling]);
    }
  });

  test('sandbox cannot write into sibling directory on host', () => {
    const cwd     = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    try {
      // Path does not exist inside sandbox — write attempt fails at the kernel level.
      tryRun(cwd, `echo payload > "${path.join(sibling, 'injected.txt')}" 2>&1`);
      // Key assertion: host sibling directory must be unmodified.
      assert.ok(
        !fs.existsSync(path.join(sibling, 'injected.txt')),
        'sandbox must not be able to write to a sibling host directory',
      );
    } finally {
      spawnSync('rm', ['-rf', cwd, sibling]);
    }
  });
});

// ---------------------------------------------------------------------------
// Common tools
//
// --sandbox bind-mounts /usr (and symlinked /bin, /lib, etc.), making the
// full userland toolchain available inside the sandbox without any --bind
// flags.  Languages that need shared libraries (node, python3) must work
// out of the box because /usr and its libraries are auto-included.
// ---------------------------------------------------------------------------

{
  // Detect tool availability on the host at module load time so we can skip
  // cleanly instead of failing on machines without tools installed.
  const hasNode    = spawnSync('which', ['node'],    { encoding: 'utf8' }).status === 0;
  const hasPython3 = spawnSync('which', ['python3'], { encoding: 'utf8' }).status === 0;
  const skipNode    = hasNode    ? false : 'node not installed on host';
  const skipPython3 = hasPython3 ? false : 'python3 not installed on host';

  describe('--try mode — common tools', () => {
    test('node --version is accessible inside sandbox', { skip: skipNode }, () => {
      const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
      try {
        const r = tryRun(cwd, 'node --version');
        assert.equal(r.status, 0, `node not accessible inside sandbox: ${r.stderr}`);
        assert.match(r.stdout.trim(), /^v\d+\.\d+/);
      } finally {
        spawnSync('rm', ['-rf', cwd]);
      }
    });

    test('node -e executes inline JavaScript inside sandbox', { skip: skipNode }, () => {
      const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
      try {
        const r = tryRun(cwd, "node -e 'console.log(6 * 7)'");
        assert.equal(r.status, 0, `node -e failed: ${r.stderr}`);
        assert.equal(r.stdout.trim(), '42');
      } finally {
        spawnSync('rm', ['-rf', cwd]);
      }
    });

    test('node can read a file from the CWD overlay inside sandbox', { skip: skipNode }, () => {
      const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
      fs.writeFileSync(path.join(cwd, 'data.json'), '{"x":21}');
      try {
        const r = tryRun(cwd,
          "node -e \"const d=JSON.parse(require('fs').readFileSync('data.json','utf8'));console.log(d.x*2)\"");
        assert.equal(r.status, 0, `node file read failed: ${r.stderr}`);
        assert.equal(r.stdout.trim(), '42');
      } finally {
        spawnSync('rm', ['-rf', cwd]);
      }
    });

    test('python3 --version is accessible inside sandbox', { skip: skipPython3 }, () => {
      const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
      try {
        // python3 --version outputs to stdout (Python 3.4+).
        const r = tryRun(cwd, 'python3 --version 2>&1');
        assert.equal(r.status, 0, `python3 not accessible inside sandbox: ${r.stderr}`);
        assert.match(r.stdout.trim(), /^Python \d+\.\d+/);
      } finally {
        spawnSync('rm', ['-rf', cwd]);
      }
    });

    test('python3 -c executes inline Python inside sandbox', { skip: skipPython3 }, () => {
      const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
      try {
        const r = tryRun(cwd, "python3 -c 'print(6 * 7)'");
        assert.equal(r.status, 0, `python3 -c failed: ${r.stderr}`);
        assert.equal(r.stdout.trim(), '42');
      } finally {
        spawnSync('rm', ['-rf', cwd]);
      }
    });

    test('python3 can run a script file from the CWD overlay', { skip: skipPython3 }, () => {
      const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
      fs.writeFileSync(path.join(cwd, 'calc.py'), 'print(6 * 7)\n');
      try {
        const r = tryRun(cwd, 'python3 calc.py');
        assert.equal(r.status, 0, `python3 script failed: ${r.stderr}`);
        assert.equal(r.stdout.trim(), '42');
      } finally {
        spawnSync('rm', ['-rf', cwd]);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Auto-included system directories
//
// /dev, /etc, /run, /var are bind-mounted from the host so the sandbox behaves
// like a real Linux environment without any extra --bind flags.
// ---------------------------------------------------------------------------

describe('--try mode — auto-included system directories', () => {
  test('/etc is fully accessible (not just selected files)',
    { skip: process.platform === 'darwin' ? '/etc/os-release, /etc/ld.so.conf, /etc/hostname are Linux-only files' : false },
    () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      // Verify several /etc files beyond the old allowlist are readable.
      const r = tryRun(cwd, 'cat /etc/os-release /etc/ld.so.conf /etc/hostname 2>&1; echo exit:$?');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!r.stdout.includes('No such file'), `/etc files missing: ${r.stdout}`);
      assert.ok(r.stdout.includes('exit:0'), `reading /etc files failed: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/etc/resolv.conf is readable (symlink target under /run is accessible)', () => {
    // resolv.conf is often a symlink into /run/systemd/resolve/; both /etc and
    // /run must be mounted for the symlink to resolve correctly.
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'cat /etc/resolv.conf 2>&1; echo exit:$?');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('exit:0'), `/etc/resolv.conf not readable: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/run is accessible',
    { skip: process.platform === 'darwin' ? '/run does not exist on macOS' : false },
    () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'ls /run 2>&1; echo exit:$?');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('exit:0'), `/run not accessible: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/var is accessible', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'ls /var 2>&1; echo exit:$?');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('exit:0'), `/var not accessible: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/var/lib/dpkg/status is readable (dpkg database intact)',
    { skip: process.platform === 'darwin' ? 'dpkg is not available on macOS' : false },
    () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'head -3 /var/lib/dpkg/status 2>&1; echo exit:$?');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('exit:0'), `dpkg status not readable: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('dpkg -s reports packages as installed',
    { skip: process.platform === 'darwin' ? 'dpkg is not available on macOS' : false },
    () => {
    // coreutils is always present on a typical Ubuntu host.
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'dpkg -s coreutils 2>&1 | grep "^Status"');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Status: install ok installed/, `dpkg -s failed: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/dev/null, /dev/zero, /dev/urandom are accessible', () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd,
        'cat /dev/null && dd if=/dev/zero bs=1 count=1 2>/dev/null | wc -c && dd if=/dev/urandom bs=1 count=1 2>/dev/null | wc -c');
      assert.equal(r.status, 0, `basic /dev nodes not accessible: ${r.stderr}`);
      const lines = r.stdout.trim().split('\n');
      // wc -c output may have leading spaces on macOS; trim each line.
      assert.equal(lines[0].trim(), '1', '/dev/zero read failed');
      assert.equal(lines[1].trim(), '1', '/dev/urandom read failed');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('/dev/pts is mounted (devpts sub-mount present)',
    { skip: process.platform === 'darwin' ? '/dev/pts (devpts) does not exist on macOS' : false },
    () => {
    const cwd = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'ls /dev/pts 2>&1; echo exit:$?');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('exit:0'), `/dev/pts not present: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });
});

