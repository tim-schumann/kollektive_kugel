import * as THREE from 'three';
import { buildTiles } from './geodesic.js';
import { SUPABASE_URL, SUPABASE_KEY, PAGE_TITLE, PAGE_SUBTITLE, PAGE_FOOTER } from './config.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const COLORS = {
  small: 0xbab3e3,   // light violet: Typ 2, the small panels around the 12 five-fold vertices
  large: 0xe4e1f3,   // pale lavender: Typ 1
  own:   0x2c17e6,   // your panel (signal blue)
  taken: 0x9540b8,   // already assigned panels in your group (signal magenta)
  core:  0x1e1650,   // deep indigo, visible through the joints
  coreFilling: 0xffffff,   // white between the fillings
  // group view: the group's free panels get a stronger tint, everything else fades
  groupSmall: 0xa89ee2,
  groupLarge: 0xcdc6f0,
  outside:    0xf6f5fa,
};
// Built sphere: Ø 1200 mm. Edge labels are node-to-node lengths at this radius
// (209 / 242 / 247 mm); the filling sits FILLING_INSET_MM inside every edge.
const SPHERE_RADIUS_MM = 600;
const FILLING_INSET_MM = 15;
const TILE_GAP = 0.955;          // frames shrink towards their centre, leaving joints
const TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.32);

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOTION = reduceMotion
  ? { idle: 0,    max: 6,  up: 0.25, down: 1.2, turn: 0.01 }
  : { idle: 0.22, max: 24, up: 1.7,  down: 3.6, turn: 1.1 };

const demoMode = !SUPABASE_URL || !SUPABASE_KEY;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const form = $('draw-form');
const input = $('student-id');
const rollButton = $('roll');
const groupButton = $('show-group');
const statusEl = $('status');
const resultEl = $('result');
const resultLead = $('result-lead');
const resultCode = $('result-code');
const groupInfo = $('group-info');
const groupSummary = $('group-summary');
const remainingEl = $('remaining');
const labelsToggle = $('toggle-labels');
const edgesToggle = $('toggle-edges');
const frameButton = $('show-frame');
const fillingButton = $('show-filling');

$('title').textContent = PAGE_TITLE;
$('subtitle').textContent = PAGE_SUBTITLE;
$('footer').textContent = PAGE_FOOTER;
document.title = PAGE_TITLE;
if (demoMode) $('demo-note').hidden = false;

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8f86c8, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.7);
key.position.set(-2.5, 3, 4);
scene.add(key);

const sphere = new THREE.Group();
scene.add(sphere);

const tiles = buildTiles();
const tileByCode = new Map(tiles.map((t, i) => [t.code, i]));
const tileIndex = (icoFace, subFace) => tiles.findIndex((t) => t.icoFace === icoFace && t.subFace === subFace);

// Two outlines per panel: the frame (the whole panel, shrunk slightly so the
// joints show) and the filling (every edge moved inwards by FILLING_INSET_MM).
const shapes = {
  frame: tiles.map((t) => t.vertices.map((v) => v.clone().sub(t.centroid).multiplyScalar(TILE_GAP).add(t.centroid))),
  filling: tiles.map((t) => insetTriangle(t.vertices, FILLING_INSET_MM / SPHERE_RADIUS_MM)),
};
const display = { mode: 'frame' };

const positions = new Float32Array(tiles.length * 9);
const colors = new Float32Array(tiles.length * 9);

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

const coreMaterial = new THREE.MeshStandardMaterial({ color: COLORS.core, roughness: 1 });

function setShape(mode) {
  display.mode = mode;
  coreMaterial.color.setHex(mode === 'filling' ? COLORS.coreFilling : COLORS.core);
  shapes[mode].forEach((verts, i) => verts.forEach((v, k) => v.toArray(positions, i * 9 + k * 3)));
  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();
}
setShape('frame');

sphere.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
  vertexColors: true, flatShading: true, roughness: 0.78, metalness: 0,
})));
sphere.add(new THREE.Mesh(new THREE.SphereGeometry(0.94, 48, 32), coreMaterial));

