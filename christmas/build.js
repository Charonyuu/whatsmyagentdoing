#!/usr/bin/env node
'use strict';

// Writes manifest.json for the Christmas Cabin scene. Run from the repo root:
//   node packs/christmas/build.js [--prune]
// Every model is placed by its real size (read from the .glb) times S, so the
// layout below is in scene units (1 = one floor tile; a person is 0.92 tall).

const fs = require('fs');
const path = require('path');
const { bounds } = require('../lib/glb');

const DIR = __dirname;
const S = 2.2; // kit unit -> scene units: a 1-unit cabin wall stands 2.2 tall
const size = bounds(path.join(DIR, 'models'));

const props = [];
const solid = [];
const used = new Set();

// A kit model centred on (cx, cy), scaled by s, turned by rot degrees.
function m(name, cx, cy, { s = S, rot = 0, y0, abs, block, stretch, h } = {}) {
  const b = size[name];
  if (!b) throw new Error(`no model ${name}`);
  used.add(name);
  const turned = Math.abs(rot % 180) === 90;
  const w = (turned ? b.z : b.x) * s, d = (turned ? b.x : b.z) * s;
  const p = { m: name, x: +(cx - w / 2).toFixed(3), y: +(cy - d / 2).toFixed(3), w: +w.toFixed(3), d: +d.toFixed(3), h: +(h || b.y * s).toFixed(3) };
  if (rot) p.rot = rot;
  if (y0 != null) p.y0 = y0;
  if (abs) p.abs = true;
  if (stretch) p.stretch = true;
  props.push(p);
  if (block) solid.push([+(cx - w / 2 + block).toFixed(2), +(cy - d / 2 + block).toFixed(2), +(w - 2 * block).toFixed(2), +(d - 2 * block).toFixed(2)]);
  return p;
}
const f = (name, x, y, w, d, extra = {}) => props.push({ f: name, x, y, w, d, ...extra });
const block = (x, y, w, d) => solid.push([x, y, w, d]);

const W = 18, D = 13;

// --- ground: a snowy clearing ----------------------------------------------
props.push({ special: 'stars', count: 600, r: 70, size: 0.26 });
props.push({ special: 'planet', x: -14, y: -24, z: 15, r: 2.6, colors: ['#f6f3e6', '#ece6cf', '#fffaf0', '#e4dcc0'] });
props.push({ special: 'floor', x: -25, y: -25, w: 70, d: 65, pattern: 'checker', color: '#dfe7ef', color2: '#dae3ec', tile: 4, y0: -0.01 });
props.push({ special: 'floor', x: 0, y: 0, w: W, d: D, pattern: 'checker', color: '#eef3f8', color2: '#e8eef5', tile: 2 });
// a trodden path from the cabin door down to the tree
props.push({ special: 'floor', x: 8.3, y: 0.2, w: 1.4, d: 4.4, pattern: 'checker', color: '#cfd8e2', color2: '#c9d3de', tile: 1.4, y0: 0.004 });

// --- the cabin: front wall along y = 0, three kit units wide ---------------
const CX = 9, U = S;            // centre x, one wall unit
const left = CX - 1.5 * U, right = CX + 1.5 * U, back = -2 * U;
const front = ['cabin-window-a', 'cabin-doorway', 'cabin-window-b'];
front.forEach((n, i) => m(n, left + U * (i + 0.5), -0.33));
['cabin-wall-wreath', 'cabin-wall', 'cabin-wall-wreath'].forEach((n, i) => m(n, left + U * (i + 0.5), back + 0.33, { rot: 180 }));
for (let k = 0; k < 2; k++) {
  m(k ? 'cabin-window-c' : 'cabin-wall', left + 0.33, -U * (k + 0.5), { rot: 90 });
  m(k ? 'cabin-wall' : 'cabin-window-c', right - 0.33, -U * (k + 0.5), { rot: -90 });
}
for (const [x, y] of [[left, 0], [right, 0], [left, back], [right, back]]) m('cabin-corner-logs', x, y - 0.0);
// gable ends: one triangle stretched over the full depth on each side
for (const x of [left, right - 0.3]) {
  props.push({ m: 'cabin-wall-roof-center', x, y: back, w: 0.3, d: -back, h: U * 0.95, y0: U, abs: true, stretch: true, rot: 90 });
  used.add('cabin-wall-roof-center');
}
// roof: a snowy slope per unit on each side. The kit's slope falls along +x,
// so it's turned to fall toward the front (and the back); its run is one unit
// to the ridge plus the overhang at the eaves.
const RUN = size['cabin-roof-snow'].x * S, OVER = RUN - U, EAVE = U * 0.82;
for (let i = 0; i < 3; i++) {
  const x = left + U * (i + 0.5);
  m('cabin-roof-snow', x, OVER - RUN / 2, { y0: EAVE, abs: true, rot: -90 });
  m(i === 2 ? 'cabin-roof-snow-chimney' : 'cabin-roof-snow', x, back - OVER + RUN / 2, { y0: EAVE, abs: true, rot: 90 });
}
block(left - 0.2, back - 0.2, right - left + 0.4, -back + 0.2);
// fairy lights along the eaves and lanterns by the door
for (let i = 0; i < 6; i++) m(i % 2 ? 'lights-colored' : 'lights-red', left + 0.1 + (i + 0.5) * (U * 3 - 0.2) / 6, 0.12, { s: (U * 3 - 0.2) / 6 / size['lights-red'].x, y0: U - 0.35, abs: true });
for (const x of [CX - 1.35, CX + 1.35]) {
  m('lantern', x, 0.55, { s: 1.15, block: 0.12 });
  props.push({ special: 'lamp', x, y: 0.75, z: 1.7, color: '#ffc46b', intensity: 1.1, range: 4 });
}
props.push({ special: 'sign', x: CX - 1.6, y: 0, z: 2.55, w: 3.2, h: 0.5, bg: '#7a2b2b', fg: '#fff3dc', border: '#e9c46a', glow: true, text: 'NORTH POLE WORKSHOP' });
props.push({ special: 'lamp', x: CX, y: -2, z: 1.6, color: '#ffb35a', intensity: 1.4, range: 6 });

