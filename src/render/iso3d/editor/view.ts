import * as THREE from 'three';
import {
  arenaBounds,
  loadMap,
  parseMap,
  type ChunkCoord,
  type ChunkRect,
  type LoadedMap,
  type MapDocument,
  type PartRecipe,
} from '../../../terrain/index.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../shared/world.js';
import type { ViewHandle } from '../view-handle.js';
import { PALETTE } from '../palette.js';
import { buildPropField, type PropFieldHandle } from '../props.js';
import { viewSeed } from '../seed.js';
import { buildTerrainMeshFromChunks, type TerrainMeshHandle } from '../terrain-mesh.js';
import { advanceWind } from '../wind-uniforms.js';
import { CAMERA_FAR, CAMERA_NEAR, DEFAULT_LIGHT_OFFSET } from '../view-settings.js';
import {
  createEditorCamera,
  editorCameraPosition,
  orbitEditorCamera,
  trackEditorCamera,
  withMapBounds,
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
import {
  AUTOSAVE_INTERVAL_MS,
  clearAutosave,
  mapFilename,
  mapText,
  readAutosave,
  RevisionTracker,
  writeAutosave,
} from './persistence.js';
import { bakeEditorMap } from './map-source.js';
import { buildEditorPanel, type EditorPanel } from './panel.js';
import { createEditorSettings, cursorColor, cursorRadius } from './tools.js';
import {
  addPart,
  chunkRectArea,
  chunkRectFrom,
  chunkRectWorld,
  partAt,
  removePart,
  uniquePartId,
} from './parts.js';
import { fenceStroke, NO_FENCE_PATH, type FencePath } from './fence.js';
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
/**
 * The recipes a part may be grown from (spec 083), bundled at build time.
 *
 * `import.meta.glob` rather than a fetch: the editor has to work from a file://
 * page and with no server behind it, and a recipe is a committed file whose set
 * is known when the bundle is made. The same JSON `scripts/grow-map.ts` reads
 * from disk, so a part grown in the editor and one grown from the shell are the
 * same part.
 *
 * The path is relative for the same reason `world/view.ts` imports the map
 * relatively: Vite's root is `src/render`, so a root-absolute glob would look
 * for `src/render/maps/` and silently match nothing at all.
 */
const RECIPE_MODULES = import.meta.glob('../../../../maps/recipes/*.json', { eager: true }) as Record<
  string,
  { default: PartRecipe }
>;

const RECIPES: ReadonlyMap<string, PartRecipe> = new Map(
  Object.entries(RECIPE_MODULES)
    .map(([path, module]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), module.default] as const)
    .sort(([a], [b]) => a.localeCompare(b)),
);

class EditorScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private terrainMesh: TerrainMeshHandle;
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
  // Reused by `pickPlane`, so aiming off the map allocates nothing either.
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly planeHit = new THREE.Vector3();

  /** The loaded document everything in this scene was built from. */
  map: LoadedMap;
  document: MapDocument;
  camera3: EditorCameraState;

  constructor(
    readonly canvas: HTMLCanvasElement,
    seed: number,
    opened?: { document: MapDocument; map: LoadedMap },
  ) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    // No `image-rendering: pixelated` and no low-res buffer: the editor draws at
    // the size of its box, so a one-pixel overlay stays one pixel.

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.scene.background = new THREE.Color(PALETTE.sky);

    // Bake the generated world unless a document was handed in -- a restored
    // autosave, or a file dropped before the first frame. Everything below
    // reads `map` either way.
    const baked = opened ?? bakeEditorMap(seed);
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

  /**
   * Props the renderer had no geometry for. Always zero in a consistent build;
   * see `PropFieldHandle.undrawn` for when it is not, and why saying so out loud
   * beats leaving a tool looking broken.
   */
  get undrawnProps(): number {
    return this.propField.undrawn;
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

  /**
   * Re-batch only the prop regions overlapping a world rectangle (spec 086).
   *
   * The counterpart to `rebuildChunk`: a part plants trees over the ground it
   * made and nowhere else, so rebuilding every batch in the world to draw them
   * costs the map rather than the part. `refreshProps` stays for the cases that
   * really do move everything -- a load, or a height brush that re-settles every
   * prop standing on the ground it moved.
   */
  refreshPropsWithin(rect: { minX: number; minZ: number; maxX: number; maxZ: number }): void {
    this.propField.rebuildWithin(this.map.store.props(this.layerId), rect);
  }

  /**
   * Swap in a different map: a loaded file, or a restored autosave.
   *
   * Everything derived is rebuilt, because everything derived belongs to the map
   * that produced it -- a terrain mesh from one document over a store from
   * another is not a state worth having a name for.
   */
  replaceMap(document: MapDocument): void {
    this.document = document;
    this.map = loadMap(document);
    this.scene.remove(this.terrainMesh.group);
    this.terrainMesh.dispose();
    this.terrainMesh = buildTerrainMeshFromChunks(this.map.meshLayers, this.map.chunks);
    this.scene.add(this.terrainMesh.group);
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

  /** Stop drawing a chunk whose ground has gone (spec 085). */
  dropChunk(layerId: string, cx: number, cz: number): void {
    this.terrainMesh.remove(layerId, cx, cz);
  }

  /**
   * Where the cursor ray meets a horizontal plane, for aiming at ground that
   * does not exist yet (spec 084).
   *
   * `pick` raycasts the terrain, which is exactly right for every tool that
   * edits ground that is there -- and useless for the one tool whose whole job
   * is to select ground that is not. Off the map's edge the ray hits nothing at
   * all, so a part could only ever be dragged over terrain that already
   * existed, which is the opposite of growing the world.
   */
  pickPlane(cssX: number, cssY: number, y = 0): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set((cssX / rect.width) * 2 - 1, -((cssY / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.plane.constant = -y;
    const hit = this.raycaster.ray.intersectPlane(this.plane, this.planeHit);
    return hit ? { x: hit.x, z: hit.z } : null;
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

  /**
   * `dt` is real elapsed seconds, and the only thing the editor does with it is
   * advance the wind (spec 074) -- so an author sees the same weather on the
   * water and the trees they will see in the Play tab, rather than a still
   * frame that starts moving only once the game opens.
   */
  render(dt = 0): void {
    advanceWind(dt);
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
    '<b>left-drag</b> applies the armed tool &middot; <b>middle-drag</b> tracks &amp; dollies &middot; ' +
    '<b>right-drag</b> orbits &middot; <b>wheel</b> zooms<br>' +
    '<span style="color:#7a7a90;">Ctrl+Z undoes a stroke</span>';

  const readout = document.createElement('div');
  readout.style.cssText = `${OVERLAY_CSS}position:absolute;right:10px;bottom:10px;z-index:20;text-align:right;`;

  const panelHost = document.createElement('div');
  panelHost.style.cssText = 'position:absolute;top:44px;right:10px;z-index:30;';

  root.append(canvas, help, readout, panelHost);
  container.appendChild(root);

  // A refresh must not lose work, so an autosave that still parses is restored
  // rather than offered. The panel's "Discard autosave" button is how you get a
  // fresh generated world back, which is one click rather than a trip through
  // devtools.
  const storage: Storage | null = (() => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      // Some browsers throw on the *property* when storage is disabled.
      return null;
    }
  })();
  const restored = storage ? readAutosave(storage) : null;
  const scene = new EditorScene(
    canvas,
    viewSeed(),
    restored ? { document: restored, map: loadMap(restored) } : undefined,
  );
  const revision = new RevisionTracker();
  let status = restored ? 'restored autosave' : '';
  const input = new EditorInputCapture(canvas);
  const history = new EditHistory();
  const settings = createEditorSettings();
  settings.recipe = [...RECIPES.keys()][0] ?? '';

  const cursor: BrushCursorHandle = createBrushCursor(cursorColor(settings));
  scene.addOverlay(cursor.object);

  const markerView = createMarkerView();
  scene.addOverlay(markerView.group);
  const arenaOutline = createArenaOutline();
  scene.addOverlay(arenaOutline.object);
  // The chunk rectangle a part drag has selected, in the part tool's own colour
  // so it is not mistaken for the arena box.
  const partOutline = createArenaOutline(0x9fb8e8);
  partOutline.object.visible = false;
  scene.addOverlay(partOutline.object);
  const navView = createNavView();
  scene.addOverlay(navView.object);

  const layerId = scene.layerId;
  // Seeded from the map, so a session's scatters are reproducible from a seed
  // rather than from whatever `Math.random` happened to be doing.
  let rng = Rng.fromSeed(scene.document.seed ^ 0x5ca77e5);
  // Fractional props owed to the next frame; see `scatterStroke`.
  let scatterCarry = 0;
  // Where the fence run has got to; see `fenceStroke`. Reset on every press, so
  // one stroke is one run rather than a line drawn from the last one's end.
  let fencePath: FencePath = NO_FENCE_PATH;
  /** Where a part drag started, in world space. Null when none is in progress. */
  let partAnchor: { x: number; z: number } | null = null;

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

  /**
   * Set once the panel exists, since the commit helpers are defined before it
   * and the panel needs them.
   */
  let onPartsChanged: () => void = () => {
    // Replaced the moment the panel exists; nothing calls this before then.
  };

  /**
   * The chunks a change to `touched` makes stale, including the neighbours.
   *
   * A chunk's walls are grown where its solid ground meets air, which is a
   * question about the chunk *next to* it -- so ground appearing or vanishing
   * silently invalidates the four chunks around it as well as itself. The
   * mesher already re-bakes the eight neighbours' water; the walls are this.
   */
  /** The smallest chunk rectangle covering a set of coordinates, or null if none. */
  const boundingChunkRect = (coords: readonly ChunkCoord[]): ChunkRect | null => {
    if (coords.length === 0) return null;
    let minCx = Infinity;
    let minCz = Infinity;
    let maxCx = -Infinity;
    let maxCz = -Infinity;
    for (const c of coords) {
      minCx = Math.min(minCx, c.cx);
      minCz = Math.min(minCz, c.cz);
      maxCx = Math.max(maxCx, c.cx);
      maxCz = Math.max(maxCz, c.cz);
    }
    return { minCx, minCz, maxCx, maxCz };
  };

  const withNeighbours = (touched: readonly ChunkCoord[]): ChunkCoord[] => {
    const seen = new Set<string>();
    const out: ChunkCoord[] = [];
    for (const c of touched) {
      for (const [dx, dz] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const cx = c.cx + dx;
        const cz = c.cz + dz;
        const key = `${cx},${cz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ cx, cz });
      }
    }
    return out;
  };

  /**
   * Everything a part changes, and nothing it does not (spec 085).
   *
   * This used to re-mesh every chunk in the world and re-bake nav for the whole
   * layer. On a 74-chunk map that was ~730ms of which ~36ms was the new ground,
   * and both halves grew with the map -- so the editor got slower the more you
   * built, which is precisely backwards. Now the work is proportional to the
   * part: the chunks it wrote, the chunks it deleted, and the ring around both.
   */
  const rebuiltAfterParts = (touched: readonly ChunkCoord[], gone: readonly ChunkCoord[] = []): void => {
    for (const c of gone) scene.dropChunk(layerId, c.cx, c.cz);
    // Both sets are re-meshed through the same call: a coordinate with no chunk
    // behind it simply draws nothing, which is what the ring around a deletion
    // needs anyway.
    for (const c of withNeighbours([...touched, ...gone])) scene.rebuildChunk(layerId, c.cx, c.cz);
    // The camera was fenced to the map as it was when the view opened, so a
    // world that just grew would otherwise be ground you can see and cannot
    // pan to (spec 084).
    scene.camera3 = withMapBounds(scene.camera3, scene.map.store.layerInfo(layerId)?.bounds ?? null);
    rebakeNav(scene.map.store, layerId, touched, settings.walkSlope);
    // Only the batches over the ground that changed, not every batch in the
    // world: the field is grouped into regions for culling, and this makes that
    // grouping the unit of invalidation too (spec 086).
    const span = boundingChunkRect([...touched, ...gone]);
    const world = span && chunkRectWorld(scene.map.store, layerId, span);
    if (world) scene.refreshPropsWithin(world);
    else scene.refreshProps();
    refreshMarkers();
    refreshNav();
    revision.touch();
    onPartsChanged();
  };

  /** How much ground the layer claims but has no chunk for; 0 is a rectangle. */
  const unfilled = (): number => {
    const info = scene.map.store.layerInfo(layerId);
    if (!info) return 0;
    const cell = scene.map.store.cellSize;
    const declared =
      Math.round((info.bounds.maxX - info.bounds.minX) / cell) *
      Math.round((info.bounds.maxZ - info.bounds.minZ) / cell);
    return Math.max(0, declared - info.grid.totalCols * info.grid.totalRows);
  };

  /** Bake the armed recipe into a chunk rectangle. */
  const commitPart = (rect: { minCx: number; minCz: number; maxCx: number; maxCz: number }): void => {
    const recipe = RECIPES.get(settings.recipe);
    if (!recipe) {
      status = settings.recipe ? `no recipe called ${settings.recipe}` : 'no recipes are bundled';
      return;
    }
    // A typed id is taken at its word; a blank one is derived and made unique,
    // so growing a run of parts from one recipe is a run of drags rather than a
    // drag and a rename each time.
    const typed = settings.partId.trim();
    const id = typed || uniquePartId(scene.map.store, settings.recipe);
    const added = addPart(scene.map.store, history, {
      id,
      layerId,
      rect,
      recipe,
      seed: Math.round(settings.partSeed),
    });
    if (!added.ok) {
      status = `part refused: ${added.reason}`;
      return;
    }
    rebuiltAfterParts([...added.created, ...added.completed]);
    const gap = unfilled();
    status =
      `added part "${id}" (${added.created.length} chunks` +
      (added.completed.length > 0 ? `, ${added.completed.length} completed` : '') +
      ')' +
      (gap > 0 ? ` — ${gap} declared cells have no ground yet` : '');
  };

  const commitRemove = (partId: string): void => {
    const removed = removePart(scene.map.store, history, partId);
    if (!removed.ok) {
      status = `remove refused: ${removed.reason}`;
      return;
    }
    rebuiltAfterParts([], removed.removed);
    status = `removed part "${removed.part.id}" (${removed.removed.length} chunks)`;
  };

  const undo = (): void => {
    const { remeshed, removed, structural } = history.undo(scene.map.store);
    if (remeshed.length === 0 && removed.length === 0) return;
    // Undoing a part is the same shape of work as making one, so it goes
    // through the same targeted path rather than rebuilding the world (spec 085).
    if (structural) {
      rebuiltAfterParts(remeshed, removed);
      return;
    }
    revision.touch();
    for (const c of remeshed) scene.rebuildChunk(c.layerId, c.cx, c.cz);
    // Nav describes the ground, so undoing the ground has to undo nav with it.
    rebakeNav(scene.map.store, layerId, remeshed, settings.walkSlope);
    scene.refreshProps();
    refreshMarkers();
    refreshNav();
  };

  /** Everything derived from the map, rebuilt after a load or a restore. */
  const rebuildAll = (): void => {
    bakeLayerNav(scene.map.store, layerId, settings.walkSlope);
    scene.refreshProps();
    refreshMarkers();
    refreshNav();
    scene.camera3 = withMapBounds(scene.camera3, scene.map.store.layerInfo(layerId)?.bounds ?? null);
    onPartsChanged();
  };

  const saveToFile = (): void => {
    const text = mapText(scene.map.store.toDocument());
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = mapFilename(scene.document);
    // In the document rather than detached: some browsers ignore a click on an
    // anchor that was never in the tree.
    anchor.style.display = 'none';
    root.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    status = `saved ${anchor.download}`;
  };

  /**
   * Take a document from a file or a slot. A parse failure changes nothing at
   * all -- the whole-document parse is what makes a half-loaded map impossible.
   */
  const openText = (text: string, from: string): void => {
    let doc;
    try {
      doc = parseMap(text);
    } catch (error) {
      status = `${from} rejected: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    scene.replaceMap(doc);
    // History belongs to the map that produced it: one Ctrl+Z restoring a chunk
    // from a map that is no longer open is the one genuinely corrupt state here.
    history.clear();
    rebuildAll();
    revision.reset();
    status = `loaded ${from}`;
  };

  const openFile = (file: File): void => {
    file
      .text()
      .then((text) => openText(text, file.name))
      .catch((error: unknown) => {
        status = `could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
      });
  };

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) openFile(file);
    // Cleared so re-opening the same file fires `change` again.
    fileInput.value = '';
  });
  root.appendChild(fileInput);

  // Drag-and-drop anywhere on the view, since that is the other habit.
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) openFile(file);
  };
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('drop', onDrop);

  const panel: EditorPanel = buildEditorPanel({
    settings,
    recipeNames: [...RECIPES.keys()],
    partIds: () => scene.map.store.parts.map((p) => p.id),
    onRemoveNamedPart: () => {
      if (settings.removePartId) commitRemove(settings.removePartId);
      else status = 'no part selected to remove';
    },
    onUndo: undo,
    onSave: saveToFile,
    onLoad: () => fileInput.click(),
    onDiscardAutosave: () => {
      if (storage) clearAutosave(storage);
      status = 'autosave cleared -- reload for a fresh world';
    },
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
  onPartsChanged = (): void => panel.refreshParts();
  onPartsChanged();
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

  // Read from the store every frame rather than counted once at mount: parts
  // add and remove chunks, so a number fixed at load time reports a world that
  // has not existed since (spec 084).
  const chunkCount = (): number => scene.map.store.chunkCount();

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
  let lastAutosaveAt = 0;

  const autosave = (time: number): void => {
    if (!storage || time - lastAutosaveAt < AUTOSAVE_INTERVAL_MS) return;
    lastAutosaveAt = time;
    // An idle editor writes nothing: the slot is not rewritten a hundred times
    // while someone reads the panel.
    if (!revision.isDirty) return;
    const result = writeAutosave(storage, mapText(scene.map.store.toDocument()));
    if (result.ok) {
      revision.markSaved();
      status = 'autosaved';
    } else {
      status = `autosave failed: ${result.reason ?? 'unknown'}`;
    }
  };

  const frame = (time: number): void => {
    if (!running) return;
    // Real elapsed seconds, capped so a backgrounded tab does not resume with one
    // enormous pan step.
    const dt = lastFrame === undefined ? 0 : Math.min(0.1, (time - lastFrame) / 1000);
    lastFrame = time;

    const orbit = input.takeOrbit();
    if (orbit.dx !== 0 || orbit.dy !== 0) scene.camera3 = orbitEditorCamera(scene.camera3, orbit.dx, orbit.dy);
    const wheel = input.takeWheel();
    if (wheel.deltaY !== 0) scene.camera3 = zoomEditorCamera(scene.camera3, wheel.deltaY, wheel.deltaMode);
    // The grip is in pixels, so it needs the width those pixels are spread over.
    const track = input.takeTrack();
    if (track.dx !== 0 || track.dy !== 0) {
      scene.camera3 = trackEditorCamera(scene.camera3, track.dx, track.dy, canvas.clientWidth);
    }

    // The cursor goes where the ray lands, and the brush follows it. Both read
    // the same pick, so the ring always marks the ground that is about to move.
    const mouse = input.mouseCanvas();
    const onTerrain = scene.pick(mouse.x, mouse.y);
    // Only the part tool falls back to the plane: every other tool edits ground
    // that is there, and letting them aim into the void would silently do
    // nothing at a point they could not have meant.
    const at = onTerrain ?? (settings.mode === 'part' ? scene.pickPlane(mouse.x, mouse.y) : null);
    if (at) {
      cursor.moveTo(at.x, at.z, cursorRadius(settings), (x, z) => scene.map.world.heightAt(x, z));
      cursor.setVisible(true);
    } else {
      cursor.setVisible(false);
    }

    const capture = (cx: number, cz: number): void => {
      history.captureChunk(scene.map.store, layerId, cx, cz);
      strokeDirty.push({ cx, cz });
    };

    if (input.takePaintStart()) {
      // A part opens and closes its own history entry, atomically on commit --
      // there is no drag for a stroke to span, and an entry left open here
      // would swallow the one `addPart` opens.
      if (settings.mode !== 'part') history.beginStroke();
      strokeMovedGround = false;
      strokeChangedProps = false;
      strokeChangedMarkers = false;
      strokeDirty.length = 0;
      scatterCarry = 0;
      fencePath = NO_FENCE_PATH;
      propsRebuiltAt = time;
      // The height under the first press is the level `flatten` works toward.
      if (at) flattenTo = scene.map.world.heightAt(at.x, at.z);
      // A marker is placed on the press, not the drag: a spawn point is not a
      // bulk thing, and dragging would leave a trail of forty of them.
      partAnchor = settings.mode === 'part' && settings.partTool === 'add' && at ? { x: at.x, z: at.z } : null;
      // Remove happens on the press, like a marker: it names a thing already on
      // the ground rather than describing a region to fill.
      if (at && settings.mode === 'part' && settings.partTool === 'remove') {
        const under = partAt(scene.map.store, at.x, at.z);
        if (under) commitRemove(under.id);
        else status = 'no part under the cursor';
      }
      if (at && settings.mode === 'marker') {
        const placed = placeMarker(
          scene.map.store,
          layerId,
          settings.markerKind,
          at.x,
          at.z,
          capture,
          settings.markerKind === 'spawner' ? settings.spawnerMonster : undefined,
        );
        if (placed.marker) {
          strokeChangedMarkers = true;
          refreshMarkers();
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
      } else if (settings.mode === 'fence') {
        const out = fenceStroke(
          scene.map.store,
          layerId,
          settings,
          { x: at.x, z: at.z, onTouchChunk: capture },
          fencePath,
          rng,
        );
        rng = out.rng;
        fencePath = out.path;
        if (out.added.length > 0) strokeChangedProps = true;
      } else if (settings.mode === 'part' && partAnchor) {
        // The outline is the selection: chunk-snapped from the first frame, so
        // what you see is exactly the ground that will be baked.
        const rect = chunkRectFrom(scene.map.store, layerId, partAnchor, at);
        const world = rect ? chunkRectWorld(scene.map.store, layerId, rect) : null;
        if (rect && world) {
          partOutline.refresh(world, groundAt);
          partOutline.object.visible = true;
          status = `${chunkRectArea(rect)} chunks: ${rect.minCx},${rect.minCz}..${rect.maxCx},${rect.maxCz}`;
        }
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
        }
      }

      if (strokeChangedProps && time - propsRebuiltAt > PROP_REBUILD_MS) {
        const span = boundingChunkRect(strokeDirty);
        const world = span && chunkRectWorld(scene.map.store, layerId, span);
        if (world) scene.refreshPropsWithin(world);
        else scene.refreshProps();
        propsRebuiltAt = time;
      }
      // The ring reads the surface it may just have moved, so redraw it after.
      cursor.moveTo(at.x, at.z, cursorRadius(settings), (x, z) => scene.map.world.heightAt(x, z));
    }

    if (input.takePaintEnd()) {
      if (settings.mode === 'part') {
        partOutline.object.visible = false;
        const rect = at && partAnchor ? chunkRectFrom(scene.map.store, layerId, partAnchor, at) : null;
        if (rect) commitPart(rect);
        partAnchor = null;
      } else history.endStroke();
      // Trees stand on the ground, and either the ground or the trees just
      // moved -- but only over the chunks the stroke actually touched, which is
      // what makes an erase or a height brush cost the stroke rather than the
      // map (spec 086).
      if (strokeMovedGround || strokeChangedProps) {
        const span = boundingChunkRect(strokeDirty);
        const world = span && chunkRectWorld(scene.map.store, layerId, span);
        if (world) scene.refreshPropsWithin(world);
        else scene.refreshProps();
      }
      // Markers and the arena outline sit on the ground too.
      if (strokeMovedGround || strokeChangedMarkers) refreshMarkers();
      // Nav is re-baked for exactly the chunks the stroke dirtied, so the
      // overlay never describes ground that has since moved.
      if (strokeMovedGround) rebakeNav(scene.map.store, layerId, strokeDirty, settings.walkSlope);
      if (strokeMovedGround || strokeChangedProps) refreshNav();
      if (strokeMovedGround || strokeChangedProps || strokeChangedMarkers) revision.touch();
      strokeMovedGround = false;
      strokeChangedProps = false;
      strokeChangedMarkers = false;
    }

    autosave(time);

    canvas.style.cursor = input.isTracking
      ? 'move'
      : input.isOrbiting
        ? 'grabbing'
        : input.isPainting
          ? 'crosshair'
          : 'default';
    scene.render(dt);

    const c = scene.camera3;
    readout.innerHTML =
      `at <b>${Math.round(c.target.x)}, ${Math.round(c.target.z)}</b> &middot; ` +
      `span <b>${Math.round(c.halfWidth)}</b> &middot; ` +
      `pitch <b>${Math.round((c.elevation * 180) / Math.PI)}&deg;</b><br>` +
      `<span style="color:#7a7a90;">${chunkCount()} chunks &middot; ` +
      `${scene.map.store.props(layerId).length} props${scene.undrawnProps > 0 ? ` (<b style="color:#e08f8f;">${scene.undrawnProps} not drawn</b>)` : ''} &middot; ` +
      `${scene.map.store.markers(layerId).length} markers &middot; ` +
      `${scene.map.store.parts.length} part${scene.map.store.parts.length === 1 ? '' : 's'} &middot; ` +
      `${history.depth} undo` +
      `${status ? ` &middot; ${status}` : ''}</span>`;

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
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('drop', onDrop);
      // A stroke interrupted by a tab switch still closes its undo entry.
      history.endStroke();
    },
  };
}
