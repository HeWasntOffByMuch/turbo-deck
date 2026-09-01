/**
 * Every number the health economy is tuned by, in one object (spec 156).
 *
 * The same reasoning as `data/scaling.ts`, and deliberately its neighbour: a
 * balance pass on kill sustain should be a diff of this file and nothing else,
 * and a reviewer should be able to read what a kill is worth without reading the
 * arithmetic that works it out. Nothing under `sim/` writes a restoration
 * constant of its own -- if a number here is wrong, exactly one line changes.
 *
 * How to read the values. Restoration is denominated in *fractions of the
 * collector's own maximum*, never in flat points, so a mote is worth the same
 * proportion to a 200-health starter and to a 600-health Constitution build.
 * What makes it worth more in absolute terms is Wisdom's `healingScale`, which
 * is the stat that is supposed to own efficiency.
 *
 * The reference character is a fresh level-1 build: 50 max health (25 flat +
 * 5 Strength x 1.5 + 5 Constitution x 3.5), since spec 217 quartered the health
 * economy. Every number in this file is a *fraction* of that pool rather than an
 * absolute, which is why the rescale reached none of them -- a vitality mote is
 * 3 health now where it was 12, and a flask is still the same share of a bar. One
 * draught is roughly six motes either way: insurance enough to rescue a
 * disastrous encounter, nowhere near enough to be the economy.
 *
 * **How these numbers were arrived at, and the signature to watch for.** The
 * first tuning pass generated a mote every half-kill at twice this size, and
 * `npm run balance` reported every one of the twelve builds at *exactly* net
 * zero health per kill. That reads as balance and is the opposite: the economy
 * was producing far more than a fight cost, and the only thing holding it down
 * was the health bar's own ceiling -- MOTE% in the same table was around 30%,
 * which is to say two thirds of every mote was being thrown away. A row at
 * net zero with a low MOTE% is over-generation wearing a costume. What it
 * should look like instead is what it looks like now: every build modestly
 * negative, and MOTE% high, because a mote that lands is a mote the fight
 * actually needed.
 *
 * Pure data. No imports but the tick rate.
 */

import { SERVER_TICK_RATE } from '../config.js';
import { above, linear } from './scaling.js';

/** Seconds as whole ticks, the convention everywhere in this repo. */
function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

