#!/usr/bin/env node
'use strict';

// Writes manifest.json for the Neon Arcade scene. Run from the repo root:
//   node packs/arcade/build.js [--prune]
// Every model is placed by its real size (read from the .glb) times S, so the
// layout below is in scene units (1 = one floor tile; a person is 0.92 tall).

const fs = require('fs');
const path = require('path');
const { bounds } = require('../lib/glb');

const DIR = __dirname;
const S = 2.15; // kit unit -> scene units: a cabinet stands about 1.55 tall
const size = bounds(path.join(DIR, 'models'));

const props = [];
const solid = [];
const used = new Set();

// A kit model centred on (cx, cy), scaled by s, turned by rot degrees.
function m(name, cx, cy, { s = S, rot = 0, y0, block } = {}) {
  const b = size[name];
  if (!b) throw new Error(`no model ${name}`);
  used.add(name);
  const turned = Math.abs(rot % 180) === 90;
  const w = (turned ? b.z : b.x) * s, d = (turned ? b.x : b.z) * s;
  const p = { m: name, x: +(cx - w / 2).toFixed(3), y: +(cy - d / 2).toFixed(3), w: +w.toFixed(3), d: +d.toFixed(3), h: +(b.y * s).toFixed(3) };
  if (rot) p.rot = rot;
  if (y0 != null) p.y0 = y0;
  props.push(p);
  if (block != null) solid.push([+(cx - w / 2 + block).toFixed(2), +(cy - d / 2 + block).toFixed(2), +(w - 2 * block).toFixed(2), +(d - 2 * block).toFixed(2)]);
  return { w, d };
}
const f = (name, x, y, w, d, extra = {}) => props.push({ f: name, x, y, w, d, ...extra });
const glow = (x, y, w, d, color, extra = {}) => props.push({ special: 'glow', x, y, w, d, h: 0.02, y0: 0.003, color, ...extra });
const lamp = (x, y, z, color, intensity = 1.2, range = 5) => props.push({ special: 'lamp', x, y, z, color, intensity, range });

const W = 16, D = 12;
const PINK = '#ff4fa3', CYAN = '#3ee6ff', PURPLE = '#9b6bff', YELLOW = '#ffd23f';

// --- room ----------------------------------------------------------------------
props.push({ special: 'floor', x: -25, y: -25, w: 70, d: 65, pattern: 'checker', color: '#0d0b16', color2: '#0b0913', tile: 4, y0: -0.01 });
props.push({ special: 'floor', x: 0, y: 0, w: W, d: D, pattern: 'checker', color: '#262038', color2: '#1d182c', tile: 1 });
props.push({ special: 'floor', x: 3, y: 3.6, w: 8.6, d: 4.8, pattern: 'checker', color: '#2e1f45', color2: '#271a3b', tile: 0.8, y0: 0.004 });
props.push({ special: 'wall', axis: 'x', x: 0, y: 0, len: W, h: 3, color: '#2a2142' });
props.push({ special: 'wall', axis: 'z', x: 0, y: 0, len: D, h: 3, color: '#241c3a', holes: [[9.4, 1.6, 0, 2.3]], door: '#3a2c5c' });
// neon trim along the top of both walls, and lines on the floor
glow(0, 0.02, W, 0.06, PINK, { y0: 2.85, h: 0.06, intensity: 1.6 });
glow(0.02, 0, 0.06, D, CYAN, { y0: 2.85, h: 0.06, intensity: 1.6 });
glow(0, 0.02, W, 0.05, PURPLE, { y0: 0.05, h: 0.05, intensity: 1.2 });
glow(3, 3.55, 8.6, 0.05, CYAN, { pulse: true, intensity: 1.4 });
glow(3, 8.4, 8.6, 0.05, PINK, { pulse: true, intensity: 1.4 });
props.push({ special: 'sign', x: 3.6, y: 0, z: 2.35, w: 4.2, h: 0.65, bg: '#140f22', fg: PINK, border: CYAN, glow: true, text: 'NEON ARCADE' });
props.push({ special: 'sign', x: 0, y: 7.6, z: 2.2, w: 1.6, h: 0.5, face: '+x', bg: '#140f22', fg: CYAN, glow: true, text: 'OPEN 24H' });

// --- working agents: a row of cabinets and two pinball tables on the back wall
const stations = [];
for (let i = 0; i < 8; i++) {
  const x = 1.05 + i * 1.05;
  const { d } = m('arcade-machine', x, 0.08 + size['arcade-machine'].z * S / 2, { block: 0.04 });
  stations.push({ x, y: d + 0.62, yaw: 180, anim: i % 2 ? 'interact-left' : 'interact-right' });
}
for (const x of [9.9, 11.15]) {
  const { d } = m('pinball', x, 0.08 + size.pinball.z * S / 2, { block: 0.04 });
  stations.push({ x, y: d + 0.55, yaw: 180, anim: x < 10 ? 'interact-right' : 'interact-left' });
}
lamp(3, 1.8, 2.5, PINK, 1.3, 5);
lamp(7.5, 1.8, 2.5, CYAN, 1.3, 5);
lamp(10.5, 1.8, 2.5, PURPLE, 1.2, 4);

