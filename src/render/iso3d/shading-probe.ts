import * as THREE from 'three';
import type { Prop } from '../../terrain/vegetation.js';
import { buildPropField } from './props.js';
import { DEFAULT_CREASE_ANGLE } from './shading.js';
import { advanceWind, setWindStrength } from './wind-uniforms.js';

/**
 * A dev-server-only rig that proves the shading switches' shaders actually
 * compile and link (spec 087, step 2). Never in a build: `vite build` bundles
 * `index.html` and nothing else.
 *
 * ## Why this exists, when there are already 1600 unit tests
 *
 * Because none of them can see a shader. Step 2 splices GLSL into three.js's
 * `defaultnormal_vertex`, and there are exactly two ways that goes wrong:
 *
 *  - the splice matches nothing. `sway.ts` already throws at module load for
 *    that, because spec 074 shipped it broken once and it was silent -- a patch
 *    that matches nothing compiles, links, and simply does not move.
 *  - the spliced GLSL is invalid. Nothing catches that. three.js **logs** a
 *    failed compile and carries on, so the frame keeps rendering with a
 *    fallback and the console note scrolls away.
 *
 * `preview-trees.ts` looks like the answer and is not: it rasterises in software
 * and never creates a GL context, so it validates geometry and nothing about
 * shaders. This needs a real GPU, so it lives here and
 * `scripts/probe-shading.ts` drives it.
 *
 * It draws the **real `buildPropField`**, so the programs compiled are the
 * programs the game compiles -- including the depth and distance materials the
 * shadow passes use, which carry their own copy of the sway patch and are
 * therefore their own chance to be broken.
 */

/** The four corners of the two switches step 2 adds. */
const CASES = [
  { smooth: false, swayNormals: false, label: 'flat, no normal bend (the shipped default)' },
  { smooth: true, swayNormals: false, label: 'smooth, no normal bend' },
  { smooth: false, swayNormals: true, label: 'flat, normal bend (inert, must still link)' },
  { smooth: true, swayNormals: true, label: 'smooth + normal bend' },
] as const;

/**
 * Enough props to build every kind of batch the field makes: three trees, so
 * the hashed variants differ and both species' parts appear, and a bush.
 */
const PROPS: readonly Prop[] = [
  { kind: 'tree', x: 0, y: 0, scale: 1, rotation: 0, tint: 0 },
  { kind: 'tree', x: 180, y: 60, scale: 1.2, rotation: 1, tint: 0.4 },
  { kind: 'tree', x: -160, y: 120, scale: 0.8, rotation: 2, tint: -0.3 },
  { kind: 'bush', x: 90, y: -80, scale: 1, rotation: 0.5, tint: 0.2 },
];

/** What one case reported. */
export interface ShadingProbeCase {
  readonly label: string;
  readonly smooth: boolean;
  readonly swayNormals: boolean;
  /** Programs three.js had compiled after the draw. Zero means nothing drew. */
  readonly programs: number;
  /** Batches built, so a case that silently produced no geometry is visible. */
  readonly batches: number;
  /**
   * Whether every batch ended up flat-shaded or smooth as asked. Checks the
   * wiring, not the shader -- but a shader that compiled on the wrong material
   * would prove nothing.
   */
  readonly flatShaded: boolean;
  /** The group's world bounds, so a case that drew nothing says why. */
  readonly bounds: readonly [number, number, number, number, number, number];
  readonly instances: number;
  /**
   * Non-background pixels the draw actually left behind, read straight out of
   * the drawing buffer.
   *
   * The claim that matters, and the one "it compiled" cannot make: a shader that
   * links and writes nothing is indistinguishable from a working one until
   * somebody counts pixels.
   */
  readonly litPixels: number;
  /** Triangles the draw actually submitted. Zero means everything was culled. */
  readonly triangles: number;
  readonly radius: number;
}

declare global {
  interface Window {
    /** Filled once every case has drawn; `probe-shading.ts` polls for it. */
    shadingProbe?: readonly ShadingProbeCase[];
    /** The four buffers as one labelled PNG data URL. Written before `shadingProbe`. */
    shadingProbeSheet?: string;
  }
}

/** Each case's drawing buffer, in draw order, for the contact sheet. */
const frames: { label: string; pixels: Uint8Array }[] = [];

const CELL_W = 320;
const CELL_H = 240;

