/**
 * Animation cannot change the game (spec 111).
 *
 * The brief's rule is a sentence -- "client-side animation state is presentation
 * only ... animation state must never feed back into gameplay state, assert on
 * this" -- and the interesting question is what an assertion on it even looks
 * like. A comment is not one. A type is barely one: `driveUnit` takes a plain
 * snapshot and not the `GameClient`, which means it has nothing to call, but
 * somebody adding a parameter would defeat that in one line and the compiler
 * would help them do it.
 *
 * So the assertion here is behavioural, and it is the one that would actually
 * catch the mistake: **run the same seed and the same inputs twice, once with
 * the animation layer driven and every event fired, once with it absent, and
 * require the authoritative state to be identical.** Anyone who wires
 * `swing.impact` into a hit, or reads a machine's state to decide an input, or
 * lets a blend weight reach a stat, breaks this and breaks it loudly.
 *
 * It is also the test that would catch the subtler version: an animation layer
 * that consumes shared mutable state -- an RNG, a scratch vector, a cache -- and
 * perturbs the sim without ever meaning to.
 *
 * Spec 140 added a second presentation-only track to the same run: the eased
 * drawn yaw. It is the same claim -- the sim owns the heading, the ease owns only
 * how a body is drawn getting to it -- so it is driven here beside the machines
 * and held to the same assertion.
 *
 * Spec 158 added a third: a drop's reveal. That one is worth having here more
 * than either of the others, because the failure it guards against is not
 * abstract -- a reveal implemented as client-side state would be a client
 * deciding when an item becomes real, and the state compared below includes the
 * drop's authoritative identity on every tick of the run.
 *
 * Spec 197 added a fourth: the paint on an afflicted body. It belongs here for
 * the same reason the reveal does, and one more. An affliction is the first
 * thing in this game a client works out the *schedule* of for itself -- the beat
 * is derived from the replicated expiry rather than sent -- so the obvious way
 * to get it wrong is to let that derivation reach back into anything. The
 * driver is handed only replicated facts and a recording player; if it ever
 * touched the sim's Rng, or the prediction, or a shared scratch buffer, this run
 * would diverge from the one with it switched off.
 */

import { describe, expect, it } from 'vitest';
import { createWorldColliders } from '../../../sim/collision.js';
import { BROADCAST_EVERY_N_TICKS, SERVER_PLAYER_RADIUS } from '../../../server/config.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import { FLAT_TERRAIN } from '../../../server/world/terrain.js';
import { GameClient } from '../../../server/client/game-client.js';
import { createWorldPredictor } from '../../../server/client/prediction.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUnitBundle } from '../../../units/bundle.js';
import { UnitMachine, type FiredEvent } from '../../../units/machine.js';
import { BASIC_ATTACK_ID } from '../../../server/data/abilities.js';
import { cancelledCast, driveUnit, speedBetween, type UnitFacts } from './unit-driver.js';
import { StaggerFlinches } from './stagger-flinch.js';
import { TurnEase, lagBound, shortestTurn, type TurnLimits } from '../turn-ease.js';
import { turnLimitsFor } from './turn-limits.js';
import type { ClientView } from '../../../server/client/game-client.js';
import { DropPresenter, type DropPresentation } from './loot-drop.js';
import { AfflictionVfx, type VfxPlayer } from './affliction-vfx.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const TICKS = 240;

/**
 * The real committed unit, read off disk through the real parser.
 *
 * Not `unitDefFixture`, deliberately. The fixture's death transition is
 * `!grounded` over a bool that starts false, so every unit built from it is
 * dead on its first tick and animates nothing -- correct for the fixture's own
 * tests, useless here. Reading the shipped document also means this test fails
 * if the document the game actually loads stops driving from the parameters
 * `unit-driver.ts` writes.
 */
const unitsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'assets', 'units', 'dev');
const read = (name: string): unknown => JSON.parse(readFileSync(join(unitsDir, name), 'utf8')) as unknown;
const bundle = loadUnitBundle(read('mannequin.unitdef.json'), read('mannequin-dev.core.cliplib.json'));
if (!bundle.value) throw new Error('the committed reference unit does not validate');
const { unit: DEV_UNIT, clipLib: DEV_CLIPS } = bundle.value;

