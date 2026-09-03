/**
 * Steering by the server's clock (spec 148).
 *
 * The controller is a fold, so most of this drives it with a list. The two that
 * matter run a *real* server against a client whose clock is deliberately
 * wrong, because the number worth having is not "the scale converged" -- it is
 * "the server stopped throwing the player's inputs away".
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  NOMINAL,
  QUEUE_DEADBAND,
  SCALE_STEP,
  TARGET_QUEUE_DEPTH,
  observeQueue,
  type RateMatchState,
} from './rate-match.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { MAX_BUFFERED_INPUTS } from '../config.js';

/**
 * Yield the event loop, so anything the loopback queued is delivered.
 *
 * `setImmediate` rather than `setTimeout(resolve, 0)` (spec 274). Node clamps a
 * zero timeout to one millisecond, so a settle awaited twice per simulated tick
 * cost 1.12ms of doing nothing against this call's 0.004ms -- 147 of the suite's
 * 330 CPU-seconds, and 39.6s of `rate-match.test.ts` alone. It is also the
 * stronger barrier: the check phase runs after the poll phase, where a timer
 * fires at the top of the next loop iteration.
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fold(depths: readonly number[], from: RateMatchState = NOMINAL): RateMatchState {
  let state = from;
  for (const depth of depths) state = observeQueue(state, depth);
  return state;
}

describe('the controller', () => {
  it('leaves a client that needs nothing exactly alone', () => {
    const state = fold(Array.from({ length: 200 }, () => TARGET_QUEUE_DEPTH));
    expect(state.tickScale).toBe(1);
  });

  it('does not move inside the deadband', () => {
    for (const depth of [TARGET_QUEUE_DEPTH - QUEUE_DEADBAND, TARGET_QUEUE_DEPTH + QUEUE_DEADBAND]) {
      expect(fold(Array.from({ length: 50 }, () => depth)).tickScale).toBe(1);
    }
  });

  it('ticks slower when the queue is deep, and faster when it is starving', () => {
    // Deep: the client is ahead, so stretch its tick and let the server catch up.
    expect(fold(Array.from({ length: 200 }, () => 40)).tickScale).toBeGreaterThan(1);
    // Empty: the server is waiting, so shorten it.
    expect(fold(Array.from({ length: 200 }, () => 0)).tickScale).toBeLessThan(1);
  });

  it('never leaves its clamp, from either extreme', () => {
    for (const depth of [0, MAX_BUFFERED_INPUTS, 1e9, -1e9]) {
      const state = fold(Array.from({ length: 500 }, () => depth));
      expect(state.tickScale).toBeGreaterThanOrEqual(1 - MAX_SCALE);
      expect(state.tickScale).toBeLessThanOrEqual(1 + MAX_SCALE);
    }
  });

  it('cannot be stepped by one outlying sample', () => {
    let state = NOMINAL;
    const depths = [2, 60, 2, 0, 2, 60, 0, 2];
    for (const depth of depths) {
      const next = observeQueue(state, depth);
      expect(Math.abs(next.tickScale - state.tickScale)).toBeLessThanOrEqual(SCALE_STEP + 1e-12);
      state = next;
    }
  });

  it('settles back into the deadband rather than hunting', () => {
    // Out at the cap, then fixed: the correction must come off again, or it
    // pushes the queue straight out the other side.
    let state = fold(Array.from({ length: 200 }, () => MAX_BUFFERED_INPUTS));
    expect(state.tickScale).toBeGreaterThan(1);
    state = fold(Array.from({ length: 200 }, () => TARGET_QUEUE_DEPTH), state);
    expect(state.tickScale).toBe(1);
  });

  it('ignores a reading that is not a number', () => {
    const state = { tickScale: 1.01 };
    expect(observeQueue(state, Number.NaN)).toBe(state);
    expect(observeQueue(state, Number.POSITIVE_INFINITY)).toBe(state);
  });

  it('is pure: the same observations give the same answer', () => {
    const depths = [0, 1, 5, 40, 2, 2, 60, 3, 0, 2];
    expect(fold(depths)).toEqual(fold(depths));
  });
});

// --- what it is actually for ---------------------------------------------

interface Played {
  /** Inputs the server threw away because the queue was full. */
  readonly dropped: number;
  /** Ticks the server advanced having consumed nothing. */
  readonly starved: number;
  readonly deepest: number;
  readonly finalScale: number;
}

/**
 * Run a client whose clock is `drift` faster than the server's, for `seconds`.
 *
 * `steer` is the whole experiment: with it off the client sends one input per
 * tick of its own clock, which is what every version before spec 148 did.
 */
async function play(drift: number, seconds: number, steer: boolean): Promise<Played> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 3, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const client = new GameClient(transport.connect(), { playerId: 'ana', displayName: 'Ana' });
  const welcome = client.connect();
  await settle();
  await welcome;
  await settle();

  let dropped = 0;
  let starved = 0;
  let deepest = 0;

  // The client's clock, in units of server ticks. `drift` above 0 means it runs
  // fast, so it produces more than one input per server tick.
  let clientClock = 0;
  for (let tick = 0; tick < seconds * 60; tick++) {
    const scale = steer ? client.view().tickScale : 1;
    // A faster crystal makes more client ticks per server tick; steering
    // stretches the client's tick and takes some of that back.
    clientClock += (1 + drift) / scale;
    while (clientClock >= 1) {
      clientClock -= 1;
      client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      client.advanceTick();
    }
    await settle();

    const depth = server.inputQueueDepth('ana');
    deepest = Math.max(deepest, depth);
    if (depth >= MAX_BUFFERED_INPUTS) dropped += 1;
    if (depth === 0) starved += 1;
    server.tick();
    await settle();
  }

  const finalScale = client.view().tickScale;
  client.disconnect();
  return { dropped, starved, deepest, finalScale };
}

describe('a clock that does not match the server', () => {
  it('stops costing the player their inputs', async () => {
    // 2% fast over a minute is 72 extra inputs -- past the 60 the queue holds,
    // so it fills and then throws away the OLDEST thing in it: movement the
    // player made a second ago.
    const adrift = await play(0.02, 60, false);
    expect(adrift.deepest).toBeGreaterThanOrEqual(MAX_BUFFERED_INPUTS);
    expect(adrift.dropped).toBeGreaterThan(0);

    const steered = await play(0.02, 60, true);
    expect(steered.dropped).toBe(0);
    expect(steered.deepest).toBeLessThan(MAX_BUFFERED_INPUTS);
    // And it is steering, not coincidence: the scale went up to slow the client.
    expect(steered.finalScale).toBeGreaterThan(1);
  }, 60_000);

  it('stops starving the server when the clock runs slow', async () => {
    const adrift = await play(-0.02, 60, false);
    const steered = await play(-0.02, 60, true);
    expect(steered.starved).toBeLessThan(adrift.starved);
    expect(steered.finalScale).toBeLessThan(1);
  }, 60_000);

  it('leaves a matched clock at nominal', async () => {
    const matched = await play(0, 20, true);
    expect(matched.dropped).toBe(0);
    expect(Math.abs(matched.finalScale - 1)).toBeLessThanOrEqual(MAX_SCALE);
  }, 60_000);
});
