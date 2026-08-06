import { describe, expect, it } from 'vitest';
import { bayerMatrix } from './retro.js';
import {
  bayer4,
  bendAngle,
  DOMINANT_HZ,
  GUST_HZ,
  maxTipDisplacement,
  phaseLagSeconds,
  stiffness,
  WAVE_LENGTH,
  WIND,
  WIND_MAX,
  windAt,
  glslWindChunk,
  type WindConfig,
} from './wind.js';

/**
 * The wind's numbers (spec 073).
 *
 * What runs on the GPU is a string, so what is checked here is the TypeScript
 * the string was transcribed from -- {@link windAt} and {@link bayer4} are the
 * shader's `windAt()` and `bayer4()` term for term. That is not the same as
 * testing the shader, and it is not pretending to be: it is testing that the
 * *motion the art direction asked for* is the motion these expressions produce,
 * so that when the frame looks wrong the arithmetic has already been ruled out.
 *
 * The frequencies are measured off the signal rather than read back off the
 * constants. Asserting `OMEGA[0] === 2.2` would pass whatever the expression
 * around it did with the number.
 */

/** Where a signal crosses zero going upwards, between `from` and `to`. */
function upCrossings(f: (t: number) => number, from: number, to: number, step = 1e-4): number[] {
  const out: number[] = [];
  let previous = f(from);
  for (let t = from + step; t <= to; t += step) {
    const value = f(t);
    if (previous < 0 && value >= 0) {
      // Linear interpolation between the samples, so the period is measured to
      // far better than the sample rate.
      out.push(t - step + (step * -previous) / (value - previous));
    }
    previous = value;
  }
  return out;
}

/** The mean gap between consecutive up-crossings -- the period. */
function period(crossings: readonly number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < crossings.length; i++) gaps.push((crossings[i] ?? 0) - (crossings[i - 1] ?? 0));
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}

