/**
 * What the game actually calls too steep to walk (spec 228).
 *
 *   npx tsx scripts/probe-walkability.ts [--map maps/arena]
 *
 * Three readers decide whether a body may stand somewhere. This measures all
 * three against the same ramps and prints the angle each one really enforces,
 * which should be one number: there is no climb band, so ground is walked on at
 * full speed or it is refused.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { isWalkable, resolveMovement } from '../src/server/sim/movement.js';
import { createWorldState, spawnEntity } from '../src/server/sim/world.js';
import { EntityKindValue, type ServerInput } from '../src/server/sim/types.js';
import { monsterById } from '../src/server/data/monsters.js';
import { createWorldColliders } from '../src/sim/collision.js';
import {
  MAX_STEP_HEIGHT,
  MAX_WALK_SLOPE,
  NAV_CELL_SIZE,
  PLAYER_RADIUS,
  SLOPE_BASELINE,
} from '../src/sim/constants.js';
import { slopeFrom, walkableSlope } from '../src/sim/slope.js';
import { CHARACTERS } from '../src/sim/characters.js';
import { createNavGrid, findPath, type NavGround } from '../src/sim/pathfinding.js';
import { joinMap, MANIFEST_PATH, parseManifest } from '../src/terrain/regions.js';
import { loadMap } from '../src/terrain/map-world.js';

const DEG = 180 / Math.PI;
const deg = (slope: number): number => Math.atan(slope) * DEG;

/**
 * Ground that rises at a constant gradient everywhere, uphill along `aspect`.
 *
 * `aspect` is the compass bearing of the fall line in the nav grid's own axes,
 * which is the thing the router's answer used to depend on.
 *
 * Uniform rather than flat-then-sloped, and that is not a detail: a hill's foot
 * is a **crease**, and `slope.ts` reads the gentler side of each axis precisely
 * so a crease is not mistaken for a slope. A fixture with a foot in it measures
 * the corner instead of the hill -- which this probe did, and reported 77
 * degrees where the rule enforces 58.
 */
function ramp(gradient: number, aspect = 0): NavGround {
  const ux = Math.cos(aspect);
  const uy = Math.sin(aspect);
  return {
    heightAt: (x: number, y: number) =>
      200_000 + ((x - 300) * ux + (y - 300) * uy) * gradient,
  };
}

// --- 1. what a moving body climbs -------------------------------------------

/**
 * Walk a body straight up a ramp for two seconds and report whether it climbed.
 *
 * Driven through the real `resolveMovement`, so the axis-slide fallback and the
 * collider pass are the shipped ones rather than a re-derivation.
 */
function climbs(moveSpeed: number, slope: number, approachDeg: number): boolean {
  const definition = monsterById('grazer');
  if (!definition) throw new Error('no grazer');
  const world = createWorldColliders([], [], { x: 0, y: 0, w: 4000, h: 4000 });
  const terrain = ramp(slope);
  const spawned = spawnEntity(createWorldState(1), {
    kind: EntityKindValue.Monster,
    typeId: 'grazer',
    position: { x: 90, y: 2000, z: terrain.heightAt(90, 2000) },
    stats: { ...definition.stats, moveSpeed },
    radius: definition.radius,
    zoneId: 'greenmarch',
  });

  let entity = spawned.entity;
  // `approachDeg` off the fall line: 0 is straight at the hill, 80 is a traverse.
  const a = (approachDeg * Math.PI) / 180;
  const dir = { moveX: Math.cos(a), moveY: Math.sin(a) };
  const startX = entity.position.x;
  const startY = entity.position.y;
  for (let tick = 0; tick < SERVER_TICK_RATE * 8; tick++) {
    const input: ServerInput = {
      entityId: entity.id,
      seq: tick,
      moveX: dir.moveX,
      moveY: dir.moveY,
      facing: 0,
      buttons: 0,
      predictedX: 0,
      predictedY: 0,
      hasPrediction: false,
      seqSpan: 1,
      castAbilityId: '',
      castTargetX: 0,
      castTargetY: 0,
      castTargetEntityId: 0,
      cancelCast: false,
    };
    const outcome = resolveMovement(entity, input, {
      world,
      terrain,
      config: DEFAULT_LIVE_CONFIG,
      tick,
    });
    entity = { ...entity, position: outcome.position, facing: outcome.facing };
  }
  // Distance *travelled*, not ground gained: at 85 degrees off the fall line a
  // body barely advances uphill however legal the ground is, so measuring the
  // gain would report the approach angle rather than the slope. The ground rule
  // is direction-independent, so a body on refused ground cannot move at all --
  // which is exactly what this asks.
  return Math.hypot(entity.position.x - startX, entity.position.y - startY) > 60;
}

