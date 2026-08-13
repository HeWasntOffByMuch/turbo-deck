// Dev-only: photograph a restorative mote (spec 154) -- what it is made of, and
// what it does between leaving a body and reaching a player.
// `npx tsx scripts/preview-motes.ts`
//
// It exists because a mote is the one thing in this system a player is supposed
// to *see*, and the first version could not be seen: it spawned inside its
// owner's attract radius and was collected on the first tick it was legally
// allowed to be, which measured at 0.30 seconds -- six frames at the 20Hz
// broadcast rate. Everything about that was correct in the tests and wrong on
// the screen, which is exactly the gap a picture closes and a headless assertion
// does not.
//
// Two rows, and they check different things:
//
//   * **The object**, at 6x, both kinds. Built through the real `appearanceOf`
//     and the real `ShotRig`, so the colour is the one the game will draw and
//     not one this file picked. A mote's whole identity is its colour and its
//     roundness, and both are only checkable at a size where they are visible.
//   * **The hop**, at play scale, sampled from the *real sim*. The arc in this
//     strip is `advanceMotes` running -- not a curve drawn to look like it -- so
//     if the trajectory is wrong here it is wrong in the game.
//
// Rasterised in software rather than photographed in a browser, for the reason
// `preview-monsters.ts` is: what is being looked at is a shape and a colour, and
// this environment paints the real page at about five frames a second, which is
// no way to look at something that lasts one.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { monsterById } from '../src/server/data/monsters.js';
import { RESTORATION } from '../src/server/data/restoration.js';
import { startingBaseStats } from '../src/server/player/attributes.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { MOTE_TYPE_ID, MoteKind } from '../src/server/sim/restoration.js';
import { EntityKindValue, type ServerInput } from '../src/server/sim/types.js';
import {
  createWorldState,
  replaceEntity,
  spawnEntity,
  step,
  type StepContext,
} from '../src/server/sim/world.js';
import { EMPTY_EQUIPMENT, emptyInventory } from '../src/server/state/types.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';
import { DEFAULT_WORLD } from '../src/sim/collision.js';
import { EntityKind } from '../src/server/net/protocol.js';
import { appearanceOf } from '../src/render/iso3d/world/appearance.js';
import { ShotRig } from '../src/render/iso3d/world/shot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, '.claude/screenshots');

const BG: readonly [number, number, number] = [86, 118, 62]; // the arena's grass
const SHEET_BG: readonly [number, number, number] = [30, 31, 36];
/** The scene's isometric view direction, and a light roughly where its sun is. */
const VIEW_DIR = new THREE.Vector3(-1, -0.82, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
const AMBIENT = 0.6;

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
  /** Unlit, like the game's own `MeshBasicMaterial` orbs. */
  readonly flat: boolean;
}

/** Every triangle under `root`, in world space, with its material's colour. */
function collectTriangles(node3d: THREE.Object3D, into: Tri[] = []): Tri[] {
  node3d.updateMatrixWorld(true);
  node3d.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || mesh.visible === false) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | (THREE.Material & { color?: THREE.Color })
      | undefined;
    if (!material?.color) return;
    // A mote's orb is `MeshBasicMaterial`, which the renderer does not light.
    // Shading it here would photograph a darker sphere than the game draws --
    // which is precisely the kind of quiet infidelity that makes a preview
    // worse than no preview.
    const flat = (material as { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial === true;
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const corners = [0, 1, 2].map((k) => {
        const vi = index ? index.getX(i + k) : i + k;
        return new THREE.Vector3(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(
          mesh.matrixWorld,
        );
      });
      into.push({
        a: corners[0] as THREE.Vector3,
        b: corners[1] as THREE.Vector3,
        c: corners[2] as THREE.Vector3,
        color: material.color,
        flat,
      });
    }
  });
  return into;
}

/** A flat ring on the ground: the player's collider, for scale. */
function ring(cx: number, cz: number, radius: number, color: number, into: Tri[]): Tri[] {
  const tint = new THREE.Color(color);
  const segments = 40;
  const inner = radius - 1.4;
  const at = (angle: number, r: number): THREE.Vector3 =>
    new THREE.Vector3(cx + Math.cos(angle) * r, 0.4, cz + Math.sin(angle) * r);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    // Wound so the normal points up: the rasteriser culls back faces like the
    // real renderer, and a ring wound the other way is drawn and then discarded.
    into.push(
      { a: at(a0, inner), b: at(a1, radius), c: at(a0, radius), color: tint, flat: true },
      { a: at(a0, inner), b: at(a1, inner), c: at(a1, radius), color: tint, flat: true },
    );
  }
  return into;
}

