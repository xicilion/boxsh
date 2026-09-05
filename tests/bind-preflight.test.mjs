/**
 * bind-preflight.test.mjs — bind-access preflight diagnostics (Linux engine).
 *
 * boxsh validates that wr:/COW bind targets are actually writable (and COW
 * sources readable) by the uid the sandbox will run as, and reports
 * actionable chown/--user hints instead of letting every write fail with
 * EACCES deep inside the sandbox.  This is the typical --user container
 * failure: mapped dirs owned by another uid, or root-owned stragglers left
 * by an earlier root run.
 *
 * Runs on any Linux host and in --user containers.  Skips on macOS (the
 * Seatbelt engine has no mount-based bind preflight) and when running as
 * uid 0 (root passes every DAC check, so the warnings cannot trigger).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BOXSH, TEMPDIR } from './helpers.mjs';

const IS_LINUX = process.platform === 'linux';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const skip = !IS_LINUX && 'preflight lives in the Linux userns/overlay engine';
const skipRoot = IS_ROOT && 'uid 0 bypasses DAC — preflight warnings cannot trigger';

function runAt(cwd, args, input = '', timeout_ms = 10000) {
  return spawnSync(BOXSH, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(TEMPDIR, prefix));
}

function cleanup(dir) {
  try { fs.chmodSync(dir, 0o700); } catch { /* already gone */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('sandbox bind preflight', { skip }, () => {
  test('wr: bind on a non-writable dir warns with the chown hint but still runs',
    { skip: skipRoot }, () => {
      const dir = mktmp('boxsh-preflight-wr-');
      try {
        // Owner-readable/executable but not writable — exactly the "mapped
        // dir owned by another uid" shape a --user container hits.
        fs.chmodSync(dir, 0o555);
        const r = runAt(dir, ['--sandbox', '--bind', `wr:${dir}`, '-c', 'echo ok']);
        assert.equal(r.status, 0, `sandbox must still run; stderr: ${r.stderr}`);
        assert.equal(r.stdout.trim(), 'ok');
        assert.ok(r.stderr.includes('warning: writable bind'),
          `expected wr warning; stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('not writable by uid'),
          `expected uid in warning; stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('chown'),
          `expected chown hint; stderr: ${r.stderr}`);
      } finally {
        cleanup(dir);
      }
    });

  test('writable wr: bind produces no warning (control)',
    { skip: skipRoot }, () => {
      const dir = mktmp('boxsh-preflight-ok-');
      try {
        const r = runAt(dir, ['--sandbox', '--bind', `wr:${dir}`, '-c', 'echo ok']);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.ok(!r.stderr.includes('not writable'),
          `unexpected warning; stderr: ${r.stderr}`);
      } finally {
        cleanup(dir);
      }
    });

  test('COW destination not writable → hard fail with actionable hint',
    { skip: skipRoot }, () => {
      const base = mktmp('boxsh-preflight-cow-');
      const src = path.join(base, 'src');
      const dst = path.join(base, 'dst');
      try {
        fs.mkdirSync(src);
        fs.mkdirSync(dst);
        fs.writeFileSync(path.join(src, 'f.txt'), 'x\n');
        fs.chmodSync(dst, 0o555);
        const r = runAt(base, ['--sandbox', '--bind', `cow:${src}:${dst}`, '-c', 'echo ok']);
        assert.notEqual(r.status, 0,
          'COW with unwritable destination must fail closed before mounting');
        assert.ok(r.stderr.includes('COW destination'),
          `expected COW destination error; stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('not writable by uid'),
          `expected uid in error; stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('chown'),
          `expected chown hint; stderr: ${r.stderr}`);
      } finally {
        try { fs.chmodSync(dst, 0o700); } catch { /* already gone */ }
        cleanup(base);
      }
    });

  test('COW destination on an unwritable ancestor → creation hint',
    { skip: skipRoot }, () => {
      const parent = mktmp('boxsh-preflight-cowparent-');
      const src = path.join(parent, 'src');
      const dst = path.join(parent, 'nested', 'deep', 'dst');
      try {
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'f.txt'), 'x\n');
        fs.chmodSync(parent, 0o555); // dst does not exist; creation blocked
        const r = runAt(parent, ['--sandbox', '--bind', `cow:${src}:${dst}`, '-c', 'echo ok']);
        assert.notEqual(r.status, 0,
          'COW with uncreatable destination must fail closed');
        assert.ok(r.stderr.includes('COW destination'),
          `expected COW destination error; stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('cannot be created'),
          `expected creation hint; stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('chown'),
          `expected chown hint; stderr: ${r.stderr}`);
      } finally {
        cleanup(parent);
      }
    });

  test('COW source not readable → hard fail with actionable hint',
    { skip: skipRoot }, () => {
      const base = mktmp('boxsh-preflight-cowsrc-');
      const src = path.join(base, 'src');
      const dst = path.join(base, 'dst');
      try {
        fs.mkdirSync(src);
        fs.mkdirSync(dst);
        fs.writeFileSync(path.join(src, 'f.txt'), 'x\n');
        fs.chmodSync(src, 0o000);
        const r = runAt(base, ['--sandbox', '--bind', `cow:${src}:${dst}`, '-c', 'echo ok']);
        assert.notEqual(r.status, 0,
          'COW with unreadable source must fail closed before mounting');
        assert.ok(r.stderr.includes('COW source'),
          `expected COW source error; stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('not readable'),
          `expected readability error; stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('chown'),
          `expected chown hint; stderr: ${r.stderr}`);
      } finally {
        try { fs.chmodSync(src, 0o700); } catch { /* already gone */ }
        cleanup(base);
      }
    });
});
