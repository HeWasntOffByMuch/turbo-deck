import { describe, expect, it } from 'vitest';
import { CARD_CATALOG, SYNERGY_DEFS } from './catalog.js';
import { getActiveSynergies } from './synergy.js';
import type { CardInstance, DeckState } from './types.js';

function hand(...defIds: (string | null)[]): DeckState['hand'] {
  const cards = defIds.map((defId, i): CardInstance | null => (defId === null ? null : { instanceId: i, defId }));
  return [cards[0] ?? null, cards[1] ?? null, cards[2] ?? null];
}

describe('getActiveSynergies', () => {
  it('is inactive with no matching tags', () => {
    const active = getActiveSynergies(hand('guardbreak', null, null), SYNERGY_DEFS, CARD_CATALOG);
    expect(active).toEqual([]);
  });

  it('activates a two-of-tag synergy once both cards are present, regardless of order', () => {
    const handA = hand('fireball', 'emberlash', null);
    const handB = hand('emberlash', 'fireball', null);
    expect(getActiveSynergies(handA, SYNERGY_DEFS, CARD_CATALOG).map((s) => s.id)).toContain('inferno');
    expect(getActiveSynergies(handB, SYNERGY_DEFS, CARD_CATALOG).map((s) => s.id)).toContain('inferno');
  });

  it('does not activate a two-of-tag synergy with only one matching card', () => {
    const active = getActiveSynergies(hand('fireball', 'guardbreak', null), SYNERGY_DEFS, CARD_CATALOG);
    expect(active.map((s) => s.id)).not.toContain('inferno');
  });

  it('activates a mixed-tag synergy from two different cards', () => {
    const active = getActiveSynergies(hand('fireball', 'iceshard', null), SYNERGY_DEFS, CARD_CATALOG);
    expect(active.map((s) => s.id)).toContain('elemental-overload');
  });

  it('can have multiple synergies active at once', () => {
    const active = getActiveSynergies(hand('fireball', 'emberlash', 'iceshard'), SYNERGY_DEFS, CARD_CATALOG);
    const ids = active.map((s) => s.id);
    expect(ids).toContain('inferno');
    expect(ids).toContain('elemental-overload');
    expect(ids).not.toContain('permafrost');
  });
});
