/**
 * What the particle sim actually costs, and what it actually allocates
 * (spec 118).
 *
 *     node --expose-gc --import tsx scripts/profile-vfx.ts
 *
 * `alloc.test.ts` asserts the shape of the answer -- that heap growth does not
 * scale with particle count -- because that is the part a CI run can be trusted
 * to judge. This reports the numbers, which is the part a person needs: how many
 * microseconds a tick costs at a given count, and which emitter features are
 * expensive enough to spend deliberately.
 *
 * Run it with `--expose-gc` and it collects before each measurement window, so
 * the heap figure is real rather than drift. Without it the timings are still
 * good and the byte counts are an upper bound.
 *
 * The counts here bracket the budget in `docs/vfx-plan.md`: 2,000 particles soft
 * cap, 3,000 hard. The frame is at most 760x300, so anything above that is
 * academic -- it is being reported to show the headroom, not to suggest using it.
 */

import { compileRegistry } from '../src/render/iso3d/vfx/compile.js';
import { STRESS_EFFECTS } from '../src/render/iso3d/vfx/stress.js';
import { VfxSystem } from '../src/render/iso3d/vfx/system.js';
import type { EffectDefinition, Emitter } from '../src/render/iso3d/vfx/types.js';

const gc = (globalThis as { gc?: () => void }).gc;

interface Result {
  readonly particles: number;
  readonly microsPerTick: number;
  readonly bytesPerTick: number;
}

function run(definitions: readonly EffectDefinition[], playId: string, capacity: number, ticks: number): Result {
  const system = new VfxSystem({
    registry: compileRegistry(definitions),
    // A real heightfield rather than a flat plane: collision samples it once per
    // colliding particle per tick, so a free `() => 0` would flatter the result.
    hooks: { ground: (x, z) => Math.sin(x * 0.01) * 20 + Math.cos(z * 0.01) * 20 },
    limits: { maxParticles: capacity, maxInstances: 64, pressureFloor: 0.25 },
    ribbonCapacity: 128,
  });

  const emitters = Math.max(2, Math.round(capacity / 160));
  for (let i = 0; i < emitters; i++) system.play(playId, { x: i * 30, y: 120, z: 0, seed: i });
  system.update(400);
  for (let i = 0; i < 600; i++) system.update(1);

  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = process.hrtime.bigint();
  for (let i = 0; i < ticks; i++) system.update(1);
  const end = process.hrtime.bigint();
  const heapAfter = process.memoryUsage().heapUsed;

  return {
    particles: system.stats.liveParticles,
    microsPerTick: Number(end - start) / 1000 / ticks,
    bytesPerTick: Math.max(0, heapAfter - heapBefore) / ticks,
  };
}

function row(label: string, result: Result): void {
  const perParticle = result.particles > 0 ? (result.microsPerTick * 1000) / result.particles : 0;
  const bytesPerParticle = result.particles > 0 ? result.bytesPerTick / result.particles : 0;
  console.log(
    `${label.padEnd(26)} ` +
      `${String(result.particles).padStart(5)} live  ` +
      `${result.microsPerTick.toFixed(0).padStart(5)} us/tick  ` +
      `${perParticle.toFixed(0).padStart(4)} ns/particle  ` +
      `${result.bytesPerTick.toFixed(0).padStart(6)} B/tick  ` +
      `${bytesPerParticle.toFixed(3)} B/particle`,
  );
}

/** The base emitter each feature is added to, one at a time. */
const BASE: Emitter = {
  id: 'e',
  shape: { kind: 'cone', angle: 1, radius: 4 },
  emission: { kind: 'rate', perSecond: 240 },
  lifetimeTicks: [30, 70],
  speed: [120, 300],
  spreadRadians: 0.6,
  gravity: -900,
  drag: 1.2,
  size: { keys: [[0, 3], [1, 1]] },
  alpha: { keys: [[0, 1], [1, 0]] },
  color: { stops: [[0, 'fireCore'], [1, 'smokeDark']] },
  render: 'billboard',
  blend: 'alpha',
};

const PING: EffectDefinition = {
  id: 'ping',
  priority: 0,
  emitters: [
    {
      id: 'p',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 2 },
      lifetimeTicks: [4, 8],
      speed: [10, 40],
      gravity: -400,
      size: { keys: [[0, 2]] },
      alpha: { keys: [[0, 1]] },
      color: { stops: [[0, 'sparkWarm']] },
      render: 'billboard',
      blend: 'additive',
    },
  ],
};

function feature(emitter: Emitter, extra: readonly EffectDefinition[] = []): readonly EffectDefinition[] {
  return [...extra, { id: 'x', priority: 2, emitters: [emitter] }];
}

function main(): void {
  if (!gc) {
    console.log('note: run with --expose-gc for real heap figures; byte counts below are an upper bound.\n');
  }

  console.log('== everything at once, by particle count ==');
  for (const capacity of [250, 500, 1000, 2000, 3000]) {
    row(`cap ${capacity}`, run(STRESS_EFFECTS, 'kitchen_sink', capacity, 3000));
  }

  console.log('\n== cost of one emitter feature at a time, ~2000 particles ==');
  row('plain', run(feature(BASE), 'x', 2000, 3000));
  row('+ turbulence', run(feature({ ...BASE, turbulence: { amplitude: 260, frequency: 0.02 } }), 'x', 2000, 3000));
  row('+ collision', run(feature({ ...BASE, collision: { restitution: 0.4, friction: 0.3, maxBounces: 3 } }), 'x', 2000, 3000));
  row(
    '+ collision + sub-effect',
    run(feature({ ...BASE, collision: { restitution: 0.4, friction: 0.3, maxBounces: 3, onCollide: 'ping' } }, [PING]), 'x', 2000, 3000),
  );
  row('+ ribbon', run(feature({ ...BASE, render: 'ribbon', ribbonSpacing: 4 }), 'x', 2000, 3000));
  row('+ sprite flipbook', run(feature({ ...BASE, sprite: { sheet: 'puff', frames: 8, fps: 12, randomStart: true } }), 'x', 2000, 3000));
  row('+ rotation curve', run(feature({ ...BASE, rotation: { keys: [[0, 0], [1, 3]] }, angularVelocity: [-4, 4] }), 'x', 2000, 3000));

  console.log('\nOne tick is one 60Hz step, so us/tick is the per-frame cost at 60fps.');
}

main();
