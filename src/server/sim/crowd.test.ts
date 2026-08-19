/**
 * What a crowd does (spec 184).
 *
 * The five scenarios these assert are the same five `npx tsx
 * scripts/preview-crowd.ts` draws, out of the same harness -- so a panel that
 * looks wrong and a green test cannot both be true, which is the one thing a
 * feature judged by eye most needs.
 *
 * Everything here runs the **real `step`**: real monsters out of `MONSTERS`,
 * real aggro, real casts, real collision, real terrain rules. The only thing
 * invented is where the bodies start.
 *
 * The numbers are deliberately loose. A crowd is a continuous system and the
 * exact figure is a fact about a tuning constant; what these pin is the
 * *property* -- bodies do not stand inside each other, the crowd flows rather
 * than jamming, fast bodies get past slow ones, and a pack surrounds rather
 * than stacks. A tightened constant that quietly broke one of those is what
 * they exist to catch.
 */

import { describe, expect, it } from 'vitest';
import { converge, cross, gate, herd, overtake, run, finalOf } from '../../../scripts/crowd-scenarios.js';
import {
  frontOf,
  jerk,
  overtook,
  reached,
  sizeOf,
  widestGap,
  worstOverlap,
} from '../../../scripts/crowd-metrics.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { createWorldColliders } from '../../sim/collision.js';
import { WORLD_BOUNDS } from '../../sim/constants.js';
import { monsterById } from '../data/monsters.js';
import { computeEffectiveStats } from '../player/stats.js';
import { EMPTY_EQUIPMENT, emptyInventory, type PersistedPlayer } from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { EntityKindValue, type ServerInput, type ServerWorldState } from './types.js';
import { createWorldState, spawnEntity, step, type StepContext } from './world.js';

describe('a herd crossing open ground', () => {
  const trace = run(herd(30), 1300, 1);

  it('does not let one body stand inside another', () => {
    // A hair of overlap is what a crowd pressed together settles at: the
    // separation pass takes a fraction of it out per tick rather than all of
    // it, on purpose. What must not happen is bodies sharing ground.
    expect(worstOverlap(trace)).toBeLessThan(0.12);
  });

  it('gets there rather than jamming', () => {
    // The quarry is at x = 2400 and they set off from about 200: a stalker
    // covers 105 units a second, so twenty-two seconds is a comfortable margin
    // over the seventeen the walk takes at full speed.
    expect(frontOf(trace, 1)).toBeGreaterThan(2200);
  });

  it('does not shudder: the tick-to-tick velocity change stays small', () => {
    // A repulsion force swings a body's whole speed back and forth across a
    // pass; this is the measurement that tells the two apart.
    const swing = jerk(trace);
    expect(swing.p50).toBeLessThan(0.02);
    expect(swing.p95).toBeLessThan(0.15);
  });

  it('never moves a body faster than its own stat allows', () => {
    for (const actor of trace.scenario.actors) {
      if (actor.player) continue;
      const entity = finalOf(trace, actor);
      if (!entity) continue;
      const speed = Math.hypot(entity.velocity.x, entity.velocity.y);
      expect(speed).toBeLessThanOrEqual(actor.speed + 1e-6);
    }
  });
});

describe('fast bodies behind slow ones', () => {
  const trace = run(overtake(), 1500, 1);

  it('lets the fast ones past rather than queueing them behind', () => {
    // Eight small spiders at 115 a second behind eight grazers at 40. Without
    // avoidance they walk through each other and this is vacuous; with a
    // repulsion force they tailgate.
    expect(overtook(trace, 2, 1)).toBe(sizeOf(trace, 2));
    expect(frontOf(trace, 2)).toBeGreaterThan(frontOf(trace, 1));
  });

  it('does not make the slow ones fast or the fast ones slow', () => {
    for (const actor of trace.scenario.actors) {
      if (actor.player) continue;
      const entity = finalOf(trace, actor);
      if (!entity) continue;
      expect(Math.hypot(entity.velocity.x, entity.velocity.y)).toBeLessThanOrEqual(actor.speed + 1e-6);
    }
  });
});

describe('a crowd at a narrow opening', () => {
  const trace = run(gate(16), 1500, 1);

  it('gets every body through rather than arching across the gap', () => {
    // The gap is 140 units and a stalker is 40 across, so three abreast do not
    // fit and something has to give way. The failure this catches is the crowd
    // literature's arch: mutual pressure across a bottleneck that nobody gets
    // through at all.
    expect(reached(trace, 1, { x: 1700, y: 900 }, 520)).toBe(sizeOf(trace, 1));
  });

  it('does not stand bodies inside each other doing it', () => {
    expect(worstOverlap(trace)).toBeLessThan(0.12);
  });
});

describe('a pack converging on one quarry', () => {
  const centre = { x: 1200, y: 900 };
  const trace = run(converge(12), 900, 1);

  it('surrounds it rather than stacking on the side it came from', () => {
    // The widest empty arc round the quarry. A pack that all arrived on one
    // bearing leaves nearly a full turn empty.
    expect(widestGap(trace, centre, 200)).toBeLessThan(Math.PI * 0.75);
  });

  it('gets most of the pack into its own reach', () => {
    // A stalker stops at 68.8 from the quarry's centre; 110 allows for the ring
    // being fuller than it is wide.
    expect(reached(trace, 1, centre, 110)).toBeGreaterThanOrEqual(sizeOf(trace, 1) - 3);
  });

  it('does not pile them into one another', () => {
    expect(worstOverlap(trace)).toBeLessThan(0.1);
  });
});

