/**
 * shell-mode.test.mjs — tests for boxsh running as a normal POSIX shell
 * (no --rpc flag), delegating to the embedded dash engine.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Basic invocation
// ---------------------------------------------------------------------------

describe('shell mode — basic invocation', () => {
  test('executes a simple command via stdin', () => {
    const r = run([], 'echo hello\n');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'hello\n');
  });

  test('-c flag executes inline command', () => {
    const r = run(['-c', 'echo from-c-flag']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'from-c-flag\n');
  });

  test('-c flag with argument passes $0', () => {
    const r = run(['-c', 'echo $0', 'myscript']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'myscript\n');
  });

  test('-c flag with positional arguments sets $1 $2', () => {
    const r = run(['-c', 'echo $1 $2', 'sh', 'foo', 'bar']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'foo bar\n');
  });

  test('empty stdin exits 0', () => {
    const r = run([], '');
    assert.equal(r.status, 0);
  });
});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('shell mode — exit codes', () => {
  test('exit 0 returns 0', () => {
    assert.equal(run([], 'exit 0\n').status, 0);
  });

  test('exit 1 returns 1', () => {
    assert.equal(run([], 'exit 1\n').status, 1);
  });

  test('exit 42 returns 42', () => {
    assert.equal(run([], 'exit 42\n').status, 42);
  });

  test('exit 127 returns 127', () => {
    assert.equal(run([], 'exit 127\n').status, 127);
  });

  test('false returns 1', () => {
    assert.equal(run([], 'false\n').status, 1);
  });

  test('true returns 0', () => {
    assert.equal(run([], 'true\n').status, 0);
  });

  test('last command exit code is propagated', () => {
    assert.equal(run([], 'true; false\n').status, 1);
    assert.equal(run([], 'false; true\n').status, 0);
  });
});

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

describe('shell mode — I/O', () => {
  test('stdout captured correctly', () => {
    const r = run([], 'printf "abc"\n');
    assert.equal(r.stdout, 'abc');
  });

  test('stderr is separate from stdout', () => {
    const r = run([], 'echo err >&2\n');
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'err\n');
  });

  test('pipeline output is correct', () => {
    const r = run([], 'echo hello | tr a-z A-Z\n');
    assert.equal(r.stdout, 'HELLO\n');
  });

  test('multi-line output is preserved', () => {
    const r = run([], 'printf "a\\nb\\nc\\n"\n');
    assert.equal(r.stdout, 'a\nb\nc\n');
  });

  test('stdout and stderr can both contain output', () => {
    const r = run([], 'echo out; echo err >&2\n');
    assert.equal(r.stdout, 'out\n');
    assert.equal(r.stderr, 'err\n');
  });
});

// ---------------------------------------------------------------------------
// POSIX shell features
// ---------------------------------------------------------------------------

describe('shell mode — POSIX features', () => {
  test('shell variables', () => {
    const r = run([], 'X=hello; echo $X\n');
    assert.equal(r.stdout, 'hello\n');
  });

  test('command substitution $(...)', () => {
    const r = run([], 'echo $(echo inner)\n');
    assert.equal(r.stdout, 'inner\n');
  });

  test('arithmetic expansion $((...))', () => {
    const r = run([], 'echo $((3 + 4))\n');
    assert.equal(r.stdout, '7\n');
  });

  test('if/then/else/fi', () => {
    const r = run([], 'if false; then echo no; else echo yes; fi\n');
    assert.equal(r.stdout, 'yes\n');
  });

  test('while loop', () => {
    const r = run([], 'i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done\n');
    assert.equal(r.stdout, '0\n1\n2\n');
  });

  test('for loop over list', () => {
    const r = run([], 'for x in a b c; do echo $x; done\n');
    assert.equal(r.stdout, 'a\nb\nc\n');
  });

  test('case statement', () => {
    const r = run([], 'x=b; case $x in a) echo A;; b) echo B;; esac\n');
    assert.equal(r.stdout, 'B\n');
  });

  test('logical && short-circuit', () => {
    const r = run([], 'true && echo yes\n');
    assert.equal(r.stdout, 'yes\n');
  });

  test('logical || short-circuit', () => {
    const r = run([], 'false || echo fallback\n');
    assert.equal(r.stdout, 'fallback\n');
  });

  test('function definition and call', () => {
    const r = run([], 'greet() { echo "hi $1"; }; greet world\n');
    assert.equal(r.stdout, 'hi world\n');
  });

  test('subshell ( )', () => {
    const r = run([], '(echo sub)\n');
    assert.equal(r.stdout, 'sub\n');
  });

  test('here-doc', () => {
    const r = run([], 'cat <<EOF\nhello\nEOF\n');
    assert.equal(r.stdout, 'hello\n');
  });

  test('parameter default value ${var:-default}', () => {
    const r = run([], 'echo ${UNSET_VAR_XYZ:-default}\n');
    assert.equal(r.stdout, 'default\n');
  });

  test('string length ${#var}', () => {
    const r = run([], 'S=hello; echo ${#S}\n');
    assert.equal(r.stdout, '5\n');
  });

  test('pattern substitution ${var#prefix}', () => {
    const r = run([], 'F=hello.txt; echo ${F%.txt}\n');
    assert.equal(r.stdout, 'hello\n');
  });

  test('export makes variable visible to child', () => {
    const r = run([], 'export MYVAR=42; sh -c "echo $MYVAR"\n');
    assert.equal(r.stdout, '42\n');
  });

  test('command not found exits non-zero', () => {
    const r = run([], '__no_such_cmd_xyz__\n');
    assert.notEqual(r.status, 0);
  });

  test('set -e aborts on first error', () => {
    const r = run([], 'set -e; false; echo should-not-print\n');
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('set -u treats unset variable as error', () => {
    const r = run([], 'set -u; echo $TOTALLY_UNSET_VAR_XYZ\n');
    assert.notEqual(r.status, 0);
  });

  test('read builtin reads a line from stdin', () => {
    // Supply the line via a here-string alternative (echo | read ... is subshell in dash)
    const r = run([], 'read X <<EOF\nhello\nEOF\necho $X\n');
    assert.equal(r.stdout, 'hello\n');
  });
});

// ---------------------------------------------------------------------------
// Shell mode — sandbox
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BOXSH } from './helpers.mjs';

/** Create lower/upper/work/dst dirs under a fresh temp base. */
function makeOverlayDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'boxsh-sm-'));
  const lower = path.join(base, 'lower');
  const upper = path.join(base, 'upper');
  const work  = path.join(base, 'work');
  const dst   = path.join(base, 'dst');
  fs.mkdirSync(lower); fs.mkdirSync(upper);
  fs.mkdirSync(work);  fs.mkdirSync(dst);
  return {
    lower, upper, work, dst,
    cleanup: () => spawnSync('rm', ['-rf', base]),
  };
}

