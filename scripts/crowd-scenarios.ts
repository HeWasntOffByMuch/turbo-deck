// The five crowd scenarios (spec 184), built once and read by three things: the
// picture (`preview-crowd.ts`), the assertions (`src/server/sim/crowd.test.ts`)
// and the cost (`bench-crowd.ts`).
//
// One module rather than three copies, because the whole value of the picture
// is that it is a picture *of the thing the tests assert*. A preview that built
// its own slightly different herd would be evidence about a herd nobody ships.
//
// Everything here runs through the **real `step`** -- real monsters out of
// `MONSTERS`, real aggro, real casts, real collision, real terrain rules. The
// only thing invented is the arrangement of bodies and, where a scenario needs
// one, a wall.
//
// The shipped map cannot field these crowds: `maps/arena.json` holds fourteen
// spawners, one monster each, and the tightest cluster on it self-initiates
// five attackers. So the bodies are placed rather than spawned -- which is what
// an admin conjuring a fight does, and what the feature has to survive.

import { createWorldColliders } from '../src/sim/collision.js';
import { WORLD_BOUNDS } from '../src/sim/constants.js';
import type { Rect, WorldColliders } from '../src/sim/types.js';
import { DEFAULT_LIVE_CONFIG } from '../src/server/config.js';
import { monsterById } from '../src/server/data/monsters.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { EntityKindValue, type ServerEntity, type ServerWorldState } from '../src/server/sim/types.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../src/server/sim/world.js';
import { EMPTY_EQUIPMENT, emptyInventory, type PersistedPlayer } from '../src/server/state/types.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';

const CHUNK = 100;

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
  currentZone: 'greenmarch',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 100,
  resource: 20,
};

const PLAYER_STATS = computeEffectiveStats(RECORD);

/**
 * Open ground and nothing else.
 *
 * Deliberately not `DEFAULT_WORLD`, which carries `ARENA_OBSTACLES` -- three
 * blocks left over from the single-player arena that predate the map document
 * entirely. A crowd scenario that had them in it would be measuring how a herd
 * gets round furniture nobody has seen since spec 072, and the one scenario
 * that is genuinely about geometry builds its own wall.
 */
const OPEN = createWorldColliders([], [], WORLD_BOUNDS);

/** One body in a scenario, and what it is for. */
export interface Actor {
  readonly id: number;
  readonly typeId: string;
  readonly radius: number;
  /** Which of the scenario's groups it belongs to, for colouring and for metrics. */
  readonly group: number;
  readonly speed: number;
  readonly player: boolean;
}

export interface Scenario {
  readonly name: string;
  /** What the picture and the numbers are meant to show. */
  readonly claim: string;
  readonly world: WorldColliders;
  /** The world-space box the picture frames. */
  readonly window: Rect;
  readonly state: ServerWorldState;
  readonly context: StepContext;
  readonly actors: readonly Actor[];
  /** Players whose health is topped up every tick, so a scenario cannot end early. */
  readonly immortal: readonly number[];
}

/** Where every body was, once per sampled tick. */
export interface Frame {
  readonly tick: number;
  readonly at: readonly { readonly x: number; readonly y: number; readonly moving: boolean }[];
}

export interface Trace {
  readonly scenario: Scenario;
  readonly frames: readonly Frame[];
  /** Final state, for the metrics that only make sense at the end. */
  readonly last: ServerWorldState;
  /** Milliseconds of wall clock the whole run took, for the bench. */
  readonly elapsedMs: number;
}

function activeOver(box: Rect): Set<string> {
  const keys = new Set<string>();
  for (let y = box.y - CHUNK; y <= box.y + box.h + CHUNK; y += CHUNK) {
    for (let x = box.x - CHUNK; x <= box.x + box.w + CHUNK; x += CHUNK) {
      keys.add(chunkKeyOf(x, y, CHUNK));
    }
  }
  return keys;
}

interface Build {
  state: ServerWorldState;
  readonly actors: Actor[];
  readonly immortal: number[];
}

