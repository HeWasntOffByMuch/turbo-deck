/**
 * The regression spec 069 exists for: what the *blow* looks like over a wire
 * that is not free.
 *
 * `latency.test.ts` asks whether the body ends up where the server says. This
 * asks a different question about the same session -- whether the player is
 * being shown what the server is doing -- and it needs its own measurements,
 * because a commit is several visible things at once and they fail in different
 * directions.
 *
 * Three of them, counted per tick:
 *
 *  - **missing** -- the server is casting and the client draws no bar. The press
 *    that appears to do nothing. On the code before this spec this is the round
 *    trip, every time, and it is the number the spec exists to remove.
 *  - **lingering** -- the client is still drawing a bar after the server's cast
 *    ended. Stillness the player is not getting anything for.
 *  - **unrooted** -- the client walked while the server held it rooted. The
 *    dangerous one: movement the server discards and later corrects.
 *
 * A bar drawn *before* the server's cast starts is deliberately not counted
 * against anything. A request is stamped to an input and committed when the
 * server dequeues that input, so there is always a window between the press and
 * the commit; drawing an empty bar across it is the honest answer to "did that
 * register", and standing still across it costs nothing (spec 067).
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
    while (this.outbound.length > 0 && (this.outbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.outbound.shift();
      if (frame) this.inner.send(frame.bytes);
    }
    while (this.inbound.length > 0 && (this.inbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.inbound.shift();
      if (!frame) break;
      this.watch(frame.bytes);
      this.handler?.(frame.bytes);
    }
  }
}

interface Played {
  readonly sampled: number;
  readonly missing: number;
  readonly lingering: number;
  readonly unrooted: number;
  readonly hardCorrections: number;
  /** Presses that put a bar on screen on the very tick they were made. */
  readonly instantBars: number;
  /** Casts the server actually began, counted from its own state. */
  readonly commits: number;
}

async function play(options: {
  readonly delayTicks: number;
  readonly ticksPerFrame: number;
  readonly ticks: number;
}): Promise<Played> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 7,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  let hardCorrections = 0;
  const line = new DelayLine(transport.connect(), options.delayTicks, (bytes) => {
    const message = decodeServerMessage(bytes);
    if (message.type !== ServerMessageType.Correction) return;
    if (message.reason !== CorrectionReason.Drift) hardCorrections += 1;
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
  let sampled = 0;
  let missing = 0;
  let lingering = 0;
  let unrooted = 0;
  let commits = 0;
  let instantBars = 0;
  let hadBar = false;
  let serverCastSeenThisBar = false;
  let serverWasCasting = false;

  // Commits are counted from the server's own state rather than from
  // `CastState`, because the server sends that message *twice* for one cast: once
  // at the commit and again when a turn finishes and the wind-up clock restarts
  // (spec 065). Counting messages double-counts every blow, and pairing them
  // one-to-one with presses mis-attributes every other one -- which is exactly
  // what made an earlier version of this test report a phantom four-tick delay
  // on alternate swings that the client was in fact drawing instantly.

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

    if (tick % 5 === 0) destination = { x: origin.x + 400, y: origin.y };
    if (tick % 7 === 0) {
      destination = null;
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

    const now = client.view();
    const me = now.self ?? view.self;
    let moveX = 0;
    if (!now.selfRoot && destination && Math.abs(destination.x - me.x) > 6) {
      moveX = Math.sign(destination.x - me.x);
    }
    client.sendInput({ moveX, moveY: 0, facing: 0, buttons: 0 });

    const after = client.view();
    const hasBar = after.casts.some((cast) => cast.entityId === after.selfEntityId);
    const serverCasting = Boolean(server.world.entities.get(after.selfEntityId)?.cast);

    if (!hadBar && hasBar) serverCastSeenThisBar = false;
    if (serverCasting && !serverWasCasting) commits += 1;
    serverWasCasting = serverCasting;
    if (serverCasting) serverCastSeenThisBar = true;
    hadBar = hasBar;

    sampled += 1;
    if (serverCasting && !hasBar) missing += 1;
    if (!serverCasting && hasBar && serverCastSeenThisBar) lingering += 1;
    if (serverCasting && !after.selfRoot) unrooted += 1;
  }

  return { sampled, missing, lingering, unrooted, hardCorrections, instantBars, commits };
}

describe('a swing, over a wire', () => {
  it('is drawn the instant it is asked for, and never late, on a free connection', async () => {
    const played = await play({ delayTicks: 0, ticksPerFrame: 3, ticks: 420 });

    // The session actually swung, or none of the rest means anything.
    expect(played.commits).toBeGreaterThan(5);

    // The headline, and the thing that was impossible before this spec: with no
    // network at all, the player is never looking at a body that is mid-swing
    // without a bar over it, and never walking while the server holds it still.
    expect(played.missing).toBe(0);
    expect(played.unrooted).toBe(0);
    // A press the server took is shown immediately -- not next frame, not next
    // round trip.
    // Exactly one bar per cast: every blow the server ran was heralded by a
    // press that lit a bar on the spot, and no press lit one for a blow that
    // never happened. `missing` says no swing went undrawn; this says nothing
    // was drawn that was not a swing, so the two together leave no room for the
    // bar to have been right by luck.
    expect(played.instantBars).toBe(played.commits);
  });

  it('does not buy that with corrections, at any latency', async () => {
    for (const delayTicks of [0, 3, 6, 12]) {
      const played = await play({ delayTicks, ticksPerFrame: 3, ticks: 420 });
      // Spec 067's guarantee, unspent: predicting the blow must not reintroduce
      // the snapping that predicting the walk removed.
      expect(played.hardCorrections).toBe(0);
      expect(played.commits).toBeGreaterThan(5);
    }
  });

  it('does not leave a bar standing after the blow is over', async () => {
    // Bounded rather than zero, and deliberately. The client ends a cast on
    // `estimatedTick`, which is a forward-biased ratchet and can lead the
    // server's clock by a tick or two, so a blow is held slightly past its
    // stamped end on purpose -- late costs a tick of stillness, early costs a
    // correction. What must not happen is a bar that waits for `CastEnded` to
    // arrive, which is a whole one-way trip and would show up here as tens of
    // percent.
    for (const delayTicks of [0, 3, 6]) {
      const played = await play({ delayTicks, ticksPerFrame: 3, ticks: 420 });
      expect(played.lingering / played.sampled).toBeLessThan(0.1);
    }
  });

  it('still lets the player walk between swings', async () => {
    // The trade the whole scheme rests on: a predicted cast roots the body, so a
    // bug that never releases it would score perfectly on every count above and
    // leave the player unable to move.
    const played = await play({ delayTicks: 6, ticksPerFrame: 3, ticks: 420 });
    expect(played.sampled).toBeGreaterThan(300);
    expect(played.unrooted + played.missing).toBeLessThan(played.sampled * 0.25);
  });
});

/** One tick of walking, for reference in the assertions above. */
export const STEP = 250 / SERVER_TICK_RATE;