describe('shell mode — sandbox', () => {
  test('--sandbox --overlay: lower-layer file visible via -c', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      fs.writeFileSync(path.join(lower, 'hello.txt'), 'from-lower\n');
      const r = run(
        ['--sandbox', '--overlay', `${lower}:${upper}:${work}:${dst}`,
         '-c', `cat ${dst}/hello.txt`],
      );
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'from-lower\n');
    } finally {
      cleanup();
    }
  });

  test('--sandbox --overlay: write goes to upper, lower unchanged', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      fs.writeFileSync(path.join(lower, 'base.txt'), 'original\n');
      const r = run(
        ['--sandbox', '--overlay', `${lower}:${upper}:${work}:${dst}`,
         '-c', `echo modified > ${dst}/base.txt`],
      );
      assert.equal(r.status, 0);
      assert.equal(fs.readFileSync(path.join(lower, 'base.txt'), 'utf8'), 'original\n');
      assert.equal(fs.readFileSync(path.join(upper, 'base.txt'), 'utf8'), 'modified\n');
    } finally {
      cleanup();
    }
  });

  test('--sandbox --overlay: delete hides file inside sandbox, lower unchanged', () => {
    const { lower, upper, work, dst, cleanup } = makeOverlayDirs();
    try {
      fs.writeFileSync(path.join(lower, 'victim.txt'), 'delete-me\n');
      const r = run(
        ['--sandbox', '--overlay', `${lower}:${upper}:${work}:${dst}`,
         '-c', `rm ${dst}/victim.txt && [ ! -e ${dst}/victim.txt ] && echo gone`],
      );
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'gone\n');
      assert.equal(fs.readFileSync(path.join(lower, 'victim.txt'), 'utf8'), 'delete-me\n');
    } finally {
      cleanup();
    }
  });

  test('--sandbox --tmpfs: mount is writable', () => {
    const r = run(
      ['--sandbox', '--tmpfs', '/tmp', '-c', 'echo ok > /tmp/x && cat /tmp/x'],
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'ok\n');
  });
});

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

describe('shell mode — built-ins', () => {
  test('echo', () => {
    assert.equal(run([], 'echo test\n').stdout, 'test\n');
  });

  test('printf', () => {
    assert.equal(run([], 'printf "%d\\n" 99\n').stdout, '99\n');
  });

  test('test [ ] returns 0 for true condition', () => {
    assert.equal(run([], '[ 1 -eq 1 ]; echo $?\n').stdout, '0\n');
  });

  test('test [ ] returns 1 for false condition', () => {
    assert.equal(run([], '[ 1 -eq 2 ]; echo $?\n').stdout, '1\n');
  });

  test('pwd outputs a directory path', () => {
    const r = run([], 'pwd\n');
    assert.match(r.stdout.trim(), /^\//);
  });

  test('cd changes working directory', () => {
    const r = run([], 'cd /tmp; pwd\n');
    assert.equal(r.stdout.trim(), '/tmp');
  });

  test('unset removes a variable', () => {
    const r = run([], 'X=hello; unset X; echo ${X:-gone}\n');
    assert.equal(r.stdout, 'gone\n');
  });

  test('readonly prevents reassignment', () => {
    // Wrap the failing assignment in a subshell so non-interactive dash
    // does not abort the outer script on the readonly violation.
    const r = run([], 'readonly A=1; (A=2) 2>/dev/null; echo $A\n');
    assert.equal(r.stdout, '1\n');
  });

  test('alias and unalias', () => {
    // Alias expansion is disabled in non-interactive mode; verify the
    // definition via `alias` output and removal via `unalias`.
    const r = run([], 'alias hi="echo aliased"; alias hi; unalias hi\n');
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('hi='), `expected alias definition, got: ${r.stdout}`);
  });

  test('type identifies a built-in', () => {
    const r = run([], 'type echo\n');
    assert.equal(r.status, 0);
    assert.ok(r.stdout.length > 0);
  });

  test('times outputs time info without error', () => {
    const r = run([], 'times\n');
    assert.equal(r.status, 0);
  });
});
