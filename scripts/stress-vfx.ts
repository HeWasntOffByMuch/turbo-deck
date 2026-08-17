// The acceptance stress test (spec 122).
// `node --expose-gc --import tsx scripts/stress-vfx.ts`
//
// "50 simultaneous combat effects plus 200 ground decals holds target
// framerate." This measures it and reports the number rather than asserting one.
//
// What it measures is the *simulation*: the particle tick, the decal field's
// ageing, and the per-frame work that is not the GPU. That is the honest half to
// measure here -- there is no GPU in this container worth timing, and the draw
// cost is a handful of instanced batches whose count is reported separately by
// `preview-vfx-library.ts`. Where a number is CPU-only, it says so.
import { compileRegistry } from '../src/render/iso3d/vfx/compile.js';
import { EFFECTS } from '../src/render/iso3d/vfx/registry.js';
import { VfxSystem } from '../src/render/iso3d/vfx/system.js';
import { DecalField } from '../src/render/iso3d/vfx/decals.js';

const registry = compileRegistry(EFFECTS);

/**
 * The effects a real fight actually plays, rather than forty at once.
 *
 * `blood_hit_brush` rather than `hit_blood` since spec 158: this list is meant
 * to be what a fight costs, and `effectsForBlow` has played the painted hit off
 * every landed blow since then. Leaving the ribbon spatter here would have
 * measured a load the game no longer generates.
 */
const COMBAT = [
  'blood_hit_brush',
  'blood_hit_brush_heavy',
  'hit_metal_spark',
  'hit_physical',
  'hit_critical',
  'hit_block',
  'impact_physical',
  'slash_arc',
  'shockwave_ring',
];

interface Result {
  readonly label: string;
  readonly meanParticles: number;
  readonly peakParticles: number;
  readonly decals: number;
  readonly microsPerTick: number;
  readonly worstTick: number;
}

function run(effects: number, decals: number, ticks: number, intensity = 3): Result {
  const field = new DecalField();
  const system = new VfxSystem({
    registry,
    hooks: {
      // A real heightfield: collision samples it per colliding particle per tick.
      ground: (x, z) => Math.sin(x * 0.01) * 20 + Math.cos(z * 0.01) * 20,
      decal: (x, y, z, seed, fluid, size, dirX, dirZ) => {
        field.add({ x, y, z, size, rotation: Math.atan2(dirZ, dirX), nx: 0, ny: 1, nz: 0, seed, fluid });
      },
    },
    limits: { maxParticles: 3000, maxInstances: 128, pressureFloor: 0.25 },
  });
  system.setIntensity(intensity);
  system.setViewpoint(0, 40, 0);
  field.setViewpoint(0, 0);

  // Pre-load the ground so the decal count is the one being claimed.
  let seed = 991;
  const next = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) | 0);
  while (field.count < decals) {
    field.add({
      x: ((next() >>> 8) % 1200) - 600,
      y: 0,
      z: ((next() >>> 8) % 1200) - 600,
      size: 24 + ((next() >>> 8) % 30),
      rotation: ((next() >>> 8) % 628) / 100,
      nx: 0,
      ny: 1,
      nz: 0,
      seed: next(),
      fluid: 'blood',
    });
  }

  // Fifty effects going at once, spread over the arena the way a fight is.
  const play = (): void => {
    for (let i = 0; i < effects; i++) {
      const id = COMBAT[i % COMBAT.length] ?? 'hit_blood';
      const angle = (i / effects) * Math.PI * 2;
      system.play(id, {
        x: Math.cos(angle) * (80 + (i % 7) * 30),
        y: 30,
        z: Math.sin(angle) * (80 + (i % 5) * 30),
        rotation: angle,
        seed: 1000 + i * 37,
      });
    }
  };

  play();
  for (let i = 0; i < 60; i++) system.update(1);      // settle
  for (let i = 0; i < 300; i++) system.update(1);     // warm the JIT

  let worst = 0;
  let peak = 0;
  let carried = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < ticks; i++) {
    // Re-played every 20 ticks, so fifty effects are *sustained* rather than
    // measured once as they die away.
    if (i % 20 === 0) play();
    const tickStart = process.hrtime.bigint();
    system.update(1);
    field.update(1);
    const spent = Number(process.hrtime.bigint() - tickStart) / 1000;
    if (spent > worst) worst = spent;
    carried += system.stats.liveParticles;
    if (system.stats.liveParticles > peak) peak = system.stats.liveParticles;
  }
  const total = Number(process.hrtime.bigint() - start) / 1000 / ticks;

  return {
    // The decal count is what the field *settled at*, not what was pre-loaded:
    // the blood these effects throw adds to it, and labelling the run by the
    // pre-load would report a lighter test than the one that ran.
    label: `${effects} effects, ${decals} decals pre-loaded${intensity === 3 ? '' : ` @ intensity ${intensity}`}`,
    meanParticles: carried / ticks,
    peakParticles: peak,
    decals: field.count,
    microsPerTick: total,
    worstTick: worst,
  };
}

function row(result: Result): void {
  const budget = (result.microsPerTick / 16667) * 100;
  console.log(
    `  ${result.label.padEnd(42)} ` +
      `${result.meanParticles.toFixed(0).padStart(4)} mean / ${String(result.peakParticles).padStart(4)} peak particles  ` +
      `${String(result.decals).padStart(4)} decals held  ` +
      `${result.microsPerTick.toFixed(0).padStart(4)} us/tick  ` +
      `worst ${result.worstTick.toFixed(0).padStart(4)} us  ` +
      `${budget.toFixed(1).padStart(4)}% of a 60fps frame`,
  );
}

console.log('== the acceptance stress: 50 combat effects + 200 ground decals ==');
console.log('   (CPU simulation only -- particle tick plus decal ageing.)\n');
row(run(50, 200, 2000));
console.log('\n== for scale ==');
row(run(10, 50, 2000));
row(run(50, 512, 2000));
row(run(100, 512, 2000));
row(run(50, 200, 2000, 1));
console.log('\nA 60fps frame is 16,667 us. One tick is one 60Hz step.');
console.log(
  'Worth reading with `scripts/profile-vfx.ts` beside it: fifty *combat* effects\n' +
    'is only a few hundred live particles, because combat bursts are short-lived by\n' +
    'design. The harder number is a saturated field -- 2,000 particles of continuous\n' +
    'emission measured 697 us/tick, which is 4.2% of a frame. Fifty combat effects\n' +
    'is comfortably inside that, and this says so rather than claiming the easy case\n' +
    'as the hard one.',
);
