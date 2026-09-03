/**
 * Timed states a body carries (spec 147).
 *
 * One small map, and everything the progression system needs to remember about
 * a body between ticks goes in it: the flow an Agility character is riding, the
 * exposure a Perception character left on a target, the attunement a Wisdom
 * character has built up, the resistance somebody has adapted, the moment an
 * Intelligence character finished priming.
 *
 * The alternative -- a field per mechanic on `ServerEntity` -- was tried on
 * paper and is why this exists. Twelve mechanics would be twenty-four fields,
 * twenty-four defaults in `blankEntity`, twenty-four lines in the client's
 * `asEntity` shim, and twenty-four places for an expiry to be forgotten. One map
 * with one expiry rule is one place to get right.
 *
 * Three properties the rest of the system leans on:
 *
 *  - **Expiry is a comparison, never a sweep.** A status is gone when
 *    `tick >= expiresAtTick`; {@link statusOf} answers that on read. The map is
 *    pruned once per tick by {@link expireStatuses} purely so it does not grow
 *    without bound -- reading a stale entry can never produce a live effect.
 *  - **Deterministic iteration.** Entries are inserted in the order they were
 *    granted and rebuilt in that order, so a replay walks the same map.
 *  - **Immutable.** Every function returns a new record, like everything else in
 *    this sim.
 *
 * Pure: no clock of its own, no randomness. The tick is always an argument.
 */

/** One live status. `magnitude` is whatever that status needs to carry. */
export interface StatusState {
  /** First tick at which this is no longer in effect. */
  readonly expiresAtTick: number;
  /** How many of it. 1 for the ones that do not stack. */
  readonly stacks: number;
  /**
   * The size of the effect, captured when it was applied.
   *
   * Carried rather than re-derived because a status usually belongs to somebody
   * *else's* stats: the exposure on a target is worth what the Perception
   * character who applied it was worth, and re-reading it off the victim would
   * give the exposure of whoever happens to be standing there.
   */
  readonly magnitude: number;
  /**
   * Who put it there. 0 for a status nobody is responsible for (spec 190).
   *
   * The same argument {@link magnitude} makes at the top of this file, carried
   * one step further. A status can now *kill* -- an affliction pulses damage
   * long after the body that applied it has walked away -- and `died.killerId`
   * has nowhere else to come from. Without it a poison's kill pays nobody: no
   * restoration, no assists, no loot roll, no metrics.
   *
   * It follows the **magnitude** rather than the clock. Whoever's application
   * set the number that is actually doing the damage owns the kill, so the
   * credit and the number always describe the same body -- where "the last one
   * to touch it" would let a weak applier take a strong one's poison while
   * leaving the strong one's damage on it.
   */
  readonly sourceId: number;
  /**
   * The tick it **first** landed, kept across a refresh (spec 190).
   *
   * What makes a periodic effect a comparison rather than a stored countdown,
   * in exactly the shape this file already commits to for expiry: a pulse is
   * `elapsed % interval === 0` and nothing has to be written per tick.
   *
   * Kept across a refresh, which is three properties at once. Refreshing a
   * poison cannot **delay** its next pulse, so a body inside a spammed refresh
   * still takes damage rather than being ticked forever into the future; it
   * cannot **double-tick** it either; and an escalating affliction measures its
   * ramp from when it got in, so "worse the longer it goes on" survives being
   * topped up. A fresh application -- one landing on a body whose last one had
   * already run out -- resets it, because that is a new affliction.
   */
  readonly appliedAtTick: number;
}

export type Statuses = Readonly<Record<string, StatusState>>;

export const NO_STATUSES: Statuses = {};

/**
 * The well-known ids.
 *
 * A const rather than a union type because {@link ADAPTED_PREFIX} builds ids at
 * runtime -- adaptation is per ability, so its key is `adapt:melee.slash` and a
 * closed union could not express it.
 */
