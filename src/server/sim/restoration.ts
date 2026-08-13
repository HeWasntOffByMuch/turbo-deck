/**
 * Kill sustain, worked out (spec 154).
 *
 * The domain service the whole health economy lives in. Everything here is a
 * pure function of `(bodies, tick, statuses)` -- no world, no clock, no
 * randomness, not one number of its own. `blow.ts` decides *how* something died,
 * `world.ts` owns entities and turns the result into them, and this file is the
 * only place that answers **what a kill is worth**.
 *
 * The shape of the answer, and the reason it is this shape:
 *
 * ```
 *   base      = experience x rate x threat      deterministic, off the row
 *   x farm    = diminishing returns per spawner deterministic, off the killer
 *   x (1 + Σ) = qualifying actions, capped      deterministic, off the blow
 * ```
 *
 * Nothing multiplies a bonus by another bonus. The five qualifying actions sum
 * as fractions of the base and the sum is clamped at
 * {@link RESTORATION.bonus.cap}, so the most any kill can ever be worth is
 * `base * (1 + cap)` and an unbounded healing loop is not expressible rather
 * than merely untuned.
 *
 * There is **no roll anywhere in this file**. That is the brief's central
 * requirement -- a player must never feel that orb RNG decided whether they were
 * allowed to keep playing -- and it is also what makes the whole thing testable:
 * given the same kill, this returns the same progress, forever.
 *
 * Three pieces of bookkeeping ride {@link Statuses} rather than new entity
 * fields, because all three are "remember this about a body for N ticks", which
 * is what that map is: the per-spawner farm decay, the per-spawner elite
 * guarantee window, and the per-victim PvP feeding lock. One expiry rule,
 * already deterministic, already ordered.
 */

import { RESTORATION } from '../data/restoration.js';
import { monsterById } from '../data/monsters.js';
import { applyStatus, hasStatus, stacksOf, type Statuses } from './statuses.js';
import { EntityKindValue, type KillQualities, type ServerEntity } from './types.js';

/** What a mote restores. A number rather than a union, so the wire can carry it. */
export const MoteKind = {
  Vitality: 0,
  Focus: 1,
} as const;

/**
 * The content id a mote entity carries.
 *
 * An id like every other entity's, because that is the contract: a replicated
 * body is a kind and a content id, and the client looks the rest up. The two
 * are separate rows rather than one parameterised type so that a third resource
 * -- stamina, heat, whatever a later spec adds -- is a row here and a case in
 * the renderer, and none of the arithmetic below changes.
 */
export const MOTE_TYPE_ID: Readonly<Record<number, string>> = {
  [MoteKind.Vitality]: 'mote.vitality',
  [MoteKind.Focus]: 'mote.focus',
};

/** Which kind a `mote.*` type id names, or null for anything that is not one. */
export function moteKindOf(typeId: string): number | null {
  if (typeId === MOTE_TYPE_ID[MoteKind.Vitality]) return MoteKind.Vitality;
  if (typeId === MOTE_TYPE_ID[MoteKind.Focus]) return MoteKind.Focus;
  return null;
}

// --- status keys ---------------------------------------------------------

/** Repeated kills from one spawner, remembered on the killer. */
export const FARM_PREFIX = 'farm:';
/** The elite guarantee already paid by one spawner, remembered on the killer. */
export const ELITE_PREFIX = 'elite:';
/** A player already killed recently, so feeding pays nothing. */
export const PVP_KILL_PREFIX = 'pvpKill:';
/**
 * "This player hit me" -- left on a *victim* by every blow, read at its death.
 *
 * The assist system in one status. There is no threat table, no damage ledger
 * and nothing to keep in sync: the mark the blow already had to leave is the
 * mark the kill reads, and it expires on its own.
 */
export const ASSIST_PREFIX = 'dmg:';

/**
 * A spawner's farm key, or a per-type one for a body with no spawner.
 *
 * The fallback matters: an admin-conjured monster, or one a scripted encounter
 * placed, has `spawnerId === null`, and a rule keyed on the spawner alone would
 * make "having no home" the way out of every anti-farm measure in this file.
 */
export function farmKey(victim: Pick<ServerEntity, 'spawnerId' | 'typeId'>): string {
  // A body with no spawner is keyed by *type* rather than lumped into one
  // bucket. Lumping was the first version and it was wrong in the direction
  // that matters least but is easiest to hit: a scripted wave of five different
  // monsters would have decayed as though it were one spawner farmed five
  // times, so the anti-farm rule would have punished exactly the encounter a
  // designer had built on purpose. Keyed by type it still catches the thing it
  // is for -- conjuring the same monster over and over -- and lets a varied
  // wave pay what it is worth.
  return `${FARM_PREFIX}${victim.spawnerId ?? `type:${victim.typeId}`}`;
}

