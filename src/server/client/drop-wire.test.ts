/**
 * Putting something down, over the real wire (spec 168).
 *
 * Two features in one message since the aim landed: the container half, and the
 * fact that a drop is an *action that needs facing* -- the body turns to the
 * point that was clicked before anything leaves the bag. The turn is the part
 * with the interesting failure modes, and it is the part only a real server can
 * be asked about: it happens over ticks, at the body's own rate, through the
 * same `resolveFacing` a cast turns through.
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
import { EntityKindValue, type ServerEntity } from '../sim/types.js';
import { RevealPhase } from '../sim/loot.js';
import { THROW_REACH } from '../sim/loot.js';
import { PICKUP_RANGE } from '../sim/world.js';
import { DROP_TURN_TIMEOUT_TICKS } from '../config.js';

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

/** A point `reach` away from `client`'s body, in the direction `angle`. */
function pointAt(r: Rig, client: GameClient, angle: number, reach = 300): { x: number; y: number } {
  const body = bodyOf(r, client);
  return {
    x: body.position.x + Math.cos(angle) * reach,
    y: body.position.y + Math.sin(angle) * reach,
  };
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

    // Aimed where the body is already looking, so there is no turn in the way
    // of what this test is about.
    ana.dropItem({ container: 'inventory', index }, pointAt(r, ana, 0));
    await r.tick(4);

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
    // Aimed a long way off, to make the point that the reach is the server's:
    // what the click gives is a direction.
    const aim = pointAt(r, ana, Math.PI / 2, 4000);
    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') }, aim);
    await r.tick(4);

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

    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'sword.keen') }, pointAt(r, ana, 0));
    await r.tick(5);

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
    ana.dropItem({ container: 'inventory', index }, pointAt(r, ana, 0));
    await r.tick(4);

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

    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') }, pointAt(r, ana, 0));
    await r.tick(4);

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

    ana.dropItem({ container: 'equipment', index: 0 }, pointAt(r, ana, 0));
    await r.tick(4);

    expect(ana.view().equipment.mainHand).toBeNull();
    expect(drops(r).map((d) => d.defId)).toEqual(['sword.worn']);
  });

  it('refuses an empty slot, drops nothing, and takes the guess back', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);

    const empty = ana.view().inventory.findIndex((stack) => stack === null);
    ana.dropItem({ container: 'inventory', index: empty }, pointAt(r, ana, 0));
    await r.tick(4);

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
    ana.dropItem({ container: 'inventory', index }, pointAt(r, ana, 0), held + 5);
    await r.tick(4);

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
        ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') }, pointAt(r, ana, 0));
      }
      await r.tick(10);
      return r.server.world.rng.getState();
    };
    expect(await run(true)).toEqual(await run(false));
  });
});

/**
 * The turn (spec 168).
 *
 * Everything here is about the gap between the press and the item existing --
 * that the gap is a turn rather than a delay, that it ends where it was aimed,
 * and that it ends *somehow* whatever the body does.
 */
