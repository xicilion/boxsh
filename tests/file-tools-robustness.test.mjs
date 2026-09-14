/**
 * file-tools-robustness.test.mjs — L3 hardening suite for the file tools
 * (read / view_image / write / edit).
 *
 * Scope (README.md "Tools" / "Error model"; the guarantees added on
 * 2026-09-14):
 *   - target types that would block a tool thread (FIFO / socket) or that are
 *     not files at all (directory), and symlink resolution;
 *   - `read` result self-consistency: empty_reason / total_lines / next_offset /
 *     file_size, and the bounded single-line input path;
 *   - resource guards: 32 MiB single line (memory), declared 11000x11000 PNG
 *     (pixels), oversized edit target;
 *   - write-path semantics: permissions, hard links, symlinks, no-op edits,
 *     failure handling;
 *   - error-channel mapping: errno → code, sandbox vs permission, parameter
 *     errors staying protocol errors.
 *
 * Every case here failed (or hung) on v5.1.1 before the hardening; each one
 * documents the pre-fix observation in a comment.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { BOXSH, rpcRaw, makePng, makePngDeclared } from './helpers.mjs';

/** Checked-in fixture directory (images used by the file-type and image suites). */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Fixtures live in the OS temp dir, NOT in helpers' TEMPDIR: the sandbox suite
// uses TEMPDIR as the copy-on-write source for `boxsh --try`, and a leftover
// symlink loop in that tree makes its manifest walk fail (ELOOP) — and a
// module-level after() hook in an imported suite only runs at the very end of
// the aggregated run, so the loop would be visible to every suite after this
// one.  Everything is still removed in after() and each case cleans up after
// itself.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-robust-'));
after(() => {
  try { fs.chmodSync(ROOT, 0o755); } catch { /* ignore */ }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const p = (...parts) => path.join(ROOT, ...parts);

function write(name, content, opts) {
  fs.writeFileSync(p(name), content, opts);
  return p(name);
}

const plain = write('plain.txt', 'alpha\nbeta\ngamma\n');
const dir = p('adir');
fs.mkdirSync(dir, { recursive: true });
const emptyFile = write('empty.txt', '');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Raw JSON-RPC response for a file-tool call. */
const call = (name, args, opts = {}) =>
  rpcRaw({ id: '1', tool: name, ...args }, { timeout_ms: 4000, ...opts });

const scOf = (resp) => resp.result?.structuredContent ?? {};
const codeOf = (resp) => scOf(resp).code;
const textOf = (resp) => (resp.result?.content ?? []).filter(c => c.type === 'text')
  .map(c => c.text).join('\n');
const detailOf = (resp) => scOf(resp).detail ?? {};
const isToolError = (resp) => resp.result?.isError === true;
const jsonRpcError = (resp) => resp.error?.message ?? '';

/** Assert a raw response is a tool error with the given code. */
function assertToolError(resp, code, label) {
  assert.ok(!resp.error, `${label}: expected a tool error, got JSON-RPC error: ${JSON.stringify(resp.error)}`);
  assert.equal(isToolError(resp), true, `${label}: expected isError=true`);
  assert.equal(codeOf(resp), code, `${label}: unexpected code (text: ${textOf(resp).slice(0, 160)})`);
  assert.match(textOf(resp), new RegExp(`^${code}: `), `${label}: text must start with "<CODE>: "`);
}

/** A long-running boxsh --rpc process, for RSS / thread-count measurements. */
class RpcProc {
  constructor(args = ['--rpc', '--workers', '1']) {
    this.proc = spawn(BOXSH, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = '';
    this.pending = new Map();
    this.seq = 0;
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const resolve = this.pending.get(String(msg.id));
        if (resolve) { this.pending.delete(String(msg.id)); resolve(msg); }
      }
    });
  }

  get pid() { return this.proc.pid; }

  call(name, args = {}, timeoutMs = 30000) {
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${name}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
      }) + '\n');
    });
  }

  /** Resident set size in KiB. */
  rssKb() {
    const out = spawnSync('ps', ['-o', 'rss=', '-p', String(this.pid)]).stdout.toString().trim();
    return Number(out) || 0;
  }

  /** Thread count (macOS `ps -M` prints one line per thread). */
  threads() {
    return spawnSync('ps', ['-M', String(this.pid)]).stdout.toString()
      .trim().split('\n').filter(Boolean).length;
  }

  close() { this.proc.kill('SIGKILL'); }
}

