import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Rng } from '../shared/prng.js';
import { HAND_SIZE, type DeckState } from './types.js';
import { drawBonusCard, initDeck, useBonusCard, useCard } from './deck.js';

const DEF_IDS = Array.from({ length: 10 }, (_, i) => `card-${i % 4}`);

function countTotal(state: DeckState): number {
  return (
    state.drawPile.length +
    state.discardPile.length +
    state.hand.filter((card) => card !== null).length +
    (state.bonusSlot ? 1 : 0)
  );
}

type Action = { kind: 'use'; index: 0 | 1 | 2 } | { kind: 'bonusDraw' } | { kind: 'bonusUse' };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constantFrom<Action>({ kind: 'use', index: 0 }, { kind: 'use', index: 1 }, { kind: 'use', index: 2 }),
  fc.constant<Action>({ kind: 'bonusDraw' }),
  fc.constant<Action>({ kind: 'bonusUse' }),
);

function applyActions(seed: number, actions: readonly Action[]): { finalState: DeckState; total: number } {
  let state = initDeck(DEF_IDS, Rng.fromSeed(seed));
  const total = countTotal(state);
  expect(state.hand.length).toBe(HAND_SIZE);

  for (const action of actions) {
    if (action.kind === 'use') {
      if (state.hand[action.index] === null) continue;
      const drawWasEmpty = state.drawPile.length === 0;
      const discardWasEmpty = state.discardPile.length === 0;
      const { state: next } = useCard(state, action.index);
      expect(next.hand.length).toBe(HAND_SIZE);
      expect(countTotal(next)).toBe(total);
      const refilled = next.hand[action.index] !== null;
      expect(refilled).toBe(!(drawWasEmpty && discardWasEmpty));
      state = next;
    } else if (action.kind === 'bonusDraw') {
      const next = drawBonusCard(state);
      expect(countTotal(next)).toBe(total);
      state = next;
    } else {
      const result = useBonusCard(state);
      if (result) {
        expect(countTotal(result.state)).toBe(total);
        state = result.state;
      }
    }
  }

  return { finalState: state, total };
}

describe('deck engine invariants', () => {
  it('keeps hand length at 3, conserves total cards, and refills a used slot iff the deck was not exhausted', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.array(actionArb, { maxLength: 200 }), (seed, actions) => {
        applyActions(seed, actions);
      }),
    );
  });

  it('is deterministic: same seed + same action sequence produces the same resulting state', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.array(actionArb, { maxLength: 100 }), (seed, actions) => {
        const runA = applyActions(seed, actions);
        const runB = applyActions(seed, actions);
        expect(runA.finalState.hand).toEqual(runB.finalState.hand);
        expect(runA.finalState.drawPile).toEqual(runB.finalState.drawPile);
        expect(runA.finalState.discardPile).toEqual(runB.finalState.discardPile);
        expect(runA.finalState.bonusSlot).toEqual(runB.finalState.bonusSlot);
        expect(runA.finalState.rng.getState()).toEqual(runB.finalState.rng.getState());
      }),
    );
  });

  it('deals an initial hand of exactly 3 known cards, drawn from the shuffled deck', () => {
    const state = initDeck(DEF_IDS, Rng.fromSeed(1));
    expect(state.hand.every((card) => card !== null)).toBe(true);
    expect(state.drawPile.length).toBe(DEF_IDS.length - HAND_SIZE);
    expect(state.discardPile).toEqual([]);
    expect(state.bonusSlot).toBeNull();
  });

  it('empties a hand slot only when both the draw pile and discard pile are exhausted', () => {
    // A 1-card deck: the initial hand gets it, slots 1 and 2 stay empty.
    let state = initDeck(['only-card'], Rng.fromSeed(7));
    expect(state.hand[0]).not.toBeNull();
    expect(state.hand[1]).toBeNull();
    expect(state.hand[2]).toBeNull();

    const { state: afterUse, used } = useCard(state, 0);
    expect(used.defId).toBe('only-card');
    // Nothing else exists anywhere in the system, so the slot goes empty.
    expect(afterUse.hand[0]).toBeNull();
    state = afterUse;
  });
});
