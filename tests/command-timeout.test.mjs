/**
 * command-timeout.test.mjs — the server-side timeout safety net
 * (--command-timeout) and the cleanup that runs when boxsh shuts down.
 *
 * Why these exist: a client that gives up on a tool call never tells the
 * server.  Before this, a command whose caller had walked away kept running
 * inside boxsh forever, and when boxsh itself was signalled, the command's
 * process group (and any PTY session) was left behind as an orphan.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BOXSH, run } from './helpers.mjs';

// ---------------------------------------------------------------------------
// A boxsh --rpc server we can signal while a command is still running.
// ---------------------------------------------------------------------------

function startServer(extraArgs = []) {
  const proc = spawn(BOXSH, ['--rpc', '--workers', '2', ...extraArgs]);
  // boxsh is expected to die while requests are still in flight in some of
  // these tests; writing to its stdin afterwards must not crash the reader.
  proc.stdin.on('error', () => {});

  const pending = new Map();
  let nextId = 1;

  const rl = createInterface({ input: proc.stdout });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(String(msg.id));
    if (p) {
      pending.delete(String(msg.id));
      p.resolve(msg);
    }
  });

  const raw = (method, params, timeout_ms = 8000) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response for ${method} (id=${id})`));
      }, timeout_ms);
      pending.set(id, {
        resolve: msg => { clearTimeout(timer); resolve(msg); },
        reject:  err => { clearTimeout(timer); reject(err);  },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  return {
    proc,
    /** tools/call that returns the raw JSON-RPC response. */
    call: (name, args, timeout_ms) =>
      raw('tools/call', { name, arguments: args }, timeout_ms),
    raw,
    /** Wait until the process exits (or reject after `timeout_ms`). */
    waitClose(timeout_ms = 10000) {
      if (proc.exitCode !== null || proc.signalCode !== null)
        return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('boxsh did not exit in time')), timeout_ms);
        proc.on('close', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

const sc = resp => {
  assert.ok(!resp.error, `JSON-RPC error: ${JSON.stringify(resp.error)}`);
  return resp.result.structuredContent ?? {};
};
const text = resp => (resp.result.content ?? [])[0]?.text ?? '';

/** Sleep duration used as a marker so a leftover process is identifiable. */
const PROBE_SLEEP = 'sleep 987';

/** PIDs of any process still matching `pattern` (excluding this script). */
function matchingPids(pattern) {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  return ps.stdout.split('\n')
    .filter(line => line.includes(pattern) && !line.includes('ps -A'))
    .map(line => Number(line.trim().split(/\s+/)[0]))
    .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Poll until `file` exists (the command has started) or time runs out. */
async function waitForFile(file, timeout_ms = 5000) {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`file never appeared: ${file}`);
}

// Fixtures live in os.tmpdir(), not helpers' TEMPDIR: the sandbox suite runs
// `boxsh --try` with cwd=TEMPDIR and walks that tree.
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-cmd-timeout-'));

// ---------------------------------------------------------------------------
// Server-side default timeout
// ---------------------------------------------------------------------------

describe('command-timeout — server default', () => {
  test('a request without a timeout is killed after the server default', async () => {
    const s = startServer(['--command-timeout', '2']);
    const started = Date.now();
    const resp = await s.call('bash', { command: 'sleep 30' });
    const elapsed = Date.now() - started;
    const scx = sc(resp);

    assert.equal(scx.timed_out, true, JSON.stringify(resp));
    assert.equal(scx.exit_code, -1);
    assert.equal(scx.stderr, 'timeout');
    assert.equal(scx.timeout_sec, 2);
    assert.equal(scx.timeout_source, 'server_default');
    assert.ok(elapsed < 6000, `killed too late: ${elapsed}ms`);
    assert.equal(resp.result.isError, true);
    // The model is told it can ask for longer instead of just "[timeout]".
    assert.match(text(resp), /server default of 2s/);

    // The worker survives and keeps serving.
    const after = await s.call('bash', { command: 'echo alive' });
    assert.equal(sc(after).exit_code, 0);
    assert.equal(sc(after).stdout, 'alive\n');

    await s.proc.kill();
    await s.waitClose();
  });

  test('timeout: 0 means "use the server default"', async () => {
    const s = startServer(['--command-timeout', '2']);
    const resp = await s.call('bash', { command: 'sleep 30', timeout: 0 });
    assert.equal(sc(resp).timed_out, true, JSON.stringify(resp));
    assert.equal(sc(resp).timeout_sec, 2);
    assert.equal(sc(resp).timeout_source, 'server_default');
    await s.proc.kill();
    await s.waitClose();
  });

  test('an explicit timeout wins over the default — long commands stay possible', async () => {
    const s = startServer(['--command-timeout', '1']);
    const resp = await s.call('bash', { command: 'sleep 2; echo ok', timeout: 5 });
    const scx = sc(resp);
    assert.equal(scx.exit_code, 0, JSON.stringify(resp));
    assert.equal(scx.stdout, 'ok\n');
    assert.equal(scx.timed_out, undefined);
    await s.proc.kill();
    await s.waitClose();
  });

  test('an explicit timeout shorter than the default still wins', async () => {
    const s = startServer(['--command-timeout', '60']);
    const resp = await s.call('bash', { command: 'sleep 30', timeout: 1 });
    const scx = sc(resp);
    assert.equal(scx.timed_out, true);
    assert.equal(scx.timeout_sec, 1);
    assert.equal(scx.timeout_source, 'request');
    // Both timeout texts say what happened and how long it ran; this one names
    // the timeout the request itself passed.
    assert.equal(text(resp),
      '[stderr]\ntimeout\n[timeout: killed after 1s (the `timeout` this request passed)]\n[exit code: -1]\n');
    await s.proc.kill();
    await s.waitClose();
  });

  test('output printed before the timeout is returned, not thrown away', async () => {
    const s = startServer(['--command-timeout', '2']);
    const resp = await s.call('bash', { command: 'echo PRE; echo PRE-ERR 1>&2; sleep 30' });
    const scx = sc(resp);
    assert.equal(scx.timed_out, true);
    assert.equal(scx.stdout, 'PRE\n', 'the progress the command already printed survives');
    assert.equal(scx.stderr, 'PRE-ERR\ntimeout', 'its stderr survives too, with the marker appended');
    assert.match(text(resp), /\[stdout\]\nPRE\n\[stderr\]\nPRE-ERR\ntimeout\n\[timeout:/);
    await s.proc.kill();
    await s.waitClose();
  });

  test('--command-timeout 0 disables the safety net', async () => {
    const s = startServer(['--command-timeout', '0']);
    const resp = await s.call('bash', { command: 'sleep 2; echo ok' });
    assert.equal(sc(resp).exit_code, 0, JSON.stringify(resp));
    assert.equal(sc(resp).stdout, 'ok\n');
    await s.proc.kill();
    await s.waitClose();
  });

  test('commands that finish in time are unaffected', async () => {
    const s = startServer(); // default 60s
    const resp = await s.call('bash', { command: 'echo hi' });
    assert.equal(sc(resp).exit_code, 0);
    assert.equal(sc(resp).stdout, 'hi\n');
    await s.proc.kill();
    await s.waitClose();
  });

  test('the configured default is advertised in tools/list', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 'l', method: 'tools/list' }) + '\n';
    const listed = run(['--rpc', '--command-timeout', '7'], line, 5000);
    const tools = JSON.parse(listed.stdout.trim()).result.tools;
    const bash = tools.find(t => t.name === 'bash');
    assert.match(bash.description, /killed after 7 seconds by default/);

    const plain = run(['--rpc'], line, 5000);
    const bashDefault = JSON.parse(plain.stdout.trim()).result.tools
      .find(t => t.name === 'bash');
    assert.match(bashDefault.description, /killed after 60 seconds by default/);
    assert.ok(bashDefault.outputSchema.properties.timeout_sec,
      'outputSchema should document timeout_sec');
  });
});

