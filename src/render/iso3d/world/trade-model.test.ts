/**
 * The trade screen's view-model (spec 134).
 *
 * The one worth reading is the consuming match. The wire sends each side's offer
 * as *items* -- the other player cannot see into your bag -- so the slots to
 * light in your own bag are matched back, and two stacks of the same thing on
 * the table have to light two slots rather than one twice.
 */

import { describe, expect, it } from 'vitest';
import { TradeStageValue } from '../../../server/net/protocol.js';
import { emptyInventory, type Inventory, type ItemStack } from '../../../server/state/types.js';
import type { TradeSideView } from '../../../server/net/messages.js';
import { offeredSlotsOf, tradeViewOf } from './trade-model.js';

function bagOf(...stacks: (ItemStack | null)[]): Inventory {
  const bag = [...emptyInventory()];
  stacks.forEach((stack, index) => {
    bag[index] = stack;
  });
  return bag;
}

const side = (over: Partial<TradeSideView> = {}): TradeSideView => ({
  playerId: 'ana',
  displayName: 'Ana',
  offer: [],
  coins: 0,
  accepted: false,
  ...over,
});

describe('offeredSlotsOf', () => {
  it('finds the slot an offered item is standing in', () => {
    const bag = bagOf({ defId: 'bow.hunting', count: 1 }, { defId: 'potion.minor', count: 3 });
    expect(offeredSlotsOf([{ defId: 'potion.minor', count: 3 }], bag)).toEqual([1]);
  });

  /**
   * Two separate stacks of the same thing are two slots. A plain `findIndex`
   * lights the first one twice and leaves the second dark, which reads as a bag
   * that has forgotten what is on the table.
   */
  it('matches consumingly, so two stacks light two slots', () => {
    const bag = bagOf(
      { defId: 'potion.minor', count: 2 },
      { defId: 'bow.hunting', count: 1 },
      { defId: 'potion.minor', count: 1 },
    );
    const offer = [
      { defId: 'potion.minor', count: 2 },
      { defId: 'potion.minor', count: 1 },
    ];
    expect(offeredSlotsOf(offer, bag)).toEqual([0, 2]);
  });

  it('lights nothing for something that is no longer there', () => {
    expect(offeredSlotsOf([{ defId: 'bow.hunting', count: 1 }], bagOf())).toEqual([]);
  });
});

describe('tradeViewOf', () => {
  it('is null when there is no trade, so the window has something to follow', () => {
    expect(tradeViewOf({ trade: null, inventory: emptyInventory(), coins: 0 })).toBeNull();
  });

  it('resolves both sides and carries the revision untouched', () => {
    const view = tradeViewOf({
      trade: {
        stage: TradeStageValue.Open,
        revision: 7,
        you: side({ offer: [{ defId: 'bow.hunting', count: 1 }], coins: 12 }),
        them: side({ playerId: 'ben', displayName: 'Ben', offer: [], accepted: true }),
        reason: '',
      },
      inventory: bagOf({ defId: 'bow.hunting', count: 1 }),
      coins: 40,
    });

    expect(view?.stage).toBe('open');
    expect(view?.you.rows).toEqual([{ name: 'Hunting Bow', count: 1 }]);
    expect(view?.them.name).toBe('Ben');
    expect(view?.them.accepted).toBe(true);
    expect(view?.offered).toEqual([0]);
    expect(view?.coins).toBe(12);
    expect(view?.purse).toBe(40);
    // Never derived, never recomputed: it is what an acceptance must name.
    expect(view?.revision).toBe(7);
  });

  it('reads both endings as one word, and keeps the reason', () => {
    for (const stage of [TradeStageValue.Done, TradeStageValue.Cancelled]) {
      const view = tradeViewOf({
        trade: { stage, revision: 1, you: side(), them: side(), reason: 'they disconnected' },
        inventory: emptyInventory(),
        coins: 0,
      });
      expect(view?.stage).toBe('over');
      expect(view?.reason).toBe('they disconnected');
    }
  });

  /**
   * The good ending is the one the server has nothing to say about: `finish`
   * leaves the reason empty because there is nothing to explain. That left the
   * payoff of the whole feature as a blank panel with a Close button on it.
   */
  it('gives a completed trade words of its own', () => {
    const view = tradeViewOf({
      trade: { stage: TradeStageValue.Done, revision: 1, you: side(), them: side(), reason: '' },
      inventory: emptyInventory(),
      coins: 0,
    });
    expect(view?.stage).toBe('over');
    expect(view?.succeeded).toBe(true);
    expect(view?.reason).not.toBe('');
  });

  /** ...and never puts words in the server's mouth when it has some. */
  it('leaves a stated reason alone, and marks a cancellation as not the good one', () => {
    const view = tradeViewOf({
      trade: {
        stage: TradeStageValue.Cancelled,
        revision: 1,
        you: side(),
        them: side(),
        reason: 'you walked too far apart',
      },
      inventory: emptyInventory(),
      coins: 0,
    });
    expect(view?.succeeded).toBe(false);
    expect(view?.reason).toBe('you walked too far apart');
  });

  it('names an item this build has never heard of rather than hiding the row', () => {
    const view = tradeViewOf({
      trade: {
        stage: TradeStageValue.Open,
        revision: 0,
        you: side(),
        them: side({ offer: [{ defId: 'sword.imaginary', count: 1 }] }),
        reason: '',
      },
      inventory: emptyInventory(),
      coins: 0,
    });
    // A server running content this build does not have. Hiding the row would
    // mean accepting an offer with an invisible item in it.
    expect(view?.them.rows).toEqual([{ name: 'sword.imaginary', count: 1 }]);
  });
});
