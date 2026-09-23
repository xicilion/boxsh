/**
 * sandbox-browser.test.mjs — Chromium-based browser tooling in the sandbox.
 *
 * Browsers are a special case for a Seatbelt sandbox, and each constraint has
 * a matching grant or flag on boxsh's side:
 *
 *  1. Chromium publishes a Mach rendezvous port for its helper processes and
 *     looks it up again from each of them.  The profile must allow both, or
 *     the browser aborts during startup:
 *       FATAL:base/apple/mach_port_rendezvous_mac.cc:159] Check failed:
 *       kr == KERN_SUCCESS. bootstrap_check_in
 *       org.chromium.Chromium.MachPortRendezvousServer.1234: Permission denied
 *
 *  2. A Seatbelt profile cannot be applied inside another Seatbelt profile, so
 *     Chromium's own sandbox has to be off (`--no-sandbox`) and boxsh's sandbox
 *     takes over.  Tools that do not let you pass browser flags can be pointed
 *     at a wrapper script (see docs/usage.md, "Browsers in the Sandbox").
 *
 *  3. Chromium resolves the OS per-user temp dir itself (NSTemporaryDirectory
 *     ignores $TMPDIR), so a tool that prints its PDF back through CDP
 *     `IO.read` - Playwright's own `page.pdf()` - needs that directory bound
 *     (`--bind "wr:$(getconf DARWIN_USER_TEMP_DIR)"`).  Printing with
 *     `printToPDF` and `transferMode: "ReturnAsBase64"` never touches it.
 *
 * The browser is not part of boxsh, so anything that needs one is skipped when
 * no Chromium-family build is installed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BOXSH, TEMPDIR } from './helpers.mjs';

const IS_MACOS = process.platform === 'darwin';

// Tools that resolve the OS temp dir themselves (Chromium does) ignore
// $TMPDIR; in containers the home directory may not exist at all.
const HOME = os.homedir();

function boxsh(args, { env = {}, cwd = TEMPDIR, timeout_ms = 30000 } = {}) {
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

/** Newest Playwright Chromium (headless shell preferred: it needs no GUI). */
function findChromium() {
  const roots = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
  ];
  const candidates = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const shell = path.join(root, entry, 'chrome-headless-shell-mac-arm64',
                              'chrome-headless-shell');
      const shellX64 = path.join(root, entry, 'chrome-headless-shell-mac-x64',
                                 'chrome-headless-shell');
      const linux = path.join(root, entry, 'chrome-headless-shell-linux64',
                              'chrome-headless-shell');
      for (const candidate of [shell, shellX64, linux]) {
        try { fs.accessSync(candidate, fs.constants.X_OK); candidates.push(candidate); }
        catch { /* not this one */ }
      }
    }
  }
  candidates.sort();
  return candidates.at(-1) ?? null;
}

/** The OS per-user temp dir as Chromium resolves it (macOS). */
function hostTempDir() {
  const r = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim().replace(/\/+$/, '');
}

const CHROMIUM = findChromium();
const BROWSER_SKIP = CHROMIUM ? false
  : 'no Chromium-family browser installed (Playwright browsers not found)';

describe('Chromium in the sandbox', () => {
  test('a Headless Chromium can start and render a page', { skip: BROWSER_SKIP }, () => {
    const proj = mkTmp('boxsh-browser-proj-');
    try {
      // --no-sandbox: the browser's own Seatbelt profile cannot be applied
      // inside boxsh's; the outer sandbox is the isolation boundary here.
      const r = boxsh([
        '--sandbox',
        '--bind', `ro:${path.dirname(CHROMIUM)}`,
        '--bind', `wr:${proj}`,
        '-c', `"${CHROMIUM}" --no-sandbox --dump-dom about:blank`,
      ]);

      assert.equal(r.signal, null, `browser killed by signal ${r.signal}: ${r.stderr}`);
      assert.equal(r.status, 0, `browser exited with ${r.status}: ${r.stderr}`);
      assert.match(r.stdout, /<html>/, `no DOM rendered: ${r.stdout}${r.stderr}`);
    } finally {
      spawnSync('rm', ['-rf', proj]);
    }
  });
});

// ============================================================================
// Profile grants
// ============================================================================

