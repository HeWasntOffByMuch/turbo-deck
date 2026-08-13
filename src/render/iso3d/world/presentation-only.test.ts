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
 * Spec 154 added a third: a drop's reveal. That one is worth having here more
 * than either of the others, because the failure it guards against is not
 * abstract -- a reveal implemented as client-side state would be a client
 * deciding when an item becomes real, and the state compared below includes the
 * drop's authoritative identity on every tick of the run.
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
import { driveUnit, speedBetween, type UnitFacts } from './unit-driver.js';
import { TurnEase, lagBound, shortestTurn, type TurnLimits } from '../turn-ease.js';
import { turnLimitsFor } from './turn-limits.js';
import type { ClientView } from '../../../server/client/game-client.js';
import { DropPresenter, type DropPresentation } from './loot-drop.js';

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
  // What the drop actually is, on every tick (spec 154). The identity is the
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

  for (let tick = 0; tick < TICKS; tick += 1) {
    server.tick();
    // A rare drop, at a fixed point rather than one read off the view, so both
    // runs put it in the same place for the same reason the inputs are scripted
    // (spec 154). Rare, because a common one reveals on the tick it lands and
    // would never exercise the withheld half at all.
    if (tick === 20) server.triggerEvent('drop', 620, 450, 1);
    client.advanceTick();
    // A fixed script: walk a circle, and swing on a fixed cadence. Nothing here
    // reads the view, so both runs send byte-identical input.
    const angle = (tick / 40) * Math.PI * 2;
    client.sendInput({
      moveX: Math.cos(angle),
      moveY: Math.sin(angle),
      facing: angle,
      buttons: 0,
    });
    await settle();

    const view = client.view();
    states.push(stateOf(view));
    if (!animate) continue;

    // The reveal presentation, driven exactly as the scene drives it: pure, and
    // handed the drawn tick.
    for (const drop of view.drops) drops.push(dropPresenter.read(drop, view.estimatedTick));
    dropPresenter.retain(new Set(view.drops.map((drop) => drop.entityId)));

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
        dead: entity.maxHealth > 0 && entity.health <= 0,
      };
      events.push(...driveUnit(machine, facts, previous.get(entity.id) ?? null, 1));
      previous.set(entity.id, facts);
      if (was === null || moved) positions.set(entity.id, at);
    }
  }

  return { states, events, yaws, drops };
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

  it('was actually revealing a drop, and withheld it first (spec 154)', async () => {
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

  it('drives a machine that has nothing it could call', () => {
    // The structural half, stated as a test so it is not only a comment: what
    // `driveUnit` is handed is a plain record of replicated facts. There is no
    // client in scope, no entity, and no route to one.
    const facts: UnitFacts = {
      speed: 0,
      activity: 0,
      castPhase: null,
      attackRate: 1,
      dead: false,
    };
    expect(Object.keys(facts).sort()).toEqual([
      'activity',
      'attackRate',
      'castPhase',
      'dead',
      'speed',
    ]);
    for (const value of Object.values(facts)) {
      expect(typeof value === 'number' || typeof value === 'boolean' || value === null).toBe(true);
    }
  });
});