function addPlayer(build: Build, x: number, y: number, group: number): number {
  const spawned = spawnEntity(build.state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: `p${build.actors.length}`,
    position: { x, y, z: 0 },
    stats: PLAYER_STATS,
    radius: 16,
    zoneId: 'greenmarch',
    health: 100000,
  });
  build.state = spawned.state;
  build.actors.push({
    id: spawned.entity.id,
    typeId: 'player',
    radius: 16,
    group,
    speed: PLAYER_STATS.moveSpeed,
    player: true,
  });
  build.immortal.push(spawned.entity.id);
  return spawned.entity.id;
}

function addMonster(
  build: Build,
  typeId: string,
  x: number,
  y: number,
  targetId: number,
  group: number,
): number {
  const def = monsterById(typeId);
  if (!def) throw new Error(`no monster ${typeId}`);
  const spawned = spawnEntity(build.state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x, y, z: 0 },
    stats: def.stats,
    radius: def.radius,
    zoneId: 'greenmarch',
    // Already committed, because nothing initiates on its own since spec 076
    // and a crowd that has not noticed anything is not a crowd.
    targetId,
    // No anchor, so no leash: these fights are meant to cross the whole window.
    health: 100000,
  });
  build.state = spawned.state;
  build.actors.push({
    id: spawned.entity.id,
    typeId,
    radius: def.radius,
    group,
    speed: def.stats.moveSpeed,
    player: false,
  });
  return spawned.entity.id;
}

function begin(): Build {
  return { state: createWorldState(1), actors: [], immortal: [] };
}

function finish(
  name: string,
  claim: string,
  build: Build,
  world: WorldColliders,
  window: Rect,
): Scenario {
  return {
    name,
    claim,
    world,
    window,
    state: build.state,
    context: {
      world,
      terrain: FLAT_TERRAIN,
      zones: new ZoneManager(),
      config: DEFAULT_LIVE_CONFIG,
      activeChunks: activeOver(window),
      chunkSize: CHUNK,
      spawnPoints: [],
    },
    actors: build.actors,
    immortal: build.immortal,
  };
}

/**
 * Forty bodies set off together across open ground after one quarry a long way
 * off. What is being watched is the travel, not the arrival.
 */
export function herd(count = 40): Scenario {
  const build = begin();
  const quarry = addPlayer(build, 2400, 900, 0);
  const columns = 5;
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns);
    const column = i % columns;
    addMonster(build, 'stalker', 400 - column * 58, 900 + (row - (count / columns - 1) / 2) * 58, quarry, 1);
  }
  return finish(
    'herd',
    `${count} bodies crossing open ground after one quarry`,
    build,
    OPEN,
    { x: 200, y: 500, w: 2400, h: 800 },
  );
}

/**
 * Slow bodies in front, fast ones behind, all after the same quarry. The claim
 * is that the fast ones end up in front -- overtaking is what a shared corridor
 * of avoidance is worst at, and what a repulsion force cannot do at all.
 */
export function overtake(): Scenario {
  const build = begin();
  const quarry = addPlayer(build, 2600, 900, 0);
  // Grazers: 40 units a second, radius 22. In front.
  for (let i = 0; i < 8; i++) {
    addMonster(build, 'grazer', 800 - Math.floor(i / 2) * 70, 900 + ((i % 2) - 0.5) * 90, quarry, 1);
  }
  // Small spiders: 115 units a second, radius 12. Behind.
  for (let i = 0; i < 8; i++) {
    addMonster(build, 'small_spider', 420 - Math.floor(i / 2) * 70, 900 + ((i % 2) - 0.5) * 90, quarry, 2);
  }
  return finish(
    'overtake',
    'eight slow bodies in front of eight fast ones, one quarry',
    build,
    OPEN,
    { x: 200, y: 600, w: 2600, h: 600 },
  );
}

/**
 * A wall with one gap in it, a crowd on one side and the quarry on the other.
 * The gap is a little over three bodies wide, so it cannot be walked through
 * abreast and something has to give way.
 */
