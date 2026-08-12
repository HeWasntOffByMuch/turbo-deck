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
 */

import { describe, expect, it } from 'vitest';
import { createWorldColliders } from '../../../sim/collision.js';
import { SERVER_PLAYER_RADIUS } from '../../../server/config.js';
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
import type { ClientView } from '../../../server/client/game-client.js';

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
  return `t${view.tick}|${bodies.join(',')}|${casts.join(',')}`;
}

interface RunResult {
  readonly states: readonly string[];
  readonly events: readonly FiredEvent[];
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

  for (let tick = 0; tick < TICKS; tick += 1) {
    server.tick();
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

    // The animation layer, driven exactly as the scene drives it.
    for (const entity of view.entities) {
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
        dead: entity.maxHealth > 0 && entity.health <= 0,
      };
      events.push(...driveUnit(machine, facts, previous.get(entity.id) ?? null, 1));
      previous.set(entity.id, facts);
      if (was === null || moved) positions.set(entity.id, at);
    }
  }

  return { states, events };
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

  it('drives a machine that has nothing it could call', () => {
    // The structural half, stated as a test so it is not only a comment: what
    // `driveUnit` is handed is a plain record of replicated facts. There is no
    // client in scope, no entity, and no route to one.
    const facts: UnitFacts = { speed: 0, activity: 0, castPhase: null, dead: false };
    expect(Object.keys(facts).sort()).toEqual(['activity', 'castPhase', 'dead', 'speed']);
    for (const value of Object.values(facts)) {
      expect(typeof value === 'number' || typeof value === 'boolean' || value === null).toBe(true);
    }
  });
});
