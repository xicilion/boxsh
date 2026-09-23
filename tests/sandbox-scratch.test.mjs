/**
 * sandbox-scratch.test.mjs — the sandbox's writable scratch directory.
 *
 * A sandbox that owns no writable directory cannot run anything that needs a
 * temporary file: a browser will not start without a profile directory, and a
 * compiler or installer fails on its first spill.  The macOS backend has no
 * writable /tmp at all, and --try binds $HOME read-only on both platforms.
 *
 * Every sandbox therefore gets a private scratch directory, and `TMPDIR`
 * points at it:
 *   - temp files work (and stay out of the host temp dirs),
 *   - a caller TMPDIR that the sandbox can write to is kept as it is,
 *   - caches are left to the caller (`npm_config_cache=$TMPDIR/.cache/npm`),
 *     which boxsh documents but never sets itself.
 *
 * The second half of the file covers the CoreFoundation regression that made
 * node die with SIGSEGV (in uv_set_process_title) inside a macOS sandbox
 * that hides $HOME — see allow_executable_search_metadata() in
 * src/sandbox_darwin.cpp.
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

// Tests create temp dirs under "HOME".  In containers HOME may point at a
// non-existent path (e.g. /nonexistent for uid 65534); fall back to TEMPDIR
// so the suite runs identically on host and in containers.
const HOMEDIR = os.homedir();
const HOME = fs.existsSync(HOMEDIR) ? HOMEDIR : TEMPDIR;

// The error a denied write produces differs per platform and per kernel
// version: macOS sandboxes yield EPERM, a Linux read-only bind yields EROFS,
// and a path that does not exist inside the sandbox yields ENOENT.
const WRITE_DENIED = /Operation not permitted|Permission denied|Read-only file system/;
const WRITE_DENIED_PLUS_MISSING = new RegExp(WRITE_DENIED.source + '|No such file or directory|Directory nonexistent');

function boxsh(args, { env = {}, cwd = TEMPDIR, timeout_ms = 20000 } = {}) {
  return spawnSync(BOXSH, args, {
    encoding: 'utf8',
    cwd,
    timeout: timeout_ms,
    env: { ...process.env, ...env },
  });
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(TEMPDIR, prefix));
}

/** Escape a path so it can be embedded in a RegExp. */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The OS per-user temp directory, as tools that ignore $TMPDIR resolve it. */
function hostTempDir() {
  const r = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim().replace(/\/+$/, '');
}

// --try creates its session directory as a sibling of the CWD, and
// helpers.mjs removes every .boxsh-try-* directory under TEMPDIR (and its
// parent) when a test *process* exits.  With test files running in parallel
// that would pull the session directory out from under a boxsh that is still
// starting, so these tests use a CWD in the system temp dir and remove their
// own session directory instead.
function tryRun(cmd, env = {}, timeout_ms = 20000) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-scratch-cwd-'));
  try {
    const r = boxsh(['--try', '-c', cmd], {
      env: { HOME, ...env }, cwd, timeout_ms,
    });
    // --try keeps the session directory for inspection; this test does not.
    const saved = r.stderr.match(/changes will be saved in (\S+)/);
    if (saved) spawnSync('rm', ['-rf', path.dirname(saved[1])]);
    return r;
  } finally {
    spawnSync('rm', ['-rf', cwd]);
  }
}

function findOnPath(name) {
  const entries = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of entries) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

// ============================================================================
// Scratch directory
// ============================================================================

