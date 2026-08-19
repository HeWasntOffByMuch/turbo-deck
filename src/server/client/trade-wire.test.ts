/**
 * A trade over the wire (spec 132): two real clients, one real server.
 *
 * The rules are hammered by a property test in `player/trade.test.ts`. What is
 * only true end to end is everything *around* the swap -- that both sides are
 * told the same thing, that a disconnect and a walk cancel it, that a player
 * cannot be in two at once, and that the swap really does write both bags.
 *
 * The dupe checks are the ones worth reading. Each of them is a way to get an
 * item into two places, and each is checked by counting what exists afterwards
 * rather than by trusting a refusal message.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { TradeStageValue } from '../net/protocol.js';
import { TRADE_RANGE } from '../player/trades.js';
import type { Inventory } from '../state/types.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly server: GameServer;
  readonly ana: GameClient;
  readonly ben: GameClient;
  /** Walk Ana east until the two of them are further apart than `apart`. */
  readonly walkApart: (apart: number) => Promise<number>;
}

async function harness(): Promise<Harness> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, transport });
  // No wandering monsters: this test is about two players and a table.
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const ana = new GameClient(transport.connect(), { playerId: 'ana', displayName: 'Ana' });
  const ben = new GameClient(transport.connect(), { playerId: 'ben', displayName: 'Ben' });
  const welcomes = Promise.all([ana.connect(), ben.connect()]);
  await settle();
  await welcomes;
  await settle();

  /**
   * Walked rather than teleported, and that is not fussiness.
   *
   * A tick mirrors every entity's authoritative position back into its record,
   * so writing a record by hand and then ticking puts both players straight back
   * where the sim has them -- which made the range check look broken when it was
   * the test that was. Sending real input is also the only version of this that
   * exercises the thing a player actually does.
   */
  const walkApart = async (apart: number): Promise<number> => {
    // Away from Ben, rather than along +x. Since spec 186 a player is blocked
    // by another player, and Ben spawns on Ana's +x -- so walking +x pressed
    // her into him and measured a gap that had stopped growing. It passed for
    // as long as it did because bodies used to walk through each other.
    //
    // Recomputed every tick rather than once up front, because a record only
    // catches up with its entity when a tick mirrors it back: before the first
    // one both of them read as the spawn point, and a direction taken from that
    // is (0, 0), which is Ana standing still and the gap never moving at all.
    let away = { x: -1, y: 0 };
    for (let tick = 0; tick < 240; tick += 1) {
      ana.sendInput({ moveX: away.x, moveY: away.y, facing: 0, buttons: 0 });
      server.tick();
      await settle();
      const here = server.playerManager.get('ana')?.record.position;
      const there = server.playerManager.get('ben')?.record.position;
      if (!here || !there) break;
      const dx = here.x - there.x;
      const dy = here.y - there.y;
      const gap = Math.hypot(dx, dy);
      if (gap > apart) return gap;
      if (gap > 1e-6) away = { x: dx / gap, y: dy / gap };
    }
    return 0;
  };
  return { server, ana, ben, walkApart };
}

function entityOf(server: GameServer, playerId: string): number {
  const session = server.playerManager.get(playerId);
  if (!session) throw new Error(`no session for ${playerId}`);
  return session.entityId;
}

function bagOf(server: GameServer, playerId: string): Inventory {
  return server.playerManager.get(playerId)?.record.inventory ?? [];
}

function countOf(inventory: Inventory, defId: string): number {
  return inventory.reduce((total, stack) => total + (stack?.defId === defId ? stack.count : 0), 0);
}

/** Everything both players hold, so a duplicate has nowhere to hide. */
function totalOf(server: GameServer, defId: string): number {
  return countOf(bagOf(server, 'ana'), defId) + countOf(bagOf(server, 'ben'), defId);
}

/**
 * How many of `defId` each side holds.
 *
 * Both characters start from the same kit, so every count here is a *delta*
 * rather than an absolute -- Ben owns a bow before Ana gives him one, and an
 * assertion that he ends with exactly one would be asserting that the trade did
 * nothing.
 */
function heldBy(server: GameServer, defId: string): { ana: number; ben: number } {
  return { ana: countOf(bagOf(server, 'ana'), defId), ben: countOf(bagOf(server, 'ben'), defId) };
}

