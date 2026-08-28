// Dev-only: play a scripted session against the real server over a channel that
// holds frames, and report how often the server had to correct us and how far
// the body jumped when it did. Not part of the app.
// `npx tsx scripts/prediction-harness.ts`
//
// The point is that single-player is a loopback in the same tab: a correction
// costs a tick to arrive, so prediction bugs that would rubber-band a player on
// a real connection are invisible locally. This drives the **real
// `GameServer`**, the **real `GameClient`** and the **real `moveIntent`** that
// `src/render/iso3d/world/view.ts` drives, so what is measured here is the same
// chain the player is in -- with a delay line spliced into the middle.
//
// The scripted player is the reported one: a right-click move order, a
// left-click swing in the same direction, over and over.
//
// LATENCY=6 TICKS=600 npx tsx scripts/prediction-harness.ts

import { GameClient } from '../src/server/client/game-client.js';
import { createWorldPredictor } from '../src/server/client/prediction.js';
import { LoopbackTransport } from '../src/server/net/transport-loop.js';
import { UnreliableChannel, PERFECT_WIRE } from '../src/server/net/unreliable.js';
import { Rng } from '../src/shared/prng.js';
import { decodeServerMessage } from '../src/server/net/messages.js';
import { CorrectionReason, ServerMessageType } from '../src/server/net/protocol.js';
import { GameServer } from '../src/server/server.js';
import { buildWorld } from '../src/server/world/build.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../src/server/config.js';
import { turnToward } from '../src/server/sim/movement.js';
import { moveIntent, RoutePlanner } from '../src/render/iso3d/world/intent.js';

const REASONS: Record<number, string> = {
  [CorrectionReason.Divergence]: 'divergence',
  [CorrectionReason.SpeedViolation]: 'speed',
  [CorrectionReason.Collision]: 'collision',
  [CorrectionReason.Teleport]: 'teleport',
  [CorrectionReason.Drift]: 'drift',
};


const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Run {
  readonly label: string;
  readonly corrections: Record<string, number>;
  readonly hard: number;
  readonly maxSnap: number;
  /** The largest gap between a claim and the server's answer for that input. */
  readonly worstResidual: number;
  /** Fraction of ticks the client refused to walk because it thought it was casting. */
  readonly rooted: number;
  /** Fraction of ticks the server really had a cast in progress. */
  readonly casting: number;
  readonly combat: Combat;
}

/**
 * What the *blow* felt like, as opposed to what the walk did (spec 069).
 *
 * Every number here is a disagreement between what the player is looking at and
 * what the server is actually doing, counted per tick. Movement had one honest
 * measure -- the body is where the server says or it is not -- and combat needs
 * four, because a commit is four visible things at once: a bar, a sweep, a
 * rooted body and a swing that lands.
 */
interface Combat {
  /** Ticks compared, so the rest can be read as fractions of a session. */
  readonly sampled: number;
  /**
   * Ticks the server had a cast running and the client was drawing no bar.
   *
   * The headline. This is the press that appears to do nothing: it is exactly
   * the round trip on a client that waits to be told, and it is the number this
   * spec exists to drive to zero.
   */
  readonly barMissing: number;
  /**
   * Ticks the client drew a bar *before* the server had started the cast it
   * belongs to.
   *
   * Not a fault, and separated from `barLingering` for that reason. A request is
   * stamped to an input and the server commits when it dequeues that input, so
   * there is always a window between the press and the commit -- the depth of
   * the input queue, plus the trip. Drawing an empty bar across it is the honest
   * answer to "did my press register", and standing still across it costs
   * nothing (spec 067). Expect it to track the queue depth and no more.
   */
  readonly barEarly: number;
  /**
   * Ticks the client was still drawing a bar *after* the server's cast ended.
   *
   * This one is the fault. Every tick here is a tick the player stood rooted for
   * a blow that had already finished, which is what the old `over-root` column
   * was mostly made of.
   */
  readonly barLingering: number;
  /**
   * Ticks the client walked while the server held it rooted. The dangerous
   * direction: movement the server discards, banked as error, corrected later.
   */
  readonly underRoot: number;
  /**
   * Ticks the server had the ability on cooldown and the client's sweep read
   * ready. A button that looks usable and is not.
   */
  readonly sweepMissing: number;
  /** Presses the server refused outright. */
  readonly refused: number;
  /**
   * Casts the server actually began, counted from its own state rather than
   * from `CastState` messages -- it sends that twice for one cast, once at the
   * commit and again when a turn finishes and the wind-up clock restarts (spec
   * 065), so counting messages reports roughly twice as many blows as happened.
   */
  readonly committed: number;
  /** Presses that lit a bar on the spot. At least one per cast is the goal. */
  readonly instantBars: number;
}

