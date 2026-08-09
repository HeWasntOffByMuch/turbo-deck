import * as THREE from 'three';
import { SHADOW_POISSON_DISK, glslPoissonShadow } from './poisson.js';

/**
 * Poisson-disc PCF for the sun's shadow (spec 105), installed once into three's
 * own shadow chunk.
 *
 * ## Why one global patch and not a patch per material
 *
 * The filter has to reach everything that receives a shadow -- the ground, the
 * cliff walls, the props, the units, the critters -- and those are many materials
 * with patches already on them. `onBeforeCompile` is a single slot, so each one
 * would have to compose (spec 104 had to do that dance for one material, and got
 * it wrong first). Patching `ShaderChunk.shadowmap_pars_fragment` reaches all of
 * them at once, because they all `#include` it.
 *
 * ## Why there is no uniform
 *
 * There is nowhere to put one. Uniform groups are merged into `ShaderLib` when
 * three.js loads, before any of this runs, so a uniform added afterwards never
 * propagates to a built-in material -- and adding it per material puts us back in
 * the paragraph above.
 *
 * `shadowRadius` is already there. three.js uploads `light.shadow.radius` for
 * every light whatever the shadow map type, and `BasicShadowMap` -- which this
 * project uses (spec 045) -- ignores it. So the unfiltered branch becomes a
 * choice between the single tap it already took and the Poisson taps, keyed on a
 * number that is already plumbed. Throwing the switch is then a property write
 * per frame: no recompile, no enumeration, nothing to keep in sync.
 */

/** The line three.js takes when no percentage-closer filtering is compiled in. */
const UNFILTERED = 'shadow = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );';

const BRANCHED = /* glsl */ `shadow = shadowRadius > 0.0
			? hikePoissonShadow( shadowMap, shadowMapSize, shadowCoord.xy, shadowCoord.z, shadowRadius )
			: texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );`;

/** Where the filter is spliced in: immediately before the function that calls it. */
const ENTRY = 'float getShadow( sampler2D shadowMap,';

let installed = false;

/**
 * Splice the filter into three's shadow chunk. Safe to call repeatedly; only the
 * first call does anything.
 *
 * Idempotent on purpose rather than by luck. Applying it twice would redefine a
 * GLSL function, which does not compile -- and three.js *logs* a failed compile
 * and carries on, so the frame would keep rendering off a fallback while the note
 * scrolled past. Both anchors are asserted for the same reason: a `replace` that
 * matches nothing is silent, and spec 074 shipped exactly that bug once.
 */
export function installPoissonShadows(): void {
  if (installed) return;
  installed = true;

  const chunk = THREE.ShaderChunk['shadowmap_pars_fragment'] ?? '';
  if (!chunk.includes(UNFILTERED)) {
    throw new Error('shadowmap_pars_fragment has no unfiltered branch to replace (three.js changed)');
  }
  if (!chunk.includes(ENTRY)) {
    throw new Error('shadowmap_pars_fragment has no getShadow to splice in front of (three.js changed)');
  }

  THREE.ShaderChunk['shadowmap_pars_fragment'] = chunk
    .replace(ENTRY, `${glslPoissonShadow(SHADOW_POISSON_DISK)}\n\t${ENTRY}`)
    .replace(UNFILTERED, BRANCHED);
}

/**
 * What to put in `light.shadow.radius` for the given settings.
 *
 * Zero switches the filter off, which is not three's default -- `radius` starts
 * at 1 -- so this has to be written even when the feature is off, or ticking
 * nothing would still soften every shadow in the world.
 */
export function shadowRadiusFor(softShadows: boolean, pcfRadius: number): number {
  return softShadows ? Math.max(0, pcfRadius) : 0;
}
