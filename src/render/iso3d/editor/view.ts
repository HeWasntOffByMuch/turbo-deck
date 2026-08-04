import * as THREE from 'three';
import { arenaBounds, type LoadedMap, type MapDocument } from '../../../terrain/index.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../shared/world.js';
import type { ViewHandle } from '../movement.js';
import { PALETTE } from '../palette.js';
import { buildPropField, type PropFieldHandle } from '../props.js';
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
import { Rng } from '../../../shared/prng.js';
import { applyTerrainBrush } from './brush.js';
import { createBrushCursor, type BrushCursorHandle } from './cursor.js';
import { EditHistory } from './history.js';
import { EditorInputCapture } from './input.js';
import { createArenaOutline, createMarkerView } from './marker-view.js';
import { eraseMarkers, placeMarker } from './markers.js';
import { bakeLayerNav, rebakeNav } from './nav.js';
import { createNavView } from './nav-view.js';
import { bakeEditorMap } from './map-source.js';
import { buildEditorPanel, createEditorSettings, cursorColor } from './panel.js';
import { eraseStroke, scatterStroke, terrainNormalAt } from './scatter.js';

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
  private propField: PropFieldHandle;
  private renderW = 0;
  private renderH = 0;
  private lastHalfWidth = -1;
  private lastAspect = -1;
  private readonly lookTarget = new THREE.Vector3();
  // Reused across cursor raycasts so a frame of painting allocates nothing.
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly hits: THREE.Intersection[] = [];

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
    this.propField = this.buildProps();
  }

  private buildProps(): PropFieldHandle {
    const layer = this.map.store.layerInfo(this.layerId);
    const field = buildPropField(
      this.map.store.props(this.layerId),
      (x, z) => this.map.world.heightAt(x, z),
      // Resolved at build time, not stored: a prop that asked to lie on the
      // ground re-settles whenever the ground under it is sculpted.
      layer ? (x, z) => terrainNormalAt(this.map.store, layer, x, z) : undefined,
    );
    this.scene.add(field.group);
    return field;
  }

  /** The layer the tools edit. One ground layer today. */
  get layerId(): string {
    return this.document.layers[0]?.id ?? 'ground';
  }

  /**
   * Re-stand every prop on the ground as it is now.
   *
   * A prop's height is baked into its instance matrix, so sculpting under a
   * forest leaves the trees hanging in the air or buried to the crown. Rebuilt
   * whole rather than per-instance, and only when a stroke *ends*: the field is
   * one pass over ~1150 props, which is far too much to do sixty times a second
   * and unnoticeable once per mouse-up.
   */
  refreshProps(): void {
    this.scene.remove(this.propField.group);
    this.propField.dispose();
    this.propField = this.buildProps();
  }

  /** The surfaces the cursor raycast hits. A stable array across patch rebuilds. */
  get pickTargets(): THREE.Object3D[] {
    return this.terrainMesh.pickTargets;
  }

  /**
   * The world point under the cursor, in canvas CSS pixels, or null if the ray
   * missed the ground. Raycast against the terrain itself rather than a flat
   * plane, so aiming at a hillside targets the hillside.
   */
  pick(cssX: number, cssY: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set((cssX / rect.width) * 2 - 1, -((cssY / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.hits.length = 0;
    this.raycaster.intersectObjects(this.terrainMesh.pickTargets, false, this.hits);
    const ground = this.hits[0];
    return ground ? { x: ground.point.x, z: ground.point.z } : null;
  }

  /** Re-mesh one chunk after an edit -- the whole point of the patch rebuild. */
  rebuildChunk(layerId: string, cx: number, cz: number): void {
    const chunk = this.map.store.buildChunk(layerId, cx, cz);
    if (chunk) this.terrainMesh.rebuild(chunk);
  }

  /** Add an overlay (the brush cursor, markers) above the terrain. */
  addOverlay(object: THREE.Object3D): void {
    this.scene.add(object);
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
    this.propField.dispose();
    this.renderer.dispose();
  }
}

/** How often the prop field may be rebuilt while a stroke is running, in ms. */
const PROP_REBUILD_MS = 120;

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
    '<b>left-drag</b> applies the armed tool &middot; <b>WASD</b> / arrows pan &middot; ' +
    '<b>right-drag</b> or <b>middle-drag</b> orbits &middot; <b>wheel</b> zooms<br>' +
    '<span style="color:#7a7a90;">Ctrl+Z undoes a stroke</span>';

  const readout = document.createElement('div');
  readout.style.cssText = `${OVERLAY_CSS}position:absolute;right:10px;bottom:10px;z-index:20;text-align:right;`;

  const panelHost = document.createElement('div');
  panelHost.style.cssText = 'position:absolute;top:44px;right:10px;z-index:30;';

  root.append(canvas, help, readout, panelHost);
  container.appendChild(root);

  const scene = new EditorScene(canvas, viewSeed());
  const input = new EditorInputCapture(canvas);
  const history = new EditHistory();
  const settings = createEditorSettings();

  const cursor: BrushCursorHandle = createBrushCursor(cursorColor(settings));
  scene.addOverlay(cursor.object);

  const markerView = createMarkerView();
  scene.addOverlay(markerView.group);
  const arenaOutline = createArenaOutline();
  scene.addOverlay(arenaOutline.object);
  const navView = createNavView();
  scene.addOverlay(navView.object);

  const layerId = scene.layerId;
  // Seeded from the map, so a session's scatters are reproducible from a seed
  // rather than from whatever `Math.random` happened to be doing.
  let rng = Rng.fromSeed(scene.document.seed ^ 0x5ca77e5);
  // Fractional props owed to the next frame; see `scatterStroke`.
  let scatterCarry = 0;

  /** Re-mesh a set of chunks, skipping the duplicates a drag produces. */
  const remesh = (dirty: readonly { cx: number; cz: number }[]): void => {
    const seen = new Set<string>();
    for (const c of dirty) {
      const key = `${c.cx},${c.cz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scene.rebuildChunk(layerId, c.cx, c.cz);
    }
  };

  const groundAt = (x: number, z: number): number => scene.map.world.heightAt(x, z);

  // Baked once at mount, so the overlay has something to show the moment it is
  // switched on and the document carries nav from the first save.
  bakeLayerNav(scene.map.store, layerId, settings.walkSlope);

  /** Redraw the walkability overlay, but only while it is being looked at. */
  const refreshNav = (): void => {
    navView.setVisible(settings.showNav);
    if (settings.showNav) navView.refresh(scene.map.store, layerId, groundAt);
  };

  /** Redraw the markers and the arena box from whatever the store now holds. */
  const refreshMarkers = (): void => {
    markerView.render(scene.map.store.markers(layerId), groundAt);
    arenaOutline.object.visible = settings.showArena;
    arenaOutline.refresh(scene.document.arena, groundAt);
  };

  const undo = (): void => {
    const restored = history.undo(scene.map.store);
    if (restored.length === 0) return;
    for (const c of restored) scene.rebuildChunk(c.layerId, c.cx, c.cz);
    // Nav describes the ground, so undoing the ground has to undo nav with it.
    rebakeNav(scene.map.store, layerId, restored, settings.walkSlope);
    scene.refreshProps();
    refreshMarkers();
  refreshNav();
    refreshNav();
  };

  const panel = buildEditorPanel({
    settings,
    onUndo: undo,
    onArmChange: () => {
      cursor.setColor(cursorColor(settings));
      arenaOutline.object.visible = settings.showArena;
    },
    onNavChange: refreshNav,
    onNavRebake: () => {
      bakeLayerNav(scene.map.store, layerId, settings.walkSlope);
      refreshNav();
    },
  });
  panelHost.appendChild(panel.element);

  /** Whether the focused element is somewhere a person is typing. */
  const isTextEntry = (element: Element | null): boolean => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.isContentEditable) return true;
    if (element.tagName === 'TEXTAREA') return true;
    if (element.tagName !== 'INPUT') return false;
    const type = (element as HTMLInputElement).type;
    return type === 'text' || type === 'number' || type === 'search';
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!((e.ctrlKey || e.metaKey) && e.code === 'KeyZ')) return;
    // A field being typed into keeps its own undo; the map's is for the map.
    if (isTextEntry(document.activeElement)) return;
    undo();
    e.preventDefault();
  };

  const chunks = scene.document.layers.reduce((n, layer) => n + layer.chunks.length, 0);

  // Sampled once when a stroke begins, so `flatten` levels to the ground it was
  // aimed at rather than chasing the surface it is changing.
  let flattenTo = 0;
  // Whether the stroke in progress changed anything, so a click that hit nothing
  // does not pay for a prop-field rebuild.
  let strokeChangedProps = false;
  let strokeMovedGround = false;
  let strokeChangedMarkers = false;
  /** Chunks this stroke has dirtied, for the nav re-bake when it ends. */
  const strokeDirty: { cx: number; cz: number }[] = [];
  // The prop field is rebuilt whole, which is far too much to do every frame --
  // but a scatter you cannot see until you let go is unusable. So it is rebuilt
  // a few times a second while a stroke runs, and once more when it ends.
  let propsRebuiltAt = 0;

  refreshMarkers();
  refreshNav();

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

    // The cursor goes where the ray lands, and the brush follows it. Both read
    // the same pick, so the ring always marks the ground that is about to move.
    const at = scene.pick(input.mouseCanvas().x, input.mouseCanvas().y);
    if (at) {
      cursor.moveTo(at.x, at.z, settings.radius, (x, z) => scene.map.world.heightAt(x, z));
      cursor.setVisible(true);
    } else {
      cursor.setVisible(false);
    }

    const capture = (cx: number, cz: number): void => {
      history.captureChunk(scene.map.store, layerId, cx, cz);
      strokeDirty.push({ cx, cz });
    };

    if (input.takePaintStart()) {
      history.beginStroke();
      strokeMovedGround = false;
      strokeChangedProps = false;
      strokeChangedMarkers = false;
      strokeDirty.length = 0;
      scatterCarry = 0;
      propsRebuiltAt = time;
      // The height under the first press is the level `flatten` works toward.
      if (at) flattenTo = scene.map.world.heightAt(at.x, at.z);
      // A marker is placed on the press, not the drag: a spawn point is not a
      // bulk thing, and dragging would leave a trail of forty of them.
      if (at && settings.mode === 'marker') {
        const placed = placeMarker(scene.map.store, layerId, settings.markerKind, at.x, at.z, capture);
        if (placed.marker) {
          strokeChangedMarkers = true;
          refreshMarkers();
  refreshNav();
        }
      }
    }

    if (input.isPainting && at) {
      if (settings.mode === 'terrain') {
        const dirty = applyTerrainBrush(
          scene.map.store,
          { tool: settings.tool, radius: settings.radius, strength: settings.strength, falloff: settings.falloff },
          { layerId, x: at.x, z: at.z, dtSeconds: dt, flattenTo, onTouchChunk: capture },
        );
        remesh(dirty);
        if (dirty.length > 0) strokeMovedGround = true;
      } else if (settings.mode === 'scatter') {
        const out = scatterStroke(
          scene.map.store,
          layerId,
          settings,
          { x: at.x, z: at.z, radius: settings.radius, dtSeconds: dt, carry: scatterCarry, onTouchChunk: capture },
          rng,
        );
        rng = out.rng;
        scatterCarry = out.carry;
        if (out.added.length > 0) strokeChangedProps = true;
      } else if (settings.mode === 'erase') {
        const circle = { x: at.x, z: at.z, radius: settings.radius };
        const props = eraseStroke(scene.map.store, layerId, circle, capture);
        if (props.removed.length > 0) strokeChangedProps = true;
        // One eraser that takes everything under it, rather than two erasers and
        // a mode switch to choose between them.
        const markers = eraseMarkers(scene.map.store, layerId, circle, capture);
        if (markers.removed.length > 0) {
          strokeChangedMarkers = true;
          refreshMarkers();
  refreshNav();
        }
      }

      if (strokeChangedProps && time - propsRebuiltAt > PROP_REBUILD_MS) {
        scene.refreshProps();
        propsRebuiltAt = time;
      }
      // The ring reads the surface it may just have moved, so redraw it after.
      cursor.moveTo(at.x, at.z, settings.radius, (x, z) => scene.map.world.heightAt(x, z));
    }

    if (input.takePaintEnd()) {
      history.endStroke();
      // Trees stand on the ground, and either the ground or the trees just moved.
      if (strokeMovedGround || strokeChangedProps) scene.refreshProps();
      // Markers and the arena outline sit on the ground too.
      if (strokeMovedGround || strokeChangedMarkers) refreshMarkers();
      // Nav is re-baked for exactly the chunks the stroke dirtied, so the
      // overlay never describes ground that has since moved.
      if (strokeMovedGround) rebakeNav(scene.map.store, layerId, strokeDirty, settings.walkSlope);
      if (strokeMovedGround || strokeChangedProps) refreshNav();
      strokeMovedGround = false;
      strokeChangedProps = false;
      strokeChangedMarkers = false;
    }

    canvas.style.cursor = input.isOrbiting ? 'grabbing' : input.isPainting ? 'crosshair' : 'default';
    scene.render();

    const c = scene.camera3;
    readout.innerHTML =
      `at <b>${Math.round(c.target.x)}, ${Math.round(c.target.z)}</b> &middot; ` +
      `span <b>${Math.round(c.halfWidth)}</b> &middot; ` +
      `pitch <b>${Math.round((c.elevation * 180) / Math.PI)}&deg;</b><br>` +
      `<span style="color:#7a7a90;">${chunks} chunks &middot; ` +
      `${scene.map.store.props(layerId).length} props &middot; ` +
      `${scene.map.store.markers(layerId).length} markers &middot; ${history.depth} undo</span>`;

    requestAnimationFrame(frame);
  };

  return {
    element: root,
    start(): void {
      if (running) return;
      running = true;
      lastFrame = undefined;
      input.attach(window);
      // Capture phase, so a focused panel widget cannot swallow it first.
      // lil-gui's checkbox does exactly that on the bubble path: click one and
      // Ctrl+Z silently stops undoing until you click somewhere else.
      window.addEventListener('keydown', onKeyDown, true);
      requestAnimationFrame(frame);
    },
    stop(): void {
      running = false;
      input.detach();
      window.removeEventListener('keydown', onKeyDown, true);
      // A stroke interrupted by a tab switch still closes its undo entry.
      history.endStroke();
    },
  };
}
