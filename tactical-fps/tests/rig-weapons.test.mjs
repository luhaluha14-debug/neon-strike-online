// The rigged weapon files are what tools/rig-weapons.mjs makes from the
// source GLBs (Node): rebuilt into a temporary folder they are byte for byte
// the files the game ships, and the sources are left as they are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './harness.mjs';

const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

test('rig-weapons rebuilds the shipped rigs byte for byte and leaves the sources alone', () => {
  const weapons = join(ROOT, 'public/weapons');
  const sources = ['pis01', 'sg01', 'smg01'].map((id) => join(weapons, `${id}.glb`));
  const before = sources.map(hash);
  const out = mkdtempSync(join(tmpdir(), 'rig-'));
  try {
    const log = execFileSync(process.execPath, [join(ROOT, 'tools/rig-weapons.mjs'), '--out', out], { encoding: 'utf8' });
    for (const id of ['pis01', 'sg01', 'smg01']) {
      assert.equal(hash(join(out, `${id}_rig.glb`)), hash(join(weapons, `${id}_rig.glb`)), `${id}_rig.glb is what the tool makes`);
    }
    assert.match(log, /Slide 17, Trigger 2, Magazine 1/);
    assert.match(log, /Pump 8, PumpBolt 1, Shell \(added\)/);
    assert.match(log, /Magazine 6, ChargingHandle 2/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  assert.deepEqual(sources.map(hash), before, 'sources unchanged');
});
