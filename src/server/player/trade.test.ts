/**
 * The trade's rules (spec 132).
 *
 * The property at the bottom is the reason this file exists in this shape, and
 * it is a stronger claim than spec 126's: there, a move had to conserve one
 * player's things; here a swap has to conserve *both players' things together*,
 * which is the only statement that catches an item ending up in two bags.
 *
 * The hand-written cases above it are the ones a human thought of -- the scam
 * the revision exists to stop, the same slot offered twice, two full bags
 * swapping swords. The property is for the ones nobody thought of.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { maxStackOf } from '../data/items.js';
import { INVENTORY_SLOTS, emptyInventory, type Inventory, type ItemStack } from '../state/types.js';
import {
  accept,
  beginTrade,
  cancel,
  exchangeProblem,
  isLive,
  isSwappable,
  respond,
  setOffer,
  sideOf,
  swap,
  type Holdings,
  type OfferedSlot,
  type Trade,
} from './trade.js';

function bagOf(entries: Readonly<Record<number, ItemStack>>): Inventory {
  const bag = [...emptyInventory()];
  for (const [index, stack] of Object.entries(entries)) bag[Number(index)] = stack;
  return bag;
}

function holding(entries: Readonly<Record<number, ItemStack>>, coins = 100): Holdings {
  return { inventory: bagOf(entries), coins };
}

/** Invite, accept, and hand back a trade both sides are editing. */
function opened(): Trade {
  const invited = beginTrade(1, 'ana', 'ben');
  const answered = respond(invited, 'ben', true);
  if (!answered.ok) throw new Error(answered.reason);
  return answered.trade;
}

/** Put both offers on the table and have both sides accept the result. */
function agreed(
  ana: Holdings,
  ben: Holdings,
  anaOffer: readonly OfferedSlot[],
  benOffer: readonly OfferedSlot[],
  anaCoins = 0,
  benCoins = 0,
): Trade {
  let trade = opened();
  for (const [who, offer, coins, holdings] of [
    ['ana', anaOffer, anaCoins, ana],
    ['ben', benOffer, benCoins, ben],
  ] as const) {
    const set = setOffer(trade, who, offer, coins, holdings);
    if (!set.ok) throw new Error(set.reason);
    trade = set.trade;
  }
  for (const who of ['ana', 'ben'] as const) {
    const said = accept(trade, who, trade.revision);
    if (!said.ok) throw new Error(said.reason);
    trade = said.trade;
  }
  return trade;
}

describe('inviting', () => {
  it('starts as an invitation nobody has answered', () => {
    const trade = beginTrade(1, 'ana', 'ben');
    expect(trade.stage).toBe('offered');
    expect(sideOf(trade, 'ana')).toBe('a');
    expect(sideOf(trade, 'ben')).toBe('b');
    expect(sideOf(trade, 'someone else')).toBeNull();
  });

  it('is answered only by the side that was invited', () => {
    const trade = beginTrade(1, 'ana', 'ben');
    expect(respond(trade, 'ana', true).ok).toBe(false);
    expect(respond(trade, 'ben', true).ok).toBe(true);
  });

  it('declining ends it, and it cannot then be accepted', () => {
    const declined = respond(beginTrade(1, 'ana', 'ben'), 'ben', false);
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;
    expect(declined.trade.stage).toBe('cancelled');
    // The double-submit: an accept arriving after a decline must not reopen it.
    expect(respond(declined.trade, 'ben', true).ok).toBe(false);
  });
});

