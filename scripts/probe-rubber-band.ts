/**
 * Why a player rubber-bands on a real server, measured rather than reasoned
 * about.
 *
 *   npx tsx scripts/probe-rubber-band.ts
 *
 * Every existing instrument in this tree is blind to the reported bug, and each
 * is blind for a stated reason:
 *
 *  - `prediction-harness.ts` hands the client **the server's own**
 *    `world.colliders` and `world.sampler`. The client therefore predicts
 *    against a perfect copy of the authoritative world, which is not a client
 *    this game has ever shipped -- the Play tab predicts against
 *    `snapshotColliders()` taken off its **own streamed map**, installed only
 *    when a nav grid comes back (`view.ts:1191`). It measures zero corrections
 *    because it removed the thing that causes them.
 *  - `bench-walk.ts` does the same, and also sets `spawnRateMultiplier` to 0.
 *  - `probe-streaming.ts` and `probe-walk-back.ts` run in a browser at about
 *    five frames a second, where a per-tick correction rate cannot be read.
 *
 * So this drives the **real `GameServer` over the shipped `maps/arena.json`**,
 * the **real `GameClient`**, and the renderer's own `moveIntent` /
 * `RoutePlanner` -- with the client's prediction ground fed the way `view.ts`
 * feeds it: a snapshot of the client's *own* `StreamedMap`, taken when a nav
 * build starts and installed when it finishes.
 *
 * Three axes, because there are three candidate causes and the whole job is
 * telling them apart:
 *
 *  - **ground**: `server` is the old harnesses' cheat, `streamed` is the tab.
 *    The difference between the two rows is what predicting against a snapshot
 *    of the client's own map costs. Measured: nothing.
 *  - **frame**: how long a client frame takes. `view.ts` clamps its accumulator
 *    to `MAX_CATCH_UP_TICKS` (10), so a frame longer than 166ms silently drops
 *    sim ticks -- the client sends fewer inputs than the server consumes and
 *    the body moves only on the ticks that got one. Measured: a movement-speed
 *    loss with **no correction attached to it**, which is why the speed column
 *    is reported twice, once against the ticks the client managed and once
 *    against the wall clock.
 *  - **server health**: the fraction of real time the server manages to
 *    simulate. `TickLoop.pump` advances `tickCount` only by the ticks it
 *    actually ran and discards the rest (`loop.ts:108`), so a loaded process
 *    falls behind real time permanently. Measured: this is the bug, and the
 *    cliff is one percentage point wide.
 *
 * The client's rate-match controller (spec 148) is live on every row, driven by
 * a real accumulator on a real `tickScale`, so what the server-health rows
 * measure is what that controller can and cannot absorb -- not what happens
 * with it switched off.
 *
 * It also times every `server.tick()` and replays `loop.ts` over the costs, so
 * the last two sheets answer *why* a server would be behind rather than only
 * what happens when it is. The standing-still row is the control for that
 * pair: a body that never leaves its chunk never changes
 * `ChunkManager.activeChunks()`, so `ServerNav.update` never drops its windows
 * and nothing is reassembled inside a tick.
 */

import { GameServer } from '../src/server/server.js';
import { GameClient } from '../src/server/client/game-client.js';
import { LoopbackTransport } from '../src/server/net/transport-loop.js';
import { UnreliableChannel, PERFECT_WIRE } from '../src/server/net/unreliable.js';
import { StreamedMap } from '../src/server/client/streamed-map.js';
import { Rng } from '../src/shared/prng.js';
import { decodeServerMessage } from '../src/server/net/messages.js';
import { CorrectionReason, ServerMessageType } from '../src/server/net/protocol.js';
import { buildWorldFromMap } from '../src/server/world/build.js';
import { loadMapFile } from '../src/server/world/map-file.js';
import { moveIntent, RoutePlanner } from '../src/render/iso3d/world/intent.js';
import {
  createGroundPredictor,
  emptyGround,
  fillGround,
  type PredictionGround,
} from '../src/render/iso3d/world/prediction-ground.js';
import {
  MAP_CHUNK_REQUEST_RADIUS,
  SERVER_PLAYER_RADIUS,
  SERVER_TICK_RATE,
} from '../src/server/config.js';

