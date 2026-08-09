import * as THREE from 'three';
import type { Prop } from '../../terrain/vegetation.js';
import { buildPropField } from './props.js';
import { DEFAULT_CREASE_ANGLE } from './shading.js';
import { advanceWind, setWindStrength } from './wind-uniforms.js';
import { decodeOctahedral } from './shading.js';
import { HikeBuffers, type BufferView } from './hike-buffers.js';
import { HikeEdges } from './hike-edges.js';
import { HIKE_OFF, paletteById } from './hike.js';
import type { InkSettings } from './ink.js';
import { RetroPass } from './retro-pass.js';
import { RETRO_DEFAULTS } from './retro.js';
import { buildTerrainMeshFromChunks } from './terrain-mesh.js';
import { CURVATURE_UNIFORMS } from './terrain-curvature.js';
import { installPoissonShadows } from './shadow-pcf.js';
import { DETAIL_UNIFORMS, buildDetailTexture } from './terrain-detail.js';
import type { TerrainChunk } from '../../terrain/index.js';
import type { MeshLayer } from '../../terrain/map-world.js';

/**
 * A dev-server-only rig that proves the shading switches' shaders actually
 * compile and link (spec 097, step 2). Never in a build: `vite build` bundles
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

/**
 * The same props, spread along the axis the camera looks down.
 *
 * The ink case needs geometry -- and therefore outlines -- at both ends of the
 * depth range, or "the far lines are as dark as the near ones" is a claim about
 * a band with no lines in it. The camera looks along roughly (-0.71, -0.71) in
 * the ground plane, so that is the axis the clusters walk.
 */
const INK_PROPS: readonly Prop[] = [
  { kind: 'tree', x: 270, y: 250, scale: 1, rotation: 0, tint: 0 },
  { kind: 'tree', x: 200, y: 320, scale: 1.15, rotation: 1.3, tint: 0.3 },
  { kind: 'bush', x: 320, y: 180, scale: 1, rotation: 0.5, tint: 0.2 },

  { kind: 'tree', x: 20, y: -10, scale: 1.1, rotation: 2.1, tint: -0.2 },
  { kind: 'bush', x: -60, y: 60, scale: 0.9, rotation: 0.9, tint: 0.1 },

  { kind: 'tree', x: -250, y: -270, scale: 1, rotation: 0.4, tint: 0.15 },
  { kind: 'tree', x: -330, y: -190, scale: 1.2, rotation: 2.6, tint: -0.3 },
  { kind: 'bush', x: -190, y: -330, scale: 1, rotation: 1.7, tint: 0 },
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

/** What one depth/normal buffer check found (spec 100). */
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
  /** Whether an opaque unlit solid -- a projectile -- reached the buffer. It must. */
  readonly shotMissing: boolean;
  /** Whether a marked in-world readout reached the buffer. It must not. */
  readonly readoutLeaked: boolean;
}

/** What the outline pass found (spec 101). */
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

/** What quantizing onto a palette produced (spec 102). */
export interface PaletteProbeCase {
  /** Distinct colours in the frame. Must not exceed the palette's size. */
  readonly distinct: number;
  readonly paletteSize: number;
  /**
   * Fraction of pixels that are exactly a palette entry.
   *
   * The claim a palette makes, stated the only way it can be: not "it looks
   * limited" but "every pixel is one of these sixteen colours".
   */
  readonly onPalette: number;
  /** Distinct colours in the same frame quantized onto even steps instead. */
  readonly distinctStepped: number;
  /** Whether the two frames differ at all. */
  readonly changedFrame: boolean;
}

/** What the distance treatment did to the frame (spec 103). */
export interface InkProbeCase {
  /** Where the treatment was ramped, in world units, and the depth range of the frame. */
  readonly inkStart: number;
  readonly inkEnd: number;
  readonly depthNearest: number;
  readonly depthFurthest: number;
  readonly nearPixels: number;
  readonly farPixels: number;
  /**
   * Fraction of near fill pixels that changed at all.
   *
   * Must be ~0: in front of the ramp the treatment is the identity, and a
   * distance effect that touches the foreground is a filter over the whole frame
   * wearing a distance effect's name.
   */
  readonly nearFillChanged: number;
  /** The same for the far band, which must be nearly all of it. */
  readonly farFillChanged: number;
  /** Mean distance from the sky colour, 0..1, before and after, in each band. */
  readonly nearFogGapOff: number;
  readonly nearFogGap: number;
  readonly farFogGapOff: number;
  readonly farFogGap: number;
  /**
   * Standard deviation of luminance across the far band's fills, before and
   * after. The shading gradient, measured: the claim is that distant geometry
   * stops being lit surfaces and becomes single-tone shapes.
   */
  readonly farSpreadOff: number;
  readonly farSpread: number;
  /**
   * Mean value of a full-strength outline pixel in the composited frame, near and
   * far. **The core of the effect**: the fills recede, and these two numbers stay
   * the same. If distance reached the lines, the far one would be lighter.
   */
  readonly nearLine: number;
  readonly farLine: number;
  readonly nearLinePixels: number;
  readonly farLinePixels: number;
  /** The colour a line actually landed at, so the setting can be held to it. */
  readonly lineColor: readonly [number, number, number];
  /** What `outlineColor` says it should be. */
  readonly lineColorWanted: readonly [number, number, number];
}