export function eliteKey(victim: Pick<ServerEntity, 'spawnerId' | 'typeId'>): string {
  return `${ELITE_PREFIX}${victim.spawnerId ?? `type:${victim.typeId}`}`;
}

export function pvpKillKey(victimEntityId: number): string {
  return `${PVP_KILL_PREFIX}${victimEntityId}`;
}

export function assistKey(attackerEntityId: number): string {
  return `${ASSIST_PREFIX}${attackerEntityId}`;
}

/** The entity ids currently marked as having damaged this body, in grant order. */
export function assistsOn(statuses: Statuses, tick: number): readonly number[] {
  const ids: number[] = [];
  for (const [key, value] of Object.entries(statuses)) {
    if (!key.startsWith(ASSIST_PREFIX)) continue;
    if (tick >= value.expiresAtTick) continue;
    const id = Number(key.slice(ASSIST_PREFIX.length));
    if (Number.isFinite(id) && id > 0) ids.push(id);
  }
  return ids;
}

/** Records that `attackerId` hit this body, for {@link assistsOn} to find later. */
export function markAssist(statuses: Statuses, attackerId: number, tick: number): Statuses {
  return applyStatus(statuses, assistKey(attackerId), tick, RESTORATION.assistTicks);
}

// --- what a body is worth ------------------------------------------------

/** Whether this monster row is an elite. Derived from experience, never authored. */
export function isEliteType(typeId: string): boolean {
  const row = monsterById(typeId);
  return row !== null && row.experience >= RESTORATION.elite.experience;
}

/**
 * The undecorated worth of the body that died, before farming and before skill.
 *
 * Zero is a real answer and means "this generates nothing": a prop, a
 * projectile, a training dummy, a body worth no experience. A caller that gets
 * zero should stop rather than look for a floor.
 */
export function baseContributionOf(victim: ServerEntity): number {
  if (victim.kind === EntityKindValue.Player) {
    // Weighted off level, because a player has no `experience` row and their
    // stats are a build rather than a budget. Scaled by its own PvP dial, so
    // "is killing people too rewarding" is one number rather than a hunt.
    return Math.max(0, victim.level) * RESTORATION.pvp.progressPerLevel * RESTORATION.pvp.scale;
  }
  if (victim.kind !== EntityKindValue.Monster) return 0;

  const row = monsterById(victim.typeId);
  if (!row || row.experience <= 0) return 0;
  // A body that will not fight back is not an economy. Read off the two fields
  // the row already authors rather than off a new "trivial" flag, which is the
  // least intrusive form of this rule that still catches the grazer.
  const threat = row.passive && row.aggroRange <= 0 ? RESTORATION.passiveFactor : 1;
  return row.experience * RESTORATION.progressPerExperience * threat;
}

/** How much of a kill's worth survives having farmed this spawner. */
export function farmFactorOf(killer: ServerEntity, victim: ServerEntity, tick: number): number {
  const stacks = stacksOf(killer.statuses, farmKey(victim), tick);
  return Math.max(RESTORATION.farm.floor, 1 - stacks * RESTORATION.farm.decayPerKill);
}

/** One line of the breakdown: what paid, and how much. Designer-facing. */
export interface ContributionSource {
  readonly reason: string;
  readonly amount: number;
}

/**
 * Why a player got what they got.
 *
 * Carried out of the sim on the `died` event and into the metrics, because the
 * brief's quality bar asks whether a designer can inspect *why* a given amount
 * of restoration was granted -- and a number with no derivation beside it is
 * exactly the thing that gets retuned in the wrong direction.
 */
export interface Contribution {
  readonly base: number;
  readonly farmFactor: number;
  /** The summed bonus fraction, after the cap. */
  readonly bonus: number;
  readonly sources: readonly ContributionSource[];
  readonly total: number;
}

export const NO_CONTRIBUTION: Contribution = {
  base: 0,
  farmFactor: 1,
  bonus: 0,
  sources: [],
  total: 0,
};

/**
 * What this kill is worth to this killer, with the reasons attached.
 *
 * The bonuses sum and are then clamped -- see the header. A stat contribution
 * rides *inside* the same sum rather than multiplying it, so a Perception build
 * makes weak-point kills worth more and can still never take a kill past the
 * cap.
 */