/** Run one request and track the peak RSS of the server process. */
async function peakRssKb(proc, name, args = {}) {
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, proc.rssKb()); }, 15);
  try {
    const resp = await proc.call(name, args);
    peak = Math.max(peak, proc.rssKb());
    return { resp, peak };
  } finally {
    clearInterval(timer);
  }
}

// ---------------------------------------------------------------------------
// Target types: FIFO / socket / directory / symlink (§2.5)
// ---------------------------------------------------------------------------

describe('file tools — target types', () => {
  const FIFO = p('pipe.fifo');
  const SOCK = p('sock');
  let sockServer = null;

  before(async () => {
    const mk = spawnSync('mkfifo', [FIFO]);
    assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`);
    // A listening unix socket is the portable way to materialise a socket file.
    sockServer = net.createServer();
    await new Promise((resolve, reject) => {
      sockServer.once('error', reject);
      sockServer.listen(SOCK, resolve);
    });
  });

  after(() => {
    if (sockServer) sockServer.close();
  });

  test('read on a FIFO fails fast instead of hanging', () => {
    // Pre-fix: the request never returned (open() blocks until a writer
    // appears), so boxsh had to be killed by the harness timeout.
    const t0 = Date.now();
    const resp = call('read', { path: FIFO });
    assertToolError(resp, 'E_INVALID_ARGUMENT', 'read fifo');
    assert.equal(detailOf(resp).kind, 'fifo', 'detail.kind must name the blocking type');
    assert.match(textOf(resp), /bash/, 'message should point at bash');
    assert.ok(Date.now() - t0 < 3000, 'FIFO read must not block');
  });

  test('write on a FIFO fails fast instead of writing into it', () => {
    // Pre-fix: reported "write: <fifo> (overwrote existing, 1 bytes)".
    const resp = call('write', { path: FIFO, content: 'x' });
    assertToolError(resp, 'E_INVALID_ARGUMENT', 'write fifo');
    assert.equal(detailOf(resp).kind, 'fifo');
  });

  test('edit on a FIFO fails fast instead of hanging', () => {
    // Pre-fix: reading the FIFO blocked forever.
    const resp = call('edit', { path: FIFO, edits: [{ oldText: 'a', newText: 'b' }] });
    assertToolError(resp, 'E_INVALID_ARGUMENT', 'edit fifo');
    assert.equal(detailOf(resp).kind, 'fifo');
  });

  test('view_image on a FIFO fails fast', () => {
    const resp = call('view_image', { path: FIFO });
    assertToolError(resp, 'E_INVALID_ARGUMENT', 'view_image fifo');
    assert.equal(detailOf(resp).kind, 'fifo');
  });

  test('all four file tools report a socket target as E_INVALID_ARGUMENT', () => {
    for (const [name, args] of [
      ['read', { path: SOCK }],
      ['view_image', { path: SOCK }],
      ['write', { path: SOCK, content: 'x' }],
      ['edit', { path: SOCK, edits: [{ oldText: 'a', newText: 'b' }] }],
    ]) {
      const resp = call(name, args);
      assertToolError(resp, 'E_INVALID_ARGUMENT', `${name} socket`);
      assert.equal(detailOf(resp).kind, 'socket', `${name}: detail.kind`);
    }
  });

  test('directory targets use one code across all four tools', () => {
    // Pre-fix: read/view_image → E_INVALID_ARGUMENT, write → E_INTERNAL,
    // edit → "oldText not found in file" (E_INVALID_ARGUMENT, misleading text).
    const cases = [
      ['read', { path: dir }, /directory/],
      ['view_image', { path: dir }, /directory/],
      ['write', { path: dir, content: 'x' }, /directory/],
      ['edit', { path: dir, edits: [{ oldText: 'a', newText: 'b' }] }, /directory/],
    ];
    for (const [name, args, pattern] of cases) {
      const resp = call(name, args);
      assertToolError(resp, 'E_INVALID_ARGUMENT', `${name} directory`);
      assert.match(textOf(resp), pattern, `${name}: message should say the target is a directory`);
    }
  });

  test('read follows a symlink to a regular file', () => {
    const link = p('link.txt');
    fs.symlinkSync(plain, link);
    const resp = call('read', { path: link });
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(textOf(resp), 'alpha\nbeta\ngamma\n');
  });

  test('broken symlink reports E_NOT_FOUND, not E_INTERNAL', () => {
    const link = p('dangling.txt');
    fs.symlinkSync(p('does-not-exist.txt'), link);
    for (const name of ['read', 'view_image']) {
      const resp = call(name, { path: link });
      assertToolError(resp, 'E_NOT_FOUND', `${name} dangling symlink`);
    }
  });

  test('character devices keep working (no new restriction)', () => {
    const devNull = call('read', { path: '/dev/null' });
    assert.ok(!isToolError(devNull), `read /dev/null: ${textOf(devNull)}`);
    assert.equal(textOf(devNull), '');

    const devZero = call('read', { path: '/dev/zero' });
    assertToolError(devZero, 'E_NOT_TEXT', 'read /dev/zero');
  });
});

// ---------------------------------------------------------------------------
// read: empty results and pagination self-consistency (§四)
// ---------------------------------------------------------------------------

describe('read — empty results and pagination', () => {
  test('offset beyond EOF reports empty_reason and total_lines', () => {
    // Pre-fix: empty text, line_count 0, truncated false — indistinguishable
    // from an empty file.
    const resp = call('read', { path: plain, offset: 99999 });
    const sc = scOf(resp);
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(textOf(resp), '');
    assert.equal(sc.line_count, 0);
    assert.equal(sc.empty_reason, 'offset_beyond_eof');
    assert.equal(sc.total_lines, 3);
    assert.equal(sc.file_size, fs.statSync(plain).size);
  });

  test('offset == total_lines + 1 also reports offset_beyond_eof', () => {
    const resp = call('read', { path: plain, offset: 4 });
    assert.equal(scOf(resp).empty_reason, 'offset_beyond_eof');
    assert.equal(scOf(resp).total_lines, 3);
  });

  test('empty file reports empty_reason "empty_file" and reads as text/plain', () => {
    const resp = call('read', { path: emptyFile });
    const sc = scOf(resp);
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(sc.empty_reason, 'empty_file');
    assert.equal(sc.line_count, 0);
    assert.equal(sc.file_size, 0);
    // Pre-fix: mime_type was "inode/x-empty".
    assert.equal(sc.mime_type, 'text/plain');
  });

  test('file_size is present on ordinary and truncated reads', () => {
    const win = call('read', { path: plain, limit: 1 });
    assert.equal(scOf(win).file_size, fs.statSync(plain).size);

    const long = write('many-lines.txt',
      Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
    const trunc = call('read', { path: long });
    const sc = scOf(trunc);
    assert.equal(sc.truncated, true);
    assert.equal(sc.total_lines, 2500);
    assert.equal(sc.next_offset, 2001);
    assert.equal(sc.file_size, fs.statSync(long).size);
  });

  test('a truncated single line does not advertise an out-of-range next_offset', () => {
    // Pre-fix: a 60001-byte single-line file returned next_offset=2 while the
    // file only has one line — following the hint silently returns nothing.
    const one = write('one-long-line.txt', 'A'.repeat(60001));
    const resp = call('read', { path: one });
    const sc = scOf(resp);
    assert.equal(sc.truncated, true);
    assert.equal(sc.line_count, 1);
    assert.equal(sc.total_lines, 1);
    assert.equal(sc.next_offset, undefined,
      'next_offset must be omitted when no further line exists');
    assert.match(textOf(resp), /longer than the 50 KiB per-call limit/);
  });

  test('a capped line followed by more lines still offers the next offset', () => {
    const f = write('capped-plus-more.txt', 'B'.repeat(60001) + '\nsecond\n');
    const sc = scOf(call('read', { path: f }));
    assert.equal(sc.truncated, true);
    assert.equal(sc.line_count, 1);
    assert.equal(sc.total_lines, 2);
    assert.equal(sc.next_offset, 2);

    const next = call('read', { path: f, offset: 2 });
    assert.equal(textOf(next), 'second\n');
  });
});

// ---------------------------------------------------------------------------
// read: bounded single-line input (memory)
// ---------------------------------------------------------------------------

describe('read — input-side limits', () => {
  test('a 32 MiB single-line file keeps server memory bounded', async () => {
    // Pre-fix: `getline` buffered the whole line (measured 531 MB for 256 MB
    // of input) before applying the 50 KiB output budget.
    const big = write('big-line.txt', 'a'.repeat(32 * 1024 * 1024));
    const proc = new RpcProc();
    try {
      const { resp, peak } = await peakRssKb(proc, 'read', { path: big });
      const raw = resp.result ?? {};
      const text = (raw.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
      assert.ok(!raw.isError, `unexpected error: ${text.slice(0, 120)}`);
      assert.ok(text.length <= 51 * 1024, `body must stay within the budget, got ${text.length}`);
      assert.ok(peak < 32 * 1024,
        `reading a 32 MiB single line must not balloon memory (peak RSS ${peak} KiB)`);
    } finally {
      proc.close();
      fs.rmSync(big, { force: true });
    }
  });

  test('a 32 MiB single-line file is still reported as truncated text', async () => {
    const big = write('big-line-2.txt', 'z'.repeat(32 * 1024 * 1024));
    try {
      const resp = call('read', { path: big }, { timeout_ms: 20000 });
      const sc = scOf(resp);
      assert.equal(sc.truncated, true);
      assert.equal(sc.line_count, 1);
      assert.equal(sc.file_size, 32 * 1024 * 1024);
    } finally {
      fs.rmSync(big, { force: true });
    }
  });

  test('edit refuses a target above the size limit', () => {
    // Pre-fix: the whole file was read into memory with no upper bound.
    const big = write('big-edit.txt', 'header\n' + 'x'.repeat(20 * 1024 * 1024));
    try {
      const resp = call('edit', { path: big, edits: [{ oldText: 'header', newText: 'H' }] },
        { timeout_ms: 20000 });
      assertToolError(resp, 'E_TOO_LARGE', 'edit oversized file');
      const detail = detailOf(resp);
      assert.equal(typeof detail.size, 'number');
      assert.equal(typeof detail.limit, 'number');
      assert.ok(detail.size > detail.limit, 'detail.size must exceed detail.limit');
      assert.match(textOf(resp), /bash/);
      // The file must be untouched.
      assert.equal(fs.statSync(big).size, 7 + 20 * 1024 * 1024);
    } finally {
      fs.rmSync(big, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// view_image: decode resource guard and failure discrimination
// ---------------------------------------------------------------------------

describe('view_image — decode guards', () => {
  const bomb = write('bomb.png', makePngDeclared(11000, 11000));

  test('a huge declared pixel count is rejected before decoding', async () => {
    // Pre-fix: stb_image allocated the declared buffer (11000x11000x3 ≈ 363 MB)
    // before discovering the data was bogus.
    const proc = new RpcProc();
    try {
      const { resp, peak } = await peakRssKb(proc, 'view_image', { path: bomb });
      const raw = resp.result ?? {};
      assert.equal(raw.isError, true, 'declared-pixel bomb must be rejected');
      assert.equal(raw.structuredContent?.code, 'E_TOO_LARGE');
      const detail = raw.structuredContent?.detail ?? {};
      assert.ok(detail.pixels >= 11000 * 11000, `detail.pixels: ${detail.pixels}`);
      assert.equal(typeof detail.limit, 'number');
      assert.ok(peak < 256 * 1024,
        `pixel guard must not allocate the declared buffer (peak RSS ${peak} KiB)`);
    } finally {
      proc.close();
    }
  });

  test('a corrupt PNG reports E_UNSUPPORTED_FORMAT + detail.reason=decode_failed', () => {
    // Pre-fix: indistinguishable from "format not supported".
    const good = makePng(8, 8, { solid: true });
    const corrupt = write('corrupt.png', good.subarray(0, 40));
    const resp = call('view_image', { path: corrupt });
    assertToolError(resp, 'E_UNSUPPORTED_FORMAT', 'corrupt png');
    assert.equal(detailOf(resp).reason, 'decode_failed');
    assert.match(textOf(resp), /bash/, 'message should point at bash for inspection');
  });

  test('an unsupported image format keeps detail.supported and carries no reason', () => {
    // A recognised image that this build cannot decode: jxl (fixtures ship
    // with the repo).  The code stays E_UNSUPPORTED_FORMAT and the reason key
    // must be absent, so callers can tell it apart from a corrupt file.
    const jxl = path.join(FIXTURES, 'fixture.jxl');
    const resp = call('view_image', { path: jxl });
    assertToolError(resp, 'E_UNSUPPORTED_FORMAT', 'jxl');
    assert.ok(Array.isArray(detailOf(resp).supported), 'detail.supported must list decodable formats');
    assert.ok(!detailOf(resp).reason, 'unsupported format must not claim a decode failure');
  });

  test('a non-image file is E_NOT_IMAGE, not a format error', () => {
    const svg = write('vector.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
    const resp = call('view_image', { path: svg });
    assertToolError(resp, 'E_NOT_IMAGE', 'svg');
    assert.ok(!detailOf(resp).reason, 'a non-image must not claim a decode failure');
  });

  test('a normal image still decodes (guard does not over-trigger)', () => {
    const png = write('ok.png', makePng(64, 64, { solid: true }));
    const resp = call('view_image', { path: png });
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(scOf(resp).encoding, 'image');
    assert.equal(scOf(resp).width, 64);
  });
});

// ---------------------------------------------------------------------------
// write / edit: semantics on the write path
// ---------------------------------------------------------------------------

describe('write — semantics', () => {
  test('overwriting preserves the mode bits', () => {
    const f = write('mode.txt', 'old\n', { mode: 0o600 });
    fs.chmodSync(f, 0o600);
    const resp = call('write', { path: f, content: 'new\n' });
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(fs.readFileSync(f, 'utf8'), 'new\n');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  });

  test('writing through a symlink keeps the symlink and updates the target', () => {
    const target = write('sym-target.txt', 'target\n');
    const link = p('sym-link.txt');
    fs.symlinkSync(target, link);
    const resp = call('write', { path: link, content: 'via link\n' });
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link must not be replaced');
    assert.equal(fs.readFileSync(target, 'utf8'), 'via link\n');
  });

  test('writing keeps hard links intact', () => {
    const a = write('hard-a.txt', 'shared\n');
    const b = p('hard-b.txt');
    fs.linkSync(a, b);
    const resp = call('write', { path: a, content: 'changed\n' });
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(fs.statSync(a).nlink, 2, 'in-place write must not break the link');
    assert.equal(fs.readFileSync(b, 'utf8'), 'changed\n');
  });

  test('a parent that is a file reports E_INVALID_ARGUMENT (not E_INTERNAL)', () => {
    // Pre-fix: ENOTDIR fell through to E_INTERNAL.
    const resp = call('write', { path: p('plain.txt', 'sub.txt'), content: 'x' });
    assertToolError(resp, 'E_INVALID_ARGUMENT', 'write under a file');
  });

  test('an over-long file name reports E_INVALID_ARGUMENT', () => {
    // Pre-fix: ENAMETOOLONG fell through to E_INTERNAL.
    const long = 'n'.repeat(300) + '.txt';
    const w = call('write', { path: p(long), content: 'x' });
    assertToolError(w, 'E_INVALID_ARGUMENT', 'write long name');
    const r = call('read', { path: p(long) });
    assertToolError(r, 'E_INVALID_ARGUMENT', 'read long name');
  });

  test('a read-only target reports E_SANDBOX with detail.sandbox=false', () => {
    // Pre-fix: the code was right but the message claimed nothing about the
    // actual cause; detail carried nothing at all.
    const f = write('readonly.txt', 'ro\n');
    fs.chmodSync(f, 0o444);
    try {
      const resp = call('write', { path: f, content: 'x' });
      assertToolError(resp, 'E_SANDBOX', 'write readonly');
      assert.equal(detailOf(resp).sandbox, false, 'no sandbox is active in this run');
      assert.equal(typeof detailOf(resp).errno, 'number');
      assert.match(textOf(resp), /permission/i);
      assert.equal(fs.readFileSync(f, 'utf8'), 'ro\n', 'content must be untouched');
    } finally {
      fs.chmodSync(f, 0o644);
    }
  });

  test('a sandboxed write outside the exposed paths never reaches the host', () => {
    // The security property is portable: the host file must not appear.  The
    // *mechanism* differs per platform, so the denial assertions are scoped:
    //   - macOS Seatbelt denies the write (E_SANDBOX + detail.sandbox);
    //   - the Linux mount namespace gives the sandbox its own /tmp, so the
    //     write succeeds but lands in a throwaway tmpfs.
    const outside = path.join(ROOT, 'sandbox-denied.txt');
    const resp = rpcRaw({ id: '1', tool: 'write', path: outside, content: 'x' },
      { sandbox: true, timeout_ms: 15000 });
    assert.equal(fs.existsSync(outside), false,
      'a sandboxed write must never touch the host filesystem');
    assert.ok(!resp.error, `sandboxed write returned a protocol error: ${JSON.stringify(resp.error)}`);

    if (resp.result?.isError) {
      assertToolError(resp, 'E_SANDBOX', 'sandboxed write');
      assert.equal(detailOf(resp).sandbox, true, 'the sandbox is active in this run');
      assert.match(textOf(resp), /--bind/, 'message should mention how to expose the path');
    } else {
      assert.equal(process.platform, 'linux',
        'only the Linux sandbox isolates /tmp instead of denying writes');
    }
  });
});

// ---------------------------------------------------------------------------
// dangling symlinks: E_NOT_FOUND stays, but the diagnosis is explicit
// ---------------------------------------------------------------------------

describe('file tools — dangling symlinks', () => {
  test('a broken symlink carries detail.kind=dangling_symlink and its target', () => {
    // Without this, a typo, an undeployed file and a broken link were three
    // identical E_NOT_FOUND answers — and a "create it" retry would follow the
    // link and produce an unintended file.
    const link = p('dangle.txt');
    fs.symlinkSync('missing-target.txt', link);
    try {
      for (const [name, args] of [
        ['read', { path: link }],
        ['view_image', { path: link }],
        ['edit', { path: link, edits: [{ oldText: 'a', newText: 'b' }] }],
      ]) {
        const resp = call(name, args);
        assertToolError(resp, 'E_NOT_FOUND', `${name} dangling symlink`);
        assert.equal(detailOf(resp).kind, 'dangling_symlink', `${name}: detail.kind`);
        assert.equal(detailOf(resp).target, 'missing-target.txt', `${name}: detail.target`);
        assert.match(textOf(resp), /broken symbolic link to missing-target\.txt/,
          `${name}: the message must name the link target`);
      }
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  test('a path that never existed carries no dangling-symlink detail', () => {
    const resp = call('read', { path: p('never-existed.txt') });
    assertToolError(resp, 'E_NOT_FOUND', 'missing path');
    assert.equal(detailOf(resp).kind, undefined,
      'a plain missing path must not be reported as a broken link');
    assert.ok(!/broken symbolic link/.test(textOf(resp)));
  });

  test('writing through a dangling symlink creates the target and keeps the link', () => {
    // POSIX open(2) semantics (the same as `echo x > link`): the write follows
    // the link.  Documented in README.md ("write").
    const link = p('dangle-write.txt');
    const target = p('dangle-target.txt');
    fs.symlinkSync(target, link);
    try {
      const resp = call('write', { path: link, content: 'x\n' });
      assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link must survive');
      assert.equal(fs.readFileSync(target, 'utf8'), 'x\n');
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// write: a failed call must not leave any side effect (v2 report P0-1)
// ---------------------------------------------------------------------------

describe('write — no side effects on failure', () => {
  test('a trailing slash on a new path fails without creating a directory', () => {
    // Pre-fix: "write newdir/" returned E_INVALID_ARGUMENT but mkdir -p had
    // already created filetest/newdir/ — a failure with a side effect.
    const resp = call('write', { path: 'slash-new/', content: 'x' });
    assertToolError(resp, 'E_INVALID_ARGUMENT', 'trailing slash');
    assert.match(textOf(resp), /trailing slash/);
    assert.equal(fs.existsSync(p('slash-new')), false,
      'a failed write must not create a directory');
  });

  test('a nested trailing slash leaves nothing behind', () => {
    const resp = call('write', { path: 'slash-deep/a/b/', content: 'x' });
    assertToolError(resp, 'E_INVALID_ARGUMENT', 'nested trailing slash');
    assert.equal(fs.existsSync(p('slash-deep')), false,
      'no intermediate directory may survive a failed write');
  });

  test('a write that fails after mkdir -p removes the directories it created', () => {
    // The parent path is missing (open → ENOENT, so mkdir -p runs) while the
    // final component is over-long, which makes the retry fail with
    // ENAMETOOLONG.  Every directory created on the way must be removed again.
    const long = 'z'.repeat(300) + '.txt';
    const resp = call('write', { path: p('rollback-dir', 'deep', long), content: 'x' });
    assertToolError(resp, 'E_INVALID_ARGUMENT', 'over-long final component');
    assert.equal(fs.existsSync(p('rollback-dir')), false,
      'directories created for a failed write must be removed');
  });

  test('a successful nested write still creates the directories', () => {
    const resp = call('write', { path: p('ok-dir', 'a', 'b.txt'), content: 'kept\n' });
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(fs.readFileSync(p('ok-dir', 'a', 'b.txt'), 'utf8'), 'kept\n');
  });
});

// ---------------------------------------------------------------------------
// symlink loops and permission consistency (v2 report P1-1 / P1-3)
// ---------------------------------------------------------------------------

describe('file tools — loops and permissions', () => {
  test('a symlink loop reports E_INVALID_ARGUMENT with an explicit message', () => {
    // Pre-fix: ELOOP was mapped to E_NOT_FOUND, so a loop looked like a
    // retryable missing file.
    const a = p('loop-a');
    const b = p('loop-b');
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    try {
      for (const [name, args] of [
        ['read', { path: a }],
        ['view_image', { path: a }],
        ['write', { path: a, content: 'x' }],
        ['edit', { path: a, edits: [{ oldText: 'a', newText: 'b' }] }],
      ]) {
        const resp = call(name, args);
        assertToolError(resp, 'E_INVALID_ARGUMENT', `${name} symlink loop`);
        assert.match(textOf(resp), /symbolic link loop/, `${name}: message must name the loop`);
        assert.equal(detailOf(resp).errno_name, 'ELOOP', `${name}: raw errno belongs in detail`);
      }
    } finally {
      // Never leave a loop behind: recursive directory walks (COW manifests,
      // rm -r) treat it as an error.
      fs.rmSync(a, { force: true });
      fs.rmSync(b, { force: true });
    }
  });

  test('an unreadable file is reported identically by read and view_image', () => {
    // Pre-fix: read said "E_SANDBOX: Permission denied" while view_image said
    // "E_NOT_IMAGE (application/octet-stream)" — same root cause, two answers.
    const f = write('noperm.txt', 'secret\n');
    fs.chmodSync(f, 0o000);
    try {
      const read = call('read', { path: f });
      const view = call('view_image', { path: f });
      assertToolError(read, 'E_SANDBOX', 'read unreadable file');
      assertToolError(view, 'E_SANDBOX', 'view_image unreadable file');
      assert.match(textOf(view), /permission/i, 'the real cause must be named');
      assert.equal(detailOf(view).sandbox, false);
      assert.equal(detailOf(read).errno, detailOf(view).errno,
        'the same root cause must carry the same errno');
    } finally {
      fs.chmodSync(f, 0o644);
    }
  });
});

describe('edit — semantics', () => {
  test('an empty edits array does not touch the file', () => {
    // Pre-fix: the file was rewritten (mtime changed) for a no-op.
    const f = write('noop-empty.txt', 'one\ntwo\n');
    const before = fs.statSync(f);
    const resp = call('edit', { path: f, edits: [] });
    const after = fs.statSync(f);
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(textOf(resp), `edit: ${f} (no changes)`);
    assert.equal(after.mtimeMs, before.mtimeMs, 'mtime must not change');
    assert.equal(fs.readFileSync(f, 'utf8'), 'one\ntwo\n');
  });

  test('an edit that changes nothing does not write the file', () => {
    const f = write('noop-same.txt', 'keep me\n');
    const before = fs.statSync(f);
    const resp = call('edit', { path: f, edits: [{ oldText: 'keep me', newText: 'keep me' }] });
    const after = fs.statSync(f);
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.equal(after.mtimeMs, before.mtimeMs, 'mtime must not change');
    assert.equal(after.ino, before.ino, 'inode must not change');
    assert.equal(fs.readFileSync(f, 'utf8'), 'keep me\n');
  });

  test('a real edit still rewrites in place and reports the change', () => {
    const f = write('real-edit.txt', 'alpha\nbeta\n');
    const before = fs.statSync(f);
    const resp = call('edit', { path: f, edits: [{ oldText: 'beta', newText: 'BETA' }] });
    assert.ok(!isToolError(resp), `unexpected error: ${textOf(resp)}`);
    assert.match(textOf(resp), /^edit: .*\(\+1 -1, first change at line 2\)$/);
    const after = fs.statSync(f);
    assert.equal(after.ino, before.ino, 'in-place rewrite keeps the inode');
    assert.equal(fs.readFileSync(f, 'utf8'), 'alpha\nBETA\n');
  });

  test('a failed edit leaves the file byte-identical', () => {
    const f = write('failed-edit.txt', 'one\ntwo\n');
    const before = fs.statSync(f);
    const resp = call('edit', { path: f, edits: [{ oldText: 'one', newText: '1' }, { oldText: 'nope', newText: 'x' }] });
    assertToolError(resp, 'E_INVALID_ARGUMENT', 'edit partial failure');
    const after = fs.statSync(f);
    assert.equal(after.mtimeMs, before.mtimeMs, 'mtime must not change on failure');
    assert.equal(fs.readFileSync(f, 'utf8'), 'one\ntwo\n');
  });

  test('a read-only file is not modified and reports E_SANDBOX', () => {
    const f = write('edit-readonly.txt', 'stay\n');
    fs.chmodSync(f, 0o444);
    try {
      const resp = call('edit', { path: f, edits: [{ oldText: 'stay', newText: 'gone' }] });
      assertToolError(resp, 'E_SANDBOX', 'edit readonly');
      assert.equal(detailOf(resp).sandbox, false);
      assert.equal(fs.readFileSync(f, 'utf8'), 'stay\n');
    } finally {
      fs.chmodSync(f, 0o644);
    }
  });
});

// ---------------------------------------------------------------------------
// Parameter validation stays a protocol error (§2.2)
// ---------------------------------------------------------------------------

describe('file tools — parameter errors', () => {
  test('an empty path is a protocol error for all four tools', () => {
    // Pre-fix: read/write/edit/view_image answered E_NOT_FOUND, i.e. a caller
    // mistake was reported as a missing file.
    const cases = [
      ['read', { path: '' }],
      ['write', { path: '', content: 'x' }],
      ['edit', { path: '', edits: [{ oldText: 'a', newText: 'b' }] }],
      ['view_image', { path: '' }],
    ];
    for (const [name, args] of cases) {
      const resp = call(name, args);
      assert.ok(resp.error, `${name}: expected a JSON-RPC error`);
      assert.equal(resp.error.code, -32000, `${name}: expected -32000`);
      assert.match(jsonRpcError(resp), /path/);
    }
  });

  test('read offset/limit rejects non-integers and out-of-range values', () => {
    for (const args of [{ offset: 0 }, { offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: '2' }]) {
      const resp = call('read', { path: plain, ...args });
      assert.ok(resp.error, `expected a protocol error for ${JSON.stringify(args)}`);
      assert.equal(resp.error.code, -32000);
    }
  });
});

// ---------------------------------------------------------------------------
// Stability: no hangs, no thread growth
// ---------------------------------------------------------------------------

describe('file tools — stability', () => {
  test('a hung request cannot happen: every blocking target returns quickly', async () => {
    const FIFO = p('fast.fifo');
    spawnSync('mkfifo', [FIFO]);
    const proc = new RpcProc();
    try {
      const t0 = Date.now();
      for (const [name, args] of [
        ['read', { path: FIFO }],
        ['write', { path: FIFO, content: 'x' }],
      ]) {
        const resp = await proc.call(name, args, 3000);
        assert.equal(resp.result?.isError, true, `${name} must fail`);
      }
      assert.ok(Date.now() - t0 < 3000, 'blocking targets must fail fast');
    } finally {
      proc.close();
      fs.rmSync(FIFO, { force: true });
    }
  });

  test('50 sequential file-tool calls do not grow the thread count',
    { skip: process.platform !== 'darwin' && 'thread counting uses ps -M (macOS)' },
    async () => {
      const proc = new RpcProc();
      try {
        // Warm up so that lazily created threads exist before we measure.
        await proc.call('read', { path: plain });
        const before = proc.threads();
        for (let i = 0; i < 50; i++) {
          const resp = await proc.call('read', { path: plain, offset: (i % 3) + 1, limit: 1 });
          assert.ok(!resp.result?.isError, `call ${i} failed`);
        }
        const after = proc.threads();
        assert.ok(after <= before + 4,
          `thread count grew from ${before} to ${after} over 50 calls`);
      } finally {
        proc.close();
      }
    });
});
