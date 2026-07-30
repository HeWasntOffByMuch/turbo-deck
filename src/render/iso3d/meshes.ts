import * as THREE from 'three';
import { PALETTE } from './palette.js';

/**
 * Flat-shaded, blocky mesh factories for the isometric scene (spec 018/031).
 * Every material is a single-diffuse `MeshLambertMaterial` with `flatShading` on
 * and low-poly geometry, so each face renders as one flat colour lit by the
 * single scene light -- no gradients, no specular, no smooth normals. Nothing
 * here reads sim state; callers position and colour the returned objects. The
 * primitive helpers are shared with the animated unit rigs in `rigs.ts`.
 */

/** A flat-shaded solid-colour material. Reused per colour to keep draw state small. */
const materialCache = new Map<number, THREE.MeshLambertMaterial>();
export function flatMaterial(color: number): THREE.MeshLambertMaterial {
  let mat = materialCache.get(color);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({ color, flatShading: true });
    materialCache.set(color, mat);
  }
  return mat;
}

/** Darken a hex colour by `factor` (0..1), for e.g. a mech's legs vs its chassis. */
export function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

export function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), flatMaterial(color));
}

/** A low-radial-segment cone reads as a faceted, blocky pine tier. */
export function cone(radius: number, height: number, color: number, segments = 7): THREE.Mesh {
  return new THREE.Mesh(new THREE.ConeGeometry(radius, height, segments), flatMaterial(color));
}

export function faceted(radius: number, color: number, detail = 0): THREE.Mesh {
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

/** A small flat marker dropped on the ground at the current move order. */
export function makeMoveMarker(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(9, 0), flatMaterial(PALETTE.marker));
  m.scale.y = 0.35;
  return m;
}

/**
 * A marker for a destination stacked behind the standing order (spec 040):
 * the same shape, smaller and translucent, so the plan reads as pending rather
 * than current. Its material is per-marker (not the shared cache) so it can
 * fade without tinting every other marker.
 */
export function makeQueuedMoveMarker(): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({
    color: PALETTE.marker,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(6, 0), material);
  m.scale.y = 0.35;
  m.visible = false;
  return m;
}

/**
 * A flat ground arrow pointing along the unit's heading (+x local). Parented to
 * the player group -- which is rotated by the sim's `facing` -- so the turn-rate
 * rotation (spec 028's "change direction before you can move") reads on screen.
 */
export function makeHeadingArrow(): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(30, 0);
  shape.lineTo(12, 9);
  shape.lineTo(12, -9);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2); // lay flat in the ground plane, tip toward +x
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: PALETTE.heading }));
  m.position.y = 3;
  return m;
}

/**
 * The charging attack cone (spec 028): a flat ground wedge, oriented to the
 * attack's aim, that fills as the wind-up nears its release. The scene sets its
 * geometry from the cone spec and scales/fades it by the animation progress.
 */
export function makeAttackCone(): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    color: PALETTE.attack,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  m.position.y = 2;
  m.visible = false;
  return m;
}

/**
 * A unit-radius flat ground marker for the unwalkable-terrain overlay (spec 034):
 * a faint filled disc under a brighter ring, so a blocked footprint reads as a
 * no-go zone. The scene scales it by the prop's footprint radius and drops it on
 * the ground; it never occludes the geometry above it (`depthWrite` off).
 */
export function makeUnwalkableMarker(): THREE.Group {
  const g = new THREE.Group();
  const fillGeo = new THREE.CircleGeometry(1, 28);
  fillGeo.rotateX(-Math.PI / 2);
  const fill = new THREE.Mesh(
    fillGeo,
    new THREE.MeshBasicMaterial({ color: PALETTE.blocked, transparent: true, opacity: 0.16, depthWrite: false }),
  );
  fill.position.y = 1.5;

  const ringGeo = new THREE.RingGeometry(0.82, 1, 28);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({ color: PALETTE.blocked, transparent: true, opacity: 0.55, depthWrite: false }),
  );
  ring.position.y = 1.6;

  g.add(fill, ring);
  return g;
}

/**
 * One of the arena's walls (spec 037): a stone block spanning the obstacle's
 * footprint with a lighter cap so the top face reads under the iso light. Sized
 * from the sim's rectangle, positioned by the caller at the rect's origin.
 */
export function makeWall(width: number, depth: number): THREE.Group {
  const g = new THREE.Group();
  const body = box(width, WALL_HEIGHT, depth, PALETTE.wall);
  body.position.set(width / 2, WALL_HEIGHT / 2, depth / 2);
  const cap = box(width, 4, depth, PALETTE.wallTop);
  cap.position.set(width / 2, WALL_HEIGHT + 2, depth / 2);
  g.add(body, cap);
  return g;
}

/** Wall height: tall enough to read as solid, low enough not to hide the fight. */
const WALL_HEIGHT = 46;

/** A unit-radius ground wedge centred on +x, spanning ±`arcHalf`, laid flat. */
export function sectorGeometry(arcHalf: number): THREE.BufferGeometry {
  const geo = new THREE.CircleGeometry(1, 24, -arcHalf, arcHalf * 2);
  geo.rotateX(-Math.PI / 2);
  return geo;
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
