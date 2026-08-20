/**
 * Whether one body has business with another (spec 163).
 *
 * Every rule about *acquiring, holding and dropping* a target lives here; every
 * rule about walking there stays in `world.ts`. That split is the whole reason
 * this is a file rather than four more branches inside `monsterIntent`: before
 * it, the entire aggro system was one line in `blow.ts`
 * (`targetId: target.targetId ?? attacker.id`) and one deleted proximity scan,
 * and there was nowhere a fifth behaviour could be added without threading it
 * through the steering.
 *
 * Nothing here draws from the `Rng`, and nothing here reads a clock it was not
 * handed. Which temperaments are on a map therefore cannot shift a combat roll,
 * and a replay of the same seed meets the same monsters the same way.
 */

import { monsterById, noticeRangeOf, type Temperament } from '../data/monsters.js';
import { AggroValue, EntityKindValue, type ServerEntity, type ServerSimEvent } from './types.js';

/**
 * How far a fleeing body aims, past whatever it is running from.
 *
 * A goal rather than a direction, because a flight is routed with the same A*
 * a chase is (see `world.ts`) and a route needs somewhere to be. Comfortably
 * past the longest notice range in the table, so the point it aims at is never
 * somewhere it would arrive at mid-flight and stop.
 */
export const FLEE_DISTANCE = 900;

/** The row's temperament, or null for anything that is not a monster. */
export function temperamentOf(entity: ServerEntity): Temperament | null {
  if (entity.kind !== EntityKindValue.Monster) return null;
  return monsterById(entity.typeId)?.temperament ?? null;
}

/** Nothing to say about anybody: no target, no clock. */
function calm(entity: ServerEntity): ServerEntity {
  if (entity.targetId === null && entity.aggro === AggroValue.Calm && entity.aggroUntilTick === 0) {
    return entity;
  }
  return { ...entity, targetId: null, aggro: AggroValue.Calm, aggroUntilTick: 0 };
}

/** Committed: chasing and swinging, until the leash or a death takes it away. */
function engage(entity: ServerEntity, targetId: number): ServerEntity {
  if (entity.targetId === targetId && entity.aggro === AggroValue.Engaged) return entity;
  return { ...entity, targetId, aggro: AggroValue.Engaged, aggroUntilTick: 0 };
}

/**
 * What a landed blow does to the victim's mind.
 *
 * This replaces the one line in `blow.ts` that used to be the entire aggro
 * system, and keeps that line's behaviour exactly for everything with no
 * temperament to read -- a player, a prop, a body whose row has gone missing.
 */
export function provoke(target: ServerEntity, attackerId: number, tick: number): ServerEntity {
  const temperament = temperamentOf(target);
  if (!temperament) {
    // The pre-163 rule, untouched: the first thing to hit you is the thing you
    // hold, and later blows do not steal it.
    return target.targetId === null ? { ...target, targetId: attackerId } : target;
  }

  if (temperament.kind === 'skittish') {
    // The one place a target is *overwritten* rather than kept, and it has to
    // be: a body running away is running from whoever hit it last, and a grazer
    // that kept sprinting away from the first thing to touch it would run
    // straight into the second. A fresh blow also restarts the clock, so
    // something still being hit is still running.
    return {
      ...target,
      targetId: attackerId,
      aggro: AggroValue.Fleeing,
      aggroUntilTick: tick + temperament.fleeTicks,
    };
  }

  // Everything else fights, and a blow ends an alert early rather than waiting
  // it out -- a body that is shot while sizing you up has finished sizing you
  // up. `Engaged` is therefore assigned rather than merged, which is exactly
  // the Alert -> Engaged edge.
  return engage(target, target.targetId ?? attackerId);
}

/**
 * What standing near a player does to a calm monster's mind.
 *
 * A linear scan of the entity map, which is the same shape and the same size as
 * the one spec 076 removed. There is no broadphase in this repo and this does
 * not add one: it runs only for a body that is both calm and able to notice
 * anything at all, which is two comparisons for every monster that is neither.
 */
export function notice(
  monster: ServerEntity,
  entities: ReadonlyMap<number, ServerEntity>,
  tick: number,
): ServerEntity {
  if (monster.aggro !== AggroValue.Calm) return monster;
  const temperament = temperamentOf(monster);
  if (!temperament) return monster;
  // Switched on the union rather than asked through `noticeRangeOf`, so the two
  // temperaments that notice anything are the two the compiler lets read a
  // range -- the scan below cannot be reached with a body that has none.
  if (temperament.kind === 'skittish' || temperament.kind === 'defensive') return monster;

  const found = nearestQuarry(monster, entities, temperament.noticeRange);
  if (found === null) return monster;

  // Insertion order breaks a tie, via `nearestQuarry`'s strict `<` -- the same
  // rule the scan spec 076 deleted used, and deterministic for the same reason.
  if (temperament.kind === 'ferocious') return engage(monster, found);
  return {
    ...monster,
    targetId: found,
    aggro: AggroValue.Alert,
    aggroUntilTick: tick + temperament.alertTicks,
  };
}

