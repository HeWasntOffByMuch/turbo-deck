/**
 * One test over the whole table (spec 121).
 *
 * The point of writing it this way is that a *new* effect is checked by tests
 * that already exist. An effect added next month gets every assertion below for
 * free, which is the only way a library of forty entries stays honest -- nobody
 * writes six tests per effect, so if the checks are per-effect they simply do
 * not get written.
 */

import { describe, expect, it } from 'vitest';
import { EFFECTS, REGISTRY } from './registry.js';
import { LIBRARY, aura, fire, puff } from './library.js';
import { compileRegistry } from './compile.js';
import { sampleCurve, compileCurve, sampleGradient, compileGradient } from './curve.js';
import { VfxSystem } from './system.js';
import { DAMAGE_EFFECTS, DAMAGE_DEBRIS } from '../world/vfx-wire.js';
import { spriteSheet, sheetFrames } from './textures.js';

const ids = new Set(EFFECTS.map((effect) => effect.id));

describe('the registry as a whole', () => {
  it('holds a real library rather than a handful of samples', () => {
    expect(EFFECTS.length).toBeGreaterThan(35);
  });

  it('has no duplicate ids', () => {
    // Two entries with one id means the second silently never plays.
    expect(ids.size).toBe(EFFECTS.length);
  });

  it('gives every effect at least one emitter', () => {
    for (const effect of EFFECTS) {
      expect(effect.emitters.length, effect.id).toBeGreaterThan(0);
    }
  });

  it('names no sub-effect that does not exist', () => {
    expect(REGISTRY.danglingSubEffects).toEqual([]);
  });

  it('gives every emitter a positive lifetime and a size that is ever non-zero', () => {
    for (const effect of EFFECTS) {
      for (const emitter of effect.emitters) {
        expect(emitter.lifetimeTicks[0], `${effect.id}/${emitter.id}`).toBeGreaterThan(0);
        expect(emitter.lifetimeTicks[1], `${effect.id}/${emitter.id}`).toBeGreaterThanOrEqual(emitter.lifetimeTicks[0]);
        const peak = Math.max(...emitter.size.keys.map(([, value]) => value));
        expect(peak, `${effect.id}/${emitter.id} is never visible`).toBeGreaterThan(0);
      }
    }
  });

  it('makes every emitter either visible or a carrier that places something', () => {
    // An invisible emitter is usually a mistake and occasionally the point:
    // `death_blood/pool` is a single transparent particle whose whole job is to
    // fall to the ground and leave the pool. So the rule is not "must be
    // visible" -- it is "must be visible OR must exist to place a decal", which
    // still fails an emitter that went transparent by accident.
    for (const effect of EFFECTS) {
      for (const emitter of effect.emitters) {
        const peak = Math.max(...emitter.alpha.keys.map(([, value]) => value));
        if (peak > 0) continue;
        expect(
          emitter.collision?.decal,
          `${effect.id}/${emitter.id} is fully transparent and places nothing`,
        ).toBeDefined();
      }
    }
  });

  it('names only sprite sheets that exist and declares their frame counts correctly', () => {
    // A typo'd sheet name silently falls back to the solid square, which looks
    // like an effect that was authored badly rather than one that is misspelt.
    for (const effect of EFFECTS) {
      for (const emitter of effect.emitters) {
        if (!emitter.sprite) continue;
        expect(spriteSheet(emitter.sprite.sheet), `${effect.id}/${emitter.id}`).toBeDefined();
        expect(emitter.sprite.frames, `${effect.id}/${emitter.id} frame count`).toBe(sheetFrames(emitter.sprite.sheet));
      }
    }
  });

  it('makes information priority 3 and decoration priority 0 or 1', () => {
    // A telegraph nobody can see is a fight nobody can play, so it must never be
    // the thing dropped when the budget is tight.
    const byId = new Map(EFFECTS.map((effect) => [effect.id, effect]));
    expect(byId.get('aura_telegraph')?.priority).toBe(3);
    expect(byId.get('aura_channel')?.priority).toBe(3);
    expect(byId.get('hit_critical')?.priority).toBe(3);
    expect(byId.get('puff_footstep')?.priority).toBeLessThanOrEqual(1);
  });

  it('compiles into few enough draw calls to be worth batching', () => {
    // The whole library, batched by blend mode and sheet. If this grows without
    // bound the batching has stopped meaning anything.
    expect(REGISTRY.batches.length).toBeLessThanOrEqual(12);
  });
});