/** What baking the ground's creases did (spec 104). */
export interface CurvatureProbeCase {
  /** Cells the synthetic chunk marked as folded, and as flat. */
  readonly creasedCells: number;
  readonly flatCells: number;
  /** Fraction of pixels over folded ground that got darker with the switch on. */
  readonly creasedDarkened: number;
  /** Mean darkening there, 0..1. */
  readonly creasedAmount: number;
  /** Fraction of pixels over flat ground that changed at all. Must be zero. */
  readonly flatChanged: number;
  /** Pixels anywhere that got *brighter*. Must be zero -- a cavity only darkens. */
  readonly brightened: number;
  /** The same measurement at half strength, to check it tracks the setting. */
  readonly halfAmount: number;
  /** Distinct greys in the debug view. One means the attribute never reached the shader. */
  readonly debugDistinct: number;
  /**
   * Mean baked cavity in the middle of the dip, and out on its rim.
   *
   * The one claim here that does not come from the shader's own attribute. Every
   * other number compares the frame against the debug view, which is the same
   * quantity twice -- so a measure with its sign flipped, darkening ridges
   * instead of hollows, would agree with itself perfectly and pass. This asks
   * where in the picture the darkening actually landed, and the answer is known
   * from the geometry: the dip is in the middle of the frame.
   */
  readonly centreCavity: number;
  readonly rimCavity: number;
  /** Whether the wind streak patch survived being composed with this one. */
  readonly streakAlive: boolean;
}

/** What the soft-shadow filter did (spec 105). */
export interface ShadowProbeCase {
  /** Pixels fully in shadow, and fully lit, with the filter off. */
  readonly shadowPixels: number;
  readonly litPixels: number;
  /**
   * Pixels sitting between the two, hard and soft.
   *
   * The penumbra, counted. With an unfiltered lookup there is essentially none --
   * a pixel is inside the shadow or outside it -- so this rising by an order of
   * magnitude is the effect, stated as the thing it is.
   */
  readonly partialHard: number;
  readonly partialSoft: number;
  /** Mean shadowed area, off and on. A filter softens an edge; it must not move it. */
  readonly areaHard: number;
  readonly areaSoft: number;
  /** Pixels of open ground far from any caster that changed. Must be zero. */
  readonly openGroundChanged: number;
  /** Whether the scene had any shadow in it at all, so a null result is visible. */
  readonly castingWorked: boolean;
}

/** What the generated detail texture did (spec 106). */
export interface DetailProbeCase {
  /** Distinct colours over the cliff face, with the switch off and on. */
  readonly cliffTonesOff: number;
  readonly cliffTonesOn: number;
  /**
   * Variation measured *down* a vertical face against variation *across* it.
   *
   * The claim triplanar exists for. A ground-plane UV smears one row of texels
   * down the whole height, so this ratio comes out in the tens; a triplanar
   * projection samples a vertical face from the horizontal projections and the
   * two are comparable.
   */
  readonly smearRatio: number;
  /** Flat ground below the slope threshold, which the blend must leave untouched. */
  readonly flatGroundChanged: number;
  /** Pixels the rock blend moved at all, so a blend that did nothing is visible. */
  readonly blendChanged: number;
  /** Read off the uploaded texture, not off the code that set it. */
  readonly mipmapped: boolean;
  readonly anisotropy: number;
  readonly minFilterIsMipmap: boolean;
  /** Whether all three ground patches survived being composed. */
  readonly streakAlive: boolean;
  readonly creasesAlive: boolean;
  /** The LOD measurement the spec declines to act on, re-run so it stays honest. */
  readonly mapInstances: number;
  readonly mapBatches: number;
  readonly mapTriangles: number;
}

declare global {
  interface Window {
    /** Filled once every case has drawn; `probe-shading.ts` polls for it. */
    shadingProbe?: readonly ShadingProbeCase[];
    /** The four buffers as one labelled PNG data URL. Written before `shadingProbe`. */
    shadingProbeSheet?: string;
    /** What the depth and normal buffers came back with (spec 100). */
    bufferProbe?: readonly BufferProbeCase[];
    /** What the outline pass found (spec 101). */
    edgeProbe?: EdgeProbeCase;
    /** What quantizing onto a palette produced (spec 102). */
    paletteProbe?: PaletteProbeCase;
    /** What the distance treatment did (spec 103). */
    inkProbe?: InkProbeCase;
    /** What baking the ground's creases did (spec 104). */
    curvatureProbe?: CurvatureProbeCase;
    /** What the soft-shadow filter did (spec 105). */
    shadowProbe?: ShadowProbeCase;
    /** What the generated detail texture did (spec 106). */
    detailProbe?: DetailProbeCase;
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
 * through the debug blit (spec 100).
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

  // An opaque *unlit* solid, which is what a projectile is: bright by design, and
  // still a surface. It has to be in the buffers. The rule used to be "is it
  // Lambert", which excluded every arrow in the game the day they landed.
  const shot = new THREE.Mesh(
    new THREE.BoxGeometry(28, 28, 28),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8 }),
  );
  shot.position.set(120, 150, -120);
  scene.add(shot);

  // And an opaque unlit thing that is *not* a surface: a facing readout drawn in
  // the world. Marked, and must stay out.
  const readout = new THREE.Mesh(
    new THREE.ConeGeometry(20, 40, 4),
    new THREE.MeshBasicMaterial({ color: 0xffe08a }),
  );
  readout.position.set(-140, 150, 120);
  readout.userData['isOverlay'] = true;
  scene.add(readout);

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
  const differs = (a: Uint8Array, b: Uint8Array): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  };

  scene.remove(decal);
  const decalLeaked = differs(pixels, grab());
  scene.add(decal);

  // The same comparison, both ways round. An opaque unlit solid must change the
  // buffer; a marked readout must not.
  scene.remove(shot);
  const shotMissing = !differs(pixels, grab());
  scene.add(shot);

  scene.remove(readout);
  const readoutLeaked = differs(pixels, grab());
  scene.add(readout);

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
    shotMissing,
    readoutLeaked,
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