function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/** Orthographic, z-buffered, flat-shaded, back-face culled -- as the game draws. */
function render(
  tris: readonly Tri[],
  width: number,
  height: number,
  halfExtent: number,
  centre: THREE.Vector3,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = BG[0];
    out[i * 4 + 1] = BG[1];
    out[i * 4 + 2] = BG[2];
    out[i * 4 + 3] = 255;
  }

  const forward = VIEW_DIR;
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const project = (p: THREE.Vector3): [number, number, number] => [
    p.dot(right),
    p.dot(up),
    p.dot(forward),
  ];
  const [midU, midV] = project(centre);
  const perPixel = (2 * halfExtent) / width;
  const halfV = (perPixel * height) / 2;

  const depth = new Float64Array(width * height).fill(Infinity);
  const normal = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();

  for (const t of tris) {
    const [ax, ay, az] = project(t.a);
    const [bx, by, bz] = project(t.b);
    const [cx, cy, cz] = project(t.c);

    e1.subVectors(t.b, t.a);
    e2.subVectors(t.c, t.a);
    normal.crossVectors(e1, e2).normalize();
    if (normal.dot(forward) > 0) continue;
    const lambert = t.flat ? 1 : AMBIENT + (1 - AMBIENT) * Math.max(0, normal.dot(LIGHT));
    const r = encode(t.color.r * lambert);
    const g = encode(t.color.g * lambert);
    const b = encode(t.color.b * lambert);

    const px = (u: number): number => ((u - midU) / (2 * halfExtent) + 0.5) * width;
    const py = (v: number): number => (0.5 - (v - midV) / (2 * halfV)) * height;
    const p0 = [px(ax), py(ay)] as const;
    const p1 = [px(bx), py(by)] as const;
    const p2 = [px(cx), py(cy)] as const;

    const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));

    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(area) < 1e-9) continue;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const sx = x + 0.5;
        const sy = y + 0.5;
        const w0 = ((p1[0] - p0[0]) * (sy - p0[1]) - (sx - p0[0]) * (p1[1] - p0[1])) / area;
        const w1 = ((sx - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (sy - p0[1])) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w2 * az + w1 * bz + w0 * cz;
        const at = y * width + x;
        if (z >= (depth[at] as number)) continue;
        depth[at] = z;
        out[at * 4] = r;
        out[at * 4 + 1] = g;
        out[at * 4 + 2] = b;
      }
    }
  }
  return out;
}

/** The rig the game would build for this mote, at the world position given. */
function moteRig(typeId: string, x: number, y: number, z: number): THREE.Object3D {
  const look = appearanceOf({ kind: EntityKind.Mote, typeId });
  const rig = new ShotRig(look.look ?? 'orb', look.radius, look.tint, look.detail);
  // World (x, y, z) to three's (x, height, z), the same swap `scene.ts` makes.
  rig.group.position.set(x, z, y);
  return rig.group;
}

// --- row 1: what a mote is made of ---------------------------------------

const CELL = 200;
const CLOSE_EXTENT = 13;

const kinds = [
  { id: MOTE_TYPE_ID[MoteKind.Vitality] ?? '', label: 'vitality' },
  { id: MOTE_TYPE_ID[MoteKind.Focus] ?? '', label: 'focus' },
];
const closeUps = kinds.map((kind) =>
  render(
    collectTriangles(moteRig(kind.id, 0, 0, 0)),
    CELL,
    CELL,
    CLOSE_EXTENT,
    new THREE.Vector3(0, 0, 0),
  ),
);

// --- row 2: the hop, flown through the real sim ---------------------------

const ORIGIN = { x: 900, y: 700 };
const CHUNK = 100;
const context: StepContext = {
  world: DEFAULT_WORLD,
  terrain: FLAT_TERRAIN,
  zones: new ZoneManager(),
  config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
  activeChunks: new Set(
    [...Array(13).keys()].flatMap((dy) =>
      [...Array(13).keys()].map((dx) =>
        chunkKeyOf(ORIGIN.x + (dx - 6) * CHUNK, ORIGIN.y + (dy - 6) * CHUNK, CHUNK),
      ),
    ),
  ),
  chunkSize: CHUNK,
  spawnPoints: [],
};

const stats = computeEffectiveStats({
  id: 'p',
  displayName: 'p',
  baseStats: startingBaseStats(),
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
  facing: 0,
  currentZone: 'greenmarch',
  level: 10,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 1000,
  resource: 100,
  coins: 0,
});

let state = spawnEntity(createWorldState(1), {
  kind: EntityKindValue.Player,
  typeId: 'player',
  ownerPlayerId: 'p',
  position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
  stats,
  radius: 16,
  zoneId: 'greenmarch',
}).state;
const selfId = 1;
const me = state.entities.get(selfId);
if (!me) throw new Error('no player');
// Hurt, and a tick from a mote: the fight this photographs is the one where a
// drop actually matters.
state = replaceEntity(state, {
  ...me,
  health: stats.maxHealth * 0.4,
  restoration: RESTORATION.threshold * 0.99,
});

const row = monsterById('stalker');
if (!row) throw new Error('no stalker');
const foe = spawnEntity(state, {
  kind: EntityKindValue.Monster,
  typeId: 'stalker',
  position: { x: ORIGIN.x + 58, y: ORIGIN.y, z: 0 },
  stats: { ...row.stats, maxHealth: 1 },
  radius: row.radius,
  zoneId: 'greenmarch',
  health: 1,
});
state = foe.state;
const foeId = foe.entity.id;

