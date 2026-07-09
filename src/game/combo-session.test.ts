import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { HAND_SIZE, type PlayingCard, type StandardDeck } from '../cards/standard.js';
import { WAVE_BASE_COUNT } from '../sim/constants.js';
import { initComboGame, stepComboGame, type ComboGameState, type ComboInput } from './combo-session.js';

const NEUTRAL: ComboInput = { moveX: 0, moveY: 0, attack: false, aimX: 1, aimY: 0, parry: false, dodge: false };

function deckIds(deck: StandardDeck): number[] {
  return [...deck.drawPile, ...deck.hand.filter((c): c is PlayingCard => c !== null), ...deck.discardPile]
    .map((c) => c.instanceId)
    .sort((a, b) => a - b);
}

function handIds(deck: StandardDeck): (number | null)[] {
  return deck.hand.map((c) => (c ? c.instanceId : null));
}

function snapshot(s: ComboGameState): string {
  return JSON.stringify([handIds(s.deck), s.refillAtTick, s.combat.tick, s.combat.player.health, s.combat.enemies.map((e) => [e.id, e.health])]);
}

describe('initComboGame', () => {
  it('starts with an empty arena and a full five-card hand', () => {
    const s = initComboGame(1);
    expect(s.combat.enemies).toHaveLength(0);
    expect(s.deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE);
    expect(deckIds(s.deck)).toHaveLength(52);
  });
});

describe('stepComboGame wiring', () => {
  it('spawning a wave populates the arena and counts up', () => {
    const r = stepComboGame(initComboGame(2), { ...NEUTRAL, spawnWave: true });
    expect(r.events.some((e) => e.kind === 'waveSpawned')).toBe(true);
    expect(r.state.combat.enemies).toHaveLength(WAVE_BASE_COUNT + 1);
    expect(r.state.combat.waveNumber).toBe(1);
  });

  it('playing a card empties its slot, and only refills it after the draw delay', () => {
    const start = initComboGame(4);
    const before = deckIds(start.deck);
    const played = start.deck.hand[1];
    let s = stepComboGame(start, { ...NEUTRAL, playHandIndex: 1 }).state;
    // The slot is now empty (spent card gone to discard) -- no instant refill.
    expect(s.deck.hand[1]).toBeNull();
    expect(s.deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE - 1);
    expect(s.refillAtTick[1]).toBeGreaterThan(s.combat.tick);
    expect(deckIds(s.deck)).toEqual(before); // spent card is in discard; nothing lost

    // Idle right up to (but not through) the refill tick: still empty.
    const refillTick = s.refillAtTick[1] as number;
    while (s.combat.tick < refillTick - 1) s = stepComboGame(s, NEUTRAL).state;
    expect(s.deck.hand[1]).toBeNull();

    // One more tick reaches the refill: the slot draws a fresh, different card.
    s = stepComboGame(s, NEUTRAL).state;
    expect(s.deck.hand[1]).not.toBeNull();
    expect(s.deck.hand[1]?.instanceId).not.toBe(played?.instanceId);
    expect(s.refillAtTick[1]).toBeNull();
    expect(s.deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE);
    expect(deckIds(s.deck)).toEqual(before);
  });

  it('activating empties the whole hand under the same delay (no free instant refill)', () => {
    const start = initComboGame(7);
    const r1 = stepComboGame(start, { ...NEUTRAL, activate: true });
    expect(r1.events.some((e) => e.kind === 'activated')).toBe(true);
    // The hand is spent, not instantly redrawn: every slot is empty and pending.
    expect(r1.state.deck.hand.every((c) => c === null)).toBe(true);
    expect(r1.state.refillAtTick.every((t) => t !== null)).toBe(true);
    expect(r1.state.combat.player.activateLockUntil).toBeGreaterThan(r1.state.combat.tick);
    expect(deckIds(r1.state.deck)).toHaveLength(52);

    const r2 = stepComboGame(r1.state, { ...NEUTRAL, activate: true });
    expect(r2.events.some((e) => e.kind === 'activateIgnoredLocked')).toBe(true);
    expect(handIds(r2.state.deck)).toEqual(handIds(r1.state.deck)); // untouched while locked
  });

  it('replays identically for the same seed and input sequence (determinism)', () => {
    const inputArb: fc.Arbitrary<ComboInput> = fc.record(
      {
        moveX: fc.constantFrom(-1 as const, 0 as const, 1 as const),
        moveY: fc.constantFrom(-1 as const, 0 as const, 1 as const),
        attack: fc.boolean(),
        aimX: fc.constantFrom(-1, 0, 1),
        aimY: fc.constantFrom(-1, 0, 1),
        parry: fc.boolean(),
        dodge: fc.boolean(),
        // Left out of requiredKeys, so these are randomly present or omitted per input.
        playHandIndex: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const, 4 as const),
        activate: fc.boolean(),
        spawnWave: fc.boolean(),
      },
      { requiredKeys: ['moveX', 'moveY', 'attack', 'aimX', 'aimY', 'parry', 'dodge'] },
    );

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.array(inputArb, { minLength: 300, maxLength: 300 }), (seed, inputs) => {
        const run = (): ComboGameState => {
          let s = initComboGame(seed);
          const total = deckIds(s.deck).length;
          for (const input of inputs) {
            s = stepComboGame(s, input).state;
            // Slots may sit empty on the draw-delay cooldown, but the hand array
            // is always five slots and the 52-card multiset is always conserved.
            expect(s.deck.hand).toHaveLength(HAND_SIZE);
            expect(s.deck.hand.filter((c) => c !== null).length).toBeLessThanOrEqual(HAND_SIZE);
            expect(deckIds(s.deck)).toHaveLength(total);
          }
          return s;
        };
        expect(snapshot(run())).toBe(snapshot(run()));
      }),
      { numRuns: 15 },
    );
  });
});
