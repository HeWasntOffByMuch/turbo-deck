// Dev-only: photograph the three light fixtures (spec 250) so a human -- or an
// agent with no screen -- can see whether a stake with a box on it reads as a
// street lamp, and whether the numbers in `FIXTURE_LIGHTS` light anything.
// Not part of the app. `npx tsx scripts/preview-fixtures.ts`
//
// It draws the **real `buildPropField`**, exactly as `preview-structures.ts`
// does and for that script's reason: what is rasterised is the geometry the game
// builds, and the only thing faked is the rasteriser, because there is no GPU in
// a container.
//
// Which is also what it deliberately does *not* show. Since spec 250 a
// campfire's fire is paint rather than geometry -- `fire_camp`, played at the
// middle of the ring by `world/fire-vfx.ts` -- so the campfire here is stones,
// charred logs and an ember bed and nothing that moves. That is the right
// subject for this sheet: it is judging the thing the light comes *out* of, and
// the fire is judged on `preview-brush-vfx.ts`'s, where a particle system can be
// stepped.
//
// What it adds over that one is the half a fixture is *for*. The rasteriser has
// a **point light** in it, transcribed from three's own
// `getDistanceAttenuation` -- the physical branch, which is what this renderer
// runs -- and driven by `pointIntensity` and `fixtureLight`, so the pool of
// light on the ground is the one the game will throw. A preview that drew the
// geometry under a flat ambient would be a picture of a lamp with no opinion
// about whether it is a *light*, which is the only question worth asking here.
//
// Four rows, each answering a different question.
//   1. Each fixture from the game's own bearing, with a body-sized block beside
//      it. Scale is the risk with anything a person stands next to: a lamp post
//      that is subtly too short looks fine alone and wrong beside a figure.
//   2. The same three under their own light in the dark, which is the picture
//      the numbers actually produce.
//   3. A campfire at three brightnesses, which is the editor's slider band, so
//      the ends of it can be judged rather than guessed at.
//   4. A lit square: two lamps and a fire, at the spacing a street wants, from
//      the game's bearing. What is being judged is whether the pools of light
//      join up or leave a hole between them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { buildPropField } from '../src/render/iso3d/props.js';
import { pointIntensity } from '../src/render/iso3d/player-lights.js';
import {
  FIXTURE_KINDS,
  FIXTURE_LIGHTS,
  fixtureLight,
  footprintRadius,
  type FixtureKind,
  type Prop,
} from '../src/terrain/vegetation.js';
import { PLAYER_RADIUS } from '../src/sim/constants.js';
import { FIXED_DAYLIGHT } from '../src/render/iso3d/daynight.js';

const SIZE = Number(process.env['SIZE'] ?? 300);
const GAP = 8;
const BG: readonly [number, number, number] = [58, 60, 68];

/** Roughly the game's isometric bearing. */
const VIEW_DIR = new THREE.Vector3(-1, -0.6, -1).normalize();
/** The sun, for the daylight row. */
const SUN = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
/** About what a unit measures: `PLAYER_RADIUS` across, a body tall. */
const BODY_HEIGHT = 56;

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
  /**
   * What this triangle gives off regardless of what falls on it (spec 263).
   *
   * Read off the material rather than assumed, and the reason is the bug this
   * sheet exists to have caught and did not: a lamp's mantle stands *inside* its
   * own point light, so every face of it has that light behind it and takes
   * nothing from the loop below. A preview that shaded a glowing part like any
   * other would go on drawing the grey box the game used to.
   */
  readonly emissive: THREE.Color;
}

/** For the sheet's own scenery -- the floor and the scale block -- which glows not at all. */
const NO_GLOW = new THREE.Color(0, 0, 0);

/** A point light as the rasteriser applies one. See the header. */
interface Lamp {
  readonly at: THREE.Vector3;
  readonly color: THREE.Color;
  readonly intensity: number;
  readonly distance: number;
}

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
      const material = mesh.material as THREE.MeshLambertMaterial;
      const color = new THREE.Color();
      if (mesh.isInstancedMesh && mesh.instanceColor) mesh.getColorAt(n, color);
      else color.copy(material.color);
      // `instanceColor` multiplies the diffuse and nothing else, which is why
      // this one is taken off the material and not off the instance.
      const emissive = material.emissive
        ? material.emissive.clone().multiplyScalar(material.emissiveIntensity ?? 1)
        : new THREE.Color(0, 0, 0);
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
          emissive,
        });
      }
    }
  });
  return tris;
}

