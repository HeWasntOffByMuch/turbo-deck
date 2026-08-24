/**
 * What one body's collision costs against the real arena, per tick.
 *
 * `resolveMovement` calls `slideCircle` (up to four `circleBlocked` scans) and
 * then `pushOutOfObstacles` (two more passes) for every entity, every tick. Both
 * scan `world.circles` linearly, and `world.circles` is every tree and bush in
 * the map. This measures that against the collider set the game actually loads.
 *
 *   npx tsx scripts/bench-collision.ts
 */

import { buildWorldFromMap } from '../src/server/world/build.js';
import { loadMapFile } from '../src/server/world/map-file.js';
import { pushOutOfObstacles, slideCircle } from '../src/sim/collision.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../src/server/config.js';

const shipped = loadMapFile();

const world = buildWorldFromMap(shipped.doc, shipped.mapId);
const colliders = world.colliders;

console.log(`colliders: ${colliders.rects.length} rects, ${colliders.circles.length} circles`);

const bounds = colliders.bounds;
// A ring of positions across the map, so the walk is not sitting on one spot.
const N = 20_000;
const points: { x: number; y: number }[] = [];
for (let i = 0; i < N; i += 1) {
  const t = (i / N) * Math.PI * 2 * 37;
  points.push({
    x: bounds.x + bounds.w * (0.5 + 0.35 * Math.cos(t)),
    y: bounds.y + bounds.h * (0.5 + 0.35 * Math.sin(t)),
  });
}

function bench(name: string, fn: (p: { x: number; y: number }) => unknown): number {
  const at = (i: number): { x: number; y: number } => points[i % points.length] ?? { x: 0, y: 0 };
  // Warm the JIT.
  for (let i = 0; i < 2000; i += 1) fn(at(i));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) fn(at(i));
  const t1 = process.hrtime.bigint();
  const perCall = Number(t1 - t0) / 1e6 / N;
  console.log(`  ${name.padEnd(28)} ${(perCall * 1000).toFixed(1).padStart(8)}µs/call`);
  return perCall;
}

console.log('\n=== per call, against the real arena ===');
const push = bench('pushOutOfObstacles', (p) => pushOutOfObstacles(p, SERVER_PLAYER_RADIUS, colliders));
const slide = bench('slideCircle (1 unit step)', (p) =>
  slideCircle(p, 1, 1, SERVER_PLAYER_RADIUS, colliders),
);

const perEntityTick = push + slide;
console.log(`\n  one entity's move resolution: ${(perEntityTick * 1000).toFixed(1)}µs/tick`);

console.log('\n=== cost per frame at 60Hz, by entity count ===');
for (const n of [1, 5, 10, 20, 40, 80]) {
  const perTick = perEntityTick * n;
  console.log(
    `  ${String(n).padStart(3)} entities: ${perTick.toFixed(2)}ms/tick` +
      `  -> ${((perTick / 16.67) * 100).toFixed(1)}% of a 60Hz frame`,
  );
}

console.log(
  `\n(the client predicts its own move too, so the player pays this twice per tick;` +
    ` and the tab runs the server AND the client in one thread at ${SERVER_TICK_RATE}Hz)`,
);
