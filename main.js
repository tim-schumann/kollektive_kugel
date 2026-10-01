import * as THREE from 'three';
import { buildTiles } from './geodesic.js';
import { SUPABASE_URL, SUPABASE_KEY, PAGE_TITLE, PAGE_SUBTITLE, PAGE_FOOTER } from './config.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const COLORS = {
  type1: 0xbab3e3,   // light violet: panels around the 12 five-fold vertices
  type2: 0xe4e1f3,   // pale lavender
  own:   0x2c17e6,   // your panel (signal blue)
  taken: 0x9540b8,   // already assigned panels in your group (signal magenta)
  core:  0x1e1650,   // deep indigo, visible through the joints
  // group view: the group's free panels get a stronger tint, everything else fades
  groupType1: 0xa89ee2,
  groupType2: 0xcdc6f0,
  outside:    0xf6f5fa,
};
const TILE_GAP = 0.955;          // panels shrink towards their centre, leaving joints
const TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.32);

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOTION = reduceMotion
  ? { idle: 0,    max: 6,  up: 0.25, down: 1.2, turn: 0.01 }
  : { idle: 0.22, max: 24, up: 1.7,  down: 3.6, turn: 1.1 };

const demoMode = !SUPABASE_URL || !SUPABASE_KEY;
const showLabels = new URLSearchParams(location.search).has('labels');

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

const positions = new Float32Array(tiles.length * 9);
const colors = new Float32Array(tiles.length * 9);

tiles.forEach((t, i) => {
  const verts = t.vertices.map((v) => v.clone().sub(t.centroid).multiplyScalar(TILE_GAP).add(t.centroid));
  verts.forEach((v, k) => v.toArray(positions, i * 9 + k * 3));
});

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
geometry.computeVertexNormals();
sphere.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
  vertexColors: true, flatShading: true, roughness: 0.78, metalness: 0,
})));
sphere.add(new THREE.Mesh(
  new THREE.SphereGeometry(0.94, 48, 32),
  new THREE.MeshStandardMaterial({ color: COLORS.core, roughness: 1 }),
));

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

if (showLabels) addLabels();

function addLabels() {
  for (const t of tiles) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = '600 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1f1b3a';
    ctx.fillText(`${t.icoFace}-${t.subFace}`, 64, 34);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }));
    sprite.position.copy(t.centroid).addScaledVector(t.normal, 0.02);
    sprite.scale.set(0.16, 0.08, 1);
    sphere.add(sprite);
  }
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
  if (i === view.own) return COLORS.own;
  if (view.group === null) return t.type === 1 ? COLORS.type1 : COLORS.type2;
  if (t.icoFace !== view.group) return COLORS.outside;
  if (view.groupTaken.has(t.subFace)) return COLORS.taken;
  return t.type === 1 ? COLORS.groupType1 : COLORS.groupType2;
}

function repaint() {
  tiles.forEach((t, i) => {
    color.setHex(panelColor(t, i));
    for (let k = 0; k < 3; k++) color.toArray(colors, i * 9 + k * 3);
  });
  geometry.attributes.color.needsUpdate = true;
}
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
}

function finish() {
  const r = anim.resolve;
  anim.resolve = null;
  r?.();
}

// Drag to turn the sphere while it isn't rolling.
let drag = null;
const canDrag = () => anim.mode === 'idle' || anim.mode === 'done';
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!canDrag()) return;
  drag = { x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag || !canDrag()) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  const R = new THREE.Quaternion()
    .setFromAxisAngle(Y, dx * 0.008)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * 0.008));
  const Ry = new THREE.Quaternion().setFromAxisAngle(Y, anim.theta);
  // B' = Ry⁻¹ · TILT⁻¹ · R · TILT · Ry · B
  anim.B.premultiply(Ry).premultiply(TILT).premultiply(R)
    .premultiply(TILT.clone().invert()).premultiply(Ry.clone().invert());
});
const endDrag = () => (drag = null);
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

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
  if (anim.mode === 'done' && !busy) {
    resetView();
    anim.mode = 'idle';
  }
});

refreshRemaining();
