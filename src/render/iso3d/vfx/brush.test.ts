/**
 * The two painted effects, and the API that spawns them (spec 158).
 *
 * The library's own sweep (`library.test.ts`) already checks that everything in
 * the registry compiles, emits, names real colours and dangles no sub-effect --
 * these entries get all of that for free, which is the point of writing the
 * checks over the table. What is here is what is specific to *these two*: the
 * counts and windows the brief states in numbers, the shape vocabulary they are
 * built from, and the arithmetic of the two spawn calls.
 */

import { describe, expect, it } from 'vitest';
import {
  bloodHit,
  bloodHitRequest,
  brushExplosion,
  brushExplosionRequest,
  BRUSH_EFFECTS,
  BRUSH_EXPLOSION_RADIUS,
  EXPLOSION_PALETTE,
  HEAVY_HIT_INTENSITY,
  NORMAL_LIFT,
} from './brush.js';
import { EFFECTS, REGISTRY } from './registry.js';
import { compileRegistry } from './compile.js';
import { VfxSystem } from './system.js';
import { orientOf, needsVelocity, particleMesh, shadedShape, strokeShape, ORIENT, BRUSH_SHAPES } from './meshes.js';
import { VFX_PALETTE } from './palette.js';
import type { EffectDefinition } from './types.js';

const TICK_HZ = 60;

function byId(id: string): EffectDefinition {
  const found = EFFECTS.find((effect) => effect.id === id);
  if (!found) throw new Error(`${id} is not in the shipped registry`);
  return found;
}

/** Ticks from the play call until the last particle of an effect can still be alive. */
function windowTicks(effect: EffectDefinition): number {
  return Math.max(
    ...effect.emitters.map((emitter) => {
      const delay = emitter.emission.kind === 'burst' ? (emitter.emission.delayTicks ?? 0) : 0;
      return delay + emitter.lifetimeTicks[1];
    }),
  );
}

/** Play one effect through a real system and report the peak live particle count. */
function peak(effect: EffectDefinition, ticks: number): number {
  const system = new VfxSystem({
    registry: compileRegistry([effect]),
    hooks: { ground: () => 0 },
    limits: { maxParticles: 3000, maxInstances: 8, pressureFloor: 0.25 },
  });
  system.play(effect.id, { x: 0, y: 40, z: 0, seed: 20260810 });
  let most = 0;
  for (let tick = 0; tick < ticks; tick++) {
    system.update(1);
    most = Math.max(most, system.pool.count);
  }
  return most;
}

describe('the painted vocabulary', () => {
  it('registers every preset in the shipped table', () => {
    const ids = new Set(EFFECTS.map((effect) => effect.id));
    for (const effect of BRUSH_EFFECTS) expect(ids.has(effect.id), effect.id).toBe(true);
    expect(BRUSH_EFFECTS.length).toBeGreaterThanOrEqual(5);
  });

  it('draws every one of its particles as a brush mark', () => {
    // The failure this catches is an emitter that quietly falls back to a
    // billboard -- exactly what `RENDER.mesh` did for a whole spec (123) and
    // `RENDER.ribbon` for another (139). A painted effect with a sprite quad in
    // it looks *nearly* right and is the one thing this vocabulary cannot have.
    for (const effect of BRUSH_EFFECTS) {
      for (const emitter of effect.emitters) {
        expect(emitter.render, `${effect.id}/${emitter.id}`).toBe('mesh');
        const shape = emitter.mesh?.shape;
        expect(shape, `${effect.id}/${emitter.id} names no solid`).toBeDefined();
        expect(strokeShape(shape ?? 'blob'), `${effect.id}/${emitter.id} is ${shape}`).toBe(true);
      }
    }
  });

  it('holds every brush mark in the view plane and lights none of them', () => {
    for (const shape of BRUSH_SHAPES) {
      const orient = orientOf(shape);
      expect([ORIENT.card, ORIENT.cardVelocity], shape).toContain(orient);
      // Paint is flat colour by decision. A lit mark has a bright side and a
      // dark side, which says "a solid seen from an angle".
      expect(shadedShape(shape), shape).toBe(false);
      // Only the two thrown marks pay for a velocity upload.
      expect(needsVelocity(shape), shape).toBe(orient === ORIENT.cardVelocity);
    }
  });

  it('gives every brush mark the per-vertex data the stroke shader reads', () => {
    // Without `strokeUv` the batch never defines VFX_STROKE, and the geometry
    // draws as its own bare spine: a line. Present for the brush marks and
    // absent for everything else, both asserted, because a lump that grew one
    // would silently take the stroke path.
    for (const shape of BRUSH_SHAPES) {
      const mesh = particleMesh(shape);
      expect(mesh.strokeUv, shape).toBeDefined();
      expect((mesh.strokeUv?.length ?? 0) / 4).toBe(mesh.positions.length / 3);
    }
    for (const shape of ['blob', 'shard', 'ring', 'tongue'] as const) {
      expect(particleMesh(shape).strokeUv, shape).toBeUndefined();
    }
  });

  it('shares one geometry per mark rather than one per particle', () => {
    // The whole reason the variation lives in the shader. Two calls, one object.
    expect(particleMesh('brush-slash')).toBe(particleMesh('brush-slash'));
  });

  it('names only colours that exist', () => {
    for (const key of Object.values(EXPLOSION_PALETTE)) {
      expect(Object.prototype.hasOwnProperty.call(VFX_PALETTE, key), key).toBe(true);
    }
  });
});