describe('sandbox scratch directory', () => {
  test('--try gives the sandbox a writable TMPDIR of its own', () => {
    const r = tryRun('echo "TMPDIR=$TMPDIR"; mkdir -p "$TMPDIR/d" && ' +
                     'echo nested > "$TMPDIR/d/f" && cat "$TMPDIR/d/f"');
    assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);

    const m = r.stdout.match(/TMPDIR=(.*)/);
    assert.ok(m, `no TMPDIR in output: ${r.stdout}`);
    const tmpdir = m[1].trim();
    assert.ok(tmpdir.startsWith('/'), `TMPDIR is not absolute: ${tmpdir}`);
    assert.notEqual(tmpdir, process.env.TMPDIR ?? '',
      'sandbox TMPDIR must not be the caller TMPDIR');
    assert.match(r.stdout, /nested/, `scratch is not writable: ${r.stdout}`);
  });

  test('the scratch directory is private (mode 0700)', () => {
    const modeCmd = IS_MACOS ? 'stat -f %Lp' : 'stat -c %a';
    const r = tryRun(`echo "root=$(${modeCmd} "$TMPDIR")"; ` +
                     `echo "cache=$(${modeCmd} "$TMPDIR/.cache")"`);
    assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
    assert.match(r.stdout, /root=700\b/, `scratch is not 0700: ${r.stdout}`);
    assert.match(r.stdout, /cache=700\b/, `scratch cache dir is not 0700: ${r.stdout}`);
  });

  test('TMPDIR is the only variable boxsh sets for tools', () => {
    // Cache locations under $HOME are the caller's business: boxsh points no
    // tool-specific cache variable anywhere, so a caller's own settings - or
    // its absence - survive unchanged.
    const r = tryRun('echo "npm=[$npm_config_cache] xdg=[$XDG_CACHE_HOME] base=[$TMPDIR]"; ' +
                     'echo "cargo=[$CARGO_HOME]"', { npm_config_cache: '', XDG_CACHE_HOME: '' });
    assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
    assert.match(r.stdout, /npm=\[\] xdg=\[\]/, `boxsh set a cache variable: ${r.stdout}`);
    assert.match(r.stdout, /cargo=\[\]/, `boxsh set a cache variable: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /base=\[\s*\]/, `TMPDIR is not set: ${r.stdout}`);
  });

  test('a cache the caller points at the scratch is writable', () => {
    // The documented pattern: point the tool at $TMPDIR yourself.
    const r = tryRun('export npm_config_cache="$TMPDIR/.cache/npm"; ' +
                     'echo "npm=$npm_config_cache"; ' +
                     'touch "$npm_config_cache/p" && echo cache-writable');
    assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
    assert.match(r.stdout, /cache-writable/, `scratch cache is not writable: ${r.stdout}`);
  });

  test('an empty $HOME does not stop the scratch from working', () => {
    // Some containers run with HOME unset; the scratch must not depend on it.
    const r = tryRun('echo "TMPDIR=$TMPDIR"; touch "$TMPDIR/p" && echo writable', { HOME: '' });
    assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
    assert.match(r.stdout, /TMPDIR=\//, `TMPDIR is not set: ${r.stdout}`);
    assert.match(r.stdout, /writable/, `scratch is not writable: ${r.stdout}`);
  });

  test('--sandbox keeps $HOME hidden while the scratch works', () => {
    // The mount point of a bind needs its parent chain inside the sandbox
    // root, and boxsh materialises it as empty directories - $HOME itself
    // among them whenever the bind lives below it.  So $HOME cannot be
    // *absent* here, and "hidden" means the thing that matters: no entry of
    // the host home directory is reachable.  The probe is a real file of the
    // host's $HOME; neither its name nor its content may show up inside.
    const probeName = `.boxsh-scratch-home-probe-${process.pid}`;
    const probePath = path.join(HOME, probeName);
    const proj = mkTmp('boxsh-scratch-proj-');
    try {
      fs.writeFileSync(probePath, 'host home content\n');

      const r = boxsh([
        '--sandbox', '--bind', `wr:${proj}`,
        '-c',
        'touch "$TMPDIR/p" && echo scratch-writable; ' +
        `ls -A "$HOME" 2>/dev/null | grep -qx '${probeName}' && echo home-exposed || echo home-hidden; ` +
        `cat "$HOME/${probeName}" 2>&1 || true`,
      ], { env: { HOME } });

      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.match(r.stdout, /scratch-writable/, `scratch not writable: ${r.stdout}`);
      assert.match(r.stdout, /home-hidden/, `$HOME became readable: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /host home content/,
        `$HOME content leaked into the sandbox: ${r.stdout}`);
    } finally {
      fs.rmSync(probePath, { force: true });
      spawnSync('rm', ['-rf', proj]);
    }
  });

  test('a writable $TMPDIR set by the caller is kept', () => {
    const bindDir = mkTmp('boxsh-scratch-bind-');
    const callerTmp = path.join(bindDir, 'tmp');
    fs.mkdirSync(callerTmp, { recursive: true });
    try {
      const r = boxsh([
        '--sandbox', '--bind', `wr:${bindDir}`,
        '-c', `echo "TMPDIR=$TMPDIR"; touch "$TMPDIR/probe" && echo writable`,
      ], { env: { HOME, TMPDIR: callerTmp } });

      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`TMPDIR=${escapeRe(callerTmp)}`),
        `a writable caller TMPDIR must be kept: ${r.stdout}`);
      assert.match(r.stdout, /writable/, `caller TMPDIR is not writable: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', bindDir]);
    }
  });

  test('an unwritable $TMPDIR set by the caller is replaced', () => {
    const proj = mkTmp('boxsh-scratch-proj-');
    // A path that does not exist is the harshest case: boxsh must not accept
    // it as the sandbox temp directory, or the sandbox ends up with no usable
    // temp at all.
    const missing = path.join(HOME, '.boxsh-missing-tmp-dir');
    try {
      const r = boxsh([
        '--sandbox', '--bind', `wr:${proj}`,
        '-c', `echo "TMPDIR=$TMPDIR"; touch "$TMPDIR/probe" && echo writable`,
      ], { env: { HOME, TMPDIR: missing } });

      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.doesNotMatch(r.stdout, new RegExp(`TMPDIR=${escapeRe(missing)}`),
        `an unwritable caller TMPDIR must not be kept: ${r.stdout}`);
      assert.match(r.stdout, /writable/, `the replacement is not writable: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', proj]);
    }
  });

  test('a "$HOME"-relative $TMPDIR is recognised when $HOME is writable', () => {
    // expand_home() has to recognise "~/..." style values, or a caller's own
    // writable temp directory would be replaced by the scratch.
    const fakeHome = mkTmp('boxsh-scratch-home-');
    try {
      const r = boxsh([
        '--sandbox', '--bind', `wr:${fakeHome}`,
        '-c', 'echo "TMPDIR=[$TMPDIR]"',
      ], { env: { HOME: fakeHome, TMPDIR: '~/tmp' } });

      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.match(r.stdout, /TMPDIR=\[~\/tmp\]/, `"~" temp path was replaced: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', fakeHome]);
    }
  });

  test('a caller TMPDIR under a symlinked bind path is kept', () => {
    // macOS maps /tmp to /private/tmp: the bind grant and the temp path must
    // be compared canonically, or a perfectly writable temp dir looks
    // unwritable and gets replaced by the scratch.
    const bindDir = fs.mkdtempSync('/tmp/boxsh-scratch-link-');
    const callerTmp = path.join(bindDir, 'tmp');
    fs.mkdirSync(callerTmp, { recursive: true });
    try {
      const r = boxsh([
        '--sandbox', '--bind', `wr:${bindDir}`,
        '-c', 'echo "TMPDIR=$TMPDIR"',
      ], { env: { HOME, TMPDIR: callerTmp } });

      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`TMPDIR=${escapeRe(callerTmp)}`),
        `a writable caller TMPDIR under a symlinked path was replaced: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', bindDir]);
    }
  });

  test('a caller TMPDIR inside a COW destination is kept', () => {
    // The COW destination is writable (writes land in the clone), so it counts
    // as a writable location just like a read-write bind.
    const src = mkTmp('boxsh-scratch-cowsrc-');
    const dst = mkTmp('boxsh-scratch-cowdst-');
    const callerTmp = path.join(dst, 'tmp');
    fs.mkdirSync(callerTmp, { recursive: true });
    try {
      const r = boxsh([
        '--sandbox', '--bind', `cow:${src}:${dst}`,
        '-c', 'echo "TMPDIR=$TMPDIR"; touch "$TMPDIR/probe" && echo writable',
      ], { env: { HOME, TMPDIR: callerTmp } });

      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`TMPDIR=${escapeRe(callerTmp)}`),
        `a writable temp dir inside the COW workspace was replaced: ${r.stdout}`);
      assert.match(r.stdout, /writable/, `COW temp dir is not writable: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', src, dst]);
    }
  });

  test('a COW workspace reuses its scratch directory across sessions', {
    skip: IS_MACOS ? false : 'macOS anchors the scratch next to the COW workspace',
  }, () => {
    // The scratch sits next to the workspace, so a resumed session keeps the
    // caches it downloaded instead of starting from zero.
    const proj = mkTmp('boxsh-scratch-proj-');
    const session = mkTmp('boxsh-scratch-session-');
    const dst = path.join(session, 'dst');
    const args = ['--sandbox', '--bind', `cow:${proj}:${dst}`];
    try {
      const first = boxsh([...args, '-c', 'echo "TMPDIR=$TMPDIR"; echo cache > "$TMPDIR/p"'],
                          { env: { HOME } });
      assert.equal(first.status, 0, `first run failed: ${first.stderr}`);
      const scratch = first.stdout.match(/TMPDIR=(.*)/)?.[1].trim();
      assert.ok(scratch, `no TMPDIR: ${first.stdout}`);

      const second = boxsh([...args, '-c', 'echo "TMPDIR=$TMPDIR"; cat "$TMPDIR/p"'],
                           { env: { HOME } });
      assert.equal(second.status, 0, `second run failed: ${second.stderr}`);
      assert.match(second.stdout, new RegExp(`TMPDIR=${escapeRe(scratch)}`),
        `the resumed session should reuse the same scratch: ${second.stdout}`);
      assert.match(second.stdout, /cache/, `the scratch lost its contents: ${second.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', proj, session]);
    }
  });

  test('a sandbox without a workspace removes its scratch directory on exit', {
    skip: IS_MACOS ? false : 'macOS creates owned scratch directories',
  }, () => {
    const proj = mkTmp('boxsh-scratch-proj-');
    const hostTmp = fs.realpathSync(os.tmpdir());
    try {
      const r = boxsh([
        '--sandbox', '--bind', `wr:${proj}`,
        '-c', 'echo "TMPDIR=$TMPDIR"; touch "$TMPDIR/probe" && echo writable',
      ], { env: { HOME, TMPDIR: hostTmp } });

      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.match(r.stdout, /writable/, `scratch not writable: ${r.stdout}`);

      const match = r.stdout.match(/TMPDIR=(.*)/);
      assert.ok(match, `no TMPDIR in output: ${r.stdout}`);
      const scratch = match[1].trim();
      // The directory boxsh owns must be gone once boxsh exits; anything else
      // in the host temp dir belongs to someone else and is left alone.
      assert.match(scratch, new RegExp(`^${escapeRe(hostTmp)}/boxsh-scratch-`),
        `expected an owned scratch directory: ${scratch}`);
      assert.equal(fs.existsSync(scratch), false,
        `the owned scratch directory survived the run: ${scratch}`);
    } finally {
      spawnSync('rm', ['-rf', proj]);
    }
  });

  test('a stale scratch directory from a killed boxsh is swept on the next run', {
    skip: IS_MACOS ? false : 'macOS creates owned scratch directories',
  }, () => {
    // A SIGKILLed boxsh never reaches its cleanup, so the next start removes
    // what it left behind.  The owner pid is part of the name for exactly this
    // decision.
    const hostTmp = fs.realpathSync(os.tmpdir());
    const stale = path.join(hostTmp, `boxsh-scratch-999999-${process.pid}`);
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'leftover'), 'stale\n');

    const proj = mkTmp('boxsh-scratch-proj-');
    try {
      const r = boxsh(['--sandbox', '--bind', `wr:${proj}`, '-c', 'true'],
                      { env: { HOME, TMPDIR: hostTmp } });
      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.equal(fs.existsSync(stale), false,
        `a stale scratch directory (dead owner) was not swept: ${stale}`);
    } finally {
      spawnSync('rm', ['-rf', stale, proj]);
    }
  });

  test('scratch for a COW workspace sits next to the workspace, not in host tmp', {
    skip: IS_MACOS ? false : 'macOS anchors the scratch next to the COW workspace',
  }, () => {
    const proj = mkTmp('boxsh-scratch-proj-');
    const session = mkTmp('boxsh-scratch-session-');
    const dst = path.join(session, 'dst');
    const hostTmp = os.tmpdir();
    const before = new Set(fs.readdirSync(hostTmp));
    try {
      const r = boxsh([
        '--sandbox', '--bind', `cow:${proj}:${dst}`,
        '-c', 'echo "TMPDIR=$TMPDIR"; touch "$TMPDIR/probe" && echo writable',
      ], { env: { HOME, TMPDIR: hostTmp } });

      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.match(r.stdout, /writable/, `scratch not writable: ${r.stdout}`);

      const m = r.stdout.match(/TMPDIR=(.*)/);
      assert.ok(m, `no TMPDIR in output: ${r.stdout}`);
      assert.ok(m[1].trim().startsWith(fs.realpathSync(session)),
        `scratch should live in the session directory: ${m[1]}`);

      // Nothing boxsh owns itself should be left behind in the host temp dir.
      const added = fs.readdirSync(hostTmp).filter(e => !before.has(e));
      assert.deepEqual(added.filter(e => e.startsWith('boxsh-scratch-')), [],
        'owned scratch directories must be cleaned up on exit');
    } finally {
      spawnSync('rm', ['-rf', proj, session]);
    }
  });

  test('scratch lives inside the sandbox and leaves nothing on the host', {
    skip: IS_LINUX ? false : 'Linux keeps the scratch in the sandbox tmpfs',
  }, () => {
    const proj = mkTmp('boxsh-scratch-proj-');
    const hostScratch = '/tmp/.boxsh-scratch';
    const existed = fs.existsSync(hostScratch);
    try {
      const r = boxsh([
        '--sandbox', '--bind', `wr:${proj}`,
        '-c', 'echo "TMPDIR=$TMPDIR"; touch "$TMPDIR/probe" && echo writable',
      ], { env: { HOME } });

      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
      assert.match(r.stdout, /TMPDIR=\/tmp\/\.boxsh-scratch/, `unexpected TMPDIR: ${r.stdout}`);
      assert.match(r.stdout, /writable/, `scratch not writable: ${r.stdout}`);
      if (!existed) {
        assert.equal(fs.existsSync(hostScratch), false,
          'sandbox scratch must not appear on the host');
      }
    } finally {
      spawnSync('rm', ['-rf', proj]);
    }
  });
});

