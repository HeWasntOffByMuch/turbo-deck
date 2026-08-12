import { describe, expect, it } from 'vitest';
import { compileRegistry } from './compile.js';
import { REGISTRY } from './registry.js';
import { VfxSystem, type VfxHooks } from './system.js';
import type { EffectDefinition, VfxLimits } from './types.js';

const FLAT_GROUND: VfxHooks = { ground: () => 0 };

function build(
  definitions: readonly EffectDefinition[] = [],
  limits?: Partial<VfxLimits>,
  hooks: VfxHooks = FLAT_GROUND,
): VfxSystem {
  const registry = definitions.length > 0 ? compileRegistry(definitions) : REGISTRY;
  return new VfxSystem({
    registry,
    hooks,
    limits: { maxParticles: 500, maxInstances: 16, pressureFloor: 0.25, ...limits },
  });
}

/** Every mutable particle field, as one comparable snapshot. */
function snapshot(system: VfxSystem): number[] {
  const pool = system.pool;
  const out: number[] = [pool.count];
  for (let i = 0; i < pool.count; i++) {
    out.push(
      pool.x[i] ?? 0, pool.y[i] ?? 0, pool.z[i] ?? 0,
      pool.vx[i] ?? 0, pool.vy[i] ?? 0, pool.vz[i] ?? 0,
      pool.age[i] ?? 0, pool.life[i] ?? 0,
      pool.size[i] ?? 0, pool.rot[i] ?? 0,
      pool.r[i] ?? 0, pool.g[i] ?? 0, pool.b[i] ?? 0, pool.a[i] ?? 0,
      pool.seed[i] ?? 0, pool.emitter[i] ?? 0, pool.bounces[i] ?? 0, pool.resting[i] ?? 0,
    );
  }
  return out;
}

// --- fixtures ----------------------------------------------------------------

const BURST: EffectDefinition = {
  id: 'burst',
  priority: 2,
  emitters: [
    {
      id: 'e',
      shape: { kind: 'sphere', radius: 5 },
      emission: { kind: 'burst', count: 10 },
      lifetimeTicks: [10, 10],
      speed: [50, 100],
      size: { keys: [[0, 4]] },
      alpha: { keys: [[0, 1], [1, 0]] },
      color: { stops: [[0, 'sparkHot']] },
      render: 'billboard',
      blend: 'additive',
    },
  ],
};

const STREAM: EffectDefinition = {
  id: 'stream',
  priority: 1,
  emitters: [
    {
      id: 'e',
      shape: { kind: 'cone', angle: 0.3, radius: 1 },
      emission: { kind: 'rate', perSecond: 60 },
      lifetimeTicks: [30, 30],
      speed: [40, 80],
      size: { keys: [[0, 3]] },
      alpha: { keys: [[0, 1]] },
      color: { stops: [[0, 'fireBody']] },
      render: 'billboard',
      blend: 'alpha',
    },
  ],
};

const FALLER = (overrides: Partial<EffectDefinition> = {}): EffectDefinition => ({
  id: 'faller',
  priority: 2,
  emitters: [
    {
      id: 'e',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 1 },
      lifetimeTicks: [600, 600],
      speed: [0, 0],
      gravity: -900,
      size: { keys: [[0, 2]] },
      alpha: { keys: [[0, 1]] },
      color: { stops: [[0, 'metalDust']] },
      render: 'billboard',
      blend: 'alpha',
      collision: { restitution: 0, friction: 0.5, maxBounces: 4 },
    },
  ],
  ...overrides,
});

// --- determinism -------------------------------------------------------------