describe('the blood hit', () => {
  it('reads and is gone inside the window a hit has to read in', () => {
    // The brief's 0.25-0.8s, at 60Hz.
    for (const id of ['blood_hit_brush', 'blood_hit_brush_heavy']) {
      const ticks = windowTicks(byId(id));
      expect(ticks / TICK_HZ, id).toBeGreaterThanOrEqual(0.25);
      expect(ticks / TICK_HZ, id).toBeLessThanOrEqual(0.8);
    }
  });

  it('is three layers: one flick that carries the direction, a scatter, and dabs', () => {
    const hit = byId('blood_hit_brush');
    expect(hit.emitters.map((emitter) => emitter.id)).toEqual(['stroke', 'splashes', 'droplets']);
    const stroke = hit.emitters[0];
    // The primary is the *longest* mark and there are only a couple of them:
    // more than that and the gesture becomes a firework.
    expect(stroke?.emission.kind === 'burst' && stroke.emission.count).toBeLessThanOrEqual(3);
  });

  it('throws everything along the blow rather than at the sky', () => {
    // `cone` is about local +Y, so a spatter authored with one throws paint
    // upward whatever direction the blow came from. `fan` is the emitter shape
    // this spec added precisely because that could not be written down.
    for (const emitter of byId('blood_hit_brush').emitters) {
      expect(emitter.shape.kind, emitter.id).toBe('fan');
    }
  });

  it('stops fast rather than coasting', () => {
    // "Rapid initial movement followed by drag": every layer's velocity scale is
    // down to a fifth or less by a third of the way through its life.
    for (const emitter of byId('blood_hit_brush').emitters) {
      const curve = emitter.velocityScale;
      expect(curve, emitter.id).toBeDefined();
      const keys = curve?.keys ?? [];
      const start = keys[0]?.[1] ?? 0;
      const end = keys[keys.length - 1]?.[1] ?? 1;
      expect(start, emitter.id).toBeGreaterThan(0.9);
      expect(end, emitter.id).toBeLessThan(0.25);
    }
  });

  it('reads louder on a killing blow in the same language', () => {
    const light = byId('blood_hit_brush');
    const heavy = byId('blood_hit_brush_heavy');
    const count = (effect: EffectDefinition): number =>
      effect.emitters.reduce((sum, e) => sum + (e.emission.kind === 'burst' ? e.emission.count : 0), 0);
    expect(count(heavy)).toBeGreaterThan(count(light));
    // The same shapes, in the same order: louder, never different.
    expect(heavy.emitters.map((e) => e.mesh?.shape)).toEqual(light.emitters.map((e) => e.mesh?.shape));
  });

  it('actually puts marks in the air', () => {
    expect(peak(byId('blood_hit_brush'), 40)).toBeGreaterThanOrEqual(12);
  });

  it('is tuned by numbers rather than by editing it', () => {
    const wide = bloodHit({ id: 'x', scale: 20, splashes: 30, droplets: 0, spread: 1.4, bias: 0 });
    const splashes = wide.emitters.find((emitter) => emitter.id === 'splashes');
    expect(splashes?.emission.kind === 'burst' && splashes.emission.count).toBe(30);
    const droplets = wide.emitters.find((emitter) => emitter.id === 'droplets');
    expect(droplets?.emission.kind === 'burst' && droplets.emission.count).toBe(0);
    // Bias at 0 is a ring: the fan opens to the full spread.
    expect(splashes?.shape.kind === 'fan' && splashes.shape.angle).toBeCloseTo(1.4, 5);
  });
});

