import * as THREE from 'three';
import { glslWindChunk } from './wind.js';
import { windTimeUniform } from './wind-uniforms.js';

/**
 * The wind's streak layer over the ground (spec 073, part 3).
 *
 * The smallest piece of the weather and the one that ties it together. The
 * trees lean and the sea churns, and without this the land between them is
 * perfectly static -- which reads as two effects bolted onto a still scene
 * rather than as weather. A faint grain, scrolling downwind at the same speed
 * the water's does and in the same direction the trees lean, is enough to make
 * the coastline read as one place under one sky.
 *
 * Deliberately low contrast (5.5%). It has to survive the retro pass's colour
 * quantization (spec 038) without becoming a second set of visible bands: at
 * this amplitude it mostly moves pixels across a dither boundary, which is what
 * the rest of the frame already looks like.
 *
 * A patch on the existing Lambert materials rather than a material of its own,
 * so the ground keeps its vertex colours, its shadows and its lights.
 */

const STREAK_PROLOGUE = /* glsl */ `
varying vec3 vWindWorld;
${glslWindChunk()}
`;

/**
 * Multiply albedo, after the vertex colour has been folded in and before
 * lighting. `diffuseColor` is what three.js calls the surface's own colour at
 * that point, so this rides on top of the material rather than replacing it.
 */
const STREAK_APPLY = /* glsl */ `
  diffuseColor.rgb *= windStreak(vWindWorld.xz, uWindTime);
`;

/**
 * Splice the streak layer into a Lambert material.
 *
 * Idempotent in effect but not in cost -- calling it twice on one material
 * replaces the callback rather than stacking two of them, which is what makes
 * it safe to call from a mesher that rebuilds chunks.
 */
export function patchTerrainStreak(material: THREE.Material): void {
  material.onBeforeCompile = (shader): void => {
    shader.uniforms['uWindTime'] = windTimeUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWindWorld;')
      // The world position is already computed here for shadows and lights;
      // this only carries it through to the fragment stage.
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWindWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${STREAK_PROLOGUE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${STREAK_APPLY}`);
  };
  // Without a cache key three.js would hand a patched and an unpatched Lambert
  // the same compiled program, and which one won would depend on draw order.
  material.customProgramCacheKey = (): string => 'wind-streak';
  material.needsUpdate = true;
}
