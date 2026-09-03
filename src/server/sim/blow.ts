/**
 * One blow, with the progression system applied to it (spec 147).
 *
 * `applyDamage` used to be nine lines: roll a crit, multiply by spell power,
 * subtract armour, subtract health. Six attributes turn that into a sequence
 * with real structure, and this file is that sequence written once, in order,
 * rather than scattered through the five places a blow can originate from.
 *
 * The order is the spec's and it is load-bearing:
 *
 * ```
 *   1. eligibility   is this blow allowed to find a weak point at all
 *   2. rolls         the weapon's range, then crit, then weak point
 *   3. base          the row's flat damage + its own letters + the weapon's
 *   3b. amplify      weak point, exploit, catalysis, exposure, execute
 *   4. mitigate      armour (less sundering), adaptation, resolve, reads, flow
 *   5. absorb        shield before health
 *   6. poise         guard damage, and the break if it empties
 *   7. aftermath     statuses left behind, resource returned, shields granted
 * ```
 *
 * **Crit is rolled before the weak point and always,** even when the weak-point
 * roll is skipped. That is not a style choice: the RNG is threaded through the
 * whole sim and a replay is only bit-identical if every body draws the same
 * number of values in the same order. Reordering these two lines changes every
 * fight that has ever been recorded.
 *
 * Amplifiers multiply and mitigators multiply, both against the same running
 * number, so two sources of 20% are 1.44x and two of -20% are 0.64x. Nothing
 * here adds a percentage to another percentage, which is the arithmetic that
 * makes a system stop being predictable once it has more than three sources.
 *
 * **Offensive sources add; everything else multiplies** (spec 238). There are
 * exactly three ways damage can enter a blow -- the ability's flat number, its
 * declared attribute letters, and a fraction of the weapon -- they are summed
 * once in step 3, and nothing below step 3 is a source. That is what makes
 * double-counting a structural impossibility rather than something to be
 * careful about: a reviewer checking "does Intelligence reach this twice" has
 * three addends to read and not a chain of multiplications spread over two
 * files. See `data/ability-scaling.ts` for what each addend is.
 *
 * Pure. The tick and the Rng are arguments.
 */

import type { Rng } from '../../shared/prng.js';
import { SERVER_TICK_RATE } from '../config.js';
import { SCALING } from '../data/scaling.js';
import { elementOfAbility, type AbilityDefinition } from '../data/abilities.js';
import { abilityAttributeBonus, abilityGradesOf, abilityWeaponFactor } from '../data/ability-scaling.js';
import { hasAffliction } from '../data/status-semantics.js';
import { applyArmor } from '../player/stats.js';
import { provoke } from './aggro.js';
import { healingScaleOf } from './damage-over-time.js';
import { applyPoiseDamage, guardImpactOf, isResolute, poiseDamageOf, stagger } from './poise.js';
import { enterCombat, markAssist } from './restoration.js';
import {
  adaptationAgainst,
  adaptedKey,
  applyStatus,
  hasStatus,
  stacksOf,
  statusOf,
  StatusId,
} from './statuses.js';
import {
  ActivityValue,
  CastEndReason,
  EntityKindValue,
  type ServerEntity,
  type ServerSimEvent,
} from './types.js';

/** How much armour Sundered removes, and for how long. */
export const SUNDER_ARMOR = 0.1;
export const SUNDER_TICKS = Math.round(SERVER_TICK_RATE * 4);
/** How long `recentlyHit` lasts -- the window Perfect Exit reads. */
export const RECENTLY_HIT_TICKS = Math.round(SERVER_TICK_RATE * 0.5);
/** Perfect Exit's own cooldown, so a hit-trade loop cannot fund itself. */
export const PERFECT_EXIT_COOLDOWN_TICKS = Math.round(SERVER_TICK_RATE * 4);
// Second Wind used to have a cooldown here beside Perfect Exit's, and it is
// gone (spec 239). It never once expired: the rule that read it re-armed the
// mechanic the moment health climbed back above its threshold, and the comeback
// itself does that on the tick it fires. What replaced it is not a longer
// number but a **lifecycle** -- consumed until a rest or a death, the two
// boundaries the flask already resets at. See `advanceProgression`.
/**
 * The bounty a Tactician's exposure leaves for everyone else.
 *
 * The id itself moved to {@link StatusId} in spec 240, where the rest of the
 * well-known ids are; this is the name every caller here already uses.
 */
