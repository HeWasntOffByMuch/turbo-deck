import { describe, expect, it } from 'vitest';
import {
  APPARENT_LIGHT_FRACTION,
  MAGIC_DEFAULTS,
  MAX_LIGHT_RANGE,
  MIN_LIGHT_RANGE,
  TORCH_ANCHOR,
  TORCH_DEFAULTS,
  apparentLightDistance,
  carriedLightDistance,
  orbState,
  pointIntensity,
  torchFlicker,
} from './player-lights.js';
import { pointLightInjection, pointLoopIsUnrolled, shaderMarkersPresent } from './player-lighting.js';

/** A long even sweep of the flame, for statistics rather than spot checks. */
function flickerSamples(seed: number, count = 4000, step = 1 / 60): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(torchFlicker(i * step, seed).intensity);
  return out;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

describe('torchFlicker (spec 047)', () => {
  it('is pure in time and seed', () => {
    expect(torchFlicker(3.25, 7)).toEqual(torchFlicker(3.25, 7));
    expect(torchFlicker(3.25, 7)).not.toEqual(torchFlicker(3.25, 8));
  });

  it('stays inside its band, so the flame never blows out or goes dark', () => {
    for (const intensity of flickerSamples(11)) {
      expect(intensity).toBeGreaterThanOrEqual(0.55);
      expect(intensity).toBeLessThanOrEqual(1.35);
    }
  });

  it('averages about 1, so flicker is not a dimmer with extra steps', () => {
    // A flicker centred anywhere but 1 would mean the brightness slider no
    // longer says what the torch actually puts out.
    expect(mean(flickerSamples(3))).toBeCloseTo(1, 1);
    expect(mean(flickerSamples(99))).toBeCloseTo(1, 1);
  });

  it('actually moves -- it is not a constant dressed up as noise', () => {
    const samples = flickerSamples(5, 600);
    const spread = Math.max(...samples) - Math.min(...samples);
    expect(spread).toBeGreaterThan(0.15);
  });

  it('is continuous: no strobe between one frame and the next', () => {
    // At 60fps a flame may shimmer, but it must never jump. Value noise eased
    // with a smoothstep is what buys this; linear interpolation would corner.
    for (let i = 0; i < 2000; i++) {
      const t = i / 60;
      const step = Math.abs(torchFlicker(t + 1 / 60, 21).intensity - torchFlicker(t, 21).intensity);
      expect(step).toBeLessThan(0.2);
    }
  });

  it('has no single dominant beat the eye can lock onto', () => {
    // Consecutive-sample correlation well below 1 at the fast rate means the
    // shimmer is not just a slow sine sampled finely.
    const samples = flickerSamples(13, 1200);
    const deltas = samples.slice(1).map((v, i) => v - (samples[i] as number));
    const signChanges = deltas.slice(1).filter((d, i) => d * (deltas[i] as number) < 0).length;
    expect(signChanges).toBeGreaterThan(60);
  });

  it('sways the light as well as dimming it, so cast shadows swim', () => {
    const samples = Array.from({ length: 600 }, (_, i) => torchFlicker(i / 60, 4).sway);
    const spread = Math.max(...samples.map((s) => s.x)) - Math.min(...samples.map((s) => s.x));
    expect(spread).toBeGreaterThan(1);
    for (const sway of samples) {
      expect(Math.hypot(sway.x, sway.y, sway.z)).toBeLessThan(8);
    }
  });

  it('goes perfectly steady at zero depth, and deeper as depth rises', () => {
    for (let i = 0; i < 200; i++) {
      const steady = torchFlicker(i / 60, 6, 0);
      expect(steady.intensity).toBe(1);
      expect(Math.hypot(steady.sway.x, steady.sway.y, steady.sway.z)).toBe(0);
    }
    const shallow = Array.from({ length: 600 }, (_, i) => torchFlicker(i / 60, 6, 0.4).intensity);
    const deep = Array.from({ length: 600 }, (_, i) => torchFlicker(i / 60, 6, 1.8).intensity);
    const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
    expect(spread(deep)).toBeGreaterThan(spread(shallow));
  });

  it('shrugs off a non-finite time rather than emitting NaN light', () => {
    expect(Number.isFinite(torchFlicker(Number.NaN, 2).intensity)).toBe(true);
    expect(Number.isFinite(torchFlicker(Number.POSITIVE_INFINITY, 2).sway.x)).toBe(true);
  });
});

