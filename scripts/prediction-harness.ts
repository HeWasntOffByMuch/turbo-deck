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
import { decodeServerMessage } from '../src/server/net/messages.js';
import { CorrectionReason, ServerMessageType } from '../src/server/net/protocol.js';
import type { Channel } from '../src/server/net/transport.js';
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

/**
 * A channel that holds every frame in both directions for a fixed number of
 * ticks. Deterministic on purpose -- jitter would make the numbers below a
 * different story every run, and constant delay is enough to expose anything
 * that only works because the round trip is free.
 */
class DelayLine implements Channel {
  private readonly outbound: { at: number; bytes: Uint8Array }[] = [];
  private readonly inbound: { at: number; bytes: Uint8Array }[] = [];
  private handler: ((bytes: Uint8Array) => void) | null = null;
  private tick = 0;

  constructor(
    private readonly inner: Channel,
    private readonly delayTicks: number,
    private readonly onServerFrame: (bytes: Uint8Array) => void,
  ) {
    inner.onMessage((bytes) => {
      this.inbound.push({ at: this.tick + this.delayTicks, bytes });
    });
  }

  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  send(bytes: Uint8Array): void {
    this.outbound.push({ at: this.tick + this.delayTicks, bytes: new Uint8Array(bytes) });
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.inner.onClose(handler);
  }

  close(): void {
    this.inner.close();
  }

  get tickNow(): number {
    return this.tick;
  }

  /** Releases everything due at or before `tick`. */
  pump(tick: number): void {
    this.tick = tick;
    while (this.outbound.length > 0 && (this.outbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.outbound.shift();
      if (frame) this.inner.send(frame.bytes);
    }
    while (this.inbound.length > 0 && (this.inbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.inbound.shift();
      if (!frame) break;
      this.onServerFrame(frame.bytes);
      this.handler?.(frame.bytes);
    }
  }
}

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
  const line = new DelayLine(transport.connect(), delayTicks, (bytes) => {
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
      line.pump(tick);
      await settle();
      line.pump(tick);
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
      client.useAbility('melee.slash', view.self.x + 100, view.self.y);
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
      const srv = (server as unknown as { state: { tick: number; entities: Map<number, { cast: unknown; position: { x: number } }> } }).state;
      const mine = srv.entities.get(view.selfEntityId);
      console.log(
        `t=${tick} est=${view.estimatedTick} srvTick=${srv.tick} rtt=${view.roundTripTicks} ` +
          `root=${view.selfRoot ? 'Y' : 'n'} srvCast=${mine?.cast ? 'Y' : 'n'} ` +
          `cd=${JSON.stringify(view.cooldowns)} move=${intent.moveX.toFixed(1)} ` +
          `local=${me.x.toFixed(1)} srv=${mine?.position.x.toFixed(1)}`,
      );
    }
    sampled += 1;
    if (fresh.selfRoot) rootedTicks += 1;
    if (
      (
        server as unknown as { state: { entities: Map<number, { cast: unknown }> } }
      ).state.entities.get(view.selfEntityId)?.cast
    ) {
      castingTicks += 1;
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
  console.log('');
}

void main();