describe('the wind field', () => {
  it('is a pure function of position and time', () => {
    for (const [x, z, t] of [[0, 0, 0], [130, -400, 3.5], [-2200, 900, 61.25]] as const) {
      expect(windAt(WIND, x, z, t)).toBe(windAt(WIND, x, z, t));
    }
  });

  it('never leaves the envelope its own harmonics can reach', () => {
    let worst = 0;
    for (let t = 0; t < 200; t += 0.01) worst = Math.max(worst, Math.abs(windAt(WIND, 137, -412, t)));
    expect(worst).toBeLessThanOrEqual(WIND_MAX);
    // ...and actually gets near it, or the sway would never reach full lean.
    expect(worst).toBeGreaterThan(WIND_MAX * 0.85);
  });

  it('is dominated by the ~0.35Hz harmonic', () => {
    // The gust envelope is stripped out first: it is an amplitude modulation and
    // does not move a zero crossing, but it does make a naive period estimate
    // noisier than it needs to be.
    const harmonics = (t: number): number => windAt(WIND, 0, 0, t);
    const measured = 1 / period(upCrossings(harmonics, 0, 120));
    expect(measured).toBeCloseTo(DOMINANT_HZ, 2);
    expect(DOMINANT_HZ).toBeGreaterThan(0.34);
    expect(DOMINANT_HZ).toBeLessThan(0.36);
  });

  it('rides a ~0.04Hz gust envelope', () => {
    // Measured off the envelope itself: how far the signal swings over each
    // dominant-period window, which is what the gust modulates.
    expect(GUST_HZ).toBeGreaterThan(0.038);
    expect(GUST_HZ).toBeLessThan(0.042);
    // The envelope has to actually bite -- a gust that never quietens is not a
    // gust. 0.65 +- 0.35 means the quiet is under half the peak.
    const peaks: number[] = [];
    for (let t = 0; t < 1 / GUST_HZ; t += 0.02) {
      let local = 0;
      for (let k = 0; k < 1 / DOMINANT_HZ; k += 0.01) local = Math.max(local, Math.abs(windAt(WIND, 0, 0, t + k)));
      peaks.push(local);
    }
    expect(Math.min(...peaks) / Math.max(...peaks)).toBeLessThan(0.55);
  });

  it('lags downwind: two points along the wind are out of phase', () => {
    /**
     * How long the wind at `distance` downwind takes to repeat what the origin
     * is doing. Measured off a late crossing, so the three harmonics have
     * settled into their steady relationship rather than their t=0 one.
     *
     * Wrapped into one period, because a shifted signal grows a crossing at the
     * near end of the window and loses one at the far end, so the n-th crossing
     * of the two signals is not always the same crossing. That is a property of
     * counting crossings, not of the wave. Only distances short of a period's
     * worth of lag are asked about, so the wrap is unambiguous.
     */
    const cycle = 1 / DOMINANT_HZ;
    const lagAt = (distance: number): number => {
      const here = upCrossings((t) => windAt(WIND, 0, 0, t), 0, 40);
      const there = upCrossings(
        (t) => windAt(WIND, WIND.dirX * distance, WIND.dirZ * distance, t),
        0,
        40,
      );
      const raw = (there[4] ?? 0) - (here[4] ?? 0);
      return ((raw % cycle) + cycle) % cycle;
    };

    let previous = 0;
    for (const distance of [20, 60, 100, 150]) {
      const lag = lagAt(distance);
      expect(lag).toBeGreaterThan(previous);
      // The first harmonic sets the lag; the two above it travel 1.7x and 2.3x
      // as fast and pull the crossing off that prediction by about a tenth.
      const predicted = phaseLagSeconds(WIND, distance);
      expect(Math.abs(lag - predicted) / predicted).toBeLessThan(0.15);
      previous = lag;
    }

    // Two trees a stone's throw apart are still visibly out of step: 20 world
    // units is under a fifth of one crown's width, and it buys five frames at
    // 60Hz. This is the number the acceptance pass asks about.
    expect(lagAt(20)).toBeGreaterThan(0.05);

    // The wave is one full period per WAVE_LENGTH world units, which is what
    // sets whether a grove leans together or shimmers at random.
    expect(phaseLagSeconds(WIND, WAVE_LENGTH)).toBeCloseTo(1 / DOMINANT_HZ, 6);
  });

  it('is exactly in phase across the wind', () => {
    // Perpendicular to the wind the dot product is zero, so `travel` is too.
    const across = { x: -WIND.dirZ * 350, z: WIND.dirX * 350 };
    for (let t = 0; t < 10; t += 0.37) {
      expect(windAt(WIND, across.x, across.z, t)).toBeCloseTo(windAt(WIND, 0, 0, t), 9);
    }
  });
});

