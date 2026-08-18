/**
 * Putting something down, over the real wire (spec 168).
 *
 * The container rule is pinned down in `player/inventory.test.ts` and the
 * landing in `sim/loot.test.ts`. What is only true once there is a socket is
 * everything here: that a stack leaving a bag becomes exactly one object in the
 * world, that the object belongs to nobody, that it is readable the moment it
 * lands, that it can be taken straight back, and that a refusal takes the
 * client's guess with it.
 *
 * The one assertion that is about the deterministic core rather than about the
 * wire is the last: dropping consumes no randomness. It is here rather than in
 * the pure tests because the claim is about the *server* -- that the path from a
 * message arriving to an entity existing never touches `state.rng` -- and a pure
 * test cannot see that path.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { EntityKindValue } from '../sim/types.js';
import { RevealPhase } from '../sim/loot.js';
import { THROW_REACH } from '../sim/loot.js';
import { PICKUP_RANGE } from '../sim/world.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  readonly server: GameServer;
  readonly transport: LoopbackTransport;
  readonly clients: GameClient[];
  readonly tick: (times?: number) => Promise<void>;
}

function rig(seed = 4): Rig {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed, transport });
  // No ambient spawning: the only things in this world are the ones put there.
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const clients: GameClient[] = [];
  const tick = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      server.tick();
      for (const client of clients) client.advanceTick();
      await settle();
    }
  };
  return { server, transport, clients, tick };
}

async function join(r: Rig, playerId: string): Promise<GameClient> {
  const client = new GameClient(r.transport.connect(), { playerId, displayName: playerId });
  const welcome = client.connect();
  await settle();
  await welcome;
  await settle();
  r.clients.push(client);
  return client;
}

function drops(r: Rig): { id: number; defId: string; count: number; owner: string | null }[] {
  const out: { id: number; defId: string; count: number; owner: string | null }[] = [];
  for (const entity of r.server.world.entities.values()) {
    if (entity.kind !== EntityKindValue.Drop || !entity.drop) continue;
    out.push({
      id: entity.id,
      defId: entity.drop.defId,
      count: entity.drop.count,
      owner: entity.drop.ownerPlayerId,
    });
  }
  return out;
}

function bodyOf(r: Rig, client: GameClient) {
  const entity = r.server.world.entities.get(client.view().selfEntityId);
  if (!entity) throw new Error('no body');
  return entity;
}

/** Where in the bag a given item is, as the client sees it. */
function slotOf(client: GameClient, defId: string): number {
  const index = client.view().inventory.findIndex((stack) => stack?.defId === defId);
  if (index < 0) throw new Error(`${defId} is not in the bag`);
  return index;
}

/** Point the body somewhere, and let the server apply the input. */
async function face(r: Rig, client: GameClient, facing: number): Promise<void> {
  // Long enough for the turn to *finish*: a body turns at its own rate (spec
  // 065), so four ticks of asking leaves it still coming round and the landing
  // measured against a facing it had not reached yet.
  for (let i = 0; i < 40; i++) {
    client.sendInput({ moveX: 0, moveY: 0, facing, buttons: 0 });
    await r.tick();
  }
}