// Centre and "up" of each group (icosahedron face), for the group view.
const groups = new Map();
for (let g = 1; g <= 20; g++) {
  const members = tiles.filter((t) => t.icoFace === g);
  const center = members.reduce((s, t) => s.add(t.centroid), new THREE.Vector3()).divideScalar(members.length);
  const normal = center.clone().normalize();
  const tip = members.find((t) => t.subFace === 1).centroid;
  const up = tip.clone().sub(center);
  up.addScaledVector(normal, -up.dot(normal)).normalize();
  groups.set(g, { normal, up });
}

// Camera distance for the whole sphere, and for a close-up of one group.
const view = { own: -1, group: null, groupTaken: new Set(), zoom: 0, zoomTarget: 0, far: 5, near: 3.5 };

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const fit = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect);
  view.far = 1.2 / fit;                 // sphere radius + margin
  view.near = 0.93 + 0.66 / fit;        // one group, seen from just above its surface
  camera.updateProjectionMatrix();
  updateCamera();
}

function updateCamera() {
  const e = smooth(view.zoom);
  camera.position.set(0, 0, view.far + (view.near - view.far) * e);
  camera.lookAt(0, 0, 0);
}

new ResizeObserver(resize).observe(stage);

// ---------------------------------------------------------------------------
// Panel colours
// ---------------------------------------------------------------------------

const color = new THREE.Color();

function panelColor(t, i) {
  const small = t.type === 2;
  if (i === view.own) return COLORS.own;
  if (view.group === null) return small ? COLORS.small : COLORS.large;
  if (t.icoFace !== view.group) return COLORS.outside;
  if (view.groupTaken.has(t.subFace)) return COLORS.taken;
  return small ? COLORS.groupSmall : COLORS.groupLarge;
}

function repaint() {
  tiles.forEach((t, i) => {
    color.setHex(panelColor(t, i));
    for (let k = 0; k < 3; k++) color.toArray(colors, i * 9 + k * 3);
  });
  geometry.attributes.color.needsUpdate = true;
  updateLabelColors();
}

// ---------------------------------------------------------------------------
// Overlays: panel labels and edge lengths, lying flat on the surface
// ---------------------------------------------------------------------------

const FONT = "'Titillium Web', 'Segoe UI', system-ui, sans-serif";
const overlayOn = { labels: false, edges: false };
const overlayCache = new Map();          // 'labels:frame' → THREE.Group, built on first use

// Place a plane flat on the surface: facing `normal`, its top towards `up`.
function placeFlat(mesh, position, normal, up) {
  const right = new THREE.Vector3().crossVectors(up, normal).normalize();
  const top = new THREE.Vector3().crossVectors(normal, right);
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, top, normal));
  mesh.position.copy(position);
}

function canvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

// Incircle of a panel: where the label has the most room.
function incircle([A, B, C]) {
  const a = B.distanceTo(C), b = C.distanceTo(A), c = A.distanceTo(B);
  const center = new THREE.Vector3()
    .addScaledVector(A, a).addScaledVector(B, b).addScaledVector(C, c)
    .divideScalar(a + b + c);
  const s = (a + b + c) / 2;
  const area = Math.sqrt(s * (s - a) * (s - b) * (s - c));
  return { center, radius: area / s };
}

// The panel with every edge moved inwards by `d`: scaled about its incentre.
function insetTriangle(verts, d) {
  const { center, radius } = incircle(verts);
  const s = (radius - d) / radius;
  return verts.map((v) => v.clone().sub(center).multiplyScalar(s).add(center));
}

function buildPanelLabels(mode) {
  const group = new THREE.Group();
  const plane = new THREE.PlaneGeometry(1, 1);
  group.userData.meshes = tiles.map((t, i) => {
    const map = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#fff';                            // tinted per panel via material colour
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 38px ${FONT}`;
      [`T${t.type}`, `G${t.icoFace}`, `F${t.subFace}`]
        .forEach((line, k) => ctx.fillText(line, w / 2, h / 2 + (k - 1) * 38));
    });
    const mesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false }));
    const { center, radius } = incircle(mode === 'filling' ? shapes.filling[i] : t.vertices);
    const size = radius * 1.5;
    mesh.scale.set(size, size, 1);
    placeFlat(mesh, center.addScaledVector(t.normal, 0.004), t.normal, t.up);
    group.add(mesh);
    return mesh;
  });
  return group;
}

const edgeMaterials = new Map();          // mm → material, shared by both modes

function edgeMaterial(mm) {
  if (!edgeMaterials.has(mm)) {
    const map = canvasTexture(160, 70, (ctx, w, h) => {
      ctx.fillStyle = '#f9f8fd';
      ctx.strokeStyle = '#6132d2';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.roundRect(3, 3, w - 6, h - 6, (h - 6) / 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1f1b3a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 44px ${FONT}`;
      ctx.fillText(String(mm), w / 2, h / 2 + 2);
    });
    edgeMaterials.set(mm, new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false }));
  }
  return edgeMaterials.get(mm);
}

