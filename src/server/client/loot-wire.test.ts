/**
 * A drop over the real wire (spec 156).
 *
 * The pure half of this feature is pinned down in `sim/loot.test.ts`. What is
 * only true once there is a socket is everything here: that the server decides
 * what dropped, that a client is genuinely not sent the identity before the
 * reveal, that the reveal arrives on its own tick, that a late observer is told
 * on first sight, and -- the one that matters most -- that a drop turns into
 * exactly one stack in exactly one bag however many people ask for it.
 *
 * The kills are real kills. It would be quicker to stuff a drop into the world
 * and assert about it, but "the server decides the item" is a claim about the
 * path from a body dying to a thing lying on the ground, and a test that skipped
 * that path would not be making it.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { rarityOf, rarityToByte } from '../data/items.js';
import { rarityRow } from '../data/loot.js';
import { DEFAULT_SPAWN } from '../player/player-manager.js';
import { EntityKindValue } from '../sim/types.js';
import { RevealPhase } from '../sim/loot.js';
import { INVENTORY_SLOTS } from '../state/types.js';
import { PICKUP_RANGE } from '../sim/world.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../config.js';
import { pickupLead, pickupOrderFor } from '../../render/iso3d/world/loot-drop.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  readonly server: GameServer;
  readonly transport: LoopbackTransport;
  readonly clients: GameClient[];
  readonly tick: (times?: number) => Promise<void>;
}

function rig(): Rig {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 8, transport });
  // No ambient spawning: this test wants the bodies it puts there and no others.
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const clients: GameClient[] = [];
  const tick = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      server.tick();
      // The clients' own clocks, advanced with the server's. A drop lying still
      // in a still world produces no deltas at all -- that silence is the whole
      // point of the delta -- so a client that is not ticking would never reach
      // the reveal. In the game the render loop does this; here nothing else
      // would.
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

/** Where the server actually put a body, which is not always where it was asked. */
function positionOf(r: Rig, entityId: number): { x: number; y: number } {
  const entity = r.server.world.entities.get(entityId);
  if (!entity) throw new Error(`no entity ${entityId}`);
  return { x: entity.position.x, y: entity.position.y };
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

/**
 * Kill one grazer next to `client` and return the drop it left.
 *
 * The drop rate is turned all the way up rather than the seed being hunted for:
 * what is under test is the path, and a test that only passes on a lucky roll
 * is a test that will start failing when somebody retunes a table.
 */
async function killSomethingNearby(r: Rig, client: GameClient): Promise<number> {
  r.server.liveConfig.set('dropRateMultiplier', 100);
  const self = client.view().selfEntityId;
  const at = positionOf(r, self);
  r.server.spawnEntities('grazer', at.x + 40, at.y, 1);
  await r.tick(2);

  for (let swing = 0; swing < 40 && drops(r).length === 0; swing++) {
    client.useAbility('melee.slash', at.x + 1000, at.y);
    for (let i = 0; i < 60; i++) {
      client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });
      await r.tick();
    }
  }
  const landed = drops(r);
  expect(landed.length, 'a kill should have left exactly one drop').toBe(1);
  return landed[0]?.id ?? -1;
}

describe('a kill leaves something the server decided', () => {
  it('drops an item nobody asked for, owned by whoever killed it', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);

    const id = await killSomethingNearby(r, ana);
    const drop = drops(r).find((d) => d.id === id);
    expect(drop?.owner).toBe('ana');
    // The grazer's table has one row in it, so this is the server's decision
    // rather than a coincidence worth asserting loosely.
    expect(drop?.defId).toBe('potion.minor');
    expect(rarityOf(drop?.defId ?? '')).toBe('common');
  });

  it('replays identically from the same seed and the same kills', async () => {
    const run = async (): Promise<string> => {
      const r = rig();
      const ana = await join(r, 'ana');
      await r.tick(2);
      await killSomethingNearby(r, ana);
      return drops(r)
        .map((d) => `${d.defId}x${d.count}`)
        .join(',');
    };
    expect(await run()).toBe(await run());
  });

  /** A drop is scenery. Nothing swings at it and nothing walks it anywhere. */
  it('leaves the drop inert and where it fell', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const id = await killSomethingNearby(r, ana);

    const before = positionOf(r, id);
    await r.tick(120);
    const entity = r.server.world.entities.get(id);
    expect(entity, 'the drop should still be there').toBeTruthy();
    expect(positionOf(r, id)).toEqual(before);
    expect(entity?.targetId).toBeNull();
    expect(entity?.cast).toBeNull();
    // Its identity is not on the entity record, which is what keeps it off the
    // delta every client in range is handed.
    expect(entity?.typeId).toBe('');
  });
});

