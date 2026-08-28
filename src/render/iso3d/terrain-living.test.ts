import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIVING_GROUND_UNIFORMS,
  livingGroundSettings,
  patchTerrainLiving,
  resetLivingGround,
  setLivingGround,
} from './terrain-living.js';
import { patchTerrainStreak } from './terrain-streak.js';
import { patchTerrainCurvature } from './terrain-curvature.js';
import { patchTerrainDetail } from './terrain-detail.js';
import { LIVING_GROUND, LIVING_GROUND_LIMITS, glslLivingGround } from './living-ground.js';

/**
 * The material patch (spec 252).
 *
 * `living-ground.test.ts` holds what the layer *is*; this holds whether it is
 * wired to anything, which on this material is a question about **order**. Four
 * patches now share one `onBeforeCompile` slot and one `#include <color_fragment>`,
 * and every one of the ways that goes wrong is invisible until a browser
 * compiles a shader: a declaration after its use, a chunk declared twice, a
 * previous patch dropped on the floor, or the cavity attribute reaching a
 * material whose geometry has no such column.
 *
 * So what is driven here is the composition `terrain-mesh.ts` actually builds,
 * in its actual order, and the assertions are about relative position in the
 * assembled source.
 */

/**
 * A stand-in for the shader three.js hands `onBeforeCompile`, with every anchor
 * the four patches reach for.
 *
 * `void main()` is the one this patch depends on that is not an `#include`, so
 * it is taken from three's own Lambert source rather than written out here --
 * see the test that does so below.
 */
function shaderStub(): { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string } {
  return {
    uniforms: {},
    vertexShader: [
      '#include <common>',
      'void main() {',
      '#include <begin_vertex>',
      '#include <defaultnormal_vertex>',
      '}',
    ].join('\n'),
    fragmentShader: [
      '#include <common>',
      'void main() {',
      '#include <color_fragment>',
      '#include <opaque_fragment>',
      '}',
    ].join('\n'),
  };
}

/** The surface material as `terrain-mesh.ts` builds it: all four, in that order. */
function surfaceShader(): ReturnType<typeof shaderStub> {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  patchTerrainStreak(material);
  patchTerrainCurvature(material);
  patchTerrainDetail(material);
  patchTerrainLiving(material);
  const shader = shaderStub();
  material.onBeforeCompile(shader as never, null as never);
  return shader;
}

afterEach(() => {
  resetLivingGround();
});

