/**
 * The paint on an afflicted body, and the beat under it (spec 215).
 *
 * Three things here are worth more than the rest of the file put together, and
 * each is a property that a green suite of per-case assertions would happily
 * sit beside while the feature was broken on screen.
 *
 * **The beat is checked against the real resolver.** `pulsesLanded` is a
 * *second* derivation of a schedule the sim already owns: `sim/damage-over-time
 * .ts` fires on `elapsed % intervalTicks === 0` measured from
 * `StatusState.appliedAtTick`, and this file works the same schedule out from
 * `expiresAtTick` and `dotDurationTicks` instead, because the applied tick is
 * not on the wire. Two derivations of one fact is exactly the arrangement that
 * drifts, so the test does not restate the arithmetic -- it applies a real
 * affliction to a real body, runs the real pass a tick at a time, and asks the
 * two for the same list of ticks. A restatement would only prove that this file
 * agrees with itself, which is the one thing that was never in doubt.
 *
 * **The beat count is frame-rate independent.** A frame drains as many ticks as
 * real time gave it -- one at 60fps, three at 20, and this environment paints a
 * real page at about five -- so a beat rule that asked "is this tick a multiple"
 * would skip most beats and skip *all* of them on a slow frame. Driving the
 * whole life of every affliction at four different strides and demanding
 * `row.pulses` beats every time is what makes that a property rather than an
 * intention.
 *
 * **A refused `play` is not a started one.** `play` returns `0` for an unknown
 * id, for a body over budget and for one beyond `cullDistance`, and the whole
 * reason this driver holds handles rather than ids is that a tracker keyed on
 * ids cannot tell "wanted, asked for, did not start" from "running". Committing
 * a refusal would leave a body silently unmarked for the rest of its life, so
 * the recorder below can refuse on demand and the retry is asserted.
 *
 * Everything is driven against a recording {@link VfxPlayer}: no three.js, no
 * DOM, no canvas. That is what makes the whole feature answerable in `npm test`
 * rather than only in a screenshot.
 */

import { describe, expect, it } from 'vitest';
import type { WireStatus } from '../../../server/net/messages.js';
import { visualFor } from '../../../server/data/status-visuals.js';
import {
  ALL_DOTS,
  dotById,
  dotDurationTicks,
  dotRampAt,
  type DotDefinition,
} from '../../../server/data/damage-over-time.js';
import { monsterById } from '../../../server/data/monsters.js';
import { applyDot, pulseDots, type DotContext } from '../../../server/sim/damage-over-time.js';
import { StatusId } from '../../../server/sim/statuses.js';
import { ADAPTED_ID } from '../../../server/data/status-visuals.js';
import { createWorldState, spawnEntity } from '../../../server/sim/world.js';
import { EntityKindValue, type ServerEntity } from '../../../server/sim/types.js';
import {
  AFFLICTION_ART,
  AfflictionVfx,
  afflictionIsHeavy,
  afflictionsOn,
  pulsesLanded,
  seedFor,
  type AfflictedBody,
  type VfxPlayer,
} from './affliction-vfx.js';

// --- reading the tables by name ----------------------------------------------

/** The wire index for a status id, so a test reads by name rather than by number. */
function wireOf(id: string): number {
  const visual = visualFor(id);
  if (!visual) throw new Error(`no visible row for ${id}`);
  return visual.wire;
}

function status(id: string, expiresAtTick: number, stacks = 1): WireStatus {
  return { wire: wireOf(id), stacks, expiresAtTick };
}

/** The affliction row for an id, thrown rather than defaulted: a missing row is the bug. */
function row(id: string): DotDefinition {
  const found = dotById(id);
  if (!found) throw new Error(`no affliction row for ${id}`);
  return found;
}

/** What a fresh application at tick 0 expires at, which is the whole window. */
function windowOf(definition: DotDefinition): number {
  return dotDurationTicks(definition);
}

// --- the sim side, so the beat has something real to be checked against ------

/** Everything hostile to everything, and everything simulated. */
const ALL_HOSTILE: DotContext = { isHostile: () => true, isSimulated: () => true };

/**
 * A victim and an applier, built through the real spawn.
 *
 * The `dummy` row for the same reason `damage-over-time.test.ts` uses it: it is
 * the one monster that exists to be hit, and a body that fought back would put
 * its own blows into the events being counted. Health is raised well past what
 * any row in the table is worth in total, because a victim that dies half way
 * through stops pulsing and would report a short window as a cadence fault.
 */