const input = (seq: number, cast: string): ServerInput => ({
  entityId: selfId,
  seq,
  moveX: 0,
  moveY: 0,
  facing: 0,
  buttons: 0,
  predictedX: ORIGIN.x,
  predictedY: ORIGIN.y,
  hasPrediction: false,
  seqSpan: 1,
  castAbilityId: cast,
  castTargetX: ORIGIN.x + 58,
  castTargetY: ORIGIN.y,
  castTargetEntityId: foeId,
  cancelCast: false,
});

/** Every tick a mote existed, as the positions the client would have drawn. */
const flight: { x: number; y: number; z: number; typeId: string }[] = [];
let collected = false;
for (let t = 1; t <= SERVER_TICK_RATE * 8 && !collected; t++) {
  const alive = state.entities.get(foeId);
  const result = step(
    state,
    [input(t, alive && state.entities.get(selfId)?.cast === null ? 'melee.slash' : '')],
    context,
  );
  state = result.state;
  for (const entity of state.entities.values()) {
    if (!entity.mote) continue;
    flight.push({ x: entity.position.x, y: entity.position.y, z: entity.position.z, typeId: entity.typeId });
  }
  collected = result.events.some((event) => event.kind === 'mote' && event.collected);
}

if (flight.length === 0) throw new Error('no mote was produced -- the economy is not paying out');

const STRIP_FRAMES = 8;
const STRIP_EXTENT = 80;
const strip = [...Array(STRIP_FRAMES).keys()].map((i) => {
  const sample = flight[Math.min(flight.length - 1, Math.round((i / (STRIP_FRAMES - 1)) * (flight.length - 1)))];
  const tris: Tri[] = [];
  // The player, as the ring the sim actually collides with, so the mote's size
  // and its distance are both legible against something real.
  ring(0, 0, 16, 0x1a1a1a, tris);
  ring(58, 0, row.radius, 0x3a2020, tris);
  if (sample) {
    collectTriangles(moteRig(sample.typeId, sample.x - ORIGIN.x, sample.y - ORIGIN.y, sample.z), tris);
  }
  return render(tris, CELL, CELL, STRIP_EXTENT, new THREE.Vector3(29, 12, 0));
});

// --- the sheet ------------------------------------------------------------

const GAP = 6;
const width = Math.max(kinds.length, STRIP_FRAMES) * (CELL + GAP) + GAP;
const height = 2 * (CELL + GAP) + GAP;
const png = new PNG({ width, height });
for (let i = 0; i < width * height; i++) {
  png.data[i * 4] = SHEET_BG[0];
  png.data[i * 4 + 1] = SHEET_BG[1];
  png.data[i * 4 + 2] = SHEET_BG[2];
  png.data[i * 4 + 3] = 255;
}

function blit(cell: Uint8ClampedArray, atX: number, atY: number): void {
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const from = (y * CELL + x) * 4;
      const to = ((atY + y) * width + atX + x) * 4;
      png.data[to] = cell[from] as number;
      png.data[to + 1] = cell[from + 1] as number;
      png.data[to + 2] = cell[from + 2] as number;
      png.data[to + 3] = 255;
    }
  }
}

closeUps.forEach((cell, i) => blit(cell, GAP + i * (CELL + GAP), GAP));
strip.forEach((cell, i) => blit(cell, GAP + i * (CELL + GAP), GAP + CELL + GAP));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'motes.png'), PNG.sync.write(png));

const hop = flight.filter((_, i) => i < RESTORATION.mote.launchTicks).length;
console.log(`  wrote motes.png (${width}x${height})`);
console.log(`  top row:    ${kinds.map((k) => k.label).join(', ')} at ${CLOSE_EXTENT * 2} units across`);
console.log(`  bottom row: the hop, ${STRIP_FRAMES} of ${flight.length} ticks`);
console.log(
  `  a mote lived ${flight.length} ticks = ${(flight.length / SERVER_TICK_RATE).toFixed(2)}s ` +
    `(${Math.round(flight.length / 3)} frames at the 20Hz broadcast rate)`,
);
console.log(`  of which ${hop} ticks were the hop out of the body`);
// The number this whole picture exists to defend. Before the hop and the linger
// a mote lived 18 ticks -- 0.30s -- and was reported as never being seen.
if (flight.length < RESTORATION.mote.launchTicks + RESTORATION.mote.lingerTicks) {
  console.error('  !! a mote is not lasting even its own hop and linger.');
  process.exitCode = 1;
}

// Print the path, so the picture above can be checked against numbers rather
// than read off pixels.
const first = flight[0];
const last = flight[flight.length - 1];
if (first && last) {
  console.log(
    `  path: from (${(first.x - ORIGIN.x).toFixed(0)}, ${(first.y - ORIGIN.y).toFixed(0)}, ` +
      `${first.z.toFixed(0)}) to (${(last.x - ORIGIN.x).toFixed(0)}, ` +
      `${(last.y - ORIGIN.y).toFixed(0)}, ${last.z.toFixed(0)})`,
  );
  console.log(`  the body fell at (58, 0); the player stands at (0, 0)`);
}
