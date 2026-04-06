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
import { BOXSH } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helper: run boxsh --try with a given CWD and -c command.
// ---------------------------------------------------------------------------

function tryRun(cwd, cmd, timeout_ms = 5000) {
  return spawnSync(BOXSH, ['--try', '-c', cmd], {
    encoding: 'utf8',
    cwd,
    timeout: timeout_ms,
  });
}

/** Extract the temp dir path printed by --try to stderr. */
function parseTmpdir(stderr) {
  const m = stderr.match(/changes will be saved in (\/tmp\/boxsh-try-\S+)\/upper/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Basic behaviour
// ---------------------------------------------------------------------------

describe('--try mode', () => {
  test('exits 0 and prints temp dir path to stderr', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'true');
      assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
      assert.match(r.stderr, /changes will be saved in \/tmp\/boxsh-try-/);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('appears as root inside the sandbox', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'whoami');
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), 'root');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('CWD inside sandbox matches launch CWD', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'pwd');
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), cwd);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  // ---------------------------------------------------------------------------
  // COW isolation
  // ---------------------------------------------------------------------------

  test('new file written inside sandbox appears in upper, not in real CWD', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'touch sandbox-new-file');
      assert.equal(r.status, 0, r.stderr);
      const tmpdir = parseTmpdir(r.stderr);
      assert.ok(tmpdir, 'could not parse tmpdir from stderr');

      assert.ok(fs.existsSync(path.join(tmpdir, 'upper', 'sandbox-new-file')),
        'new file must appear in upper layer');
      assert.ok(!fs.existsSync(path.join(cwd, 'sandbox-new-file')),
        'new file must not appear in real CWD');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('existing file modified inside sandbox: upper has copy, original unchanged', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    const original = 'original content\n';
    fs.writeFileSync(path.join(cwd, 'data.txt'), original);
    try {
      const r = tryRun(cwd, 'echo modified > data.txt');
      assert.equal(r.status, 0, r.stderr);
      const tmpdir = parseTmpdir(r.stderr);
      assert.ok(tmpdir, 'could not parse tmpdir from stderr');

      // Original must be untouched.
      assert.equal(fs.readFileSync(path.join(cwd, 'data.txt'), 'utf8'), original);
      // Modified copy in upper.
      assert.equal(
        fs.readFileSync(path.join(tmpdir, 'upper', 'data.txt'), 'utf8'),
        'modified\n',
      );
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('existing file is visible and readable inside sandbox', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello\n');
    try {
      const r = tryRun(cwd, 'cat hello.txt');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'hello\n');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  test('file deleted inside sandbox leaves whiteout in upper, original intact', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
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
      // Whiteout in upper.
      const tmpdir = parseTmpdir(r.stderr);
      const wh = fs.statSync(path.join(tmpdir, 'upper', 'victim.txt'));
      assert.ok(wh.isCharacterDevice() && wh.rdev === 0, 'expected whiteout entry');
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });

  // ---------------------------------------------------------------------------
  // Temp directory is retained after exit
  // ---------------------------------------------------------------------------

  test('temp directory is retained after the shell exits', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
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
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-try-'));
    try {
      const r = tryRun(cwd, 'exit 42');
      assert.equal(r.status, 42);
    } finally {
      spawnSync('rm', ['-rf', cwd]);
    }
  });
});
