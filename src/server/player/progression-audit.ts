/**
 * Does this purchase change anything? (spec 241)
 *
 * `npm run balance` fights twelve *attribute* presets through the real sim and
 * prints what each one did. It is the right instrument for "is Strength worth
 * taking" and the wrong one for the question this file asks, which is one level
 * down: **for every skill, at every rank, at every attribute value where that
 * rank can legally be bought -- does the purchase reach the simulation at all?**
 *
 * Spec 239 closed eight faults that were each invisible to every test in the
 * tree, and six of them were this question answered wrongly: three skills that
 * granted an improvement to a mechanic their own milestone introduced, two ranks
 * bought into a number a milestone had already filled to its cap, and a capstone
 * that made its own mechanic more expensive. Every one of them would have been a
 * line of this report. That is the whole justification for the file: those were
 * found by reading, and reading does not scale to thirty-six skills times three
 * ranks times four contexts.
 *
 * **What counts as an effect.** A rank must move a value on `EffectiveStats` or
 * `TraitStats` -- the two objects the sim actually reads. A modifier that only
 * moves a `ModifierTotals` field is explicitly *not* enough, which is the case
 * `grantsPrepared` existed to fix: the totals moved, `deriveTraits` gated on a
 * different field, and nothing downstream saw a thing.
 *
 * **Four verdicts**, and the difference between the middle two is what makes the
 * report worth reading rather than a list of complaints:
 *
 *  - `ACTIVE`     -- something the sim reads moved.
 *  - `REDUNDANT`  -- nothing moved *here*, but the same rank moves something at
 *                    another legal attribute value. A cap somebody else filled.
 *  - `INERT`      -- nothing moved at any legal attribute value. The rank does
 *                    nothing, anywhere, ever.
 *  - `BACKWARDS`  -- something moved the wrong way, judged against
 *                    {@link TRAIT_DIRECTION}.
 *
 * Pure: no clock, no randomness, no I/O. The script and the test both drive it.
 */

import { ATTRIBUTE_KEYS, type AttributeKey } from '../data/attributes.js';
import { ALL_MILESTONES, type MilestoneDefinition } from '../data/milestones.js';
import { MILESTONE_THRESHOLDS, SCALING } from '../data/scaling.js';
import { ALL_SKILLS, type SkillDefinition } from '../data/skills.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
  type TraitStats,
} from '../state/types.js';
import { startingBaseStats } from './attributes.js';
import { computeEffectiveStats } from './stats.js';

// --- which way is better --------------------------------------------------

/**
 * Which direction a field improves in, where that is knowable.
 *
 * The brief's *"create explicit monotonic assertions for mechanics where
 * direction is known"*, as a table rather than as a heuristic -- because there
 * is no heuristic. `backswingScale` down is good and `flowTicks` up is good and
 * nothing about either name says so.
 *
 * `ambiguous` is a **decision**, not an omission: a field marked ambiguous is
 * one somebody looked at and could not honestly give a direction to, and
 * `progression-audit.test.ts` asserts the table covers `TraitStats` exactly --
 * so a field added and forgotten fails CI rather than silently opting out of
 * the backwards check.
 */
export type Direction = 'up' | 'down' | 'ambiguous';

