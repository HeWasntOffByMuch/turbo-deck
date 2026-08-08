import * as THREE from 'three';
import { glslEdgeChunk } from './edges.js';
import { glslOctahedralChunk } from './shading.js';
import type { HikeSettings } from './hike.js';

/**
 * The outline pass (spec 097): a Roberts cross over the depth and normal buffers,
 * drawn over the finished frame as a constant dark line.
 *
 * Everything interesting about *what* it computes is in `edges.ts`, which is pure
 * and tested; this is the three.js half that binds the buffers, hands the shader
 * the camera's extents and blends the result over the canvas.
 *
 * ## What the far plane does, and why that is a choice
 *
 * The background sits at the far plane, which is thousands of world units from
 * anything. Left alone, every silhouette against it is a depth step larger than
 * any threshold and gets a line -- so the whole world ends up traced against the
 * sky whether or not that is the look wanted, and the line is at its maximum
 * strength everywhere it appears.
 *
 * So background taps are masked by default, and `outlineAgainstSky` turns them
 * back on. It is a real choice rather than a safety measure: silhouettes against
 * the sky *are* drawn in the look this is imitating. It defaults off because a
 * default that traces everything is not a default anybody can judge the rest of
 * the pass against.
 *
 * In this world it matters less than it would elsewhere -- the camera looks down
 * at ground that fills most of the frame, and sky appears only past the edge of
 * the map and above the horizon.
 */

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uNormals;
uniform highp sampler2D uDepth;
uniform vec2 uTexel;
/** Half-extents of the orthographic frustum, world units. */
uniform vec2 uHalfExtent;
uniform float uNear;
uniform float uFar;
uniform float uDepthThreshold;
uniform float uNormalThreshold;
uniform float uOutlineAgainstSky;
uniform vec3 uOutlineColor;
uniform float uOutlineStrength;
/** 0 draws the line over the frame, 1 draws the mask on its own. */
uniform float uMaskOnly;

varying vec2 vUv;

${glslOctahedralChunk()}
${glslEdgeChunk()}

/**
 * A tap: where it is on screen in world units, how far away, its normal, and
 * whether there is anything there at all.
 */
struct Tap {
  vec2 xy;
  float depth;
  vec3 normal;
  float solid;
};

Tap tapAt(vec2 uv) {
  Tap t;
  float raw = texture2D(uDepth, uv).r;
  // Orthographic: the buffer is already linear from near to far, so this is a
  // distance in world units and not a reciprocal to be undone.
  t.depth = uNear + raw * (uFar - uNear);
  t.xy = (uv * 2.0 - 1.0) * uHalfExtent;
  t.normal = decodeOctahedral(texture2D(uNormals, uv).rg);
  // The far plane is background. Nothing was drawn there, so its normal is the
  // cleared marker and its depth is meaningless as a surface.
  t.solid = raw < 0.999999 ? 1.0 : 0.0;
  return t;
}

