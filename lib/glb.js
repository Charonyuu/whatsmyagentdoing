'use strict';

// Size of every .glb in a folder, from its accessor bounds and node
// transforms: { name: { x, y, z } } in the model's own units. Lets a scene's
// build.js place models by their real footprint instead of guessed numbers.

const fs = require('fs');
const path = require('path');

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
  return o;
}

function local(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}

function measure(file) {
  const b = fs.readFileSync(file);
  const j = JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString());
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const visit = (i, parent) => {
    const n = j.nodes[i], w = mul(parent, local(n));
    if (n.mesh != null) {
      for (const p of j.meshes[n.mesh].primitives) {
        const a = j.accessors[p.attributes.POSITION];
        for (let c = 0; c < 8; c++) {
          const v = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]];
          for (let r = 0; r < 3; r++) {
            const t = w[r] * v[0] + w[4 + r] * v[1] + w[8 + r] * v[2] + w[12 + r];
            lo[r] = Math.min(lo[r], t); hi[r] = Math.max(hi[r], t);
          }
        }
      }
    }
    for (const c of n.children || []) visit(c, w);
  };
  for (const r of j.scenes[j.scene || 0].nodes) visit(r, I);
  return { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] };
}

function bounds(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.glb')) out[f.slice(0, -4)] = measure(path.join(dir, f));
  return out;
}

module.exports = { bounds };