describe('the explosion', () => {
  it('unfolds and is over inside the window an explosion has to read in', () => {
    // The brief's 0.7-1.5s, at 60Hz.
    for (const effect of BRUSH_EFFECTS.filter((entry) => entry.id.startsWith('explosion_'))) {
      const ticks = windowTicks(effect);
      expect(ticks / TICK_HZ, effect.id).toBeGreaterThanOrEqual(0.7);
      expect(ticks / TICK_HZ, effect.id).toBeLessThanOrEqual(1.5);
    }
  });

  it('is four layers in the order they happen', () => {
    const large = byId('explosion_brush_large');
    expect(large.emitters.map((emitter) => emitter.id)).toEqual(['flash', 'radial', 'debris', 'smoke']);
    const flash = large.emitters[0];
    const smoke = large.emitters[3];
    // The flash is over before anything else has finished being born, and the
    // smoke has not started when it goes off.
    expect(flash?.lifetimeTicks[1]).toBeLessThan(10);
    expect(smoke?.emission.kind === 'burst' && (smoke.emission.delayTicks ?? 0)).toBeGreaterThan(0);
  });

  it('keeps the radial count inside the range the brief states', () => {
    for (const effect of BRUSH_EFFECTS.filter((entry) => entry.id.startsWith('explosion_'))) {
      const radial = effect.emitters.find((emitter) => emitter.id === 'radial');
      const count = radial?.emission.kind === 'burst' ? radial.emission.count : 0;
      expect(count, effect.id).toBeGreaterThanOrEqual(8);
      expect(count, effect.id).toBeLessThanOrEqual(20);
    }
    // Clamped rather than trusted: this is the number a person retunes, and a
    // zero here is an explosion with no explosion in it.
    const silly = brushExplosion({ id: 'x', radius: 40, radialCount: 400 });
    const radial = silly.emitters.find((emitter) => emitter.id === 'radial');
    expect(radial?.emission.kind === 'burst' && radial.emission.count).toBe(20);
    const none = brushExplosion({ id: 'y', radius: 40, radialCount: 0 });
    expect(none.emitters.find((e) => e.id === 'radial')?.emission).toMatchObject({ count: 8 });
  });

  it('runs the palette from pale yellow to a dark warm brown', () => {
    const radial = byId('explosion_brush').emitters.find((emitter) => emitter.id === 'radial');
    expect(radial?.color.stops.map(([, key]) => key)).toEqual([
      EXPLOSION_PALETTE.hot,
      EXPLOSION_PALETTE.warm,
      EXPLOSION_PALETTE.mid,
      EXPLOSION_PALETTE.deep,
    ]);
    // The ramp really does darken. Luma off the authored sRGB is enough to say
    // so, and it is what stops somebody reordering the stops by accident.
    const luma = (packed: number): number =>
      0.2126 * ((packed >> 16) & 0xff) + 0.7152 * ((packed >> 8) & 0xff) + 0.0722 * (packed & 0xff);
    const keys = [EXPLOSION_PALETTE.hot, EXPLOSION_PALETTE.warm, EXPLOSION_PALETTE.mid, EXPLOSION_PALETTE.deep];
    for (let i = 1; i < keys.length; i++) {
      expect(luma(VFX_PALETTE[keys[i] as keyof typeof VFX_PALETTE])).toBeLessThan(
        luma(VFX_PALETTE[keys[i - 1] as keyof typeof VFX_PALETTE]),
      );
    }
  });

  it('grows far faster than it travels', () => {
    // The finding `burst` made first (spec 125): marks that travel separate from
    // the middle and read as a ring of darts leaving. So the size curve reaches
    // full extension by a fifth of the life and the drag is heavy.
    const radial = byId('explosion_brush').emitters.find((emitter) => emitter.id === 'radial');
    const keys = radial?.size.keys ?? [];
    const born = keys[0]?.[1] ?? 0;
    const at20 = keys.find(([t]) => t >= 0.2)?.[1] ?? 0;
    expect(at20 / Math.max(1e-6, born)).toBeGreaterThan(3);
    expect(radial?.drag ?? 0).toBeGreaterThan(8);
  });

  it('paints its smoke rather than fogging it', () => {
    const smoke = byId('explosion_brush').emitters.find((emitter) => emitter.id === 'smoke');
    // Chunky blots, and the cutout blend -- no partial alpha at all, so a mass
    // thins into a weave instead of smearing.
    expect(smoke?.mesh?.shape).toBe('brush-blot');
    expect(smoke?.blend).toBe('dither-cutout');
    // Rises, but only just: a painted mass that climbs like a chimney is a
    // chimney.
    const rise = smoke?.acceleration?.y ?? 0;
    expect(rise).toBeGreaterThan(0);
    expect(rise).toBeLessThan(BRUSH_EXPLOSION_RADIUS);
    // Turbulence is what makes the clumps separate rather than expand as a ball.
    expect(smoke?.turbulence?.amplitude ?? 0).toBeGreaterThan(0);
  });

  it('actually puts marks in the air', () => {
    expect(peak(byId('explosion_brush'), 70)).toBeGreaterThanOrEqual(25);
  });

  it('drops a layer when it is asked to', () => {
    const bare = brushExplosion({ id: 'x', radius: 50, debris: 0, smoke: 0 });
    expect(bare.emitters.map((emitter) => emitter.id)).toEqual(['flash', 'radial']);
  });
});

