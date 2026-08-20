/**
 * Afflictions (spec 190).
 *
 * The edges here are the ones a periodic system goes wrong on, and they are not
 * the ones a one-shot blow has. A blow is right or wrong once; an affliction is
 * wrong by *accumulation*, so what is asserted is the whole life of one rather
 * than a single tick of it: how many pulses land, on which ticks exactly, and
 * what the total comes to.
 *
 * Four of these tests exist because the obvious implementation gets them wrong:
 *
 *  - the pulse that lands on the tick the affliction was applied, which makes
 *    every row worth one pulse more than it says;
 *  - the pulse that never lands, because a refresh moved the phase and a body
 *    inside a spammed refresh is ticked forever into the future;
 *  - the last pulse, lost to the expiry comparison, which makes every row worth
 *    one pulse *less* than it says;
 *  - and the spread that does not terminate.
 *
 * Mostly driven at the pass rather than through `step`, because the arithmetic
 * is the subject and a real tick would put movement, regeneration and monster
 * intent between the reading and the thing being read. The two questions that
 * are genuinely about the tick -- kill credit and the Rng draw count -- are
 * driven through the real `step`, in `active-skills.test.ts`'s company.
 */

import { describe, expect, it } from 'vitest';
import { SERVER_TICK_RATE } from '../config.js';
import {
  dotById,
  dotDurationTicks,
  dotPulseDamage,
  dotTotalDamage,
  type DotDefinition,
} from '../data/damage-over-time.js';
import { monsterById } from '../data/monsters.js';
import {
  applyDot,
  clearAfflictions,
  healingScaleOf,
  MIN_HEALING_SCALE,
  pulseDots,
  type DotContext,
} from './damage-over-time.js';
import { applyHealing } from './healing.js';
import { applyStatus, statusOf, StatusId } from './statuses.js';
import {
  ActivityValue,
  CastPhase,
  EntityKindValue,
  type ServerEntity,
  type ServerSimEvent,
} from './types.js';
import { NO_ATTACK_SPEED, resolveAttackTiming } from './attack-timing.js';
import { createWorldState, spawnEntity } from './world.js';

/** A cast's timing block, so a fabricated `CastState` is a real one. */
const NO_TIMING = resolveAttackTiming(
  { baseAttackTimeTicks: 60, baseAttackPointTicks: 200, baseAttackBackswingTicks: 0 },
  NO_ATTACK_SPEED,
  SERVER_TICK_RATE,
);

function row(id: string): DotDefinition {
  const found = dotById(id);
  if (!found) throw new Error(`no affliction row for ${id}`);
  return found;
}

/**
 * A body, built through the real spawn so its stats are a real monster's.
 *
 * `dummy` because it is the one row in `MONSTERS` that exists to be hit, and
 * because a body that fights back would put its own blows into the events these
 * tests are counting.
 */
function body(id: number, x = 600, y = 450, health = 10_000): ServerEntity {
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy');
  let state = createWorldState(1);
  // Spawned `id` times so the ids come out where the caller asked for them:
  // spread breaks ties on entity id, so a test about spread needs to be able to
  // say which body is which.
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
  return { ...made, health, stats: { ...made.stats, maxHealth: health } };
}

/** Everything hostile to everything, and everything simulated. */
const ALL_HOSTILE: DotContext = { isHostile: () => true, isSimulated: () => true };

/** A source, so `sourceId` resolves and a spread has sides to measure against. */
function source(id: number): ServerEntity {
  return { ...body(1), id, kind: EntityKindValue.Player, typeId: 'player' };
}

interface Ran {
  readonly world: Map<number, ServerEntity>;
  readonly events: readonly ServerSimEvent[];
  /** Ticks on which the named body took a pulse, and what each one was worth. */
  readonly pulses: readonly { tick: number; damage: number }[];
}

/**
 * `ticks` ticks of the pass, from tick `from`, over a world you hand in.
 *
 * The affliction has to have been applied *at* `from` by the caller, because
 * the whole cadence is measured from `appliedAtTick` and a helper that applied
 * it would be deciding the thing under test.
 */
