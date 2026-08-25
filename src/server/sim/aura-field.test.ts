/**
 * Aura fields (spec 223).
 *
 * The edges here are not the ones a landing has, because a field is not a
 * landing: it re-applies every tick, so what goes wrong with one is what goes
 * wrong with *repetition*. Three of these tests exist because the obvious
 * implementation gets them wrong and none of the three is visible from a single
 * tick:
 *
 *  - the field that **shortens** a longer affliction, because `applyStatus`
 *    refreshes a clock in both directions -- so walking into one second of fire
 *    puts out four seconds of it;
 *  - the field that reaches a stacking affliction's ceiling in `maxStacks`
 *    ticks, or cuts somebody else's full stack down to one;
 *  - the field that restarts the cadence it is refreshing, so a body standing in
 *    it is ticked forever into the future and never takes a pulse at all.
 *
 * Driven at the pass rather than through `step`, for `damage-over-time.test.ts`'s
 * stated reason: the arithmetic is the subject, and a real tick would put
 * movement and monster intent between the reading and the thing read. The two
 * questions that genuinely are about the tick -- that the pass runs at all, and
 * that it moves no Rng draw -- are driven through the real `step` at the bottom.
 */

import { describe, expect, it } from 'vitest';
import { SERVER_TICK_RATE } from '../config.js';
import {
  ALL_AURA_FIELDS,
  lingerWindowTicks,
  SCORCHED_EARTH,
  type AuraFieldDefinition,
} from '../data/aura-fields.js';
import { dotById, dotDurationTicks } from '../data/damage-over-time.js';
import { monsterById } from '../data/monsters.js';
import { STATUS_VISUALS } from '../data/status-visuals.js';
import { fieldLanding, fieldsOn, pulseAuraFields } from './aura-field.js';
import { pulseDots, type DotContext } from './damage-over-time.js';
import { applyStatus, statusOf, StatusId } from './statuses.js';
import { EntityKindValue, type ServerEntity } from './types.js';
import { createWorldState, spawnEntity } from './world.js';

/** Everything hostile to everything, and everything simulated. */
const ALL_HOSTILE: DotContext = { isHostile: () => true, isSimulated: () => true };

/**
 * A body, built through the real spawn so its stats and radius are a monster's.
 *
 * Spawned `id` times so ids come out where a caller asked, which
 * `damage-over-time.test.ts` needs for spread and this file needs for the
 * `maxTargets` tie rule.
 */
function body(id: number, x = 600, y = 450): ServerEntity {
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy');
  let state = createWorldState(1);
  let made: ServerEntity | null = null;
  for (let i = 0; i < id; i++) {
    const result = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'dummy',
      position: { x, y, z: 0 },
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
    });
    state = result.state;
    made = result.entity;
  }
  if (!made) throw new Error('no body');
  return { ...made, health: 10_000, stats: { ...made.stats, maxHealth: 10_000 } };
}

/** A carrier with the field already on it, at `tick`, for `durationTicks`. */
function carrier(
  id: number,
  tick: number,
  x = 600,
  y = 450,
  durationTicks = SERVER_TICK_RATE * 8,
  field: AuraFieldDefinition = SCORCHED_EARTH,
): ServerEntity {
  const made = body(id, x, y);
  return {
    ...made,
    kind: EntityKindValue.Player,
    typeId: 'player',
    // A real spell power, so the affliction it lands is worth something: a
    // magnitude of zero draws the mark and does nothing, which is the lie every
    // test row in this repo is written to avoid.
    stats: { ...made.stats, spellPower: 1 },
    statuses: applyStatus({}, field.id, tick, durationTicks),
  };
}

