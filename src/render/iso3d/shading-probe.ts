import * as THREE from 'three';
import type { Prop } from '../../terrain/vegetation.js';
import { buildPropField } from './props.js';
import { DEFAULT_CREASE_ANGLE } from './shading.js';
import { advanceWind, setWindStrength } from './wind-uniforms.js';
import { decodeOctahedral } from './shading.js';
import { HikeBuffers, type BufferView } from './hike-buffers.js';
import { HikeEdges } from './hike-edges.js';
import { HIKE_OFF } from './hike.js';

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

/** What one depth/normal buffer check found (spec 090). */
export interface BufferProbeCase {
  readonly label: string;
  readonly view: BufferView;
  /** Distinct values in the buffer. One means it is a constant, i.e. not bound. */
  readonly distinct: number;
  /**
   * Fraction of the frame with no surface in it. Zero means the check that a
   * background is even distinguishable never ran.
   */
  readonly backgroundFraction: number;
  /** Fraction of the frame that is not background. */
  readonly covered: number;
  /**
   * Depth only: the nearest and furthest values written, 0..255. A depth texture
   * that never got bound reads as a flat 0 or a flat 255.
   */
  readonly nearest: number;
  readonly furthest: number;
  /**
   * Normals only: of the pixels that are surfaces, the fraction whose decoded
   * normal points toward the camera. Most of a frame does, so a number near zero
   * means the encode, the decode or the view-space transform is inverted.
   */
  readonly facingCamera: number;
  /**
   * Whether a translucent ground decal changed the buffer. It must not: removing
   * it from the scene has to leave the frame byte-identical.
   */
  readonly decalLeaked: boolean;
}

/** What the outline pass found (spec 091). */
export interface EdgeProbeCase {
  /** Fraction of the frame marked as edge, with the sky masked out. */
  readonly edgeFraction: number;
  /** The same with the far plane allowed to take part. */
  readonly edgeFractionSky: number;
  /**
   * Mean brightness of the *composited* frame -- the lit scene with the outlines
   * drawn over it.
   *
   * The check that was missing when "turn on outlines" turned the world black.
   * Everything else here measures the mask, and the mask was right the whole
   * time; what was wrong was the pass clearing the canvas before blending over
   * it, which no amount of looking at a mask would reveal.
   */
  readonly compositeMean: number;
  /** The same frame without the outline pass, for comparison. */
  readonly frameMean: number;
  /** Fraction of the composited frame that is outline-dark. */
  readonly compositeLines: number;
  /**
   * Fraction of the *floor* marked as edge.
   *
   * The number the plane reconstruction exists for. The floor is a single flat
   * surface seen at a glancing angle: a raw depth-difference test covers it in
   * lines, and measuring against each neighbour's own plane leaves it clean.
   */
  readonly floorEdgeFraction: number;
}

