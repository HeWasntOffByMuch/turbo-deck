/**
 * Every coefficient the six attributes scale by, in one object (spec 147).
 *
 * The reason this is a table rather than numbers inlined into `derived.ts` is
 * the brief's last quality bar: *are the mechanics easy to tune through
 * centralized data/config*. A balance pass on this system should be a diff of
 * this file and nothing else, and a reviewer should be able to read what an
 * attribute is worth without reading the arithmetic that applies it.
 *
 * Three curve shapes, and only three, so a number here can be understood from
 * its shape alone:
 *
 *  - {@link linear} -- more of a thing, forever. For the stats where "twice the
 *    investment is twice the value" is actually true: health, pools, poise.
 *  - {@link softCap} -- linear to a knee, then a fraction of the rate. For the
 *    stats where an unbounded specialist would stop the game being a game, but
 *    where a cap would make the last twenty points worthless.
 *  - {@link reciprocal} -- `1 / (1 + attr * per)`, floored. For every "less of a
 *    thing" stat: cost, cooldown, animation length. It cannot reach zero, it has
 *    no negative branch, and its output means what it says -- 0.5 is *half*,
 *    where "-50%" invites the question of whether two of them is -100%.
 *
 * Pure, dependency-free, part of the deterministic core.
 */

import { SERVER_TICK_RATE } from '../config.js';

/** Seconds as whole ticks, rounding to nearest -- the convention everywhere. */
function seconds(value: number): number {
  return Math.max(0, Math.round(value * SERVER_TICK_RATE));
}

/** `attr * per`. The honest one. */
export function linear(attr: number, per: number): number {
  if (!Number.isFinite(attr) || !Number.isFinite(per)) return 0;
  return attr * per;
}

/**
 * Linear to `knee`, then `falloff` of the rate.
 *
 * Piecewise-linear rather than a smooth asymptote on purpose: a player can work
 * out what the next point is worth by reading two numbers, and a reviewer can
 * work out the value at the hard cap in their head. A smooth curve is prettier
 * and nobody can answer either question about it without a calculator.
 */
export function softCap(attr: number, per: number, knee: number, falloff: number): number {
  if (!Number.isFinite(attr) || attr <= 0) return 0;
  if (attr <= knee) return attr * per;
  return (knee + (attr - knee) * falloff) * per;
}

/**
 * How far past the starting value an attribute is.
 *
 * **The baseline rule** (spec 147). Every attribute starts at
 * {@link SCALING.startingAttribute}, so a coefficient applied to the raw value
 * would mean a brand-new character already had five points of every scale --
 * their wind-ups shorter than the ability table says, their costs lower than the
 * ability table says, their cooldowns shorter than the ability table says. Every
 * authored number in `data/abilities.ts` would describe a character that does
 * not exist.
 *
 * So the *scales* -- the reciprocal ones, and movement -- are measured from the
 * start, and a fresh character is exactly 1.0x on all of them: the content
 * tables say what actually happens to somebody who has spent nothing. The
 * *quantities* that predate this spec (health, the pool, armour, turn rate) stay
 * measured from zero, because their baselines are already load-bearing
 * elsewhere and re-basing them would move numbers this spec has no business
 * moving.
 */
export function above(attr: number): number {
  if (!Number.isFinite(attr)) return 0;
  return Math.max(0, attr - SCALING.startingAttribute);
}

/**
 * `1 / (1 + attr * per)`, held at or above `floor`.
 *
 * The multiplier form of "reduces X". Two sources of 30% reduction compose to
 * 0.7 * 0.7 rather than to zero, because each is a *factor* -- which is the
 * whole reason the reductions in this system are written as scales and not as
 * percentages to be subtracted.
 */
export function reciprocal(attr: number, per: number, floor: number): number {
  if (!Number.isFinite(attr) || !Number.isFinite(per)) return 1;
  const denominator = 1 + Math.max(0, attr) * per;
  if (!(denominator > 0)) return floor;
  return Math.max(floor, 1 / denominator);
}

