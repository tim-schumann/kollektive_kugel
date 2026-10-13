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
const lockEl = $('lock');
const loginForm = $('login-form');
const idInput = $('student-id');
const passwordInput = $('password');
const loginButton = $('login');
const loginStatus = $('login-status');
const lockedParts = document.querySelectorAll('[data-locked]');
const rollButton = $('roll');
const viewButtons = $('view-buttons');
const groupButton = $('show-group');
const panelButton = $('show-panel');
const uploadButton = $('upload');
const uploadHint = $('upload-hint');
const fileInput = $('design-file');
const previewEl = $('preview');
const previewCanvas = $('preview-canvas');
const acceptButton = $('accept');
const discardButton = $('discard');
const panelsToggle = $('toggle-panels');
const accountEl = $('account');
const whoEl = $('who');
const logoutButton = $('logout');
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
$('login-title').textContent = PAGE_TITLE;
if (demoMode) $('demo-note').hidden = $('login-demo').hidden = false;

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
const view = { own: -1, focus: 'sphere', group: null, groupTaken: new Set(), zoom: 0, zoomTarget: 0, far: 5, near: 3.5 };

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

// ---------------------------------------------------------------------------
// Designs: the students' images, mapped onto the fillings
// ---------------------------------------------------------------------------

const designs = {
  on: false,                 // "Panels laden": everyone's designs, not just your own
  loading: false,
  committed: new Map(),      // tile index → { texture, updatedAt }
  preview: null,             // { png, jpeg, canvas, texture } until accepted or deleted
  meshes: new Map(),         // tile index → mesh, built on first use
};
const designLayer = new THREE.Group();
sphere.add(designLayer);

// A filling as the design image sees it: the base (the edge whose length
// differs from the other two) along the bottom edge of the image, the apex at
// the middle of the top edge, left and right as seen from outside the sphere.
function designCorners(i) {
  const verts = shapes.filling[i];
  const side = (k) => verts[(k + 1) % 3].distanceTo(verts[(k + 2) % 3]);   // opposite corner k
  const odd = (k) => Math.abs(side(k) - (side((k + 1) % 3) + side((k + 2) % 3)) / 2);
  const a = [0, 1, 2].reduce((best, k) => (odd(k) > odd(best) ? k : best), 0);
  const apex = verts[a];
  let left = verts[(a + 1) % 3], right = verts[(a + 2) % 3];
  const mid = left.clone().add(right).multiplyScalar(0.5);
  const up = apex.clone().sub(mid);
  if (left.clone().sub(mid).dot(new THREE.Vector3().crossVectors(up, tiles[i].normal)) > 0) {
    [left, right] = [right, left];
  }
  return {
    apex, left, right,
    widthMm: left.distanceTo(right) * SPHERE_RADIUS_MM,
    heightMm: up.length() * SPHERE_RADIUS_MM,
  };
}

// Textures are uploaded with flipY off, so v = 0 is the top row of the image.
function designMesh(i) {
  if (!designs.meshes.has(i)) {
    const t = tiles[i];
    const { apex, left, right } = designCorners(i);
    const lift = t.normal.clone().multiplyScalar(0.002);  // just above the panel, below the labels
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(
      [left, right, apex].flatMap((v) => v.clone().add(lift).toArray()), 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(
      [t.normal, t.normal, t.normal].flatMap((n) => n.toArray()), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0.5, 0], 2));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0 }));
    designs.meshes.set(i, mesh);
    designLayer.add(mesh);
  }
  return designs.meshes.get(i);
}

// Your own design (or its preview) always shows; the others with "Panels laden".
function refreshDesigns() {
  const shown = new Map();
  for (const [i, d] of designs.committed) {
    if (designs.on || i === view.own) shown.set(i, d.texture);
  }
  if (designs.preview && view.own >= 0) shown.set(view.own, designs.preview.texture);
  for (const [i, mesh] of designs.meshes) mesh.visible = shown.has(i);
  for (const [i, texture] of shown) {
    const material = designMesh(i).material;
    if (material.map !== texture) {
      material.map = texture;
      material.needsUpdate = true;
    }
  }
}

