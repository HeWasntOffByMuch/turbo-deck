import * as THREE from 'three';
import {
  LIVING_GROUND,
  LIVING_GROUND_LIMITS,
  glslLivingGround,
  type LivingGroundConfig,
} from './living-ground.js';

/**
 * The three.js half of the living ground (spec 250): the uniform objects the
 * weather panel writes through, and the patch that splices the surface shader
 * into the ground material.
 *
 * The maths and the art direction are in `living-ground.ts`, which is pure and
 * tested. Everything here is plumbing and clamping.
 *
 * ## Written, not polled
 *
 * There is exactly one uniform object per value in the process, handed to the
 * material *by reference* -- the arrangement `wind-uniforms.ts` established and
 * for its reason: a second source of truth for how the ground looks cannot be
 * introduced by accident, because there is no second place to write one. The
 * weather panel pushes into these when a slider moves; nothing polls them, and
 * the per-frame cost of the whole layer is zero writes.
 *
 * ## Where it sits in the chain
 *
 * Applied **fourth**, after `patchTerrainStreak`, `patchTerrainCurvature` and
 * `patchTerrainDetail`, and that is a requirement rather than a preference. Two
 * things follow from it, and they are the reason the order is stated in
 * `terrain-mesh.ts` as well as here:
 *
 * - It **depends on the streak patch**. `hash21`, `uWindDir` and `uWindTime` come
 *   from `glslWindChunk()`, which that patch splices in, and `vWindWorld` is the
 *   world position it already carries to the fragment stage. `vDetailNormal` is
 *   the world normal the detail patch already carries. Re-declaring either
 *   varying would cost two more of a budget this material is already deep into,
 *   and re-declaring the noise would be a redefinition error.
 * - It **runs first**. Every one of these patches splices after
 *   `#include <color_fragment>`, and each one's replacement lands in front of
 *   whatever the previous patches inserted -- so the last patch applied is the
 *   first code to execute. That is what this one wants: the albedo it is handed
 *   is the raw vertex colour, which is what the grass mask reads, and the rock
 *   blend, the detail, the creases and the streak then ride on top of the
 *   surface it produced.
 */

/**
 * Where the declarations go: the top of the fragment shader's `main`, which is
 * after every `#include` three.js assembles and before anything that could use
 * them.
 *
 * Tolerant of the whitespace because it is somebody else's source. If a three.js
 * upgrade ever changes the shape of that line the splice silently does nothing
 * and the ground turns into a compile error, so `terrain-living.test.ts` asserts
 * the anchor against `THREE.ShaderLib.lambert` itself rather than against a
 * string this file also wrote.
 */