describe('what a client is told, and when', () => {
  it('withholds the identity of a rare drop until its reveal tick', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);

    // The developer path: a drop of a chosen tier, with no monster involved.
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 60, at.y, rarityToByte('rare'));
    await r.tick(4);

    const seen = ana.view().drops;
    expect(seen.length).toBe(1);
    const drop = seen[0];
    if (!drop) throw new Error('no drop');

    // The client knows something is there and knows the tier -- that is the
    // "notice" -- and does not know what it is.
    expect(drop.rarity).toBe('rare');
    expect(drop.defId).toBeNull();
    expect(drop.name).toBeNull();
    expect(drop.phase).not.toBe(RevealPhase.Revealed);

    // ...and the server has known all along.
    const authoritative = r.server.world.entities.get(drop.entityId)?.drop;
    expect(authoritative?.defId).toBe('sword.keen');

    await r.tick(rarityRow('rare').revealTicks + 6);
    const revealed = ana.view().drops[0];
    expect(revealed?.defId).toBe('sword.keen');
    expect(revealed?.name).toBe('Keen Longsword');
    expect(revealed?.phase).toBe(RevealPhase.Revealed);
    // The item never changed. The presentation did.
    expect(r.server.world.entities.get(drop.entityId)?.drop?.defId).toBe('sword.keen');
  });

  it('tells a client that arrives after the reveal on first sight', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 60, at.y, rarityToByte('exceptional'));

    await r.tick(rarityRow('exceptional').revealTicks + 6);
    expect(ana.view().drops[0]?.defId).toBeTruthy();

    // Ben was not connected when any of that happened.
    const ben = await join(r, 'ben');
    await r.tick(6);
    const seen = ben.view().drops[0];
    expect(seen, 'a late observer should be told about the drop').toBeTruthy();
    expect(seen?.defId).toBe(ana.view().drops[0]?.defId);
    expect(seen?.phase).toBe(RevealPhase.Revealed);
  });

  it('never lets a common drop wait for anything', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 60, at.y, rarityToByte('common'));
    await r.tick(4);

    const drop = ana.view().drops[0];
    expect(drop?.rarity).toBe('common');
    expect(drop?.phase).toBe(RevealPhase.Revealed);
    expect(drop?.defId).toBeTruthy();
    expect(drop?.revealTick).toBe(drop?.spawnTick);
  });
});

describe('it looks dropped, and it looks the same to everybody', () => {
  /**
   * The requirement in one test: the throw is two authoritative points, so two
   * players watching the same kill are watching the same throw. A scatter
   * decided client-side would put the same sword in two places.
   */
  it('lands clear of the body, and both ends reach every observer alike', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    const ben = await join(r, 'ben');
    await r.tick(4);

    const corpseAt = positionOf(r, ana.view().selfEntityId);
    const id = await killSomethingNearby(r, ana);
    await r.tick(4);

    const landing = positionOf(r, id);
    const thrown = Math.hypot(landing.x - corpseAt.x, landing.y - corpseAt.y);
    expect(thrown, 'the drop should not be under the body').toBeGreaterThan(0);

    const seenByAna = ana.view().drops.find((d) => d.entityId === id);
    const seenByBen = ben.view().drops.find((d) => d.entityId === id);
    expect(seenByAna, 'ana should see it').toBeTruthy();
    expect(seenByBen, 'ben should see it too').toBeTruthy();
    // Same origin, same landing, same spawn tick -- so the same arc, drawn by a
    // pure function of those three on both machines.
    expect(seenByBen?.origin).toEqual(seenByAna?.origin);
    expect(seenByBen?.spawnTick).toBe(seenByAna?.spawnTick);
    const authoritative = r.server.world.entities.get(id)?.drop?.origin;
    expect(seenByAna?.origin.x).toBeCloseTo(authoritative?.x ?? -1, 2);
    expect(seenByAna?.origin.y).toBeCloseTo(authoritative?.y ?? -1, 2);
  });

  it('replays the landing exactly from the same seed', async () => {
    const run = async (): Promise<string> => {
      const r = rig();
      const ana = await join(r, 'ana');
      await r.tick(2);
      const id = await killSomethingNearby(r, ana);
      const at = positionOf(r, id);
      return `${at.x.toFixed(4)},${at.y.toFixed(4)}`;
    };
    expect(await run()).toBe(await run());
  });
});

