// Dev-only: plot the path a shot actually flies (spec 089), so the two claims
// that spec makes can be looked at rather than taken on trust.
// Not part of the app. `npx tsx scripts/preview-arcs.ts`
//
// Every curve here is flown through the **real `step`** -- a real cast, a real
// release, the real projectile pass -- and the heights plotted are the `z` the
// server put on the entity. Nothing is re-derived for the picture, so a curve
// that is wrong here is wrong in the game.
//
// Top: one weapon at a spread of distances, against its own maximum range. The
// claim is that only the farthest shot leaves at 45 degrees and the near ones
// are nearly flat.
// Bottom: the same shot, at the same distance, over flat ground and over a
// ridge-and-trench. The claim is that the two curves are the *same curve* --
// the ground under a shot does not steer it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_WORLD } from '../src/sim/collision.js';
import { DEFAULT_LIVE_CONFIG } from '../src/server/config.js';
import { abilityById } from '../src/server/data/abilities.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { launchAngle } from '../src/server/sim/ballistics.js';
import { EntityKindValue, type ServerInput, type ServerWorldState } from '../src/server/sim/types.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../src/server/sim/world.js';
import { EMPTY_EQUIPMENT, emptyInventory, type PersistedPlayer } from '../src/server/state/types.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { FLAT_TERRAIN, type TerrainSampler } from '../src/server/world/terrain.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';

const WIDTH = 900;
const PANEL = 300;
const GAP = 10;
const CHUNK = 100;
const ORIGIN = { x: 600, y: 450 };

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
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

function activeAround(...points: readonly { x: number; y: number }[]): Set<string> {
  const keys = new Set<string>();
  for (const point of points) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        keys.add(chunkKeyOf(point.x + dx * CHUNK, point.y + dy * CHUNK, CHUNK));
      }
    }
  }
  return keys;
}

interface Sample {
  /** Ground distance from the launch point. */
  readonly along: number;
  readonly z: number;
}

/** One real flight: cast at `distance`, over `terrain`, sampled every tick. */
function fly(abilityId: string, distance: number, terrain: TerrainSampler): Sample[] {
  const ability = abilityById(abilityId);
  if (!ability) throw new Error(`no ${abilityId}`);

  let state: ServerWorldState = createWorldState(7);
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: ORIGIN.x, y: ORIGIN.y, z: terrain.heightAt(ORIGIN.x, ORIGIN.y) },
    stats: STATS,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = spawned.state;

  const aim = { x: ORIGIN.x + distance, y: ORIGIN.y };
  const ctx: StepContext = {
    world: DEFAULT_WORLD,
    terrain,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: activeAround(ORIGIN, aim, { x: ORIGIN.x + distance / 2, y: ORIGIN.y }),
    chunkSize: CHUNK,
    spawnPoints: [],
  };

  const cast: ServerInput = {
    entityId: spawned.entity.id,
    seq: 1,
    moveX: 0,
    moveY: 0,
    facing: 0,
    buttons: 0,
    predictedX: ORIGIN.x,
    predictedY: ORIGIN.y,
    hasPrediction: false,
    seqSpan: 1,
    castAbilityId: abilityId,
    castTargetX: aim.x,
    castTargetY: aim.y,
    castTargetEntityId: 0,
    cancelCast: false,
  };

  const out: Sample[] = [];
  let current = state;
  for (let tick = 0; tick < 900; tick++) {
    current = step(current, tick === 0 ? [cast] : [], ctx).state;
    let live = false;
    for (const entity of current.entities.values()) {
      if (!entity.projectile) continue;
      live = true;
      out.push({ along: entity.position.x - ORIGIN.x, z: entity.position.z });
    }
    if (!live && out.length > 0) break;
  }
  return out;
}

// --- drawing ---------------------------------------------------------------

const BG: readonly [number, number, number] = [30, 31, 36];
const PANEL_BG: readonly [number, number, number] = [46, 48, 56];
const GROUND: readonly [number, number, number] = [96, 104, 88];
const CURVES: readonly (readonly [number, number, number])[] = [
  [120, 200, 255],
  [130, 235, 190],
  [245, 220, 120],
  [250, 160, 120],
  [235, 120, 190],
];