// --- the big tree, presents and a little train -----------------------------
m('tree-decorated-snow', 9, 6.6, { s: 2.1, block: 0.55 });
props.push({ special: 'lamp', x: 9, y: 7.6, z: 2.2, color: '#ffd9a0', intensity: 1.6, range: 6 });
[['present-a-cube', 7.85, 7.55, 0], ['present-b-rectangle', 10.15, 7.6, 20], ['present-a-round', 8.4, 8.0, 0],
  ['present-b-cube', 9.75, 8.05, -15], ['present-a-rectangle', 10.5, 6.2, 70], ['present-b-round', 7.5, 6.3, 0]]
  .forEach(([n, x, y, rot]) => m(n, x, y, { s: 1.15, rot }));
block(7.2, 5.6, 3.6, 2.8);
m('train-locomotive', 12.2, 8.9, { s: 1.6, rot: 90 });
m('train-wagon-logs', 12.2, 10.15, { s: 1.6, rot: 90 });
m('train-wagon', 12.2, 11.45, { s: 1.6, rot: 90 });
block(11.9, 8.3, 0.6, 3.8);

// --- working agents: two gingerbread tables and a wrapping bench ------------
const stations = [];
for (const ty of [6.2, 9.4]) {
  props.push({ m: 'cabin-wall-low', x: 0.9, y: ty, w: 3.9, d: 0.8, h: 0.75, stretch: true }); used.add('cabin-wall-low');
  block(0.9, ty, 3.9, 0.8);
  [1.55, 2.85, 4.15].forEach((x, i) => {
    m(['gingerbread-man', 'gingerbread-woman', 'candy-cane-red'][i], x, ty + 0.35, { s: 0.9, y0: 0.75, rot: 180 });
    f('chairCushion', x - 0.25, ty + 0.95, 0.5, 0.5, { h: 0.85, rot: 180 });
    stations.push({ x, y: ty + 1.2, yaw: 180, pose: 'sit' });
  });
}
props.push({ m: 'cabin-wall-low', x: 13.2, y: 5.2, w: 4, d: 0.8, h: 0.8, stretch: true });
block(13.2, 5.2, 4, 0.8);
[['present-a-cube', 13.75], ['present-b-round', 14.75], ['present-a-rectangle', 15.75], ['present-b-cube', 16.7]]
  .forEach(([n, x]) => m(n, x, 5.6, { s: 0.7, y0: 0.8 }));
['interact-right', 'pick-up', 'interact-left', 'pick-up'].forEach((anim, i) => stations.push({ x: 13.75 + i, y: 6.4, yaw: 180, anim }));
props.push({ special: 'lamp', x: 15.2, y: 5.8, z: 1.9, color: '#ffe0a8', intensity: 1, range: 4 });
props.push({ special: 'lamp', x: 2.85, y: 7.8, z: 2, color: '#ffe0a8', intensity: 1.1, range: 5 });

