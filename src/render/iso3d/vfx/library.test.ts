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
import { LIBRARY, aura, burst, fire, puff } from './library.js';
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
    // The whole library, batched by blend mode, sheet and solid shape. If this
    // grows without bound the batching has stopped meaning anything. It is a
    // ceiling on what *could* be drawn: only a batch with something in it costs
    // a call, so a frame with one aura up draws three.
    expect(REGISTRY.batches.length).toBeLessThanOrEqual(20);
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
    expect(campfire?.emitters.map((emitter) => emitter.id)).toEqual([
      'tongues',
      'core',
      'embers',
      'shimmer',
      'smoke',
      'glow',
    ]);
  });

  it('builds its flame out of solids rather than camera-facing cards', () => {
    // The direction of spec 123, as an assertion. A flipbook on a quad has no
    // silhouette to read, and the silhouette is the whole thing at this size.
    const campfire = byId.get('campfire');
    for (const id of ['tongues', 'core']) {
      const emitter = campfire?.emitters.find((candidate) => candidate.id === id);
      expect(emitter?.render, id).toBe('mesh');
      expect(emitter?.mesh?.shape, id).toBe('tongue');
      // Alpha rather than additive: additive is a glow, and a glow has no edge.
      expect(emitter?.blend, id).toBe('alpha');
    }
  });

  it('keeps the embers as quads, because an ember is a spark', () => {
    const embers = byId.get('campfire')?.emitters.find((emitter) => emitter.id === 'embers');
    expect(embers?.render).toBe('billboard');
    expect(embers?.blend).toBe('additive');
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
    expect(peak(large, 'tongues') / peak(small, 'tongues')).toBeCloseTo(4, 5);
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

  it('is made of solids, so overlapping puffs build a mass', () => {
    // The direction of spec 123. A billboard cannot intersect anything, so two
    // of them are two decals stacked up rather than one churning body.
    for (const effect of LIBRARY) {
      if (!effect.id.startsWith('puff_') && !effect.id.startsWith('cloud_') && !effect.id.startsWith('smoke_')) continue;
      const emitter = effect.emitters[0];
      expect(emitter?.render, effect.id).toBe('mesh');
      expect(emitter?.mesh?.shape, effect.id).toBe('blob');
      expect(emitter?.blend, effect.id).toBe('alpha');
    }
  });

  it('rises unless it was told to hug the ground', () => {
    const groundHugging = LIBRARY.find((effect) => effect.id === 'cloud_poison')?.emitters[0];
    const rising = LIBRARY.find((effect) => effect.id === 'puff_teleport')?.emitters[0];
    // Both are solids now; what separates them is where they go, not how they
    // are drawn -- a cloud that sinks and one that climbs.
    expect(groundHugging?.gravity ?? 0).toBeLessThan(0);
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
      expect(ring?.render, effect.id).toBe('mesh');
      expect(ring?.mesh?.shape, effect.id).toMatch(/^rune-ring/);
      // Not dithered. This is the one drawn line in the library, and a stipple
      // has no edge -- which is the whole of why the first version was rejected.
      expect(ring?.blend, effect.id).toBe('alpha');
    }
  });

  it('stops hard, because a held sigil would otherwise outlive its status', () => {
    for (const effect of LIBRARY) {
      if (!effect.id.startsWith('aura_')) continue;
      expect(effect.hardStop, effect.id).toBe(true);
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

  it('holds the sigil rather than stamping it', () => {
    // Two crisp rings alive at once at slightly different angles are a doubled
    // line, so there is only ever one and it is spun rather than re-emitted.
    const ring = aura({ id: 'aura_test', color: 'auraBuff', radius: 40 }).emitters[0];
    expect(ring?.emission).toEqual({ kind: 'burst', count: 1 });
    expect(ring?.lifetimeTicks[0]).toBeGreaterThan(30 * 60);
    expect(ring?.lifetimeTicks[0]).toBe(ring?.lifetimeTicks[1]);
  });

  it('spins from angular velocity, never from a rotation curve', () => {
    // A rotation curve is sampled from life fraction every tick and would
    // overwrite the spin, so a held sigil driven by one would sit still.
    for (const effect of LIBRARY) {
      if (!effect.id.startsWith('aura_')) continue;
      const ring = effect.emitters.find((emitter) => emitter.id === 'ring');
      expect(ring?.rotation, effect.id).toBeUndefined();
    }
    const spun = aura({ id: 'a', color: 'auraBuff', radius: 40, spin: 0.5 }).emitters[0];
    expect(spun?.angularVelocity?.[0]).toBeCloseTo(Math.PI, 5);
    expect(spun?.angularVelocity?.[0]).toBe(spun?.angularVelocity?.[1]);
  });

  it('holds its size and alpha flat, since every frame but the angle is the same', () => {
    const ring = aura({ id: 'a', color: 'auraBuff', radius: 40 }).emitters[0];
    const size = compileCurve(ring?.size ?? { keys: [] });
    const alpha = compileCurve(ring?.alpha ?? { keys: [] });
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(sampleCurve(size, t)).toBeCloseTo(40, 5);
      expect(sampleCurve(alpha, t)).toBeCloseTo(0.9, 5);
    }
  });

  it('adds shafts and diamonds only where they were asked for', () => {
    expect(aura({ id: 'a', color: 'auraBuff', radius: 40 }).emitters).toHaveLength(1);
    expect(aura({ id: 'b', color: 'auraBuff', radius: 40, shafts: 4 }).emitters).toHaveLength(2);
    expect(aura({ id: 'c', color: 'auraBuff', radius: 40, diamonds: 4 }).emitters).toHaveLength(2);
    expect(aura({ id: 'd', color: 'auraBuff', radius: 40, shafts: 4, diamonds: 4 }).emitters).toHaveLength(3);
  });

  it('leaves nothing behind when a soft stop ends it', () => {
    // The hazard `hardStop` exists for. A held sigil is given ten minutes of
    // life, so a soft stop -- the default, and the right default for a fire
    // trail -- would leave it lying on the ground long after the status ended.
    const system = new VfxSystem({
      registry: REGISTRY,
      hooks: { ground: () => 0 },
      limits: { maxParticles: 400, maxInstances: 8, pressureFloor: 0.25 },
    });
    const handle = system.play('aura_buff', { x: 0, y: 0, z: 0, seed: 11 });
    system.update(30);
    expect(system.pool.count).toBeGreaterThan(0);
    system.stop(handle);
    expect(system.pool.count).toBe(0);
  });

  it('stands its shafts on the ring rather than inside it', () => {
    // Two effects rather than one, otherwise: light coming out of the middle of
    // a circle is not light coming out of the circle.
    const built = aura({ id: 'a', color: 'auraBuff', radius: 40, shafts: 4 });
    const shafts = built.emitters.find((emitter) => emitter.id === 'shafts');
    expect(shafts?.shape).toEqual({ kind: 'circle', radius: 40 * 0.86, shell: true });
    expect(shafts?.mesh?.shape).toBe('shaft');
    expect(shafts?.blend).toBe('additive');
  });
});

describe('the burst family', () => {
  const byId = new Map(LIBRARY.map((effect) => [effect.id, effect]));

  it('makes a hit the quiet end of an explosion, not a second vocabulary', () => {
    const small = byId.get('hit_physical');
    const large = byId.get('explosion_large');
    expect(small?.emitters.map((emitter) => emitter.id)).toContain('spikes');
    expect(large?.emitters.map((emitter) => emitter.id)).toContain('spikes');
  });

  it('aims its spikes down their own travel', () => {
    // The reason ORIENT.velocity exists. A shard authored pointing at +Y and
    // aimed by the batch radiates out of a point with nothing computing a
    // rotation per particle.
    for (const effect of LIBRARY) {
      const spikes = effect.emitters.find((emitter) => emitter.id === 'spikes');
      if (!spikes) continue;
      expect(spikes.render, effect.id).toBe('mesh');
      expect(spikes.mesh?.shape, effect.id).toBe('shard');
      expect(spikes.blend, effect.id).toBe('alpha');
    }
  });

  it('gives every burst a solid core rather than a stack of quads', () => {
    for (const effect of LIBRARY) {
      const core = effect.emitters.find((emitter) => emitter.id === 'core');
      if (!core || !effect.emitters.some((emitter) => emitter.id === 'spikes')) continue;
      expect(core.mesh?.shape, effect.id).toBe('starburst');
      expect(core.emission, effect.id).toEqual({ kind: 'burst', count: 1 });
    }
  });

  it('stops its spikes with drag rather than letting them fly away', () => {
    // What reads as the burst opening is the size curve, not travel. Spikes that
    // travelled would separate from the core and read as darts leaving.
    const spikes = burst({ id: 'b', scale: 40, hot: 'fireCore', warm: 'fireBody', cool: 'fireDeep' })
      .emitters.find((emitter) => emitter.id === 'spikes');
    expect(spikes?.drag ?? 0).toBeGreaterThan(8);
    const size = compileCurve(spikes?.size ?? { keys: [] });
    expect(sampleCurve(size, 0.3)).toBeGreaterThan(sampleCurve(size, 0) * 3);
    expect(sampleCurve(size, 1)).toBeLessThan(sampleCurve(size, 0.3));
  });

  it('scales every layer from the one number', () => {
    const small = burst({ id: 'a', scale: 20, hot: 'fireCore', warm: 'fireBody', cool: 'fireDeep', chunks: 3 });
    const large = burst({ id: 'b', scale: 80, hot: 'fireCore', warm: 'fireBody', cool: 'fireDeep', chunks: 3 });
    const peak = (effect: typeof small, id: string): number => {
      const emitter = effect.emitters.find((candidate) => candidate.id === id);
      return Math.max(...(emitter?.size.keys.map(([, value]) => value) ?? [0]));
    };
    for (const id of ['core', 'spikes', 'shards', 'chunks', 'dust']) {
      expect(peak(large, id) / peak(small, id), id).toBeCloseTo(4, 5);
    }
  });

  it('drops the layers a variant does not want', () => {
    const bare = burst({ id: 'a', scale: 20, hot: 'fireCore', warm: 'fireBody', cool: 'fireDeep', dust: false, glow: false });
    const ids = bare.emitters.map((emitter) => emitter.id);
    expect(ids).not.toContain('dust');
    expect(ids).not.toContain('glow');
    expect(ids).not.toContain('chunks');
  });

  it('throws rock that bounces rather than sinking into the floor', () => {
    const chunks = byId.get('explosion_large')?.emitters.find((emitter) => emitter.id === 'chunks');
    expect(chunks?.mesh?.shape).toBe('chunk');
    expect(chunks?.collision?.maxBounces ?? 0).toBeGreaterThan(0);
    expect(chunks?.gravity ?? 0).toBeLessThan(0);
  });

  it('fires a directed burst along the blow rather than in every direction', () => {
    const jet = byId.get('explosion_directed')?.emitters.find((emitter) => emitter.id === 'spikes');
    const ball = byId.get('explosion_large')?.emitters.find((emitter) => emitter.id === 'spikes');
    const angle = (emitter: typeof jet): number =>
      emitter?.shape.kind === 'cone' ? emitter.shape.angle : 0;
    expect(angle(jet)).toBeLessThan(angle(ball) / 2);
  });

  it('lays the ground variant flat instead of pointing it up', () => {
    const flat = byId.get('explosion_ground')?.emitters.find((emitter) => emitter.id === 'spikes');
    // A circle emits in the ground plane; a cone emits into the sky.
    expect(flat?.shape.kind).toBe('circle');
  });

  it('keeps every damage type on its own colours', () => {
    const hot = (id: string): string | undefined => {
      const core = byId.get(id)?.emitters.find((emitter) => emitter.id === 'core');
      return core?.color.stops[0]?.[1];
    };
    const types = ['hit_physical', 'hit_fire', 'hit_poison', 'hit_ice', 'hit_lightning', 'hit_arcane'];
    expect(new Set(types.map(hot)).size).toBe(types.length);
  });

  it('makes a crit the same burst, larger', () => {
    const peak = (id: string): number => {
      const spikes = byId.get(id)?.emitters.find((emitter) => emitter.id === 'spikes');
      return Math.max(...(spikes?.size.keys.map(([, value]) => value) ?? [0]));
    };
    expect(peak('hit_critical')).toBeGreaterThan(peak('hit_physical'));
    expect(peak('explosion_large')).toBeGreaterThan(peak('hit_critical'));
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