function makeTexture(image) {
  const texture = new THREE.Texture(image);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

async function textureFromJpeg(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const texture = makeTexture(bitmap);
  texture.onUpdate = () => bitmap.close();             // on the GPU now, free the copy
  return texture;
}

function setCommitted(i, texture, updatedAt) {
  designs.committed.get(i)?.texture.dispose();
  designs.committed.set(i, { texture, updatedAt });
}

function clearDesigns() {
  for (const { texture } of designs.committed.values()) texture.dispose();
  designs.committed.clear();
  designs.preview?.texture.dispose();
  designs.preview = null;
  refreshDesigns();
}

// --- Upload checks ----------------------------------------------------------
// The file is only ever decoded as an image and then redrawn on a canvas, so
// only its pixels reach the database; anything hidden in the file is dropped.
// The server checks the redrawn files again (supabase/setup.sql).

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXTURE_BYTES = 512 * 1024;
const SIDE_PX = { min: 64, max: 4096 };
const STORED_MAX_WIDTH = 1600;
const TEXTURE_WIDTH = 512;
const ASPECT_TOLERANCE = 0.05;
// Letters, digits, space, _ - ( ) and a single ".png": no paths, no double extensions.
const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _()-]{0,95}\.png$/iu;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'IDAT', 'IEND']);

class UploadError extends Error {}

// Walks the chunks of a PNG. Returns them, or null unless the file starts with
// the signature and IHDR, and ends with IEND and nothing after it.
function pngChunks(bytes) {
  if (bytes.length < 57 || PNG_SIGNATURE.some((b, k) => bytes[k] !== b)) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  for (let o = 8; o + 12 <= bytes.length;) {
    const length = data.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    const end = o + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > bytes.length) return null;
    if ((chunks.length === 0) !== (type === 'IHDR') || (type === 'IHDR' && length !== 13)) return null;
    chunks.push({ type, start: o, end });
    if (type === 'IEND') return end === bytes.length && chunks.some((c) => c.type === 'IDAT') ? chunks : null;
    o = end;
  }
  return null;
}

function pngSize(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: data.getUint32(16), height: data.getUint32(20) };
}

// Keeps only the chunks needed to show the image (drops text, metadata, …).
function stripPng(bytes) {
  const chunks = pngChunks(bytes);
  if (!chunks) throw new UploadError('Das Bild konnte nicht gespeichert werden.');
  const kept = chunks.filter((c) => PNG_KEEP.has(c.type));
  const out = new Uint8Array(8 + kept.reduce((n, c) => n + c.end - c.start, 0));
  out.set(PNG_SIGNATURE);
  let o = 8;
  for (const c of kept) {
    out.set(bytes.subarray(c.start, c.end), o);
    o += c.end - c.start;
  }
  return out;
}

function drawScaled(source, maxWidth, background) {
  const scale = Math.min(1, maxWidth / source.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function encode(canvas, type, quality) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new UploadError('Das Bild konnte nicht gespeichert werden.');
  return new Uint8Array(await blob.arrayBuffer());
}

const mm = (x) => Math.round(x);
const formatMb = (bytes) => (bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 });

function designFormat(i) {
  const { widthMm, heightMm } = designCorners(i);
  return `PNG bis 2 MB, nur die Füllung ohne Rahmen: ${mm(widthMm)} × ${mm(heightMm)} mm `
    + `(z. B. ${mm(widthMm) * 10} × ${mm(heightMm) * 10} px), Grundseite unten, Spitze oben mittig.`;
}