describe('orbState (spec 047)', () => {
  it('floats above the player at all times', () => {
    for (let i = 0; i < 1200; i++) {
      expect(orbState(i / 30).offset.y).toBeGreaterThan(40);
    }
  });

  it('holds a steady circle rather than wandering', () => {
    for (let i = 0; i < 600; i++) {
      const { x, z } = orbState(i / 30).offset;
      expect(Math.hypot(x, z)).toBeCloseTo(22, 6);
    }
  });

  it('completes its circuit, its bob and its pulse on unrelated periods', () => {
    // If any two shared a period the three would resynchronise into a visible
    // loop; sampling a full circuit and finding the bob elsewhere shows they do not.
    const start = orbState(0);
    const circuit = orbState(7.3);
    expect(circuit.offset.x).toBeCloseTo(start.offset.x, 6);
    expect(circuit.offset.y).not.toBeCloseTo(start.offset.y, 1);
  });

  it('breathes gently rather than throbbing', () => {
    const samples = Array.from({ length: 900 }, (_, i) => orbState(i / 30).intensity);
    expect(Math.min(...samples)).toBeGreaterThan(0.85);
    expect(Math.max(...samples)).toBeLessThan(1.15);
  });

  it('is pure, and phase-shiftable so two orbs need not overlap', () => {
    expect(orbState(2.5)).toEqual(orbState(2.5));
    expect(orbState(2.5, 1).offset.x).not.toBeCloseTo(orbState(2.5, 0).offset.x, 3);
  });

  it('shrugs off a non-finite time', () => {
    expect(Number.isFinite(orbState(Number.NaN).offset.y)).toBe(true);
  });
});

describe('pointIntensity (spec 047)', () => {
  it('scales with the square of the range', () => {
    // The point of the conversion: doubling the reach needs 4x the candela to
    // look the same, so the range slider does not secretly change brightness.
    expect(pointIntensity(1, 600) / pointIntensity(1, 300)).toBeCloseTo(4, 9);
    expect(pointIntensity(1, 300) / pointIntensity(1, 150)).toBeCloseTo(4, 9);
  });

  it('is linear in brightness', () => {
    expect(pointIntensity(2, 300)).toBeCloseTo(2 * pointIntensity(1, 300), 9);
    expect(pointIntensity(0, 300)).toBe(0);
  });

  it('means the same apparent brightness at half range, whatever the range', () => {
    // Illuminance at half range is intensity / (range/2)^2, which is exactly
    // the brightness asked for -- at any range.
    for (const range of [120, 300, 500, 900]) {
      const half = range / 2;
      expect(pointIntensity(1.6, range) / (half * half)).toBeCloseTo(1.6, 9);
    }
  });

  it('produces the large candela values three 0.160 physical falloff needs', () => {
    // Sanity: the defaults land in the tens of thousands, not near 1. A torch
    // set to an intensity of "1.6" in this world would be invisible.
    expect(pointIntensity(TORCH_DEFAULTS.brightness, TORCH_DEFAULTS.range)).toBeGreaterThan(10_000);
    expect(pointIntensity(MAGIC_DEFAULTS.brightness, MAGIC_DEFAULTS.range)).toBeGreaterThan(10_000);
  });

  it('never returns a negative or non-finite intensity', () => {
    expect(pointIntensity(-5, 300)).toBe(0);
    expect(Number.isFinite(pointIntensity(1, 0))).toBe(true);
  });
});


