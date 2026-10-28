// High-quality office: same floor plan and behaviour as the 2D office
// (office.js), rendered in 3D with Kenney's CC0 models (assets/kenney).
// Bubbles and name tags are drawn by the 2D code on a canvas overlay.
// Source file: `npm run build` bundles it with three.js into public/office3d.js.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const CHARACTERS = ['male-a', 'male-b', 'male-c', 'male-d', 'male-e', 'male-f',
  'female-a', 'female-b', 'female-c', 'female-d', 'female-e', 'female-f'];
const FURNITURE = ['desk', 'chairDesk', 'computerScreen', 'computerKeyboard', 'computerMouse', 'laptop',
  'pottedPlant', 'plantSmall1', 'plantSmall2', 'plantSmall3', 'kitchenCabinet', 'kitchenCoffeeMachine',
  'kitchenSink', 'kitchenFridgeLarge', 'kitchenMicrowave', 'stoolBar', 'tableRound', 'table',
  'chairModernCushion', 'bookcaseOpen', 'books', 'loungeSofa', 'loungeChairRelax', 'tableCoffee', 'rugRectangle',
  'lampRoundFloor', 'lampSquareTable', 'televisionModern', 'cabinetTelevision', 'trashcan',
  'coatRackStanding', 'radio', 'speaker', 'toaster', 'cardboardBoxClosed'];

const STATUS_COLOR = {
  thinking: 0x8b6be6, tool: 0x3b8ee0, typing: 0x22a874, waiting: 0xe09412, error: 0xde4b40,
};
const CHAR_HEIGHT = 0.92; // world units (≈ tiles)
const WALL_H = 2.4;
const SIT_FORWARD = 0.16;

// Turn a scene manifest into the floor plan the shared simulation uses:
// stations play the part of desks, pois are where off-duty agents hang out.
function scenePlan(def) {
  const grid = new window.OfficeGrid(def.W, def.D);
  const R = grid.res;
  grid.cost.fill(1); // everything blocked (sea) …
  for (const [x0, y0, x1, y1] of def.walk || []) {
    for (let j = Math.floor(y0 * R); j < Math.ceil(y1 * R); j++) {
      for (let i = Math.floor(x0 * R); i < Math.ceil(x1 * R); i++) {
        if (i >= 0 && j >= 0 && i < grid.cw && j < grid.ch) grid.cost[j * grid.cw + i] = 0; // … except walkable ground
      }
    }
  }
  for (const [x, y, w, d] of def.solid || []) grid.block(x, y, w, d, 0.1);
  const rad = (deg) => (deg == null ? null : (deg * Math.PI) / 180);
  const desks = def.stations.map((st) => ({
    x: st.x, y: st.y, side: 'n', pose: st.pose || 'stand', yaw: rad(st.yaw), anim: st.anim, seat: { x: st.x, y: st.y },
  }));
  const pois = def.pois.map((q) => ({
    ...q, yaw: rad(q.yaw), face: 'front', sit: q.sit ? (typeof q.sit === 'number' ? q.sit : 0.3) : 0, taken: null,
  }));
  return {
    W: def.W, D: def.D, viewH: def.viewH, grid, items: [], props: [], pois, desks,
    windows: [], posters: [], pp: null, door: def.spawn, fixed: true, noNap: true, terrain: !!def.terrain, scene: def,
  };
}

function skyNow() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h >= 7 && h < 17) return { sky: 0xa9d4f2, sun: 1.7, amb: 1.15, night: false };
  if (h >= 5 && h < 7) return { sky: 0xf3c9a8, sun: 1.1, amb: 0.8, night: false };
  if (h >= 17 && h < 19) return { sky: 0xf0a679, sun: 1.0, amb: 0.75, night: false };
  return { sky: 0x1d2747, sun: 0.9, amb: 1.05, night: true };
}

// The scene pack for the instance being constructed. The base constructor
// builds the floor plan before our fields exist, so it's passed this way.
let PENDING_SCENE = null;

