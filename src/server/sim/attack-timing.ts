/**
 * How long an attack takes, in every sense of the question (spec 144).
 *
 * There are four answers and they used to live in three places: how often a body
 * may swing was `EffectiveStats.attackDelayTicks`, how long the swing took to
 * land was `AbilityDefinition.windupTicks`, how long the follow-through lasted
 * was nothing at all, and how attack speed related the three was nothing either.
 * This module is all four, and it is the only place any of them is worked out.
 *
 * The model is Heroes of Newerth's, and the one idea worth holding onto is that
 * the **attack interval and the attack animation are two spans that start
 * together and end apart**:
 *
 *                          ATTACK INTERVAL
 *      |--------------------------------------------------|
 *      0                                                READY
 *      |
 *      |---------- WIND-UP ----------|
 *                                    X COMMIT
 *                                    |
 *                                    |---- BACKSWING ----|
 *
 * A unit with BAT 1.7, an attack point of 0.4 and a backswing of 0.5 is animating
 * for 0.9 seconds out of every 1.7. The other 0.8 is standing there, and that is
 * not a bug to be tuned away -- it is the window the next decision is made in.
 *
 * Pure and clock-free: numbers in, numbers out, no entity and no tick. That is
 * what lets the sim, the client's prediction, the HUD and the character sheet all
 * ask the same function rather than each keeping a version of the arithmetic.
 */

/**
 * The three attack-speed categories, kept apart because they stack apart.
 *
 * Flattening them into one number is the obvious simplification and it is wrong
 * the first time two sources disagree about whether they add or multiply: an
 * additive +100 and a +100% multiplier are the same factor alone and are 4x
 * rather than 3x together, and the difference is invisible until somebody wears
 * both.
 */
export interface AttackSpeedInputs {
  /**
   * Additive flat attack speed, in the HoN convention: **0 is base speed, 100
   * is twice the attacks per second, 200 is three times**.
   *
   * Note the convention explicitly, because this repo already had two others.
   * `StatModifier.attackSpeed` is flat haste where +0.2 means a fifth faster,
   * and `StatModifier.attackSpeedPct` is a fraction where 0.15 means 15% faster.
   * Neither is this one. Anything mapping those onto this goes through
   * {@link attackSpeedFromHaste} rather than being reinterpreted in place.
   */
  readonly attackSpeed: number;
  /** Percent attack-speed multiplier. 1 is none; 1.2 is a fifth faster. */
  readonly attackSpeedMultiplier: number;
  /** Percent attack-speed *slow* multiplier. 1 is none; 0.8 is a fifth slower. */
  readonly attackSpeedSlowMultiplier: number;
}

/** Nothing modifying anything: the factor comes out at exactly 1. */
export const NO_ATTACK_SPEED: AttackSpeedInputs = {
  attackSpeed: 0,
  attackSpeedMultiplier: 1,
  attackSpeedSlowMultiplier: 1,
};

/**
 * What the base numbers are, before any of that is applied.
 *
 * BAT is the *unit's* and the other two are the *ability's*, which is spec 088's
 * split kept intact: how often a body may swing is a property of the body, and
 * how the swing is shaped is a property of what it is swinging.
 */
export interface AttackTimingBase {
  /** Base Attack Time: the interval between blows before any modifier. */
  readonly baseAttackTimeTicks: number;
  /** Ticks from the swing starting to the blow being real. HoN's attack point. */
  readonly baseAttackPointTicks: number;
  /** Ticks of follow-through after that, which may be walked out of. */
  readonly baseAttackBackswingTicks: number;
  /**
   * How much of that follow-through is **committed** before a voluntary cancel
   * becomes legal (spec 257). 0.7 is "seven tenths of it".
   *
   * A fraction rather than a count of ticks, and that is the whole reason it
   * belongs here rather than being resolved by a caller: attack speed divides
   * the backswing, and a fraction is invariant under that division -- so the
   * rule reads the same at every attack speed with nothing to re-derive, and a
   * hasted body's cancel point moves with its own animation for free.
   *
   * Optional, defaulting to {@link FULLY_COMMITTED}: a body with no opinion is
   * committed to its whole follow-through, which is what every monster in the
   * game does anyway (only a player withdraws -- spec 221).
   */
  readonly backswingCancelPct?: number;
}