describe('putting things on the table', () => {
  const ana = holding({ 0: { defId: 'sword.worn', count: 1 }, 3: { defId: 'potion.minor', count: 5 } });

  it('refuses a slot that is empty', () => {
    const result = setOffer(opened(), 'ana', [{ index: 7, count: 1 }], 0, ana);
    expect(result.ok).toBe(false);
  });

  it('refuses more than the stack holds', () => {
    expect(setOffer(opened(), 'ana', [{ index: 3, count: 6 }], 0, ana).ok).toBe(false);
    expect(setOffer(opened(), 'ana', [{ index: 3, count: 5 }], 0, ana).ok).toBe(true);
  });

  /**
   * The shortest path to a duplicate there is: offer slot 3 twice and let each
   * half be taken separately. Refused rather than merged, because merging would
   * accept an offer of eight potions from a stack of five.
   */
  it('refuses the same slot twice', () => {
    const result = setOffer(
      opened(),
      'ana',
      [
        { index: 3, count: 3 },
        { index: 3, count: 3 },
      ],
      0,
      ana,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('already on the table');
  });

  it('refuses coins nobody has', () => {
    expect(setOffer(opened(), 'ana', [], 101, ana).ok).toBe(false);
    expect(setOffer(opened(), 'ana', [], 100, ana).ok).toBe(true);
  });

  it('refuses an offer from somebody not in the trade', () => {
    expect(setOffer(opened(), 'cass', [], 0, ana).ok).toBe(false);
  });
});

describe('accepting', () => {
  const ana = holding({ 0: { defId: 'sword.worn', count: 1 } });
  const ben = holding({ 0: { defId: 'bow.hunting', count: 1 } });

  it('needs both sides on the same revision', () => {
    let trade = opened();
    const set = setOffer(trade, 'ana', [{ index: 0, count: 1 }], 0, ana);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    trade = set.trade;

    const one = accept(trade, 'ana', trade.revision);
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.trade.stage).toBe('open');
    expect(isSwappable(one.trade)).toBe(false);

    const both = accept(one.trade, 'ben', one.trade.revision);
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.trade.stage).toBe('confirmed');
    expect(isSwappable(both.trade)).toBe(true);
  });

  /**
   * The scam this whole design exists to prevent: accept a valuable offer, and
   * have it swapped for a worthless one in the instant before the exchange
   * resolves. Editing bumps the revision and clears *both* acceptances, so the
   * window is not small -- it does not exist.
   */
  it('is thrown away when the offer changes underneath it', () => {
    let trade = agreed(ana, ben, [{ index: 0, count: 1 }], [{ index: 0, count: 1 }]);
    expect(isSwappable(trade)).toBe(true);

    const swapped = setOffer(trade, 'ben', [], 0, ben);
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;
    trade = swapped.trade;

    expect(trade.stage).toBe('open');
    expect(isSwappable(trade)).toBe(false);
    expect(trade.a.acceptedRevision).toBe(-1);
    expect(trade.b.acceptedRevision).toBe(-1);
  });

  it('refuses an acceptance naming a revision that has passed', () => {
    let trade = opened();
    const stale = trade.revision;
    const set = setOffer(trade, 'ana', [{ index: 0, count: 1 }], 0, ana);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    trade = set.trade;
    expect(accept(trade, 'ben', stale).ok).toBe(false);
    expect(accept(trade, 'ben', trade.revision).ok).toBe(true);
  });
});

describe('cancelling', () => {
  it('ends a live trade and says why', () => {
    const trade = cancel(opened(), 'walked away');
    expect(trade.stage).toBe('cancelled');
    expect(trade.reason).toBe('walked away');
    expect(isLive(trade)).toBe(false);
  });

  it('leaves a finished one alone', () => {
    const done: Trade = { ...opened(), stage: 'done' };
    expect(cancel(done, 'too late').stage).toBe('done');
  });
});