function box(cx: number, cy: number, cz: number, w: number, h: number, d: number, hex: number): Tri[] {
  const color = new THREE.Color().setHex(hex);
  const v = (sx: number, sy: number, sz: number): THREE.Vector3 =>
    new THREE.Vector3(cx + (sx * w) / 2, cy + (sy * h) / 2, cz + (sz * d) / 2);
  const corner = [
    v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1),
    v(-1, 1, -1), v(1, 1, -1), v(1, 1, 1), v(-1, 1, 1),
  ] as const;
  const face = (a: number, b: number, c: number, d2: number): Tri[] => [
    { a: corner[a] as THREE.Vector3, b: corner[b] as THREE.Vector3, c: corner[c] as THREE.Vector3, color, emissive: NO_GLOW },
    { a: corner[a] as THREE.Vector3, b: corner[c] as THREE.Vector3, c: corner[d2] as THREE.Vector3, color, emissive: NO_GLOW },
  ];
  return [
    ...face(4, 7, 6, 5),
    ...face(0, 1, 2, 3),
    ...face(3, 2, 6, 7),
    ...face(1, 0, 4, 5),
    ...face(0, 3, 7, 4),
    ...face(2, 1, 5, 6),
  ];
}

/**
 * The ground, cut into a grid rather than drawn as one quad.
 *
 * `preview-structures.ts` uses a single slab and is right to: it is judging a
 * silhouette under a directional light, which is constant over a flat surface.
 * A point light is not -- it falls off with distance -- and this rasteriser
 * shades per *triangle*, so one quad would take one sample of the light at its
 * own centroid and paint the whole floor that colour. The pool of light **is**
 * the thing being looked at, so the floor has to be finely enough divided to
 * show one.
 */
function ground(halfSpan: number, cells = 48): Tri[] {
  const tris: Tri[] = [];
  const step = (halfSpan * 2) / cells;
  const color = new THREE.Color().setHex(0x6f8a4a);
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const x0 = -halfSpan + i * step;
      const z0 = -halfSpan + j * step;
      const p = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, 0, z);
      tris.push(
        { a: p(x0, z0), b: p(x0 + step, z0), c: p(x0 + step, z0 + step), color, emissive: NO_GLOW },
        { a: p(x0, z0), b: p(x0 + step, z0 + step), c: p(x0, z0 + step), color, emissive: NO_GLOW },
      );
    }
  }
  return tris;
}

const saturate = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * three's own point-light falloff, transcribed.
 *
 * The physical branch of `getDistanceAttenuation` -- `LEGACY_LIGHTS` is off in
 * this renderer -- so what this preview shows is what the frame shows. A
 * falloff written from memory would be a preview that flatters or punishes every
 * number in `FIXTURE_LIGHTS` by some amount nobody could measure.
 */
function attenuation(distance: number, cutoff: number): number {
  let falloff = 1 / Math.max(distance * distance, 0.01);
  if (cutoff > 0) {
    const w = saturate(1 - Math.pow(distance / cutoff, 4));
    falloff *= w * w;
  }
  return falloff;
}

/** Linear-sRGB to sRGB, the transfer WebGL applies on the way to the screen. */
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

interface Lighting {
  /** Flat fill, so a shot in the dark is not black. */
  readonly ambient: number;
  /** Directional strength. 0 for the night shots. */
  readonly sun: number;
  readonly lamps: readonly Lamp[];
}

