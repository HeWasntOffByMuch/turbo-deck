import * as THREE from 'three';
import { arenaBounds, type LoadedMap, type MapDocument } from '../../../terrain/index.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../shared/world.js';
import type { ViewHandle } from '../movement.js';
import { PALETTE } from '../palette.js';
import { buildPropField } from '../props.js';
import { viewSeed } from '../seed.js';
import { buildTerrainMeshFromChunks, type TerrainMeshHandle } from '../terrain-mesh.js';
import { CAMERA_FAR, CAMERA_NEAR, DEFAULT_LIGHT_OFFSET } from '../view-settings.js';
import {
  createEditorCamera,
  editorCameraPosition,
  orbitEditorCamera,
  panEditorCamera,
  zoomEditorCamera,
  type EditorCameraState,
} from './camera.js';
import { EditorInputCapture } from './input.js';
import { bakeEditorMap } from './map-source.js';

/**
 * The map editor tab (spec 049).
 *
 * The fourth view in the shell, and the only one that renders from a **map
 * document** rather than from the generator. The world is baked once at mount and
 * everything below reads exclusively from the result -- the terrain mesh from
 * `map.chunks`, the props from `map.props`, the ground height from
 * `map.world.heightAt`. That indirection is the whole point of the tab: from the
 * first frame the editor is looking at the data path, so when a brush lands it
 * changes arrays in `map.store` and rebuilds, and nothing else has to move.
 *
 * The game is untouched. Combat still builds its world through `createArenaWorld`
 * exactly as before; this is a separate view with its own scene, the same way the
 * movement sandbox is the only tab that mounts a rig picker.
 *
 * Two departures from every other view, both deliberate:
 *
 * - **No retro pass** (spec 038) and no low-resolution upscale. The posterizing
 *   filter destroys thin geometry, and a brush ring, a marker billboard or a nav
 *   overlay is exactly that -- a ring would flicker in and out of existence as it
 *   moved. Being an accurate preview of the game's look is not this tab's job.
 * - **A camera that follows nothing**, unlocked from the isometric constraint.
 *   See `camera.ts`, which owns every rule about where it may go.
 */

/** Sun and fill, matching the movement sandbox's unshadowed lighting. */
const SUN_COLOR = 0xfff4e0;
const SUN_INTENSITY = 2.1;
const FILL_COLOR = 0x8090a0;
const FILL_INTENSITY = 1.1;

/** How far the sun is placed along its direction. Orthographic, so this is arbitrary but stable. */
const SUN_DISTANCE = 3000;

/** The editor's scene: a baked map, lit, with a free camera over it. */
class EditorScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly terrainMesh: TerrainMeshHandle;
  private renderW = 0;
  private renderH = 0;
  private lastHalfWidth = -1;
  private lastAspect = -1;
  private readonly lookTarget = new THREE.Vector3();

  /** The loaded document everything in this scene was built from. */
  readonly map: LoadedMap;
  readonly document: MapDocument;
  camera3: EditorCameraState;

  constructor(
    readonly canvas: HTMLCanvasElement,
    seed: number,
  ) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    // No `image-rendering: pixelated` and no low-res buffer: the editor draws at
    // the size of its box, so a one-pixel overlay stays one pixel.

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.scene.background = new THREE.Color(PALETTE.sky);

    // Bake the generated world, then forget it. Everything below reads `map`.
    const baked = bakeEditorMap(seed);
    this.document = baked.document;
    this.map = baked.map;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR);
    this.camera3 = createEditorCamera({
      // Opens over the middle of the play area, standing on the ground there.
      target: {
        x: PLAY_WIDTH / 2,
        y: this.map.world.heightAt(PLAY_WIDTH / 2, PLAY_HEIGHT / 2),
        z: PLAY_HEIGHT / 2,
      },
      bounds: arenaBounds(),
    });
    this.resize();

    const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    sun.position.set(
      DEFAULT_LIGHT_OFFSET.x * SUN_DISTANCE,
      DEFAULT_LIGHT_OFFSET.y * SUN_DISTANCE,
      DEFAULT_LIGHT_OFFSET.z * SUN_DISTANCE,
    );
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(FILL_COLOR, FILL_INTENSITY));

    this.terrainMesh = buildTerrainMeshFromChunks(this.map.meshLayers, this.map.chunks);
    this.scene.add(this.terrainMesh.group);
    this.scene.add(buildPropField(this.map.props, (x, z) => this.map.world.heightAt(x, z)).group);
  }

  /** The surfaces a cursor raycast should hit. The brush enters here in step 4. */
  get pickTargets(): THREE.Object3D[] {
    return this.terrainMesh.pickTargets;
  }

  /** Match the drawing buffer to the canvas's box. Cheap to call every frame. */
  private resize(): void {
    const width = this.canvas.clientWidth || this.canvas.width || 1;
    const height = this.canvas.clientHeight || this.canvas.height || 1;
    if (width === this.renderW && height === this.renderH) return;
    this.renderW = width;
    this.renderH = height;
    this.renderer.setSize(width, height, false);
    this.lastHalfWidth = -1; // force the frustum to be rebuilt for the new aspect
  }

  render(): void {
    this.resize();
    const aspect = this.renderH === 0 ? 1 : this.renderW / this.renderH;
    const hw = this.camera3.halfWidth;
    if (hw !== this.lastHalfWidth || aspect !== this.lastAspect) {
      this.camera.left = -hw;
      this.camera.right = hw;
      this.camera.top = hw / aspect;
      this.camera.bottom = -hw / aspect;
      this.camera.updateProjectionMatrix();
      this.lastHalfWidth = hw;
      this.lastAspect = aspect;
    }

    const at = editorCameraPosition(this.camera3);
    this.camera.position.set(at.x, at.y, at.z);
    this.lookTarget.set(this.camera3.target.x, this.camera3.target.y, this.camera3.target.z);
    this.camera.lookAt(this.lookTarget);

    // Straight to the screen: no RetroPass, so nothing posterizes the overlays
    // every later step of the editor draws.
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.terrainMesh.dispose();
    this.renderer.dispose();
  }
}

