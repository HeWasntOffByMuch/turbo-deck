import * as THREE from 'three';
import { loadShippedMap } from './map-asset.js';
import { loadMap } from '../../terrain/index.js';
import type { Prop } from '../../terrain/vegetation.js';
import { buildTerrainMeshFromChunks } from './terrain-mesh.js';
import { buildPropField } from './props.js';
import { PALETTE } from './palette.js';
import { FIXED_DAYLIGHT } from './daynight.js';
import { RetroPass } from './retro-pass.js';
import { CAMERA_FAR, CAMERA_NEAR, DEFAULT_CAMERA_OFFSET, DEFAULT_LIGHT_OFFSET } from './view-settings.js';
import { internalRenderSize } from './view-frame.js';
import { SHADOW_MAP_SIZE } from './shadow.js';
import { advanceWind, resetWind, windTimeUniform } from './wind-uniforms.js';
import { WATER, WIND } from './wind.js';

/**
 * The measuring rig for the weather (spec 074).
 *
 * Dev-server only -- `vite build` bundles `index.html` and nothing else, so
 * this page is never part of a shipped build. It exists because the acceptance
 * questions for spec 074 are all of the form "what does the *frame* do", and
 * the Play tab cannot answer any of them: its camera follows the player, so it
 * cannot be pointed at a coastline; its clock runs from real time, so two runs
 * never photograph the same instant; and it draws one scene, so there is
 * nothing to compare a frame time against.
 *
 * This draws the same world through the same mesher and the same prop field,
 * and adds the three things a measurement needs: a camera that can be put
 * anywhere, a clock that can be set to an exact second, and a switch that
 * strips the weather back out so the two can be timed against each other in one
 * process on one GPU.
 *
 * Driven by `scripts/preview-wind.ts`. Query parameters:
 *
 * - `at=x,z`      where to point the camera, world units
 * - `span=n`      orthographic half-width, world units (default 320)
 * - `t=seconds`   freeze the wind clock here instead of running it
 * - `retro=0`     skip the posterizing pass, to see what the water shader alone
 *                 produces (the colour-picker check)
 * - `trees=x,z`   replace the map's props with two trees 20 units apart along
 *                 the wind axis, standing at this point
 * - `baseline=1`  strip the sway, the streak and the water shader back out
 * - `shadows=0`   no shadow pass
 *
 * `window.windProbe` exposes `ready`, `setTime`, `frameMs()` and `reset()`.
 */

interface ProbeApi {
  ready: boolean;
  setTime(seconds: number): void;
  /** Median and mean of the frames drawn since the last `reset()`, in ms. */
  frameMs(): { median: number; mean: number; samples: number };
  reset(): void;
  windTime(): number;
  /**
   * A world point in CSS pixels within the canvas.
   *
   * Exposed rather than re-derived in the driving script, because a script's
   * own copy of the projection would be the thing under test rather than the
   * camera the frame was actually drawn with.
   */
  project(x: number, y: number, z: number): { x: number; y: number };
  /**
   * Every shader program the renderer has compiled, by cache key, with the
   * vertex attributes it actually declared.
   *
   * The decisive answer to "did the shadow pass get the sway patch". Pixel
   * diffing can only say that some shade moved a little; this says whether the
   * depth and distance programs were compiled with `aWindBase` bound at all,
   * which they cannot be unless the splice landed.
   */
  programs(): { key: string; attributes: string[] }[];
}

declare global {
  var windProbe: ProbeApi | undefined;
}

const params = new URLSearchParams(globalThis.location.search);
const numbers = (name: string, fallback: readonly number[]): number[] => {
  const raw = params.get(name);
  if (!raw) return [...fallback];
  const parts = raw.split(',').map(Number);
  return parts.some((n) => !Number.isFinite(n)) ? [...fallback] : parts;
};
const flag = (name: string, fallback: boolean): boolean => {
  const raw = params.get(name);
  return raw === null ? fallback : raw !== '0' && raw !== 'false';
};

const [atX = 0, atZ = 0] = numbers('at', [0, 0]);
const span = numbers('span', [320])[0] ?? 320;
const frozen = params.has('t') ? (numbers('t', [0])[0] ?? 0) : null;
const useRetro = flag('retro', true);
const useShadows = flag('shadows', true);
const baseline = flag('baseline', false);
const treesAt = params.has('trees') ? numbers('trees', [0, 0]) : null;

const app = document.getElementById('app') as HTMLElement;
const canvas = document.createElement('canvas');
canvas.style.width = '100%';
canvas.style.height = '100%';
canvas.style.display = 'block';
canvas.style.imageRendering = 'pixelated';
app.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = useShadows;
renderer.shadowMap.type = THREE.BasicShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);

// Top-level await, which this page can afford and the tabs cannot (spec 199):
// this is a dev-server-only rig with no shell above it to keep responsive, so
// the whole module simply waits for the map rather than restructuring around it.
const map = loadMap((await loadShippedMap()).doc);
const terrain = buildTerrainMeshFromChunks(map.meshLayers, map.chunks);
scene.add(terrain.group);

/**
 * Two trees the wind reaches at measurably different moments, when asked for.
 * Placed rather than found: the scatter keeps trunks a hundred-odd units apart,
 * so a pair 20 units apart along the wind axis does not occur in the real world
 * and the acceptance question is about the *field*, not about the scatter.
 */
function probeTrees(x: number, z: number): Prop[] {
  const make = (offset: number): Prop => ({
    kind: 'tree',
    x: x + WIND.dirX * offset,
    y: z + WIND.dirZ * offset,
    scale: 1,
    rotation: 0,
    tint: 0.5,
  });
  return [make(-10), make(10)];
}

