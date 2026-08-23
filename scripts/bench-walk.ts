/**
 * What walking costs the prop field, and what the completeness rule takes off it
 * (spec 180).
 *
 * The rule was reasoned about and shipped without being counted: a 1100-unit
 * prop region spans two chunk columns, walking east those columns arrive a
 * chunk-crossing apart, so the old settle rebuilt the region on the first and
 * again on the second. That predicts a factor of two. Predicting is not
 * measuring, and a rebuild is 34ms of main thread -- a dropped frame each time
 * -- so the factor is the whole value of the rule.
 *
 * A real `GameServer` over the shipped arena, a real `GameClient` asking for
 * chunks the way the tab does, and a real walk. Two `ChunkIngest` ledgers are
 * fed the identical arrivals on the identical clock, one with the rule and one
 * without, so the comparison is not two runs that might have streamed
 * differently -- it is one stream, judged twice.
 *
 * Node, because the browser cannot answer it: `probe-streaming.ts` paints at
 * about four frames a second under software GL, and a count of rebuilds there
 * would be a count of what fits in a 250ms frame.
 *
 *   npx tsx scripts/bench-walk.ts
 */


import { GameServer } from '../src/server/server.js';
import { GameClient } from '../src/server/client/game-client.js';
import { LoopbackTransport } from '../src/server/net/transport-loop.js';
import { StreamedMap } from '../src/server/client/streamed-map.js';
import { ChunkIngest, type WorldRect } from '../src/render/iso3d/world/chunk-ingest.js';
import { PROP_REGION_SIZE, propRegionSize, setPropRegionSize } from '../src/render/iso3d/props.js';
import { buildWorldFromMap } from '../src/server/world/build.js';
import { createWorldPredictor } from '../src/server/client/prediction.js';
import { moveIntent, RoutePlanner } from '../src/render/iso3d/world/intent.js';
import { MAP_CHUNK_REQUEST_RADIUS, SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../src/server/config.js';
import { loadMapFile } from '../src/server/world/map-file.js';

/** `view.ts`'s own numbers, so this measures the shipped pacing. */
const PROP_SETTLE_MS = 120;
const PROP_INCOMPLETE_HOLD_MS = 4000;
const PROP_REGIONS_PER_FRAME = 1;
/** ...and behind the loading screen, where a lurch costs nothing. */
const PROP_REGIONS_LOADING = 8;
/** The ledger's backstop for a mesh reply that never comes (spec 213). */
const MESH_TIMEOUT_MS = 10_000;
/**
 * What one region costs the *frame*, from `bench-stream.ts`.
 *
 * 1.0ms since spec 181: composing the instances is 17.5ms on the map worker and
 * what is left here is the shells, the meshes and the sway patch. It was 34ms,
 * which is why this bench counted rebuilds in the first place -- at that price
 * every one of them was a dropped frame.
 */
const REGION_MS = 1;
/** Three ticks a frame at 60Hz, which is also the delta cadence. */
const TICKS_PER_FRAME = 3;
const FRAME_MS = (1000 / SERVER_TICK_RATE) * TICKS_PER_FRAME;

/**
 * Where the scripted player is sent, relative to spawn.
 *
 * A destination and a `RoutePlanner`, not a held direction. A raw `moveX: 1`
 * walks into the first tree and stops -- 413 units and then nothing, on a map
 * with 6942 of them -- which measures a wedged body rather than a walk. This is
 * what the tab does when somebody right-clicks the horizon.
 */
const TARGET = (() => {
  const [x, y] = (process.env['TARGET'] ?? '6000,0').split(',').map(Number);
  return { x: x ?? 6000, y: y ?? 0 };
})();

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function ledger(): ChunkIngest {
  return new ChunkIngest({
    settleMs: PROP_SETTLE_MS,
    regionSize: propRegionSize(),
    regionsPerFlush: PROP_REGIONS_PER_FRAME,
    incompleteHoldMs: PROP_INCOMPLETE_HOLD_MS,
    meshTimeoutMs: MESH_TIMEOUT_MS,
  });
}

async function main(): Promise<void> {
  // `PROPS=2200` measures the walk at another batching size (spec 195). The
  // frame's bill per region is flat, so what changes with size is how *often* a
  // region is rebuilt -- which is the half standing still cannot show.
  setPropRegionSize(Number(process.env['PROPS'] ?? PROP_REGION_SIZE));
  const shipped = loadMapFile();
  const world = buildWorldFromMap(shipped.doc, shipped.mapId);
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: world.seed, built: world, transport });
  transport.onConnection((channel) => server.accept(channel));
  // Nothing should wander into the walk and change what gets requested.
  server.liveConfig.set('spawnRateMultiplier', 0);

  const client = new GameClient(transport.connect(), {
    playerId: 'walker',
    displayName: 'Walker',
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: world.colliders,
        terrain: world.sampler,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  void client.connect();

  const planner = new RoutePlanner();
  const pathWorld = { colliders: world.colliders, radius: SERVER_PLAYER_RADIUS, ground: world.sampler };
  let destination: { x: number; y: number } | null = null;
  let facing = 0;
  let streamed: StreamedMap | null = null;
  const withRule = ledger();
  const without = ledger();
  // Split at the gate, because that is where a rebuild changes meaning. Behind
  // the loading screen there are no frames to protect and a 34ms region is just
  // part of the load; in front of it, it is a dropped frame.
  const counted = {
    withRule: { loading: 0, playing: 0 },
    without: { loading: 0, playing: 0 },
  };
  let open = false;
  let gateAt: { tick: number; held: number; ms: number } | null = null;
  let arrivalsAfterGate = 0;
  let arrivals = 0;
  let walkedFrom: { x: number; y: number } | null = null;
  let walkedTo: { x: number; y: number } | null = null;
  /** How far the body actually travelled, summed per tick rather than end to end. */
  let travelled = 0;

  const TICKS = Number(process.env['TICKS'] ?? 3600);
  let nowMs = 0;

  /**
   * One tick of walking, through the renderer's own `moveIntent` and
   * `RoutePlanner` -- the same two functions the Play tab drives a right-click
   * with, so what is being measured is a walk rather than a body against a tree.
   */
  function step(): void {
    const view = client.view();
    const me = view.self;
    if (!me) return;
    // Nothing moves until the world is on screen. A walker that sets off during
    // the load drags the request window across the map before the gate opens,
    // and then the whole map is in hand by the time anybody can see it -- which
    // measures a scenario no player can produce, and reports the stutter this
    // bench exists to count as zero.
    if (!open) return;
    if (!walkedFrom) {
      walkedFrom = { x: me.x, y: me.y };
      destination = { x: me.x + TARGET.x, y: me.y + TARGET.y };
    }
    if (walkedTo) travelled += Math.hypot(me.x - walkedTo.x, me.y - walkedTo.y);
    walkedTo = { x: me.x, y: me.y };
    const intent = moveIntent({
      held: new Set<string>(),
      self: me,
      destination,
      route: planner.next(me, destination, pathWorld, view.estimatedTick),
      facing,
      castAim: view.selfRoot,
    });
    if (intent.arrived) {
      // Reached it: turn round and go back, so a long run keeps streaming.
      destination = walkedFrom ? { x: walkedFrom.x, y: walkedFrom.y } : null;
      planner.clear();
    }
    facing = intent.facing;
    client.sendInput({ moveX: intent.moveX, moveY: intent.moveY, facing, buttons: 0 });
  }

  for (let tick = 1; tick <= TICKS; tick++) {
    server.tick();
    client.advanceTick();
    await settle();

    step();

    if (tick % TICKS_PER_FRAME !== 1) continue;

    nowMs += FRAME_MS;
    const view = client.view();
    const map = view.map;
    if (process.env['DEBUG'] && tick % 300 === 1 && view.self) {
      console.log(
        `  tick ${tick}: at (${view.self.x.toFixed(0)}, ${view.self.y.toFixed(0)}) held=${streamed?.size ?? 0}`,
      );
    }
    if (!map) continue;
    if (!streamed) streamed = new StreamedMap(map.info);

    // Exactly `ingestChunks`: insert what arrived, offer what it dirtied, and
    // complete it -- the worker is faster than a frame on this map, so a reply
    // in the same frame is the honest model of it.
    for (const held of map.chunks) {
      if (streamed.has(held.layer, held.cx, held.cz)) continue;
      const dirty = streamed.add(held);
      if (dirty.length === 0) continue;
      arrivals++;
      if (open) arrivalsAfterGate++;
      for (const queue of [withRule, without]) queue.offer(dirty, nowMs);
      for (const ref of dirty) {
        for (const queue of [withRule, without]) queue.complete(ref.layer, ref.cx, ref.cz, nowMs);
      }
    }

    const held = streamed;
    // `view.ts`'s own gate condition: the whole request window covered, and
    // nothing still owed a mesh or a prop region.
    if (!open && view.self) {
      const coverage = held.coverage(view.self.x, view.self.y, MAP_CHUNK_REQUEST_RADIUS);
      open =
        coverage.needed > 0 &&
        coverage.held >= coverage.needed &&
        withRule.pending === 0 &&
        withRule.dirtyRegionCount === 0;
      if (open) {
        gateAt = { tick, held: held.size, ms: nowMs };
      }
    }
    const phase = open ? 'playing' : 'loading';
    // The same split of budgets `view.ts` uses: generous while the screen is up,
    // small once it is not. Draining one a frame throughout would hold the gate
    // shut far longer than the tab does and hide rebuilds behind it.
    const budget = open ? PROP_REGIONS_PER_FRAME : PROP_REGIONS_LOADING;
    counted.withRule[phase] += withRule.takePropRects(nowMs, budget, (rect: WorldRect) =>
      held.rectCovered(rect),
    ).length;
    counted.without[phase] += without.takePropRects(nowMs, budget).length;
  }

  console.log(
    `walked ${travelled.toFixed(0)} units over ${TICKS} ticks ` +
      `(${(TICKS / SERVER_TICK_RATE).toFixed(1)}s), ${arrivals} chunk arrivals, ` +
      `${streamed?.size ?? 0} chunks held`,
  );
  const row = (label: string, n: { loading: number; playing: number }): string =>
    `  ${label.padEnd(30)} ${String(n.loading).padStart(4)} behind the gate,` +
    ` ${String(n.playing).padStart(4)} in front of it` +
    `  (~${(n.playing * REGION_MS).toFixed(0)}ms of main thread in play)`;
  console.log(
    gateAt
      ? `the gate opened at tick ${gateAt.tick} (${(gateAt.ms / 1000).toFixed(1)}s) with ${gateAt.held} chunks;` +
          ` ${arrivalsAfterGate} chunks arrived after it`
      : 'the gate never opened',
  );
  console.log('\nprop region rebuilds over that walk');
  console.log(row('without the completeness rule', counted.without));
  console.log(row('with it', counted.withRule));
  const playing = counted.withRule.playing;
  console.log(
    `\n  a region costs the frame ~${REGION_MS}ms (spec 181), so ${playing} of them in front of` +
      ` the gate is ~${(playing * REGION_MS).toFixed(0)}ms over ${(TICKS / SERVER_TICK_RATE).toFixed(0)}s of walking`,
  );
  process.exit(0);
}

void main();