/**
 * Ticks the client advances between message deliveries.
 *
 * Not a detail: the renderer runs the sim from an accumulator and drains its
 * inbox between animation frames, so a browser painting at 20fps hears from the
 * server in three-tick lumps whatever the connection is doing. That is why the
 * reported bug is visible on a loopback at all -- three ticks of frame is three
 * ticks of not knowing you are rooted.
 */
const TICKS_PER_FRAME = Number(process.env.TICKS_PER_FRAME ?? 3);

/** How often the scripted player clicks, in ticks. Twelve and eight per second. */
const RIGHT_CLICK_EVERY = Number(process.env.RIGHT_EVERY ?? 5);
const LEFT_CLICK_EVERY = Number(process.env.LEFT_EVERY ?? 7);

async function run(label: string, delayTicks: number, ticks: number): Promise<Run> {
  const seed = 4242;
  const world = buildWorld(seed);
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed, built: world, transport });
  transport.onConnection((channel) => server.accept(channel));
  server.liveConfig.set('spawnRateMultiplier', 0);

  const corrections: Record<string, number> = {};
  /** What this client claimed for each input, so a correction can be measured. */
  const claims = new Map<number, { x: number; y: number }>();
  let worstResidual = 0;
  const line = new UnreliableChannel(transport.connect(), () => ({ ...PERFECT_WIRE, delayTicks: delayTicks }), Rng.fromSeed(1), (bytes, direction) => {
    // Inbound only: the tap sees both directions now, and these all decode a
    // *server* message.
    if (direction !== 'in') return;
    const message = decodeServerMessage(bytes);
    if (message.type !== ServerMessageType.Correction) return;
    const name = REASONS[message.reason] ?? String(message.reason);
    corrections[name] = (corrections[name] ?? 0) + 1;
    const claim = claims.get(message.inputSeq);
    if (claim && process.env.DEBUG_DRIFT) {
      console.log(
        `correction ${name} at=${line.tickNow} seq=${message.inputSeq} residual=` +
          `${Math.hypot(claim.x - message.position.x, claim.y - message.position.y).toFixed(2)} ` +
          `srv=(${message.position.x.toFixed(1)},${message.position.y.toFixed(1)}) ` +
          `claim=(${claim.x.toFixed(1)},${claim.y.toFixed(1)})`,
      );
    }
    if (claim) {
      worstResidual = Math.max(
        worstResidual,
        Math.hypot(claim.x - message.position.x, claim.y - message.position.y),
      );
    }
  });

  const client = new GameClient(line, {
    playerId: 'you',
    displayName: 'You',
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

  // What the server actually has, read straight out of its state. The harness is
  // allowed to do this and the client is not -- that asymmetry is the point.
  //
  // Read through a function, never captured: `step()` returns a fresh state and
  // the server rebinds the field every tick, so a reference taken once is the
  // world as it stood at tick zero. Holding one silently reported a session in
  // which nobody ever cast anything.
  const serverState = (): {
    tick: number;
    entities: Map<
      number,
      { cast: unknown; position: { x: number; y: number }; cooldowns: Record<string, number> }
    >;
  } =>
    (
      server as unknown as {
        state: {
          tick: number;
          entities: Map<
            number,
            {
              cast: unknown;
              position: { x: number; y: number };
              cooldowns: Record<string, number>;
            }
          >;
        };
      }
    ).state;

  const combat = {
    sampled: 0,
    barMissing: 0,
    barEarly: 0,
    barLingering: 0,
    underRoot: 0,
    sweepMissing: 0,
    refused: 0,
    committed: 0,
  };
  /**
   * Whether the server has begun a cast since the client's current bar went up.
   * This is what separates "the bar is early" from "the bar is overstaying": the
   * same tick-level disagreement means opposite things either side of it.
   */
  let serverCastSeenThisBar = false;
  /** Whether the server had a cast last tick, so a new one can be counted once. */
  let serverWasCasting = false;
  const timeline: string[] = [];
  /** Presses that put a bar on screen on the very tick they were made. */
  let instantBars = 0;
  let hadBar = false;
  client.onCastRejected(() => {
    combat.refused += 1;
  });

  const planner = new RoutePlanner();
  const held = new Set<string>();
  const pathWorld = { colliders: world.colliders, radius: SERVER_PLAYER_RADIUS };
  let destination: { x: number; y: number } | null = null;
  let facing = 0;
  let origin: { x: number; y: number } | null = null;
  let previous: { x: number; y: number } | null = null;
  let maxSnap = 0;
  let sentSeq = 0;
  /** Ticks the client held itself rooted, and ticks the server really was. */
  let rootedTicks = 0;
  let castingTicks = 0;
  let sampled = 0;

  for (let tick = 1; tick <= ticks; tick += 1) {
    // Frames deliver; ticks in between run blind, exactly as they do in the tab.
    if (tick % TICKS_PER_FRAME === 1 || TICKS_PER_FRAME === 1) {
      line.deliver(tick);
      await settle();
      line.deliver(tick);
      await settle();
    }

    server.tick();
    client.advanceTick();

    const view = client.view();
    if (!view.self) continue;
    if (!origin) origin = { x: view.self.x, y: view.self.y };

    // The reported pattern, at the reported speed: keep right clicking where you
    // are going, and keep left clicking at it. The two cadences are deliberately
    // coprime so the swing lands at every phase of the walk rather than at one.
    if (tick % RIGHT_CLICK_EVERY === 0) destination = { x: origin.x + 400, y: origin.y };
    if (tick % LEFT_CLICK_EVERY === 0) {
      // Committing cancels where you were going -- what `view.ts` does.
      destination = null;
      planner.clear();
      // Counted only when the press puts up a bar that was not already there.
      // A press made *during* a swing can see the bar of the swing already
      // running, and counting that would score a client that predicts nothing
      // as though it predicted everything.
      const showedBefore = view.casts.some((cast) => cast.entityId === view.selfEntityId);
      client.useAbility('melee.slash', view.self.x + 100, view.self.y);
      const pressed = client.view();
      const showsAfter = pressed.casts.some((cast) => cast.entityId === pressed.selfEntityId);
      if (!showedBefore && showsAfter) instantBars += 1;
    }

    // Read after the clicks, exactly as the view does: a root asked for this
    // tick roots this tick's input, or the prediction is a tick late every time.
    const fresh = client.view();
    const me = fresh.self ?? view.self;
    const intent = moveIntent({
      held,
      self: me,
      destination,
      route: planner.next(me, destination, pathWorld, fresh.estimatedTick),
      facing,
      castAim: fresh.selfRoot,
    });
    if (intent.arrived) {
      destination = null;
      planner.clear();
    }
    facing = turnToward(facing, intent.facing, fresh.stats?.turnRate ?? 0, SERVER_TICK_RATE);
    if (process.env.DEBUG) {
      const at = serverState().entities.get(view.selfEntityId);
      console.log(
        `t=${tick} est=${view.estimatedTick} srvTick=${serverState().tick} rtt=${view.roundTripTicks} ` +
          `qd=${view.commitDelayTicks} root=${view.selfRoot ? 'Y' : 'n'} srvCast=${at?.cast ? 'Y' : 'n'} ` +
          `cd=${JSON.stringify(view.cooldowns)} move=${intent.moveX.toFixed(1)} ` +
          `local=${me.x.toFixed(1)} srv=${at?.position.x.toFixed(1)}`,
      );
    }
    sampled += 1;
    if (fresh.selfRoot) rootedTicks += 1;
    const mine = serverState().entities.get(view.selfEntityId);
    const serverCasting = Boolean(mine?.cast);
    if (serverCasting) castingTicks += 1;
    if (serverCasting && !serverWasCasting) combat.committed += 1;
    serverWasCasting = serverCasting;

    // What the player is looking at, against what the server is doing. Read from
    // `fresh` -- the view *after* this tick's press -- because a bar that only
    // appears on the next tick is a bar that appeared late.
    const hasBar = fresh.casts.some((cast) => cast.entityId === fresh.selfEntityId);
    if (!hadBar && hasBar) serverCastSeenThisBar = false;
    if (serverCasting) serverCastSeenThisBar = true;
    hadBar = hasBar;

    // A tick-by-tick picture of the disagreement, which a percentage cannot give
    // you: whether the client is a tick late at the start of every blow or a
    // handful late at the end of it are different bugs with the same number.
    // `.` neither, `C` both, `s` server only, `c` client only.
    if (process.env.DEBUG_CAST) {
      timeline.push(serverCasting ? (hasBar ? 'C' : 's') : hasBar ? 'c' : '.');
    }

    combat.sampled += 1;
    if (serverCasting && !hasBar) combat.barMissing += 1;
    if (!serverCasting && hasBar) {
      if (serverCastSeenThisBar) combat.barLingering += 1;
      else combat.barEarly += 1;
    }
    if (serverCasting && !fresh.selfRoot) combat.underRoot += 1;
    // The sweep is only wrong when the server says "not yet" and the client's
    // own table says "ready" -- a button that looks pressable and is not.
    const serverReadyAt = mine?.cooldowns['melee.slash'] ?? 0;
    if (serverState().tick < serverReadyAt && (fresh.cooldowns['melee.slash'] ?? 0) <= fresh.estimatedTick) {
      combat.sweepMissing += 1;
    }
    const claimed = client.sendInput({
      moveX: intent.moveX,
      moveY: intent.moveY,
      facing: intent.facing,
      buttons: 0,
    });
    // Keyed by the client's own sequence number, which starts at its first
    // accepted input rather than at tick one -- a correction names a seq.
    if (claimed) {
      sentSeq += 1;
      claims.set(sentSeq, { x: claimed.x, y: claimed.y });
    }

    const after = client.view().self;
    if (after && previous) {
      const step = Math.hypot(after.x - previous.x, after.y - previous.y);
      // A tick of walking is a few units; anything much past that is a jump the
      // player sees rather than a step they took.
      if (step > 8) maxSnap = Math.max(maxSnap, step);
    }
    previous = after ? { x: after.x, y: after.y } : null;
  }

  if (process.env.DEBUG_CAST) {
    console.log(`\n${label}`);
    for (let at = 0; at < timeline.length; at += 120) {
      console.log(`  ${String(at).padStart(4)} ${timeline.slice(at, at + 120).join('')}`);
    }
  }

  // Drift nudges are the system working -- small, eased, and gone. Anything else
  // is a snap the player sees.
  const hard = Object.entries(corrections)
    .filter(([name]) => name !== 'drift')
    .reduce((sum, [, count]) => sum + count, 0);
  return {
    label,
    corrections,
    hard,
    maxSnap,
    worstResidual,
    rooted: sampled === 0 ? 0 : rootedTicks / sampled,
    casting: sampled === 0 ? 0 : castingTicks / sampled,
    combat: { ...combat, instantBars },
  };
}

async function main(): Promise<void> {
  const ticks = Number(process.env.TICKS ?? 600);
  const only = process.env.ONLY;
  const cases: readonly (readonly [string, number])[] = ([
    ['loopback   0ms', 0],
    ['lan       50ms', 3],
    ['wan      100ms', 6],
    ['poor     200ms', 12],
  ] as const).filter(([label]) => !only || label.includes(only));
  const rows: Run[] = [];
  for (const [label, delay] of cases) rows.push(await run(label, delay, ticks));

  console.log(
    `\n${ticks} ticks (${(ticks / SERVER_TICK_RATE).toFixed(1)}s), swinging every 0.5s, ` +
      `${(SERVER_TICK_RATE / TICKS_PER_FRAME).toFixed(0)}fps\n`,
  );
  console.log(
    'round trip       hard snaps   by reason                      worst jump   worst error   rooted/casting',
  );
  for (const row of rows) {
    const reasons = Object.entries(row.corrections)
      .map(([name, count]) => `${name}=${count}`)
      .join(' ');
    console.log(
      `${row.label.padEnd(17)}${String(row.hard).padEnd(13)}${(reasons || '-').padEnd(31)}` +
        `${row.maxSnap.toFixed(1).padEnd(13)}${row.worstResidual.toFixed(1).padEnd(14)}` +
        `${(row.rooted * 100).toFixed(0)}% / ${(row.casting * 100).toFixed(0)}%`,
    );
  }

  // The combat half (spec 069). Every column is a disagreement between what the
  // player sees and what the server is doing, as a percentage of the session.
  console.log('\nwhat the blow felt like -- % of ticks the client disagreed with the server\n');
  console.log(
    'round trip       no bar   early bar   lingering bar   under-root   dead sweep   instant/cast   refused',
  );
  for (const row of rows) {
    const pct = (value: number): string =>
      row.combat.sampled === 0 ? '-' : `${((value / row.combat.sampled) * 100).toFixed(0)}%`;
    console.log(
      `${row.label.padEnd(17)}${pct(row.combat.barMissing).padEnd(9)}` +
        `${pct(row.combat.barEarly).padEnd(12)}${pct(row.combat.barLingering).padEnd(16)}` +
        `${pct(row.combat.underRoot).padEnd(13)}${pct(row.combat.sweepMissing).padEnd(13)}` +
        `${`${row.combat.instantBars} / ${row.combat.committed}`.padEnd(15)}` +
        `${row.combat.refused}`,
    );
  }
  console.log('');
}

void main();
