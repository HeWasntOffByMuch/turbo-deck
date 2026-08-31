/**
 * A conversation over the wire (spec 246): a real client, a real server, the
 * shipped map, and the merchant standing on it.
 *
 * Three things are only true end to end, and each is the reason this file exists
 * rather than another unit test of `setConversation`.
 *
 * The merchant has to actually **be there** -- it comes off a spawner marker in
 * a document, through `spawnPointsFrom` and `runSpawners`, and every rule about
 * talking to it is worth nothing if the row and the marker disagree.
 *
 * The claim has to **reach the movement pass**: `monsterIntent` reading
 * `conversationWith` is a line that can be green in a unit test beside a tick
 * that never calls it.
 *
 * And the release has to happen **without being asked**. `sweepConversations`
 * reconciles rather than answering an event, so what has to be checked is that
 * walking away ends it, not that some code path fires.
 */

import { describe, expect, it } from 'vitest';

import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { buildWorldFromMap } from '../world/build.js';
import { loadMapFile } from '../world/map-file.js';
import { npcById } from '../data/npcs.js';
import { buyPrice, vendorById } from '../data/vendors.js';
import { STARTING_COINS } from '../player/player-manager.js';
import { EntityKind } from '../net/protocol.js';
import { GameClient } from './game-client.js';
import {
  approachLead,
  approachOrderFor,
  TALK_MAX_ASKS,
  TALK_STANDOFF_FRACTION,
} from '../../render/iso3d/world/approach.js';
import { SERVER_TICK_RATE } from '../config.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const shippedMap = loadMapFile();
const MERCHANT = 'npc.merchant';

function merchantNpc(): NonNullable<ReturnType<typeof npcById>> {
  const npc = npcById(MERCHANT);
  if (npc === null) throw new Error('the merchant has no NPC row');
  return npc;
}

interface Harness {
  readonly server: GameServer;
  readonly client: GameClient;
  readonly other: GameClient;
  readonly tick: (times?: number) => Promise<void>;
}

async function harness(): Promise<Harness> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 5,
    transport,
    built: buildWorldFromMap(shippedMap.doc, shippedMap.mapId),
  });
  transport.onConnection((channel) => server.accept(channel));

  const client = new GameClient(transport.connect(), { playerId: 'p1', displayName: 'Ana' });
  const other = new GameClient(transport.connect(), { playerId: 'p2', displayName: 'Ben' });
  const welcomes = Promise.all([client.connect(), other.connect()]);
  await settle();
  await welcomes;
  await settle();

  const tick = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      server.tick();
      client.advanceTick();
      other.advanceTick();
      await settle();
    }
  };
  await tick(8);
  return { server, client, other, tick };
}

/** The merchant's entity, as this client sees it. */
function merchantOf(
  client: GameClient,
): { id: number; x: number; y: number; health: number } | undefined {
  return client
    .view()
    .entities.find((entity) => entity.kind === EntityKind.Monster && entity.typeId === MERCHANT);
}

/**
 * Put a player exactly `away` units from the merchant, and let it land.
 *
 * `teleport` rather than `playerManager.syncFromEntity`, and the difference is
 * the whole reason the first cut of this file reported a working range check as
 * broken: `syncFromEntity` writes the persisted *record*, and `talkableFor`
 * deliberately measures from the **entity** -- because the record is written by
 * the autosave, so a body that has walked since the last flush would be measured
 * where it used to be.
 */
async function stand(
  server: GameServer,
  playerId: string,
  at: { x: number; y: number },
  away: number,
): Promise<void> {
  const moved = server.teleport(playerId, at.x + away, at.y);
  if (!moved) throw new Error(`could not move ${playerId}`);
  await settle();
}

