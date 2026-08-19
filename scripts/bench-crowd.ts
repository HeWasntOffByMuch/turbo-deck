// Dev-only: what the crowd pass costs (spec 187).
// Not part of the app. `npx tsx scripts/bench-crowd.ts`
//
// Two measurements, because they answer different questions and only one of
// them is about this feature.
//
// **The pass on its own** is the honest cost of spec 187: a synthetic crowd of
// N bodies, `solveAvoidance` and `resolveCrowding` and nothing else, so the
// number is not diluted by the tick around it. This is what has to stay small.
//
// **A whole tick** is what a server actually pays, and most of it is not this:
// a chasing monster's `pathClear` walks every collider in the world, which is
// the cost that dominates at scale and which this spec does not touch. It is
// here so the two are never confused -- a crowd feature that looked expensive
// because the router is expensive would be the wrong thing optimised.
//
// Both are wall-clock on one machine and mean nothing in absolute terms across
// machines. What they are for is the *shape*: linear in N rather than
// quadratic, and a small fraction of a 16.7ms frame at the sizes the game will
// ever field.

import { NeighbourGrid } from '../src/sim/neighbours.js';
import {
  AVOID_HORIZON_SECONDS,
  createCrowdScratch,
  resolveCrowding,
  solveAvoidance,
  type CrowdBody,
  type CrowdPush,
} from '../src/server/sim/crowd.js';
import { herd, run } from './crowd-scenarios.js';

const TICK = 1 / 60;
const PARAMS = { horizon: AVOID_HORIZON_SECONDS, timeStep: TICK };

/** A dense blob of bodies all heading the same way: the worst case for neighbour count. */
function blob(count: number): CrowdBody[] {
  const bodies: CrowdBody[] = [];
  const side = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / side);
    const column = i % side;
    // 55 units apart: touching-ish for radius 20, which is the density a herd
    // actually reaches once it has packed.
    bodies.push({
      id: i + 1,
      x: column * 55,
      y: row * 55,
      vx: 105,
      vy: 0,
      radius: 20,
      pinned: false,
      bumps: true,
      pushLimit: (105 / 60) * 0.5,
      ignoreId: -1,
      maxSpeed: 105,
      prefX: 105,
      prefY: 0,
      outX: 0,
      outY: 0,
    });
  }
  return bodies;
}

function timePass(count: number, ticks: number): { perTick: number; neighbours: number } {
  const bodies = blob(count);
  const scratch = createCrowdScratch();
  const positions: CrowdPush[] = bodies.map((body) => ({ x: body.x, y: body.y }));
  const pushes: CrowdPush[] = bodies.map(() => ({ x: 0, y: 0 }));

  // One warm run, so the measurement is not of the JIT.
  solveAvoidance(bodies, scratch, PARAMS);
  resolveCrowding(bodies, positions, scratch, pushes);

  const startedAt = Date.now();
  for (let t = 0; t < ticks; t++) {
    solveAvoidance(bodies, scratch, PARAMS);
    resolveCrowding(bodies, positions, scratch, pushes);
  }
  const perTick = (Date.now() - startedAt) / ticks;

  // How many candidates the broadphase actually hands over, which is the number
  // that would have been N in the version without one.
  const grid = new NeighbourGrid(320);
  grid.rebuild(bodies);
  let candidates = 0;
  const out: number[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    if (!body) continue;
    out.length = 0;
    candidates += grid.around(body.x, body.y, i, out);
  }
  return { perTick, neighbours: candidates / Math.max(1, bodies.length) };
}

console.log('the crowd pass on its own -- avoidance + overlap, no tick around it');
console.log('   bodies    ms/tick   us/body   candidates/body   vs N^2');
for (const count of [10, 25, 50, 100, 200, 400, 800]) {
  const ticks = count > 200 ? 200 : 600;
  const { perTick, neighbours } = timePass(count, ticks);
  const quadratic = ((count - 1) / neighbours).toFixed(1);
  console.log(
    `${String(count).padStart(9)}  ${perTick.toFixed(3).padStart(9)}  ${((perTick * 1000) / count).toFixed(2).padStart(8)}  ${neighbours.toFixed(1).padStart(17)}  ${quadratic.padStart(6)}x fewer`,
  );
}

console.log('');
console.log('a whole tick, real monsters chasing a real player over open ground');
console.log('   bodies    ms/tick   of a 16.7ms frame');
for (const count of [10, 25, 50, 100]) {
  const ticks = 240;
  const trace = run(herd(count), ticks, ticks);
  const perTick = trace.elapsedMs / ticks;
  console.log(
    `${String(count).padStart(9)}  ${perTick.toFixed(3).padStart(9)}  ${((perTick / 16.7) * 100).toFixed(1).padStart(8)}%`,
  );
}
console.log('');
console.log('Most of the second table is not this feature: a chasing body asks `pathClear`');
console.log('every tick, which walks every collider in the world. The first table is the bill');
console.log('spec 187 adds.');