const REASONS: Record<number, string> = {
  [CorrectionReason.Divergence]: 'divergence',
  [CorrectionReason.SpeedViolation]: 'speed',
  [CorrectionReason.Collision]: 'collision',
  [CorrectionReason.Teleport]: 'teleport',
  [CorrectionReason.Drift]: 'drift',
};

/** `view.ts`'s own numbers, so this models the shipped pacing. */
const MAX_CATCH_UP_TICKS = 10;
const GROUND_REFRESH_MIN_CHUNKS = 8;

/**
 * Frames a nav build takes before its colliders are installed.
 *
 * `bench-editor.ts` and spec 205 put a grid over this map at around a second on
 * a real machine, and the worker is a thread rather than a queue, so the cost
 * is latency rather than a stall. Three 50ms frames is deliberately *generous*
 * to the shipped client.
 */
const NAV_BUILD_FRAMES = Number(process.env['NAV_FRAMES'] ?? 3);

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Scenario {
  readonly label: string;
  /** One-way wire delay, in ticks. */
  readonly delayTicks: number;
  /** How long a client frame takes, in real milliseconds. */
  readonly frameMs: number;
  /**
   * The fraction of real time the **server** manages to simulate.
   *
   * 1 is a healthy process. Below it is `TickLoop.pump` hitting its catch-up
   * cap: it advances `tickCount` only by the ticks it actually ran and
   * **discards the rest** (`loop.ts:108`), so a loaded process falls behind
   * real time permanently and never catches up. The client is on wall-clock
   * time and keeps producing one input per tick of it, so the difference goes
   * straight into `connection.inputs`.
   */
  readonly serverHealth: number;
  /** Where the client's prediction colliders come from. */
  readonly ground: 'server' | 'streamed';
  /** Whether anything is alive to fight. */
  readonly mobs: boolean;
  /**
   * Stand still instead of walking.
   *
   * The control for the overrun column. A body that never leaves its chunk
   * never changes `ChunkManager.activeChunks()`, so `ServerNav.update` never
   * calls `clearWindows()` and no window is ever reassembled -- which is the
   * difference between "routing is expensive" and "*re*-routing after a chunk
   * crossing is expensive", and they want different fixes.
   */
  readonly stationary?: boolean;
}

interface Result {
  readonly label: string;
  readonly corrections: Record<string, number>;
  readonly total: number;
  readonly hard: number;
  readonly worstResidual: number;
  readonly worstOffset: number;
  /** Per ten seconds of sim time, so a rate that climbs is visible as one. */
  readonly perBucket: number[];
  /** Distance the *server's* body covered, as a fraction of what it could. */
  readonly speedFraction: number;
  /** ...and as a fraction of what it could in the same number of *seconds*. */
  readonly wallSpeedFraction: number;
  /** Mean depth of the server's unconsumed input queue. */
  readonly meanQueue: number;
  /** Ticks the server had no input to consume, as a fraction. */
  readonly starved: number;
  readonly clientTicks: number;
  readonly serverTicks: number;
  /** What the rate-match controller settled on. 1 is "did nothing". */
  readonly meanScale: number;
  /** What a whole server tick cost in milliseconds, against a 16.67ms budget. */
  readonly tickP50: number;
  readonly tickP99: number;
  readonly tickMax: number;
  readonly overruns: readonly { tick: number; cost: number; entities: number; chunk: string }[];
  readonly worstPending: number;
  readonly overrunCount: number;
  readonly overrunMs: number;
  readonly behind: { ran: number; wanted: number; dropped: number };
}

/**
 * What these tick costs do to `TickLoop`.
 *
 * `loop.ts`'s `pump` is replayed over the measured sequence on a virtual clock
 * that advances by what each tick really cost: accumulate the real time that
 * passed, run at most `MAX_CATCHUP_TICKS` of backlog, and **discard the rest
 * without advancing `tickCount`**. So `ran` against `wanted` is how far behind
 * real time the server ends up, and `dropped` is the backlog it threw away --
 * which is also, tick for tick, how much deeper every connected client's input
 * queue got, because the client goes on producing one input per tick of real
 * time whatever the server managed.
 */