export class Office3D extends window.Office {
  constructor(root, opts) {
    PENDING_SCENE = (opts && opts.scene) || null;
    super(root, opts);
    this.sceneDef = PENDING_SCENE;
    this.compact = !!opts?.compact;
    this.canvas.classList.add('office-overlay');
    try {
      this.gl = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) {
      // No WebGL here; the page falls back to the 2D office.
      this.loadError = 'WebGL unavailable';
      this.markReady(false);
      return;
    }
    this.gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.15;
    this.gl.domElement.className = 'office-gl';
    root.insertBefore(this.gl.domElement, this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.25;
    this.controls.minZoom = 0.6;
    this.controls.maxZoom = 4;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;

    this.hemi = new THREE.HemisphereLight(0xfff8ee, 0x8a7a66, 1.0);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.actors = new Map();     // person key -> { obj, mixer, actions, current, head, cup }
    this.screens = new Map();    // desk -> emissive screen mesh
    this.blinkers = [];
    this.loaded = false;
    this.clock = new THREE.Clock();
    this.load().catch((e) => {
      this.loadError = String(e && e.message || e);
      console.error('3D office failed to load:', e);
      this.markReady(false);
    });
    this.resize();
  }

  destroy() {
    super.destroy();
    if (!this.gl) return;
    this.controls.dispose();
    this.gl.dispose();
    this.gl.domElement.remove();
  }

  buildPlan(n) {
    const def = PENDING_SCENE || this.sceneDef;
    return def ? scenePlan(def) : super.buildPlan(n);
  }

  // ------------------------------------------------------------ assets

  async load() {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const get = (url) => new Promise((ok, fail) => loader.load(url, ok, undefined, fail));
    const [chars, furn] = await Promise.all([
      Promise.all(CHARACTERS.map((c) => get(`/assets/kenney/characters/character-${c}.glb`))),
      Promise.all(FURNITURE.map((f) => get(`/assets/kenney/furniture/${f}.glb`).then((g) => [f, g.scene]))),
    ]);
    this.chars = chars;
    this.models = Object.fromEntries(furn);
    if (this.sceneDef) {
      const extra = [...new Set(this.sceneDef.props.filter((p) => p.f && !this.models[p.f]).map((p) => p.f))];
      const base = await Promise.all(extra.map((f) => get(`/assets/kenney/furniture/${f}.glb`).then((g) => [f, g.scene])));
      Object.assign(this.models, Object.fromEntries(base));
      for (const [, m] of base) m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      const names = [...new Set(this.sceneDef.props.filter((p) => p.m).map((p) => p.m))];
      const got = await Promise.all(names.map((m) => get(`${this.sceneDef.base}models/${m}.glb`).then((g) => [`scene:${m}`, g.scene])));
      Object.assign(this.models, Object.fromEntries(got));
      for (const [, m] of got) m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    }
    for (const m of Object.values(this.models)) {
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    }
    this.loaded = true;
  }

  // Place a furniture model so its footprint fills (x, y, w, d) on the floor
  // plan, standing on height y0. rot turns it (0 = model's own front faces +z).
  // With `stretch` the model is scaled per axis to exactly w × h × d.
  place(name, x, y, w, d, { rot = 0, y0 = 0, h = null, stretch = false, group = this.room } = {}) {
    const src = this.models[name];
    if (!src) return null;
    const m = src.clone(true);
    m.rotation.y = rot;
    m.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    if (stretch) {
      const turned = Math.abs(Math.sin(rot)) > 0.5;
      m.scale.set((turned ? d : w) / (turned ? size.z : size.x), h / size.y, (turned ? w : d) / (turned ? size.x : size.z));
    } else {
      m.scale.setScalar(h ? h / size.y : Math.min(w / size.x, d / size.z));
    }
    m.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(m);
    const c = box.getCenter(new THREE.Vector3());
    m.position.set(x + w / 2 - c.x, y0 - box.min.y, y + d / 2 - c.z);
    group.add(m);
    return m;
  }

  boxMesh(x, y, z, w, d, h, color, opts = {}) {
    const mat = opts.mat || new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.8, metalness: opts.metal ?? 0, ...(opts.emissive ? { emissive: opts.emissive, emissiveIntensity: opts.ei ?? 1 } : {}) });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x + w / 2, z + h / 2, y + d / 2);
    m.castShadow = opts.shadow !== false;
    m.receiveShadow = true;
    (opts.group || this.room).add(m);
    return m;
  }

  glassMat() {
    return this._glass || (this._glass = new THREE.MeshPhysicalMaterial({
      color: 0xcfe6f5, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0, depthWrite: false,
    }));
  }

  textPlane(text, bg, w, h) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = Math.round(256 * h / w);
    const c = cv.getContext('2d');
    c.fillStyle = bg; c.fillRect(0, 0, cv.width, cv.height);
    c.fillStyle = '#fff';
    c.font = `800 ${Math.round(cv.height * 0.22)}px ui-sans-serif, system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, cv.width / 2, cv.height / 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  }

  // ------------------------------------------------------------ build room

  build() {
    if (this.plan.scene) return this.buildScene();
    const plan = this.plan;
    if (this.room) { this.scene.remove(this.room); }
    this.room = new THREE.Group();
    this.scene.add(this.room);
    this.screens.clear();
    this.blinkers = [];
    const { W, D, OW, MR, PY } = plan;
    const dark = this.pal.dark;

    // floors
    const floor = (x, y, w, d, color, tex) => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, map: tex || null });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x + w / 2, 0, y + d / 2);
      m.receiveShadow = true;
      this.room.add(m);
    };
    const planks = this.patternTexture((c, s) => {
      c.fillStyle = dark ? '#4a3f35' : '#e3cfb0'; c.fillRect(0, 0, s, s);
      c.strokeStyle = dark ? 'rgba(0,0,0,.25)' : 'rgba(120,90,50,.18)'; c.lineWidth = 2;
      for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(0, i * s / 4); c.lineTo(s, i * s / 4); c.stroke(); }
      for (let i = 0; i < 4; i++) { const x = ((i * 37) % 4 + 0.5) * s / 4; c.beginPath(); c.moveTo(x, i * s / 4); c.lineTo(x, (i + 1) * s / 4); c.stroke(); }
    });
    const tiles = this.patternTexture((c, s) => {
      c.fillStyle = dark ? '#3d4044' : '#f4f4f1'; c.fillRect(0, 0, s, s);
      c.fillStyle = dark ? '#35383c' : '#e3e4e0'; c.fillRect(0, 0, s / 2, s / 2); c.fillRect(s / 2, s / 2, s / 2, s / 2);
    });
    planks.repeat.set(OW / 2, D / 2);
    floor(0, 0, OW, D, 0xffffff, planks);
    floor(OW, 0, W - OW, MR, dark ? 0x33404d : 0xc9d3dc);
    tiles.repeat.set((W - OW), (PY - MR));
    floor(OW, MR, W - OW, PY - MR, 0xffffff, tiles);
    const planks2 = planks.clone(); planks2.needsUpdate = true; planks2.repeat.set((W - OW) / 2, (D - PY) / 2);
    floor(OW, PY, W - OW, D - PY, 0xffffff, planks2);
    const pp = plan.pp;
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(pp.x1 - pp.x0 + 1.2, 2.7), new THREE.MeshStandardMaterial({ color: dark ? 0x2f4a3a : 0xbfd8c4, roughness: 1 }));
    mat.rotation.x = -Math.PI / 2; mat.position.set((pp.x0 + pp.x1) / 2, 0.005, pp.y - 0.05); mat.receiveShadow = true;
    this.room.add(mat);

    // walls: back (z=0) with windows, left (x=0) with a door
    const wallCol = dark ? 0x4a4640 : 0xf4efe6;
    const wallMat = new THREE.MeshStandardMaterial({ color: wallCol, roughness: 0.95 });
    const T = 0.12;
    let cx = -T;
    const sky = skyNow();
    this.windowMat = new THREE.MeshStandardMaterial({ color: sky.sky, emissive: sky.sky, emissiveIntensity: 0.6 });
    for (const wx of plan.windows) {
      this.boxMesh(cx, -T, 0, wx - cx, T, WALL_H, 0, { mat: wallMat });
      this.boxMesh(wx, -T, 0, 1.5, T, 0.85, 0, { mat: wallMat });
      this.boxMesh(wx, -T, 2.0, 1.5, T, WALL_H - 2.0, 0, { mat: wallMat });
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.15), this.windowMat);
      glass.position.set(wx + 0.75, 1.425, -T / 2);
      this.room.add(glass);
      this.boxMesh(wx + 0.73, -0.02, 0.85, 0.04, 0.04, 1.15, dark ? 0x2b2926 : 0xcfc5b3);
      this.boxMesh(wx, -0.02, 0.83, 1.5, 0.1, 0.04, dark ? 0x2b2926 : 0xcfc5b3);
      cx = wx + 1.5;
    }
    this.boxMesh(cx, -T, 0, W - cx, T, WALL_H, 0, { mat: wallMat });
    const dy = plan.door.y;
    this.boxMesh(-T, -T, 0, T, dy - 0.6 + T, WALL_H, 0, { mat: wallMat });
    this.boxMesh(-T, dy + 0.6, 0, T, D - dy - 0.6, WALL_H, 0, { mat: wallMat });
    this.boxMesh(-T, dy - 0.6, 1.8, T, 1.2, WALL_H - 1.8, 0, { mat: wallMat });
    this.boxMesh(-T + 0.02, dy - 0.55, 0, 0.06, 1.1, 1.78, dark ? 0x5c4431 : 0xa8825a);
    this.boxMesh(0, dy - 0.6, 0, 0.9, 1.2, 0.01, dark ? 0x5a3b2e : 0xb9654a, { shadow: false });
    // posters + whiteboard
    for (const ps of plan.posters) {
      const m = this.textPlane(ps.text, ps.color, 0.9, 1.0);
      m.rotation.y = Math.PI / 2; m.position.set(0.005, 1.45, ps.y + 0.45);
      this.room.add(m);
    }
    const wb = this.textPlane('', '#fdfdfb', 2.6, 1.15);
    wb.position.set(OW + 3.7, 1.4, 0.005);
    this.room.add(wb);
    this.whiteboardScribbles(OW + 3.7);
    const sign = this.textPlane('MEETING', dark ? '#3a4a5a' : '#8ea3b8', 1.3, 0.3);
    sign.position.set(OW + 1.1, 2.15, 0.005);
    this.room.add(sign);

    // desks
    for (const dk of plan.desks) this.buildDesk(dk);

    for (const p of plan.props) this.buildProp(p);
    this.fitCamera3D(true);
  }

  patternTexture(paint) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    paint(cv.getContext('2d'), 128);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  whiteboardScribbles(cx) {
    const g = new THREE.Group();
    const line = (pts, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)));
      g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })));
    };
    line([[-1.1, 0.35], [-0.6, 0.35]], 0x3b8ee0);
    line([[-1.1, 0.2], [-0.3, 0.2]], 0x3b8ee0);
    line([[0.0, 0.3], [0.4, 0.3], [0.4, 0.05], [0.0, 0.05], [0.0, 0.3]], 0xc96442);
    line([[0.4, 0.17], [0.65, 0.0]], 0xc96442);
    line([[0.65, 0.1], [1.05, 0.1], [1.05, -0.15], [0.65, -0.15], [0.65, 0.1]], 0xc96442);
    line([[-1.1, -0.35], [-0.9, -0.1], [-0.7, -0.3], [-0.5, -0.05], [-0.3, -0.25], [-0.1, 0.0]], 0x5f9a4c);
    g.position.set(cx, 1.4, 0.01);
    this.room.add(g);
  }

  buildDesk(dk) {
    const { x, y } = dk;
    this.place('desk', x, y, 1.4, 0.8, { h: 0.75, rot: dk.side === 's' ? 0 : Math.PI });
    const top = 0.75;
    const back = dk.side === 's' ? y + 0.12 : y + 0.48;
    const rot = dk.side === 's' ? 0 : Math.PI;
    const mon = this.place('computerScreen', x + 0.4, back, 0.6, 0.2, { y0: top, h: 0.5, rot });
    const kb = dk.side === 's' ? y + 0.45 : y + 0.2;
    this.place('computerKeyboard', x + 0.45, kb, 0.5, 0.15, { y0: top, rot });
    this.place('computerMouse', x + 1.0, kb, 0.08, 0.12, { y0: top, rot });
    const h = (Math.round(x * 10) * 31 + Math.round(y * 10) * 17) >>> 0;
    if (h % 3 === 0) this.place('plantSmall' + (1 + (h % 3)), x + 0.05, y + 0.3, 0.25, 0.25, { y0: top, h: 0.3 });
    if (h % 4 === 1) this.place('lampSquareTable', x + 1.1, back, 0.25, 0.25, { y0: top, h: 0.35 });
    // chair, facing the desk
    const seat = dk.seat;
    this.place('chairDesk', seat.x - 0.3, seat.y - 0.3, 0.6, 0.6, { h: 0.9, rot: dk.side === 's' ? Math.PI : 0 });
    // The monitor's own screen quad lights up in the worker's status colour.
    if (mon) {
      let quad = null;
      mon.traverse((o) => { if (o.isMesh && o.geometry.attributes.position.count === 4) quad = o; });
      if (quad) {
        quad.material = new THREE.MeshStandardMaterial({ color: 0x1b1e24, emissive: 0x000000, roughness: 0.35 });
        this.screens.set(dk, quad);
      }
    }
  }

  buildProp(p) {
    const dark = this.pal.dark;
    switch (p.t) {
      case 'panel':
        this.boxMesh(p.x, p.y, 0, p.w, p.d, p.h, new THREE.Color(p.color).getHex(), { rough: 1 });
        break;
      case 'rack': {
        this.boxMesh(p.x, p.y, 0, 0.7, 0.6, 1.9, 0x2a2d33, { metal: 0.3, rough: 0.5 });
        for (let r = 0; r < 7; r++) {
          for (let k = 0; k < 4; k++) {
            const led = this.boxMesh(p.x + 0.12 + k * 0.13, p.y + 0.6, 1.7 - r * 0.22, 0.05, 0.01, 0.03, 0x113322,
              { emissive: k % 3 === 0 ? 0xffb347 : 0x5cf08a, ei: 1, shadow: false });
            this.blinkers.push({ m: led, r, k });
          }
        }
        break;
      }
      case 'printer':
        this.boxMesh(p.x, p.y, 0, 0.75, 0.55, 0.55, dark ? 0x6e533b : 0xa8825a);
        this.boxMesh(p.x + 0.05, p.y + 0.05, 0.55, 0.65, 0.45, 0.28, 0xe8e8e8);
        this.boxMesh(p.x + 0.15, p.y + 0.35, 0.83, 0.45, 0.15, 0.02, 0xffffff);
        this.place('cardboardBoxClosed', p.x - 0.7, p.y + 0.05, 0.5, 0.5, { h: 0.35 });
        break;
      case 'plant':
        this.place('pottedPlant', p.x - 0.3, p.y - 0.3, 0.6, 0.6, { h: 1.0 });
        break;
      case 'pingpong': {
        const { x, y } = p;
        for (const [lx, ly] of [[0.1, 0.1], [2.4, 0.1], [0.1, 1.2], [2.4, 1.2]]) this.boxMesh(x + lx, y + ly, 0, 0.08, 0.08, 0.7, 0x333333);
        this.boxMesh(x, y, 0.7, 2.6, 1.4, 0.05, 0x2f7a52, { rough: 0.6 });
        this.boxMesh(x + 0.04, y + 0.69, 0.751, 2.52, 0.02, 0.002, 0xffffff, { shadow: false });
        this.boxMesh(x + 1.29, y - 0.05, 0.75, 0.02, 1.5, 0.17, 0xf4f4f4, { rough: 1 });
        this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffffff }));
        this.ball.castShadow = true;
        this.ball.visible = false;
        this.room.add(this.ball);
        break;
      }
      case 'vending': {
        this.boxMesh(p.x, p.y, 0, 0.7, 0.75, 1.85, new THREE.Color(p.color).getHex(), { rough: 0.5 });
        this.boxMesh(p.x + 0.7, p.y + 0.08, 0.7, 0.01, 0.47, 1.0, 0x0d1520, { emissive: 0x2a4a6a, ei: 0.5, shadow: false });
        const cols = [0xf2d16b, 0x5cf08a, 0xff8a65, 0x81d4fa, 0xce93d8];
        for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) {
          this.boxMesh(p.x + 0.62, p.y + 0.13 + k * 0.14, 0.82 + r * 0.22, 0.06, 0.07, 0.13, cols[(r * 3 + k) % 5], { emissive: cols[(r * 3 + k) % 5], ei: 0.25, shadow: false });
        }
        break;
      }
      case 'foosball': {
        const { x, y } = p;
        for (const [lx, ly] of [[0.1, 0.1], [1.42, 0.1], [0.1, 0.62], [1.42, 0.62]]) this.boxMesh(x + lx, y + ly, 0, 0.08, 0.08, 0.6, 0x5a4030);
        this.boxMesh(x, y, 0.6, 1.6, 0.8, 0.06, 0x6e533b);
        this.boxMesh(x + 0.05, y + 0.05, 0.66, 1.5, 0.7, 0.01, 0x2f8a4a, { shadow: false });
        this.boxMesh(x, y, 0.66, 1.6, 0.05, 0.18, 0x6e533b);
        this.boxMesh(x, y + 0.75, 0.66, 1.6, 0.05, 0.18, 0x6e533b);
        this.rods = [];
        for (let k = 0; k < 6; k++) {
          const rod = new THREE.Group();
          const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.2, 6), new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 0.7, roughness: 0.3 }));
          bar.rotation.x = Math.PI / 2;
          rod.add(bar);
          for (let m = 0; m < 2; m++) {
            const man = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.05), new THREE.MeshStandardMaterial({ color: k % 2 ? 0xc0392b : 0x2f6fb0 }));
            man.position.set(0, -0.03, -0.15 + m * 0.3);
            man.castShadow = true;
            rod.add(man);
          }
          rod.position.set(x + 0.2 + k * 0.24, 0.8, y + 0.4);
          this.room.add(rod);
          this.rods.push(rod);
        }
        break;
      }
      case 'booth': {
        const { x, y } = p;
        const felt = new THREE.MeshStandardMaterial({ color: dark ? 0x3c4a5a : 0x9fb3c8, roughness: 1 });
        this.boxMesh(x, y - 0.05, 0, 1.3, 0.05, 2.0, 0, { mat: felt });
        this.boxMesh(x - 0.05, y, 0, 0.05, 1.3, 2.0, 0, { mat: felt });
        this.boxMesh(x + 1.25, y, 0, 0.05, 1.3, 2.0, 0, { mat: this.glassMat(), shadow: false });
        this.boxMesh(x, y + 1.25, 0, 0.85, 0.05, 2.0, 0, { mat: this.glassMat(), shadow: false });
        this.boxMesh(x - 0.05, y - 0.05, 2.0, 1.4, 1.4, 0.06, dark ? 0x4a5868 : 0xb5c4d3);
        this.place('stoolBar', x + 0.45, y + 0.4, 0.4, 0.4, { h: 0.5 });
        const l = new THREE.PointLight(0xffd9a0, 0.6, 2.5);
        l.position.set(x + 0.65, 1.85, y + 0.65);
        this.room.add(l);
        break;
      }
      case 'glass':
        if (p.w === 0) this.boxMesh(p.x - 0.03, p.y, 0, 0.06, p.d, 2.1, 0, { mat: this.glassMat(), shadow: false });
        else this.boxMesh(p.x, p.y - 0.03, 0, p.w, 0.06, 2.1, 0, { mat: this.glassMat(), shadow: false });
        if (p.w === 0) this.boxMesh(p.x - 0.04, p.y, 0, 0.08, p.d, 0.12, dark ? 0x2b2926 : 0xcfc5b3);
        else this.boxMesh(p.x, p.y - 0.04, 0, p.w, 0.08, 0.12, dark ? 0x2b2926 : 0xcfc5b3);
        break;
      case 'meetingTable':
        this.place('table', p.x, p.y, p.w, p.d, { h: 0.75 });
        this.place('laptop', p.x + 1.2, p.y + 0.45, 0.45, 0.35, { y0: 0.75 });
        break;
      case 'chair':
        this.place('chairModernCushion', p.x - 0.28, p.y - 0.28, 0.56, 0.56, { h: 0.85, rot: p.face === 'front' ? 0 : Math.PI });
        break;
      case 'counter': {
        const n = Math.max(1, Math.round(p.w / 0.7));
        const u = p.w / n;
        for (let i = 0; i < n; i++) {
          const ux = p.x + i * u;
          const isSink = Math.abs(ux + u / 2 - (p.x + 3.15)) < u / 2;
          this.place(isSink ? 'kitchenSink' : 'kitchenCabinet', ux, p.y, u, p.d, { h: 0.9, stretch: true });
        }
        this.place('kitchenMicrowave', p.x + p.w - 0.75, p.y + 0.1, 0.55, 0.4, { y0: 0.9, h: 0.32 });
        this.place('toaster', p.x + 0.2, p.y + 0.2, 0.3, 0.2, { y0: 0.9, h: 0.18 });
        break;
      }
      case 'coffee':
        this.place('kitchenCoffeeMachine', p.x, p.y, 0.45, 0.4, { y0: 0.9, h: 0.5 });
        break;
      case 'fridge':
        this.place('kitchenFridgeLarge', p.x, p.y, 0.85, 0.75, { h: 1.95, stretch: true });
        break;
      case 'cooler': {
        this.boxMesh(p.x, p.y, 0, 0.42, 0.42, 0.95, 0xe8ecef, { rough: 0.4 });
        const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.42, 16),
          new THREE.MeshPhysicalMaterial({ color: 0x8ec5f2, transparent: true, opacity: 0.65, roughness: 0.1 }));
        bottle.position.set(p.x + 0.21, 0.95 + 0.21, p.y + 0.21);
        this.room.add(bottle);
        break;
      }
      case 'sink':
        break; // part of the counter
      case 'roundTable':
        this.place('tableRound', p.x - 0.45, p.y - 0.45, 0.9, 0.9, { h: 0.75 });
        break;
      case 'barStool':
        this.place('stoolBar', p.x - 0.2, p.y - 0.2, 0.4, 0.4, { h: 0.5 });
        break;
      case 'shelf': {
        const n = Math.max(1, Math.round(p.w / 0.9));
        const u = p.w / n;
        for (let i = 0; i < n; i++) {
          const b = this.place('bookcaseOpen', p.x + i * u, p.y, u, p.d, { h: 1.45, stretch: true });
          if (!b) continue;
          // book stacks on each shelf
          b.updateMatrixWorld(true);
          const ray = new THREE.Raycaster();
          for (let k = 0; k < 2; k++) {
            const bx = p.x + i * u + 0.2 + k * (u - 0.4) * 0.6;
            ray.set(new THREE.Vector3(bx + 0.1, 1.6, p.y + p.d / 2), new THREE.Vector3(0, -1, 0));
            for (const hit of ray.intersectObject(b, true)) {
              if (hit.face && hit.face.normal.y > 0.5 && hit.point.y < 1.4) {
                this.place('books', bx, p.y + 0.06, 0.25, p.d - 0.12, { y0: hit.point.y, h: 0.14 + ((i + k) % 3) * 0.03 });
              }
            }
          }
        }
        break;
      }
      case 'couch':
        this.place('loungeSofa', p.x - 0.1, p.y - 0.15, p.w + 0.2, p.d + 0.2, { h: 0.8, stretch: true });
        break;
      case 'coffeeTable':
        this.place('tableCoffee', p.x, p.y, p.w, p.d, { h: 0.35 });
        this.place('radio', p.x + 1.0, p.y + 0.2, 0.3, 0.18, { y0: 0.35, h: 0.18 });
        break;
      case 'beanbag': {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 14), new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.95 }));
        m.scale.set(1, 0.5, 1);
        m.position.set(p.x, 0.2, p.y);
        m.castShadow = m.receiveShadow = true;
        this.room.add(m);
        break;
      }
      case 'arcade': {
        const { x, y } = p;
        this.boxMesh(x, y, 0, 0.7, 0.7, 1.75, 0x3a2a6a, { rough: 0.6 });
        this.arcadeScreen = this.boxMesh(x + 0.1, y + 0.7, 1.0, 0.5, 0.01, 0.45, 0x000000, { emissive: 0xff44aa, ei: 1, shadow: false });
        this.boxMesh(x, y + 0.7, 1.55, 0.7, 0.02, 0.17, 0xffcf4a, { emissive: 0xffcf4a, ei: 0.6, shadow: false });
        this.boxMesh(x, y + 0.7, 0.8, 0.7, 0.2, 0.08, 0x4a3a8a);
        break;
      }
      case 'lamp':
        this.place('lampRoundFloor', p.x - 0.25, p.y - 0.25, 0.5, 0.5, { h: 1.7 });
        this.lampLight = new THREE.PointLight(0xffd9a0, 0, 4);
        this.lampLight.position.set(p.x, 1.6, p.y);
        this.room.add(this.lampLight);
        break;
      case 'rug':
        this.place('rugRectangle', p.x, p.y, p.w, p.d, { y0: 0.004 });
        break;
    }
  }

  // ------------------------------------------------------------ scene packs

  buildScene() {
    const def = this.plan.scene;
    if (this.room) this.scene.remove(this.room);
    this.room = new THREE.Group();
    this.scene.add(this.room);
    this.screens.clear();
    this.blinkers = [];
    this.bobbers = [];
    this.flames = [];
    this.pendants = [];
    this.pulsers = [];
    this.windowMat = null;
    this.clearMat = null;
    this.stars = null;
    this.planet = null;
    this.scene.background = def.background === null ? null : new THREE.Color(def.background || def.sky || '#9fd3ef');
    if (def.fog) this.scene.fog = new THREE.Fog(def.fog[0], def.fog[1], def.fog[2]);

    if (def.water) {
      const geo = new THREE.PlaneGeometry(160, 160, 80, 80);
      geo.rotateX(-Math.PI / 2);
      this.water = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: def.water.color, roughness: 0.35, metalness: 0.05, flatShading: true,
      }));
      this.water.position.set(def.W / 2, -0.08, def.D / 2);
      this.water.receiveShadow = true;
      this.waterBase = geo.attributes.position.array.slice();
      this.room.add(this.water);
      if (def.water.island) {
        const [cx, cz, rx, rz] = def.water.island;
        const sh = new THREE.Mesh(new THREE.CircleGeometry(1, 48),
          new THREE.MeshStandardMaterial({ color: def.water.shallow, transparent: true, opacity: 0.7, roughness: 0.5 }));
        sh.rotation.x = -Math.PI / 2;
        sh.scale.set(rx, rz, 1);
        sh.position.set(cx, -0.035, cz);
        this.room.add(sh);
      }
    }
    for (const p of def.props) this.buildSceneProp(p);
    this.fitCamera3D(true);
  }

  // Top of the ground (sand, dock…) under a point, ignoring anything taller
  // than a step. Props stand on it; y0 in the manifest is relative to it.
  surfaceAt(x, z) {
    this.room.updateMatrixWorld(true); // boxes added so far have no world matrix until a render
    return this.surfaceBelow(x, z, 0.6, 2);
  }

  buildSceneProp(p) {
    const flat = ['sandbase', 'floor', 'wall', 'sign', 'pendant', 'stars', 'planet', 'lamp'];
    const ground = (p.m && p.m.startsWith('patch-')) || flat.includes(p.special) || p.abs ? 0 : this.surfaceAt(p.x + (p.w || 0) / 2, p.y + (p.d || 0) / 2);
    if (p.special === 'fire') return this.buildFire(p.x, p.y, ground + (p.y0 || 0), p);
    if (p.special === 'target') return this.buildTarget(p, ground);
    if (p.special === 'well') return this.buildWell(p, ground);
    if (p.special === 'map') return this.buildMap({ ...p, y0: ground + (p.y0 ?? 0.78) });
    if (p.special === 'dock') return this.buildDock(p);
    if (p.special === 'floor') return this.buildFloor(p);
    if (p.special === 'stars') return this.buildStars(p);
    if (p.special === 'lamp') {
      // an unseen ceiling light
      const l = new THREE.PointLight(p.color || '#ffffff', p.intensity ?? 1, p.range || 6);
      l.position.set(p.x, p.z || 2.3, p.y);
      this.room.add(l);
      return;
    }
    if (p.special === 'planet') return this.buildPlanet(p);
    if (p.special === 'glow') {
      // an emissive strip or panel (light bars, screens, floor markings)
      const m = this.boxMesh(p.x, p.y, ground + (p.y0 || 0), p.w, p.d, p.h || 0.03, 0, {
        mat: new THREE.MeshStandardMaterial({ color: p.color || '#5ad1ff', emissive: p.color || '#5ad1ff', emissiveIntensity: p.intensity ?? 1.2 }), shadow: false,
      });
      if (p.pulse) (this.pulsers = this.pulsers || []).push({ m, base: p.intensity ?? 1.2, ph: p.x + p.y });
      return m;
    }
    if (p.special === 'wall') return this.buildWall(p);
    if (p.special === 'sign') return this.buildSign(p);
    if (p.special === 'pendant') return this.buildPendant(p);
    if (p.special === 'box') return this.boxMesh(p.x, p.y, ground + (p.y0 || 0), p.w, p.d, p.h, new THREE.Color(p.color || '#888').getHex(), { rough: p.rough ?? 0.8, metal: p.metal || 0 });
    if (p.special === 'glass') return this.boxMesh(p.x, p.y, ground + (p.y0 || 0), p.w, p.d, p.h, 0, { mat: this.glassMat(), shadow: false });
    if (p.special === 'sandbase') {
      // a flat bed of sand under the island so seams between sand patches
      // show sand (and can be stood on) instead of the sea
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.5, 40),
        new THREE.MeshStandardMaterial({ color: p.color || '#d9a46c', roughness: 1 }));
      m.scale.set(p.rx, 1, p.rz);
      m.position.set(p.x, (p.top ?? 0.27) - 0.25, p.y);
      m.receiveShadow = true;
      this.room.add(m);
      return;
    }
    const name = p.m ? `scene:${p.m}` : p.f;
    const m = this.place(name, p.x, p.y, p.w, p.d, {
      rot: ((p.rot || 0) * Math.PI) / 180, y0: ground + (p.y0 || 0), h: p.h || null, stretch: !!p.stretch,
    });
    if (m && p.bob) this.bobbers.push({ m, y: m.position.y, ph: p.x * 0.7 });
  }

  buildFire(x, y, ground = 0.25, opts = {}) {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4426, roughness: 1 });
    for (let i = 0; i < 3; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.75, 8), wood);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = (i * Math.PI) / 3;
      log.position.y = 0.32;
      log.castShadow = true;
      g.add(log);
    }
    const stone = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 1, flatShading: true });
    for (let i = 0; i < (opts.stones === false ? 0 : 9); i++) {
      const a = (i / 9) * Math.PI * 2;
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09), stone);
      r.position.set(Math.cos(a) * 0.45, 0.3, Math.sin(a) * 0.45);
      r.castShadow = true;
      g.add(r);
    }
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 7), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.9 }));
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.38, 7), new THREE.MeshBasicMaterial({ color: 0xffe066 }));
    outer.position.y = 0.6; inner.position.y = 0.55;
    const light = new THREE.PointLight(0xffa040, 1.4, 6);
    light.position.y = 0.9;
    g.add(outer, inner, light);
    g.position.set(x, ground - 0.25, y); // parts are laid out for a 0.25 sand top
    if (opts.scale) g.scale.setScalar(opts.scale);
    this.room.add(g);
    this.flames.push({ outer, inner, light });
  }

  // Floor: planks, tiles or a checkerboard over a rectangle.
  buildFloor(p) {
    const dark = this.pal.dark;
    const a = p.color || (dark ? '#4a3f35' : '#e3cfb0');
    const b = p.color2 || (dark ? '#3e342b' : '#d6bf9c');
    const tex = this.patternTexture((c, s) => {
      c.fillStyle = a; c.fillRect(0, 0, s, s);
      if (p.pattern === 'checker') {
        c.fillStyle = b; c.fillRect(0, 0, s / 2, s / 2); c.fillRect(s / 2, s / 2, s / 2, s / 2);
      } else {
        c.strokeStyle = b; c.lineWidth = 3;
        for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(0, (i * s) / 4); c.lineTo(s, (i * s) / 4); c.stroke(); }
        for (let i = 0; i < 4; i++) { const x = (((i * 37) % 4) + 0.5) * (s / 4); c.beginPath(); c.moveTo(x, (i * s) / 4); c.lineTo(x, ((i + 1) * s) / 4); c.stroke(); }
      }
    });
    tex.repeat.set(p.w / (p.tile || 2), p.d / (p.tile || 2));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(p.x + p.w / 2, p.y0 || 0.002, p.y + p.d / 2);
    m.receiveShadow = true;
    this.room.add(m);
  }

  // Wall along x (axis "x": from x to x+len at depth y) or along z (axis
  // "z": from y to y+len at x), with optional window/door openings
  // [from, length, bottom, top] measured along the wall.
  buildWall(p) {
    const h = p.h || 2.4, t = p.t || 0.12;
    const mat = new THREE.MeshStandardMaterial({ color: p.color || (this.pal.dark ? '#4a4640' : '#f1ebe0'), roughness: 0.95 });
    if (p.clear) {
      this.clearMat = this.clearMat || new THREE.MeshPhysicalMaterial({ color: '#9fd8ff', transparent: true, opacity: 0.12, roughness: 0.05, depthWrite: false });
    } else if (!this.windowMat) {
      this.windowMat = new THREE.MeshStandardMaterial({ color: this.plan.scene.sky || '#a9d4f2', emissive: this.plan.scene.sky || '#a9d4f2', emissiveIntensity: 0.6 });
    }
    const paneMat = p.clear ? this.clearMat : this.windowMat;
    const seg = (a, len, z0, z1) => {
      if (len <= 0.001 || z1 - z0 <= 0.001) return;
      if (p.axis === 'z') this.boxMesh(p.x - t, p.y + a, z0, t, len, z1 - z0, 0, { mat });
      else this.boxMesh(p.x + a, p.y - t, z0, len, t, z1 - z0, 0, { mat });
    };
    const holes = (p.holes || []).slice().sort((u, v) => u[0] - v[0]);
    let at = 0;
    for (const [from, len, bot, top] of holes) {
      seg(at, from - at, 0, h);
      seg(from, len, 0, bot);
      seg(from, len, top, h);
      if (bot > 0.05) {
        // window pane + a mullion in the middle
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(len, top - bot), paneMat);
        if (p.axis === 'z') { pane.rotation.y = Math.PI / 2; pane.position.set(p.x - t / 2, (bot + top) / 2, p.y + from + len / 2); }
        else pane.position.set(p.x + from + len / 2, (bot + top) / 2, p.y - t / 2);
        this.room.add(pane);
        const frame = new THREE.Color(p.frame || '#2b2926').getHex();
        for (let k = 1; k < Math.round(len / 1.2); k++) {
          const f = from + (len * k) / Math.round(len / 1.2);
          if (p.axis === 'z') this.boxMesh(p.x - 0.04, p.y + f - 0.03, bot, 0.04, 0.06, top - bot, frame);
          else this.boxMesh(p.x + f - 0.03, p.y - 0.04, bot, 0.06, 0.04, top - bot, frame);
        }
        if (p.axis === 'z') this.boxMesh(p.x - 0.02, p.y + from, bot - 0.05, 0.14, len, 0.05, frame);
        else this.boxMesh(p.x + from, p.y - 0.02, bot - 0.05, len, 0.14, 0.05, frame);
      } else if (p.door) {
        const door = new THREE.Color(p.door).getHex();
        if (p.axis === 'z') this.boxMesh(p.x - 0.06, p.y + from + 0.05, 0, 0.05, len - 0.1, top - 0.05, door);
        else this.boxMesh(p.x + from + 0.05, p.y - 0.06, 0, len - 0.1, 0.05, top - 0.05, door);
      }
      at = from + len;
    }
    seg(at, (p.len || 0) - at, 0, h);
  }

  // Text on a board, flat against a wall (face "+z" or "+x").
  buildSign(p) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = Math.round(512 * p.h / p.w);
    const c = cv.getContext('2d');
    c.fillStyle = p.bg || '#2b2b2b'; c.fillRect(0, 0, cv.width, cv.height);
    if (p.border) { c.strokeStyle = p.border; c.lineWidth = 14; c.strokeRect(7, 7, cv.width - 14, cv.height - 14); }
    c.fillStyle = p.fg || '#fff';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const lines = String(p.text || '').split('\n');
    const size = Math.min(cv.height / (lines.length + 0.6), (cv.width * 1.6) / Math.max(...lines.map((l) => l.length), 1));
    c.font = `700 ${Math.round(size)}px ${p.font || 'ui-rounded, "Comic Sans MS", system-ui, sans-serif'}`;
    lines.forEach((l, i) => c.fillText(l, cv.width / 2, (cv.height * (i + 0.8)) / (lines.length + 0.6)));
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, emissive: p.glow ? '#ffffff' : '#000000', emissiveMap: p.glow ? tex : null, emissiveIntensity: p.glow ? 0.9 : 0 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), mat);
    if (p.face === '+x') { m.rotation.y = Math.PI / 2; m.position.set(p.x + 0.01, p.z, p.y); }
    else m.position.set(p.x, p.z, p.y + 0.01);
    this.room.add(m);
  }

  // A field of stars on a big sphere around the scene.
  buildStars(p) {
    const n = p.count || 900, r = p.r || 70;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, k = Math.sqrt(1 - u * u);
      pos[i * 3] = this.plan.W / 2 + Math.cos(a) * k * r;
      pos[i * 3 + 1] = u * r * 0.6;
      pos[i * 3 + 2] = this.plan.D / 2 + Math.sin(a) * k * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: p.size || 0.35, sizeAttenuation: true, fog: false }));
    this.room.add(this.stars);
  }

  // A planet (with an optional ring) out beyond the windows.
  buildPlanet(p) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 128;
    const c = cv.getContext('2d');
    const cols = p.colors || ['#e08a5a', '#c76b45', '#f0b27a', '#a85a3c'];
    for (let y = 0; y < 128; y += 4) { c.fillStyle = cols[Math.floor((Math.sin(y * 0.21) + 1) * 1.99) % cols.length]; c.fillRect(0, y, 256, 4); }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const planet = new THREE.Mesh(new THREE.SphereGeometry(p.r || 6, 40, 24), new THREE.MeshStandardMaterial({ map: tex, roughness: 1, fog: false }));
    planet.position.set(p.x, p.z || 0, p.y);
    planet.rotation.z = 0.35;
    this.room.add(planet);
    if (p.ring) {
      const ring = new THREE.Mesh(new THREE.RingGeometry((p.r || 6) * 1.3, (p.r || 6) * 1.75, 64),
        new THREE.MeshBasicMaterial({ color: p.ring, transparent: true, opacity: 0.4, side: THREE.DoubleSide, fog: false }));
      ring.position.copy(planet.position);
      ring.rotation.x = -Math.PI / 2 + 0.45;
      ring.rotation.y = 0.3;
      this.room.add(ring);
    }
    this.planet = planet;
  }

  // An archery target on a wooden stand, facing `yaw` degrees.
  buildTarget(p, ground) {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a5232, roughness: 1 });
    for (const dz of [-0.28, 0.28]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.2, 0.06), wood);
      leg.position.set(-0.12, 0.6, dz); leg.rotation.z = 0.18; leg.castShadow = true; g.add(leg);
    }
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    ['#f4efe2', '#d23c2f', '#f4efe2', '#d23c2f', '#f2c14e'].forEach((col, i) => {
      c.fillStyle = col; c.beginPath(); c.arc(64, 64, 62 - i * 12, 0, Math.PI * 2); c.fill();
    });
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.38, 32), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    const back = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.08, 32), new THREE.MeshStandardMaterial({ color: 0xd8c08a, roughness: 1 }));
    back.rotation.z = Math.PI / 2; back.position.set(0, 0.95, 0); back.castShadow = true;
    face.rotation.y = Math.PI / 2; face.position.set(0.045, 0.95, 0);
    g.add(back, face);
    g.rotation.y = ((p.yaw ?? -90) * Math.PI) / 180 + Math.PI / 2;
    g.position.set(p.x, ground, p.y);
    this.room.add(g);
  }

  // A stone well with a little roof and a bucket.
  buildWell(p, ground) {
    const g = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 1, flatShading: true });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.6, 12, 1, true), stone);
    ring.material.side = THREE.DoubleSide; ring.position.y = 0.3; ring.castShadow = true;
    const water = new THREE.Mesh(new THREE.CircleGeometry(0.5, 12), new THREE.MeshStandardMaterial({ color: 0x2f6f9a, roughness: 0.2 }));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.35;
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4426, roughness: 1 });
    for (const dx of [-0.5, 0.5]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.3, 0.08), wood); post.position.set(dx, 0.95, 0); post.castShadow = true; g.add(post); }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.85, 0.45, 4), new THREE.MeshStandardMaterial({ color: 0x9c3b2e, roughness: 0.9 }));
    roof.position.y = 1.8; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
    const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.16, 10), wood);
    bucket.position.set(0, 1.05, 0);
    g.add(ring, water, roof, bucket);
    g.position.set(p.x, ground, p.y);
    this.room.add(g);
  }

  // A hanging lamp: cord, shade and a soft warm light.
  buildPendant(p) {
    const top = p.top || 2.5, drop = p.drop || 0.8;
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, drop, 4), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    cord.position.set(p.x, top - drop / 2, p.y);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.18, 16, 1, true), new THREE.MeshStandardMaterial({ color: p.color || '#2f3b36', side: THREE.DoubleSide, roughness: 0.6 }));
    shade.position.set(p.x, top - drop, p.y);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffe7b0' }));
    bulb.position.set(p.x, top - drop - 0.07, p.y);
    const light = new THREE.PointLight(0xffd9a0, 0.7, 3.5);
    light.position.set(p.x, top - drop - 0.15, p.y);
    this.room.add(cord, shade, bulb, light);
    this.pendants.push(light);
  }

  // A plank boardwalk on posts, from the shore out over the water.
  buildDock(p) {
    const top = p.top ?? 0.32;
    const planks = [0x9c6b3c, 0xa8774a, 0x8f6236];
    for (let z = p.y, i = 0; z < p.y + p.d - 0.05; z += 0.3, i++) {
      this.boxMesh(p.x, z, top - 0.07, p.w, 0.26, 0.07, planks[i % 3], { rough: 0.95 });
    }
    for (const side of [p.x - 0.02, p.x + p.w - 0.1]) this.boxMesh(side, p.y, top - 0.16, 0.12, p.d, 0.1, 0x6b4426);
    for (let z = p.y + 0.1; z < p.y + p.d; z += 1.6) {
      for (const x of [p.x + 0.02, p.x + p.w - 0.14]) this.boxMesh(x, z, -0.9, 0.12, 0.12, top + 0.95, 0x5c3a20);
    }
    // a rope post at the far end
    this.boxMesh(p.x + p.w - 0.2, p.y + 0.05, top - 0.1, 0.14, 0.14, 0.55, 0x5c3a20);
  }

  buildMap(p) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 160;
    const c = cv.getContext('2d');
    c.fillStyle = '#e9d5a6'; c.fillRect(0, 0, 256, 160);
    c.strokeStyle = '#8a6a3a'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(40, 120); c.bezierCurveTo(30, 60, 90, 20, 140, 40); c.bezierCurveTo(200, 60, 230, 110, 180, 135); c.bezierCurveTo(130, 150, 60, 150, 40, 120); c.stroke();
    c.setLineDash([6, 6]); c.strokeStyle = '#6b4426'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(70, 110); c.quadraticCurveTo(110, 60, 165, 95); c.stroke();
    c.setLineDash([]); c.strokeStyle = '#c0392b'; c.lineWidth = 5;
    c.beginPath(); c.moveTo(158, 88); c.lineTo(174, 104); c.moveTo(174, 88); c.lineTo(158, 104); c.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(p.x + p.w / 2, (p.y0 || 0.78) + 0.005, p.y + p.d / 2);
    m.receiveShadow = true;
    this.room.add(m);
  }

  animateScene(t, sky) {
    const def = this.plan.scene;
    if (this.water) {
      const pos = this.water.geometry.attributes.position;
      const a = pos.array, b = this.waterBase;
      for (let i = 0; i < a.length; i += 3) {
        a[i + 1] = Math.sin(b[i] * 0.45 + t * 1.1) * 0.06 + Math.cos(b[i + 2] * 0.38 + t * 0.8) * 0.05;
      }
      pos.needsUpdate = true;
      if ((this.waterTick = (this.waterTick || 0) + 1) % 3 === 0) this.water.geometry.computeVertexNormals();
    }
    for (const b of this.bobbers) {
      b.m.position.y = b.y + Math.sin(t * 0.9 + b.ph) * 0.05;
      b.m.rotation.x = Math.sin(t * 0.7 + b.ph) * 0.015;
    }
    for (const f of this.flames) {
      const k = 0.85 + Math.sin(t * 13) * 0.08 + Math.sin(t * 7.3) * 0.07;
      f.outer.scale.set(1, k, 1);
      f.inner.scale.set(1, 1.6 - k * 0.6, 1);
      f.light.intensity = (sky.night ? 3 : 1.2) * k;
    }
    if (this.scene.background && !def.fixedSky) this.scene.background.set(sky.night ? '#13213f' : (def.background || def.sky || '#9fd3ef'));
    if (this.planet) this.planet.rotation.y = t * 0.03;
    if (this.stars) this.stars.rotation.y = t * 0.004;
    for (const g of this.pulsers || []) g.m.material.emissiveIntensity = g.base * (0.65 + 0.35 * Math.sin(t * 2.2 + g.ph));
    if (this.windowMat) { this.windowMat.color.set(sky.night ? '#1d2747' : def.sky); this.windowMat.emissive.set(sky.night ? '#1d2747' : def.sky); }
    for (const l of this.pendants || []) l.intensity = sky.night ? 1.6 : 0.7;
    if (this.scene.fog) this.scene.fog.color.set(sky.night ? '#1b2a4a' : def.fog[0]);
  }

  // ------------------------------------------------------------ camera

  fitCamera3D(reset) {
    const { W, D } = this.plan;
    const center = new THREE.Vector3(W / 2, 0.6, D / 2);
    if (reset || !this.fitted) {
      const dist = 40;
      this.camera.position.set(center.x + dist * 0.62, center.y + dist * 0.58, center.z + dist * 0.62);
      this.controls.target.copy(center);
      this.camera.zoom = this.compact ? 1 : 1.25;
      this.fitted = true;
    }
    this.camera.lookAt(this.controls.target);
    this.camera.updateMatrixWorld(true);
    // Fit the room's corners into the view.
    const inv = this.camera.matrixWorldInverse;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [0, W]) for (const y of [0, this.plan.viewH || WALL_H]) for (const z of [0, D]) {
      const v = new THREE.Vector3(x, y, z).applyMatrix4(inv);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
    const aspect = this.cw / this.ch;
    let w = (maxX - minX) * 1.06, h = (maxY - minY) * 1.1;
    // Leave room for screen-space badges and bubbles in a small PiP window.
    if (this.compact) h *= this.ch / Math.max(80, this.ch - 48);
    if (w / h > aspect) h = w / aspect; else w = h * aspect;
    const cxv = (minX + maxX) / 2, cyv = (minY + maxY) / 2;
    Object.assign(this.camera, { left: cxv - w / 2, right: cxv + w / 2, top: cyv + h / 2, bottom: cyv - h / 2 });
    this.camera.updateProjectionMatrix();
    // Sun casts shadows over the whole room.
    this.sun.position.set(center.x - 6, 14, center.z - 3);
    this.sun.target.position.copy(center);
    const sc = this.sun.shadow.camera;
    const r = Math.max(W, D) * 0.75;
    Object.assign(sc, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 50 });
    sc.updateProjectionMatrix();
  }

  resize() {
    super.resize();
    if (!this.gl) return;
    this.gl.setSize(this.cw, this.ch, false);
    this.gl.domElement.style.width = this.cw + 'px';
    this.gl.domElement.style.height = this.ch + 'px';
    if (this.room) this.fitCamera3D(false);
  }

  // ------------------------------------------------------------ actors

  actorFor(p) {
    let a = this.actors.get(p.key);
    if (a) return a;
    const gltf = this.chars[p.h % this.chars.length];
    const obj = cloneSkinned(gltf.scene);
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const box = new THREE.Box3().setFromObject(obj);
    const s = CHAR_HEIGHT * (p.s && p.s.subagent ? 0.8 : 1) / (box.max.y - box.min.y);
    obj.scale.setScalar(s);
    const mixer = new THREE.AnimationMixer(obj);
    const actions = {};
    for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
    let head = null, armR = null;
    obj.traverse((o) => { if (o.name === 'head') head = o; if (o.name === 'arm-right') armR = o; });
    const prop = new THREE.Group();
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.1, 10), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    const book = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.28, 0.04), new THREE.MeshStandardMaterial({ color: 0xc96442 }));
    prop.add(cup, book);
    this.scene.add(obj, prop);
    a = { obj, mixer, actions, current: null, head, headRest: head ? head.rotation.x : 0, armR, prop, cup, book, yaw: 0, last: { x: p.x, y: p.y } };
    this.actors.set(p.key, a);
    return a;
  }

  play(a, name) {
    if (a.current === name) return;
    const next = a.actions[name] || a.actions.idle;
    if (!next) return;
    next.reset().setEffectiveWeight(1).fadeIn(0.25).play();
    if (a.current && a.actions[a.current]) a.actions[a.current].fadeOut(0.25);
    a.current = name;
  }

  facing(p, st) {
    if (st.pose === 'walk') return null;
    if (p.mode === 'work' && p.desk) {
      if (p.desk.yaw != null) return p.desk.yaw;
      return p.desk.side === 'n' ? 0 : Math.PI;
    }
    const q = p.poi;
    if (!q) return null;
    if (q.yaw != null) return q.yaw;
    if (q.pair) {
      const other = this.plan.pois.find((o) => o.pair === q.pair && o !== q);
      return Math.atan2(other.x - q.x, 0);
    }
    if (q.act === 'vending' || q.act === 'plant') return -Math.PI / 2;
    return st.face === 'back' ? Math.PI : 0;
  }

  syncActors(dt) {
    for (const [k, a] of this.actors) {
      if (!this.people.has(k)) { this.scene.remove(a.obj, a.prop); this.actors.delete(k); }
    }
    for (const p of this.people.values()) {
      const a = this.actorFor(p);
      const st = this.stateOf(p);
      p.pose = st.pose;
      const anim = {
        walk: 'walk', wave: 'emote-yes', coffee: 'holding-right', water: 'holding-right', read: 'holding-both',
        phone: 'holding-right', arcade: 'interact-right', whiteboard: 'interact-right', foosball: 'interact-left',
        pingpong: 'interact-right', vending: 'interact-right', fridge: 'interact-left', sink: 'interact-right',
      }[st.pose === 'walk' ? 'walk' : st.act] || (st.pose === 'sit' ? 'sit' : 'idle');
      let chosen = anim;
      if (st.act === 'station') chosen = p.s.status === 'thinking' ? 'idle' : (p.desk.anim || 'interact-right');
      else if (st.pose !== 'walk' && p.poi && p.poi.anim) chosen = p.poi.anim;
      this.play(a, chosen);
      a.mixer.update(dt);

      // position + facing
      const dx = p.x - a.last.x, dy = p.y - a.last.y;
      let want = st.pose !== 'walk' && p.poi && p.poi.float ? null : this.facing(p, st);
      if (want == null && Math.hypot(dx, dy) > 0.001) want = Math.atan2(dx, dy);
      if (want != null) {
        let d = want - a.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        a.yaw += d * Math.min(1, dt * 10);
      }
      a.last = { x: p.x, y: p.y };
      a.obj.rotation.y = a.yaw;
      const seatY = st.pose === 'sit' ? this.seatHeight(p.x, p.y, st.sitZ)
        : this.plan.terrain ? this.groundHeight(p.x, p.y) : 0;
      // The sit pose's torso leans back past its origin; slide the body
      // forward so the back rests against the backrest instead of in it.
      const fwd = st.pose === 'sit' ? SIT_FORWARD : 0;
      let lift = 0;
      if (st.pose !== 'walk' && p.poi && p.poi.float) {
        // zero gravity: drift up and down, slowly turning
        const k = this.t / 1000 + p.phase;
        lift = 0.45 + Math.sin(k * 0.9) * 0.18;
        a.yaw += dt * 0.35;
      }
      a.obj.position.set(p.x + Math.sin(a.yaw) * fwd, seatY + lift, p.y + Math.cos(a.yaw) * fwd);
      if (a.head) {
        if (st.act === 'nap') { a.head.rotation.x = a.headRest + 0.55; a.napped = true; }
        else if (a.napped) { a.head.rotation.x = a.headRest; a.napped = false; }
      }
      // hand-held props
      a.cup.visible = st.act === 'coffee' || st.act === 'water' || (st.pose !== 'walk' && p.poi && p.poi.prop === 'cup');
      a.book.visible = st.act === 'read';
      if (a.armR && (a.cup.visible || a.book.visible)) {
        a.obj.updateMatrixWorld(true);
        const hand = new THREE.Vector3(0, -0.4, 0.15);
        a.armR.localToWorld(hand);
        a.prop.position.copy(hand);
        a.prop.rotation.y = a.yaw;
        a.cup.material.color.set(st.act === 'water' ? 0x9fd3ff : 0xffffff);
      }
    }
  }

  // Highest surface below `limit` under (x, z). Sampled at the point and
  // four spots around it so a gap between dock planks or sand patches
  // doesn't read as the sea floor. World matrices must be current.
  surfaceBelow(x, z, limit, from = 1.2) {
    if (!this.room) return 0;
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    let best = 0;
    for (const [dx, dz] of [[0, 0], [0.09, 0], [-0.09, 0], [0, 0.09], [0, -0.09]]) {
      ray.set(new THREE.Vector3(x + dx, from, z + dz), down);
      for (const h of ray.intersectObject(this.room, true)) {
        if (h.point.y < limit && h.point.y > best) best = h.point.y;
      }
    }
    return best;
  }

  // Height of the walkable surface (sand, dock planks…) on terrain scenes.
  groundHeight(x, y) {
    const key = `${Math.round(x * 4)},${Math.round(y * 4)}`;
    this.ground = this.ground || new Map();
    if (this.ground.has(key)) return this.ground.get(key);
    const v = this.surfaceBelow(x, y, 0.55);
    this.ground.set(key, v);
    return v;
  }

  // Kenney's `sit` clip is a sit-on-the-floor pose (seat at the model's
  // origin), so lift the character to whatever surface is under the seat
  // point: chair cushion, stool, sofa or beanbag. Measured once per spot.
  seatHeight(x, y, fallback) {
    const key = `${x.toFixed(2)},${y.toFixed(2)}`;
    this.seats = this.seats || new Map();
    if (this.seats.has(key)) return this.seats.get(key);
    const best = this.surfaceBelow(x, y, 0.75);
    const v = best > 0.05 ? best : fallback;
    this.seats.set(key, v);
    return v;
  }

  // ------------------------------------------------------------ frame

  draw() {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.cw, this.ch);
    if (!this.loaded) {
      c.fillStyle = this.pal.text;
      c.globalAlpha = 0.7;
      c.font = '600 14px ui-sans-serif, system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText(this.loadError ? `3D failed: ${this.loadError}` : '', this.cw / 2, this.ch / 2);
      c.globalAlpha = 1;
      return false;
    }
    if (this.room !== undefined && this.builtPlan === this.plan) {
      // fine
    } else {
      this.build();
      this.builtPlan = this.plan;
      this.room.updateMatrixWorld(true);
      this.seats = new Map();
      this.ground = new Map();
      for (const a of this.actors.values()) this.scene.remove(a.obj, a.prop);
      this.actors.clear();
    }
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.t / 1000;

    // lighting follows the time of day
    const sky = skyNow();
    this.sun.intensity = sky.sun;
    this.hemi.intensity = sky.amb;
    if (this.windowMat) {
      this.windowMat.color.setHex(sky.sky);
      this.windowMat.emissive.setHex(sky.sky);
    }
    if (this.plan.scene) this.animateScene(t, sky);
    if (this.lampLight) this.lampLight.intensity = sky.night ? 2.2 : 0;

    // screens show who is working and on what
    const occupant = new Map();
    for (const p of this.people.values()) if (p.mode === 'work' && p.desk && !p.path.length) occupant.set(p.desk, p);
    for (const [dk, scr] of this.screens) {
      const p = occupant.get(dk);
      const col = p ? STATUS_COLOR[p.s.status] : null;
      if (col) {
        const pulse = p.s.status === 'thinking' ? 0.5 + 0.35 * Math.sin(t * 3 + p.phase) : 0.8 + 0.2 * Math.sin(t * 9 + p.phase);
        scr.material.emissive.setHex(col);
        scr.material.emissiveIntensity = pulse;
      } else {
        scr.material.emissive.setHex(0x000000);
      }
    }
    for (const b of this.blinkers) {
      const on = Math.sin(this.t / (180 + b.r * 37 + b.k * 53) + b.r * b.k) > 0.2 && (b.r * 4 + b.k) < Math.max(4, this.deskOf.size * 3);
      b.m.material.emissiveIntensity = on ? 1.2 : 0.05;
    }
    if (this.arcadeScreen) this.arcadeScreen.material.emissive.setHSL((t * 0.05) % 1, 0.7, 0.5);
    const fbPlaying = this.plan.pois.filter((q) => q.pair === 'fb' && q.taken).length === 2;
    if (this.rods) this.rods.forEach((r, k) => { r.position.z = this.plan.props.find((q) => q.t === 'foosball').y + 0.4 + (fbPlaying ? Math.sin(t * 8 + k) * 0.06 : 0); r.rotation.z = fbPlaying ? Math.sin(t * 12 + k) * 0.6 : 0; });
    this.updateBall();

    this.syncActors(dt);
    this.controls.update();
    this.gl.render(this.scene, this.camera);

    // overlay: bubbles + name tags, reusing the 2D drawing code
    this.hit = [];
    const heads = [];
    const v = new THREE.Vector3();
    for (const p of this.people.values()) {
      const a = this.actors.get(p.key);
      if (!a) continue;
      const st = this.stateOf(p);
      const scale = p.s.subagent ? 0.8 : 1;
      const base = this.plan.terrain && st.pose !== 'sit' ? this.groundHeight(p.x, p.y) : 0;
      const floatUp = st.pose !== 'walk' && p.poi && p.poi.float ? 0.45 + Math.sin((this.t / 1000 + p.phase) * 0.9) * 0.18 : 0;
      const top = (st.pose === 'sit' ? this.seatHeight(p.x, p.y, st.sitZ) + CHAR_HEIGHT * 0.8 * scale : base + CHAR_HEIGHT * scale) + floatUp;
      v.set(p.x, top + 0.05, p.y).project(this.camera);
      const sx = (v.x + 1) / 2 * this.cw, sy = (1 - v.y) / 2 * this.ch;
      const foot = new THREE.Vector3(p.x, 0, p.y).project(this.camera);
      const fy = (1 - foot.y) / 2 * this.ch;
      heads.push([p, { x: sx, y: sy, act: st.act }, v.z]);
      this.hit.push({ key: p.key, x0: sx - 18, x1: sx + 18, y0: sy - 24, y1: fy + 4 });
    }
    heads.sort((a, b) => b[2] - a[2]);
    for (const [p, at] of heads) this.bubble(p, at);
    if (this.offDuty > 0) {
      c.font = '600 11px ui-sans-serif, system-ui, -apple-system, "PingFang TC", sans-serif';
      c.textAlign = 'left';
      c.fillStyle = this.pal.text;
      c.globalAlpha = 0.65;
      c.fillText(`+${this.offDuty} ${this.offDutyLabel}`, 12, this.ch - 12);
      c.globalAlpha = 1;
    }
  }

  updateBall() {
    if (!this.ball) return;
    const players = this.plan.pois.filter((q) => q.pair === 'pp' && q.taken)
      .map((q) => this.people.get(q.taken)).filter((p) => p && p.poi && p.poi.pair === 'pp' && !p.path.length);
    this.ball.visible = players.length === 2;
    if (!this.ball.visible) return;
    const pp = this.plan.pp;
    const k = (this.t / 900) % 2;
    const f = k < 1 ? k : 2 - k;
    this.ball.position.set(pp.x0 + 0.3 + f * (pp.x1 - pp.x0 - 0.6), 0.8 + Math.abs(Math.sin(f * Math.PI * 2)) * 0.4, pp.y);
  }

  pointer(e, click) {
    // Let OrbitControls drags through without flickering the tooltip.
    if (e.buttons && !click) return;
    super.pointer(e, click);
  }
}
