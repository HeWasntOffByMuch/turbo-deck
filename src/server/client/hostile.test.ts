/**
 * A hostile client (spec 151), against a real server.
 *
 * Two properties. Arbitrary frames must not be able to hurt the world or the
 * player standing next to the attacker; and a fuzzed sequence of trade verbs
 * must not be able to change how many items exist.
 *
 * The second is spec 132's rule taken off its script: a duplication bug leaves
 * each bag individually plausible, so the thing that has to be counted is
 * *both together*.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { TradeStageValue } from '../net/protocol.js';
import { MAX_FRAME_BYTES, MAX_NAME_LENGTH } from '../net/rate-limit.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  readonly server: GameServer;
  readonly transport: LoopbackTransport;
  readonly tick: (times?: number) => Promise<void>;
}

function rig(): Rig {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 8, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const tick = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      server.tick();
      await settle();
    }
  };
  return { server, transport, tick };
}

async function join(r: Rig, playerId: string, displayName = playerId): Promise<GameClient> {
  const client = new GameClient(r.transport.connect(), { playerId, displayName });
  const welcome = client.connect();
  await settle();
  await welcome;
  await settle();
  return client;
}

/** Every item either player is holding, plus whatever is on the table. */
function itemsAcross(r: Rig, ids: readonly string[]): number {
  let total = 0;
  for (const id of ids) {
    for (const stack of r.server.playerManager.get(id)?.record.inventory ?? []) {
      if (stack) total += stack.count;
    }
  }
  return total;
}

function coinsAcross(r: Rig, ids: readonly string[]): number {
  let total = 0;
  for (const id of ids) total += r.server.playerManager.get(id)?.record.coins ?? 0;
  return total;
}

describe('arbitrary frames at a real server', () => {
  it('never throw, and never hurt the player standing next to them', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    const attacker = r.transport.connect();
    const raw = r.server.accept(attacker);
    await r.tick(4);

    const anaEntity = ana.view().selfEntityId;
    const healthBefore = ana.view().entities.find((e) => e.id === anaEntity)?.health ?? 0;
    expect(healthBefore).toBeGreaterThan(0);

    // Deliberately not through `encodeClientMessage`: the point is bytes
    // nothing in this repo would ever produce.
    const rng = fc.sample(fc.uint8Array({ minLength: 0, maxLength: 300 }), {
      numRuns: 400,
      seed: 20260812,
    });
    for (const frame of rng) {
      await r.server.receive(raw, frame);
    }
    await r.tick(10);

    // The world is still coherent.
    const ids = new Set<number>();
    for (const entity of r.server.world.entities.values()) {
      expect(Number.isFinite(entity.position.x)).toBe(true);
      expect(Number.isFinite(entity.position.y)).toBe(true);
      expect(Number.isFinite(entity.health)).toBe(true);
      expect(ids.has(entity.id)).toBe(false);
      ids.add(entity.id);
    }
    // And the innocent client beside it is untouched and still playing.
    expect(ana.view().entities.find((e) => e.id === anaEntity)?.health).toBe(healthBefore);
    ana.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
    await r.tick(4);
    expect(ana.view().connected).toBe(true);
  }, 60_000);

  it('drops an oversized frame without parsing it, and survives', async () => {
    const r = rig();
    const raw = r.server.accept(r.transport.connect());
    await r.server.receive(raw, new Uint8Array(MAX_FRAME_BYTES + 1).fill(0x07));
    await r.tick(2);
    // Nothing threw, and the connection is still usable.
    const ana = await join(r, 'ana');
    expect(ana.view().connected).toBe(true);
  });

  it('will not broadcast a name of any length somebody likes', async () => {
    const r = rig();
    const ana = await join(r, 'ana', 'A'.repeat(10_000));
    const ben = await join(r, 'ben');
    await r.tick(8);
    const anaId = ana.view().selfEntityId;
    const seen = ben.view().entities.find((e) => e.id === anaId)?.name ?? '';
    expect(seen.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });
});

describe('a fuzzed trade cannot change how much exists', () => {
  it('keeps both bags and both purses balanced, whatever the sequence', async () => {
    // A fixed prologue, then a random tail.
    //
    // Purely random sequences never complete a trade -- the protocol needs an
    // invite answered before anything else means anything -- and a property
    // about totals that is only ever exercised on trades that did not happen is
    // no property at all. The `swapsCompleted` assertion at the bottom is what
    // makes that failure loud rather than silent; this is the fix it forced.
    const VERBS = ['offer', 'accept', 'cancel', 'invite', 'accept-invite', 'refuse-invite', 'walk'] as const;
    const tails = fc.sample(fc.array(fc.constantFrom(...VERBS), { minLength: 6, maxLength: 24 }), {
      numRuns: 16,
      seed: 424242,
    });
    const sequences = tails.map((tail) => ['invite', 'accept-invite', 'offer', ...tail] as const);

    // Counted so this cannot pass by never trading. A property test that
    // asserts a total is unchanged is trivially satisfied by a run in which
    // nothing happened.
    let swapsCompleted = 0;
    for (const sequence of sequences) {
      const r = rig();
      const ana = await join(r, 'ana');
      const ben = await join(r, 'ben');
      await r.tick(6);

      const ids = ['ana', 'ben'];
      const itemsBefore = itemsAcross(r, ids);
      const coinsBefore = coinsAcross(r, ids);

      for (const verb of sequence) {
        switch (verb) {
          case 'invite':
            ana.inviteToTrade(ben.view().selfEntityId);
            break;
          case 'accept-invite':
            ben.respondToTrade(true);
            break;
          case 'refuse-invite':
            ben.respondToTrade(false);
            break;
          case 'offer': {
            // Offer whatever is in the first two slots, from both sides.
            ana.offerInTrade([{ index: 0, count: 1 }], 1);
            ben.offerInTrade([{ index: 1, count: 1 }], 0);
            break;
          }
          case 'accept':
            ana.acceptTrade(ana.view().trade?.revision ?? 0);
            ben.acceptTrade(ben.view().trade?.revision ?? 0);
            break;
          case 'cancel':
            ana.cancelTrade();
            break;
          case 'walk':
            ana.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
            break;
        }
        await r.tick(3);
      }
      await r.tick(10);
      if (
        ana.endedTrade?.stage === TradeStageValue.Done ||
        ben.endedTrade?.stage === TradeStageValue.Done
      ) {
        swapsCompleted += 1;
      }

      // The whole point: counted together. A swap that duplicated a sword
      // leaves each bag individually plausible and only this sum notices.
      expect(itemsAcross(r, ids)).toBe(itemsBefore);
      expect(coinsAcross(r, ids)).toBe(coinsBefore);
    }
    // Five of sixteen, at this seed. Not a majority, and it does not need to
    // be -- it needs to not be zero, which it silently was before this line.
    expect(swapsCompleted).toBeGreaterThan(0);
  }, 120_000);
});
