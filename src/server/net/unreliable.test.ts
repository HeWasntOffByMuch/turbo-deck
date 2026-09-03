/**
 * A wire you can make bad on purpose (spec 147).
 *
 * The assertion that matters most is the last one: a fixed input sequence
 * through a wire that is losing, jittering and duplicating produces **identical
 * authoritative state** on every run. Determinism is the property this repo is
 * built on and networking is where it usually dies, so a bad wire that could
 * not be replayed exactly would be a toy rather than a tool.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import { LoopbackTransport } from './transport-loop.js';
import { PERFECT_WIRE, UnreliableChannel, type WireConditions } from './unreliable.js';
import { GameServer } from '../server.js';
import { GameClient } from '../client/game-client.js';
import type { Channel } from './transport.js';

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

/** A channel that records what reached the far side, and nothing else. */
function sink(): Channel & { received: Uint8Array[] } {
  const received: Uint8Array[] = [];
  return {
    received,
    isOpen: true,
    send: (bytes) => void received.push(bytes),
    onMessage: () => undefined,
    onClose: () => undefined,
    close: () => undefined,
  };
}

/** Push `count` numbered frames through, delivering one tick at a time. */
function run(
  conditions: WireConditions,
  count: number,
  seed = 1,
): { out: number[]; arrivedOn: Map<number, number> } {
  const far = sink();
  const wire = new UnreliableChannel(far, () => conditions, Rng.fromSeed(seed));
  const arrivedOn = new Map<number, number>();
  const seen = new Set<number>();
  for (let tick = 0; tick < count + 200; tick++) {
    // Advance the clock, then send, then release. The wire stamps a frame from
    // the tick it was last advanced to, so sending before the advance would
    // date the frame to the previous tick -- which is what the `DelayLine` this
    // replaces did, and is why its call sites read one tick fast.
    const before = far.received.length;
    wire.deliver(tick);
    if (tick < count) wire.send(Uint8Array.of(tick & 0xff, (tick >> 8) & 0xff));
    wire.deliver(tick);
    for (let i = before; i < far.received.length; i++) {
      const frame = far.received[i];
      if (!frame) continue;
      const id = (frame[0] ?? 0) | ((frame[1] ?? 0) << 8);
      if (!seen.has(id)) {
        arrivedOn.set(id, tick);
        seen.add(id);
      }
    }
  }
  return {
    out: far.received.map((f) => (f[0] ?? 0) | ((f[1] ?? 0) << 8)),
    arrivedOn,
  };
}

describe('a perfect wire', () => {
  it('delivers everything, once, in order, on the tick it was sent', () => {
    const { out, arrivedOn } = run(PERFECT_WIRE, 50);
    expect(out).toEqual(Array.from({ length: 50 }, (_, i) => i));
    for (let i = 0; i < 50; i++) expect(arrivedOn.get(i)).toBe(i);
  });
});

describe('each condition does what it says', () => {
  it('delays by exactly the ticks asked for', () => {
    const { out, arrivedOn } = run({ ...PERFECT_WIRE, delayTicks: 7 }, 30);
    expect(out).toHaveLength(30);
    for (let i = 0; i < 30; i++) expect(arrivedOn.get(i)).toBe(i + 7);
  });

  it('loses everything at 1 and nothing at 0', () => {
    expect(run({ ...PERFECT_WIRE, loss: 1 }, 50).out).toHaveLength(0);
    expect(run({ ...PERFECT_WIRE, loss: 0 }, 50).out).toHaveLength(50);
  });

  it('loses roughly the share it was asked for', () => {
    const { out } = run({ ...PERFECT_WIRE, loss: 0.25 }, 2000);
    // Seeded, so this is a fact about one run rather than a flaky range.
    expect(out.length).toBeGreaterThan(1400);
    expect(out.length).toBeLessThan(1600);
  });

  it('duplicates every frame at 1', () => {
    const { out } = run({ ...PERFECT_WIRE, duplicate: 1 }, 20);
    expect(out).toHaveLength(40);
    // Adjacent, because a duplicate lands on its original's tick.
    expect(out.slice(0, 4)).toEqual([0, 0, 1, 1]);
  });

  it('keeps jitter inside its band, and genuinely reorders', () => {
    const conditions = { ...PERFECT_WIRE, delayTicks: 4, jitterTicks: 6 };
    const { out, arrivedOn } = run(conditions, 400);
    for (const [id, at] of arrivedOn) {
      expect(at).toBeGreaterThanOrEqual(id + 4);
      expect(at).toBeLessThanOrEqual(id + 4 + 6);
    }
    // Out of order at some point -- the whole reason release is due-tick
    // ordered rather than arrival ordered, and the only thing in this repo
    // that reaches the server's stale-sequence drop.
    let reordered = false;
    for (let i = 1; i < out.length; i++) {
      if ((out[i] ?? 0) < (out[i - 1] ?? 0)) reordered = true;
    }
    expect(reordered).toBe(true);
  });
});