export function contributionFor(
  killer: ServerEntity,
  victim: ServerEntity,
  qualities: KillQualities,
  tick: number,
): Contribution {
  const base = baseContributionOf(victim);
  if (base <= 0) return NO_CONTRIBUTION;

  const farmFactor = farmFactorOf(killer, victim, tick);
  const traits = killer.stats.traits;
  const B = RESTORATION.bonus;
  const sources: ContributionSource[] = [];

  const add = (reason: string, amount: number): void => {
    if (amount > 0) sources.push({ reason, amount });
  };
  if (qualities.weakPoint) add('weakPoint', B.weakPointKill + traits.restoreWeakPointPct);
  if (qualities.overkill) add('overkill', B.overkill + traits.restoreOverkillPct);
  if (qualities.execution) add('execution', B.execution + traits.restoreOverkillPct);
  if (qualities.untouched) add('untouched', B.untouched + traits.restoreEvasivePct);
  if (qualities.abilityKill) add('abilityKill', B.abilityKill + traits.restoreAbilityKillPct);

  const summed = sources.reduce((total, source) => total + source.amount, 0);
  const bonus = Math.min(B.cap, summed);
  return { base, farmFactor, bonus, sources, total: base * farmFactor * (1 + bonus) };
}

// --- the meter -----------------------------------------------------------

export interface MeterResult {
  /** What is left after whole motes have been taken out. Never negative. */
  readonly meter: number;
  /** How many crossed. More than one is normal for a big kill. */
  readonly motes: number;
}

/**
 * Progress in, motes out, excess carried.
 *
 * A floor rather than a boolean, deliberately: a single kill large enough to
 * cross the threshold twice produces two motes. The boolean version makes a big
 * kill worth *less* than the two small ones it replaced, which is the opposite
 * of what an elite is supposed to feel like.
 */
export function advanceMeter(meter: number, progress: number): MeterResult {
  // Both guarded for finiteness, and the second is not paranoia: `Math.max(0,
  // NaN)` is NaN, so an unguarded progress would poison the meter permanently
  // -- every later comparison against it is false and the body never produces
  // another mote for the rest of its life.
  const from = Number.isFinite(meter) ? meter : 0;
  const added = Number.isFinite(progress) ? Math.max(0, progress) : 0;
  const total = Math.max(0, from + added);
  const motes = Math.floor(total / RESTORATION.threshold);
  return { meter: total - motes * RESTORATION.threshold, motes };
}

/** Progress as the bar draws it: 0..1 toward the next mote. */
export function meterFraction(meter: number): number {
  if (!Number.isFinite(meter) || meter <= 0) return 0;
  return Math.min(1, meter / RESTORATION.threshold);
}

// --- motes ---------------------------------------------------------------