describe('the damage-type tables', () => {
  it('names only effects the registry holds', () => {
    for (const [type, id] of Object.entries(DAMAGE_EFFECTS)) {
      expect(ids.has(id), `${type} -> ${id}`).toBe(true);
    }
    for (const [type, id] of Object.entries(DAMAGE_DEBRIS)) {
      if (id === null) continue;
      expect(ids.has(id), `${type} debris -> ${id}`).toBe(true);
    }
  });

  it('gives every damage type its own flash', () => {
    expect(new Set(Object.values(DAMAGE_EFFECTS)).size).toBe(Object.keys(DAMAGE_EFFECTS).length);
  });
});

describe('the fire family', () => {
  const byId = new Map(LIBRARY.map((effect) => [effect.id, effect]));

  it('is layered rather than one emitter', () => {
    // The thing that reads as burning is the relationship between the layers.
    const campfire = byId.get('campfire');
    expect(campfire?.emitters.map((emitter) => emitter.id)).toEqual(['flame', 'embers', 'shimmer', 'smoke', 'glow']);
  });

  it('drops the layers a variant does not want', () => {
    expect(byId.get('torch')?.emitters.some((emitter) => emitter.id === 'smoke')).toBe(false);
    expect(byId.get('fire_burning_unit')?.emitters.some((emitter) => emitter.id === 'glow')).toBe(false);
  });

  it('parents a burning unit to the body rather than the world', () => {
    for (const emitter of byId.get('fire_burning_unit')?.emitters ?? []) {
      expect(emitter.worldSpace, emitter.id).toBe(false);
    }
  });

  it('leaves a standing fire in the world so it does not ride the camera', () => {
    for (const emitter of byId.get('campfire')?.emitters ?? []) {
      expect(emitter.worldSpace, emitter.id).toBe(true);
    }
  });

  it('scales every layer from one height', () => {
    const small = fire({ id: 'a', height: 10 });
    const large = fire({ id: 'b', height: 40 });
    const peak = (effect: typeof small, id: string): number => {
      const emitter = effect.emitters.find((candidate) => candidate.id === id);
      return Math.max(...(emitter?.size.keys.map(([, value]) => value) ?? [0]));
    };
    expect(peak(large, 'flame') / peak(small, 'flame')).toBeCloseTo(4, 5);
    expect(peak(large, 'smoke') / peak(small, 'smoke')).toBeCloseTo(4, 5);
  });

  it('burns until it is stopped unless it was given a duration', () => {
    expect(byId.get('campfire')?.durationTicks).toBe(0);
    expect(byId.get('fire_ignite')?.durationTicks).toBeGreaterThan(0);
  });
});

describe('tint', () => {
  it('changes hue without changing brightness', () => {
    // The property that makes normal, blue and cursed fire one definition: a
    // tint that also dimmed would need three separate sets of alpha curves.
    const registry = compileRegistry([fire({ id: 'flame_test', height: 20 })]);
    const luma = (system: VfxSystem, index: number): number =>
      (system.pool.r[index] ?? 0) * 0.2126 + (system.pool.g[index] ?? 0) * 0.7152 + (system.pool.b[index] ?? 0) * 0.0722;

    const build = (): VfxSystem =>
      new VfxSystem({ registry, hooks: { ground: () => -1000 }, limits: { maxParticles: 400, maxInstances: 8, pressureFloor: 0.25 } });

    const plain = build();
    const blue = build();
    plain.play('flame_test', { x: 0, y: 0, z: 0, seed: 5 });
    blue.play('flame_test', { x: 0, y: 0, z: 0, seed: 5, tint: 'icePale' });
    plain.update(6);
    blue.update(6);

    expect(plain.pool.count).toBeGreaterThan(0);
    expect(blue.pool.count).toBe(plain.pool.count);
    for (let i = 0; i < plain.pool.count; i++) {
      expect(luma(blue, i)).toBeCloseTo(luma(plain, i), 3);
    }
    // ...and it really is bluer.
    expect(blue.pool.b[0] ?? 0).toBeGreaterThan(plain.pool.b[0] ?? 0);
  });
});