describe('sandbox profile grants', () => {
  const PROBE = path.resolve('build/bootstrap_probe_darwin');

  test('mach-register stays scoped to the browser name prefixes', {
    skip: !IS_MACOS ? 'macOS-only profile rule'
        : (fs.existsSync(PROBE) ? false : 'build/bootstrap_probe_darwin is not built'),
  }, () => {
    const proj = mkTmp('boxsh-browser-proj-');
    const probeDir = path.dirname(PROBE);
    try {
      const run = (service) => boxsh([
        '--sandbox', '--bind', `ro:${probeDir}`, '--bind', `wr:${proj}`,
        '-c', `"${PROBE}" ${service}`,
      ], { env: { HOME } });

      // Control: unsandboxed, the very same registration succeeds — so the
      // denial below is the profile's doing, not Mach semantics.
      const host = spawnSync(PROBE, ['com.apple.boxsh.probe'], { encoding: 'utf8' });
      assert.equal(host.status, 0,
        `the probe fails even without a sandbox: ${host.stderr}`);

      const allowed = run('org.chromium.boxsh.probe');
      assert.equal(allowed.status, 0,
        `a browser service must stay registerable: ${allowed.stdout}${allowed.stderr}`);

      const denied = run('com.apple.boxsh.probe');
      assert.notEqual(denied.status, 0,
        `SECURITY BUG: com.apple.* became registerable: ${denied.stdout}`);
      assert.match(denied.stdout, /denied/, `unexpected probe output: ${denied.stdout}`);
    } finally {
      spawnSync('rm', ['-rf', proj]);
    }
  });

  test('the profile grants the scratch directory and nothing broader', {
    skip: IS_MACOS ? false : 'macOS-only profile',
  }, () => {
    const proj = mkTmp('boxsh-browser-proj-');
    const dump = path.join(mkTmp('boxsh-browser-dump-'), 'profile.sbpl');
    try {
      const r = boxsh([
        '--sandbox', '--bind', `wr:${proj}`,
        '-c', 'echo "TMPDIR=$TMPDIR"',
      ], { env: { HOME, BOXSH_SBPL_DUMP: dump } });
      assert.equal(r.status, 0, `boxsh failed: ${r.stderr}`);

      const scratch = r.stdout.match(/TMPDIR=(.*)/)?.[1].trim();
      assert.ok(scratch, `no TMPDIR in output: ${r.stdout}`);
      const profile = fs.readFileSync(dump, 'utf8');
      const re = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

      // The scratch is reported canonically (/var → /private/var on macOS) and
      // removed again on exit, so canonicalise the parent, not the directory.
      const realScratch = path.join(fs.realpathSync(path.dirname(scratch)),
                                    path.basename(scratch));
      assert.match(profile, re(`(allow file-read* (subpath "${realScratch}"))`),
        'the scratch read grant is missing');
      assert.match(profile, re(`(allow file-write* (subpath "${realScratch}"))`),
        'the scratch write grant is missing');

      // Every mach-register entry must be a scoped browser prefix: this is the
      // grant that keeps sandboxed processes from publishing service names
      // that could shadow a system service.  The block ends with a lone ")".
      const block = profile.match(/\(allow mach-register\n([\s\S]*?)\n\)\n/);
      assert.ok(block, 'the profile has no mach-register block');
      const entries = block[1].split('\n').map((line) => line.trim()).filter(Boolean);
      assert.ok(entries.length > 0, 'the mach-register block is empty');
      for (const entry of entries) {
        assert.match(entry, /^\(global-name-prefix "(org\.chromium|com\.google\.Chrome)"\)$/,
          `mach-register entry is not a scoped browser prefix: ${entry}`);
      }

      // Grants must not have replaced the rules that keep the sandbox closed.
      assert.match(profile, /^\(deny default\)$/m, 'the profile no longer denies by default');
      assert.match(profile, re('(deny file-read* (subpath "/System/Volumes"))'),
        'the /System/Volumes deny rule is gone');

      // Executables on $PATH are stat-able (metadata only) so that
      // CoreFoundation-based programs can start.
      for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
        if (/^\/(usr|bin|sbin|System|Library|Applications|opt|private|var|tmp|etc)\b/.test(dir)) continue;
        const resolved = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
        assert.match(profile, re(`(allow file-read-metadata (literal "${resolved}"))`),
          `no metadata grant for the executable directory ${dir}`);
      }
    } finally {
      spawnSync('rm', ['-rf', proj]);
    }
  });
});
