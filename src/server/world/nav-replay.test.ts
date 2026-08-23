/**
 * A real fight, replayed through the windowed nav (spec 205).
 *
 * `nav.test.ts` asserts the cache answers the same whatever it has built before;
 * this asserts the consequence, which is the rule the whole project turns on:
 * **the same seed and the same inputs produce bit-identical state.**
 *
 * It exists as its own file because the replay tests already in the tree drive
 * `step` with no `nav` in the context and a 100-unit chunk grid, so they
 * exercise the fallback rather than the windows. This one uses `CHUNK_SIZE`,
 * because that is what a nav tile is.
 *
 * The monster is walled off from the player on purpose. `routeToward` only
 * reaches `findPath` when the straight line is blocked, so an open-ground fight
 * would replay identically while never once asking nav a question.
 */

import { describe, expect, it } from 'vitest';

import { buildColliderIndex } from '../../sim/collider-index.js';
import type { Circle, WorldColliders } from '../../sim/types.js';
import { CHUNK_SIZE, DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { monsterById } from '../data/monsters.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
  type PersistedPlayer,
} from '../state/types.js';
import { EntityKindValue, type ServerWorldState } from '../sim/types.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../sim/world.js';
import { chunkKeysInRadius } from './chunks.js';
import { FLAT_TERRAIN } from './terrain.js';
import { ZoneManager } from './zone-manager.js';
import { ServerNav } from './nav.js';

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: 0, y: 0, z: 0 },
  facing: 0,
  currentZone: 'hearth',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 100,
  resource: 20,
};
const PLAYER_STATS: EffectiveStats = computeEffectiveStats(RECORD);

/** The player's spot, and the monster's, with a wall between them. */
const PLAYER = { x: 1000, y: 1000 };
// Inside `small_spider`'s 300-unit notice range, on the far side of the wall.
// Out of range and it never engages, and every replay below would be two
// identical recordings of nothing happening -- which is what the control test
// exists to catch, and did.
const MONSTER = { x: 1000, y: 1250 };

/**
 * A world far wider than one window, with a wall between the two bodies.
 *
 * Wider than a window so a window is genuinely a window; walled so the monster
 * has to path round rather than walk straight, which is the only way nav is
 * asked anything at all.
 */
function walledWorld(): WorldColliders {
  const circles: Circle[] = [];
  // Long enough to block the straight line, short enough that going round it is
  // a route rather than a hopeless search.
  for (let x = 850; x <= 1150; x += 11) circles.push({ x, y: 1150, r: 14 });
  return {
    bounds: { x: -20000, y: -20000, w: 40000, h: 40000 },
    rects: [],
    circles,
    index: buildColliderIndex(circles),
  };
}

function activeAround(x: number, y: number): Set<string> {
  return new Set(
    chunkKeysInRadius({ cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE) }, 4),
  );
}

function fight(nav: ServerNav, colliders: WorldColliders): ServerWorldState {
  let state = createWorldState(7);
  const player = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: PLAYER.x, y: PLAYER.y, z: 0 },
    stats: PLAYER_STATS,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = player.state;

  const spider = monsterById('small_spider');
  if (!spider) throw new Error('no small_spider');
  const monster = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: 'small_spider',
    position: { x: MONSTER.x, y: MONSTER.y, z: 0 },
    stats: spider.stats,
    radius: spider.radius,
    zoneId: 'greenmarch',
    anchor: { x: MONSTER.x, y: MONSTER.y },
  });
  state = monster.state;

  const active = activeAround(PLAYER.x, PLAYER.y);
  nav.update(active);
  const ctx: StepContext = {
    world: colliders,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks: active,
    chunkSize: CHUNK_SIZE,
    spawnPoints: [],
    nav,
  };

  for (let tick = 0; tick < SERVER_TICK_RATE * 3; tick++) {
    state = step(state, [], ctx).state;
  }
  return state;
}

/** Everything that must match between two replays of the same seed and inputs. */
function snapshot(state: ServerWorldState): string {
  return JSON.stringify({
    tick: state.tick,
    nextEntityId: state.nextEntityId,
    rng: state.rng.getState(),
    entities: [...state.entities.values()],
  });
}

/** A nav that has already been used somewhere else entirely. */
function walkedElsewhere(colliders: WorldColliders, radii: readonly number[]): ServerNav {
  const nav = new ServerNav(colliders, FLAT_TERRAIN, radii);
  for (const at of [12000, -8000, 4000]) {
    nav.update(activeAround(at, at));
    nav.gridAt(radii[0] ?? 16, at, at);
  }
  return nav;
}

describe('a fight routed through a window', () => {
  const colliders = walledWorld();
  const spider = monsterById('small_spider');
  if (!spider) throw new Error('no small_spider');
  const radii = [16, spider.radius];

  it('asks nav a question at all', () => {
    // The control. Everything below would pass on an open field where
    // `routeToward` never reaches `findPath`, and would be asserting nothing.
    const nav = new ServerNav(colliders, FLAT_TERRAIN, radii);
    fight(nav, colliders);
    expect(nav.stats().windows).toBeGreaterThan(0);
    expect(nav.stats().tiles).toBeGreaterThan(0);
  });

  it('replays to bit-identical state', () => {
    const a = fight(new ServerNav(colliders, FLAT_TERRAIN, radii), colliders);
    const b = fight(new ServerNav(colliders, FLAT_TERRAIN, radii), colliders);
    expect(snapshot(b)).toBe(snapshot(a));
  });

  it('replays to bit-identical state on a nav that had been used elsewhere', () => {
    // The hazard a cache introduces, at the level it would actually bite: if
    // what had been built changed what was answered, this is the run that would
    // diverge, and it would diverge for a reason no seed could reproduce.
    const fresh = fight(new ServerNav(colliders, FLAT_TERRAIN, radii), colliders);
    const used = fight(walkedElsewhere(colliders, radii), colliders);
    expect(snapshot(used)).toBe(snapshot(fresh));
  });

  it('gets the monster past the wall', () => {
    // Not a determinism claim -- a sanity one. Two identical wrong answers are
    // still identical, so the replays above are only worth having if the fight
    // in them is a fight.
    const state = fight(new ServerNav(colliders, FLAT_TERRAIN, radii), colliders);
    const monster = [...state.entities.values()].find((e) => e.typeId === 'small_spider');
    if (!monster) throw new Error('no monster');
    expect(monster.position.y).not.toBe(MONSTER.y);
  });
});