async function prepareDesign(file, i) {
  const name = file.name.normalize('NFC');
  if (!SAFE_NAME.test(name)) {
    throw new UploadError('Ungültiger Dateiname. Erlaubt sind Buchstaben, Ziffern, Leerzeichen, - _ ( ) und die Endung .png, z. B. „Paneel_Entwurf-2.png“.');
  }
  if (file.type && file.type !== 'image/png') throw new UploadError('Bitte lade eine PNG-Datei hoch.');
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    throw new UploadError(`Die Datei ist ${formatMb(file.size)} MB groß, erlaubt sind höchstens 2 MB.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!pngChunks(bytes)) {
    throw new UploadError('Die Datei ist keine gültige PNG-Datei oder enthält zusätzliche Daten.');
  }
  // Checked before decoding, so a tiny file can't unpack into a huge image.
  const { width, height } = pngSize(bytes);
  if (width < SIDE_PX.min || height < SIDE_PX.min || width > SIDE_PX.max || height > SIDE_PX.max) {
    throw new UploadError(`Das Bild muss zwischen ${SIDE_PX.min} und ${SIDE_PX.max} Pixel breit und hoch sein (deins: ${width} × ${height} px).`);
  }
  const { widthMm, heightMm } = designCorners(i);
  if (Math.abs((width / height) / (widthMm / heightMm) - 1) > ASPECT_TOLERANCE) {
    throw new UploadError(`Das Seitenverhältnis passt nicht zu deinem Paneel: erwartet ${mm(widthMm)} × ${mm(heightMm)} mm `
      + `(z. B. ${mm(widthMm) * 10} × ${mm(heightMm) * 10} px), dein Bild hat ${width} × ${height} px.`);
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  } catch {
    throw new UploadError('Das Bild konnte nicht gelesen werden. Ist die Datei beschädigt?');
  }
  try {
    if (bitmap.width !== width || bitmap.height !== height) {
      throw new UploadError('Das Bild konnte nicht gelesen werden. Ist die Datei beschädigt?');
    }
    // Stored copy: redrawn PNG, scaled down until it fits into 2 MB.
    let png = null;
    for (let w = Math.min(width, STORED_MAX_WIDTH); w >= 256 && !png; w = Math.round(w * 0.8)) {
      const candidate = stripPng(await encode(drawScaled(bitmap, w), 'image/png'));
      if (candidate.length <= MAX_FILE_BYTES) png = candidate;
    }
    if (!png) throw new UploadError('Das Bild ist zu detailreich, um es unter 2 MB zu speichern.');

    // Texture for the sphere: small JPEG on white.
    const canvas = drawScaled(bitmap, TEXTURE_WIDTH, '#fff');
    let jpeg = null;
    for (const quality of [0.85, 0.7, 0.5]) {
      const candidate = await encode(canvas, 'image/jpeg', quality);
      if (candidate.length <= MAX_TEXTURE_BYTES) { jpeg = candidate; break; }
    }
    if (!jpeg) throw new UploadError('Das Bild konnte nicht gespeichert werden.');
    return { png, jpeg, canvas };
  } finally {
    bitmap.close();
  }
}

// The design clipped to the filling, as it will be cut.
function drawPreview(source) {
  const w = previewCanvas.width = 480;
  const h = previewCanvas.height = Math.round((w * source.height) / source.width);
  const ctx = previewCanvas.getContext('2d');
  const inset = 3;
  const triangle = () => {
    ctx.beginPath();
    ctx.moveTo(w / 2, inset);
    ctx.lineTo(w - inset, h - inset);
    ctx.lineTo(inset, h - inset);
    ctx.closePath();
  };
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  triangle();
  ctx.clip();
  ctx.drawImage(source, 0, 0, w, h);
  ctx.restore();
  triangle();
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#2c17e6';
  ctx.stroke();
}

repaint();

function markOwn(i) {
  view.own = i;
  repaint();
  refreshDesigns();
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

const session = { token: null, studentId: null, tileCode: null };
const SESSION_KEY = 'kollektive-kugel-session';

function saveSession() {
  try {
    if (session.token) sessionStorage.setItem(SESSION_KEY, session.token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* private mode: login lasts until reload */ }
}

function savedSession() {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}

// Demo: two test IDs, password "demo", and some panels already taken by others.
const DEMO_PASSWORD = 'demo';
const demoDb = { students: new Set(['1234567', '7654321']), assigned: new Map(), sessions: new Map(), designs: new Map() };
if (demoMode) {
  const shuffled = [...tiles].sort(() => Math.random() - 0.5);
  shuffled.slice(0, 60).forEach((t, k) => demoDb.assigned.set(`demo-${k}`, t));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tileJson = (t) => ({ code: t.code, ico_face: t.icoFace, sub_face: t.subFace });
const asResult = (status, t) => ({ status, ...tileJson(t) });
const demoStudent = () => demoDb.sessions.get(session.token);
const demoTile = (id) => (demoDb.assigned.has(id) ? tileJson(demoDb.assigned.get(id)) : null);

async function login(id, password) {
  if (!demoMode) return rpc('student_login', { p_student_id: id, p_password: password });
  await sleep(250);
  if (!demoDb.students.has(id) || password !== DEMO_PASSWORD) return { status: 'invalid' };
  const token = crypto.randomUUID();
  demoDb.sessions.set(token, id);
  return { status: 'ok', token, student_id: id, tile: demoTile(id) };
}

async function whoAmI() {
  if (!demoMode) return rpc('student_session', { p_token: session.token });
  const id = demoStudent();
  return id ? { status: 'ok', student_id: id, tile: demoTile(id) } : { status: 'expired' };
}

async function endSession(token) {
  if (!demoMode) return rpc('student_logout', { p_token: token });
  demoDb.sessions.delete(token);
}

async function rollDice() {
  if (!demoMode) return rpc('roll_dice', { p_token: session.token });
  await sleep(250);
  const id = demoStudent();
  if (!id) return { status: 'expired' };
  if (demoDb.assigned.has(id)) return asResult('existing', demoDb.assigned.get(id));
  const taken = new Set(demoDb.assigned.values());
  const free = tiles.filter((t) => !taken.has(t));
  if (!free.length) return { status: 'full' };
  const t = free[Math.floor(Math.random() * free.length)];
  demoDb.assigned.set(id, t);
  return asResult('assigned', t);
}

async function uploadDesign(png, jpeg) {
  if (!demoMode) {
    return rpc('upload_design', { p_token: session.token, p_image: bytesToBase64(png), p_texture: bytesToBase64(jpeg) });
  }
  await sleep(400);
  const id = demoStudent();
  if (!id) return { status: 'expired' };
  const t = demoDb.assigned.get(id);
  if (!t) return { status: 'no_tile' };
  const updated_at = new Date().toISOString();
  demoDb.designs.set(t.code, { ...tileJson(t), updated_at, texture: bytesToBase64(jpeg) });
  return { status: 'ok', updated_at };
}

async function listDesigns() {
  if (!demoMode) return rpc('list_designs', { p_token: session.token });
  if (!demoStudent()) return { status: 'expired' };
  return { status: 'ok', designs: [...demoDb.designs.values()].map(({ texture, ...d }) => d) };
}

async function designTextures(codes) {
  if (!demoMode) return rpc('design_textures', { p_token: session.token, p_codes: codes });
  if (!demoStudent()) return { status: 'expired' };
  return { status: 'ok', textures: codes.map((c) => demoDb.designs.get(c)).filter(Boolean) };
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

function bytesToBase64(bytes) {
  let s = '';
  for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let k = 0; k < s.length; k++) bytes[k] = s.charCodeAt(k);
  return bytes;
}

// ---------------------------------------------------------------------------
// UI flow
// ---------------------------------------------------------------------------

const NO_CONNECTION = 'Keine Verbindung zur Datenbank. Prüfe deine Internetverbindung und versuche es erneut.';
const SESSION_ENDED = 'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.';
const PANEL_ZOOM = 2.4;
const TEXTURE_BATCH = 20;
let busy = false;

// Thrown after an expired session has sent the user back to the login.
class SessionExpired extends Error {}

async function authed(request) {
  const result = await request;
  if (result?.status === 'expired') {
    logout(SESSION_ENDED);
    throw new SessionExpired();
  }
  return result;
}

function showStatus(text, tone = '') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function showLoginStatus(text, tone = '') {
  loginStatus.textContent = text;
  loginStatus.dataset.tone = tone;
}

function showResult(lead, code) {
  resultLead.textContent = lead;
  resultCode.textContent = code;
  resultEl.hidden = false;
}

function shake() {
  if (reduceMotion) return;
  loginForm.classList.remove('shake');
  void loginForm.offsetWidth;
  loginForm.classList.add('shake');
}

function renderControls() {
  const hasPanel = view.own >= 0;
  rollButton.hidden = !session.studentId || !!session.tileCode;
  viewButtons.hidden = !hasPanel;
  uploadButton.hidden = uploadHint.hidden = !hasPanel || !!designs.preview;
  previewEl.hidden = !designs.preview;
  for (const button of [rollButton, groupButton, panelButton, uploadButton, acceptButton, discardButton]) {
    button.disabled = busy;
  }
  groupButton.setAttribute('aria-pressed', String(view.focus === 'group'));
  panelButton.setAttribute('aria-pressed', String(view.focus === 'panel'));
  accountEl.hidden = !session.studentId;
}

function setBusy(value) {
  busy = value;
  renderControls();
}

// --- Lock screen ------------------------------------------------------------

function lockPage(message = '', tone = 'error') {
  lockEl.classList.remove('open');
  lockedParts.forEach((el) => (el.inert = true));
  loginButton.disabled = false;
  showLoginStatus(message, message ? tone : '');
}

function unlockPage() {
  lockEl.classList.add('open');
  lockedParts.forEach((el) => (el.inert = false));
  showLoginStatus('');
}

// After login or a page reload: open the page and show the student's panel.
async function enter({ student_id, tile }) {
  session.studentId = student_id;
  session.tileCode = tile?.code ?? null;
  whoEl.textContent = `Angemeldet mit ${student_id}`;
  unlockPage();
  refreshRemaining();
  if (!tile) {
    showStatus('Würfle jetzt dein Paneel aus.');
    renderControls();
    return;
  }
  setBusy(true);
  await showTile(tile, 'turn');
  setBusy(false);
  loadDesigns({ ownOnly: true }).catch((err) => {
    if (!(err instanceof SessionExpired)) console.error(err);
  });
}

function logout(message = '') {
  if (session.token) endSession(session.token).catch(() => {});
  session.token = session.studentId = session.tileCode = null;
  saveSession();
  designs.on = false;
  panelsToggle.setAttribute('aria-pressed', 'false');
  clearDesigns();
  resetView();
  showStatus('');
  passwordInput.value = '';
  if (message !== SESSION_ENDED) idInput.value = '';   // the next person at a shared screen
  busy = false;
  renderControls();
  lockPage(message, message === SESSION_ENDED ? 'error' : '');
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (loginButton.disabled) return;
  const id = idInput.value.trim();
  const password = passwordInput.value;
  if (!id || !password) {
    showLoginStatus('Bitte gib Matrikelnummer und Passwort ein.', 'error');
    (id ? passwordInput : idInput).focus();
    return;
  }

  loginButton.disabled = true;
  showLoginStatus('Anmeldung wird geprüft …');
  let result;
  try {
    result = await login(id, password);
  } catch (err) {
    console.error(err);
    result = { status: 'error' };
  }
  loginButton.disabled = false;

  if (result.status === 'ok') {
    session.token = result.token;
    saveSession();
    passwordInput.value = '';
    enter(result);
  } else if (result.status === 'invalid') {
    showLoginStatus('Matrikelnummer oder Passwort falsch.', 'error');
    shake();
  } else if (result.status === 'locked') {
    showLoginStatus('Zu viele Fehlversuche. Bitte warte 15 Minuten.', 'error');
  } else if (result.status === 'no_password') {
    showLoginStatus('Für den Kurs ist noch kein Passwort eingerichtet. Bitte wende dich an die Lehrenden.', 'error');
  } else {
    showLoginStatus(NO_CONNECTION, 'error');
  }
});

logoutButton.addEventListener('click', () => logout());

// --- Your panel ---------------------------------------------------------------

function tileIndexOf(result) {
  if (result.ico_face != null) return tileIndex(result.ico_face, result.sub_face);
  return tileByCode.get(result.code) ?? -1;
}

// Spins ('roll') or turns ('turn') the sphere onto the tile and marks it.
async function showTile(tile, how, lead = 'Deine Paneelnummer ist:') {
  session.tileCode = tile.code;
  const index = tileIndexOf(tile);
  if (index < 0) {
    // Saved on the server, but not found on this sphere: numbering out of sync with setup.sql.
    console.warn('Panel not found on the sphere:', tile);
    showStatus('Dein Paneel ist gespeichert, kann aber nicht auf der Kugel angezeigt werden.', 'error');
    showResult(lead, tile.code);
    return;
  }
  if (how === 'roll') {
    await spinUp();
    await spinDownTo(tiles[index], MOTION.max, MOTION.down, 0.55);
  } else {
    await spinDownTo(tiles[index], reduceMotion ? 2 : 5, reduceMotion ? 0.8 : 1.6, 0.8);
  }
  markOwn(index);
  uploadHint.textContent = designFormat(index);
  showStatus('');
  showResult(lead, tile.code);
}

// Back to the plain spinning sphere, e.g. after logging out.
function resetView() {
  resultEl.hidden = true;
  groupInfo.hidden = true;
  view.own = -1;
  view.group = null;
  view.focus = 'sphere';
  view.zoomTarget = 0;
  zoomTo(ZOOM.min);
  if (anim.mode === 'done') anim.mode = 'idle';
  repaint();
  refreshDesigns();
}

rollButton.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  showStatus('Es wird gewürfelt …');
  try {
    const result = await authed(rollDice());
    if (result.status === 'assigned') await showTile(result, 'roll');
    else if (result.status === 'existing') await showTile(result, 'turn', 'Paneel bereits vergeben. Deine Paneelnummer ist:');
    else if (result.status === 'full') showStatus(`Alle ${tiles.length} Paneele sind vergeben. Bitte wende dich an die Lehrenden.`, 'error');
    else showStatus(NO_CONNECTION, 'error');
  } catch (err) {
    if (err instanceof SessionExpired) return;
    console.error(err);
    showStatus(NO_CONNECTION, 'error');
  } finally {
    setBusy(false);
    refreshRemaining();
  }
});

// The camera on the whole sphere, your group, or close on your panel.
async function focusView(target) {
  const own = tiles[view.own];
  zoomTo(target === 'panel' ? PANEL_ZOOM : ZOOM.min);
  if (target === 'group') {
    const taken = await takenInGroup(own.icoFace);
    view.group = own.icoFace;
    view.groupTaken = new Set(taken.map(Number));
    view.groupTaken.add(own.subFace);
    groupSummary.textContent = `Gruppe ${own.icoFace}: ${view.groupTaken.size} von 9 Feldern vergeben`;
  } else {
    view.group = null;
  }
  groupInfo.hidden = target !== 'group';
  view.focus = target;
  view.zoomTarget = target === 'sphere' ? 0 : 1;
  repaint();
  renderControls();
  await spinDownTo(target === 'group' ? groups.get(own.icoFace) : own, 0, MOTION.turn, 1);
}

// Each button switches its view on, or back to the whole sphere.
async function toggleFocus(target) {
  if (busy || view.own < 0) return;
  setBusy(true);
  try {
    await focusView(view.focus === target ? 'sphere' : target);
  } catch (err) {
    console.error(err);
    showStatus(NO_CONNECTION, 'error');
  } finally {
    setBusy(false);
  }
}

groupButton.addEventListener('click', () => toggleFocus('group'));
panelButton.addEventListener('click', () => toggleFocus('panel'));

// --- Designs ------------------------------------------------------------------

uploadButton.addEventListener('click', () => {
  if (!busy && view.own >= 0) fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';                               // the same file can be chosen again
  if (!file || busy || view.own < 0) return;
  setBusy(true);
  showStatus('Datei wird geprüft …');
  try {
    const design = await prepareDesign(file, view.own);
    designs.preview = { ...design, texture: makeTexture(design.canvas) };
    drawPreview(design.canvas);
    refreshDesigns();
    showStatus('Vorschau: So sitzt dein Design auf dem Paneel.');
    if (view.focus !== 'panel') await focusView('panel');
  } catch (err) {
    if (!(err instanceof UploadError)) console.error(err);
    showStatus(err instanceof UploadError ? err.message : 'Die Datei konnte nicht verarbeitet werden.', 'error');
  } finally {
    setBusy(false);
  }
});

discardButton.addEventListener('click', () => {
  if (busy || !designs.preview) return;
  designs.preview.texture.dispose();
  designs.preview = null;
  refreshDesigns();
  showStatus('Vorschau gelöscht.');
  renderControls();
});

acceptButton.addEventListener('click', async () => {
  if (busy || !designs.preview) return;
  setBusy(true);
  showStatus('Design wird hochgeladen …');
  try {
    const { png, jpeg, texture } = designs.preview;
    const result = await authed(uploadDesign(png, jpeg));
    if (result.status === 'ok') {
      setCommitted(view.own, texture, result.updated_at);
      designs.preview = null;
      refreshDesigns();
      showStatus('Dein Design ist gespeichert und für alle sichtbar. Du kannst es jederzeit ersetzen.');
    } else if (result.status === 'invalid_file') {
      showStatus('Die Datei wurde vom Server abgelehnt. Bitte exportiere sie neu als PNG.', 'error');
    } else if (result.status === 'no_tile') {
      showStatus('Dir ist kein Paneel mehr zugewiesen. Bitte wende dich an die Lehrenden.', 'error');
    } else {
      showStatus(NO_CONNECTION, 'error');
    }
  } catch (err) {
    if (err instanceof SessionExpired) return;
    console.error(err);
    showStatus(NO_CONNECTION, 'error');
  } finally {
    setBusy(false);
  }
});

// Fetches designs that are new or changed since the last load, in batches.
async function loadDesigns({ ownOnly = false, onProgress } = {}) {
  const token = session.token;
  const { designs: list } = await authed(listDesigns());
  const wanted = list
    .map((d) => ({ ...d, index: tileIndexOf(d) }))
    .filter((d) => d.index >= 0 && (!ownOnly || d.index === view.own));
  if (!ownOnly) {
    // Designs that are gone, e.g. because a panel was freed.
    const listed = new Set(wanted.map((d) => d.index));
    for (const [i, d] of designs.committed) {
      if (!listed.has(i)) { d.texture.dispose(); designs.committed.delete(i); }
    }
  }
  const stale = wanted.filter((d) => designs.committed.get(d.index)?.updatedAt !== d.updated_at);
  let done = wanted.length - stale.length;
  onProgress?.(done, wanted.length);
  for (let k = 0; k < stale.length; k += TEXTURE_BATCH) {
    const batch = stale.slice(k, k + TEXTURE_BATCH).map((d) => d.code);
    const { textures } = await authed(designTextures(batch));
    if (session.token !== token) return 0;           // logged out meanwhile
    for (const t of textures) {
      const i = tileIndexOf(t);
      if (i < 0) continue;
      try {
        setCommitted(i, await textureFromJpeg(base64ToBytes(t.texture)), t.updated_at);
      } catch (err) {
        console.warn('Design skipped:', t.code, err);
      }
    }
    done += batch.length;
    refreshDesigns();
    onProgress?.(done, wanted.length);
  }
  refreshDesigns();
  return wanted.length;
}

panelsToggle.addEventListener('click', async () => {
  designs.on = !designs.on;
  panelsToggle.setAttribute('aria-pressed', String(designs.on));
  refreshDesigns();
  if (!designs.on || designs.loading) return;
  designs.loading = true;
  showStatus('Paneele werden geladen …');
  try {
    const n = await loadDesigns({
      onProgress: (done, total) => showStatus(`Paneele werden geladen … ${done} von ${total}`),
    });
    showStatus(n ? `${n} ${n === 1 ? 'Design' : 'Designs'} geladen.` : 'Noch hat niemand ein Design hochgeladen.');
  } catch (err) {
    if (err instanceof SessionExpired) return;
    console.error(err);
    showStatus(NO_CONNECTION, 'error');
  } finally {
    designs.loading = false;
  }
});

// --- Start --------------------------------------------------------------------

async function start() {
  renderControls();
  const token = savedSession();
  if (!token) {
    lockPage();
    return;
  }
  session.token = token;
  showLoginStatus('Anmeldung wird wiederhergestellt …');
  try {
    const result = await whoAmI();
    if (result.status === 'ok') {
      enter(result);
      return;
    }
  } catch (err) {
    console.error(err);
  }
  session.token = null;
  saveSession();
  lockPage();
}

start();