describe('determinism', () => {
  it('reproduces the whole particle field from the same seed', () => {
    const a = build();
    const b = build();
    a.play('hit_metal_spark', { x: 10, y: 40, z: -5, seed: 1234 });
    b.play('hit_metal_spark', { x: 10, y: 40, z: -5, seed: 1234 });
    // Mid-flight, where the shower is still up and bounces have started, then
    // again once only the stragglers are left. Both, because a system that
    // agrees at one instant and not at another is not deterministic.
    a.update(12);
    b.update(12);
    expect(a.pool.count).toBeGreaterThan(5);
    expect(snapshot(a)).toEqual(snapshot(b));

    a.update(33);
    b.update(33);
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('produces a different field from a different seed', () => {
    const a = build();
    const b = build();
    a.play('hit_metal_spark', { x: 0, y: 40, z: 0, seed: 1 });
    b.play('hit_metal_spark', { x: 0, y: 40, z: 0, seed: 2 });
    a.update(10);
    b.update(10);
    expect(snapshot(a)).not.toEqual(snapshot(b));
  });

  it('advances identically in one big step and in many small ones', () => {
    // The property that makes the look independent of the frame rate.
    const a = build();
    const b = build();
    a.play('hit_metal_spark', { x: 0, y: 30, z: 0, seed: 99 });
    b.play('hit_metal_spark', { x: 0, y: 30, z: 0, seed: 99 });
    a.update(60);
    for (let i = 0; i < 60; i++) b.update(1);
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('gives a continuous emitter a different particle each tick', () => {
    // The bug this exists to catch: re-seeding a rate emitter from the instance
    // seed on every emission makes every particle it ever produces identical, so
    // a fountain fires one drop forever and looks like it is working.
    const system = build([STREAM]);
    system.play('stream', { x: 0, y: 0, z: 0, seed: 7 });
    system.update(10);
    expect(system.pool.count).toBeGreaterThanOrEqual(8);
    const speeds = new Set<string>();
    for (let i = 0; i < system.pool.count; i++) {
      speeds.add(`${(system.pool.vx[i] ?? 0).toFixed(4)}:${(system.pool.vz[i] ?? 0).toFixed(4)}`);
    }
    expect(speeds.size).toBeGreaterThan(1);
  });

  it('does not play two different effects in lockstep from one seed', () => {
    const other: EffectDefinition = { ...BURST, id: 'burst2' };
    const system = build([BURST, other]);
    system.play('burst', { x: 0, y: 0, z: 0, seed: 42 });
    system.play('burst2', { x: 0, y: 0, z: 0, seed: 42 });
    system.update(1);
    const first: number[] = [];
    const second: number[] = [];
    for (let i = 0; i < system.pool.count; i++) {
      (system.pool.instance[i] === 0 ? first : second).push(system.pool.vx[i] ?? 0);
    }
    expect(first.length).toBe(10);
    expect(second.length).toBe(10);
    expect(first).not.toEqual(second);
  });
});

// --- time --------------------------------------------------------------------

describe('time', () => {
  it('freezes exactly while paused', () => {
    const system = build([BURST]);
    system.play('burst', { x: 0, y: 0, z: 0, seed: 5 });
    system.update(3);
    const before = snapshot(system);
    system.setPaused(true);
    system.update(30);
    expect(snapshot(system)).toEqual(before);
    system.setPaused(false);
    system.update(1);
    expect(snapshot(system)).not.toEqual(before);
  });

  it('matches half speed over 2N ticks to full speed over N', () => {
    const fast = build([BURST]);
    const slow = build([BURST]);
    fast.play('burst', { x: 0, y: 0, z: 0, seed: 8 });
    slow.play('burst', { x: 0, y: 0, z: 0, seed: 8 });
    slow.setTimeScale(0.5);
    fast.update(9);
    slow.update(18);
    expect(snapshot(slow)).toEqual(snapshot(fast));
  });

  it('banks a fractional tick rather than dropping it', () => {
    const system = build([BURST]);
    system.setTimeScale(0.5);
    system.play('burst', { x: 0, y: 0, z: 0, seed: 3 });
    system.update(1);
    expect(system.pool.count).toBe(0);
    system.update(1);
    expect(system.pool.count).toBe(10);
  });

  it('does nothing at all at intensity 0', () => {
    const system = build([BURST]);
    system.setIntensity(0);
    expect(system.play('burst', { x: 0, y: 0, z: 0, seed: 1 })).toBe(0);
    system.update(10);
    expect(system.pool.count).toBe(0);
  });

  it('emits fewer particles at a lower intensity', () => {
    const full = build([BURST]);
    const low = build([BURST]);
    low.setIntensity(1);
    full.play('burst', { x: 0, y: 0, z: 0, seed: 1 });
    low.play('burst', { x: 0, y: 0, z: 0, seed: 1 });
    full.update(1);
    low.update(1);
    expect(low.pool.count).toBeLessThan(full.pool.count);
    expect(low.pool.count).toBeGreaterThan(0);
  });
});

// --- capacity and budget -----------------------------------------------------

describe('budget', () => {
  it('never exceeds capacity, however hard it is pushed', () => {
    const system = build([STREAM], { maxParticles: 40, maxInstances: 8 });
    for (let i = 0; i < 8; i++) system.play('stream', { x: i, y: 0, z: 0, seed: i });
    for (let i = 0; i < 200; i++) system.update(1);
    expect(system.pool.count).toBeLessThanOrEqual(40);
  });

  it('keeps the pool consistent across interleaved spawns and kills', () => {
    const system = build([BURST, STREAM], { maxParticles: 60, maxInstances: 8 });
    for (let round = 0; round < 40; round++) {
      if (round % 3 === 0) system.play('burst', { x: round, y: 0, z: 0, seed: round });
      if (round % 5 === 0) system.play('stream', { x: -round, y: 0, z: 0, seed: round });
      system.update(2);
      expect(system.pool.count).toBeGreaterThanOrEqual(0);
      expect(system.pool.count).toBeLessThanOrEqual(system.pool.capacity);
      expect(system.pool.free).toBe(system.pool.capacity - system.pool.count);
    }
  });

  it('refuses low priority before high, and never refuses priority 3', () => {
    // Long-lived so the pool actually fills and stays full while the thresholds
    // are probed, and one particle per burst so the fill is exact.
    const probe = (priority: 0 | 1 | 2 | 3): EffectDefinition => ({
      id: `p${priority}`,
      priority,
      emitters: [
        {
          id: 'e',
          shape: { kind: 'point' },
          // One per burst, so the pool fills to an exact count rather than
          // overshooting to zero free -- at which point even priority 3 is
          // refused, which is correct and is a different assertion.
          emission: { kind: 'burst', count: 1 },
          lifetimeTicks: [10000, 10000],
          speed: [0, 0],
          size: { keys: [[0, 1]] },
          alpha: { keys: [[0, 1]] },
          color: { stops: [[0, 'sparkHot']] },
          render: 'billboard',
          blend: 'additive',
        },
      ],
    });
    const system = build([probe(0), probe(1), probe(2), probe(3)], { maxParticles: 100, maxInstances: 128 });

    // pressureFloor is 0.25, so the free fraction each priority needs is
    // p0: 0.50   p1: 0.25   p2: 0.0875   p3: none at all.
    const fillTo = (particles: number): void => {
      while (system.pool.count < particles) {
        system.play('p3', { x: 0, y: 0, z: 0, seed: system.pool.count });
        system.update(1);
      }
    };

    fillTo(60); // 40% free: below p0's floor, above p1's.
    expect(system.play('p0', { x: 0, y: 0, z: 0, seed: 1 })).toBe(0);
    expect(system.play('p1', { x: 0, y: 0, z: 0, seed: 1 })).not.toBe(0);

    fillTo(80); // 20% free: below p1's floor, above p2's.
    expect(system.play('p1', { x: 0, y: 0, z: 0, seed: 2 })).toBe(0);
    expect(system.play('p2', { x: 0, y: 0, z: 0, seed: 2 })).not.toBe(0);

    fillTo(95); // 5% free: below p2's floor. Priority 3 still gets through.
    expect(system.play('p2', { x: 0, y: 0, z: 0, seed: 3 })).toBe(0);
    expect(system.play('p3', { x: 0, y: 0, z: 0, seed: 3 })).not.toBe(0);

    expect(system.stats.refusedBudget).toBe(3);

    // And with nothing left at all, even priority 3 is refused -- "never dropped
    // while capacity remains" is not "conjures capacity from nowhere".
    fillTo(100);
    expect(system.play('p3', { x: 0, y: 0, z: 0, seed: 4 })).toBe(0);
  });

  it('refuses an effect further away than its cull distance', () => {
    const near: EffectDefinition = { ...BURST, cullDistance: 100 };
    const system = build([near]);
    system.setViewpoint(0, 0, 0);
    expect(system.play('burst', { x: 20, y: 0, z: 0, seed: 1 })).not.toBe(0);
    expect(system.play('burst', { x: 500, y: 0, z: 0, seed: 1 })).toBe(0);
    expect(system.stats.refusedDistance).toBe(1);
  });

  it('counts an unknown id rather than throwing', () => {
    const system = build();
    expect(system.play('no_such_effect', { x: 0, y: 0, z: 0, seed: 1 })).toBe(0);
    expect(system.stats.refusedUnknown).toBe(1);
    expect(system.has('no_such_effect')).toBe(false);
    expect(system.has('hit_metal_spark')).toBe(true);
  });

  it('evicts a lower-priority instance to make room for a higher one', () => {
    const low: EffectDefinition = { ...STREAM, id: 'low', priority: 0 };
    const high: EffectDefinition = { ...STREAM, id: 'high', priority: 3 };
    const system = build([low, high], { maxInstances: 2, maxParticles: 400 });
    const a = system.play('low', { x: 0, y: 0, z: 0, seed: 1 });
    const b = system.play('low', { x: 0, y: 0, z: 0, seed: 2 });
    expect(system.isLive(a)).toBe(true);
    expect(system.isLive(b)).toBe(true);
    const c = system.play('high', { x: 0, y: 0, z: 0, seed: 3 });
    expect(c).not.toBe(0);
    expect(system.isLive(c)).toBe(true);
    expect([system.isLive(a), system.isLive(b)]).toContain(false);
  });

  it('lets orphaned particles finish their lives unchanged in size', () => {
    // Eviction cuts particles loose rather than killing them. They carry their
    // own scale, so they must not jump size on the frame their owner went away.
    const low: EffectDefinition = { ...BURST, id: 'low', priority: 0 };
    const high: EffectDefinition = { ...BURST, id: 'high', priority: 3 };
    const system = build([low, high], { maxInstances: 1, maxParticles: 400 });
    system.play('low', { x: 0, y: 0, z: 0, seed: 1, scale: 3 });
    system.update(1);
    const sizeBefore = system.pool.size[0] ?? 0;
    expect(sizeBefore).toBeCloseTo(12, 5);
    system.play('high', { x: 0, y: 0, z: 0, seed: 2 });
    system.update(1);
    expect(system.pool.size[0] ?? 0).toBeCloseTo(12, 5);
  });
});

// --- collision ---------------------------------------------------------------

describe('collision', () => {
  it('comes to rest on the ground and does not sink', () => {
    const system = build([FALLER()]);
    system.play('faller', { x: 0, y: 200, z: 0, seed: 1 });
    system.update(400);
    expect(system.pool.count).toBe(1);
    expect(system.pool.y[0] ?? -1).toBeCloseTo(0, 5);
    expect(system.pool.resting[0]).toBe(1);
  });

  it('fires a collide sub-effect once per bounce, never once per tick', () => {
    // A resting particle sits on the ground for hundreds of ticks. Without the
    // resting flag, gravity pushes it under every tick and it machine-guns a
    // sub-effect for the rest of its life.
    const collide: EffectDefinition = { ...BURST, id: 'ping', priority: 0 };
    const faller = FALLER();
    const withSub: EffectDefinition = {
      ...faller,
      emitters: [
        {
          ...(faller.emitters[0] as NonNullable<(typeof faller.emitters)[0]>),
          collision: { restitution: 0, friction: 0.5, maxBounces: 4, onCollide: 'ping' },
        },
      ],
    };
    const system = build([collide, withSub], { maxParticles: 2000, maxInstances: 64 });
    system.play('faller', { x: 0, y: 200, z: 0, seed: 1 });
    system.update(60);
    const afterLanding = system.pool.count;
    system.update(300);
    // One landing, one ping of ten particles, and then nothing more forever.
    expect(system.pool.count).toBeLessThanOrEqual(afterLanding);
    expect(system.pool.count).toBeLessThan(40);
  });

  it('honours maxBounces exactly', () => {
    const bouncy: EffectDefinition = {
      ...FALLER(),
      emitters: [
        {
          ...(FALLER().emitters[0] as NonNullable<(typeof BURST.emitters)[0]>),
          collision: { restitution: 0.9, friction: 0, maxBounces: 2 },
        },
      ],
    };
    const system = build([bouncy]);
    system.play('faller', { x: 0, y: 300, z: 0, seed: 1 });
    for (let i = 0; i < 600 && system.pool.count > 0; i++) {
      system.update(1);
      expect(system.pool.bounces[0] ?? 0).toBeLessThanOrEqual(3);
    }
    expect(system.pool.count).toBe(0);
  });

  it('follows the ground the hook reports, not a flat plane', () => {
    const hilly: VfxHooks = { ground: (x) => 50 + x * 0.1 };
    const system = build([FALLER()], undefined, hilly);
    system.play('faller', { x: 100, y: 400, z: 0, seed: 1 });
    system.update(400);
    expect(system.pool.y[0] ?? 0).toBeCloseTo(60, 4);
  });
});

// --- sub-emitters ------------------------------------------------------------

describe('sub-emitters', () => {
  it('terminates a definition that names itself', () => {
    const recursive: EffectDefinition = {
      id: 'loop',
      priority: 1,
      emitters: [
        {
          id: 'e',
          shape: { kind: 'point' },
          emission: { kind: 'burst', count: 2 },
          lifetimeTicks: [2, 2],
          speed: [0, 0],
          size: { keys: [[0, 1]] },
          alpha: { keys: [[0, 1]] },
          color: { stops: [[0, 'sparkHot']] },
          render: 'billboard',
          blend: 'additive',
          subEmitters: { onDeath: 'loop' },
        },
      ],
    };
    const system = build([recursive], { maxParticles: 2000, maxInstances: 64 });
    system.play('loop', { x: 0, y: 0, z: 0, seed: 1 });
    system.update(300);
    // Depth capped at 2, so it dies out instead of doubling forever.
    expect(system.pool.count).toBe(0);
  });

  it('reports a sub-effect id nothing provides instead of failing at import', () => {
    const broken: EffectDefinition = {
      ...BURST,
      emitters: [
        {
          ...(BURST.emitters[0] as NonNullable<(typeof BURST.emitters)[0]>),
          subEmitters: { onDeath: 'typo_here' },
        },
      ],
    };
    const registry = compileRegistry([broken]);
    expect(registry.danglingSubEffects).toEqual(['typo_here']);
  });

  it('has no dangling sub-effect ids in the shipped registry', () => {
    expect(REGISTRY.danglingSubEffects).toEqual([]);
  });
});

// --- attachment --------------------------------------------------------------

describe('attachment', () => {
  it('carries a parented effect along with its socket', () => {
    let socketX = 0;
    const hooks: VfxHooks = {
      ground: () => -1000,
      attach: (_entity, _socket, out, at) => {
        out[at] = socketX;
        out[at + 1] = 10;
        out[at + 2] = 0;
        return true;
      },
    };
    const parented: EffectDefinition = {
      ...STREAM,
      emitters: [{ ...(STREAM.emitters[0] as NonNullable<(typeof STREAM.emitters)[0]>), speed: [0, 0], worldSpace: false }],
    };
    const system = build([parented], undefined, hooks);
    system.play('stream', { x: 0, y: 0, z: 0, seed: 1, attach: { kind: 'socket', entityId: 7, socket: 'hand' } });
    system.update(3);
    const born = system.pool.x[0] ?? 0;
    socketX = 500;
    system.update(3);
    expect((system.pool.x[0] ?? 0) - born).toBeCloseTo(500, 3);
  });

  it('leaves a detached effect where it was born', () => {
    let socketX = 0;
    const hooks: VfxHooks = {
      ground: () => -1000,
      attach: (_entity, _socket, out, at) => {
        out[at] = socketX;
        out[at + 1] = 0;
        out[at + 2] = 0;
        return true;
      },
    };
    const system = build([BURST], undefined, hooks);
    system.play('burst', { x: 0, y: 0, z: 0, seed: 1, attach: { kind: 'detach', entityId: 7 } });
    system.update(1);
    socketX = 900;
    system.update(1);
    for (let i = 0; i < system.pool.count; i++) {
      expect(Math.abs(system.pool.x[i] ?? 0)).toBeLessThan(200);
    }
  });

  it('leaves an effect in place when its body stops being drawn', () => {
    let drawn = true;
    const hooks: VfxHooks = {
      ground: () => -1000,
      attach: (_entity, _socket, out, at) => {
        if (!drawn) return false;
        out[at] = 42;
        out[at + 1] = 0;
        out[at + 2] = 0;
        return true;
      },
    };
    const system = build([STREAM], undefined, hooks);
    system.play('stream', { x: 0, y: 0, z: 0, seed: 1, attach: { kind: 'entity', entityId: 3 } });
    system.update(2);
    drawn = false;
    expect(() => system.update(5)).not.toThrow();
    // Nothing teleported to the origin.
    for (let i = 0; i < system.pool.count; i++) {
      expect(system.pool.x[i] ?? 0).toBeGreaterThan(20);
    }
  });
});

// --- lifecycle ---------------------------------------------------------------

describe('lifecycle', () => {
  it('lets a soft stop finish the particles already in the air', () => {
    const system = build([STREAM]);
    const handle = system.play('stream', { x: 0, y: 0, z: 0, seed: 1 });
    system.update(10);
    const inAir = system.pool.count;
    expect(inAir).toBeGreaterThan(0);
    system.stop(handle);
    system.update(1);
    expect(system.pool.count).toBe(inAir);
    system.update(40);
    expect(system.pool.count).toBe(0);
  });

  it('clears the field on a hard stop', () => {
    const system = build([STREAM]);
    const handle = system.play('stream', { x: 0, y: 0, z: 0, seed: 1 });
    system.update(10);
    system.stop(handle, true);
    expect(system.pool.count).toBe(0);
    expect(system.isLive(handle)).toBe(false);
  });

  it('stops a stale handle from steering a recycled slot', () => {
    const system = build([BURST], { maxInstances: 1 });
    const first = system.play('burst', { x: 0, y: 0, z: 0, seed: 1 });
    system.update(20);
    expect(system.isLive(first)).toBe(false);
    const second = system.play('burst', { x: 0, y: 0, z: 0, seed: 2 });
    expect(second).not.toBe(first);
    system.stop(first, true);
    expect(system.isLive(second)).toBe(true);
  });

  it('retires a burst instance once its last particle is gone', () => {
    const system = build([BURST]);
    system.play('burst', { x: 0, y: 0, z: 0, seed: 1 });
    system.update(1);
    expect(system.stats.liveInstances).toBe(1);
    system.update(30);
    expect(system.stats.liveParticles).toBe(0);
    expect(system.stats.liveInstances).toBe(0);
  });

  it('honours a duration on a continuous effect', () => {
    const timed: EffectDefinition = { ...STREAM, durationTicks: 10 };
    const system = build([timed]);
    system.play('stream', { x: 0, y: 0, z: 0, seed: 1 });
    system.update(10);
    const atStop = system.pool.count;
    system.update(5);
    expect(system.pool.count).toBeLessThanOrEqual(atStop);
    system.update(60);
    expect(system.pool.count).toBe(0);
  });
});

// --- hooks -------------------------------------------------------------------

describe('hooks', () => {
  it('fires the sound sink without needing an audio system behind it', () => {
    const cues: string[] = [];
    const system = build(undefined, undefined, { ground: () => 0, sound: (cue) => cues.push(cue) });
    system.play('hit_metal_spark', { x: 0, y: 0, z: 0, seed: 1 });
    system.update(2);
    expect(cues).toContain('impact_metal');
  });

  it('runs with no optional hooks at all', () => {
    const system = build(undefined, undefined, { ground: () => 0 });
    expect(() => {
      system.play('hit_metal_spark', { x: 0, y: 50, z: 0, seed: 1, attach: { kind: 'socket', entityId: 1, socket: 'hand' } });
      system.update(60);
    }).not.toThrow();
  });

  it('collects at most one light per emitter rather than one per particle', () => {
    const system = build();
    system.play('hit_metal_spark', { x: 0, y: 50, z: 0, seed: 1 });
    system.update(2);
    const count = system.collectLights();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(2);
  });
});

// --- tint --------------------------------------------------------------------

describe('tint', () => {
  it('recolours an effect without dimming it', () => {
    const plain = build([BURST]);
    const tinted = build([BURST]);
    plain.play('burst', { x: 0, y: 0, z: 0, seed: 1 });
    tinted.play('burst', { x: 0, y: 0, z: 0, seed: 1, tint: 'icePale' });
    plain.update(1);
    tinted.update(1);

    const luma = (s: VfxSystem, i: number): number =>
      (s.pool.r[i] ?? 0) * 0.2126 + (s.pool.g[i] ?? 0) * 0.7152 + (s.pool.b[i] ?? 0) * 0.0722;

    // Same brightness, different hue -- the property that makes one fire
    // definition produce blue fire from a parameter.
    expect(luma(tinted, 0)).toBeCloseTo(luma(plain, 0), 3);
    expect(tinted.pool.b[0] ?? 0).toBeGreaterThan(plain.pool.b[0] ?? 0);
  });
});