describe('the bend', () => {
  it('pins the base and grows toward the tip', () => {
    const wind = 1;
    const stiff = stiffness(6, 128);
    expect(bendAngle(WIND, wind, stiff, 0)).toBe(0);
    let previous = -1;
    for (let b = 0; b <= 1; b += 0.05) {
      const angle = bendAngle(WIND, wind, stiff, b);
      expect(angle).toBeGreaterThanOrEqual(previous);
      previous = angle;
    }
  });

  it('leans the crown 5-7 degrees at the peak of a gust', () => {
    const stiff = stiffness(6, 128);
    const peak = bendAngle(WIND, WIND_MAX, stiff, 1);
    const degrees = (peak * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(5);
    expect(degrees).toBeLessThan(7);
  });

  it('pushes the tip 8-12% of the tree height', () => {
    for (const height of [118, 128]) {
      const fraction = maxTipDisplacement(WIND, height) / height;
      expect(fraction).toBeGreaterThan(0.08);
      expect(fraction).toBeLessThan(0.12);
    }
  });

  it('is an arc, so the trunk keeps its length', () => {
    // The displacement the shader applies: x += h sin a, y = h cos a. Whatever
    // the angle, the vertex stays exactly h from the base -- which is the
    // difference between a tree leaning and a tree stretching.
    for (const h of [10, 64, 128]) {
      for (let angle = -0.2; angle <= 0.2; angle += 0.01) {
        const x = h * Math.sin(angle);
        const y = h * Math.cos(angle);
        expect(Math.hypot(x, y)).toBeCloseTo(h, 9);
      }
    }
  });

  it('makes a thick trunk stiffer, and does not care how big the tree is', () => {
    expect(stiffness(12, 128)).toBeLessThan(stiffness(6, 128));
    expect(stiffness(3, 128)).toBeGreaterThan(stiffness(6, 128));
    // Scaling a tree does not make it more flexible: the same shape at twice the
    // size has the same answer.
    expect(stiffness(12, 256)).toBeCloseTo(stiffness(6, 128), 12);
  });
});

describe('the dither', () => {
  it('is the canonical 4x4 Bayer matrix', () => {
    const reference = bayerMatrix(4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(bayer4(x, y) * 16).toBe(reference[y]?.[x]);
      }
    }
  });

  it('tiles, including into negative screen coordinates', () => {
    for (let y = -8; y < 8; y++) {
      for (let x = -8; x < 8; x++) {
        expect(bayer4(x, y)).toBe(bayer4(x + 4, y));
        expect(bayer4(x, y)).toBe(bayer4(x, y + 4));
      }
    }
  });
});

describe('the shader chunk', () => {
  const glsl = glslWindChunk();

  it('declares what it uses, in dependency order', () => {
    // n2 is used by windStreak and defined by the noise fragment, so the noise
    // has to come first. Concatenating them the other way round compiles
    // nowhere, and nothing else in the suite would notice.
    expect(glsl.indexOf('float n2(')).toBeLessThan(glsl.indexOf('windStreak'));
    expect(glsl.indexOf('const vec2 WIND_DIR')).toBeLessThan(glsl.indexOf('windStreak'));
    expect(glsl).toContain('uniform float uWindTime;');
  });

  it('inlines the config rather than growing more uniforms', () => {
    // One uniform, so one write per frame however many materials read it.
    expect(glsl.match(/uniform /g)).toHaveLength(1);
    expect(glsl).toContain(WIND.travel.toFixed(8));
  });

  it('bans smoothstep from the band logic it hands out', () => {
    // The noise's own fade is written out longhand (fr*fr*(3-2fr)) precisely so
    // that a `smoothstep` appearing anywhere downstream is a real mistake.
    expect(glsl).not.toContain('smoothstep');
  });
});

describe('the config is the only source of truth', () => {
  it('describes a unit direction', () => {
    expect(Math.hypot(WIND.dirX, WIND.dirZ)).toBeCloseTo(1, 4);
  });

  it('points across the isometric camera rather than along it', () => {
    // The camera looks down the +X/+Z diagonal, so displacement along that
    // diagonal projects to almost nothing on screen. The wind has to have a
    // large component on the *other* diagonal to be visible at all.
    const alongView = (WIND.dirX + WIND.dirZ) / Math.SQRT2;
    const acrossView = (WIND.dirX - WIND.dirZ) / Math.SQRT2;
    expect(Math.abs(acrossView)).toBeGreaterThan(0.9);
    expect(Math.abs(alongView)).toBeLessThan(0.2);
  });

  it('re-derives the same wind from a config passed in', () => {
    // windAt takes its config rather than reaching for the module's, so a tuning
    // pass can evaluate a candidate without mutating anything.
    const gentler: WindConfig = { ...WIND, strength: 0.05 };
    expect(windAt(gentler, 100, 100, 2)).toBe(windAt(WIND, 100, 100, 2));
    expect(bendAngle(gentler, 1, 1, 1)).toBeCloseTo(bendAngle(WIND, 1, 1, 1) / 2, 12);
  });
});
