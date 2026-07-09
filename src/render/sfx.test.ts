import { describe, expect, it } from 'vitest';
import { CARD_CATALOG } from '../cards/catalog.js';
import type { GameEvent } from '../game/session.js';
import { SFX, sfxForEvent } from './sfx.js';

describe('SFX library', () => {
  it('gives every spec at least one segment with positive duration and gain', () => {
    for (const [id, spec] of Object.entries(SFX)) {
      expect(spec.segments.length, `${id} has no segments`).toBeGreaterThan(0);
      for (const seg of spec.segments) {
        expect(seg.duration, `${id} segment duration`).toBeGreaterThan(0);
        expect(seg.gain, `${id} segment gain`).toBeGreaterThan(0);
        expect(seg.gain).toBeLessThanOrEqual(1);
        if (seg.delay !== undefined) expect(seg.delay).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('sfxForEvent routing', () => {
  const at = { x: 0, y: 0 };
  const attackEvents: GameEvent[] = [
    { kind: 'enemyHit', damage: 10, tick: 1, enemyId: 1, at },
    { kind: 'attackMissed', tick: 1 },
    { kind: 'cardPlayed', handIndex: 0, defId: 'fireball' },
    { kind: 'bonusCardPlayed', defId: 'iceshard' },
    { kind: 'perfectDefense', defenseType: 'parry', tick: 1 },
    { kind: 'normalDefense', defenseType: 'dodge', tick: 1 },
    { kind: 'playerHit', damage: 5, tick: 1 },
    { kind: 'playerHealed', amount: 30, tick: 1 },
    { kind: 'enemyDefeated', tick: 1, enemyId: 1, enemyType: 'Brawler' },
    { kind: 'playerDefeated', tick: 1 },
    { kind: 'bonusCardDrawn' },
    { kind: 'passiveRetired', defId: 'sharpen' },
  ];

  it('routes every combat/attack event to a real SFX', () => {
    for (const event of attackEvents) {
      const id = sfxForEvent(event);
      expect(id, `no sfx for ${event.kind}`).toBeDefined();
      expect(id !== undefined && SFX[id], `sfx '${id}' missing from library`).toBeDefined();
    }
  });

  it('gives each active card a sound when played', () => {
    for (const def of CARD_CATALOG.values()) {
      if (def.kind !== 'active') continue;
      const id = sfxForEvent({ kind: 'cardPlayed', handIndex: 0, defId: def.id });
      expect(id, `no sfx for active ${def.id}`).toBeDefined();
      expect(id !== undefined && SFX[id]).toBeDefined();
    }
  });

  it('stays silent for purely cosmetic events', () => {
    expect(sfxForEvent({ kind: 'playCardIgnoredEmptySlot' })).toBeUndefined();
    expect(sfxForEvent({ kind: 'enemyAttackAvoided', tick: 1 })).toBeUndefined();
    expect(sfxForEvent({ kind: 'effectRejectedInsufficientMana', tick: 1 })).toBeUndefined();
  });
});
