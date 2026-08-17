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
import {
  orientOf,
  needsVelocity,
  particleMesh,
  rootShadeOf,
  shadingOf,
  strokeShape,
  BANK_SIZE,
  ORIENT,
  BRUSH_SHAPES,
} from './meshes.js';
import { paletteInto, VFX_PALETTE, type PaletteKey } from './palette.js';
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

  it('is a hybrid: the composition faces the camera, the small pieces do not', () => {
    // Spec 159's depth correction. Every piece camera-facing is a decal; no
    // piece camera-facing is a gesture you can only read from one seat. So the
    // marks that carry the composition are held in the view plane and the rest
    // are turned in world space.
    expect(orientOf('brush-slash')).toBe(ORIENT.cardVelocity);
    expect(orientOf('brush-flick')).toBe(ORIENT.cardVelocity);
    expect(orientOf('brush-dab')).toBe(ORIENT.velocity);
    expect(orientOf('brush-blot')).toBe(ORIENT.tumble);
    for (const shape of BRUSH_SHAPES) {
      // Only a shape that aims itself pays for a velocity upload.
      const orient = orientOf(shape);
      expect(needsVelocity(shape), shape).toBe(orient === ORIENT.velocity || orient === ORIENT.cardVelocity);
    }
  });

  it('lights a brush mark just enough to see its arch', () => {
    // Not flat, which spec 158 made it: a shell turned in world space and drawn
    // in one colour has no form, so the depth it was given is invisible. Not
    // fully lit either, or paint looks like plastic.
    for (const shape of BRUSH_SHAPES) {
      expect(shadingOf(shape), shape).toBeGreaterThan(0);
      expect(shadingOf(shape), shape).toBeLessThan(0.5);
    }
    expect(shadingOf('blob')).toBe(1);
    expect(shadingOf('tongue')).toBe(0);
  });

  it('darkens a mark toward its own root rather than patterning over it', () => {
    // Value variation inside one mark, out of its own geometry -- the
    // alternative is a darker pattern laid over a lighter shape, which is the
    // stipple this spec removed. Gentle, or a handful of overlapping marks turn
    // the middle of a hit into one dark mass.
    expect(rootShadeOf('brush-slash')).toBeGreaterThan(0);
    expect(rootShadeOf('brush-slash')).toBeLessThan(0.3);
    // Smoke is already the dark layer and would turn to mud.
    expect(rootShadeOf('brush-blot')).toBe(0);
  });

  it('never asks a solid to dissolve by deleting pixels', () => {
    // The rule spec 159 exists to enforce. `dither-cutout` on a mesh emitter is
    // screen-door transparency: checkerboards, halftone fills and one-pixel
    // fragments over every painted effect. The mesh shader no longer implements
    // it, so an emitter that asked for it would silently get plain alpha -- this
    // is the assertion that stops that being discovered in a screenshot.
    for (const effect of EFFECTS) {
      for (const emitter of effect.emitters) {
        if (emitter.render !== 'mesh') continue;
        expect(emitter.blend, `${effect.id}/${emitter.id}`).not.toBe('dither-cutout');
      }
    }
  });

  it('gives every brush mark the per-vertex data the stroke shader reads', () => {
    // Without `strokeUv` the batch never defines VFX_STROKE, and the geometry
    // draws as its own bare spine: a line. Present for the brush marks and
    // absent for everything else, both asserted, because a lump that grew one
    // would silently take the stroke path.
    for (const shape of BRUSH_SHAPES) {
      const mesh = particleMesh(shape);
      const vertices = mesh.positions.length / 3;
      expect(mesh.strokeUv, shape).toBeDefined();
      expect((mesh.strokeUv?.length ?? 0) / 4).toBe(vertices);
      expect(mesh.variant?.length, shape).toBe(vertices);
      // A bank rather than one canonical mark: this is the number that decides
      // whether a fan of a dozen reads as a dozen marks or as one drawn twelve
      // times.
      expect(mesh.variants, shape).toBe(BANK_SIZE);
    }
    for (const shape of ['blob', 'shard', 'ring', 'tongue'] as const) {
      expect(particleMesh(shape).strokeUv, shape).toBeUndefined();
      expect(particleMesh(shape).variant, shape).toBeUndefined();
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

  it('is one dominant mark, a few medium ones and a handful of dabs', () => {
    // The composition the corrective pass turned this into. Spec 158 had three
    // emitters of a dozen small marks and it read as a cloud of red chips.
    const hit = byId('blood_hit_brush');
    expect(hit.emitters.map((emitter) => emitter.id)).toEqual(['primary', 'secondary', 'fragments']);
    const count = (id: string): number => {
      const emitter = hit.emitters.find((entry) => entry.id === id);
      return emitter?.emission.kind === 'burst' ? emitter.emission.count : 0;
    };
    expect(count('primary')).toBe(1);
    expect(count('secondary')).toBeGreaterThanOrEqual(2);
    expect(count('secondary')).toBeLessThanOrEqual(5);
    expect(count('fragments')).toBeGreaterThanOrEqual(3);
    expect(count('fragments')).toBeLessThanOrEqual(8);
    // Ten pieces, not a hundred. Every one of them has to be big enough to read.
    expect(count('primary') + count('secondary') + count('fragments')).toBeLessThanOrEqual(14);
  });

  it('makes the dominant mark dominant', () => {
    // "The dominant stroke should occupy most of the visual mass." Measured as
    // drawn length, which for a stroke is its size.
    const hit = byId('blood_hit_brush');
    const peak = (id: string): number => {
      const emitter = hit.emitters.find((entry) => entry.id === id);
      return Math.max(...(emitter?.size.keys.map(([, value]) => value) ?? [0]));
    };
    expect(peak('primary')).toBeGreaterThan(peak('secondary') * 1.6);
    expect(peak('primary')).toBeGreaterThan(peak('fragments') * 4);
  });

  it('holds the composition to the blow rather than randomising it', () => {
    // The primary within a few degrees of the bearing, the medium marks inside
    // about 35, and only the dabs allowed to stray. Randomness modifies a
    // composition; it does not replace one.
    const hit = byId('blood_hit_brush');
    const angleOf = (id: string): number => {
      const shape = hit.emitters.find((entry) => entry.id === id)?.shape;
      return shape?.kind === 'fan' ? shape.angle : Infinity;
    };
    expect(angleOf('primary')).toBeLessThan(0.12);
    expect(angleOf('secondary')).toBeLessThan(0.62);
    expect(angleOf('secondary')).toBeGreaterThan(angleOf('primary'));
    expect(angleOf('fragments')).toBeGreaterThan(angleOf('secondary'));
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
    const most = peak(byId('blood_hit_brush'), 40);
    expect(most).toBeGreaterThanOrEqual(8);
    // And not many. Tens of meaningful pieces, never hundreds of specks.
    expect(most).toBeLessThanOrEqual(14);
  });

  it('is tuned by numbers rather than by editing it', () => {
    const wide = bloodHit({ id: 'x', scale: 20, splashes: 4, droplets: 0, spread: 1.4, bias: 0 });
    const secondary = wide.emitters.find((emitter) => emitter.id === 'secondary');
    expect(secondary?.emission.kind === 'burst' && secondary.emission.count).toBe(4);
    const fragments = wide.emitters.find((emitter) => emitter.id === 'fragments');
    expect(fragments?.emission.kind === 'burst' && fragments.emission.count).toBe(0);
    // Bias at 0 is a ring: the fan opens to the full spread.
    expect(secondary?.shape.kind === 'fan' && secondary.shape.angle).toBeCloseTo(1.4, 5);
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

  it('unfolds in staged layers rather than arriving all at once', () => {
    const large = byId('explosion_brush_large');
    expect(large.emitters.map((emitter) => emitter.id)).toEqual([
      'flash',
      'major',
      'mid',
      'rise',
      'ground',
      'transitional',
      'smoke',
    ]);
    // Each layer starts after the one before it. This is the staging the brief
    // spells out in seconds, and the failure it names -- "do not make the entire
    // explosion appear simultaneously" -- is a list of equal delays.
    const delays = large.emitters.map((emitter) =>
      emitter.emission.kind === 'burst' ? (emitter.emission.delayTicks ?? 0) : 0,
    );
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i], large.emitters[i]?.id).toBeGreaterThanOrEqual(delays[i - 1] ?? 0);
    }
    expect(delays[delays.length - 1]).toBeGreaterThan(delays[0] ?? 0);
    // The flash is light and is over in a tenth of a second.
    const flash = large.emitters[0];
    expect(flash?.lifetimeTicks[1]).toBeLessThanOrEqual(6);
    expect(flash?.blend).toBe('additive');
  });

  it('is composed out of lobes rather than sprayed out of a cone', () => {
    // The correction that made the blast stop being a radial star. A cone
    // samples directions uniformly, so however different the marks are, a dozen
    // of them come out evenly spaced. Four fans at irregular bearings, with
    // different counts, pitches, lengths and colours, give clusters and gaps.
    const boom = byId('explosion_brush');
    const lobes = boom.emitters.filter((emitter) => ['major', 'mid', 'rise', 'ground'].includes(emitter.id));
    expect(lobes.length).toBe(4);
    const bearings: number[] = [];
    const rises: number[] = [];
    for (const lobe of lobes) {
      expect(lobe.shape.kind, lobe.id).toBe('fan');
      if (lobe.shape.kind !== 'fan') continue;
      bearings.push(lobe.shape.bearing ?? 0);
      rises.push(lobe.shape.rise);
    }
    // No two lobes point the same way, and the gaps between them are uneven --
    // evenly spaced lobes are a star with fewer arms.
    const sorted = [...bearings].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] ?? 0) - (sorted[i - 1] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThan(0.5);
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeGreaterThan(1.1);
    // And they are not all at the same pitch: one hugs the ground, one rises.
    expect(Math.max(...rises) - Math.min(...rises)).toBeGreaterThan(0.7);
  });

  it('gives its lobes visibly different lengths and counts', () => {
    const boom = byId('explosion_brush');
    const lobes = boom.emitters.filter((emitter) => ['major', 'mid', 'rise', 'ground'].includes(emitter.id));
    const lengths = lobes.map((lobe) => Math.max(...lobe.size.keys.map(([, value]) => value)));
    const counts = lobes.map((lobe) => (lobe.emission.kind === 'burst' ? lobe.emission.count : 0));
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeGreaterThan(1.3);
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it('draws its dark layers as separate shapes', () => {
    // "Do not represent darker areas with black dots over orange geometry."
    // The transitional layer and the smoke are their own marks, in their own
    // colours, arriving later.
    const boom = byId('explosion_brush');
    const transitional = boom.emitters.find((emitter) => emitter.id === 'transitional');
    const smoke = boom.emitters.find((emitter) => emitter.id === 'smoke');
    expect(transitional?.mesh?.shape).toBe('brush-flick');
    expect(smoke?.mesh?.shape).toBe('brush-blot');
    for (const dark of [transitional, smoke]) {
      expect(dark?.blend).toBe('alpha');
      expect(dark?.emission.kind === 'burst' && (dark.emission.delayTicks ?? 0)).toBeGreaterThan(5);
    }
  });

  it('keeps the major-stroke count inside the range the brief states', () => {
    const majors = (effect: EffectDefinition): number =>
      effect.emitters
        .filter((emitter) => ['major', 'mid', 'rise', 'ground'].includes(emitter.id))
        .reduce((sum, emitter) => sum + (emitter.emission.kind === 'burst' ? emitter.emission.count : 0), 0);
    for (const effect of BRUSH_EFFECTS.filter((entry) => entry.id.startsWith('explosion_'))) {
      expect(majors(effect), effect.id).toBeGreaterThanOrEqual(8);
      expect(majors(effect), effect.id).toBeLessThanOrEqual(16);
    }
    // Clamped rather than trusted: this is the number a person retunes, and a
    // zero here is an explosion with no explosion in it.
    expect(majors(brushExplosion({ id: 'x', radius: 40, radialCount: 400 }))).toBeLessThanOrEqual(16);
    expect(majors(brushExplosion({ id: 'y', radius: 40, radialCount: 0 }))).toBeGreaterThanOrEqual(4);
  });

  it('runs its six named layers from pale yellow down to soot', () => {
    // Measured on what the shader actually receives, which is the LINEAR
    // decode: these materials write `gl_FragColor` with no colour-space encode
    // on the way out, so a palette entry is displayed roughly as its own linear
    // value. Judging the ramp on the authored sRGB would be judging a different
    // set of colours (see the note in `palette.ts`).
    const shown = (key: PaletteKey): { luma: number; warmth: number } => {
      const rgb = new Float32Array(3);
      paletteInto(key, rgb, 0);
      const [r, g, b] = [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0];
      return { luma: 0.2126 * r + 0.7152 * g + 0.0722 * b, warmth: r - b };
    };
    const p = EXPLOSION_PALETTE;

    // The fire darkens as it goes out...
    expect(shown(p.warm).luma).toBeLessThan(shown(p.hot).luma);
    expect(shown(p.mid).luma).toBeLessThan(shown(p.warm).luma);
    // ...and the smoke end is darker than any of it.
    expect(shown(p.deep).luma).toBeLessThan(shown(p.mid).luma);
    expect(shown(p.soot).luma).toBeLessThan(shown(p.deep).luma);

    // But not a hole. A soot that reaches the screen at near-black punches a
    // shape *out* of the picture rather than putting a dark one in it, which is
    // exactly what 0x241d19 did.
    expect(shown(p.soot).luma).toBeGreaterThan(0.06);

    // Warm at every step, which is what makes it smoke off a fire rather than
    // fog. Deliberately not a luma ordering across all six: `burnt` is a
    // saturated dark orange and is genuinely darker than the brown after it,
    // and forcing a monotone ramp would flatten the hue progression the brief
    // is actually asking for.
    for (const key of Object.values(p)) expect(shown(key).warmth, key).toBeGreaterThan(0.02);
  });

  it('is stopped by drag rather than allowed to fly apart', () => {
    // The finding `burst` made first (spec 125): marks that travel separate from
    // the middle and read as a ring of darts leaving. What expands is the
    // *shape*, in the vertex shader off the particle's age -- which is why the
    // size curves here are nearly flat and would have looked wrong before.
    const boom = byId('explosion_brush');
    for (const id of ['major', 'mid', 'rise', 'ground']) {
      const lobe = boom.emitters.find((emitter) => emitter.id === id);
      expect(lobe?.drag ?? 0, id).toBeGreaterThan(8);
      expect(lobe?.velocityScale?.keys.at(-1)?.[1] ?? 1, id).toBeLessThan(0.15);
    }
  });

  it('paints its smoke rather than fogging it', () => {
    const smoke = byId('explosion_brush').emitters.find((emitter) => emitter.id === 'smoke');
    // Chunky painted lobes -- each particle is already three broad strokes
    // crossing in one mesh, so a handful is a mass rather than a bead cluster.
    expect(smoke?.mesh?.shape).toBe('brush-blot');
    expect(smoke?.blend).toBe('alpha');
    // Rises, but only just: a painted mass that climbs like a chimney is a
    // chimney.
    const rise = smoke?.acceleration?.y ?? 0;
    expect(rise).toBeGreaterThan(0);
    expect(rise).toBeLessThan(BRUSH_EXPLOSION_RADIUS);
    // Turbulence is what makes the clumps separate rather than expand as a ball.
    expect(smoke?.turbulence?.amplitude ?? 0).toBeGreaterThan(0);
  });

  it('actually puts marks in the air', () => {
    // Tens of meaningful pieces, never hundreds of specks.
    const most = peak(byId('explosion_brush'), 70);
    expect(most).toBeGreaterThanOrEqual(18);
    expect(most).toBeLessThanOrEqual(45);
  });

  it('drops a layer when it is asked to', () => {
    const bare = brushExplosion({ id: 'x', radius: 50, debris: 0, smoke: 0 });
    expect(bare.emitters.map((emitter) => emitter.id)).toEqual(['flash', 'major', 'mid', 'rise', 'ground']);
  });

  it('faces a different way every time it is played', () => {
    // The composition is fixed and asymmetric, so what makes two blasts look
    // like two blasts rather than one stamped twice is which way it points.
    const bearings = [1, 2, 3, 4, 5, 6].map(
      (seed) => brushExplosionRequest({ x: 0, y: 0, z: 0, seed: seed * 7919 }).rotation,
    );
    expect(new Set(bearings.map((value) => Math.round(value * 100))).size).toBe(bearings.length);
    for (const bearing of bearings) {
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThanOrEqual(Math.PI * 2);
    }
    // Still a pure function of the seed: two clients see the same blast.
    expect(brushExplosionRequest({ x: 0, y: 0, z: 0, seed: 42 }).rotation).toBe(
      brushExplosionRequest({ x: 0, y: 0, z: 0, seed: 42 }).rotation,
    );
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
      const reach = preset?.emitters.find((emitter) => emitter.id === 'major');
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