export const EXPOSED_BOUNTY: string = StatusId.ExposedBounty;

export interface BlowResult {
  /** The attacker, with whatever the blow returned to it. */
  readonly attacker: ServerEntity;
  readonly target: ServerEntity;
  readonly events: readonly ServerSimEvent[];
  readonly rng: Rng;
}

/**
 * An integer in `[min, max]`, and the Rng that has spent the draw.
 *
 * Integral on purpose: at spec 217's magnitudes a fractional roll is a number
 * nobody can read off a damage popup, and what the attribute term adds on top
 * is fractional anyway. The ends are rounded rather than truncated so that a
 * range widened by a modifier keeps both of its ends reachable.
 *
 * Degenerate ranges are the common case rather than an edge one -- every
 * monster's is `min === max` -- so the draw is still taken and still spends the
 * same one value, which is what keeps a blow's draw count uniform.
 */
export function rollBetween(rng: Rng, min: number, max: number): [number, Rng] {
  const lo = Number.isFinite(min) ? Math.max(0, Math.round(min)) : 0;
  const hi = Number.isFinite(max) ? Math.max(lo, Math.round(max)) : lo;
  const [roll, next] = rng.nextInt(0, hi - lo);
  return [lo + roll, next];
}

function healthFraction(entity: ServerEntity): number {
  return entity.stats.maxHealth > 0 ? entity.health / entity.stats.maxHealth : 1;
}

/**
 * The whole of one blow.
 *
 * Returns both bodies because a blow now changes the attacker too -- resource
 * from a weak point, a shield from ability damage, momentum from a break. Every
 * caller has the attacker in hand and must write it back; `advanceCast` already
 * folds a returned caster into its local copy, and `world.ts` does the same for
 * a projectile's owner.
 */