function pulse(
  world: Map<number, ServerEntity>,
  victimId: number,
  from: number,
  ticks: number,
  context: DotContext = ALL_HOSTILE,
): Ran {
  const events: ServerSimEvent[] = [];
  const pulses: { tick: number; damage: number }[] = [];
  for (let tick = from; tick < from + ticks; tick++) {
    const produced = pulseDots(world, tick, context);
    events.push(...produced);
    for (const event of produced) {
      if (event.kind === 'hit' && event.targetId === victimId) {
        pulses.push({ tick, damage: event.damage });
      }
    }
  }
  return { world, events, pulses };
}

describe('the cadence', () => {
  it('lands exactly the pulses the row says, on exactly the ticks it implies', () => {
    const poison = row(StatusId.Poison);
    const victim = applyDot(body(1), StatusId.Poison, 0, source(9));
    const world = new Map([[victim.id, victim]]);
    // Two ticks past the whole window, so a pulse landing late would show up.
    const ran = pulse(world, victim.id, 0, dotDurationTicks(poison) + 2);

    expect(ran.pulses.length).toBe(poison.pulses);
    expect(ran.pulses.map((p) => p.tick)).toEqual(
      Array.from({ length: poison.pulses }, (_, i) => (i + 1) * poison.intervalTicks),
    );
  });

  it('does not pulse on the tick it was applied', () => {
    // The double dip. The blow that applies an affliction has already dealt its
    // own damage on this tick, and an affliction that fired here would make
    // every row in the table worth one more pulse than it states.
    const victim = applyDot(body(1), StatusId.Burn, 0, source(9));
    const world = new Map([[victim.id, victim]]);
    expect(pulseDots(world, 0, ALL_HOSTILE)).toEqual([]);
  });

  it('lands its last pulse inside its own window', () => {
    // The other half of the same off-by-one, and the reason `dotDurationTicks`
    // adds a tick: `statusOf` refuses an entry at `tick >= expiresAtTick`, so a
    // duration of exactly `pulses * interval` silently loses the final pulse.
    for (const id of [StatusId.Burn, StatusId.Poison, StatusId.Shock, StatusId.Decay]) {
      const definition = row(id);
      const victim = applyDot(body(1), id, 0, source(9));
      const world = new Map([[victim.id, victim]]);
      const ran = pulse(world, victim.id, 0, dotDurationTicks(definition) + 5);
      expect(ran.pulses.length, id).toBe(definition.pulses);
    }
  });

  it('is worth what the table says in total', () => {
    const poison = row(StatusId.Poison);
    const victim = applyDot(body(1), StatusId.Poison, 0, source(9));
    const world = new Map([[victim.id, victim]]);
    const ran = pulse(world, victim.id, 0, dotDurationTicks(poison) + 2);

    const total = ran.pulses.reduce((sum, p) => sum + p.damage, 0);
    expect(total).toBeCloseTo(dotTotalDamage(poison), 5);
    // And it actually came off the body, rather than only being reported.
    expect(world.get(victim.id)?.health).toBeCloseTo(victim.health - total, 5);
  });
});