describe('asking for it', () => {
  /**
   * The wedge, as a test: a refused pickup used to leave `awaitingPickup` set
   * forever, so the standing order stopped walking, stopped asking, and sat
   * there. Clicking again was the only way out, which is exactly what was
   * reported.
   */
  it('clears the request once the server answers, refusal included', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 60, at.y, rarityToByte('rare'));
    await r.tick(4);
    const drop = ana.view().drops[0];
    if (!drop) throw new Error('no drop');

    // Out of range on purpose, so the answer is a refusal rather than a grant.
    r.server.teleport('ana', DEFAULT_SPAWN.x + 2000, DEFAULT_SPAWN.y);
    await r.tick(4);

    ana.pickUp(drop.entityId);
    expect(ana.view().awaitingPickup, 'asked, and waiting').toBe(true);
    await r.tick(6);
    expect(ana.view().awaitingPickup, 'a refusal is an answer').toBe(false);

    // ...and the next ask goes through, which is what the order relies on.
    r.server.teleport('ana', at.x + 60, at.y);
    await r.tick(4);
    ana.pickUp(drop.entityId);
    await r.tick(6);
    expect(ana.view().awaitingPickup).toBe(false);
    expect(r.server.world.entities.get(drop.entityId)).toBeUndefined();
  });

  /**
   * The reported bug, driven end to end: right-click something far away, walk
   * over under the standing order, and the item arrives **and** "that is too
   * far away" appears.
   *
   * Both really happened. `PickUpItem` carries no `afterInputSeq`, so the server
   * answered it against the last input it had *applied* while the client had
   * asked from its prediction some ticks further on; the first ask was refused
   * and the retry a tick later took the item. The order is driven here through
   * the same pure `pickupOrderFor` the view uses, so this is the approach a
   * player actually makes rather than a teleport and a click.
   */
  it('walks over from far away and takes it without a word', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(4);

    const refusals: string[] = [];
    ana.onError((_code, message) => refusals.push(message));

    const at = positionOf(r, ana.view().selfEntityId);
    // Well outside the reach, so the whole approach is under the order.
    r.server.triggerEvent('drop', at.x + 700, at.y, rarityToByte('rare'));
    await r.tick(4);
    const drop = ana.view().drops[0];
    if (!drop) throw new Error('no drop');
    const target = positionOf(r, drop.entityId);
    const before = held(r, ['ana'], 'sword.keen');

    const reach = PICKUP_RANGE + SERVER_PLAYER_RADIUS;
    for (let i = 0; i < 600 && r.server.world.entities.get(drop.entityId); i++) {
      const view = ana.view();
      const self = view.entities.find((e) => e.id === view.selfEntityId);
      // The *predicted* position, which is what `view.ts` measures from and
      // what the whole disagreement is about -- reading the replica here would
      // be asking the server where it thinks we are, which is the one thing a
      // client does not do while it is walking.
      const me = view.self ?? { x: self?.x ?? 0, y: self?.y ?? 0 };
      const order = pickupOrderFor({
        self: me,
        selfHealth: self?.health ?? 1,
        drop: { entityId: drop.entityId, x: target.x, y: target.y },
        reach,
        lead: pickupLead(view.stats?.moveSpeed ?? 0, view.roundTripTicks, SERVER_TICK_RATE, reach),
        pending: view.awaitingPickup,
      });
      if (order.ask) ana.pickUp(drop.entityId);
      // Straight at it, exactly as `moveIntent` would drive the approach.
      const dx = target.x - me.x;
      const dy = target.y - me.y;
      const span = Math.hypot(dx, dy) || 1;
      const walking = order.walkTo !== null;
      ana.sendInput({
        moveX: walking ? dx / span : 0,
        moveY: walking ? dy / span : 0,
        facing: Math.atan2(dy, dx),
        buttons: 0,
      });
      await r.tick();
    }

    expect(held(r, ['ana'], 'sword.keen'), 'the item should arrive').toBe(before + 1);
    expect(r.server.world.entities.get(drop.entityId)).toBeUndefined();
    // ...and nothing was said about it. A refusal here is the order's machinery
    // showing through, not something the player did.
    expect(refusals).toEqual([]);
  });

  /**
   * `MoveItem` and `PickUpItem` are answered by the same message at the same id
   * space. Two counters meant a pickup's answer retired a drag that happened to
   * share its number -- a rollback on a message about something else.
   */
  it('does not let a pickup answer retire an unrelated bag move', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 40, at.y, rarityToByte('common'));
    await r.tick(4);
    const drop = ana.view().drops[0];
    if (!drop) throw new Error('no drop');

    const moveId = ana.moveItem(
      { container: 'inventory', index: 0 },
      { container: 'inventory', index: 20 },
    );
    const pickId = ana.pickUp(drop.entityId);
    expect(pickId, 'two verbs, one id space').not.toBe(moveId);
    await r.tick(8);

    // Both landed, and the bag holds the result of both.
    const bag = r.server.playerManager.get('ana')?.record.inventory ?? [];
    expect(bag[20]).toBeTruthy();
    expect(held(r, ['ana'], 'potion.minor')).toBeGreaterThan(0);
  });
});