describe('SpawnBloodHit', () => {
  const seed = 4242;

  it('aims between the blow and the surface, weighted toward the blow', () => {
    // A blow travelling +X into a surface whose normal is +X: both agree, so the
    // answer is unambiguous and the weighting cannot hide a sign error.
    const straight = bloodHitRequest({ x: 0, y: 0, z: 0, normal: { x: 1, y: 0, z: 0 }, incoming: { x: 1, y: 0, z: 0 }, seed });
    expect(straight.rotation).toBeCloseTo(0, 6);

    // Now they disagree by a right angle. The result must sit between them and
    // nearer the blow, which is what "direction is information" means here.
    const split = bloodHitRequest({ x: 0, y: 0, z: 0, normal: { x: 0, y: 0, z: 1 }, incoming: { x: 1, y: 0, z: 0 }, seed });
    expect(split.rotation).toBeGreaterThan(0);
    expect(split.rotation).toBeLessThan(Math.PI / 4);
  });

  it('is not swamped by an un-normalised velocity', () => {
    // A caller handing over a raw velocity rather than a direction is the
    // obvious mistake, and it must not silently delete the normal's half.
    const slow = bloodHitRequest({ x: 0, y: 0, z: 0, normal: { x: 0, y: 0, z: 1 }, incoming: { x: 1, y: 0, z: 0 }, seed });
    const fast = bloodHitRequest({ x: 0, y: 0, z: 0, normal: { x: 0, y: 0, z: 1 }, incoming: { x: 900, y: 0, z: 0 }, seed });
    expect(fast.rotation).toBeCloseTo(slow.rotation, 6);
  });

  it('lifts the mark clear of the surface it landed on', () => {
    const request = bloodHitRequest({ x: 10, y: 20, z: 30, normal: { x: 0, y: 1, z: 0 }, incoming: { x: 1, y: 0, z: 0 }, seed });
    expect(request.y).toBeCloseTo(20 + NORMAL_LIFT, 6);
    expect(request.x).toBeCloseTo(10, 6);
  });

  it('survives an attacker standing exactly on its target', () => {
    // Point blank, which happens: a fixed bearing beats a NaN rotation.
    const request = bloodHitRequest({ x: 5, y: 5, z: 5, seed });
    expect(Number.isFinite(request.rotation)).toBe(true);
    expect(request.x).toBe(5);
  });

  it('picks the loud definition rather than compounding onto it', () => {
    const ordinary = bloodHitRequest({ x: 0, y: 0, z: 0, intensity: 1, seed });
    expect(ordinary.id).toBe('blood_hit_brush');
    expect(ordinary.scale).toBeCloseTo(1, 6);

    const crit = bloodHitRequest({ x: 0, y: 0, z: 0, intensity: HEAVY_HIT_INTENSITY, seed });
    expect(crit.id).toBe('blood_hit_brush_heavy');
    // Measured against the heavy definition, so a crit is not the loud effect
    // AND a 1.35x on top of it.
    expect(crit.scale).toBeCloseTo(1, 6);
  });

  it('is a pure function of what it is handed', () => {
    const input = { x: 1, y: 2, z: 3, normal: { x: 0, y: 1, z: 0 }, incoming: { x: 1, y: 0, z: 1 }, intensity: 1.1, seed };
    expect(bloodHitRequest(input)).toEqual(bloodHitRequest(input));
  });

  it('names effects the registry actually holds', () => {
    for (const intensity of [0.5, 1, 2, 6]) {
      const request = bloodHitRequest({ x: 0, y: 0, z: 0, intensity, seed });
      expect(REGISTRY.byId.has(request.id), request.id).toBe(true);
      expect(request.scale).toBeGreaterThan(0);
    }
  });
});