export function resolveBlow(
  ability: AbilityDefinition,
  attackerIn: ServerEntity,
  targetIn: ServerEntity,
  tick: number,
  rngIn: Rng,
): BlowResult {
  let attacker = attackerIn;
  let target = targetIn;
  const events: ServerSimEvent[] = [];
  const A = attacker.stats.traits;
  const D = target.stats.traits;
  const isBasicAttack = ability.basicAttack === true;

  // --- 1 + 2: eligibility, then the rolls, the weapon's own first ----------
  //
  // The damage roll leads (spec 217), and it is drawn for a blow that carries
  // some of the weapon: a basic attack, or an ability declaring a `weapon`
  // fraction (spec 238). Conditioning on the ability's own row is safe where
  // conditioning on a *chance* would not be -- both are fixed for a given
  // ability id, so two replays of the same inputs always draw the same count.
  // `weakPointChance > 0` below is the shape to be careful of, and it is
  // already there.
  //
  // The Rng draw count is protocol, so adding this moved every seeded combat
  // sequence in the tree once. That is the cost of a weapon having damage of
  // its own, and it is paid here rather than smeared over a special case. No
  // production ability declares a `weapon` fraction today, so spec 238 moved
  // none of them a second time.
  let rng = rngIn;
  let weaponRoll = 0;
  // A weapon roll is drawn for a basic attack, and for an ability that declares
  // a `weapon` fraction (spec 238). Both conditions are properties of the *row*
  // -- fixed for an ability id -- so two replays of the same inputs draw the
  // same count in the same order, which is the rule this block is written under.
  const weaponFactor = isBasicAttack ? 1 : abilityWeaponFactor(ability.scaling);
  if (weaponFactor > 0) {
    const [roll, afterRoll] = rollBetween(rng, attacker.stats.weaponDamageMin, attacker.stats.weaponDamageMax);
    weaponRoll = roll;
    rng = afterRoll;
  }

  const [critRoll, afterCrit] = rng.nextInt(0, 9999);
  rng = afterCrit;
  const critical = critRoll / 10000 < attacker.stats.critChance;

  const mayWeakPoint = isBasicAttack || A.abilityWeakPoints > 0;
  const vulnerable = hasStatus(target.statuses, StatusId.Vulnerable, tick);
  const flowStacks = stacksOf(attacker.statuses, StatusId.Flow, tick);
  const weakPointChance = mayWeakPoint
    ? Math.min(
        0.95,
        (A.weakPointChance + flowStacks * A.flowWeakPoint) *
          (vulnerable ? A.vulnerableWeakPointFactor : 1),
      )
    : 0;
  let weakPoint = false;
  if (weakPointChance > 0) {
    const [roll, afterWeak] = rng.nextInt(0, 9999);
    rng = afterWeak;
    weakPoint = roll / 10000 < weakPointChance;
  }

  // --- 3: amplify ---------------------------------------------------------
  //
  // **Where a blow's base number comes from** (specs 147, 217, 231). This is
  // the answer to "why did this hit for that", and it is three addends and
  // nothing else:
  //
  // ```
  //   base = ability.damage                 the row's own flat number
  //        + abilityAttributeBonus(...)     its declared STR/AGI/INT letters
  //        + weaponRoll * weaponFactor      the fraction of the weapon it is
  // ```
  //
  // A **basic attack** is the third addend alone: `weaponFactor` is 1, the row
  // authors `damage: 0` and declares no letters of its own, so `base` is the
  // weapon's rolled range -- which already carries spec 216's attribute term,
  // the flat bonuses and the percentage. That is bit-for-bit what this line did
  // before spec 238, and `ability-scaling.test.ts` asserts it rather than
  // leaving it as a claim.
  //
  // **Nothing enters twice, and each addend is why:**
  //
  //  - `ability.damage` is a constant on the row and is multiplied by nothing.
  //    It used to be multiplied by `spellPower`, which is how every active
  //    ability in the game became an Intelligence ability.
  //  - the attribute term reads each of the three attributes exactly once, at
  //    the one grade the row declares for it. `spellPower` is inside it and
  //    only on Intelligence, and its own Intelligence term was removed when
  //    this landed, so Intelligence is linear rather than quadratic.
  //  - the weapon term is the weapon's *whole* resolved damage, so a weapon's
  //    own letters live in it and are not re-applied by the ability. An
  //    ability's letters and its weapon's are separate addends for exactly this
  //    reason: nested, a hybrid would multiply one by the other.
  //
  // Everything after this point is a multiplier on the running number -- crit,
  // weak point, exposure, armour, adaptation -- and none of them is an
  // offensive *source*, so none of them can double-count one.
  const base =
    ability.damage +
    (isBasicAttack
      ? 0
      : abilityAttributeBonus(
          attacker.stats.scalingAttributes,
          abilityGradesOf(ability.scaling),
          attacker.stats.spellPower,
        )) +
    weaponRoll * weaponFactor;
  let damage = base * (critical ? 1.75 : 1);

  if (weakPoint) {
    const still = tick - attacker.stillSinceTick >= A.steadyAimTicks ? A.steadyAimPct : 0;
    damage *= A.weakPointMultiplier * (1 + still);
    // Exploit reads the exposure that was there *before* this blow, so the hit
    // that applies the mark can never be the hit that cashes it in. That is the
    // whole reason Perception's payoff is a two-step play rather than a bigger
    // number on every swing.
    if (A.exploitDamagePct > 0 && hasStatus(target.statuses, StatusId.Exposed, tick)) {
      damage *= 1 + A.exploitDamagePct;
    }
  }

  const exposed = statusOf(target.statuses, StatusId.Exposed, tick);
  if (exposed) damage *= 1 + exposed.magnitude;
  // **Catalysis, against a body that is actually suffering from something**
  // (spec 240). `hasAffliction` reads `data/status-semantics.ts`, which is the
  // one place a status says what kind of thing it is.
  //
  // This used to be a local `afflicted` that returned true if *any* entry on
  // the body was live -- and every blow stamps `recentlyHit` and `inCombat` on
  // what it lands on, so the Intelligence skill whose whole identity is
  // rewarding a set-up was "8% more damage to anything you have hit once", on
  // every target in the game.
  if (A.vsAfflictedPct > 0 && hasAffliction(target.statuses, tick)) damage *= 1 + A.vsAfflictedPct;

  const staggered = target.activity === ActivityValue.Stunned;
  if (A.executeBonus > 0 && staggered && healthFraction(target) <= A.executeBelow) {
    damage *= 1 + A.executeBonus;
  }

  // Captured before the mitigation below, because the execution bonus in the
  // health economy asks whether the body was staggered *when it was hit*, and
  // the poise pass a few lines down is free to stagger it afterwards. Reading
  // `activity` at the end would count a blow that caused the stagger as one that
  // exploited it.
  const wasStaggered = staggered;
  const raw = damage;

  // --- 4: mitigate --------------------------------------------------------
  const sundered = statusOf(target.statuses, StatusId.Sundered, tick);
  const armor = Math.max(0, target.stats.armor - (sundered?.magnitude ?? 0));
  damage = applyArmor(damage, { ...target.stats, armor });

  damage *= 1 - adaptationAgainst(target.statuses, ability.id, tick, D.adaptationPerStack, D.adaptationCap);
  if (isResolute(target)) damage *= 1 - D.resoluteReduction;
  if (D.vsVulnerableReduction > 0 && hasStatus(attacker.statuses, StatusId.Vulnerable, tick)) {
    damage *= 1 - D.vsVulnerableReduction;
  }
  const targetFlow = stacksOf(target.statuses, StatusId.Flow, tick);
  if (targetFlow > 0 && D.flowArmorPct > 0) {
    damage *= Math.max(0.5, 1 - targetFlow * D.flowArmorPct);
  }
  damage = Math.max(0, damage);

  // --- 5: absorb ----------------------------------------------------------
  // A shield is spent before health and is *not* refunded by anything. It
  // expires whole rather than decaying, which is what makes it readable: a
  // player can see how much buffer they have and know it is all there until it
  // is all gone.
  const shieldLive = tick < target.shieldUntilTick ? target.shield : 0;
  const absorbed = Math.min(shieldLive, damage);
  const toHealth = damage - absorbed;
  const health = Math.max(0, target.health - toHealth);
  const killed = health <= 0;
  const overkill = killed && toHealth >= targetIn.health * (1 + SCALING.combat.overkillFraction);

  // What being hit does to the victim's *mind* is `provoke`'s to say (spec 163)
  // and not this function's. Until then it was one line here -- `targetId ??
  // attacker.id` -- which was the entire aggro system, and which could only ever
  // express "fights back". A grazer that bolts and a spider that calls its nest
  // are the same event arriving at a different temperament.
  target = provoke(
    {
      ...target,
      health,
      shield: shieldLive - absorbed,
      activity: killed ? ActivityValue.Dead : target.activity,
      stillSinceTick: tick,
      // Taking a blow breaks the artillery stance as well as the lull
      // (spec 270). Two fields because they answer to two attributes -- this
      // one is Intelligence's and is otherwise untouched by casting -- and one
      // sentence, so a hit cannot reset one and leave the other running.
      stanceSinceTick: tick,
    },
    attacker,
    tick,
  );

  events.push({
    kind: 'hit',
    attackerId: attacker.id,
    targetId: target.id,
    damage,
    targetHealth: health,
    killed,
    critical,
    blocked: armor > 0 && damage < raw,
    weakPoint,
    // What it was made of, for the picture (spec 232). Derived from the row --
    // an affliction-carrying ability is its affliction's element -- so nothing
    // in this function decides it and no blow can disagree with the skill that
    // threw it.
    element: elementOfAbility(ability),
  });

  // --- 6: poise -----------------------------------------------------------
  // A dead body has no guard to break, and the whole aftermath below is about
  // what a *live* exchange leaves behind.
  if (!killed) {
    const poiseMultiplier = weakPoint ? 1 + A.exploitPoiseFactor : 1;
    // What the blow weighs (spec 271): the weapon's impact for a swing, the
    // ability's own for a skill. Zero for a row that authors none, which is
    // every row that carried no Guard pressure before this spec.
    const impact = guardImpactOf(ability, attacker.stats);
    const poised = applyPoiseDamage(
      target,
      poiseDamageOf(attacker.stats, impact, poiseMultiplier),
      tick,
      isBasicAttack,
    );
    target = poised.entity;
    if (poised.broke) {
      // What a stagger *is* lives in `sim/poise.ts` since spec 188, because a
      // skill can now apply one directly and two copies of these lines would be
      // two answers to the same question. `applyPoiseDamage` has already
      // checked the immunity and taken the cast off, so the cast it dropped is
      // passed in rather than read back off a body that no longer has it.
      // **`A`, not `D`** (spec 243). `staggerTicks` is Strength's, it sits in
      // `SCALING.strength` beside the poise damage a blow carries, and it means
      // *how long the break you caused lasts* -- so it is the attacker's, the
      // way `staggerPower` two lines of arithmetic above it already is.
      //
      // Read off the defender it was Strength scaling the holder's **own**
      // stagger: 31 ticks at 5 Strength and 42 at 60, so investing in the
      // overpower attribute bought a longer time on the floor and bought the
      // body that broke you nothing at all. Backwards progression in exactly
      // the sense `player/progression-audit.ts` exists to catch, and it caught
      // it -- it was allowlisted for four specs while the semantic was decided.
      const struck = stagger(target, attacker.id, A.staggerTicks, tick, poised.interrupted);
      target = struck.entity;
      events.push(...struck.events);
      attacker = rewardBreak(attacker, tick);
    }
  } else if (target.cast) {
    // Death still drops a cast, and still announces it: a client roots itself
    // while it believes it is casting, so silently clearing the field leaves a
    // player stuck on the spot for good (spec 062).
    events.push({
      kind: 'castEnded',
      entityId: target.id,
      abilityId: target.cast.abilityId,
      reason: CastEndReason.Interrupted,
    });
    target = { ...target, cast: null };
  }

  if (killed) {
    // What was good about this kill, for the health economy to price (spec 156).
    // Nothing here is measured for this purpose: all five are facts the blow
    // above already had to establish. `untouched` is the one that reads off the
    // *attacker*, and it is the mark `markTarget` leaves on everyone it hits --
    // so "I did not get hit doing that" is answered by the same status Perfect
    // Exit reads, rather than by a second window that could drift from it.
    events.push({
      kind: 'died',
      entityId: target.id,
      killerId: attacker.id,
      // What died, because in a moment there will be nothing left to ask
      // (spec 164). Read off the body in hand rather than from its id.
      victimKind: target.kind,
      victimTypeId: target.typeId,
      qualities: {
        weakPoint,
        overkill,
        execution: wasStaggered,
        untouched: !hasStatus(attacker.statuses, StatusId.RecentlyHit, tick),
        abilityKill: !isBasicAttack,
      },
    });
  }

  // --- 7: aftermath -------------------------------------------------------
  target = markTarget(target, attacker, ability, tick, weakPoint);
  attacker = rewardAttacker(attacker, target, ability, tick, {
    weakPoint,
    killed,
    damage,
    overkill,
  });

  return { attacker, target, events, rng };
}

