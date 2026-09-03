/**
 * Thirty-six milestone specializations, six per attribute (spec 244).
 *
 * A specialization is a mechanic a **milestone on an attribute track** makes
 * available, bought in tiers out of the one progression pool. It was a "skill"
 * spending its own separate currency (spec 147); the mechanics are unchanged and
 * the thresholds have not moved, so what this rename buys is two things:
 *
 *  - **The word.** "Skill" already meant the four *active* abilities a character
 *    equips (`skill1..skill4`, `activeSkillId`, `SkillSlot`). Two unrelated
 *    systems shared it and shared nothing else.
 *  - **The economy.** A tier now competes with an attribute point, which is the
 *    decision the progression system exists to present.
 *
 * The properties that made this table right are the ones it keeps:
 *
 *  - **Nothing forecloses anything.** A character with tiers in Strength and
 *    Intelligence specializations is a build, not a mistake.
 *  - **The gate is an attribute, not a point count.** `requires` is "you need
 *    this much Strength", so what opens a specialization is the build you have
 *    actually made rather than how much you have already spent in the same
 *    column.
 *  - **Every row names a trigger.** `trigger` is not flavour: it is the review
 *    criterion. A row whose trigger is "passive" and whose grant is a percentage
 *    is a row that failed, and there are six of them here on purpose -- the
 *    numerical-competence tier -- against thirty that fire on something.
 *
 * Six per attribute, at three thresholds: two at 10 (competence), three at 25
 * (identity) and one at 40 (the qualitative one). Every one of the eighteen
 * *automatic* milestones at 20/35/50 shares its name with a row here and
 * deepens it -- see `MilestoneDefinition.deepens`.
 *
 * Pure data.
 */

import type { AttributeKey } from './attributes.js';
import type { StatModifier } from './modifiers.js';
import { MILESTONE_THRESHOLDS, SCALING, SPECIALIZATION_THRESHOLDS } from './scaling.js';

export interface SpecializationDefinition {
  readonly id: string;
  readonly attribute: AttributeKey;
  readonly name: string;
  /** The milestone that unlocks it: the attribute value needed before tier 1. */
  readonly requires: number;
  /** Which of {@link SPECIALIZATION_THRESHOLDS} this sits on: 1, 2 or 3. */
  readonly tier: number;
  /** Tiers that may be bought. */
  readonly maxTier: number;
  /** When it fires. "passive" is allowed and is a deliberate minority. */
  readonly trigger: string;
  /** What one tier is worth; the total is this times the tiers held. */
  readonly perTier: StatModifier;
  /**
   * Points one tier costs. Absent means 1, and every row is absent.
   *
   * Here so that a variable cost is a data edit rather than a schema change --
   * the whole reason it is optional is that inventing a cost curve now would be
   * tuning a system nobody has played. `costOfNextTier` is the only reader.
   */
  readonly costPerTier?: number;
  readonly description: string;
}

/**
 * What one more tier costs.
 *
 * Beside the field it reads rather than in `player/specializations.ts`, since
 * spec 273 gave `data/presets.ts` a second reason to ask -- and a content module
 * reaching up into `player/` to find out what its own row costs is the wrong way
 * round. Re-exported from there, so no caller moved.
 */
export function costOfNextTier(specialization: SpecializationDefinition): number {
  return Math.max(1, Math.floor(specialization.costPerTier ?? 1));
}

const [T1, T2, T3] = SPECIALIZATION_THRESHOLDS as [number, number, number];

/**
 * Where Constitution's mastery rows sit (spec 273).
 *
 * The last milestone threshold rather than a fourth number of its own, so the
 * track gains depth without gaining a shape the other five do not have.
 */
const MASTERY = MILESTONE_THRESHOLDS[2] as number;

function thresholdTierOf(requires: number): number {
  if (requires >= T3) return 3;
  if (requires >= T2) return 2;
  return 1;
}

function specialization(
  id: string,
  attribute: AttributeKey,
  name: string,
  requires: number,
  maxTier: number,
  trigger: string,
  perTier: StatModifier,
  description: string,
  costPerTier?: number,
): SpecializationDefinition {
  const row = { id, attribute, name, requires, tier: thresholdTierOf(requires), maxTier, trigger, perTier, description };
  return costPerTier === undefined ? row : { ...row, costPerTier };
}

