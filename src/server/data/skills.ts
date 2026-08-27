/**
 * Thirty-six attribute-attuned skills, six per attribute (spec 147).
 *
 * A second tree beside the branch-locked one in `skills.ts`, spending the *same*
 * `unspentSkillPoints`. The differences are the whole point:
 *
 *  - **No branch locks.** Nothing here forecloses anything. A character with
 *    points in Strength skills and Intelligence skills is a build, not a
 *    mistake, and the brief's "avoid hard class locks" governs this tree.
 *  - **The gate is an attribute, not a point count.** `requires` is "you need
 *    this much Strength", so what opens a skill is the build you have actually
 *    made rather than how much you have already spent in the same column.
 *  - **Every row names a trigger.** `trigger` is not flavour: it is the review
 *    criterion. A row whose trigger is "passive" and whose grant is a percentage
 *    is a row that failed, and there are six of them here on purpose -- the
 *    numerical-competence tier -- against thirty that fire on something.
 *
 * Six per attribute, at three thresholds: two at 10 (competence), three at 25
 * (identity) and one at 40 (the qualitative one).
 *
 * Pure data.
 */

import type { AttributeKey } from './attributes.js';
import type { StatModifier } from './modifiers.js';
import { SCALING, SKILL_THRESHOLDS } from './scaling.js';

export interface SkillDefinition {
  readonly id: string;
  readonly attribute: AttributeKey;
  readonly name: string;
  /** Attribute value needed before a point may go in. */
  readonly requires: number;
  /** Which of {@link SKILL_THRESHOLDS} this sits on: 1, 2 or 3. */
  readonly tier: number;
  readonly maxLevel: number;
  /** When it fires. "passive" is allowed and is a deliberate minority. */
  readonly trigger: string;
  /** What one level is worth; the total is this times the level held. */
  readonly perLevel: StatModifier;
  readonly description: string;
}

const [T1, T2, T3] = SKILL_THRESHOLDS as [number, number, number];

function tierOf(requires: number): number {
  if (requires >= T3) return 3;
  if (requires >= T2) return 2;
  return 1;
}

function skill(
  id: string,
  attribute: AttributeKey,
  name: string,
  requires: number,
  maxLevel: number,
  trigger: string,
  perLevel: StatModifier,
  description: string,
): SkillDefinition {
  return { id, attribute, name, requires, tier: tierOf(requires), maxLevel, trigger, perLevel, description };
}