describe('the developer path', () => {
  /**
   * Tuning a presentation must not require farming for one. Both halves are
   * checked because both are easy to leave half-wired: the spawn produces a
   * drop of a named tier, and the force pulls one that is already lying there.
   */
  it('forces a drop already in the world to reveal, without changing it', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 60, at.y, rarityToByte('exceptional'));
    await r.tick(4);

    const before = ana.view().drops[0];
    if (!before) throw new Error('no drop');
    expect(before.defId).toBeNull();
    const authoritative = r.server.world.entities.get(before.entityId)?.drop?.defId;

    const said = r.server.triggerEvent('reveal', at.x + 60, at.y, 200);
    expect(said).toContain('revealed 1');
    await r.tick(2);

    const after = ana.view().drops[0];
    expect(after?.phase).toBe(RevealPhase.Revealed);
    // The presentation moved. The item did not, and nothing here could move it.
    expect(after?.defId).toBe(authoritative);
    expect(r.server.world.entities.get(before.entityId)?.drop?.defId).toBe(authoritative);
  });

  it('collapses the run-up to nothing when the scale says so', async () => {
    const r = rig();
    r.server.liveConfig.set('lootRevealScale', 0);
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 60, at.y, rarityToByte('exceptional'));
    await r.tick(4);

    const drop = ana.view().drops[0];
    expect(drop?.rarity).toBe('exceptional');
    expect(drop?.phase).toBe(RevealPhase.Revealed);
    expect(drop?.defId).toBeTruthy();
  });

  /**
   * And the knob is snapshotted: a drop already running keeps the clock it was
   * stamped with, which is spec 144's rule about attack timing applied to a
   * reveal, and for the same reason -- a finish line that moved while the thing
   * was running could be put in the past.
   */
  it('leaves a reveal already running alone when the scale changes', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 60, at.y, rarityToByte('exceptional'));
    await r.tick(4);

    const stamped = ana.view().drops[0]?.revealTick;
    r.server.liveConfig.set('lootRevealScale', 0);
    await r.tick(4);
    expect(ana.view().drops[0]?.revealTick).toBe(stamped);
  });
});