describe('the body turns to what it was asked to put down', () => {
  it('holds the item until the heading has come round', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await face(r, ana, 0);

    const index = slotOf(ana, 'potion.minor');
    // Straight behind: the longest turn a body can be asked for.
    const aim = pointAt(r, ana, Math.PI);
    ana.dropItem({ container: 'inventory', index }, aim);

    await r.tick(3);
    const turning = bodyOf(r, ana);
    // Nothing has left the bag yet on the server...
    expect(drops(r).length).toBe(0);
    // The aim as the wire delivered it: f32, so it is the point that was
    // clicked to within a float and not the exact double that was sent.
    const held = r.server.world.entities.get(ana.view().selfEntityId)?.dropAim;
    expect(held?.x).toBeCloseTo(aim.x, 2);
    expect(held?.y).toBeCloseTo(aim.y, 2);
    // ...and the body is on its way round, rather than snapped to it.
    expect(Math.abs(turning.facing)).toBeGreaterThan(0);
    expect(Math.abs(turning.facing)).toBeLessThan(Math.PI - 1e-6);

    // Half a second is past any authored turn rate for half a revolution.
    await r.tick(40);
    expect(drops(r).length).toBe(1);
    expect(Math.abs(bodyOf(r, ana).facing)).toBeCloseTo(Math.PI, 3);
    // The aim is let go of the moment it is served: a body still turning toward
    // something it has already put down would ignore its own input forever.
    expect(r.server.world.entities.get(ana.view().selfEntityId)?.dropAim).toBeNull();
  });

  it('throws it toward the point that was clicked', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await face(r, ana, 0);

    const from = { ...bodyOf(r, ana).position };
    const aim = pointAt(r, ana, -Math.PI / 2, 900);
    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') }, aim);
    await r.tick(45);

    const entity = r.server.world.entities.get(drops(r)[0]?.id ?? -1);
    if (!entity) throw new Error('nothing was dropped');
    const dx = entity.position.x - from.x;
    const dy = entity.position.y - from.y;
    // A direction from the click and a reach from the server: nine hundred
    // units away is asked for and forty is what happens.
    expect(Math.hypot(dx, dy)).toBeCloseTo(THROW_REACH, 3);
    expect(Math.atan2(dy, dx)).toBeCloseTo(-Math.PI / 2, 3);
  });

  /**
   * The turn is not a root and not a commitment: there is nothing to refund, so
   * walking away is not a withdrawal the way it is from a cast (spec 079).
   */
  it('still puts it down if the player walks while it comes round', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await face(r, ana, 0);

    const before = { ...bodyOf(r, ana).position };
    const aim = pointAt(r, ana, Math.PI);
    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') }, aim);
    for (let i = 0; i < 45; i++) {
      ana.sendInput({ moveX: 0, moveY: 1, facing: Math.PI / 2, buttons: 0 });
      await r.tick();
    }

    expect(drops(r).length).toBe(1);
    // It walked: the drop did not root it.
    const after = bodyOf(r, ana).position;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1);
  });

  /** One turn, and then everything queued behind it, in the order asked for. */
  it('serves a queue of drops aimed at the same place in one turn', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await face(r, ana, 0);
    await r.server.giveItem('ana', 'sword.keen', 1);
    await r.tick(2);

    const aim = pointAt(r, ana, Math.PI);
    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') }, aim);
    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'sword.keen') }, aim);
    await r.tick(50);

    const landed = drops(r);
    expect(landed.length).toBe(2);
    expect(landed.map((d) => d.defId).sort()).toEqual(['potion.minor', 'sword.keen']);
    expect(r.server.world.entities.get(ana.view().selfEntityId)?.dropAim).toBeNull();
  });

  /**
   * The client turns its own body too (spec 168).
   *
   * It has to: this client never adopts the server's facing after the first
   * seed, so the aim it is holding is the only thing that makes the local
   * player's own body come round on screen.
   */
  it('holds the aim on the client until the answer arrives', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await face(r, ana, 0);

    const aim = pointAt(r, ana, Math.PI);
    ana.dropItem({ container: 'inventory', index: slotOf(ana, 'potion.minor') }, aim);
    expect(ana.view().dropAim).toEqual(aim);

    await r.tick(3);
    expect(ana.view().dropAim).toEqual(aim);

    await r.tick(45);
    expect(drops(r).length).toBe(1);
    expect(ana.view().dropAim).toBeNull();
  });

  /**
   * The safety valve. A body that cannot turn would otherwise hold a drop
   * forever -- and hold its own facing hostage to it, since a pending aim
   * outranks the input.
   *
   * A turn rate of zero is a training dummy's and no player row authors one, so
   * it is written onto the body here rather than reached through the content
   * tables. What is under test is the timeout, not how a body comes to be
   * unable to turn.
   */
  it('gives up on a turn that never arrives, and keeps the item', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await face(r, ana, 0);

    const id = ana.view().selfEntityId;
    const body = bodyOf(r, ana);
    // Written straight into the world, which is the one thing in this file that
    // reaches behind an interface. Nothing authored for a player has a turn rate
    // of zero and nothing in the game can set one, so the alternative is leaving
    // the safety valve untested -- and an untested timeout is exactly where an
    // off-by-one lives, because a wrong one fires on the first tick and looks
    // like a refusal nobody asked for.
    (r.server.world.entities as Map<number, ServerEntity>).set(id, {
      ...body,
      stats: { ...body.stats, turnRate: 0 },
    });

    const index = slotOf(ana, 'potion.minor');
    const held = ana.view().inventory[index]?.count ?? 0;
    ana.dropItem({ container: 'inventory', index }, pointAt(r, ana, Math.PI));

    await r.tick(DROP_TURN_TIMEOUT_TICKS + 4);
    expect(drops(r).length).toBe(0);
    // Refused, not eaten: the client's guess is taken back and the aim let go.
    expect(ana.view().inventory[index]?.count).toBe(held);
    expect(r.server.world.entities.get(id)?.dropAim).toBeNull();
  });
});