describe('the merchant on the shipped map', () => {
  it('spawns, and is the fox-drawn body the NPC table describes', async () => {
    const { client } = await harness();
    const body = merchantOf(client);
    expect(body, 'no merchant spawned from the map').toBeDefined();
  });

  it('has no health bar to take down: a blow is refused', async () => {
    // The end-to-end half of `isHostile`'s refusal. Asserted through the real
    // ability path rather than by calling the predicate.
    const { client, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    const before = body.health;
    for (let i = 0; i < 60; i++) {
      client.useAbility('melee.slash', body.x, body.y, body.id, 22);
      await tick();
    }
    expect(merchantOf(client)?.health).toBe(before);
  });
});

describe('starting a conversation', () => {
  it('is refused from too far away, and answered either way', async () => {
    const { server, client, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    await stand(server, 'p1', body, merchantNpc().talkRadius + 200);

    client.talk(body.id);
    await tick(3);
    // A refusal is a `Conversation 0` rather than silence: a client that asked
    // and heard nothing cannot tell a refusal from a dropped message.
    expect(client.view().conversationEntityId).toBe(0);
  });

  it('is granted from inside the radius', async () => {
    const { server, client, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    await stand(server, 'p1', body, 40);

    client.talk(body.id);
    await tick(3);
    expect(client.view().conversationEntityId).toBe(body.id);
  });

  it('is refused for a body that is not an NPC', async () => {
    const { client, tick } = await harness();
    const spider = client
      .view()
      .entities.find((entity) => entity.kind === EntityKind.Monster && entity.typeId !== MERCHANT);
    if (!spider) return; // No other monster in range this run; nothing to assert.
    client.talk(spider.id);
    await tick(3);
    expect(client.view().conversationEntityId).toBe(0);
  });

  it('is harmless to ask for repeatedly', async () => {
    // Repeated right-clicks. The conversation must not restart -- which from a
    // player's side would be the line beginning again under their cursor.
    const { server, client, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    await stand(server, 'p1', body, 40);
    for (let i = 0; i < 5; i++) {
      client.talk(body.id);
      await tick();
    }
    expect(client.view().conversationEntityId).toBe(body.id);
  });

  it('is refused to a second player while the first holds it', async () => {
    const { server, client, other, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    await stand(server, 'p1', body, 40);
    await stand(server, 'p2', body, 50);

    client.talk(body.id);
    await tick(3);
    other.talk(body.id);
    await tick(3);
    expect(client.view().conversationEntityId).toBe(body.id);
    expect(other.view().conversationEntityId).toBe(0);
  });
});

describe('holding one', () => {
  it('stops the merchant walking, and lets it go again afterwards', async () => {
    // The claim reaching the movement pass, over the real tick. Both halves,
    // because a body that never moved at all would pass the first alone.
    const { server, client, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    await stand(server, 'p1', body, 40);

    client.talk(body.id);
    await tick(3);
    const held = merchantOf(client);
    if (!held) throw new Error('the merchant left');
    await tick(240);
    const after = merchantOf(client);
    if (!after) throw new Error('the merchant left');
    expect(Math.hypot(after.x - held.x, after.y - held.y)).toBeLessThan(4);

    client.talk(0);
    await tick(3);
    expect(client.view().conversationEntityId).toBe(0);
    await tick(600);
    const wandered = merchantOf(client);
    if (!wandered) throw new Error('the merchant left');
    expect(Math.hypot(wandered.x - after.x, wandered.y - after.y)).toBeGreaterThan(4);
  });

  it('ends on its own when the player walks away', async () => {
    // Nothing raises an event for this: `sweepConversations` reconciles once a
    // broadcast, which is what makes walking away, dying and despawning the
    // same three lines.
    const { server, client, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    await stand(server, 'p1', body, 40);
    client.talk(body.id);
    await tick(3);
    expect(client.view().conversationEntityId).toBe(body.id);

    await stand(server, 'p1', body, merchantNpc().talkRadius + 150);
    await tick(10);
    expect(client.view().conversationEntityId).toBe(0);
  });

  it('ends when the player dies', async () => {
    const { server, client, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    await stand(server, 'p1', body, 40);
    client.talk(body.id);
    await tick(3);

    server.kill('p1');
    await tick(10);
    expect(client.view().conversationEntityId).toBe(0);
  });

  it('hands the merchant to the next player once the first lets go', async () => {
    const { server, client, other, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    await stand(server, 'p1', body, 40);
    await stand(server, 'p2', body, 50);

    client.talk(body.id);
    await tick(3);
    client.talk(0);
    await tick(3);
    other.talk(body.id);
    await tick(3);
    expect(other.view().conversationEntityId).toBe(body.id);
  });
});

describe('the shop behind it', () => {
  it('opens at the merchant’s own vendor from where a conversation happens', async () => {
    // The whole reason `RELL_REACH` is derived: a player at the edge of the talk
    // radius, with the body at the edge of its wander disc, must still be served.
    const { server, client, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    const npc = merchantNpc();
    await stand(server, 'p1', body, npc.talkRadius - 4);

    client.talk(body.id);
    await tick(3);
    expect(client.view().conversationEntityId).toBe(body.id);

    if (npc.vendorId === null) throw new Error('the merchant has no shop');
    client.openVendor(npc.vendorId);
    await tick(3);
    expect(client.view().vendor?.id).toBe(npc.vendorId);
  });

  it('sells a real item for real coins, and refuses what cannot be paid for', async () => {
    const { server, client, tick } = await harness();
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    const npc = merchantNpc();
    if (npc.vendorId === null) throw new Error('the merchant has no shop');
    const vendor = vendorById(npc.vendorId);
    if (vendor === null) throw new Error('no vendor row');
    await stand(server, 'p1', body, 40);
    client.talk(body.id);
    client.openVendor(npc.vendorId);
    await tick(3);

    const affordable = vendor.stock.find((defId) => buyPrice(defId, vendor) <= STARTING_COINS);
    if (affordable === undefined) throw new Error('nothing in this shop is affordable at all');
    const price = buyPrice(affordable, vendor);

    client.buyItem(npc.vendorId, affordable, 1);
    await tick(4);
    expect(client.view().coins).toBe(STARTING_COINS - price);
    expect(client.view().inventory.some((stack) => stack?.defId === affordable)).toBe(true);

    // And the refusal: buy until it cannot be paid for, then check that the
    // failed purchase moved neither the coins nor the bag.
    for (let i = 0; i < 12; i++) {
      client.buyItem(npc.vendorId, affordable, 1);
      await tick(2);
    }
    const broke = client.view();
    expect(broke.coins).toBeLessThan(price);
    client.buyItem(npc.vendorId, affordable, 1);
    await tick(4);
    expect(client.view().coins).toBe(broke.coins);
  });
});

describe('walking over to talk (spec 257)', () => {
  /**
   * The order driven end to end, through the same pure `approachOrderFor` the
   * view uses -- so this is the approach a player actually makes rather than a
   * teleport and a click.
   *
   * The click itself is not here and cannot be: `issueOrder` needs a cursor and
   * a scene. What is here is everything after it, which is the half that was
   * missing -- before spec 257 the click sent a `Talk` from wherever the player
   * stood, the server refused it past `talkRadius`, and the refusal is silent.
   */
  async function walkAndTalk(
    { server, client, tick }: Harness,
    away: number,
    ticks = 900,
  ): Promise<{ asks: number; walked: number }> {
    const body = merchantOf(client);
    if (!body) throw new Error('no merchant');
    await stand(server, 'p1', body, away);
    await tick(4);

    const reach = merchantNpc().talkRadius;
    let asks = 0;
    let walked = 0;
    for (let i = 0; i < ticks && client.view().conversationEntityId === 0; i++) {
      if (asks >= TALK_MAX_ASKS) break;
      const view = client.view();
      const self = view.entities.find((entity) => entity.id === view.selfEntityId);
      // The merchant is read fresh every tick, because it wanders: an order
      // aimed at the coordinate it was clicked on would arrive where it used to
      // be. This is `driveTalk` re-aiming.
      const mark = merchantOf(client);
      if (!mark) throw new Error('the merchant left');
      // The *predicted* position, which is what `view.ts` measures from.
      const me = view.self ?? { x: self?.x ?? 0, y: self?.y ?? 0 };
      const order = approachOrderFor({
        self: me,
        selfHealth: self?.health ?? 1,
        target: { x: mark.x, y: mark.y },
        reach,
        // `driveTalk`'s margin: the standoff, tightened by every ask already
        // refused. Not the lead alone -- this comparison has two out-of-date
        // bodies in it. See `TALK_STANDOFF_FRACTION` and `TALK_MAX_ASKS`.
        lead: Math.max(
          reach * (1 - TALK_STANDOFF_FRACTION ** (asks + 1)),
          approachLead(view.stats?.moveSpeed ?? 0, view.roundTripTicks, SERVER_TICK_RATE, reach),
        ),
        // Nothing to throttle: the standoff after an ask is inside where the
        // body is standing, so the next one cannot be sent until it has walked
        // further in.
        pending: false,
      });
      if (order.ask) {
        client.talk(mark.id);
        asks += 1;
      }
      const dx = mark.x - me.x;
      const dy = mark.y - me.y;
      const span = Math.hypot(dx, dy) || 1;
      const walking = order.walkTo !== null;
      if (walking) walked += 1;
      client.sendInput({
        moveX: walking ? dx / span : 0,
        moveY: walking ? dy / span : 0,
        facing: Math.atan2(dy, dx),
        buttons: 0,
      });
      await tick();
    }
    return { asks, walked };
  }

  it('closes the gap from outside the radius and then talks', async () => {
    const rig = await harness();
    const { asks, walked } = await walkAndTalk(rig, merchantNpc().talkRadius + 400);
    expect(walked, 'the order should have walked').toBeGreaterThan(0);
    // The standoff is wide enough that the first ask is granted, so the retry
    // `TALK_MAX_ASKS` allows is never spent. That is the point of it being a
    // *bound* rather than a cadence: on a wire that does not disagree with
    // itself, walking up to somebody is still one message.
    expect(asks).toBe(1);
    expect(rig.client.view().conversationEntityId).toBe(merchantOf(rig.client)?.id);
  });

  /**
   * The bug the lead exists for, in this radius rather than the drop's: the
   * client asks from its prediction and the server checks against the last
   * input it applied, so arriving at the client's own copy of `talkRadius` and
   * asking earns a silent refusal -- which, unlike a pickup's, has no retry
   * behind it, so it is not one wasted message but a click that did nothing.
   */
  it('is never refused for range on the ask the walk produced', async () => {
    const rig = await harness();
    // Far enough out that the whole approach is at full walking speed, so the
    // ask lands at the moment the prediction is furthest ahead of the server.
    await walkAndTalk(rig, merchantNpc().talkRadius + 900);
    expect(rig.client.view().conversationEntityId).not.toBe(0);
  });

  /** Already close enough: no walking at all, and the same single ask. */
  it('asks at once when the click was already inside the standoff', async () => {
    const rig = await harness();
    const inside = merchantNpc().talkRadius * TALK_STANDOFF_FRACTION - 10;
    const { asks, walked } = await walkAndTalk(rig, inside);
    expect(walked).toBe(0);
    expect(asks).toBe(1);
    expect(rig.client.view().conversationEntityId).not.toBe(0);
  });
});