export const StatusId = {
  /** Agility: built by moving out of a follow-through, lost by being staggered. */
  Flow: 'flow',
  /** Strength+Agility: a poise break shortens the next wind-up. */
  Momentum: 'momentum',
  /** Intelligence: primed by stillness, spent on the next ability. */
  Prepared: 'prepared',
  /**
   * Intelligence: this body is planting itself, and comes up when this expires
   * (spec 270).
   *
   * The one status here whose **expiry is the tell**. A stance nobody can see
   * is a stance nobody can punish, and the counterplay the whole mechanic is
   * priced against is *make the caster move* -- so the buildup has to be
   * legible to the person deciding whether to charge. `expiresAtTick` is the
   * tick `Prepared` lands, so a client reads the countdown off machinery that
   * already replicates rather than off a progress bar with a wire field behind
   * it. Cleared the moment the stance breaks, and again when it pays out.
   */
  Preparing: 'preparing',
  /**
   * Intelligence: a spell just ate this body's health (spec 270).
   *
   * Carries nothing the sim reads. It exists because an overdraw cast writes
   * health directly -- bypassing `resolveBlow`, so no `hit` event fires and no
   * damage number floats -- and the health bar's white chunk and kick are the
   * same ones a blow leaves. Without this, the capstone's whole feedback is
   * indistinguishable from being attacked by something off screen.
   */
  Overdrawn: 'overdrawn',
  /**
   * Intelligence: consecutive *different* abilities (spec 270).
   *
   * Stacks while the caster keeps varying what they throw and lapses when they
   * repeat themselves or stop. What it is worth is `weaveEffectPct` on the
   * magnitude of afflictions this body applies -- manipulation rather than a
   * second damage multiplier, which is the distinction that stops this being
   * `int.potency` with extra steps.
   */
  Weave: 'weave',
  /** Perception: left on a target by a weak point. Everyone benefits. */
  Exposed: 'exposed',
  /** Perception: an enemy that has just committed an attack. */
  Vulnerable: 'vulnerable',
  /** Strength+Intelligence: armour reduced. */
  Sundered: 'sundered',
  /** Wisdom: efficiency built by landing things. */
  Attuned: 'attuned',
  /** Constitution: Second Wind has fired and has not re-armed. */
  SecondWindSpent: 'secondWind.spent',
  /** Agility: Perfect Exit has fired and has not re-armed. */
  PerfectExitSpent: 'perfectExit.spent',
  /** Agility: this body took a hit recently, which is what Perfect Exit reads. */
  RecentlyHit: 'recentlyHit',
  /**
   * This body has been in a fight and is not yet due back to full (spec 261).
   *
   * The one status here whose **expiry is the fact**: it is stamped for the
   * combat window plus a whole recovery, so `expiresAtTick` is the tick the
   * body is owed full health on, and `sim/idle.ts` reads it as one. Which is
   * what makes recovery a comparison against a tick rather than a counter of
   * how many ticks somebody happened to be near enough to watch -- `world.ts`
   * steps nothing outside `activeChunks`, and a monster nobody is near is not
   * slowed but frozen.
   *
   * Its lifetime is exactly the ramp's, so it is gone precisely when there is
   * nothing left to owe: an entry that has been pruned and a body that was
   * never in a fight are the same answer, which is *no floor*, and neither can
   * be mistaken for the other.
   */
  Recovering: 'recovering',
  /**
   * Perception+Wisdom: what a Tactician's exposure leaves for everyone else.
   *
   * Declared here with the rest of the well-known ids rather than beside its one
   * writer in `sim/blow.ts` (spec 240). It is a status id, this is where status
   * ids are, and leaving it over there meant `data/status-semantics.ts` -- which
   * has to classify every id that can exist -- could only reach it by importing
   * `blow.ts`, which imports the classification. `blow.ts` re-exports the name
   * it has always used.
   */
  ExposedBounty: 'exposed.bounty',
  /**
   * This body has traded a blow lately -- given or taken (spec 156).
   *
   * Longer than {@link RecentlyHit} and deliberately a different thing. That one
   * is a *reaction window*, half a second wide, and Perfect Exit and the untouched
   * -kill bonus both need it to be exactly that narrow. This one is "are you in a
   * fight", and the only thing that reads it is resting: gating a refill on the
   * reaction window would let a player refill between a ravager's swings, which is
   * two and a quarter seconds apart.
   */
  InCombat: 'inCombat',
  /**
   * Movement taken away for a while (spec 188).
   *
   * The first status in this map that is **applied by a skill rather than
   * earned by a build**, and it is in this map rather than in a debuff system
   * of its own for exactly the reason the file's header gives: one map with one
   * expiry rule is one place to get right. `magnitude` is the fraction of move
   * speed removed, captured when it was applied -- so a slow is worth what the
   * skill that landed it was worth, which is the same rule `Exposed` already
   * follows and the reason `magnitude` exists at all.
   *
   * It does not stack: a second slow refreshes the clock and keeps the stronger
   * magnitude, which is what {@link applyStatus} already does with a
   * `maxStacks` of 1. Two slows that added would be a root, and a root is a
   * different mechanic that should have to say so.
   */
  Slowed: 'slowed',

  // --- the afflictions (spec 190) ---------------------------------------
  //
  // Seven ids and no seventh mechanic: each names a row in
  // `data/damage-over-time.ts`, and what separates them is a rate, a cadence,
  // a length and at most one rider that reaches into a system this game
  // already has. They are in this map rather than in an affliction map of
  // their own for the reason the file's header gives -- one map with one
  // expiry rule is one place to get right -- and they are the first entries
  // here whose `sourceId` is load-bearing, because they can kill.

  /** Strong and short. Immediate pressure, and it spreads. */
  Burn: 'burn',
  /** Moderate, and worse while the body keeps moving or keeps swinging. */
  Bleed: 'bleed',
  /** Weak and long. Attrition: it stacks, and every dart refreshes the clock. */
  Poison: 'poison',
  /** Moderate, and it takes the guard and the armour with it. */
  Corrosion: 'corrosion',
  /** Bursts rather than a trickle, and it arcs to whoever is standing near. */
  Shock: 'shock',
  /** Escalating. Harmless at first and dangerous if it is left on. */
  Frostbite: 'frostbite',
  /** Slow, and nothing heals properly while it is running. */
  Decay: 'decay',

  // --- the aura fields (spec 223) ----------------------------------------
  //
  // The first status here that is about the ground around its carrier rather
  // than about the body carrying it. It is a **boon** and it is in this map
  // rather than in a field system of its own for the reason the header gives:
  // what a field *is* is a timed state on a body, and one map with one expiry
  // rule is one place to get right. What it does to everybody else is a row in
  // `data/aura-fields.ts`, read by `sim/aura-field.ts` and by nothing else.
  //
  // It carries no magnitude. A field's reach and its affliction are the row's,
  // whole -- the same rule spec 190 keeps for an affliction -- so there is no
  // number here that could depend on who cast it.

  /** Fire underfoot: whoever stands near the carrier catches, briefly. */
  ScorchedEarth: 'scorchedEarth',

  // --- the conjured light (spec 250) -------------------------------------
  //
  // The first status here that does nothing to a body at all. Nothing in the
  // sim reads it: no trait, no scale, no pass. What it is for is that a status
  // is the one thing about a body that is *replicated to every client* -- so a
  // light somebody conjured is a light everybody can see, where the torch in
  // their off hand is not, because equipment is on the wire for its owner only.
  //
  // It is in this map rather than in a buff system of its own for the reason
  // the header gives: what it is, is a timed state on a body, and one map with
  // one expiry rule is one place to get right. It carries no magnitude -- how
  // far a conjured light reaches is `MAGIC_DEFAULTS`, whole, so there is no
  // number here that could depend on who cast it.

  /** A conjured light, floating over its carrier. Purely a thing you can see. */
  MagicLight: 'magicLight',

  // --- the Warden's recovery (spec 262) ----------------------------------
  //
  // The one entry here written by a *monster's own attack finishing*, and the
  // only piece of state the Warden's four-state machine stores: the other three
  // are read off the cast the sim already has. It is in this map rather than in
  // a field on the entity for the reason the header gives -- what it is, is a
  // timed state on a body, and one map with one expiry rule is one place to get
  // right -- and for a second reason the header could not have anticipated: a
  // status is replicated, so an overheat is a thing every client can see
  // without a byte being added to the entity delta for it.
  //
  // Two things read it. `sim/warden.ts` asks whether the machine may aim again;
  // a client asks it to tell an overheat from the stagger it otherwise looks
  // exactly like, since the root is `ActivityValue.Stunned` on purpose -- that
  // is the state, mechanically, and a second one that also meant "rooted,
  // silenced, no guard coming back" would be three existing readers duplicated.
  //
  // It carries no magnitude. What the window is *worth* is `Exposed`, applied
  // beside it from `WARDEN_LASER.overheatExposure`, because amplifying damage
  // is a thing this game already knows how to say.

  /** A machine that has just fired, and cannot do anything at all for a while. */
  Overheated: 'overheated',
} as const;