// Frame: one label per edge, shared by two panels (209 / 242 / 247 mm).
// Filling: one label per edge of every filling, as it gets cut.
function buildEdgeLabels(mode) {
  const group = new THREE.Group();
  const plane = new THREE.PlaneGeometry(0.105, 0.045);
  const seen = new Set();
  const key = (v) => v.toArray().map((x) => x.toFixed(4)).join(',');
  tiles.forEach((t, i) => {
    const verts = mode === 'filling' ? shapes.filling[i] : t.vertices;
    for (let k = 0; k < 3; k++) {
      const a = verts[k], b = verts[(k + 1) % 3];
      if (mode === 'frame') {
        const id = [key(a), key(b)].sort().join('|');
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const mm = Math.round(a.distanceTo(b) * SPHERE_RADIUS_MM);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const normal = mode === 'filling' ? t.normal : mid.clone().normalize();
      const along = b.clone().sub(a).normalize();
      const up = new THREE.Vector3().crossVectors(normal, along);
      if (up.y < 0) up.negate();                        // keep text upright on an upright sphere
      const mesh = new THREE.Mesh(plane, edgeMaterial(mm));
      placeFlat(mesh, mid.addScaledVector(normal, 0.006), normal, up);
      group.add(mesh);
    }
  });
  return group;
}

function updateLabelColors() {
  for (const [id, group] of overlayCache) {
    if (!id.startsWith('labels:')) continue;
    tiles.forEach((t, i) => {
      const fill = panelColor(t, i);
      const material = group.userData.meshes[i].material;
      material.color.setHex(fill === COLORS.own || fill === COLORS.taken ? 0xffffff : 0x1f1b3a);
      material.opacity = fill === COLORS.outside ? 0.3 : 1;
    });
  }
}

// Show the overlays that are switched on, in the current mode (frame or filling).
async function refreshOverlays() {
  const names = Object.keys(overlayOn);
  if (names.some((name) => overlayOn[name] && !overlayCache.has(`${name}:${display.mode}`))) {
    await document.fonts.load(`700 40px ${FONT}`).catch(() => {});
  }
  for (const name of names) {
    const id = `${name}:${display.mode}`;
    if (overlayOn[name] && !overlayCache.has(id)) {
      const group = name === 'labels' ? buildPanelLabels(display.mode) : buildEdgeLabels(display.mode);
      overlayCache.set(id, group);
      sphere.add(group);
    }
  }
  for (const [id, group] of overlayCache) {
    const [name, mode] = id.split(':');
    group.visible = overlayOn[name] && mode === display.mode;
  }
  updateLabelColors();
}

function toggleOverlay(name, button) {
  overlayOn[name] = !overlayOn[name];
  button.setAttribute('aria-pressed', String(overlayOn[name]));
  refreshOverlays();
}

function showShape(mode) {
  setShape(mode);
  frameButton.setAttribute('aria-pressed', String(mode === 'frame'));
  fillingButton.setAttribute('aria-pressed', String(mode === 'filling'));
  refreshOverlays();
}

labelsToggle.addEventListener('click', () => toggleOverlay('labels', labelsToggle));
edgesToggle.addEventListener('click', () => toggleOverlay('edges', edgesToggle));
frameButton.addEventListener('click', () => showShape('frame'));
fillingButton.addEventListener('click', () => showShape('filling'));

repaint();

function markOwn(i) {
  view.own = i;
  repaint();
}

// ---------------------------------------------------------------------------
// Motion: orientation = TILT · Ry(theta) · B
// Spinning changes theta; B is blended towards the target while the sphere
// spins, so the chosen panel (or group) ends up facing the camera.
// ---------------------------------------------------------------------------

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const anim = { mode: 'idle', theta: 0, B: new THREE.Quaternion(), t: 0, resolve: null, down: null };

// Rotation that turns `normal` towards the camera with `up` pointing up.
function faceTowardsCamera({ normal, up }) {
  const q = new THREE.Quaternion().setFromUnitVectors(normal, Z);
  const u = up.clone().applyQuaternion(q);
  return new THREE.Quaternion().setFromAxisAngle(Z, Math.atan2(u.x, u.y)).multiply(q);
}

function spinUp() {
  anim.mode = 'spinup';
  anim.t = 0;
  return new Promise((resolve) => (anim.resolve = resolve));
}

// Slows down from `omega0` and lands with `target` facing the camera.
// With omega0 = 0 this is a plain turn.
function spinDownTo(target, omega0, duration, blendEnd) {
  const D = (omega0 * duration) / 3;                    // matches the starting speed
  const thetaEnd = anim.theta + D;
  const to = new THREE.Quaternion()
    .setFromAxisAngle(Y, -thetaEnd)
    .multiply(TILT.clone().invert())
    .multiply(faceTowardsCamera(target));
  anim.down = { t: 0, duration, thetaStart: anim.theta, D, from: anim.B.clone(), to, blendEnd };
  anim.mode = 'spindown';
  return new Promise((resolve) => (anim.resolve = resolve));
}

const smooth = (x) => x * x * (3 - 2 * x);

function updateMotion(dt) {
  switch (anim.mode) {
    case 'idle':
      anim.theta += MOTION.idle * dt;
      break;
    case 'spinup': {
      anim.t += dt;
      const u = Math.min(anim.t / MOTION.up, 1);
      anim.theta += (MOTION.idle + (MOTION.max - MOTION.idle) * u * u) * dt;
      if (u >= 1) { anim.mode = 'spinning'; finish(); }
      break;
    }
    case 'spinning':
      anim.theta += MOTION.max * dt;
      break;
    case 'spindown': {
      const d = anim.down;
      d.t += dt;
      const u = Math.min(d.t / d.duration, 1);
      anim.theta = d.thetaStart + d.D * (1 - (1 - u) ** 3);
      anim.B.slerpQuaternions(d.from, d.to, smooth(Math.min(u / d.blendEnd, 1)));
      if (u >= 1) { anim.mode = 'done'; finish(); }
      break;
    }
  }
  sphere.quaternion.copy(TILT).multiply(new THREE.Quaternion().setFromAxisAngle(Y, anim.theta)).multiply(anim.B);

  if (view.zoom !== view.zoomTarget) {
    const step = reduceMotion ? 1 : dt / MOTION.turn;
    view.zoom = view.zoomTarget > view.zoom
      ? Math.min(view.zoom + step, view.zoomTarget)
      : Math.max(view.zoom - step, view.zoomTarget);
    updateCamera();
  }

  if (userZoom.value !== userZoom.target) {
    const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 10);
    let z = userZoom.value + (userZoom.target - userZoom.value) * k;
    if (Math.abs(userZoom.target - z) < 0.001) z = userZoom.target;
    applyZoom(z);
  }
}