function fallBehind(costs: readonly number[]): { ran: number; wanted: number; dropped: number } {
  const tickMs = 1000 / SERVER_TICK_RATE;
  const pollMs = Math.max(1, Math.floor(tickMs / 2));
  let wall = 0;
  let lastAt = 0;
  let accumulator = 0;
  let dropped = 0;
  let index = 0;
  let nextPollAt = pollMs;
  while (index < costs.length) {
    // Idle until the timer is due. A loop with nothing to do runs on time.
    wall = Math.max(wall, nextPollAt);
    nextPollAt = wall + pollMs;
    accumulator += wall - lastAt;
    lastAt = wall;
    let ran = 0;
    while (accumulator >= tickMs && ran < 5 && index < costs.length) {
      accumulator -= tickMs;
      ran += 1;
      // The tick costs real time, which the *next* pump will see.
      wall += costs[index] ?? 0;
      index += 1;
    }
    // `lastAt` is *not* re-stamped here: `pump` stamps it on entry, so the time
    // the ticks themselves burned is time the next pump sees. Re-stamping it
    // was this model's own first bug, and it hid every dropped tick.
    if (accumulator >= tickMs) {
      dropped += Math.floor(accumulator / tickMs);
      accumulator = 0;
    }
  }
  return { ran: costs.length, wanted: Math.round(wall / tickMs), dropped };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[at] ?? 0;
}

const BUCKET_TICKS = SERVER_TICK_RATE * 10;

