import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { run } from './helpers.mjs';

const POWER_PROBE = path.resolve('build/power_probe_darwin');
const POWER_PROBE_DIR = path.dirname(POWER_PROBE);

test('macOS sandbox allows RootDomain power registration without warning spam', {
  skip: process.platform !== 'darwin' ? 'macOS-specific regression' : false,
}, () => {
  const r = run([
    '--sandbox',
    '--bind', `ro:${POWER_PROBE_DIR}`,
    '-c',
    `${POWER_PROBE}`,
  ]);

  assert.equal(r.signal, null, `power probe killed by signal ${r.signal}\nstderr: ${r.stderr}`);
  assert.equal(r.status, 0,
    `power probe failed under sandbox\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout, 'power-probe-ok\n');
  assert.ok(!r.stderr.includes('IORegisterForSystemPower failed'),
    `unexpected power-registration warning under sandbox\nstderr: ${r.stderr}`);
});