export const TRAIT_DIRECTION: Readonly<Record<keyof TraitStats, Direction>> = {
  // --- Strength ---
  staggerPower: 'up',
  // How long a stagger *on this body* lasts: `resolveBlow` reads the victim's.
  staggerTicks: 'down',
  windupPoiseArmor: 'up',
  poiseArmorInBackswing: 'up',
  poiseArmorAllCasts: 'up',
  // A health gate on hyper-armour: 1 is "always", lower is "only when hurt".
  juggernautBelow: 'up',
  breakResource: 'up',
  breakCooldownRefund: 'up',
  abilityPoiseFactor: 'up',
  executeBonus: 'up',
  executeBelow: 'up',
  overkillResource: 'up',
  momentumTicks: 'up',
  momentumWindupScale: 'up',
  heavyWindupScale: 'down',

  // --- Agility ---
  attackPointScale: 'down',
  backswingScale: 'down',
  handlingScale: 'down',
  handlingCooldowns: 'up',
  flowTicks: 'up',
  flowBackswingPct: 'up',
  flowCostPct: 'up',
  flowArmorPct: 'up',
  flowWeakPoint: 'up',
  spellbladeHandling: 'up',
  perfectExitResource: 'up',
  perfectExitWindowTicks: 'up',

  // --- Intelligence ---
  spellRadiusPct: 'up',
  spellRangePct: 'up',
  // The premium shaping charges. Lower is better; `shapingCostRelief` pays it.
  shapingCostPct: 'down',
  shapingCostRelief: 'up',
  // How long you must stand still to prime. Lower is better -- and `0` means
  // *no Prepared at all*, which is why the audit compares only live values.
  prepareTicks: 'down',
  preparedWindupScale: 'down',
  preparedMastery: 'up',
  vsAfflictedPct: 'up',
  appliesSundered: 'up',
  // Health per point of missing resource. A **price**: lower is better, and the
  // field whose additive representation made the Intelligence 50 milestone
  // double its own cost (spec 239).
  overflowHealthPerResource: 'down',
  damageToShield: 'up',

  // --- Constitution ---
  maxPoise: 'up',
  poiseRegen: 'up',
  poiseRegenCalm: 'up',
  poiseRegenStaggered: 'up',
  poiseRegenMoving: 'up',
  // A threshold: firing earlier is better, so a *higher* fraction is better.
  secondWindBelow: 'up',
  secondWindHeal: 'up',
  resoluteBelow: 'up',
  resoluteReduction: 'up',
  staggerImmuneBelow: 'up',
  overhealShieldTicks: 'up',
  maxShield: 'up',

  // --- Perception ---
  weakPointChance: 'up',
  weakPointMultiplier: 'up',
  exposeTicks: 'up',
  exposedDamagePct: 'up',
  openingReadTicks: 'up',
  vulnerableWeakPointFactor: 'up',
  steadyAimPct: 'up',
  // How long you must stand still before Steady Aim pays. Lower is better.
  steadyAimTicks: 'down',
  exploitDamagePct: 'up',
  exploitPoiseFactor: 'up',
  weakPointResource: 'up',
  weakPointKillHeal: 'up',
  abilityWeakPoints: 'up',
  vsVulnerableReduction: 'up',
  exposedTeamResource: 'up',

  // --- Wisdom ---
  resourceCostScale: 'down',
  cooldownScale: 'down',
  healingScale: 'up',
  healingSurge: 'up',
  healingSurgeBelow: 'up',
  attunedMaxStacks: 'up',
  attunedTicks: 'up',
  attunedCostPct: 'up',
  attunedFromWeakPoints: 'up',
  adaptationPerStack: 'up',
  adaptationCap: 'up',
  adaptationTicks: 'up',
  conversionCap: 'up',
  // A count that *lowers* a skill's attribute requirement.
  masteryRelief: 'up',

  // --- the health economy ---
  restoreOverkillPct: 'up',
  restoreEvasivePct: 'up',
  restoreAbilityKillPct: 'up',
  restoreWeakPointPct: 'up',
  moteAttractRadius: 'up',
  restoreSalvagePct: 'up',
  fallbackCharges: 'up',
};

/**
 * Fields where **`0` means the mechanic is not there at all**.
 *
 * Two, and they need naming because both are `down` fields -- a stillness
 * window and a price -- where the naive reading of `0 -> 1.5` is "the cost went
 * up" and the true reading is "you acquired Arcane Overflow". Every other
 * `down` field in `TraitStats` has a non-zero neutral (a scale is 1, a stagger
 * is `staggerTicksBase`), so zero is a real value there and a rise really is a
 * regression.
 *
 * Stated as a table rather than inferred from `NEUTRAL_TRAITS === 0`, because
 * plenty of `up` fields are zero at neutral too and the distinction that
 * matters is *"is zero the absence of a mechanic"*, which only a person knows.
 */
export const ABSENT_AT_ZERO: ReadonlySet<string> = new Set<string>([
  'prepareTicks',
  'overflowHealthPerResource',
]);

