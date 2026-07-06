import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CARD_CATALOG } from '../cards/catalog.js';
import { HAND_SIZE } from '../cards/types.js';
import {
  ENEMY_IDLE_TICKS,
  ENEMY_MAX_HEALTH,
  ENEMY_WINDUP_TICKS,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_MANA,
} from '../sim/constants.js';
import { IDENTITY_MODIFIERS, NEUTRAL_INPUT } from '../sim/types.js';
import { computeModifiers, initGame, stepGame, type GameInput, type GameState } from './session.js';

// Active-only decks keep modifiers at identity, so enemy timing is unchanged.
const ACTIVE_DECK = ['fireball', 'emberlash', 'iceshard', 'guardbreak', 'mend', 'fireball', 'iceshard', 'guardbreak'];
// A mixed deck exercises passives (held modifiers) alongside actives.
const MIXED_DECK = ['fireball', 'iceshard', 'sharpen', 'momentum', 'vigor', 'focus', 'bloodpact', 'recklesshex'];

const NEUTRAL_GAME_INPUT: GameInput = NEUTRAL_INPUT;

function countTotalCards(state: GameState): number {
  return (
    state.deck.drawPile.length +
    state.deck.discardPile.length +
    state.deck.hand.filter((c) => c !== null).length +
    (state.deck.bonusSlot ? 1 : 0)
  );
}

describe('stepGame active cards', () => {
  it('playing an active damage card reduces enemy health and spends mana', () => {
    let state = initGame(1, ACTIVE_DECK);
    const handIndex = state.deck.hand.findIndex((card) => {
      if (!card) return false;
      const def = CARD_CATALOG.get(card.defId);
      return def?.kind === 'active' && def.effect.kind === 'damage';
    });
    expect(handIndex).toBeGreaterThanOrEqual(0);
    const card = state.deck.hand[handIndex];
    if (!card) throw new Error('expected a card');
    const def = CARD_CATALOG.get(card.defId);
    if (!def || def.kind !== 'active' || def.effect.kind !== 'damage') throw new Error('expected an active damage card');

    const before = state;
    const result = stepGame(state, { ...NEUTRAL_GAME_INPUT, playHandIndex: handIndex as 0 | 1 | 2 }, CARD_CATALOG);
    state = result.state;

    expect(state.combat.enemy.health).toBe(ENEMY_MAX_HEALTH - def.effect.amount);
    expect(state.combat.player.mana).toBeLessThan(before.combat.player.mana + 0.001);
    expect(result.events.some((e) => e.kind === 'cardPlayed')).toBe(true);
    expect(state.deck.hand.length).toBe(HAND_SIZE);
  });

  it('playing an empty hand slot is a no-op aside from the event', () => {
    const state = initGame(1, ['only-one']);
    const result = stepGame(state, { ...NEUTRAL_GAME_INPUT, playHandIndex: 1 }, CARD_CATALOG);
    expect(result.events).toContainEqual({ kind: 'playCardIgnoredEmptySlot' });
    expect(result.state.deck.hand).toEqual(state.deck.hand);
    expect(result.state.combat.player.health).toBe(state.combat.player.health);
  });

  it('playing the bonus slot when nothing is pending is a no-op', () => {
    const state = initGame(1, ACTIVE_DECK);
    expect(state.deck.bonusSlot).toBeNull();
    const result = stepGame(state, { ...NEUTRAL_GAME_INPUT, playBonusCard: true }, CARD_CATALOG);
    expect(result.state.deck.bonusSlot).toBeNull();
    expect(result.state.combat.enemy.health).toBe(state.combat.enemy.health);
  });

  it('a perfect defense always leaves the bonus slot occupied', () => {
    let state = initGame(5, ACTIVE_DECK);
    expect(state.deck.bonusSlot).toBeNull();

    const hitTick = ENEMY_IDLE_TICKS + ENEMY_WINDUP_TICKS; // identity mods, so timing is unchanged
    let perfectEvents: unknown[] = [];
    for (let tick = 1; tick <= hitTick; tick++) {
      const input: GameInput = tick === hitTick ? { ...NEUTRAL_GAME_INPUT, parry: true } : NEUTRAL_GAME_INPUT;
      const result = stepGame(state, input, CARD_CATALOG);
      state = result.state;
      if (tick === hitTick) perfectEvents = result.events.filter((e) => e.kind === 'perfectDefense');
    }

    expect(perfectEvents).toHaveLength(1);
    expect(state.deck.bonusSlot).not.toBeNull();
  });
});