/**
 * The cancel fraction of a body that has bought nothing: the whole thing.
 *
 * Not zero, which is the tempting default and the wrong one -- zero says "leave
 * whenever you like", which is the behaviour spec 257 exists to replace, and it
 * would arrive silently at any call site that forgot the field.
 */
export const FULLY_COMMITTED = 1;

/** The four numbers an attack actually runs on, plus the two it is read by. */
export interface AttackTiming {
  /** What every base duration was divided by. */
  readonly factor: number;
  /** Ticks from one attack starting to the next being allowed to. */
  readonly intervalTicks: number;
  /** Ticks from the attack starting to it committing. */
  readonly attackPointTicks: number;
  /** Ticks of backswing after the commit. Never longer than what is left of the interval. */
  readonly backswingTicks: number;
  /**
   * Ticks of that backswing which must elapse before a voluntary cancel is
   * legal (spec 257). 0 when there is no follow-through to leave.
   *
   * Measured from the attack point, so the tick a body may walk from is
   * `releaseTick + backswingCancelTicks`. Resolved here rather than at the
   * cancel, and snapshotted onto the cast with the rest of this object, for the
   * reason the rest of it is: a buff landing mid-swing belongs to the next
   * attack. Flow won by *this* cancel pays for the next follow-through, which
   * is exactly the loop Agility's tree describes.
   */
  readonly backswingCancelTicks: number;
  /** The interval read the other way round, for anything showing a player a rate. */
  readonly attacksPerSecond: number;
}

/**
 * Bounds on the interval, in seconds.
 *
 * These are spec 088's numbers -- `MIN_ATTACK_DELAY_TICKS` and
 * `MAX_ATTACK_DELAY_TICKS` were 0.2s and 5s -- moved here from `player/stats.ts`
 * because the clamp belongs beside the division that needs it. A floor as well
 * as a ceiling for the reason 088 gave: the factor is a divisor, and a modifier
 * that drove it to zero would not make a body fast, it would make its interval
 * infinite.
 *
 * Deliberately *not* an attacks-per-second cap invented here. Nothing in the
 * content reaches either bound: the slowest monster is on 2.25s and the fastest
 * anything can be authored at is the player's 1.2s base.
 */
export const MIN_ATTACK_INTERVAL_SECONDS = 0.2;
export const MAX_ATTACK_INTERVAL_SECONDS = 5;

/**
 * The same two questions for a **cooldown** rather than a cadence (spec 250).
 *
 * The bounds above are about a Base Attack Time, and their own comment says
 * *"nothing in the content reaches either bound"* -- which is true of a BAT and
 * was false the moment `attackTimingFor` started sending a non-basic ability's
 * `cooldownTicks` through the same clamp. **Twelve of the fourteen non-basic
 * rows are authored over five seconds**, so every one of them was really on a
 * five-second cooldown: Scorched Earth's 24 was 5, Stunning Blow's 14 was 5, and
 * the table said one thing while the game did another.
 *
 * An attacks-per-second cap applied to a spell cooldown is a category error. A
 * cadence is how often a body may swing and is a property of the body; a
 * cooldown is how often an *effect* may exist and is a property of the row.
 *
 * The floor stays and is the same number, because the reason for it is
 * arithmetic rather than balance: the interval is divided by the attack-speed
 * factor, and a modifier that drove the result to nothing would not make an
 * ability fast, it would make it free. The ceiling exists for the same kind of
 * reason at the other end -- a bad modifier should be a long cooldown rather
 * than an infinite one -- and is set where no content reaches it. The longest
 * row in the table is 24s.
 */
export const MIN_COOLDOWN_SECONDS = 0.2;
export const MAX_COOLDOWN_SECONDS = 300;