describe('refreshing', () => {
  it('moves the deadline and leaves the cadence exactly where it was', () => {
    const poison = row(StatusId.Poison);
    let victim = applyDot(body(1), StatusId.Poison, 0, source(9));
    const first = statusOf(victim.statuses, StatusId.Poison, 0);

    victim = applyDot(victim, StatusId.Poison, 7, source(9));
    const second = statusOf(victim.statuses, StatusId.Poison, 7);

    expect(second?.appliedAtTick).toBe(first?.appliedAtTick);
    expect(second?.expiresAtTick).toBe(7 + dotDurationTicks(poison));
    expect(second?.stacks).toBe(2);
  });

  it('cannot be used to hold an affliction off forever', () => {
    // The failure a stored countdown has and a comparison does not. Refreshed
    // every single tick, the poison still pulses on its own phase -- where a
    // "ticks until next pulse" field reset by each application would be pushed
    // out of reach and the affliction would deal nothing at all.
    const poison = row(StatusId.Poison);
    const attacker = source(9);
    let victim = applyDot(body(1), StatusId.Poison, 0, attacker);
    const world = new Map([[victim.id, victim]]);
    const seen: number[] = [];

    for (let tick = 1; tick <= poison.intervalTicks * 3; tick++) {
      const held = world.get(victim.id);
      if (!held) throw new Error('gone');
      victim = applyDot(held, StatusId.Poison, tick, attacker);
      world.set(victim.id, victim);
      for (const event of pulseDots(world, tick, ALL_HOSTILE)) {
        if (event.kind === 'hit') seen.push(tick);
      }
    }

    expect(seen).toEqual([poison.intervalTicks, poison.intervalTicks * 2, poison.intervalTicks * 3]);
  });

  it('is a fresh affliction once the old one has run out', () => {
    const poison = row(StatusId.Poison);
    let victim = applyDot(body(1), StatusId.Poison, 0, source(9));
    const gone = dotDurationTicks(poison) + 1;
    victim = applyDot(victim, StatusId.Poison, gone, source(9));

    const held = statusOf(victim.statuses, StatusId.Poison, gone);
    expect(held?.stacks).toBe(1);
    // The one that matters for Frostbite: a lapsed affliction re-applied starts
    // its escalation again rather than resuming somebody's old one.
    expect(held?.appliedAtTick).toBe(gone);
  });

  it('keeps the stronger applier, and gives them what it kills', () => {
    // `magnitude` is a max and `sourceId` follows it, so the credit and the
    // number always describe the same body -- where "whoever touched it last"
    // would let a weak applier take a strong one's poison while leaving the
    // strong one's damage running.
    const strong = { ...source(9), stats: { ...source(9).stats, spellPower: 2 } };
    const weak = { ...source(11), stats: { ...source(11).stats, spellPower: 1 } };

    let victim = applyDot(body(1), StatusId.Poison, 0, strong);
    victim = applyDot(victim, StatusId.Poison, 5, weak);
    const held = statusOf(victim.statuses, StatusId.Poison, 5);
    expect(held?.magnitude).toBe(2);
    expect(held?.sourceId).toBe(strong.id);

    // And the other way round, so it is the magnitude deciding rather than the
    // order two casters happened to arrive in.
    let other = applyDot(body(1), StatusId.Poison, 0, weak);
    other = applyDot(other, StatusId.Poison, 5, strong);
    expect(statusOf(other.statuses, StatusId.Poison, 5)?.sourceId).toBe(strong.id);
  });
});

describe('what a pulse is worth', () => {
  it('multiplies by the concentration', () => {
    const poison = row(StatusId.Poison);
    const attacker = source(9);
    let victim = applyDot(body(1), StatusId.Poison, 0, attacker);
    victim = applyDot(victim, StatusId.Poison, 1, attacker);
    victim = applyDot(victim, StatusId.Poison, 2, attacker);
    const world = new Map([[victim.id, victim]]);

    const ran = pulse(world, victim.id, 0, poison.intervalTicks + 1);
    expect(ran.pulses[0]?.damage).toBeCloseTo(dotPulseDamage(poison) * 3, 5);
  });

  it('escalates while it is left on, and stops escalating at the cap', () => {
    const frost = row(StatusId.Frostbite);
    if (frost.rampPerSecond === undefined || frost.rampCap === undefined) {
      throw new Error('frostbite is meant to ramp');
    }
    const victim = applyDot(body(1), StatusId.Frostbite, 0, source(9));
    const world = new Map([[victim.id, victim]]);
    const ran = pulse(world, victim.id, 0, dotDurationTicks(frost));

    const first = ran.pulses[0]?.damage ?? 0;
    const last = ran.pulses[ran.pulses.length - 1]?.damage ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(first);
    // Every pulse is at least as big as the one before it: the whole identity is
    // that it only ever gets worse, and a ramp that dipped would read as noise.
    for (let i = 1; i < ran.pulses.length; i++) {
      expect(ran.pulses[i]?.damage ?? 0).toBeGreaterThanOrEqual(ran.pulses[i - 1]?.damage ?? 0);
    }
    expect(last).toBeLessThanOrEqual(dotPulseDamage(frost) * frost.rampCap + 1e-9);
  });

  it('is worth more while the body is exerting itself, and only then', () => {
    const bleed = row(StatusId.Bleed);
    const scale = bleed.exertionScale ?? 1;
    expect(scale).toBeGreaterThan(1);

    const still = applyDot({ ...body(1), activity: ActivityValue.Idle }, StatusId.Bleed, 0, source(9));
    const walking = { ...still, activity: ActivityValue.Moving };
    const swinging = { ...still, activity: ActivityValue.Casting };
    // Stunned is not exertion. Being knocked down is not "using the arm it is
    // in", and a bleed that punished it would punish being punished.
    const floored = { ...still, activity: ActivityValue.Stunned };

    const worth = (entity: ServerEntity): number => {
      const world = new Map([[entity.id, entity]]);
      return pulse(world, entity.id, 0, bleed.intervalTicks + 1).pulses[0]?.damage ?? 0;
    };

    const base = worth(still);
    expect(worth(walking)).toBeCloseTo(base * scale, 5);
    expect(worth(swinging)).toBeCloseTo(base * scale, 5);
    expect(worth(floored)).toBeCloseTo(base, 5);
  });

  it('is worth what the applier was worth, captured when it landed', () => {
    const poison = row(StatusId.Poison);
    const strong = { ...source(9), stats: { ...source(9).stats, spellPower: 3 } };
    const victim = applyDot(body(1), StatusId.Poison, 0, strong);
    const world = new Map([[victim.id, victim]]);
    expect(pulse(world, victim.id, 0, poison.intervalTicks + 1).pulses[0]?.damage).toBeCloseTo(
      dotPulseDamage(poison) * 3,
      5,
    );
  });
});