// --- idle spots ---------------------------------------------------------------
props.push({ special: 'fire', x: 3.2, y: 2.6 });
block(2.7, 2.1, 1, 1);
const pois = [
  { x: 2.1, y: 2.6, act: 'fire', yaw: 90, sit: true },
  { x: 4.3, y: 2.6, act: 'fire', yaw: -90, sit: true, prop: 'cup' },
  { x: 3.2, y: 3.7, act: 'fire', yaw: 180, sit: true },
  { x: 3.2, y: 1.5, act: 'fire', yaw: 0, sit: true, sleepy: true },
];
m('snowman-hat', 15.4, 2.4, { s: 1.2, block: 0.15 });
pois.push({ x: 15.4, y: 3.35, act: 'snowman', yaw: 180, anim: 'interact-right' });
m('reindeer', 16.6, 10.2, { s: 1.4, rot: -90, block: 0.1 });
pois.push({ x: 15.6, y: 10.2, act: 'reindeer', yaw: 90, anim: 'interact-right' });
m('sled', 1.4, 12, { s: 1.3, rot: 90 });
pois.push({ x: 1.4, y: 12, act: 'sled', yaw: 90, sit: 0.35, sleepy: true });
m('bench', 6, 12.2, { s: 1.3, block: 0.05 });
pois.push({ x: 5.65, y: 12.05, act: 'bench', yaw: 0, sit: true, prop: 'cup' }, { x: 6.35, y: 12.05, act: 'bench', yaw: 0, sit: true, sleepy: true });
pois.push({ x: 8.3, y: 9.3, act: 'tree', yaw: 0, anim: 'idle' }, { x: 9.8, y: 9.4, act: 'tree', yaw: 0, anim: 'emote-yes' });
pois.push({ x: 14.4, y: 12.1, act: 'chat', yaw: 40, anim: 'emote-yes', prop: 'cup' }, { x: 15.4, y: 12.6, act: 'chat', yaw: -140, anim: 'emote-yes' });
m('nutcracker', 7.2, 0.6, { s: 1.0, block: 0.1 });
m('nutcracker', 10.8, 0.6, { s: 1.0, block: 0.1 });

// --- the edge of the forest ----------------------------------------------------
const trees = [['tree-snow-a', -1.5, 2], ['tree-snow-b', -2, 6.5], ['tree-snow-c', -1.4, 11], ['tree-snow-b', 19.6, 1.5],
  ['tree-snow-a', 20, 6], ['tree-snow-c', 19.4, 11.5], ['tree-snow-a', 3, 15], ['tree-snow-b', 9, 15.5], ['tree-snow-c', 15, 15],
  ['tree-snow-a', 2.5, -3], ['tree-snow-c', 15.5, -3.2], ['tree', 0, -4.5], ['tree', 18, -4.5]];
trees.forEach(([n, x, y], i) => m(n, x, y, { s: 1.9 + (i % 3) * 0.25 }));
m('rocks-large', -3.5, 14, { s: 1.1 });
m('rocks-medium', 21, 14.2, { s: 1.1 });
m('snow-pile', 17, 0.8, { s: 1.4 });
m('snow-pile', 0.9, 4.9, { s: 1.2 });
m('snow-flat-large', 5.5, -1.6, { s: 1.0 });
for (const [x, y] of [[0.4, 0.4], [17.6, 12.6], [17.6, 4.4], [0.4, 8.2]]) {
  m('lantern', x, y, { s: 1.15, block: 0.12 });
  props.push({ special: 'lamp', x, y, z: 1.8, color: '#ffc46b', intensity: 0.9, range: 3.5 });
}

const manifest = {
  id: 'christmas',
  version: 1,
  name: { en: 'Christmas Cabin', 'zh-TW': '聖誕小屋', 'zh-CN': '圣诞小屋', ja: 'クリスマスの小屋', ko: '크리스마스 오두막', es: 'Cabaña navideña', fr: 'Chalet de Noël', de: 'Weihnachtshütte', pt: 'Cabana de Natal' },
  credits: 'Models: Kenney Holiday Kit, Furniture Kit (CC0)',
  W, D, viewH: 3,
  background: '#1b2340', fixedSky: true, sky: '#1b2340', fog: ['#26304f', 24, 72],
  spawn: { x: CX, y: 0.7 },
  walk: [[0.25, 0.25, W - 0.25, D - 0.25]],
  solid, props, stations, pois,
};
fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
// --prune drops the kit models the layout doesn't use, right before packing.
if (process.argv.includes('--prune')) {
  for (const file of fs.readdirSync(path.join(DIR, 'models'))) {
    if (file.endsWith('.glb') && !used.has(file.slice(0, -4))) fs.unlinkSync(path.join(DIR, 'models', file));
  }
}
console.log(`christmas: ${props.length} props, ${stations.length} stations, ${pois.length} spots, ${used.size} models`);
