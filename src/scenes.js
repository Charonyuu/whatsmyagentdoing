'use strict';

// Scene packs ("DLC"): extra 3D scenes that aren't part of the clone.
// scenes.json (in the repo) lists what exists; a pack is downloaded only when
// someone picks it, checked against the sha256 pinned in scenes.json, and
// unpacked into ~/.whatsmyagentdoing/scenes/<id>/. Packs are data only
// (manifest.json, .glb, .png), so installing one never runs code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const USER_DIR = path.join(os.homedir(), '.whatsmyagentdoing', 'scenes');
const BUNDLED_DIR = path.join(__dirname, '..', 'scenes');
const SCENE_DIRS = [USER_DIR, BUNDLED_DIR];
const CATALOG = path.join(__dirname, '..', 'scenes.json');
const ALLOWED_EXT = new Set(['.json', '.glb', '.png', '.txt']);
const MAX_BYTES = 30 * 1024 * 1024;

function catalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG, 'utf8')).scenes || []; } catch { return []; }
}

function installed() {
  const out = [];
  const seen = new Set();
  for (const dir of SCENE_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name) || !/^[a-z0-9-]+$/.test(e.name)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'manifest.json'), 'utf8'));
        seen.add(e.name);
        out.push({ id: e.name, name: m.name, version: m.version, credits: m.credits, icon: m.icon, dir: path.join(dir, e.name) });
      } catch {}
    }
  }
  return out;
}

function sceneDir(id) {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  for (const dir of SCENE_DIRS) {
    if (fs.existsSync(path.join(dir, id, 'manifest.json'))) return path.join(dir, id);
  }
  return null;
}

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (process.env.WMAD_SCENES_LOCAL) {
      // for testing the installer against a local file
      try { return resolve(fs.readFileSync(path.join(process.env.WMAD_SCENES_LOCAL, path.basename(url)))); } catch (e) { return reject(e); }
    }
    if (!url.startsWith('https://')) return reject(new Error('scene packs are only fetched over https'));
    https.get(url, { headers: { 'user-agent': 'whatsmyagentdoing' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download failed: HTTP ${res.statusCode}`)); }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX_BYTES) res.destroy(new Error('scene pack too large')); else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Minimal ustar reader: regular files only, no links, no absolute paths.
function untar(buf, dest) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = str(156, 157) || '0';
    off += 512;
    const body = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type !== '0' && type !== '') continue; // dirs are created as needed; skip links etc.
    const rel = path.normalize(name).replace(/^(\.\/)+/, '');
    if (rel.startsWith('..') || path.isAbsolute(rel) || !ALLOWED_EXT.has(path.extname(rel).toLowerCase())) continue;
    const file = path.join(dest, rel);
    if (!file.startsWith(dest + path.sep)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

async function install(id) {
  const entry = catalog().find((s) => s.id === id);
  if (!entry) throw new Error(`unknown scene: ${id}`);
  const have = installed().find((s) => s.id === id);
  if (have && have.version >= entry.version) return have;
  const gz = await download(entry.url);
  const sum = crypto.createHash('sha256').update(gz).digest('hex');
  if (sum !== entry.sha256) throw new Error(`checksum mismatch for ${id}; not installed`);
  const tmp = path.join(USER_DIR, `.${id}-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  untar(zlib.gunzipSync(gz), tmp);
  if (!fs.existsSync(path.join(tmp, 'manifest.json'))) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('scene pack has no manifest.json');
  }
  const final = path.join(USER_DIR, id);
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(tmp, final);
  return installed().find((s) => s.id === id);
}

function remove(id) {
  if (!/^[a-z0-9-]+$/.test(id)) return false;
  const dir = path.join(USER_DIR, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { catalog, installed, sceneDir, install, remove, untar, USER_DIR };