// ============================================================================
// CoreFoundation: programs must be able to stat their own executable path
// ============================================================================

describe('CoreFoundation executable lookup', () => {
  test('node can set process.title with $HOME hidden (macOS SIGSEGV regression)', {
    skip: findOnPath('node') ? false : 'node is not on PATH',
  }, () => {
    const proj = mkTmp('boxsh-scratch-proj-');
    try {
      // npm/npx set process.title; libuv resolves it through CoreFoundation,
      // which stats the directories along the executable path.  When that
      // stat fails (executable under a hidden $HOME, e.g. ~/.nvm or
      // ~/Tools), CFBundleGetMainBundle() returns NULL and node crashes.
      const r = boxsh([
        '--sandbox', '--bind', `wr:${proj}`,
        '-c', 'node -e \'process.title = "boxsh"; console.log("title-ok")\'',
      ], { env: { HOME } });

      assert.equal(r.signal, null, `node killed by signal ${r.signal}: ${r.stderr}`);
      assert.equal(r.status, 0, `node exited with ${r.status}: ${r.stderr}`);
      assert.match(r.stdout, /title-ok/, `unexpected output: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', proj]);
    }
  });

  test('executable directories on $PATH stay metadata-only', {
    skip: IS_MACOS ? false : 'macOS-only profile rule',
  }, () => {
    // The grant that fixes the crash above must not turn into a read grant:
    // a directory reachable only through it can be stat()ed but not listed.
    const toolDir = findOnPath('node');
    if (!toolDir) return;  // nothing to check without an extra $PATH entry
    const dir = path.dirname(toolDir);
    if (dir.startsWith('/usr') || dir.startsWith('/opt') || dir.startsWith('/bin')) {
      return;  // already readable through the system directory rules
    }

    const r = boxsh([
      '--sandbox', '--bind', `wr:${TEMPDIR}`,
      '-c', `test -d "${dir}" && echo stat-ok; ls "${dir}" > /dev/null 2>&1 && echo listed || echo not-listed`,
    ], { env: { HOME } });

    assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
    assert.match(r.stdout, /stat-ok/, `executable directory is not stat-able: ${r.stdout}`);
    assert.match(r.stdout, /not-listed/,
      `executable directory contents leaked: ${r.stdout}`);
  });

  test('writing outside the workspace is still denied', () => {
    const proj = mkTmp('boxsh-scratch-proj-');
    const outside = mkTmp('boxsh-scratch-outside-');
    fs.writeFileSync(path.join(outside, 'data.txt'), 'original\n');
    try {
      const r = boxsh([
        '--sandbox', '--bind', `wr:${proj}`,
        '-c', `echo evil > ${path.join(outside, 'data.txt')} 2>&1; ` +
              `cat ${path.join(outside, 'data.txt')} 2>&1 | head -1`,
      ], { env: { HOME } });

      // The denial is reported differently per platform: macOS yields EPERM,
      // Linux has no such path inside the sandbox at all (ENOENT) or is
      // read-only.  What matters is that the host file never changed.
      assert.equal(fs.readFileSync(path.join(outside, 'data.txt'), 'utf8'), 'original\n',
        'SECURITY BUG: write outside the binds reached the host');
      assert.match(r.stdout, WRITE_DENIED_PLUS_MISSING,
        `expected a denial, got: ${r.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', proj, outside]);
    }
  });
});

// ============================================================================
// The OS per-user temp directory (opt-in through --bind)
// ============================================================================

describe('host temp directory', () => {
  test('the per-user temp dir is only writable when it is bound', {
    skip: IS_MACOS ? false : 'macOS resolves its per-user temp dir itself',
  }, () => {
    const tempDir = hostTempDir();
    assert.ok(tempDir, 'getconf DARWIN_USER_TEMP_DIR failed');
    const proj = mkTmp('boxsh-scratch-proj-');
    const probe = `${tempDir}/boxsh-host-temp-probe-${process.pid}`;
    const cmd = `touch "${probe}" && echo wrote || echo denied`;
    try {
      // Default: hidden.  Tools that resolve the OS temp dir themselves (rather
      // than using $TMPDIR) have to ask for it with a bind.
      const hidden = boxsh(['--sandbox', '--bind', `wr:${proj}`, '-c', cmd],
                           { env: { HOME } });
      assert.equal(hidden.status, 0, hidden.stderr);
      assert.match(hidden.stdout, /denied/,
        `the per-user temp dir must stay read-only by default: ${hidden.stdout}`);

      const bound = boxsh([
        '--sandbox', '--bind', `wr:${tempDir}`, '--bind', `wr:${proj}`,
        '-c', `${cmd}; rm -f "${probe}"`,
      ], { env: { HOME } });
      assert.equal(bound.status, 0, bound.stderr);
      assert.match(bound.stdout, /wrote/,
        `a bound per-user temp dir must be writable: ${bound.stdout}${bound.stderr}`);
    } finally {
      spawnSync('rm', ['-f', probe]);
      spawnSync('rm', ['-rf', proj]);
    }
  });

  test('a bound per-user temp dir is used as TMPDIR', {
    skip: IS_MACOS ? false : 'macOS resolves its per-user temp dir itself',
  }, () => {
    const tempDir = hostTempDir();
    assert.ok(tempDir, 'getconf DARWIN_USER_TEMP_DIR failed');
    const r = boxsh([
      '--try', '--bind', `wr:${tempDir}`, '-c', 'echo "TMPDIR=$TMPDIR"',
    ], { env: { HOME, TMPDIR: tempDir } });

    assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);
    // With it writable, the caller's TMPDIR is usable and kept as-is.
    assert.match(r.stdout, new RegExp(`TMPDIR=${escapeRe(tempDir)}/?$`, 'm'),
      `TMPDIR should stay on the bound temp dir: ${r.stdout}`);
  });
});

// ============================================================================
// Profile safety
// ============================================================================

describe('profile safety', () => {
  test('a bind path that breaks the profile fails closed', {
    skip: IS_MACOS ? false : 'macOS-only profile quoting',
  }, () => {
    // A double quote inside a path would terminate the SBPL string early.
    // sandbox_init() must fail and boxsh must refuse to run anything, rather
    // than continue unsandboxed.
    const weird = path.join(TEMPDIR, 'boxsh-quo"te');
    fs.mkdirSync(weird, { recursive: true });
    try {
      const r = boxsh(['--sandbox', '--bind', `wr:${weird}`, '-c', 'echo RAN'],
                      { env: { HOME } });

      assert.notEqual(r.status, 0, `boxsh must refuse a sandbox it cannot build: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /RAN/, `the command ran without a sandbox: ${r.stdout}`);
      assert.match(r.stderr, /sandbox_apply failed/,
        `expected a sandbox failure, got: ${r.stderr}`);
    } finally {
      spawnSync('rm', ['-rf', weird]);
    }
  });
});