describe('a player putting something down', () => {
  it('turns a stack in the bag into one object in the world', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await face(r, ana, 0);

    const index = slotOf(ana, 'potion.minor');
    const held = ana.view().inventory[index]?.count ?? 0;
    expect(held).toBeGreaterThan(0);

    ana.dropItem({ container: 'inventory', index });
    await r.tick(2);

    const landed = drops(r);
    expect(landed.length).toBe(1);
    expect(landed[0]?.defId).toBe('potion.minor');
    expect(landed[0]?.count).toBe(held);
    // Nobody's. A thing somebody discarded is not being protected from anybody.
    expect(landed[0]?.owner).toBeNull();
    // ...and the bag no longer has it.
    expect(ana.view().inventory[index]).toBeNull();
  });

  it('throws it in front of the body, close enough to pick back up', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await face(r, ana, Math.PI / 2);

    const body = bodyOf(r, ana);
    const from = { x: body.position.x, y: body.position.y };
    expect(body.facing).toBeCloseTo(Math.PI / 2, 6);
    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') });
    await r.tick(2);

    const id = drops(r)[0]?.id ?? -1;
    const entity = r.server.world.entities.get(id);
    if (!entity) throw new Error('no drop');
    const dx = entity.position.x - from.x;
    const dy = entity.position.y - from.y;
    expect(Math.hypot(dx, dy)).toBeCloseTo(THROW_REACH, 3);
    // In front: along the facing the body was holding, not merely nearby.
    expect(dx * Math.cos(body.facing) + dy * Math.sin(body.facing)).toBeCloseTo(THROW_REACH, 3);
    // Close enough to undo. A drop you have to walk to punishes a mis-click.
    expect(Math.hypot(dx, dy)).toBeLessThan(PICKUP_RANGE);
    // The arc's other end is where the body stands, so the throw draws itself.
    expect(entity.drop?.origin.x).toBeCloseTo(from.x, 6);
    expect(entity.drop?.origin.y).toBeCloseTo(from.y, 6);
  });

  it('is readable the moment it lands, with no reveal to wait through', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    // The keen longsword is rare -- the tier that has the longest run-up when a
    // monster leaves one. A player putting one down has none.
    await r.server.giveItem('ana', 'sword.keen', 1);
    await r.tick(2);

    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'sword.keen') });
    await r.tick(3);

    const seen = ana.view().drops;
    expect(seen.length).toBe(1);
    expect(seen[0]?.rarity).toBe('rare');
    expect(seen[0]?.defId).toBe('sword.keen');
    expect(seen[0]?.phase).toBe(RevealPhase.Revealed);
  });

  it('can be picked straight back up by the player who dropped it', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await face(r, ana, 0);

    const index = slotOf(ana, 'potion.minor');
    const held = ana.view().inventory[index]?.count ?? 0;
    ana.dropItem({ container: 'inventory', index });
    await r.tick(2);

    ana.pickUp(drops(r)[0]?.id ?? -1);
    await r.tick(2);

    expect(drops(r).length).toBe(0);
    const back = ana.view().inventory.find((stack) => stack?.defId === 'potion.minor');
    expect(back?.count).toBe(held);
  });

  it('can be picked up by somebody else, because it belongs to nobody', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    const bo = await join(r, 'bo');
    await r.tick(2);
    await face(r, ana, 0);

    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') });
    await r.tick(2);

    // Both spawn at the same place, so Bo is already standing over it.
    bo.pickUp(drops(r)[0]?.id ?? -1);
    await r.tick(2);

    expect(drops(r).length).toBe(0);
    expect(bo.view().inventory.some((stack) => stack?.defId === 'potion.minor')).toBe(true);
  });

  it('drops what is worn straight off the body', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await r.server.giveItem('ana', 'sword.worn', 1);
    await r.tick(2);
    await ana.equip('mainHand', 'sword.worn');
    await r.tick(2);
    expect(ana.view().equipment.mainHand).toBe('sword.worn');

    ana.dropItem({ container: 'equipment', index: 0 });
    await r.tick(2);

    expect(ana.view().equipment.mainHand).toBeNull();
    expect(drops(r).map((d) => d.defId)).toEqual(['sword.worn']);
  });

  it('refuses an empty slot, drops nothing, and takes the guess back', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);

    const empty = ana.view().inventory.findIndex((stack) => stack === null);
    ana.dropItem({ container: 'inventory', index: empty });
    await r.tick(2);

    expect(drops(r).length).toBe(0);
    expect(ana.view().inventory[empty]).toBeNull();
  });

  it('rolls a refused drop back into the bag', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);

    const index = slotOf(ana, 'potion.minor');
    const held = ana.view().inventory[index]?.count ?? 0;
    // More than is there: the local rules refuse it too, so nothing is drawn --
    // and the server's answer has to leave the bag exactly as it was either way.
    ana.dropItem({ container: 'inventory', index }, held + 5);
    await r.tick(2);

    expect(drops(r).length).toBe(0);
    expect(ana.view().inventory[index]?.count).toBe(held);
  });

  /**
   * The one that is about the sim rather than the wire.
   *
   * A kill's scatter draws from `state.rng`, so a drop that also drew would let
   * anybody shift every roll in the world after them by emptying their bag --
   * and a replay of the same seed and the same inputs would stop reproducing.
   */
  it('consumes no randomness', async () => {
    const run = async (drop: boolean): Promise<readonly number[]> => {
      const r = rig(77);
      const ana = await join(r, 'ana');
      await r.tick(4);
      if (drop) {
        ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') });
      }
      await r.tick(6);
      return r.server.world.rng.getState();
    };
    expect(await run(true)).toEqual(await run(false));
  });
});
