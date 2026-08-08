import * as THREE from 'three';
import {
  RETRO_DEFAULTS,
  bayerTextureData,
  paletteSpacing,
  paletteChannels,
  paletteTextureData,
  type BayerSize,
  type RetroSettings,
} from './retro.js';
import { GRADE_NONE, gradeIsIdentity, unpackColor, type GradeSettings } from './grade.js';
import { glslInkChunk, type InkSettings } from './ink.js';
import { glslSrgbEncodeChunk } from './hike.js';

/**
 * The retro post-processing pass (spec 038): draws the scene into a low
 * resolution buffer, then paints that buffer over the canvas through a shader
 * that quantizes every channel to a handful of steps and dithers across the
 * band edges with a screen-space Bayer matrix.
 *
 * The dither is what produces the fine weave inside otherwise flat colours: a
 * shade that falls between two palette steps is drawn as a mix of both, in a
 * fixed pattern indexed by pixel position. Because the pass runs on the final
 * image, every surface gets it -- no per-material or per-mesh work.
 *
 * The maths lives in `retro.ts` and is unit-tested there; the fragment shader
 * below computes the same expression per channel. The only thing it does on top
 * is the linear -> sRGB transfer: the scene renders into a linear-space target,
 * and the palette steps have to be evenly spaced in *display* space to look like
 * a real limited palette (and so that switching the filter off changes nothing
 * but the filter).
 */

/**
 * Palette entries the shader will loop over.
 *
 * A fixed bound because GLSL ES 1.00 will not take a loop whose count is a
 * uniform -- the loop runs to this and breaks at the real size, which costs
 * nothing for a shorter palette and is the standard way to say "up to N" in a
 * shader this old. Sixteen is already more colours than the look wants.
 */
const MAX_PALETTE = 16;

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uDither;
uniform vec2 uSceneSize;
uniform float uDitherSize;
uniform float uDitherScale;
uniform float uLevels;
uniform float uStrength;
uniform float uSaturation;
uniform vec3 uTint;
uniform float uTintStrength;
uniform float uGain;
/** The palette as a one-row texture, and how many of its texels are real. */
uniform sampler2D uPalette;
uniform float uPaletteSize;
/** The mean gap between neighbouring palette colours; the dither's unit. */
uniform float uPaletteSpacing;
/** The distance treatment (spec 099). uInkOn is 0 when there is nothing to do. */
uniform highp sampler2D uDepth;
uniform float uInkOn;
uniform float uNear;
uniform float uFar;
uniform vec3 uFogColor;
uniform float uInkOrigin;
uniform float uInkStart;
uniform float uInkEnd;
uniform float uInkFlatten;
uniform float uInkDesaturate;
uniform float uInkFog;
uniform float uInkTarget;
varying vec2 vUv;

${glslInkChunk()}

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

${glslSrgbEncodeChunk()}

// The colour grade (spec 047), mirroring gradeColor in grade.ts term for term:
// desaturate toward luma, blend toward the tint at matched luminance, then
// gain. Dividing the tint by its own luma is what keeps a strong hue from
// doubling as a dimmer.
vec3 grade(vec3 c) {
  float grey = dot(c, LUMA);
  vec3 desat = mix(vec3(grey), c, uSaturation);
  vec3 toned = grey * (uTint / max(dot(uTint, LUMA), 1e-4));
  return clamp(mix(desat, toned, uTintStrength) * uGain, 0.0, 1.0);
}

