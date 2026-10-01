// geodesic.js — 3-frequency geodesic sphere (class I, icosahedral) with tile codes.
//
// Numbering convention
// --------------------
// Icosahedron faces 1–20, with the sphere's pole axis vertical:
//    1–5   top cap      (around the north pole)
//    6–10  upper belt   (pointing down)
//    11–15 lower belt   (pointing up)
//    16–20 bottom cap   (around the south pole)
// Each icosahedron face has a "tip" corner: the pole for cap faces, the pointed
// end for belt faces. Sub-faces 1–9 are numbered row by row starting at the tip:
//
//              1              <- tip
//            2 3 4
//          5 6 7 8 9
//
// Sub-faces 1, 5 and 9 touch an icosahedron vertex  -> Type 1 (60 tiles)
// All other sub-faces                                -> Type 2 (120 tiles)
// Code format: "Typ 1 - Gruppe 13 - Feld 7"  (type - icosahedron face - sub-face)
//
// To change the convention, only this file (and the SQL seed, if the type
// rule changes) needs editing.

import * as THREE from 'three';

const FREQ = 3;
const CORNER_SUBFACES = new Set([1, 5, 9]);

export function tileCode(type, icoFace, subFace) {
  return `Typ ${type} - Gruppe ${icoFace} - Feld ${subFace}`;
}

function icosahedron() {
  const lat = Math.atan(0.5);
  const r = Math.cos(lat), h = Math.sin(lat);
  const v = [new THREE.Vector3(0, 1, 0)];                       // 0: north pole
  for (let k = 0; k < 5; k++) {                                 // 1–5: upper ring
    const a = (k * 2 * Math.PI) / 5;
    v.push(new THREE.Vector3(r * Math.cos(a), h, r * Math.sin(a)));
  }
  for (let k = 0; k < 5; k++) {                                 // 6–10: lower ring
    const a = ((k + 0.5) * 2 * Math.PI) / 5;
    v.push(new THREE.Vector3(r * Math.cos(a), -h, r * Math.sin(a)));
  }
  v.push(new THREE.Vector3(0, -1, 0));                          // 11: south pole

  const U = (k) => 1 + (k % 5), L = (k) => 6 + (k % 5);
  const faces = [];                                             // [tip, b, c]
  for (let k = 0; k < 5; k++) faces.push([0, U(k), U(k + 1)]);
  for (let k = 0; k < 5; k++) faces.push([L(k), U(k + 1), U(k)]);
  for (let k = 0; k < 5; k++) faces.push([U(k + 1), L(k), L(k + 1)]);
  for (let k = 0; k < 5; k++) faces.push([11, L(k + 1), L(k)]);

  // Keep the tip first, but make b → c run counter-clockwise seen from outside.
  for (const f of faces) {
    const [a, b, c] = f.map((i) => v[i]);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const centroid = new THREE.Vector3().add(a).add(b).add(c);
    if (n.dot(centroid) < 0) [f[1], f[2]] = [f[2], f[1]];
  }
  return { vertices: v, faces };
}

// Returns 180 tiles: { code, type, icoFace, subFace, vertices:[3×Vector3],
// centroid, normal, up }  (up = in-plane direction towards the face tip)
export function buildTiles() {
  const { vertices, faces } = icosahedron();
  const tiles = [];

  faces.forEach((f, fi) => {
    const [A, B, C] = f.map((i) => vertices[i]);
    const P = (i, j) =>
      new THREE.Vector3()
        .copy(A)
        .addScaledVector(new THREE.Vector3().subVectors(B, A), i / FREQ)
        .addScaledVector(new THREE.Vector3().subVectors(C, A), j / FREQ)
        .normalize();

    // Row-by-row from the tip: up(r,0), down(r-1,0), up(r-1,1), down(r-2,1), … up(0,r)
    const tris = [];
    for (let row = 0; row < FREQ; row++) {
      for (let j = 0; j <= row; j++) {
        const i = row - j;
        tris.push([P(i, j), P(i + 1, j), P(i, j + 1)]);                 // pointing away from tip
        if (j < row) tris.push([P(i, j), P(i, j + 1), P(i - 1, j + 1)]);  // pointing towards tip
      }
    }

    tris.forEach((tri, ti) => {
      const subFace = ti + 1;
      const type = CORNER_SUBFACES.has(subFace) ? 1 : 2;
      const centroid = new THREE.Vector3().add(tri[0]).add(tri[1]).add(tri[2]).divideScalar(3);
      let normal = new THREE.Vector3()
        .subVectors(tri[1], tri[0])
        .cross(new THREE.Vector3().subVectors(tri[2], tri[0]))
        .normalize();
      if (normal.dot(centroid) < 0) {
        [tri[1], tri[2]] = [tri[2], tri[1]];
        normal.negate();
      }
      const up = new THREE.Vector3().subVectors(A, centroid);
      up.addScaledVector(normal, -up.dot(normal)).normalize();
      tiles.push({
        code: tileCode(type, fi + 1, subFace),
        type,
        icoFace: fi + 1,
        subFace,
        vertices: tri,
        centroid,
        normal,
        up,
      });
    });
  });
  return tiles;
}
