/**
 * The audit, as a gate (spec 241).
 *
 * `npx tsx scripts/audit-progression.ts` is the instrument a person reads while
 * tuning; this is the half that runs in CI. What it asserts is not a set of
 * numbers -- a balance pass should be free to move every one of them -- but the
 * two properties the numbers have to keep:
 *
 *  1. **Every rank you can legally buy changes something the sim reads**, at
 *     every attribute value where you can buy it.
 *  2. **Nothing gets worse** as a rank, a milestone or an attribute goes up.
 *
 * Exceptions are an **explicit allowlist with a reason each**, and the list is
 * asserted *exactly* rather than as a subset. That cuts both ways on purpose: a
 * new inert rank fails, and so does fixing an allowlisted one without removing
 * its entry -- so the list can only shrink by somebody deciding it should.
 */

import { describe, expect, it } from 'vitest';
import { NEUTRAL_TRAITS } from './derived.js';
import { ALL_SKILLS } from '../data/skills.js';
import {
  auditProgression,
  contextsFor,
  findingKey,
  findings,
  regressionKeys,
  STAT_DIRECTION,
  TRAIT_DIRECTION,
  type Verdict,
} from './progression-audit.js';

/**
 * Rank/context cells that are allowed not to be `ACTIVE`, and why.
 *
 * A reason is not decoration: an entry with no defensible one is a bug somebody
 * decided to keep, and the point of writing them down is that the next reader
 * can tell the two apart.
 */
const ALLOWED_RANKS: Readonly<Record<string, string>> = {
  // Spell Shaping buys radius and range **at a premium**, and says so in its own
  // description: "Wider and further, at a premium only Efficient Construction
  // pays off." `shapingCostPct` rising with the rank is the trade-off the skill
  // *is*, and `int.efficientConstruction` exists to pay it off. The audit
  // correctly flags a `down` field going up; this is the one place the game
  // explicitly presents that as the deal.
  ...Object.fromEntries(
    ALL_SKILLS.filter((skill) => skill.id === 'int.shaping').flatMap((skill) =>
      contextsFor(skill).flatMap((context) =>
        Array.from({ length: skill.maxLevel }, (_, index) => [
          `${skill.id} ${String(index)}->${String(index + 1)} @ ${context.attribute} ${String(context.value)}`,
          'the shaping premium is the trade-off the skill is, and it is stated on the row',
        ]),
      ),
    ),
  ),
};

/**
 * Attribute-side regressions that are allowed, and why.
 *
 * Two entries and they are different in kind. The shaping ones are a stated
 * trade-off; the Strength one is a **finding**, kept here rather than fixed
 * because fixing it is a design decision and a balance change rather than a
 * cleanup -- see the reason on the entry.
 */
const ALLOWED_REGRESSIONS: Readonly<Record<string, string>> = {
  'milestone int.shaping : shapingCostPct':
    'the Intelligence 20 milestone grants the shaping premium along with the geometry it pays for; the trade-off is stated on the milestone and on the skill',
  'growth intelligence 5->20 : shapingCostPct':
    'the same premium, seen as the attribute crossing the milestone that grants it',

  // **A real finding, deliberately not fixed here.**
  //
  // `staggerTicks` is documented under Strength -- "how long a break roots the
  // broken body" -- and grows 0.2 a point, 31 ticks at 5 Strength to 42 at 60.
  // But `resolveBlow` reads it off the **defender**: `stagger(target,
  // attacker.id, D.staggerTicks, ...)`. So a Strength character's own stagger
  // lasts *longer* the more Strength they have, which is backwards progression
  // in exactly the sense this audit exists to catch.
  //
  // Which side should read it is a design question rather than a typo: "a heavy
  // body takes longer to get up" is a defensible rule, and so is "Strength makes
  // the breaks you cause last longer", and the two produce different games.
  // Changing it moves every stagger duration in the game either way, which is a
  // balance pass rather than a cleanup. Recorded, surfaced by the report on
  // every run, and left for that decision.
  'growth strength 5->20 : staggerTicks': 'Strength lengthens the holder’s own stagger -- see the note above',
  'growth strength 20->35 : staggerTicks': 'Strength lengthens the holder’s own stagger -- see the note above',
  'growth strength 35->50 : staggerTicks': 'Strength lengthens the holder’s own stagger -- see the note above',
  'growth strength 50->60 : staggerTicks': 'Strength lengthens the holder’s own stagger -- see the note above',
};