function render(
  tris: readonly Tri[],
  size: number,
  forward: THREE.Vector3,
  fit: number,
  lighting: Lighting,
): Uint8ClampedArray {
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

  const scale = size / fit;
  const toPixel = (p: THREE.Vector3): [number, number, number] => {
    const [u, v, d] = project(p);
    return [size / 2 + u * scale, size * 0.62 - v * scale, d];
  };

  const depth = new Float64Array(size * size).fill(Infinity);
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const toLight = new THREE.Vector3();
  for (const tri of tris) {
    const [ax, ay, az] = toPixel(tri.a);
    const [bx, by, bz] = toPixel(tri.b);
    const [cx, cy, cz] = toPixel(tri.c);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) continue;

    normal.crossVectors(ab.subVectors(tri.b, tri.a), ac.subVectors(tri.c, tri.a)).normalize();
    centroid.copy(tri.a).add(tri.b).add(tri.c).multiplyScalar(1 / 3);

    // Per triangle, which is what makes this a *flat*-shaded renderer and is
    // why the floor above is a grid. The light is sampled at the centroid.
    let r = lighting.ambient;
    let g = lighting.ambient;
    let b = lighting.ambient;
    const lambert = Math.max(0, normal.dot(SUN)) * lighting.sun;
    r += lambert;
    g += lambert;
    b += lambert;
    for (const lamp of lighting.lamps) {
      toLight.subVectors(lamp.at, centroid);
      const distance = toLight.length();
      if (distance <= 0) continue;
      toLight.multiplyScalar(1 / distance);
      const facing = Math.max(0, normal.dot(toLight));
      if (facing <= 0) continue;
      const irradiance = lamp.intensity * attenuation(distance, lamp.distance) * facing;
      r += lamp.color.r * irradiance;
      g += lamp.color.g * irradiance;
      b += lamp.color.b * irradiance;
    }

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
        // Added after the lighting, which is what emissive means: a part that
        // emits is bright in the dark, and no dimmer at noon.
        out[at * 4] = encode(tri.color.r * r + tri.emissive.r);
        out[at * 4 + 1] = encode(tri.color.g * g + tri.emissive.g);
        out[at * 4 + 2] = encode(tri.color.b * b + tri.emissive.b);
      }
    }
  }
  return out;
}

function fixture(kind: FixtureKind, x: number, z: number, scale = 1, light?: Prop['light']): Prop {
  return {
    kind,
    x,
    y: z,
    scale,
    rotation: 0,
    tint: (((x * 7 + z * 13) % 200) / 100) - 1,
    ...(light ? { light } : {}),
  };
}

/** The lamps a set of props throws, exactly as the scene composes them. */
function lampsFor(props: readonly Prop[]): Lamp[] {
  const out: Lamp[] = [];
  for (const prop of props) {
    const lit = fixtureLight(prop);
    if (!lit) continue;
    out.push({
      at: new THREE.Vector3(prop.x, lit.height * prop.scale, prop.y),
      color: new THREE.Color().setHex(lit.color),
      intensity: pointIntensity(lit.brightness, lit.radius),
      distance: lit.radius,
    });
  }
  return out;
}

/** Daylight: what `preview-structures.ts` draws, so a silhouette can be judged. */
const DAY: Omit<Lighting, 'lamps'> = { ambient: 0.55, sun: 0.45 };
/** Night: a floor of fill, and everything else is the fixture's own light. */
const NIGHT: Omit<Lighting, 'lamps'> = { ambient: 0.1, sun: 0 };

interface Shot {
  readonly label: string;
  readonly props: readonly Prop[];
  readonly fit: number;
  readonly night: boolean;
  readonly body?: readonly [number, number];
}

const SQUARE = 190;