describe('how it arrives', () => {
  it('spends a shield before it touches health, and no armour touches it', () => {
    const poison = row(StatusId.Poison);
    const shielded = applyDot(
      { ...body(1), shield: 1000, shieldUntilTick: 10_000 },
      StatusId.Poison,
      0,
      source(9),
    );
    const world = new Map([[shielded.id, shielded]]);
    pulse(world, shielded.id, 0, poison.intervalTicks + 1);

    const after = world.get(shielded.id);
    expect(after?.health).toBe(shielded.health);
    expect(after?.shield).toBeCloseTo(1000 - dotPulseDamage(poison), 5);
  });

  it('is not reduced by armour, however much of it there is', () => {
    // The role the whole family exists to fill: a body you cannot get through
    // is exactly the body you put an affliction on. `applyArmor` is never
    // called by the pass, and this is the assertion that says so from outside.
    const poison = row(StatusId.Poison);
    const plated = body(1);
    const armoured = applyDot(
      { ...plated, stats: { ...plated.stats, armor: 0.85 } },
      StatusId.Poison,
      0,
      source(9),
    );
    const world = new Map([[armoured.id, armoured]]);
    const ran = pulse(world, armoured.id, 0, poison.intervalTicks + 1);
    expect(ran.pulses[0]?.damage).toBeCloseTo(dotPulseDamage(poison), 5);
  });

  it('reports itself as a hit from whoever applied it', () => {
    const poison = row(StatusId.Poison);
    const victim = applyDot(body(1), StatusId.Poison, 0, source(9));
    const world = new Map([[victim.id, victim]]);
    const ran = pulse(world, victim.id, 0, poison.intervalTicks + 1);

    const hit = ran.events.find((event) => event.kind === 'hit');
    expect(hit).toBeDefined();
    if (hit?.kind !== 'hit') throw new Error('no hit');
    expect(hit.attackerId).toBe(9);
    expect(hit.targetId).toBe(victim.id);
    // Never a crit and never a weak point: those are facts about a blow, and
    // reporting one would put a yellow number over a body nobody swung at.
    expect(hit.critical).toBe(false);
    expect(hit.weakPoint).toBe(false);
    expect(hit.blocked).toBe(false);
  });

  it('stops the body resting it off', () => {
    const poison = row(StatusId.Poison);
    const victim = applyDot(body(1), StatusId.Poison, 0, source(9));
    const world = new Map([[victim.id, victim]]);
    pulse(world, victim.id, 0, poison.intervalTicks + 1);
    const after = world.get(victim.id);
    expect(statusOf(after?.statuses ?? {}, StatusId.InCombat, poison.intervalTicks)).toBeTruthy();
    // And deliberately NOT the half-second reaction window: an affliction that
    // held `RecentlyHit` open would take Perfect Exit off an Agility build for
    // its whole duration.
    expect(statusOf(after?.statuses ?? {}, StatusId.RecentlyHit, poison.intervalTicks)).toBeNull();
  });

  it('names its source as the killer when it finishes somebody', () => {
    const poison = row(StatusId.Poison);
    const dying = applyDot(body(1, 600, 450, 1), StatusId.Poison, 0, source(9));
    const world = new Map([[dying.id, dying]]);
    const ran = pulse(world, dying.id, 0, poison.intervalTicks + 1);

    const died = ran.events.find((event) => event.kind === 'died');
    expect(died).toBeDefined();
    if (died?.kind !== 'died') throw new Error('no death');
    expect(died.killerId).toBe(9);
    expect(died.entityId).toBe(dying.id);
    expect(died.qualities.abilityKill).toBe(true);
    expect(died.qualities.weakPoint).toBe(false);
  });

  it('announces one death and stops, however many afflictions are on the body', () => {
    // Two afflictions whose pulses coincide on a body with one point of health.
    // A pass that kept going would emit two `died` events for one body, and
    // `creditDeaths` would pay for the kill twice.
    const attacker = source(9);
    let dying = applyDot(body(1, 600, 450, 1), StatusId.Poison, 0, attacker);
    dying = applyDot(dying, StatusId.Bleed, 0, attacker);
    const world = new Map([[dying.id, dying]]);
    const ran = pulse(world, dying.id, 0, SERVER_TICK_RATE * 2);

    expect(ran.events.filter((event) => event.kind === 'died').length).toBe(1);
  });
});