describe('the draw sequence', () => {
  it('does not depend on the settings', () => {
    // Rule 1: every frame draws all three values whatever the conditions say.
    // If it did not, turning loss up would silently change the *jitter* on
    // every later frame, and two runs that differed in one number would differ
    // in all of them.
    const clean = run({ ...PERFECT_WIRE, delayTicks: 2, jitterTicks: 5 }, 300);
    const lossy = run({ ...PERFECT_WIRE, delayTicks: 2, jitterTicks: 5, loss: 0.3 }, 300);
    let compared = 0;
    for (const [id, at] of lossy.arrivedOn) {
      const cleanAt = clean.arrivedOn.get(id);
      if (cleanAt === undefined) continue;
      // The frames the lossy wire did not drop got exactly the jitter the
      // clean wire gave them.
      expect(at).toBe(cleanAt);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('differs between seeds, so the tests are not passing on a still wire', () => {
    const conditions = { ...PERFECT_WIRE, delayTicks: 2, jitterTicks: 6, loss: 0.2 };
    const a = run(conditions, 300, 1);
    const b = run(conditions, 300, 2);
    expect(a.out).not.toEqual(b.out);
  });
});

// --- the property the repo is built on -----------------------------------

interface Snapshot {
  readonly tick: number;
  readonly entities: [number, number, number, number, number, number][];
}

async function playThroughWire(conditions: WireConditions, seed: number): Promise<Snapshot> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 11, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  // The handshake goes over a clean wire and the fight goes over the bad one.
  // Not a dodge: without reconnect (spec 150) a dropped `Hello` is a connection
  // that never happens, and this test is about whether the *fight* replays, not
  // about surviving a lost handshake. It also exercises the thing the design
  // is built around -- conditions read per frame, so a slider moves mid-session.
  let live: WireConditions = PERFECT_WIRE;
  const wire = new UnreliableChannel(transport.connect(), () => live, Rng.fromSeed(seed));
  const client = new GameClient(wire, { playerId: 'ana', displayName: 'Ana' });

  let tick = 0;
  const step = async (): Promise<void> => {
    tick += 1;
    wire.deliver(tick);
    server.tick();
    client.advanceTick();
    await settle();
    wire.deliver(tick);
    await settle();
  };

  let connected = false;
  const welcome = client.connect().then((info) => {
    connected = true;
    return info;
  });
  for (let i = 0; i < 60 && !connected; i++) await step();
  await welcome;

  live = conditions;

  // A fixed input sequence. Nothing here reads a clock or draws a number: the
  // only nondeterminism in the whole run is the wire's, and it is seeded.
  for (let i = 0; i < 400; i++) {
    const angle = (tick + 1) * 0.037;
    client.sendInput({ moveX: Math.cos(angle), moveY: Math.sin(angle), facing: angle, buttons: 0 });
    await step();
  }

  const entities: [number, number, number, number, number, number][] = [];
  for (const entity of server.world.entities.values()) {
    entities.push([
      entity.id,
      entity.position.x,
      entity.position.y,
      entity.position.z,
      entity.health,
      entity.activity,
    ]);
  }
  entities.sort((a, b) => a[0] - b[0]);
  client.disconnect();
  return { tick: server.world.tick, entities };
}

describe('a fixed input sequence through a bad wire', () => {
  const BAD: WireConditions = { delayTicks: 4, jitterTicks: 5, loss: 0.1, duplicate: 0.05 };

  it('produces identical authoritative state, every run', async () => {
    const first = await playThroughWire(BAD, 7);
    const second = await playThroughWire(BAD, 7);
    const third = await playThroughWire(BAD, 7);
    // Every entity's position, health and activity -- not a summary. A hash
    // that collided would be a worse test than no test.
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  }, 60_000);

  it('is a different fight on a different wire seed, so the above means something', async () => {
    const one = await playThroughWire(BAD, 7);
    const other = await playThroughWire(BAD, 99);
    expect(other).not.toEqual(one);
  }, 60_000);

  it('leaves the player somewhere the server agrees with, despite the losses', async () => {
    // The two lines nothing had ever executed: `server.ts:414` drops an input
    // whose seq has already been applied, and `server.ts:1189` widens the
    // speed allowance when the sequence skips. A body that ended up nowhere,
    // or that got flagged and dragged back to spawn, would show here.
    const played = await playThroughWire(BAD, 7);
    const player = played.entities[0];
    if (!player) throw new Error('expected a player');
    expect(player[4]).toBeGreaterThan(0);
    expect(Number.isFinite(player[1])).toBe(true);
    expect(Number.isFinite(player[2])).toBe(true);
    // It moved: a wire this bad must not amount to a body that never left spawn.
    expect(Math.hypot(player[1] - 600, player[2] - 450)).toBeGreaterThan(1);
  }, 60_000);
});