describe('the puff family', () => {
  it('drives every soft volume from one definition', () => {
    const soft = LIBRARY.filter((effect) => effect.id.startsWith('puff_') || effect.id.startsWith('cloud_') || effect.id.startsWith('smoke_'));
    expect(soft.length).toBeGreaterThan(7);
    for (const effect of soft) {
      expect(effect.emitters, effect.id).toHaveLength(1);
      expect(effect.emitters[0]?.id, effect.id).toBe('puff');
    }
  });

  it('gives a lingering cloud a real area and a real end', () => {
    // Otherwise it reads as a fountain somebody left running rather than as an
    // ability's zone.
    const cloud = LIBRARY.find((effect) => effect.id === 'cloud_poison');
    expect(cloud?.durationTicks).toBeGreaterThan(0);
    const shape = cloud?.emitters[0]?.shape;
    expect(shape?.kind).toBe('circle');
    expect(shape?.kind === 'circle' ? shape.radius : 0).toBeGreaterThan(40);
    expect(cloud?.emitters[0]?.emission.kind).toBe('rate');
  });

  it('makes a one-shot puff a burst rather than a rate', () => {
    const footstep = LIBRARY.find((effect) => effect.id === 'puff_footstep');
    expect(footstep?.emitters[0]?.emission.kind).toBe('burst');
    expect(footstep?.durationTicks).toBe(0);
  });

  it('tints a footfall by what is underfoot', () => {
    const colourOf = (id: string): number => {
      const effect = LIBRARY.find((candidate) => candidate.id === id);
      const flat = compileGradient(effect?.emitters[0]?.color ?? { stops: [] });
      const out = new Float32Array(3);
      sampleGradient(flat, 0, out, 0);
      return (out[0] ?? 0) + (out[1] ?? 0) * 1000 + (out[2] ?? 0) * 1e6;
    };
    const tones = new Set([colourOf('puff_footstep'), colourOf('puff_footstep_sand'), colourOf('puff_footstep_snow'), colourOf('puff_splash')]);
    expect(tones.size).toBe(4);
  });

  it('rises unless it was told to hug the ground', () => {
    const groundHugging = LIBRARY.find((effect) => effect.id === 'cloud_poison')?.emitters[0];
    const rising = LIBRARY.find((effect) => effect.id === 'puff_teleport')?.emitters[0];
    expect(groundHugging?.render).toBe('ground-quad');
    expect(rising?.render).toBe('axis-billboard');
    expect(rising?.acceleration?.y ?? 0).toBeGreaterThan(0);
  });
});

describe('the aura family', () => {
  it('never expires on its own', () => {
    // An aura is state. It is stopped when the state ends, and a duration would
    // make a poison that outlasts its own ring.
    for (const effect of LIBRARY) {
      if (!effect.id.startsWith('aura_')) continue;
      expect(effect.durationTicks ?? 0, effect.id).toBe(0);
    }
  });

  it('sits on the ground rather than around the body', () => {
    // The reason two can be on at once: rings stack concentrically, and two
    // overlapping body glows are one muddy colour.
    for (const effect of LIBRARY) {
      if (!effect.id.startsWith('aura_')) continue;
      const ring = effect.emitters.find((emitter) => emitter.id === 'ring');
      expect(ring?.render, effect.id).toBe('ground-quad');
    }
  });

  it('follows the unit it is on', () => {
    for (const effect of LIBRARY) {
      if (!effect.id.startsWith('aura_')) continue;
      for (const emitter of effect.emitters) {
        expect(emitter.worldSpace, `${effect.id}/${emitter.id}`).toBe(false);
      }
    }
  });

  it('pulses, which needs the ring re-stamped rather than held', () => {
    // A single long-lived quad cannot pulse: size is a curve over a particle's
    // own life, so a ring that lived forever would sit at its last keyframe.
    const built = aura({ id: 'aura_test', color: 'auraBuff', radius: 40 });
    const ring = built.emitters[0];
    expect(ring?.emission.kind).toBe('rate');
    const flat = compileCurve(ring?.size ?? { keys: [] });
    expect(sampleCurve(flat, 0.5)).toBeGreaterThan(sampleCurve(flat, 0));
  });

  it('adds motes only where they were asked for', () => {
    expect(aura({ id: 'a', color: 'auraBuff', radius: 40 }).emitters).toHaveLength(1);
    expect(aura({ id: 'b', color: 'auraBuff', radius: 40, motes: 6 }).emitters).toHaveLength(2);
  });
});