export function gate(count = 24): Scenario {
  const build = begin();
  const wallX = 1100;
  const gapY = 900;
  const gapHalf = 70;
  const world = createWorldColliders(
    [
      { x: wallX, y: 300, w: 60, h: gapY - gapHalf - 300 },
      { x: wallX, y: gapY + gapHalf, w: 60, h: 1500 - (gapY + gapHalf) },
    ],
    [],
    WORLD_BOUNDS,
  );
  const quarry = addPlayer(build, 1700, gapY, 0);
  const columns = 4;
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns);
    const column = i % columns;
    addMonster(build, 'stalker', 700 - column * 60, gapY + (row - (count / columns - 1) / 2) * 60, quarry, 1);
  }
  return finish(
    'gate',
    `${count} bodies through a ${gapHalf * 2}-unit gap: a stalker is 40 across`,
    build,
    world,
    { x: 400, y: 500, w: 1600, h: 800 },
  );
}

/** Bodies from every direction onto one quarry, which is what a pack pull looks like. */
export function converge(count = 20): Scenario {
  const build = begin();
  const centre = { x: 1200, y: 900 };
  const quarry = addPlayer(build, centre.x, centre.y, 0);
  for (let i = 0; i < count; i++) {
    // Two rings, so they do not all arrive on the same tick.
    const angle = (i * 2 * Math.PI) / count;
    const away = 380 + (i % 2) * 190;
    addMonster(build, 'stalker', centre.x + Math.cos(angle) * away, centre.y + Math.sin(angle) * away, quarry, 1);
  }
  return finish(
    'converge',
    `${count} bodies onto one quarry from every side`,
    build,
    OPEN,
    { x: 600, y: 300, w: 1200, h: 1200 },
  );
}

/** Two crowds with business on opposite sides, walking straight through each other. */
export function cross(perSide = 15): Scenario {
  const build = begin();
  const east = addPlayer(build, 2200, 900, 0);
  const west = addPlayer(build, 200, 900, 0);
  const columns = 3;
  for (let i = 0; i < perSide; i++) {
    const row = Math.floor(i / columns);
    const column = i % columns;
    addMonster(build, 'stalker', 600 - column * 60, 900 + (row - (perSide / columns - 1) / 2) * 62, east, 1);
  }
  for (let i = 0; i < perSide; i++) {
    const row = Math.floor(i / columns);
    const column = i % columns;
    addMonster(build, 'stalker', 1800 + column * 60, 900 + (row - (perSide / columns - 1) / 2) * 62 + 20, west, 2);
  }
  return finish(
    'cross',
    `two crowds of ${perSide} walking through each other`,
    build,
    OPEN,
    { x: 100, y: 550, w: 2200, h: 700 },
  );
}

export const SCENARIOS: readonly (() => Scenario)[] = [herd, overtake, gate, converge, cross];

/**
 * Run a scenario, sampling every `every` ticks.
 *
 * The immortal players are topped up each tick, because what is being measured
 * is how a crowd moves and a quarry that dies ends the crowd.
 */
export function run(scenario: Scenario, ticks: number, every = 4): Trace {
  let state = scenario.state;
  const frames: Frame[] = [];
  const startedAt = Date.now();

  for (let tick = 0; tick < ticks; tick++) {
    if (scenario.immortal.length > 0) {
      const entities = new Map(state.entities);
      for (const id of scenario.immortal) {
        const entity = entities.get(id);
        if (entity) entities.set(id, { ...entity, health: entity.stats.maxHealth });
      }
      state = { ...state, entities };
    }
    state = step(state, [], scenario.context).state;
    if (tick % every === 0 || tick === ticks - 1) {
      frames.push({
        tick,
        at: scenario.actors.map((actor) => {
          const entity = state.entities.get(actor.id);
          return {
            x: entity?.position.x ?? 0,
            y: entity?.position.y ?? 0,
            moving: (entity?.velocity.x ?? 0) !== 0 || (entity?.velocity.y ?? 0) !== 0,
          };
        }),
      });
    }
  }

  return { scenario, frames, last: state, elapsedMs: Date.now() - startedAt };
}

/** The entity for an actor at the end of a run, or null if it left the world. */
export function finalOf(trace: Trace, actor: Actor): ServerEntity | null {
  return trace.last.entities.get(actor.id) ?? null;
}
