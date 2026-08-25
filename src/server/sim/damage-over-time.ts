/**
 * Afflictions, pulsed (spec 190).
 *
 * The whole of "damage that arrives after the blow has walked away". One pass
 * over the world's bodies, one comparison per affliction they are carrying, and
 * no state kept anywhere but the {@link Statuses} map they are already in.
 *
 * **A pulse is not a blow, and that is the design rather than an omission.**
 * `resolveBlow` is the only damage path this game has ever had and every part
 * of it is about a *blow*: it rolls a crit and a weak point, it stamps
 * `RecentlyHit`, it stacks Adaptation against the ability that caused it, and
 * it `provoke`s. Run sixty times a second per afflicted body, each of those
 * turns into a fault:
 *
 *  - the crit roll draws from the Rng, and the **draw count is protocol** -- a
 *    burning body would shift every subsequent draw in the world;
 *  - `RecentlyHit` is a half-second reaction window and Perfect Exit reads it,
 *    so a poison would deny an Agility character their trait for its whole life;
 *  - Adaptation is keyed per ability and an affliction has no ability;
 *  - the body was already provoked by whatever applied this.
 *
 * So a pulse does the short, honest thing instead: shield, then health, then
 * the `hit` event so the number floats and the metrics see it. **No armour**,
 * no adaptation, no resolve, no reads -- an affliction is already inside, and
 * being the answer to a body you cannot get through is a role worth having.
 *
 * It draws **nothing from the Rng.** Spread takes the nearest eligible body and
 * breaks ties on entity id -- the rule `crowd.ts` already uses for the same
 * reason -- so adding an affliction to a fight cannot move a single draw in the
 * world after it.
 *
 * Pure. The tick is an argument, the world map is handed in, and the two
 * questions this module cannot answer for itself -- who is hostile to whom, and
 * which bodies are being simulated -- arrive as functions on {@link DotContext}
 * rather than as an import of `world.ts`, which imports this.
 */

import { RESTORATION } from '../data/restoration.js';
import { SCALING } from '../data/scaling.js';
import {
  dotById,
  dotDurationTicks,
  dotPulseDamage,
  dotPulseGuard,
  dotRampAt,
  type DotDefinition,
} from '../data/damage-over-time.js';
import { staggered } from './poise.js';
import { markAssist } from './restoration.js';
import {
  applyStatus,
  hasStatus,
  statusOf,
  StatusId,
  type Statuses,
  type StatusState,
} from './statuses.js';
import {
  ActivityValue,
  CastEndReason,
  EntityKindValue,
  type ServerEntity,
  type ServerSimEvent,
} from './types.js';

/**
 * The two facts this pass needs and cannot derive.
 *
 * Handed in rather than imported, because both live in `world.ts` and `world.ts`
 * calls this: two peers importing each other is a cycle even when ESM happens to
 * survive one, which is the reason `healing.ts` exists as its own file.
 */
export interface DotContext {
  /** Whether `b` is somebody `a` would fight. Used only to decide who catches. */
  readonly isHostile: (a: ServerEntity, b: ServerEntity) => boolean;
  /** Whether this body is in a chunk anybody is simulating. */
  readonly isSimulated: (entity: ServerEntity) => boolean;
}

/** What a body carrying nothing costs. */
const NO_EVENTS: readonly ServerSimEvent[] = [];

/**
 * How far Decay may push healing down.
 *
 * Floored for the reason `MIN_MOVE_SCALE` is: "suppresses" is not "prevents",
 * and an affliction that switched healing off outright would decide a fight on
 * its own. A row authoring something lower gets this instead.
 */
export const MIN_HEALING_SCALE = 0.2;

/**
 * Whether an affliction pulses on this tick.
 *
 * `elapsed > 0` is what stops the blow that applied it and its own first pulse
 * landing on the same tick -- a double dip that would make every affliction
 * worth one more pulse than its row says.
 */
function pulsesOn(held: StatusState, row: DotDefinition, tick: number): boolean {
  const elapsed = tick - held.appliedAtTick;
  return elapsed > 0 && elapsed % row.intervalTicks === 0;
}

/**
 * What one pulse of this affliction is worth on this body, right now.
 *
 * Four multipliers and each of them is a stated identity: the concentration
 * (`stacks`), the applier (`magnitude`, captured when it landed), the
 * escalation (Frostbite) and the exertion (Bleed).
 */
