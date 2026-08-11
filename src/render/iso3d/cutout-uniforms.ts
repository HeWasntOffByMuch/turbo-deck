import * as THREE from 'three';

import { CUTOUT_APPLY, CUTOUT_PROLOGUE, CUTOUT_VERTEX_APPLY, CUTOUT_VERTEX_PROLOGUE, CUTOUT_OFF } from './cutout.js';

/**
 * The three.js half of the cutaway (spec 126).
 *
 * One uniform object per value in the process, handed to every material that
 * can stand between the camera and a body -- the same arrangement
 * `wind-uniforms.ts` uses, and for the same reason: a second copy of "where the
 * body is" cannot be introduced by accident when there is no second place to
 * write one.
 *
 * The default is **off**. Every view that never writes these draws exactly what
 * it drew before, which matters because the materials are module-level
 * singletons shared with the map editor -- a tab with no body in it.
 */

/** The body's position in view space. Written once a frame by the Play view. */
export const cutBodyUniform: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0, 0) };

/** `(inner, outer, depthBias)`. An outer of zero is off. */
export const cutParamsUniform: THREE.IUniform<THREE.Vector3> = {
  value: new THREE.Vector3(CUTOUT_OFF.inner, CUTOUT_OFF.outer, CUTOUT_OFF.depthBias),
};

/**
 * Spread rather than copied: `{...CUTOUT_UNIFORMS}` makes a new object holding
 * the *same* `IUniform` instances, which is the sharing this module is for.
 */
export const CUTOUT_UNIFORMS = {
  uCutBody: cutBodyUniform,
  uCutParams: cutParamsUniform,
};

/** Stop cutting. Called when the Play view unmounts, so no tab inherits a hole. */
export function clearCutout(): void {
  cutParamsUniform.value.set(0, 0, 0);
}

/**
 * Teach one material to give way in front of a body.
 *
 * Patched in the same style as the wind's streak layer, including the cache
 * key: without one, three.js hands a patched and an unpatched Lambert the same
 * compiled program and which wins depends on draw order.
 *
 * `tag` distinguishes this material's program from another patched material's,
 * since several of these are composed with other patches on the same base type.
 */
export function patchCutout(material: THREE.Material, tag: string): void {
  const existing = material.onBeforeCompile;
  const existingKey = material.customProgramCacheKey?.bind(material);

  /**
   * Splice after an anchor, and refuse to do it quietly if the anchor is gone.
   *
   * Every one of these is an `#include` that another patch is free to have
   * expanded already -- `applySway` replaces `#include <project_vertex>` with
   * its own source outright, which is why the prop field is not patched here.
   * A `String.replace` that matches nothing returns the string unchanged, so
   * without this the cutout would compile perfectly and cut nothing, on exactly
   * the materials somebody had just added another effect to.
   */
  const splice = (source: string, anchor: string, addition: string, where: string): string => {
    if (!source.includes(anchor)) {
      throw new Error(
        `patchCutout(${tag}): no \`${anchor}\` left in the ${where} shader -- another patch has already expanded it. ` +
          `Anchor somewhere it survives, or this compiles and cuts nothing.`,
      );
    }
    return source.replace(anchor, `${anchor}\n${addition}`);
  };

  material.onBeforeCompile = (shader, renderer): void => {
    // Composed rather than replacing: the terrain's materials already carry the
    // wind streak and the triplanar detail, and dropping either to make room
    // for this would be a silent regression in two other specs.
    existing?.call(material, shader, renderer);
    Object.assign(shader.uniforms, CUTOUT_UNIFORMS);
    shader.vertexShader = splice(shader.vertexShader, '#include <common>', CUTOUT_VERTEX_PROLOGUE, 'vertex');
    // `project_vertex` is where `mvPosition` exists: before it there is no view
    // position to carry, and by `fog_vertex` it is out of scope.
    shader.vertexShader = splice(shader.vertexShader, '#include <project_vertex>', CUTOUT_VERTEX_APPLY, 'vertex');
    shader.fragmentShader = splice(shader.fragmentShader, '#include <common>', CUTOUT_PROLOGUE, 'fragment');
    // First thing in the body, so a cut fragment costs no lighting.
    shader.fragmentShader = splice(
      shader.fragmentShader,
      '#include <clipping_planes_fragment>',
      CUTOUT_APPLY,
      'fragment',
    );
  };
  material.customProgramCacheKey = (): string => `cutout:${tag}:${existingKey?.() ?? ''}`;
  material.needsUpdate = true;
}