describe('apparentLightDistance (spec 118)', () => {
  it('is a fixed fraction of the light’s own range', () => {
    expect(apparentLightDistance(300)).toBeCloseTo(300 * APPARENT_LIGHT_FRACTION, 9);
    expect(apparentLightDistance(900)).toBeCloseTo(900 * APPARENT_LIGHT_FRACTION, 9);
  });

  it('is linear in the range', () => {
    expect(apparentLightDistance(600)).toBeCloseTo(2 * apparentLightDistance(300), 9);
  });

  it('lights the body at exactly the brightness the slider names, at every range', () => {
    // The headline, and the reason the fraction is a half. `pointIntensity`
    // exists because the brightness slider means "this much illuminance at half
    // range"; measuring the body from there is that sentence, applied to the
    // body. A range slider that changed how lit the player looks would be the
    // same coupling `pointIntensity` was written to remove everywhere else.
    for (const range of [MIN_LIGHT_RANGE, 120, 300, 500, MAX_LIGHT_RANGE]) {
      for (const brightness of [0.4, 1.6, 3.2]) {
        const d = apparentLightDistance(range);
        expect(pointIntensity(brightness, range) / (d * d)).toBeCloseTo(brightness, 6);
      }
    }
  });

  it('holds the torch further out than it really is, at the default reach', () => {
    const carried = Math.hypot(TORCH_ANCHOR.x, TORCH_ANCHOR.y, TORCH_ANCHOR.z);
    expect(carriedLightDistance(carried, TORCH_DEFAULTS.range)).toBeGreaterThan(carried * 3);
    expect(carriedLightDistance(carried, MAX_LIGHT_RANGE)).toBeGreaterThan(carried * 3);
  });

  it('never pulls a light *closer* than it really is', () => {
    // Which is not hypothetical: at the shortest reach the panel allows, half
    // range is 40 units and the flame's own anchor is 44. A lamp with an
    // 80-unit reach is meant to be an intimate light, and dragging it inward to
    // make it uniform would be inventing a look nobody asked for.
    const carried = Math.hypot(TORCH_ANCHOR.x, TORCH_ANCHOR.y, TORCH_ANCHOR.z);
    expect(apparentLightDistance(MIN_LIGHT_RANGE)).toBeLessThan(carried);
    expect(carriedLightDistance(carried, MIN_LIGHT_RANGE)).toBe(carried);
    for (const range of [MIN_LIGHT_RANGE, 120, 300, MAX_LIGHT_RANGE]) {
      for (const distance of [0, 5, carried, 400, 5000]) {
        expect(carriedLightDistance(distance, range)).toBeGreaterThanOrEqual(distance);
      }
    }
  });

  it('flattens the falloff across a body from severe to under a stop', () => {
    // The uniformity, stated as the thing the eye actually sees: how much more
    // light the near side of a figure gets than the far side, under 1/d².
    const halfBody = 46 / 2;
    const spread = (distance: number): number =>
      ((distance + halfBody) / (distance - halfBody)) ** 2;

    const carried = Math.hypot(TORCH_ANCHOR.x, TORCH_ANCHOR.y, TORCH_ANCHOR.z);
    expect(spread(carried)).toBeGreaterThan(8);
    expect(spread(apparentLightDistance(TORCH_DEFAULTS.range))).toBeLessThan(2);
  });

  it('never returns zero or a non-finite distance', () => {
    // This reaches a shader, where a NaN does not throw -- it paints the body
    // black -- and a zero divides by itself.
    for (const range of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = apparentLightDistance(range);
      expect(Number.isFinite(d) || range === Number.POSITIVE_INFINITY).toBe(true);
      expect(d).toBeGreaterThan(0);
    }
  });
});

describe('the shader patch behind it (spec 118)', () => {
  it('still finds the line it rewrites in three’s own chunk', () => {
    // The one thing that cannot be seen from a browser: a replace that stops
    // matching is a silent no-op there, and a player lit from point blank
    // again. A three.js upgrade that renames this fails here instead.
    expect(shaderMarkersPresent()).toBe(true);
  });

  /**
   * The patch has to survive being emitted more than once (spec 248).
   *
   * three unrolls the point-light loop, so its body appears once per light *at
   * the same scope*. Two copies of a bare `vec3 turboToLight` is
   * `'turboToLight' : redefinition` and a material that never compiles -- and
   * three logs a failed compile and carries on, so the symptom is an unlit
   * player and a green suite.
   *
   * It hid for a hundred and thirty specs because this game had exactly one
   * point light. It took the light pool to produce a second one and a browser to
   * see it, which is why the invariant is pinned here rather than left to the
   * next probe run.
   */
  it('wraps what it injects in a block, because the loop is unrolled', () => {
    expect(pointLoopIsUnrolled()).toBe(true);
    const injection = pointLightInjection();
    expect(injection.trim().startsWith('{')).toBe(true);
    expect(injection.trim().endsWith('}')).toBe(true);
    // Balanced, and never closing early: a block that shut before the light was
    // read would compile and leave the light exactly where it was.
    let depth = 0;
    let closedEarly = false;
    for (const ch of injection) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0 && !injection.trimEnd().endsWith(ch)) closedEarly = true;
      }
    }
    expect(depth).toBe(0);
    expect(closedEarly).toBe(false);
  });

  it('declares each of its own names exactly once inside that block', () => {
    const injection = pointLightInjection();
    for (const name of ['turboToLight', 'turboTrue', 'turboApparent', 'turboHeld']) {
      const declarations = injection.split(new RegExp(`\\b(?:vec3|float) ${name}\\b`)).length - 1;
      expect(declarations, name).toBe(1);
    }
  });
});
