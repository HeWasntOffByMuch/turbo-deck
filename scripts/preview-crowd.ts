/**
 * What a crowd actually looks like (spec 184), as a picture rather than as a
 * number.
 *
 * Every scenario here is flown through the **real `step`** -- the real router,
 * the real steering, the real blocking rule, the real attack slots -- and what
 * is drawn is the positions the server put the bodies at. Nothing is
 * re-derived for the picture, so a crowd that looks wrong here is wrong in the
 * game.
 *
 * Rasterised in software rather than photographed in a browser, for the reason
 * `preview-arcs.ts` gives: what is being looked at is a *path over time*, and a
 * screenshot of a live page is one instant of it. A trail is the whole point --
 * the failure modes this feature has are all shapes rather than states. A
 * single-file queue and a spread-out crowd look identical in a still frame
 * taken at the wrong moment; their trails do not.
 *
 * Two things are drawn that the game does not draw. Each body's **path** fades
 * from its start to its end, so the direction of travel is legible without an
 * arrow; and the last position is a filled disc at the body's true radius, so
 * "these two are overlapping" is something the eye can check rather than
 * something the caption has to claim.
 *
 *   npx tsx scripts/preview-crowd.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import { createWorldColliders } from '../src/sim/collision.js';
import type { Rect, Vec2 } from '../src/sim/types.js';
import { DEFAULT_LIVE_CONFIG } from '../src/server/config.js';
import { monsterById } from '../src/server/data/monsters.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { EntityKindValue, type ServerWorldState } from '../src/server/sim/types.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../src/server/sim/world.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
  type PersistedPlayer,
} from '../src/server/state/types.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';

const CHUNK = 100;
const O = { x: 2000, y: 2000 };

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: O.x, y: O.y, z: 0 },
  facing: 0,
  currentZone: 'greenmarch',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 100,
  resource: 100,
};
const PLAYER_STATS = computeEffectiveStats(RECORD);

function context(walls: readonly Rect[] = []): StepContext {
  const keys = new Set<string>();
  for (let cy = 0; cy <= 4000; cy += CHUNK) {
    for (let cx = 0; cx <= 4000; cx += CHUNK) keys.add(chunkKeyOf(cx, cy, CHUNK));
  }
  return {
    world: createWorldColliders(walls, [], { x: 0, y: 0, w: 4000, h: 4000 }),
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: keys,
    chunkSize: CHUNK,
    spawnPoints: [],
  };
}

/**
 * A target that outlives the picture.
 *
 * These are movement scenarios, and a target that dies half way turns them into
 * something else: the pack goes calm and stands still, which draws as a crowd
 * that stopped for no reason.
 */
function addPlayer(state: ServerWorldState, at: Vec2): { state: ServerWorldState; id: number } {
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: at.x, y: at.y, z: 0 },
    stats: { ...PLAYER_STATS, maxHealth: 1e9 } as EffectiveStats,
    radius: 16,
    health: 1e9,
    zoneId: 'greenmarch',
  });
  return { state: spawned.state, id: spawned.entity.id };
}

function addMonster(
  state: ServerWorldState,
  at: Vec2,
  targetId: number,
  moveSpeed?: number,
): { state: ServerWorldState; id: number } {
  const definition = monsterById('stalker');
  if (!definition) throw new Error('no stalker');
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: 'stalker',
    position: { x: at.x, y: at.y, z: 0 },
    stats: moveSpeed ? { ...definition.stats, moveSpeed } : definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
    targetId,
  });
  return { state: spawned.state, id: spawned.entity.id };
}

interface Body {
  readonly id: number;
  readonly radius: number;
  readonly hue: number;
  readonly trail: Vec2[];
}

interface Scene {
  readonly title: string;
  readonly walls: readonly Rect[];
  readonly bodies: readonly Body[];
  /** Deepest overlap between any two bodies on any tick, in world units. */
  readonly worstOverlap: number;
}

/** Run a scenario and record where every body went. */
function record(
  title: string,
  build: (state: ServerWorldState) => { state: ServerWorldState; hues: ReadonlyMap<number, number> },
  ticks: number,
  walls: readonly Rect[] = [],
): Scene {
  const ctx = context(walls);
  const built = build(createWorldState(9));
  let state = built.state;
  const trails = new Map<number, Vec2[]>();
  let worst = 0;

  for (let tick = 0; tick < ticks; tick++) {
    state = step(state, [], ctx).state;
    const live = [...state.entities.values()].filter(
      (one) =>
        one.health > 0 &&
        (one.kind === EntityKindValue.Monster || one.kind === EntityKindValue.Player),
    );
    for (const body of live) {
      const trail = trails.get(body.id) ?? [];
      trail.push({ x: body.position.x, y: body.position.y });
      trails.set(body.id, trail);
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        if (!a || !b) continue;
        const gap = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
        worst = Math.max(worst, a.radius + b.radius - gap);
      }
    }
  }

  const bodies: Body[] = [];
  for (const [id, trail] of trails) {
    const entity = state.entities.get(id);
    if (!entity) continue;
    bodies.push({ id, radius: entity.radius, hue: built.hues.get(id) ?? 0, trail });
  }
  return { title, walls, bodies, worstOverlap: worst };
}