const DEFINITIONS: readonly SpecializationDefinition[] = [
  // ======================= STRENGTH =======================
  specialization('str.crushingBlows', 'strength', 'Crushing Blows', T1, 3, 'every blow',
    { traits: { poiseDamagePct: 0.18 } },
    "Your blows carry more weight against an enemy's guard."),
  // 0.08 a tier rather than 0.2 (spec 239). Four sources feed `windupPoiseArmor`
  // and it is capped at 0.9: at 0.2 a tier they summed to 2.0, so the Strength
  // 35 milestone alone pre-spent two thirds of the cap and tier 3 of this was
  // worth nothing at all -- and past Strength 50 the milestones filled it and
  // every tier was. The four now sum to exactly 0.9, so a fully-invested
  // Strength character ends where they always did and every step on the way
  // there is a step.
  specialization('str.committedSwing', 'strength', 'Committed Swing', T1, 3, 'while winding up an attack',
    { traits: { windupPoiseArmor: 0.08 } },
    'Harder to knock out of a swing you have already started.'),
  specialization('str.followThrough', 'strength', 'Brutal Follow-Through', T2, 3, "on breaking an enemy's guard",
    { traits: { momentumTicks: Math.round(SCALING.agility.flowTicks * 0.5), momentumWindupScale: 0.12 } },
    'A break opens a window: your next blow starts faster.'),
  // **Heavy Handling was here, and it did nothing** (spec 271). Its consumer was
  // `ability.damage >= HEAVY_ABILITY_DAMAGE`, a threshold spec 217 set to 6 so
  // that `melee.heavy` (damage exactly 6) would keep clearing it -- and spec 237
  // then deleted `melee.heavy` as one of seven rows nothing granted. It was the
  // only row that ever cleared the bar, so from that commit three purchasable
  // points bought a number nothing multiplied. Every test stayed green, and
  // `audit:progression` reported it ACTIVE, because the derived value does move:
  // what nothing checked was whether any content could reach the branch reading
  // it.
  //
  // Executioner is the replacement rather than a lowered threshold, because
  // moving the bar until one current ability happens to qualify is a number
  // chosen to make a row true rather than a mechanic anybody asked for. What the
  // tree was actually missing is the step between the break and the kill: it
  // could pressure a Guard, break it, and take the tempo, and then had nothing
  // that cared whether the body in front of it was already beaten.
  //
  // The condition is the loop's own: `blow.ts` has read
  // `executeBonus > 0 && staggered && healthFraction <= executeBelow` since spec
  // 147 and nothing has granted it since spec 244 deleted the pair that did.
  // Staggered *and* low, never low alone -- a flat bonus against hurt enemies is
  // a damage passive that any attribute could carry, and what makes this
  // Strength's is that the target is only staggered because Strength put it
  // there.
  //
  // Both numbers move per tier and that is the whole progression: more payoff,
  // and a wider window to collect it in. Three tiers reach +36% inside 30% of a
  // health bar.
  specialization('str.executioner', 'strength', 'Executioner', T2, 3, 'against a staggered target below the threshold',
    { traits: { executeBonus: 0.12, executeBelow: 0.1 } },
    'I broke you. Now I finish you.'),
  // **Renamed from "Overkill" (spec 271), id unchanged because it is persisted.**
  // `data/restoration.ts` has a separate `bonus.overkill` -- a *health* reward,
  // scaled by the Strength attribute rather than by this row -- and it is the
  // largest sustain source a Strength build has. Two mechanics called the same
  // word, paying different currencies off the same excess, is a tooltip a player
  // cannot reason about.
  specialization('str.overkill', 'strength', 'Brutal Reserve', T2, 3, 'on a kill that overkilled by a quarter',
    { traits: { overkillResource: 4 } },
    'Force spent past what was needed comes back to you.'),
  // `juggernautBelow` went with spec 271. It was a health gate on the all-cast
  // armour below, from the Strength+Constitution pair spec 244 deleted, and its
  // only surviving grant set it to exactly 1 -- "always" -- so the branch
  // reading it could never run. Granting it was the capstone shipping a third
  // effect that could not evaluate; the two that remain are what the row has
  // always actually done.
  specialization('str.unstoppable', 'strength', 'Unstoppable', T3, 1, 'while committed to any cast',
    { traits: { windupPoiseArmor: 0.12, poiseArmorAllCasts: 1 } },
    'Nothing takes you off a blow you have committed to. Only while you are committed.'),

  // ======================= AGILITY ========================
  // The three rows below are one mechanic seen three ways (spec 258): a
  // follow-through is committed until its cancel point, Quick Recovery moves
  // that point earlier, Flow moves it earlier again while it is held, and Mobile
  // Offense is what pays for the cancel itself. None of them shortens the
  // follow-through, which is what they used to do and what made them cancel each
  // other out -- a shorter phase is a smaller window to be good at leaving.
  specialization('agi.quickRecovery', 'agility', 'Quick Recovery', T1, 3, 'passive',
    { traits: { backswingCancelReduction: 0.05 } },
    'You may break out of a follow-through sooner. You do not attack more often.'),
  // Cooldown, not recovery (spec 254). This used to grant Flow and a slice of
  // Flow's own backswing reduction, which made the loop a circle: cancel the
  // follow-through, gain Flow, have the follow-through shortened. The player
  // has already left the recovery by the time the reward lands, so the payout
  // was the thing they had just declined to spend -- and it shrank the window
  // the trigger is read in, since a shorter backswing is fewer ticks in which
  // `cancelBackswing` can be reached at all.
  //
  // Spec 258 closed the other half of that circle: the follow-through is a
  // fixed length now and what Agility buys is the tick it may be *left* on, so
  // nothing in this tree can shrink the window the trigger is read in any more.
  // The trigger itself is unchanged and is the right one: leaving a
  // follow-through costs nothing mechanically, demands attention to a phase
  // boundary, and can never buy attacks per second (spec 144). What it buys is
  // time off the active abilities, which is a reward for the *next* decision
  // rather than a refund of the one just made.
  specialization('agi.mobileOffense', 'agility', 'Mobile Offense', T1, 3, 'on cancelling a follow-through',
    { traits: { mobileOffenseCooldownTicks: SCALING.agility.mobileOffenseCooldownTicks } },
    'Leaving a follow-through early puts every ability you are waiting on back in your hands sooner.'),
  specialization('agi.lightfoot', 'agility', 'Lightfoot', T2, 3, 'passive',
    { moveSpeed: 6, armor: 0.008 },
    'Footwork that is worth something even when it does not avoid the blow.'),
  specialization('agi.rapidHandling', 'agility', 'Rapid Handling', T2, 3, 'casting an ability that launches something',
    { traits: { handlingReduction: 0.12 } },
    'Draw, load and release. The cadence does not move.'),
  // 0.01 a tier rather than 0.005 (spec 258, after 254). Flow's contribution to
  // the cancel point is 0.05 a stack in total and it now comes from **two**
  // sources rather than four: this and the milestone that introduces Flow at
  // all. Mobile Offense used to be one of the other two and buys cooldown now,
  // so the number moved to keep the budget where it was measured rather than to
  // retune anything.
  specialization('agi.flow', 'agility', 'Flow', T2, 3, 'while Flow is held',
    { traits: { flowBackswingCancelPct: 0.01, flowDurationPct: 0.12 } },
    'Kept moving, kept swinging: each stack lets you leave the next follow-through sooner.'),
  specialization('agi.perfectExit', 'agility', 'Perfect Exit', T3, 1, 'withdrawing just after being hit',
    { traits: { perfectExitResource: 5, perfectExitWindowTicks: Math.round(SCALING.agility.flowTicks / 6) } },
    'Reading a blow and stepping out of your own turns the exchange around.'),

  // ===================== INTELLIGENCE =====================
  // `int.potency` stood here until spec 270 and was +5% spell power a tier: the
  // one row in the Intelligence tree whose trigger was `passive` and whose grant
  // was a percentage, which is the shape this file's own header calls a row that
  // failed. Advancing Intelligence is already how you get more spell power, so
  // the slot was buying a second, slower copy of the attribute.
  specialization('int.weaving', 'intelligence', 'Arcane Weaving', T1, 3, 'casting a different ability than the last',
    { traits: { grantsWeave: 1, weaveEffectPct: 0.09 } },
    'Vary what you throw and every affliction you land bites harder.'),
  specialization('int.shaping', 'intelligence', 'Spell Shaping', T1, 3, 'ground and projectile abilities',
    { traits: { spellRadiusPct: 0.08, spellRangePct: 0.05, shapingCostPct: 0.1 } },
    'Wider and further, and you pay for the space you take.'),
  // `grantsPrepared` (spec 239). Both of its numbers are *reductions*, so
  // before this the specialization's only effect on `deriveTraits`' old gate
  // (`preparedWindupScale > 0`) was to fail it -- Prepared did not exist for a
  // character who had bought the specialization improving Prepared, and would not until
  // the Intelligence 35 milestone.
  specialization('int.prepared', 'intelligence', 'Prepared Casting', T2, 3, 'after standing still',
    {
      traits: {
        grantsPrepared: 1,
        prepareTicks: -SCALING.intelligence.prepareTierRelief,
        // -0.06 rather than -0.08: the scale is floored at 0.2, and with the
        // milestone's -0.1 on top of a 0.5 base, -0.08 a tier put tier 3
        // through the floor and made half of it disappear. Three tiers and the
        // milestone now land at 0.22, so every tier is worth its whole step.
        preparedWindupScale: -0.06,
      },
    },
    'Less stillness to prime, and a sharper opener when you do.'),
  // `appliesSundered: 1` rather than `: 0` (spec 270). The zero was a *socket* --
  // a documented "this row is about that trait" whose magnitude was to come from
  // a pair -- and spec 244 deleted the pairs, so it sat in a purchasable row
  // describing a mechanic nobody could reach. It is the row's own second half
  // now: `blow.ts` sunders a target that is **already afflicted**, which is this
  // specialization's stated trigger rather than a basic-attack rule bolted to it.
  specialization('int.catalysis', 'intelligence', 'Catalysis', T2, 3, 'hitting anything already afflicted',
    { traits: { vsAfflictedPct: 0.08, appliesSundered: 1 } },
    'Statuses are fuel. What is already suffering suffers more, and its armour gives.'),
  // 0.2 a tier rather than 0.4 (spec 270). Three tiers reach
  // `shapingReliefCap` exactly, so every tier delivers its whole step -- at 0.4
  // the sum was 1.2 into a clamp of 1, which wasted half of tier 3 and, worse,
  // left the premium at exactly zero: a shaped cast cost what an unshaped one
  // cost, and the drawback the signature specialization is built around stopped
  // existing for anybody who finished the track.
  specialization('int.efficientConstruction', 'intelligence', 'Efficient Construction', T2, 3, 'passive',
    { traits: { shapingCostRelief: 0.2 } },
    'Pays down the shaping premium. Space is always dearer than no space.'),
  // Enables Overflow **and relieves it** (spec 239). Both this and the
  // Intelligence 50 milestone granted the rate and the two summed, so arriving
  // at the milestone doubled the health an overflow cast costs. The rate is now
  // `SCALING`'s and the only thing either layer moves is the relief, which can
  // only ever shrink it -- so the two compose to a cheaper cast in every order.
  specialization('int.overflow', 'intelligence', 'Arcane Overflow', T3, 1, 'casting without the resource',
    {
      traits: {
        overflowHealthPerResource: SCALING.intelligence.overflowHealthPerResource,
        overflowCostReduction: 0.25,
      },
    },
    'The pool is not the limit. Your health is, and it is a real one.'),

  // ==================== CONSTITUTION ======================
  specialization('con.deepReserves', 'constitution', 'Deep Reserves', T1, 3, 'passive',
    { maxHealth: 25, traits: { maxPoise: 8 } },
    'More to lose before any of it matters.'),
  // The trigger says what the grant does (spec 273). It read `while not casting`,
  // and `poiseRegenPct` multiplies the *base* rate -- so it reaches the moving,
  // committed and staggered branches too, and the not-casting condition belongs
  // to the CON 20 milestone's `poiseRegenCalm` rather than to this.
  //
  // The moving grant is the other half of the same fix. `regenPoise` used to zero
  // the rate outright on any tick the body moved, so a rank of this was worth
  // nothing at all to a repositioning player; movement is a fraction now, and
  // this is the specialization that buys some of it back.
  specialization('con.steadyFrame', 'constitution', 'Steady Frame', T1, 3, 'always -- most while holding ground',
    { traits: { poiseRegenPct: 0.4, poiseRegenMoving: 0.05 } },
    'A moment not swinging is a moment getting your feet back -- and you never fully stop getting them back.'),
  // The lifecycle is on the `secondWindHeal` label in `data/description.ts`,
  // where it is derived (spec 243). It used to be the second sentence here --
  // "it will not fire again until you have climbed back out" -- which was the
  // rule until spec 239 made the reset a rest or a death, and which then went
  // on being shown for four specs. Flavour is flavour: it is the one text in
  // this file with nothing keeping it true.
  specialization('con.secondWind', 'constitution', 'Second Wind', T2, 3, 'dropping below 30% health',
    { traits: { secondWindBelow: 0, secondWindHeal: 0.12 } },
    'One comeback, and the body only has the one.'),
  // Damage reduction, and **only** damage reduction (spec 239). `isResolute`
  // gated the reduction and the immunity to guard breaks together, and
  // `deriveTraits` inferred the threshold from the reduction -- so this specialization
  // silently handed out complete stagger immunity below 30% health, which is
  // the Constitution 35 milestone's stated, qualitative payoff. A tooltip
  // should describe what a specialization grants.
  specialization('con.hardToKill', 'constitution', 'Hard to Kill', T2, 3, 'below 30% health',
    // 0.06 a tier: `resoluteReduction` is capped at 0.4 and the Constitution 35
    // milestone grants 0.2, so at 0.08 tier 3 was half swallowed by the cap.
    // 0.2 + 3 x 0.06 is 0.38, under it, so every tier is worth its whole step.
    { traits: { resoluteReduction: 0.06 } },
    'The execute range is where you get harder, not softer.'),
  specialization('con.sustainedEffort', 'constitution', 'Sustained Effort', T2, 3, 'while staggered',
    { traits: { poiseRegenStaggered: 0.25 } },
    'You are already getting up while you are still going down.'),
  specialization('con.overflowVitality', 'constitution', 'Overflow Vitality', T3, 1, 'healing past full',
    { traits: { overhealShieldTicks: SCALING.constitution.shieldTicks } },
    'What a heal cannot fit becomes a buffer instead of nothing.'),

  // --- Constitution mastery (spec 273) ------------------------------------
  //
  // The track was complete at level 18 of 60 -- 55 attribute points to the cap
  // plus sixteen tiers is 71 of the 242 a level-60 character has -- and there was
  // no Constitution purchase at level 40 that a level-18 character had not
  // already made. These three are what a player who wants to keep investing buys
  // instead, and each one deepens a mechanic the track already has rather than
  // adding a mechanic beside it.
  //
  // Three decisions about their shape.
  //
  // They sit at `MASTERY`, which is the CON 50 threshold the Overflow Vitality
  // milestone is already on. `TrackNode` has always allowed a node to carry both
  // an automatic milestone and purchasable rows -- "which kinds of thing hang off
  // it is the tables' business" -- so the capstone threshold becomes the place
  // deep investment continues rather than the place it stops.
  //
  // They are **priced above 1**, through the `costPerTier` field that has been on
  // this interface since spec 244 with no row using it and `costOfNextTier` as
  // its only reader. A late purchase competing with two or four attribute points
  // is the decision the one-pool economy exists to present; a 1-point mastery
  // would be strictly better than the attribute point beside it.
  //
  // And none of them is a bigger number. Two grant a capability or a ceiling and
  // one deepens a fraction that changes which posture a fight is played in --
  // which is the bar spec 273 set against filler, and the reason there are three
  // of these rather than one per mechanic. Sustained Effort has no mastery here
  // on purpose: `applyPoiseDamage` refills the pool whole on a break, so
  // `poiseRegenStaggered` only ever reaches poise drained by blows landing
  // *inside* the stagger window, and a mastery built on that would be a mastery
  // of a mechanic whose base is thinner than it looks. Measured and written down
  // rather than built on.
  specialization('con.unbroken', 'constitution', 'Unbroken Stride', MASTERY, 3, 'while moving',
    { traits: { poiseRegenMoving: 0.1 } },
    'Ground given up is not recovery given up.', 2),
  specialization('con.deathsDoor', 'constitution', "Death's Door", MASTERY, 1, 'below 30% health',
    { traits: { resoluteRegenCalm: 1 } },
    'Down there, nothing you do costs you your guard.', 4),
  specialization('con.deepWell', 'constitution', 'Deep Well', MASTERY, 3, 'healing past full',
    { traits: { overhealShieldPct: 0.08 } },
    'More of what you cannot use now keeps for later.', 2),

  // ===================== PERCEPTION =======================
  specialization('per.weakPointStudy', 'perception', 'Weak-Point Study', T1, 3, 'every blow',
    { traits: { weakPointChance: 0.04 } },
    'You know where the seams are.'),
  // `grantsOpeningRead`, and a real share of the payoff (spec 239). This
  // granted a longer Vulnerable window and a factor of **0**, and the window is
  // gated on the factor -- so from Perception 10 to Perception 35 it was
  // three purchasable tiers of nothing whatsoever. The window is the specialization's
  // (Vulnerable is a fact about the target); exploiting it is Perception's, so
  // the milestone still owns most of the factor.
  specialization('per.openingRead', 'perception', 'Opening Read', T1, 3, 'an enemy committing an attack',
    {
      traits: {
        grantsOpeningRead: 1,
        openingReadTicks: Math.round(SCALING.perception.openingReadTicks * 0.25),
        // A share of the remaining probability rather than a multiplier
        // (spec 272), so this and Weak-Point Study compose instead of competing
        // for one clamp. The milestone still owns most of it.
        openingReadFactor: 0.06,
      },
    },
    'A committed enemy has told you something. The window stays open longer, and you use it better.'),
  // **Patient Read replaces Steady Aim** (spec 272). That one read
  // `tick - stillSinceTick` at the instant of impact, and `startCast` stamps
  // that field while `advanceProgression` re-stamps it every tick a cast is
  // live -- in pass 1c, where casts resolve in pass 3 of the same tick. The
  // gate needed 30 and was handed 0 in all 153 sampled blows: not rare,
  // unsatisfiable. Three purchasable tiers worth nothing.
  //
  // Replaced rather than repaired, because the repaired version would have been
  // Intelligence's. Prepared already owns "stand still, gain casting tempo"
  // (spec 270); the cost here is **offensive pressure** instead, so a Perception
  // character may move, reposition, dodge and track the whole time and pays in
  // the attacks they did not throw.
  specialization('per.patientRead', 'perception', 'Patient Read', T2, 3, 'a weak point after not attacking',
    { traits: { patientReadPayoffPct: 0.35 } },
    'Wait, and watch. The next seam you find is worth far more than the ones you swing through.'),
  specialization('per.huntersEye', 'perception', "Hunter's Eye", T2, 3, 'passive',
    { traits: { exposeTicks: 30 } },
    'What you have marked stays marked, for everyone.'),
  specialization('per.exploit', 'perception', 'Exploit', T2, 3, 'weak point on an already-Exposed target',
    { traits: { exploitDamagePct: 0.25 } },
    'The first hit finds it. The second one uses it.'),
  specialization('per.resourceSense', 'perception', 'Resource Sense', T3, 1, 'on a weak-point hit',
    { traits: { weakPointResource: 3, weakPointKillHeal: 0.06 } },
    'Precision pays for itself. Nothing else here heals you.'),

  // ======================= WISDOM =========================
  // Spec 274. Conservation sits at T1 so that the milestone above it deepens
  // the specialization that owns Attuned: the WIS 20 milestone used to grant
  // the Attuned family while naming `wis.discipline`, which granted
  // `costReduction` -- the same name over two mechanics with no trait in
  // common. Resource Discipline itself is gone: three tiers of passive cost
  // reduction on an economy that closes at WIS 13 was the clearest example of
  // the branch spending points on a solved problem, and Conservation is where a
  // player specializes into cost now.
  specialization('wis.conservation', 'wisdom', 'Conservation', T1, 3, 'an ability that connects',
    { traits: { grantsAttuned: 1, attunedCostPct: 0.04 } },
    'A cast that did something makes the next one cheaper. A wasted one does not.'),
  specialization('wis.measuredRecovery', 'wisdom', 'Measured Recovery', T1, 3, 'receiving healing',
    { traits: { healingPct: 0.12 } },
    'Every restorative thing works better on you. It does not make you need one.'),
  // Composure replaces Resource Discipline, and `cooldownReduction` is the hook
  // it was written for: `deriveTraits` already multiplies the term into
  // `cooldownScale`, and until now nothing in the game granted it -- so the one
  // attribute whose own row claims "cooldowns" had no purchasable cooldown
  // content at all. 0.05 a tier against the attribute's own 0.752 at the cap
  // takes a fully invested body to 0.639, well clear of both floors.
  //
  // It reaches active abilities and nothing else *structurally* rather than by
  // a guard: `cooldownScaleFor` is called from `attackTimingFor`'s non-basic
  // branch alone, and a basic attack's interval is `baseAttackTimeTicks`.
  specialization('wis.composure', 'wisdom', 'Composure', T2, 3, 'passive',
    { traits: { cooldownReduction: 0.05 } },
    'Something useful is always coming back.'),
  // Both halves are bought now (spec 275). The cap used to be granted by
  // nothing, so all three tiers and the milestone converged on 0.3 and deep
  // investment bought only hits-to-cap -- at Wisdom 35 tier 2 did not move even
  // that. Rate and ceiling together: 0.45 fully specialized, 0.50 with the
  // milestone.
  specialization('wis.adaptation', 'wisdom', 'Adaptation', T2, 3, 'taking the same ability twice',
    { traits: { grantsAdaptation: 1, adaptationPerStack: 0.03, adaptationCap: 0.05 } },
    'Nothing gets to hurt you the same way forever.'),
  // Mastery, rebuilt (spec 275). It used to relieve specialization thresholds,
  // which is meta-progression rather than combat -- roughly point-neutral, told
  // to the player only in flavour text, and its trait field replicated to every
  // client and read by nobody.
  //
  // What it is now is Adaptation's mirror, and the symmetry is the identity:
  // an enemy repeats something and Wisdom learns to resist it; you repeat
  // something and Wisdom learns to use it more efficiently. Per ability, earned
  // at the attack point, so a heal or a shield masters exactly as a blow does.
  specialization('wis.mastery', 'wisdom', 'Mastery', T2, 3, 'using the same ability again',
    { traits: { grantsMastery: 1, masteryCooldownPct: 0.02 } },
    'A tool you keep reaching for comes back to your hand sooner.'),
  // Conversion also deepens salvage since spec 275, which is what gives the T3
  // node something to do besides a second copy of the milestone's cap: the
  // attribute's own salvage curve is capped at 0.35 and this is the extreme
  // version of it.
  specialization('wis.conversion', 'wisdom', 'Conversion', T3, 1, 'healing past full',
    { traits: { conversionCap: SCALING.wisdom.conversionCap, salvagePct: 0.2 } },
    'Overflow goes somewhere useful. Capped, so it is a valve and not a loop.'),
];

export const ALL_SPECIALIZATIONS: readonly SpecializationDefinition[] = DEFINITIONS;

export const SPECIALIZATIONS: ReadonlyMap<string, SpecializationDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function specializationById(id: string): SpecializationDefinition | null {
  return SPECIALIZATIONS.get(id) ?? null;
}

/** Every specialization for one attribute, in threshold then id order. */
export function specializationsFor(attribute: AttributeKey): readonly SpecializationDefinition[] {
  return DEFINITIONS.filter((definition) => definition.attribute === attribute)
    .slice()
    .sort((a, b) => a.tier - b.tier || (a.id < b.id ? -1 : 1));
}