const props = treesAt ? probeTrees(treesAt[0] ?? 0, treesAt[1] ?? 0) : map.props;
const propField = buildPropField(props, (x, z) => map.world.heightAt(x, z));
scene.add(propField.group);

/**
 * Put the scene back the way it looked before spec 074, in place: the sway
 * patch off the trees and off their two shadow materials, the streak off the
 * ground, and the water back to a plain unlit quad of the old flat colour.
 *
 * Done by walking the built scene rather than by a second code path, so what is
 * being timed against is *this* geometry with *this* draw-call count and only
 * the shaders changed. Anything else would be measuring the wrong difference.
 */
function stripWeather(): void {
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.material instanceof THREE.ShaderMaterial) {
      object.material = new THREE.MeshBasicMaterial({ color: WATER.deep });
      return;
    }
    // A fresh clone, because onBeforeCompile is the patch and clearing it on a
    // shared module-level material would strip the scene twice over.
    const copy = (object.material as THREE.Material).clone();
    copy.onBeforeCompile = (): void => undefined;
    copy.customProgramCacheKey = (): string => 'baseline';
    object.material = copy;
    if (object instanceof THREE.InstancedMesh) {
      object.customDepthMaterial = undefined as unknown as THREE.Material;
      object.customDistanceMaterial = undefined as unknown as THREE.Material;
    }
  });
}
if (baseline) stripWeather();

const sun = new THREE.DirectionalLight(FIXED_DAYLIGHT.lightColor, FIXED_DAYLIGHT.lightIntensity);
sun.castShadow = useShadows;
sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
sun.shadow.camera.left = -span;
sun.shadow.camera.right = span;
sun.shadow.camera.top = span;
sun.shadow.camera.bottom = -span;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 8000;
scene.add(sun, sun.target, new THREE.AmbientLight(FIXED_DAYLIGHT.ambientColor, FIXED_DAYLIGHT.ambientIntensity));

const target = new THREE.Vector3(atX, map.world.heightAt(atX, atZ), atZ);
sun.target.position.copy(target);
sun.position.set(
  target.x + DEFAULT_LIGHT_OFFSET.x * 2000,
  target.y + DEFAULT_LIGHT_OFFSET.y * 2000,
  target.z + DEFAULT_LIGHT_OFFSET.z * 2000,
);

const camera = new THREE.OrthographicCamera(-span, span, span, -span, CAMERA_NEAR, CAMERA_FAR);
camera.position.set(
  target.x + DEFAULT_CAMERA_OFFSET.x,
  target.y + DEFAULT_CAMERA_OFFSET.y,
  target.z + DEFAULT_CAMERA_OFFSET.z,
);
camera.lookAt(target);

const retro = new RetroPass(1, 1);

let width = 0;
let height = 0;
function resize(): void {
  const box = canvas.getBoundingClientRect();
  const size = internalRenderSize(box.width || 1, box.height || 1);
  if (size.width === width && size.height === height) return;
  width = size.width;
  height = size.height;
  renderer.setSize(width, height, false);
  retro.setSize(width, height);
  const aspect = width / height;
  camera.left = -span * aspect;
  camera.right = span * aspect;
  camera.top = span;
  camera.bottom = -span;
  camera.updateProjectionMatrix();
}

/** Frame times, as a ring buffer -- the caller decides what window to average. */
const samples: number[] = [];
const SAMPLE_CAP = 240;
let last = 0;

resetWind();
if (frozen !== null) windTimeUniform.value = frozen;

const gl = renderer.getContext();

function frame(now: number): void {
  const dt = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000);
  const first = last === 0;
  last = now;
  if (frozen === null) advanceWind(dt);
  resize();

  const started = performance.now();
  if (useRetro) retro.render(renderer, scene, camera);
  else renderer.render(scene, camera);
  // WebGL is asynchronous: a stopwatch around `render()` alone times the
  // command submission, not the drawing. `finish()` blocks until the work is
  // actually done, which is the only way to compare two scenes honestly from
  // inside the page.
  gl.finish();
  if (!first && samples.length < SAMPLE_CAP) samples.push(performance.now() - started);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

globalThis.windProbe = {
  ready: true,
  setTime(seconds: number): void {
    windTimeUniform.value = seconds;
  },
  windTime(): number {
    return windTimeUniform.value;
  },
  frameMs(): { median: number; mean: number; samples: number } {
    if (samples.length === 0) return { median: 0, mean: 0, samples: 0 };
    // Both, because they answer different questions. The median throws away a
    // scheduling hiccup that a mean would let dominate; the mean sees past the
    // browser's 0.1ms clock granularity, which the median cannot.
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      mean: samples.reduce((a, b) => a + b, 0) / samples.length,
      samples: samples.length,
    };
  },
  programs(): { key: string; attributes: string[] }[] {
    return renderer.info.programs?.map((program) => ({
      key: String(program.cacheKey).slice(0, 60),
      attributes: Object.keys(program.getAttributes()).filter((name) => name.startsWith('a')),
    })) ?? [];
  },
  project(x: number, y: number, z: number): { x: number; y: number } {
    const point = new THREE.Vector3(x, y, z).project(camera);
    const box = canvas.getBoundingClientRect();
    return { x: ((point.x + 1) / 2) * box.width, y: ((1 - point.y) / 2) * box.height };
  },
  reset(): void {
    samples.length = 0;
  },
};
document.body.dataset['probeReady'] = 'true';