function pulseDamageFor(held: StatusState, row: DotDefinition, entity: ServerEntity, tick: number): number {
  // The escalation, from the table rather than from here, so the number a row
  // states it is worth in total and the number a body actually takes are the
  // same arithmetic (spec 190).
  const ramp = dotRampAt(row, tick - held.appliedAtTick);
  // Read off the replicated activity rather than measured here, so "stop moving
  // and it hurts less" is a fact anybody watching the fight can already see.
  const exerting =
    entity.activity === ActivityValue.Moving || entity.activity === ActivityValue.Casting;
  const exertion = exerting ? (row.exertionScale ?? 1) : 1;
  return dotPulseDamage(row) * held.stacks * Math.max(0, held.magnitude) * ramp * exertion;
}

/**
 * Whether a body is the sort of thing an affliction can be on at all.
 *
 * The same list every other pass in the tick keeps: a projectile is a body for
 * the purposes of flying, a mote drifts, a drop lies there, and a corpse is
 * done.
 */
export function afflictable(entity: ServerEntity): boolean {
  if (entity.health <= 0) return false;
  return entity.kind === EntityKindValue.Player || entity.kind === EntityKindValue.Monster;
}

/**
 * Puts an affliction on a body (spec 190).
 *
 * The one way a skill applies one, and the row is applied **whole**: no
 * per-skill duration, no per-skill rate. An affliction whose numbers depended
 * on which skill happened to land it is one the player carrying it cannot
 * reason about, and "content is data" means the data is the content.
 *
 * What does vary is the *applier*: their `spellPower` is captured into
 * `magnitude` the way Exposed already captures the exposer's own coefficient,
 * so an affliction is worth what the build that landed it was worth and does
 * not retroactively change when that build does.
 */
export function applyDot(
  target: ServerEntity,
  dotId: string,
  tick: number,
  source: ServerEntity,
): ServerEntity {
  const row = dotById(dotId);
  if (!row || !afflictable(target)) return target;
  return {
    ...target,
    statuses: landDot(target.statuses, row, tick, {
      durationTicks: dotDurationTicks(row),
      maxStacks: row.maxStacks,
      magnitude: Math.max(0, source.stats.spellPower),
      sourceId: source.id,
    }),
  };
}

/** Everything an affliction landing on a body is, past deciding to land it. */
export interface DotLanding {
  /** How long this application is worth. The row's own, unless it is a hop. */
  readonly durationTicks: number;
  /** The concentration ceiling. The row's own, unless a caller may not stack. */
  readonly maxStacks: number;
  /** The applier's spell power, or a copy of it for an affliction passed on. */
  readonly magnitude: number;
  readonly sourceId: number;
}

/**
 * One affliction onto one status map, whatever put it there (spec 223).
 *
 * The one description of what landing an affliction *is*, and there are three
 * callers of it precisely because the three differ only in the window and the
 * ceiling they hand it: {@link applyDot} lands the row whole, {@link spread}
 * lands what is left of one on the next body along, and `sim/aura-field.ts`
 * lands the linger a field is worth. Everything else about it -- the rider, the
 * source rule, the refresh rule -- is the same question three times, and a
 * second copy of it is how a hop ends up subtly unlike an application.
 *
 * That the rider was the divergence is not hypothetical: `spread` wrote its own
 * `applyStatus` and did not apply Corrosion's `Sundered`, which is invisible
 * only because no row that spreads has one. Routing all three through here
 * closes it before a row does.
 */
export function landDot(
  statuses: Statuses,
  row: DotDefinition,
  tick: number,
  landing: DotLanding,
): Statuses {
  let next = applyStatus(statuses, row.id, tick, landing.durationTicks, {
    maxStacks: landing.maxStacks,
    magnitude: landing.magnitude,
    sourceId: landing.sourceId,
  });
  // Corrosion's armour half, applied here rather than on each pulse.
  //
  // The armour is a **state that lasts as long as the affliction does**, not a
  // thing that happens every half second, and writing it per pulse got that
  // wrong twice: it re-stamped a shared status thirty times a fight -- which is
  // a status-list delta to every client in range, each time -- and because
  // `applyStatus` refreshes a clock rather than extending it, each stamp
  // *shortened* a longer Sundered that somebody else's build had applied. One
  // write, at the moment it lands, for exactly the affliction's own life.
  //
  // Through the status the game already has, so there is one armour-reduction
  // reader in `blow.ts` and not two.
  if (row.sunderMagnitude !== undefined && row.sunderMagnitude > 0) {
    next = applyStatus(next, StatusId.Sundered, tick, landing.durationTicks, {
      magnitude: row.sunderMagnitude,
      sourceId: landing.sourceId,
    });
  }
  return next;
}