describe('the swap', () => {
  it('refuses unless both sides accepted what is on the table now', () => {
    const ana = holding({ 0: { defId: 'sword.worn', count: 1 } });
    const ben = holding({});
    expect(swap(opened(), ana, ben).ok).toBe(false);
  });

  it('moves the goods and the coins together', () => {
    const ana = holding({ 0: { defId: 'sword.worn', count: 1 } }, 50);
    const ben = holding({ 0: { defId: 'bow.hunting', count: 1 } }, 20);
    const trade = agreed(ana, ben, [{ index: 0, count: 1 }], [{ index: 0, count: 1 }], 30, 0);

    const result = swap(trade, ana, ben);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.a.coins).toBe(20);
    expect(result.b.coins).toBe(50);
    expect(result.a.inventory.some((s) => s?.defId === 'bow.hunting')).toBe(true);
    expect(result.b.inventory.some((s) => s?.defId === 'sword.worn')).toBe(true);
    expect(result.a.inventory.some((s) => s?.defId === 'sword.worn')).toBe(false);
  });

  /**
   * Two full bags swapping one item each is a legal trade, and it is legal only
   * because the swap takes from both sides before it gives to either. Giving
   * first refuses it for want of a slot that is about to be empty.
   */
  it('lets two full bags exchange one item each', () => {
    const fill = (defId: string): Inventory =>
      Array.from({ length: INVENTORY_SLOTS }, () => ({ defId, count: 1 }));
    const ana: Holdings = { inventory: fill('sword.worn'), coins: 0 };
    const ben: Holdings = { inventory: fill('bow.hunting'), coins: 0 };
    const trade = agreed(ana, ben, [{ index: 0, count: 1 }], [{ index: 0, count: 1 }]);

    const result = swap(trade, ana, ben);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.a.inventory.filter((s) => s?.defId === 'bow.hunting')).toHaveLength(1);
    expect(result.b.inventory.filter((s) => s?.defId === 'sword.worn')).toHaveLength(1);
  });

  it('refuses the whole trade when one side cannot take what is coming', () => {
    const full: Holdings = {
      inventory: Array.from({ length: INVENTORY_SLOTS }, () => ({ defId: 'sword.worn', count: 1 })),
      coins: 0,
    };
    const giver = holding({ 0: { defId: 'bow.hunting', count: 1 }, 1: { defId: 'chest.leather', count: 1 } });
    // Two items out, nothing back: the full bag has no room for the second.
    const trade = agreed(
      giver,
      full,
      [
        { index: 0, count: 1 },
        { index: 1, count: 1 },
      ],
      [],
    );
    const result = swap(trade, giver, full);
    expect(result.ok).toBe(false);
  });

  /**
   * The late check. An offer names slots and is resolved against the bag at swap
   * time, so a bag that changed in between -- something sold, equipped, moved --
   * refuses the whole trade rather than trading whatever is in that slot now.
   */
  it('refuses when an offered slot changed after it was accepted', () => {
    const ana = holding({ 0: { defId: 'sword.worn', count: 1 } });
    const ben = holding({});
    const trade = agreed(ana, ben, [{ index: 0, count: 1 }], []);

    const sold: Holdings = { ...ana, inventory: bagOf({}) };
    const result = swap(trade, sold, ben);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('empty now');
  });

  it('refuses when the coins offered have since been spent', () => {
    const ana = holding({}, 60);
    const ben = holding({});
    const trade = agreed(ana, ben, [], [], 50, 0);
    expect(swap(trade, { ...ana, coins: 10 }, ben).ok).toBe(false);
  });
});

// --- the property ------------------------------------------------------

describe('furnishing an invitation (spec 170)', () => {
  const bow = { defId: 'bow.hunting', count: 1 };

  /**
   * An empty request asks "do you want to trade?" with no goods and no reason
   * to say yes. The inviter may put something up before it is answered.
   */
  it('lets the inviting side put something on the table', () => {
    const trade = beginTrade(1, 'ana', 'ben');
    const set = setOffer(trade, 'ana', [{ index: 0, count: 1 }], 5, holding({ 0: bow }));
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    // Still an invitation: advancing here would put Ben at a table he never
    // agreed to sit at, and `respond` -- which only runs at `offered` -- could
    // then never fire.
    expect(set.trade.stage).toBe('offered');
    expect(set.trade.a.offer).toEqual([{ index: 0, count: 1 }]);
    expect(set.trade.a.coins).toBe(5);
    expect(set.trade.revision).toBe(trade.revision + 1);
  });

  /** ...and the invited side may not, until it has answered. */
  it('refuses the invited side until it has answered', () => {
    const trade = beginTrade(1, 'ana', 'ben');
    const set = setOffer(trade, 'ben', [{ index: 0, count: 1 }], 0, holding({ 0: bow }));
    expect(set.ok).toBe(false);
    if (set.ok) return;
    expect(set.reason).toContain('answer the invitation');
  });

  it('refuses anybody who is not in it', () => {
    const trade = beginTrade(1, 'ana', 'ben');
    const set = setOffer(trade, 'cass', [], 0, holding({}));
    expect(set.ok).toBe(false);
  });

  /** A furnished invitation still answers, and lands both sides at the table. */
  it('carries the furnished offer through into the open trade', () => {
    const trade = beginTrade(1, 'ana', 'ben');
    const set = setOffer(trade, 'ana', [{ index: 0, count: 1 }], 0, holding({ 0: bow }));
    if (!set.ok) throw new Error(set.reason);
    const answered = respond(set.trade, 'ben', true);
    if (!answered.ok) throw new Error(answered.reason);
    expect(answered.trade.stage).toBe('open');
    expect(answered.trade.a.offer).toEqual([{ index: 0, count: 1 }]);
  });
});