function spawnPair(): { readonly victim: ServerEntity; readonly source: ServerEntity } {
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy monster');
  let state = createWorldState(1);
  const spec = {
    kind: EntityKindValue.Monster,
    typeId: 'dummy',
    position: { x: 600, y: 450, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
  };
  const first = spawnEntity(state, spec);
  state = first.state;
  const second = spawnEntity(state, spec);
  const health = 1_000_000;
  return {
    victim: { ...first.entity, health, stats: { ...first.entity.stats, maxHealth: health } },
    source: {
      ...second.entity,
      kind: EntityKindValue.Player,
      typeId: 'player',
      health,
      stats: { ...second.entity.stats, maxHealth: health },
    },
  };
}

/**
 * The ticks the **sim** actually pulses on, for a fresh application at tick 0.
 *
 * Run past the end of the window on purpose: a pulse landing one tick late, or
 * an extra one on the tick of slack `dotDurationTicks` adds, is exactly the
 * off-by-one this comparison exists to catch and it lives past the last
 * expected beat rather than before the first.
 */
function simPulseTicks(definition: DotDefinition): number[] {
  const { victim, source } = spawnPair();
  const afflicted = applyDot(victim, definition.id, 0, source);
  const world = new Map<number, ServerEntity>([
    [afflicted.id, afflicted],
    [source.id, source],
  ]);
  const ticks: number[] = [];
  for (let tick = 0; tick <= windowOf(definition) + 5; tick++) {
    for (const event of pulseDots(world, tick, ALL_HOSTILE)) {
      if (event.kind === 'hit' && event.targetId === afflicted.id) ticks.push(tick);
    }
  }
  return ticks;
}

/** The ticks on which the **client's** derived count goes up, over the same span. */
function derivedPulseTicks(definition: DotDefinition): number[] {
  const expiresAtTick = windowOf(definition);
  const ticks: number[] = [];
  let previous = 0;
  for (let tick = 0; tick <= expiresAtTick + 5; tick++) {
    const landed = pulsesLanded(definition, expiresAtTick, tick);
    if (landed > previous) ticks.push(tick);
    previous = landed;
  }
  return ticks;
}

// --- the recorder ------------------------------------------------------------

interface PlayCall {
  readonly id: string;
  readonly entityId: number;
  readonly seed: number;
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** What `play` answered. `0` is a refusal, which is the case that matters. */
  readonly handle: number;
}

/**
 * A {@link VfxPlayer} that writes down what it was asked for.
 *
 * `VfxLayer` satisfies the interface structurally and so does this, which is the
 * point of the interface being two methods and a predicate rather than the
 * layer: the driver never learns what a particle is, so the whole of it runs in
 * Node.
 *
 * Two knobs, and both are failure modes rather than conveniences. `known`
 * narrows what `has` will admit, because the driver must never `play` an id the
 * registry has not got -- `playCue`'s rule, not `addEffect`'s: an unauthored id
 * is silence and never a fallback ring. `refusals` makes the next few `play`
 * calls answer `0`, which is what an over-budget or out-of-range system does and
 * is the state a handle-holding tracker exists to survive.
 */
class Recorder implements VfxPlayer {
  readonly played: PlayCall[] = [];
  readonly stopped: number[] = [];
  /** How many more `play` calls answer `0`. */
  refusals = 0;
  /**
   * Handles the pool has taken back, standing in for eviction.
   *
   * `claimInstance` does not refuse when the instance pool is full: it evicts
   * the lowest-priority, furthest instance and bumps that slot's generation, so
   * every handle to it goes stale in place. A cling is the lowest priority in
   * the game and therefore the first thing evicted, and the only way a driver
   * finds out is by asking.
   */
  readonly evicted = new Set<number>();
  private readonly known: ReadonlySet<string> | null;
  private next = 1;

  constructor(known?: readonly string[]) {
    this.known = known ? new Set(known) : null;
  }

  has(id: string): boolean {
    return this.known === null ? true : this.known.has(id);
  }

  play(id: string, options: Parameters<VfxPlayer['play']>[1]): number {
    let handle = 0;
    if (this.refusals > 0) this.refusals -= 1;
    else {
      handle = this.next;
      this.next += 1;
    }
    this.played.push({
      id,
      entityId: options.attach?.entityId ?? 0,
      seed: options.seed,
      scale: options.scale ?? 1,
      x: options.x,
      y: options.y,
      z: options.z,
      handle,
    });
    return handle;
  }

  isLive(handle: number): boolean {
    return handle !== 0 && !this.evicted.has(handle) && !this.stopped.includes(handle);
  }

  stop(handle: number): void {
    this.stopped.push(handle);
  }

  /** Every call for one id, refusals included. */
  callsFor(id: string): readonly PlayCall[] {
    return this.played.filter((call) => call.id === id);
  }

  /** Just the ids, in the order they were asked for. */
  get ids(): readonly string[] {
    return this.played.map((call) => call.id);
  }
}

const BODY: AfflictedBody = { entityId: 7, x: 120, y: 30, z: -40, radius: 18 };

/**
 * The ticks a frame lands on, for a stride and a window.
 *
 * The affliction's **last live tick** is always in the schedule, and that is a
 * decision rather than an accident: `dotDurationTicks` adds exactly one tick of
 * slack, so the last pulse lands on `expiresAtTick - 1` and on no other tick. A
 * schedule that stepped over it would draw every beat but the last -- a real
 * limit, asserted on its own below, and not the thing the frame-rate property is
 * about.
 */
function frameTicks(expiresAtTick: number, stride: number): number[] {
  const ticks: number[] = [];
  for (let tick = 0; tick < expiresAtTick; tick += stride) ticks.push(tick);
  const last = expiresAtTick - 1;
  if (ticks[ticks.length - 1] !== last) ticks.push(last);
  return ticks;
}

/** One whole affliction, apply to expiry, at a given frame stride. */
function driveWholeWindow(
  definition: DotDefinition,
  stride: number,
  stacks = 1,
): Recorder {
  const recorder = new Recorder();
  const driver = new AfflictionVfx(recorder);
  const expiresAtTick = windowOf(definition);
  const held = [status(definition.id, expiresAtTick, stacks)];
  for (const tick of frameTicks(expiresAtTick, stride)) driver.step(BODY, held, tick);
  // Two frames past the end, so a beat that landed late would be counted.
  driver.step(BODY, held, expiresAtTick);
  driver.step(BODY, held, expiresAtTick + 10);
  return recorder;
}

// --- what is live on a body --------------------------------------------------

describe('afflictionsOn (spec 215)', () => {
  it('reports an affliction that is on the body', () => {
    const live = afflictionsOn([status(StatusId.Burn, 200)], 40);
    expect(live).toHaveLength(1);
    expect(live[0]?.dotId).toBe(StatusId.Burn);
    expect(live[0]?.cling).toBe(AFFLICTION_ART[StatusId.Burn]?.cling);
    expect(live[0]?.pulse).toBe(AFFLICTION_ART[StatusId.Burn]?.pulse);
  });

  it('refuses a window that has passed, with nothing having been pruned', () => {
    // The property the whole design rests on, and the same comparison
    // `statusOf` makes in the sim and `statusMarks` makes beside this. Nothing
    // prunes `ReplicatedEntity.statuses` -- the delta carries whatever was in
    // the map when it was built and the pulse pass stopping is invisible from
    // out here -- so this comparison is the only thing that takes the paint off.
    const stale = [status(StatusId.Poison, 400, 5)];
    expect(afflictionsOn(stale, 400)).toHaveLength(0);
    expect(afflictionsOn(stale, 900)).toHaveLength(0);
    // And the list it was handed is untouched: refusing on read is not pruning.
    expect(stale).toHaveLength(1);
    expect(stale[0]?.expiresAtTick).toBe(400);

    // The refusal is per entry rather than a decision about the body.
    const mixed = afflictionsOn([status(StatusId.Poison, 400, 5), status(StatusId.Burn, 900)], 520);
    expect(mixed.map((affliction) => affliction.dotId)).toEqual([StatusId.Burn]);
  });

  it('draws nothing for a boon, or for anything that is not an affliction', () => {
    // Absent is the default, the rule `visualFor` already keeps one level up.
    // Every one of these has a picture over the head (spec 186) and none of them
    // is something happening *to* a body from the inside -- Slowed is the one
    // worth naming, because a skill applies it and it rides the same delta, and
    // a mark on the body would say "you are being damaged" about a status that
    // takes nothing.
    for (const id of [
      StatusId.Flow,
      StatusId.Momentum,
      StatusId.Prepared,
      StatusId.Attuned,
      StatusId.Exposed,
      StatusId.Vulnerable,
      StatusId.Sundered,
      ADAPTED_ID,
      StatusId.Slowed,
    ]) {
      expect(afflictionsOn([status(id, 500, 3)], 0), id).toHaveLength(0);
    }
  });

  it('drops a wire index this build has no row for', () => {
    // A client talking to a newer server. The decoder reads the bytes so the
    // frame stays aligned; here is where an unnamed status is refused a picture
    // rather than given a guessed one.
    const unknown: WireStatus = { wire: 240, stacks: 1, expiresAtTick: 500 };
    expect(afflictionsOn([unknown], 0)).toHaveLength(0);
    expect(afflictionsOn([unknown, status(StatusId.Shock, 500)], 0)).toHaveLength(1);
  });

  it('is a pure function of its arguments: the same facts twice, the same list', () => {
    const held = [status(StatusId.Frostbite, 400), status(StatusId.Decay, 700)];
    const first = afflictionsOn(held, 90);
    expect(afflictionsOn(held, 90)).toEqual(first);
    // And asking about a later tick does not disturb the earlier answer.
    afflictionsOn(held, 380);
    expect(afflictionsOn(held, 90)).toEqual(first);
  });

  it('orders by wire index rather than by the order it was handed', () => {
    // Two bodies carrying the same afflictions must produce the same list, and
    // a mark must not move because something else was applied -- the reason
    // `AURA_ORDER` is fixed and the invariant spec 215 states in as many words:
    // *"in wire order, whatever order the statuses arrive in"*.
    //
    // The wire does arrive sorted -- `visibleStatusesOf` in `net/delta.ts` ends
    // on `packed.sort((a, b) => a.wire - b.wire)` -- so today this preserves an
    // order it never imposes. That is not the same claim, and the module's own
    // header makes the stronger one: *"does not depend on that, because it reads
    // the index it was sent"*. It does not read it. `status.wire` is used for
    // the lookup and for nothing else, so the fixed order is a fact about
    // another module that nothing here would notice changing -- and the day a
    // second producer packs a status list (an admin trigger, a replay, a test
    // fixture) the paint on two identical bodies stops matching with every test
    // in this file green.
    //
    // The fix is one line at the end of `afflictionsOn`: sort `live` by the wire
    // index the entry was read from, which means carrying `visual.wire` onto
    // `LiveAffliction` (or sorting on it before the push).
    const scrambled = [
      status(StatusId.Decay, 900),
      status(StatusId.Burn, 900),
      status(StatusId.Shock, 900),
      status(StatusId.Bleed, 900),
    ];
    const ids = afflictionsOn(scrambled, 0).map((affliction) => affliction.dotId);
    expect(ids, 'afflictionsOn does not sort by wire index -- see the comment above').toEqual([
      StatusId.Burn,
      StatusId.Bleed,
      StatusId.Shock,
      StatusId.Decay,
    ]);
    // Reversing the input must not reverse the picture.
    expect(afflictionsOn([...scrambled].reverse(), 0).map((live) => live.dotId)).toEqual(ids);
  });

  it('costs nothing at all for a body carrying nothing', () => {
    // The common case: almost every body in the world is carrying nothing, and
    // this runs per body per frame. The shared empty array is what makes that
    // free, so it is asserted by identity rather than by length.
    expect(afflictionsOn([], 0)).toBe(afflictionsOn([], 900));
    expect(afflictionsOn([], 0)).toHaveLength(0);
    // A list of nothing but stale entries is the same case one step in.
    expect(afflictionsOn([status(StatusId.Burn, 100)], 500)).toBe(afflictionsOn([], 0));
  });

  it('reports how far in it is, and what has landed, for every row in the table', () => {
    // A row added to `DAMAGE_OVER_TIME` with no art is an affliction the paint
    // silently does not draw, which is the failure this spec exists to close.
    for (const definition of ALL_DOTS) {
      const expiresAtTick = windowOf(definition);
      const at = definition.intervalTicks * 2;
      const live = afflictionsOn([status(definition.id, expiresAtTick)], at);
      expect(live, definition.id).toHaveLength(1);
      expect(live[0]?.elapsedTicks, definition.id).toBe(at);
      expect(live[0]?.landed, definition.id).toBe(2);
    }
    expect(ALL_DOTS).toHaveLength(7);
  });
});

// --- the beat, against the resolver that owns it -----------------------------

describe('the derived beat agrees with the sim', () => {
  it('beats on exactly the ticks the real resolver fires on, for every affliction', () => {
    // Two derivations of one schedule: the sim measures `elapsed` from
    // `appliedAtTick` and the client cannot see that field, so it works back
    // from the replicated expiry and `dotDurationTicks` instead. This is the
    // only assertion in the tree that can tell the two apart, and it is written
    // against the *pass* rather than against its arithmetic on purpose -- a
    // restatement of `elapsed % intervalTicks === 0` would prove only that this
    // file agrees with itself.
    for (const definition of ALL_DOTS) {
      const sim = simPulseTicks(definition);
      // The pass actually ran and actually hurt somebody, or the comparison
      // below is two empty lists agreeing.
      expect(sim.length, definition.id).toBeGreaterThan(0);
      expect(derivedPulseTicks(definition), definition.id).toEqual(sim);
    }
  });

  it('lands exactly the number of beats the row says it is worth', () => {
    // Where the `+ 1` in `dotDurationTicks` lives. A window of exactly
    // `pulses * interval` loses its last beat to the expiry comparison and an
    // uncapped count reports an extra one on the tick of slack -- so both ends
    // are asserted, for every row at once.
    for (const definition of ALL_DOTS) {
      expect(derivedPulseTicks(definition), definition.id).toHaveLength(definition.pulses);
      expect(simPulseTicks(definition), definition.id).toHaveLength(definition.pulses);
    }
  });

  it('counts nothing before the first beat and never more than the row is worth', () => {
    for (const definition of ALL_DOTS) {
      const expiresAtTick = windowOf(definition);
      expect(pulsesLanded(definition, expiresAtTick, 0), definition.id).toBe(0);
      expect(
        pulsesLanded(definition, expiresAtTick, definition.intervalTicks - 1),
        definition.id,
      ).toBe(0);
      // The tick of slack, and the ticks past the window a stale entry can still
      // be read on: capped, or every affliction in the table reports one beat
      // too many at the same moment.
      expect(pulsesLanded(definition, expiresAtTick, expiresAtTick), definition.id).toBe(
        definition.pulses,
      );
      expect(pulsesLanded(definition, expiresAtTick, expiresAtTick + 600), definition.id).toBe(
        definition.pulses,
      );
    }
  });

  it('never counts backwards for an expiry further out than the row allows', () => {
    // A negative elapsed would report a beat that has not happened. Clamped at
    // zero rather than trusted, because an expiry beyond the authored duration
    // is a server that extended the window somehow and not a client fault.
    const burn = row(StatusId.Burn);
    expect(pulsesLanded(burn, windowOf(burn) + 5000, 0)).toBe(0);
  });
});

// --- severity ----------------------------------------------------------------

describe('severity is more paint, and only for the rows that can get worse', () => {
  it('crosses at half a stacking row’s own maximum', () => {
    // Half, because five stacks of Poison and four are not two pictures anybody
    // can tell apart at three hundred pixels tall -- and the count is already
    // drawn, over the head (spec 186). What the paint owes is severity.
    const bleed = row(StatusId.Bleed); // maxStacks 3
    expect(afflictionIsHeavy(bleed, 1, 0)).toBe(false);
    expect(afflictionIsHeavy(bleed, 2, 0)).toBe(true);
    expect(afflictionIsHeavy(bleed, 3, 0)).toBe(true);

    const poison = row(StatusId.Poison); // maxStacks 5
    expect(afflictionIsHeavy(poison, 1, 0)).toBe(false);
    expect(afflictionIsHeavy(poison, 2, 0)).toBe(false);
    expect(afflictionIsHeavy(poison, 3, 0)).toBe(true);
    expect(afflictionIsHeavy(poison, 5, 0)).toBe(true);

    const corrosion = row(StatusId.Corrosion); // maxStacks 3
    expect(afflictionIsHeavy(corrosion, 1, 0)).toBe(false);
    expect(afflictionIsHeavy(corrosion, 2, 0)).toBe(true);
  });

  it('never drops back down as a stacking row deepens', () => {
    // A picture that got lighter as the affliction got worse would be a legend
    // read backwards.
    for (const definition of ALL_DOTS) {
      if (definition.maxStacks <= 1) continue;
      let seenHeavy = false;
      for (let stacks = 1; stacks <= definition.maxStacks; stacks++) {
        const heavy = afflictionIsHeavy(definition, stacks, 0);
        if (heavy) seenHeavy = true;
        expect(heavy || !seenHeavy, `${definition.id} at ${stacks}`).toBe(true);
      }
      expect(seenHeavy, definition.id).toBe(true);
    }
  });

  it('crosses Frostbite on elapsed rather than on stacks', () => {
    // The one row that ramps instead of stacking, and it is the whole of that
    // row's design: harmless for a moment, dangerous if you let it stay on. Its
    // ceiling is `maxStacks: 1`, so a stack rule could never move it at all.
    const frostbite = row(StatusId.Frostbite);
    expect(frostbite.maxStacks).toBe(1);
    expect(afflictionIsHeavy(frostbite, 1, 0)).toBe(false);

    // Half its own escalation: cap 3, so the tier crosses when the ramp reaches
    // 2, which `1 + 0.35 * elapsed / 60` does a shade past 171 ticks.
    let crossing = -1;
    for (let elapsed = 0; elapsed <= windowOf(frostbite); elapsed++) {
      if (afflictionIsHeavy(frostbite, 1, elapsed)) {
        crossing = elapsed;
        break;
      }
    }
    expect(crossing).toBe(172);
    expect(dotRampAt(frostbite, crossing - 1)).toBeLessThan(2);
    expect(dotRampAt(frostbite, crossing)).toBeGreaterThanOrEqual(2);

    // Strictly inside the window, or the heavy id is a picture of a state that
    // never arrives -- and comfortably inside it, since a tier that crossed in
    // the last tenth of a life would be a swap nobody saw.
    expect(crossing).toBeLessThan(windowOf(frostbite) / 2);
    // And once it is on, it stays on for the rest of the affliction.
    for (let elapsed = crossing; elapsed <= windowOf(frostbite); elapsed++) {
      expect(afflictionIsHeavy(frostbite, 1, elapsed), `${elapsed}`).toBe(true);
    }
  });

  it('has a heavy id for exactly the rows that can be heavy, and for no others', () => {
    // The property that stops `afflictionsOn` naming an effect that does not
    // exist. `cling` falls back to the light id when `heavy` is absent, so a row
    // that could go heavy without one would silently never change -- and a row
    // with a heavy id it can never reach is an authored effect nothing plays,
    // which is the failure this whole spec exists to close, one level down.
    for (const definition of ALL_DOTS) {
      const art = AFFLICTION_ART[definition.id];
      expect(art, definition.id).toBeDefined();
      if (!art) continue;

      let everHeavy = false;
      for (let stacks = 0; stacks <= definition.maxStacks; stacks++) {
        for (let elapsed = 0; elapsed <= windowOf(definition); elapsed++) {
          if (afflictionIsHeavy(definition, stacks, elapsed)) {
            everHeavy = true;
            break;
          }
        }
        if (everHeavy) break;
      }
      expect(everHeavy, `${definition.id} can be heavy`).toBe(art.heavy !== undefined);
    }
  });

  it('never lets Burn or Shock get louder than they already are', () => {
    // Neither stacks and neither ramps: a second Ember Toss is the same fire on
    // a new clock. There is no state of a body in this game where either is more
    // than it is, so a louder picture would be a picture of something that never
    // happens -- and Decay is the third of the same kind.
    for (const id of [StatusId.Burn, StatusId.Shock, StatusId.Decay]) {
      const definition = row(id);
      expect(AFFLICTION_ART[id]?.heavy, id).toBeUndefined();
      for (let stacks = 0; stacks <= 9; stacks++) {
        for (let elapsed = 0; elapsed <= windowOf(definition) + 600; elapsed += 7) {
          expect(afflictionIsHeavy(definition, stacks, elapsed), `${id} ${stacks}/${elapsed}`).toBe(
            false,
          );
        }
      }
    }
  });

  it('names the heavy cling once a stacking affliction has got there', () => {
    const light = afflictionsOn([status(StatusId.Poison, 900, 1)], 10);
    const deep = afflictionsOn([status(StatusId.Poison, 900, 4)], 10);
    expect(light[0]?.cling).toBe(AFFLICTION_ART[StatusId.Poison]?.cling);
    expect(deep[0]?.cling).toBe(AFFLICTION_ART[StatusId.Poison]?.heavy);
    expect(deep[0]?.cling).not.toBe(light[0]?.cling);
  });
});

// --- the driver --------------------------------------------------------------

describe('AfflictionVfx', () => {
  it('starts the cling once and stops it once across apply, hold and expire', () => {
    // The cling is a **state**: started when the affliction lands, stopped when
    // it ends, and nothing in between. Burn, because it neither stacks nor ramps
    // and so cannot change severity half way through -- the swap has its own
    // test below.
    const burn = row(StatusId.Burn);
    const recorder = driveWholeWindow(burn, 1);
    const art = AFFLICTION_ART[StatusId.Burn];
    const clings = recorder.callsFor(art?.cling ?? '');

    expect(clings).toHaveLength(1);
    expect(recorder.stopped).toEqual([clings[0]?.handle]);
  });

  it('rides the body: attached, at the body’s own scale, on a shared seed', () => {
    // `scale` is the footprint radius because every length in `brushAffliction`
    // is authored as a multiple of it, and `attach` is what makes a mark born on
    // a walking body stay on it. The seed is derived from facts every client
    // shares, so two people watching one poisoned body see the same marks.
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    driver.step(BODY, [status(StatusId.Poison, 900)], 10);

    const call = recorder.played[0];
    expect(call?.entityId).toBe(BODY.entityId);
    expect(call?.scale).toBe(BODY.radius);
    expect(call?.x).toBe(BODY.x);
    expect(call?.z).toBe(BODY.z);
    expect(call?.seed).toBe(seedFor(BODY.entityId, AFFLICTION_ART[StatusId.Poison]?.cling ?? '', 0));
  });

  it('plays exactly one beat per pulse however many ticks a frame drains', () => {
    // The single most valuable property in this file. A frame drains as many
    // ticks as real time gave it -- one at 60fps, three at 20, seven on a bad
    // one -- and a beat rule that asked "is this tick a multiple of the
    // interval" would skip most beats and skip *all* of them on a slow frame.
    // Counting what has landed and firing on the increase is frame-rate
    // independent by construction, and it fires **once** for a frame that
    // drained three pulses, because a beat is a beat and not a quantity.
    for (const definition of ALL_DOTS) {
      const art = AFFLICTION_ART[definition.id];
      if (!art) throw new Error(`no art for ${definition.id}`);
      for (const stride of [1, 2, 3, 7]) {
        const recorder = driveWholeWindow(definition, stride);
        expect(
          recorder.callsFor(art.pulse),
          `${definition.id} at ${stride} ticks a frame`,
        ).toHaveLength(definition.pulses);
      }
    }
  });

  it('gives each beat of one affliction its own painting', () => {
    // The pulse index is in the seed, so successive beats on one body are
    // different paintings rather than the same one played over -- which is what
    // a fixed seed would make of an affliction that beats twenty times.
    const poison = row(StatusId.Poison);
    const art = AFFLICTION_ART[StatusId.Poison];
    const recorder = driveWholeWindow(poison, 1);
    const seeds = recorder.callsFor(art?.pulse ?? '').map((call) => call.seed);
    expect(seeds).toHaveLength(poison.pulses);
    expect(new Set(seeds).size).toBe(poison.pulses);
  });

  it('draws no beat after the window has closed', () => {
    // Nothing prunes the replicated list, so the driver keeps being handed a
    // status that ran out -- the refusal on read is the only thing that stops a
    // dead affliction beating forever.
    const shock = row(StatusId.Shock);
    const art = AFFLICTION_ART[StatusId.Shock];
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    const expiresAtTick = windowOf(shock);
    const held = [status(StatusId.Shock, expiresAtTick)];
    for (let tick = 0; tick < expiresAtTick; tick++) driver.step(BODY, held, tick);
    const during = recorder.callsFor(art?.pulse ?? '').length;
    for (let tick = expiresAtTick; tick < expiresAtTick + 400; tick++) {
      driver.step(BODY, held, tick);
    }
    expect(during).toBe(shock.pulses);
    expect(recorder.callsFor(art?.pulse ?? '')).toHaveLength(shock.pulses);
    expect(driver.entities()).toEqual([]);
  });

  it('draws every beat but the last when a frame never lands on the last live tick', () => {
    // The stated limit, asserted rather than left to be discovered. The window
    // carries exactly one tick of slack, so the final pulse lands on
    // `expiresAtTick - 1` and nowhere else; a frame schedule that steps over
    // that tick draws the beat that landed on the last tick it *did* see. What
    // matters is that this loses a beat and never invents one -- the count is
    // still exactly what the derivation says had landed when the driver last
    // looked.
    const burn = row(StatusId.Burn);
    const art = AFFLICTION_ART[StatusId.Burn];
    const expiresAtTick = windowOf(burn);
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    const held = [status(StatusId.Burn, expiresAtTick)];
    let last = 0;
    for (let tick = 0; tick < expiresAtTick; tick += 7) {
      driver.step(BODY, held, tick);
      last = tick;
    }
    driver.step(BODY, held, expiresAtTick);
    expect(last).toBeLessThan(expiresAtTick - 1);
    expect(recorder.callsFor(art?.pulse ?? '')).toHaveLength(
      pulsesLanded(burn, expiresAtTick, last),
    );
    expect(recorder.callsFor(art?.pulse ?? '').length).toBe(burn.pulses - 1);
  });

  it('fires no catch-up beats for a body first seen mid-affliction', () => {
    // A beat is a **contact**, and a contact nobody watched did not happen to
    // them -- the same rule `stagger-flinch.ts` keeps when it refuses to flinch
    // for a body that walked into view already broken. The cling is the
    // opposite and correctly starts at once, because a body that is burning is
    // burning whether or not this client watched it catch.
    const burn = row(StatusId.Burn);
    const art = AFFLICTION_ART[StatusId.Burn];
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    const expiresAtTick = windowOf(burn);
    const held = [status(StatusId.Burn, expiresAtTick)];

    const midway = burn.intervalTicks * 3 + 4;
    driver.step(BODY, held, midway);
    expect(recorder.callsFor(art?.pulse ?? '')).toHaveLength(0);
    expect(recorder.callsFor(art?.cling ?? '')).toHaveLength(1);

    // And the next real beat still lands: the baseline is a starting point, not
    // a mute.
    driver.step(BODY, held, burn.intervalTicks * 4);
    expect(recorder.callsFor(art?.pulse ?? '')).toHaveLength(1);
  });

  it('swaps the cling when the severity changes, stopping exactly one and starting one', () => {
    // Two ids rather than a parameter, so the driver's own diff does the swap
    // for free. Stepped at the same tick twice, so no beat can land in between
    // and the only calls in the recorder are the swap itself.
    const art = AFFLICTION_ART[StatusId.Poison];
    expect(art?.heavy).toBeDefined();
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    driver.step(BODY, [status(StatusId.Poison, 900, 1)], 10);
    driver.step(BODY, [status(StatusId.Poison, 900, 4)], 10);

    expect(recorder.ids).toEqual([art?.cling, art?.heavy]);
    expect(recorder.stopped).toEqual([recorder.played[0]?.handle]);
    // A body must never wear both at once, which is why the stop comes first.
    expect(recorder.stopped).toHaveLength(1);
  });

  it('leaves a cling alone while the affliction merely deepens below the tier', () => {
    // Poison crosses at three of five, so one to two is not a change of picture
    // and must not restart the paint: a cling that was stopped and started every
    // time a dart landed would flicker on exactly the affliction built to stack.
    const art = AFFLICTION_ART[StatusId.Poison];
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    driver.step(BODY, [status(StatusId.Poison, 900, 1)], 10);
    driver.step(BODY, [status(StatusId.Poison, 900, 2)], 11);
    expect(recorder.callsFor(art?.cling ?? '')).toHaveLength(1);
    expect(recorder.stopped).toEqual([]);
  });

  it('stops one affliction ending without disturbing another still running', () => {
    const burn = row(StatusId.Burn);
    const poison = row(StatusId.Poison);
    const burnArt = AFFLICTION_ART[StatusId.Burn];
    const poisonArt = AFFLICTION_ART[StatusId.Poison];
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    const held = [
      status(StatusId.Burn, windowOf(burn)),
      status(StatusId.Poison, windowOf(poison)),
    ];
    for (let tick = 0; tick < windowOf(burn) + 60; tick++) driver.step(BODY, held, tick);

    expect(recorder.callsFor(burnArt?.cling ?? '')).toHaveLength(1);
    expect(recorder.callsFor(poisonArt?.cling ?? '')).toHaveLength(1);
    // Exactly the burn's handle went back, and the body is still marked.
    expect(recorder.stopped).toEqual([recorder.callsFor(burnArt?.cling ?? '')[0]?.handle]);
    expect(driver.entities()).toEqual([BODY.entityId]);
  });

  it('hands back everything a despawning body still owns', () => {
    // The obligation that comes with holding a handle: on despawn **nothing
    // stops itself**. The attach hook answers false, the instance stays where it
    // last resolved, and a `durationTicks: 0` effect hangs in the air forever
    // holding an instance slot. Nothing in this game has ever held a persistent
    // attached effect before, so this is the pattern rather than a use of one.
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    driver.step(BODY, [status(StatusId.Burn, 900), status(StatusId.Decay, 900)], 10);
    expect(driver.entities()).toEqual([BODY.entityId]);
    expect(recorder.played).toHaveLength(2);

    driver.forget(BODY.entityId);
    expect(recorder.stopped).toEqual(recorder.played.map((call) => call.handle));
    expect(driver.entities()).toEqual([]);
    // Forgetting twice is not two stops.
    driver.forget(BODY.entityId);
    expect(recorder.stopped).toHaveLength(2);
  });

  it('keeps two bodies apart, and clear() empties both', () => {
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    const other: AfflictedBody = { ...BODY, entityId: 12 };
    driver.step(BODY, [status(StatusId.Burn, 900)], 10);
    driver.step(other, [status(StatusId.Burn, 900)], 10);
    expect(driver.entities()).toEqual([BODY.entityId, other.entityId]);
    // Two bodies wearing one affliction are two instances, and their seeds
    // differ, so a row of burning monsters is not one painting repeated.
    expect(recorder.played[0]?.seed).not.toBe(recorder.played[1]?.seed);

    driver.clear();
    expect(recorder.stopped).toHaveLength(2);
    expect(driver.entities()).toEqual([]);
  });

  it('retries a refused play rather than believing it started', () => {
    // `play` answers `0` for an unknown id, for a system over budget and for a
    // body beyond `cullDistance`, and this is the whole reason the driver holds
    // handles rather than ids: a tracker keyed on ids has no way to say
    // "wanted, asked for, did not start", and committing a refusal would leave a
    // body silently unmarked for the rest of its life. Holding a handle makes a
    // refusal mean "not started yet", so a body that walks into range gets its
    // paint on the frame it does.
    const art = AFFLICTION_ART[StatusId.Burn];
    const recorder = new Recorder();
    recorder.refusals = 3;
    const driver = new AfflictionVfx(recorder);
    const held = [status(StatusId.Burn, 900)];
    // The same tick each time, so nothing but the retry is in the recording.
    for (let attempt = 0; attempt < 4; attempt++) driver.step(BODY, held, 5);

    const calls = recorder.callsFor(art?.cling ?? '');
    expect(calls).toHaveLength(4);
    expect(calls.slice(0, 3).map((call) => call.handle)).toEqual([0, 0, 0]);
    expect(calls[3]?.handle).not.toBe(0);
    // A refusal is never stopped: there is no instance to hand back.
    expect(recorder.stopped).toEqual([]);

    // And once it is running it stays running, and stops exactly once.
    driver.step(BODY, held, 6);
    expect(recorder.callsFor(art?.cling ?? '')).toHaveLength(4);
    driver.forget(BODY.entityId);
    expect(recorder.stopped).toEqual([calls[3]?.handle]);
  });

  it('never plays an id the registry has not got', () => {
    // `playCue`'s rule rather than `addEffect`'s: an id the registry does not
    // know is silence, never a fallback ring. A debug ring under every body
    // carrying an unauthored status is exactly the noise the restrained-
    // presentation rule exists to prevent.
    const burn = row(StatusId.Burn);
    const art = AFFLICTION_ART[StatusId.Burn];
    // The cling is known and the beat is not, which is the half-authored case.
    const recorder = new Recorder([art?.cling ?? '']);
    const driver = new AfflictionVfx(recorder);
    const held = [status(StatusId.Burn, windowOf(burn))];
    for (let tick = 0; tick < windowOf(burn); tick++) driver.step(BODY, held, tick);

    expect(recorder.callsFor(art?.cling ?? '')).toHaveLength(1);
    expect(recorder.callsFor(art?.pulse ?? '')).toHaveLength(0);
    expect(recorder.ids.every((id) => recorder.has(id))).toBe(true);

    // And with nothing known at all, nothing is ever asked for -- including the
    // stop, since there was never a handle to hand back.
    const deaf = new Recorder([]);
    const other = new AfflictionVfx(deaf);
    for (let tick = 0; tick < 200; tick++) other.step(BODY, held, tick);
    other.forget(BODY.entityId);
    expect(deaf.played).toEqual([]);
    expect(deaf.stopped).toEqual([]);
  });

  it('is idempotent: the same facts on the next frame start, stop and beat nothing', () => {
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    const held = [status(StatusId.Frostbite, 900), status(StatusId.Bleed, 900, 3)];
    driver.step(BODY, held, 40);
    const after = recorder.played.length;
    for (let repeat = 0; repeat < 20; repeat++) driver.step(BODY, held, 40);
    expect(recorder.played).toHaveLength(after);
    expect(recorder.stopped).toEqual([]);
  });

  it('puts a cling back after the pool evicts it (spec 215)', () => {
    // The failure this closes is silent and only happens in the fight that
    // caused it: with the instance pool full, `claimInstance` evicts the
    // lowest-priority instance it can find rather than refusing, and a cling is
    // the lowest priority in the game. The handle goes stale in place. A driver
    // that kept believing it would leave that body unpainted for the rest of
    // its life, and every test that never filled the pool would stay green.
    const player = new Recorder();
    const driver = new AfflictionVfx(player);
    const body = { entityId: 4, x: 0, y: 0, z: 0, radius: 16 };
    const statuses = [status(StatusId.Burn, 400)];

    driver.step(body, statuses, 10);
    const first = player.played.filter((call) => call.id === 'affliction_burn');
    expect(first).toHaveLength(1);

    // Nothing has changed, so nothing should be started again.
    driver.step(body, statuses, 11);
    expect(player.played.filter((call) => call.id === 'affliction_burn')).toHaveLength(1);

    // Now the pool takes the slot back.
    player.evicted.add(first[0]?.handle ?? 0);
    driver.step(body, statuses, 12);
    const after = player.played.filter((call) => call.id === 'affliction_burn');
    expect(after).toHaveLength(2);
    // And it was restarted rather than stopped: stopping a handle the pool has
    // already retired is a no-op at best, and at worst it names a slot somebody
    // else is now using.
    expect(player.stopped).not.toContain(first[0]?.handle);
    // Settled again: the replacement is not restarted every frame.
    driver.step(body, statuses, 13);
    expect(player.played.filter((call) => call.id === 'affliction_burn')).toHaveLength(2);
  });

  it('costs nothing for a body that has never carried anything', () => {
    const recorder = new Recorder();
    const driver = new AfflictionVfx(recorder);
    driver.step(BODY, [], 40);
    driver.step(BODY, [status(StatusId.Flow, 900)], 40);
    expect(recorder.played).toEqual([]);
    expect(recorder.stopped).toEqual([]);
    expect(driver.entities()).toEqual([]);
  });
});