/**
 * What healing on this body is multiplied by right now (spec 190).
 *
 * Built to {@link moveScaleOf}'s shape and for its stated reason: a timed state
 * living on `EffectiveStats` would either be recomputed every tick or go stale,
 * so it is read at the point of use instead.
 *
 * Health goes up in six places and only three of them go through
 * `applyHealing`, so this is read at three sites rather than one: there (which
 * covers the flask, Mend, a skill's heal and a collected mote), at **Second
 * Wind**, and at the **weak-point-kill heal**. A suppression that covered only
 * the first would stop working at exactly the moment a Constitution build needs
 * it, which is the one moment anybody would notice.
 *
 * Resting is deliberately not a fourth site. A pulse stamps `InCombat` and
 * `advanceRest` already refuses outright while that is live, so a burning
 * player cannot heal it off in town at *any* rate -- which is stronger than a
 * multiplier, and true of every affliction rather than only of Decay.
 */
export function healingScaleOf(statuses: Statuses, tick: number): number {
  let scale = 1;
  for (const [id, held] of Object.entries(statuses)) {
    if (tick >= held.expiresAtTick) continue;
    const row = dotById(id);
    if (!row || row.healingScale === undefined) continue;
    scale *= row.healingScale;
  }
  return scale === 1 ? 1 : Math.max(MIN_HEALING_SCALE, scale);
}

/**
 * Every affliction taken off a body, and nothing else (spec 190).
 *
 * What a respawn does. `respawn` has never cleared `statuses` and nothing had
 * ever noticed, because until now no status could hurt you -- a player who died
 * burning would have come back burning and taken the next pulse standing on the
 * spawn pad. Afflictions **only**, so death does not also cost the Flow or the
 * Attunement somebody built, which is not what death is meant to charge for.
 */
export function clearAfflictions(statuses: Statuses): Statuses {
  let stripped = false;
  for (const id of Object.keys(statuses)) {
    if (dotById(id)) {
      stripped = true;
      break;
    }
  }
  if (!stripped) return statuses;
  const next: Record<string, StatusState> = {};
  for (const [id, held] of Object.entries(statuses)) {
    if (!dotById(id)) next[id] = held;
  }
  return next;
}

/**
 * One tick of every affliction in the world.
 *
 * Mutates `working` and returns the events, the same contract `advanceMotes`
 * has. It runs **between the projectiles and the kill credit** because those
 * are the two things that bracket it: everything that can apply an affliction
 * has run, and `creditDeaths` is driven off this tick's `died` events, so a
 * pulse that kills has to have said so before it.
 */
export function pulseDots(
  working: Map<number, ServerEntity>,
  tick: number,
  context: DotContext,
): readonly ServerSimEvent[] {
  let events: ServerSimEvent[] | null = null;

  for (const entity of [...working.values()]) {
    if (!afflictable(entity)) continue;
    if (!context.isSimulated(entity)) continue;
    // The common case, and the reason this pass costs a map lookup rather than
    // a table walk: almost every body in the world is carrying nothing.
    const carried = Object.keys(entity.statuses);
    if (carried.length === 0) continue;

    let body = working.get(entity.id) ?? entity;
    for (const id of carried) {
      if (body.health <= 0) break;
      const row = dotById(id);
      if (!row) continue;
      const held = statusOf(body.statuses, id, tick);
      if (!held || !pulsesOn(held, row, tick)) continue;

      const pulsed = onePulse(body, held, row, tick, working, context);
      body = pulsed.entity;
      if (pulsed.events.length > 0) (events ??= []).push(...pulsed.events);
    }
    if (body !== entity) working.set(body.id, body);
  }

  return events ?? NO_EVENTS;
}

interface PulseResult {
  readonly entity: ServerEntity;
  readonly events: readonly ServerSimEvent[];
}