/** How wide an interval may be, in seconds. See the two pairs above. */
export interface IntervalBounds {
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

/** A basic attack's cadence: bounded as an attacks-per-second window. */
export const ATTACK_INTERVAL_BOUNDS: IntervalBounds = {
  minSeconds: MIN_ATTACK_INTERVAL_SECONDS,
  maxSeconds: MAX_ATTACK_INTERVAL_SECONDS,
};

/** A non-basic ability's cooldown: bounded only against a broken modifier. */
export const COOLDOWN_BOUNDS: IntervalBounds = {
  minSeconds: MIN_COOLDOWN_SECONDS,
  maxSeconds: MAX_COOLDOWN_SECONDS,
};

/**
 * How far the factor may be pushed, either way.
 *
 * Clamped on the *factor* rather than on the resulting interval, which is the
 * whole reason this is one number rather than three clamps. Attack speed scales
 * the interval, the attack point and the backswing by the same amount, and
 * clamping each of them separately would let a body at an absurd attack speed
 * hit the interval floor while its wind-up carried on shrinking -- an animation
 * that finishes before the blow it belongs to.
 *
 * 25x either way is far past anything the content can produce and exists only so
 * that a modifier bug is a slow unit or a fast one rather than a division by
 * zero.
 */
export const MIN_ATTACK_SPEED_FACTOR = 1 / 25;
export const MAX_ATTACK_SPEED_FACTOR = 25;

/**
 * A duration in seconds, as whole ticks.
 *
 * **Rounds to nearest**, and does not floor or ceil. That is the convention
 * already in the tree -- `seconds()` in `data/abilities.ts`, `simTicksToServerTicks`
 * in `player/stats.ts` and the old `attackDelayTicksFrom` all round -- and having
 * attack timing round the other way would put a half-tick of disagreement between
 * an ability's authored wind-up and the same wind-up resolved through here.
 *
 * There is no separate quantization step and no 20Hz combat clock. HoN's 0.05s
 * granularity is an artefact of the tick rate it ran at; this sim runs at 60Hz
 * and quantizing to 20Hz on top of that would be copying the artefact rather
 * than the design. Timings are computed in seconds and land on 60Hz ticks here,
 * once, at the boundary.
 */
export function quantizeToTicks(seconds: number, tickRate: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * tickRate);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The one multiplier every attack duration is divided by.
 *
 *   factor = (1 + attackSpeed / 100) * multiplier * slowMultiplier
 *
 * Linear in attack speed, which is the property that makes the stat readable:
 * +100 is twice the attacks per second and +200 is three times, so the *rate*
 * adds up in a straight line while the *interval* falls off reciprocally. A
 * player reads the first and the sim runs on the second.
 *
 * A non-finite input is a stat that says nothing, so it says nothing rather than
 * poisoning the product with a NaN.
 */
export function attackSpeedFactor(inputs: AttackSpeedInputs): number {
  const raw =
    (1 + inputs.attackSpeed / 100) *
    inputs.attackSpeedMultiplier *
    inputs.attackSpeedSlowMultiplier;
  // A stat that says nothing changes nothing. NaN is the only value with no
  // direction to clamp toward -- an infinity has one, and gets it below.
  if (Number.isNaN(raw)) return 1;
  // Zero or negative is "never", not "instantly": it lands on the slow bound
  // rather than dividing into an infinite or a negative duration. An absurd
  // amount of haste, infinity included, lands on the fast one.
  if (raw <= 0) return MIN_ATTACK_SPEED_FACTOR;
  return clamp(raw, MIN_ATTACK_SPEED_FACTOR, MAX_ATTACK_SPEED_FACTOR);
}

/**
 * Converts this repo's flat-haste modifier to the additive attack speed above.
 *
 * `StatModifier.attackSpeed` means "+0.2 is a fifth faster" (spec 088). HoN's
 * additive stat means "+20 is a fifth faster". Same quantity, two spellings,
 * and the conversion is written down here rather than being a `* 100` somebody
 * has to recognise at a call site.
 */
export function attackSpeedFromHaste(haste: number): number {
  return Number.isFinite(haste) ? haste * 100 : 0;
}

/**
 * How much of a follow-through is committed, as a count of ticks.
 *
 * Its own function because three places need the same answer and only one of
 * them has an {@link AttackTiming} to read it off: the resolver below, the
 * client's own prediction (which rebuilds the cancel tick from the *replicated*
 * release and end ticks rather than from a timing it would have to guess), and
 * the tests that assert the two agree.
 *
 * Two bounds, and neither is a taste:
 *
 *  - **at least one tick**, so a legal cancel can never land on the attack
 *    point itself. Cancelling *on* the release tick is already impossible --
 *    the movement pass runs before the cast pass, so `committed` is not true
 *    until the tick after -- and flooring here makes that a property of the
 *    number rather than of the pass order.
 *  - **at most the whole backswing**, so no threshold can push the cancel point
 *    past the end of the phase it is inside. A cancel point a body can never
 *    reach is a follow-through that cannot be left, which is a different
 *    feature and not this one.
 *
 * A backswing of zero has no cancel point at all rather than a floored one: a
 * channel and every ability that ends at its release are cancellable exactly as
 * they were before this existed.
 */
export function backswingCancelTicksFrom(backswingTicks: number, pct: number): number {
  if (!Number.isFinite(backswingTicks) || backswingTicks <= 0) return 0;
  const fraction = Number.isFinite(pct) ? clamp(pct, 0, 1) : FULLY_COMMITTED;
  return clamp(Math.round(backswingTicks * fraction), 1, backswingTicks);
}

/**
 * Every attack duration, resolved.
 *
 * The interval is clamped, the attack point is floored at one tick -- a blow
 * that commits on the tick it starts cannot be reacted to, and the whole design
 * rests on a wind-up being readable -- and the backswing is floored at zero,
 * because no follow-through at all is a legitimate thing for an ability to say.
 *
 * The backswing is then held to what is left of the interval. A body must never
 * be animation-locked past the moment it may swing again: it would be unable to
 * start the attack it is entitled to (`startCast` refuses while a cast is live),
 * so the backswing would quietly become the real cadence and the interval would
 * stop describing anything. Truncating here rather than refusing the content
 * means a fast unit with a long clip loses the tail of its follow-through, which
 * is what a fast unit looks like.
 */
export function resolveAttackTiming(
  base: AttackTimingBase,
  inputs: AttackSpeedInputs,
  tickRate: number,
  bounds: IntervalBounds = ATTACK_INTERVAL_BOUNDS,
): AttackTiming {
  const factor = attackSpeedFactor(inputs);
  const rate = Number.isFinite(tickRate) && tickRate > 0 ? tickRate : 60;

  const bat = Number.isFinite(base.baseAttackTimeTicks) ? base.baseAttackTimeTicks : rate;
  const point = Number.isFinite(base.baseAttackPointTicks) ? base.baseAttackPointTicks : 1;
  const swing = Number.isFinite(base.baseAttackBackswingTicks)
    ? base.baseAttackBackswingTicks
    : 0;

  const intervalTicks = clamp(
    Math.round(bat / factor),
    Math.max(1, quantizeToTicks(bounds.minSeconds, rate)),
    Math.max(1, quantizeToTicks(bounds.maxSeconds, rate)),
  );
  const attackPointTicks = Math.max(1, Math.round(point / factor));
  const backswingTicks = Math.max(
    0,
    Math.min(
      Math.max(0, Math.round(swing / factor)),
      // What is left of the interval once the wind-up has had its share.
      intervalTicks - attackPointTicks,
    ),
  );
  // Taken against the **resolved** backswing rather than the authored one, so a
  // truncated follow-through keeps its proportions: a fast unit that loses the
  // tail of its clip to the line above should not also find its cancel point
  // pushed past what is left of the phase.
  const backswingCancelTicks = backswingCancelTicksFrom(
    backswingTicks,
    base.backswingCancelPct ?? FULLY_COMMITTED,
  );

  return {
    factor,
    intervalTicks,
    attackPointTicks,
    backswingTicks,
    backswingCancelTicks,
    attacksPerSecond: rate / intervalTicks,
  };
}