describe('taking it', () => {
  it('serves a pickup before the reveal has finished', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 40, at.y, rarityToByte('exceptional'));
    await r.tick(4);

    const drop = ana.view().drops[0];
    if (!drop) throw new Error('no drop');
    expect(drop.phase).not.toBe(RevealPhase.Revealed);

    ana.pickUp(drop.entityId);
    await r.tick(4);

    // The item is in the bag, under its real name, and the world is clear of it.
    const bag = r.server.playerManager.get('ana')?.record.inventory ?? [];
    expect(bag.some((stack) => stack?.defId === 'trinket.bloodstone')).toBe(true);
    expect(r.server.world.entities.get(drop.entityId)).toBeUndefined();
    expect(ana.view().drops).toHaveLength(0);
  });

  it('serves a pickup after the reveal the same way', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 40, at.y, rarityToByte('rare'));
    await r.tick(rarityRow('rare').revealTicks + 6);

    const drop = ana.view().drops[0];
    if (!drop) throw new Error('no drop');
    expect(drop.phase).toBe(RevealPhase.Revealed);
    ana.pickUp(drop.entityId);
    await r.tick(4);
    expect(
      (r.server.playerManager.get('ana')?.record.inventory ?? []).some(
        (stack) => stack?.defId === 'sword.keen',
      ),
    ).toBe(true);
  });

  /**
   * The duplication property, and the reason `pickUpDrop` removes the entity
   * before it awaits the grant. Counted across both bags together, because a
   * duplicated item leaves each one individually plausible.
   */
  it('turns one drop into exactly one stack, however many people ask', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 30, at.y, rarityToByte('rare'));
    await r.tick(4);

    const drop = ana.view().drops[0];
    if (!drop) throw new Error('no drop');
    const before = held(r, ['ana'], 'sword.keen');

    for (let i = 0; i < 8; i++) ana.pickUp(drop.entityId);
    await r.tick(8);

    expect(held(r, ['ana'], 'sword.keen')).toBe(before + 1);
    expect(r.server.world.entities.get(drop.entityId)).toBeUndefined();
  });

  it('refuses somebody else’s drop, and leaves it lying there', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    const ben = await join(r, 'ben');
    await r.tick(4);

    const id = await killSomethingNearby(r, ana);
    expect(drops(r)[0]?.owner).toBe('ana');

    // Ben walks over to it and asks anyway. The client cannot see ownership --
    // it is not on the wire -- so this is exactly what an honest client does.
    r.server.teleport('ben', positionOf(r, id).x, positionOf(r, id).y);
    await r.tick(4);
    const benBefore = held(r, ['ben'], 'potion.minor');
    ben.pickUp(id);
    await r.tick(4);

    // Measured as a change, not as a total: everybody starts with three of
    // these in the kit, so an absolute count would pass whatever happened.
    expect(held(r, ['ben'], 'potion.minor')).toBe(benBefore);
    expect(r.server.world.entities.get(id), 'the drop should still be there').toBeTruthy();

    const anaBefore = held(r, ['ana'], 'potion.minor');
    ana.pickUp(id);
    await r.tick(4);
    expect(held(r, ['ana'], 'potion.minor')).toBeGreaterThan(anaBefore);
    expect(r.server.world.entities.get(id)).toBeUndefined();
  });

  it('refuses a drop across the map, and leaves it lying there', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 60, at.y, rarityToByte('rare'));
    await r.tick(4);
    const drop = ana.view().drops[0];
    if (!drop) throw new Error('no drop');

    r.server.teleport('ana', DEFAULT_SPAWN.x + 2000, DEFAULT_SPAWN.y);
    await r.tick(4);
    ana.pickUp(drop.entityId);
    await r.tick(4);

    expect(held(r, ['ana'], 'sword.keen')).toBe(0);
    expect(r.server.world.entities.get(drop.entityId)).toBeTruthy();
  });

  /** A refusal must not eat the drop -- the worst bug this feature could have. */
  it('leaves the drop in the world when the bag is full', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(2);
    await fillBag(r, 'ana');

    const at = positionOf(r, ana.view().selfEntityId);
    r.server.triggerEvent('drop', at.x + 40, at.y, rarityToByte('rare'));
    await r.tick(4);
    const drop = ana.view().drops[0];
    if (!drop) throw new Error('no drop');

    ana.pickUp(drop.entityId);
    await r.tick(4);

    const entity = r.server.world.entities.get(drop.entityId);
    expect(entity, 'a full bag is a refusal, not a deletion').toBeTruthy();
    expect(entity?.drop?.defId).toBe('sword.keen');
    expect(held(r, ['ana'], 'sword.keen')).toBe(0);
  });
});

/** How many of `defId` those players are carrying, in total. */
function held(r: Rig, playerIds: readonly string[], defId: string): number {
  let total = 0;
  for (const id of playerIds) {
    for (const stack of r.server.playerManager.get(id)?.record.inventory ?? []) {
      if (stack?.defId === defId) total += stack.count;
    }
  }
  return total;
}

/**
 * Fill every free slot with something that does not stack.
 *
 * Through `giveItem` rather than by writing the record, so the bag ends up full
 * by the same rule the pickup will be refused by -- a test that reached past
 * `addToInventory` to set up a full bag would not be testing the thing that
 * refuses.
 */
async function fillBag(r: Rig, playerId: string): Promise<void> {
  for (let i = 0; i < INVENTORY_SLOTS + 1; i++) {
    await r.server.playerManager.giveItem(playerId, 'sword.worn', 1);
  }
  const bag = r.server.playerManager.get(playerId)?.record.inventory ?? [];
  expect(bag.every((stack) => stack !== null)).toBe(true);
}