// --- the five scenarios ----------------------------------------------------

const SCENES: Scene[] = [];

SCENES.push(
  record(
    '40 through open ground',
    (start) => {
      let state = start;
      const hues = new Map<number, number>();
      const player = addPlayer(state, { x: O.x + 900, y: O.y });
      state = player.state;
      hues.set(player.id, -1);
      for (let i = 0; i < 40; i++) {
        const added = addMonster(
          state,
          { x: O.x - (i % 8) * 55, y: O.y - 200 + Math.floor(i / 8) * 55 },
          player.id,
        );
        state = added.state;
        hues.set(added.id, 0);
      }
      return { state, hues };
    },
    // Long enough to arrive, not just to cross. The trails still show the
    // crossing; the discs show where forty bodies end up around one target,
    // which is concentric rings rather than a heap and is the thing worth
    // looking at. Drawn at 420 this panel showed a tidy lattice half way
    // across the field and read, wrongly, as a stall.
    900,
  ),
);

SCENES.push(
  record(
    'fast overtaking slow',
    (start) => {
      let state = start;
      const hues = new Map<number, number>();
      const player = addPlayer(state, { x: O.x + 1100, y: O.y });
      state = player.state;
      hues.set(player.id, -1);
      for (let i = 0; i < 12; i++) {
        // Alternating: half of them at two thirds speed, half at half again.
        const quick = i % 2 === 0;
        const added = addMonster(
          state,
          { x: O.x - (i % 3) * 55, y: O.y - 110 + Math.floor(i / 3) * 55 },
          player.id,
          quick ? 165 : 60,
        );
        state = added.state;
        hues.set(added.id, quick ? 1 : 2);
      }
      return { state, hues };
    },
    460,
  ),
);

{
  const gap = 96;
  const walls: Rect[] = [
    { x: O.x + 300, y: O.y - 600, w: 40, h: 600 - gap / 2 },
    { x: O.x + 300, y: O.y + gap / 2, w: 40, h: 600 },
  ];
  SCENES.push(
    record(
      '16 through a two-body gap',
      (start) => {
        let state = start;
        const hues = new Map<number, number>();
        const player = addPlayer(state, { x: O.x + 700, y: O.y });
        state = player.state;
        hues.set(player.id, -1);
        for (let i = 0; i < 16; i++) {
          const added = addMonster(
            state,
            { x: O.x - (i % 4) * 60, y: O.y - 90 + Math.floor(i / 4) * 60 },
            player.id,
          );
          state = added.state;
          hues.set(added.id, 0);
        }
        return { state, hues };
      },
      1000,
      walls,
    ),
  );
}

SCENES.push(
  record(
    '12 converging on one target',
    (start) => {
      let state = start;
      const hues = new Map<number, number>();
      const player = addPlayer(state, { x: O.x, y: O.y });
      state = player.state;
      hues.set(player.id, -1);
      for (let i = 0; i < 12; i++) {
        // All from roughly one side, which is the case that used to put every
        // body on the same point.
        const angle = (-30 + i * 5) * (Math.PI / 180);
        const added = addMonster(
          state,
          { x: O.x + Math.cos(angle) * 520, y: O.y + Math.sin(angle) * 520 },
          player.id,
        );
        state = added.state;
        hues.set(added.id, 0);
      }
      return { state, hues };
    },
    620,
  ),
);

SCENES.push(
  record(
    'two groups through each other',
    (start) => {
      let state = start;
      const hues = new Map<number, number>();
      const east = addPlayer(state, { x: O.x + 700, y: O.y });
      state = east.state;
      hues.set(east.id, -1);
      const west = addPlayer(state, { x: O.x - 700, y: O.y });
      state = west.state;
      hues.set(west.id, -1);
      for (let i = 0; i < 10; i++) {
        const goingEast = addMonster(
          state,
          { x: O.x - 400 - (i % 2) * 55, y: O.y - 130 + Math.floor(i / 2) * 55 },
          east.id,
        );
        state = goingEast.state;
        hues.set(goingEast.id, 1);
        const goingWest = addMonster(
          state,
          { x: O.x + 400 + (i % 2) * 55, y: O.y - 130 + Math.floor(i / 2) * 55 },
          west.id,
        );
        state = goingWest.state;
        hues.set(goingWest.id, 2);
      }
      return { state, hues };
    },
    1100,
  ),
);

// --- drawing ---------------------------------------------------------------

