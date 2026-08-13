/**
 * A drop inside the tick (spec 156).
 *
 * Between `loot.test.ts` (the clock, as arithmetic) and `client/loot-wire.test.ts`
 * (the whole path, over a socket) there is a third thing worth pinning down on
 * its own: what `step` does with a drop lying in the world. Expiry, the one
 * reveal event, and the drop being inert are all decisions inside the tick, and
 * driving them here is thousands of times cheaper than driving them through a
 * server -- a drop's lifetime is 90 seconds of ticks.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG } from '../config.js';
import { DROP_LIFETIME_TICKS, rarityRow } from '../data/loot.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { chunkKeyOf } from '../world/chunks.js';
import { makeDrop } from './loot.js';
import { EntityKindValue, type ServerWorldState } from './types.js';
import { createWorldState, spawnDrop, step, type StepContext } from './world.js';

const CHUNK = 100;
const AT = { x: 600, y: 450, z: 0 };
const ORIGIN = AT;

function context(overrides: Partial<StepContext> = {}): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks: new Set([chunkKeyOf(AT.x, AT.y, CHUNK)]),
    chunkSize: CHUNK,
    spawnPoints: [],
    ...overrides,
  };
}

/** A world holding one rare drop, stamped at tick 0. */
function worldWithDrop(rarity: 'common' | 'rare' | 'exceptional' = 'rare'): {
  state: ServerWorldState;
  id: number;
} {
  const drop = makeDrop('sword.keen', 1, rarity, 'ana', ORIGIN, 0, 1);
  const spawned = spawnDrop(createWorldState(1), drop, AT, 'greenmarch');
  return { state: spawned.state, id: spawned.entity.id };
}

/** Runs `ticks` steps and returns the final state plus everything that happened. */
function run(
  state: ServerWorldState,
  ticks: number,
): { state: ServerWorldState; events: ReturnType<typeof step>['events'][number][] } {
  let current = state;
  const events: ReturnType<typeof step>['events'][number][] = [];
  const ctx = context();
  for (let i = 0; i < ticks; i++) {
    const result = step(current, [], ctx);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

describe('a drop inside the tick', () => {
  it('announces its reveal exactly once, on the tick it crosses', () => {
    const { state, id } = worldWithDrop('rare');
    const revealTick = state.entities.get(id)?.drop?.revealTick ?? -1;
    expect(revealTick).toBe(rarityRow('rare').revealTicks);

    const { events } = run(state, revealTick + 60);
    const reveals = events.filter((e) => e.kind === 'lootRevealed' && e.entityId === id);
    expect(reveals).toHaveLength(1);
  });

  /** Nothing to announce when the first message already carries the answer. */
  it('announces nothing for a drop that landed already revealed', () => {
    const { state, id } = worldWithDrop('common');
    const { events } = run(state, 120);
    expect(events.filter((e) => e.kind === 'lootRevealed' && e.entityId === id)).toHaveLength(0);
  });

  it('holds the item unchanged across every phase', () => {
    const { state, id } = worldWithDrop('exceptional');
    const before = state.entities.get(id)?.drop;
    let current = state;
    const ctx = context();
    for (let i = 0; i < (before?.revealTick ?? 0) + 120; i++) {
      current = step(current, [], ctx).state;
      const drop = current.entities.get(id)?.drop;
      expect(drop?.defId).toBe(before?.defId);
      expect(drop?.count).toBe(before?.count);
      expect(drop?.rarity).toBe(before?.rarity);
      expect(drop?.ownerPlayerId).toBe(before?.ownerPlayerId);
      expect(drop?.revealTick).toBe(before?.revealTick);
    }
  });

  it('expires on its own tick, and leaves like any other entity', () => {
    const { state, id } = worldWithDrop('rare');
    const alive = run(state, DROP_LIFETIME_TICKS - 1);
    expect(alive.state.entities.get(id), 'still there the tick before').toBeTruthy();

    const gone = run(alive.state, 1);
    expect(gone.state.entities.get(id)).toBeUndefined();
    expect(gone.events.some((e) => e.kind === 'despawned' && e.entityId === id)).toBe(true);
  });

  /**
   * An unrevealed drop that runs out its clock says nothing on the way out. It
   * cannot: the reveal is thousands of ticks behind it, so this is really a
   * check that expiry does not go looking for one last announcement to make.
   */
  it('reveals nothing on the way out', () => {
    const { state, id } = worldWithDrop('exceptional');
    // Wound forward to just before the end, having never been observed.
    const { events } = run(state, DROP_LIFETIME_TICKS + 5);
    const reveals = events.filter((e) => e.kind === 'lootRevealed' && e.entityId === id);
    // Exactly the one crossing, and none at the expiry.
    expect(reveals).toHaveLength(1);
    const despawns = events.filter((e) => e.kind === 'despawned' && e.entityId === id);
    expect(despawns).toHaveLength(1);
  });

  it('does not walk, turn, cast or take a target', () => {
    const { state, id } = worldWithDrop('rare');
    const before = state.entities.get(id);
    const after = run(state, 300).state.entities.get(id);
    expect(after?.position).toEqual(before?.position);
    expect(after?.facing).toBe(before?.facing);
    expect(after?.targetId).toBeNull();
    expect(after?.path).toBeNull();
    expect(after?.cast).toBeNull();
    expect(after?.kind).toBe(EntityKindValue.Drop);
  });

  /**
   * The determinism property, stated where it is cheapest to check: the same
   * seed and the same steps give the same world, drop clock included.
   */
  it('replays exactly', () => {
    const trace = (): string => {
      const { state } = worldWithDrop('rare');
      const out = run(state, 200);
      return JSON.stringify([...out.state.entities.values()].map((e) => e.drop));
    };
    expect(trace()).toBe(trace());
  });
});
