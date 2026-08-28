import * as THREE from 'three';
import {
  arenaBounds,
  fixtureLight,
  loadMap,
  parseMap,
  type ChunkCoord,
  type ChunkRect,
  type LoadedMap,
  type MapDocument,
  meshLayerFor,
  worldFor,
  type PartRecipe,
} from '../../../terrain/index.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../shared/world.js';
import type { ViewHandle } from '../view-handle.js';
import { PALETTE } from '../palette.js';
import { buildPropField, buildRegionInstances, propRegionKeysIn, type PropFieldHandle } from '../props.js';
import { propRegions, propRegionsOwed, propRegionsPending } from './prop-residency.js';
import {
  EDITOR_KEEP_PAD_CHUNKS,
  chunkKey,
  chunksBeyond,
  chunksOwed,
  viewRect,
} from './ground-residency.js';
import { FrameBudget } from '../world/frame-budget.js';
import type { Prop } from '../../../terrain/vegetation.js';
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
import { applyTerrainPaint } from './paint.js';
import { createBrushCursor, type BrushCursorHandle } from './cursor.js';
import { EditHistory } from './history.js';
import { EditorInputCapture } from './input.js';
import { createArenaOutline, createMarkerView } from './marker-view.js';
import { eraseMarkers, markerAt, placeMarker, updateMarker } from './markers.js';
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
import { openEditorMap, SHIPPED_MAP_NAME } from './map-source.js';
import { loadShippedMap } from '../map-asset.js';
import { writeMapToDisk } from './map-write.js';
import { buildEditorPanel, type EditorPanel } from './panel.js';
import {
  clearSelection,
  createEditorSettings,
  cursorColor,
  cursorRadius,
  MARKER_CURSOR_RADIUS,
  MODE_COLORS,
  NEW_ROCK_TIER,
  patchFromSelection,
  selectionFrom,
  SELECT_PICK_RADIUS,
} from './tools.js';
import {
  addPart,
  chunkRectArea,
  chunkRectFrom,
  chunkRectWorld,
  partAt,
  removePart,
  uniquePartId,
} from './parts.js';
import {
  addRock,
  addStair,
  detailAt,
  nextRockLayerId,
  removeRock,
  rockLayerAt,
  rockLayerIds,
  worldRectFrom,
} from './rock.js';
import { fenceStroke, NO_FENCE_PATH, type FencePath } from './fence.js';
import { eraseStroke, scatterStroke, terrainNormalAt } from './scatter.js';
import { dragScale, placeStructure, structureFootprint } from './structure.js';
import { createStructureGhost } from './structure-ghost.js';

/**
 * The map editor tab (spec 049).
 *
 * The fourth view in the shell, and the only one that renders from a **map
 * document** rather than from the generator. The document is the one the game
 * plays -- `maps/arena/`, see `map-source.ts` -- read once at mount, and
 * everything below reads exclusively from the result: the terrain mesh from
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

/**
 * How far a tier's underside is sunk below the lowest ground it covers.
 *
 * The skirt is drawn from the tier's rim straight down to this, so anything
 * short of the ground leaves the slab hovering with daylight under it. A little
 * past the lowest corner buries the base in the hillside, which is what makes a
 * formation look like it grew out of the ground rather than being set on it.
 */
const BURY_DEPTH = 40;

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

/**
 * How much of a frame the deferred prop fill may have (spec 211).
 *
 * The Play tab's `INGEST_BUDGET_MS`, because it is the same question -- how much
 * of a frame a background job gets -- and a second number would be a second
 * answer to it. See `EditorScene.pumpProps` for what it actually buys at the
 * region size in force, which is less than it looks.
 */
const PROP_PUMP_BUDGET_MS = 6;

/**
 * How much of a frame the ground fill may have (spec 212).
 *
 * The same number, for the same reason -- and here it buys what a budget is
 * supposed to buy, unlike the prop pump beside it. A chunk is ~5.7ms to build
 * and mesh, so this is a handful of chunks a frame rather than the one region
 * `PROP_PUMP_BUDGET_MS` works out to.
 */
