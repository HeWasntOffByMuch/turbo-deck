import * as THREE from 'three';
import { glslEdgeChunk } from './edges.js';
import { glslOctahedralChunk } from './shading.js';
import { glslInkChunk } from './ink.js';
import { glslSrgbEncodeChunk, type HikeSettings } from './hike.js';

/**
 * The outline pass (spec 101): a Roberts cross over the depth and normal buffers,
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
/** The distance terms (spec 103). */
uniform float uInkOn;
uniform float uInkOrigin;
uniform float uInkStart;
uniform float uInkEnd;
uniform float uInkEdgeGain;
uniform float uMinNeighbours;

varying vec2 vUv;

${glslOctahedralChunk()}
${glslEdgeChunk()}
${glslInkChunk()}
${glslSrgbEncodeChunk()}

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

/**
 * The edge at one pixel, without the coherence test. Called for the centre and,
 * when coherence is on, for its eight neighbours.
 */
float edgeAt(vec2 uv) {
  Tap c = tapAt(uv);
  Tap tl = tapAt(uv + vec2(-uTexel.x, -uTexel.y));
  Tap br = tapAt(uv + vec2(uTexel.x, uTexel.y));
  Tap tr = tapAt(uv + vec2(uTexel.x, -uTexel.y));
  Tap bl = tapAt(uv + vec2(-uTexel.x, uTexel.y));

  float solid = min(min(tl.solid, br.solid), min(tr.solid, bl.solid)) * c.solid;
  float allowed = max(solid, uOutlineAgainstSky);

  float dTL = planeDeviation(c.xy, c.depth, tl.xy, tl.depth, tl.normal);
  float dBR = planeDeviation(c.xy, c.depth, br.xy, br.depth, br.normal);
  float dTR = planeDeviation(c.xy, c.depth, tr.xy, tr.depth, tr.normal);
  float dBL = planeDeviation(c.xy, c.depth, bl.xy, bl.depth, bl.normal);
  float depthEdge = robertsCross(dTL, dBR, dTR, dBL);

  float normalEdge = normalRobertsCross(tl.normal, br.normal, tr.normal, bl.normal);

  // Distance makes the normal term more sensitive, not less. A far-off shape has
  // lost its shading to the ink treatment, so the only thing left describing it
  // is its line -- and the creases that line is made of are the same size on
  // screen as they ever were, since the camera is orthographic. Dividing the
  // threshold is what raises sensitivity.
  // Past the focus rather than from the camera, the same origin the fill
  // treatment ramps on -- the two have to agree about where "far" starts, or the
  // lines sharpen over ground that has not yet begun to recede.
  float t = uInkOn > 0.5 ? inkAmount(c.depth - uInkOrigin, uInkStart, uInkEnd) : 0.0;
  float normalThreshold = uNormalThreshold / mix(1.0, uInkEdgeGain, t);

  return max(step(uDepthThreshold, depthEdge), step(normalThreshold, normalEdge)) * allowed;
}

void main() {
  float edge = edgeAt(vUv);

  // Fade an outline that has nothing beside it.
  //
  // A line one or two pixels long has nothing holding it steady, so it blinks as
  // the geometry crosses a sample boundary; a line belonging to a real
  // silhouette has neighbours running along it. Counting them is a cheaper and
  // more direct test than the screen-size one the brief asks for -- and under an
  // orthographic camera screen size does not change with distance at all, so
  // "small because far away" is not a thing that happens here.
  if (edge > 0.0 && uMinNeighbours > 0.0) {
    float neighbours = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        neighbours += edgeAt(vUv + vec2(float(dx) * uTexel.x, float(dy) * uTexel.y));
      }
    }
    // Smooth rather than a cliff: a hard cut-off makes the fade itself flicker,
    // which is the artefact being removed.
    edge *= clamp(neighbours / uMinNeighbours, 0.0, 1.0);
  }

  if (uMaskOnly > 0.5) {
    gl_FragColor = vec4(vec3(edge), 1.0);
  } else {
    // A constant dark value, composited over whatever is already there. Not a
    // darkening of the pixel underneath: a line whose colour depends on what it
    // crosses is a line that fades out over dark ground, which is where it is
    // most needed.
    //
    // Constant with distance too, which is the point of the whole step: the
    // fills recede and the lines do not.
    //
    // Encoded, because this is one of the few passes that writes to the canvas
    // without three.js appending its own output conversion -- a ShaderMaterial
    // gets no colorspace_fragment. The colour is held linear like every other
    // colour here, and the frame underneath is already display space, so writing
    // it raw drew the line at about a tenth of the value the setting names:
    // 0x1a1a22 landed as 0x030304. Still "a constant dark value", which is why
    // nothing about the look gave it away.
    gl_FragColor = vec4(toSRGB(clamp(uOutlineColor, 0.0, 1.0)), edge * uOutlineStrength);
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
    uInkOn: { value: number };
    uInkOrigin: { value: number };
    uInkStart: { value: number };
    uInkEnd: { value: number };
    uInkEdgeGain: { value: number };
    uMinNeighbours: { value: number };
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
      uInkOn: { value: 0 },
      uInkOrigin: { value: 0 },
      uInkStart: { value: 80 },
      uInkEnd: { value: 380 },
      uInkEdgeGain: { value: 1 },
      uMinNeighbours: { value: 0 },
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
    inkOrigin = 0,
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
    this.uniforms.uInkOn.value = hike.ink ? 1 : 0;
    this.uniforms.uInkOrigin.value = inkOrigin;
    this.uniforms.uInkStart.value = hike.inkStart;
    this.uniforms.uInkEnd.value = hike.inkEnd;
    this.uniforms.uInkEdgeGain.value = hike.inkEdgeGain;
    this.uniforms.uMinNeighbours.value = hike.outlineMinNeighbours;
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