function onePulse(
  entityIn: ServerEntity,
  held: StatusState,
  row: DotDefinition,
  tick: number,
  working: Map<number, ServerEntity>,
  context: DotContext,
): PulseResult {
  const source = held.sourceId > 0 ? working.get(held.sourceId) ?? null : null;
  const events: ServerSimEvent[] = [];
  let entity = entityIn;

  // **Hostility is re-asked here, not only where the affliction was applied.**
  //
  // `isHostile` for two players requires *both* to be standing in a pvp zone,
  // and `world.ts` says why in as many words: reading only the attacker's zone
  // lets somebody reach into Hearthstead, and reading only the target's lets a
  // target retreat into safety mid-swing. A blow and a projectile are both
  // measured at the instant they land, against where both bodies are then.
  //
  // An affliction is the first damage in this game that outlives its own
  // delivery, so it is the first that could carry a wilderness fight across a
  // safe-zone line -- light somebody up, follow them into town, watch them die
  // there. Asking the same question every pulse is what makes a safe zone mean
  // the same thing for the seven new rows as it does for everything else.
  //
  // Only when there *is* a source: an affliction whose applier has left the
  // world, or one a developer trigger put on with no applier at all, has no
  // side to be measured against, and refusing it would make the trigger inert.
  if (source && !context.isHostile(source, entityIn)) return { entity, events };

  // --- the guard, first, and it can never break ---------------------------
  // Written straight into the pool and clamped at zero, which is spec 188's
  // `poise` effect and its argument: stripping a guard and knocking somebody
  // down are different asks, and an affliction that sometimes did the second
  // would stagger a body once a second for six seconds.
  const guard = dotPulseGuard(row) * held.stacks;
  if (guard > 0) {
    entity = { ...entity, poise: Math.max(0, entity.poise - guard) };
  }

  // --- the damage ---------------------------------------------------------
  const damage = pulseDamageFor(held, row, entity, tick);
  // A pulse worth nothing says nothing. Every `hit` event becomes a floating
  // number on somebody's screen, and a row whose applier had no spell power at
  // all -- or an affliction put on by a developer trigger -- would otherwise
  // throw a "0" over the body twice a second for its whole duration.
  if (!(damage > 0)) {
    if (row.spreadRadius !== undefined && source) {
      spread(entity, held, row, tick, working, context, source);
    }
    return { entity, events };
  }

  const before = entity.health;
  const shieldLive = tick < entity.shieldUntilTick ? entity.shield : 0;
  const absorbed = Math.min(shieldLive, damage);
  const toHealth = damage - absorbed;
  const health = Math.max(0, before - toHealth);
  const killed = health <= 0;

  let statuses = entity.statuses;
  if (!killed) {
    // The wide "you are in a fight" window, so a burning player cannot walk
    // into a rest zone and heal through it. Deliberately NOT `RecentlyHit`:
    // that one is a half-second reaction window and an affliction that held it
    // open would take Perfect Exit off an Agility build for its whole duration.
    statuses = applyStatus(statuses, StatusId.InCombat, tick, RESTORATION.rest.combatTicks);
    // A player whose affliction is doing the work has helped kill it, and the
    // assist system is one mark plus a lookup -- so it gets the mark.
    if (source && source.kind === EntityKindValue.Player) {
      statuses = markAssist(statuses, source.id, tick);
    }
  }

  entity = {
    ...entity,
    health,
    shield: shieldLive - absorbed,
    statuses,
    activity: killed ? ActivityValue.Dead : entity.activity,
    // Death drops a cast, exactly as `resolveBlow` makes it (blow.ts).
    //
    // This is the first death in this game that is not a blow, and getting it
    // wrong was not cosmetic: a player's entity survives death, the cast pass
    // refuses a corpse so nothing advances or cancels what it was holding, and
    // `respawn` rewrites eleven fields without touching `cast` -- so a
    // wind-up somebody died in came back with them and **landed from the spawn
    // pad on their first living tick**, at the coordinates they had aimed at
    // before dying, stamping the cooldown a second time. Until it resolved,
    // `startCast` refused every attack they pressed with `alreadyCasting`.
    cast: killed ? null : entity.cast,
  };

  events.push({
    kind: 'hit',
    // Not a blow, and `rally` reads this to know it (spec 190).
    periodic: true,
    // The source, so the number floats over the right body, `foldMetrics`
    // credits the right build, and a client that can see either end is told.
    attackerId: held.sourceId,
    targetId: entity.id,
    damage,
    targetHealth: health,
    killed,
    critical: false,
    blocked: false,
    weakPoint: false,
  });

  if (killed) {
    // And announces it, for the reason `blow.ts` states: a client roots itself
    // while it believes it is casting, so a field cleared in silence leaves a
    // player standing still for good.
    if (entityIn.cast) {
      events.push({
        kind: 'castEnded',
        entityId: entity.id,
        abilityId: entityIn.cast.abilityId,
        reason: CastEndReason.Interrupted,
      });
    }
    events.push({
      kind: 'died',
      entityId: entity.id,
      // Whoever applied it, which is the whole reason `sourceId` is on a
      // status: without it an affliction's kill pays nobody -- no restoration,
      // no assists, no loot roll, no metrics.
      killerId: held.sourceId > 0 ? held.sourceId : null,
      victimKind: entity.kind,
      victimTypeId: entity.typeId,
      qualities: {
        // Not a blow, so it cannot have found a weak point and it was never a
        // basic attack. The other three are facts about the moment and are read
        // off it rather than defaulted.
        weakPoint: false,
        overkill: toHealth >= before * (1 + SCALING.combat.overkillFraction),
        execution: staggered(entityIn, tick),
        untouched: source ? !hasStatus(source.statuses, StatusId.RecentlyHit, tick) : false,
        abilityKill: true,
      },
    });
  }

  // --- and who else catches it -------------------------------------------
  if (!killed && row.spreadRadius !== undefined && source) {
    spread(entity, held, row, tick, working, context, source);
  }

  return { entity, events };
}