/**
 * Whether an alert has run out, a flight has ended, or a quarry has backed off.
 *
 * Called every tick with the target already resolved by the caller, so a target
 * that died or left the world arrives here as null and takes the body straight
 * back to calm however it was feeling about it.
 */
export function settle(
  monster: ServerEntity,
  target: ServerEntity | null,
  tick: number,
): ServerEntity {
  // The two lines that make `Calm <-> targetId === null` an invariant rather
  // than a convention, and they are here rather than at each place a body is
  // built because there are several of those and the rule is one. A body
  // holding an id for something that is gone is calmed; a body handed a target
  // by something that did not set a mood -- an admin conjuring an attacker, a
  // test seeding a fight -- is committed to it, which is what handing it one
  // meant.
  if (!target) return calm(monster);
  if (monster.aggro === AggroValue.Calm) return engage(monster, target.id);

  if (monster.aggro === AggroValue.Fleeing) {
    // A flight ends on its clock and on nothing else. It is not ended by the
    // attacker leaving, because the whole behaviour is that the body does the
    // leaving.
    return tick >= monster.aggroUntilTick ? calm(monster) : monster;
  }

  if (monster.aggro === AggroValue.Alert) {
    const temperament = temperamentOf(monster);
    const range = temperament ? noticeRangeOf(temperament) : 0;
    // Backing out of an alert is an answer, not a tidy-up: the pause exists to
    // give the player a decision, and it would not be one if leaving did
    // nothing. Measured against the same range that started it, with no
    // hysteresis -- a body that walks the boundary flickers between calm and
    // alert, which is the honest report of somebody walking the boundary.
    if (range > 0 && !within(monster, target, range)) return calm(monster);
    return tick >= monster.aggroUntilTick ? engage(monster, target.id) : monster;
  }

  return monster;
}

/**
 * What a blow landed on one body does to the bodies around it.
 *
 * Driven off this tick's `hit` events rather than off a per-tick scan for an
 * ally who looks angry, and that is what keeps it bounded: a rallied body is not
 * itself hit, so it raises no call of its own. The call carries exactly one hop
 * from each *actual blow*, and a chain across the map would need a chain of
 * actual blows to carry it -- where the scan version cascades through any
 * overlapping pair of ranges for as long as one fight lasts.
 *
 * Runs before the dead are swept, so killing a spider still brings the nest.
 * Returns only the bodies it changed; an empty map is the common case and costs
 * nothing on a tick where nothing was hit.
 */
export function rally(
  events: readonly ServerSimEvent[],
  entities: ReadonlyMap<number, ServerEntity>,
): ReadonlyMap<number, ServerEntity> {
  const changed = new Map<number, ServerEntity>();
  for (const event of events) {
    if (event.kind !== 'hit') continue;
    // A pulse is not a blow, and is not a shout either (spec 190). The bound
    // this whole function rests on is one hop per blow; an affliction ticking
    // twenty times would raise twenty calls, each from wherever its applier had
    // walked to since. The blow that applied it already rallied.
    if (event.periodic) continue;
    const victim = entities.get(event.targetId);
    if (!victim || victim.kind !== EntityKindValue.Monster) continue;
    const attacker = entities.get(event.attackerId);
    // Onto a player and onto nothing else. Narrower than `isHostile` on
    // purpose: a monster caught by another monster's blast has been hurt by
    // something it has no quarrel with, and rallying the nest onto it would
    // turn one stray cone into a civil war.
    if (!attacker || attacker.kind !== EntityKindValue.Player) continue;
    if (attacker.health <= 0) continue;

    for (const ally of entities.values()) {
      if (ally.id === victim.id || ally.health <= 0) continue;
      // Already changed by an earlier hit this tick: it is engaged on whoever
      // called it first, and a second call is not a reason to switch.
      if (changed.has(ally.id)) continue;
      if (ally.aggro !== AggroValue.Calm) continue;
      const temperament = temperamentOf(ally);
      if (temperament?.kind !== 'ferocious') continue;
      // Measured from the *victim*, not from the attacker: what a body is
      // answering is a neighbour being hurt, so a nest guards its own rather
      // than reacting to somebody standing near it swinging at nothing.
      if (!within(ally, victim, temperament.assistRange)) continue;
      changed.set(ally.id, engage(ally, attacker.id));
    }
  }
  return changed;
}

/** Nearest living player within `range`, by id, or null. */
function nearestQuarry(
  monster: ServerEntity,
  entities: ReadonlyMap<number, ServerEntity>,
  range: number,
): number | null {
  let bestId: number | null = null;
  let bestSq = range * range;
  for (const other of entities.values()) {
    if (other.kind !== EntityKindValue.Player) continue;
    if (other.health <= 0) continue;
    const dx = other.position.x - monster.position.x;
    const dy = other.position.y - monster.position.y;
    const sq = dx * dx + dy * dy;
    // Strictly closer, so the first body in insertion order keeps a tie.
    if (sq < bestSq) {
      bestSq = sq;
      bestId = other.id;
    }
  }
  return bestId;
}

/** Squared-distance comparison, so noticing costs no square roots. */
function within(a: ServerEntity, b: ServerEntity, range: number): boolean {
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  return dx * dx + dy * dy <= range * range;
}
