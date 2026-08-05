/**
 * The regression spec 067 exists for: prediction over a connection that is not
 * free (spec 067).
 *
 * Single-player is a server in the same tab, so every reply comes back within a
 * frame and a prediction bug has nowhere to show. This puts a delay line between
 * a real `GameClient` and a real `GameServer` -- the same encoded frames, held
 * for a fixed number of ticks in each direction -- and plays the pattern that
 * was reported: keep ordering a walk, keep swinging, in the same direction.
 *
 * What it asserts is the thing a player feels. Not "the prediction is perfect"
 * -- it is not, and drift nudges are the system working -- but that nothing ever
 * *snaps*: no hard correction, and no jump in the drawn position larger than a
 * step.
 */

import { describe, expect, it } from 'vitest';
import { createWorldColliders } from '../../sim/collision.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../config.js';
import { decodeServerMessage } from '../net/messages.js';
import { CorrectionReason, ServerMessageType } from '../net/protocol.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import type { Channel } from '../net/transport.js';
import { GameServer } from '../server.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { GameClient } from './game-client.js';
import { createWorldPredictor } from './prediction.js';

/** Lets the loopback's queued microtasks drain. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Holds every frame, in both directions, for a fixed number of ticks. */
class DelayLine implements Channel {
  private readonly outbound: { at: number; bytes: Uint8Array }[] = [];
  private readonly inbound: { at: number; bytes: Uint8Array }[] = [];
  private handler: ((bytes: Uint8Array) => void) | null = null;
  private tick = 0;

  constructor(
    private readonly inner: Channel,
    private readonly delayTicks: number,
    private readonly watch: (bytes: Uint8Array) => void,
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

  deliver(tick: number): void {
    this.tick = tick;
    while ((this.outbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.outbound.shift();
      if (frame) this.inner.send(frame.bytes);
    }
    while ((this.inbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.inbound.shift();
      if (!frame) break;
      this.watch(frame.bytes);
      this.handler?.(frame.bytes);
    }
  }
}

interface Played {
  readonly reasons: Record<number, number>;
  readonly worstJump: number;
  readonly ticksWalked: number;
}

/**
 * Plays the reported pattern for `ticks`, with `delayTicks` of one-way latency
 * and `ticksPerFrame` ticks between message deliveries -- the second matters as
 * much as the first, since the renderer drains its inbox once a frame.
 */
async function play(options: {
  readonly delayTicks: number;
  readonly ticksPerFrame: number;
  readonly ticks: number;
}): Promise<Played> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 7,
    transport,
    // Open ground, so client and server agree about movement exactly and the
    // only thing that can diverge is the thing under test.
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const reasons: Record<number, number> = {};
  const line = new DelayLine(transport.connect(), options.delayTicks, (bytes) => {
    const message = decodeServerMessage(bytes);
    if (message.type !== ServerMessageType.Correction) return;
    reasons[message.reason] = (reasons[message.reason] ?? 0) + 1;
  });

  const client = new GameClient(line, {
    playerId: 'you',
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: createWorldColliders([], []),
        terrain: FLAT_TERRAIN,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  void client.connect();

  let destination: { x: number; y: number } | null = null;
  let origin: { x: number; y: number } | null = null;
  let drawn: { x: number; y: number } | null = null;
  let worstJump = 0;
  let ticksWalked = 0;

  for (let tick = 1; tick <= options.ticks; tick++) {
    if (tick % options.ticksPerFrame === 1 || options.ticksPerFrame === 1) {
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

    // Right click every five ticks, left click every seven: the reported
    // pattern, at a pace no human quite manages.
    if (tick % 5 === 0) destination = { x: origin.x + 400, y: origin.y };
    if (tick % 7 === 0) {
      destination = null;
      client.useAbility('melee.slash', view.self.x + 100, view.self.y);
    }

    // What `moveIntent` does, reduced to the two rules this exercises: a root
    // outranks a move order, and a move order is a unit vector at the goal.
    const now = client.view();
    const me = now.self ?? view.self;
    let moveX = 0;
    if (!now.selfRoot && destination && Math.abs(destination.x - me.x) > 6) {
      moveX = Math.sign(destination.x - me.x);
      ticksWalked += 1;
    }
    client.sendInput({ moveX, moveY: 0, facing: 0, buttons: 0 });

    const after = client.view().self;
    if (after && drawn) {
      worstJump = Math.max(worstJump, Math.hypot(after.x - drawn.x, after.y - drawn.y));
    }
    drawn = after ? { x: after.x, y: after.y } : null;
  }

  return { reasons, worstJump, ticksWalked };
}

/** One tick of walking, which is the size a step is allowed to be. */
const STEP = 250 / SERVER_TICK_RATE;

describe('a move order and a swing, over a wire', () => {
  const CASES = [
    { label: 'loopback', delayTicks: 0 },
    { label: '50ms', delayTicks: 3 },
    { label: '100ms', delayTicks: 6 },
    { label: '200ms', delayTicks: 12 },
  ];

  for (const runCase of CASES) {
    it(`is never snapped at ${runCase.label}`, async () => {
      const played = await play({ delayTicks: runCase.delayTicks, ticksPerFrame: 3, ticks: 420 });

      // Every reason but drift is a hard correction: the client is moved rather
      // than eased, and the player sees it.
      const hard = Object.entries(played.reasons)
        .filter(([reason]) => Number(reason) !== CorrectionReason.Drift)
        .reduce((sum, [, count]) => sum + count, 0);
      expect(hard).toBe(0);

      // And nothing the player is looking at ever moves further in one tick
      // than a body can walk -- drift is eased, not applied.
      expect(played.worstJump).toBeLessThanOrEqual(STEP + 1e-6);
    });
  }

  it('still lets the player walk between swings', async () => {
    // The other half of the trade: predicting the root must not root a player
    // who is not casting. Committing costs mobility; asking to costs some of it;
    // neither may cost all of it.
    const played = await play({ delayTicks: 3, ticksPerFrame: 3, ticks: 420 });
    expect(played.ticksWalked).toBeGreaterThan(20);
  });
});
