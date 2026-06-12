/**
 * terminal-sandbox.test.mjs — reproduce grantpt/unlockpt failure
 * when run_in_terminal is used inside a macOS Seatbelt sandbox.
 *
 * On macOS, grantpt()/unlockpt() require access to PTY devices that
 * the sandbox profile must explicitly allow.  Without those rules,
 * the call fails with "grantpt/unlockpt failed".
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BOXSH, TEMPDIR } from './helpers.mjs';

const IS_MACOS = process.platform === 'darwin';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Start boxsh in RPC mode with --sandbox and return a session object that
 * can send JSON-RPC tools/call requests and read responses.
 */
class SandboxedBoxshSession {
  /**
   * @param {object} opts
   * @param {string} opts.basePath   - cow source (read-only base)
   * @param {string} opts.overlayPath - cow dst (captures writes)
   * @param {string} [opts.repoPath]  - optional ro bind
   * @param {string} [opts.stageDir]  - optional wr bind
   */
  constructor(opts) {
    const args = [
      '--rpc',
      '--workers', '1',
      '--sandbox',
      '--bind', `cow:${opts.basePath}:${opts.overlayPath}`,
    ];
    if (opts.repoPath) {
      args.push('--bind', `ro:${opts.repoPath}`);
    }
    if (opts.stageDir) {
      args.push('--bind', `wr:${opts.stageDir}`);
    }

    this._proc = spawn(BOXSH, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this._pending = new Map();
    this._nextId  = 1;
    this._closed  = false;

    const rl = createInterface({ input: this._proc.stdout });
    rl.on('line', line => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      // Also handle Content-Length framed responses.
      const p = this._pending.get(String(msg.id));
      if (p) {
        this._pending.delete(String(msg.id));
        p.resolve(msg);
      }
    });

    this._proc.on('error', err => {
      for (const p of this._pending.values()) p.reject(err);
      this._pending.clear();
    });

    // Collect stderr for diagnostics
    this._stderr = '';
    this._proc.stderr?.on('data', d => { this._stderr += d.toString(); });
  }

  /** Send a tools/call request. */
  call(toolName, args = {}, timeout_ms = 15000) {
    return new Promise((resolve, reject) => {
      const reqId = String(this._nextId++);
      const rpcReq = {
        jsonrpc: '2.0',
        id: reqId,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      };
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error(`timeout waiting for id=${reqId} (${toolName})`));
      }, timeout_ms);

      this._pending.set(reqId, {
        resolve: msg => { clearTimeout(timer); resolve(msg); },
        reject:  err  => { clearTimeout(timer); reject(err);  },
      });

      this._proc.stdin.write(JSON.stringify(rpcReq) + '\n');
    });
  }

  /** Extract structuredContent from response, or throw. */
  static sc(resp) {
    assert.ok(!resp.error, `JSON-RPC error: ${JSON.stringify(resp.error)}`);
    const r = resp.result ?? {};
    if (r.isError) {
      const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      throw new Error(text || JSON.stringify(r));
    }
    return r.structuredContent ?? {};
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._proc.kill('SIGKILL');
    // Drain
    try { await new Promise(r => setTimeout(r, 200)); } catch {}
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('terminal inside sandbox', () => {
  /** @type {SandboxedBoxshSession} */
  let session;
  let workDir;

  before(() => {
    // Create a temporary base directory (cow source - readonly base).
    // The overlay captures writes.
    const basePath = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-terminal-sandbox-base-'));
    // Put a file in it so it's not empty
    fs.writeFileSync(path.join(basePath, 'hello.txt'), 'hello sandbox\n');

    workDir = fs.mkdtempSync(path.join(TEMPDIR, 'boxsh-terminal-sandbox-work-'));
    const overlayPath = path.join(workDir, 'overlay');
    fs.mkdirSync(overlayPath);

    session = new SandboxedBoxshSession({
      basePath,
      overlayPath,
    });
  });

  after(async () => {
    if (session) await session.close();
  });

  test('run_in_terminal inside --sandbox', async () => {
    // This was failing with "grantpt/unlockpt failed" on macOS because
    // the sandbox profile did not allow PTY operations.
    const resp = await session.call('run_in_terminal', {
      command: 'echo hello && echo world',
    });

    const sc = SandboxedBoxshSession.sc(resp);
    assert.ok(sc.id, 'should have a session id');
    assert.ok(typeof sc.output === 'string', 'should have output');
    // The output should contain the echoed text
    assert.ok(
      sc.output.includes('hello') || sc.output.includes('world'),
      `output should contain the command result, got: ${JSON.stringify(sc.output)}`,
    );
  });
});