// ---------------------------------------------------------------------------
// Shutdown cleanup: nothing survives boxsh
// ---------------------------------------------------------------------------

describe('command-timeout — nothing outlives the server', () => {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    test(`${sig} takes running commands and PTY sessions down with it`, async () => {
      const dir = fs.mkdtempSync(path.join(probeDir, 'sig-'));
      const cmdPidFile = path.join(dir, 'cmd.pid');
      const sessPidFile = path.join(dir, 'sess.pid');

      // --command-timeout 0: the processes below must die because boxsh died,
      // not because a timeout happened to fire.
      const s = startServer(['--command-timeout', '0']);

      // Fire and forget: neither request ever gets a response.
      s.call('bash',
        { command: `echo $$ > ${cmdPidFile}; sleep 987` }).catch(() => {});
      s.call('run_in_terminal',
        { command: `echo $$ > ${sessPidFile}; sleep 987` }).catch(() => {});

      const cmdPid = await waitForFile(cmdPidFile);
      const sessPid = await waitForFile(sessPidFile);
      assert.ok(pidAlive(cmdPid), `command shell ${cmdPid} should be running`);

      s.proc.kill(sig);
      await s.waitClose();

      // Give the OS a moment to finish reaping the process groups.
      await new Promise(r => setTimeout(r, 500));

      assert.equal(pidAlive(cmdPid), false,
        `command shell ${cmdPid} survived ${sig}`);
      assert.equal(pidAlive(sessPid), false,
        `PTY session shell ${sessPid} survived ${sig}`);
      assert.deepEqual(matchingPids(PROBE_SLEEP), [],
        `${sig}: "sleep 987" processes survived boxsh`);
    });
  }

  test('a client that closes stdin is not left waiting on a runaway command', async () => {
    const dir = fs.mkdtempSync(path.join(probeDir, 'eof-'));
    const pidFile = path.join(dir, 'cmd.pid');

    const s = startServer(['--command-timeout', '2']);
    s.call('bash', { command: `echo $$ > ${pidFile}; sleep 987` })
      .catch(() => {});
    const cmdPid = await waitForFile(pidFile);

    // The client goes away without saying goodbye: stdin EOF.
    s.proc.stdin.end();
    await s.waitClose(10000);

    await new Promise(r => setTimeout(r, 500));
    assert.equal(pidAlive(cmdPid), false, `command shell ${cmdPid} survived EOF`);
    assert.deepEqual(matchingPids(PROBE_SLEEP), []);
  });

  // Regression: an interactive shell ignores SIGTERM, so a shutdown that only
  // sends SIGTERM (and then waits for the PTY to report EOF) hangs forever —
  // the whole server stops responding.  Escalating to SIGKILL is what makes
  // this terminate.
  test('a session whose shell ignores SIGTERM does not block shutdown', async () => {
    const s = startServer(['--command-timeout', '0']);
    const resp = await s.call('run_in_terminal', { command: 'bash' });
    assert.ok(sc(resp).id, `no session id: ${JSON.stringify(resp)}`);

    const started = Date.now();
    s.proc.kill('SIGTERM');
    await s.waitClose(8000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 6000, `shutdown took ${elapsed}ms on a SIGTERM-ignoring session`);
  });
});
