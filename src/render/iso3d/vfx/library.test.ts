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
import { DAMAGE_EFFECTS, DAMAGE_DEBRIS, effectsForBlow, REDUNDANT_SERVER_EFFECTS } from '../world/vfx-wire.js';
import { SCORCHED_EARTH } from '../../../server/data/aura-fields.js';
import { AFFLICTION_ART } from '../world/affliction-vfx.js';
import { SHOT_ART } from '../world/shot-vfx.js';
import { EMBER_BURST_RADIUS } from './brush.js';
import { abilityById } from '../../../server/data/abilities.js';
import { PROJECTILE_SPEED_SCALE } from '../../../server/player/stats.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { ALL_DOTS } from '../../../server/data/damage-over-time.js';
import { spriteSheet, sheetFrames } from './textures.js';
import { MARK_REACH } from './meshes.js';

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
    //
    // Moved from 20 to 25 by spec 158, deliberately and once: the painted
    // vocabulary brings four marks, and `brush-slash` is used both additive (the
    // explosion's flash) and cutout (everything else), so it costs five. What a
    // *frame* pays is still bounded by the effects actually up -- a painted
    // explosion is four calls and a painted hit is three.
    expect(REGISTRY.batches.length).toBeLessThanOrEqual(25);
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

  it('names only effects the registry holds, at every gore level (spec 182)', () => {
    // The tables above are what a *typo* hides in; this is what a new branch
    // hides in. The gore level chooses between four blood ids, and a level that
    // names one the registry has not got plays nothing and looks like the
    // setting working.
    const seen = new Set<string>();
    for (const gore of [0, 1, 2] as const) {
      for (const damageType of Object.keys(DAMAGE_EFFECTS) as (keyof typeof DAMAGE_EFFECTS)[]) {
        for (const bleeds of [false, true]) {
          for (const killed of [false, true]) {
            for (const critical of [false, true]) {
              for (const blocked of [false, true]) {
                for (const damage of [-14, 0, 10]) {
                  const played = effectsForBlow(
                    {
                      attackerId: 1,
                      targetId: 2,
                      damage,
                      killed,
                      critical,
                      blocked,
                      damageType,
                      x: 0,
                      y: 0,
                      z: 0,
                      fromX: -40,
                      fromZ: 0,
                      bleeds,
                      // A pulse names nothing at all (spec 219), so it can hide
                      // no typo -- this sweep is about the blow's four ids.
                      periodic: false,
                    },
                    1,
                    gore,
                  );
                  for (const request of played) seen.add(request.id);
                }
              }
            }
          }
        }
      }
    }
    for (const id of seen) expect(ids.has(id), id).toBe(true);
    // And the sweep actually reached the blood vocabulary, or it proved nothing.
    expect(seen).toContain('blood_hit_brush');
    expect(seen).toContain('blood_hit_brush_heavy');
    expect(seen).toContain('death_blood');
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

  it('is the combined thing: a crystal, flat streaks, rock and a wavefront', () => {
    // Spec 126. The reference shows all four at once, and the wave is the part
    // that says shockwave rather than explosion.
    const wave = LIBRARY.find((effect) => effect.id === 'shockwave_ring');
    const ids = wave?.emitters.map((emitter) => emitter.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(['core', 'spikes', 'chunks', 'wave', 'wave_halo']));
    // The streaks run along the floor: a circle emits in the ground plane where
    // a cone emits into the sky.
    expect(wave?.emitters.find((emitter) => emitter.id === 'spikes')?.shape.kind).toBe('circle');
  });

  it('outruns and outlives its own fan', () => {
    const wave = LIBRARY.find((effect) => effect.id === 'shockwave_ring');
    const of = (id: string) => wave?.emitters.find((emitter) => emitter.id === id);
    const peak = (id: string): number =>
      Math.max(...(of(id)?.size.keys.map(([, value]) => value) ?? [0]));
    expect(peak('wave')).toBeGreaterThan(peak('spikes') * 1.5);
    expect(of('wave')?.lifetimeTicks[0] ?? 0).toBeGreaterThan(of('spikes')?.lifetimeTicks[1] ?? 0);
    const size = compileCurve(of('wave')?.size ?? { keys: [] });
    expect(sampleCurve(size, 1)).toBeGreaterThan(sampleCurve(size, 0) * 4);
  });

  it('adds the wave only where it was asked for', () => {
    const plain = burst({ id: 'a', scale: 40, hot: 'iceWhite', warm: 'icePale', cool: 'iceDeep' });
    expect(plain.emitters.some((emitter) => emitter.id === 'wave')).toBe(false);
    const waved = burst({ id: 'b', scale: 40, hot: 'iceWhite', warm: 'icePale', cool: 'iceDeep', ring: true });
    expect(waved.emitters.filter((emitter) => emitter.id.startsWith('wave'))).toHaveLength(2);
    for (const emitter of waved.emitters.filter((entry) => entry.id.startsWith('wave'))) {
      expect(emitter.mesh?.shape).toBe('ring');
      // Light, not an object.
      expect(emitter.blend).toBe('additive');
    }
  });

  it('answers a walk order with two crossed marks and nothing else', () => {
    // Spec 175. An order threw no rock, lit no fire and scattered nothing, so
    // there are two brush marks here and no company for them -- anything around
    // them would be paint that came off the brush, which is the one thing that
    // did not happen.
    const order = LIBRARY.find((effect) => effect.id === 'order_move');
    expect(order?.emitters.map((emitter) => emitter.id)).toEqual(['stroke_a', 'stroke_b']);
    for (const emitter of order?.emitters ?? []) {
      expect(emitter.mesh?.shape, emitter.id).toBe('brush-mark');
      // One mark each. A second particle in either emitter is a third stroke in
      // a cross, which is a scribble.
      expect(emitter.emission, emitter.id).toEqual({ kind: 'burst', count: 1 });
      // It was placed. Nothing about it travels, or the answer drifts off the
      // point the question was asked about.
      expect(emitter.speed, emitter.id).toEqual([0, 0]);
    }
  });

  it('crosses the two marks rather than opening them out of a point', () => {
    // The whole geometry of a cross, as the two numbers it actually rests on:
    // the arms are a quarter turn apart, and neither of them is upright.
    const order = LIBRARY.find((effect) => effect.id === 'order_move');
    const rolls = (order?.emitters ?? []).map((emitter) => {
      const keys = emitter.rotation?.keys ?? [];
      // Constant over the life: a mark that turned while it was being read is a
      // mark somebody is still drawing.
      expect(new Set(keys.map(([, value]) => value)).size, emitter.id).toBe(1);
      return keys[0]?.[1] ?? 0;
    });
    expect(rolls).toHaveLength(2);
    const apart = Math.abs((rolls[0] ?? 0) - (rolls[1] ?? 0));
    expect(apart).toBeGreaterThan(Math.PI / 2 - 0.12);
    expect(apart).toBeLessThan(Math.PI / 2 + 0.12);
    // And never exactly 90 apart, nor either arm on an axis: a cross drawn by a
    // person is two strokes that nearly agree.
    expect(apart).not.toBe(Math.PI / 2);
    for (const roll of rolls) expect(Math.abs(roll)).toBeGreaterThan(0.1);
  });

  it('makes the order cue small, brief and undroppable', () => {
    const order = LIBRARY.find((effect) => effect.id === 'order_move');
    const selected = LIBRARY.find((effect) => effect.id === 'aura_selected');
    const peak = Math.max(
      ...(order?.emitters.flatMap((emitter) => emitter.size.keys.map(([, value]) => value)) ?? [0]),
    );
    // Inside the sigil a selected unit already stands on: this is a
    // confirmation, not an ability. Its REACH against that radius, because a
    // stroke's size is its length where a ring's is its half-width, and the
    // version of this that compared the two raw numbers was comparing a span
    // against half of one.
    const sigil = Math.max(
      ...(selected?.emitters
        .find((emitter) => emitter.id === 'ring')
        ?.size.keys.map(([, value]) => value) ?? [0]),
    );
    expect(peak * MARK_REACH).toBeLessThan(sigil);
    // It ends on its own, and nothing about it is a rate: an order's cue that
    // outlived the click would be the marker again by another name. Quicker
    // than the wavefront it replaced, which ran to 34 ticks.
    for (const emitter of order?.emitters ?? []) {
      expect(emitter.emission.kind, emitter.id).toBe('burst');
      expect(emitter.lifetimeTicks[1], emitter.id).toBeLessThanOrEqual(24);
    }
    // Information about your own input, so never the thing dropped when the
    // budget is tight.
    expect(order?.priority).toBe(3);
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

describe('the heal (spec 157)', () => {
  const heal = LIBRARY.find((effect) => effect.id === 'heal_restore');
  const emitter = (id: string) => heal?.emitters.find((entry) => entry.id === id);

  it('is the three layers the brief asks for, and nothing else', () => {
    expect(heal?.emitters.map((entry) => entry.id)).toEqual(['wave', 'wave_halo', 'streaks', 'plusses']);
  });

  it('shares the one wavefront rather than authoring a second one', () => {
    // The same two emitters the shockwave's ring is, so a tuning pass on the
    // wave moves both instead of leaving this one behind. Measured against the
    // shockwave rather than against the walk order, which is where the wave is
    // authored -- the order was the copy, and since spec 175 it is a cross.
    const shock = LIBRARY.find((effect) => effect.id === 'shockwave_ring');
    for (const id of ['wave', 'wave_halo']) {
      expect(emitter(id)?.mesh?.shape, id).toBe(shock?.emitters.find((entry) => entry.id === id)?.mesh?.shape);
      expect(emitter(id)?.blend, id).toBe(shock?.emitters.find((entry) => entry.id === id)?.blend);
    }
  });

  it('keeps the shockwave at the feet and smaller than the selection ring', () => {
    // Small, and inside every status ring: a heal is an event that happened
    // here, and one that reached the outer radii would read as a status.
    const peak = Math.max(...(emitter('wave')?.size.keys.map(([, value]) => value) ?? [0]));
    const sigil = Math.max(
      ...(LIBRARY.find((effect) => effect.id === 'aura_selected')
        ?.emitters.find((entry) => entry.id === 'ring')
        ?.size.keys.map(([, value]) => value) ?? [0]),
    );
    expect(peak).toBeLessThan(sigil);
    // On the floor, a hair above it: the origin is the ground, not a chest.
    for (const id of ['wave', 'wave_halo']) {
      expect(emitter(id)?.offset?.y ?? 0, id).toBeLessThanOrEqual(3);
    }
  });

  it('sends the streaks and the plusses straight up rather than outward', () => {
    // A cone emits into the sky about +Y; a circle emits in the ground plane,
    // which is what the flat shockwave uses and is exactly wrong here.
    for (const id of ['streaks', 'plusses']) {
      const shape = emitter(id)?.shape;
      expect(shape?.kind, id).toBe('cone');
      expect(shape?.kind === 'cone' ? shape.angle : Math.PI, `${id} fans out`).toBeLessThan(0.2);
      // Gravity would arc a rise over into a spray, which is the blood this
      // replaces. Nothing here falls.
      expect(emitter(id)?.gravity ?? 0, id).toBe(0);
    }
  });

  it('draws the streaks as ribbons, so a rise is a line and not a bar', () => {
    expect(emitter('streaks')?.render).toBe('ribbon');
    expect(emitter('streaks')?.ribbonSpacing ?? 0).toBeGreaterThan(0);
  });

  it('holds the plusses on screen after the streaks have gone', () => {
    // The effect ends on the symbol rather than on the motion.
    expect(emitter('plusses')?.lifetimeTicks[0] ?? 0).toBeGreaterThan(emitter('streaks')?.lifetimeTicks[1] ?? 0);
    expect(emitter('plusses')?.speed[1] ?? 0).toBeLessThan(emitter('streaks')?.speed[0] ?? 0);
  });

  it('draws the plus as a cutout of the plus sheet, big enough to read', () => {
    expect(emitter('plusses')?.sprite?.sheet).toBe('plus');
    // The pixel-look blend: a plus that fades through partial alpha is a smudge
    // the retro pass then bands.
    expect(emitter('plusses')?.blend).toBe('dither-cutout');
    // Roughly eleven pixels at the gameplay zoom (760px over ~900 world units),
    // which is about a pixel and a half per texel of a 7x7 sheet.
    const peak = Math.max(...(emitter('plusses')?.size.keys.map(([, value]) => value) ?? [0]));
    expect(peak).toBeGreaterThanOrEqual(12);
  });

  it('is green throughout, in the greens the heal ring already uses', () => {
    // Not "a green picked to look like healing": the same palette entries the
    // heal aura is drawn in, so a heal landing and a heal status showing do not
    // nearly match.
    for (const entry of heal?.emitters ?? []) {
      for (const [, key] of entry.color.stops) {
        expect(['auraHeal', 'auraBuff'], `${entry.id} -> ${key}`).toContain(key);
      }
    }
  });

  it('ends on its own rather than standing under the body', () => {
    // A heal is an event. A rate emitter never finishes, so one in here would be
    // a status aura that nothing ever stops -- the plusses stagger with a ramp,
    // which ends, rather than with a rate, which does not.
    for (const entry of heal?.emitters ?? []) {
      expect(entry.emission.kind, entry.id).not.toBe('rate');
      if (entry.emission.kind === 'ramp') expect(entry.emission.overTicks, entry.id).toBeLessThanOrEqual(30);
      expect(entry.lifetimeTicks[1], entry.id).toBeLessThanOrEqual(50);
    }
  });
});

describe('the plus sheet (spec 157)', () => {
  const image = spriteSheet('plus').image;
  // `TextureImageData.data` is a typed array of some flavour; every sheet in
  // this file is RGBA bytes, and reading it as numbers is all this needs.
  const data = image.data as ArrayLike<number>;
  const alphaAt = (x: number, y: number): number => data[(y * image.width + x) * 4 + 3] ?? 0;

  it('is one square frame', () => {
    expect(sheetFrames('plus')).toBe(1);
    expect(image.width).toBe(image.height);
  });

  it('is a cross rather than a blob or a box', () => {
    const last = image.width - 1;
    const mid = (image.width - 1) / 2;
    // The arms reach all four edges...
    expect(alphaAt(mid, 0)).toBe(255);
    expect(alphaAt(mid, last)).toBe(255);
    expect(alphaAt(0, mid)).toBe(255);
    expect(alphaAt(last, mid)).toBe(255);
    // ...and the corners are empty, which is the difference between a plus and
    // a square.
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      expect(alphaAt(x ?? 0, y ?? 0)).toBe(0);
    }
  });

  it('is every texel on or off, so the quantizer has nothing to band', () => {
    for (let i = 3; i < data.length; i += 4) {
      expect(data[i] === 0 || data[i] === 255).toBe(true);
    }
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


/**
 * The afflictions (spec 215).
 *
 * Both directions, and the second one is why this block exists. Checking that
 * every id `AFFLICTION_ART` names is in the registry catches a typo -- the
 * failure `aurasFor`'s own test names, "a name that looks right and silently
 * plays nothing". Checking the other way catches the failure spec 215 was
 * written to close: an effect that was **authored and then reached by nothing**.
 * `EmitterShape`'s `{ kind: 'mesh' }` sat in the type for eighty specs with no
 * definition that used it and no `surface` hook to resolve it, and every test in
 * the tree was green throughout, because a table that agrees with itself is all
 * a one-directional check can ever prove.
 *
 * The third assertion closes the same loop one table further out: an affliction
 * added to `data/damage-over-time.ts` with no art is a mechanic that takes
 * health with nothing on the body to say so, and from the neck down it is
 * indistinguishable from being wrong about your own health bar -- which is the
 * exact state this spec found the game in.
 */
describe('the afflictions (spec 215)', () => {
  /** Every id reachable from the art table: the cling, its heavy tier, the beat. */
  const named = new Set<string>();
  for (const art of Object.values(AFFLICTION_ART)) {
    named.add(art.cling);
    if (art.heavy) named.add(art.heavy);
    named.add(art.pulse);
  }

  it('names only effects the registry actually holds', () => {
    for (const id of named) expect(ids.has(id), id).toBe(true);
    // And the sweep reached something, or an empty table passes it.
    expect(named.size).toBeGreaterThan(ALL_DOTS.length * 2);
  });

  it('reaches every affliction effect the registry holds', () => {
    // The direction that catches an authored effect nothing plays. A `_heavy`
    // for a row that cannot get worse, or a beat for an affliction that was
    // renamed, is dead paint: it costs a batch in the compiled registry, it is
    // previewed by `preview-afflictions-vfx.ts`, and it never appears in a game.
    const authored = EFFECTS.filter((effect) => effect.id.startsWith('affliction_')).map(
      (effect) => effect.id,
    );
    expect(authored.length).toBeGreaterThan(0);
    for (const id of authored) expect(named.has(id), `${id} is authored and reached by nothing`).toBe(true);
    // Both directions together mean the two sets are the same set.
    expect([...named].sort()).toEqual([...authored].sort());
  });

  it('has art for every affliction the sim can apply', () => {
    for (const row of ALL_DOTS) {
      const art = AFFLICTION_ART[row.id];
      expect(art, row.id).toBeDefined();
      expect(art?.cling, row.id).toBeTruthy();
      expect(art?.pulse, row.id).toBeTruthy();
    }
    expect(Object.keys(AFFLICTION_ART)).toHaveLength(ALL_DOTS.length);
  });

  it('gives every affliction its own paint rather than two rows sharing one', () => {
    // Seven afflictions drawn with five effects is five afflictions, and the
    // whole problem this spec opens on is that from the neck down they already
    // looked alike.
    const clings = ALL_DOTS.map((row) => AFFLICTION_ART[row.id]?.cling);
    expect(new Set(clings).size).toBe(ALL_DOTS.length);
    const pulses = ALL_DOTS.map((row) => AFFLICTION_ART[row.id]?.pulse);
    expect(new Set(pulses).size).toBe(ALL_DOTS.length);
  });

  it('burns until stopped, and never hard-stops', () => {
    // `durationTicks: 0` is what makes a cling a **state**: the driver owns the
    // stop and owes one on despawn, because nothing in this system stops itself
    // when the body it is attached to goes away. The stop is **soft**, unlike an
    // aura's: a cling mark lives about half a second, so letting the last few
    // dry is what an affliction ending should look like -- where `hardStop` was
    // written for a single particle held for ten minutes, which is not this.
    const byId = new Map(EFFECTS.map((effect) => [effect.id, effect]));
    for (const art of Object.values(AFFLICTION_ART)) {
      for (const id of [art.cling, art.heavy].filter((entry): entry is string => Boolean(entry))) {
        expect(byId.get(id)?.durationTicks, id).toBe(0);
        expect(byId.get(id)?.hardStop, id).toBeFalsy();
      }
      // A beat is the opposite kind of thing: an event, thrown and over, whose
      // handle the driver drops on the floor. A rate emitter here would be an
      // instance nobody is holding a handle to and nothing will ever stop.
      const beat = byId.get(art.pulse);
      expect(beat?.emitters.length, art.pulse).toBeGreaterThan(0);
      for (const emitter of beat?.emitters ?? []) {
        expect(emitter.emission.kind, `${art.pulse}/${emitter.id}`).toBe('burst');
      }
    }
  });

  it('paints in opaque marks throughout', () => {
    // The painted vocabulary's opacity rule (spec 159): paint is opaque, and two
    // translucent marks crossing make a third colour that is in neither of them.
    // It matters more here than anywhere else in the file, because a cling is
    // *many overlapping marks on one body by construction* -- the one
    // arrangement where a translucent mark is guaranteed to cross another.
    for (const effect of EFFECTS) {
      if (!effect.id.startsWith('affliction_')) continue;
      for (const emitter of effect.emitters) {
        expect(emitter.blend, `${effect.id}/${emitter.id}`).toBe('alpha');
      }
    }
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

/**
 * The shot the staff throws, and where it lands (spec 218).
 *
 * Two effects, and the properties worth pinning are the ones a still frame
 * cannot show. `worldSpace` is the whole of the flight look and is a boolean
 * nobody can see; "no smoke" is a request that has to survive a retune of a
 * shared builder; and "a very short trail" is an adjective until it is a number
 * of world units.
 */
describe('the ember shot (spec 218)', () => {
  const byId = new Map(EFFECTS.map((effect) => [effect.id, effect]));
  const flight = byId.get('shot_ember');
  const burst = byId.get('ranged.ember.impact');
  const emitter = (effect: typeof flight, id: string) =>
    effect?.emitters.find((entry) => entry.id === id);

  it('is in the registry under both ids', () => {
    expect(flight, 'shot_ember').toBeDefined();
    // Named for the ability, because that is the id the server has sent on a
    // projectile's impact since spec 062 and the seam this reaches it by.
    expect(burst, 'ranged.ember.impact').toBeDefined();
  });

  it('clings its fire to the ball and leaves its smoke behind', () => {
    // The one property the whole look rests on, and the one that is invisible
    // in a still frame. The compiled default is world space, and attaching an
    // effect moves only the emission *origin* -- so on the two layers that are
    // the fireball, `worldSpace: false` is what makes them travel with it, and
    // on the trail its absence is what makes a mark stay where it was laid.
    expect(emitter(flight, 'core')?.worldSpace).toBe(false);
    expect(emitter(flight, 'licks')?.worldSpace).toBe(false);
    expect(emitter(flight, 'trail')?.worldSpace).not.toBe(false);
  });

  it('runs until it is stopped, because a flight has no length of its own', () => {
    // The driver owns both ends and owes the stop; a duration here would put the
    // paint out partway through a long shot.
    expect(flight?.durationTicks).toBe(0);
  });

  it('leaves a very short trail, in world units rather than in adjectives', () => {
    const spec = abilityById('ranged.ember')?.projectile;
    const perSecond = (spec?.speed ?? 0) * PROJECTILE_SPEED_SCALE;
    const life = emitter(flight, 'trail')?.lifetimeTicks[1] ?? 0;
    const behind = (perSecond / SERVER_TICK_RATE) * life;
    // Long enough to read as a trail at all -- a few shot-radii...
    expect(behind).toBeGreaterThan((spec?.radius ?? 0) * 3);
    // ...and short enough that it is smoke coming off a shot rather than a line
    // drawn across the arena. The bow's whole range is 420.
    expect(behind).toBeLessThan(100);
  });

  it('has no smoke in its burst, and therefore no soot anywhere in it', () => {
    // `smoke: 0` is the request read literally, and `brushExplosion` omits the
    // emitter outright at zero rather than bursting nothing.
    expect(emitter(burst, 'smoke')).toBeUndefined();
    // The stronger form: soot is the smoke layer's colour and appears nowhere
    // else in the builder, so this fails if a retune reintroduces it by another
    // route. The transitional layer stays -- burnt orange into brown, drawn
    // among the fire -- because it is what makes a painted explosion painted.
    for (const entry of burst?.emitters ?? []) {
      for (const [, key] of entry.color?.stops ?? []) {
        expect(key, `${entry.id} reaches ${key}`).not.toBe('paintSoot');
      }
    }
    expect(emitter(burst, 'transitional')).toBeDefined();
  });

  it('carries no light, because a light is the one length scale does not touch', () => {
    // A light's radius goes straight into the light buffer (`system.ts`), so a
    // lit preset is a light sized for whatever radius it was authored at
    // whatever it is played at. The three lit explosion presets are played by
    // nothing, so nothing has ever noticed.
    for (const entry of burst?.emitters ?? []) expect(entry.light, entry.id).toBeUndefined();
  });

  it('is authored at the radius it is drawn at', () => {
    // Since spec 218 those are the same statement: `scene.addEffect` plays an
    // authored effect at scale 1. Small against a body -- a player's radius is
    // 16 -- which is the request, and the same number `explosion_brush_small` is
    // authored at, so this is the vocabulary's own small blast rather than a
    // shrunk large one.
    expect(EMBER_BURST_RADIUS).toBeGreaterThan((abilityById('ranged.ember')?.projectile?.radius ?? 0) * 2);
    expect(EMBER_BURST_RADIUS).toBeLessThan(46);
  });

  it('draws its shot with paint the registry holds', () => {
    // The same pair of directions `AFFLICTION_ART` is held to, so an effect
    // authored and reached by nothing fails here rather than being previewed
    // forever and never appearing in a game.
    const named = new Set(Object.values(SHOT_ART));
    const authored = EFFECTS.filter((effect) => effect.id.startsWith('shot_')).map((e) => e.id);
    expect([...named].sort()).toEqual([...authored].sort());
  });
});

/**
 * The five landings that were a debug ring (spec 231).
 *
 * The seam is `scene.addEffect`'s `system.has(effectId)`: the server has sent
 * these ids since spec 062 and the registry held none of them, so authoring
 * under the id already being sent is the whole of the wiring. What that makes
 * fragile is the *id* -- a typo produces an effect nobody plays and a ring
 * nobody notices, which is the state this spec found the game in.
 */
describe('the landings (spec 231)', () => {
  const LANDINGS = [
    { id: 'skill.emberToss.impact', ability: 'skill.emberToss' },
    { id: 'skill.rimeTouch.impact', ability: 'skill.rimeTouch' },
    { id: 'skill.blight.impact', ability: 'skill.blight' },
    { id: 'skill.arcLash.impact', ability: 'skill.arcLash' },
    { id: 'skill.whirlwind.impact', ability: 'skill.whirlwind' },
    { id: 'skill.scorchedEarth.self', ability: 'skill.scorchedEarth' },
  ] as const;

  it('is in the registry, so addEffect takes the authored branch', () => {
    for (const landing of LANDINGS) {
      expect(REGISTRY.byId.has(landing.id), landing.id).toBe(true);
    }
  });

  it('names an ability, with the suffix that ability actually sends', () => {
    for (const landing of LANDINGS) {
      const ability = abilityById(landing.ability);
      expect(ability, landing.ability).toBeDefined();
      if (!ability) continue;
      if (landing.id.endsWith('.self')) {
        // `landSelf` is the only landing that sends `.self`.
        expect(ability.kind, landing.id).toBe('self');
        continue;
      }
      // The three landings that send `.impact`: an area shape, a ground blast,
      // and a projectile with a burst radius. A plain melee row sends nothing,
      // so an `.impact` authored for one would never play.
      const sendsImpact =
        ability.kind === 'area' ||
        ability.kind === 'ground' ||
        (ability.kind === 'projectile' && (ability.radius ?? 0) > 0);
      expect(sendsImpact, `${landing.id} names a row that sends no impact`).toBe(true);
    }
  });

  it('does not drop the scorched-earth ignition before it reaches the registry', () => {
    // `REDUNDANT_SERVER_EFFECTS` is where the two self-heals correctly sit,
    // because the blow they report already draws them. Scorched Earth reports no
    // blow at all -- it applies a status -- so the ignition is its only picture.
    expect(REDUNDANT_SERVER_EFFECTS.has('skill.scorchedEarth.self')).toBe(false);
  });

  it('sizes the ignition off the field it lights, not off a number', () => {
    // The same rule `aura_scorched` follows: this is where the fire is about to
    // be, so a burst reaching past the field would promise ground that is safe.
    const index = REGISTRY.byId.get('skill.scorchedEarth.self');
    expect(index).toBeDefined();
    const effect = EFFECTS.find((entry) => entry.id === 'skill.scorchedEarth.self');
    expect(effect).toBeDefined();
    // Authored at the field's reach: the longest a mark is thrown scales off it,
    // so the check is that the definition moves when the constant does.
    const reach = Math.max(
      ...(effect?.emitters ?? []).map((emitter) =>
        Math.max(...emitter.size.keys.map(([, value]) => value)),
      ),
    );
    expect(reach).toBeGreaterThan(SCORCHED_EARTH.radius * 0.3);
    expect(reach).toBeLessThan(SCORCHED_EARTH.radius * 2.2);
  });

  it('gives no two landings the same colours', () => {
    // The sheet's own finding, turned into a check. Arc Lash's second version
    // came out the same pale blue as Rime Touch two rows above it, and nothing
    // else in this suite could have said so.
    const signature = (id: string): string => {
      const effect = EFFECTS.find((entry) => entry.id === id);
      const stops = (effect?.emitters ?? []).flatMap((emitter) =>
        emitter.color.stops.map(([, key]) => key),
      );
      return [...new Set(stops)].sort().join(',');
    };
    const seen = new Map<string, string>();
    for (const landing of LANDINGS) {
      const colours = signature(landing.id);
      const clash = seen.get(colours);
      // Ember Toss and Scorched Earth are both fire and are allowed to share:
      // they are the same element, which is the rule rather than an exception.
      const firePair =
        clash !== undefined &&
        [clash, landing.id].every((id) => id === 'skill.emberToss.impact' || id === 'skill.scorchedEarth.self');
      expect(clash === undefined || firePair, `${landing.id} shares a palette with ${String(clash)}`).toBe(true);
      seen.set(colours, landing.id);
    }
  });
});
