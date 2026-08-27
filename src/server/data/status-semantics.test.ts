/**
 * The status taxonomy (spec 240).
 *
 * Two kinds of assertion, and the second is the one that keeps the table
 * honest over time.
 *
 * **Coverage.** Every id the game can produce is classified, including the
 * dynamic families, so "unclassified" stays a bug rather than becoming the
 * quiet default half the table falls into.
 *
 * **Consistency.** The table has to agree with the three others that already
 * describe the same statuses from different angles -- `data/status-visuals.ts`
 * says which way a status cuts for the *player*, `data/damage-over-time.ts`
 * says which ones pulse, and `data/aura-fields.ts` says which are fields. A
 * disagreement between any two of them is a status that means one thing to the
 * sim and another to the interface, which is precisely the class of fault this
 * spec exists to close.
 */

import { describe, expect, it } from 'vitest';
import { ALL_AURA_FIELDS } from './aura-fields.js';
import { ALL_DOTS } from './damage-over-time.js';
import { STATUS_VISUALS } from './status-visuals.js';
import {
  afflictionsOn,
  hasAffliction,
  hasTag,
  isAffliction,
  STATUS_PREFIX_SEMANTICS,
  STATUS_SEMANTICS,
  StatusTag,
  tagsOf,
} from './status-semantics.js';
import { adaptedKey, applyStatus, StatusId, type Statuses } from '../sim/statuses.js';
import { assistKey, farmKey } from '../sim/restoration.js';

const TICK = 100;
const LIVE = 500;

/** A status map with these ids live at {@link TICK}. */
function carrying(...ids: readonly string[]): Statuses {
  let statuses: Statuses = {};
  for (const id of ids) statuses = applyStatus(statuses, id, TICK, LIVE);
  return statuses;
}