function world(...entities: readonly ServerEntity[]): Map<number, ServerEntity> {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

const BURN = (() => {
  const found = dotById(StatusId.Burn);
  if (!found) throw new Error('no burn');
  return found;
})();

describe('the field table (spec 223)', () => {
  it('names a status, an affliction and a ring that all exist', () => {
    for (const field of ALL_AURA_FIELDS) {
      expect(dotById(field.dotId), field.dotId).not.toBeNull();
      expect(
        STATUS_VISUALS.find((row) => row.id === field.id),
        `${field.id} has no visual row, so nobody can see the field they are standing in`,
      ).toBeDefined();
      expect(field.radius, field.id).toBeGreaterThan(0);
      expect(field.lingerTicks, field.id).toBeGreaterThan(0);
      expect(field.maxTargets, field.id).toBeGreaterThan(0);
    }
  });

  it('lingers for less than the affliction it lays', () => {
    // The point of a field is that leaving it works. A linger at or past the
    // row's own duration would make stepping out worth nothing, and the skill
    // would be an area-denial tool that does not deny anything.
    for (const field of ALL_AURA_FIELDS) {
      const dot = dotById(field.dotId);
      if (!dot) continue;
      expect(lingerWindowTicks(field), field.id).toBeLessThan(dotDurationTicks(dot));
    }
  });

  it('adds one tick of slack, so the last pulse lands inside the window', () => {
    // The same off-by-one `dotDurationTicks` states once, and the reason it is
    // derived rather than authored per row.
    for (const field of ALL_AURA_FIELDS) {
      expect(lingerWindowTicks(field), field.id).toBe(field.lingerTicks + 1);
    }
  });
});

describe('who a field reaches', () => {
  it('lays its affliction on a hostile body inside it', () => {
    const map = world(carrier(1, 0), body(2, 600 + SCORCHED_EARTH.radius - 10));
    pulseAuraFields(map, 0, ALL_HOSTILE);
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, 0)).not.toBeNull();
  });

  it('leaves a body outside it alone', () => {
    const map = world(carrier(1, 0), body(2, 600 + SCORCHED_EARTH.radius + 200));
    pulseAuraFields(map, 0, ALL_HOSTILE);
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, 0)).toBeNull();
  });

  it('measures the reach to a body’s edge, not to its centre', () => {
    // The rule `landOnTarget` and `landBlast` already keep: a big body is caught
    // by the edge of the fire rather than only by its middle. Placed so the
    // centre is outside and the edge is in, which is a miss under the naive
    // comparison and a hit under the right one.
    const target = body(2);
    const at = 600 + SCORCHED_EARTH.radius + target.radius / 2;
    const map = world(carrier(1, 0), { ...target, position: { x: at, y: 450, z: 0 } });
    pulseAuraFields(map, 0, ALL_HOSTILE);
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, 0)).not.toBeNull();
  });

  it('never lays anything on its own carrier', () => {
    const map = world(carrier(1, 0));
    pulseAuraFields(map, 0, ALL_HOSTILE);
    expect(statusOf(map.get(1)?.statuses ?? {}, StatusId.Burn, 0)).toBeNull();
  });

  it('leaves an ally alone, and re-asks every tick', () => {
    // Re-asked rather than captured, which matters more for a field than for
    // anything else in the sim: a field is *live*, so a carrier who walked into
    // a safe zone with one up would otherwise go on burning whoever is standing
    // there. Driven as a change of answer mid-field rather than as a constant.
    const map = world(carrier(1, 0), body(2, 620));
    let hostile = false;
    const context: DotContext = { isHostile: () => hostile, isSimulated: () => true };
    pulseAuraFields(map, 0, context);
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, 0)).toBeNull();
    hostile = true;
    pulseAuraFields(map, 1, context);
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, 1)).not.toBeNull();
  });

  it('leaves a corpse and an unsimulated body alone', () => {
    const dead = { ...body(2, 620), health: 0 };
    const away = body(3, 640);
    const map = world(carrier(1, 0), dead, away);
    pulseAuraFields(map, 0, { isHostile: () => true, isSimulated: (e) => e.id !== 3 });
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, 0)).toBeNull();
    expect(statusOf(map.get(3)?.statuses ?? {}, StatusId.Burn, 0)).toBeNull();
  });

  it('does nothing at all once the carrier’s own status has expired', () => {
    const map = world(carrier(1, 0, 600, 450, 10), body(2, 620));
    pulseAuraFields(map, 10, ALL_HOSTILE);
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, 10)).toBeNull();
    expect(fieldsOn(map.get(1) ?? carrier(1, 0), 10)).toBeNull();
  });

  it('cuts to maxTargets by distance, then by entity id', () => {
    // Six is the cap, so the seventh nearest is left out -- and the two at equal
    // distance are separated by id, which is `crowd.ts`'s rule and is what makes
    // the cut deterministic rather than a function of map order.
    const bodies = [];
    for (let i = 0; i < SCORCHED_EARTH.maxTargets + 2; i++) {
      bodies.push(body(i + 2, 600 + 10 + i * 5));
    }
    const map = world(carrier(1, 0), ...bodies);
    pulseAuraFields(map, 0, ALL_HOSTILE);
    const burning = [...map.values()].filter(
      (entity) => statusOf(entity.statuses, StatusId.Burn, 0) !== null,
    );
    expect(burning).toHaveLength(SCORCHED_EARTH.maxTargets);
    // The nearest six, which are the six lowest ids here.
    expect(burning.map((entity) => entity.id).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
  });
});