/**
 * Render a frame through the retro pass with a palette, and check that the
 * palette is what came out.
 *
 * Not "does it look limited" -- the frame is read back and every pixel is looked
 * up in the palette. A quantizer that is subtly wrong, or a palette texture that
 * never uploaded, produces a frame that still looks stylized and is not on the
 * palette at all.
 */
function runPalette(): PaletteProbeCase {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fd6c8);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(300, 600, 300);
  scene.add(sun);
  const field = buildPropField(PROPS, () => 0, undefined, {
    smooth: false,
    creaseAngle: DEFAULT_CREASE_ANGLE,
    swayNormals: false,
  });
  scene.add(field.group);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshLambertMaterial({ color: 0x556633, flatShading: true }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const half = 240;
  const camera = new THREE.OrthographicCamera(-half, half, half * 0.75, -half * 0.75, 1, 4000);
  camera.position.set(700, 620, 700);
  camera.lookAt(27, 95, 30);

  const retro = new RetroPass(CELL_W, CELL_H, RETRO_DEFAULTS);
  const gl = renderer.getContext();
  const shoot = (palette: readonly number[] | null): Uint8Array => {
    retro.setPalette(palette);
    retro.render(renderer, scene, camera);
    const out = new Uint8Array(CELL_W * CELL_H * 4);
    gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const colors = paletteById('world') ?? [];
  const stepped = shoot(null);
  const painted = shoot(colors);
  frames.push({ label: 'palette: world', pixels: painted });

  const allowed = new Set(colors);
  const seen = new Set<number>();
  const seenStepped = new Set<number>();
  let onPalette = 0;
  let changed = false;
  for (let i = 0; i < painted.length; i += 4) {
    const hex = ((painted[i] ?? 0) << 16) | ((painted[i + 1] ?? 0) << 8) | (painted[i + 2] ?? 0);
    seen.add(hex);
    if (allowed.has(hex)) onPalette++;
    seenStepped.add(((stepped[i] ?? 0) << 16) | ((stepped[i + 1] ?? 0) << 8) | (stepped[i + 2] ?? 0));
    if (painted[i] !== stepped[i]) changed = true;
  }

  field.dispose();
  retro.dispose();
  renderer.dispose();

  return {
    distinct: seen.size,
    paletteSize: colors.length,
    onPalette: onPalette / (painted.length / 4),
    distinctStepped: seenStepped.size,
    changedFrame: changed,
  };
}

/**
 * Run the distance treatment over a scene deep enough to have a near and a far
 * end, and measure the one claim that separates this effect from ordinary fog
 * (spec 103).
 *
 * Fog everything and the far hills go soft. What is being built instead is fills
 * that recede under lines that do not: the treatment runs inside the retro pass,
 * on colour, and the outline pass composites afterwards at a constant. So the
 * measurement is not "did the frame change" -- it is *which parts* changed. Far
 * fills must move and far lines must not, and the two are measured in the same
 * frame at the same time so no bookkeeping error can make them agree by accident.
 *
 * `inkEdgeGain` is pinned at 1 here on purpose. It is a real setting and it does
 * something, but it changes *which pixels* are edges with distance -- and this
 * check is about what an edge pixel is *worth*. Leaving it on would let a changed
 * mask masquerade as a changed line.
 */
function runInk(): InkProbeCase {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });

  const sky = new THREE.Color(0x8fd6c8);
  const scene = new THREE.Scene();
  scene.background = sky;
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(300, 600, 300);
  scene.add(sun);

  const field = buildPropField(INK_PROPS, () => 0, undefined, {
    smooth: false,
    creaseAngle: DEFAULT_CREASE_ANGLE,
    swayNormals: false,
  });
  scene.add(field.group);
  // Wide enough that the frame is ground from top to bottom, so every depth band
  // has a surface in it rather than a hole.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(3000, 3000),
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
  const retro = new RetroPass(CELL_W, CELL_H, { ...RETRO_DEFAULTS, enabled: false });
  const gl = renderer.getContext();
  const read = (): Uint8Array => {
    const out = new Uint8Array(CELL_W * CELL_H * 4);
    gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  buffers.capture(renderer, scene, camera);
  buffers.blit(renderer, 'depth');
  const depthBytes = read();

  // The same origin the play view uses: the camera's distance to what it is
  // looking at. Everything below is therefore depth *past the focus*, which is
  // what the settings are in -- and exercising it here is the point, since the
  // first version of this measured from the camera and the whole frame came out
  // past the far end of the ramp.
  const origin = camera.position.distanceTo(new THREE.Vector3(27, 95, 30));
  const toWorld = (byte: number): number =>
    camera.near + (byte / 255) * (camera.far - camera.near) - origin;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < depthBytes.length; i += 4) {
    const b = depthBytes[i] ?? 255;
    if (b >= 255) continue;
    lo = Math.min(lo, b);
    hi = Math.max(hi, b);
  }
  const depthNearest = toWorld(lo);
  const depthFurthest = toWorld(hi);
  const span = depthFurthest - depthNearest;
  const inkStart = depthNearest + span * 0.3;
  const inkEnd = depthNearest + span * 0.7;

  const off: InkSettings = { inkStart, inkEnd, inkFlatten: 0, inkDesaturate: 0, inkFog: 0 };
  // The values the build ships with, not 1.0 across the board: what is being
  // checked here is the frame the panel produces. `ink.test.ts` already pins the
  // arithmetic at its extremes.
  const on: InkSettings = {
    inkStart,
    inkEnd,
    inkFlatten: HIKE_OFF.inkFlatten,
    inkDesaturate: HIKE_OFF.inkDesaturate,
    inkFog: HIKE_OFF.inkFog,
  };
  const hike = {
    ...HIKE_OFF,
    buffers: true,
    edges: true,
    ink: true,
    inkStart,
    inkEnd,
    inkEdgeGain: 1,
    outlineMinNeighbours: 0,
  };

  const shoot = (ink: InkSettings, withLines: boolean): Uint8Array => {
    buffers.capture(renderer, scene, camera);
    retro.setInk(buffers.depthTexture, camera.near, camera.far, origin, sky, ink);
    retro.render(renderer, scene, camera);
    if (withLines) {
      edges.render(
        renderer, buffers.normalTexture, buffers.depthTexture, camera, CELL_W, CELL_H, hike, false, origin,
      );
    }
    return read();
  };

  // The baseline goes through the same quad with the three amounts at zero,
  // rather than skipping the pass: comparing against a frame that took a
  // different path would fold every difference between the paths into the
  // measurement of the effect.
  const plain = shoot(off, false);
  const inked = shoot(on, false);
  const composited = shoot(on, true);

  buffers.capture(renderer, scene, camera);
  edges.render(
    renderer, buffers.normalTexture, buffers.depthTexture, camera, CELL_W, CELL_H, hike, true, origin,
  );
  const mask = read();

  frames.push({ label: 'ink: fills recede', pixels: inked });
  frames.push({ label: 'ink + outlines composited', pixels: composited });

  const skyRgb = [(0x8f), (0xd6), (0xc8)];
  const value = (px: Uint8Array, i: number): number =>
    ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0)) / 3;
  const luma = (px: Uint8Array, i: number): number =>
    ((px[i] ?? 0) * 0.2126 + (px[i + 1] ?? 0) * 0.7152 + (px[i + 2] ?? 0) * 0.0722) / 255;
  const fogGap = (px: Uint8Array, i: number): number => {
    let sum = 0;
    for (let c = 0; c < 3; c++) sum += Math.abs((px[i + c] ?? 0) - (skyRgb[c] ?? 0));
    return sum / 3 / 255;
  };

  // Two depth steps of slack at each boundary: the bands are classified from an
  // 8-bit blit while the shader ramps from the full-precision depth texture, and
  // a pixel that straddles the difference belongs to neither band.
  const margin = ((camera.far - camera.near) / 255) * 2;

  let nearPixels = 0;
  let farPixels = 0;
  let nearChanged = 0;
  let farChanged = 0;
  let nearGapOff = 0;
  let nearGapOn = 0;
  let farGapOff = 0;
  let farGapOn = 0;
  const farLumaOff: number[] = [];
  const farLumaOn: number[] = [];
  let nearLine = 0;
  let farLine = 0;
  let nearLinePixels = 0;
  let farLinePixels = 0;
  const lineSum = [0, 0, 0];

  for (let i = 0; i < depthBytes.length; i += 4) {
    const b = depthBytes[i] ?? 255;
    if (b >= 255) continue;
    const depth = toWorld(b);
    const isNear = depth < inkStart - margin;
    const isFar = depth > inkEnd + margin;
    if (!isNear && !isFar) continue;
    // Full strength only: a partially covered edge pixel is a blend of the line
    // and the fill underneath, and the fill is the thing that changes.
    const isLine = (mask[i] ?? 0) >= 250;

    if (isLine) {
      const v = value(composited, i);
      for (let c = 0; c < 3; c++) lineSum[c] = (lineSum[c] ?? 0) + (composited[i + c] ?? 0);
      if (isNear) {
        nearLine += v;
        nearLinePixels++;
      } else {
        farLine += v;
        farLinePixels++;
      }
      continue;
    }

    const changed =
      plain[i] !== inked[i] || plain[i + 1] !== inked[i + 1] || plain[i + 2] !== inked[i + 2];
    if (isNear) {
      nearPixels++;
      if (changed) nearChanged++;
      nearGapOff += fogGap(plain, i);
      nearGapOn += fogGap(inked, i);
    } else {
      farPixels++;
      if (changed) farChanged++;
      farGapOff += fogGap(plain, i);
      farGapOn += fogGap(inked, i);
      farLumaOff.push(luma(plain, i));
      farLumaOn.push(luma(inked, i));
    }
  }

  const stdDev = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  };
  const lines = nearLinePixels + farLinePixels;

  field.dispose();
  buffers.dispose();
  edges.dispose();
  retro.dispose();
  renderer.dispose();

  return {
    inkStart,
    inkEnd,
    depthNearest,
    depthFurthest,
    nearPixels,
    farPixels,
    nearFillChanged: nearPixels === 0 ? 1 : nearChanged / nearPixels,
    farFillChanged: farPixels === 0 ? 0 : farChanged / farPixels,
    nearFogGapOff: nearPixels === 0 ? 0 : nearGapOff / nearPixels,
    nearFogGap: nearPixels === 0 ? 0 : nearGapOn / nearPixels,
    farFogGapOff: farPixels === 0 ? 0 : farGapOff / farPixels,
    farFogGap: farPixels === 0 ? 0 : farGapOn / farPixels,
    farSpreadOff: stdDev(farLumaOff),
    farSpread: stdDev(farLumaOn),
    nearLine: nearLinePixels === 0 ? 0 : nearLine / nearLinePixels,
    farLine: farLinePixels === 0 ? 0 : farLine / farLinePixels,
    nearLinePixels,
    farLinePixels,
    lineColor: lines === 0
      ? [0, 0, 0]
      : [
          Math.round((lineSum[0] ?? 0) / lines),
          Math.round((lineSum[1] ?? 0) / lines),
          Math.round((lineSum[2] ?? 0) / lines),
        ],
    lineColorWanted: [
      (HIKE_OFF.outlineColor >> 16) & 0xff,
      (HIKE_OFF.outlineColor >> 8) & 0xff,
      HIKE_OFF.outlineColor & 0xff,
    ],
  };
}