describe('what the swap reports it moved (spec 171)', () => {
  const bow = { defId: 'bow.hunting', count: 1 };
  const stars = { defId: 'stars.weighted', count: 1 };

  /**
   * Carried out rather than recomputed, because by the time anyone asks it is
   * no longer answerable: an offer is a set of slot indices and the bags they
   * point into have been written.
   */
  it('reports each side by what it handed over', () => {
    const ana = holding({ 0: bow });
    const ben = holding({ 1: stars });
    const result = swap(
      agreed(ana, ben, [{ index: 0, count: 1 }], [{ index: 1, count: 1 }]),
      ana,
      ben,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.moved.a).toEqual([bow]);
    expect(result.moved.b).toEqual([stars]);
  });

  /** A part of a stack is reported as the part, not as the stack. */
  it('reports a partial stack as what left the bag', () => {
    const potions = { defId: 'potion.minor', count: 3 };
    const ana = holding({ 0: potions });
    const ben = holding({});
    const result = swap(agreed(ana, ben, [{ index: 0, count: 1 }], []), ana, ben);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.moved.a).toEqual([{ defId: 'potion.minor', count: 1 }]);
    expect(result.moved.b).toEqual([]);
  });
});

describe('exchangeProblem (spec 170)', () => {
  const bow = { defId: 'bow.hunting', count: 1 };

  /** A bag with no free slot and nothing to stack onto. */
  function full(): Holdings {
    const entries: Record<number, ItemStack> = {};
    for (let index = 0; index < INVENTORY_SLOTS; index += 1) {
      entries[index] = { defId: 'chest.leather', count: 1 };
    }
    return holding(entries);
  }

  it('says nothing about a trade that would go through', () => {
    const ana = holding({ 0: bow });
    const ben = holding({});
    expect(exchangeProblem(agreed(ana, ben, [{ index: 0, count: 1 }], []), ana, ben)).toBeNull();
  });

  /**
   * Whose bag it is, rather than a sentence about it. `swap` returned one
   * string to both players and it was only ever true for one of them: the
   * player whose own bag was the problem was told "their bag is full".
   */
  it('names the side whose bag has no room', () => {
    const ana = holding({ 0: bow });
    const ben = full();
    // Ana gives a bow to a bag with no slot for it, and offers nothing back --
    // so nothing leaves Ben's bag to make room.
    const trade = agreed(ana, ben, [{ index: 0, count: 1 }], []);
    const problem = exchangeProblem(trade, ana, ben);
    expect(problem?.side).toBe('b');

    // ...and the other way round.
    const mirrored = agreed(full(), holding({ 0: bow }), [], [{ index: 0, count: 1 }]);
    expect(exchangeProblem(mirrored, full(), holding({ 0: bow }))?.side).toBe('a');
  });

  /**
   * The check that warns and the check that refuses are the same arithmetic, so
   * they cannot drift: a warning nobody could act on, or worse a table that
   * looked fine and then failed, is what two separate implementations produce.
   */
  it('agrees with swap on whether the exchange runs', () => {
    for (const [ana, ben] of [
      [holding({ 0: bow }), holding({})],
      [holding({ 0: bow }), full()],
      [full(), full()],
    ] as const) {
      const trade = agreed(ana, ben, ana.inventory[0] ? [{ index: 0, count: 1 }] : [], []);
      expect(exchangeProblem(trade, ana, ben) === null).toBe(swap(trade, ana, ben).ok);
    }
  });
});

