import * as THREE from 'three';
import { DETAIL_TILE_SIZE, detailTile } from './detail-texture.js';
import { glslSurfaceDetail } from './surface-detail.js';

/**
 * The three.js half of spec 106: upload the generated tile and splice the
 * triplanar detail and the slope/height blend into the ground materials.
 *
 * The maths is in `surface-detail.ts` and the tile in `detail-texture.ts`, both
 * pure and tested. Everything here is plumbing and sampler state.
 */

/** Written straight into by the view controls; read by the ground materials. */
export const DETAIL_UNIFORMS = {
  uDetailMap: { value: null as THREE.Texture | null },
  /** How far the detail modulates the surface colour, 0..1. Zero is switched off. */
  uDetailStrength: { value: 0 },
  /** World units per tile repeat, as its reciprocal -- the shader multiplies. */
  uDetailScale: { value: 1 / 90 },
  /** How hard a surface commits to one projection axis. */
  uDetailSharpness: { value: 4 },
  /** How far the ground's colour moves toward bare rock, 0..1. Zero is off. */
  uBlendStrength: { value: 0 },
  /** The tone the blend moves toward, linear like every colour here. */
  uBlendColor: { value: new THREE.Color(0xc6bda9) },
  uBlendSlopeStart: { value: 0.85 },
  uBlendSlopeEnd: { value: 0.5 },
  uBlendHeightStart: { value: 260 },
  uBlendHeightEnd: { value: 420 },
  uBlendNoise: { value: 0.25 },
  /** World units per repeat of the noise that displaces the boundary. */
  uBlendNoiseScale: { value: 1 / 620 },
};

/**
 * The tile as a texture, built once.
 *
 * **This is where the brief's sampling constraint lands.** Mipmapped, trilinear
 * on minification, and anisotropic at whatever the driver will give -- the
 * framebuffer upscale is the *only* nearest-neighbour step in the renderer, and a
 * texture sampled nearest would put a second, unrelated pixel grid inside the
 * first one. Anisotropy in particular is not a nicety here: the ground is seen at
 * a 27-degree grazing angle, which is the exact case trilinear alone blurs to
 * mush.
 *
 * `maxAnisotropy` has to come from the renderer, so it is passed in rather than
 * reached for.
 */
export function buildDetailTexture(maxAnisotropy: number): THREE.DataTexture {
  const bytes = detailTile();
  // Expanded to RGBA: single-channel formats are a compatibility question across
  // WebGL1/2 and this is 64KB either way.
  const rgba = new Uint8Array(DETAIL_TILE_SIZE * DETAIL_TILE_SIZE * 4);
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] ?? 0;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(rgba, DETAIL_TILE_SIZE, DETAIL_TILE_SIZE, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.max(1, maxAnisotropy);
  // A detail signal, not a colour: it modulates a tone the material already has,
  // so it must not be sRGB-decoded on the way in.
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const DETAIL_APPLY = /* glsl */ `
  if (uDetailStrength > 0.0 || uBlendStrength > 0.0) {
    vec3 n = normalize(vDetailNormal);

    if (uBlendStrength > 0.0) {
      // A low-frequency sample of the same tile displaces the boundary. Taken
      // from the ground projection alone: what is wanted is a plan-view blotch
      // pattern, and a triplanar sample of it would follow the cliff faces and
      // put the ragged edge somewhere the eye reads as geology rather than noise.
      float boundary = texture2D(uDetailMap, vDetailWorld.xz * uBlendNoiseScale).r;
      float rock = rockBlend(n.y, vDetailWorld.y, boundary,
                             uBlendSlopeStart, uBlendSlopeEnd,
                             uBlendHeightStart, uBlendHeightEnd, uBlendNoise);
      diffuseColor.rgb = mix(diffuseColor.rgb, uBlendColor, rock * uBlendStrength);
    }

    if (uDetailStrength > 0.0) {
      float detail = triplanarDetail(uDetailMap, vDetailWorld, n, uDetailScale, uDetailSharpness);
      // Centred on the tile's midpoint, so the detail darkens and lightens about
      // the colour the surface already had instead of dimming it overall.
      diffuseColor.rgb *= 1.0 + (detail - 0.5) * 2.0 * uDetailStrength;
    }
  }
`;

/**
 * Splice the detail into a ground material, composing with whatever is already
 * patched onto it.
 *
 * The wind streak (spec 074) is on both ground materials and the creases (spec
 * 100) are on the surface, and `onBeforeCompile` is a single slot -- so this
 * wraps rather than assigns, and the cache key carries every patch. Getting that
 * wrong stops the grass moving, which is a bug nobody notices for weeks.
 */
export function patchTerrainDetail(material: THREE.Material): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;

  material.onBeforeCompile = function (shader, renderer): void {
    previousCompile.call(this, shader, renderer);
    Object.assign(shader.uniforms, DETAIL_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDetailWorld;\nvarying vec3 vDetailNormal;')
      .replace(
        '#include <defaultnormal_vertex>',
        // After `defaultnormal_vertex`, so `objectNormal` has been through
        // whatever the wind sway did to it -- a cliff that bends must be
        // textured as it is, not as it was authored.
        '#include <defaultnormal_vertex>\nvDetailNormal = normalize(mat3(modelMatrix) * objectNormal);',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDetailWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vDetailWorld;
varying vec3 vDetailNormal;
uniform sampler2D uDetailMap;
uniform float uDetailStrength;
uniform float uDetailScale;
uniform float uDetailSharpness;
uniform float uBlendStrength;
uniform vec3 uBlendColor;
uniform float uBlendSlopeStart;
uniform float uBlendSlopeEnd;
uniform float uBlendHeightStart;
uniform float uBlendHeightEnd;
uniform float uBlendNoise;
uniform float uBlendNoiseScale;
${glslSurfaceDetail()}`,
      )
      // After `color_fragment` like the other ground patches, so it rides on the
      // vertex colours and still takes the sun, the shadows and the lights.
      .replace('#include <color_fragment>', `#include <color_fragment>\n${DETAIL_APPLY}`);
  };

  material.customProgramCacheKey = function (): string {
    return `${previousKey.call(this)}+detail`;
  };
}
