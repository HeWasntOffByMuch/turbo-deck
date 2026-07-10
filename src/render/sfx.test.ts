import { describe, expect, it } from 'vitest';
import { CARD_CATALOG } from '../cards/catalog.js';
import type { GameEvent } from '../game/session.js';
import type { ComboEvent } from '../game/combo-session.js';
import { SUITS, type PlayingCard } from '../cards/standard.js';
import { POKER_ORDER } from '../cards/poker.js';
import { SFX, sfxForComboEvent, sfxForEvent } from './sfx.js';

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

describe('gameOver "death song"', () => {
  const segments = SFX.gameOver?.segments ?? [];
  const pitched = segments.filter((s) => s.wave !== 'noise');
  // The short lead phrase (the descending line) vs. the sustained tonic it lands on.
  const HELD = 0.5;
  const lead = pitched.filter((s) => s.duration < HELD).sort((a, b) => (a.delay ?? 0) - (b.delay ?? 0));
  const held = pitched.filter((s) => s.duration >= HELD);

  it('is built from discrete steady pitches, not formless glides', () => {
    // Every note holds a single pitch (start === end) so the ear can anticipate
    // and land on it — a glide (start !== end) would be the unsatisfying siren.
    expect(pitched.length).toBeGreaterThan(0);
    for (const seg of pitched) {
      expect(seg.startFreq, 'a death-song note glides instead of holding a pitch').toBe(seg.endFreq);
    }
  });

  it('descends step by step, then resolves onto a held low tonic', () => {
    expect(lead.length).toBeGreaterThanOrEqual(3);
    let prev = Infinity;
    for (const note of lead) {
      expect(note.startFreq, 'death song should step strictly downward').toBeLessThan(prev);
      prev = note.startFreq;
    }
    // The sustained resolution sits at or below the lowest note of the descent.
    const lowestLead = Math.min(...lead.map((s) => s.startFreq));
    expect(held.length).toBeGreaterThan(0);
    for (const note of held) {
      expect(note.startFreq, 'the held resolution should not sit above the descent').toBeLessThanOrEqual(lowestLead);
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

describe('sfxForComboEvent routing (spec 014 prototype)', () => {
  const card = (suit: PlayingCard['suit']): PlayingCard => ({ instanceId: 1, suit, rank: 7 });

  it('voices a card play by suit, and every suit maps to a real SFX', () => {
    for (const suit of SUITS) {
      const id = sfxForComboEvent({ kind: 'cardPlayed', index: 0, card: card(suit) });
      expect(id, `no sfx for suit ${suit}`).toBeDefined();
      expect(id !== undefined && SFX[id], `sfx '${id}' missing`).toBeDefined();
    }
  });

  it('voices every poker-stance activation with its own real SFX', () => {
    for (const category of POKER_ORDER) {
      const id = sfxForComboEvent({ kind: 'activated', category, strength: POKER_ORDER.indexOf(category) });
      expect(id, `no sfx for combo ${category}`).toBeDefined();
      expect(id !== undefined && SFX[id], `sfx '${id}' missing for ${category}`).toBeDefined();
    }
  });

  it('defers shared combat events to the common routing', () => {
    const events: ComboEvent[] = [
      { kind: 'enemyHit', damage: 10, tick: 1, enemyId: 1, at: { x: 0, y: 0 } },
      { kind: 'playerHit', damage: 5, tick: 1 },
      { kind: 'perfectDefense', defenseType: 'parry', tick: 1 },
      { kind: 'enemyDefeated', tick: 1, enemyId: 1, enemyType: 'Brawler' },
      { kind: 'playerDefeated', tick: 1 },
    ];
    for (const event of events) {
      const id = sfxForComboEvent(event);
      expect(id, `no sfx for ${event.kind}`).toBeDefined();
      expect(id !== undefined && SFX[id]).toBeDefined();
    }
  });

  it('stays silent for ignored-input events', () => {
    expect(sfxForComboEvent({ kind: 'playIgnoredEmptySlot' })).toBeUndefined();
    expect(sfxForComboEvent({ kind: 'activateIgnoredLocked' })).toBeUndefined();
  });
});