const report = auditProgression();

describe('the direction table covers what it judges (spec 241)', () => {
  it('gives every TraitStats field a direction', () => {
    // Exactly, in both directions: a trait added and forgotten would opt out of
    // the backwards check silently, and a direction for a field that no longer
    // exists is a line nobody will ever delete.
    expect(Object.keys(TRAIT_DIRECTION).sort()).toEqual(Object.keys(NEUTRAL_TRAITS).sort());
  });

  it('gives every direction a legal value', () => {
    for (const [field, direction] of Object.entries(TRAIT_DIRECTION)) {
      expect(['up', 'down', 'ambiguous'], field).toContain(direction);
    }
    for (const [field, direction] of Object.entries(STAT_DIRECTION)) {
      expect(['up', 'down', 'ambiguous'], field).toContain(direction);
    }
  });
});

describe('every rank checked (spec 241)', () => {
  it('checks every skill at every rank and every legal context', () => {
    const expected = ALL_SKILLS.reduce(
      (sum, skill) => sum + skill.maxLevel * contextsFor(skill).length,
      0,
    );
    expect(report.ranks.length).toBe(expected);
    // And there is something to check: a report over zero skills would pass
    // every assertion below it.
    expect(report.ranks.length).toBeGreaterThan(100);
  });

  it('gives every skill at least one context', () => {
    for (const skill of ALL_SKILLS) {
      expect(contextsFor(skill).length, skill.id).toBeGreaterThan(0);
      // The first one is always the value the rank becomes purchasable at,
      // which is the context the brief cares about most.
      expect(contextsFor(skill)[0]?.value, skill.id).toBe(skill.requires);
    }
  });
});

describe('no rank is inert, redundant or backwards (spec 241)', () => {
  it('has no finding that is not on the allowlist', () => {
    const found = findings(report).map(findingKey);
    const unexpected = found.filter((key) => !(key in ALLOWED_RANKS));
    // Named rather than counted, so a failure says which rank and at which
    // attribute value rather than "expected 3 to be 0".
    expect(unexpected).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    // The half that makes the list shrink: fixing an allowlisted rank without
    // removing its entry fails here.
    const found = new Set(findings(report).map(findingKey));
    const stale = Object.keys(ALLOWED_RANKS).filter((key) => !found.has(key));
    expect(stale).toEqual([]);
  });

  it('gives every allowlist entry a reason', () => {
    for (const [key, reason] of Object.entries(ALLOWED_RANKS)) {
      expect(reason.length, key).toBeGreaterThan(20);
    }
    for (const [key, reason] of Object.entries(ALLOWED_REGRESSIONS)) {
      expect(reason.length, key).toBeGreaterThan(20);
    }
  });

  it('reports the verdicts it is meant to be able to report', () => {
    // A control. Every assertion above is an absence, and an audit that had
    // stopped computing verdicts at all would satisfy all of them.
    const verdicts = new Set<Verdict>(report.ranks.map((row) => row.verdict));
    expect(verdicts.has('ACTIVE')).toBe(true);
    // And the deltas are real rather than empty: an `ACTIVE` row names what moved.
    const active = report.ranks.find((row) => row.verdict === 'ACTIVE');
    expect(active?.deltas.length).toBeGreaterThan(0);
  });
});

describe('nothing gets worse as progression goes up (spec 241)', () => {
  it('has no regression that is not on the allowlist', () => {
    const unexpected = regressionKeys(report).filter((key) => !(key in ALLOWED_REGRESSIONS));
    expect(unexpected).toEqual([]);
  });

  it('has no stale regression allowlist entry', () => {
    const found = new Set(regressionKeys(report));
    const stale = Object.keys(ALLOWED_REGRESSIONS).filter((key) => !found.has(key));
    expect(stale).toEqual([]);
  });

  it('checks every milestone and every stretch of every attribute', () => {
    // 18 milestones, audited twice -- alone, and under the skills of the same
    // attribute a real character would be holding. The second is the one that
    // catches a milestone whose grant only turns bad on top of a skill, which
    // is exactly what Arcane Overflow's did.
    expect(report.milestones.length).toBe(36);
    expect(report.growth.length).toBeGreaterThan(0);
  });
});