/** Adaptation is per ability id: `adapt:skill.poisonDart`. */
export const ADAPTED_PREFIX = 'adapt:';

export function adaptedKey(abilityId: string): string {
  return `${ADAPTED_PREFIX}${abilityId}`;
}

/** The status if it is live on this tick, or null. Never returns a stale entry. */
export function statusOf(statuses: Statuses, id: string, tick: number): StatusState | null {
  const held = statuses[id];
  if (!held || tick >= held.expiresAtTick) return null;
  return held;
}

/** Live stacks, or 0. The question most callers actually have. */
export function stacksOf(statuses: Statuses, id: string, tick: number): number {
  return statusOf(statuses, id, tick)?.stacks ?? 0;
}

export function hasStatus(statuses: Statuses, id: string, tick: number): boolean {
  return statusOf(statuses, id, tick) !== null;
}

/**
 * Applies a status, refreshing its duration and adding a stack up to `maxStacks`.
 *
 * A duration of zero or less is a no-op that returns the *same* object, so a
 * caller that has no business granting anything -- a monster with no traits,
 * a milestone not reached -- costs nothing and allocates nothing.
 *
 * `magnitude` replaces rather than sums. A second, stronger exposure should be
 * worth what the stronger one is worth; a second, weaker one should not dilute
 * the first, which is why it is a max rather than an assignment.
 */
