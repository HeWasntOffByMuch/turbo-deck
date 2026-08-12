/**
 * The progression tables, checked as tables (spec 147).
 *
 * These are the assertions that make the *design* reviewable rather than just
 * the code. The brief's rules -- every attribute viable, every pair interesting,
 * six skills each, nothing a passive immunity -- are claims about content, and a
 * claim about content that is only checked by a human reading it is a claim that
 * rots the first time somebody adds a row.
 *
 * So: fifteen pairs or CI fails. Thirty-six skills or CI fails. A trait added to
 * the interface and forgotten in the wire order, or in the modifier sum, or CI
 * fails.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readdirDeep(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? readdirDeep(path) : [path];
  });
}
import {
  ATTRIBUTES,
  ATTRIBUTE_KEYS,
  attributeByOrdinal,
  ordinalOfAttribute,
  type AttributeKey,
} from './attributes.js';
import { ALL_MILESTONES, metMilestones, milestonesFor, nextMilestone } from './milestones.js';
import {
  emptyTraitTotals,
  scaleModifier,
  sumModifiers,
  type TraitModifier,
} from './modifiers.js';
import { MILESTONE_THRESHOLDS, SCALING, STAT_SKILL_THRESHOLDS, SYNERGY_THRESHOLD } from './scaling.js';
import { ALL_STAT_SKILLS, statSkillsFor } from './stat-skills.js';
import { ALL_SYNERGIES, allAttributePairs, metSynergies, synergyForPair } from './synergies.js';
import { BASE_STAT_KEYS, TRAIT_WIRE_ORDER } from '../state/types.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';

const ALL_AT = (value: number): Record<AttributeKey, number> =>
  Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [key, value])) as Record<AttributeKey, number>;

describe('the six attributes', () => {
  it('is exactly six, and matches the persisted record key for key', () => {
    expect(ATTRIBUTE_KEYS).toHaveLength(6);
    expect([...ATTRIBUTE_KEYS].sort()).toEqual([...BASE_STAT_KEYS].sort());
  });

  it('agrees with BASE_STAT_KEYS on order, which is the wire ordinal', () => {
    // Not a style point. `AllocateAttribute` names an attribute by its index
    // here, and `writeAttributes` writes six varuints in this order, so the two
    // arrays disagreeing would silently put points in the wrong stat.
    expect([...ATTRIBUTE_KEYS]).toEqual([...BASE_STAT_KEYS]);
    for (const [index, key] of ATTRIBUTE_KEYS.entries()) {
      expect(attributeByOrdinal(index)?.key).toBe(key);
      expect(ordinalOfAttribute(key)).toBe(index);
    }
  });

  it('refuses an ordinal off either end rather than wrapping', () => {
    expect(attributeByOrdinal(-1)).toBeNull();
    expect(attributeByOrdinal(6)).toBeNull();
    expect(attributeByOrdinal(1.5)).toBeNull();
    expect(attributeByOrdinal(Number.NaN)).toBeNull();
  });

  it('gives every attribute a distinct route to staying alive', () => {
    // The rule that stops Constitution being a tax: six routes, six different
    // sentences. Two attributes surviving the same way would mean one of them
    // is the other one's prerequisite.
    const routes = ATTRIBUTES.map((a) => a.sustain);
    expect(new Set(routes).size).toBe(6);
    for (const route of routes) expect(route.length).toBeGreaterThan(20);
  });

  it('never has two attributes claiming to own the same mechanic', () => {
    const owned = new Map<string, string>();
    for (const attribute of ATTRIBUTES) {
      for (const mechanic of attribute.owns) {
        expect(owned.get(mechanic), `${mechanic} claimed twice`).toBeUndefined();
        owned.set(mechanic, attribute.key);
      }
    }
  });
});

describe('milestones', () => {
  it('gives every attribute one at each threshold', () => {
    expect(ALL_MILESTONES).toHaveLength(ATTRIBUTE_KEYS.length * MILESTONE_THRESHOLDS.length);
    for (const key of ATTRIBUTE_KEYS) {
      expect(milestonesFor(key).map((m) => m.threshold)).toEqual([...MILESTONE_THRESHOLDS]);
    }
  });

  it('activates at exactly its threshold and not one point below', () => {
    for (const milestone of ALL_MILESTONES) {
      const at = { ...ALL_AT(0), [milestone.attribute]: milestone.threshold };
      const below = { ...ALL_AT(0), [milestone.attribute]: milestone.threshold - 1 };
      expect(metMilestones(at).map((m) => m.id)).toContain(milestone.id);
      expect(metMilestones(below).map((m) => m.id)).not.toContain(milestone.id);
    }
  });

  it('never grants an attribute, which is what keeps the graph one hop', () => {
    // `resolveProgression` settles the attributes before any milestone grant
    // exists, so a milestone granting one would be a grant that silently does
    // nothing -- worse than a cycle, because it would look like it worked.
    for (const milestone of ALL_MILESTONES) {
      for (const key of ATTRIBUTE_KEYS) {
        expect(milestone.grants[key], `${milestone.id} grants ${key}`).toBeUndefined();
      }
    }
  });

  it('says what changes, in a sentence, for every one of them', () => {
    for (const milestone of ALL_MILESTONES) {
      expect(milestone.effect.length, milestone.id).toBeGreaterThan(30);
      expect(milestone.name.length, milestone.id).toBeGreaterThan(3);
    }
  });

  it('walks the next one up as an attribute climbs, then runs out', () => {
    expect(nextMilestone('strength', 0)?.threshold).toBe(MILESTONE_THRESHOLDS[0]);
    expect(nextMilestone('strength', MILESTONE_THRESHOLDS[0] ?? 0)?.threshold).toBe(
      MILESTONE_THRESHOLDS[1],
    );
    expect(nextMilestone('strength', 999)).toBeNull();
  });
});

describe('the fifteen pairs', () => {
  it('has an entry for every unordered pair, and no more', () => {
    // The brief's rule, as a test. A pair with no row fails here rather than
    // being discovered later as a combination nobody thought about.
    const pairs = allAttributePairs();
    expect(pairs).toHaveLength(15);
    expect(ALL_SYNERGIES).toHaveLength(15);
    for (const [a, b] of pairs) {
      expect(synergyForPair(a, b), `${a}+${b}`).not.toBeNull();
      // Order-insensitive, because a player does not think in a canonical order.
      expect(synergyForPair(b, a)?.id).toBe(synergyForPair(a, b)?.id);
    }
  });

  it('never pairs an attribute with itself, and never repeats a pair', () => {
    const seen = new Set<string>();
    for (const synergy of ALL_SYNERGIES) {
      expect(synergy.a).not.toBe(synergy.b);
      const key = [synergy.a, synergy.b].sort().join('+');
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('needs both halves, and turns on at exactly the threshold', () => {
    for (const synergy of ALL_SYNERGIES) {
      const onlyA = { ...ALL_AT(0), [synergy.a]: 99 };
      const both = { ...ALL_AT(0), [synergy.a]: SYNERGY_THRESHOLD, [synergy.b]: SYNERGY_THRESHOLD };
      const nearly = { ...both, [synergy.b]: SYNERGY_THRESHOLD - 1 };
      expect(metSynergies(onlyA).map((s) => s.id)).not.toContain(synergy.id);
      expect(metSynergies(nearly).map((s) => s.id)).not.toContain(synergy.id);
      expect(metSynergies(both).map((s) => s.id)).toContain(synergy.id);
    }
  });

  it('sits below the second milestone, so a pair adds to two identities', () => {
    // Ordering that matters to the design: reaching a pair means both halves
    // already crossed their first milestone, so a synergy is never a substitute
    // for having an identity.
    expect(SYNERGY_THRESHOLD).toBeGreaterThan(MILESTONE_THRESHOLDS[0] ?? 0);
    expect(SYNERGY_THRESHOLD).toBeLessThan(MILESTONE_THRESHOLDS[1] ?? 0);
  });

  it('grants a trigger or an eligibility change, never a bare attribute', () => {
    for (const synergy of ALL_SYNERGIES) {
      for (const key of ATTRIBUTE_KEYS) {
        expect(synergy.grants[key], `${synergy.id} grants ${key}`).toBeUndefined();
      }
      // Everything a pair does goes through the trait bundle. A pair that
      // granted `attackDamagePct` would be exactly the "+X% because both are
      // high" the brief forbids, and this is where that would be caught.
      expect(Object.keys(synergy.grants), synergy.id).toEqual(['traits']);
      expect(Object.keys(synergy.grants.traits ?? {}).length, synergy.id).toBeGreaterThan(0);
    }
  });

  it('records why each is a mechanic rather than a multiplier', () => {
    for (const synergy of ALL_SYNERGIES) {
      expect(synergy.effect.length, synergy.id).toBeGreaterThan(30);
      expect(synergy.why.length, synergy.id).toBeGreaterThan(40);
    }
  });
});

describe('the thirty-six skills', () => {
  it('is six per attribute, at the three thresholds', () => {
    expect(ALL_STAT_SKILLS).toHaveLength(36);
    for (const key of ATTRIBUTE_KEYS) {
      const mine = statSkillsFor(key);
      expect(mine, key).toHaveLength(6);
      expect(mine.map((s) => s.requires)).toEqual([
        STAT_SKILL_THRESHOLDS[0],
        STAT_SKILL_THRESHOLDS[0],
        STAT_SKILL_THRESHOLDS[1],
        STAT_SKILL_THRESHOLDS[1],
        STAT_SKILL_THRESHOLDS[1],
        STAT_SKILL_THRESHOLDS[2],
      ]);
    }
  });

  it('is reachable: every threshold is inside the hard cap', () => {
    for (const skill of ALL_STAT_SKILLS) {
      expect(skill.requires, skill.id).toBeLessThanOrEqual(SCALING.attributeHardCap);
      expect(skill.maxLevel, skill.id).toBeGreaterThan(0);
    }
  });

  it('has unique ids, namespaced by their attribute', () => {
    const ids = ALL_STAT_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const skill of ALL_STAT_SKILLS) {
      expect(skill.id.startsWith(`${skill.attribute.slice(0, 3)}.`), skill.id).toBe(true);
    }
  });

  it('names a trigger on every row, and is mostly not "passive"', () => {
    // The review criterion, as an assertion. A tree of passives is a tree of
    // coefficients, which is the thing this whole spec exists to replace.
    const passive = ALL_STAT_SKILLS.filter((s) => s.trigger === 'passive');
    expect(passive.length).toBeLessThanOrEqual(9);
    for (const skill of ALL_STAT_SKILLS) {
      expect(skill.trigger.length, skill.id).toBeGreaterThan(4);
      expect(skill.description.length, skill.id).toBeGreaterThan(20);
    }
  });

  it('scales linearly with level, through the shared scaler', () => {
    for (const skill of ALL_STAT_SKILLS) {
      const one = sumModifiers([scaleModifier(skill.perLevel, 1)]);
      const three = sumModifiers([scaleModifier(skill.perLevel, 3)]);
      for (const key of Object.keys(one.traits) as (keyof typeof one.traits)[]) {
        expect(three.traits[key], `${skill.id}.${key}`).toBeCloseTo(one.traits[key] * 3, 9);
      }
    }
  });
});

describe('the modifier currency', () => {
  it('sums every trait field, so none can be silently dropped', () => {
    // The guard the header of `modifiers.ts` promises. `zeroTraits` is a literal
    // -- a type has no keys at runtime -- so a field added to `TraitModifier`
    // and forgotten there would sum to nothing forever. This walks a modifier
    // with every field set to 1 and asserts the sum kept all of them.
    const every = Object.fromEntries(
      Object.keys(emptyTraitTotals()).map((key) => [key, 1]),
    ) as TraitModifier;
    const summed = sumModifiers([{ traits: every }, { traits: every }]);
    for (const [key, value] of Object.entries(summed.traits)) {
      expect(value, key).toBe(2);
    }
  });

  it('scales the nested traits, not just the flat half', () => {
    const scaled = scaleModifier({ maxHealth: 10, traits: { staggerPower: 4 } }, 2.5);
    expect(scaled.maxHealth).toBe(25);
    expect(scaled.traits?.staggerPower).toBe(10);
  });

  it('treats a missing traits block as zero rather than throwing', () => {
    const summed = sumModifiers([{ maxHealth: 1 }, {}, { traits: { maxPoise: 5 } }]);
    expect(summed.maxHealth).toBe(1);
    expect(summed.traits.maxPoise).toBe(5);
    expect(summed.traits.staggerPower).toBe(0);
  });
});

describe('every trait actually reaches the sim', () => {
  it('is read by name somewhere under src/server/, or it is dead content', () => {
    // The test that would have caught three pieces of content that were shipped
    // and did nothing: `flowMovePct`, `secondWindHeal` and `secondWindBelow`
    // were derived, replicated and printed, and no line in the sim ever asked
    // for them. A milestone that grants nothing is worse than a milestone that
    // is missing, because the sheet says it works.
    //
    // A grep rather than an execution trace, deliberately: what is being
    // checked is that somebody *wired it up*, and a name that appears nowhere
    // cannot have been. A trait genuinely meant to be inert can be listed here
    // with a reason.
    const inert = new Set<string>([
      // Read by `derived.ts` to decide whether the geometry is switched on at
      // all, and never by the sim -- the geometry is what the sim reads.
      'shapingCostRelief',
      // The sheet's number. `stat-skills.ts` reads Mastery off the held levels
      // rather than off the bundle, because the bundle is derived from them and
      // asking it here would be the one cycle this design does not have.
      'masteryRelief',
    ]);

    // `derived.ts` is excluded, and excluding it is the whole point: it is the
    // *producer*, and every trait necessarily appears there as `t.thing` on the
    // line that computes it. Searching it too made the first version of this
    // test vacuous -- it passed with the reader deleted, which is exactly the
    // failure it exists to catch.
    const roots = ['src/server/sim', 'src/server/player', 'src/server/world'];
    const sources = roots
      .flatMap((root) => readdirDeep(root))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => !file.endsWith('derived.ts'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    const unread = TRAIT_WIRE_ORDER.filter(
      (key) => !inert.has(key) && !new RegExp(`\\.${key}\\b`).test(sources),
    );
    expect(unread, `traits nothing reads: ${unread.join(', ')}`).toEqual([]);
  });
});

describe('the trait wire order', () => {
  it('covers every field of TraitStats exactly once', () => {
    // A trait added to the interface and forgotten here would read as its
    // neighbour's value on every client, which is the sort of bug that survives
    // a playtest because most traits are zero most of the time.
    const declared = Object.keys(NEUTRAL_TRAITS).sort();
    const wire = [...TRAIT_WIRE_ORDER].sort();
    expect(wire).toEqual(declared);
    expect(new Set(TRAIT_WIRE_ORDER).size).toBe(TRAIT_WIRE_ORDER.length);
  });
});
