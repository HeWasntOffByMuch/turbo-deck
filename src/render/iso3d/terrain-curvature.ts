import * as THREE from 'three';

/**
 * The three.js half of spec 100: carry the baked cavity through to the fragment
 * stage and darken the ground with it.
 *
 * The measure itself is in `curvature.ts`, which is pure and tested; the mesher
 * bakes one float per vertex. Everything here is plumbing.
 *
 * ## Why a uniform rather than the colour attribute
 *
 * The brief says "darken vertex colours", and baking it straight into the colour
 * is the obvious reading. It was not taken because that makes the toggle a
 * re-mesh of every chunk in the world, and the whole arc is built on being able
 * to switch each piece on and off and look at the difference. The value is still
 * computed once at mesh time from adjacent normals -- it is baked; it is carried
 * in its own channel so a checkbox costs a uniform write instead of 56 rebuilds.
 *
 * The uniforms object is shared by reference with the panel, the same arrangement
 * spec 075 uses for the weather.
 */

/** Written straight into by the view controls; read by the ground materials. */
export const CURVATURE_UNIFORMS = {
  /** How dark the deepest fold goes, 0..1. Zero is the feature switched off. */
  uCavityStrength: { value: 0 },
  /** 1 draws the baked cavity on its own, for the debug view. */
  uCavityOnly: { value: 0 },
};

const CURVATURE_APPLY = /* glsl */ `
  // After color_fragment, so this rides under the vertex colours rather than
  // replacing them -- and before lighting, so a crease is darker *material*
  // rather than a darker pixel, and still takes the sun and the shadows.
  diffuseColor.rgb *= 1.0 - uCavityStrength * clamp(vCavity, 0.0, 1.0);
`;

/**
 * The debug view: the baked measure on its own, white where the ground is flat
 * or domed and black in the deepest fold.
 *
 * Spliced after `opaque_fragment` -- i.e. after lighting has been resolved and
 * discarded -- rather than into `diffuseColor`, because a debug view that is
 * still lit is not the value; it is the value times the sun, which is exactly
 * the thing being separated out. The first version did that and every pixel in
 * the frame read as folded.
 *
 * At full scale regardless of strength: what was baked is a different question
 * from what is currently applied.
 */
const CURVATURE_ONLY = /* glsl */ `
  if (uCavityOnly > 0.5) gl_FragColor = vec4(vec3(1.0 - clamp(vCavity, 0.0, 1.0)), 1.0);
`;

/**
 * Splice the cavity term into a material that already carries other patches.
 *
 * Composed rather than assigned: `onBeforeCompile` is a single slot, and the
 * ground materials already hold the wind streak (spec 074). Overwriting it would
 * silently drop the weather, which is the kind of break that shows up as "the
 * grass stopped moving" three commits later.
 *
 * Only for geometry that actually carries the `cavity` attribute -- a patched
 * material drawing a mesh without it is a GL error, which is why the cliff walls
 * are left unpatched rather than given a column of zeroes.
 */
export function patchTerrainCurvature(material: THREE.Material): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;

  material.onBeforeCompile = function (shader, renderer): void {
    previousCompile.call(this, shader, renderer);
    Object.assign(shader.uniforms, CURVATURE_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float cavity;\nvarying float vCavity;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCavity = cavity;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vCavity;\nuniform float uCavityStrength;\nuniform float uCavityOnly;',
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${CURVATURE_APPLY}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${CURVATURE_ONLY}`);
  };

  // Combined with whatever the material already answered, so a patched and an
  // unpatched Lambert never share a compiled program.
  material.customProgramCacheKey = function (): string {
    return `${previousKey.call(this)}+curvature`;
  };
}