export function applyStatus(
  statuses: Statuses,
  id: string,
  tick: number,
  durationTicks: number,
  options: {
    readonly maxStacks?: number;
    readonly magnitude?: number;
    /** Who is responsible for this, for a status that can kill (spec 190). */
    readonly sourceId?: number;
  } = {},
): Statuses {
  if (!Number.isFinite(durationTicks) || durationTicks <= 0) return statuses;
  const maxStacks = Math.max(1, Math.floor(options.maxStacks ?? 1));
  const magnitude = options.magnitude ?? 0;
  const sourceId = options.sourceId ?? 0;
  const held = statusOf(statuses, id, tick);
  // The source follows the magnitude, not the clock (spec 190): whoever's
  // application set the number doing the damage owns what that damage does.
  // Ties go to whoever was already there, so the rule is total and stable.
  const takesOver = !held || magnitude > held.magnitude;
  const next: StatusState = {
    expiresAtTick: tick + Math.round(durationTicks),
    stacks: Math.min(maxStacks, (held?.stacks ?? 0) + 1),
    magnitude: held ? Math.max(held.magnitude, magnitude) : magnitude,
    sourceId: takesOver ? sourceId : held.sourceId,
    // Kept, so a refresh moves the deadline and nothing else -- see the field.
    appliedAtTick: held ? held.appliedAtTick : tick,
  };
  return { ...statuses, [id]: next };
}

/** Removes a status outright -- what being staggered does to Flow. */
export function clearStatus(statuses: Statuses, id: string): Statuses {
  if (!(id in statuses)) return statuses;
  const next: Record<string, StatusState> = {};
  for (const [key, value] of Object.entries(statuses)) {
    if (key !== id) next[key] = value;
  }
  return next;
}

/**
 * Drops everything that has expired.
 *
 * Returns the same object when nothing has, which is the common case and keeps
 * the tick from allocating a fresh record per body per tick. Correctness does
 * not depend on this running -- {@link statusOf} already refuses a stale entry --
 * so it is a garbage collector rather than a rule.
 */
export function expireStatuses(statuses: Statuses, tick: number): Statuses {
  let stale = false;
  for (const value of Object.values(statuses)) {
    if (tick >= value.expiresAtTick) {
      stale = true;
      break;
    }
  }
  if (!stale) return statuses;
  const next: Record<string, StatusState> = {};
  for (const [key, value] of Object.entries(statuses)) {
    if (tick < value.expiresAtTick) next[key] = value;
  }
  return next;
}

/**
 * How much damage from `abilityId` this body has learned to shrug off.
 *
 * Wisdom's Adaptation, read out. A fraction 0..cap, and the cap is the victim's
 * own -- the Constitution+Wisdom pair raises it, which is the only place in the
 * system where a pair changes a ceiling rather than adding an effect.
 */
export function adaptationAgainst(
  statuses: Statuses,
  abilityId: string,
  tick: number,
  perStack: number,
  cap: number,
): number {
  if (perStack <= 0 || cap <= 0) return 0;
  const held = statusOf(statuses, adaptedKey(abilityId), tick);
  if (!held) return 0;
  return Math.min(cap, held.stacks * perStack);
}

/**
 * What this body's move speed is multiplied by right now (spec 188).
 *
 * The one place a slow is *read*, so `resolveMovement` and the client's mirror
 * of it cannot disagree about what "40% slower" means. Returns 1 for a body
 * carrying nothing, which is the common case and the reason this is a lookup
 * rather than a field on `EffectiveStats`: a slow is a timed state and
 * `EffectiveStats` is derived on equip, so a slow living there would either be
 * recomputed per tick or go stale.
 *
 * Floored rather than allowed to reach zero. A slow that stopped a body dead
 * would be a root wearing a slow's name, and the two want different counters --
 * so the floor is stated here, once, and a row that authors a magnitude past it
 * gets a hard slow rather than a root.
 */
export function moveScaleOf(statuses: Statuses, tick: number, floor: number): number {
  const slowed = statusOf(statuses, StatusId.Slowed, tick);
  if (!slowed) return 1;
  return Math.max(floor, 1 - Math.max(0, slowed.magnitude));
}