// --- idle spots -----------------------------------------------------------------
const pois = [];
// prize counter in the back corner
m('prizes', 14.3, 0.5, { block: 0.05 });
m('cash-register', 14.3, 2.15, { block: 0.05 });
pois.push({ x: 13.7, y: 3.35, act: 'prizes', yaw: 180, anim: 'idle' }, { x: 14.9, y: 3.35, act: 'prizes', yaw: 180, anim: 'emote-yes' });
lamp(14.3, 2.6, 2.4, YELLOW, 1.1, 4);
// air hockey in the middle, one player at each end
m('air-hockey', 5.4, 6, { block: 0.05 });
pois.push({ x: 5.4 - size['air-hockey'].x * S / 2 - 0.4, y: 6, act: 'hockey', yaw: 90, anim: 'interact-right' },
  { x: 5.4 + size['air-hockey'].x * S / 2 + 0.4, y: 6, act: 'hockey', yaw: -90, anim: 'interact-left' });
lamp(5.4, 6, 2.4, CYAN, 1.1, 4);
// dance machine: whoever is idle dances on its pad
const dance = m('dance-machine', 9.6, 5.6);
solid.push([+(9.6 - dance.w / 2).toFixed(2), +(5.6 - dance.d / 2).toFixed(2), +dance.w.toFixed(2), +(dance.d * 0.45).toFixed(2)]); // the screen, not the pad
pois.push({ x: 9.6, y: +(5.6 + dance.d / 4).toFixed(2), act: 'dance', yaw: 180, anim: 'emote-yes' });
lamp(9.6, 6.2, 2.4, PINK, 1.3, 4);
// claw machines and a basketball game along the left wall
for (const y of [4.3, 5.9]) {
  m('claw-machine', 0.12 + size['claw-machine'].z * S / 2, y, { rot: 90, block: 0.04 });
  pois.push({ x: 0.12 + size['claw-machine'].z * S + 0.5, y, act: 'claw', yaw: -90, anim: 'interact-right' });
}
m('basketball-game', 0.12 + size['basketball-game'].z * S / 2, 8.1, { rot: 90, block: 0.04 });
pois.push({ x: 0.12 + size['basketball-game'].z * S + 0.5, y: 8.1, act: 'hoops', yaw: -90, anim: 'pick-up' });
// along the open right side: tickets, slots, a prize wheel and a drink machine
const RIGHT = W - 0.15;
const side = (name, y, act, anim, extra = {}) => {
  const depth = size[name].z * S;
  m(name, RIGHT - depth / 2, y, { rot: -90, block: 0.04 });
  pois.push({ x: RIGHT - depth - 0.5, y, act, yaw: 90, anim, ...extra });
};
side('ticket-machine', 4.7, 'tickets', 'interact-left');
side('gambling-machine', 5.9, 'slots', 'interact-right');
side('gambling-machine', 7.05, 'slots', 'interact-left');
side('prize-wheel', 8.4, 'wheel', 'interact-right');
side('vending-machine', 9.8, 'vending', 'interact-left', { prop: 'cup' });
lamp(14.8, 7, 2.4, PURPLE, 1.1, 5);
// a lounge by the entrance
f('loungeSofa', 5.2, 10.85, 3, 0.95, { h: 0.82, stretch: true, rot: 180 });
f('tableCoffee', 5.9, 9.35, 1.6, 0.65, { h: 0.36 });
solid.push([5.2, 10.85, 3, 0.95], [5.9, 9.35, 1.6, 0.65]);
pois.push({ x: 5.85, y: 11.05, act: 'sofa', yaw: 180, sit: true, prop: 'cup' },
  { x: 6.7, y: 11.05, act: 'sofa', yaw: 180, sit: true },
  { x: 7.55, y: 11.05, act: 'sofa', yaw: 180, sit: true, sleepy: true });
lamp(6.7, 10.6, 2.4, YELLOW, 0.9, 4);
f('pottedPlant', 9.1, 11.1, 0.6, 0.6, { h: 1 });
f('pottedPlant', 3.9, 11.1, 0.6, 0.6, { h: 1 });
solid.push([9.1, 11.1, 0.6, 0.6], [3.9, 11.1, 0.6, 0.6]);
pois.push({ x: 11.6, y: 10.6, act: 'chat', yaw: 40, anim: 'emote-yes' }, { x: 12.5, y: 11.2, act: 'chat', yaw: -140, anim: 'emote-yes', prop: 'cup' });

const manifest = {
  id: 'arcade',
  version: 1,
  name: { en: 'Neon Arcade', 'zh-TW': '電玩遊樂場', 'zh-CN': '电玩游乐场', ja: 'ネオンゲームセンター', ko: '네온 오락실', es: 'Salón recreativo neón', fr: "Salle d'arcade néon", de: 'Neon-Spielhalle', pt: 'Fliperama neon' },
  credits: 'Models: Kenney Mini Arcade, Furniture Kit (CC0)',
  W, D, viewH: 2.8,
  background: '#0d0b16', sky: '#0d0b16',
  spawn: { x: 0.5, y: 10.2 },
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
console.log(`arcade: ${props.length} props, ${stations.length} stations, ${pois.length} spots, ${used.size} models`);