describe('what a lethal pulse leaves behind', () => {
  it('drops the cast the body died in, and says so', () => {
    // The first death in this game that is not a blow, and the one thing
    // `resolveBlow` does on a kill that is easy to leave out. A player's entity
    // survives death, the cast pass refuses a corpse so nothing advances or
    // cancels what it was holding, and `respawn` rewrites eleven fields without
    // touching `cast` -- so a wind-up somebody died in came back with them and
    // landed from the spawn pad on their first living tick, at the coordinates
    // they had aimed at before dying.
    const poison = row(StatusId.Poison);
    const casting: ServerEntity = {
      ...applyDot(body(1, 600, 450, 1), StatusId.Poison, 0, source(9)),
      cast: {
        abilityId: 'ground.quake',
        phase: CastPhase.Windup,
        startedTick: 0,
        releaseTick: 200,
        endTick: 200,
        targetX: 900,
        targetY: 900,
        targetEntityId: 0,
        spentResource: 0,
        spentHealth: 0,
        spentCharges: 0,
        spentPoise: 0,
        nextPulseTick: 0,
        windupStartTick: 0,
        timing: NO_TIMING,
        committed: false,
      },
    };
    const world = new Map([[casting.id, casting]]);
    const ran = pulse(world, casting.id, 0, poison.intervalTicks + 1);

    expect(world.get(casting.id)?.health).toBe(0);
    expect(world.get(casting.id)?.cast).toBeNull();
    const ended = ran.events.filter((event) => event.kind === 'castEnded');
    expect(ended).toHaveLength(1);
  });

  it('says nothing about a cast for a body that was not holding one', () => {
    const poison = row(StatusId.Poison);
    const dying = applyDot(body(1, 600, 450, 1), StatusId.Poison, 0, source(9));
    const world = new Map([[dying.id, dying]]);
    const ran = pulse(world, dying.id, 0, poison.intervalTicks + 1);
    expect(ran.events.filter((event) => event.kind === 'castEnded')).toHaveLength(0);
  });
});

