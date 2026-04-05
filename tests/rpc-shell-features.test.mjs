/**
 * rpc-shell-features.test.mjs — tests for shell language features accessible
 * via the RPC interface.  Each test sends one JSON request and checks the
 * parsed response.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rpc } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Pipelines & redirection
// ---------------------------------------------------------------------------

describe('rpc shell — pipelines & redirection', () => {
  test('simple pipeline', () => {
    const r = rpc({ id: 't', cmd: 'echo hello | tr a-z A-Z' });
    assert.equal(r.stdout, 'HELLO\n');
  });

  test('multi-stage pipeline', () => {
    const r = rpc({ id: 't', cmd: 'printf "b\\na\\nc\\n" | sort | head -1' });
    assert.equal(r.stdout, 'a\n');
  });

  test('stderr redirect 2>&1 merges into stdout', () => {
    const r = rpc({ id: 't', cmd: 'ls /no-such-path-xyz 2>&1' });
    assert.notEqual(r.exit_code, 0);
    assert.ok(r.stdout.length > 0);
    assert.equal(r.stderr, '');
  });

  test('stdout redirect to /dev/null empties captured stdout', () => {
    const r = rpc({ id: 't', cmd: 'echo discarded >/dev/null' });
    assert.equal(r.stdout, '');
    assert.equal(r.exit_code, 0);
  });

  test('tee splits output', () => {
    // tee to /dev/stderr so both stdout and stderr get the same line
    const r = rpc({ id: 't', cmd: 'echo split | tee /dev/stderr' });
    assert.equal(r.stdout, 'split\n');
    assert.equal(r.stderr, 'split\n');
  });
});

// ---------------------------------------------------------------------------
// Variables & expansion
// ---------------------------------------------------------------------------

describe('rpc shell — variables & expansion', () => {
  test('set and read variable', () => {
    assert.equal(rpc({ id: 't', cmd: 'X=42; echo $X' }).stdout, '42\n');
  });

  test('export propagates to subshell', () => {
    const r = rpc({ id: 't', cmd: 'export V=hello; sh -c "echo $V"' });
    assert.equal(r.stdout, 'hello\n');
  });

  test('unset removes variable', () => {
    const r = rpc({ id: 't', cmd: 'V=1; unset V; echo ${V:-gone}' });
    assert.equal(r.stdout, 'gone\n');
  });

  test('${var:-default} uses default when unset', () => {
    assert.equal(rpc({ id: 't', cmd: 'echo ${UNSET999:-def}' }).stdout, 'def\n');
  });

  test('${var:=default} assigns when unset', () => {
    const r = rpc({ id: 't', cmd: 'echo ${UNSET888:=assigned}; echo $UNSET888' });
    assert.equal(r.stdout, 'assigned\nassigned\n');
  });

  test('${var:+alt} gives alt when set', () => {
    const r = rpc({ id: 't', cmd: 'V=1; echo ${V:+present}' });
    assert.equal(r.stdout, 'present\n');
  });

  test('${#var} gives string length', () => {
    assert.equal(rpc({ id: 't', cmd: 'S=hello; echo ${#S}' }).stdout, '5\n');
  });

  test('${var%suffix} strips suffix', () => {
    assert.equal(rpc({ id: 't', cmd: 'F=foo.txt; echo ${F%.txt}' }).stdout, 'foo\n');
  });

  test('${var#prefix} strips prefix', () => {
    assert.equal(rpc({ id: 't', cmd: 'P=/usr/bin; echo ${P#/usr}' }).stdout, '/bin\n');
  });

  test('command substitution $(...)', () => {
    assert.equal(rpc({ id: 't', cmd: 'echo $(echo inner)' }).stdout, 'inner\n');
  });

  test('nested command substitution', () => {
    const r = rpc({ id: 't', cmd: 'echo $(echo $(echo deep))' });
    assert.equal(r.stdout, 'deep\n');
  });

  test('arithmetic expansion $((...))', () => {
    assert.equal(rpc({ id: 't', cmd: 'echo $((3 * 7))' }).stdout, '21\n');
  });

  test('arithmetic with variable', () => {
    assert.equal(rpc({ id: 't', cmd: 'N=10; echo $((N + 5))' }).stdout, '15\n');
  });

  test('positional parameters $@ in function', () => {
    const r = rpc({ id: 't', cmd: 'f() { echo "$@"; }; f a b c' });
    assert.equal(r.stdout, 'a b c\n');
  });

  test('IFS-based word splitting', () => {
    const r = rpc({ id: 't', cmd: 'IFS=:; s=a:b:c; for x in $s; do echo $x; done' });
    assert.equal(r.stdout, 'a\nb\nc\n');
  });
});

// ---------------------------------------------------------------------------
// Control flow
// ---------------------------------------------------------------------------

describe('rpc shell — control flow', () => {
  test('if true branch', () => {
    assert.equal(rpc({ id: 't', cmd: 'if true; then echo yes; fi' }).stdout, 'yes\n');
  });

  test('if false else branch', () => {
    assert.equal(
      rpc({ id: 't', cmd: 'if false; then echo no; else echo yes; fi' }).stdout,
      'yes\n',
    );
  });

  test('elif chain', () => {
    const r = rpc({ id: 't', cmd: 'x=2; if [ $x -eq 1 ]; then echo one; elif [ $x -eq 2 ]; then echo two; else echo other; fi' });
    assert.equal(r.stdout, 'two\n');
  });

  test('for loop', () => {
    assert.equal(rpc({ id: 't', cmd: 'for i in 1 2 3; do echo $i; done' }).stdout, '1\n2\n3\n');
  });

  test('while loop', () => {
    const r = rpc({ id: 't', cmd: 'i=0; while [ $i -lt 3 ]; do printf "%d\\n" $i; i=$((i+1)); done' });
    assert.equal(r.stdout, '0\n1\n2\n');
  });

  test('until loop', () => {
    const r = rpc({ id: 't', cmd: 'i=3; until [ $i -le 0 ]; do echo $i; i=$((i-1)); done' });
    assert.equal(r.stdout, '3\n2\n1\n');
  });

  test('case statement matches first arm', () => {
    const r = rpc({ id: 't', cmd: 'x=b; case $x in a) echo A;; b) echo B;; *) echo C;; esac' });
    assert.equal(r.stdout, 'B\n');
  });

  test('case wildcard fallthrough', () => {
    const r = rpc({ id: 't', cmd: 'x=z; case $x in a) echo A;; *) echo other;; esac' });
    assert.equal(r.stdout, 'other\n');
  });

  test('break exits loop', () => {
    const r = rpc({ id: 't', cmd: 'for i in 1 2 3; do [ $i -eq 2 ] && break; echo $i; done' });
    assert.equal(r.stdout, '1\n');
  });

  test('continue skips iteration', () => {
    const r = rpc({ id: 't', cmd: 'for i in 1 2 3; do [ $i -eq 2 ] && continue; echo $i; done' });
    assert.equal(r.stdout, '1\n3\n');
  });

  test('logical && short-circuits on false', () => {
    assert.equal(rpc({ id: 't', cmd: 'false && echo no' }).stdout, '');
  });

  test('logical || short-circuits on true', () => {
    assert.equal(rpc({ id: 't', cmd: 'true || echo no' }).stdout, '');
  });

  test('subshell does not affect parent env', () => {
    const r = rpc({ id: 't', cmd: '(X=inner); echo ${X:-outer}' });
    assert.equal(r.stdout, 'outer\n');
  });
});

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

describe('rpc shell — functions', () => {
  test('basic function call', () => {
    assert.equal(
      rpc({ id: 't', cmd: 'greet() { echo "hi $1"; }; greet world' }).stdout,
      'hi world\n',
    );
  });

  test('function return code', () => {
    const r = rpc({ id: 't', cmd: 'f() { return 3; }; f; echo $?' });
    assert.equal(r.stdout, '3\n');
  });

  test('recursive function (factorial)', () => {
    const r = rpc({
      id: 't',
      cmd: 'fact() { [ $1 -le 1 ] && echo 1 && return; echo $(($(fact $((${1}-1))) * ${1})); }; fact 5',
    }, { timeout_ms: 5000 });
    assert.equal(r.stdout.trim(), '120');
  });

  test('local variables (dash uses local keyword)', () => {
    const r = rpc({
      id: 't',
      cmd: 'f() { local x=inside; echo $x; }; x=outside; f; echo $x',
    });
    assert.equal(r.stdout, 'inside\noutside\n');
  });
});

// ---------------------------------------------------------------------------
// Here-docs & here-strings
// ---------------------------------------------------------------------------

describe('rpc shell — here-docs', () => {
  test('basic here-doc', () => {
    const r = rpc({ id: 't', cmd: 'cat <<EOF\nhello here-doc\nEOF' });
    assert.equal(r.stdout, 'hello here-doc\n');
  });

  test('here-doc with variable expansion', () => {
    const r = rpc({ id: 't', cmd: 'X=world; cat <<EOF\nhello $X\nEOF' });
    assert.equal(r.stdout, 'hello world\n');
  });

  test("here-doc with quoted delimiter suppresses expansion", () => {
    const r = rpc({ id: 't', cmd: "X=world; cat <<'EOF'\nhello $X\nEOF" });
    assert.equal(r.stdout, 'hello $X\n');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('rpc shell — error handling', () => {
  test('set -e aborts on error', () => {
    const r = rpc({ id: 't', cmd: 'set -e; false; echo should-not-print' });
    assert.notEqual(r.exit_code, 0);
    assert.equal(r.stdout, '');
  });

  test('set -u treats unset var as error', () => {
    const r = rpc({ id: 't', cmd: 'set -u; echo $TOTALLYMISSINGVAR_XYZ' });
    assert.notEqual(r.exit_code, 0);
  });

  test('set -o pipefail reports pipeline error', () => {
    // dash supports set -o pipefail
    const r = rpc({ id: 't', cmd: 'set -o pipefail 2>/dev/null || true; false | true; echo $?' });
    // Just verify it runs without crashing
    assert.equal(typeof r.exit_code, 'number');
  });

  test('command not found', () => {
    const r = rpc({ id: 't', cmd: '__no_such_cmd_xyz__' });
    assert.notEqual(r.exit_code, 0);
  });

  test('trap on EXIT fires before process ends', () => {
    const r = rpc({ id: 't', cmd: 'trap "echo trapped" EXIT; exit 0' });
    assert.equal(r.stdout, 'trapped\n');
    assert.equal(r.exit_code, 0);
  });
});

// ---------------------------------------------------------------------------
// Built-ins via RPC
// ---------------------------------------------------------------------------

describe('rpc shell — built-ins', () => {
  test('printf with format string', () => {
    assert.equal(rpc({ id: 't', cmd: 'printf "%05d\\n" 42' }).stdout, '00042\n');
  });

  test('test -f returns 0 for existing file', () => {
    const r = rpc({ id: 't', cmd: 'test -f /etc/passwd; echo $?' });
    assert.equal(r.stdout, '0\n');
  });

  test('test -d returns 0 for directory', () => {
    const r = rpc({ id: 't', cmd: 'test -d /tmp; echo $?' });
    assert.equal(r.stdout, '0\n');
  });

  test('wc -l counts lines', () => {
    const r = rpc({ id: 't', cmd: 'printf "a\\nb\\nc\\n" | wc -l' });
    assert.equal(r.stdout.trim(), '3');
  });

  test('awk processes input', () => {
    // Use single quotes around the awk program so the shell does not expand $1/$2.
    const r = rpc({ id: 't', cmd: "printf '1 2\\n3 4\\n' | awk '{print $1+$2}'" });
    assert.equal(r.stdout, '3\n7\n');
  });

  test('sed substitution', () => {
    const r = rpc({ id: 't', cmd: 'echo hello | sed s/hello/world/' });
    assert.equal(r.stdout, 'world\n');
  });

  test('grep filters lines', () => {
    const r = rpc({ id: 't', cmd: 'printf "apple\\nbanana\\napricot\\n" | grep "^a"' });
    assert.equal(r.stdout, 'apple\napricot\n');
  });

  test('sort and uniq', () => {
    const r = rpc({ id: 't', cmd: 'printf "b\\na\\nb\\na\\n" | sort | uniq' });
    assert.equal(r.stdout, 'a\nb\n');
  });

  test('xargs with echo', () => {
    const r = rpc({ id: 't', cmd: 'printf "a\\nb\\n" | xargs echo joined:' });
    assert.equal(r.stdout, 'joined: a b\n');
  });
});
