import { describe, expect, it } from 'vitest';
import { actionVerb, cardAction, handStance } from './stance.js';
import type { PlayingCard, Rank, Suit } from './standard.js';

let nextId = 0;
function card(suit: Suit, rank: Rank): PlayingCard {
  return { instanceId: nextId++, suit, rank };
}
function flush(suit: Suit, ranks: readonly Rank[]): PlayingCard[] {
  return ranks.map((r) => card(suit, r));
}

describe('cardAction', () => {
  it('maps each suit to its effect, scaling magnitude with rank', () => {
    expect(cardAction(card('clubs', 14)).kind).toBe('damage');
    expect(cardAction(card('hearts', 14)).kind).toBe('heal');
    expect(cardAction(card('spades', 14)).kind).toBe('guard');
    expect(cardAction(card('diamonds', 14)).kind).toBe('slow');

    const low = cardAction(card('clubs', 2));
    const high = cardAction(card('clubs', 14));
    if (low.kind !== 'damage' || high.kind !== 'damage') throw new Error('expected damage');
    expect(high.amount).toBeGreaterThan(low.amount);

    // A stronger diamond slows harder -> a smaller multiplier.
    const slowLow = cardAction(card('diamonds', 2));
    const slowHigh = cardAction(card('diamonds', 14));
    if (slowLow.kind !== 'slow' || slowHigh.kind !== 'slow') throw new Error('expected slow');
    expect(slowHigh.multiplier).toBeLessThan(slowLow.multiplier);
  });

  it('labels the action verb per suit', () => {
    expect(actionVerb('clubs')).toBe('Damage');
    expect(actionVerb('diamonds')).toBe('Slow');
  });
});

describe('handStance', () => {
  it('a flush pours the whole bonus into its one matching stat', () => {
    const clubsStance = handStance(flush('clubs', [2, 5, 8, 11, 13]));
    expect(clubsStance.attackBonus).toBeGreaterThan(0);
    expect(clubsStance.reductionPct).toBe(0);
    expect(clubsStance.regenPerSecond).toBe(0);
    expect(clubsStance.slowMultiplier).toBe(1);

    const spadesStance = handStance(flush('spades', [2, 5, 8, 11, 13]));
    expect(spadesStance.reductionPct).toBeGreaterThan(0);
    expect(spadesStance.attackBonus).toBe(0);

    const diamondsStance = handStance(flush('diamonds', [2, 5, 8, 11, 13]));
    expect(diamondsStance.slowMultiplier).toBeLessThan(1);
    expect(diamondsStance.regenPerSecond).toBe(0);
  });

  it('a stronger poker hand never yields a smaller bonus for the same suit mix', () => {
    // Both all-clubs (identical suit composition), but one is a plain flush and
    // the other a straight flush -- higher strength must not weaken the stat.
    const plainFlush = handStance(flush('clubs', [2, 5, 8, 11, 13]));
    const straightFlush = handStance(flush('clubs', [5, 6, 7, 8, 9]));
    expect(straightFlush.attackBonus).toBeGreaterThan(plainFlush.attackBonus);
    expect(straightFlush.durationSeconds).toBeGreaterThan(plainFlush.durationSeconds);
    expect(straightFlush.lockoutSeconds).toBeGreaterThan(straightFlush.durationSeconds);
  });

  it('blends stats for a mixed hand by suit share', () => {
    // 3 clubs, 2 hearts -> mostly attack, some regen, nothing else.
    const stance = handStance([card('clubs', 9), card('clubs', 9), card('clubs', 4), card('hearts', 5), card('hearts', 7)]);
    expect(stance.attackBonus).toBeGreaterThan(0);
    expect(stance.regenPerSecond).toBeGreaterThan(0);
    expect(stance.reductionPct).toBe(0);
    expect(stance.slowMultiplier).toBe(1);
  });
});