const OVERLAY_CSS =
  "font-family:'Courier New',ui-monospace,monospace;font-size:11px;line-height:1.6;letter-spacing:.04em;" +
  'color:#c8c8d8;background:rgba(12,12,18,.82);border:1px solid #2a2a3a;padding:7px 10px;' +
  'box-shadow:2px 2px 0 rgba(0,0,0,.5);pointer-events:none;';

/**
 * Mount the map editor into `container`, returning a start/stop handle.
 *
 * No fixed-timestep loop and no sim: there is no game state here to advance, only
 * a camera to move and a scene to draw, so the frame is driven by real elapsed
 * time directly. That is not a determinism exception -- nothing in this view can
 * decide a game outcome.
 */
export function mountEditor(container: HTMLElement): ViewHandle {
  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#0b0b12;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;';

  const help = document.createElement('div');
  help.style.cssText = `${OVERLAY_CSS}position:absolute;left:10px;bottom:10px;z-index:20;`;
  help.innerHTML =
    '<b style="color:#f0f0f8;">Map editor</b> &mdash; rendering from a baked map document<br>' +
    '<b>WASD</b> / arrows pan &middot; <b>right-drag</b> or <b>middle-drag</b> orbits &middot; <b>wheel</b> zooms<br>' +
    '<span style="color:#7a7a90;">left-click is reserved for the tools</span>';

  const readout = document.createElement('div');
  readout.style.cssText = `${OVERLAY_CSS}position:absolute;right:10px;bottom:10px;z-index:20;text-align:right;`;

  root.append(canvas, help, readout);
  container.appendChild(root);

  const scene = new EditorScene(canvas, viewSeed());
  const input = new EditorInputCapture(canvas);

  const chunks = scene.document.layers.reduce((n, layer) => n + layer.chunks.length, 0);
  const props = scene.map.props.length;

  let running = false;
  let lastFrame: number | undefined;

  const frame = (time: number): void => {
    if (!running) return;
    // Real elapsed seconds, capped so a backgrounded tab does not resume with one
    // enormous pan step.
    const dt = lastFrame === undefined ? 0 : Math.min(0.1, (time - lastFrame) / 1000);
    lastFrame = time;

    const drag = input.takeDrag();
    if (drag.dx !== 0 || drag.dy !== 0) scene.camera3 = orbitEditorCamera(scene.camera3, drag.dx, drag.dy);
    const wheel = input.takeWheel();
    if (wheel.deltaY !== 0) scene.camera3 = zoomEditorCamera(scene.camera3, wheel.deltaY, wheel.deltaMode);
    const pan = input.panAxes();
    if (pan.forward !== 0 || pan.right !== 0) {
      scene.camera3 = panEditorCamera(scene.camera3, pan.forward, pan.right, dt);
    }

    canvas.style.cursor = input.isOrbiting ? 'grabbing' : 'default';
    scene.render();

    const c = scene.camera3;
    readout.innerHTML =
      `at <b>${Math.round(c.target.x)}, ${Math.round(c.target.z)}</b> &middot; ` +
      `span <b>${Math.round(c.halfWidth)}</b> &middot; ` +
      `pitch <b>${Math.round((c.elevation * 180) / Math.PI)}&deg;</b><br>` +
      `<span style="color:#7a7a90;">${chunks} chunks &middot; ${props} props</span>`;

    requestAnimationFrame(frame);
  };

  return {
    element: root,
    start(): void {
      if (running) return;
      running = true;
      lastFrame = undefined;
      input.attach(window);
      requestAnimationFrame(frame);
    },
    stop(): void {
      running = false;
      input.detach();
    },
  };
}
