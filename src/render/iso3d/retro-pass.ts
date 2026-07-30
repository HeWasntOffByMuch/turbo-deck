import * as THREE from 'three';
import { RETRO_DEFAULTS, bayerTextureData, type BayerSize, type RetroSettings } from './retro.js';

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
varying vec2 vUv;

// Linear working space -> sRGB display space (the exact transfer function,
// matching what the renderer would have applied drawing straight to the canvas).
vec3 toSRGB(vec3 c) {
  vec3 low = c * 12.92;
  vec3 high = pow(c, vec3(0.41666666)) * 1.055 - 0.055;
  return mix(high, low, step(c, vec3(0.0031308)));
}

void main() {
  vec3 color = toSRGB(clamp(texture2D(uScene, vUv).rgb, 0.0, 1.0));

  // This pixel's threshold, tiled across the screen in low-resolution pixels.
  vec2 cell = mod(floor(vUv * uSceneSize / uDitherScale), uDitherSize);
  float threshold = texture2D(uDither, (cell + 0.5) / uDitherSize).r;

  // Nudge by up to half a band, then snap to the palette.
  float steps = max(uLevels - 1.0, 1.0);
  vec3 nudged = clamp(color + (threshold - 0.5) * uStrength / steps, 0.0, 1.0);
  gl_FragColor = vec4(floor(nudged * steps + 0.5) / steps, 1.0);
}
`;

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
  };

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
    if (settings.pixelSize !== previous.pixelSize) this.resizeTarget();

    this.uniforms.uDitherScale.value = Math.max(1, settings.ditherScale);
    this.uniforms.uLevels.value = settings.levels;
    this.uniforms.uStrength.value = settings.ditherStrength;
  }

  /**
   * Draw `scene` through the filter. With the filter off this is exactly the
   * plain `renderer.render(scene, camera)` it replaced.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.settings.enabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCamera);
  }

  dispose(): void {
    this.target.dispose();
    this.uniforms.uDither.value.dispose();
    this.material.dispose();
  }

  /** The scene buffer is the output resolution divided by the pixel size. */
  private resizeTarget(): void {
    const divisor = Math.max(1, Math.round(this.settings.pixelSize));
    const w = Math.max(1, Math.ceil(this.width / divisor));
    const h = Math.max(1, Math.ceil(this.height / divisor));
    this.target.setSize(w, h);
    this.uniforms.uSceneSize.value.set(w, h);
  }
}