describe('coverage (spec 240)', () => {
  it('classifies every well-known status id', () => {
    // `StatusId` is the closed half of the vocabulary, so this is exhaustive
    // for it: a status added there and forgotten here fails, rather than
    // becoming silently unclassified.
    const missing = Object.values(StatusId).filter((id) => tagsOf(id).length === 0);
    expect(missing).toEqual([]);
  });

  it('classifies every dynamic family', () => {
    // The ids built at runtime, through the functions that build them rather
    // than through a literal, so renaming a prefix fails here too.
    expect(tagsOf(adaptedKey('melee.slash'))).not.toEqual([]);
    expect(tagsOf(assistKey(7))).not.toEqual([]);
    expect(farmKey).toBeTypeOf('function');
  });

  it('gives every row at least one tag and no duplicates', () => {
    for (const row of STATUS_SEMANTICS) {
      expect(row.tags.length, row.id).toBeGreaterThan(0);
      expect(new Set(row.tags).size, row.id).toBe(row.tags.length);
    }
    for (const family of STATUS_PREFIX_SEMANTICS) {
      expect(family.tags.length, family.prefix).toBeGreaterThan(0);
    }
  });

  it('names each id once', () => {
    const ids = STATUS_SEMANTICS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('answers nothing for an id nobody has classified', () => {
    // The safe default, asserted rather than assumed: the failure mode of a
    // forgotten row is a mechanic that does not fire, never one that fires on
    // everything.
    expect(tagsOf('some.status.nobody.wrote')).toEqual([]);
    expect(isAffliction('some.status.nobody.wrote')).toBe(false);
  });
});

describe('the tags are internally coherent (spec 240)', () => {
  it('makes every affliction harmful', () => {
    for (const row of STATUS_SEMANTICS) {
      if (!row.tags.includes(StatusTag.Affliction)) continue;
      expect(row.tags, row.id).toContain(StatusTag.Harmful);
    }
  });

  it('makes every damage-over-time an affliction', () => {
    for (const row of STATUS_SEMANTICS) {
      if (!row.tags.includes(StatusTag.DamageOverTime)) continue;
      expect(row.tags, row.id).toContain(StatusTag.Affliction);
    }
  });

  it('never calls one status both beneficial and harmful', () => {
    for (const row of STATUS_SEMANTICS) {
      const both =
        row.tags.includes(StatusTag.Beneficial) && row.tags.includes(StatusTag.Harmful);
      expect(both, row.id).toBe(false);
    }
  });

  it('keeps bookkeeping out of every other category', () => {
    // The whole point of the tag: an internal timer is not a condition, whichever
    // way it would cut if it were one.
    for (const row of STATUS_SEMANTICS) {
      if (!row.tags.includes(StatusTag.Bookkeeping)) continue;
      expect(row.tags, row.id).toEqual([StatusTag.Bookkeeping]);
    }
  });
});

describe('the tags agree with the tables beside them (spec 240)', () => {
  it('tags every row of the affliction table as a damage-over-time', () => {
    // The check that stops the two drifting: an affliction added to
    // `data/damage-over-time.ts` and not classified here would be one Catalysis
    // could not see.
    for (const dot of ALL_DOTS) {
      expect(hasTag(dot.id, StatusTag.DamageOverTime), dot.id).toBe(true);
    }
  });

  it('tags every field as beneficial to the body carrying it', () => {
    // A field is a boon its carrier wears; what it lays on everyone else is the
    // affliction its row names, tagged where that affliction is.
    for (const field of ALL_AURA_FIELDS) {
      expect(hasTag(field.id, StatusTag.Beneficial), field.id).toBe(true);
    }
  });

  it('agrees with what the player is shown about which way a status cuts', () => {
    // `StatusVisual.kind` is presentation and nothing in the sim reads it, so
    // the two could drift silently. A mark drawn as a boon that the sim treats
    // as harmful is a fight nobody can read.
    for (const visual of STATUS_VISUALS) {
      const tags = tagsOf(visual.id);
      if (tags.length === 0) continue;
      const want = visual.kind === 'boon' ? StatusTag.Beneficial : StatusTag.Harmful;
      expect(tags, `${visual.id} is drawn as a ${visual.kind}`).toContain(want);
    }
  });
});

describe('what counts as an affliction (spec 240)', () => {
  it('counts a real one', () => {
    expect(hasAffliction(carrying(StatusId.Poison), TICK)).toBe(true);
    expect(hasAffliction(carrying(StatusId.Sundered), TICK)).toBe(true);
    expect(hasAffliction(carrying(StatusId.Slowed), TICK)).toBe(true);
  });

  it('does not count the sim’s own timers', () => {
    // The two that made Catalysis unconditional, and the two inverted marks
    // beside them.
    expect(hasAffliction(carrying(StatusId.RecentlyHit), TICK)).toBe(false);
    expect(hasAffliction(carrying(StatusId.InCombat), TICK)).toBe(false);
    expect(hasAffliction(carrying(StatusId.SecondWindSpent), TICK)).toBe(false);
    expect(hasAffliction(carrying(StatusId.PerfectExitSpent), TICK)).toBe(false);
    expect(hasAffliction(carrying(StatusId.ExposedBounty), TICK)).toBe(false);
    expect(hasAffliction(carrying(assistKey(3)), TICK)).toBe(false);
  });

  it('does not count a boon', () => {
    expect(hasAffliction(carrying(StatusId.Flow), TICK)).toBe(false);
    expect(hasAffliction(carrying(StatusId.Attuned), TICK)).toBe(false);
    expect(hasAffliction(carrying(StatusId.ScorchedEarth), TICK)).toBe(false);
    expect(hasAffliction(carrying(adaptedKey('melee.slash')), TICK)).toBe(false);
  });

  it('does not count an opening', () => {
    // Vulnerable and Exposed are harmful and are not afflictions: one is a fact
    // about what the target just did and the other is a read somebody took. The
    // design call is recorded here as much as in the table.
    expect(hasAffliction(carrying(StatusId.Vulnerable), TICK)).toBe(false);
    expect(hasAffliction(carrying(StatusId.Exposed), TICK)).toBe(false);
    expect(hasTag(StatusId.Vulnerable, StatusTag.Harmful)).toBe(true);
    expect(hasTag(StatusId.Exposed, StatusTag.Harmful)).toBe(true);
  });

  it('finds the affliction in a body carrying a pile of bookkeeping', () => {
    // The realistic case: a body mid-fight carries both timers, an assist mark
    // and one real affliction.
    const busy = carrying(
      StatusId.RecentlyHit,
      StatusId.InCombat,
      assistKey(9),
      StatusId.Flow,
      StatusId.Burn,
    );
    expect(hasAffliction(busy, TICK)).toBe(true);
    expect(afflictionsOn(busy, TICK)).toEqual([StatusId.Burn]);
  });

  it('refuses an expired affliction', () => {
    // Live entries only, through the same `statusOf` everything else reads
    // with: a stale entry can no more feed Catalysis than it can feed anything.
    const stale = carrying(StatusId.Poison);
    expect(hasAffliction(stale, TICK + LIVE)).toBe(false);
    expect(afflictionsOn(stale, TICK + LIVE)).toEqual([]);
  });
});