const DEFINITIONS: readonly SkillDefinition[] = [
  // ======================= STRENGTH =======================
  skill('str.crushingBlows', 'strength', 'Crushing Blows', T1, 3, 'every blow',
    { traits: { poiseDamagePct: 0.18 } },
    'Your blows carry more weight against an enemy’s guard.'),
  // 0.08 a rank rather than 0.2 (spec 239). Four sources feed `windupPoiseArmor`
  // and it is capped at 0.9: at 0.2 a rank they summed to 2.0, so the Strength
  // 35 milestone alone pre-spent two thirds of the cap and rank 3 of this was
  // worth nothing at all -- and past Strength 50 the milestones filled it and
  // every rank was. The four now sum to exactly 0.9, so a fully-invested
  // Strength character ends where they always did and every step on the way
  // there is a step.
  skill('str.committedSwing', 'strength', 'Committed Swing', T1, 3, 'while winding up an attack',
    { traits: { windupPoiseArmor: 0.08 } },
    'Harder to knock out of a swing you have already started.'),
  skill('str.followThrough', 'strength', 'Brutal Follow-Through', T2, 3, 'on breaking an enemy’s guard',
    { traits: { momentumTicks: Math.round(SCALING.agility.flowTicks * 0.5), momentumWindupScale: 0.12 } },
    'A break opens a window: your next blow starts faster.'),
  skill('str.heavyHandling', 'strength', 'Heavy Handling', T2, 3, 'casting a heavy ability',
    { traits: { heavyWindupReduction: 0.15 } },
    'Oversized weapons stop punishing you for their weight.'),
  skill('str.overkill', 'strength', 'Overkill', T2, 3, 'on a kill that overkilled by a quarter',
    { traits: { overkillResource: 4 } },
    'Force spent past what was needed comes back to you.'),
  skill('str.unstoppable', 'strength', 'Unstoppable', T3, 1, 'while committed to any cast',
    { traits: { windupPoiseArmor: 0.12, poiseArmorAllCasts: 1, juggernautBelow: 1 } },
    'Nothing takes you off a blow you have committed to. Only while you are committed.'),

  // ======================= AGILITY ========================
  skill('agi.quickRecovery', 'agility', 'Quick Recovery', T1, 3, 'passive',
    { traits: { backswingReduction: 0.1 } },
    'You are rooted for less of every attack. You do not attack more often.'),
  skill('agi.mobileOffense', 'agility', 'Mobile Offense', T1, 3, 'on cancelling a follow-through',
    { traits: { flowTicks: Math.round(SCALING.agility.flowTicks * 0.15), flowBackswingPct: 0.01 } },
    'Breaking out of a swing feeds your momentum instead of wasting it.'),
  skill('agi.lightfoot', 'agility', 'Lightfoot', T2, 3, 'passive',
    { moveSpeed: 6, armor: 0.008 },
    'Footwork that is worth something even when it does not avoid the blow.'),
  skill('agi.rapidHandling', 'agility', 'Rapid Handling', T2, 3, 'casting an ability that launches something',
    { traits: { handlingReduction: 0.12 } },
    'Draw, load and release. The cadence does not move.'),
  skill('agi.flow', 'agility', 'Flow', T2, 3, 'while Flow is held',
    { traits: { flowBackswingPct: 0.06, flowDurationPct: 0.12 } },
    'Kept moving, kept swinging: each stack shortens the next recovery.'),
  skill('agi.perfectExit', 'agility', 'Perfect Exit', T3, 1, 'withdrawing just after being hit',
    { traits: { perfectExitResource: 5, perfectExitWindowTicks: Math.round(SCALING.agility.flowTicks / 6) } },
    'Reading a blow and stepping out of your own turns the exchange around.'),

  // ===================== INTELLIGENCE =====================
  skill('int.potency', 'intelligence', 'Arcane Potency', T1, 3, 'passive',
    { spellPower: 0.05 },
    'The straightforward one. Everything you throw hits harder.'),
  skill('int.shaping', 'intelligence', 'Spell Shaping', T1, 3, 'ground and projectile abilities',
    { traits: { spellRadiusPct: 0.08, spellRangePct: 0.05, shapingCostPct: 0.1 } },
    'Wider and further, at a premium only Efficient Construction pays off.'),
  // `grantsPrepared` (spec 239). Both of its numbers are *reductions*, so
  // before this the skill's only effect on `deriveTraits`' old gate
  // (`preparedWindupScale > 0`) was to fail it -- Prepared did not exist for a
  // character who had bought the skill improving Prepared, and would not until
  // the Intelligence 35 milestone.
  skill('int.prepared', 'intelligence', 'Prepared Casting', T2, 3, 'after standing still',
    {
      traits: {
        grantsPrepared: 1,
        prepareTicks: -Math.round(SCALING.intelligence.prepareTicks * 0.15),
        // -0.06 rather than -0.08: the scale is floored at 0.2, and with the
        // milestone's -0.1 on top of a 0.5 base, -0.08 a rank put rank 3
        // through the floor and made half of it disappear. Three ranks and the
        // milestone now land at 0.22, so every rank is worth its whole step.
        preparedWindupScale: -0.06,
      },
    },
    'Less stillness to prime, and a sharper opener when you do.'),
  skill('int.catalysis', 'intelligence', 'Catalysis', T2, 3, 'hitting anything already afflicted',
    { traits: { vsAfflictedPct: 0.08, appliesSundered: 0 } },
    'Statuses are fuel. Anything already suffering suffers more.'),
  skill('int.efficientConstruction', 'intelligence', 'Efficient Construction', T2, 3, 'passive',
    { traits: { shapingCostRelief: 0.4 } },
    'Pays off the shaping premium. It can never make an unshaped cast cheaper.'),
  // Enables Overflow **and relieves it** (spec 239). Both this and the
  // Intelligence 50 milestone granted the rate and the two summed, so arriving
  // at the milestone doubled the health an overflow cast costs. The rate is now
  // `SCALING`'s and the only thing either layer moves is the relief, which can
  // only ever shrink it -- so the two compose to a cheaper cast in every order.
  skill('int.overflow', 'intelligence', 'Arcane Overflow', T3, 1, 'casting without the resource',
    {
      traits: {
        overflowHealthPerResource: SCALING.intelligence.overflowHealthPerResource,
        overflowCostReduction: 0.25,
      },
    },
    'The pool is not the limit. Your health is, and it is a real one.'),

  // ==================== CONSTITUTION ======================
  skill('con.deepReserves', 'constitution', 'Deep Reserves', T1, 3, 'passive',
    { maxHealth: 25, traits: { maxPoise: 8 } },
    'More to lose before any of it matters.'),
  skill('con.steadyFrame', 'constitution', 'Steady Frame', T1, 3, 'while not casting',
    { traits: { poiseRegenPct: 0.4 } },
    'A moment not swinging is a moment getting your feet back.'),
  skill('con.secondWind', 'constitution', 'Second Wind', T2, 3, 'dropping below 30% health',
    { traits: { secondWindBelow: 0, secondWindHeal: 0.12 } },
    'One comeback. It will not fire again until you have climbed back out.'),
  // Damage reduction, and **only** damage reduction (spec 239). `isResolute`
  // gated the reduction and the immunity to guard breaks together, and
  // `deriveTraits` inferred the threshold from the reduction -- so this skill
  // silently handed out complete stagger immunity below 30% health, which is
  // the Constitution 35 milestone's stated, qualitative payoff. A tooltip
  // should describe what a skill grants.
  skill('con.hardToKill', 'constitution', 'Hard to Kill', T2, 3, 'below 30% health',
    // 0.06 a rank: `resoluteReduction` is capped at 0.4 and the Constitution 35
    // milestone grants 0.2, so at 0.08 rank 3 was half swallowed by the cap.
    // 0.2 + 3 x 0.06 is 0.38, under it, so every rank is worth its whole step.
    { traits: { resoluteReduction: 0.06 } },
    'The execute range is where you get harder, not softer.'),
  skill('con.sustainedEffort', 'constitution', 'Sustained Effort', T2, 3, 'while staggered',
    { traits: { poiseRegenStaggered: 0.25 } },
    'You are already getting up while you are still going down.'),
  skill('con.overflowVitality', 'constitution', 'Overflow Vitality', T3, 1, 'healing past full',
    { traits: { overhealShieldTicks: SCALING.constitution.shieldTicks } },
    'What a heal cannot fit becomes a buffer instead of nothing.'),

  // ===================== PERCEPTION =======================
  skill('per.weakPointStudy', 'perception', 'Weak-Point Study', T1, 3, 'every blow',
    { traits: { weakPointChance: 0.04 } },
    'You know where the seams are.'),
  // `grantsOpeningRead`, and a real share of the payoff (spec 239). This
  // granted a longer Vulnerable window and a factor of **0**, and the window is
  // gated on the factor -- so from Perception 10 to Perception 35 the skill was
  // three purchasable ranks of nothing whatsoever. The window is the skill's
  // (Vulnerable is a fact about the target); exploiting it is Perception's, so
  // the milestone still owns most of the factor.
  skill('per.openingRead', 'perception', 'Opening Read', T1, 3, 'an enemy committing an attack',
    {
      traits: {
        grantsOpeningRead: 1,
        openingReadTicks: Math.round(SCALING.perception.openingReadTicks * 0.25),
        vulnerableWeakPointFactor: 0.15,
      },
    },
    'A committed enemy has told you something. The window stays open longer, and you use it better.'),
  skill('per.steadyAim', 'perception', 'Steady Aim', T2, 3, 'after half a second without moving',
    { traits: { steadyAimPct: 0.12, steadyAimTicks: 0 } },
    'Standing still is a cost. This is what it buys.'),
  skill('per.huntersEye', 'perception', 'Hunter’s Eye', T2, 3, 'passive',
    { traits: { exposeTicks: 30 } },
    'What you have marked stays marked, for everyone.'),
  skill('per.exploit', 'perception', 'Exploit', T2, 3, 'weak point on an already-Exposed target',
    { traits: { exploitDamagePct: 0.25 } },
    'The first hit finds it. The second one uses it.'),
  skill('per.resourceSense', 'perception', 'Resource Sense', T3, 1, 'on a weak-point hit',
    { traits: { weakPointResource: 3, weakPointKillHeal: 0.06 } },
    'Precision pays for itself. Nothing else here heals you.'),

  // ======================= WISDOM =========================
  skill('wis.discipline', 'wisdom', 'Resource Discipline', T1, 3, 'passive',
    { traits: { costReduction: 0.06 } },
    'The same pool, more casts.'),
  skill('wis.measuredRecovery', 'wisdom', 'Measured Recovery', T1, 3, 'receiving healing',
    { traits: { healingPct: 0.12 } },
    'Every restorative thing works better on you. It does not make you need one.'),
  skill('wis.mastery', 'wisdom', 'Mastery', T2, 3, 'passive',
    { traits: { masteryRelief: 1 } },
    'The advanced techniques of every attribute open a point early, per level.'),
  // 0.04 a rank (spec 239). `attunedCostPct` is capped at 0.2 and the Wisdom 20
  // milestone already grants 0.08, so at 0.07 rank 2 was half wasted and rank 3
  // was worth nothing -- a rank you could buy, at the tier where the skill first
  // becomes purchasable, whose effective delta was zero. 0.08 + 3 x 0.04 is the
  // cap exactly, so every rank moves the number and the ceiling is still reached.
  //
  // `attunedTicks` is gone from the grant: it was 0, which is what a field that
  // wants the base rather than a delta says, and the base is `SCALING`'s.
  skill('wis.conservation', 'wisdom', 'Conservation', T2, 3, 'an ability that connects',
    { traits: { attunedCostPct: 0.04 } },
    'A cast that did something makes the next one cheaper. A wasted one does not.'),
  // `grantsAdaptation` (spec 239). This granted a per-stack size and neither a
  // window nor a cap, and Adaptation needs both to do anything -- `markTarget`
  // records a stack only with a window and `adaptationAgainst` reads one only
  // under a cap. Three ranks of nothing from Wisdom 25 to Wisdom 35.
  skill('wis.adaptation', 'wisdom', 'Adaptation', T2, 3, 'taking the same ability twice',
    { traits: { grantsAdaptation: 1, adaptationPerStack: 0.04 } },
    'Nothing gets to hurt you the same way three times.'),
  skill('wis.conversion', 'wisdom', 'Conversion', T3, 1, 'healing past full',
    { traits: { conversionCap: SCALING.wisdom.conversionCap } },
    'Overflow goes somewhere useful. Capped, so it is a valve and not a loop.'),
];

export const ALL_SKILLS: readonly SkillDefinition[] = DEFINITIONS;

export const SKILLS: ReadonlyMap<string, SkillDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function skillById(id: string): SkillDefinition | null {
  return SKILLS.get(id) ?? null;
}

/** Every stat skill for one attribute, in tier then id order. */
export function skillsFor(attribute: AttributeKey): readonly SkillDefinition[] {
  return DEFINITIONS.filter((definition) => definition.attribute === attribute)
    .slice()
    .sort((a, b) => a.tier - b.tier || (a.id < b.id ? -1 : 1));
}
