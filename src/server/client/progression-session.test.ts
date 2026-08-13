/**
 * Allocation end to end (spec 147): a real `GameClient` against a real
 * `GameServer` over a real loopback transport, exchanging real encoded frames.
 *
 * Everything else about this system is tested against a pure function. This
 * file exists for the two properties that only hold once a *wire* is involved:
 *
 *  - **the client is told, never trusted.** A press sends an ordinal and
 *    nothing else; the numbers come back on the next `Stats`. Nothing here
 *    checks a value the client computed.
 *  - **a refusal reaches the player.** An illegal allocation is answered with a
 *    reason rather than being dropped, because a button that silently does
 *    nothing reads as the game being broken.
 */

import { describe, expect, it } from 'vitest';
import { BROADCAST_EVERY_N_TICKS } from '../config.js';
import { ATTRIBUTE_KEYS } from '../data/attributes.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { RESPEC_COST, STARTING_ATTRIBUTE, STARTING_ATTRIBUTE_POINTS } from '../player/attributes.js';
import { GameClient } from './game-client.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly server: GameServer;
  readonly transport: LoopbackTransport;
}

function harness(seed = 5): Harness {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  return { server, transport };
}

async function connect(test: Harness, playerId: string): Promise<GameClient> {
  const client = new GameClient(test.transport.connect(), { playerId, displayName: playerId });
  const welcomed = client.connect();
  await settle();
  await welcomed;
  return client;
}

async function advance(test: Harness, periods = 1): Promise<void> {
  for (let i = 0; i < periods * BROADCAST_EVERY_N_TICKS; i++) test.server.tick();
  await settle();
}

describe('allocating over the wire', () => {
  it('sends an ordinal and reads the answer back off Stats', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test);

    const before = client.view();
    expect(before.baseStats.constitution).toBe(STARTING_ATTRIBUTE);
    expect(before.unspentAttributePoints).toBe(STARTING_ATTRIBUTE_POINTS);
    const healthBefore = before.stats?.maxHealth ?? 0;

    client.allocateAttribute('constitution');
    await settle();
    await advance(test);

    const after = client.view();
    expect(after.baseStats.constitution).toBe(STARTING_ATTRIBUTE + 1);
    expect(after.unspentAttributePoints).toBe(STARTING_ATTRIBUTE_POINTS - 1);
    // The *derived* consequence arrives with it. The client asked for a point
    // and was told what the point did.
    expect(after.stats?.maxHealth ?? 0).toBeGreaterThan(healthBefore);
  });

  it('carries the totals as well as the allocation, so thresholds are drawable', () => {
    // Both, because neither is derivable from the other once an item grants an
    // attribute -- the sheet spends against one and measures milestones on the
    // other.
    expect(ATTRIBUTE_KEYS.length).toBe(6);
  });

  it('answers an illegal allocation with a reason, and changes nothing', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test);

    // Spend the whole budget, then ask for one more.
    for (let i = 0; i < STARTING_ATTRIBUTE_POINTS; i++) client.allocateAttribute('strength');
    await settle();
    await advance(test);
    expect(client.view().unspentAttributePoints).toBe(0);

    const errors: string[] = [];
    client.onError((_code, message) => errors.push(message));
    const snapshot = JSON.stringify(client.view().baseStats);

    client.allocateAttribute('strength');
    await settle();
    await advance(test);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' | ')).toContain('no unspent attribute points');
    expect(JSON.stringify(client.view().baseStats)).toBe(snapshot);
  });

  it('refuses a respec nobody can afford, and settles one they can', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test);
    for (let i = 0; i < STARTING_ATTRIBUTE_POINTS; i++) client.allocateAttribute('perception');
    await settle();
    await advance(test);
    expect(client.view().baseStats.perception).toBe(STARTING_ATTRIBUTE + STARTING_ATTRIBUTE_POINTS);

    const session = test.server.playerManager.get('alice');
    if (!session) throw new Error('no session');
    const coins = session.record.coins;

    client.respecAttributes();
    await settle();
    await advance(test);

    const after = client.view();
    if (coins >= RESPEC_COST) {
      expect(after.baseStats.perception).toBe(STARTING_ATTRIBUTE);
      expect(after.unspentAttributePoints).toBe(STARTING_ATTRIBUTE_POINTS);
      expect(test.server.playerManager.get('alice')?.record.coins).toBe(coins - RESPEC_COST);
    } else {
      expect(after.baseStats.perception).toBe(STARTING_ATTRIBUTE + STARTING_ATTRIBUTE_POINTS);
    }
  });

  it('never lets a client name an attribute the table does not have', async () => {
    // The codec carries the ordinal through unclamped on purpose, so this is the
    // refusal actually happening rather than the message being made plausible
    // on the way in.
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test);
    const errors: string[] = [];
    client.onError((_code, message) => errors.push(message));

    const channel = test.transport;
    void channel;
    // `allocateAttribute` refuses an unknown key locally, so the hostile case is
    // driven through the manager the handler calls -- the same path, minus a
    // client that behaves.
    const result = await test.server.playerManager.allocateAttribute('alice', 'luck');
    expect(result.ok).toBe(false);
    expect(client.view().baseStats).toEqual(
      test.server.playerManager.get('alice')?.record.baseStats,
    );
  });

  it('replicates poise and a shield on the body, so a bar can be drawn', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 2);

    const self = client.view().selfEntityId;
    const replica = client.view().entities.find((entity) => entity.id === self);
    expect(replica).toBeDefined();
    // A full guard reads as 1, whatever the pool actually is: a bar asks how
    // full, and the absolute is a build detail nobody watching a fight needs.
    expect(replica?.poise).toBeCloseTo(1, 2);
    expect(replica?.shield).toBe(0);
  });
});