describe('the hit vocabulary', () => {
  it('gives a slash its swept arc', () => {
    const slash = LIBRARY.find((effect) => effect.id === 'slash_arc');
    expect(slash?.emitters[0]?.shape.kind).toBe('arc');
  });

  it('spreads the shockwave on the ground so its direction reads', () => {
    const wave = LIBRARY.find((effect) => effect.id === 'shockwave_ring');
    const ring = wave?.emitters[0];
    expect(ring?.render).toBe('ground-quad');
    const flat = compileCurve(ring?.size ?? { keys: [] });
    expect(sampleCurve(flat, 1)).toBeGreaterThan(sampleCurve(flat, 0) * 4);
  });

  it('has a death for each archetype, and they differ', () => {
    const deaths = LIBRARY.filter((effect) => effect.id.startsWith('death_'));
    expect(deaths.map((effect) => effect.id).sort()).toEqual(['death_ash', 'death_collapse', 'death_dissolve']);
    expect(new Set(deaths.map((effect) => effect.emitters[0]?.blend)).size).toBeGreaterThan(1);
  });

  it('emits a dissolve off the body rather than from a point', () => {
    const dissolve = LIBRARY.find((effect) => effect.id === 'death_dissolve');
    expect(dissolve?.emitters[0]?.shape.kind).toBe('mesh');
  });
});

describe('the whole library actually runs', () => {
  it('plays every effect for a hundred ticks without throwing or leaking', () => {
    // Cheap, and it is the only check that exercises collision, sub-effects,
    // flipbooks, ribbons and lights across every authored entry at once.
    const system = new VfxSystem({
      registry: REGISTRY,
      hooks: { ground: () => 0 },
      limits: { maxParticles: 4000, maxInstances: 128, pressureFloor: 0.25 },
    });
    for (const effect of EFFECTS) {
      const handle = system.play(effect.id, { x: 0, y: 60, z: 0, seed: 4242 });
      expect(handle, effect.id).not.toBe(0);
      system.update(100);
      system.stop(handle, true);
    }
    system.update(400);
    expect(system.pool.count).toBeLessThanOrEqual(system.pool.capacity);
  });

  it('is deterministic across the whole library', () => {
    const run = (): number[] => {
      const system = new VfxSystem({
        registry: REGISTRY,
        hooks: { ground: () => 0 },
        limits: { maxParticles: 4000, maxInstances: 128, pressureFloor: 0.25 },
      });
      for (const effect of EFFECTS) system.play(effect.id, { x: 0, y: 60, z: 0, seed: 77 });
      system.update(50);
      const out: number[] = [system.pool.count];
      for (let i = 0; i < system.pool.count; i++) out.push(system.pool.x[i] ?? 0, system.pool.y[i] ?? 0, system.pool.a[i] ?? 0);
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('puff and fire builders', () => {
  it('return plain config, so a variant is a call rather than a class', () => {
    const made = puff({
      id: 'puff_test',
      color: { stops: [[0, 'dustPale']] },
      size: 8,
      count: 4,
      rise: 20,
      spread: 1,
      lifetime: [10, 20],
    });
    expect(made.id).toBe('puff_test');
    expect(JSON.parse(JSON.stringify(made))).toEqual(made);
  });
});
