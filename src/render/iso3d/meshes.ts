import * as THREE from 'three';
import { PALETTE, enemyColor } from './palette.js';

/**
 * Flat-shaded, blocky mesh factories for the isometric scene (spec 018). Every
 * material is a single-diffuse `MeshLambertMaterial` with `flatShading` on and
 * low-poly geometry, so each face renders as one flat colour lit by the single
 * scene light -- no gradients, no specular, no smooth normals. Nothing here
 * reads sim state; callers position and colour the returned objects.
 */

/** A flat-shaded solid-colour material. Reused per colour to keep draw state small. */
const materialCache = new Map<number, THREE.MeshLambertMaterial>();
function flatMaterial(color: number): THREE.MeshLambertMaterial {
  let mat = materialCache.get(color);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({ color, flatShading: true });
    materialCache.set(color, mat);
  }
  return mat;
}

function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), flatMaterial(color));
}

/** A low-radial-segment cone reads as a faceted, blocky pine tier. */
function cone(radius: number, height: number, color: number, segments = 7): THREE.Mesh {
  return new THREE.Mesh(new THREE.ConeGeometry(radius, height, segments), flatMaterial(color));
}

function faceted(radius: number, color: number, detail = 0): THREE.Mesh {
  // detail 0 == a 20-face icosahedron: rounded but unmistakably faceted.
  return new THREE.Mesh(new THREE.IcosahedronGeometry(radius, detail), flatMaterial(color));
}

/** A blocky conifer: a short trunk under three stacked, tapering foliage tiers. */
export function makeTree(): THREE.Group {
  const g = new THREE.Group();
  const trunk = box(10, 26, 10, PALETTE.trunk);
  trunk.position.y = 13;
  g.add(trunk);

  const tiers: readonly [number, number, number, number][] = [
    // radius, height, baseY, color
    [34, 34, 26, PALETTE.leafDeep],
    [26, 30, 44, PALETTE.leafMid],
    [17, 26, 60, PALETTE.leafBright],
  ];
  for (const [radius, height, baseY, color] of tiers) {
    const tier = cone(radius, height, color);
    tier.position.y = baseY + height / 2;
    g.add(tier);
  }
  return g;
}

/** A low rounded shrub: two overlapping faceted blobs. */
export function makeBush(): THREE.Group {
  const g = new THREE.Group();
  const big = faceted(20, PALETTE.bush);
  big.position.set(0, 14, 0);
  big.scale.y = 0.7;
  g.add(big);
  const small = faceted(13, PALETTE.bushBright);
  small.position.set(9, 20, -4);
  small.scale.y = 0.7;
  g.add(small);
  return g;
}

/**
 * The little bird-like hero from the reference art: a navy egg-body, a red
 * wing, and a pale beak, all as flat blocks. Built facing +x; the scene spins
 * the group to the aim/move direction.
 */
export function makePlayer(): THREE.Group {
  const g = new THREE.Group();
  const body = faceted(16, PALETTE.heroBody);
  body.scale.set(1.05, 0.95, 1.25);
  body.position.y = 18;
  g.add(body);
  const wing = box(10, 14, 16, PALETTE.heroWing);
  wing.position.set(2, 18, 6);
  g.add(wing);
  const beak = cone(4, 10, PALETTE.heroBeak, 5);
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(16, 20, 0);
  g.add(beak);
  const eye = faceted(2.4, PALETTE.enemyEye, 0);
  eye.position.set(12, 24, -4);
  g.add(eye);
  return g;
}

/** A blocky enemy: a coloured cube body with a single dark facing eye. */
export function makeEnemy(type: string): THREE.Group {
  const g = new THREE.Group();
  const body = box(28, 28, 28, enemyColor(type));
  body.position.y = 16;
  g.add(body);
  const eye = box(6, 8, 4, PALETTE.enemyEye);
  eye.position.set(15, 20, 0);
  g.add(eye);
  return g;
}

/** A small flat marker dropped on the ground at the current move order. */
export function makeMoveMarker(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(9, 0), flatMaterial(PALETTE.marker));
  m.scale.y = 0.35;
  return m;
}

/** The ground plane, split into a flat two-tone check so scale reads without texture. */
export function makeGround(width: number, height: number): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(width, 12, height),
    flatMaterial(PALETTE.grassDark),
  );
  base.position.set(width / 2, -6, height / 2);
  g.add(base);

  // A sparse raised check of the lighter grass for depth cues under the iso light.
  const cell = 150;
  const lightMat = flatMaterial(PALETTE.grassLight);
  for (let gy = 0; gy < height; gy += cell) {
    for (let gx = 0; gx < width; gx += cell) {
      if (((gx / cell) + (gy / cell)) % 2 !== 0) continue;
      const w = Math.min(cell, width - gx);
      const d = Math.min(cell, height - gy);
      const patch = new THREE.Mesh(new THREE.BoxGeometry(w, 1.5, d), lightMat);
      patch.position.set(gx + w / 2, 0.4, gy + d / 2);
      g.add(patch);
    }
  }
  return g;
}