describe('who a pulse is allowed to hurt', () => {
  it('asks again every pulse, so a body that reached safety stops taking it', () => {
    // `isHostile` between two players needs BOTH of them standing in a pvp
    // zone, and `world.ts` says why: reading one end lets somebody reach into
    // a safe zone, or lets a target retreat out of one mid-swing. A blow and a
    // projectile are each measured where both bodies are when they land.
    //
    // An affliction is the first damage here that outlives its own delivery,
    // so it is the first that could carry a fight across a safe-zone line --
    // light somebody up, follow them into town, watch them die there.
    const poison = row(StatusId.Poison);
    const victim = applyDot(body(1), StatusId.Poison, 0, source(9));
    const world = new Map([[victim.id, victim], [9, source(9)]]);

    let safe = false;
    const zoned: DotContext = { isHostile: () => !safe, isSimulated: () => true };
    pulse(world, victim.id, 0, poison.intervalTicks + 1, zoned);
    const afterFirst = world.get(victim.id)?.health ?? 0;
    expect(afterFirst).toBeLessThan(victim.health);

    safe = true;
    pulse(world, victim.id, poison.intervalTicks + 1, poison.intervalTicks * 4, zoned);
    expect(world.get(victim.id)?.health).toBe(afterFirst);
  });

  it('still pulses one nobody is answerable for', () => {
    // A developer trigger applies an affliction with no applier at all, and an
    // affliction with no source has no side to be measured against. Refusing it
    // would make `admin:triggerEvent 'status'` draw seven marks over a body
    // that nothing is happening to.
    const poison = row(StatusId.Poison);
    const victim = {
      ...body(1),
      statuses: applyStatus({}, StatusId.Poison, 0, dotDurationTicks(poison), { magnitude: 1 }),
    };
    const world = new Map([[victim.id, victim]]);
    const ran = pulse(world, victim.id, 0, poison.intervalTicks + 1, {
      isHostile: () => false,
      isSimulated: () => true,
    });
    expect(ran.pulses.length).toBe(1);
  });
});

describe('who is not afflicted', () => {
  const cases: readonly { readonly what: string; readonly change: Partial<ServerEntity> }[] = [
    { what: 'a corpse', change: { health: 0 } },
    { what: 'a projectile', change: { kind: EntityKindValue.Projectile } },
    { what: 'a mote', change: { kind: EntityKindValue.Mote } },
    { what: 'a drop', change: { kind: EntityKindValue.Drop } },
  ];

  for (const { what, change } of cases) {
    it(`never pulses ${what}`, () => {
      const poison = row(StatusId.Poison);
      const victim = { ...applyDot(body(1), StatusId.Poison, 0, source(9)), ...change };
      // Written straight in, because `applyDot` correctly refuses these too --
      // the point of the test is that the *pass* refuses them as well, so a
      // status arriving by any other route still cannot tick on a corpse.
      const carrying = {
        ...victim,
        statuses: applyStatus(victim.statuses, StatusId.Poison, 0, 10_000, { magnitude: 1 }),
      };
      const world = new Map([[carrying.id, carrying]]);
      expect(pulse(world, carrying.id, 0, poison.intervalTicks + 1).pulses.length).toBe(0);
    });
  }

  it('never pulses a body in a chunk nobody is simulating', () => {
    const poison = row(StatusId.Poison);
    const victim = applyDot(body(1), StatusId.Poison, 0, source(9));
    const world = new Map([[victim.id, victim]]);
    const ran = pulse(world, victim.id, 0, poison.intervalTicks + 1, {
      isHostile: () => true,
      isSimulated: () => false,
    });
    expect(ran.pulses.length).toBe(0);
  });
});