/** One mote to be made, relative to the body it came from. */
export interface MoteSpawn {
  readonly kind: number;
  readonly amount: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Which kind this body needs more, by fractional deficit.
 *
 * Deterministic and legible: you get what you are shorter of, and ties go to
 * health. A body with no resource pool -- every monster, and any build that has
 * not bought one -- always gets vitality, because the alternative is a mote
 * that cannot mean anything.
 */
export function moteKindFor(body: ServerEntity): number {
  const maxResource = body.stats.maxResource;
  if (!(maxResource > 0)) return MoteKind.Vitality;
  const maxHealth = body.stats.maxHealth;
  const healthDeficit = maxHealth > 0 ? 1 - body.health / maxHealth : 0;
  const resourceDeficit = 1 - body.resource / maxResource;
  // **Vitality unless health is nearly full.** The plain "whichever deficit is
  // larger" rule was the first version, and the balance harness showed exactly
  // what is wrong with it: a Constitution build has an enormous health pool and
  // a small resource pool, so a scratch is a tiny *fraction* of its health while
  // one cast is a large fraction of its mana -- and the survivability stat got
  // nothing but focus motes for a whole run. Resource also regenerates on its
  // own and health does not, so a health economy that hands out mana whenever
  // the pools happen to compare that way is giving away the only thing it has.
  if (healthDeficit > RESTORATION.mote.focusHealthCeiling) return MoteKind.Vitality;
  return resourceDeficit > healthDeficit ? MoteKind.Focus : MoteKind.Vitality;
}

/** What a mote of `kind` is worth to this body, before `applyHealing` scales it. */
export function moteValueFor(body: ServerEntity, kind: number): number {
  if (kind === MoteKind.Focus) {
    return body.stats.maxResource * RESTORATION.mote.resourceFraction;
  }
  return body.stats.maxHealth * RESTORATION.mote.healthFraction;
}

/** How far a mote reaches for its owner. Perception's route. */
export function attractRadiusFor(body: ServerEntity): number {
  return RESTORATION.mote.attractRadius + Math.max(0, body.stats.traits.moteAttractRadius);
}

/**
 * `count` motes, scattered around the body they came from.
 *
 * The scatter is the golden angle by index rather than a draw from the `Rng`,
 * and that is a determinism decision rather than an aesthetic one: the
 * generator is threaded through the whole sim, so a kill that drew two values
 * would change every fight recorded after it. This way the number of motes is
 * free to depend on the build and the seed sequence never notices.
 */
export function scatterMotes(
  count: number,
  kind: number,
  amount: number,
  toward: number,
): readonly MoteSpawn[] {
  const motes: MoteSpawn[] = [];
  const radius = RESTORATION.mote.scatterRadius;
  const fan = RESTORATION.mote.scatterFan;
  for (let index = 0; index < count; index++) {
    // **Toward the killer, in a fan.** The first version burst along the
    // *victim's* facing plus the golden angle, which spread three motes nicely
    // and sent them in whatever direction the corpse happened to be looking --
    // so a monster facing away threw its drop further away, and a preview caught
    // one landing 102 units from the player when the body had died at 58. The
    // fiction is that the life leaves the body and comes to you; the geometry
    // should say the same thing.
    //
    // A bounded fan rather than the golden angle, for the same reason: the
    // golden angle is the right spread when direction does not matter, and here
    // it is the only thing that does. Centred, so an odd count sends one
    // straight at the killer and an even one splits around them.
    const angle = toward + (index - (count - 1) / 2) * fan;
    // Every mote travels, the single one included. It used to sit still when it
    // was alone, which is the *common* case -- so the hop that exists to make a
    // drop legible did nothing at all for most drops.
    motes.push({
      kind,
      amount,
      offsetX: Math.cos(angle) * radius,
      offsetY: Math.sin(angle) * radius,
    });
  }
  return motes;
}

/**
 * The direction a body's motes should burst in: at `to`, or `from`'s own facing
 * when the two are on the same spot and there is no line between them.
 */
export function scatterAngle(
  from: Pick<ServerEntity, 'position' | 'facing'>,
  to: Pick<ServerEntity, 'position'>,
): number {
  const dx = to.position.x - from.position.x;
  const dy = to.position.y - from.position.y;
  return Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dy, dx) : from.facing;
}

// --- the whole credit ----------------------------------------------------

export interface KillCredit {
  /** The killer, with their meter advanced and their bookkeeping stamped. */
  readonly killer: ServerEntity;
  readonly motes: readonly MoteSpawn[];
  readonly contribution: Contribution;
  /** Motes the elite guarantee added on top of what the meter produced. */
  readonly guaranteed: number;
}

/**
 * One kill, credited in full.
 *
 * The order is load-bearing and reads top to bottom:
 *
 *  1. **Eligibility.** Only a player is paid, and never for killing themselves.
 *     A monster that kills a monster generates nothing -- monsters do not need
 *     sustain, and paying them would be a mote nobody can collect.
 *  2. **The PvP feeding lock**, before anything is worked out, so a repeat kill
 *     on the same body costs the killer a status write and buys nothing.
 *  3. **Contribution**, then the meter, then the motes.
 *  4. **The elite guarantee**, which tops the *count* up without touching the
 *     meter. Laundering a guarantee into carry-over is the one way a guaranteed
 *     drop could have become farmable, and this is where it is refused.
 *  5. **The farm stack**, stamped last, so this kill is priced at what the
 *     spawner was worth *before* it and the next one pays for it.
 */
