// Dev-only: photograph the village props (spec 224) so a human -- or an agent
// with no screen -- can see whether a box with a triangle on it actually reads
// as a house. Not part of the app. `npx tsx scripts/preview-structures.ts`
//
// It draws the **real `buildPropField`**, so what is rasterised is exactly the
// geometry the game builds: the same batches, the same per-instance tint, the
// same offsets. The only thing faked is the rasteriser, which is here because
// there is no GPU in a container.
//
// Three rows, and each answers a different question.
//   1. Each building from the game's own bearing, with a **body-sized block**
//      beside it. Scale is the whole risk with a building: a hut that is
//      subtly too big looks fine alone and wrong the moment somebody stands
//      next to it, which is the same argument `preview-monsters.ts` makes for
//      drawing every monster in one world-space window.
//   2. The hut turned through four facings. The door and the ridge are what say
//      which way a building faces, and a facing slider that turned the offsets
//      the opposite way to the mesh would show up here and nowhere else.
//   3. A village: four huts round a well, at the distance the editor's spacing
//      actually puts them, from two heights. What is being judged is whether a
//      cluster reads as a settlement rather than as four separate props.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { buildPropField } from '../src/render/iso3d/props.js';
import { footprintRadius, HOUSE_PLAN, type Prop } from '../src/terrain/vegetation.js';
import { PLAYER_RADIUS } from '../src/sim/constants.js';

const SIZE = Number(process.env['SIZE'] ?? 300);
const GAP = 8;
const BG: readonly [number, number, number] = [58, 60, 68];

/** Roughly the game's isometric bearing, and a light near where its sun is. */
const VIEW_DIR = new THREE.Vector3(-1, -0.6, -1).normalize();
/** A lower and a higher seat, for the village row. */
const LOW_DIR = new THREE.Vector3(-1, -0.32, -1).normalize();
const HIGH_DIR = new THREE.Vector3(-1, -1.5, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
const AMBIENT = 0.55;

/** About what a unit measures: `PLAYER_RADIUS` across, a body tall. */
const BODY_HEIGHT = 56;

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
}

/** Every triangle of a built field in world space, one copy per instance. */
function collectTriangles(root: THREE.Object3D): Tri[] {
  const tris: Tri[] = [];
  root.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  root.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    const instances = mesh.isInstancedMesh ? mesh.count : 1;
    for (let n = 0; n < instances; n++) {
      if (mesh.isInstancedMesh) mesh.getMatrixAt(n, matrix);
      else matrix.identity();
      matrix.premultiply(mesh.matrixWorld);
      const color = new THREE.Color();
      if (mesh.isInstancedMesh && mesh.instanceColor) mesh.getColorAt(n, color);
      else color.copy((mesh.material as THREE.MeshLambertMaterial).color);
      for (let i = 0; i < count; i += 3) {
        const corners = [0, 1, 2].map((k) => {
          const vi = index ? index.getX(i + k) : i + k;
          return point.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(matrix).clone();
        });
        tris.push({
          a: corners[0] as THREE.Vector3,
          b: corners[1] as THREE.Vector3,
          c: corners[2] as THREE.Vector3,
          color: color.clone(),
        });
      }
    }
  });
  return tris;
}

/** A box of loose triangles, for the things this preview draws that the game
 *  does not: the scale reference and the ground pad under it. */
function box(
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  hex: number,
): Tri[] {
  const color = new THREE.Color().setHex(hex);
  const v = (sx: number, sy: number, sz: number): THREE.Vector3 =>
    new THREE.Vector3(cx + (sx * w) / 2, cy + (sy * h) / 2, cz + (sz * d) / 2);
  const corner = [
    v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1),
    v(-1, 1, -1), v(1, 1, -1), v(1, 1, 1), v(-1, 1, 1),
  ] as const;
  const face = (a: number, b: number, c: number, d2: number): Tri[] => [
    { a: corner[a] as THREE.Vector3, b: corner[b] as THREE.Vector3, c: corner[c] as THREE.Vector3, color },
    { a: corner[a] as THREE.Vector3, b: corner[c] as THREE.Vector3, c: corner[d2] as THREE.Vector3, color },
  ];
  return [
    ...face(4, 7, 6, 5), // top
    ...face(0, 1, 2, 3), // bottom
    ...face(3, 2, 6, 7), // +z
    ...face(1, 0, 4, 5), // -z
    ...face(0, 3, 7, 4), // -x
    ...face(2, 1, 5, 6), // +x
  ];
}

/** The ground, as one big flat quad, so a building is seen standing on something. */
function ground(halfSpan: number): Tri[] {
  return box(0, -2, 0, halfSpan * 2, 4, halfSpan * 2, 0x6f8a4a);
}