// The nearest entry of the palette texture, by squared distance. Mirrors
// nearestPaletteColor in retro.ts; the colours are texels rather than constants
// so a palette is data the panel supplies and never shader source (spec 098).
vec3 nearestPaletteColor(vec3 c) {
  vec3 best = c;
  float bestDistance = 1e9;
  for (int i = 0; i < ${MAX_PALETTE}; i++) {
    if (float(i) >= uPaletteSize) break;
    vec3 entry = texture2D(uPalette, vec2((float(i) + 0.5) / float(${MAX_PALETTE}), 0.5)).rgb;
    vec3 d = c - entry;
    float distance = dot(d, d);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return best;
}

void main() {
  vec3 lit = toSRGB(clamp(texture2D(uScene, vUv).rgb, 0.0, 1.0));

  // The distance treatment, on the fill and before everything else (spec 099).
  //
  // Before the grade and the quantize because it is part of what the surface
  // *is*, not a filter over the finished image -- and, more to the point, before
  // the outline pass, which runs after this whole pass and lays its line down at
  // a constant dark value. That ordering is the entire effect: the fills recede
  // and the lines do not, so distant geometry becomes flat shapes bounded by ink
  // rather than a soft haze.
  if (uInkOn > 0.5) {
    float raw = texture2D(uDepth, vUv).r;
    // The background is at the far plane and is already the sky; treating it
    // would fog the sky toward itself and flatten a colour with no surface under
    // it.
    if (raw < 0.999999) {
      // Depth past the camera's focus, not depth from the camera: the camera is
      // orthographic and sits a fixed distance back, so the raw number is mostly
      // that constant. See inkStart in hike.ts.
      float depth = uNear + raw * (uFar - uNear) - uInkOrigin;
      // The fog colour arrives as the live sky, which -- like every colour in
      // this renderer -- is held linear. The lit colour is display space by this
      // line, so mixing the two directly would drag every distant fill toward a sky about
      // twice as dark as the one behind it, and the horizon would read as a band
      // rather than as a vanishing. Encode it into the space it is being mixed in.
      vec3 fog = toSRGB(clamp(uFogColor, 0.0, 1.0));
      lit = inkFill(lit, fog, depth, uInkTarget,
                    uInkStart, uInkEnd, uInkFlatten, uInkDesaturate, uInkFog);
    }
  }

  // Graded before quantization on purpose: a black-and-white frame is then
  // banded into a proper grey ramp and dithered across it, where grading after
  // would spend the palette on colours about to be thrown away.
  vec3 color = grade(lit);

  // This pixel's threshold, tiled across the screen in low-resolution pixels.
  vec2 cell = mod(floor(vUv * uSceneSize / uDitherScale), uDitherSize);
  float threshold = texture2D(uDither, (cell + 0.5) / uDitherSize).r;

  if (uPaletteSize > 0.5) {
    // Dither first, then snap -- the same order as the banded path. The nudge is
    // measured in palette spacing rather than in band widths, because a palette
    // has no bands: half the typical gap between neighbouring colours is the
    // equivalent of half a band, and without it one strength setting is a
    // snowstorm on a tight palette and invisible on a wide one.
    vec3 nudged = clamp(color + (threshold - 0.5) * uStrength * uPaletteSpacing, 0.0, 1.0);
    gl_FragColor = vec4(nearestPaletteColor(nudged), 1.0);
  } else {
    // Nudge by up to half a band, then snap to the nearest even step.
    float steps = max(uLevels - 1.0, 1.0);
    vec3 nudged = clamp(color + (threshold - 0.5) * uStrength / steps, 0.0, 1.0);
    gl_FragColor = vec4(floor(nudged * steps + 0.5) / steps, 1.0);
  }
}
`;

/**
 * The palette as a one-row RGBA texture, always MAX_PALETTE wide.
 *
 * Padded to a fixed width so the shader's texel lookup divides by a constant and
 * a shorter palette does not silently address different texels; the entries past
 * the real size are never read, because the loop breaks first.
 */
function makePaletteTexture(palette: readonly number[]): THREE.DataTexture {
  const bytes = new Uint8Array(MAX_PALETTE * 4);
  bytes.set(paletteTextureData(palette).subarray(0, MAX_PALETTE * 4));
  const texture = new THREE.DataTexture(bytes, MAX_PALETTE, 1, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The Bayer thresholds as an RGBA byte texture (RGBA so any GL context takes it). */
function makeDitherTexture(size: BayerSize): THREE.DataTexture {
  const thresholds = bayerTextureData(size);
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < thresholds.length; i++) {
    const v = thresholds[i] ?? 0;
    rgba.set([v, v, v, 255], i * 4);
  }
  const tex = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export class RetroPass {
  private settings: RetroSettings;
  private grade: GradeSettings = GRADE_NONE;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  // A fixed clip-space quad: the vertex shader ignores the camera entirely.
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms: {
    uScene: { value: THREE.Texture };
    uDither: { value: THREE.DataTexture };
    uSceneSize: { value: THREE.Vector2 };
    uDitherSize: { value: number };
    uDitherScale: { value: number };
    uLevels: { value: number };
    uStrength: { value: number };
    uSaturation: { value: number };
    uTint: { value: THREE.Vector3 };
    uTintStrength: { value: number };
    uGain: { value: number };
    uPalette: { value: THREE.DataTexture };
    uPaletteSize: { value: number };
    uPaletteSpacing: { value: number };
    uDepth: { value: THREE.Texture | null };
    uInkOn: { value: number };
    uNear: { value: number };
    uFar: { value: number };
    uFogColor: { value: THREE.Color };
    uInkOrigin: { value: number };
    uInkStart: { value: number };
    uInkEnd: { value: number };
    uInkFlatten: { value: number };
    uInkDesaturate: { value: number };
    uInkFog: { value: number };
    uInkTarget: { value: number };
  };

  /** The palette currently uploaded, so an unchanged one is not re-uploaded. */
  private paletteKey = '';

  constructor(
    private width: number,
    private height: number,
    settings: RetroSettings = RETRO_DEFAULTS,
  ) {
    this.settings = settings;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      // Nearest everywhere: the whole point is hard pixels, never a blend.
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    this.uniforms = {
      uScene: { value: this.target.texture },
      uDither: { value: makeDitherTexture(settings.matrixSize) },
      uSceneSize: { value: new THREE.Vector2(1, 1) },
      uDitherSize: { value: settings.matrixSize },
      uDitherScale: { value: Math.max(1, settings.ditherScale) },
      uLevels: { value: settings.levels },
      uStrength: { value: settings.ditherStrength },
      uSaturation: { value: GRADE_NONE.saturation },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uTintStrength: { value: GRADE_NONE.tintStrength },
      uGain: { value: GRADE_NONE.gain },
      uPalette: { value: makePaletteTexture([]) },
      uPaletteSize: { value: 0 },
      uPaletteSpacing: { value: 0 },
      uDepth: { value: null },
      uInkOn: { value: 0 },
      uNear: { value: 1 },
      uFar: { value: 12000 },
      uFogColor: { value: new THREE.Color(0x8fd6c8) },
      uInkOrigin: { value: 0 },
      uInkStart: { value: 80 },
      uInkEnd: { value: 380 },
      uInkFlatten: { value: 0 },
      uInkDesaturate: { value: 0 },
      uInkFog: { value: 0 },
      // Mid-grey in display space: the luminance a flattened surface settles on.
      uInkTarget: { value: 0.45 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));

    this.resizeTarget();
  }

  /** Resize the output (canvas) resolution the pass renders for. */
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.resizeTarget();
  }

  /** Apply new settings; only a changed matrix size rebuilds anything. */
  set(settings: RetroSettings): void {
    const previous = this.settings;
    this.settings = settings;

    if (settings.matrixSize !== previous.matrixSize) {
      this.uniforms.uDither.value.dispose();
      this.uniforms.uDither.value = makeDitherTexture(settings.matrixSize);
      this.uniforms.uDitherSize.value = settings.matrixSize;
    }
    // The buffer's divisor depends on `enabled` as well as on the pixel size:
    // a grade-only frame renders at full resolution whatever the slider says.
    if (settings.pixelSize !== previous.pixelSize || settings.enabled !== previous.enabled) {
      this.resizeTarget();
    }

    this.uniforms.uDitherScale.value = Math.max(1, settings.ditherScale);
    this.uniforms.uLevels.value = settings.levels;
    this.uniforms.uStrength.value = settings.ditherStrength;
  }

  /**
   * Quantize onto a palette instead of onto even steps (spec 098), or pass null
   * to go back to steps.
   *
   * The colours travel as a texture rather than as shader source, which is the
   * whole point: a palette is data the panel hands over, so trying another one is
   * a dropdown rather than a rebuild. Re-uploaded only when it actually changes,
   * since this is called every frame.
   */
  setPalette(palette: readonly number[] | null): void {
    const entries = (palette ?? []).slice(0, MAX_PALETTE);
    const key = entries.join(',');
    if (key === this.paletteKey) return;
    this.paletteKey = key;

    this.uniforms.uPalette.value.dispose();
    this.uniforms.uPalette.value = makePaletteTexture(entries);
    this.uniforms.uPaletteSize.value = entries.length;
    this.uniforms.uPaletteSpacing.value = paletteSpacing(paletteChannels(entries));
  }

  /**
   * Switch the distance treatment on, with the depth buffer it reads (spec 099).
   *
   * Pass null to switch it off. The fog colour is the *live* sky rather than a
   * setting: the day/night cycle moves it, and a fixed haze colour under a sunset
   * is a grey band across the horizon.
   */
  setInk(
    depth: THREE.Texture | null,
    near: number,
    far: number,
    origin: number,
    fog: THREE.Color,
    settings: InkSettings | null,
  ): void {
    this.uniforms.uDepth.value = depth;
    this.uniforms.uInkOn.value = depth && settings ? 1 : 0;
    if (!settings) return;
    this.uniforms.uNear.value = near;
    this.uniforms.uFar.value = far;
    this.uniforms.uInkOrigin.value = origin;
    this.uniforms.uFogColor.value.copy(fog);
    this.uniforms.uInkStart.value = settings.inkStart;
    this.uniforms.uInkEnd.value = settings.inkEnd;
    this.uniforms.uInkFlatten.value = settings.inkFlatten;
    this.uniforms.uInkDesaturate.value = settings.inkDesaturate;
    this.uniforms.uInkFog.value = settings.inkFog;
  }

  /** Apply a colour grade (spec 047). The identity grade costs nothing. */
  setGrade(grade: GradeSettings): void {
    this.grade = grade;
    const [r, g, b] = unpackColor(grade.tint);
    this.uniforms.uSaturation.value = grade.saturation;
    this.uniforms.uTint.value.set(r, g, b);
    this.uniforms.uTintStrength.value = grade.tintStrength;
    this.uniforms.uGain.value = grade.gain;
  }

  /**
   * Draw `scene` through the filter. With both the filter and the grade off
   * this is exactly the plain `renderer.render(scene, camera)` it replaced.
   *
   * A grade with the retro filter switched off still has to go through the
   * shader -- there is nowhere else to put it -- so that case takes the quad
   * path with quantization neutered: 256 levels and no dither is a no-op band,
   * leaving the grade and the linear->sRGB transfer as the only things applied.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const grading = !gradeIsIdentity(this.grade);
    // A palette is a reason to run the pass even with the filter switched off:
    // quantizing onto a named set of colours is the thing being asked for, not a
    // side effect of the retro look.
    const palettized = this.uniforms.uPaletteSize.value > 0;
    // And the ink, which is a third reason to run the quad at all.
    const inking = this.uniforms.uInkOn.value > 0;
    if (!this.settings.enabled && !grading && !palettized && !inking) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    this.uniforms.uLevels.value = this.settings.enabled ? this.settings.levels : 256;
    // The dither still applies to a palette with the retro filter off: it is what
    // stops a limited palette banding, which is the reason to want it.
    this.uniforms.uStrength.value =
      this.settings.enabled || palettized ? this.settings.ditherStrength : 0;

    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCamera);
  }

  dispose(): void {
    this.target.dispose();
    this.uniforms.uPalette.value.dispose();
    this.uniforms.uDither.value.dispose();
    this.material.dispose();
  }

  /**
   * The scene buffer is the output resolution divided by the pixel size -- but
   * only while the retro filter is on. With it off the pass is running purely
   * to carry a grade, and chunking the pixels would be applying half the filter
   * the viewer just switched off.
   */
  private resizeTarget(): void {
    const divisor = this.settings.enabled ? Math.max(1, Math.round(this.settings.pixelSize)) : 1;
    const w = Math.max(1, Math.ceil(this.width / divisor));
    const h = Math.max(1, Math.ceil(this.height / divisor));
    this.target.setSize(w, h);
    this.uniforms.uSceneSize.value.set(w, h);
  }
}
