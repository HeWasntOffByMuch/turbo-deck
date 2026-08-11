/**
 * The trade screen (spec 134).
 *
 * The two that matter are the two the other player can hurt you with: an Accept
 * that sends the revision it was *shown*, and an offer that goes whole so the
 * server and the screen cannot disagree about what is on the table.
 */

import { describe, expect, it } from 'vitest';
import { THEME } from '../theme/theme.js';
import { TradeScreen, type TradeUiView } from './trade.js';
import type { ItemView } from '../widgets/item-slot.js';

const item = (defId: string, name: string, count = 1): ItemView => ({
  defId,
  name,
  count,
  slot: null,
  icon: 'item:potion',
  levelRequirement: 1,
});

function viewOf(over: Partial<TradeUiView> = {}): TradeUiView {
  return {
    stage: 'open',
    you: { name: 'You', rows: [], coins: 0, accepted: false },
    them: { name: 'Ben', rows: [], coins: 0, accepted: false },
    bag: [item('potion.minor', 'Minor Salve', 3), item('bow.hunting', 'Hunting Bow'), null],
    offered: [],
    coins: 0,
    purse: 60,
    revision: 4,
    reason: '',
    ...over,
  };
}

interface Harness {
  readonly screen: TradeScreen;
  readonly offers: { slots: readonly { index: number; count: number }[]; coins: number }[];
  readonly accepted: number[];
  readonly responses: boolean[];
}

function harness(): Harness {
  const screen = new TradeScreen({ theme: THEME });
  const offers: { slots: readonly { index: number; count: number }[]; coins: number }[] = [];
  const accepted: number[] = [];
  const responses: boolean[] = [];
  screen.onOffer = (slots, coins) => offers.push({ slots: slots.map((s) => ({ ...s })), coins });
  screen.onAccept = (revision) => accepted.push(revision);
  screen.onRespond = (accept) => responses.push(accept);
  return { screen, offers, accepted, responses };
}

describe('putting things on the table', () => {
  it('emits the whole offer, not the change to it', () => {
    const h = harness();
    h.screen.setTrade(viewOf({ offered: [0] }));
    h.screen.toggle(1);
    // Both slots, because the wire replaces the offer whole (spec 132) -- a
    // protocol with add and remove has two handlers that can disagree about
    // what is on the table.
    expect(h.offers).toEqual([
      { slots: [{ index: 0, count: 3 }, { index: 1, count: 1 }], coins: 0 },
    ]);
  });

  it('takes one off the same way', () => {
    const h = harness();
    h.screen.setTrade(viewOf({ offered: [0, 1] }));
    h.screen.toggle(0);
    expect(h.offers).toEqual([{ slots: [{ index: 1, count: 1 }], coins: 0 }]);
  });

  /** The rule every screen since phase 4 keeps: it never edits itself. */
  it('changes nothing on screen until the next setTrade', () => {
    const h = harness();
    h.screen.setTrade(viewOf({ offered: [] }));
    h.screen.toggle(0);
    expect(h.screen.view?.offered).toEqual([]);
    expect(h.screen.bagSlots[0]?.dropCandidate).toBe(false);

    h.screen.setTrade(viewOf({ offered: [0] }));
    expect(h.screen.bagSlots[0]?.dropCandidate).toBe(true);
  });

  it('ignores an empty slot', () => {
    const h = harness();
    h.screen.setTrade(viewOf());
    h.screen.toggle(2);
    expect(h.offers).toEqual([]);
  });

  it('keeps the coins when the goods change, and the goods when the coins do', () => {
    const h = harness();
    h.screen.setTrade(viewOf({ offered: [1], coins: 20 }));
    h.screen.toggle(0);
    expect(h.offers[0]?.coins).toBe(20);

    h.screen.stepCoins(10);
    expect(h.offers[1]?.slots).toEqual([{ index: 1, count: 1 }]);
    expect(h.offers[1]?.coins).toBe(30);
  });

  it('will not offer coins nobody has', () => {
    const h = harness();
    h.screen.setTrade(viewOf({ coins: 55, purse: 60 }));
    h.screen.stepCoins(10);
    expect(h.offers[0]?.coins).toBe(60);
    h.screen.setTrade(viewOf({ coins: 60, purse: 60 }));
    h.screen.stepCoins(10);
    // Already at the ceiling: nothing to say, so nothing is said.
    expect(h.offers).toHaveLength(1);
  });
});

describe('accepting', () => {
  /**
   * The whole reason this screen is careful.
   *
   * The button sends the revision the *view* carried. A screen that worked one
   * out would be a screen with an opinion about whether the offer had changed,
   * which is exactly the opinion it must not have -- and the scam spec 132
   * exists to stop.
   */
  it('sends the revision it was shown, and the newer one after a resend', () => {
    const h = harness();
    h.screen.setTrade(viewOf({ revision: 4 }));
    h.screen.acceptButton.press();
    expect(h.accepted).toEqual([4]);

    h.screen.setTrade(viewOf({ revision: 5 }));
    h.screen.acceptButton.press();
    expect(h.accepted).toEqual([4, 5]);
  });

  it('answers an invitation rather than accepting an offer', () => {
    const h = harness();
    h.screen.setTrade(viewOf({ stage: 'offered' }));
    h.screen.acceptButton.press();
    // Two different messages, one word to the player.
    expect(h.responses).toEqual([true]);
    expect(h.accepted).toEqual([]);

    h.screen.declineButton.press();
    expect(h.responses).toEqual([true, false]);
  });

  it('shows their acceptance where it cannot be missed', () => {
    const h = harness();
    h.screen.setTrade(viewOf({ them: { name: 'Ben', rows: [], coins: 0, accepted: true } }));
    const heading = [...h.screen.walk()].find((widget) => widget.name === 'trade:theirs:rows');
    expect(heading).toBeDefined();
    expect(h.screen.view?.them.accepted).toBe(true);
  });
});

describe('when it is over', () => {
  /**
   * Nothing left that would ask the server for anything. A button still there
   * after the window is dead is a button whose press is refused, and a refusal
   * the player did not cause is noise.
   */
  it('offers no button that would ask for anything, and says why', () => {
    const h = harness();
    h.screen.setTrade(viewOf({ stage: 'over', reason: 'you walked too far apart' }));
    expect(h.screen.acceptButton.visible).toBe(false);
    expect(h.screen.declineButton.visible).toBe(false);
    expect(h.screen.addCoin.visible).toBe(false);
    expect(h.screen.cancelButton.visible).toBe(true);
    expect(h.screen.cancelButton.label).toBe('Close');

    h.screen.toggle(0);
    h.screen.stepCoins(10);
    expect(h.offers).toEqual([]);
  });
});