/** Linear-sRGB to sRGB, the transfer WebGL applies on the way to the screen. */
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/** Orthographic, z-buffered, flat-shaded -- the same three properties the game has. */
function render(tris: readonly Tri[], size: number, forward: THREE.Vector3, fit: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = BG[0] as number;
    out[i * 4 + 1] = BG[1] as number;
    out[i * 4 + 2] = BG[2] as number;
    out[i * 4 + 3] = 255;
  }
  if (tris.length === 0) return out;

  const worldUp = Math.abs(forward.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const project = (p: THREE.Vector3): [number, number, number] => [p.dot(right), p.dot(up), p.dot(forward)];

  // A fixed world-space window rather than one fitted per panel, so two
  // buildings side by side really are the same scale and can be compared --
  // which is the only thing a sheet of buildings is for.
  const scale = size / fit;
  const toPixel = (p: THREE.Vector3): [number, number, number] => {
    const [u, v, d] = project(p);
    return [size / 2 + u * scale, size * 0.62 - v * scale, d];
  };

  const depth = new Float64Array(size * size).fill(Infinity);
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const tri of tris) {
    const [ax, ay, az] = toPixel(tri.a);
    const [bx, by, bz] = toPixel(tri.b);
    const [cx, cy, cz] = toPixel(tri.c);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) continue;

    normal.crossVectors(ab.subVectors(tri.b, tri.a), ac.subVectors(tri.c, tri.a)).normalize();
    const lambert = Math.max(0, normal.dot(LIGHT));
    const shade = AMBIENT + (1 - AMBIENT) * lambert;

    const loX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const hiX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const loY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const hiY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = loY; y <= hiY; y++) {
      for (let x = loX; x <= hiX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area;
        const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        const d = az + w1 * (bz - az) + w0 * (cz - az);
        const at = y * size + x;
        if (d >= (depth[at] as number)) continue;
        depth[at] = d;
        out[at * 4] = encode(tri.color.r * shade);
        out[at * 4 + 1] = encode(tri.color.g * shade);
        out[at * 4 + 2] = encode(tri.color.b * shade);
      }
    }
  }
  return out;
}

interface Shot {
  readonly label: string;
  readonly props: readonly Prop[];
  readonly forward: THREE.Vector3;
  readonly fit: number;
  /** Draw a body-sized block for scale. */
  readonly body?: readonly [number, number];
}

const hut = (x: number, z: number, yawDeg: number, scale = 1): Prop => ({
  kind: 'house',
  x,
  y: z,
  scale,
  rotation: (yawDeg * Math.PI) / 180,
  tint: (((x * 7 + z * 13) % 200) / 100) - 1,
});
const well = (x: number, z: number, scale = 1): Prop => ({
  kind: 'well',
  x,
  y: z,
  scale,
  rotation: 0,
  tint: 0,
});
/**
 * A sign (spec 259).
 *
 * The message is not drawn -- the board is blank timber and the words are in
 * the bubble -- so what these shots are for is the *silhouette*: whether a post
 * and a board read as a sign at all from a hundred units up, and whether the
 * board is broadside to the way its facing points it.
 */
const signpost = (x: number, z: number, yawDeg: number, scale = 1): Prop => ({
  kind: 'sign',
  x,
  y: z,
  scale,
  rotation: (yawDeg * Math.PI) / 180,
  tint: (((x * 5 + z * 11) % 200) / 100) - 1,
  text: 'Hearthstead, two miles',
});

/**
 * How far the huts stand from the well, in the village shots.
 *
 * Two and a half footprints, which leaves a square between them rather than a
 * terrace: at 1.9 the huts nearly touched and the one nearest the camera hid
 * the well outright, which is a fact about where this preview put them and not
 * about either prop.
 */
const SPREAD = footprintRadius(hut(0, 0, 0)) * 2.5;