describe('two crowds walking through each other', () => {
  const trace = run(cross(9), 1500, 1);

  it('lets both sides through', () => {
    expect(reached(trace, 1, { x: 2200, y: 900 }, 400)).toBe(sizeOf(trace, 1));
    expect(reached(trace, 2, { x: 200, y: 900 }, 400)).toBe(sizeOf(trace, 2));
  });

  it('does not let them pass through each other', () => {
    expect(worstOverlap(trace)).toBeLessThan(0.12);
  });

  it('does not shudder while they interleave', () => {
    expect(jerk(trace).p95).toBeLessThan(0.15);
  });
});

describe('the crowd pass is part of the deterministic core', () => {
  it('replays a crowd bit for bit', () => {
    const first = run(converge(12), 300, 300);
    const second = run(converge(12), 300, 300);
    for (const actor of first.scenario.actors) {
      const a = finalOf(first, actor);
      const b = second.last.entities.get(actor.id) ?? null;
      expect(b?.position.x).toBe(a?.position.x);
      expect(b?.position.y).toBe(a?.position.y);
      expect(b?.facing).toBe(a?.facing);
      expect(b?.attackSlot).toBe(a?.attackSlot);
    }
  });

  it('draws no randomness, so a fight after a crowd rolls what it would have rolled', () => {
    // The rng is threaded through the whole sim and its draw *count* is
    // load-bearing: a crowd pass that drew even one value would shift every
    // crit, weak point and loot roll after it in every replay.
    const trace = run(herd(12), 120, 120);
    expect(trace.last.rng.getState()).toEqual(trace.scenario.state.rng.getState());
  });
});

/**
 * The limit spec 184 states rather than hides: a player's own movement is not
 * touched, because it is predicted on their machine (spec 067) and a deflection
 * here is a divergence the client cannot reproduce.
 */
describe('a player in a crowd', () => {
  const RECORD: PersistedPlayer = {
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    coins: 0,
    position: { x: 1200, y: 900, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 1,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
    health: 100,
    resource: 20,
  };
  const STATS = computeEffectiveStats(RECORD);
  const CHUNK = 100;

  function pressedUpon(): { state: ServerWorldState; context: StepContext; playerId: number } {
    let state = createWorldState(1);
    const player = spawnEntity(state, {
      kind: EntityKindValue.Player,
      typeId: 'player',
      ownerPlayerId: 'p1',
      position: { x: 1200, y: 900, z: 0 },
      stats: STATS,
      radius: 16,
      zoneId: 'greenmarch',
      health: 100000,
    });
    state = player.state;
    const def = monsterById('stalker');
    if (!def) throw new Error('no stalker');
    for (let i = 0; i < 10; i++) {
      const angle = (i * 2 * Math.PI) / 10;
      const spawned = spawnEntity(state, {
        kind: EntityKindValue.Monster,
        typeId: 'stalker',
        position: { x: 1200 + Math.cos(angle) * 90, y: 900 + Math.sin(angle) * 90, z: 0 },
        stats: def.stats,
        radius: def.radius,
        zoneId: 'greenmarch',
        targetId: player.entity.id,
        health: 100000,
      });
      state = spawned.state;
    }
    const keys = new Set<string>();
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) keys.add(chunkKeyOf(1200 + dx * CHUNK, 900 + dy * CHUNK, CHUNK));
    }
    return {
      state,
      playerId: player.entity.id,
      context: {
        world: createWorldColliders([], [], WORLD_BOUNDS),
        terrain: FLAT_TERRAIN,
        zones: new ZoneManager(),
        config: DEFAULT_LIVE_CONFIG,
        activeChunks: keys,
        chunkSize: CHUNK,
        spawnPoints: [],
      },
    };
  }

  it('walks exactly as far as it asked to, with ten bodies pressed against it', () => {
    let { state } = pressedUpon();
    const { context, playerId } = pressedUpon();
    const step_ = SERVER_TICK_RATE;
    const from = state.entities.get(playerId)?.position.x ?? 0;
    for (let tick = 0; tick < step_; tick++) {
      const input: ServerInput = {
        entityId: playerId,
        seq: tick + 1,
        moveX: 1,
        moveY: 0,
        facing: 0,
        buttons: 0,
        predictedX: 0,
        predictedY: 0,
        hasPrediction: false,
        seqSpan: 1,
        castAbilityId: '',
        castTargetX: 0,
        castTargetY: 0,
        castTargetEntityId: 0,
        cancelCast: false,
      };
      state = step(state, [input], context).state;
    }
    const to = state.entities.get(playerId)?.position.x ?? 0;
    // A second of walking at the player's own speed, to the unit.
    expect(to - from).toBeCloseTo(STATS.moveSpeed, 6);
  });

  it('is never corrected because of the crowd around it', () => {
    let { state } = pressedUpon();
    const { context, playerId } = pressedUpon();
    let corrections = 0;
    for (let tick = 0; tick < SERVER_TICK_RATE * 2; tick++) {
      const angle = tick / 20;
      const result = step(
        state,
        [
          {
            entityId: playerId,
            seq: tick + 1,
            moveX: Math.cos(angle),
            moveY: Math.sin(angle),
            facing: angle,
            buttons: 0,
            predictedX: 0,
            predictedY: 0,
            hasPrediction: false,
            seqSpan: 1,
            castAbilityId: '',
            castTargetX: 0,
            castTargetY: 0,
            castTargetEntityId: 0,
            cancelCast: false,
          },
        ],
        context,
      );
      state = result.state;
      corrections += result.events.filter((e) => e.kind === 'correction').length;
    }
    expect(corrections).toBe(0);
  });
});