const ITEM_IDS = ['sword.worn', 'bow.hunting', 'chest.leather', 'potion.minor'] as const;

const arbStack = fc
  .record({ defId: fc.constantFrom(...ITEM_IDS), count: fc.integer({ min: 1, max: 12 }) })
  .map((stack) => ({ defId: stack.defId, count: Math.min(stack.count, maxStackOf(stack.defId)) }));

const arbHoldings: fc.Arbitrary<Holdings> = fc.record({
  inventory: fc
    .array(fc.option(arbStack, { nil: null }), { minLength: INVENTORY_SLOTS, maxLength: INVENTORY_SLOTS })
    .map((bag): Inventory => bag),
  coins: fc.integer({ min: 0, max: 500 }),
});

/**
 * An offer, including nonsensical ones: empty slots, counts past the stack,
 * indices off the end and the same slot twice. A generator that only produced
 * legal offers would only test the half of the code that says yes.
 */
const arbOffer: fc.Arbitrary<readonly OfferedSlot[]> = fc.array(
  fc.record({
    index: fc.integer({ min: -2, max: INVENTORY_SLOTS + 1 }),
    count: fc.integer({ min: -1, max: 14 }),
  }),
  { maxLength: 5 },
);

/** Everything both players hold, as one tally. The thing that must not change. */
function tallyBoth(a: Holdings, b: Holdings): ReadonlyMap<string, number> {
  const tally = new Map<string, number>();
  for (const bag of [a.inventory, b.inventory]) {
    for (const stack of bag) {
      if (!stack) continue;
      tally.set(stack.defId, (tally.get(stack.defId) ?? 0) + stack.count);
    }
  }
  return tally;
}

describe('conservation across both bags', () => {
  /**
   * Nothing is created and nothing is destroyed by a swap -- accepted *or*
   * refused, and counting **both players together**.
   *
   * That last part is the whole difference from spec 126's property. A swap that
   * duplicated a sword would leave each bag individually plausible, and only the
   * sum over both catches it. Coins are summed the same way and for the same
   * reason: a trade is the one place they can be minted by an arithmetic slip.
   */
  it('holds over random offers between random bags', () => {
    fc.assert(
      fc.property(
        arbHoldings,
        arbHoldings,
        arbOffer,
        arbOffer,
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 600 }),
        (ana, ben, anaOffer, benOffer, anaCoins, benCoins) => {
          const goods = tallyBoth(ana, ben);
          const purse = ana.coins + ben.coins;

          let trade = opened();
          for (const [who, offer, coins, holdings] of [
            ['ana', anaOffer, anaCoins, ana],
            ['ben', benOffer, benCoins, ben],
          ] as const) {
            const set = setOffer(trade, who, offer, coins, holdings);
            // An illegal offer is refused and the trade is untouched, which is
            // itself part of the property: a rejected edit must not half-apply.
            if (set.ok) trade = set.trade;
          }
          for (const who of ['ana', 'ben'] as const) {
            const said = accept(trade, who, trade.revision);
            if (said.ok) trade = said.trade;
          }

          const result = swap(trade, ana, ben);
          if (!result.ok) {
            // A refusal leaves both players exactly as they were -- there is
            // nothing to check but that nothing came back to write.
            expect(tallyBoth(ana, ben)).toEqual(goods);
            return;
          }

          expect(tallyBoth(result.a, result.b)).toEqual(goods);
          expect(result.a.coins + result.b.coins).toBe(purse);
          expect(result.a.coins).toBeGreaterThanOrEqual(0);
          expect(result.b.coins).toBeGreaterThanOrEqual(0);

          // ...and every accepted state is a legal one.
          for (const bag of [result.a.inventory, result.b.inventory]) {
            expect(bag).toHaveLength(INVENTORY_SLOTS);
            for (const stack of bag) {
              if (!stack) continue;
              expect(stack.count).toBeGreaterThanOrEqual(1);
              expect(stack.count).toBeLessThanOrEqual(maxStackOf(stack.defId));
            }
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