function finish() {
  const r = anim.resolve;
  anim.resolve = null;
  r?.();
}

// User zoom: narrows the camera's view, so the camera never moves into the sphere.
// Pinch with two fingers; double-click zooms in step by step, then back out.
const ZOOM = { min: 1, max: 4, step: 1.6 };
const userZoom = { value: 1, target: 1 };

function applyZoom(z) {
  userZoom.value = z;
  camera.zoom = z;
  camera.updateProjectionMatrix();
}

function zoomTo(z, immediate = false) {
  userZoom.target = THREE.MathUtils.clamp(z, ZOOM.min, ZOOM.max);
  if (immediate) applyZoom(userZoom.target);
}

renderer.domElement.addEventListener('dblclick', (e) => {
  e.preventDefault();
  zoomTo(userZoom.target >= ZOOM.max - 0.01 ? ZOOM.min : userZoom.target * ZOOM.step);
});

// One pointer turns the sphere while it isn't rolling; two pointers zoom.
const pointers = new Map();               // pointerId → last { x, y }
let pinch = null;                         // finger distance at the last move
const canDrag = () => anim.mode === 'idle' || anim.mode === 'done';
const fingerDistance = () => {
  const [a, b] = pointers.values();
  return Math.hypot(a.x - b.x, a.y - b.y);
};

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  renderer.domElement.setPointerCapture(e.pointerId);
  if (pointers.size === 2) pinch = fingerDistance();
});
renderer.domElement.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;

  if (pointers.size >= 2) {
    const d = fingerDistance();
    if (pinch) zoomTo(userZoom.target * (d / pinch), true);
    pinch = d;
    return;
  }
  if (!canDrag()) return;
  const s = 0.008 / userZoom.value;       // slower when zoomed in
  const R = new THREE.Quaternion()
    .setFromAxisAngle(Y, dx * s)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * s));
  const Ry = new THREE.Quaternion().setFromAxisAngle(Y, anim.theta);
  // B' = Ry⁻¹ · TILT⁻¹ · R · TILT · Ry · B
  anim.B.premultiply(Ry).premultiply(TILT).premultiply(R)
    .premultiply(TILT.clone().invert()).premultiply(Ry.clone().invert());
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
};
renderer.domElement.addEventListener('pointerup', endPointer);
renderer.domElement.addEventListener('pointercancel', endPointer);

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