/**
 * What breaking somebody's guard is worth to the breaker.
 *
 * Exported since spec 271 because a skill can break a Guard too: `skill-effects`
 * calls it on the `poiseDamage` break path, so a break caused by Guard Break
 * pays out exactly as one caused by a swing. Without that, the ability half of
 * the Strength loop stopped at the break and never reached Momentum -- which is
 * the whole of "break -> seize initiative".
 */
export function rewardBreak(attacker: ServerEntity, tick: number): ServerEntity {
  const A = attacker.stats.traits;
  let next = attacker;

  if (A.breakResource > 0) {
    next = { ...next, resource: Math.min(next.stats.maxResource, next.resource + A.breakResource) };
  }
  if (A.breakCooldownRefund > 0) {
    const cooldowns: Record<string, number> = {};
    for (const [id, readyAt] of Object.entries(next.cooldowns)) {
      const remaining = readyAt - tick;
      cooldowns[id] = remaining > 0 ? readyAt - Math.floor(remaining * A.breakCooldownRefund) : readyAt;
    }
    next = { ...next, cooldowns };
  }
  // The *magnitude* is the breaker's, captured now. What the window is worth was
  // decided by the build that caused the break, not by whatever the body happens
  // to have on it when it cashes the window in.
  if (A.momentumTicks > 0 && A.momentumWindupScale > 0) {
    next = {
      ...next,
      statuses: applyStatus(next.statuses, StatusId.Momentum, tick, A.momentumTicks, {
        magnitude: A.momentumWindupScale,
      }),
    };
  }
  return next;
}

