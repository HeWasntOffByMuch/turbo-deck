/**
 * The zero-allocation claim, as a test (spec 118).
 *
 * ## Why this measures a ratio and not a number
 *
 * `heapUsed` is a coarse instrument. Without `--expose-gc` nothing is collected
 * on demand, V8 does its own bookkeeping inside the window being measured, and
 * the absolute figure drifts between runs and between machines. A test that
 * asserts "under N bytes a tick" is therefore either so tight it is flaky or so
 * loose it proves nothing -- the first draft of this file asserted 48 and
 * measured 427, and neither number meant anything.
 *
 * So what is asserted is the figure *per particle*, at a high particle count
 * where the fixed bookkeeping is amortised away, taken as the minimum of several
 * runs. Allocation inside the particle loop scales with the particle count by
 * definition; bookkeeping does not.
 *
 * That is the regression this exists to catch. The obvious way to write this
 * system -- a particle object, an `{x, y, z}` returned from the shape sampler, a
 * fresh array per burst -- fails it by a factor of hundreds. Measured as this
 * landed: about 0.4 bytes per particle per tick, against at least 32 for one
 * small object each.
 *
 * `scripts/profile-vfx.ts` is the real capture: `--expose-gc`, a settled
 * baseline, and it reports numbers rather than asserting them.
 */

import { describe, expect, it } from 'vitest';
import { compileRegistry } from './compile.js';
import { VfxSystem } from './system.js';
import { STRESS_EFFECTS } from './stress.js';

/** Saturate a pool of `capacity`, settle it, then report heap growth per tick. */
function measure(capacity: number, ticks: number): { bytes: number; particles: number } {
  const system = new VfxSystem({
    registry: compileRegistry(STRESS_EFFECTS),
    hooks: { ground: (x, z) => Math.sin(x * 0.01) * 20 + Math.cos(z * 0.01) * 20 },
    limits: { maxParticles: capacity, maxInstances: 64, pressureFloor: 0.25 },
    ribbonCapacity: 128,
  });

  const emitters = Math.max(2, Math.round(capacity / 160));
  for (let i = 0; i < emitters; i++) system.play('kitchen_sink', { x: i * 30, y: 120, z: 0, seed: i });
  system.update(400);

  // Warm-up, so JIT compilation and any lazily-grown internals are not counted
  // as the loop's own allocation.
  for (let i = 0; i < 600; i++) system.update(1);

  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < ticks; i++) system.update(1);
  const after = process.memoryUsage().heapUsed;

  return { bytes: Math.max(0, after - before) / ticks, particles: system.stats.liveParticles };
}

describe('the update loop does not allocate per particle', () => {
  it('holds heap growth per particle far below the size of one object', { timeout: 60_000 }, () => {
    // Min of three, because the quantity being measured is a floor with noise on
    // top: a GC that happens to land inside a window inflates that window and
    // nothing deflates one. The median would work too; the minimum is the
    // honest estimate of the floor, which is what the claim is about.
    let bytes = Number.POSITIVE_INFINITY;
    let particles = 0;
    for (let run = 0; run < 3; run++) {
      const result = measure(2000, 2500);
      bytes = Math.min(bytes, result.bytes);
      particles = result.particles;
    }
    expect(particles).toBeGreaterThan(1500);

    const perParticle = bytes / particles;

    // One small object per particle per tick is at least 32 bytes each -- and
    // that is what the obvious implementation of this system does, with a
    // particle object, an `{x, y, z}` back from the shape sampler, or a fresh
    // array per burst. The threshold is a quarter of that, and the measured
    // figure as this landed was around 0.4, so there is room for the number to
    // drift without the test becoming a tripwire.
    expect(perParticle).toBeLessThan(8);
  });

  it('never reallocates the pool backing arrays under sustained pressure', { timeout: 30_000 }, () => {
    // The other half of the same promise: capacity is fixed, so the arrays in
    // use are the ones the constructor made and never a reallocated copy.
    const system = new VfxSystem({
      registry: compileRegistry(STRESS_EFFECTS),
      hooks: { ground: () => 0 },
      limits: { maxParticles: 256, maxInstances: 16, pressureFloor: 0.25 },
    });
    const buffer = system.pool.x.buffer;
    const length = system.pool.x.length;

    for (let i = 0; i < 16; i++) system.play('kitchen_sink', { x: i, y: 200, z: 0, seed: i });
    system.update(1500);

    expect(system.pool.x.buffer).toBe(buffer);
    expect(system.pool.x.length).toBe(length);
    expect(system.pool.count).toBeLessThanOrEqual(256);
  });
});