/**
 * Lay the captured buffers out as one labelled 2x2 PNG, as a data URL.
 *
 * `readPixels` hands back rows bottom-up, so each one is written back in reverse
 * -- the classic way to produce a contact sheet that is upside down and to not
 * notice, since trees are roughly symmetric about the horizontal.
 */
function contactSheet(): string {
  const pad = 10;
  const label = 18;
  const sheet = document.createElement('canvas');
  sheet.width = pad + 2 * (CELL_W + pad);
  sheet.height = pad + 2 * (CELL_H + label + pad);
  const ctx = sheet.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#16161e';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = '12px monospace';

  frames.forEach((frame, i) => {
    const ox = pad + (i % 2) * (CELL_W + pad);
    const oy = pad + Math.floor(i / 2) * (CELL_H + label + pad);
    const image = ctx.createImageData(CELL_W, CELL_H);
    for (let y = 0; y < CELL_H; y++) {
      const src = (CELL_H - 1 - y) * CELL_W * 4;
      const dst = y * CELL_W * 4;
      for (let x = 0; x < CELL_W * 4; x += 4) {
        image.data[dst + x] = frame.pixels[src + x] ?? 0;
        image.data[dst + x + 1] = frame.pixels[src + x + 1] ?? 0;
        image.data[dst + x + 2] = frame.pixels[src + x + 2] ?? 0;
        image.data[dst + x + 3] = 255;
      }
    }
    ctx.putImageData(image, ox, oy);
    ctx.fillStyle = '#c8c8d4';
    ctx.fillText(frame.label, ox, oy + CELL_H + 13);
  });
  return sheet.toDataURL('image/png');
}

function runCase(smooth: boolean, swayNormals: boolean, label: string): ShadingProbeCase {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H;

  // preserveDrawingBuffer, so `readPixels` below still has something to read
  // once the draw has finished.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(300, 600, 300);
  sun.castShadow = true;
  scene.add(sun);

  const field = buildPropField(PROPS, () => 0, undefined, {
    smooth,
    creaseAngle: DEFAULT_CREASE_ANGLE,
    swayNormals,
  });
  scene.add(field.group);



  let batches = 0;
  let instances = 0;
  let flatShaded = true;
  field.group.traverse((node) => {
    if (!(node instanceof THREE.InstancedMesh)) return;
    batches++;
    instances += node.count;
    const material = node.material as THREE.MeshLambertMaterial;
    if (material.flatShading === smooth) flatShaded = false;
  });
  const box = new THREE.Box3().setFromObject(field.group);

  // Framed tight on the props' own bounds rather than on a round number, so the
  // shading difference between the cases is big enough on screen to read.
  const half = 240;
  const camera = new THREE.OrthographicCamera(-half, half, half * 0.75, -half * 0.75, 1, 4000);
  camera.position.set(700, 620, 700);
  camera.lookAt(27, 95, 30);

  // Twice: the first draw compiles the visible materials, and the shadow pass
  // compiles the depth material it renders casters with. Both carry the patch.
  renderer.render(scene, camera);
  renderer.render(scene, camera);

  // Read back before anything else touches the context. `preserveDrawingBuffer`
  // is what makes this legal after the draw has finished.
  const gl = renderer.getContext();
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let litPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0) > 12) litPixels++;
  }
  // Kept, so the contact sheet below is built from the very bytes just counted.
  // Screenshotting the page instead looked fine and was not: four live WebGL
  // contexts and the compositor between them handed back a frame from an earlier
  // state, so the picture and the number it was meant to illustrate disagreed.
  frames.push({ label, pixels });

  const programs = renderer.info.programs?.length ?? 0;
  const triangles = renderer.info.render.triangles;
  let radius = 0;
  field.group.traverse((node) => {
    if (node instanceof THREE.InstancedMesh) radius = Math.max(radius, node.boundingSphere?.radius ?? -1);
  });
  field.dispose();
  renderer.dispose();
  return {
    label, smooth, swayNormals, programs, batches, flatShaded, instances, litPixels, triangles, radius,
    bounds: [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z],
  };
}

// Lean the trees hard and put the clock somewhere mid-gust before drawing
// anything. At the default wind and t=0 the bend angle is near zero, so the
// normal rotation is the identity and the case that is supposed to exercise it
// would draw exactly like the case that is not -- a comparison that proves the
// shader links and nothing else.
setWindStrength(2);
advanceWind(7.3);

const results = CASES.map(({ smooth, swayNormals, label }) => runCase(smooth, swayNormals, label));
window.shadingProbeSheet = contactSheet();
window.shadingProbe = results;