/** The `EffectiveStats` numbers a rank can move, and which way is better. */
export const STAT_DIRECTION: Readonly<Record<string, Direction>> = {
  maxHealth: 'up',
  moveSpeed: 'up',
  turnRate: 'up',
  attackDamage: 'up',
  attackRange: 'up',
  baseAttackTimeTicks: 'down',
  attackSpeed: 'up',
  attackSpeedMultiplier: 'up',
  attackSpeedSlowMultiplier: 'up',
  armor: 'up',
  spellPower: 'up',
  critChance: 'up',
  maxResource: 'up',
  resourceRegen: 'up',
  weaponDamageMin: 'up',
  weaponDamageMax: 'up',
};

// --- what the audit produces ----------------------------------------------

export type Verdict = 'ACTIVE' | 'REDUNDANT' | 'INERT' | 'BACKWARDS';

export interface ValueDelta {
  readonly where: 'stat' | 'trait';
  readonly field: string;
  readonly before: number;
  readonly after: number;
  readonly direction: Direction;
  /** True when this delta moved the wrong way for a known direction. */
  readonly backwards: boolean;
}

/** One attribute value a transition is evaluated at, and why that one. */
export interface AuditContext {
  readonly attribute: AttributeKey;
  readonly value: number;
  /** `purchasable`, `milestone 35`, `cap` -- what makes this value worth testing. */
  readonly reason: string;
}

export interface RankAudit {
  readonly skillId: string;
  readonly skillName: string;
  readonly attribute: AttributeKey;
  readonly from: number;
  readonly to: number;
  readonly context: AuditContext;
  readonly deltas: readonly ValueDelta[];
  readonly verdict: Verdict;
  /** One line saying why this verdict, for the report. */
  readonly note: string;
}

export interface MilestoneAudit {
  readonly milestoneId: string;
  readonly attribute: AttributeKey;
  readonly threshold: number;
  /** Fields that got *worse* on crossing the threshold. Empty is the goal. */
  readonly regressions: readonly ValueDelta[];
}

export interface AuditReport {
  readonly ranks: readonly RankAudit[];
  readonly milestones: readonly MilestoneAudit[];
  readonly growth: readonly GrowthAudit[];
}

// --- the machinery --------------------------------------------------------

interface Rank {
  readonly skillId: string;
  readonly level: number;
}

function record(baseStats: Partial<BaseStats>, skills: readonly Rank[]): PersistedPlayer {
  return {
    id: 'audit',
    displayName: 'audit',
    baseStats: { ...startingBaseStats(), ...baseStats },
    skills: [...skills],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
    health: 100,
    resource: 10,
    coins: 0,
  };
}

function statsAt(attribute: AttributeKey, value: number, skills: readonly Rank[]): EffectiveStats {
  return computeEffectiveStats(record({ [attribute]: value }, skills));
}

/** Two derivations, differenced field by field. Only real movement is kept. */
function diff(before: EffectiveStats, after: EffectiveStats): ValueDelta[] {
  const deltas: ValueDelta[] = [];
  const seen = (
    where: 'stat' | 'trait',
    field: string,
    a: number,
    b: number,
    direction: Direction,
  ): void => {
    // A float epsilon, not zero: two derivations of the same character can differ
    // in the last bit of a chain of multiplications, and a report full of `1e-16`
    // deltas is a report nobody reads.
    if (Math.abs(b - a) <= 1e-9) return;
    // Acquiring a mechanic is never a regression, however the field reads: see
    // {@link ABSENT_AT_ZERO}. Only the `0 ->` direction is exempted, so *losing*
    // one still shows up, and a rise from an already-live value still does too.
    const acquired = direction === 'down' && a === 0 && b > 0 && ABSENT_AT_ZERO.has(field);
    const backwards =
      !acquired && ((direction === 'up' && b < a) || (direction === 'down' && b > a));
    deltas.push({ where, field, before: a, after: b, direction, backwards });
  };

  for (const [field, direction] of Object.entries(STAT_DIRECTION)) {
    const a = (before as unknown as Record<string, unknown>)[field];
    const b = (after as unknown as Record<string, unknown>)[field];
    if (typeof a === 'number' && typeof b === 'number') seen('stat', field, a, b, direction);
  }
  for (const [field, direction] of Object.entries(TRAIT_DIRECTION)) {
    const a = (before.traits as unknown as Record<string, number>)[field] ?? 0;
    const b = (after.traits as unknown as Record<string, number>)[field] ?? 0;
    seen('trait', field, a, b, direction);
  }
  return deltas;
}