/** The authoritative facts, as a string. Everything a change would show up in. */
function stateOf(view: ClientView): string {
  const bodies = [...view.entities]
    .sort((a, b) => a.id - b.id)
    .map((entity) =>
      [
        entity.id,
        entity.kind,
        entity.typeId,
        entity.x.toFixed(6),
        entity.y.toFixed(6),
        entity.facing.toFixed(6),
        entity.health,
        entity.maxHealth,
        entity.activity,
      ].join(':'),
    );
  const casts = [...view.casts]
    .sort((a, b) => a.entityId - b.entityId)
    .map((cast) => `${cast.entityId}:${cast.abilityId}:${cast.phase}`);
  // What the drop actually is, on every tick (spec 158). The identity is the
  // field the whole feature withholds, so it is the field a presentation layer
  // must be shown to be unable to move.
  const drops = [...view.drops]
    .sort((a, b) => a.entityId - b.entityId)
    .map((drop) =>
      [drop.entityId, drop.rarity, drop.defId ?? '', drop.count, drop.spawnTick, drop.revealTick].join(':'),
    );
  return `t${view.tick}|${bodies.join(',')}|${casts.join(',')}|${drops.join(',')}`;
}

interface RunResult {
  readonly states: readonly string[];
  readonly events: readonly FiredEvent[];
  /**
   * The eased drawn yaw beside the heading it was eased toward (spec 142), so a
   * run that silently stopped easing cannot pass the assertion above.
   */
  readonly yaws: readonly { drawn: number; heading: number; limits: TurnLimits }[];
  /** Every drop presentation produced, so a run that presented nothing fails. */
  readonly drops: readonly DropPresentation[];
  /**
   * Every effect the affliction layer asked for (spec 197), so a run whose paint
   * silently did nothing cannot claim to have covered it. Ids rather than
   * handles: what is worth asserting is that a cling was started and a beat was
   * played, not which slot they landed in.
   */
  readonly painted: readonly string[];
  /** How many attacks were called off (spec 166), so a run that left every
   * one-shot to finish on its own cannot claim to have covered the cancel. */
  readonly cancels: number;
  /**
   * How many bodies the stagger flinch was actually consulted about (spec 173),
   * so a run in which the reader was never driven cannot pass for one in which
   * it was.
   */
  readonly flinchesTracked: number;
}

/**
 * Plays the same scripted fight, with the animation layer on or off.
 *
 * The inputs are a fixed script rather than anything reactive, so the two runs
 * are the same experiment with one variable. A player who moved differently
 * because of what they saw would be a *different* input sequence, which is not
 * what is being measured.
 */
