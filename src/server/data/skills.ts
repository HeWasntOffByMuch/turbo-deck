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
  skill('str.committedSwing', 'strength', 'Committed Swing', T1, 3, 'while winding up an attack',
    { traits: { windupPoiseArmor: 0.2 } },
    'Harder to knock out of a swing you have already started.'),
  skill('str.followThrough', 'strength', 'Brutal Follow-Through', T2, 3, 'on breaking an enemy’s poise',
    { traits: { momentumTicks: Math.round(SCALING.agility.flowTicks * 0.5), momentumWindupScale: 0.12 } },
    'A break opens a window: your next blow starts faster.'),
  skill('str.heavyHandling', 'strength', 'Heavy Handling', T2, 3, 'casting a heavy ability',
    { traits: { heavyWindupReduction: 0.15 } },
    'Oversized weapons stop punishing you for their weight.'),
  skill('str.overkill', 'strength', 'Overkill', T2, 3, 'on a kill that overkilled by a quarter',
    { traits: { overkillResource: 4 } },
    'Force spent past what was needed comes back to you.'),
  skill('str.unstoppable', 'strength', 'Unstoppable', T3, 1, 'while committed to any cast',
    { traits: { windupPoiseArmor: 0.5, poiseArmorAllCasts: 1, juggernautBelow: 1 } },
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
  skill('int.prepared', 'intelligence', 'Prepared Casting', T2, 3, 'after standing still',
    { traits: { prepareTicks: -Math.round(SCALING.intelligence.prepareTicks * 0.15), preparedWindupScale: -0.08 } },
    'Less stillness to prime, and a sharper opener when you do.'),
  skill('int.catalysis', 'intelligence', 'Catalysis', T2, 3, 'hitting anything already afflicted',
    { traits: { vsAfflictedPct: 0.08, appliesSundered: 0 } },
    'Statuses are fuel. Anything already suffering suffers more.'),
  skill('int.efficientConstruction', 'intelligence', 'Efficient Construction', T2, 3, 'passive',
    { traits: { shapingCostRelief: 0.4 } },
    'Pays off the shaping premium. It can never make an unshaped cast cheaper.'),
  skill('int.overflow', 'intelligence', 'Arcane Overflow', T3, 1, 'casting without the resource',
    { traits: { overflowHealthPerResource: SCALING.intelligence.overflowHealthPerResource } },
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
  skill('con.hardToKill', 'constitution', 'Hard to Kill', T2, 3, 'below 30% health',
    { traits: { resoluteBelow: 0, resoluteReduction: 0.08 } },
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
  skill('per.openingRead', 'perception', 'Opening Read', T1, 3, 'an enemy committing an attack',
    { traits: { openingReadTicks: Math.round(SCALING.perception.openingReadTicks * 0.25), vulnerableWeakPointFactor: 0 } },
    'A committed enemy has told you something. The window stays open longer.'),
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
  skill('wis.conservation', 'wisdom', 'Conservation', T2, 3, 'an ability that connects',
    { traits: { attunedCostPct: 0.07, attunedTicks: 0 } },
    'A cast that did something makes the next one cheaper. A wasted one does not.'),
  skill('wis.adaptation', 'wisdom', 'Adaptation', T2, 3, 'taking the same ability twice',
    { traits: { adaptationPerStack: 0.04, adaptationTicks: 0 } },
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