const GROUND_PUMP_BUDGET_MS = 6;

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
  /** Chunks meshed, per layer. Nothing else may be drawn (spec 212). */
  private readonly groundHeld = new Map<string, Map<string, ChunkCoord>>();
  /** Props by the region they stand in, from the list the field was built from. */
  private propBuckets: ReadonlyMap<string, readonly Prop[]> = new Map();
  /** Regions composed so far. Everything in `propBuckets` and not in here is owed. */
  private propsHeld = new Set<string>();
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
    opened: { document: MapDocument; map: LoadedMap },
  ) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    // No `image-rendering: pixelated` and no low-res buffer: the editor draws at
    // the size of its box, so a one-pixel overlay stays one pixel.

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.scene.background = new THREE.Color(PALETTE.sky);

    // Handed the document it edits rather than reaching for one: the shipped
    // map, a restored autosave, or a file dropped before the first frame. There
    // used to be a fallback to the generator here, and that one line is what
    // opened a different world from the clock every session while the game
    // played `maps/arena.json` (spec 176). A scene that cannot reach the
    // generator cannot quietly re-open the wrong world.
    this.document = opened.document;
    this.map = opened.map;

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

    // Nothing meshed (spec 212). `map.chunks` is the getter spec 207 made lazy
    // and this was its one eager caller: 4.9s on the map we ship, and 73s of the
    // ~148s projected at the 4x target. `pumpGround` meshes what the camera
    // frames, from the pivot outward, and drops what it has panned away from.
    this.terrainMesh = buildTerrainMeshFromChunks(this.map.meshLayers, []);
    this.scene.add(this.terrainMesh.group);
    this.propField = this.buildProps();
  }

  private buildProps(): PropFieldHandle {
    const props = this.map.store.props(this.layerId);
    const field = buildPropField(
      props,
      (x, z) => this.map.world.heightAt(x, z),
      this.propNormalAt(),
      undefined,
      // Deferred (spec 211). Composing every region here is about half of
      // everything opening the editor costs -- 4.5s on the map we ship -- and
      // it is a cost with nobody waiting on it: the ground and the camera are
      // ready, and what is missing is trees. `pumpProps` brings them in from
      // the pivot outward while the tab is already usable.
      { deferred: true },
    );
    this.scene.add(field.group);
    this.propBuckets = propRegions(props);
    this.propsHeld = new Set();
    return field;
  }

  /**
   * The ground normals props lie along, or nothing if the layer has gone.
   *
   * Resolved at build time, not stored: a prop that asked to lie on the ground
   * re-settles whenever the ground under it is sculpted.
   */
  private propNormalAt(): ((x: number, z: number) => readonly [number, number, number]) | undefined {
    const layer = this.map.store.layerInfo(this.layerId);
    if (!layer) return undefined;
    return (x, z) => terrainNormalAt(this.map.store, layer, x, z);
  }

  /** Regions still owed. Counted, never subtracted -- see `propRegionsPending`. */
  get propsPending(): number {
    return propRegionsPending(this.propBuckets, this.propsHeld);
  }

  /**
   * Prop instances actually hanging on the scene graph.
   *
   * Counted by walking what is attached rather than by totting up what was
   * asked for, which is the rule `data-held-weapons` is published under: a
   * region composed into batches that never reached the group has to read as
   * absent, because that is the failure a deferred field can have and an eager
   * one could not.
   */
  get drawnPropInstances(): number {
    let n = 0;
    this.propField.group.traverse((child) => {
      if (child instanceof THREE.InstancedMesh) n += child.count;
    });
    return n;
  }

  /**
   * Compose owed prop regions until the budget is gone (spec 211).
   *
   * Nearest the camera's pivot first, so the trees you are looking at arrive
   * before the far corner of the map -- which is the whole of what makes a
   * deferred field better than a slow one rather than merely later.
   *
   * The budget is the Play tab's own `INGEST_BUDGET_MS`, and it is worth being
   * honest about what it buys here: one region is **55ms** on the shipped map
   * (median over its 72 regions; 77ms at the worst), because a region is ~426
   * props at 0.15ms each. `FrameBudget` is checked *after* a unit of work and
   * nothing here can subdivide one, so in practice this composes exactly one
   * region a frame. That is still the feature -- the first region lands in 55ms
   * where the eager field took 4.5s to land anything, and the tab pans and
   * paints throughout -- but it is a frame the budget cannot actually bound.
   *
   * What would make the budget mean what it says is a smaller region, and the
   * switch already exists: spec 195 chose 2200 by measuring **draw calls on a
   * real GPU for the Play tab**, said in as many words that it is one machine's
   * answer, and left `?props=` to ask again. The editor is a different
   * workload -- it re-composes regions on every stroke -- so it may well want a
   * different number, and that is a measurement on a real GPU rather than
   * something to guess at here.
   */
  pumpProps(budget: FrameBudget): number {
    if (this.propsPending === 0) return 0;
    const at = { x: this.camera3.target.x, z: this.camera3.target.z };
    const owed = propRegionsOwed(this.propBuckets, at, this.propsHeld);
    const heightAt = (x: number, z: number): number => this.map.world.heightAt(x, z);
    const normalAt = this.propNormalAt();
    let composed = 0;
    for (const key of owed) {
      this.propField.adoptRegion(key, buildRegionInstances(this.propBuckets.get(key) ?? [], heightAt, normalAt));
      this.propsHeld.add(key);
      composed++;
      if (budget.spent()) break;
    }
    return composed;
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
   * one pass over every prop in the world, which is far too much to do sixty
   * times a second.
   *
   * Since spec 211 this **drops and re-owes** rather than rebuilding: the field
   * is deferred, so building it composes nothing and `pumpProps` puts the
   * regions back from the pivot outward. That is the whole reason the
   * whole-field path is affordable at all -- it used to be 4.5s of frozen
   * editor at the end of a stroke that happened not to report a rectangle, on
   * the map we ship today rather than one we grow into.
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
    const props = this.map.store.props(this.layerId);
    this.propField.rebuildWithin(props, rect);
    // An edit composes the regions it touched, so the ledger has to agree that
    // they are composed -- otherwise the fill would compose them a second time,
    // throwing away the very batches this call just built. Re-bucketed for the
    // same reason: a stroke that scattered into empty ground made a region that
    // did not exist when the field was built, and one that erased the last prop
    // in a region removed one.
    this.propBuckets = propRegions(props);
    for (const key of propRegionKeysIn(rect)) this.propsHeld.add(key);
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
    this.groundHeld.clear();
    this.terrainMesh = buildTerrainMeshFromChunks(this.map.meshLayers, []);
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

  /**
   * The nearest of `targets` under the cursor, or null (spec 222).
   *
   * Beside `pick` rather than folded into it because the two answer different
   * questions -- that one is "which ground", this is "which *thing*" -- and the
   * select tool needs the second: a marker's billboard floats above the point
   * it marks, so aiming at the picture and aiming at the ground under it are
   * metres apart, by a distance that depends on the camera's pitch.
   *
   * `visible` is checked because the marker view keeps its spare sprites and
   * hides them rather than destroying them, and three does not skip an
   * invisible object for a direct `intersectObjects` over a list.
   */
  pickObject(cssX: number, cssY: number, targets: readonly THREE.Object3D[]): THREE.Object3D | null {
    if (targets.length === 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set((cssX / rect.width) * 2 - 1, -((cssY / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.hits.length = 0;
    this.raycaster.intersectObjects([...targets], false, this.hits);
    for (const hit of this.hits) {
      if (hit.object.visible) return hit.object;
    }
    return null;
  }

  /** Re-mesh one chunk after an edit -- the whole point of the patch rebuild. */
  rebuildChunk(layerId: string, cx: number, cz: number): void {
    // Ground that is not meshed is not re-meshed (spec 212). A mesh is derived,
    // and an edit to a chunk the camera has panned away from must not put it
    // back on the scene graph -- `pumpGround` rebuilds it from the store if the
    // camera ever comes back, and until then there is nothing to correct.
    if (!this.heldGround(layerId).has(chunkKey(cx, cz))) return;
    const chunk = this.map.store.buildChunk(layerId, cx, cz);
    if (chunk) this.terrainMesh.rebuild(chunk);
  }

  /** What is meshed for one layer. Created on first ask. */
  private heldGround(layerId: string): Map<string, ChunkCoord> {
    const held = this.groundHeld.get(layerId);
    if (held) return held;
    const fresh = new Map<string, ChunkCoord>();
    this.groundHeld.set(layerId, fresh);
    return fresh;
  }

  /** The chunk the camera's pivot stands in, or null if it is off this layer. */
  private pivotChunk(layerId: string): ChunkCoord | null {
    const { x, z } = this.camera3.target;
    return this.map.store.chunksInRect(layerId, { minX: x, minZ: z, maxX: x, maxZ: z })[0] ?? null;
  }

  /** Chunks the ledger believes are meshed, across every layer. */
  get groundHeldCount(): number {
    let n = 0;
    for (const held of this.groundHeld.values()) n += held.size;
    return n;
  }

  /**
   * Chunk surfaces actually on the scene graph.
   *
   * Counted off the graph rather than off the ledger, the way
   * `drawnPropInstances` is: the two agreeing is the claim, so a readout taken
   * from the ledger alone could report a working fill that drew nothing.
   * `pickTargets` is exactly the list of drawn surfaces, and is the same list
   * the cursor raycasts against -- so this also answers "is there anything to
   * click on", which is the consequence of a window this spec has to be right
   * about.
   */
  get groundMeshedCount(): number {
    return this.terrainMesh.pickTargets.length;
  }

  /**
   * Mesh the ground the camera frames, and drop what it has panned away from
   * (spec 212).
   *
   * Per layer, because the rock tiers are layers of their own with their own
   * chunk grids -- one window over all of them would let the ground's view
   * evict a tier's chunks, which is a different rectangle's business.
   *
   * The two halves cannot fight: everything `chunksOwed` returns is in view, the
   * view is inside its own bounding box, and `chunksBeyond` keeps that box grown
   * by `EDITOR_KEEP_PAD_CHUNKS`. Eviction therefore runs unbudgeted -- it is a
   * `remove` per chunk against a `buildChunk` plus a mesh, and leaving dropped
   * ground on the graph until a later frame is holding memory to save nothing.
   *
   * Unlike spec 208's client, nothing beside a dropped chunk needs re-meshing.
   * There the store loses the chunk, so its neighbours' aprons and shore fields
   * go stale; here the store is untouched and only what is *drawn* changes, so a
   * chunk's mesh is a pure function of the store whichever of its neighbours
   * happen to be on the graph. (`erase` re-bakes the neighbours' water anyway,
   * which is right for the streaming case and simply lands on the same answer
   * here, for the same reason.)
   */
  pumpGround(budget: FrameBudget): number {
    const rect = viewRect(this.camera3, this.aspect());
    let meshed = 0;
    for (const layer of this.document.layers) {
      const inView = this.map.store.chunksInRect(layer.id, rect);
      const held = this.heldGround(layer.id);
      const owed = chunksOwed(inView, this.pivotChunk(layer.id), new Set(held.keys()));
      for (const c of owed) {
        const chunk = this.map.store.buildChunk(layer.id, c.cx, c.cz);
        if (chunk) {
          this.terrainMesh.rebuild(chunk);
          held.set(chunkKey(c.cx, c.cz), c);
          meshed++;
        }
        if (budget.spent()) break;
      }
      for (const c of chunksBeyond(held, inView, EDITOR_KEEP_PAD_CHUNKS)) {
        this.terrainMesh.remove(layer.id, c.cx, c.cz);
        held.delete(chunkKey(c.cx, c.cz));
      }
    }
    return meshed;
  }

  /** The canvas's aspect, from the box rather than from the last render. */
  private aspect(): number {
    const w = this.canvas.clientWidth || this.canvas.width || 1;
    const h = this.canvas.clientHeight || this.canvas.height || 1;
    return h === 0 ? 1 : w / h;
  }

  /** Stop drawing a chunk whose ground has gone (spec 085). */
  dropChunk(layerId: string, cx: number, cz: number): void {
    this.terrainMesh.remove(layerId, cx, cz);
  }

  /**
   * Bring the mesh's layer set in line with the store's (spec 123).
   *
   * Drawing a tier adds a layer, carving the last of one away removes it, and
   * undo does either -- so rather than have four call sites each remember which
   * direction they moved, this reconciles both. Cheap: a map has a handful of
   * layers, and it is only called when one has actually changed.
   */
  syncLayers(): void {
    const held = new Set(this.map.store.layerIds);
    const drawn = new Set(this.terrainMesh.layerIds());
    for (const id of held) {
      if (drawn.has(id)) continue;
      const layer = meshLayerFor(this.map.store, id);
      if (layer) this.terrainMesh.addLayer(layer);
    }
    for (const id of drawn) {
      if (!held.has(id)) this.terrainMesh.removeLayer(id);
    }
    // `heightAt` closes over a fixed layer array so the server's per-tick path
    // allocates nothing, which means a tier just drawn is invisible to it until
    // the world is rebuilt. Doing it here rather than at each call site is what
    // makes a stack stack: the next drag's height is taken from ground that now
    // includes the tier under it.
    this.map = { ...this.map, world: worldFor(this.map.store) };
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
export async function mountEditor(container: HTMLElement): Promise<ViewHandle> {
  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#0b0b12;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;';

  const help = document.createElement('div');
  help.style.cssText = `${OVERLAY_CSS}position:absolute;left:10px;bottom:10px;z-index:20;`;
  /**
   * Filled in once the map is open, because what the top line should say
   * depends on which map that is: replacing `maps/arena/` with a generated
   * world is the mistake spec 176 exists to stop, and telling somebody to do it
   * would be this tab's own idea.
   */
  const showHelp = (): void => {
    help.innerHTML =
      `<b style="color:#f0f0f8;">Map editor</b> &mdash; editing <b>${editing}</b>` +
      // Kept to one short clause: this box sits beside the readout, and the
      // four-step copy it used to describe is one button now.
      `${savedAs === SHIPPED_MAP_NAME ? ', the map the game plays' : ''}<br>` +
      '<b>left-drag</b> applies the armed tool &middot; <b>middle-drag</b> tracks &amp; dollies &middot; ' +
      '<b>right-drag</b> orbits &middot; <b>wheel</b> zooms<br>' +
      '<span style="color:#7a7a90;">Ctrl+Z undoes a stroke</span>';
  };

  const readout = document.createElement('div');
  readout.style.cssText = `${OVERLAY_CSS}position:absolute;right:10px;bottom:10px;z-index:20;text-align:right;`;

  const panelHost = document.createElement('div');
  panelHost.style.cssText = 'position:absolute;top:44px;right:10px;z-index:30;';

  root.append(canvas, help, readout, panelHost);
  container.appendChild(root);

  // A refresh must not lose work, so an autosave that still parses is restored
  // rather than offered. The panel's "Discard autosave" button is how you get
  // the map back as it is on disk, which is one click rather than a trip through
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
  // What this session is editing: `maps/arena/` unless `?map=generated`
  // asks for a world from a seed (spec 176).
  const source = await openEditorMap(globalThis.location?.search ?? '', viewSeed(), async () => (await loadShippedMap()).doc);
  const scene = new EditorScene(
    canvas,
    restored ? { document: restored, map: loadMap(restored) } : source,
  );
  const revision = new RevisionTracker();
  /**
   * Whether a restored autosave is work on *this* map or on a different one.
   *
   * The slot holds text and no name, so the only honest way to ask is the
   * document itself, and the seed answers it: a slot written before spec 176
   * holds a world generated from the clock, and calling that `arena.json`
   * would let one click drop a stranger's world on top of the map the server
   * boots from -- under the right filename, which is the worst version of it
   * (spec 177).
   */
  const restoredIsSource = restored !== null && restored.seed === source.document.seed;
  /**
   * The name a save comes back as: whatever was opened.
   *
   * Follows a loaded file, so saving after a load round-trips the name rather
   * than renaming somebody's map after its seed. A restored autosave keeps the
   * name only when it is the same map -- otherwise it is named after its own
   * seed, like any other generated world.
   */
  let savedAs = restored !== null && !restoredIsSource ? mapFilename(restored) : source.name;
  /** Which map the readout says is being edited. */
  let editing =
    restored === null
      ? source.from
      : restoredIsSource
        ? `${source.from} (restored autosave)`
        : `restored autosave, seed ${restored.seed} -- NOT ${source.from}`;
  let status = restored ? 'restored autosave (in this browser, not on disk)' : '';
  /**
   * Edits this session has made that are not in `maps/` yet.
   *
   * Separate from the autosave's own revision, because they answer different
   * questions -- the autosave asks "is the slot stale", and this asks "does the
   * file the server boots from have this in it". Conflating them is what let
   * "autosaved" read as "saved".
   */
  let editsSinceDisk = 0;
  /** Anything changed: the autosave wants to know, and so does the disk. */
  const markEdited = (): void => {
    revision.touch();
    editsSinceDisk += 1;
  };
  showHelp();
  const input = new EditorInputCapture(canvas);
  const history = new EditHistory();
  const settings = createEditorSettings();
  settings.recipe = [...RECIPES.keys()][0] ?? '';

  const cursor: BrushCursorHandle = createBrushCursor(cursorColor(settings));
  scene.addOverlay(cursor.object);

  /**
   * How far a select drag must travel before it counts as moving the marker
   * rather than as a click that selected it (spec 222).
   *
   * In world units, so it is a real distance on the ground rather than a number
   * of pixels that means something different at every zoom -- and small enough
   * that a deliberate drag crosses it immediately.
   */
  const MARKER_DRAG_SLOP = 4;

  /**
   * The selected marker went away: re-read the panel (spec 222).
   *
   * The same hoisted-hook shape `onPartsChanged` uses below and for the same
   * reason -- `refreshMarkers` is defined before the panel exists, and this is
   * how it reaches one without a nullable handle.
   */
  let onSelectionCleared: () => void = () => {
    // Replaced the moment the panel exists; nothing selects anything before then.
  };

  const markerView = createMarkerView();
  scene.addOverlay(markerView.group);
  // A second ring, in the select tool's own colour, parked on the selected
  // marker rather than following the cursor (spec 222). The same geometry the
  // brush cursor is, for the same reason: a flat ring laid against a hillside
  // buries half of itself, and a marker on a slope is exactly where you want to
  // see which one is picked.
  const selectionRing: BrushCursorHandle = createBrushCursor(MODE_COLORS.select);
  scene.addOverlay(selectionRing.object);
  const arenaOutline = createArenaOutline();
  scene.addOverlay(arenaOutline.object);
  // The chunk rectangle a part drag has selected, in the part tool's own colour
  // so it is not mistaken for the arena box.
  const partOutline = createArenaOutline(0x9fb8e8);
  partOutline.object.visible = false;
  scene.addOverlay(partOutline.object);
  // A tier's drag draws its own rectangle too, in the rock tool's grey.
  const rockOutline = createArenaOutline(0x9aa4b0);
  rockOutline.object.visible = false;
  scene.addOverlay(rockOutline.object);

  // The building under the cursor, before it is put down (spec 225).
  const structureGhost = createStructureGhost();
  scene.addOverlay(structureGhost.object);
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
  /** Where a tier drag started (spec 123). Null when none is in progress. */
  let rockAnchor: { x: number; z: number } | null = null;
  /**
   * Where a building's press landed, while the drag that sizes it is still
   * going on (spec 225).
   *
   * The building goes at the **anchor**, never at where the cursor ended up:
   * the drag says how big, and a press already said where.
   */
  let structureAnchor: { x: number; z: number } | null = null;

  /**
   * The size a building would be put down at right now.
   *
   * The drag's, once it has left the smallest ring; the panel's until then, and
   * whenever there is no drag. One function, three readers -- the cursor ring,
   * the ghost and the commit -- because a preview that showed one size and
   * placed another would be worse than no preview at all.
   */
  const armedStructureScale = (to: { x: number; z: number } | null): number => {
    if (!structureAnchor || !to) return settings.structureScale;
    const distance = Math.hypot(to.x - structureAnchor.x, to.z - structureAnchor.z);
    return dragScale(settings.structure, distance) ?? settings.structureScale;
  };
  /**
   * The first of a stair's two edges, waiting for the second (spec 132).
   *
   * Held across strokes on purpose -- it is the one tool here that takes two
   * drags -- and dropped whenever the tool or the mode changes, so a half-drawn
   * flight cannot be finished by a gesture meant for something else.
   */
  let stairHead: {
    line: [{ x: number; z: number }, { x: number; z: number }];
    tierLayerId: string;
    height: number;
  } | null = null;
  /** Shorter than this and a drag is a click, not an edge. */
  const MIN_STAIR_EDGE = 8;

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

  /**
   * Whether this session has baked walkability yet (spec 204).
   *
   * It used to be baked once at mount, because the document carried `nav` and a
   * save had to have something to write. The document does not carry it any
   * more -- its only reader was this overlay -- so the bake moves to the first
   * time the overlay is actually switched on, and a session that never opens it
   * never pays for it.
   */
  let navBaked = false;

  /** Redraw the walkability overlay, but only while it is being looked at. */
  const refreshNav = (): void => {
    navView.setVisible(settings.showNav);
    if (!settings.showNav) return;
    if (!navBaked) {
      bakeLayerNav(scene.map.store, layerId);
      navBaked = true;
    }
    navView.refresh(scene.map.store, layerId, groundAt);
  };

  /** Redraw the markers and the arena box from whatever the store now holds. */
  const refreshMarkers = (): void => {
    const markers = scene.map.store.markers(layerId);
    // The selection is held by id, so a marker that has gone -- erased, or taken
    // away by an undo -- has to be *noticed* rather than announced. Checked here
    // because this is the one function every path that changes the marker set
    // already calls, so there is no way to change the set and skip the check.
    const selected = markers.find((m) => m.id === settings.selectedMarkerId) ?? null;
    if (!selected && settings.selectedMarkerId !== '') {
      Object.assign(settings, clearSelection(settings));
      // On the *transition* only. The eraser calls this every frame of a drag,
      // and rebuilding the whole GUI sixty times a second to say the same thing
      // is the sort of thing that reads as a stutter -- and the panel is stale
      // rather than merely quiet if it is not told at all, which is the
      // live-looking-and-inert state the Markers folder's own note argues
      // against.
      onSelectionCleared();
    }
    markerView.render(markers, groundAt, settings.selectedMarkerId);
    if (selected) {
      selectionRing.moveTo(selected.x, selected.z, MARKER_CURSOR_RADIUS, groundAt);
      selectionRing.setVisible(true);
    } else {
      selectionRing.setVisible(false);
    }
    arenaOutline.object.visible = settings.showArena;
    arenaOutline.refresh(scene.document.arena, groundAt);
  };

  /**
   * Select the marker a click named, or nothing (spec 222).
   *
   * Two picks in order, and the order is the whole design. **The billboards
   * first**, because that is what a person is aiming at and a sprite raycast is
   * exact at every camera angle -- where the marker's own point is
   * `STEM_HEIGHT` below its disc, so the ground under an aimed cursor is some
   * way off and by a distance the pitch decides. **Then the ground**, within
   * `SELECT_PICK_RADIUS`, so a click that missed the disc but landed by the
   * stem still names the thing it was obviously about.
   *
   * A click that names nothing clears the selection, which is what makes the
   * selection dismissable without a second control.
   */
  const selectAt = (cssX: number, cssY: number, ground: { x: number; z: number } | null): void => {
    const markers = scene.map.store.markers(layerId);
    const hit = scene.pickObject(cssX, cssY, markerView.pickTargets);
    const byBillboard = hit ? markerView.markerIdOf(hit) : null;
    const found =
      byBillboard !== null
        ? (markers.find((m) => m.id === byBillboard) ?? null)
        : ground
          ? markerAt(markers, ground.x, ground.z, SELECT_PICK_RADIUS)
          : null;

    if (!found) {
      Object.assign(settings, clearSelection(settings));
      refreshMarkers();
      panel.refresh();
      status = 'nothing there: click a marker to select it';
      return;
    }
    Object.assign(settings, selectionFrom(found, settings));
    refreshMarkers();
    panel.refresh();
    status = `selected ${found.id}${found.label === undefined ? '' : `: ${found.label}`}`;
  };

  /**
   * Write the panel's values onto the selected marker.
   *
   * One undo entry per edit rather than per stroke: there is no drag here, and a
   * change to a dropdown is a whole thought.
   */
  const commitSelection = (): void => {
    const id = settings.selectedMarkerId;
    if (id === '') return;
    history.beginStroke();
    const { marker } = updateMarker(scene.map.store, layerId, id, patchFromSelection(settings), (cx, cz) => {
      history.captureChunk(scene.map.store, layerId, cx, cz);
    });
    history.endStroke();
    if (!marker) {
      status = `could not edit ${id}`;
      return;
    }
    // A marker sits at a height and changes nothing under it, so this owes the
    // autosave and nothing else -- no re-mesh, no nav re-bake, no prop rebuild.
    // The same reasoning the repaint stroke's comment sets out, one field over.
    markEdited();
    refreshMarkers();
    // Said in words, like a placement is (spec 178): a spawner and a campfire
    // are two letters apart in the strip, and what a kind change actually did to
    // the numbers under it is worth reading rather than inferring.
    status = `${marker.id}: ${marker.kind}${marker.label === undefined ? '' : ` ${marker.label}`}`;
  };

  /** The selected marker as the document holds it, for a probe (spec 222). */
  const selectedReadout = (): string => {
    const id = settings.selectedMarkerId;
    if (id === '') return 'none';
    const marker = scene.map.store.markers(layerId).find((m) => m.id === id);
    if (!marker) return 'none';
    return (
      `${marker.id} kind:${marker.kind} label:${marker.label ?? ''} ` +
      `respawn:${String(marker.spawner?.respawnSeconds ?? 0)} leash:${String(marker.spawner?.leashRadius ?? 0)} ` +
      `at:${String(Math.round(marker.x))},${String(Math.round(marker.z))}`
    );
  };

  /** Take the selected marker off the map, since the eraser is a radius. */
  const deleteSelection = (): void => {
    const id = settings.selectedMarkerId;
    if (id === '') {
      status = 'nothing selected';
      return;
    }
    const found = scene.map.store.markers(layerId).find((m) => m.id === id);
    if (!found) return;
    history.beginStroke();
    // Through the eraser's own removal, at a radius small enough to take one
    // marker: a second way to delete a marker would be a second set of rules
    // about which chunks that dirties.
    eraseMarkers(scene.map.store, layerId, { x: found.x, z: found.z, radius: 0.01 }, (cx, cz) => {
      history.captureChunk(scene.map.store, layerId, cx, cz);
    });
    history.endStroke();
    markEdited();
    // Clears the selection on its own, since the id it names has gone.
    refreshMarkers();
    panel.refresh();
    status = `deleted ${id}`;
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
    rebakeNav(scene.map.store, layerId, touched);
    // Only the batches over the ground that changed, not every batch in the
    // world: the field is grouped into regions for culling, and this makes that
    // grouping the unit of invalidation too (spec 086).
    const span = boundingChunkRect([...touched, ...gone]);
    const world = span && chunkRectWorld(scene.map.store, layerId, span);
    if (world) scene.refreshPropsWithin(world);
    else scene.refreshProps();
    refreshMarkers();
    refreshNav();
    markEdited();
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

  /**
   * Everything a tier changes, and nothing it does not (spec 123).
   *
   * The same shape as `rebuiltAfterParts`, and deliberately smaller. A tier
   * stands *on* the world rather than extending it, so none of the things that
   * follow ground moving follow this: nav describes where a body may walk on
   * the ground layer, the prop field is planted on the ground layer, and the
   * camera fence comes from the ground layer's bounds. All three are untouched
   * by a slab appearing above them.
   */
  const rebuiltAfterRock = (
    rockLayer: string,
    touched: readonly ChunkCoord[],
    gone: readonly ChunkCoord[] = [],
  ): void => {
    for (const c of gone) scene.dropChunk(rockLayer, c.cx, c.cz);
    // The ring too: a tier's neighbours decide where its skirt goes, so a chunk
    // beside one that just changed has a wall to grow or drop.
    for (const c of withNeighbours([...touched, ...gone])) scene.rebuildChunk(rockLayer, c.cx, c.cz);
    markEdited();
    onPartsChanged();
  };

  /** Drag out a tier, or take a bite out of one. */
  const commitRock = (a: { x: number; z: number }, b: { x: number; z: number }): void => {
    const footprint = worldRectFrom(a, b);
    const store = scene.map.store;

    if (settings.rockTool === 'detail') {
      // A click rather than a drag: the formation is already a thing on the
      // ground, so pointing at it is the whole selection.
      const detail = detailAt(store, history, {
        x: a.x,
        z: a.z,
        seed: Math.round(settings.rockDetailSeed),
        erosion: settings.rockErosion,
      });
      if (!detail.ok) {
        status = `detail refused: ${detail.reason}`;
        return;
      }
      // Erosion can empty a chunk, so the mesh has to be told to stop drawing
      // one -- and the ring around it re-meshed, since a neighbour losing its
      // ground is a wall appearing.
      for (const layerId2 of detail.layerIds) {
        const held = new Set(store.chunkCoords(layerId2).map((c) => `${c.cx},${c.cz}`));
        for (const c of detail.touched) {
          if (!held.has(`${c.cx},${c.cz}`)) scene.dropChunk(layerId2, c.cx, c.cz);
        }
        rebuiltAfterRock(layerId2, detail.touched);
      }
      status = `detailed ${detail.layerIds.length} tier(s): eroded ${detail.erodedCells} cells`;
      return;
    }

    if (settings.rockTool === 'stair') {
      // Two lines, not a rectangle (spec 132): the first is where the flight
      // meets the tier, the second is where its foot lands. Each is drawn *on*
      // a layer and takes its height from that layer, which is the whole point
      // -- the old tool raycast the ground under the two ends of one drag and
      // could not tell tier top from the meadow behind it.
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      if (Math.hypot(b.x - a.x, b.z - a.z) < MIN_STAIR_EDGE) {
        status = 'that edge is too short to be one -- drag out the width of the flight';
        return;
      }

      if (!stairHead) {
        const tier = rockLayerAt(store, mid.x, mid.z);
        if (!tier) {
          status = 'draw the first edge on a tier -- that is the rock the flight is cut into';
          return;
        }
        stairHead = {
          line: [{ x: a.x, z: a.z }, { x: b.x, z: b.z }],
          tierLayerId: tier,
          height: scene.map.world.heightAt(mid.x, mid.z),
        };
        status = `head on "${tier}" at ${Math.round(stairHead.height)} -- now draw the foot`;
        return;
      }

      // Read before the flight exists: afterwards the world includes the run
      // itself, and sampling again would measure what was just built rather
      // than the thing it has to reach.
      const head = stairHead;
      stairHead = null;
      const footHeight = scene.map.world.heightAt(mid.x, mid.z);
      const stair = addStair(store, history, {
        edges: { top: head.line, foot: [{ x: a.x, z: a.z }, { x: b.x, z: b.z }] },
        tierLayerId: head.tierLayerId,
        topHeight: head.height,
        bottomHeight: footHeight,
        seed: (scene.document.seed ^ 0x57a12) + store.layerIds.length,
        origin: scene.map.store.layerInfo(layerId)?.origin ?? { x: 0, z: 0 },
        propLayerId: layerId,
      });
      if (!stair.ok) {
        status = `stair refused: ${stair.reason}`;
        return;
      }
      scene.syncLayers();
      // The notch took cells out of the tier, so that layer needs re-meshing
      // too -- and its emptied chunks dropping, since a hole cut clean through
      // one leaves nothing to draw.
      const held = new Set(store.chunkCoords(head.tierLayerId).map((c) => `${c.cx},${c.cz}`));
      const gone = store
        .chunksInRect(head.tierLayerId, worldRectFrom(head.line[0], head.line[1]))
        .filter((c) => !held.has(`${c.cx},${c.cz}`));
      rebuiltAfterRock(head.tierLayerId, stair.created, gone);
      rebuiltAfterRock(stair.layerId, stair.created);
      if (stair.clearedProps > 0) {
        scene.refreshPropsWithin(footprint);
        for (const c of stair.propChunks) scene.rebuildChunk(layerId, c.cx, c.cz);
      }
      status =
        `stair "${stair.layerId}": ${stair.cells} cells in ${stair.risers} step(s), ` +
        `climbing ${Math.round(Math.abs(head.height - footHeight))}, ` +
        `notched ${stair.notched} out of "${head.tierLayerId}"`;
      return;
    }

    if (settings.rockTool === 'remove') {
      // Named by pointing at it rather than chosen from a list first, the way
      // removing a part is: the tier you can see is the one you mean.
      const target = settings.rockLayer || rockLayerAt(store, a.x, a.z) || rockLayerAt(store, b.x, b.z);
      if (!target) {
        status = 'no tier under the cursor';
        return;
      }
      const removed = removeRock(store, history, { layerId: target, footprint });
      if (!removed.ok) {
        status = `tier refused: ${removed.reason}`;
        return;
      }
      if (removed.removedLayer) {
        scene.syncLayers();
        if (settings.rockLayer === target) settings.rockLayer = NEW_ROCK_TIER;
      }
      rebuiltAfterRock(target, removed.touched, removed.removed);
      status =
        `carved ${removed.cells} cells from "${target}"` + (removed.removedLayer ? ' (tier gone)' : '');
      return;
    }

    // The tier's top is measured from the *highest* ground its footprint covers,
    // so a rectangle dropped on a tier already standing rises above that one
    // rather than being swallowed by it. The base is taken from the lowest, so
    // the skirt buries itself in the hillside instead of floating over it.
    const step = store.cellSize;
    let hi = -Infinity;
    let lo = Infinity;
    for (let x = footprint.minX; x <= footprint.maxX + step; x += step) {
      for (let z = footprint.minZ; z <= footprint.maxZ + step; z += step) {
        const h = scene.map.world.heightAt(Math.min(x, footprint.maxX), Math.min(z, footprint.maxZ));
        hi = Math.max(hi, h);
        lo = Math.min(lo, h);
      }
    }
    if (!Number.isFinite(hi)) {
      status = 'that rectangle covers no ground';
      return;
    }

    const isNew = settings.rockLayer === NEW_ROCK_TIER;
    const layerIdForTier = isNew ? nextRockLayerId(store) : settings.rockLayer;
    const ground = scene.map.store.layerInfo(layerId);
    const added = addRock(store, history, {
      layerId: layerIdForTier,
      footprint,
      top: hi + settings.rockHeight,
      baseY: lo - BURY_DEPTH,
      seed: (scene.document.seed ^ 0x0c1177) + store.layerIds.length,
      origin: ground?.origin ?? { x: 0, z: 0 },
      // Trees under a slab are trees standing inside it. Cleared in the same
      // stroke, so one Ctrl+Z puts both the rock and the stand back.
      propLayerId: layerId,
    });
    if (!added.ok) {
      status = `tier refused: ${added.reason}`;
      return;
    }
    if (added.createdLayer) {
      scene.syncLayers();
      // Armed on the tier just made, so the next drag extends it rather than
      // silently starting another layer at the same height.
      settings.rockLayer = added.layerId;
      panel.refreshParts();
    }
    rebuiltAfterRock(added.layerId, [...added.created, ...added.touched]);
    if (added.propChunks.length > 0) {
      // Ground chunks change for two reasons now: trees taken out from under the
      // tier, and the ground under it painted as stone (spec 127). Either one
      // needs the chunk re-meshed; only the first needs the prop field touched.
      if (added.clearedProps > 0) {
        // Only the batches over the ground the tier covers, not every batch in
        // the world -- the same region-sized invalidation a brush stroke uses
        // (spec 086).
        scene.refreshPropsWithin(footprint);
      }
      for (const c of added.propChunks) scene.rebuildChunk(layerId, c.cx, c.cz);
    }
    status =
      `tier "${added.layerId}": ${added.cells} cells at ${Math.round(hi + settings.rockHeight)}` +
      (added.clearedProps > 0 ? `, cleared ${added.clearedProps} props` : '');
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
    // The stroke may have been the one that created a tier's layer, or the one
    // that carved the last of it away -- either way the mesh's layer set and the
    // world's have just moved, and both directions are reconciled in one place.
    if (structural) scene.syncLayers();
    if (settings.rockLayer && !scene.map.store.layerInfo(settings.rockLayer)) {
      settings.rockLayer = NEW_ROCK_TIER;
    }

    // Tiers rebuild on their own terms. Nav, the prop field and the camera fence
    // all describe the ground layer, and none of them is changed by a slab
    // above it appearing or going away.
    for (const id of new Set([...remeshed, ...removed].map((r) => r.layerId))) {
      if (id === layerId) continue;
      rebuiltAfterRock(
        id,
        remeshed.filter((r) => r.layerId === id),
        removed.filter((r) => r.layerId === id),
      );
    }

    const groundRemeshed = remeshed.filter((r) => r.layerId === layerId);
    const groundRemoved = removed.filter((r) => r.layerId === layerId);
    if (groundRemeshed.length === 0 && groundRemoved.length === 0) return;

    // Undoing a part is the same shape of work as making one, so it goes
    // through the same targeted path rather than rebuilding the world (spec 085).
    if (structural) {
      rebuiltAfterParts(groundRemeshed, groundRemoved);
      return;
    }
    markEdited();
    for (const c of groundRemeshed) scene.rebuildChunk(c.layerId, c.cx, c.cz);
    // Nav describes the ground, so undoing the ground has to undo nav with it.
    rebakeNav(scene.map.store, layerId, groundRemeshed);
    scene.refreshProps();
    refreshMarkers();
    refreshNav();
  };

  /** Everything derived from the map, rebuilt after a load or a restore. */
  const rebuildAll = (): void => {
    // The ground under it is a different world now, so whatever was baked is
    // stale. Invalidated rather than re-baked: `refreshNav` below does it if the
    // overlay is on, and a session that never opens it never pays (spec 204).
    navBaked = false;
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
    anchor.download = savedAs;
    // In the document rather than detached: some browsers ignore a click on an
    // anchor that was never in the tree.
    anchor.style.display = 'none';
    root.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    status = `downloaded ${anchor.download} -- copy it over maps/ and restart the server`;
  };

  /**
   * Write the map over the file it came from, through the dev server (spec 177).
   *
   * The one that finishes the job. `saveToFile` hands you a download and four
   * more steps to get wrong, and the failure looks identical to the editor not
   * having saved -- which is how "I added some spawners and nothing shows up"
   * happens with every rule in this directory working correctly.
   *
   * Never silent, in either direction: it says what it wrote, or why it could
   * not and what to do instead.
   */
  const saveToDisk = (): void => {
    status = `writing maps/${savedAs}...`;
    void writeMapToDisk(
      (input, init) => fetch(input, init),
      savedAs,
      mapText(scene.map.store.toDocument()),
    ).then((result) => {
      status = result.detail;
      // Only a write that landed counts as saved. A refusal must leave the
      // editor dirty, or the autosave stops running and the work is held in
      // one browser tab with nothing on disk behind it.
      if (result.kind === 'written') {
        revision.markSaved();
        editsSinceDisk = 0;
      }
    });
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
    // A save goes back under the name it came in as, so loading a map and saving
    // it again round-trips the file rather than renaming it after its seed.
    savedAs = from;
    editing = from;
    editsSinceDisk = 0;
    showHelp();
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
    rockLayerIds: () => rockLayerIds(scene.map.store),
    onRemoveNamedPart: () => {
      if (settings.removePartId) commitRemove(settings.removePartId);
      else status = 'no part selected to remove';
    },
    onSelectionEdit: commitSelection,
    onSelectionDelete: deleteSelection,
    onUndo: undo,
    onSave: saveToFile,
    onSaveToDisk: saveToDisk,
    onLoad: () => fileInput.click(),
    onDiscardAutosave: () => {
      if (storage) clearAutosave(storage);
      status = `autosave cleared -- reload for ${source.from} as it is on disk`;
    },
    onArmChange: () => {
      cursor.setColor(cursorColor(settings));
      arenaOutline.object.visible = settings.showArena;
    },
    onNavChange: refreshNav,
    onNavRebake: () => {
      // The one place a bake is asked for outright: the panel's own button.
      bakeLayerNav(scene.map.store, layerId);
      navBaked = true;
      refreshNav();
    },
  });
  onPartsChanged = (): void => panel.refreshParts();
  onSelectionCleared = (): void => panel.refresh();
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
  /**
   * The marker a select drag is carrying, by id (spec 222).
   *
   * Set on the press when the click named one, cleared on release. An id rather
   * than the marker, because the drag re-files it as it crosses a chunk seam and
   * a held object is stale the moment it does.
   */
  let grabbedMarkerId = '';
  /**
   * Where the ground pick was when the drag began, or null.
   *
   * A drag only *becomes* a move once it has travelled further than
   * `MARKER_DRAG_SLOP`, so a click with a shaky hand selects a marker without
   * nudging it half a unit -- the same reason a press and a drag are different
   * gestures everywhere else.
   */
  let markerDragFrom: { x: number; z: number } | null = null;
  let markerDragging = false;
  /**
   * Whether this stroke repainted any ground (spec 179).
   *
   * Its own flag rather than `strokeMovedGround`, because a material change is
   * the first edit here that changes the document without moving anything: it
   * owes a re-mesh and a revision, and none of the nav re-bake, prop rebuild or
   * marker refresh that flag pays for.
   */
  let strokeChangedMaterial = false;
  /**
   * Where the paint brush was last frame, so a drag paints the circle it swept
   * rather than a stamp per frame. Cleared whenever the cursor leaves the
   * terrain, so a pick that lands somewhere else does not paint the line
   * between.
   */
  let paintFrom: { x: number; z: number } | null = null;
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
      // Named for where it went. "autosaved" reads as "saved", and this slot is
      // in localStorage -- the file on disk has not been touched, which is
      // exactly the misunderstanding spec 177 was written about.
      status = 'autosaved to this browser -- not to maps/';
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

    // Ground the camera frames but has no mesh for (spec 212), then the trees
    // the deferred field still owes (spec 211). After the camera has moved and
    // before anything is drawn, so a frame that panned fills toward where it
    // panned to rather than where it came from -- and ground before trees,
    // because a tree standing over ground that has not arrived is the one
    // ordering a person would notice.
    scene.pumpGround(new FrameBudget(time, GROUND_PUMP_BUDGET_MS));
    scene.pumpProps(new FrameBudget(time, PROP_PUMP_BUDGET_MS));

    // The cursor goes where the ray lands, and the brush follows it. Both read
    // the same pick, so the ring always marks the ground that is about to move.
    const mouse = input.mouseCanvas();
    const onTerrain = scene.pick(mouse.x, mouse.y);
    // Only the part tool falls back to the plane: every other tool edits ground
    // that is there, and letting them aim into the void would silently do
    // nothing at a point they could not have meant.
    const at = onTerrain ?? (settings.mode === 'part' ? scene.pickPlane(mouse.x, mouse.y) : null);
    // A building being dragged out owns the ring: centred where the press
    // landed rather than under the cursor, at the size the drag has reached
    // (spec 225). Every other tool works under the cursor, so `at` is both.
    const armedScale = settings.mode === 'structure' ? armedStructureScale(at) : settings.structureScale;
    // Scoped to the mode rather than to whether an anchor happens to be set: an
    // anchor only outlives its own gesture if the mode changed mid-drag, and a
    // terrain brush drawing its ring where a building's press landed would be a
    // strange thing to have to explain.
    const ringAt = settings.mode === 'structure' ? (structureAnchor ?? at) : at;
    const ringRadius =
      settings.mode === 'structure'
        ? structureFootprint({ ...settings, structureScale: armedScale })
        : cursorRadius(settings);
    if (ringAt) {
      cursor.moveTo(ringAt.x, ringAt.z, ringRadius, (x, z) => scene.map.world.heightAt(x, z));
      cursor.setVisible(true);
    } else {
      cursor.setVisible(false);
    }

    // The ghost stands wherever the ring does, which is the point of it: the
    // ring says the footprint and this says the building. It goes away exactly
    // where `placeStructure` would refuse -- no ground under the cursor -- so
    // the preview vanishing *is* the refusal, seen before the click.
    if (settings.mode === 'structure' && ringAt) {
      structureGhost.showAt(
        settings.structure,
        ringAt.x,
        ringAt.z,
        (settings.structureYaw * Math.PI) / 180,
        armedScale,
        (x, z) => scene.map.world.heightAt(x, z),
      );
    } else {
      structureGhost.hide();
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
      strokeChangedMaterial = false;
      strokeDirty.length = 0;
      paintFrom = null;
      scatterCarry = 0;
      fencePath = NO_FENCE_PATH;
      propsRebuiltAt = time;
      // The height under the first press is the level `flatten` works toward.
      if (at) flattenTo = scene.map.world.heightAt(at.x, at.z);
      // A marker is placed on the press, not the drag: a spawn point is not a
      // bulk thing, and dragging would leave a trail of forty of them.
      partAnchor = settings.mode === 'part' && settings.partTool === 'add' && at ? { x: at.x, z: at.z } : null;
      // Both tier tools drag out a rectangle, unlike a part's remove which
      // names one thing under the cursor: carving a bite out of a tier is a
      // region, so it is a drag in both directions.
      rockAnchor = settings.mode === 'rock' && at ? { x: at.x, z: at.z } : null;
      // Remove happens on the press, like a marker: it names a thing already on
      // the ground rather than describing a region to fill.
      if (at && settings.mode === 'part' && settings.partTool === 'remove') {
        const under = partAt(scene.map.store, at.x, at.z);
        if (under) commitRemove(under.id);
        else status = 'no part under the cursor';
      }
      // A building lands on the *release*: the drag between the two is what
      // sizes it (spec 225). Only the anchor is taken here, because a press has
      // already said where the hut goes and the cursor is about to wander off
      // to say how big.
      structureAnchor = settings.mode === 'structure' && at ? { x: at.x, z: at.z } : null;
      if (settings.mode === 'select') {
        // Handed the *ground* pick as the fallback, and the cursor position for
        // the billboard raycast that is tried first (spec 222).
        selectAt(mouse.x, mouse.y, at);
        grabbedMarkerId = settings.selectedMarkerId;
        // Opened here rather than at the first drag frame, so the undo entry
        // holds where the marker was before it started moving. A press that
        // selects and never drags closes it having captured nothing, which is
        // what `endStroke` already does with an empty entry.
        markerDragFrom = at;
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
          // Named on the way in (spec 178). A marker's kind is a colour and a
          // letter on a billboard, and `spawn` and `spawner` are two letters
          // apart in the panel -- so what was actually placed is said in words,
          // with the monster when there is one, because a spawner without its
          // label is the failure this line exists to make visible.
          status =
            placed.marker.label === undefined
              ? `placed ${placed.marker.id}`
              : `placed ${placed.marker.id}: ${placed.marker.label}`;
        } else {
          // `addMarker` refuses a point past the layer or over a hole in it, and
          // this used to drop that on the floor -- a click that did nothing, no
          // marker and no word about why, which is indistinguishable from a
          // marker tool that does not work. Said out loud, like the part tool's
          // "no part under the cursor".
          status = 'no ground there: a marker has to sit on the map';
        }
      }
    }

    // The paint brush's segment memory only means anything while the cursor is
    // on the terrain: after a gap, the line between where it left and where it
    // came back is not ground anybody dragged over.
    if (!at) paintFrom = null;

    if (input.isPainting && at && settings.mode === 'select' && grabbedMarkerId !== '') {
      const from = markerDragFrom;
      if (from && !markerDragging && Math.hypot(at.x - from.x, at.z - from.z) > MARKER_DRAG_SLOP) {
        markerDragging = true;
      }
      if (markerDragging) {
        const moved = updateMarker(scene.map.store, layerId, grabbedMarkerId, { x: at.x, z: at.z }, capture);
        if (moved.marker) {
          strokeChangedMarkers = true;
          refreshMarkers();
          status = `moved ${grabbedMarkerId}`;
        } else {
          // `updateMarker` puts the marker back when the point is off the layer,
          // so this is a drag that went past the edge rather than a lost marker.
          status = 'no ground there: a marker has to sit on the map';
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
      } else if (settings.mode === 'paint') {
        const dirty = applyTerrainPaint(
          scene.map.store,
          { material: settings.paintMaterial, radius: settings.radius, falloff: settings.falloff },
          { layerId, x: at.x, z: at.z, from: paintFrom, onTouchChunk: capture },
        );
        paintFrom = { x: at.x, z: at.z };
        remesh(dirty);
        if (dirty.length > 0) strokeChangedMaterial = true;
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
      } else if (settings.mode === 'rock' && rockAnchor) {
        // Exactly the rectangle that will be baked -- unsnapped, because
        // `bakeRock` decides which cells are in by testing their centres and
        // the quantisation belongs in that one place.
        const rect = worldRectFrom(rockAnchor, at);
        rockOutline.refresh(rect, groundAt);
        rockOutline.object.visible = true;
        status = `${Math.round(rect.maxX - rect.minX)} x ${Math.round(rect.maxZ - rect.minZ)}`;
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
      // The ring reads the surface it may just have moved, so redraw it after --
      // at whatever this frame decided its centre and radius are, or a building
      // being dragged out would have its ring snapped back under the cursor.
      cursor.moveTo(ringAt?.x ?? at.x, ringAt?.z ?? at.z, ringRadius, (x, z) => scene.map.world.heightAt(x, z));
    }

    if (input.takePaintEnd()) {
      // A building lands here rather than on the press, because the drag
      // between them is its size (spec 225). At the **anchor**: the press said
      // where, and the cursor has since wandered off to say how big.
      if (settings.mode === 'structure' && structureAnchor) {
        const scale = armedStructureScale(at);
        const out = placeStructure(
          scene.map.store,
          layerId,
          { ...settings, structureScale: scale },
          structureAnchor,
          capture,
        );
        if (out.placed) {
          // The rebuild, the autosave and the edit marker are the block below
          // this one -- a building is an ordinary prop edit, which is exactly
          // what moving it onto the release bought.
          strokeChangedProps = true;
          // The drag is where the size came from, so the panel is told: the
          // next building is the size of the last one, and the slider says so.
          settings.structureScale = scale;
          panel.syncStructureSize();
          // What a light was placed *at* is said out loud, for the reason the
          // refusal below is: a fixture put down at the wrong brightness looks
          // exactly like one put down at the right one until it is dark
          // (spec 248). A kind that emits nothing says nothing extra.
          const lit = fixtureLight(out.placed);
          status =
            `placed ${out.placed.kind} facing ${Math.round(settings.structureYaw)}\u00b0` +
            ` at ${scale.toFixed(2)}x` +
            (lit ? `, ${lit.brightness.toFixed(2)} over ${String(Math.round(lit.radius))}` : '');
        } else if (out.refused) {
          status = out.refused;
        }
      }
      structureAnchor = null;

      if (settings.mode === 'part') {
        partOutline.object.visible = false;
        const rect = at && partAnchor ? chunkRectFrom(scene.map.store, layerId, partAnchor, at) : null;
        if (rect) commitPart(rect);
        partAnchor = null;
      } else if (settings.mode === 'rock') {
        rockOutline.object.visible = false;
        // `addRock`/`removeRock` open and close their own entry, so this must
        // not be wrapped in one: a tier lands in one commit or not at all.
        if (at && rockAnchor) commitRock(rockAnchor, at);
        rockAnchor = null;
      } else history.endStroke();
      grabbedMarkerId = '';
      markerDragFrom = null;
      markerDragging = false;
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
      if (strokeMovedGround) rebakeNav(scene.map.store, layerId, strokeDirty);
      if (strokeMovedGround || strokeChangedProps) refreshNav();
      // A repaint counts as an edit -- the autosave and the disk both want it --
      // and owes nothing above it: walkability is ground, solidity and the water
      // line, a prop's colour comes from its own part rather than from what it
      // stands on, and a marker sits at a height. None of the three moved.
      if (strokeMovedGround || strokeChangedProps || strokeChangedMarkers || strokeChangedMaterial) {
        markEdited();
      }
      strokeMovedGround = false;
      strokeChangedProps = false;
      strokeChangedMarkers = false;
      strokeChangedMaterial = false;
      paintFrom = null;
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
    // What the deferred prop fill has actually got on screen (spec 211).
    // Published because there is no other way to see it: every rule about the
    // ledger is asserted in Node, and none of them can say whether the frame
    // loop calls any of it -- which is the shape of bug this tree keeps finding.
    readout.dataset.props = `drawn:${String(scene.drawnPropInstances)} pending:${String(scene.propsPending)}`;
    // What the windowed ground fill is holding (spec 212), for the same reason:
    // every rule about the window is asserted in Node and none of them can say
    // whether the frame loop calls any of it. `meshed` is counted off the scene
    // graph, so ground built and hung on nothing reads as absent.
    readout.dataset.ground = `meshed:${String(scene.groundMeshedCount)} held:${String(scene.groundHeldCount)} of:${String(chunkCount())}`;
    // The building preview (spec 225), and the same argument again: every rule
    // about the ghost's transform is asserted in Node, and none of them can say
    // whether the frame loop shows it, hides it where the tool would refuse, or
    // grows it while a drag is running. Off the scene graph, so a ghost built
    // and hung on nothing reads as absent.
    const ghost = structureGhost.drawn();
    readout.dataset.ghost = ghost
      ? `${ghost.kind} meshes:${String(ghost.meshes)} scale:${ghost.scale.toFixed(2)}`
      : 'hidden';
    // What the selected marker is **in the document** (spec 222), which is the
    // only reading worth publishing: every rule about selecting and editing one
    // is asserted in Node and none of them can say whether a click reached any
    // of it. Read off the store rather than off the settings for the reason
    // `data-ground`'s `meshed` is counted off the scene graph -- a panel that
    // believes it edited something and wrote nothing has to read as unedited.
    readout.dataset.selected = selectedReadout();
    readout.innerHTML =
      `at <b>${Math.round(c.target.x)}, ${Math.round(c.target.z)}</b> &middot; ` +
      `span <b>${Math.round(c.halfWidth)}</b> &middot; ` +
      `pitch <b>${Math.round((c.elevation * 180) / Math.PI)}&deg;</b><br>` +
      `<span style="color:#7a7a90;">${editing}` +
      `${editsSinceDisk === 0 ? '' : ` <b style="color:#e0c07a;">${editsSinceDisk} edit${editsSinceDisk === 1 ? '' : 's'} not in maps/</b>`}` +
      ` &middot; ${chunkCount()} chunks &middot; ` +
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
      // A stroke interrupted by a tab switch still closes its undo entry, and a
      // building half-dragged when the tab went away is given up on rather than
      // resumed against an anchor from a session ago.
      structureAnchor = null;
      structureGhost.hide();
      history.endStroke();
    },
  };
}
