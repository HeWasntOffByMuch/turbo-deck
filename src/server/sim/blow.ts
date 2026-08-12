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
 *   2. rolls         crit, then weak point -- crit FIRST, always
 *   3. amplify       weak point, exploit, catalysis, exposure, execute
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
 * Pure. The tick and the Rng are arguments.
 */

import type { Rng } from '../../shared/prng.js';
import { SERVER_TICK_RATE } from '../config.js';
import type { AbilityDefinition } from '../data/abilities.js';
import { applyArmor } from '../player/stats.js';
import { applyPoiseDamage, isResolute, poiseDamageOf } from './poise.js';
import {
  adaptationAgainst,
  adaptedKey,
  applyStatus,
  clearStatus,
  hasStatus,
  stacksOf,
  statusOf,
  StatusId,
  type Statuses,
} from './statuses.js';
import { ActivityValue, CastEndReason, type ServerEntity, type ServerSimEvent } from './types.js';

/** How much armour Sundered removes, and for how long. */
export const SUNDER_ARMOR = 0.1;
export const SUNDER_TICKS = Math.round(SERVER_TICK_RATE * 4);
/** How long `recentlyHit` lasts -- the window Perfect Exit reads. */
export const RECENTLY_HIT_TICKS = Math.round(SERVER_TICK_RATE * 0.5);
/** Perfect Exit's own cooldown, so a hit-trade loop cannot fund itself. */
export const PERFECT_EXIT_COOLDOWN_TICKS = Math.round(SERVER_TICK_RATE * 4);
/** Second Wind's, for the same reason. */
export const SECOND_WIND_COOLDOWN_TICKS = Math.round(SERVER_TICK_RATE * 20);
/** The bounty a Tactician's exposure leaves for everyone else. */
export const EXPOSED_BOUNTY = 'exposed.bounty';

export interface BlowResult {
  /** The attacker, with whatever the blow returned to it. */
  readonly attacker: ServerEntity;
  readonly target: ServerEntity;
  readonly events: readonly ServerSimEvent[];
  readonly rng: Rng;
}

function healthFraction(entity: ServerEntity): number {
  return entity.stats.maxHealth > 0 ? entity.health / entity.stats.maxHealth : 1;
}

/** Whether anything at all is on this body -- what Catalysis keys off. */
function afflicted(statuses: Statuses, tick: number): boolean {
  for (const [, value] of Object.entries(statuses)) {
    if (tick < value.expiresAtTick) return true;
  }
  return false;
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

  // --- 1 + 2: eligibility, then the two rolls, crit first ------------------
  const [critRoll, afterCrit] = rngIn.nextInt(0, 9999);
  let rng = afterCrit;
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
  // Two multipliers, and which one applies is the ability's own `basicAttack`
  // flag (spec 147). A swing scales with what you are swinging -- Strength, and
  // whatever the weapon adds -- and a spell scales with Intelligence. Before
  // this, every blow in the game scaled with `spellPower` and nothing scaled
  // with `attackDamage` at all, so a Strength build's damage stat was a number
  // on a sheet that reached nothing.
  const power = isBasicAttack ? A.weaponPower : attacker.stats.spellPower;
  let damage = ability.damage * power * (critical ? 1.75 : 1);

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
  if (A.vsAfflictedPct > 0 && afflicted(target.statuses, tick)) damage *= 1 + A.vsAfflictedPct;

  const staggered = target.activity === ActivityValue.Stunned;
  if (A.executeBonus > 0 && staggered && healthFraction(target) <= A.executeBelow) {
    damage *= 1 + A.executeBonus;
  }

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

  target = {
    ...target,
    health,
    shield: shieldLive - absorbed,
    activity: killed ? ActivityValue.Dead : target.activity,
    targetId: target.targetId ?? attacker.id,
    stillSinceTick: tick,
  };

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
  });

  // --- 6: poise -----------------------------------------------------------
  // A dead body has no guard to break, and the whole aftermath below is about
  // what a *live* exchange leaves behind.
  if (!killed) {
    const poiseMultiplier = weakPoint ? 1 + A.exploitPoiseFactor : 1;
    const poised = applyPoiseDamage(
      target,
      poiseDamageOf(attacker.stats, isBasicAttack, poiseMultiplier),
      tick,
      isBasicAttack,
    );
    target = poised.entity;
    if (poised.broke) {
      target = {
        ...target,
        activity: ActivityValue.Stunned,
        activityUntilTick: tick + D.staggerTicks,
        // A break costs the broken body its Flow. Agility's momentum is
        // explicitly a thing that can be taken away, which is what stops the
        // stack from being a passive.
        statuses: clearStatus(target.statuses, StatusId.Flow),
      };
      events.push({ kind: 'poiseBroken', entityId: target.id, breakerId: attacker.id, ticks: D.staggerTicks });
      if (poised.interrupted) {
        events.push({
          kind: 'castEnded',
          entityId: target.id,
          abilityId: poised.interrupted.abilityId,
          reason: CastEndReason.Interrupted,
        });
      }
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

  if (killed) events.push({ kind: 'died', entityId: target.id, killerId: attacker.id });

  // --- 7: aftermath -------------------------------------------------------
  target = markTarget(target, attacker, ability, tick, weakPoint);
  attacker = rewardAttacker(attacker, target, ability, tick, {
    weakPoint,
    killed,
    damage,
    overkill: killed && toHealth >= targetIn.health * (1 + 0.25),
  });

  return { attacker, target, events, rng };
}

/** What breaking somebody's guard is worth to the breaker. */
function rewardBreak(attacker: ServerEntity, tick: number): ServerEntity {
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
  if (A.appliesSundered > 0 && ability.basicAttack === true) {
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
  let statuses = next.statuses;

  if (outcome.weakPoint) {
    resource += A.weakPointResource;
    if (outcome.killed && A.weakPointKillHeal > 0) {
      health = Math.min(next.stats.maxHealth, health + next.stats.maxHealth * A.weakPointKillHeal);
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