/**
 * The whole balance surface.
 *
 * Read it as: for each attribute, what one point of it buys. Anything that is
 * *not* a per-point rate -- a threshold, a duration, a cap -- lives beside its
 * rate rather than in a separate constants file, because a rate whose cap is
 * three files away is a rate nobody can evaluate.
 */
export const SCALING = {
  /** What every character starts each attribute at, and the ceiling on one. */
  startingAttribute: 5,
  attributeHardCap: 60,
  /**
   * The whole progression award schedule (spec 244): points per level, and what
   * a fresh character has to place.
   *
   * One pool, so one schedule, and it is the two it replaced **summed** rather
   * than either of them kept: attributes granted 5 + 3/level and the skill tree
   * 1 + 1/level, so a level-20 character earned 82 points of purchasing power
   * across two currencies and earns exactly 82 across one. That is deliberately
   * a conversion and not a rebalance -- whether 4 a level is right for a pool
   * that now buys two things is a pacing question, and this is the one place to
   * answer it.
   */
  pointsPerLevel: 4,
  startingPoints: 6,
  /** Coins a full respec costs. Cheap enough to experiment, not free. */
  respecCost: 40,

  strength: {
    /**
     * Health per point.
     *
     * Half Constitution's rather than a tenth of it. A pure-Strength character
     * has to be able to reach what it is hitting, and the brief's rule is that
     * it must not be *forced* into Constitution -- so Strength buys enough
     * durability to close the distance and none of the tools to survive being
     * there.
     */
    healthPer: 1.5,
    /** Poise damage a blow carries: a base, plus a soft-capped rate. */
    staggerBase: 2,
    staggerPer: 0.225,
    staggerKnee: 40,
    staggerFalloff: 0.5,
    /** Poise contributed to one's own pool. */
    poisePer: 0.2,
    /**
     * How long a break **you cause** roots the body you broke: a floor plus a
     * rate, capped. Offence, like `staggerBase`/`staggerPer` above it.
     */
    staggerTicksBase: seconds(0.5),
    staggerTicksPer: 0.2,
    /**
     * **Unreachable at the current attribute cap, and kept deliberately** (spec
     * 271). The duration is `staggerTicksBase + staggerTicksPer * STR` measured
     * from zero, so it reaches 42 ticks at the hard cap of 60 and would need
     * Strength 90 to touch 48.
     *
     * Retained rather than removed because it bounds an *edit* as much as a
     * build: `admin:setAttribute` and a hand-edited save are not held to the
     * cap, and the number this guards is how long a body is rooted and unable
     * to answer. Written down here so the next reader does not spend an
     * afternoon working out why it never binds.
     */
    staggerTicksCap: seconds(0.8),
  },

  agility: {
    /** Wind-up and handling scales. Both reciprocal, both floored. */
    attackPointPer: 0.01,
    attackPointFloor: 0.5,
    handlingPer: 0.012,
    handlingFloor: 0.5,
    /**
     * The follow-through's **cancel point** (spec 258), and deliberately not its
     * length.
     *
     * Agility used to divide the backswing by a reciprocal here -- 45% off at the
     * cap -- while the rest of its tree paid the player for walking out of one.
     * The two ate each other: every point spent shortening the phase shrank the
     * window the Flow/Mobile Offense loop is played in. So the length is fixed
     * and Agility buys the boundary inside it. **Agility controls commitment; it
     * does not erase it.**
     *
     * `base` is how much of the follow-through is committed with no Agility at
     * all, `per` is what a point above the starting attribute takes off, and
     * `floor` is how committed a body always is however much is stacked on it.
     * Subtractive rather than reciprocal, because this is a fraction of a phase
     * rather than a multiplier on a duration: two sources of "10% sooner" should
     * be 20% sooner, and a reciprocal would quietly make them 19%.
     *
     * The budget, so that no purchase is ever bought into a filled cap: 0.11
     * from the attribute at the hard cap, 0.15 from Quick Recovery's three tiers
     * and 0.15 from three Flow stacks (0.05 a stack, from the Agility 20
     * milestone that grants Flow and the `agi.flow` specialization -- Mobile
     * Offense buys cooldown rather than Flow since spec 254), against the 0.45
     * between the base and the floor. That is 0.41 of it, so **nothing in the
     * shipped tree reaches the floor** -- the state `MIN_ATTACK_INTERVAL_SECONDS`
     * is in and the right one for a guard rather than a ceiling the tree is
     * priced against.
     *
     * The two thirds a player *buys* are worth more than the third the attribute
     * hands over, which is deliberate: controlling commitment is a thing to
     * build toward rather than a number that accrues.
     */
    backswingCancelBase: 0.7,
    backswingCancelPer: 0.002,
    backswingCancelFloor: 0.25,
    movePer: 0.6,
    /**
     * Turn rate per point.
     *
     * `TURN_RATE_PER_AGILITY` unchanged, and it must stay unchanged: spec 142's
     * turn ease derives its acceleration from `COMMIT_ALIGN_TICKS` against this
     * rate, and `world/turn-limits.ts` estimates a remote player's rate from the
     * same number. Retuning it here would silently re-time every drawn turn in
     * the game.
     */
    turnPer: 30,
    /** Armour per point -- half Constitution's, and the reason is footwork. */
    armorPer: 0.004,
    /** How long one `flow` stack lives, and how many may be held. */
    flowTicks: seconds(1.2),
    flowMaxStacks: 3,
    /**
     * Cooldown one tier of Mobile Offense takes off, per follow-through walked
     * out of (spec 254).
     *
     * Here rather than in the specialization row for the reason everything in
     * this file is here: what a tier is worth is a balance decision, and this
     * one is the number the whole mechanic turns on -- one cancel pays it to
     * *every* active ability that is cooling, so the same edit reaches the
     * milestone that deepens it and both ends of the balance harness.
     */
    mobileOffenseCooldownTicks: seconds(0.4),
  },

  intelligence: {
    /**
     * Resource pool per point (spec 270).
     *
     * 2 until this spec, which at the hard cap was a 145-point pool against
     * abilities costing 5 to 7 -- a magazine of roughly thirty casts, which is
     * not a magazine, it is an assumption that you will never reload. 1.4 keeps
     * Intelligence far and away the largest pool in the game (109 at the cap
     * against Wisdom's 65) while making the number of casts in it something a
     * player can count.
     */
    resourcePer: 1.4,
    /** Geometry. Gated behind the INT 20 milestone; zero until then. */
    radiusPer: 0.006,
    rangePer: 0.004,
    /** Extra damage against anything carrying a status. */
    vsAfflictedPer: 0.006,
    /** Health paid per point of missing resource by an overdraw cast. */
    overflowHealthPerResource: 2,
    /** Fraction of *current* health one overdraw cast may spend. */
    overflowHealthFraction: 0.4,
    /**
     * The artillery stance (spec 270): how long a body must stay planted before
     * `Prepared` is banked, and what counts as leaving.
     *
     * **The duration is the cost of the mechanic**, so it is authored where a
     * cost belongs rather than being whatever fell out of three reductions. At
     * 2s base a fully-invested caster lands at 1.95s -- the tiers buy a stance
     * that is *sharper*, not one that is nearly free. Before this spec the same
     * table bottomed out at 0.6s, which is not a decision anybody makes; it is
     * a proc that happens to them.
     */
    prepareTicks: seconds(2.75),
    /**
     * However much is stacked on it, a stance is never shorter than this.
     *
     * A real floor rather than the old `rate * 0.25` (0.25s), which existed to
     * stop a divide-by-nothing and would have let a future source turn the
     * stance back into a proc. Nothing in the shipped tree reaches it: three
     * tiers plus the milestone come to 1.95s against this 1.5s, which is the
     * state a guard should be in.
     */
    prepareFloorTicks: seconds(1.5),
    /**
     * What one Prepared Casting tier and the Intelligence 35 milestone each take
     * off the stance.
     *
     * **Absolute rather than a fraction of the base** (spec 270). They were
     * authored as `prepareTicks * 0.15` and `* 0.25`, so raising the base to
     * make the stance a real commitment would have raised the reductions with
     * it and landed in the same place -- the tuning knob quietly cancelling
     * itself. Stated in seconds, the base and what buys it down are two
     * decisions instead of one.
     *
     * 2.75s less 0.35s less three tiers of 0.15s is 1.95s: a caster who has
     * bought the whole row plants for two seconds rather than for a fifth of
     * one, and what the tiers bought is a sharper opener rather than an absent
     * cost.
     */
    prepareTierRelief: seconds(0.15),
    prepareMilestoneRelief: seconds(0.35),
    preparedWindupScale: 0.5,
    /**
     * How far a body may be displaced in one tick and still be standing still.
     *
     * The stance asks whether the *player chose to move*, and exact float
     * equality on position answers a different question: a body pressed against
     * a prop is pushed out of it by `resolveMovement` with a zero intent, and a
     * player given `bumps` would take crowd nudges as well. A walk is 2.58
     * units a tick at `MOVE_SPEED`, so this is about a seventh of one step --
     * far above any resolution jitter and far below anything a person would
     * call walking.
     */
    stanceMoveEpsilon: 0.35,
    /**
     * The most of the shaping premium Efficient Construction may ever pay off.
     *
     * Under 1 on purpose (spec 270). A specialization whose whole job is to
     * delete another specialization's drawback is not progression, it is an
     * apology for it -- so shaping stays more expensive than not shaping at
     * every level of investment, and what the tiers buy is how much more.
     * Three tiers of `shapingCostRelief: 0.2` reach exactly this, so every tier
     * is worth its whole step and none of it disappears into the clamp.
     */
    shapingReliefCap: 0.6,
    /** Arcane Weaving: how long a stack lives, and how many may be held. */
    weaveTicks: seconds(6),
    weaveMaxStacks: 3,
  },

  constitution: {
    healthPer: 3.5,
    poiseBase: 10,
    poisePer: 0.55,
    /** Poise per second, before the calm multiplier. */
    poiseRegenBase: 1,
    poiseRegenPer: 0.0875,
    /**
     * What a *moving* body keeps of its Guard regeneration (spec 273).
     *
     * It was not a fraction at all: `regenPoise` set the rate to **zero** on any
     * tick the body moved unless `poiseRegenMoving` was granted, and nothing in
     * the game granted it -- the branch's comment pointed at the
     * Agility+Constitution pair spec 244 deleted. So Steady Frame's three ranks
     * and the CON 20 milestone that deepens them were worth exactly zero to a
     * repositioning body, in a game whose thesis is committing to a blow and
     * withdrawing from it.
     *
     * A fraction rather than a switch, and 0.3 rather than a token: standing
     * still has to remain clearly the strongest recovery posture, and
     * repositioning has to remain a viable endurance tactic. Measured against
     * the real loop in `scripts/probe-constitution.ts`.
     *
     * This is the **player** baseline: `NEUTRAL_TRAITS` keeps 0 and
     * `monsterTraits` spreads it, so no monster gains Guard while chasing. A
     * monster that did would be a broad enemy rebalance and a nerf to
     * Strength's stagger pressure, which spec 273 explicitly is not.
     */
    poiseRegenMovingBase: 0.3,
    /**
     * And never more than this, however much is granted.
     *
     * Strictly below 1 so that moving can never match standing -- which is what
     * stops continuous kiting from refilling Guard as efficiently as
     * deliberately holding ground. Asserted rather than assumed.
     */
    poiseRegenMovingCap: 0.75,
    armorPer: 0.008,
    healingPer: 0.006,
    /**
     * The low-health band, named once (spec 273).
     *
     * Four literals sat at 0.3: `resoluteBelow`'s floor, `secondWindBelow`'s
     * floor, and the Hard to Kill milestone's `resoluteBelow` and
     * `staggerImmuneBelow`. They are the same number because they are the same
     * *band* -- the health at which Constitution's low-health identity turns on
     * -- and Second Wind's recovery ceiling is now a fifth reader of it.
     *
     * That last one is the reason this is a constant rather than four numbers
     * that happen to agree: Second Wind stabilizes the body at exactly the top
     * of the band, and `isResolute` compares with `<=`, so the mechanics the
     * threshold armed are all still on afterwards. Retuning the band moves the
     * ceiling with it, which is the only way that claim stays true.
     */
    dangerBelow: 0.3,
    /** Shield ceiling, as a fraction of max health. */
    shieldFraction: 0.25,
    shieldTicks: seconds(8),
  },

  perception: {
    weakPointPer: 0.006,
    weakPointCap: 0.6,
    weakPointMultBase: 1.5,
    weakPointMultPer: 0.012,
    critPer: 0.004,
    exposeTicksBase: seconds(1),
    exposeTicksPer: 1.8,
    /** What being `exposed` is worth to whoever exposed the target. */
    exposedDamagePct: 0.15,
    openingReadTicks: seconds(0.75),
    /**
     * What the Perception 35 milestone adds to the Vulnerable weak-point
     * factor, **as a bonus above 1** (spec 239).
     *
     * It was `vulnerableWeakPointFactor: 2` -- a *total* -- and the milestone
     * granted it while the skill granted 0, which is what made the skill inert:
     * a total cannot be shared between two layers without one of them knowing
     * what the other is. As a bonus the two simply add, and `deriveTraits`
     * turns the sum into a factor exactly once. 1.0 is still "double", so what
     * a Perception character with the milestone alone gets has not moved.
     */
    /**
     * Opening Read's share of the **remaining** probability (spec 272).
     *
     * It was `vulnerableWeakPointBonus`, a multiplier above 1, and the two
     * Perception lines therefore multiplied into one clamp: at Perception 60
     * with Weak-Point Study and Opening Read both maxed the raw chance was
     * 1.176 against a bare 0.95 ceiling, so 19% of a purchase was discarded
     * during exactly the window it was bought for.
     *
     * As a share of what is left -- `base + (1 - base) * factor` -- the two
     * compose instead. Two properties follow from the form rather than from
     * tuning, and both are tested: the derivative with respect to the base is
     * `1 - factor`, which is positive, so **every Weak-Point Study tier still
     * raises the final chance at maximum Opening Read**; and the highest legal
     * value is `weakPointCap + (1 - weakPointCap) * (this + 3 tiers)` = 0.892,
     * so legal progression provably cannot reach {@link WEAK_POINT_CHANCE_CAP}.
     *
     * 0.55 rather than a round number because it is **calibrated against what
     * this replaced**: the old form doubled the chance, so at Perception 60 with
     * the milestone alone it gave `0.36 x 2 = 0.72`, and `0.36 + 0.64 x 0.55` is
     * 0.712. A character who bought nothing but the attribute is therefore left
     * where they were, and what changes is that the purchases above them stop
     * being thrown away. Picking 0.3 first cost Pure Perception half its kills
     * in `npm run balance`, which is what measuring it caught.
     */
    openingReadShare: 0.55,
    /**
     * How long Perception must go **without committing an attack** for Patient
     * Read to bank (spec 272).
     *
     * Measured against the cadence rather than chosen: a worn sword commits
     * about every 66 ticks and the longest idle gap inside a continuous fight
     * is 29, so this is a little under two whole attacks given up. Short enough
     * to be worth doing, long enough that continuing to swing is a real
     * alternative rather than an obvious mistake.
     *
     * The cost is offensive pressure and **never movement** -- that space is
     * Intelligence's Prepared, which this must not duplicate.
     */
    patientReadTicks: seconds(1.75),
    /** How long a banked read keeps. Long enough to line a shot up, short
     *  enough that it cannot be carried between fights. */
    patientReadHoldTicks: seconds(8),
  },

  /**
   * Wisdom: making finite things last (spec 275).
   *
   * **There is no `resourcePer` here, and that is the ownership rule rather
   * than an omission**: INT owns the magazine and WIS owns making it last and
   * recovering it. Six automatic scales all pointed at the resource problem,
   * three of them the same lever, and a pool is the one of the three that
   * another attribute already had the primitive for. Removing it costs a pure
   * Wisdom character 55 points of pool and none of their regeneration, which
   * is the tension spec 275 wants: cooldowns come back faster than a small
   * magazine can pay for, and the answer is to spend on Intelligence.
   *
   * Every rate below is measured through `above()`. `healingPer` and
   * `regenPer` were on the raw attribute until 274, which is the case this
   * file's own header warns about -- a character who had spent nothing on
   * Wisdom carried +6% healing and +0.6/s of regeneration from it.
   */
  wisdom: {
    costPer: 0.01,
    costFloor: 0.4,
    cooldownPer: 0.006,
    cooldownFloor: 0.5,
    healingPer: 0.012,
    /**
     * Resource per second per point of Wisdom, **soft-capped** (spec 276).
     *
     * `resourcePer` used to sit above this and is gone (spec 275). Spec 270's
     * own sentence is *"Intelligence buys the magazine and Wisdom buys the
     * reload"*, and Wisdom was still quietly buying a point of magazine per
     * point spent; removing it is that split finished rather than a second
     * opinion about it. The two specs reached the same rule from opposite ends
     * -- 270 from the Intelligence economy being decorative, 275 from six
     * automatic Wisdom scales all pointing at one problem.
     *
     * What neither of them fixed is that this rate was **linear and unbounded**
     * against a demand with a hard ceiling. The greediest four-skill bar a
     * player can equip drains 3.38 resource/second -- it is the four highest
     * cost-per-cycle rows in the content table, and a body is rooted through its
     * own casts, so nothing can spend faster. At 0.2 a point the supply passed
     * that at about Wisdom 21 and reached **11.4/s at the hard cap, 3.4x the
     * most the game can spend**. Measured through
     * `scripts/probe-resource.ts`, the waste was visible from the other side
     * too: at Wisdom 40, 7.40/s was available and 2.15/s actually landed,
     * because the pool was at its ceiling. Every point past the crossover
     * bought nothing at all, and every other resource mechanic in the design --
     * capacity, efficiency, Conservation, Overdraw, combat-earned restoration
     * -- was measuring against a pool that was already full.
     *
     * {@link softCap} for the reason `staggerPer` and `weakPointPer` use it: an
     * unbounded specialist would stop the game being a game, and a hard cap
     * would make the last twenty points worthless. Measured against the same
     * bar, with both columns moving because Wisdom makes the bar cheaper too:
     *
     * ```
     *   WIS   regen/s   greedy drain/s   supply/demand
     *     5      1.00             3.38             30%
     *    15      1.25             3.24             39%
     *    25      1.50             2.37             63%
     *    40      1.71             2.25             76%
     *    60      2.00             2.13             94%
     * ```
     *
     * The property that makes it a design rather than a number: **the ratio
     * rises the whole way and never reaches 1.** Every point is worth
     * something, and no amount of the attribute alone makes the greediest bar
     * free -- what closes the last six percent is a *purchase*, which is where
     * Conservation belongs. Asserted in `resource-economy.test.ts` against the
     * content table rather than against a number typed into a test, so a
     * cheaper ability moves the claim.
     */
    regenPer: 0.025,
    /**
     * Where the reload's rate halves, and by how much.
     *
     * The knee sits at `above(WIS) = 20` -- Wisdom 25, the second
     * specialization threshold -- so the attribute is at its most generous
     * exactly over the range a character is climbing to reach Composure,
     * Adaptation and Mastery, and pays a diminishing rate for the deep
     * investment past it. `regenFalloff` is a shade over half rather than the
     * customary 0.5 so that the last twenty points still read as progress on
     * the sheet: 0.0138/s a point against 0.025.
     */
    regenKnee: 20,
    regenFalloff: 0.55,
    attunedTicks: seconds(6),
    attunedMaxStacks: 3,
    /**
     * The most one Attuned stack may be worth (spec 276).
     *
     * Here rather than as the literal `0.2` it was in `derived.ts`, for this
     * file's own stated reason: a rate whose cap is three files away is a rate
     * nobody can evaluate, and this one is a balance decision rather than a
     * guard. The three Conservation tiers and the Wisdom 20 milestone sum to it
     * *exactly*, so every tier moves the number and none of it disappears into
     * the clamp -- a property the milestone's own comment states and which only
     * holds while the grants and this move together.
     *
     * **Halved from 0.2** by the resource-economy pass. `Attuned` is a standing
     * six-second buff refreshed by every non-basic ability that connects rather
     * than a charge consumed by a cast, so any sustained rotation holds three
     * stacks permanently -- which made Conservation a flat 60% discount, nearly
     * twice the whole attribute curve's 35%, and took `WIS 40 + Conservation` to
     * a pool that was full 100% of a 150-second fight. At 0.1 three stacks are
     * 30% off: about what the attribute beside it is worth, which is what a
     * specialization should be, and enough to close the last six percent the
     * regeneration curve deliberately leaves open.
     */
    attunedCostCap: 0.1,
    adaptationTicks: seconds(10),
    /**
     * Where Adaptation starts, and no longer where it ends (spec 275).
     *
     * Every tier and the milestone used to converge here, because
     * `adaptationCap` was granted by nothing: deep investment bought
     * hits-to-cap and never the cap. Both layers grant it now, so a fully
     * specialized body reaches 0.5 -- inside `deriveTraits`' existing 0.6
     * clamp, which stays as the guard against a modifier rather than as a
     * number the tree is priced against.
     */
    adaptationCap: 0.3,
    conversionCap: 15,
    /**
     * Mastery: repeated use of one's own ability (spec 275).
     *
     * The mirror of Adaptation, and deliberately the same shape -- an enemy
     * repeats something and Wisdom learns to resist it; you repeat something
     * and Wisdom learns to use it more efficiently. Both are keyed per ability
     * id, both stack to a cap, both expire.
     *
     * The window is long against a cooldown rather than against a fight: a
     * tool you come back to inside twenty seconds is one you are leaning on,
     * and the longest cooldown in the table is 24s, so the slowest ability in
     * the game can hold one stack between uses and no more.
     */
    masteryTicks: seconds(20),
    masteryMaxStacks: 5,
  },

  /**
   * Shared combat constants the attributes act through.
   *
   * The poise numbers here and in `strength`/`constitution` above divide by the
   * same four the health economy did in spec 217, and they had to: a monster's
   * guard is `maxHealth * monsterPoiseFraction` floored at {@link minPoise}, so
   * quartering health alone put **every** monster in the game on the floor --
   * one guard value for the grazer and the ravager alike, and every stagger
   * threshold met by blows that used to bounce.
   */
  combat: {
    /**
     * How long after a poise break a body cannot be broken again.
     *
     * The single most important anti-abuse number in this spec: without it, two
     * Strength characters chain-stagger anything between them forever, which is
     * not a build, it is a removal. Two seconds is long enough that a break is a
     * window rather than a state.
     */
    staggerImmuneTicks: seconds(2),
    /** Overkill fraction that counts as an overkill, for Strength's payoff. */
    overkillFraction: 0.25,
    /** Poise a body with no Constitution at all still has. */
    minPoise: 5,
    /** Poise a monster gets, as a fraction of its health. */
    monsterPoiseFraction: 0.35,
    /** Poise a monster regains per second. */
    monsterPoiseRegen: 1.5,
  },

  /**
   * What a weapon's scaling letters are worth (spec 216).
   *
   * **The one place a grade becomes a number.** Nothing else in the tree may
   * spell a coefficient: `coefficientOf` in `data/weapon-scaling.ts` is the only
   * reader, the weapon rows author a *letter*, and the tooltip draws the letter
   * it was authored with rather than inferring one back out of a number. So
   * deciding that `S` is worth 1.30 is an edit here and nowhere else, and it
   * reaches every `S` weapon in the game on the next tick.
   *
   * `damagePerPoint` is **one rate shared by all three attributes**, and that is
   * what makes a grade mean something. Before this spec Strength bought 0.6
   * damage a point and Agility 0.15, which is a four-to-one gap living
   * underneath the grades -- an `A` in Agility would have been worth less than
   * an `E` in Strength, and no letter a designer could write would have fixed
   * it. The differentiation belongs in the grade or it belongs nowhere.
   *
   * It was `2/3` when spec 216 chose it, because `2/3 * 0.9` is exactly `0.6`:
   * grade `A` reproduced the Strength rate that spec inherited, so migrating the
   * existing weapons to `A` moved a Strength build's damage by nothing at all.
   * **Spec 217 retuned it to 0.15** with the rest of the damage economy -- see
   * the field's own docstring below, which is the one that states the live
   * value. Kept as history rather than deleted because the *reason* the rate is
   * its own constant is still this: retuning `A` has to be a deliberate
   * rebalance rather than a side effect of the ladder it was chosen against.
   */
  weaponScaling: {
    /**
     * Damage a point of a scaling attribute buys, at grade `A` times this.
     *
     * Retuned from `2/3` to `0.15` by spec 217, along with the whole damage
     * economy: a weapon's own range is now what a swing is built on, and a
     * scaling term an order of magnitude larger than the weapon would have made
     * the range decorative. Measured from `above()` since 217 too, so this is
     * what a point *past the starting five* is worth rather than what a point
     * is.
     */
    damagePerPoint: 0.15,
    /**
     * Grade to coefficient. Keyed by the grade's own name, so a reader can check
     * this against the ladder without counting array positions.
     */
    grades: {
      none: 0,
      E: 0.15,
      D: 0.3,
      C: 0.5,
      B: 0.7,
      A: 0.9,
      S: 1.15,
    },
  },

  /**
   * What an *ability's* own letters are worth (spec 238).
   *
   * Deliberately thin, and that is the point: the ladder, the letters and the
   * damage a point buys are all `weaponScaling` above, shared, so an `A` on
   * Whirlwind and an `A` on a sword buy the same damage per point of Strength.
   * A second ladder here would be the second coefficient language spec 238
   * exists to refuse.
   *
   * What an ability does need of its own is the rate for the effects that are
   * **not** damage -- an affliction's pulse, a slow's bite -- because those are
   * in a different currency. A row in `data/damage-over-time.ts` states its
   * damage per second whole, and what an applier moves is one multiplier on
   * top of it.
   */
  abilityScaling: {
    /**
     * The multiplier an `A`-grade ability's effects gain, per point above the
     * starting attribute, times the grade's coefficient.
     *
     * Chosen to reproduce the curve this replaced rather than to retune it:
     * before spec 238 an affliction's magnitude was the applier's `spellPower`,
     * `1 + 0.04 * Intelligence`, which is `3.0` at 50 Intelligence. At `A`
     * (coefficient 0.9) and 45 points above the start this gives `1 + 45 * 0.9
     * * 0.05 = 3.025`, so a fully-specialised caster's Poison is worth what it
     * was worth. What moved is *which* casters get it: a Rending Cut's Bleed
     * now grows with the build that threw it, and a fresh character is exactly
     * `1.0` rather than `1.2`, which is the baseline rule `above()` states.
     */
    effectPerPoint: 0.05,
    /**
     * What an ability's **own** letters may add up to.
     *
     * A shade over the ladder's best single grade (`S`, 1.15) on purpose, so a
     * two-attribute hybrid can carry a real second letter rather than a token
     * one -- `A` and `D` together, which is the shape the design brief asks for
     * -- and paid for by the cooldown and the resource cost an active ability
     * has and a basic attack does not.
     *
     * The **weapon** fraction is deliberately outside it: that term is the
     * weapon's own scaling, already budgeted where weapons are budgeted, and
     * counting it twice would price a technique against its own tool.
     *
     * Asserted rather than trusted -- `ability-scaling.test.ts` fails a row that
     * exceeds it, which is what keeps "breadth is paid for" a property of the
     * table rather than a habit.
     */
    coefficientBudget: 1.2,
  },
} as const;

/**
 * The six thresholds on every attribute track (spec 244).
 *
 * A specialization threshold is where a mechanic becomes *purchasable*; a
 * milestone threshold is where one deepens *automatically*. Neither moved when
 * the two point pools became one -- the conversion is an economy change and not
 * a content change, and every number a designer tuned still means what it did.
 */
export const MILESTONE_THRESHOLDS: readonly number[] = [20, 35, 50];
export const SPECIALIZATION_THRESHOLDS: readonly number[] = [10, 25, 40];