describe('spreading', () => {
  /** A fire, a body carrying it, and a crowd standing at set distances. */
  function crowd(distances: readonly number[]): {
    world: Map<number, ServerEntity>;
    victimId: number;
    ids: number[];
  } {
    const attacker = source(9);
    const victim = applyDot(body(1, 600, 450), StatusId.Burn, 0, attacker);
    const world = new Map<number, ServerEntity>([
      [victim.id, victim],
      [attacker.id, attacker],
    ]);
    const ids: number[] = [];
    let next = 100;
    for (const distance of distances) {
      const other = { ...body(1, 600 + distance, 450), id: next };
      world.set(other.id, other);
      ids.push(other.id);
      next += 1;
    }
    return { world, victimId: victim.id, ids };
  }

  it('reaches the nearest body in range and nobody else', () => {
    const burn = row(StatusId.Burn);
    const radius = burn.spreadRadius ?? 0;
    expect(radius).toBeGreaterThan(0);

    const { world, victimId, ids } = crowd([radius * 0.4, radius * 0.8, radius * 2]);
    pulse(world, victimId, 0, burn.intervalTicks + 1);
    const at = burn.intervalTicks;

    expect(statusOf(world.get(ids[0] ?? 0)?.statuses ?? {}, StatusId.Burn, at)).toBeTruthy();
    // One hop per pulse. The second body is in range and does not catch it yet,
    // which is what keeps a fire in a crowd from being an instant epidemic.
    expect(statusOf(world.get(ids[1] ?? 0)?.statuses ?? {}, StatusId.Burn, at)).toBeNull();
    expect(statusOf(world.get(ids[2] ?? 0)?.statuses ?? {}, StatusId.Burn, at)).toBeNull();
  });

  it('passes on what is left of itself, never a fresh one', () => {
    const burn = row(StatusId.Burn);
    const { world, victimId, ids } = crowd([(burn.spreadRadius ?? 0) * 0.5]);
    pulse(world, victimId, 0, burn.intervalTicks + 1);

    const at = burn.intervalTicks;
    const parent = statusOf(world.get(victimId)?.statuses ?? {}, StatusId.Burn, at);
    const child = statusOf(world.get(ids[0] ?? 0)?.statuses ?? {}, StatusId.Burn, at);
    expect(child).toBeTruthy();
    // The same deadline as its parent, which is strictly earlier than a fresh
    // application would have given it. This one comparison is the whole reason
    // the chain terminates without a hop counter.
    expect(child?.expiresAtTick).toBe(parent?.expiresAtTick);
    expect(child?.expiresAtTick ?? 0).toBeLessThan(at + dotDurationTicks(burn));
    // And it carries the original's credit, so a fire started by a player still
    // pays that player for what it kills three bodies along.
    expect(child?.sourceId).toBe(9);
  });

  it('burns out rather than going round a crowd forever', () => {
    // The property the design rests on. Twelve bodies packed inside one radius
    // is the worst case there is, and every one of them ends up clear.
    const burn = row(StatusId.Burn);
    const radius = burn.spreadRadius ?? 0;
    const { world, victimId, ids } = crowd(
      Array.from({ length: 12 }, (_, i) => radius * 0.1 * (i + 1)),
    );
    const horizon = dotDurationTicks(burn) * 4;
    pulse(world, victimId, 0, horizon);

    for (const id of [victimId, ...ids]) {
      expect(statusOf(world.get(id)?.statuses ?? {}, StatusId.Burn, horizon), String(id)).toBeNull();
    }
  });

  it('never catches the body that started it, or anyone on its side', () => {
    const burn = row(StatusId.Burn);
    const attacker = source(9);
    const ally = { ...source(10), position: { x: 610, y: 450, z: 0 } };
    const victim = applyDot(body(1, 600, 450), StatusId.Burn, 0, attacker);
    const world = new Map<number, ServerEntity>([
      [victim.id, victim],
      [attacker.id, { ...attacker, position: { x: 605, y: 450, z: 0 } }],
      [ally.id, ally],
    ]);

    // Sides as the real world states them: a player's fire may not catch a
    // player. Without this a burn thrown into a pack walks back out of it.
    pulse(world, victim.id, 0, dotDurationTicks(burn), {
      isHostile: (a, b) => a.kind !== b.kind,
      isSimulated: () => true,
    });

    const at = burn.intervalTicks;
    expect(statusOf(world.get(attacker.id)?.statuses ?? {}, StatusId.Burn, at)).toBeNull();
    expect(statusOf(world.get(ally.id)?.statuses ?? {}, StatusId.Burn, at)).toBeNull();
  });

  it('does not spread once its source has left the world', () => {
    // Nobody to measure sides against, so there is no honest answer to who
    // should catch it -- and guessing would let a fire whose owner logged out
    // work its way through a town.
    const burn = row(StatusId.Burn);
    const victim = applyDot(body(1, 600, 450), StatusId.Burn, 0, source(9));
    const neighbour = { ...body(1, 620, 450), id: 100 };
    const world = new Map<number, ServerEntity>([
      [victim.id, victim],
      [neighbour.id, neighbour],
    ]);
    pulse(world, victim.id, 0, dotDurationTicks(burn));
    expect(statusOf(world.get(neighbour.id)?.statuses ?? {}, StatusId.Burn, 1)).toBeNull();
  });
});

