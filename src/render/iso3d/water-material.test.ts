import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildWaterQuad,
  disposeWaterQuad,
  isWaterQuad,
  REFERENCE_IRRADIANCE,
  waterAlbedo,
  waterFragmentChunk,
} from './water-material.js';
import { WATER } from './wind.js';
import { srgbDecode, unpackLinear } from './hike.js';
import { skyAt } from './daynight.js';

/** GLSL with comments stripped, so a word in prose is not read as an identifier. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * The water shader is a *string* until a GPU sees it, so neither the type
 * system nor any amount of headless testing of what it computes will notice
 * that it does not compile (spec 074).
 *
 * It got shipped broken exactly once, and instructively: the art-direction
 * constants were substituted with a chain of `String.replace` calls, which take
 * a string pattern and replace the **first** occurrence only. Every constant
 * used twice compiled with its second use left as an undeclared identifier, and
 * the only thing that noticed was Chromium. What is checked here is the class of
 * mistake rather than that one instance: after substitution, every screaming-
 * case identifier in the source must be one the source itself declares.
 */
describe('the assembled water shader', () => {
  const source = code(waterFragmentChunk());

  it('leaves no identifier undeclared', () => {
    const declared = new Set<string>();
    for (const [, name] of source.matchAll(/\bconst\s+\w+\s+([A-Z][A-Z0-9_]*)\s*=/g)) {
      if (name) declared.add(name);
    }
    // Everything three.js supplies or GLSL defines that legitimately screams.
    const provided = new Set(['WIND_CHUNK']);
    const used = new Set<string>();
    for (const [name] of source.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) used.add(name);

    const undeclared = [...used].filter((name) => !declared.has(name) && !provided.has(name));
    expect(undeclared).toEqual([]);
    // ...and the scan actually found something, or an empty list means nothing.
    expect(declared.size).toBeGreaterThan(4);
  });

  it('substitutes every use of a constant, not just the first', () => {
    // The specific regression. SHORE_RANGE_VALUE is the placeholder; if any
    // survives, a constant went in unsubstituted.
    expect(source).not.toMatch(/\bSHORE_RANGE_VALUE\b/);
    // ...and one that is genuinely used more than once still resolves at both
    // sites, which is what the chain of replace() calls got wrong.
    expect(source.match(/\bSHORE_RANGE\b/g)?.length ?? 0).toBeGreaterThan(1);
  });

  it('declares the wind chunk it was handed', () => {
    expect(source).toContain('uniform float uWindTime;');
    expect(source).toContain('float warpedField(');
    expect(source).toContain('float bayer4(');
    expect(source).toContain('float windStreak(');
  });

  it('bands with step and never with smoothstep', () => {
    // The whole look. A soft boundary anywhere in here is the one change that
    // would quietly turn four flat colours back into a gradient.
    expect(source).not.toContain('smoothstep');
    expect(source.match(/\bstep\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('has nothing view-dependent in it', () => {
    // The camera angle is constant, so fresnel and reflection have one answer
    // and it is already in the palette. Anything that reads the eye vector here
    // is fill rate spent recomputing a constant.
    for (const banned of ['cameraPosition', 'viewMatrix', 'reflect(', 'refract(']) {
      expect(source).not.toContain(banned);
    }
  });

  it('hands the bands to three rather than writing the frame itself', () => {
    // Spec 259. The sea used to write gl_FragColor and so was the one surface
    // in the frame that no light reached; what it produces now is an albedo for
    // the Lambert shader underneath it to light.
    expect(source).toContain('diffuseColor.rgb = water;');
    expect(source).not.toContain('gl_FragColor');
    expect(source).not.toContain('colorspace_fragment');
  });

  it('keeps its locals out of three.js main()', () => {
    // Everything the patch declares sits inside a block of its own -- otherwise
    // a local three.js adds to main() in some later version collides with one of
    // these, and the ground materials go on compiling while the sea stops.
    //
    // The prologue ends at the one declaration it makes; what follows it is the
    // half spliced into main(), and all of it has to be inside one block.
    const applied = source.slice(source.indexOf(';', source.indexOf('SHORE_RANGE =')) + 1).trim();
    expect(applied.startsWith('{')).toBe(true);
    expect(applied.endsWith('}')).toBe(true);
    expect(applied).toContain('diffuseColor.rgb');
  });
});

/**
 * The palette stopped being output colour and became albedo (spec 259).
 *
 * The four hexes in `WATER` were authored as what the sea *looks like* under the
 * light the game opens on, so handing them to a lighting model unchanged would
 * multiply them by the irradiance a second time. They are divided by that light
 * once, at module load, and what makes that safe rather than a fudge is that the
 * division is exact: light the albedo with the very irradiance it was divided
 * by and the authored colour comes back.
 */
describe('the water albedo', () => {
  const palette = { deep: WATER.deep, mid: WATER.mid, shallow: WATER.shallow, foam: WATER.foam };

  it('reproduces every authored colour under the light it was authored in', () => {
    for (const [name, hex] of Object.entries(palette)) {
      const albedo = waterAlbedo(hex);
      const authored = unpackLinear(hex);
      for (let i = 0; i < 3; i++) {
        // `BRDF_Lambert` is `RECIPROCAL_PI * diffuseColor`, so the shader
        // divides by PI on the way out and the albedo carries it on the way in.
        const lit = ((albedo[i] as number) * (REFERENCE_IRRADIANCE[i] as number)) / Math.PI;
        expect(lit, `${name} channel ${i}`).toBeCloseTo(authored[i] as number, 12);
      }
    }
  });

  it('is brighter than the colour it stands for, in every channel', () => {
    // The reference frame delivers more than one unit of irradiance per PI, so
    // an albedo that reproduces it has to be scaled up. A scale at or below 1
    // means the PI went missing, which is a third of the sea's brightness.
    for (const hex of Object.values(palette)) {
      const albedo = waterAlbedo(hex);
      const authored = unpackLinear(hex);
      for (let i = 0; i < 3; i++) {
        expect(albedo[i] as number).toBeGreaterThan(authored[i] as number);
      }
    }
  });

  it('lets foam past 1 rather than clamping it', () => {
    // Nothing between `diffuseColor` and `<opaque_fragment>` clamps, so the
    // brightest band is free to exceed 1 and land back on its authored value.
    // Clamping here would darken foam in every frame at every hour.
    expect(Math.max(...waterAlbedo(WATER.foam))).toBeGreaterThan(1);
  });
});

/**
 * ...and now that it is albedo, the clock reaches it. This is the whole of what
 * spec 259 is for: the sea was drawn at full daylight brightness at midnight,
 * against land at a twelfth of it.
 */
describe('the sea under the day/night ramp', () => {
  /**
   * The irradiance a flat, up-facing surface takes from one hour of the ramp.
   * Written out here rather than imported so the assertions below are measured
   * against arithmetic this file did itself.
   */
  function irradianceAt(hours: number): readonly [number, number, number] {
    const sky = skyAt(hours);
    const dotNL = Math.max(0, sky.lightDirection.y);
    const channel = (ambient: number, key: number): number =>
      srgbDecode(ambient) * sky.ambientIntensity + srgbDecode(key) * sky.lightIntensity * dotNL;
    return [
      channel(sky.ambientColor.r, sky.lightColor.r),
      channel(sky.ambientColor.g, sky.lightColor.g),
      channel(sky.ambientColor.b, sky.lightColor.b),
    ];
  }

  /** How bright the sea reads at an hour, against the frame it was authored in. */
  function relative(hours: number): readonly [number, number, number] {
    const now = irradianceAt(hours);
    return [0, 1, 2].map(
      (i) => (now[i] as number) / (REFERENCE_IRRADIANCE[i] as number),
    ) as unknown as readonly [number, number, number];
  }

  it('goes dark at night and bright at noon', () => {
    const midnight = relative(0);
    const noon = relative(12);
    for (let i = 0; i < 3; i++) {
      // A fifth of the authored brightness at worst, and never more than half.
      expect(midnight[i] as number).toBeLessThan(0.5);
      expect(noon[i] as number).toBeGreaterThan(1);
    }
    // The measurement the spec leads with: the sea used to be drawn at 1.0 here.
    expect(midnight[0] as number).toBeLessThan(0.1);
  });

  it('takes the colour of the night and not only its level', () => {
    // The ramp's night is cool, and a sea that dimmed without cooling would be
    // a grey hole in a blue frame. Blue survives the night by a wide margin
    // over red; at noon the three channels are within a few percent.
    const midnight = relative(0);
    expect(midnight[2] as number).toBeGreaterThan((midnight[0] as number) * 2);
    const noon = relative(12);
    expect(Math.abs((noon[2] as number) - (noon[0] as number))).toBeLessThan(0.1);
  });
});

/**
 * The patch is four `String.replace` calls into somebody else's shader, and a
 * `replace` that matches nothing is a **no-op**: a three.js upgrade that renamed
 * one of these anchors would leave the sea a plain unshaded quad with every
 * assertion above still green. So they are pinned against three's own Lambert
 * source rather than written out here.
 */
describe('the anchors the patch reaches for', () => {
  it('are ones three.js actually has', () => {
    for (const anchor of ['#include <common>', '#include <begin_vertex>']) {
      expect(THREE.ShaderLib.lambert.vertexShader).toContain(anchor);
    }
    for (const anchor of ['#include <common>', '#include <color_fragment>']) {
      expect(THREE.ShaderLib.lambert.fragmentShader).toContain(anchor);
    }
  });

  it('put the bands in before anything lights them', () => {
    // `<color_fragment>` has to come before the lighting reads `diffuseColor`,
    // or the sea is lit as plain white and the palette is thrown away.
    const fragment = THREE.ShaderLib.lambert.fragmentShader;
    expect(fragment.indexOf('#include <color_fragment>')).toBeLessThan(
      fragment.indexOf('#include <lights_lambert_fragment>'),
    );
  });

  it("are reached, and bind one shared palette beside the chunk's own field", () => {
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <color_fragment>\n}',
    };
    const mesh = buildWaterQuad({
      originX: 0,
      originZ: 0,
      width: 40,
      depth: 40,
      waterLevel: -4,
      cellSize: 10,
      field: { cols: 4, rows: 4, data: new Uint8Array(16) },
    });
    const material = mesh.material as THREE.Material;
    material.onBeforeCompile(shader as never, null as never);

    expect(shader.vertexShader).toContain('vWaterWorld = ( modelMatrix');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = water;');
    // Both stages declare the varying, or it is a link error rather than a
    // compile one and only a GPU would say so.
    expect(shader.vertexShader).toContain('varying vec3 vWaterWorld;');
    expect(shader.fragmentShader).toContain('varying vec3 vWaterWorld;');
    for (const bound of ['uWindTime', 'uDeep', 'uMid', 'uShallow', 'uFoam', 'uShoreField']) {
      expect(shader.uniforms[bound]).toBeDefined();
    }
    // One key for every chunk, so the per-chunk material a shore texture forces
    // costs a texture bind rather than a shader switch.
    expect(material.customProgramCacheKey()).toBe('water');
    disposeWaterQuad(mesh);
  });
});

/**
 * A patched built-in material has no `.uniforms`, so the shore texture it owns
 * has to be held somewhere for the dispose path to reach -- and "is this one of
 * ours" has to stay answerable, since the test that asked it before spec 259
 * asked `material instanceof THREE.ShaderMaterial`.
 */
describe('a water quad', () => {
  function quad(): THREE.Mesh {
    return buildWaterQuad({
      originX: 0,
      originZ: 0,
      width: 40,
      depth: 40,
      waterLevel: -4,
      cellSize: 10,
      field: { cols: 4, rows: 4, data: new Uint8Array(16) },
    });
  }

  it('is one of ours, and a plain mesh is not', () => {
    expect(isWaterQuad(quad())).toBe(true);
    expect(isWaterQuad(new THREE.Mesh(new THREE.PlaneGeometry(1, 1)))).toBe(false);
  });

  it('neither casts the sun nor takes its shade', () => {
    // Being lit and receiving shadow are separate switches, and spec 259 threw
    // only the first: a shadow on a flat stylized surface reads as dirt on it.
    const mesh = quad();
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
  });

  it('frees its own shore texture and stops answering for it', () => {
    const mesh = quad();
    let disposed = 0;
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <color_fragment>\n}',
    };
    (mesh.material as THREE.Material).onBeforeCompile(shader as never, null as never);
    const texture = shader.uniforms['uShoreField']?.value as THREE.DataTexture;
    texture.addEventListener('dispose', () => {
      disposed += 1;
    });

    disposeWaterQuad(mesh);
    expect(disposed).toBe(1);
    // The table the dispose path reads is the same one `isWaterQuad` answers
    // from, so a freed quad cannot go on being recognised as a live one.
    expect(isWaterQuad(mesh)).toBe(false);
  });
});