resize();
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  updateMotion(dt);
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

async function rpc(fn, args = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_KEY}`; // legacy anon key
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

// Demo: two test IDs, and some panels already taken by others.
const demoDb = { students: new Set(['1234567', '7654321']), assigned: new Map() };
if (demoMode) {
  const shuffled = [...tiles].sort(() => Math.random() - 0.5);
  shuffled.slice(0, 60).forEach((t, k) => demoDb.assigned.set(`demo-${k}`, t));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asResult = (status, t) => ({ status, code: t.code, ico_face: t.icoFace, sub_face: t.subFace });

async function rollDice(id) {
  if (!demoMode) return rpc('roll_dice', { p_student_id: id });
  await sleep(250);
  if (!demoDb.students.has(id)) return { status: 'invalid' };
  if (demoDb.assigned.has(id)) return asResult('existing', demoDb.assigned.get(id));
  const taken = new Set(demoDb.assigned.values());
  const free = tiles.filter((t) => !taken.has(t));
  if (!free.length) return { status: 'full' };
  const t = free[Math.floor(Math.random() * free.length)];
  demoDb.assigned.set(id, t);
  return asResult('assigned', t);
}

async function takenInGroup(group) {
  if (!demoMode) return rpc('group_status', { p_ico_face: group });
  await sleep(150);
  return [...demoDb.assigned.values()].filter((t) => t.icoFace === group).map((t) => t.subFace);
}

async function tilesLeft() {
  if (demoMode) return tiles.length - demoDb.assigned.size;
  return rpc('tiles_left');
}

async function refreshRemaining() {
  try {
    const n = await tilesLeft();
    remainingEl.textContent = `${n} von ${tiles.length} Paneelen frei`;
  } catch {
    remainingEl.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// UI flow
// ---------------------------------------------------------------------------

const GROUP_SHOW = 'Gruppe anzeigen';
const GROUP_HIDE = 'Ganze Kugel anzeigen';
let busy = false;

function showStatus(text, tone = '') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function showResult(lead, code) {
  resultLead.textContent = lead;
  resultCode.textContent = code;
  resultEl.hidden = false;
}

function shake() {
  if (reduceMotion) return;
  form.classList.remove('shake');
  void form.offsetWidth;
  form.classList.add('shake');
}

function setBusy(value) {
  busy = value;
  rollButton.disabled = value;
  groupButton.disabled = value || view.own < 0;
  input.readOnly = value;
  form.setAttribute('aria-busy', String(value));
}

// Back to the plain spinning sphere, e.g. when the next person types their ID.
function resetView() {
  resultEl.hidden = true;
  groupInfo.hidden = true;
  view.own = -1;
  view.group = null;
  view.zoomTarget = 0;
  zoomTo(ZOOM.min);
  if (anim.mode === 'done') anim.mode = 'idle';
  repaint();
  groupButton.textContent = GROUP_SHOW;
  groupButton.disabled = true;
  groupButton.setAttribute('aria-pressed', 'false');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;

  const id = input.value.trim();
  resetView();
  if (!id) {
    showStatus('Bitte gib zuerst deine Matrikelnummer ein.', 'error');
    input.focus();
    return;
  }

  setBusy(true);
  showStatus('Matrikelnummer wird geprüft …');

  let result;
  try {
    result = await rollDice(id);
  } catch (err) {
    console.error(err);
    result = { status: 'error' };
  }

  let index = -1;
  if (result.ico_face != null) index = tileIndex(result.ico_face, result.sub_face);
  else if (result.code != null) index = tileByCode.get(result.code) ?? -1;

  if (result.status === 'assigned' && index >= 0) {
    showStatus('Es wird gewürfelt …');
    await spinUp();
    await spinDownTo(tiles[index], MOTION.max, MOTION.down, 0.55);
    markOwn(index);
    showStatus('');
    showResult('Deine Paneelnummer ist:', result.code);
  } else if (result.status === 'existing' && index >= 0) {
    showStatus('');
    await spinDownTo(tiles[index], reduceMotion ? 2 : 5, reduceMotion ? 0.8 : 1.6, 0.8);
    markOwn(index);
    showResult('Paneel bereits vergeben. Deine Paneelnummer ist:', result.code);
  } else if ((result.status === 'assigned' || result.status === 'existing') && result.code) {
    // Saved on the server, but not found on this sphere: numbering out of sync with setup.sql.
    console.warn('Panel not found on the sphere:', result);
    showStatus('Dein Paneel ist gespeichert, kann aber nicht auf der Kugel angezeigt werden.', 'error');
    showResult(result.status === 'existing' ? 'Paneel bereits vergeben. Deine Paneelnummer ist:' : 'Deine Paneelnummer ist:', result.code);
  } else if (result.status === 'invalid') {
    showStatus('Falsche Matrikelnummer', 'error');
    shake();
  } else if (result.status === 'full') {
    showStatus(`Alle ${tiles.length} Paneele sind vergeben. Bitte wende dich an die Lehrenden.`, 'error');
  } else {
    showStatus('Keine Verbindung zur Datenbank. Prüfe deine Internetverbindung und versuche es erneut.', 'error');
  }

  setBusy(false);
  refreshRemaining();
});

groupButton.addEventListener('click', async () => {
  if (busy || view.own < 0) return;
  const own = tiles[view.own];
  setBusy(true);
  zoomTo(ZOOM.min);                       // the group view sets its own framing

  if (view.group === null) {
    let taken;
    try {
      taken = await takenInGroup(own.icoFace);
    } catch (err) {
      console.error(err);
      showStatus('Keine Verbindung zur Datenbank. Prüfe deine Internetverbindung und versuche es erneut.', 'error');
      setBusy(false);
      return;
    }
    view.group = own.icoFace;
    view.groupTaken = new Set(taken.map(Number));
    view.groupTaken.add(own.subFace);
    repaint();
    groupSummary.textContent = `Gruppe ${own.icoFace}: ${view.groupTaken.size} von 9 Feldern vergeben`;
    groupInfo.hidden = false;
    view.zoomTarget = 1;
    await spinDownTo(groups.get(own.icoFace), 0, MOTION.turn, 1);
    groupButton.textContent = GROUP_HIDE;
    groupButton.setAttribute('aria-pressed', 'true');
  } else {
    view.group = null;
    repaint();
    groupInfo.hidden = true;
    view.zoomTarget = 0;
    await spinDownTo(own, 0, MOTION.turn, 1);
    groupButton.textContent = GROUP_SHOW;
    groupButton.setAttribute('aria-pressed', 'false');
  }

  setBusy(false);
});

// A new person at the same screen: back to the idle spin when the ID changes.
input.addEventListener('input', () => {
  if (statusEl.dataset.tone === 'error') showStatus('');
  if (anim.mode === 'done' && !busy) resetView();
});

refreshRemaining();