async function play(animate: boolean): Promise<RunResult> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 11,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  transport.onConnection((channel) => server.accept(channel));

  const client = new GameClient(transport.connect(), {
    playerId: 'you',
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: createWorldColliders([], []),
        terrain: FLAT_TERRAIN,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  client.connect();
  await settle();

  const machines = new Map<number, UnitMachine>();
  const previous = new Map<number, UnitFacts>();
  /** Last position a delta actually moved a body to, and the tick it landed on. */
  const positions = new Map<number, { x: number; y: number; tick: number }>();
  const events: FiredEvent[] = [];
  const states: string[] = [];
  const turnEase = new TurnEase();
  const yaws: { drawn: number; heading: number; limits: TurnLimits }[] = [];
  const dropPresenter = new DropPresenter();
  const drops: DropPresentation[] = [];
  // A recorder rather than a `VfxLayer`, which is the whole reason `VfxPlayer`
  // is an interface: the driver has no three.js in it and is driven here in
  // Node exactly as `scene.ts` drives it.
  const painted: string[] = [];
  let nextHandle = 1;
  const recorder: VfxPlayer = {
    has: () => true,
    play: (id) => {
      painted.push(id);
      return nextHandle++;
    },
    stop: () => {},
  };
  const afflictions = new AfflictionVfx(recorder);
  let cancels = 0;
  const flinches = new StaggerFlinches();

  for (let tick = 0; tick < TICKS; tick += 1) {
    server.tick();
    // A rare drop, at a fixed point rather than one read off the view, so both
    // runs put it in the same place for the same reason the inputs are scripted
    // (spec 158). Rare, because a common one reveals on the tick it lands and
    // would never exercise the withheld half at all.
    if (tick === 20) server.triggerEvent('drop', 620, 450, 1);
    // Every visible status, which is every affliction, on whatever is standing
    // near the spawn (spec 186's developer path). At a fixed tick and a fixed
    // point for the reason the drop is: both runs have to see the same world.
    // It is applied in *both* runs -- it is a server action, not a presentation
    // one -- so the comparison is between two identical fights, one of which is
    // being painted.
    if (tick === 30) server.triggerEvent('status', 700, 500, 400);
    client.advanceTick();
    // A fixed script: walk a circle, and every fortieth tick stop, swing, and
    // then walk out of it again -- which withdraws (spec 166), because asking
    // to move calls off a cast. The comment here used to claim the swing and
    // the script never made one; the counter below is what noticed.
    //
    // Nothing here reads the view, so both runs send byte-identical input.
    const angle = (tick / 40) * Math.PI * 2;
    const standing = tick % 40 < 6;
    if (tick % 40 === 0) client.useAbility(BASIC_ATTACK_ID, 700, 500);
    client.sendInput({
      moveX: standing ? 0 : Math.cos(angle),
      moveY: standing ? 0 : Math.sin(angle),
      facing: angle,
      buttons: 0,
    });
    await settle();

    const view = client.view();
    states.push(stateOf(view));
    if (!animate) continue;

    // The reveal presentation, driven exactly as the scene drives it: pure, and
    // handed the drawn tick.
    for (const drop of view.drops) {
      const entity = view.entities.find((body) => body.id === drop.entityId);
      const landing = { x: entity?.x ?? 0, y: entity?.y ?? 0, z: entity?.z ?? 0 };
      drops.push(dropPresenter.read(drop, landing, view.estimatedTick));
    }
    dropPresenter.retain(new Set(view.drops.map((drop) => drop.entityId)));

    // The paint (spec 197), driven exactly as `syncBodies` drives it: the
    // replicated status list, the drawn tick, and the body's own radius as the
    // scale. Nothing is read back.
    for (const entity of view.entities) {
      afflictions.step(
        {
          entityId: entity.id,
          x: entity.x,
          y: entity.z,
          z: entity.y,
          radius: SERVER_PLAYER_RADIUS,
        },
        entity.statuses ?? [],
        view.estimatedTick,
      );
    }

    // The animation layer, driven exactly as the scene drives it.
    for (const entity of view.entities) {
      // The eased yaw (spec 142), driven the same way -- one step per entity per
      // frame, off the replicated heading, exactly as `syncBodies` does it.
      const limits = turnLimitsFor(entity, entity.id === view.selfEntityId, view.stats?.turnRate ?? null, 60);
      if (limits !== null) {
        const drawn = turnEase.step(entity.id, entity.facing, limits, 1 / 60);
        yaws.push({ drawn, heading: entity.facing, limits });
      }
      let machine = machines.get(entity.id);
      if (!machine) {
        machine = new UnitMachine({ unit: DEV_UNIT, clipLib: DEV_CLIPS });
        machines.set(entity.id, machine);
      }
      // Deltas land every third tick, so two ticks in three the replicated
      // position is the same number it was. Measuring naively between
      // consecutive ticks reads zero two thirds of the time and the unit never
      // leaves idle -- the scene does not have this problem because it measures
      // off the *interpolated* pose, which moves every frame. Measuring from
      // the last delta that actually moved is the same quantity without needing
      // the interpolator in a headless test.
      const at = { x: entity.x, y: entity.y, tick };
      const was = positions.get(entity.id) ?? null;
      const moved = was !== null && (was.x !== at.x || was.y !== at.y);
      const facts: UnitFacts = {
        speed: moved ? speedBetween(was, at, Math.max(1, tick - was.tick) / 60) : (previous.get(entity.id)?.speed ?? 0),
        activity: entity.activity,
        castPhase: view.casts.find((cast) => cast.entityId === entity.id)?.phase ?? null,
        attackRate: 1,
        abilityId: view.casts.find((cast) => cast.entityId === entity.id)?.abilityId ?? null,
        castTicksLeft: (() => {
          const cast = view.casts.find((entry) => entry.entityId === entity.id);
          return cast === undefined ? null : cast.endTick - tick;
        })(),
        dead: entity.maxHealth > 0 && entity.health <= 0,
      };
      // Counted so the assertion below can say this fight really exercised the
      // cancel path (spec 166) rather than only the trigger. It does, and for a
      // reason that is easy to miss: the script walks a circle, and asking to
      // move withdraws from a cast.
      if (cancelledCast(facts, previous.get(entity.id) ?? null)) cancels += 1;
      // The stagger flinch, driven from the same replicated facts and on the
      // same tick (spec 173). It reads `activity` and `activityUntilTick`, both
      // of which are authoritative, and returns two angles nothing here writes
      // back -- which is the whole claim this file exists to make.
      flinches.read(entity.id, entity.activity, entity.activityUntilTick ?? 0, tick);
      events.push(...driveUnit(machine, facts, previous.get(entity.id) ?? null, 1));
      previous.set(entity.id, facts);
      if (was === null || moved) positions.set(entity.id, at);
    }
  }

  return { states, events, yaws, drops, painted, cancels, flinchesTracked: flinches.tracked };
}

describe('animation is presentation only', () => {
  it('does not change one byte of the authoritative state', async () => {
    const [withAnimation, without] = await Promise.all([play(true), play(false)]);
    expect(withAnimation.states).toEqual(without.states);
  }, 30_000);

  it('was actually animating, so the comparison above means something', async () => {
    // Without this, a run whose animation layer silently did nothing would pass
    // the test above and prove nothing at all.
    const animated = await play(true);
    expect(animated.events.length).toBeGreaterThan(0);
    expect(animated.states.length).toBe(TICKS);
    // And it withdrew from attacks along the way, so the comparison covers the
    // path that *leaves* a state early (spec 166) and not only the one that
    // enters it. Walking is what does it -- asking to move withdraws from a
    // cast -- and this script never stops walking.
    expect(animated.cancels).toBeGreaterThan(0);
  }, 30_000);

  it('was actually easing a yaw, and easing it away from the heading', async () => {
    // The same guard for spec 142's half: a run whose ease returned the
    // authoritative heading unchanged would pass the assertion above while
    // testing nothing. The player is turning continuously here, so the drawn yaw
    // must differ from the replicated one somewhere -- and by no more than the
    // sim's own alignment tolerance.
    const animated = await play(true);
    expect(animated.yaws.length).toBeGreaterThan(0);

    let worst = 0;
    for (const { drawn, heading, limits } of animated.yaws) {
      const behind = Math.abs(shortestTurn(drawn, heading));
      worst = Math.max(worst, behind);
      // The bound here carries a whole delta interval that the scene's does not,
      // and the difference is worth understanding rather than widening away: this
      // test drives the ease off `entity.facing`, the *raw* 20Hz replica, which
      // is a staircase that stands still for two ticks and then moves three
      // ticks' worth at once. The scene feeds it a ramp -- the prediction for our
      // own body, the interpolated pose for everything else -- and the tight
      // bound is asserted against exactly that, with the real `turnToward`
      // driving it, in `turn-ease.test.ts`. What is worth having here is that a
      // full fight's worth of bodies stays inside a bound at all.
      const staircase = (limits.degreesPerSecond * Math.PI * BROADCAST_EVERY_N_TICKS) / 180 / 60;
      expect(behind).toBeLessThanOrEqual(lagBound(limits) + staircase + 1e-9);
    }
    // And it really did trail: an ease that returned the heading unchanged would
    // satisfy the loop above and prove nothing.
    expect(worst).toBeGreaterThan(0);
  }, 30_000);

  it('was actually revealing a drop, and withheld it first (spec 158)', async () => {
    // The same guard the yaw gets: a run whose drop presentation did nothing
    // would satisfy the byte-for-byte assertion above and prove nothing.
    const animated = await play(true);
    expect(animated.drops.length).toBeGreaterThan(0);
    // It was withheld...
    expect(animated.drops.some((shown) => shown.label === null)).toBe(true);
    // ...and then it was not.
    expect(animated.drops.some((shown) => shown.label !== null)).toBe(true);
    // ...and it announced itself on the way, by name rather than by asset.
    expect(animated.drops.flatMap((shown) => shown.cues)).toContain('loot.reveal.rare');
  }, 30_000);

  it('was actually painting an affliction, and beating it (spec 197)', async () => {
    // The same guard the yaw and the drop get. A driver that started nothing
    // would satisfy the byte-for-byte assertion above and prove nothing -- and
    // that is not a hypothetical here, because every id it can play is looked up
    // through `has()` first and a table with a typo in it plays silence.
    const animated = await play(true);
    // The cling: started, and started once per body per affliction rather than
    // once per frame. Two hundred and forty ticks of holding it would be
    // thousands of plays if the idempotence were broken.
    const clings = animated.painted.filter((id) => !id.endsWith('_pulse'));
    expect(clings.length).toBeGreaterThan(0);
    expect(clings.length).toBeLessThan(60);
    // And the beat, which is the half that is derived rather than replicated.
    const beats = animated.painted.filter((id) => id.endsWith('_pulse'));
    expect(beats.length).toBeGreaterThan(0);
    // All seven afflictions land together under the developer trigger, so all
    // seven should have been painted. This is what catches a table that names
    // an effect the registry does not hold -- for six of the seven.
    const kinds = new Set(clings.map((id) => id.replace(/_heavy$/, '')));
    expect(kinds.size).toBe(7);
  }, 30_000);

  it('drives the stagger flinch, and it changes no state (spec 173)', async () => {
    // What this covers is the *wiring*: the flinch reader is consulted for every
    // body on every tick, from the same replicated facts the machines get, and
    // the authoritative state still compares equal. Both `activity` and
    // `activityUntilTick` are carried in the compared state, so a flinch that
    // wrote back would surface as a divergence here rather than as a silent
    // pass.
    //
    // What it deliberately does NOT claim is that a break happened. This script
    // is a fixed input sequence chosen for the turn ease and the drop reveal,
    // and nothing in it empties anybody's poise pool -- so an assertion that a
    // flinch fired would either be a lie or force the scenario to be rebuilt
    // around a mechanic it was not written for. The amplitude, the decay and
    // the edge are pinned in `stagger-flinch.test.ts`, against ticks rather
    // than against a fight, and the gate that produces the break at all is
    // pinned in `server/sim/stagger-gate.test.ts` through the real `step`.
    const [withAnimation, without] = await Promise.all([play(true), play(false)]);
    expect(withAnimation.flinchesTracked).toBeGreaterThan(0);
    expect(withAnimation.states).toEqual(without.states);
  }, 30_000);

  it('drives a machine that has nothing it could call', () => {
    // The structural half, stated as a test so it is not only a comment: what
    // `driveUnit` is handed is a plain record of replicated facts. There is no
    // client in scope, no entity, and no route to one.
    const facts: UnitFacts = {
      speed: 0,
      activity: 0,
      castPhase: null,
      attackRate: 1,
      abilityId: null,
      castTicksLeft: null,
      dead: false,
    };
    expect(Object.keys(facts).sort()).toEqual([
      'abilityId',
      'activity',
      'attackRate',
      'castPhase',
      'castTicksLeft',
      'dead',
      'speed',
    ]);
    for (const value of Object.values(facts)) {
      expect(typeof value === 'number' || typeof value === 'boolean' || value === null).toBe(true);
    }
  });
});