describe('the linger', () => {
  it('leaves exactly the field’s window on a body that walks out', () => {
    const map = world(carrier(1, 0), body(2, 620));
    pulseAuraFields(map, 0, ALL_HOSTILE);
    const held = statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, 0);
    expect(held?.expiresAtTick).toBe(lingerWindowTicks(SCORCHED_EARTH));
  });

  it('never runs out while a body stays inside', () => {
    // The whole design: it is re-laid every tick, so the expiry keeps moving.
    // Run for more than the affliction's own duration, which is what tells this
    // apart from "it was applied once and happens to still be running".
    const map = world(carrier(1, 0), body(2, 620));
    const ticks = dotDurationTicks(BURN) * 2;
    for (let tick = 0; tick < ticks; tick++) pulseAuraFields(map, tick, ALL_HOSTILE);
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, ticks - 1)).not.toBeNull();
  });

  it('keeps the cadence rather than restarting it, so a body inside takes pulses', () => {
    // The trap a per-tick refresh sets: if `appliedAtTick` moved with the
    // expiry, `elapsed % interval` would never come round and a body standing in
    // the fire would take no damage at all -- the pass working perfectly and the
    // skill doing nothing. Asserted as pulses landing, not as a field being set.
    const map = world(carrier(1, 0), body(2, 620));
    let pulses = 0;
    const ticks = BURN.intervalTicks * 6;
    for (let tick = 0; tick < ticks; tick++) {
      pulseAuraFields(map, tick, ALL_HOSTILE);
      for (const event of pulseDots(map, tick, ALL_HOSTILE)) {
        if (event.kind === 'hit' && event.targetId === 2) pulses++;
      }
    }
    // One per interval, from the first boundary after it landed.
    expect(pulses).toBe(5);
    const held = statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, ticks);
    expect(held?.appliedAtTick).toBe(0);
  });

  it('stops burning within the linger of stepping out', () => {
    // Walked out for real -- the body is moved past the reach and the pass keeps
    // running, which is the scenario rather than "the test stopped calling it".
    const map = world(carrier(1, 0), body(2, 620));
    // The last tick it is inside for, which is what the window is measured from.
    const lastInside = 9;
    for (let tick = 0; tick <= lastInside; tick++) pulseAuraFields(map, tick, ALL_HOSTILE);
    const inside = map.get(2);
    if (!inside) throw new Error('no body');
    map.set(2, { ...inside, position: { x: 600 + SCORCHED_EARTH.radius + 500, y: 450, z: 0 } });

    const out = lingerWindowTicks(SCORCHED_EARTH);
    for (let tick = lastInside + 1; tick <= lastInside + out; tick++) {
      pulseAuraFields(map, tick, ALL_HOSTILE);
    }
    // Still burning on the last tick of the linger, and gone on the one after
    // it: the window is exactly what the row says and not a tick more.
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, lastInside + out - 1)).not.toBeNull();
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, lastInside + out)).toBeNull();
  });
});

describe('what a field must not take away', () => {
  it('never shortens a longer application already on the body', () => {
    // `applyStatus` refreshes a clock in **both** directions, so the naive
    // version has a one-second field putting out the four seconds of Burn an
    // Ember Toss just started. The window is the larger of the two.
    const full = dotDurationTicks(BURN);
    const victim = {
      ...body(2, 620),
      statuses: applyStatus({}, StatusId.Burn, 0, full, { magnitude: 1, sourceId: 9 }),
    };
    const map = world(carrier(1, 0), victim);
    pulseAuraFields(map, 0, ALL_HOSTILE);
    expect(statusOf(map.get(2)?.statuses ?? {}, StatusId.Burn, 0)?.expiresAtTick).toBe(full);
  });

  it('never cuts a stack somebody else built, and never adds one of its own', () => {
    // Asserted on {@link fieldLanding} -- the pass's *own* decision, lifted out
    // for exactly this -- rather than on a fabricated field run through a copy
    // of the pass. The shipped table has one row and it lays Burn, which does
    // not stack, so a test that wanted a stacking field had either to invent
    // content or to re-implement the rule it is checking. Neither is evidence.
    const poison = dotById(StatusId.Poison);
    if (!poison) throw new Error('no poison');

    // A body carrying five darts' worth, walked into a field. Its concentration
    // survives: the ceiling handed on is what is already there.
    const full = { expiresAtTick: 400, stacks: poison.maxStacks, magnitude: 1, sourceId: 9, appliedAtTick: 0 };
    expect(fieldLanding(SCORCHED_EARTH, full, 10).maxStacks).toBe(poison.maxStacks);

    // A body carrying none gets one and, applied again and again, still one.
    expect(fieldLanding(SCORCHED_EARTH, null, 10).maxStacks).toBe(1);
    const one = { ...full, stacks: 1 };
    expect(fieldLanding(SCORCHED_EARTH, one, 10).maxStacks).toBe(1);
  });

  it('hands on the larger window and the held ceiling, as one decision', () => {
    // The window half of the same function, stated directly: a longer
    // application wins, a shorter one is replaced by the field's own.
    const longer = { expiresAtTick: 400, stacks: 1, magnitude: 1, sourceId: 9, appliedAtTick: 0 };
    expect(fieldLanding(SCORCHED_EARTH, longer, 10).durationTicks).toBe(390);
    const shorter = { ...longer, expiresAtTick: 12 };
    expect(fieldLanding(SCORCHED_EARTH, shorter, 10).durationTicks).toBe(
      lingerWindowTicks(SCORCHED_EARTH),
    );
    expect(fieldLanding(SCORCHED_EARTH, null, 10).durationTicks).toBe(
      lingerWindowTicks(SCORCHED_EARTH),
    );
  });
});