/**
 * The attribute values one skill is evaluated at.
 *
 * Derived from the skill and the tables rather than authored, so a retuned
 * threshold moves the contexts with it. Four kinds, and the brief names three
 * of them: the value at which the rank first becomes purchasable, each
 * milestone threshold of the same attribute at or above it, and the hard cap.
 * A duplicate value is dropped, which is why a skill requiring exactly a
 * milestone value produces three contexts rather than four.
 */
export function contextsFor(skill: SkillDefinition): readonly AuditContext[] {
  const values = new Map<number, string>();
  values.set(skill.requires, 'purchasable');
  for (const threshold of MILESTONE_THRESHOLDS) {
    if (threshold < skill.requires) continue;
    if (!values.has(threshold)) values.set(threshold, `milestone ${String(threshold)}`);
  }
  const cap = SCALING.attributeHardCap;
  if (!values.has(cap)) values.set(cap, 'specialised');
  return [...values.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, reason]) => ({ attribute: skill.attribute, value, reason }));
}

/**
 * Every rank transition of every skill, at every context.
 *
 * The two-pass shape is what makes `REDUNDANT` and `INERT` different answers:
 * the first pass measures each `(transition, context)` cell, and the second
 * looks *across* a transition's row to decide whether "nothing moved here"
 * means a cap somebody else filled or a rank that does nothing anywhere.
 */
export function auditSkills(skills: readonly SkillDefinition[] = ALL_SKILLS): readonly RankAudit[] {
  const out: RankAudit[] = [];
  for (const skill of skills) {
    const contexts = contextsFor(skill);
    for (let to = 1; to <= skill.maxLevel; to++) {
      const from = to - 1;
      const cells = contexts.map((context) => {
        const before = statsAt(
          context.attribute,
          context.value,
          from > 0 ? [{ skillId: skill.id, level: from }] : [],
        );
        const after = statsAt(context.attribute, context.value, [{ skillId: skill.id, level: to }]);
        return { context, deltas: diff(before, after) };
      });
      const movesSomewhere = cells.some((cell) => cell.deltas.length > 0);

      for (const cell of cells) {
        const backwards = cell.deltas.filter((delta) => delta.backwards);
        let verdict: Verdict;
        let note: string;
        if (backwards.length > 0) {
          verdict = 'BACKWARDS';
          note = `${backwards.map((d) => d.field).join(', ')} moved the wrong way`;
        } else if (cell.deltas.length > 0) {
          verdict = 'ACTIVE';
          note = cell.deltas.map((d) => d.field).join(', ');
        } else if (movesSomewhere) {
          verdict = 'REDUNDANT';
          note = 'nothing the sim reads moved here, though this rank moves something elsewhere';
        } else {
          verdict = 'INERT';
          note = 'nothing the sim reads moved at any legal attribute value';
        }
        out.push({
          skillId: skill.id,
          skillName: skill.name,
          attribute: skill.attribute,
          from,
          to,
          context: cell.context,
          deltas: cell.deltas,
          verdict,
          note,
        });
      }
    }
  }
  return out;
}

/**
 * What crossing a milestone threshold does, and whether any of it is a loss.
 *
 * One point of an attribute, either side of the threshold, with no skills held
 * -- so what moves is the milestone's own grant plus one point of whatever that
 * attribute smoothly scales. Both are progression, and neither is allowed to
 * make a thing worse.
 *
 * This is the audit that would have caught spec 239's headline fault on its own:
 * reaching Intelligence 50 **doubled** the health an overflow cast costs,
 * because the skill and the milestone both granted the rate and the two summed.
 */
export function auditMilestones(
  milestones: readonly MilestoneDefinition[] = ALL_MILESTONES,
): readonly MilestoneAudit[] {
  return milestones.map((milestone) => {
    const below = statsAt(milestone.attribute, milestone.threshold - 1, []);
    const at = statsAt(milestone.attribute, milestone.threshold, []);
    return {
      milestoneId: milestone.id,
      attribute: milestone.attribute,
      threshold: milestone.threshold,
      regressions: diff(below, at).filter((delta) => delta.backwards),
    };
  });
}