const height = PANEL * 2 + GAP * 3;
const png = new PNG({ width: WIDTH, height });
function put(x: number, y: number, rgb: readonly [number, number, number]): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= height) return;
  const at = (Math.round(y) * WIDTH + Math.round(x)) * 4;
  png.data[at] = rgb[0];
  png.data[at + 1] = rgb[1];
  png.data[at + 2] = rgb[2];
  png.data[at + 3] = 255;
}
function fill(x0: number, y0: number, w: number, h: number, rgb: readonly [number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, rgb);
}
function dot(x: number, y: number, rgb: readonly [number, number, number], r = 1): void {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) put(x + dx, y + dy, rgb);
}

for (let i = 0; i < WIDTH * height; i++) {
  png.data[i * 4] = BG[0];
  png.data[i * 4 + 1] = BG[1];
  png.data[i * 4 + 2] = BG[2];
  png.data[i * 4 + 3] = 255;
}

const SHOT = 'ranged.shot';
const ability = abilityById(SHOT);
if (!ability) throw new Error('no ranged.shot');

/** One panel: a shared world-unit scale, x to the right and z up. */
function panel(
  top: number,
  spanX: number,
  spanZ: number,
  draw: (toPixel: (along: number, z: number) => { x: number; y: number }) => void,
): void {
  fill(GAP, top, WIDTH - GAP * 2, PANEL, PANEL_BG);
  const left = GAP + 30;
  const right = WIDTH - GAP - 20;
  const base = top + PANEL - 40;
  const scaleX = (right - left) / spanX;
  const scaleZ = (base - (top + 20)) / spanZ;
  const toPixel = (along: number, z: number): { x: number; y: number } => ({
    x: left + along * scaleX,
    y: base - z * scaleZ,
  });
  // The launch point's ground line, for scale.
  for (let x = left; x < right; x++) put(x, base, GROUND);
  draw(toPixel);
}

// Row 0: the same weapon at a spread of distances.
const FRACTIONS = [0.15, 0.35, 0.55, 0.8, 1];
panel(GAP, ability.range, ability.range / 4 + 40, (toPixel) => {
  FRACTIONS.forEach((fraction, i) => {
    const distance = ability.range * fraction;
    const colour = CURVES[i % CURVES.length] as readonly [number, number, number];
    for (const sample of fly(SHOT, distance, FLAT_TERRAIN)) {
      const at = toPixel(sample.along, sample.z);
      dot(at.x, at.y, colour);
    }
  });
});

// Row 1: one distance, two terrains, drawn on top of each other. The broken one
// is drawn second and thicker; if the ground steered the shot, it would show.
const BROKEN: TerrainSampler = {
  heightAt: (x) => (x > ORIGIN.x + 60 && x < ORIGIN.x + ability.range - 60
    ? Math.sin((x - ORIGIN.x - 60) / 30) * 150
    : 0),
};
panel(GAP * 2 + PANEL, ability.range, ability.range / 4 + 40, (toPixel) => {
  // The terrain profile itself, so what the shot is ignoring is visible.
  for (let along = 0; along <= ability.range; along += 1) {
    const at = toPixel(along, BROKEN.heightAt(ORIGIN.x + along, ORIGIN.y));
    put(at.x, at.y, GROUND);
  }
  for (const sample of fly(SHOT, ability.range, FLAT_TERRAIN)) {
    const at = toPixel(sample.along, sample.z);
    dot(at.x, at.y, CURVES[0] as readonly [number, number, number], 2);
  }
  for (const sample of fly(SHOT, ability.range, BROKEN)) {
    const at = toPixel(sample.along, sample.z);
    dot(at.x, at.y, CURVES[2] as readonly [number, number, number]);
  }
});

mkdirSync('.claude/screenshots', { recursive: true });
writeFileSync('.claude/screenshots/arcs.png', PNG.sync.write(png));
console.log(`.claude/screenshots/arcs.png  ${WIDTH}x${height}`);
console.log(`top: ${SHOT} at ${FRACTIONS.map((f) => `${Math.round(f * 100)}%`).join(', ')} of its ${ability.range} range`);
for (const fraction of FRACTIONS) {
  const distance = ability.range * fraction;
  const angle = (launchAngle(distance, ability.range, ability.projectile?.arc ?? 0) * 180) / Math.PI;
  console.log(`  ${String(Math.round(distance)).padStart(4)}u -> ${angle.toFixed(1)}deg`);
}
console.log('bottom: the same shot over flat ground (thick) and over a ridge (thin), overlaid');
