#!/usr/bin/env node
// Brings a knife model delivered as a .glb (any units, any orientation in the file's XY plane) into GRID's
// knife conventions (the M9 file's, see knifeModels.ts): blade along +Y, edge toward -X, grip below the guard
// with the guard at the origin, metres. The mesh data is not touched: every top-level node is put under one
// new root node (named after the knife, which the view uses to pick its handling) that carries the turn,
// scale and shift.
//
//   node tools/import-knife.mjs <in.glb> <out.glb> <RootName> <turnZDeg> <scale> <originX> <originY>
//
// turnZDeg turns the file about its Z axis so the handle lines up with -Y; (originX, originY) is the guard in
// the turned file's units (before scaling). Phase 34: karambit.glb and butterfly.glb were made with:
//   karambit:  Karambit  -107.6  0.019   0.23 -0.4
//   butterfly: Butterfly -52     0.0192  0.06  1.6
import fs from 'node:fs';

const [inPath, outPath, rootName, turnDeg, scaleArg, ox, oy] = process.argv.slice(2);
if (!oy) {
  console.error('usage: import-knife.mjs <in.glb> <out.glb> <RootName> <turnZDeg> <scale> <originX> <originY>');
  process.exit(1);
}
const buf = fs.readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb');
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8').trim());
const rest = buf.subarray(20 + jsonLen); // the BIN chunk (header included), unchanged

const th = (Number(turnDeg) * Math.PI) / 180;
const s = Number(scaleArg);
// The guard, turned then scaled, goes to the origin.
const gx = Number(ox) * s;
const gy = Number(oy) * s;
const scene = json.scenes[json.scene ?? 0];
const root = {
  name: rootName,
  rotation: [0, 0, Math.sin(th / 2), Math.cos(th / 2)],
  scale: [s, s, s],
  translation: [-gx, -gy, 0],
  children: scene.nodes.slice(),
};
// The turn is applied in the root's own space (T·R·S), so the guard at (ox, oy) in turned units is the
// original point R⁻¹(ox, oy): T must cancel R·S of that, which is (gx, gy) in the turned frame.
json.nodes.push(root);
scene.nodes = [json.nodes.length - 1];

let text = JSON.stringify(json);
while (Buffer.byteLength(text) % 4) text += ' ';
const jsonChunk = Buffer.alloc(8 + Buffer.byteLength(text));
jsonChunk.writeUInt32LE(Buffer.byteLength(text), 0);
jsonChunk.writeUInt32LE(0x4e4f534a, 4);
jsonChunk.write(text, 8, 'utf8');
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + jsonChunk.length + rest.length, 8);
fs.writeFileSync(outPath, Buffer.concat([header, jsonChunk, rest]));
console.log(`${outPath}: ${rootName}, turn ${turnDeg}°, scale ${s}, guard (${ox}, ${oy})`);
