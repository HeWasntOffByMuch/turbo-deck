import type { Catalog, DeckState, SynergyDef } from './types.js';

/**
 * A synergy is active when, for every distinct tag in its requiredTags
 * multiset, at least that many hand cards carry the tag. Pure function of
 * (hand, defs, catalog) -- adding a card or synergy is a data-only change.
 */
export function getActiveSynergies(
  hand: DeckState['hand'],
  synergyDefs: readonly SynergyDef[],
  catalog: Catalog,
): SynergyDef[] {
  const tagCounts = new Map<string, number>();
  for (const card of hand) {
    if (!card) continue;
    const def = catalog.get(card.defId);
    if (!def) continue;
    for (const tag of new Set(def.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  return synergyDefs.filter((synergy) => {
    const required = new Map<string, number>();
    for (const tag of synergy.requiredTags) {
      required.set(tag, (required.get(tag) ?? 0) + 1);
    }
    for (const [tag, count] of required) {
      if ((tagCounts.get(tag) ?? 0) < count) return false;
    }
    return true;
  });
}