const MAIN_ANCHOR = /void main\(\)\s*\{/;

/** A packed sRGB hex as a linear `THREE.Color`, the way every colour here is carried. */
function linear(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Written straight into by the weather panel; read by the ground surface material. */
export const LIVING_GROUND_UNIFORMS = {
  uGrassAmount: { value: LIVING_GROUND.amount },
  uGrassBase: { value: linear(LIVING_GROUND.base) },
  uGrassDark: { value: linear(LIVING_GROUND.dark) },
  uGrassLight: { value: linear(LIVING_GROUND.light) },
  uGrassDry: { value: linear(LIVING_GROUND.dry) },
  uGrassMacroScale: { value: LIVING_GROUND.macroScale },
  uGrassMacroStrength: { value: LIVING_GROUND.macroStrength },
  uGrassDetailScale: { value: LIVING_GROUND.detailScale },
  uGrassDetailStrength: { value: LIVING_GROUND.detailStrength },
  uGrassDetailDensity: { value: LIVING_GROUND.detailDensity },
  uGrassWindScale: { value: LIVING_GROUND.windScale },
  uGrassWindSpeed: { value: LIVING_GROUND.windSpeed },
  uGrassWindStrength: { value: LIVING_GROUND.windStrength },
  uGrassGustScale: { value: LIVING_GROUND.gustScale },
  uGrassGustContrast: { value: LIVING_GROUND.gustContrast },
  uGrassGustBrightness: { value: LIVING_GROUND.gustBrightness },
  uGrassMicroScale: { value: LIVING_GROUND.microScale },
  uGrassMicroStrength: { value: LIVING_GROUND.microStrength },
  uGrassSlopeStart: { value: LIVING_GROUND.slopeStart },
  uGrassSlopeEnd: { value: LIVING_GROUND.slopeEnd },
  uGrassSlopeStrength: { value: LIVING_GROUND.slopeStrength },
  uGrassShelter: { value: LIVING_GROUND.shelter },
};

/**
 * Push part of a configuration into the live uniforms.
 *
 * Clamped against {@link LIVING_GROUND_LIMITS} on the way in, because these are
 * reachable from a slider, from a probe and from a console -- and every scale is
 * inverted in the shader, so a zero is a division rather than a look. A partial
 * patch rather than a whole config, so a panel row can write the one field it
 * owns without restating twenty it does not.
 */
export function setLivingGround(patch: Partial<LivingGroundConfig>): void {
  const u = LIVING_GROUND_UNIFORMS;
  const L = LIVING_GROUND_LIMITS;
  const strength = (v: number): number => clamp(v, L.minStrength, L.maxStrength);

  if (patch.amount !== undefined) u.uGrassAmount.value = strength(patch.amount);
  if (patch.base !== undefined) u.uGrassBase.value.setHex(patch.base);
  if (patch.dark !== undefined) u.uGrassDark.value.setHex(patch.dark);
  if (patch.light !== undefined) u.uGrassLight.value.setHex(patch.light);
  if (patch.dry !== undefined) u.uGrassDry.value.setHex(patch.dry);

  if (patch.macroScale !== undefined) u.uGrassMacroScale.value = clamp(patch.macroScale, L.minScale, L.maxMacroScale);
  if (patch.macroStrength !== undefined) u.uGrassMacroStrength.value = strength(patch.macroStrength);

  if (patch.detailScale !== undefined) u.uGrassDetailScale.value = clamp(patch.detailScale, L.minScale, L.maxDetailScale);
  if (patch.detailStrength !== undefined) u.uGrassDetailStrength.value = strength(patch.detailStrength);
  if (patch.detailDensity !== undefined) u.uGrassDetailDensity.value = strength(patch.detailDensity);

  if (patch.windScale !== undefined) u.uGrassWindScale.value = clamp(patch.windScale, L.minScale, L.maxWindScale);
  if (patch.windSpeed !== undefined) u.uGrassWindSpeed.value = clamp(patch.windSpeed, L.minSpeed, L.maxSpeed);
  if (patch.windStrength !== undefined) u.uGrassWindStrength.value = strength(patch.windStrength);

  if (patch.gustScale !== undefined) u.uGrassGustScale.value = clamp(patch.gustScale, L.minScale, L.maxGustScale);
  if (patch.gustContrast !== undefined) u.uGrassGustContrast.value = strength(patch.gustContrast);
  if (patch.gustBrightness !== undefined) u.uGrassGustBrightness.value = strength(patch.gustBrightness);

  if (patch.microScale !== undefined) u.uGrassMicroScale.value = clamp(patch.microScale, L.minScale, L.maxMicroScale);
  if (patch.microStrength !== undefined) u.uGrassMicroStrength.value = strength(patch.microStrength);

  // Clamped against each other as well as against 0..1: `slopeSteepness` reads
  // the pair as a ramp, and a reversed one is a hillside that reads as flat.
  if (patch.slopeStart !== undefined) u.uGrassSlopeStart.value = clamp(patch.slopeStart, 0, 1);
  if (patch.slopeEnd !== undefined) {
    u.uGrassSlopeEnd.value = clamp(patch.slopeEnd, 0, Math.min(1, u.uGrassSlopeStart.value));
  }
  if (patch.slopeStrength !== undefined) u.uGrassSlopeStrength.value = strength(patch.slopeStrength);

  if (patch.shelter !== undefined) u.uGrassShelter.value = strength(patch.shelter);
}

/** What the uniforms currently say. For tests, probes and a panel reading back. */
export function livingGroundSettings(): LivingGroundConfig {
  const u = LIVING_GROUND_UNIFORMS;
  return {
    amount: u.uGrassAmount.value,
    base: u.uGrassBase.value.getHex(),
    dark: u.uGrassDark.value.getHex(),
    light: u.uGrassLight.value.getHex(),
    dry: u.uGrassDry.value.getHex(),
    macroScale: u.uGrassMacroScale.value,
    macroStrength: u.uGrassMacroStrength.value,
    detailScale: u.uGrassDetailScale.value,
    detailStrength: u.uGrassDetailStrength.value,
    detailDensity: u.uGrassDetailDensity.value,
    windScale: u.uGrassWindScale.value,
    windSpeed: u.uGrassWindSpeed.value,
    windStrength: u.uGrassWindStrength.value,
    gustScale: u.uGrassGustScale.value,
    gustContrast: u.uGrassGustContrast.value,
    gustBrightness: u.uGrassGustBrightness.value,
    microScale: u.uGrassMicroScale.value,
    microStrength: u.uGrassMicroStrength.value,
    slopeStart: u.uGrassSlopeStart.value,
    slopeEnd: u.uGrassSlopeEnd.value,
    slopeStrength: u.uGrassSlopeStrength.value,
    shelter: u.uGrassShelter.value,
  };
}

/** Put every knob back to the ground the world was art-directed for. */
export function resetLivingGround(): void {
  // Start high so the slope pair cannot be clamped against a stale ceiling on
  // the way past each other.
  LIVING_GROUND_UNIFORMS.uGrassSlopeStart.value = 1;
  setLivingGround(LIVING_GROUND);
}

/**
 * Splice the living ground into the terrain **surface** material.
 *
 * Surface only. The cliff walls keep `TERRAIN_CLIFF_COLORS` and their own two
 * patches: a cut bank is earth rather than meadow, its colours are outside the
 * grass mask anyway, and spec 250 is explicit that the existing rock and cliff
 * treatment is not what this replaces.
 *
 * Composed rather than assigned, like every patch on this material --
 * `onBeforeCompile` is a single slot and overwriting it would silently drop the
 * weather, which is the kind of break that shows up as "the grass stopped
 * moving" three commits later.
 */
export function patchTerrainLiving(material: THREE.Material): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;

  material.onBeforeCompile = function (shader, renderer): void {
    previousCompile.call(this, shader, renderer);
    Object.assign(shader.uniforms, LIVING_GROUND_UNIFORMS);
    shader.fragmentShader = shader.fragmentShader
      // Immediately before `void main()`, which is the one anchor that is
      // guaranteed to be after *every* prologue -- and it has to be, because
      // `hash21`, `uWindDir` and `uWindTime` come from the wind chunk the streak
      // patch splices in and GLSL wants a declaration before its use.
      //
      // Anchoring on `#include <common>` instead, which is what the three
      // patches above do, lands this in front of them: each replacement matches
      // the *original* include and inserts before whatever the previous patch
      // put there, so the last patch applied ends up first in the file. That is
      // exactly what this one wants for its `color_fragment` half below -- it
      // reads the raw vertex colour -- and exactly what it must not have for its
      // declarations.
      .replace(MAIN_ANCHOR, `${glslLivingGround()}\nvoid main() {`)
      // `vWindWorld` is the streak patch's world position and `vDetailNormal`
      // the detail patch's world normal, both already carried through for their
      // own sake. Reading them rather than adding a third and fourth varying is
      // the whole reason this patch has no vertex-stage half at all.
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n' +
          '  diffuseColor.rgb = livingGround(diffuseColor.rgb, vWindWorld, normalize(vDetailNormal), uWindTime);',
      );
  };

  material.customProgramCacheKey = function (): string {
    return `${previousKey.call(this)}+living`;
  };
  material.needsUpdate = true;
}