/**
 * A chunk with a smooth round dip in the middle of it and flat ground around it.
 *
 * Built by hand rather than sampled, so the answer is known before the frame is
 * drawn, and analytically rather than by finite difference, so the normals are
 * the ones the surface actually has instead of the ones a stencil approximates.
 *
 * A Gaussian dip rather than a trench, for two reasons found by trying the
 * trench first:
 *
 *  - a fold that varies in only one direction has half the *mean* curvature of
 *    its profile, since the other two edges of every cell are dead flat. That is
 *    correct behaviour and it halves the signal, which made the fixture weaker
 *    than it looked.
 *  - eight cells across a symmetric trench produce about three distinct cavity
 *    values, so "the baked attribute varies" could not be asserted at all. A
 *    round dip gives a different value at almost every cell.
 *
 * It also has a convex rim, which is the part that must come out as *no* cavity.
 */
function bowlChunk(cols: number, rows: number, cellSize: number): TerrainChunk {
  const stride = cols + 1;
  const corners = stride * (rows + 1);
  const heights = new Float32Array(corners);
  const cornerX = new Float32Array(corners);
  const cornerZ = new Float32Array(corners);
  const normals = new Float32Array(corners * 3);

  const centreX = (cols * cellSize) / 2;
  const centreZ = (rows * cellSize) / 2;
  // Sized so the deepest cell turns through about 0.3 radians across its own
  // width -- under CAVITY_FULL_TURN, so the measure ramps instead of clamping.
  const radius = 110;
  const depth = 80;

  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * stride + i;
      const x = i * cellSize;
      const z = j * cellSize;
      const dx = x - centreX;
      const dz = z - centreZ;
      const fall = Math.exp(-(dx * dx + dz * dz) / (radius * radius));
      cornerX[k] = x;
      cornerZ[k] = z;
      heights[k] = -depth * fall;
      // dy/dx = 2*depth*dx*fall/radius², and likewise for z.
      const slopeX = (2 * depth * dx * fall) / (radius * radius);
      const slopeZ = (2 * depth * dz * fall) / (radius * radius);
      const length = Math.hypot(slopeX, 1, slopeZ);
      normals[k * 3] = -slopeX / length;
      normals[k * 3 + 1] = 1 / length;
      normals[k * 3 + 2] = -slopeZ / length;
    }
  }

  const cells = cols * rows;
  return {
    layerId: 'probe',
    coord: { cx: 0, cz: 0 },
    originX: 0,
    originZ: 0,
    cols,
    rows,
    startCol: 0,
    startRow: 0,
    cellSize,
    heights,
    cornerX,
    cornerZ,
    normals,
    solid: new Uint8Array(cells).fill(1),
    materials: new Uint8Array(cells),
    tones: new Uint8Array(cells),
    baseY: -400,
    waterLevel: null,
  };
}

