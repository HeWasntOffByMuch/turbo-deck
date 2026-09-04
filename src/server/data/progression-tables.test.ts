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
  allAttributePairs,
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
import { MILESTONE_THRESHOLDS, SCALING, SPECIALIZATION_THRESHOLDS } from './scaling.js';
import { ALL_SPECIALIZATIONS, specializationById, specializationsFor } from './specializations.js';
import { ALL_TRACKS } from './tracks.js';
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
    // Not a style point. a `SpendProgressionPoint` naming an attribute does so by its index
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

describe('attribute pairs carry no authored content (spec 244)', () => {
  /**
   * This block used to require an entry for every one of the fifteen unordered
   * pairs, and a pair with no row failed CI. That rule produced fifteen bespoke
   * bonuses whose only justification was the rule, and it made the question
   * worth asking -- *do these mechanics already compose?* -- untestable, because
   * the authored layer was always in the way.
   *
   * What is asserted now is the absence, in the one place it could come back:
   * the tables. `progression-interactions.test.ts` asserts it in the resolution,
   * and `derived.test.ts` over all fifteen pairs at once.
   */
  it('has fifteen of them, and no table keyed on one', () => {
    expect(allAttributePairs()).toHaveLength(15);
  });

  it('never pairs an attribute with itself, and never repeats a pair', () => {
    const seen = new Set<string>();
    for (const [a, b] of allAttributePairs()) {
      expect(a, `${a}+${b}`).not.toBe(b);
      const key = [a, b].sort().join('+');
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('leaves every progression grant keyed on one attribute alone', () => {
    // A milestone names one attribute and a specialization names one attribute.
    // Those are the only two shapes a grant has, so there is nowhere a two-stat
    // condition could be authored without a new table -- which is the guarantee
    // that replaced the fifteen rows.
    for (const milestone of ALL_MILESTONES) {
      expect(ATTRIBUTE_KEYS, milestone.id).toContain(milestone.attribute);
    }
    for (const specialization of ALL_SPECIALIZATIONS) {
      expect(ATTRIBUTE_KEYS, specialization.id).toContain(specialization.attribute);
    }
  });
});

describe('the six tracks (spec 244)', () => {
  it('gives every attribute a track spanning the whole range', () => {
    expect(ALL_TRACKS).toHaveLength(ATTRIBUTE_KEYS.length);
    for (const track of ALL_TRACKS) {
      expect(track.from).toBe(SCALING.startingAttribute);
      expect(track.to).toBe(SCALING.attributeHardCap);
    }
  });

  it('puts the nodes in threshold order, with no threshold twice', () => {
    for (const track of ALL_TRACKS) {
      const thresholds = track.nodes.map((node) => node.threshold);
      expect(thresholds, track.attribute).toEqual([...thresholds].sort((a, b) => a - b));
      expect(new Set(thresholds).size, track.attribute).toBe(thresholds.length);
    }
  });

  it('carries every milestone and every specialization exactly once', () => {
    const milestones = ALL_TRACKS.flatMap((t) => t.nodes.map((n) => n.milestone?.id ?? null))
      .filter((id): id is string => id !== null);
    const specializations = ALL_TRACKS.flatMap((t) =>
      t.nodes.flatMap((n) => n.specializations.map((s) => s.id)),
    );
    expect(milestones.slice().sort()).toEqual(ALL_MILESTONES.map((m) => m.id).slice().sort());
    expect(specializations.slice().sort()).toEqual(
      ALL_SPECIALIZATIONS.map((s) => s.id).slice().sort(),
    );
  });

  it('links every milestone to a specialization on its own track', () => {
    // All eighteen have one and always have: each milestone shares its name with
    // a specialization the track unlocked earlier and grants more of the same
    // mechanic. A `deepens` naming something on another track, or nothing at all,
    // would draw as one mechanic that is two.
    for (const milestone of ALL_MILESTONES) {
      const target = milestone.deepens;
      expect(target, milestone.id).toBeDefined();
      const specialization = specializationById(target ?? '');
      expect(specialization, `${milestone.id} -> ${String(target)}`).not.toBeNull();
      expect(specialization?.attribute, milestone.id).toBe(milestone.attribute);
      expect(specialization?.name, milestone.id).toBe(milestone.name);
      // And it is unlocked *before* the milestone that deepens it, or the sheet
      // would draw a boost to something a player cannot have yet.
      expect(specialization?.requires ?? 0, milestone.id).toBeLessThan(milestone.threshold);
    }
  });
});

describe('the specializations', () => {
  it('gives every attribute the same six core rows, at the three thresholds', () => {
    // The **core** six, which is every row on `SPECIALIZATION_THRESHOLDS`. Spec
    // 273 added Constitution mastery rows on top, and they sit on the last
    // *milestone* threshold rather than on one of these -- so this stays the
    // assertion it always was about the shape every track shares, and the
    // asymmetry is asserted separately below rather than smuggled in by
    // loosening this.
    for (const key of ATTRIBUTE_KEYS) {
      const core = specializationsFor(key).filter((s) =>
        (SPECIALIZATION_THRESHOLDS as readonly number[]).includes(s.requires),
      );
      expect(core, key).toHaveLength(6);
      expect(core.map((s) => s.requires)).toEqual([
        SPECIALIZATION_THRESHOLDS[0],
        SPECIALIZATION_THRESHOLDS[0],
        SPECIALIZATION_THRESHOLDS[1],
        SPECIALIZATION_THRESHOLDS[1],
        SPECIALIZATION_THRESHOLDS[1],
        SPECIALIZATION_THRESHOLDS[2],
      ]);
    }
  });

  it('puts late mastery rows on Constitution alone, priced above a point', () => {
    // Spec 273. The track completed at level 18 of 60 and had nothing to sell
    // after it; these are what deep investment buys instead. Constitution-only
    // on purpose -- the other five tracks are out of that spec's scope -- and
    // this asserts that boundary rather than trusting it, so extending another
    // track later is a deliberate edit here.
    const mastery = ALL_SPECIALIZATIONS.filter(
      (s) => !(SPECIALIZATION_THRESHOLDS as readonly number[]).includes(s.requires),
    );
    expect(mastery.length).toBeGreaterThan(0);
    for (const row of mastery) {
      expect(row.attribute, row.id).toBe('constitution');
      // On a threshold the track already has, so the shape gains depth without
      // gaining a number the tables do not already state.
      expect(MILESTONE_THRESHOLDS as readonly number[], row.id).toContain(row.requires);
      expect(row.costPerTier ?? 1, row.id).toBeGreaterThan(1);
    }
  });

  it('is reachable: every threshold is inside the hard cap', () => {
    for (const skill of ALL_SPECIALIZATIONS) {
      expect(skill.requires, skill.id).toBeLessThanOrEqual(SCALING.attributeHardCap);
      expect(skill.maxTier, skill.id).toBeGreaterThan(0);
    }
  });

  it('has unique ids, namespaced by their attribute', () => {
    const ids = ALL_SPECIALIZATIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const skill of ALL_SPECIALIZATIONS) {
      expect(skill.id.startsWith(`${skill.attribute.slice(0, 3)}.`), skill.id).toBe(true);
    }
  });

  it('names a trigger on every row, and is mostly not "passive"', () => {
    // The review criterion, as an assertion. A tree of passives is a tree of
    // coefficients, which is the thing this whole spec exists to replace.
    const passive = ALL_SPECIALIZATIONS.filter((s) => s.trigger === 'passive');
    expect(passive.length).toBeLessThanOrEqual(9);
    for (const skill of ALL_SPECIALIZATIONS) {
      expect(skill.trigger.length, skill.id).toBeGreaterThan(4);
      expect(skill.description.length, skill.id).toBeGreaterThan(20);
    }
  });

  it('scales linearly with level, through the shared scaler', () => {
    for (const skill of ALL_SPECIALIZATIONS) {
      const one = sumModifiers([scaleModifier(skill.perTier, 1)]);
      const three = sumModifiers([scaleModifier(skill.perTier, 3)]);
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
      // The sheet's number. `skills.ts` reads Mastery off the held levels
      // rather than off the bundle, because the bundle is derived from them and
      // asking it here would be the one cycle this design does not have.
      'masteryRelief',
      // **Deliberately dormant since spec 271.** A health gate on Unstoppable's
      // all-cast hyper-armour, from the Strength+Constitution pair spec 244
      // deleted. Its only surviving grant set it to exactly 1 -- "always" -- so
      // `if (gate < 1)` could never run and the sim carried a threshold no
      // content could set. The grant and the branch are both gone; the field
      // stays because `TRAIT_WIRE_ORDER` is protocol and removing an entry
      // renumbers every trait after it. It is listed here rather than given a
      // fractional grant, because inventing a low-health Strength mechanic to
      // keep a field alive is how this list got long in the first place.
      'juggernautBelow',
      // Dormant since spec 271 too, and for the same protocol reason. Heavy
      // Handling was its only grant, and the branch that read it -- an
      // `ability.damage >= HEAVY_ABILITY_DAMAGE` gate -- had been unreachable
      // since spec 237 deleted the one ability that cleared the bar. `derived.ts`
      // pins it at 1.
      'heavyWindupScale',
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
