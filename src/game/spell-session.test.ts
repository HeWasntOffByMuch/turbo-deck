import { describe, expect, it } from 'vitest';
import type { SpellId } from '../cards/spells.js';
import {
  CARD_DRAW_DELAY_TICKS,
  initSpellGame,
  stepSpellGame,
  SYNERGY_WINDOW_TICKS,
  type SpellGameEvent,
  type SpellGameState,
  type SpellInput,
} from './spell-session.js';

const NEUTRAL: SpellInput = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, targetX: 0, targetY: 0 };

function play(slot: 0 | 1 | 2 | 3): SpellInput {
  return { ...NEUTRAL, playHandIndex: slot };
}

function run(state: SpellGameState, inputs: readonly SpellInput[]): { state: SpellGameState; events: SpellGameEvent[] } {
  let s = state;
  const events: SpellGameEvent[] = [];
  for (const input of inputs) {
    const r = stepSpellGame(s, input);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

/** Find the slot indices whose cards match `id` in the starting hand. */
function slotsWithId(state: SpellGameState, id: SpellId): number[] {
  return state.deck.hand.flatMap((c, i) => (c && c.id === id ? [i] : []));
}

describe('spell session', () => {
  it('resolves a lone card as its base spell when the window closes', () => {
    const state = initSpellGame(7);
    const { events } = run(state, [play(0), ...Array.from({ length: SYNERGY_WINDOW_TICKS }, () => NEUTRAL)]);
    const resolved = events.find((e) => e.kind === 'spellsResolved');
    expect(resolved).toBeDefined();
    if (resolved && resolved.kind === 'spellsResolved') expect(resolved.ids).toHaveLength(1);
  });

  it('fuses two identical cards played inside the window into one cast', () => {
    // Seed chosen so the opening hand holds at least two of the same card.
    let seed = 1;
    let start = initSpellGame(seed);
    while (![...new Set(start.deck.hand.map((c) => c?.id))].some((id) => id && slotsWithId(start, id).length >= 2)) {
      start = initSpellGame(++seed);
    }
    const dup = [...new Set(start.deck.hand.map((c) => c?.id))].find((id) => id && slotsWithId(start, id).length >= 2) as SpellId;
    const [a, b] = slotsWithId(start, dup) as [number, number];

    const { events } = run(start, [
      play(a as 0 | 1 | 2 | 3),
      play(b as 0 | 1 | 2 | 3),
      ...Array.from({ length: SYNERGY_WINDOW_TICKS }, () => NEUTRAL),
    ]);
    const resolved = events.filter((e) => e.kind === 'spellsResolved');
    expect(resolved).toHaveLength(1); // one window, one cast
    if (resolved[0]?.kind === 'spellsResolved') expect(resolved[0].ids).toEqual([dup, dup]);
    const casts = events.filter((e) => e.kind === 'spellCast');
    expect(casts).toHaveLength(1);
  });

  it('ignores a play on an empty slot', () => {
    let state = initSpellGame(3);
    // Empty slot 0 by playing it, then immediately try to play it again.
    state = run(state, [play(0)]).state;
    const { events } = run(state, [play(0)]);
    expect(events.some((e) => e.kind === 'playIgnoredEmptySlot')).toBe(true);
  });

  it('leaves a played slot empty until the draw delay elapses', () => {
    const state = initSpellGame(5);
    const played = run(state, [play(1)]).state;
    expect(played.deck.hand[1]).toBeNull();
    // Still empty just before the delay, refilled just after.
    const justBefore = run(played, Array.from({ length: CARD_DRAW_DELAY_TICKS - 2 }, () => NEUTRAL)).state;
    expect(justBefore.deck.hand[1]).toBeNull();
    const justAfter = run(justBefore, Array.from({ length: 3 }, () => NEUTRAL)).state;
    expect(justAfter.deck.hand[1]).not.toBeNull();
  });

  it('replays identically for the same seed and inputs', () => {
    const inputs = [play(0), NEUTRAL, play(1), ...Array.from({ length: 30 }, () => NEUTRAL), play(2), ...Array.from({ length: 30 }, () => NEUTRAL)];
    const a = run(initSpellGame(11), inputs).state;
    const b = run(initSpellGame(11), inputs).state;
    expect(a).toEqual(b);
  });
});