/**
 * Mesh that chunk through the real mesher and measure what the crease switch does
 * to the frame (spec 104).
 *
 * The real mesher and the real material on purpose. The measure itself is already
 * pinned in `curvature.test.ts`; what cannot be checked in Node is whether the
 * baked attribute survives the trip -- and in particular whether this patch
 * composes with the wind streak that is already on the same material, since
 * `onBeforeCompile` is a single slot and overwriting it would silently stop the
 * grass moving.
 */
function runCurvature(): CurvatureProbeCase {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });

  const cols = 24;
  const rows = 24;
  const cellSize = 22;
  const chunk = bowlChunk(cols, rows, cellSize);
  const span = cols * cellSize;
  const layer: MeshLayer = {
    id: 'probe',
    bounds: { minX: 0, minZ: 0, maxX: span, maxZ: rows * cellSize },
    waterLevel: null,
    solidAt: (col, row) => col >= 0 && row >= 0 && col < cols && row < rows,
    materialAt: () => 0,
  };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101018);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(300, 600, 300);
  scene.add(sun);
  const terrain = buildTerrainMeshFromChunks([layer], [chunk]);
  scene.add(terrain.group);

  // Straight down, so every cell is seen the same way and the only thing that can
  // differ between two pixels is the ground under them.
  const half = span / 2;
  const camera = new THREE.OrthographicCamera(-half, half, half * 0.75, -half * 0.75, 1, 4000);
  camera.position.set(half, 900, (rows * cellSize) / 2);
  camera.lookAt(half, 0, (rows * cellSize) / 2);
  camera.updateMatrixWorld(true);

  const gl = renderer.getContext();
  const shoot = (strength: number, only: number): Uint8Array => {
    CURVATURE_UNIFORMS.uCavityStrength.value = strength;
    CURVATURE_UNIFORMS.uCavityOnly.value = only;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const out = new Uint8Array(CELL_W * CELL_H * 4);
    gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const off = shoot(0, 0);
  const on = shoot(0.6, 0);
  const half6 = shoot(0.3, 0);
  const debug = shoot(0, 1);
  CURVATURE_UNIFORMS.uCavityStrength.value = 0;
  CURVATURE_UNIFORMS.uCavityOnly.value = 0;
  frames.push({ label: 'creases baked from corner normals', pixels: debug });

  // Which pixels are over folded ground is read out of the debug frame rather
  // than reasoned about from the geometry: it is the very quantity the shader
  // used, so a disagreement between the two cannot hide here.
  const value = (px: Uint8Array, i: number): number =>
    ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0)) / 3;

  let centreCavity = 0;
  let centrePixels = 0;
  let rimCavity = 0;
  let rimPixels = 0;
  let creasedCells = 0;
  let flatCells = 0;
  let creasedDarkened = 0;
  let creasedAmount = 0;
  let halfAmount = 0;
  let flatChanged = 0;
  let brightened = 0;
  const greys = new Set<number>();

  for (let i = 0; i < off.length; i += 4) {
    // Background is very dark and identical in every frame; skip it.
    if (value(off, i) < 12) continue;
    const cavity = 255 - (debug[i] ?? 255);

    // Where in the frame this pixel is. The camera looks straight down at the
    // centre of the dip, so distance from the middle of the image is distance
    // from the middle of the dip -- and that holds however the degenerate
    // straight-down `lookAt` ends up rotating the frame about its own axis.
    const pixel = i / 4;
    const px = pixel % CELL_W;
    const py = Math.floor(pixel / CELL_W);
    const radius = Math.hypot(px - CELL_W / 2, py - CELL_H / 2);
    if (radius < 40) {
      centreCavity += cavity;
      centrePixels++;
    } else if (radius > 90 && radius < 130) {
      rimCavity += cavity;
      rimPixels++;
    }

    greys.add(debug[i] ?? 0);
    const before = value(off, i);
    const after = value(on, i);
    if (after > before + 0.5) brightened++;

    if (cavity > 24) {
      creasedCells++;
      if (before - after > 1) creasedDarkened++;
      creasedAmount += (before - after) / Math.max(1, before);
      halfAmount += (before - value(half6, i)) / Math.max(1, before);
    } else if (cavity === 0) {
      flatCells++;
      if (before !== after) flatChanged++;
    }
  }

  // The streak patch has to have survived being composed with this one. Its
  // signature is that the ground is not perfectly uniform across cells that share
  // a colour and a normal -- which the flat half of this chunk is, apart from it.
  let streakGreys = 0;
  const seenFlat = new Set<number>();
  for (let i = 0; i < off.length; i += 4) {
    if (value(off, i) < 12) continue;
    if ((255 - (debug[i] ?? 255)) !== 0) continue;
    seenFlat.add(off[i] ?? 0);
  }
  streakGreys = seenFlat.size;

  terrain.dispose();
  renderer.dispose();

  return {
    creasedCells,
    flatCells,
    creasedDarkened: creasedCells === 0 ? 0 : creasedDarkened / creasedCells,
    creasedAmount: creasedCells === 0 ? 0 : creasedAmount / creasedCells,
    halfAmount: creasedCells === 0 ? 0 : halfAmount / creasedCells,
    flatChanged: flatCells === 0 ? 1 : flatChanged / flatCells,
    brightened,
    debugDistinct: greys.size,
    centreCavity: centrePixels === 0 ? 0 : centreCavity / centrePixels / 255,
    rimCavity: rimPixels === 0 ? 0 : rimCavity / rimPixels / 255,
    streakAlive: streakGreys > 1,
  };
}

