/**
 * Which bodies get eased, and how fast we believe they turn (spec 142).
 *
 * The interesting cases are the ones that must *not* be eased -- a projectile's
 * facing is its path, and easing it draws the nose off the curve on the frame it
 * spawns.
 */

import { describe, expect, it } from 'vitest';
import { REMOTE_PLAYER_TURN_RATE, turnLimitsFor } from './turn-limits.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { MONSTERS } from '../../../server/data/monsters.js';
import { CHARACTERS } from '../../../sim/characters.js';

const TICK = 60;

function entity(kind: number, typeId = 'grazer'): { kind: number; typeId: string } {
  return { kind, typeId };
}

describe('turnLimitsFor', () => {
  it('eases our own body at the rate the wire says we turn', () => {
    const limits = turnLimitsFor(entity(EntityKind.Player, 'self'), true, 612, TICK);
    expect(limits).toEqual({ degreesPerSecond: 612, tickRate: TICK });
  });

  it('does not ease our body before its stats have arrived', () => {
    expect(turnLimitsFor(entity(EntityKind.Player, 'self'), true, null, TICK)).toBeNull();
  });

  it('eases a monster at its own table rate', () => {
    for (const monster of MONSTERS.values()) {
      const limits = turnLimitsFor(entity(EntityKind.Monster, monster.id), false, 540, TICK);
      expect(limits).toEqual({ degreesPerSecond: monster.stats.turnRate, tickRate: TICK });
    }
    // And the rates really do differ between monsters, so this is reading the
    // table rather than a constant that happens to match one row.
    const rates = new Set([...MONSTERS.values()].map((monster) => monster.stats.turnRate));
    expect(rates.size).toBeGreaterThan(1);
  });

  it('leaves a monster it has never heard of alone rather than guessing', () => {
    expect(turnLimitsFor(entity(EntityKind.Monster, 'not-a-monster'), false, 540, TICK)).toBeNull();
  });

  it('eases a remote player at a rate no character is faster than at base', () => {
    const limits = turnLimitsFor(entity(EntityKind.Player, 'someone'), false, 540, TICK);
    expect(limits).toEqual({ degreesPerSecond: REMOTE_PLAYER_TURN_RATE, tickRate: TICK });
    for (const character of CHARACTERS) {
      expect(REMOTE_PLAYER_TURN_RATE).toBeGreaterThanOrEqual(character.turnRate);
    }
  });

  it('never eases a projectile, whose facing is its path', () => {
    expect(turnLimitsFor(entity(EntityKind.Projectile, 'arrow'), false, 540, TICK)).toBeNull();
    // Including one that somehow arrives flagged as ours.
    expect(turnLimitsFor(entity(EntityKind.Projectile, 'arrow'), true, 540, TICK)).toBeNull();
  });

  it('never eases a prop, which does not turn', () => {
    expect(turnLimitsFor(entity(EntityKind.Prop, 'rock'), false, 540, TICK)).toBeNull();
  });

  it('leaves a kind it has never heard of alone', () => {
    expect(turnLimitsFor(entity(99, 'whatever'), false, 540, TICK)).toBeNull();
  });
});
