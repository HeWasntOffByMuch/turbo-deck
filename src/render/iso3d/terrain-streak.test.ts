import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { patchTerrainStreak } from './terrain-streak.js';
import { RETRO_DEFAULTS } from './retro.js';
import { TERRAIN_COLORS } from './palette.js';
import { WIND, glslWindChunk } from './wind.js';

/**
 * The streak layer over the ground (spec 074, part 3).
 *
 * This file exists because the layer shipped switched on, correctly wired, and
 * invisible, and nothing in the suite objected. The splice was fine; the
 * amplitude was a quarter of what the retro pass can represent, so quantization
 * rounded it away everywhere except where the ground already sat on a colour
 * band edge. The acceptance script said otherwise only because it ran with the
 * retro pass off and with trees in shot.
 *
 * What is guarded here is therefore not "the code is present" -- the old bug
 * would have passed that -- but the two relationships that decide whether a
 * player sees anything: the layer's swing against the size of a colour band,
 * and the gust front's motion against the grain's.
 */

/** GLSL with comments stripped, so prose is not read as code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

describe('the streak layer, against the pass that has to show it', () => {
  /** How much of the 0..1 range one step of the retro pass's palette covers. */
  const bandStep = 1 / (RETRO_DEFAULTS.levels - 1);
  /** The ground the layer actually lands on. Water has its own, lower, amplitude. */
  const groundShades = Object.entries(TERRAIN_COLORS)
    .filter(([name]) => name !== 'water')
    .flatMap(([, pair]) => pair);
  /** The channel carrying a colour, which is the one that can cross a band first. */
  const strongestChannel = (hex: number): number =>
    Math.max((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff) / 255;

  it('swings far enough to cross a colour band on its own', () => {
    // The regression, stated as the arithmetic that was wrong. The layer is
    // multiplicative, so what it is worth on screen depends on the ground under
    // it, and a quantized channel only changes if something moves it more than
    // half a band. At the 5.5% this shipped at, the only shades clearing that
    // bar were sand and snow -- the two brightest in the palette and the two a
    // player sees least of. Grass, dirt and rock, which is most of the map,
    // cleared it nowhere, and that is precisely why nothing was visible.
    for (const shade of groundShades) {
      expect(WIND.streakContrast * strongestChannel(shade)).toBeGreaterThan(bandStep * 0.5);
    }
  });

  it('does not lean on the dither to carry it, because the dither cannot', () => {
    // What the original comment assumed. At the strength the view ships with,
    // the dither can move a value across a fortieth of a band -- nowhere near
    // enough to spread sub-step detail over an edge, so the layer must not need
    // it to. If the shipped dither is ever turned up this can be revisited;
    // until then, amplitude is the only thing that reaches a player.
    const ditherReach = (RETRO_DEFAULTS.ditherStrength * bandStep) / 2;
    expect(ditherReach).toBeLessThan(bandStep * 0.05);
  });

  it('keeps the sea quieter than the grass', () => {
    // The water is four flat colours by design; the grain the grass wants would
    // read there as a fifth and a sixth.
    expect(WIND.waterStreakContrast).toBeLessThan(WIND.streakContrast);
  });
});

describe('the gust front, which is the part that moves', () => {
  it('carries most of the swing', () => {
    // The grain is stretched along the axis it scrolls down, so it slides along
    // its own length and barely appears to move at all. The front is stretched
    // across the flow and travels perpendicular to its own bands, which is the
    // only motion in this layer the eye reads as wind.
    expect(WIND.gustShare).toBeGreaterThan(0.5);
  });

  it('crosses a point often enough to read as gusting, and not as flicker', () => {
    const secondsBetweenFronts = WIND.gustScale / WIND.streakSpeed;
    expect(secondsBetweenFronts).toBeGreaterThan(1);
    expect(secondsBetweenFronts).toBeLessThan(4);
  });

  it('turns over faster than the grain it rides on', () => {
    // The grain is squashed 4:1 along the flow by `windStreakField`, so that is
    // how far it must travel to become a different pattern. If the front were
    // the slower of the two this layer would be back to sliding along itself.
    const grainTurnover = (WIND.streakScale * 4) / WIND.streakSpeed;
    expect(WIND.gustScale / WIND.streakSpeed).toBeLessThan(grainTurnover);
  });
});

describe('the shader chunk the ground compiles', () => {
  const glsl = code(glslWindChunk());

  it('takes its amplitude from the caller rather than baking one in', () => {
    // Ground and sea are one field at one instant and two amplitudes. A
    // windStreak() that closed over a single constant is what forced the sea's
    // tolerance onto the grass.
    expect(glsl).toMatch(/float windStreak\(vec2 \w+, float \w+, float contrast\)/);
    expect(glsl).toContain('float windStreakField(');
  });

  it('declares a constant for each surface, and both are used', () => {
    for (const name of ['STREAK_GROUND', 'STREAK_WATER']) {
      expect(glsl).toContain(`const float ${name} =`);
    }
  });

  it('samples the front across the flow and the grain along it', () => {
    // The axis swap is the fix. `along.x` is the wind axis: the grain divides it
    // down (4:1 stretch along the flow), the front multiplies the *other* one
    // down instead, which lays its bands across the flow.
    expect(glsl).toContain('n2(vec2(along.x * 0.25, along.y) * STREAK_SCALE)');
    expect(glsl).toContain('n2(vec2(along.x, along.y * 0.2) * GUST_SCALE)');
  });
});

describe('the material patch', () => {
  it('carries the world position through to the fragment stage', () => {
    // The layer is sampled in world space so that two chunks meeting at a
    // border show one continuous field rather than two copies of it.
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchTerrainStreak(material);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <color_fragment>\n}',
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('varying vec3 vWindWorld;');
    expect(shader.vertexShader).toContain('modelMatrix * vec4( transformed, 1.0 )');
    expect(shader.fragmentShader).toContain('windStreak(vWindWorld.xz, uWindTime, STREAK_GROUND)');
  });

  it('hands the material the shared uniform objects, not copies of them', () => {
    // One clock. If these were cloned, the ground would drift out of step with
    // the trees the moment anything touched the weather panel.
    const material = new THREE.MeshLambertMaterial();
    patchTerrainStreak(material);
    const shader = { uniforms: {}, vertexShader: '', fragmentShader: '' };
    material.onBeforeCompile(shader as never, null as never);
    const second = new THREE.MeshLambertMaterial();
    patchTerrainStreak(second);
    const other = { uniforms: {}, vertexShader: '', fragmentShader: '' };
    second.onBeforeCompile(other as never, null as never);
    for (const name of ['uWindTime', 'uWindDir', 'uWindStrength']) {
      expect((shader.uniforms as Record<string, unknown>)[name]).toBe(
        (other.uniforms as Record<string, unknown>)[name],
      );
    }
  });
});