async function run(scenario: Scenario, ticks: number): Promise<Result> {
  const shipped = loadMapFile();
  const world = buildWorldFromMap(shipped.doc, shipped.mapId);
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: world.seed, built: world, transport });
  transport.onConnection((channel) => server.accept(channel));
  if (!scenario.mobs) server.liveConfig.set('spawnRateMultiplier', 0);

  const corrections: Record<string, number> = {};
  const perBucket: number[] = [];
  const claims = new Map<number, { x: number; y: number }>();
  let worstResidual = 0;
  let bucket = 0;
  let clientTick = 0;

  const line = new UnreliableChannel(
    transport.connect(),
    () => ({ ...PERFECT_WIRE, delayTicks: scenario.delayTicks }),
    Rng.fromSeed(1),
    (bytes, direction) => {
      if (direction !== 'in') return;
      const message = decodeServerMessage(bytes);
      if (message.type !== ServerMessageType.Correction) return;
      const name = REASONS[message.reason] ?? String(message.reason);
      corrections[name] = (corrections[name] ?? 0) + 1;
      perBucket[bucket] = (perBucket[bucket] ?? 0) + 1;
      const claim = claims.get(message.inputSeq);
      if (claim) {
        worstResidual = Math.max(
          worstResidual,
          Math.hypot(claim.x - message.position.x, claim.y - message.position.y),
        );
      }
    },
  );

  // The holder `view.ts` keeps, and the only thing this probe varies. Empty is
  // the flat predictor, which is what the tab uses until its first grid lands.
  const ground: PredictionGround = emptyGround();
  if (scenario.ground === 'server') fillGround(ground, world.colliders, world.sampler);

  const client = new GameClient(line, {
    playerId: 'walker',
    displayName: 'Walker',
    predictor: (stats, tickRate) =>
      createGroundPredictor({
        ground,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  void client.connect();

  const planner = new RoutePlanner();
  const held = new Set<string>();
  let walk = Rng.fromSeed(97);
  let destination: { x: number; y: number } | null = null;
  let facing = 0;
  /**
   * Ticks since the body last actually moved.
   *
   * A scripted walker pressed into a rock is not a walk, and it is exactly what
   * the first cut of this probe measured: wedged at one coordinate for twenty
   * seconds, client and server in perfect agreement, zero corrections and a
   * flawless pass. A player picks somewhere else; so does this.
   */
  let stuckTicks = 0;
  let lastSelf: { x: number; y: number } | null = null;

  let streamed: StreamedMap | null = null;
  /** A nav build in flight: when it lands, and the colliders it snapshotted. */
  let navDueFrame = -1;
  let navSnapshot: ReturnType<StreamedMap['snapshotColliders']> | null = null;
  let revisionAtRefresh = -1;
  let firstGroundBuilt = false;
  let frame = 0;
  let navBuilds = 0;

  let queueTotal = 0;
  let queueSamples = 0;
  let starvedTicks = 0;
  let travelled = 0;
  let last: { x: number; y: number } | null = null;
  let movingTicks = 0;
  let serverTicksRun = 0;
  /**
   * The deepest `PredictionBuffer.pendingInputs` ever got.
   *
   * It is pruned only by an arriving `Delta` (`acknowledge`) or a `Correction`,
   * and a delta carrying no change is not sent at all -- so a body standing
   * still in a quiet corner acknowledges nothing and the buffer grows for as
   * long as the player stands there. A `reconcile` then replays all of it.
   */
  let worstPending = 0;
  /** What a whole server tick cost, including the broadcast and chunk serving. */
  const tickCosts: number[] = [];
  /** Every tick that cost more than its own 16.67ms budget. */
  const overruns: { tick: number; cost: number; entities: number; chunk: string }[] = [];
  const entityCount = (): number =>
    (server as unknown as { state: { entities: Map<number, unknown> } }).state.entities.size;

  const serverEntity = (): { position: { x: number; y: number } } | undefined => {
    const state = (server as unknown as {
      state: { entities: Map<number, { position: { x: number; y: number } }> };
    }).state;
    return state.entities.get(client.view().selfEntityId);
  };

  const framesToRun = Math.ceil((ticks * (1000 / SERVER_TICK_RATE)) / scenario.frameMs);
  /** The renderer's own accumulator, in real milliseconds. */
  let accumulator = 0;
  /** ...and the server's, so the ticks it loses are lost the way the loop loses them. */
  let serverAccumulator = 0;
  let wallMs = 0;
  let scaleTotal = 0;
  let scaleSamples = 0;

  for (frame = 1; frame <= framesToRun; frame += 1) {
    wallMs += scenario.frameMs;
    const wireNow = Math.floor(wallMs / (1000 / SERVER_TICK_RATE));
    line.deliver(wireNow);
    await settle();
    line.deliver(wireNow);
    await settle();

    // --- the server's clock -------------------------------------------------
    // It is handed the real time that passed and simulates `serverHealth` of
    // it; the shortfall is the backlog `pump` throws away.
    serverAccumulator += scenario.frameMs * scenario.serverHealth;
    while (serverAccumulator >= 1000 / SERVER_TICK_RATE) {
      serverAccumulator -= 1000 / SERVER_TICK_RATE;
      const depth = server.inputQueueDepth('walker');
      queueTotal += depth;
      queueSamples += 1;
      if (depth === 0) starvedTicks += 1;
      const started = performance.now();
      server.tick();
      const cost = performance.now() - started;
      tickCosts.push(cost);
      if (cost > 16.67) {
        const at = serverEntity()?.position;
        overruns.push({
          tick: serverTicksRun,
          cost,
          entities: entityCount(),
          chunk: at ? `${Math.floor(at.x / 616)},${Math.floor(at.y / 616)}` : '?',
        });
      }
      serverTicksRun += 1;
      const at = serverEntity()?.position;
      if (at) {
        if (last) travelled += Math.hypot(at.x - last.x, at.y - last.y);
        last = { x: at.x, y: at.y };
      }
    }

    // --- the client's, exactly as `view.ts:4397` keeps it --------------------
    const scale = client.view().tickScale || 1;
    scaleTotal += scale;
    scaleSamples += 1;
    const tickMs = (1000 / SERVER_TICK_RATE) * scale;
    accumulator = Math.min(accumulator + scenario.frameMs, tickMs * MAX_CATCH_UP_TICKS);
    while (accumulator >= tickMs) {
      accumulator -= tickMs;
      client.advanceTick();
      clientTick += 1;
      bucket = Math.floor(clientTick / BUCKET_TICKS);
      const view = client.view();
      const me = view.self;
      if (!me) continue;
      if (lastSelf && Math.hypot(me.x - lastSelf.x, me.y - lastSelf.y) < 0.05) stuckTicks += 1;
      else stuckTicks = 0;
      lastSelf = { x: me.x, y: me.y };
      if (!destination || stuckTicks > SERVER_TICK_RATE) {
        [destination, walk] = wanderFrom(me, walk);
        planner.clear();
        stuckTicks = 0;
      }
      const intent = scenario.stationary
        ? { moveX: 0, moveY: 0, facing, arrived: false }
        : moveIntent({
            held,
            self: me,
            destination,
            route: planner.next(me, destination, pathWorldFor(ground), view.estimatedTick),
            facing,
            castAim: view.selfRoot,
          });
      if (intent.arrived) {
        [destination, walk] = wanderFrom(me, walk);
        planner.clear();
      }
      facing = intent.facing;
      if (intent.moveX !== 0 || intent.moveY !== 0) movingTicks += 1;
      const claimed = client.sendInput({
        moveX: intent.moveX,
        moveY: intent.moveY,
        facing,
        buttons: 0,
      });
      if (claimed) claims.set(clientSeq(client), { x: claimed.x, y: claimed.y });
      worstPending = Math.max(worstPending, pendingCount(client));
    }

    // --- what `view.ts` does with the map, once a frame ---------------------
    const view = client.view();
    const map = view.map;
    if (!map) continue;
    if (!streamed) streamed = new StreamedMap(map.info);
    const store = streamed;

    const wanted = new Set(map.chunks.map((c) => `${c.layer}:${c.cx},${c.cz}`));
    const gone = store
      .heldRefs()
      .filter((c) => !wanted.has(`${c.layer}:${c.cx},${c.cz}`));
    if (gone.length > 0) store.remove(gone);
    for (const chunk of map.chunks) {
      if (store.has(chunk.layer, chunk.cx, chunk.cz)) continue;
      store.add(chunk);
    }

    if (scenario.ground === 'streamed' && view.self) {
      // The request side: `view.ts:1235` for the first grid, `view.ts:1160` for
      // every one after it.
      const coverage = store.coverage(view.self.x, view.self.y, MAP_CHUNK_REQUEST_RADIUS);
      const wantsFirst =
        !firstGroundBuilt && coverage.needed > 0 && coverage.held >= coverage.needed;
      const wantsRefresh =
        firstGroundBuilt && store.revision - revisionAtRefresh >= GROUND_REFRESH_MIN_CHUNKS;
      if (navDueFrame < 0 && (wantsFirst || wantsRefresh)) {
        firstGroundBuilt = true;
        revisionAtRefresh = store.revision;
        // The worker snapshots when the build *starts*; chunks keep arriving
        // while it runs.
        navSnapshot = store.snapshotColliders();
        navDueFrame = frame + NAV_BUILD_FRAMES;
      }
      // ...and the reply side.
      if (navDueFrame >= 0 && frame >= navDueFrame) {
        if (navSnapshot) {
          fillGround(ground, navSnapshot, store.sampler());
          navBuilds += 1;
        }
        navSnapshot = null;
        navDueFrame = -1;
      }
    }
  }

  const perTick = client.view().stats?.moveSpeed ?? 0;
  const could = (movingTicks * perTick) / SERVER_TICK_RATE;
  // The same distance judged against wall-clock rather than against the ticks
  // the client managed: a client whose own clock is slow asks for less walking
  // and gets all of it, which is a perfect score and a body that crawls.
  const movingFraction = clientTick > 0 ? movingTicks / clientTick : 0;
  const wallTicks = (wallMs / 1000) * SERVER_TICK_RATE;
  const couldWall = (wallTicks * movingFraction * perTick) / SERVER_TICK_RATE;
  const hard =
    (corrections['divergence'] ?? 0) +
    (corrections['speed'] ?? 0) +
    (corrections['collision'] ?? 0) +
    (corrections['teleport'] ?? 0);
  const total = Object.values(corrections).reduce((a, b) => a + b, 0);
  const result: Result = {
    label: `${scenario.label} (${navBuilds} grids)`,
    corrections,
    total,
    hard,
    worstResidual,
    worstOffset: 0,
    perBucket: [...perBucket].map((n) => n ?? 0),
    speedFraction: could > 0 ? travelled / could : 0,
    wallSpeedFraction: couldWall > 0 ? travelled / couldWall : 0,
    meanQueue: queueSamples > 0 ? queueTotal / queueSamples : 0,
    starved: queueSamples > 0 ? starvedTicks / queueSamples : 0,
    clientTicks: clientTick,
    serverTicks: serverTicksRun,
    tickP50: percentile(tickCosts, 0.5),
    tickP99: percentile(tickCosts, 0.99),
    tickMax: tickCosts.length > 0 ? Math.max(...tickCosts) : 0,
    worstPending,
    overruns: overruns.slice(0, 12),
    overrunCount: overruns.length,
    overrunMs: overruns.reduce((a, b) => a + b.cost, 0),
    behind: fallBehind(tickCosts),
    meanScale: scaleSamples > 0 ? scaleTotal / scaleSamples : 1,
  };
  await server.stop();
  return result;
}

/** How many inputs the client is still holding unacknowledged. */
function pendingCount(client: GameClient): number {
  const prediction = (client as unknown as { prediction: { pending: readonly unknown[] } | null })
    .prediction;
  return prediction ? prediction.pending.length : 0;
}

/** The last seq the client sent, which it does not otherwise expose. */
function clientSeq(client: GameClient): number {
  return (client as unknown as { seq: number }).seq;
}

/**
 * Somewhere else to be: a seeded bearing at a chunk-and-a-bit's reach.
 *
 * Seeded rather than drawn from `Math.random` for the reason everything in this
 * tree is -- two runs of this probe have to be the same walk, or the difference
 * between two rows is the walk rather than the thing being varied. The reach is
 * long enough that the walk keeps crossing chunk boundaries, which is what makes
 * the streamed map churn at all.
 */
function wanderFrom(
  from: { x: number; y: number },
  rng: Rng,
): [{ x: number; y: number }, Rng] {
  const [degrees, afterBearing] = rng.nextInt(0, 359);
  const [reach, afterReach] = afterBearing.nextInt(700, 1400);
  const bearing = (degrees * Math.PI) / 180;
  return [
    { x: from.x + Math.cos(bearing) * reach, y: from.y + Math.sin(bearing) * reach },
    afterReach,
  ];
}

function pathWorldFor(
  ground: PredictionGround,
): { colliders: NonNullable<PredictionGround['colliders']>; radius: number; ground: NonNullable<PredictionGround['terrain']> } | null {
  return ground.colliders && ground.terrain
    ? { colliders: ground.colliders, radius: SERVER_PLAYER_RADIUS, ground: ground.terrain }
    : null;
}

async function main(): Promise<void> {
  const ticks = Number(process.env['TICKS'] ?? 3600);
  const scenarios: Scenario[] = [
    { label: 'server ground, 60fps', delayTicks: 3, frameMs: 16.7, serverHealth: 1, ground: 'server', mobs: false },
    { label: 'streamed ground, 60fps', delayTicks: 3, frameMs: 16.7, serverHealth: 1, ground: 'streamed', mobs: false },
    { label: 'streamed ground, 20fps, mobs', delayTicks: 3, frameMs: 50, serverHealth: 1, ground: 'streamed', mobs: true },
    { label: 'streamed ground, 5fps, mobs', delayTicks: 3, frameMs: 200, serverHealth: 1, ground: 'streamed', mobs: true },
    // The control for the tick-cost sheets: no chunk crossings, so no window
    // is ever reassembled.
    { label: 'streamed ground, 60fps, mobs, STANDING STILL', delayTicks: 3, frameMs: 16.7, serverHealth: 1, ground: 'streamed', mobs: true, stationary: true },
    // The server losing ticks it never gets back (`loop.ts:108`).
    { label: 'SERVER at 97% of real time', delayTicks: 3, frameMs: 16.7, serverHealth: 0.97, ground: 'streamed', mobs: true },
    { label: 'SERVER at 94% of real time', delayTicks: 3, frameMs: 16.7, serverHealth: 0.94, ground: 'streamed', mobs: true },
    { label: 'SERVER at 90% of real time', delayTicks: 3, frameMs: 16.7, serverHealth: 0.90, ground: 'streamed', mobs: true },
    { label: 'SERVER at 75% of real time', delayTicks: 3, frameMs: 16.7, serverHealth: 0.75, ground: 'streamed', mobs: true },
    { label: 'SERVER at 50% of real time', delayTicks: 3, frameMs: 16.7, serverHealth: 0.50, ground: 'streamed', mobs: true },
  ];

  console.log(
    `${ticks} server ticks (${(ticks / SERVER_TICK_RATE).toFixed(0)}s) walking a circuit of the shipped arena\n`,
  );
  console.log(
    'scenario'.padEnd(42) +
      'corrections'.padStart(12) +
      'hard'.padStart(7) +
      'worst'.padStart(8) +
      'speed'.padStart(8) +
      'wall'.padStart(7) +
      'queue'.padStart(8) +
      'scale'.padStart(8) +
      'pending'.padStart(9),
  );
  const results: Result[] = [];
  for (const scenario of scenarios) {
    const result = await run(scenario, ticks);
    results.push(result);
    console.log(
      result.label.padEnd(42) +
        String(result.total).padStart(12) +
        String(result.hard).padStart(7) +
        result.worstResidual.toFixed(1).padStart(8) +
        `${(result.speedFraction * 100).toFixed(0)}%`.padStart(8) +
        `${(result.wallSpeedFraction * 100).toFixed(0)}%`.padStart(7) +
        result.meanQueue.toFixed(1).padStart(8) +
        result.meanScale.toFixed(3).padStart(8) +
        String(result.worstPending).padStart(9),
    );
  }

  console.log('\nwhat a whole server tick cost, against the 16.67ms it has');
  for (const result of results) {
    console.log(
      `  ${result.label.padEnd(42)} p50 ${result.tickP50.toFixed(3)}ms   ` +
        `p99 ${result.tickP99.toFixed(3)}ms   max ${result.tickMax.toFixed(3)}ms`,
    );
  }

  console.log('\nwhat those costs do to the clock (`loop.ts` replayed over them)');
  for (const result of results) {
    const b = result.behind;
    console.log(
      `  ${result.label.padEnd(42)} ${result.overrunCount} ticks over budget ` +
        `(${result.overrunMs.toFixed(0)}ms of overrun), ran ${b.ran} of ${b.wanted} ` +
        `wall ticks, ${b.dropped} dropped`,
    );
  }

  console.log('\nthe ticks that went over budget');
  for (const result of results) {
    if (result.overruns.length === 0) continue;
    console.log(`  ${result.label}`);
    for (const over of result.overruns) {
      console.log(
        `    tick ${String(over.tick).padStart(5)}  ${over.cost.toFixed(1)}ms  ` +
          `${over.entities} entities  chunk ${over.chunk}`,
      );
    }
  }

  console.log('\nby reason');
  for (const result of results) {
    const by = Object.entries(result.corrections)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} ${n}`)
      .join(', ');
    console.log(`  ${result.label.padEnd(42)} ${by || '-'}`);
  }

  console.log('\ncorrections per 10s of play, in order -- a rate that climbs is the bug');
  for (const result of results) {
    console.log(`  ${result.label.padEnd(42)} ${result.perBucket.join(' ')}`);
  }
  process.exit(0);
}

void main();