/** Everything the blow leaves *on* the body it hit. */
function markTarget(
  target: ServerEntity,
  attacker: ServerEntity,
  ability: AbilityDefinition,
  tick: number,
  weakPoint: boolean,
): ServerEntity {
  if (target.health <= 0) return target;
  const A = attacker.stats.traits;
  const D = target.stats.traits;
  let statuses = target.statuses;

  // Adaptation is the victim's, and it accrues on every hit rather than on the
  // second: the first stack is worth `adaptationPerStack` and the cap does the
  // rest. Keyed per ability, so learning to eat a Quake teaches you nothing
  // about an arrow.
  if (D.adaptationPerStack > 0 && D.adaptationTicks > 0) {
    statuses = applyStatus(statuses, adaptedKey(ability.id), tick, D.adaptationTicks, {
      maxStacks: Math.max(1, Math.ceil(D.adaptationCap / D.adaptationPerStack)),
    });
  }
  statuses = applyStatus(statuses, StatusId.RecentlyHit, tick, RECENTLY_HIT_TICKS);
  // And the wider "you are in a fight" window, which only resting reads
  // (spec 156). Both, because they answer different questions at different
  // widths -- see `StatusId.InCombat`.
  statuses = enterCombat(statuses, tick);

  // "This player hit me", left on the victim for its death to read (spec 156).
  // The whole assist system is this line plus a lookup: no threat table, no
  // damage ledger, nothing to keep in step with the damage that actually
  // happened -- the mark a blow was always going to leave is the mark the kill
  // reads, and it expires on its own like every other status here.
  //
  // Players only. A monster that helped kill another monster has no meter to
  // credit, and marking it would be an entry nothing ever looks up.
  if (attacker.kind === EntityKindValue.Player) {
    statuses = markAssist(statuses, attacker.id, tick);
  }

  if (weakPoint && A.exposeTicks > 0 && A.exposedDamagePct > 0) {
    statuses = applyStatus(statuses, StatusId.Exposed, tick, A.exposeTicks, {
      magnitude: A.exposedDamagePct,
    });
    if (A.exposedTeamResource > 0) {
      statuses = applyStatus(statuses, EXPOSED_BOUNTY, tick, A.exposeTicks, {
        magnitude: A.exposedTeamResource,
      });
    }
  }
  // Catalysis's second half (spec 270). The gate was `ability.basicAttack ===
  // true`, which is what the field meant when a Strength/Intelligence pair
  // granted it and nothing does now; read against **the target already carrying
  // an affliction** it is the specialization's own trigger instead, and the
  // sentence the row prints -- *what is already suffering suffers more, and its
  // armour gives* -- is one mechanic rather than two unrelated ones sharing a
  // tooltip.
  //
  // Asked of the statuses the target had **coming in**, not of `statuses`: this
  // blow may have just applied the affliction itself, and sundering off your own
  // application would make the "already" in the trigger a lie.
  if (A.appliesSundered > 0 && hasAffliction(target.statuses, tick)) {
    statuses = applyStatus(statuses, StatusId.Sundered, tick, SUNDER_TICKS, { magnitude: SUNDER_ARMOR });
  }

  return statuses === target.statuses ? target : { ...target, statuses };
}