/** The steepest gradient a body of this speed still walks up. */
function steepestWalk(moveSpeed: number, approachDeg = 0): number {
  let lo = 0;
  let hi = 400;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (climbs(moveSpeed, mid, approachDeg)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// --- 2. what the router routes up -------------------------------------------

const BOUNDS = { x: 0, y: 0, w: 600, h: 600 };
const OPEN = createWorldColliders([], [], BOUNDS);

/**
 * Whether the router will lead a body 300 units up a hill of this gradient.
 *
 * `findPath` answers an empty list for unreachable and the *nearest reachable*
 * spot otherwise, so arriving has to be checked rather than assumed.
 */
function routes(gradient: number, aspect: number): boolean {
  const grid = createNavGrid(OPEN, PLAYER_RADIUS, NAV_CELL_SIZE, ramp(gradient, aspect));
  const ux = Math.cos(aspect);
  const uy = Math.sin(aspect);
  const from = { x: 300 - 200 * ux, y: 300 - 200 * uy };
  const to = { x: 300 + 200 * ux, y: 300 + 200 * uy };
  const path = findPath(grid, from, to);
  const end = path[path.length - 1];
  return end !== undefined && Math.hypot(end.x - to.x, end.y - to.y) <= NAV_CELL_SIZE * 2;
}

function steepestRoute(aspect: number): number {
  let lo = 0;
  let hi = 400;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (routes(mid, aspect)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// --- 3. what the ground actually is -----------------------------------------

interface SlopeCensus {
  readonly cells: number;
  readonly refused: number;
  readonly steepest: number;
  readonly percentiles: readonly { readonly p: number; readonly slope: number }[];
}

/**
 * What the shipped map is, measured the way the game measures it.
 *
 * Through `slopeFrom` at `SLOPE_BASELINE` rather than the raw per-cell
 * gradient, because those are different numbers -- the baseline smooths, and
 * the gentler-side rule is what stops a plateau's rim reading as a cliff. A
 * census of the raw gradient over-reports every band.
 */
function census(mapDir: string): SlopeCensus | null {
  const manifestPath = join(mapDir, MANIFEST_PATH);
  if (!existsSync(manifestPath)) return null;
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  const doc = joinMap(manifest, (region) => readFileSync(join(mapDir, region), 'utf8'));
  const store = loadMap(doc).store;
  const cell = store.cellSize;
  const step = Math.max(1, Math.round(SLOPE_BASELINE / cell));

  const slopes: number[] = [];
  let refused = 0;
  let steepest = 0;

  for (const layer of doc.layers) {
    const mean = (col: number, row: number): number =>
      (store.cornerHeight(layer.id, col, row) +
        store.cornerHeight(layer.id, col + 1, row) +
        store.cornerHeight(layer.id, col, row + 1) +
        store.cornerHeight(layer.id, col + 1, row + 1)) /
      4;
    for (const chunk of layer.chunks) {
      const built = store.buildChunk(layer.id, chunk.cx, chunk.cz);
      if (!built) continue;
      for (let j = 0; j < built.rows; j++) {
        for (let i = 0; i < built.cols; i++) {
          const col = built.startCol + i;
          const row = built.startRow + j;
          if (!store.cellSolid(layer.id, col, row)) continue;
          const s = slopeFrom(
            mean(col, row),
            mean(col - step, row),
            mean(col + step, row),
            mean(col, row - step),
            mean(col, row + step),
            step * cell,
            step * cell,
          );
          slopes.push(s);
          if (s > steepest) steepest = s;
          if (!walkableSlope(s)) refused++;
        }
      }
    }
  }

  slopes.sort((a, b) => a - b);
  const at = (p: number): number =>
    slopes[Math.min(slopes.length - 1, Math.floor((p / 100) * slopes.length))] ?? 0;
  return {
    cells: slopes.length,
    refused,
    steepest,
    percentiles: [50, 90, 99, 99.9].map((p) => ({ p, slope: at(p) })),
  };
}

// --- report -----------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  let mapDir = 'maps/arena';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--map') mapDir = argv[++i] ?? mapDir;
    else throw new Error(`unknown argument: ${String(argv[i])}`);
  }

  console.log('=== 1. movement: the steepest ground a body walks up ===');
  console.log('Since spec 228 this is a property of the ground, so every column should');
  console.log('read MAX_WALK_ANGLE_DEG. Before it, the same table ran 69.1 to 89.9.\n');
  console.log('  body                 speed   u/tick   head-on   at 60 deg   at 85 deg');
  const bodies: { name: string; speed: number }[] = [
    { name: 'MOVE_SPEED_HARD_MAX', speed: 550 },
    { name: 'player (Cow)', speed: CHARACTERS[0]?.moveSpeed ?? 155 },
    { name: 'ravager', speed: monsterById('ravager')?.stats.moveSpeed ?? 0 },
    { name: 'grazer', speed: monsterById('grazer')?.stats.moveSpeed ?? 0 },
  ];
  for (const body of bodies) {
    if (body.speed <= 0) continue;
    const perTick = body.speed / SERVER_TICK_RATE;
    const cells = [0, 60, 85]
      .map((a) => `${deg(steepestWalk(body.speed, a)).toFixed(1).padStart(5)} deg`)
      .join('  ');
    console.log(
      `  ${body.name.padEnd(20)} ${body.speed.toFixed(0).padStart(5)}  ${perTick.toFixed(2).padStart(6)}   ${cells}`,
    );
  }
  console.log(
    `\n  All of it should be ${deg(MAX_WALK_SLOPE).toFixed(1)} deg: one angle, ` +
      'at every speed and from every approach.',
  );

  console.log('\n=== 2. the router: the steepest hill it will plan a route up ===');
  console.log('  by which way the hill happens to face in the nav lattice:\n');
  console.log('  aspect   steepest routable');
  let lowest = Infinity;
  let highest = 0;
  for (const a of [0, 15, 30, 45, 60, 75, 90]) {
    const g = steepestRoute((a * Math.PI) / 180);
    lowest = Math.min(lowest, g);
    highest = Math.max(highest, g);
    console.log(`  ${String(a).padStart(3)} deg  ${deg(g).toFixed(1).padStart(5)} deg  (gradient ${g.toFixed(2)})`);
  }
  console.log(
    `\n  A swing of ${(deg(highest) - deg(lowest)).toFixed(1)} degrees. It was 6.2 before spec 228, ` +
      'from reading a jump rule as a slope',
  );
  console.log('  over two different runs; what is left is the cell lattice.');

  console.log('\n=== 3. the threshold, as authored ===');
  console.log(
    `  MAX_WALK_SLOPE ${MAX_WALK_SLOPE.toFixed(2)}    ${deg(MAX_WALK_SLOPE).toFixed(1).padStart(5)} deg  ` +
      '(MAX_STEP_HEIGHT / NAV_CELL_SIZE; the editor overlay imports it)',
  );
  console.log(`  SLOPE_BASELINE ${String(SLOPE_BASELINE)}      the body's own radius`);
  console.log('  There is no band above it: steep ground is refused, never slowed.');

  console.log('\n=== 4. the shipped map, measured against all three ===');
  const report = census(mapDir);
  if (!report) {
    console.log(`  ${mapDir}: no manifest, skipped`);
  } else {
    const pct = (n: number): string => `${((n / report.cells) * 100).toFixed(2)}%`;
    console.log(`  ${report.cells.toLocaleString()} solid cells, steepest ${deg(report.steepest).toFixed(1)} deg`);
    for (const { p, slope } of report.percentiles) {
      console.log(`    p${String(p).padEnd(5)} ${deg(slope).toFixed(1).padStart(5)} deg`);
    }
    console.log(`  too steep to walk               ${pct(report.refused).padStart(7)}`);
  }

  console.log('\n=== 5. the jump rule never binds on ground the slope rule allows ===');
  const perTick = 550 / SERVER_TICK_RATE;
  console.log(
    `  at MOVE_SPEED_HARD_MAX, ${perTick.toFixed(2)} u/tick x ${MAX_WALK_SLOPE.toFixed(2)} = ` +
      `${(perTick * MAX_WALK_SLOPE).toFixed(2)} against MAX_STEP_HEIGHT ${String(MAX_STEP_HEIGHT)}`,
  );
  const flat = { heightAt: () => 0 };
  console.log(`  flat ground is still walkable: ${String(isWalkable({ x: 0, y: 0, z: 0 }, 1, 0, flat))}`);
}

main();