const SHOTS: readonly Shot[] = [
  { label: 'house', props: [hut(0, 0, 0)], forward: VIEW_DIR, fit: 460, body: [120, 40] },
  { label: 'well', props: [well(0, 0)], forward: VIEW_DIR, fit: 460, body: [80, 20] },
  { label: 'house + well', props: [hut(-70, 0, 0), well(90, 30)], forward: VIEW_DIR, fit: 460, body: [30, 120] },

  // Beside a body block, because a sign is the one prop here whose whole job is
  // to be read at standing height: too tall and it is a gallows, too short and
  // it is a stump, and neither is visible without something to compare it to.
  { label: 'sign', props: [signpost(0, 0, 0)], forward: VIEW_DIR, fit: 260, body: [70, 0] },
  // The facing is the only thing a level designer sets about a sign, so it gets
  // its own row: a board edge-on to the road it labels is the failure.
  { label: 'sign facing 0', props: [signpost(0, 0, 0)], forward: VIEW_DIR, fit: 240 },
  { label: 'sign facing 90', props: [signpost(0, 0, 90)], forward: VIEW_DIR, fit: 240 },
  { label: 'sign facing 180', props: [signpost(0, 0, 180)], forward: VIEW_DIR, fit: 240 },

  { label: 'facing 0', props: [hut(0, 0, 0)], forward: VIEW_DIR, fit: 380 },
  { label: 'facing 90', props: [hut(0, 0, 90)], forward: VIEW_DIR, fit: 380 },
  { label: 'facing 180', props: [hut(0, 0, 180)], forward: VIEW_DIR, fit: 380 },

  {
    label: 'village',
    props: [
      hut(-SPREAD, -SPREAD * 0.55, 30),
      hut(SPREAD * 0.9, -SPREAD * 0.7, -20, 1.15),
      hut(-SPREAD * 0.75, SPREAD * 0.95, 150, 0.85),
      hut(SPREAD * 1.05, SPREAD * 0.6, 200),
      well(0, 0),
    ],
    forward: VIEW_DIR,
    fit: 1050,
    body: [SPREAD * 0.35, SPREAD * 0.3],
  },
  {
    label: 'village, low',
    props: [
      hut(-SPREAD, -SPREAD * 0.55, 30),
      hut(SPREAD * 0.9, -SPREAD * 0.7, -20, 1.15),
      hut(-SPREAD * 0.75, SPREAD * 0.95, 150, 0.85),
      hut(SPREAD * 1.05, SPREAD * 0.6, 200),
      well(0, 0),
    ],
    forward: LOW_DIR,
    fit: 1050,
    body: [SPREAD * 0.35, SPREAD * 0.3],
  },
  {
    label: 'village, overhead',
    props: [
      hut(-SPREAD, -SPREAD * 0.55, 30),
      hut(SPREAD * 0.9, -SPREAD * 0.7, -20, 1.15),
      hut(-SPREAD * 0.75, SPREAD * 0.95, 150, 0.85),
      hut(SPREAD * 1.05, SPREAD * 0.6, 200),
      well(0, 0),
    ],
    forward: HIGH_DIR,
    fit: 1050,
    body: [SPREAD * 0.35, SPREAD * 0.3],
  },
];

const cols = 3;
const rows = Math.ceil(SHOTS.length / cols);
const sheet = new PNG({ width: cols * (SIZE + GAP), height: rows * (SIZE + GAP), colorType: 6 });
for (let i = 0; i < sheet.data.length; i += 4) {
  sheet.data[i] = 30;
  sheet.data[i + 1] = 31;
  sheet.data[i + 2] = 36;
  sheet.data[i + 3] = 255;
}

SHOTS.forEach((shot, index) => {
  const field = buildPropField(shot.props, () => 0);
  const tris = [...ground(shot.fit), ...collectTriangles(field.group)];
  if (shot.body) {
    const [bx, bz] = shot.body;
    // A body, drawn in something no palette tone uses so it cannot be mistaken
    // for part of a building.
    tris.push(...box(bx, BODY_HEIGHT / 2, bz, PLAYER_RADIUS * 2, BODY_HEIGHT, PLAYER_RADIUS * 2, 0xd0407a));
  }
  const pixels = render(tris, SIZE, shot.forward, shot.fit);
  field.dispose();

  const column = index % cols;
  const row = Math.floor(index / cols);
  const ox = column * (SIZE + GAP);
  const oy = row * (SIZE + GAP);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const from = (y * SIZE + x) * 4;
      const to = ((oy + y) * sheet.width + ox + x) * 4;
      sheet.data[to] = pixels[from] as number;
      sheet.data[to + 1] = pixels[from + 1] as number;
      sheet.data[to + 2] = pixels[from + 2] as number;
      sheet.data[to + 3] = 255;
    }
  }
  console.log(`${row},${column}: ${shot.label} (${shot.props.length} props, ${tris.length} triangles)`);
});

mkdirSync('.claude/screenshots', { recursive: true });
const out = '.claude/screenshots/structures.png';
writeFileSync(out, PNG.sync.write(sheet));
console.log(`\nhut plan ${HOUSE_PLAN.width} x ${HOUSE_PLAN.depth}, footprint ${footprintRadius(hut(0, 0, 0)).toFixed(1)}`);
console.log(`wrote ${out} (${sheet.width}x${sheet.height})`);