/** Everything the blow returns to the body that threw it. */
function rewardAttacker(
  attacker: ServerEntity,
  target: ServerEntity,
  ability: AbilityDefinition,
  tick: number,
  outcome: {
    readonly weakPoint: boolean;
    readonly killed: boolean;
    readonly damage: number;
    readonly overkill: boolean;
  },
): ServerEntity {
  const A = attacker.stats.traits;
  let next = attacker;
  let resource = next.resource;
  let health = next.health;
  // Landing a blow puts *you* in a fight too (spec 156), and it is stamped here
  // rather than in `markTarget` because that one skips a body it just killed --
  // and a player standing over a corpse in the safe zone has very much been
  // fighting.
  let statuses = enterCombat(next.statuses, tick);

  if (outcome.weakPoint) {
    resource += A.weakPointResource;
    if (outcome.killed && A.weakPointKillHeal > 0) {
      // Third of the three restorations that never touch `applyHealing`, and so
      // the third that has to consult the suppression itself (spec 190).
      const mend =
        next.stats.maxHealth * A.weakPointKillHeal * healingScaleOf(next.statuses, tick);
      health = Math.min(next.stats.maxHealth, health + mend);
    }
    if (A.attunedFromWeakPoints > 0 && A.attunedTicks > 0) {
      statuses = applyStatus(statuses, StatusId.Attuned, tick, A.attunedTicks, {
        maxStacks: A.attunedMaxStacks,
      });
    }
  }

  // Wisdom's Conservation: an *ability* that connected. A basic attack is
  // excluded deliberately -- auto-attacking is not a decision, and paying
  // efficiency for it would make Wisdom the stat you take for standing there.
  if (!ability.basicAttack && A.attunedCostPct > 0 && A.attunedTicks > 0) {
    statuses = applyStatus(statuses, StatusId.Attuned, tick, A.attunedTicks, {
      maxStacks: A.attunedMaxStacks,
    });
  }

  if (outcome.overkill && A.overkillResource > 0) resource += A.overkillResource;

  // The Intelligence+Constitution loop: ability damage becomes buffer. Capped by
  // `maxShield` like every other shield source, which is what stops a mage from
  // out-tanking a Constitution build by casting at a training dummy.
  let shield = tick < next.shieldUntilTick ? next.shield : 0;
  let shieldUntilTick = next.shieldUntilTick;
  if (!ability.basicAttack && A.damageToShield > 0 && A.maxShield > 0 && outcome.damage > 0) {
    shield = Math.min(A.maxShield, shield + outcome.damage * A.damageToShield);
    shieldUntilTick = tick + Math.max(1, A.overhealShieldTicks || SUNDER_TICKS);
  }

  // The Tactician's bounty: hitting a body somebody else exposed pays *you*.
  // Read off the target rather than off the attacker, which is what makes it a
  // team effect rather than a self-buff with extra steps.
  const bounty = statusOf(target.statuses, EXPOSED_BOUNTY, tick);
  if (bounty) resource += bounty.magnitude;

  next = {
    ...next,
    resource: Math.min(next.stats.maxResource, resource),
    health: Math.min(next.stats.maxHealth, health),
    shield,
    shieldUntilTick,
    statuses,
  };
  return next;
}