describe('SpawnBrushExplosion', () => {
  const seed = 77;

  it('honours a radius as a length rather than as a multiplier', () => {
    // The `lengthWorld` argument from src/items/: nobody can check a scale
    // factor and anybody can hold a length up against the world.
    for (const radius of [30, 60, 96, 150]) {
      const request = brushExplosionRequest({ x: 0, y: 0, z: 0, radius, seed });
      const preset = EFFECTS.find((effect) => effect.id === request.id);
      expect(preset, request.id).toBeDefined();
      const reach = preset?.emitters.find((emitter) => emitter.id === 'radial');
      const drawn = Math.max(...(reach?.size.keys.map(([, value]) => value) ?? [0])) * request.scale;
      // Within a factor of the authored length range, which is what `radius`
      // means: how far the marks reach.
      expect(drawn, `${radius}`).toBeGreaterThan(radius * 0.5);
      expect(drawn, `${radius}`).toBeLessThan(radius * 2);
    }
  });

  it('picks a preset by size rather than shrinking one', () => {
    // A nine-stroke burst at a third the size is a different picture from a
    // nineteen-stroke one, and counts do not scale.
    expect(brushExplosionRequest({ x: 0, y: 0, z: 0, radius: 30, seed }).id).toBe('explosion_brush_small');
    expect(brushExplosionRequest({ x: 0, y: 0, z: 0, radius: 60, seed }).id).toBe('explosion_brush');
    expect(brushExplosionRequest({ x: 0, y: 0, z: 0, radius: 140, seed }).id).toBe('explosion_brush_large');
    expect(brushExplosionRequest({ x: 0, y: 0, z: 0, seed }).id).toBe('explosion_brush');
  });

  it('grows with intensity without running away with it', () => {
    const at = (intensity: number): number =>
      brushExplosionRequest({ x: 0, y: 0, z: 0, radius: 60, intensity, seed }).scale;
    expect(at(2)).toBeGreaterThan(at(1));
    expect(at(0.5)).toBeLessThan(at(1));
    // The cube root: twice as hard is visibly bigger, not twice as wide.
    expect(at(8) / at(1)).toBeCloseTo(2, 5);
  });

  it('refuses to produce a degenerate play call', () => {
    const request = brushExplosionRequest({ x: 1, y: 2, z: 3, radius: 0, intensity: 0, seed });
    expect(request.scale).toBeGreaterThan(0);
    expect(Number.isFinite(request.scale)).toBe(true);
    expect(REGISTRY.byId.has(request.id)).toBe(true);
  });
});
