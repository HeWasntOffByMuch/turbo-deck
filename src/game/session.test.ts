import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CARD_CATALOG, SYNERGY_DEFS } from '../cards/catalog.js';
import { HAND_SIZE } from '../cards/types.js';
import { ENEMY_IDLE_TICKS, ENEMY_MAX_HEALTH, ENEMY_WINDUP_TICKS, PLAYER_MAX_HEALTH, PLAYER_MAX_MANA } from '../sim/constants.js';
import { NEUTRAL_INPUT } from '../sim/types.js';
import { initGame, stepGame, type GameInput, type GameState } from './session.js';

const DEF_IDS = ['fireball', 'emberlash', 'iceshard', 'frostbite', 'guardbreak', 'manasurge', 'fireball', 'iceshard'];

const NEUTRAL_GAME_INPUT: GameInput = NEUTRAL_INPUT;

function countTotalCards(state: GameState): number {
  return (
    state.deck.drawPile.length +
    state.deck.discardPile.length +
    state.deck.hand.filter((c) => c !== null).length +
    (state.deck.bonusSlot ? 1 : 0)
  );
}

describe('stepGame', () => {
  it('playing a damage card reduces enemy health and spends mana', () => {
    let state = initGame(1, DEF_IDS);
    // Find a hand index holding a damage-effect card.
    const handIndex = state.deck.hand.findIndex((card) => {
      if (!card) return false;
      const def = CARD_CATALOG.get(card.defId);
      return def?.effect.kind === 'damage';
    });
    expect(handIndex).toBeGreaterThanOrEqual(0);
    const card = state.deck.hand[handIndex];
    if (!card) throw new Error('expected a card');
    const def = CARD_CATALOG.get(card.defId);
    if (!def) throw new Error('expected a def');

    const before = state;
    const result = stepGame(state, { ...NEUTRAL_GAME_INPUT, playHandIndex: handIndex as 0 | 1 | 2 }, CARD_CATALOG, SYNERGY_DEFS);
    state = result.state;

    expect(state.combat.enemy.health).toBeLessThanOrEqual(ENEMY_MAX_HEALTH - (def.effect as { amount: number }).amount);
    expect(state.combat.player.mana).toBeLessThan(before.combat.player.mana + 0.001);
    expect(result.events.some((e) => e.kind === 'cardPlayed')).toBe(true);
    // The used slot must have refilled or gone empty -- never left stale.
    expect(state.deck.hand.length).toBe(HAND_SIZE);
  });

  it('playing an empty hand slot is a no-op aside from the event', () => {
    const state = initGame(1, ['only-one']);
    // Slots 1 and 2 are empty with only one card in the deck.
    const result = stepGame(state, { ...NEUTRAL_GAME_INPUT, playHandIndex: 1 }, CARD_CATALOG, SYNERGY_DEFS);
    expect(result.events).toContainEqual({ kind: 'playCardIgnoredEmptySlot' });
    expect(result.state.deck.hand).toEqual(state.deck.hand);
    expect(result.state.combat.player.health).toBe(state.combat.player.health);
  });

  it('playing the bonus slot when nothing is pending is a no-op', () => {
    const state = initGame(1, DEF_IDS);
    expect(state.deck.bonusSlot).toBeNull();
    const result = stepGame(state, { ...NEUTRAL_GAME_INPUT, playBonusCard: true }, CARD_CATALOG, SYNERGY_DEFS);
    expect(result.state.deck.bonusSlot).toBeNull();
    expect(result.state.combat.enemy.health).toBe(state.combat.enemy.health);
  });

  it('a perfect defense always leaves the bonus slot occupied', () => {
    let state = initGame(5, DEF_IDS);
    expect(state.deck.bonusSlot).toBeNull();

    // The dummy enemy's first attack resolves at a fixed tick (idle + windup);
    // pressing parry exactly then is guaranteed to register as perfect.
    const hitTick = ENEMY_IDLE_TICKS + ENEMY_WINDUP_TICKS;
    let perfectEvents: unknown[] = [];
    for (let tick = 1; tick <= hitTick; tick++) {
      const input: GameInput = tick === hitTick ? { ...NEUTRAL_GAME_INPUT, parry: true } : NEUTRAL_GAME_INPUT;
      const result = stepGame(state, input, CARD_CATALOG, SYNERGY_DEFS);
      state = result.state;
      if (tick === hitTick) perfectEvents = result.events.filter((e) => e.kind === 'perfectDefense');
    }

    expect(perfectEvents).toHaveLength(1);
    expect(state.deck.bonusSlot).not.toBeNull();
  });
});

describe('fuzz smoke test', () => {
  // Runs 20 * 2000 = 40,000 sim ticks; comfortably under a second locally but
  // slow enough on a loaded CI runner to flake against Vitest's 5s default.
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
          let state = initGame(seed, DEF_IDS);
          const total = countTotalCards(state);

          for (const input of inputs) {
            const result = stepGame(state, input, CARD_CATALOG, SYNERGY_DEFS);
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