declare global {
  interface Window {
    /** Filled once every case has drawn; `probe-shading.ts` polls for it. */
    shadingProbe?: readonly ShadingProbeCase[];
    /** The four buffers as one labelled PNG data URL. Written before `shadingProbe`. */
    shadingProbeSheet?: string;
    /** What the depth and normal buffers came back with (spec 090). */
    bufferProbe?: readonly BufferProbeCase[];
    /** What the outline pass found (spec 091). */
    edgeProbe?: EdgeProbeCase;
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
  const rows = Math.ceil(frames.length / 2);
  const sheet = document.createElement('canvas');
  sheet.width = pad + 2 * (CELL_W + pad);
  sheet.height = pad + rows * (CELL_H + label + pad);
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

/**
 * Capture the depth/normal buffers for the same scene and read one of them back
 * through the debug blit (spec 090).
 *
 * Through the blit, not by reading the target: a depth attachment cannot be
 * `readPixels`'d at all, so sampling it in a shader and writing the result
 * somewhere readable is the only way to find out whether the depth texture is
 * bound and carries anything. Which is exactly the step "verify the depth texture
 * path works before building anything on it" asks for -- and the first thing that
 * would silently be a flat grey rectangle if it were not.
 */
function runBuffers(view: BufferView): BufferProbeCase {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const field = buildPropField(PROPS, () => 0, undefined, {
    smooth: false,
    creaseAngle: DEFAULT_CREASE_ANGLE,
    swayNormals: false,
  });
  scene.add(field.group);

  // A big flat floor, so there is a surface whose normal is known: world up. In
  // view space that has to come back pointing toward the camera, which is the
  // claim that catches an inverted encode.
  // Deliberately smaller than the view: the checks below need somewhere in the
  // frame with no surface in it, and a floor to the horizon leaves none.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(520, 520),
    new THREE.MeshLambertMaterial({ color: 0x556633, flatShading: true }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // A translucent unlit decal of the kind the world puts on the ground -- a
  // target ring, a telegraph, a move marker. It must not appear in the buffers at
  // all: it is not a surface, and an outline pass that saw it would ring every
  // telegraph in the game.
  //
  // Placed over the floor and lifted well clear of it, so that if it *did* leak
  // it would be unmistakable: a ring of much nearer depth in the middle of a flat
  // gradient. A decal lying on the ground would differ by less than one
  // quantization step and the check would pass whatever happened.
  const decal = new THREE.Mesh(
    new THREE.RingGeometry(60, 90, 24),
    new THREE.MeshBasicMaterial({ color: 0xff6a5a, transparent: true, opacity: 0.8, depthWrite: false }),
  );
  decal.rotation.x = -Math.PI / 2;
  decal.position.set(-60, 120, -60);
  scene.add(decal);

  const half = 240;
  const camera = new THREE.OrthographicCamera(-half, half, half * 0.75, -half * 0.75, 1, 4000);
  camera.position.set(700, 620, 700);
  camera.lookAt(27, 95, 30);
  camera.updateMatrixWorld(true);

  const buffers = new HikeBuffers(CELL_W, CELL_H);
  const gl = renderer.getContext();
  const grab = (): Uint8Array => {
    buffers.capture(renderer, scene, camera);
    buffers.blit(renderer, view);
    const out = new Uint8Array(CELL_W * CELL_H * 4);
    gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const pixels = grab();
  // The decal claim, stated as the thing it actually means: taking it out of the
  // scene must change nothing. Comparing frames is a stronger check than looking
  // for its shape, and it cannot pass by accident.
  scene.remove(decal);
  const withoutDecal = grab();
  let decalLeaked = false;
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] !== withoutDecal[i]) {
      decalLeaked = true;
      break;
    }
  }

  frames.push({ label: `${view} buffer`, pixels });

  // What "nothing here" looks like after the blit, which is not what it looks
  // like in the buffer. Depth clears to the far plane, so 255. The normal target
  // clears to black, and the blit *decodes* that: (0,0) unfolds to (0,0,-1),
  // which is written out as (0.5, 0.5, 0) -- a direction pointing away from the
  // camera, which no visible surface has, so it doubles as the marker.
  const isBackground = (r: number, g: number, b: number): boolean =>
    view === 'depth' ? r === 255 : Math.abs(r - 128) <= 1 && Math.abs(g - 128) <= 1 && b <= 1;

  const seen = new Set<number>();
  let nearest = 255;
  let furthest = 0;
  let background = 0;
  let facing = 0;
  let surfaces = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    seen.add((r << 16) | (g << 8) | b);
    if (isBackground(r, g, b)) {
      background++;
      continue;
    }
    surfaces++;
    if (view === 'depth') {
      nearest = Math.min(nearest, r);
      furthest = Math.max(furthest, r);
    } else {
      const n = decodeOctahedral([r / 255, g / 255]);
      // +z in view space is toward the camera.
      if (n[2] > 0) facing++;
    }
  }
  const total = CELL_W * CELL_H;

  field.dispose();
  buffers.dispose();
  renderer.dispose();

  return {
    label: `${view} buffer`,
    view,
    distinct: seen.size,
    backgroundFraction: background / total,
    covered: surfaces / total,
    nearest,
    furthest,
    facingCamera: surfaces === 0 ? 0 : facing / surfaces,
    decalLeaked,
  };
}

/**
 * Run the outline pass over the same scene and measure what it marked.
 *
 * The floor is the interesting part. It is one flat plane seen at a glancing
 * angle and it fills most of the frame -- exactly the surface a naive
 * depth-difference test covers in lines, and exactly the surface the plane
 * reconstruction is there to leave alone. So "how much of the floor is edge" is
 * the number that says whether the depth test works, and no amount of looking at
 * a tree silhouette would tell you.
 */