describe('corrosion', () => {
  it('takes the guard without ever breaking it', () => {
    const corrosion = row(StatusId.Corrosion);
    const plain = body(1);
    const victim = applyDot({ ...plain, poise: 4 }, StatusId.Corrosion, 0, source(9));
    const world = new Map([[victim.id, victim]]);
    pulse(world, victim.id, 0, dotDurationTicks(corrosion));

    const after = world.get(victim.id);
    // Emptied, and floored there. A break is a stagger, and an affliction that
    // staggered once a second for six seconds would be a removal.
    expect(after?.poise).toBe(0);
    expect(after?.activity).not.toBe(ActivityValue.Stunned);
  });

  it('strips armour through the status the game already has', () => {
    const corrosion = row(StatusId.Corrosion);
    const victim = applyDot(body(1), StatusId.Corrosion, 0, source(9));
    const world = new Map([[victim.id, victim]]);
    pulse(world, victim.id, 0, corrosion.intervalTicks + 1);

    const at = corrosion.intervalTicks;
    const sundered = statusOf(world.get(victim.id)?.statuses ?? {}, StatusId.Sundered, at);
    expect(sundered?.magnitude).toBe(corrosion.sunderMagnitude);
  });
});

describe('decay', () => {
  it('multiplies healing everywhere a heal is scaled', () => {
    const decayed = applyDot(body(1, 600, 450, 100), StatusId.Decay, 0, source(9));
    const hurt = { ...decayed, health: 10 };
    const clean = { ...hurt, statuses: {} };

    const withDecay = applyHealing(hurt, 50, 1);
    const without = applyHealing(clean, 50, 1);
    expect(withDecay.healed).toBeLessThan(without.healed);
    expect(withDecay.healed).toBeCloseTo(without.healed * (row(StatusId.Decay).healingScale ?? 1), 5);
  });

  it('never takes healing to nothing', () => {
    // "Suppresses" is not "prevents". One status deciding a whole fight is the
    // failure mode a floor exists to prevent, and the floor is stated once.
    const stacked = { [StatusId.Decay]: { expiresAtTick: 100, stacks: 1, magnitude: 1, sourceId: 9, appliedAtTick: 0 } };
    expect(healingScaleOf(stacked, 0)).toBeGreaterThanOrEqual(MIN_HEALING_SCALE);
    expect(healingScaleOf(stacked, 0)).toBeLessThan(1);
    // A body carrying nothing pays no cost at all for the lookup.
    expect(healingScaleOf({}, 0)).toBe(1);
    // And an expired one is not a suppression.
    expect(healingScaleOf(stacked, 100)).toBe(1);
  });

  it('is the only affliction that touches healing', () => {
    for (const id of [StatusId.Burn, StatusId.Bleed, StatusId.Poison, StatusId.Shock]) {
      const victim = applyDot(body(1), id, 0, source(9));
      expect(healingScaleOf(victim.statuses, 1), id).toBe(1);
    }
  });
});

describe('coming back', () => {
  it('takes the afflictions off and leaves what was earned', () => {
    let victim = applyDot(body(1), StatusId.Burn, 0, source(9));
    victim = applyDot(victim, StatusId.Poison, 0, source(9));
    victim = { ...victim, statuses: applyStatus(victim.statuses, StatusId.Flow, 0, 100, { maxStacks: 3 }) };

    const cleared = clearAfflictions(victim.statuses);
    expect(statusOf(cleared, StatusId.Burn, 1)).toBeNull();
    expect(statusOf(cleared, StatusId.Poison, 1)).toBeNull();
    // Death already costs the meter and the run. Taking the Flow as well is not
    // what it is meant to charge for.
    expect(statusOf(cleared, StatusId.Flow, 1)).toBeTruthy();
  });

  it('costs nothing for a body carrying no affliction', () => {
    const clean = applyStatus({}, StatusId.Flow, 0, 100);
    expect(clearAfflictions(clean)).toBe(clean);
  });
});
