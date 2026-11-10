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

test('Phase 24: the parted Blender files are copied node for node with only the missing pieces added (P220 magazine body, M249 belt, M110 tan), byte for byte; sources and uploads untouched', () => {
  const weapons = join(ROOT, 'public/weapons');
  const ids = ['pis02', 'lmg01', 'dmr01'];
  // The sources as delivered (sha-256 of the uploaded files).
  const delivered = {
    pis02: '89110fa400e4391f74fbf2c01be23cc31c936406d136d801d26314e2336618fa',
    lmg01: '2841ade57a4f55b2792d928ee898c93e96185f6a148cf5791e54dbc957a2b14d',
    dmr01: '93217f2b29c926d09e995dc300b189845a84755ed050ae8aee627047a756b4e9',
    ar02: 'c969b87e8b3dd547e31fba5d0f95188029a779d7b8daf037a9b2b73bb93dd675',
    smg02: '2ba9f4457464b2fee2757dc6940a7f2b75e846aef1a1484ba13a23fbffed487b',
  };
  for (const [id, h] of Object.entries(delivered)) assert.equal(hash(join(weapons, `${id}.glb`)), h, `${id}.glb is the delivered file`);
  const out = mkdtempSync(join(tmpdir(), 'rig-'));
  try {
    const log = execFileSync(process.execPath, [join(ROOT, 'tools/rig-weapons.mjs'), '--out', out, ...ids], { encoding: 'utf8' });
    for (const id of ids) assert.equal(hash(join(out, `${id}_rig.glb`)), hash(join(weapons, `${id}_rig.glb`)), `${id}_rig.glb is what the tool makes`);
    assert.match(log, /pis02_rig\.glb .* nodes kept: 22 {2}P_MagBody \(added, 1 pieces\)/);
    assert.match(log, /lmg01_rig\.glb .* nodes kept: 50 {2}G_Belt \(added, 12 pieces\)/);
    assert.match(log, /dmr01_rig\.glb .* nodes kept: 54 {2}FDE_Tan recoloured, FDE_Polymer recoloured/);
    // Every node of the source is in the rig, under the same name (nothing dropped or renamed).
    const nodes = (f) => {
      const b = readFileSync(f);
      return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()).nodes.map((n) => n.name);
    };
    for (const id of ids) {
      const src = nodes(join(weapons, `${id}.glb`));
      const rig = nodes(join(weapons, `${id}_rig.glb`));
      assert.deepEqual(rig.slice(0, src.length), src, `${id}: the source's nodes, in order`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  for (const [id, h] of Object.entries(delivered)) assert.equal(hash(join(weapons, `${id}.glb`)), h, `${id}.glb still the delivered file`);
});