function slotOf(inventory: Inventory, defId: string): number {
  return inventory.findIndex((stack) => stack?.defId === defId);
}

/** Invite and accept, so both sides are looking at an open table. */
async function open(h: Harness): Promise<void> {
  h.ana.inviteToTrade(entityOf(h.server, 'ben'));
  await settle();
  h.ben.respondToTrade(true);
  await settle();
}

describe('a trade over the wire', () => {
  it('tells both sides about an invitation, each from their own side', async () => {
    const h = await harness();
    h.ana.inviteToTrade(entityOf(h.server, 'ben'));
    await settle();

    expect(h.ana.view().trade?.stage).toBe(TradeStageValue.Offered);
    expect(h.ana.view().trade?.you.playerId).toBe('ana');
    expect(h.ana.view().trade?.them.displayName).toBe('Ben');
    // The same trade, seen from the other chair.
    expect(h.ben.view().trade?.id).toBe(h.ana.view().trade?.id);
    expect(h.ben.view().trade?.you.playerId).toBe('ben');
    expect(h.ben.view().trade?.them.displayName).toBe('Ana');
  });

  /**
   * Which chair you are in (spec 170). `you` and `them` are symmetric by
   * construction, so nothing else in the message says who opened the trade --
   * which is how the sender came to be shown "Accept invitation" for their own
   * invitation.
   */
  it('tells each side whether it is the one being asked', async () => {
    const h = await harness();
    h.ana.inviteToTrade(entityOf(h.server, 'ben'));
    await settle();
    expect(h.ana.view().trade?.invited).toBe(false);
    expect(h.ben.view().trade?.invited).toBe(true);
  });

  /**
   * The whole point of the change: a request that arrives with something in it.
   * The invitee is looking at goods and coins before deciding, rather than at
   * an empty table.
   */
  it('lets the inviter furnish the request before it is answered', async () => {
    const h = await harness();
    h.ana.inviteToTrade(entityOf(h.server, 'ben'));
    await settle();
    const index = slotOf(bagOf(h.server, 'ana'), 'bow.hunting');
    h.ana.offerInTrade([{ index, count: 1 }], 7);
    await settle();

    // Still an invitation, and Ben can already read what is being offered.
    expect(h.ben.view().trade?.stage).toBe(TradeStageValue.Offered);
    expect(h.ben.view().trade?.them.offer).toEqual([{ defId: 'bow.hunting', count: 1 }]);
    expect(h.ben.view().trade?.them.coins).toBe(7);

    // ...and it survives the answer rather than being cleared by it.
    h.ben.respondToTrade(true);
    await settle();
    expect(h.ben.view().trade?.stage).toBe(TradeStageValue.Open);
    expect(h.ben.view().trade?.them.offer).toEqual([{ defId: 'bow.hunting', count: 1 }]);
  });

  it('resolves an offer to items, so the other side can read it', async () => {
    const h = await harness();
    await open(h);
    const index = slotOf(bagOf(h.server, 'ana'), 'bow.hunting');
    h.ana.offerInTrade([{ index, count: 1 }], 5);
    await settle();

    // Ben cannot see into Ana's bag, so a slot index would mean nothing to him.
    expect(h.ben.view().trade?.them.offer).toEqual([{ defId: 'bow.hunting', count: 1 }]);
    expect(h.ben.view().trade?.them.coins).toBe(5);
    expect(h.ana.view().trade?.you.offer).toEqual([{ defId: 'bow.hunting', count: 1 }]);
  });

  it('swaps the goods and the coins when both sides accept', async () => {
    const h = await harness();
    await open(h);
    const bows = heldBy(h.server, 'bow.hunting');
    const stars = heldBy(h.server, 'stars.weighted');
    const anaCoins = h.server.playerManager.get('ana')?.record.coins ?? 0;
    const benCoins = h.server.playerManager.get('ben')?.record.coins ?? 0;

    h.ana.offerInTrade([{ index: slotOf(bagOf(h.server, 'ana'), 'bow.hunting'), count: 1 }], 10);
    await settle();
    h.ben.offerInTrade([{ index: slotOf(bagOf(h.server, 'ben'), 'stars.weighted'), count: 1 }], 0);
    await settle();

    const revision = h.ana.view().trade?.revision ?? -1;
    h.ana.acceptTrade(revision);
    await settle();
    h.ben.acceptTrade(revision);
    await settle();

    expect(heldBy(h.server, 'bow.hunting')).toEqual({ ana: bows.ana - 1, ben: bows.ben + 1 });
    expect(heldBy(h.server, 'stars.weighted')).toEqual({ ana: stars.ana + 1, ben: stars.ben - 1 });
    expect(h.server.playerManager.get('ana')?.record.coins).toBe(anaCoins - 10);
    expect(h.server.playerManager.get('ben')?.record.coins).toBe(benCoins + 10);
    // Nothing was created. The whole point.
    expect(totalOf(h.server, 'bow.hunting')).toBe(bows.ana + bows.ben);
    expect(totalOf(h.server, 'stars.weighted')).toBe(stars.ana + stars.ben);

    // Both were told, and both were told the bag they now have.
    expect(h.ana.endedTrade?.stage).toBe(TradeStageValue.Done);
    expect(h.ben.endedTrade?.stage).toBe(TradeStageValue.Done);
    expect(h.ana.view().trade).toBeNull();
    expect(countOf(h.ana.view().inventory, 'stars.weighted')).toBe(stars.ana + 1);
    expect(countOf(h.ben.view().inventory, 'bow.hunting')).toBe(bows.ben + 1);
  });

  /**
   * The scam, end to end: Ben accepts a bow, Ana takes it off the table, and
   * the exchange must not run on the acceptance Ben gave to a different offer.
   */
  it('throws both acceptances away when an offer changes', async () => {
    const h = await harness();
    await open(h);
    const index = slotOf(bagOf(h.server, 'ana'), 'bow.hunting');
    const bows = heldBy(h.server, 'bow.hunting');
    h.ana.offerInTrade([{ index, count: 1 }], 0);
    await settle();

    const revision = h.ana.view().trade?.revision ?? -1;
    h.ben.acceptTrade(revision);
    await settle();
    expect(h.ben.view().trade?.you.accepted).toBe(true);

    h.ana.offerInTrade([], 0);
    await settle();
    expect(h.ben.view().trade?.you.accepted).toBe(false);

    // Ana accepting at the *stale* revision is refused outright.
    h.ana.acceptTrade(revision);
    await settle();
    expect(h.ana.view().trade?.stage).toBe(TradeStageValue.Open);
    expect(heldBy(h.server, 'bow.hunting')).toEqual(bows);
  });

  it('lets nobody be in two trades at once', async () => {
    const h = await harness();
    await open(h);
    const id = h.ana.view().trade?.id;
    // Asking again while one is open changes nothing about the one that is open.
    h.ana.inviteToTrade(entityOf(h.server, 'ben'));
    await settle();
    expect(h.ana.view().trade?.id).toBe(id);
    expect(h.ana.view().trade?.stage).toBe(TradeStageValue.Open);
  });

  it('cancels when either side says so, and moves nothing', async () => {
    const h = await harness();
    await open(h);
    const before = totalOf(h.server, 'bow.hunting');
    h.ana.offerInTrade([{ index: slotOf(bagOf(h.server, 'ana'), 'bow.hunting'), count: 1 }], 0);
    await settle();

    h.ben.cancelTrade();
    await settle();
    expect(h.ana.view().trade).toBeNull();
    expect(h.ana.endedTrade?.stage).toBe(TradeStageValue.Cancelled);
    expect(totalOf(h.server, 'bow.hunting')).toBe(before);
  });

  it('cancels when they walk apart, and says so', async () => {
    const h = await harness();
    await open(h);
    const gap = await h.walkApart(TRADE_RANGE);
    expect(gap).toBeGreaterThan(TRADE_RANGE);

    expect(h.ana.view().trade).toBeNull();
    expect(h.ana.endedTrade?.reason).toContain('too far apart');
    expect(h.ben.endedTrade?.reason).toContain('too far apart');
  });

  /**
   * The ending has to reach the *view*, because the view is all the interface
   * reads (spec 134). `endedTrade` existed as a getter for two specs and no
   * screen could see it -- so the window sat frozen on the last live frame with
   * a Cancel button for a trade the server had already forgotten.
   */
  it('carries the ending in the view, until it is dismissed', async () => {
    const h = await harness();
    await open(h);
    h.ben.cancelTrade();
    await settle();

    const view = h.ana.view();
    expect(view.trade).toBeNull();
    expect(view.endedTrade?.stage).toBe(TradeStageValue.Cancelled);

    // The one piece of trade state a client may drop on its own: the trade is
    // already gone at the server, so there is nothing here to disagree with.
    h.ana.dismissEndedTrade();
    expect(h.ana.view().endedTrade).toBeNull();
  });

  /**
   * ...and a new trade clears the last one's ending, or the window falls back
   * to the previous reason the moment this trade ends.
   */
  it('clears a stale ending when a new trade starts', async () => {
    const h = await harness();
    await open(h);
    h.ben.cancelTrade();
    await settle();
    expect(h.ana.view().endedTrade).not.toBeNull();

    await open(h);
    expect(h.ana.view().endedTrade).toBeNull();
    expect(h.ana.view().trade?.stage).toBe(TradeStageValue.Open);
  });

  /**
   * A dropped socket ends the trade, and the survivor has to be *told* -- this
   * is the one ending nobody chose, and a window left sitting there offering an
   * Accept for a trade with one player in it is the worst version of it.
   */
  it('tells the survivor when the other player disconnects', async () => {
    const h = await harness();
    await open(h);
    const anaBefore = countOf(bagOf(h.server, 'ana'), 'bow.hunting');
    h.ana.offerInTrade([{ index: slotOf(bagOf(h.server, 'ana'), 'bow.hunting'), count: 1 }], 0);
    await settle();

    h.ben.disconnect();
    await settle();
    h.server.tick();
    await settle();

    expect(h.ana.view().trade).toBeNull();
    expect(h.ana.view().endedTrade?.stage).toBe(TradeStageValue.Cancelled);
    expect(h.ana.view().endedTrade?.reason).not.toBe('');
    // Nothing moved: a trade that paid out when a socket dropped would be the
    // easiest duplication there is. Counted on the side still here, because the
    // other one's session went with the socket.
    expect(countOf(bagOf(h.server, 'ana'), 'bow.hunting')).toBe(anaBefore);
  });

  /**
   * A full bag used to surface as the reason a confirmed trade was cancelled --
   * after both sides had accepted, which is the one moment neither can do
   * anything about it. It is a warning on the live table now, phrased for
   * whoever is reading it.
   */
  it('warns each side about the bag that has no room, in their own terms', async () => {
    const h = await harness();
    await open(h);
    // Filled through the real path rather than by writing the record, so the
    // bag this is measured against is a bag the game could actually produce.
    for (let guard = 0; guard < 200; guard += 1) {
      const given = await h.server.playerManager.giveItem('ben', 'chest.leather', 1);
      if (!given.ok) break;
    }
    expect(bagOf(h.server, 'ben').every((stack) => stack !== null)).toBe(true);

    const bow = slotOf(bagOf(h.server, 'ana'), 'bow.hunting');
    h.ana.offerInTrade([{ index: bow, count: 1 }], 0);
    await settle();

    expect(h.ana.view().trade?.warning).toContain('their bag');
    expect(h.ben.view().trade?.warning).toContain('your bag');

    // ...and clears when room is made, without what is on the table changing.
    await h.server.playerManager.sellItem('ben', 'vendor.quartermaster', 0, 1);
    h.ana.offerInTrade([{ index: bow, count: 1 }], 0);
    await settle();
    expect(h.ana.view().trade?.warning).toBe('');
    expect(h.ben.view().trade?.warning).toBe('');
  });

  it('is still open while they are still close', async () => {
    const h = await harness();
    await open(h);
    // The other half of the same rule: a sweep that cancelled everything would
    // pass the test above and be useless.
    for (let tick = 0; tick < 20; tick += 1) {
      h.server.tick();
      await settle();
    }
    expect(h.ana.view().trade?.stage).toBe(TradeStageValue.Open);
  });

  /**
   * What the ending says each side gave (spec 171).
   *
   * This is the case that used to come back **reversed**. An offer is a set of
   * slot indices resolved when the message is built, and the `done` message is
   * built after both bags have been written -- so the slot Ana's bow left is
   * the first free one, which is where Ben's stars landed, and Ana was told she
   * had offered the stars she just received.
   */
  it('says what each side gave, not what it got', async () => {
    const h = await harness();
    await open(h);
    const anaBow = slotOf(bagOf(h.server, 'ana'), 'bow.hunting');
    const benStars = slotOf(bagOf(h.server, 'ben'), 'stars.weighted');
    h.ana.offerInTrade([{ index: anaBow, count: 1 }], 0);
    await settle();
    h.ben.offerInTrade([{ index: benStars, count: 1 }], 0);
    await settle();

    const revision = h.ana.view().trade?.revision ?? -1;
    h.ana.acceptTrade(revision);
    await settle();
    h.ben.acceptTrade(revision);
    await settle();

    const ana = h.ana.view().endedTrade;
    expect(ana?.you.offer).toEqual([{ defId: 'bow.hunting', count: 1 }]);
    expect(ana?.them.offer).toEqual([{ defId: 'stars.weighted', count: 1 }]);
    // ...and the same trade from the other chair, which is the same two lists
    // the other way round.
    const ben = h.ben.view().endedTrade;
    expect(ben?.you.offer).toEqual([{ defId: 'stars.weighted', count: 1 }]);
    expect(ben?.them.offer).toEqual([{ defId: 'bow.hunting', count: 1 }]);
  });

  /**
   * The other half: with nothing coming back, the vacated slot stays empty and
   * the ending said "nothing offered" -- a completed trade that appears to have
   * moved nothing at all.
   */
  it('names the goods when only one side gave anything', async () => {
    const h = await harness();
    await open(h);
    const index = slotOf(bagOf(h.server, 'ana'), 'bow.hunting');
    h.ana.offerInTrade([{ index, count: 1 }], 3);
    await settle();
    const revision = h.ana.view().trade?.revision ?? -1;
    h.ana.acceptTrade(revision);
    await settle();
    h.ben.acceptTrade(revision);
    await settle();

    expect(h.ana.view().endedTrade?.you.offer).toEqual([{ defId: 'bow.hunting', count: 1 }]);
    expect(h.ben.view().endedTrade?.them.offer).toEqual([{ defId: 'bow.hunting', count: 1 }]);
    // Coins were never wrong: they are stored on the trade, not derived from a
    // bag. Asserted so a future change to the ending cannot quietly break them.
    expect(h.ana.view().endedTrade?.you.coins).toBe(3);
  });

  /**
   * A cancellation goes on resolving against the bag, and is right to: nothing
   * was written, so the bag it resolves against is the one the offer was made
   * from.
   */
  it('still reads a cancelled table off the bag it was offered from', async () => {
    const h = await harness();
    await open(h);
    const index = slotOf(bagOf(h.server, 'ana'), 'bow.hunting');
    h.ana.offerInTrade([{ index, count: 1 }], 0);
    await settle();
    h.ben.cancelTrade();
    await settle();

    expect(h.ana.view().endedTrade?.stage).toBe(TradeStageValue.Cancelled);
    expect(h.ana.view().endedTrade?.you.offer).toEqual([{ defId: 'bow.hunting', count: 1 }]);
  });

  /**
   * The two-window dupe: offer something, then sell it to a vendor, then have
   * the trade go through. The offer is resolved against the bag at *swap* time,
   * so the sale wins and the trade is refused whole.
   */
  it('refuses a trade whose goods were sold out from under it', async () => {
    const h = await harness();
    await open(h);
    const index = slotOf(bagOf(h.server, 'ana'), 'bow.hunting');
    const bows = heldBy(h.server, 'bow.hunting');

    h.ana.offerInTrade([{ index, count: 1 }], 0);
    await settle();
    const revision = h.ana.view().trade?.revision ?? -1;
    h.ben.acceptTrade(revision);
    await settle();

    // Sold between the two acceptances. The trade is still "confirmed" as far
    // as the table is concerned; the bag disagrees.
    await h.server.playerManager.sellItem('ana', 'vendor.quartermaster', index, 1);
    h.ana.acceptTrade(revision);
    await settle();

    expect(h.ana.view().trade).toBeNull();
    expect(h.ana.endedTrade?.stage).toBe(TradeStageValue.Cancelled);
    // Ben got nothing: the bow was Ana's to sell and she sold it.
    expect(heldBy(h.server, 'bow.hunting')).toEqual({ ana: bows.ana - 1, ben: bows.ben });
    // One left the world through the shop; none were made.
    expect(totalOf(h.server, 'bow.hunting')).toBe(bows.ana + bows.ben - 1);
  });
});