function runEdges(): EdgeProbeCase {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const field = buildPropField(PROPS, () => 0, undefined, {
    smooth: false,
    creaseAngle: DEFAULT_CREASE_ANGLE,
    swayNormals: false,
  });
  scene.add(field.group);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(520, 520),
    new THREE.MeshLambertMaterial({ color: 0x556633, flatShading: true }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const half = 240;
  const camera = new THREE.OrthographicCamera(-half, half, half * 0.75, -half * 0.75, 1, 4000);
  camera.position.set(700, 620, 700);
  camera.lookAt(27, 95, 30);
  camera.updateMatrixWorld(true);

  const buffers = new HikeBuffers(CELL_W, CELL_H);
  const edges = new HikeEdges();
  const gl = renderer.getContext();

  const depthShot = (): Uint8Array => {
    buffers.capture(renderer, scene, camera);
    buffers.blit(renderer, 'depth');
    const out = new Uint8Array(CELL_W * CELL_H * 4);
    gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  // Which pixels are *bare* floor: solid with the props gone, and at the same
  // depth once they are back. The second half matters -- without it every tree
  // outline drawn over the floor counts as a floor edge, and the measurement
  // stops being about the floor at all. It reported 8% that way, and the floor
  // is visibly spotless.
  scene.remove(field.group);
  const floorOnly = depthShot();
  scene.add(field.group);
  const withProps = depthShot();

  const maskFor = (sky: boolean): Uint8Array => {
    buffers.capture(renderer, scene, camera);
    edges.render(
      renderer,
      buffers.normalTexture,
      buffers.depthTexture,
      camera,
      CELL_W,
      CELL_H,
      { ...HIKE_OFF, buffers: true, edges: true, outlineAgainstSky: sky },
      true,
    );
    const out = new Uint8Array(CELL_W * CELL_H * 4);
    gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const mask = maskFor(false);
  const maskSky = maskFor(true);
  frames.push({ label: 'edge mask', pixels: mask });

  // And the composite: the lit frame, then the outline pass over it. Measured
  // against the same frame without the pass, because "did the outlines eat the
  // picture" is a comparison and not a threshold.
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(300, 600, 300);
  scene.add(sun);
  scene.background = new THREE.Color(0x8fd6c8);

  const litFrame = (withOutlines: boolean): Uint8Array => {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    if (withOutlines) {
      buffers.capture(renderer, scene, camera);
      edges.render(
        renderer,
        buffers.normalTexture,
        buffers.depthTexture,
        camera,
        CELL_W,
        CELL_H,
        { ...HIKE_OFF, buffers: true, edges: true },
        false,
      );
    }
    const out = new Uint8Array(CELL_W * CELL_H * 4);
    gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const plain = litFrame(false);
  const composited = litFrame(true);
  frames.push({ label: 'outlines over the frame', pixels: composited });

  const meanOf = (px: Uint8Array): number => {
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0)) / 3;
    return sum / (px.length / 4) / 255;
  };
  let darkened = 0;
  for (let i = 0; i < composited.length; i += 4) {
    const before = ((plain[i] ?? 0) + (plain[i + 1] ?? 0) + (plain[i + 2] ?? 0)) / 3;
    const after = ((composited[i] ?? 0) + (composited[i + 1] ?? 0) + (composited[i + 2] ?? 0)) / 3;
    if (before - after > 20) darkened++;
  }

  const total = CELL_W * CELL_H;
  let edgePixels = 0;
  let edgePixelsSky = 0;
  let floorPixels = 0;
  let floorEdges = 0;
  for (let i = 0; i < mask.length; i += 4) {
    const lit = (mask[i] ?? 0) > 127;
    if (lit) edgePixels++;
    if ((maskSky[i] ?? 0) > 127) edgePixelsSky++;
    const isFloor = (floorOnly[i] ?? 255) < 250 && floorOnly[i] === withProps[i];
    if (isFloor) {
      floorPixels++;
      if (lit) floorEdges++;
    }
  }

  field.dispose();
  buffers.dispose();
  edges.dispose();
  renderer.dispose();

  return {
    edgeFraction: edgePixels / total,
    edgeFractionSky: edgePixelsSky / total,
    floorEdgeFraction: floorPixels === 0 ? 1 : floorEdges / floorPixels,
    frameMean: meanOf(plain),
    compositeMean: meanOf(composited),
    compositeLines: darkened / total,
  };
}

const results = CASES.map(({ smooth, swayNormals, label }) => runCase(smooth, swayNormals, label));
window.bufferProbe = [runBuffers('depth'), runBuffers('normals')];
window.edgeProbe = runEdges();
window.shadingProbeSheet = contactSheet();
window.shadingProbe = results;