/**
 * Crossing a milestone while **holding the skills of the same attribute**.
 *
 * The other half of the same question, and the half that actually bit: a
 * milestone's grant is not evaluated in isolation by a real character, it lands
 * on top of whatever they have already bought. Arcane Overflow's cost doubled
 * only for somebody holding both, and `auditMilestones` above would have
 * reported it as fine.
 */
export function auditMilestonesWithSkills(
  milestones: readonly MilestoneDefinition[] = ALL_MILESTONES,
): readonly MilestoneAudit[] {
  return milestones.map((milestone) => {
    // Everything of that attribute the character could legally be holding below
    // the threshold, at full rank.
    const held = ALL_SKILLS.filter(
      (skill) => skill.attribute === milestone.attribute && skill.requires < milestone.threshold,
    ).map((skill) => ({ skillId: skill.id, level: skill.maxLevel }));
    const below = statsAt(milestone.attribute, milestone.threshold - 1, held);
    const at = statsAt(milestone.attribute, milestone.threshold, held);
    return {
      milestoneId: milestone.id,
      attribute: milestone.attribute,
      threshold: milestone.threshold,
      regressions: diff(below, at).filter((delta) => delta.backwards),
    };
  });
}

/** One stretch of an attribute, and what got worse across it. */
export interface GrowthAudit {
  readonly attribute: AttributeKey;
  readonly from: number;
  readonly to: number;
  readonly regressions: readonly ValueDelta[];
}

/**
 * What *raising an attribute* does, over the whole range rather than a point.
 *
 * The third audit, and the one that catches what neither of the others can.
 * `auditMilestones` compares one point either side of a threshold, so a smooth
 * scale moving 0.2 per point rounds to nothing across it and reads as fine --
 * while over forty points it is eight ticks. The brief's rule is *increasing a
 * stat should not make a thing worse*, and that is a question about the whole
 * span.
 *
 * Every consecutive pair of interesting values, so the report can say *where*
 * it turned rather than only that it did.
 */
export function auditAttributeGrowth(): readonly GrowthAudit[] {
  const stops = [SCALING.startingAttribute, ...MILESTONE_THRESHOLDS, SCALING.attributeHardCap];
  const out: GrowthAudit[] = [];
  for (const attribute of ATTRIBUTE_KEYS) {
    for (let i = 1; i < stops.length; i++) {
      const from = stops[i - 1] as number;
      const to = stops[i] as number;
      if (to <= from) continue;
      const regressions = diff(statsAt(attribute, from, []), statsAt(attribute, to, [])).filter(
        (delta) => delta.backwards,
      );
      out.push({ attribute, from, to, regressions });
    }
  }
  return out;
}

/** The whole audit. */
export function auditProgression(): AuditReport {
  return {
    ranks: auditSkills(),
    milestones: [...auditMilestones(), ...auditMilestonesWithSkills()],
    growth: auditAttributeGrowth(),
  };
}

/** Every rank whose verdict is not `ACTIVE`, which is what a gate checks. */
export function findings(report: AuditReport): readonly RankAudit[] {
  return report.ranks.filter((row) => row.verdict !== 'ACTIVE');
}

/** `str.committedSwing 2->3 @ strength 50` -- the key an allowlist entry names. */
export function findingKey(row: RankAudit): string {
  return `${row.skillId} ${String(row.from)}->${String(row.to)} @ ${row.attribute} ${String(row.context.value)}`;
}

/**
 * Every regression the two attribute-side audits found, as allowlist keys.
 *
 * Milestones and growth together, because both answer "does raising this
 * attribute cost me anything" and a caller gating on one and not the other
 * would leave half the question unasked.
 */
export function regressionKeys(report: AuditReport): readonly string[] {
  const keys: string[] = [];
  for (const milestone of report.milestones) {
    for (const delta of milestone.regressions) {
      keys.push(`milestone ${milestone.milestoneId} : ${delta.field}`);
    }
  }
  for (const span of report.growth) {
    for (const delta of span.regressions) {
      keys.push(`growth ${span.attribute} ${String(span.from)}->${String(span.to)} : ${delta.field}`);
    }
  }
  return [...new Set(keys)].sort();
}

/** Every attribute, so a caller can iterate without importing the table. */
export const AUDIT_ATTRIBUTES: readonly AttributeKey[] = ATTRIBUTE_KEYS;