export const RESTORATION = {
  // --- the meter --------------------------------------------------------
  /**
   * Progress a mote costs. Everything below is denominated against this, so
   * moving it alone re-tunes the whole economy's *rate* without touching its
   * shape.
   */
  threshold: 100,
  /**
   * Progress one point of a monster's `experience` is worth.
   *
   * Weighted off experience rather than off a second authored number, because
   * experience is already the difficulty budget somebody tuned per row -- the
   * same rule `withTraits` follows when it sizes poise off health. At 1.0 the
   * current roster reads: spider 10, stalker 18, slinger 32, ravager 55 -- so an
   * ordinary stalker is roughly a quarter of a mote once its bonuses are in,
   * and the measured economy is a fifth to a half of a fight's cost coming
   * back. The rest is what a player has to make up by fighting better.
   */
  progressPerExperience: 1,
  /**
   * What a body that will not fight back is worth.
   *
   * The least intrusive trivial-enemy rule available: it reads `passive` and
   * `aggroRange`, both of which every row already authors, and it needs no new
   * classification. A grazer is food, not an economy.
   */
  passiveFactor: 0.35,

  // --- anti-farm --------------------------------------------------------
  farm: {
    /** How long a spawner is remembered as having been farmed. */
    windowTicks: seconds(45),
    /** Contribution removed per remembered kill from the same spawner. */
    decayPerKill: 0.25,
    /** However often it is farmed, a kill is never worth less than this. */
    floor: 0.1,
    /** Beyond this the decay is already at its floor; the stacks stop counting. */
    maxStacks: 6,
  },

  // --- elites -----------------------------------------------------------
  elite: {
    /**
     * Experience at or above which a row is an elite.
     *
     * Derived rather than authored, so a monster added later classifies itself
     * and no row can be an elite by accident of a forgotten flag. On the
     * current roster this is the ravager and nothing else.
     */
    experience: 50,
    /** Motes an elite kill is guaranteed to produce, the meter's own included. */
    motes: 2,
    /** How long before the same spawner may pay a guarantee again. */
    guaranteeTicks: seconds(90),
  },

  // --- what good combat is worth ----------------------------------------
  /**
   * Bonuses to a kill's contribution, as fractions of the base.
   *
   * **They sum and are then clamped**, never multiply. That is the whole of
   * "avoid unbounded multiplicative healing loops": the maximum a kill can be
   * worth is `base * (1 + cap)` and there is no expression that reaches past it.
   */
  bonus: {
    weakPointKill: 0.25,
    overkill: 0.2,
    execution: 0.25,
    untouched: 0.3,
    abilityKill: 0.15,
    /** The ceiling on the sum, stat contributions included. */
    cap: 1,
  },

  // --- motes ------------------------------------------------------------
  mote: {
    /** Health restored, as a fraction of the collector's maximum. */
    healthFraction: 0.06,
    /** Resource restored, as a fraction of the collector's pool. */
    resourceFraction: 0.2,
    /** How long one survives before it fades. Short enough that hoarding is not a plan. */
    lifetimeTicks: seconds(12),
    /**
     * How long the hop out of the body takes, and how high it goes.
     *
     * The three numbers below this comment are the visibility fix, and they
     * were tuned against a measurement rather than a feeling. Before them a
     * mote spawned inside its owner's attract radius, armed after 0.3s, and was
     * taken on that very tick: **0.30 seconds on screen**, six frames at the
     * 20Hz broadcast rate. A drop that brief is one a player never sees, which
     * is exactly what was reported.
     *
     * Now it bursts out, arcs, lands, and is drawn back in -- about a second
     * end to end, most of it spent somewhere the eye can follow.
     */
    launchTicks: seconds(0.5),
    hopHeight: 26,
    /**
     * How long it sits where it landed before it is drawn in.
     *
     * The floor under the whole fix. The hop alone left the on-screen time to
     * geometry -- a mote that landed inside the pickup radius was taken the tick
     * it touched down -- so this is the beat every drop gets whatever direction
     * it happened to fly.
     */
    lingerTicks: seconds(0.35),
    /** Collected inside this of the owner's centre. */
    pickupRadius: 44,
    /** Drawn toward its owner from inside this, before Perception widens it. */
    attractRadius: 130,
    /**
     * World units per second it closes at once attracted.
     *
     * Deliberately slower than a projectile. It was 300, which crossed the whole
     * attract radius in under half a second -- fast enough that the mote read as
     * a flicker rather than as something coming toward you.
     */
    attractSpeed: 180,
    /**
     * How far from the body motes land.
     *
     * Wide enough that the hop is a journey rather than a twitch, and that two
     * from one kill are plainly two. It is the *travel* that makes a drop
     * legible, so this is the number to raise if they still read as instant.
     */
    scatterRadius: 46,
    /**
     * How far apart two motes from one kill are thrown, in radians.
     *
     * A bounded fan rather than the golden angle, because the burst has a
     * *direction* now -- at the killer -- and the golden angle's whole virtue is
     * spreading things when direction does not matter.
     */
    scatterFan: 0.55,
    /**
     * Health deficit above which a mote is always vitality.
     *
     * The bias that keeps this a *health* economy. Below a quarter of health
     * missing, a mote may go to whichever pool is emptier; above it, health
     * wins outright however short of mana the body is -- because resource
     * regenerates on its own between fights and health is the thing that does
     * not.
     */
    focusHealthCeiling: 0.25,
  },

  // --- the flask --------------------------------------------------------
  fallback: {
    /** What every character carries before Constitution says otherwise. */
    charges: 3,
    /** Ceiling on charges however much Constitution is invested. */
    maxCharges: 6,
  },

  // --- resting ----------------------------------------------------------
  rest: {
    /** Fraction of maximum health returned per second while resting. */
    healthPerSecond: 0.08,
    /** How long one charge takes to come back. */
    chargeTicks: seconds(2),
    /**
     * How long after trading a blow a body still counts as fighting.
     *
     * Wide enough to cover the gap between a slow monster's swings -- the
     * ravager is 2.25s apart -- because the failure this closes is a player
     * standing in the safe zone refilling *between* the blows of the thing
     * hitting them. Deliberately not the half-second `RecentlyHit` window, which
     * exists to be a reaction window and has to stay one.
     */
    combatTicks: seconds(8),
    /**
     * How long a monster nobody is fighting takes to come back from nothing to
     * full, once {@link combatTicks} has closed (specs 213, 259).
     *
     * Here rather than in `sim/idle.ts` because two files need it and they are
     * on opposite sides of an import: `restore` ramps over it, and
     * `enterCombat` sizes `StatusId.Recovering` as `combatTicks` plus this, so
     * that the record of when a fight ended lasts exactly as long as the ramp
     * measured against it. Stated once, so those two cannot drift.
     */
    recoveryTicks: seconds(4),
  },

  // --- groups -----------------------------------------------------------
  /**
   * What a kill is worth to a player who damaged it and did not land the blow.
   *
   * The base only: no bonuses, no elite guarantee, no motes at the corpse. It
   * reaches their own meter and may cross their own threshold at their own
   * feet, which is what makes it unstealable -- last-hitting takes the motes
   * and never the credit.
   */
  assistFraction: 0.35,
  /** How long after being hit a player still counts as having been in the fight. */
  assistTicks: seconds(8),

  // --- PvP --------------------------------------------------------------
  /**
   * The separate tuning layer the brief asks for, rather than exceptions hidden
   * in the sim (spec 156 § E).
   */
  pvp: {
    /** Progress a player kill is worth, per level of the body killed. */
    progressPerLevel: 24,
    /** Everything above, scaled -- one dial for "is PvP sustain too strong". */
    scale: 0.5,
    /** How long a repeat kill on the same body is worth nothing. */
    victimTicks: seconds(300),
  },

  // --- what each attribute buys ----------------------------------------
  /**
   * Per-point rates, measured from the starting attribute like every other
   * scale in `data/scaling.ts`. One route per stat and no two the same shape --
   * see spec 156 § F for why none of these is "+X% healing received".
   */
  stats: {
    /** Strength: overkill and execution pay more. */
    strengthOverkillPer: 0.012,
    /** Agility: an untouched kill pays more. */
    agilityEvasivePer: 0.012,
    /** Intelligence: a kill made with an ability pays more. */
    intelligenceAbilityPer: 0.01,
    /** Perception: weak-point kills pay more, and motes come from further away. */
    perceptionWeakPointPer: 0.012,
    perceptionAttractPer: 2.4,
    /** Wisdom: the fraction of a mote's overheal that goes back into the meter. */
    wisdomSalvagePer: 0.02,
    wisdomSalvageCap: 0.6,
    /** Wisdom: the most one collection may salvage, as a fraction of a threshold. */
    salvageCapFraction: 0.35,
    /** Constitution: one more charge per this many points above the start. */
    constitutionChargePer: 18,
    /**
     * Constitution: how much more every restorative is worth below the
     * threshold, per point.
     *
     * Granted as `healingSurge`, which already exists and already runs inside
     * `applyHealing` -- a second mechanism meaning "heal more when low" would
     * be a second threshold to get wrong.
     */
    constitutionSurgePer: 0.014,
    /** Health fraction below which that surge applies. */
    desperationBelow: 0.4,
  },
} as const;

/**
 * Charges Constitution carries, and the ceiling on them.
 *
 * Beside the numbers rather than in `player/derived.ts` because two other
 * callers need the same answer: `player-manager.ts`, filling in a save written
 * before the field existed, and the rest loop, which has to know when a flask is
 * full. Three copies of a ceiling is three places for it to be off by one.
 */
export function maxFallbackCharges(constitution: number): number {
  const extra = Math.floor(above(constitution) / RESTORATION.stats.constitutionChargePer);
  return Math.min(RESTORATION.fallback.maxCharges, RESTORATION.fallback.charges + Math.max(0, extra));
}

/**
 * Constitution's desperation surge, expressed as the `healingSurge` trait it is
 * granted as.
 *
 * Reusing that trait rather than adding a second one is the point: it already
 * exists, it already runs inside `applyHealing`, and it therefore already
 * reaches motes, the flask and `self.mend` alike. A parallel "heal more when
 * low" mechanic would be a second threshold to keep in step with this one.
 */
export function desperationSurge(constitution: number): number {
  return linear(above(constitution), RESTORATION.stats.constitutionSurgePer);
}