export function creditKill(
  killerIn: ServerEntity,
  victim: ServerEntity,
  qualities: KillQualities,
  tick: number,
): KillCredit {
  const none: KillCredit = {
    killer: killerIn,
    motes: [],
    contribution: NO_CONTRIBUTION,
    guaranteed: 0,
  };
  if (killerIn.kind !== EntityKindValue.Player) return none;
  if (killerIn.id === victim.id) return none;
  if (killerIn.health <= 0) return none;

  const pvp = victim.kind === EntityKindValue.Player;
  if (pvp && hasStatus(killerIn.statuses, pvpKillKey(victim.id), tick)) {
    return none;
  }

  const contribution = contributionFor(killerIn, victim, qualities, tick);
  if (contribution.total <= 0) return none;

  const advanced = advanceMeter(killerIn.restoration, contribution.total);
  let count = advanced.motes;
  let guaranteed = 0;

  // The elite guarantee: a reliable recovery moment for defeating something
  // significant, and once per spawner per window so a reset loop or a re-pull
  // is worth its meter progress and nothing more. Never in PvP -- a player kill
  // must not be a guaranteed reset, which is the whole of the snowball problem.
  const eliteWindow = eliteKey(victim);
  let statuses = killerIn.statuses;
  if (!pvp && isEliteType(victim.typeId) && !hasStatus(statuses, eliteWindow, tick)) {
    guaranteed = Math.max(0, RESTORATION.elite.motes - count);
    count += guaranteed;
    statuses = applyStatus(statuses, eliteWindow, tick, RESTORATION.elite.guaranteeTicks);
  }

  statuses = applyStatus(statuses, farmKey(victim), tick, RESTORATION.farm.windowTicks, {
    maxStacks: RESTORATION.farm.maxStacks,
  });
  if (pvp) {
    statuses = applyStatus(statuses, pvpKillKey(victim.id), tick, RESTORATION.pvp.victimTicks);
  }

  // Kind and value are the *killer's* deficit at the moment of generation, not
  // the collector's at the moment of pickup. They are the same body, and fixing
  // it here is what lets a mote's look be decided once and drawn honestly.
  const kind = moteKindFor(killerIn);
  return {
    killer: { ...killerIn, restoration: advanced.meter, statuses },
    // Burst out of the body *toward the killer* (spec 154), so the drop closes
    // some of the distance itself rather than adding to it.
    motes: scatterMotes(count, kind, moteValueFor(killerIn, kind), scatterAngle(victim, killerIn)),
    contribution,
    guaranteed,
  };
}

/**
 * An assist: the base only, into somebody else's meter.
 *
 * No bonuses (they belong to the blow that landed), no elite guarantee (that
 * belongs to whoever finished it), no motes at this corpse (they belong to the
 * killer). What it can do is cross the assisting player's own threshold, which
 * produces motes at *their* feet -- so a teammate's economy is never in the
 * killer's hands, and last-hitting takes the drop and not the credit.
 */
export function creditAssist(
  helper: ServerEntity,
  victim: ServerEntity,
  tick: number,
): KillCredit {
  if (helper.kind !== EntityKindValue.Player || helper.health <= 0) {
    return { killer: helper, motes: [], contribution: NO_CONTRIBUTION, guaranteed: 0 };
  }
  const base = baseContributionOf(victim) * farmFactorOf(helper, victim, tick);
  const total = base * RESTORATION.assistFraction;
  if (total <= 0) {
    return { killer: helper, motes: [], contribution: NO_CONTRIBUTION, guaranteed: 0 };
  }

  const advanced = advanceMeter(helper.restoration, total);
  const kind = moteKindFor(helper);
  return {
    killer: { ...helper, restoration: advanced.meter },
    // An assist's motes are already at the helper's feet, so there is no gap for
    // them to close: they burst along the helper's own heading, which is the
    // direction that body is looking anyway.
    motes: scatterMotes(advanced.motes, kind, moteValueFor(helper, kind), helper.facing),
    contribution: {
      base,
      farmFactor: 1,
      bonus: 0,
      sources: [{ reason: 'assist', amount: RESTORATION.assistFraction }],
      total,
    },
    guaranteed: 0,
  };
}

/**
 * The part of an overheal Wisdom puts back into the meter.
 *
 * The only path in the game from healing to the meter, and it is bounded twice
 * -- by the fraction Wisdom has bought, and by a cap expressed as a fraction of
 * one threshold -- so no amount of overhealing can fund a mote outright. A mote
 * that overheals is a mote that was already nearly wasted; this makes it
 * partly not wasted, which is what "reduced waste from overcapping" has to mean
 * if it is not to become a second economy.
 */
export function salvageFrom(body: ServerEntity, overheal: number): number {
  const rate = body.stats.traits.restoreSalvagePct;
  if (!(rate > 0) || !(overheal > 0)) return 0;
  const cap = RESTORATION.threshold * RESTORATION.stats.salvageCapFraction;
  return Math.min(cap, overheal * rate);
}