const SHOTS: readonly Shot[] = [
  ...FIXTURE_KINDS.map((kind) => ({
    label: `${kind}, daylight`,
    props: [fixture(kind, 0, 0)],
    fit: 320,
    night: false,
    body: [90, 30] as const,
  })),
  ...FIXTURE_KINDS.map((kind) => ({
    label: `${kind}, lit`,
    props: [fixture(kind, 0, 0)],
    fit: 700,
    night: true,
    body: [90, 30] as const,
  })),
  {
    label: 'campfire, dim',
    props: [fixture('campfire', 0, 0, 1, { brightness: 0.6, radius: FIXTURE_LIGHTS.campfire.radius })],
    fit: 700,
    night: true,
  },
  {
    label: 'campfire, authored',
    props: [fixture('campfire', 0, 0)],
    fit: 700,
    night: true,
  },
  {
    label: 'campfire, bright',
    props: [fixture('campfire', 0, 0, 1, { brightness: 5, radius: FIXTURE_LIGHTS.campfire.radius })],
    fit: 700,
    night: true,
  },
  {
    label: 'a lit square',
    props: [
      fixture('lamp-post', -SQUARE, -SQUARE),
      fixture('lamp-post', SQUARE, SQUARE),
      fixture('campfire', 0, 0),
      fixture('torch-stand', SQUARE, -SQUARE),
    ],
    fit: 1100,
    night: true,
    body: [40, 120],
  },
  {
    label: 'a lit square, daylight',
    props: [
      fixture('lamp-post', -SQUARE, -SQUARE),
      fixture('lamp-post', SQUARE, SQUARE),
      fixture('campfire', 0, 0),
      fixture('torch-stand', SQUARE, -SQUARE),
    ],
    fit: 1100,
    night: false,
    body: [40, 120],
  },
  {
    label: 'lamps only, lit',
    props: [fixture('lamp-post', -SQUARE * 0.7, 0), fixture('lamp-post', SQUARE * 0.7, 0)],
    fit: 1100,
    night: true,
    body: [0, 0],
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
    tris.push(...box(bx, BODY_HEIGHT / 2, bz, PLAYER_RADIUS * 2, BODY_HEIGHT, PLAYER_RADIUS * 2, 0xd0407a));
  }
  const base = shot.night ? NIGHT : DAY;
  const pixels = render(tris, SIZE, VIEW_DIR, shot.fit, { ...base, lamps: lampsFor(shot.props) });
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

/**
 * What a fixture actually puts on the ground, at a spread of distances.
 *
 * The number worth printing, and the one a picture is bad at: what a designer
 * sets is `brightness`, which is defined at *half range on a surface facing the
 * light* -- and the ground is not facing it. A flame `h` above the ground seen
 * from `d` away lands at a grazing angle of `h / hypot(h, d)`, so a campfire's
 * 22-unit flame delivers about a tenth of its own brightness at a couple of
 * hundred units while a lamp post's 122 delivers half of it. Two fixtures with
 * the same brightness therefore light the ground quite differently, and no
 * amount of looking at a thumbnail says by how much.
 *
 * Against `FIXED_DAYLIGHT.ambientIntensity`, because that is what a lit patch has
 * to stand out from: a pool below the ambient is a light nobody can see is on.
 */
function groundIlluminance(kind: FixtureKind, at: number): number {
  const lit = FIXTURE_LIGHTS[kind];
  const distance = Math.hypot(lit.height, at);
  const facing = lit.height / distance;
  return pointIntensity(lit.brightness, lit.radius) * attenuation(distance, lit.radius) * facing;
}

/**
 * The ambient at midnight, which is the one a fixture is actually judged
 * against.
 *
 * A lamp at noon should do very little and does; what it is *for* is the dark
 * end of the cycle, where the ambient is a third of the daylight one and a
 * cold blue on top of that. Both are printed because the threshold moves by
 * about a factor of three between them, and a table tuned against the wrong one
 * is a set of lights that either do nothing or blow out.
 */
const NIGHT_AMBIENT = 0.55;

console.log('');
console.log(
  `ambient is ${FIXED_DAYLIGHT.ambientIntensity.toFixed(2)} by day and` +
    ` ${NIGHT_AMBIENT.toFixed(2)} at midnight; a pool has to beat it to be seen`,
);
for (const kind of FIXTURE_KINDS) {
  const lit = FIXTURE_LIGHTS[kind];
  const at = [0.15, 0.3, 0.5, 0.8].map(
    (fraction) => `${(fraction * 100).toFixed(0)}%:${groundIlluminance(kind, lit.radius * fraction).toFixed(2)}`,
  );
  console.log(
    `${kind.padEnd(12)} brightness ${lit.brightness.toFixed(2)}` +
      `  reach ${String(lit.radius).padStart(4)}` +
      `  flame at ${String(lit.height).padStart(3)}` +
      `  blocks ${footprintRadius(fixture(kind, 0, 0)).toFixed(0)}` +
      `  ground ${at.join(' ')}`,
  );
}
console.log('');
for (const kind of FIXTURE_KINDS) {
  const lit = FIXTURE_LIGHTS[kind];
  // How far out the pool is still brighter than the sky is, which is the number
  // a level designer is really placing a lamp by: past it, the light is on and
  // nobody can tell.
  const reach = (ambient: number): string => {
    for (let d = lit.radius; d > 0; d -= 2) {
      if (groundIlluminance(kind, d) >= ambient) {
        return `${String(Math.round(d))} (${((d / lit.radius) * 100).toFixed(0)}% of reach)`;
      }
    }
    return 'nowhere';
  };
  console.log(
    `${kind.padEnd(12)} reads out to ${reach(NIGHT_AMBIENT).padEnd(22)} at night,` +
      ` ${reach(FIXED_DAYLIGHT.ambientIntensity)} by day`,
  );
}

mkdirSync('.claude/screenshots', { recursive: true });
const out = '.claude/screenshots/fixtures.png';
writeFileSync(out, PNG.sync.write(sheet));
console.log(`\nwrote ${out} (${sheet.width}x${sheet.height})`);