describe('stepGame passive cards', () => {
  it('aggregates held passives into modifiers; an all-active hand yields identity', () => {
    const passives = initGame(1, ['vigor', 'vigor', 'vigor']);
    const mods = computeModifiers(passives.deck, CARD_CATALOG);
    expect(mods.healthRegenPerTick).toBeGreaterThan(0);

    const actives = initGame(1, ['fireball', 'fireball', 'fireball']);
    expect(computeModifiers(actives.deck, CARD_CATALOG)).toEqual(IDENTITY_MODIFIERS);
  });

  it('playing a passive retires it (no mana spent, no one-shot effect)', () => {
    const state = initGame(1, ['vigor', 'vigor', 'vigor']);
    const before = state.combat;
    const result = stepGame(state, { ...NEUTRAL_GAME_INPUT, playHandIndex: 0 }, CARD_CATALOG);
    expect(result.events.some((e) => e.kind === 'passiveRetired')).toBe(true);
    expect(result.events.some((e) => e.kind === 'cardPlayed')).toBe(false);
    // No mana spent (only the passive regen/base regen applied), enemy untouched.
    expect(result.state.combat.player.mana).toBeGreaterThanOrEqual(before.player.mana);
    expect(result.state.combat.enemy.health).toBe(before.enemy.health);
    expect(result.state.deck.hand.length).toBe(HAND_SIZE);
  });

  it('a held enemyTempo passive makes the slam land sooner — an emergent effect via the sim', () => {
    let state = initGame(3, ['recklesshex', 'recklesshex', 'recklesshex']);
    let hitTick: number | null = null;
    for (let tick = 1; tick <= ENEMY_IDLE_TICKS + ENEMY_WINDUP_TICKS && hitTick === null; tick++) {
      const result = stepGame(state, NEUTRAL_GAME_INPUT, CARD_CATALOG);
      state = result.state;
      if (result.events.some((e) => e.kind === 'playerHit')) hitTick = tick;
    }
    expect(hitTick).not.toBeNull();
    // Faster windup (speedMultiplier < 1) resolves before the un-modified hit tick.
    expect(hitTick as number).toBeLessThan(ENEMY_IDLE_TICKS + ENEMY_WINDUP_TICKS);
  });
});

describe('fuzz smoke test', () => {
  it(
    'never crashes or leaves an illegal state across thousands of ticks of seeded-random-but-valid input',
    () => {
      const inputArb: fc.Arbitrary<GameInput> = fc.record(
        {
          moveX: fc.constantFrom(-1 as const, 0 as const, 1 as const),
          moveY: fc.constantFrom(-1 as const, 0 as const, 1 as const),
          attack: fc.boolean(),
          aimX: fc.constantFrom(-1, 0, 1),
          aimY: fc.constantFrom(-1, 0, 1),
          parry: fc.boolean(),
          dodge: fc.boolean(),
          playHandIndex: fc.constantFrom(0 as const, 1 as const, 2 as const),
          playBonusCard: fc.boolean(),
        },
        { requiredKeys: ['moveX', 'moveY', 'attack', 'aimX', 'aimY', 'parry', 'dodge', 'playBonusCard'] },
      );

      fc.assert(
        fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.array(inputArb, { minLength: 2000, maxLength: 2000 }), (seed, inputs) => {
          let state = initGame(seed, MIXED_DECK);
          const total = countTotalCards(state);

          for (const input of inputs) {
            const result = stepGame(state, input, CARD_CATALOG);
            state = result.state;

            expect(state.deck.hand.length).toBe(HAND_SIZE);
            expect(countTotalCards(state)).toBe(total);
            expect(state.combat.player.health).toBeGreaterThanOrEqual(0);
            expect(state.combat.player.health).toBeLessThanOrEqual(PLAYER_MAX_HEALTH);
            expect(state.combat.player.mana).toBeGreaterThanOrEqual(0);
            expect(state.combat.player.mana).toBeLessThanOrEqual(PLAYER_MAX_MANA + 1e-9);
            expect(state.combat.enemy.health).toBeGreaterThanOrEqual(0);
            expect(state.combat.enemy.health).toBeLessThanOrEqual(ENEMY_MAX_HEALTH);
          }
        }),
        { numRuns: 20 },
      );
    },
    30_000,
  );
});
