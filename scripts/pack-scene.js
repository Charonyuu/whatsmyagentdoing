#!/usr/bin/env node
'use strict';

// Build a scene pack for release and record it in scenes.json.
//   node scripts/pack-scene.js packs/pirate
// Writes dist/<id>-v<version>.tar.gz; upload it to the "scenes" GitHub release.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const REPO = 'Charonyuu/whatsmyagentdoing';
const src = path.resolve(process.argv[2] || '');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const id = manifest.id;
if (!/^[a-z0-9-]+$/.test(id)) throw new Error('manifest id must be lowercase letters, digits and dashes');

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  }).filter((f) => /\.(json|glb|png|txt)$/i.test(f)).sort();
}

function header(name, size) {
  const h = Buffer.alloc(512);
  const put = (s, off, len) => h.write(s, off, len, 'utf8');
  if (Buffer.byteLength(name) > 100) throw new Error(`path too long for tar: ${name}`);
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  put('00000000000\0', 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

const parts = [];
for (const f of walk(src)) {
  const body = fs.readFileSync(path.join(src, f));
  parts.push(header(f, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
}
parts.push(Buffer.alloc(1024));
const gz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
const file = `${id}-v${manifest.version}.tar.gz`;
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(path.join('dist', file), gz);

const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
const catalogPath = path.join(__dirname, '..', 'scenes.json');
let cat = { scenes: [] };
try { cat = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); } catch {}
const entry = {
  id, version: manifest.version, name: manifest.name, credits: manifest.credits,
  icon: manifest.icon || (cat.scenes.find((s) => s.id === id) || {}).icon,
  size: gz.length, sha256, url: `https://github.com/${REPO}/releases/download/scenes/${file}`,
};
cat.scenes = [...cat.scenes.filter((s) => s.id !== id), entry].sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(catalogPath, JSON.stringify(cat, null, 2) + '\n');
console.log(`dist/${file}  ${(gz.length / 1024).toFixed(0)} KB  sha256 ${sha256}`);