void main() {
  Tap c = tapAt(vUv);
  Tap tl = tapAt(vUv + vec2(-uTexel.x, -uTexel.y));
  Tap br = tapAt(vUv + vec2(uTexel.x, uTexel.y));
  Tap tr = tapAt(vUv + vec2(uTexel.x, -uTexel.y));
  Tap bl = tapAt(vUv + vec2(-uTexel.x, uTexel.y));

  // Every tap solid, or the sky is allowed to take part.
  float solid = min(min(tl.solid, br.solid), min(tr.solid, bl.solid)) * c.solid;
  float allowed = max(solid, uOutlineAgainstSky);

  // Depth, measured against each neighbour's own plane rather than against its
  // depth -- so a hillside at a glancing angle reads as flat, which it is.
  float dTL = planeDeviation(c.xy, c.depth, tl.xy, tl.depth, tl.normal);
  float dBR = planeDeviation(c.xy, c.depth, br.xy, br.depth, br.normal);
  float dTR = planeDeviation(c.xy, c.depth, tr.xy, tr.depth, tr.normal);
  float dBL = planeDeviation(c.xy, c.depth, bl.xy, bl.depth, bl.normal);
  float depthEdge = robertsCross(dTL, dBR, dTR, dBL);

  float normalEdge = normalRobertsCross(tl.normal, br.normal, tr.normal, bl.normal);

  // max, not a sum. A corner fires on both terms; adding them makes it twice an
  // edge, so a threshold thin enough for lines blobs every corner.
  float edge = max(
    step(uDepthThreshold, depthEdge),
    step(uNormalThreshold, normalEdge)
  ) * allowed;

  if (uMaskOnly > 0.5) {
    gl_FragColor = vec4(vec3(edge), 1.0);
  } else {
    // A constant dark value, composited over whatever is already there. Not a
    // darkening of the pixel underneath: a line whose colour depends on what it
    // crosses is a line that fades out over dark ground, which is where it is
    // most needed.
    gl_FragColor = vec4(uOutlineColor, edge * uOutlineStrength);
  }
}
`;

export class HikeEdges {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms: {
    uNormals: { value: THREE.Texture | null };
    uDepth: { value: THREE.Texture | null };
    uTexel: { value: THREE.Vector2 };
    uHalfExtent: { value: THREE.Vector2 };
    uNear: { value: number };
    uFar: { value: number };
    uDepthThreshold: { value: number };
    uNormalThreshold: { value: number };
    uOutlineAgainstSky: { value: number };
    uOutlineColor: { value: THREE.Color };
    uOutlineStrength: { value: number };
    uMaskOnly: { value: number };
  };

  constructor() {
    this.uniforms = {
      uNormals: { value: null },
      uDepth: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 480, 1 / 270) },
      uHalfExtent: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 1 },
      uFar: { value: 12000 },
      uDepthThreshold: { value: 6 },
      uNormalThreshold: { value: 0.35 },
      uOutlineAgainstSky: { value: 0 },
      uOutlineColor: { value: new THREE.Color(0x1a1a22) },
      uOutlineStrength: { value: 1 },
      uMaskOnly: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  /**
   * Draw the outlines over whatever is on the canvas, or the mask on its own.
   *
   * `width`/`height` are the buffer's, not the canvas's: the taps have to land on
   * neighbouring pixels of the depth and normal buffers, which is what makes the
   * pass resolution-independent and the thresholds mean the same thing at every
   * virtual size.
   */
  render(
    renderer: THREE.WebGLRenderer,
    normals: THREE.Texture,
    depth: THREE.Texture | null,
    camera: THREE.OrthographicCamera,
    width: number,
    height: number,
    hike: HikeSettings,
    maskOnly: boolean,
  ): void {
    this.uniforms.uNormals.value = normals;
    this.uniforms.uDepth.value = depth;
    this.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.uniforms.uHalfExtent.value.set(
      (camera.right - camera.left) / 2,
      (camera.top - camera.bottom) / 2,
    );
    this.uniforms.uNear.value = camera.near;
    this.uniforms.uFar.value = camera.far;
    this.uniforms.uDepthThreshold.value = hike.depthEdgeThreshold;
    this.uniforms.uNormalThreshold.value = hike.normalEdgeThreshold;
    this.uniforms.uOutlineAgainstSky.value = hike.outlineAgainstSky ? 1 : 0;
    this.uniforms.uOutlineColor.value.setHex(hike.outlineColor, THREE.SRGBColorSpace);
    this.uniforms.uOutlineStrength.value = hike.outlineStrength;
    this.uniforms.uMaskOnly.value = maskOnly ? 1 : 0;
    // Opaque when it is the whole picture, blended when it is a line over one.
    this.material.transparent = !maskOnly;

    renderer.setRenderTarget(null);
    // The line goes *over* the frame, so the frame has to survive being drawn
    // over. `autoClear` defaults to true, and a fullscreen pass that clears
    // before it blends does not composite anything -- it replaces the picture
    // with the clear colour and a few dark pixels, which is a black screen with
    // outlines on it. Restored rather than left off, because the retro pass and
    // the shadow maps rely on the renderer clearing for them.
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = maskOnly;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = previousAutoClear;
  }

  dispose(): void {
    this.material.dispose();
  }
}