describe('the anchor this patch depends on', () => {
  it('is in three.js\'s own Lambert fragment shader', () => {
    // The declarations go at the top of `main`, which is the one place after
    // every `#include` and before anything that could use them. If a three.js
    // upgrade reshapes that line the splice silently does nothing and the ground
    // becomes a compile error in a browser -- which is precisely what a Node
    // suite cannot see, so it is asserted against three's source rather than
    // against a copy of it.
    expect(THREE.ShaderLib.lambert.fragmentShader).toMatch(/void main\(\)\s*\{/);
  });
});

describe('the four patches, composed the way the surface material composes them', () => {
  it('keeps every one of them', () => {
    // `onBeforeCompile` is a single slot. Assigning rather than wrapping drops
    // the weather, which shows up as "the grass stopped moving" three commits
    // later and is the reason every patch on this material wraps.
    const shader = surfaceShader();
    expect(shader.fragmentShader).toContain('windStreak(vWindWorld.xz, uWindTime, STREAK_GROUND)');
    expect(shader.fragmentShader).toContain('uCavityStrength');
    expect(shader.fragmentShader).toContain('triplanarDetail(uDetailMap');
    expect(shader.fragmentShader).toContain('livingGround(diffuseColor.rgb');
  });

  it('names all four in the program cache key', () => {
    // Without it three.js hands two differently-patched Lamberts the same
    // compiled program and which one wins depends on draw order.
    const material = new THREE.MeshLambertMaterial();
    patchTerrainStreak(material);
    patchTerrainCurvature(material);
    patchTerrainDetail(material);
    patchTerrainLiving(material);
    expect(material.customProgramCacheKey()).toBe('wind-streak+curvature+detail+living');
  });

  it('declares the living ground after the wind chunk it reads', () => {
    // The bug this test was written for. Anchored on `#include <common>` like
    // its three neighbours, this chunk lands *in front of* them -- each patch
    // matches the original include and inserts before whatever the last one put
    // there -- so `hash21` and `uWindDir` would have been used a hundred lines
    // above their declarations.
    const src = surfaceShader().fragmentShader;
    expect(src.indexOf('float hash21(')).toBeGreaterThan(-1);
    expect(src.indexOf('float grassNoise(')).toBeGreaterThan(src.indexOf('float hash21('));
    expect(src.indexOf('float grassNoise(')).toBeGreaterThan(src.indexOf('uniform vec2 uWindDir;'));
  });

  it('declares every name it introduces exactly once in the assembled shader', () => {
    // **The regression this file was written for.** The first version of the
    // chunk declared a `GUST_ASPECT` that `GLSL_STREAK` already had, which is a
    // fragment shader that does not compile -- on the ground materials only, in
    // a browser, with all 28 tests in `living-ground.test.ts` green and the
    // terrain simply not drawn. `npx tsx scripts/probe-shading.ts` found it;
    // this is the same question asked where it costs a second.
    //
    // The whole assembled source, so it also covers a collision with three.js's
    // own chunks and with the detail patch, not only with the wind's.
    const src = surfaceShader().fragmentShader;
    const chunk = glslLivingGround();
    const declared = [
      ...[...chunk.matchAll(/^const\s+\w+\s+(\w+)\s*=/gm)].map((m) => m[1] ?? ''),
      ...[...chunk.matchAll(/^\w+\s+(\w+)\s*\(/gm)].map((m) => m[1] ?? ''),
      ...[...chunk.matchAll(/^uniform\s+\w+\s+(\w+);/gm)].map((m) => m[1] ?? ''),
    ].filter(Boolean);
    expect(declared.length).toBeGreaterThan(30);
    for (const name of declared) {
      const declarations = src.match(
        new RegExp(`^(?:const\\s+\\w+|uniform\\s+\\w+|\\w+)\\s+${name}\\s*[=(;]`, 'gm'),
      );
      expect(`${name}: ${declarations?.length ?? 0}`).toBe(`${name}: 1`);
    }
  });

  it('declares the two varyings it borrows rather than a second copy of them', () => {
    // `vWindWorld` is the streak's world position and `vDetailNormal` the
    // detail's world normal, both already carried for their own sake. This patch
    // has no vertex half at all because of it, and re-declaring either would be
    // a redefinition error -- and two more varyings on a material that is
    // already deep into the budget.
    const shader = surfaceShader();
    const src = shader.fragmentShader;
    expect(src.split('varying vec3 vWindWorld;').length - 1).toBe(1);
    expect(src.split('varying vec3 vDetailNormal;').length - 1).toBe(1);
    expect(src).toContain('livingGround(diffuseColor.rgb, vWindWorld, normalize(vDetailNormal), uWindTime)');
    // ...and both are written in the vertex stage, by the patches that own them.
    expect(shader.vertexShader).toContain('vWindWorld = ');
    expect(shader.vertexShader).toContain('vDetailNormal = ');
  });

  it('runs first, on the raw vertex colour', () => {
    // Which is what the grass mask needs: it is a chromaticity test standing in
    // for a material id, so it has to read the colour the mesher painted rather
    // than one the rock blend has already pushed toward stone.
    const src = surfaceShader().fragmentShader;
    // Measured inside `main`, after the include the four of them splice onto:
    // `rockBlend` and `triplanarDetail` are *defined* in the prologue as well as
    // called here, so searching the whole file finds the definition and reports
    // a correct order as a broken one.
    const body = src.slice(src.indexOf('#include <color_fragment>'));
    const living = body.indexOf('livingGround(diffuseColor.rgb');
    expect(living).toBeGreaterThan(-1);
    for (const later of [
      'rockBlend(',
      'triplanarDetail(uDetailMap',
      'uCavityStrength * clamp(vCavity',
      'windStreak(vWindWorld.xz',
    ]) {
      expect(body.indexOf(later)).toBeGreaterThan(living);
    }
  });

  it('adds nothing to the vertex stage', () => {
    // The ground does not move. Comparing against the same chain without this
    // patch is stronger than asserting an absence, because it also catches a
    // vertex splice arriving by some other route.
    const without = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchTerrainStreak(without);
    patchTerrainCurvature(without);
    patchTerrainDetail(without);
    const plain = shaderStub();
    without.onBeforeCompile(plain as never, null as never);
    expect(surfaceShader().vertexShader).toBe(plain.vertexShader);
  });
});

describe('the uniforms', () => {
  it('are shared by reference between two patched materials', () => {
    // One ground. If these were cloned, the map editor and the play view would
    // be tuning two different meadows.
    const first = new THREE.MeshLambertMaterial();
    patchTerrainStreak(first);
    patchTerrainLiving(first);
    const a = shaderStub();
    first.onBeforeCompile(a as never, null as never);

    const second = new THREE.MeshLambertMaterial();
    patchTerrainStreak(second);
    patchTerrainLiving(second);
    const b = shaderStub();
    second.onBeforeCompile(b as never, null as never);

    for (const name of Object.keys(LIVING_GROUND_UNIFORMS)) {
      expect(a.uniforms[name]).toBe(b.uniforms[name]);
    }
  });

  it('open at the ground the world is art-directed for', () => {
    expect(livingGroundSettings()).toEqual(LIVING_GROUND);
  });

  it('take a partial patch without disturbing what it does not name', () => {
    setLivingGround({ macroStrength: 0.2 });
    const after = livingGroundSettings();
    expect(after.macroStrength).toBeCloseTo(0.2, 6);
    expect(after.detailStrength).toBe(LIVING_GROUND.detailStrength);
    expect(after.base).toBe(LIVING_GROUND.base);
  });

  it('clamp a scale away from zero, because every one of them is inverted', () => {
    setLivingGround({ macroScale: 0, detailScale: -5, microScale: 1e9 });
    const after = livingGroundSettings();
    expect(after.macroScale).toBe(LIVING_GROUND_LIMITS.minScale);
    expect(after.detailScale).toBe(LIVING_GROUND_LIMITS.minScale);
    expect(after.microScale).toBe(LIVING_GROUND_LIMITS.maxMicroScale);
  });

  it('clamp every strength into the range its colours were chosen in', () => {
    setLivingGround({ amount: 4, macroStrength: -1, gustBrightness: 2 });
    const after = livingGroundSettings();
    expect(after.amount).toBe(LIVING_GROUND_LIMITS.maxStrength);
    expect(after.macroStrength).toBe(LIVING_GROUND_LIMITS.minStrength);
    expect(after.gustBrightness).toBe(LIVING_GROUND_LIMITS.maxStrength);
  });

  it('keep the slope ramp the right way round', () => {
    // `slopeSteepness` reads the pair as a ramp and a reversed one reports a
    // cliff as flat ground -- so the end is clamped against the start rather
    // than merely against 0..1.
    setLivingGround({ slopeStart: 0.5, slopeEnd: 0.9 });
    const after = livingGroundSettings();
    expect(after.slopeEnd).toBeLessThanOrEqual(after.slopeStart);
  });

  it('carry the colours decoded to linear, which is the space the shader adds in', () => {
    // The vertex colours the patch is handed are linear (`terrain-arrays.ts`
    // decodes them at mesh time), so an sRGB uniform beside them would be a
    // palette that is right in a picker and wrong on the ground.
    const base = LIVING_GROUND_UNIFORMS.uGrassBase.value;
    expect(base.getHex()).toBe(LIVING_GROUND.base);
    expect(base.r).toBeLessThan(((LIVING_GROUND.base >> 16) & 0xff) / 255);
  });

  it('put everything back, including what no slider owns', () => {
    setLivingGround({ amount: 0, base: 0x112233, slopeStart: 0.1, slopeEnd: 0.05, shelter: 1 });
    resetLivingGround();
    expect(livingGroundSettings()).toEqual(LIVING_GROUND);
  });
});