/**
 * Cast a hard-edged shadow onto flat ground and measure what the filter does to
 * its edge (spec 105).
 *
 * The claim is narrow and worth keeping narrow: a filter widens the band of
 * partially-shadowed pixels and does nothing else. It must not move the shadow,
 * and it must not touch ground the shadow never reached -- a filter that dims
 * open ground is one that is sampling outside its own frustum test, which looks
 * like the scene got darker rather than like a shadow bug.
 */
function runShadows(): ShadowProbeCase {
  installPoissonShadows();

  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.shadowMap.enabled = true;
  // The type this project actually ships (spec 045): no filtering at all, so the
  // branch the patch replaced is the branch being exercised.
  renderer.shadowMap.type = THREE.BasicShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101018);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(260, 700, 200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(512, 512);
  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = -400;
  shadowCamera.right = 400;
  shadowCamera.top = 400;
  shadowCamera.bottom = -400;
  shadowCamera.near = 1;
  shadowCamera.far = 2000;
  shadowCamera.updateProjectionMatrix();
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshLambertMaterial({ color: 0x8a8a78 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // One blocky caster, well clear of the ground, so its shadow has long straight
  // edges -- the easiest possible thing to measure the width of.
  const caster = new THREE.Mesh(
    new THREE.BoxGeometry(120, 120, 120),
    new THREE.MeshLambertMaterial({ color: 0x99553c }),
  );
  caster.position.set(-40, 190, -30);
  caster.castShadow = true;
  scene.add(caster);

  const half = 320;
  const camera = new THREE.OrthographicCamera(-half, half, half * 0.75, -half * 0.75, 1, 4000);
  camera.position.set(0, 1200, 0.001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const gl = renderer.getContext();
  const shoot = (radius: number): Uint8Array => {
    sun.shadow.radius = radius;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const out = new Uint8Array(CELL_W * CELL_H * 4);
    gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const hard = shoot(0);
  const soft = shoot(4);
  frames.push({ label: 'soft shadow (Poisson disc)', pixels: soft });

  const value = (px: Uint8Array, i: number): number =>
    ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0)) / 3;

  /**
   * Whether a pixel is floor rather than the caster's own lit top face.
   *
   * By hue, not by brightness. Lambert scales all three channels by the same
   * number, so the ratio between two of them survives being lit or shadowed and
   * identifies the material: the floor is a warm grey (blue/red about 0.87) and
   * the caster is a strong red-brown (about 0.39).
   *
   * The first version of this took the frame's brightest pixel as "fully lit
   * floor" -- which was the caster's top face, so every lit floor pixel then
   * scored as partially shadowed and the unfiltered frame reported a 3,600-pixel
   * penumbra it does not have.
   */
  const isFloor = (px: Uint8Array, i: number): boolean => {
    const r = px[i] ?? 0;
    const b = px[i + 2] ?? 0;
    if (r < 8) return false;
    return b / r > 0.7;
  };

  // The floor's two levels, read out of the hard frame rather than assumed: fully
  // lit and fully shadowed are whatever this light and this albedo produce.
  let lit = 0;
  let shade = 255;
  for (let i = 0; i < hard.length; i += 4) {
    if (!isFloor(hard, i)) continue;
    const v = value(hard, i);
    lit = Math.max(lit, v);
    shade = Math.min(shade, v);
  }
  const band = lit - shade;

  let shadowPixels = 0;
  let litPixels = 0;
  let partialHard = 0;
  let partialSoft = 0;
  let areaHard = 0;
  let areaSoft = 0;
  let openGroundChanged = 0;

  for (let i = 0; i < hard.length; i += 4) {
    if (!isFloor(hard, i)) continue;
    const h = value(hard, i);
    const s = value(soft, i);
    const hFrac = band > 0 ? (h - shade) / band : 1;
    const sFrac = band > 0 ? (s - shade) / band : 1;

    if (hFrac < 0.08) {
      shadowPixels++;
      areaHard++;
    } else if (hFrac > 0.92) {
      litPixels++;
    } else {
      partialHard++;
      areaHard += 1 - hFrac;
    }
    if (sFrac < 0.08) areaSoft++;
    else if (sFrac <= 0.92) {
      partialSoft++;
      areaSoft += 1 - sFrac;
    }

    // Open ground: lit in the hard frame and nowhere near the edge, so no tap of
    // a four-texel kernel could legitimately reach a blocker.
    if (hFrac > 0.99) {
      let nearEdge = false;
      for (let dy = -6; dy <= 6 && !nearEdge; dy += 2) {
        for (let dx = -6; dx <= 6; dx += 2) {
          const j = i + (dy * CELL_W + dx) * 4;
          if (j < 0 || j >= hard.length || !isFloor(hard, j)) continue;
          const n = value(hard, j);
          if (band > 0 && (n - shade) / band < 0.99) {
            nearEdge = true;
            break;
          }
        }
      }
      if (!nearEdge && Math.abs(h - s) > 0.5) openGroundChanged++;
    }
  }

  renderer.dispose();

  return {
    shadowPixels,
    litPixels,
    partialHard,
    partialSoft,
    areaHard,
    areaSoft,
    openGroundChanged,
    castingWorked: shadowPixels > 200 && litPixels > 200,
  };
}

/**
 * Draw a terrain chunk with a tall cliff in it and measure what the generated
 * texture does to it (spec 106).
 *
 * The measurement that matters is the smear. Any texture at all makes a cliff
 * more interesting than one flat tone, so "there are more colours now" would pass
 * with a mapping that is completely wrong. What separates triplanar from a
 * ground-plane UV is what happens *down* a vertical face: the wrong mapping
 * stretches a single row of texels over the whole drop, so the face varies across
 * its width and not at all down its height.
 */
function runDetail(): DetailProbeCase {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });

  const cols = 24;
  const rows = 24;
  const cellSize = 22;
  // A plateau: flat low ground, one tall step, flat high ground. The step becomes
  // a wall in the mesher, which is the surface under test.
  const stride = cols + 1;
  const corners = stride * (rows + 1);
  const heights = new Float32Array(corners);
  const cornerX = new Float32Array(corners);
  const cornerZ = new Float32Array(corners);
  const normals = new Float32Array(corners * 3);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * stride + i;
      cornerX[k] = i * cellSize;
      cornerZ[k] = j * cellSize;
      heights[k] = j >= rows / 2 ? 300 : 0;
      normals[k * 3] = 0;
      normals[k * 3 + 1] = 1;
      normals[k * 3 + 2] = 0;
    }
  }
  const cells = cols * rows;
  const solid = new Uint8Array(cells).fill(1);
  // A hole along the step, so the mesher skirts it and builds a real wall.
  for (let i = 0; i < cols; i++) solid[Math.floor(rows / 2) * cols + i] = 0;

  const chunk: TerrainChunk = {
    layerId: 'probe',
    coord: { cx: 0, cz: 0 },
    originX: 0,
    originZ: 0,
    cols,
    rows,
    startCol: 0,
    startRow: 0,
    cellSize,
    heights,
    cornerX,
    cornerZ,
    normals,
    solid,
    materials: new Uint8Array(cells),
    tones: new Uint8Array(cells),
    baseY: -200,
    waterLevel: null,
  };
  const layer: MeshLayer = {
    id: 'probe',
    bounds: { minX: 0, minZ: 0, maxX: cols * cellSize, maxZ: rows * cellSize },
    waterLevel: null,
    solidAt: (col, row) =>
      col >= 0 && row >= 0 && col < cols && row < rows && solid[row * cols + col] === 1,
    materialAt: () => 0,
  };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a10);
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const terrain = buildTerrainMeshFromChunks([layer], [chunk]);
  scene.add(terrain.group);

  // Square on to the cliff face, so "down the face" is straight down the image
  // and "across it" is straight across -- which is what makes the smear ratio a
  // measurement rather than a projection exercise.
  const half = 200;
  const camera = new THREE.OrthographicCamera(-half, half, half * 0.75, -half * 0.75, 1, 4000);
  camera.position.set((cols * cellSize) / 2, 150, (rows * cellSize) / 2 - 500);
  camera.lookAt((cols * cellSize) / 2, 100, (rows * cellSize) / 2);
  camera.updateMatrixWorld(true);

  const texture = buildDetailTexture(renderer.capabilities.getMaxAnisotropy());
  DETAIL_UNIFORMS.uDetailMap.value = texture;

  const gl = renderer.getContext();
  const shoot = (detail: number, blend: number): Uint8Array => {
    DETAIL_UNIFORMS.uDetailStrength.value = detail;
    DETAIL_UNIFORMS.uBlendStrength.value = blend;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    const out = new Uint8Array(CELL_W * CELL_H * 4);
    gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const off = shoot(0, 0);
  const on = shoot(0.35, 0);
  const blended = shoot(0, 0.9);
  DETAIL_UNIFORMS.uDetailStrength.value = 0;
  DETAIL_UNIFORMS.uBlendStrength.value = 0;
  frames.push({ label: 'triplanar detail on a cliff', pixels: on });

  const value = (px: Uint8Array, i: number): number =>
    ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0)) / 3;

  // The cliff, found by hue rather than by geometry: the wall material is a grey
  // stone and the surface above and below it is a warm green.
  const isCliff = (i: number): boolean => {
    const r = off[i] ?? 0;
    const g = off[i + 1] ?? 0;
    const b = off[i + 2] ?? 0;
    if (r < 20) return false;
    return b / Math.max(1, g) > 0.75 && Math.abs(r - g) < 40;
  };

  const cliffTones = (px: Uint8Array): number => {
    const seen = new Set<number>();
    for (let i = 0; i < px.length; i += 4) {
      if (!isCliff(i)) continue;
      seen.add(((px[i] ?? 0) << 16) | ((px[i + 1] ?? 0) << 8) | (px[i + 2] ?? 0));
    }
    return seen.size;
  };

  // Variation down the face against variation across it. A ground-plane UV gives
  // a column that never changes and a row that changes fast.
  let downSteps = 0;
  let downCount = 0;
  let acrossSteps = 0;
  let acrossCount = 0;
  for (let y = 1; y < CELL_H - 1; y++) {
    for (let x = 1; x < CELL_W - 1; x++) {
      const i = (y * CELL_W + x) * 4;
      if (!isCliff(i)) continue;
      const below = i - CELL_W * 4;
      const right = i + 4;
      if (isCliff(below)) {
        downSteps += Math.abs(value(on, i) - value(on, below));
        downCount++;
      }
      if (isCliff(right)) {
        acrossSteps += Math.abs(value(on, i) - value(on, right));
        acrossCount++;
      }
    }
  }
  const down = downCount === 0 ? 0 : downSteps / downCount;
  const across = acrossCount === 0 ? 0 : acrossSteps / acrossCount;

  // The blend must leave flat ground alone: it is the slope and the height that
  // earn bare rock, and the low plateau has neither.
  let flatGroundChanged = 0;
  let blendChanged = 0;
  for (let i = 0; i < off.length; i += 4) {
    if (value(off, i) < 20) continue;
    if (Math.abs(value(off, i) - value(blended, i)) > 0.5) blendChanged++;
    // Low flat ground: the green surface in the bottom half of the frame.
    const pixel = i / 4;
    const y = Math.floor(pixel / CELL_W);
    if (!isCliff(i) && y < CELL_H * 0.35) {
      if (off[i] !== blended[i] || off[i + 1] !== blended[i + 1] || off[i + 2] !== blended[i + 2]) {
        flatGroundChanged++;
      }
    }
  }

  // Whether the other two ground patches survived being composed with this one.
  // `onBeforeCompile` is a single slot; assigning instead of wrapping would drop
  // the weather and the creases silently.
  const surfaceShader = terrain.group.children.find(
    (c) => c instanceof THREE.Mesh && (c.material as THREE.Material).name !== 'wall',
  );
  const programs = renderer.info.programs ?? [];
  const source = programs.map((p) => (p as unknown as { cacheKey?: string }).cacheKey ?? '').join('|');

  // The LOD measurement the spec declines to act on, re-run so the numbers in it
  // stay true as the map grows.
  const lodField = buildPropField(INK_PROPS, () => 0, undefined, {
    smooth: false,
    creaseAngle: DEFAULT_CREASE_ANGLE,
    swayNormals: false,
  });
  let mapBatches = 0;
  let mapInstances = 0;
  let mapTriangles = 0;
  lodField.group.traverse((node) => {
    if (!(node instanceof THREE.InstancedMesh)) return;
    mapBatches++;
    mapInstances += node.count;
    const position = node.geometry.getAttribute('position');
    const perInstance = node.geometry.index
      ? node.geometry.index.count / 3
      : (position?.count ?? 0) / 3;
    mapTriangles += perInstance * node.count;
  });
  lodField.dispose();

  const result: DetailProbeCase = {
    cliffTonesOff: cliffTones(off),
    cliffTonesOn: cliffTones(on),
    smearRatio: down === 0 ? 0 : across / down,
    flatGroundChanged,
    blendChanged,
    mipmapped: texture.generateMipmaps,
    anisotropy: texture.anisotropy,
    minFilterIsMipmap: texture.minFilter === THREE.LinearMipmapLinearFilter,
    streakAlive: source.includes('wind-streak'),
    creasesAlive: source.includes('curvature') && surfaceShader !== undefined,
    mapInstances,
    mapBatches,
    mapTriangles: Math.round(mapTriangles),
  };

  terrain.dispose();
  texture.dispose();
  DETAIL_UNIFORMS.uDetailMap.value = null;
  renderer.dispose();
  return result;
}

const results = CASES.map(({ smooth, swayNormals, label }) => runCase(smooth, swayNormals, label));
window.bufferProbe = [runBuffers('depth'), runBuffers('normals')];
window.edgeProbe = runEdges();
window.paletteProbe = runPalette();
window.inkProbe = runInk();
window.curvatureProbe = runCurvature();
window.shadowProbe = runShadows();
window.detailProbe = runDetail();
window.shadingProbeSheet = contactSheet();
window.shadingProbe = results;