/**
 * One hop, at most, per pulse.
 *
 * Burn's *"spreads"* and Shock's *"jumps to nearby targets"* are the same
 * question -- how does an affliction reach the body next to it -- so this is one
 * rule with two radii rather than two propagation systems.
 *
 * **What is passed on is what is left**, and that single sentence is also the
 * bound. A hop is only ever taken on a pulse, so the copy is always strictly
 * shorter-lived than its parent; every generation is shorter than the last, and
 * the chain therefore burns out by construction -- no generation counter, no hop
 * limit, and nothing to tune. Fire that has almost gone out spreads almost
 * nothing.
 *
 * Eligibility is measured against the **source**, not against the body it is
 * leaving: a player's fire spreads through the pack it was thrown into and can
 * never turn round and catch the player. An affliction whose source has left the
 * world stops spreading, because with nobody to measure sides against there is
 * no honest answer to who should catch it.
 *
 * Nothing is drawn: the nearest wins, ties break on entity id.
 */
function spread(
  entity: ServerEntity,
  held: StatusState,
  row: DotDefinition,
  tick: number,
  working: Map<number, ServerEntity>,
  context: DotContext,
  source: ServerEntity,
): void {
  const radius = row.spreadRadius ?? 0;
  const remaining = held.expiresAtTick - tick;
  if (radius <= 0 || remaining <= 0) return;

  let bestId = 0;
  let bestDistanceSq = radius * radius;
  for (const candidate of working.values()) {
    if (candidate.id === entity.id || candidate.id === source.id) continue;
    if (!afflictable(candidate) || !context.isSimulated(candidate)) continue;
    // Already carrying it is what makes the hop go somewhere new rather than
    // refreshing the body it came from, and is half of why the chain ends.
    if (statusOf(candidate.statuses, row.id, tick) !== null) continue;
    if (!context.isHostile(source, candidate)) continue;

    const dx = candidate.position.x - entity.position.x;
    const dy = candidate.position.y - entity.position.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > bestDistanceSq) continue;
    if (distanceSq === bestDistanceSq && bestId > 0 && candidate.id > bestId) continue;
    bestDistanceSq = distanceSq;
    bestId = candidate.id;
  }

  const caught = bestId > 0 ? working.get(bestId) : undefined;
  if (!caught) return;
  working.set(bestId, {
    ...caught,
    statuses: landDot(caught.statuses, row, tick, {
      durationTicks: remaining,
      maxStacks: row.maxStacks,
      magnitude: held.magnitude,
      sourceId: held.sourceId,
    }),
  });
}