const CELL_W = 560;
const CELL_H = 380;
const PAD = 10;
const COLUMNS = 2;
const ROWS = Math.ceil(SCENES.length / COLUMNS);
const WIDTH = COLUMNS * CELL_W + (COLUMNS + 1) * PAD;
const HEIGHT = ROWS * CELL_H + (ROWS + 1) * PAD;

const png = new PNG({ width: WIDTH, height: HEIGHT });
type Rgb = readonly [number, number, number];

const INK: Rgb = [18, 20, 26];
const WALL: Rgb = [92, 84, 74];
const TARGET: Rgb = [236, 226, 168];
/** Hue 0 is one pack; 1 and 2 are the two halves of a mixed scenario. */
const PACK: readonly Rgb[] = [
  [96, 176, 232],
  [120, 214, 150],
  [232, 132, 118],
];

function put(x: number, y: number, rgb: Rgb, alpha = 1): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) return;
  const at = (py * WIDTH + px) << 2;
  for (let c = 0; c < 3; c++) {
    const held = png.data[at + c] ?? 0;
    png.data[at + c] = Math.round(held + ((rgb[c] ?? 0) - held) * alpha);
  }
  png.data[at + 3] = 255;
}

function line(a: Vec2, b: Vec2, rgb: Rgb, alpha = 1): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    put(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, rgb, alpha);
  }
}

function disc(centre: Vec2, radius: number, rgb: Rgb, alpha = 1): void {
  const r = Math.max(1, radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      put(centre.x + dx, centre.y + dy, rgb, alpha);
    }
  }
}

function ring(centre: Vec2, radius: number, rgb: Rgb, alpha = 1): void {
  const steps = Math.max(12, Math.ceil(radius * 8));
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    put(centre.x + Math.cos(angle) * radius, centre.y + Math.sin(angle) * radius, rgb, alpha);
  }
}

for (let i = 0; i < WIDTH * HEIGHT; i++) {
  png.data[(i << 2) + 0] = INK[0];
  png.data[(i << 2) + 1] = INK[1];
  png.data[(i << 2) + 2] = INK[2];
  png.data[(i << 2) + 3] = 255;
}

SCENES.forEach((scene, index) => {
  const col = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const originX = PAD + col * (CELL_W + PAD);
  const originY = PAD + row * (CELL_H + PAD);

  // One window per cell, fitted to what the scenario actually covers. Framing
  // each cell separately is right here and wrong in `preview-monsters.ts`: what
  // is being compared across these panels is a *shape*, not a size.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const body of scene.bodies) {
    for (const point of body.trail) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
  for (const wall of scene.walls) {
    minX = Math.min(minX, wall.x);
    maxX = Math.max(maxX, wall.x + wall.w);
    minY = Math.min(minY, wall.y);
    maxY = Math.max(maxY, wall.y + wall.h);
  }
  const margin = 60;
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;
  const scale = Math.min((CELL_W - 16) / (maxX - minX), (CELL_H - 26) / (maxY - minY));
  const project = (point: Vec2): Vec2 => ({
    x: originX + 8 + (point.x - minX) * scale,
    y: originY + 20 + (point.y - minY) * scale,
  });

  for (const wall of scene.walls) {
    const a = project({ x: wall.x, y: wall.y });
    const b = project({ x: wall.x + wall.w, y: wall.y + wall.h });
    for (let y = a.y; y <= b.y; y++) line({ x: a.x, y }, { x: b.x, y }, WALL, 0.85);
  }

  for (const body of scene.bodies) {
    const colour = body.hue < 0 ? TARGET : PACK[body.hue] ?? PACK[0] ?? TARGET;
    for (let i = 1; i < body.trail.length; i++) {
      const from = body.trail[i - 1];
      const to = body.trail[i];
      if (!from || !to) continue;
      // Fading from faint to solid, so which end of a trail is the end is
      // legible without drawing an arrow on it.
      const age = i / body.trail.length;
      line(project(from), project(to), colour, 0.10 + age * 0.5);
    }
    const last = body.trail[body.trail.length - 1];
    if (!last) continue;
    const at = project(last);
    disc(at, body.radius * scale, colour, 0.85);
    ring(at, body.radius * scale, [250, 250, 250], 0.35);
  }
});

mkdirSync('.claude/screenshots', { recursive: true });
writeFileSync('.claude/screenshots/crowd.png', PNG.sync.write(png));

console.log('\nwrote .claude/screenshots/crowd.png');
console.log('panels read left to right, top to bottom:\n');
for (const scene of SCENES) {
  const bodies = scene.bodies.length;
  console.log(
    `  ${scene.title.padEnd(32)} ${String(bodies).padStart(3)} bodies` +
      `   worst overlap ${scene.worstOverlap.toFixed(2).padStart(6)} units`,
  );
}
console.log(
  '\n  Overlap is measured every tick, not at the end: nothing in this game\n' +
    '  pushes a body, so an overlap is prevented rather than repaired and a\n' +
    '  final-frame check would miss every one that resolved itself.\n',
);
