/**
 * The isometric world, drawn from a replicated client view (spec 063).
 *
 * The descendant of `IsoScene`, which spec 062 deleted along with the card game
 * it framed. Most of what it does is unchanged and deliberately so -- the
 * terrain mesh, the instanced prop field, the hard single-sun shadows, the
 * retro dither pass, the trailing camera and the player's torch are six specs of
 * look that were never about the card economy.
 *
 * What changed is where the world comes from, and it changed in both directions:
 *
 *  - The old scene **built** the world and handed the colliders to the sim
 *    afterwards. This one is handed a `BuiltWorld` that the server is already
 *    running (spec 063), so the trees on screen are the trees being collided
 *    against rather than a second scatter that happens to match.
 *  - The old scene read a `CombatState` -- a live sim object in the same tab.
 *    This one reads a `ClientView`: entities as the wire described them, three
 *    ticks apart, smoothed by `EntityMotion`.
 *
 * There is no game logic in here. Nothing it computes is sent anywhere; every
 * branch decides what a mesh looks like, and the server is not listening.
 */

import * as THREE from 'three';
import type { Vec2 } from '../../../sim/types.js';
import type { StreamedMap } from '../../../server/client/streamed-map.js';
import type { TerrainChunk } from '../../../terrain/chunk.js';
import type { ClientView } from '../../../server/client/game-client.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { abilityById } from '../../../server/data/abilities.js';
import { PALETTE } from '../palette.js';
import { castsShadows, makeMoveMarker, makeUnwalkableField, makeWall } from '../meshes.js';
import { ARENA_OBSTACLES } from '../../../sim/constants.js';
import { vegetationColliders } from '../../../terrain/vegetation.js';
import { buildTerrainMeshFromChunks, type TerrainMeshHandle } from '../terrain-mesh.js';
import { buildPropField, FLAT_SHADING, type PropFieldHandle, type PropShading } from '../props.js';
import { type HikeSettings } from '../hike.js';
import { CURVATURE_UNIFORMS } from '../terrain-curvature.js';
import { installPoissonShadows, shadowRadiusFor } from '../shadow-pcf.js';
import { DETAIL_UNIFORMS, buildDetailTexture } from '../terrain-detail.js';
import { MechRig, Poofs } from '../rigs.js';
import { CritterRig, defaultCritterTuning } from '../critter.js';
import { CRITTERS } from '../../critters/index.js';
import { attachHighlight, type HighlightHandle } from '../highlight.js';
import { pickHoveredUnit, type HoverTarget } from '../hover.js';
import { createViewControls, type ViewControls } from '../view-controls.js';
import {
  CAMERA_FAR,
  CAMERA_NEAR,
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_VIEW_HALF_WIDTH,
  followAlpha,
  offsetToOrbit,
  orbitToOffset,
} from '../view-settings.js';
import {
  cameraFrustum,
  cursorToNdc,
  internalRenderSize,
  pixelFrame,
  snapToPixelGrid,
  worldPerPixel,
  type PixelFrame,
} from '../view-frame.js';
import {
  horizonShadow,
  shadowFillBoost,
  shadowFrame,
  shadowFrameStale,
  SHADOW_MAP_SIZE,
  type HorizonShadow,
} from '../shadow.js';
import { RetroPass } from '../retro-pass.js';
import { HikeBuffers } from '../hike-buffers.js';
import { HikeEdges } from '../hike-edges.js';
import { advanceWind } from '../wind-uniforms.js';
import { FIXED_DAYLIGHT } from '../daynight.js';
import {
  MAGIC_COLOR,
  MAX_LIGHT_RANGE,
  TORCH_ANCHOR,
  TORCH_COLOR,
  TORCH_DEFAULTS,
  orbState,
  pointIntensity,
  torchFlicker,
} from '../player-lights.js';
import { PlayerLighting } from '../player-lighting.js';
import { appearanceOf, PLAYER_CRITTER, PLAYER_FIGURE, type Appearance } from './appearance.js';
import { UnitRig } from '../unit-rig.js';
import { UnitMachine } from '../../../units/machine.js';
import { authoredUnitFor } from './unit-catalog.js';
import { authoredUnitAssets } from './unit-assets.js';
import { advanceSpeed, driveUnit, slewSpeed, STOPPED, type SpeedClock, type UnitFacts } from './unit-driver.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { drawnPixels, mixerCadence, shouldApply } from './unit-lod.js';
import { DEFAULT_CANONICAL_HEIGHT } from '../../../units/canonical-height.js';
import { ShotRig } from './shot.js';
import type { AimShape } from './aim.js';
import { castBar } from './cast.js';
import { EntityMotion } from './interpolate.js';
import type { WorldAnchor } from './damage-popup.js';

/** One sim tick, in seconds -- the clock an authored unit's speed is on. */
const TICK_SECONDS = 1 / SERVER_TICK_RATE;

/** Fraction of the gap to the target framing closed each frame (spec 034). */
const CAMERA_SMOOTH = 0.15;

const TORCH_SHADOW_MAP_SIZE = 512;
const TORCH_SHADOW_NEAR = 8;
const TORCH_SHADOW_NORMAL_BIAS = 2.5;
/** The ring under a ground-targeted cast. Warm red: it is about to hurt. */
const TELEGRAPH_COLOR = 0xff785a;
/** The ring under the body being attacked (spec 070). */
const TARGET_RING_COLOR = 0xff6a5a;
/**
 * The skill being aimed (spec 080). Deliberately not either red above: what a
 * click *would* do and what is already being hit must never be the same mark.
 */
const AIM_COLOR = 0x7fd4ff;

/**
 * Where the middle of a body is, as a fraction of the height its health bar
 * hangs at (spec 118). A little under half, because the bar clears the head.
 */
const BODY_MIDDLE = 0.45;

const FLAME_RADIUS = 5;
const ORB_RADIUS = 7;

/** What the view hands the scene each frame. All presentation, no state. */
export interface FrameInfo {
  /** Real seconds since the last frame, for animation. */
  readonly dt: number;
  /**
   * Whole 60Hz sim steps the frame's accumulator drained (spec 111).
   *
   * What an authored unit's state machine advances by, and the reason `dt` is
   * not: a machine stepped by a frame delta fires its events at whatever rate
   * the browser happens to be painting, so a hit lands on a different frame of
   * the swing at 30fps than at 144. Usually 1, zero on a frame that arrived
   * early, and up to the catch-up cap after a pause.
   *
   * The procedural rigs keep reading `dt`. They are frame-rate toys with no
   * events in them and always were.
   */
  readonly ticks: number;
  /** How far through the current delta interval this frame is, in [0, 1]. */
  readonly alpha: number;
  /**
   * The sim tick to read cast bars against, fractional. Interpolated the same
   * way positions are, so a wind-up fills smoothly rather than in 20Hz steps.
   */
  readonly tick: number;
  /**
   * The local player's predicted heading (spec 064). Drawn instead of the
   * replicated one for the same reason its position is: facing arrives at 20Hz,
   * and a turn the player is making themselves must not lag by an interval.
   */
  readonly selfFacing: number;
  /** The standing move order to mark on the ground, or null (spec 064). */
  readonly destination: { readonly x: number; readonly y: number } | null;
  /**
   * Where the mouse is inside the canvas, in CSS pixels, or null when it has
   * left. Drives the hover highlight (spec 070) and nothing else -- the pick is
   * redone per frame because bodies move under a cursor that is standing still.
   */
  readonly cursor: { readonly x: number; readonly y: number } | null;
  /** The entity being attacked, so it can be ringed. */
  readonly targetEntityId: number | null;
  /**
   * The skill being aimed, or the one whose order is still walking into range
   * (spec 080), or null. Everything about it was decided in `aim.ts`; this is
   * the picture of that decision and nothing else.
   */
  readonly aim: AimIndicator | null;
}

/** What to draw for a pending or standing aim (spec 080). */
export interface AimIndicator {
  readonly shape: AimShape;
  /** The caster, which a cone and a lane both run from. */
  readonly origin: Vec2;
  /** The aimed ground point: the cursor while aiming, the placement once ordered. */
  readonly point: Vec2;
  /** The body under the cursor, or the ordered mark, for an aim that names one. */
  readonly unitId: number | null;
  readonly range: number;
  /** False when the placement is out of range, so the picture says "you will walk". */
  readonly inRange: boolean;
}

/**
 * An authored unit standing in the world (spec 111).
 *
 * The machine and the rig are one per body rather than one per unit type: two
 * grunts mid-swing are at different points in the same clip, and a shared
 * machine would put them in lockstep.
 */
interface DrivenUnit {
  readonly rig: UnitRig;
  readonly machine: UnitMachine;
  /** Last tick's facts, so a cast's first tick can be told from its fifth. */
  previous: UnitFacts | null;
  /** Last drawn position, for the speed the blend tree reads. */
  previousPosition: { x: number; y: number } | null;
  /** That speed, kept on the sim's clock rather than the browser's (spec 118). */
  speed: SpeedClock;
  /**
   * The same speed, slewed, which is what the blend tree is actually handed
   * (spec 119).
   *
   * The measured one steps -- the sim has no acceleration -- and a blend tree
   * is a pure function of its parameter, so a step in it is a cut no transition
   * duration can soften.
   */
  blendSpeed: number;
  /**
   * Bone count, read once when the mesh lands.
   *
   * Cached rather than measured on demand: `stats()` walks the whole model, and
   * the only caller is a per-frame debug readout. A number that cannot change
   * after load has no business being recomputed sixty times a second.
   */
  bones: number;
}

/** A body on screen, pooled by entity id. */
interface Body {
  readonly group: THREE.Group;
  readonly kind: 'player' | 'monster' | 'projectile';
  readonly player?: CritterRig;
  readonly mech?: MechRig;
  readonly unit?: DrivenUnit;
  readonly shot?: ShotRig;
  readonly highlight?: HighlightHandle;
  /**
   * World units above the feet to hang the health bar.
   *
   * Not readonly, because an authored unit's height is not known until its mesh
   * has been fetched and skinned -- and until it is measured the bar hangs at a
   * shared default that cut straight through the pig's head.
   */
  headroom: number;
}

/**
 * Where a health bar floats, for a body whose height nothing else knows.
 *
 * Tuned against the mech rigs, which is every monster and the projectiles that
 * never show one anyway. The player is taller than this and asks for its own
 * (spec 081) -- a shared constant was fine while the player was a knee-high
 * bird, and put the bar straight across the cow's face the moment it was not.
 */
export const DEFAULT_HEADROOM = 46;

/** Clearance between the top of a critter's head and the bar hanging over it. */
const HEADROOM_GAP = 12;

/**
 * The sphere a body is culled by for the skinning skip (spec 111).
 *
 * Generous rather than tight. Getting this wrong in the small direction pops a
 * pose at the edge of the screen, which is exactly where the eye is; getting it
 * wrong in the large direction costs one mixer update for a body that turned out
 * not to be visible, which costs nothing anybody can perceive.
 */
const FRUSTUM_BODY_RADIUS = 90;

// Reused across every body every frame. Allocating a Frustum and three vectors
// per unit per frame is forty throwaway objects a frame in a fight, which is a
// garbage collector pause with a schedule.
const SCRATCH_FRUSTUM = new THREE.Frustum();
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_SPHERE = new THREE.Sphere();
const SCRATCH_WORLD = new THREE.Vector3();

/** A blast that has landed and is fading out. Presentation only. */
interface LiveEffect {
  readonly mesh: THREE.Mesh;
  age: number;
  readonly ttl: number;
}

/** Where a body is on screen, so the DOM HUD can hang a bar over it. */
export interface ScreenAnchor {
  readonly id: number;
  /** CSS pixels within the canvas box. */
  readonly x: number;
  readonly y: number;
  /** True when it is in front of the camera and inside the frame. */
  readonly onScreen: boolean;
}

export class WorldScene {
  readonly controls: ViewControls;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly retro = new RetroPass(1, 1);
  /**
   * Depth and view-space normals at the virtual resolution (spec 100). Built lazily,
   * because until the switch is thrown it would be a render target nothing reads.
   */
  private buffers: HikeBuffers | null = null;
  /** The outline pass (spec 101). Built with the buffers it reads. */
  private edges: HikeEdges | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly sun = new THREE.DirectionalLight(
    FIXED_DAYLIGHT.lightColor,
    FIXED_DAYLIGHT.lightIntensity,
  );
  private readonly ambient = new THREE.AmbientLight(
    FIXED_DAYLIGHT.ambientColor,
    FIXED_DAYLIGHT.ambientIntensity,
  );
  private readonly background = new THREE.Color(PALETTE.sky);
  private readonly torch = new THREE.PointLight(TORCH_COLOR, 0, TORCH_DEFAULTS.range);
  private readonly torchFlame: THREE.Mesh;
  private readonly orb = new THREE.PointLight(MAGIC_COLOR, 0, 0);
  private readonly orbMesh: THREE.Mesh;
  /** The rig currently carrying the torch, so re-parenting happens once. */
  private torchHost: THREE.Object3D | null = null;
  /**
   * The local player, lit by the lights they carry from farther off than they
   * really are (spec 118).
   *
   * Attached to the same rig the torch is hung off, and for the same reason it
   * is re-checked every frame: a respawn is a new entity and therefore a new
   * body.
   */
  private readonly playerLighting = new PlayerLighting();
  /** Scratch for the body anchor, so a frame of lit walking allocates nothing. */
  private readonly lightAnchor = new THREE.Vector3();
  private readonly unwalkable = new THREE.Group();

  /**
   * Null until `MapInfo` arrives (spec 072). Kept null rather than filled with
   * an empty stand-in so that "no map yet" is one check here instead of an
   * `if` in every caller -- and so `ground()` can answer 0 for a world that has
   * genuinely not been described yet.
   */
  private map: StreamedMap | null = null;
  private terrainMesh: TerrainMeshHandle | null = null;
  private propField: PropFieldHandle | null = null;
  private readonly poofs: Poofs;
  /** Marks the standing move order on the ground (spec 064). */
  private readonly moveMarker = makeMoveMarker();

  private readonly motion = new EntityMotion();
  private readonly bodies = new Map<number, Body>();
  private readonly telegraphs = new Map<number, THREE.Mesh>();
  /** Units the cursor may pick this frame, rebuilt as bodies are placed. */
  private readonly hoverTargets: HoverTarget[] = [];
  /**
   * Cast phase by entity id, refreshed each frame (spec 111).
   *
   * An authored unit starts its swing on the tick the wire says a cast began,
   * and the phase is how "began" is told from "is still going" -- see
   * `startedCasting`. Rebuilt rather than accumulated so a cast that ended
   * leaves no entry behind to be read as a swing that never finished.
   */
  private readonly castPhases = new Map<number, number>();
  private hovered: number | null = null;
  /** The ring under the body being attacked (spec 070). */
  private readonly targetRing: THREE.Mesh;
  /**
   * The aim indicator (spec 080): the shape of the blow, the range ring that
   * says the confirm will be a walk, and the ring under a named body.
   *
   * Four meshes built once and re-pointed, rather than geometry rebuilt per
   * frame -- the cursor moves every frame, and a `CircleGeometry` allocated at
   * 60Hz for as long as somebody is deciding is a garbage-collection pause
   * during the one moment the player is looking closely.
   */
  private readonly aimShapeMesh: THREE.Mesh;
  private readonly aimRangeRing: THREE.Mesh;
  private readonly aimUnitRing: THREE.Mesh;
  /** The shape currently baked into `aimShapeMesh`, so it is rebuilt only on a change. */
  private aimShapeKey = '';
  private readonly effects: LiveEffect[] = [];
  private readonly anchors: ScreenAnchor[] = [];

  private readonly camOffsetCurrent = new THREE.Vector3(
    DEFAULT_CAMERA_OFFSET.x,
    DEFAULT_CAMERA_OFFSET.y,
    DEFAULT_CAMERA_OFFSET.z,
  );
  private readonly camOffsetTarget = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private targetPlaced = false;
  private halfWidth = DEFAULT_VIEW_HALF_WIDTH;
  private lastHalfWidth = -1;
  private shadowHalfWidth = -1;
  private readonly sunDirection = new THREE.Vector3();

  private renderW = 0;
  private renderH = 0;
  private aspect = 1;
  private elapsed = 0;
  /**
   * How the fixed virtual buffer is being shown, or null while the view is drawn
   * the pre-spec-099 way (spec 099).
   */
  private frame: PixelFrame | null = null;
  /** Scratch for the pixel snap, so a per-frame snap allocates nothing. */
  private readonly snapRight = new THREE.Vector3();
  private readonly snapUp = new THREE.Vector3();
  private readonly snapForward = new THREE.Vector3();
  private readonly snapBefore = new THREE.Vector3();

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();
  private readonly terrainHits: THREE.Intersection[] = [];
  private readonly projected = new THREE.Vector3();

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.display = 'block';

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(1);
    // Hard, unfiltered shadows (spec 045): one depth comparison per pixel, so an
    // edge is a step rather than a gradient -- the only kind that belongs in a
    // posterized frame.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.scene.background = this.background;

    const frustum = cameraFrustum(DEFAULT_VIEW_HALF_WIDTH, 1);
    this.camera = new THREE.OrthographicCamera(
      -frustum.halfWidth,
      frustum.halfWidth,
      frustum.halfHeight,
      -frustum.halfHeight,
      CAMERA_NEAR,
      CAMERA_FAR,
    );

    // Before the first resize, and it has to stay there: since spec 099 `resize`
    // asks the panel whether the frame is drawn at a fixed virtual resolution, so
    // a panel built afterwards is a panel that does not exist the first time it
    // is read. Nothing here depends on the scene, so this is only an ordering
    // requirement, not a design one -- but it is a real one, and it took a
    // browser to notice: no unit test constructs a WorldScene, because it needs
    // a canvas.
    this.controls = createViewControls();
    this.controls.attachWheelZoom(canvas);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.resize();

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    // Before any material compiles: the filter lives in three's own shadow chunk,
    // and a chunk edited after a program is built does not reach that program.
    installPoissonShadows();
    this.sun.shadow.radius = 0;
    this.scene.add(this.sun, this.sun.target, this.ambient);

    // No terrain yet. The ground and the trees are the ones the server *sent*
    // (spec 072), and nothing has been sent until `MapInfo` lands -- which is a
    // frame or two after this, even over a loopback. `setMap` builds them.
    this.scene.add(this.unwalkable);
    this.addWalls();

    this.torchFlame = this.buildTorch();
    this.orbMesh = this.buildOrb();
    this.poofs = new Poofs(this.scene);
    this.moveMarker.visible = false;
    this.scene.add(this.moveMarker);

    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(22, 27, 24),
      new THREE.MeshBasicMaterial({
        color: TARGET_RING_COLOR,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.visible = false;
    this.scene.add(this.targetRing);

    // The aim (spec 080). Flat, unlit and never depth-writing, exactly like the
    // ground telegraph and the blast effects it sits among.
    this.aimShapeMesh = new THREE.Mesh(
      new THREE.CircleGeometry(1, 28),
      new THREE.MeshBasicMaterial({
        color: AIM_COLOR,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.aimShapeMesh.rotation.x = -Math.PI / 2;
    this.aimShapeMesh.visible = false;
    this.scene.add(this.aimShapeMesh);

    this.aimRangeRing = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1, 48),
      new THREE.MeshBasicMaterial({
        color: AIM_COLOR,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.aimRangeRing.rotation.x = -Math.PI / 2;
    this.aimRangeRing.visible = false;
    this.scene.add(this.aimRangeRing);

    this.aimUnitRing = new THREE.Mesh(
      new THREE.RingGeometry(22, 27, 24),
      new THREE.MeshBasicMaterial({
        color: AIM_COLOR,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.aimUnitRing.rotation.x = -Math.PI / 2;
    this.aimUnitRing.visible = false;
    this.scene.add(this.aimUnitRing);
  }

  /**
   * Adopt the streamed map, once the server has said what it is.
   *
   * Builds the empty mesh and prop field the arrivals are patched into. Called
   * once per session; a second call would mean the map changed underneath,
   * which the client refuses at the cache instead.
   */
  setMap(map: StreamedMap): void {
    this.map = map;
    this.terrainMesh = buildTerrainMeshFromChunks(map.meshLayers, []);
    this.scene.add(this.terrainMesh.group);
    this.propField = buildPropField([], (x, z) => this.ground(x, z), undefined, this.propShading);
    this.scene.add(this.propField.group);
  }

  /**
   * How the prop field is shaded (spec 097, step 2), as the panel last asked
   * for it.
   *
   * Held rather than read at build time because it is baked into the geometry's
   * normals and into each batch's material: changing it means rebuilding the
   * field, so the frame has to notice the change rather than pick it up on the
   * next rebuild that happens for some other reason.
   */
  private propShading: PropShading = FLAT_SHADING;

  /**
   * Adopt the panel's shading settings, rebuilding the prop field if they moved
   * (spec 097, step 2).
   *
   * Compared rather than applied every frame, because applying means rebuilding
   * every batch in the world -- a few hundred milliseconds. So this costs three
   * comparisons per frame and does the work only on the frame a switch is
   * actually thrown.
   */
  private applyPropShading(hike: HikeSettings): void {
    const wanted: PropShading = {
      smooth: hike.smoothNormals,
      creaseAngle: hike.creaseAngle,
      swayNormals: hike.swayNormals,
    };
    const current = this.propShading;
    if (
      wanted.smooth === current.smooth &&
      wanted.creaseAngle === current.creaseAngle &&
      wanted.swayNormals === current.swayNormals
    ) {
      return;
    }
    this.propShading = wanted;
    this.refreshProps();
  }

  /**
   * Hand the ground materials the crease settings (spec 104).
   *
   * A uniform write, every frame, costing nothing: the measure itself was baked
   * into a vertex attribute when the chunk was meshed. That is the whole reason
   * it is carried in its own channel rather than folded into the vertex colours
   * -- toggling it would otherwise mean re-meshing every chunk in the world.
   */
  private applyCurvature(hike: HikeSettings): void {
    CURVATURE_UNIFORMS.uCavityStrength.value = hike.curvature ? hike.curvatureStrength : 0;
    // The debug view draws what was baked at full scale, which is a different
    // question from what is currently applied -- and it stands on its own rather
    // than needing the feature switched on to be looked at.
    CURVATURE_UNIFORMS.uCavityOnly.value = hike.debug === 'curvature' ? 1 : 0;
  }

  /**
   * Hand the ground materials the surface-detail settings (spec 106).
   *
   * Uniform writes, like the creases: the tile is generated once at startup and
   * nothing here rebuilds geometry or recompiles a shader. The texture is built
   * lazily, so a session that never throws the switch never spends the 64KB or
   * the mipmap chain on it.
   */
  private applyDetail(hike: HikeSettings): void {
    const wanted = hike.triplanar || hike.materialBlend;
    if (wanted && !DETAIL_UNIFORMS.uDetailMap.value) {
      // The driver's maximum, which is what makes the ground readable at the
      // 27-degree grazing angle this camera looks along.
      DETAIL_UNIFORMS.uDetailMap.value = buildDetailTexture(
        this.renderer.capabilities.getMaxAnisotropy(),
      );
    }
    DETAIL_UNIFORMS.uDetailStrength.value = hike.triplanar ? hike.detailStrength : 0;
    DETAIL_UNIFORMS.uDetailScale.value = 1 / Math.max(1, hike.detailScale);
    DETAIL_UNIFORMS.uDetailSharpness.value = Math.max(1, hike.detailSharpness);
    DETAIL_UNIFORMS.uBlendStrength.value = hike.materialBlend ? hike.blendStrength : 0;
    DETAIL_UNIFORMS.uBlendNoise.value = hike.blendNoise;
  }

  /** Ground height, or 0 before there is any ground to ask about. */
  private ground(x: number, z: number): number {
    return this.map?.world.heightAt(x, z) ?? 0;
  }

  /**
   * Mesh one chunk that has just arrived (spec 072).
   *
   * `rebuild` is the seam spec 050 cut for the editor's brush -- replace one
   * chunk's geometry, dispose what it replaced, leave the rest alone. A brush
   * stroke and a streamed chunk want exactly the same thing, so this is not a
   * second meshing path; it is the one that already existed.
   */
  addTerrainChunk(chunk: TerrainChunk): void {
    this.terrainMesh?.rebuild(chunk);
  }

  /**
   * Rebuild the instanced prop field from everything held.
   *
   * Deliberately *not* per chunk. One instanced mesh per species over the whole
   * map is a handful of draw calls; one per chunk would be 56 times that, every
   * frame, forever -- trading a startup cost for a permanent one. So the caller
   * calls this when the chunk stream goes quiet, which costs one pass over
   * ~1150 props, the same single pass the pre-streaming build did.
   */
  refreshProps(): void {
    if (!this.map || !this.propField) return;
    const props = this.map.props();
    const heightAt = (x: number, z: number): number => this.ground(x, z);

    this.scene.remove(this.propField.group);
    this.propField.dispose();
    this.propField = buildPropField(props, heightAt, undefined, this.propShading);
    this.scene.add(this.propField.group);

    this.unwalkable.clear();
    this.unwalkable.add(makeUnwalkableField(vegetationColliders(props), heightAt));
  }

  /**
   * Raycast a canvas pixel onto the ground. Against the terrain mesh itself, so
   * pointing at a hillside aims at the spot under the cursor rather than at
   * where the y=0 plane happens to be behind it.
   */
  screenToWorld(cssX: number, cssY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const point = cursorToNdc(cssX, cssY, rect.width || 1, rect.height || 1);
    this.raycaster.setFromCamera(this.ndc.set(point.x, point.y), this.camera);

    this.terrainHits.length = 0;
    // Before any chunk has landed there is nothing to hit, and the raycast
    // falls through to the y=0 plane below -- which is the right answer for a
    // world that has not been drawn yet.
    this.raycaster.intersectObjects(this.terrainMesh?.pickTargets ?? [], false, this.terrainHits);
    const ground = this.terrainHits[0];
    const hit = ground ? ground.point : this.raycaster.ray.intersectPlane(this.groundPlane, this.hit);
    return hit ? { x: hit.x, y: hit.z } : { x: this.target.x, y: this.target.z };
  }

  /**
   * The unit at a canvas pixel, or null for empty ground (spec 070).
   *
   * Asked afresh when a click arrives rather than answered from the last
   * frame's hover. The two are the same answer for a cursor that has been
   * sitting still, and different in the case that matters: a click that arrives
   * in the same task as the `mousemove` that positioned it -- a synthetic one,
   * a tap, a fast flick -- has had no frame in between, so the remembered hover
   * is a frame old at best and null at worst. It picked nothing at all the
   * first time a preview run tried to right-click a monster.
   */
  pickUnitAt(cssX: number, cssY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const point = cursorToNdc(cssX, cssY, rect.width || 1, rect.height || 1);
    this.raycaster.setFromCamera(this.ndc.set(point.x, point.y), this.camera);
    return pickHoveredUnit(this.raycaster, this.hoverTargets, this.screenToWorld(cssX, cssY));
  }

  /** Where the bodies drawn last frame are on screen, for the DOM overlay. */
  screenAnchors(): readonly ScreenAnchor[] {
    return this.anchors;
  }

  /**
   * Where a body is standing and how far over its head a number hangs, in the
   * world (spec 096).
   *
   * The point a damage number is nailed to, read once when the blow lands. Two
   * details make it the right one to read. It is the *drawn* position -- the
   * interpolated pose the player is actually looking at, not the replica's
   * three-ticks-ago one -- so the number lands on the body rather than behind
   * it. And a `CombatResult` is delivered while the frame that killed the
   * victim is still the last frame drawn, so the body is still pooled here: a
   * killing blow gets the ground the victim fell on, which is the case the old
   * entity-id anchor could not answer at all.
   */
  bodyAnchor(id: number): WorldAnchor | null {
    const body = this.bodies.get(id);
    if (!body) return null;
    return { x: body.group.position.x, y: body.group.position.z, lift: body.headroom };
  }

  /**
   * Project a world point to a canvas pixel, the way {@link collectAnchors}
   * does for a body (spec 076).
   *
   * The overlay is DOM for the same reason the health bars are: text through
   * the low-res buffer and the dither pass comes out as chewed pixels, and a
   * countdown is a number you are meant to read.
   */
  projectPoint(x: number, y: number, lift = 30): { x: number; y: number; onScreen: boolean } {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.projected.set(x, this.ground(x, y) + lift, y);
    this.projected.project(this.camera);
    const px = (this.projected.x * 0.5 + 0.5) * width;
    const py = (-this.projected.y * 0.5 + 0.5) * height;
    return {
      x: px,
      y: py,
      onScreen: this.projected.z < 1 && px >= -80 && px <= width + 80 && py >= -80 && py <= height + 80,
    };
  }

  /** A blast landed. Purely something to look at; the damage already happened. */
  addEffect(x: number, y: number, radius: number, durationTicks: number): void {
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(Math.max(4, radius), 24),
      new THREE.MeshBasicMaterial({
        color: PALETTE.torchCore,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, this.ground(x, y) + 1.5, y);
    this.scene.add(mesh);
    this.effects.push({ mesh, age: 0, ttl: Math.max(6, durationTicks) });
  }

  render(view: ClientView, frame: FrameInfo): void {
    this.resize();
    const dt = Math.min(0.05, Math.max(0, frame.dt));
    this.elapsed += dt;
    this.controls.advanceClock(dt);
    // The entire per-frame cost of the wind (spec 074): one float, shared by
    // every tree, every tree shadow, every chunk of ground and every quad of
    // sea. Nothing else about either feature is touched between frames.
    advanceWind(dt);

    this.observe(view);
    this.syncBodies(view, frame, dt);
    this.carryTorch(view.selfEntityId);

    // Where the last right-click landed. A move order you cannot see is an
    // order you cannot tell from a missed click.
    this.moveMarker.visible = frame.destination !== null;
    if (frame.destination) {
      const { x, y } = frame.destination;
      this.moveMarker.position.set(x, this.ground(x, y) + 6, y);
    }
    this.syncTelegraphs(view, frame);
    this.ageEffects();
    this.poofs.update(dt);

    // The camera follows the *predicted* self, not an interpolated replica: the
    // one body that must never lag its own input is this one.
    const me = view.self ?? { x: this.target.x, y: this.target.z };
    const groundY = this.ground(me.x, me.y);
    this.followSelf(me, groundY, dt);
    this.applyControls();
    this.applyPlayerLights(me, groundY);
    this.camera.lookAt(this.target);

    this.camera.updateMatrixWorld();
    this.scene.updateMatrixWorld();
    // Needs both of the above: it reads the rig's world position and pushes it
    // through the camera's inverse (spec 118).
    this.anchorPlayerLighting(view.selfEntityId);
    // Before the snap, because this is a pick: which body is under the cursor is
    // answered against the same unsnapped camera every other pick uses. After
    // the matrices are fresh, though -- a pick made against last frame's camera
    // lags the highlight behind a moving view by a frame.
    //
    // `collectAnchors` used to sit here beside it and has moved below the snap:
    // an anchor has to agree with the *drawn* image, and a pick must not (spec
    // 095). They want opposite cameras, so they no longer travel together.
    this.syncHover(frame);

    const hike = this.controls.hike();
    this.applyPropShading(hike);
    this.applyCurvature(hike);
    // Written every frame, and written even when the feature is off: three's own
    // default for `radius` is 1, so leaving it alone would soften every shadow in
    // the world without anything having been switched on (spec 105).
    this.sun.shadow.radius = shadowRadiusFor(hike.softShadows, hike.shadowPcfRadius);
    this.applyDetail(hike);

    // Snapped for everything that has to agree with the drawn image: the frame
    // itself, and the screen anchors the DOM overlay hangs bars from. An anchor
    // computed off the unsnapped camera would jitter against the body it labels
    // by up to half a virtual pixel -- which at a 4x upscale is two CSS pixels
    // of health bar wobble, exactly the shimmer the snap exists to remove.
    const unsnap = this.applyPixelSnap(hike);
    this.collectAnchors();

    // Captured with the snapped camera, so the buffers line up with the frame
    // they will be composited over rather than being half a pixel out from it.
    const debugging = hike.debug === 'depth' || hike.debug === 'normals';
    // Outlines need the buffers they are found in, so asking for outlines asks
    // for the buffers. Two switches where one implies the other is a switch that
    // silently does nothing, which is worse than no switch at all.
    const wantsBuffers = hike.buffers || hike.edges || hike.ink;
    if (wantsBuffers) {
      const buffers = this.ensureBuffers();
      buffers.capture(this.renderer, this.scene, this.camera);
    }

    if (wantsBuffers && debugging) {
      // One buffer on its own, instead of the frame. The only way to look at a
      // depth texture at all: a depth attachment cannot be read back, so it has
      // to be sampled in a shader and written somewhere visible.
      this.ensureBuffers().blit(this.renderer, hike.debug === 'depth' ? 'depth' : 'normals');
    } else if (hike.edges && hike.debug === 'edges') {
      this.drawEdges(hike, true);
    } else {
      this.retro.set(this.controls.retro());
      this.retro.setGrade(this.controls.grade());
      this.retro.setPalette(hike.palette);
      // The distance treatment reads the same depth buffer the outlines do, so
      // it needs the buffers whether or not the outlines are on (spec 103). The
      // fog colour is the live sky rather than a setting: the day/night cycle
      // moves it, and a fixed haze under a sunset is a grey band on the horizon.
      this.retro.setInk(
        hike.ink ? this.ensureBuffers().depthTexture : null,
        this.camera.near,
        this.camera.far,
        this.inkOrigin(),
        this.background,
        hike.ink ? hike : null,
      );
      this.retro.render(this.renderer, this.scene, this.camera);
      // Over the finished frame, which is where a line belongs: the fills are
      // settled, so the outline is a constant dark value rather than something
      // the quantizer gets to round.
      if (hike.edges) this.drawEdges(hike, false);
    }
    unsnap?.();
  }

  dispose(): void {
    for (const body of this.bodies.values()) {
      this.scene.remove(body.group);
      if (body.shot?.trace) this.scene.remove(body.shot.trace);
      body.shot?.dispose();
    }
    this.bodies.clear();
    for (const effect of this.effects) this.scene.remove(effect.mesh);
    this.effects.length = 0;
    for (const mesh of this.telegraphs.values()) this.scene.remove(mesh);
    this.telegraphs.clear();
    this.terrainMesh?.dispose();
    this.propField?.dispose();
    this.buffers?.dispose();
    this.edges?.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.renderer.dispose();
  }

  /**
   * A lost context takes every GPU-side object with it, including the render
   * targets and the depth texture, and leaves three.js holding handles to things
   * that no longer exist (spec 100).
   *
   * Unhandled since spec 038 put the first render target on screen, and survivable
   * until now only because nothing read one back. Preventing the default is what
   * makes `webglcontextrestored` fire at all -- without it the browser never
   * offers a new context and the canvas stays blank for good.
   */
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
  };

  private readonly onContextRestored = (): void => {
    this.buffers?.recreate();
    // Re-measured from scratch: the swap chain is new, so the sizes three.js
    // thinks it set are not the sizes it has.
    this.renderW = 0;
    this.renderH = 0;
    this.frame = null;
    this.lastHalfWidth = -1;
    this.resize();
  };

  // --- world ------------------------------------------------------------

  private addWalls(): void {
    for (const rect of ARENA_OBSTACLES) {
      const wall = makeWall(rect.w, rect.h);
      wall.position.set(rect.x, this.lowestGroundIn(rect.x, rect.y, rect.w, rect.h), rect.y);
      castsShadows(wall);
      this.scene.add(wall);
    }
  }

  private lowestGroundIn(x: number, z: number, w: number, d: number): number {
    let low = Infinity;
    for (const [sx, sz] of [
      [x, z],
      [x + w, z],
      [x, z + d],
      [x + w, z + d],
      [x + w / 2, z + d / 2],
    ] as const) {
      low = Math.min(low, this.ground(sx, sz));
    }
    return low;
  }

  private buildTorch(): THREE.Mesh {
    this.torch.castShadow = true;
    this.torch.shadow.mapSize.set(TORCH_SHADOW_MAP_SIZE, TORCH_SHADOW_MAP_SIZE);
    this.torch.shadow.camera.near = TORCH_SHADOW_NEAR;
    this.torch.shadow.camera.far = MAX_LIGHT_RANGE;
    this.torch.shadow.normalBias = TORCH_SHADOW_NORMAL_BIAS;
    this.torch.position.set(TORCH_ANCHOR.x, TORCH_ANCHOR.y, TORCH_ANCHOR.z);
    this.scene.add(this.torch);

    // Unlit, so the flame stays the brightest thing in frame at midnight rather
    // than being shaded by the light it is emitting.
    const flame = new THREE.Mesh(
      new THREE.IcosahedronGeometry(FLAME_RADIUS, 0),
      new THREE.MeshBasicMaterial({ color: PALETTE.torchCore }),
    );
    this.scene.add(flame);
    return flame;
  }

  private buildOrb(): THREE.Mesh {
    this.orb.castShadow = false;
    this.scene.add(this.orb);
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(ORB_RADIUS, 0),
      new THREE.MeshBasicMaterial({ color: PALETTE.magicCore }),
    );
    this.scene.add(mesh);
    return mesh;
  }

  // --- bodies -----------------------------------------------------------

  /**
   * Feed the frame's replicated positions into the interpolator. Only on a new
   * tick: re-observing the same delta every frame would collapse the interval
   * being interpolated over and put the stutter straight back.
   */
  private observe(view: ClientView): void {
    for (const entity of view.entities) {
      this.motion.observe(entity.id, entity.x, entity.y, entity.z, entity.facing, view.tick);
    }
    this.motion.retain(new Set(view.entities.map((entity) => entity.id)));
  }

  private syncBodies(view: ClientView, frame: FrameInfo, dt: number): void {
    const live = new Set<number>();
    this.hoverTargets.length = 0;
    this.castPhases.clear();
    for (const cast of view.casts) this.castPhases.set(cast.entityId, cast.phase);

    for (const entity of view.entities) {
      live.add(entity.id);
      const look = appearanceOf(entity);
      const body = this.bodyFor(entity.id, look);
      const isSelf = entity.id === view.selfEntityId;

      // The local player is drawn at its prediction; everything else at its
      // smoothed replica. Interpolating our own body would add a frame of lag to
      // the one thing that must feel immediate.
      const pose = this.motion.sample(entity.id, frame.alpha);
      const x = isSelf && view.self ? view.self.x : (pose?.x ?? entity.x);
      const y = isSelf && view.self ? view.self.y : (pose?.y ?? entity.y);
      const facing = isSelf ? frame.selfFacing : (pose?.facing ?? entity.facing);

      const ground =
        entity.kind === EntityKind.Projectile
          ? (pose?.z ?? entity.z)
          : this.ground(x, y);

      body.group.position.set(x, ground, y);
      // A mesh built facing +x sits at world heading `theta` when yawed -theta.
      body.group.rotation.y = -facing;

      // Both rigs read their own gait out of the positions they are handed, so
      // neither needs the scene to remember where it drew them last frame.
      body.player?.update(dt, { x, y }, -facing);
      body.mech?.update(dt, { x, y }, -facing);
      if (body.unit) this.driveAuthoredUnit(body.unit, entity, { x, y }, frame);
      // Fed the *drawn* pose, so an arrow's nose follows the curve the eye is
      // following rather than the one the deltas describe (spec 087).
      body.shot?.update(dt, x, y, ground);

      // A corpse lies where it fell and stops animating, so a kill reads.
      const dead = entity.maxHealth > 0 && entity.health <= 0;
      body.group.scale.setScalar(dead ? 0.6 : 1);
      // Cleared here and turned back on by `syncHover`, so exactly one body is
      // ever lit however many frames ago the cursor last moved.
      body.highlight?.setHighlighted(false);

      // Only living units are pickable. A corpse is scenery, and a projectile
      // is a few pixels of geometry crossing the frame -- lighting either up is
      // a cursor that catches on things nothing can be done about.
      if (body.highlight && !dead) {
        this.hoverTargets.push({
          id: entity.id,
          object: body.group,
          position: { x, y },
          radius: look.radius,
          // The volume the cursor may pick the unit by (spec 095): its footprint
          // swept from the ground it is standing on to the top of its head. The
          // headroom was measured for the health bar and is the same number.
          base: ground,
          height: body.headroom,
        });
      }
    }

    for (const [id, body] of this.bodies) {
      if (live.has(id)) continue;
      this.scene.remove(body.group);
      if (body.shot?.trace) this.scene.remove(body.shot.trace);
      // A shot builds its own geometry and is gone within a second or two, so
      // this is a leak that would run at the rate of the fighting.
      body.shot?.dispose();
      this.bodies.delete(id);
    }
  }

  /**
   * Advances one authored unit's machine and, if it is worth it, its pose.
   *
   * The two halves are separate on purpose, and the separation is the LOD (spec
   * 111). The **machine** always steps: its events are authored on frame
   * indices, and one that skipped ticks would fire a footstep late, twice or
   * not at all. The **pose** is what costs -- sampling every track, writing
   * every bone, walking the skeleton's world matrices -- and a body four
   * screens away does not need one every tick, nor any at all when it is behind
   * the camera.
   *
   * Everything read here is either straight off the wire or something already
   * computed for drawing. Nothing an animation produced is read back, which is
   * the rule `unit-driver.ts` exists to make structural rather than careful.
   */
  private driveAuthoredUnit(
    unit: DrivenUnit,
    entity: ClientView['entities'][number],
    at: { readonly x: number; readonly y: number },
    frame: FrameInfo,
  ): void {
    const dead = entity.maxHealth > 0 && entity.health <= 0;
    // Distance on the frame clock, the quotient on the tick clock (spec 118).
    // A drawn position only moves when a tick drained, so dividing by the frame
    // delta reported a standing body on every frame that drained none -- which
    // above 60fps is most of them, and which the blend tree reads on all of them.
    unit.speed = advanceSpeed(
      unit.speed,
      unit.previousPosition === null ? 0 : Math.hypot(at.x - unit.previousPosition.x, at.y - unit.previousPosition.y),
      frame.ticks,
      TICK_SECONDS,
    );
    // Slewed, not assigned: a blend tree reads its parameter live, so a step in
    // it swaps the pose in one tick under a cross-fade that never sees it (spec
    // 119). This is the only input to the machine allowed to jump, so it is the
    // one that is bounded.
    unit.blendSpeed = slewSpeed(unit.blendSpeed, unit.speed.speed, frame.ticks, TICK_SECONDS);
    const facts: UnitFacts = {
      speed: unit.blendSpeed,
      activity: entity.activity,
      castPhase: this.castPhases.get(entity.id) ?? null,
      dead,
    };
    driveUnit(unit.machine, facts, unit.previous, frame.ticks);
    unit.previous = facts;
    unit.previousPosition = { x: at.x, y: at.y };

    // How big the body is *drawn*, never how far the camera is from it (spec
    // 118). This camera is orthographic and parks 6000 units back for near/far
    // clearance, so every unit in the game read as maximally distant and posed
    // at 15Hz -- the player in the centre of the screen included.
    const cadence = mixerCadence(
      drawnPixels(DEFAULT_CANONICAL_HEIGHT, this.camera.right - this.camera.left, this.renderW),
      this.inFrustum(unit.rig.object),
    );
    if (shouldApply(cadence, unit.machine.tick, entity.id)) unit.rig.applyPoses(unit.machine.poses());
  }

  /**
   * What the authored units are doing, for `preview-units.ts`.
   *
   * Everything else about spec 111 is checked in Node. What cannot be is the
   * half that only exists once a browser has fetched a `.glb`, decoded it,
   * built a skeleton and posed it -- and a mesh this repo writes by hand is
   * exactly the thing not to take on trust. This is the smallest readout that
   * distinguishes "loaded", "has the right skeleton" and "is being driven";
   * `view.ts` puts it on a data attribute and nothing in the game reads it.
   */
  authoredUnitReadout(): { readonly loaded: number; readonly bones: number; readonly states: string } {
    let loaded = 0;
    let bones = 0;
    const states: string[] = [];
    for (const body of this.bodies.values()) {
      if (!body.unit?.rig.loaded) continue;
      loaded += 1;
      bones = Math.max(bones, body.unit.bones);
      states.push(`${body.unit.machine.stateId}@${body.unit.machine.tick}`);
    }
    return { loaded, bones, states: states.sort().join(',') };
  }

  /** Whether a body is anywhere the camera can see, for the skinning skip. */
  private inFrustum(object: THREE.Object3D): boolean {
    SCRATCH_MATRIX.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    SCRATCH_FRUSTUM.setFromProjectionMatrix(SCRATCH_MATRIX);
    // A sphere rather than a point: a body whose feet are off the bottom of the
    // screen is still half on it, and popping its pose would be visible.
    SCRATCH_SPHERE.center.copy(object.getWorldPosition(SCRATCH_WORLD));
    SCRATCH_SPHERE.radius = FRUSTUM_BODY_RADIUS;
    return SCRATCH_FRUSTUM.intersectsSphere(SCRATCH_SPHERE);
  }

  /**
   * Brighten the unit under the cursor, and ring the one being attacked
   * (spec 070).
   *
   * `pickHoveredUnit` answers with the unit whose body the cursor is on or
   * whose ground it is standing on, and nothing looser (spec 095). Cosmetic in
   * the strict sense -- what it returns decides which rig is lit, and the *view*
   * decides whether a click acts on it.
   */
  private syncHover(frame: FrameInfo): void {
    const cursor = frame.cursor;
    this.hovered = cursor ? this.pickUnitAt(cursor.x, cursor.y) : null;

    if (this.hovered !== null) this.bodies.get(this.hovered)?.highlight?.setHighlighted(true);

    const target =
      frame.targetEntityId === null
        ? undefined
        : this.hoverTargets.find((candidate) => candidate.id === frame.targetEntityId);
    this.targetRing.visible = target !== undefined;
    if (target) {
      this.targetRing.position.set(
        target.position.x,
        this.ground(target.position.x, target.position.y) + 1.6,
        target.position.y,
      );
      // Sized to the body it is under, so a ravager's ring is not a grazer's.
      this.targetRing.scale.setScalar(Math.max(0.6, (target.radius + 8) / 27));
    }

    this.syncAim(frame);
  }

  /**
   * The aim indicator (spec 080): the shape of the blow the player is deciding
   * about, drawn before they are committed to it.
   *
   * Every number here came out of `aim.ts`, which read them off the ability
   * table. Nothing in this method decides anything -- if it did, it would be an
   * `if` in `src/render/` changing a game outcome, which is the one thing this
   * layer may not do.
   */
  private syncAim(frame: FrameInfo): void {
    const aim = frame.aim;
    if (!aim) {
      this.aimShapeMesh.visible = false;
      this.aimRangeRing.visible = false;
      this.aimUnitRing.visible = false;
      return;
    }

    // The ring under the body a click would pick, or the one already picked.
    const named =
      aim.unitId === null
        ? undefined
        : this.hoverTargets.find((candidate) => candidate.id === aim.unitId);
    this.aimUnitRing.visible = named !== undefined;
    if (named) {
      this.aimUnitRing.position.set(
        named.position.x,
        this.ground(named.position.x, named.position.y) + 1.7,
        named.position.y,
      );
      this.aimUnitRing.scale.setScalar(Math.max(0.6, (named.radius + 10) / 27));
    }

    // Out of range is the one thing the picture has to say that the shape
    // cannot: the confirm will be a walk before it is a blow.
    this.aimRangeRing.visible = !aim.inRange && aim.range > 0;
    if (this.aimRangeRing.visible) {
      this.aimRangeRing.position.set(aim.origin.x, this.ground(aim.origin.x, aim.origin.y) + 1.1, aim.origin.y);
      this.aimRangeRing.scale.setScalar(aim.range);
    }

    const shape = aim.shape;
    if (shape.kind === 'none') {
      this.aimShapeMesh.visible = false;
      return;
    }

    const dx = aim.point.x - aim.origin.x;
    const dy = aim.point.y - aim.origin.y;
    const heading = Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dy, dx) : 0;
    this.setAimShape(shape);
    this.aimShapeMesh.visible = true;
    // Dimmer out of range: the same shape, said less certainly.
    (this.aimShapeMesh.material as THREE.MeshBasicMaterial).opacity = aim.inRange ? 0.3 : 0.15;

    if (shape.kind === 'circle') {
      // A burst lands where it was placed; nothing about it points anywhere.
      this.aimShapeMesh.position.set(aim.point.x, this.ground(aim.point.x, aim.point.y) + 1.3, aim.point.y);
      this.aimShapeMesh.rotation.set(-Math.PI / 2, 0, 0);
      return;
    }

    // A cone and a lane both run from the caster toward the cursor. The mesh is
    // built pointing down +X in its own plane, so the third Euler term -- which
    // is the world Y spin once the mesh is laid flat -- is the heading, negated
    // because the flat rotation mirrors the sweep.
    this.aimShapeMesh.position.set(
      aim.origin.x,
      this.ground(aim.origin.x, aim.origin.y) + 1.3,
      aim.origin.y,
    );
    this.aimShapeMesh.rotation.set(-Math.PI / 2, 0, -heading);
  }

  /** Rebuild the aim geometry, but only when the shape it is drawing changed. */
  private setAimShape(shape: AimShape): void {
    const key = JSON.stringify(shape);
    if (key === this.aimShapeKey) return;
    this.aimShapeKey = key;
    this.aimShapeMesh.geometry.dispose();
    this.aimShapeMesh.geometry = buildAimGeometry(shape);
  }

  /** Hang the torch off the local player's rig; see {@link applyPlayerLights}. */
  private carryTorch(selfEntityId: number): void {
    const host = this.bodies.get(selfEntityId)?.group ?? null;
    // Every frame, not only on a change: the patch has to find meshes that were
    // not there when the body was made, since an authored unit's `.glb` lands
    // some frames after the group it goes in (spec 118).
    this.playerLighting.attach(host);
    if (host === this.torchHost) return;
    this.torchHost = host;
    // Before the first delta places us there is no rig to carry it; parking the
    // pair on the scene keeps them in the graph without lighting anything, since
    // both are hidden until the panel says otherwise.
    const parent = host ?? this.scene;
    parent.add(this.torch, this.torchFlame);
  }

  private bodyFor(id: number, appearance: Appearance): Body {
    const existing = this.bodies.get(id);
    if (existing) return existing;

    const { rig, typeId, radius, look } = appearance;
    let body: Body;

    // Tried before anything else, and for the player as well as a monster
    // (spec 111). The player is the body somebody looks at for hours, so it is
    // the one that has to prove the format -- and an entity with no row in the
    // table still falls through to exactly the rig it drew before.
    const authoredId = authoredUnitFor(appearance);
    const authoredUnit = authoredId === null ? null : authoredUnitAssets(authoredId);
    if (authoredUnit) {
      const group = new THREE.Group();
      const unitRig = new UnitRig();
      group.add(unitRig.object);
      const driven: DrivenUnit = {
        rig: unitRig,
        machine: new UnitMachine({ unit: authoredUnit.unit, clipLib: authoredUnit.clipLib }),
        previous: null,
        previousPosition: null,
        speed: STOPPED,
        blendSpeed: 0,
        bones: 0,
      };
      // Fire and forget: the group is in the scene from this frame and the mesh
      // appears in it whenever the fetch lands. Awaiting here would mean
      // `bodyFor` could not answer a frame that is already drawing.
      void unitRig.load(authoredUnit.assets, authoredUnit.unit.id).then(() => {
        castsShadows(group);
        driven.bones = unitRig.stats().bones;
        // Measured off the body that actually loaded rather than left at the
        // shared default. A generated unit stands at whatever its import scale
        // brings it to, and the default is a number picked for the procedural
        // mech rig -- on a taller body the health bar hangs inside the head.
        const height = unitRig.drawnHeight();
        if (height > 0) authoredBody.headroom = height + HEADROOM_GAP;
      });
      const authoredBody: Body = {
        group,
        kind: rig === 'player' ? 'player' : 'monster',
        unit: driven,
        highlight: attachHighlight(group),
        headroom: DEFAULT_HEADROOM,
      };
      this.scene.add(authoredBody.group);
      // `castsShadows` runs again once the mesh has actually loaded, above --
      // the group is empty at this point and there is nothing yet to cast one.
      this.bodies.set(id, authoredBody);
      return authoredBody;
    }

    if (rig === 'player') {
      // Every player gets its own tuning object rather than sharing one: the
      // panel that edits a figure lives in the sandbox, and a shared record here
      // would be one player's coat-picker session resizing the whole server.
      const species = CRITTERS[PLAYER_CRITTER];
      const player = new CritterRig(species, {
        tuning: { ...defaultCritterTuning(), ...PLAYER_FIGURE },
      });
      body = {
        group: player.group,
        kind: 'player',
        player,
        highlight: attachHighlight(player.group),
        // Read off the species rather than measured: the metrics are what the
        // skeleton is built from, so a taller animal moves its own bar.
        headroom:
          (species.metrics.headY + species.metrics.headRadius) * PLAYER_FIGURE.bodyScale +
          HEADROOM_GAP,
      };
    } else if (rig === 'projectile') {
      // The silhouette comes from the ability that threw it (spec 087), so a
      // thrown weapon reads as one in the air rather than as a bead of light.
      const shot = new ShotRig(look ?? 'orb', radius);
      // A shot never shows a bar, so its headroom is the shared default rather
      // than anything measured off the mesh.
      body = { group: shot.group, kind: 'projectile', shot, headroom: DEFAULT_HEADROOM };
    } else {
      // No authored unit for this type, so the procedural rig it has always
      // had. Additive on purpose: the roster moves over when there is a roster.
      const mech = new MechRig(typeId);
      body = {
        group: mech.group,
        kind: 'monster',
        mech,
        highlight: attachHighlight(mech.group),
        headroom: DEFAULT_HEADROOM,
      };
    }

    this.scene.add(body.group);
    // The streak is a record of where the shot has been, so it belongs to the
    // world rather than to the body that is laying it down (spec 087).
    if (body.shot?.trace) this.scene.add(body.shot.trace);
    // A projectile is unlit and moving; giving it a shadow caster costs a pass
    // over the scene for something a few pixels across.
    if (body.kind !== 'projectile') castsShadows(body.group);
    this.bodies.set(id, body);
    return body;
  }

  // --- telegraphs -------------------------------------------------------

  /**
   * The ring under a ground-targeted wind-up, filling as the cast commits.
   *
   * This is the readable half of spec 062's design in the 3D view: the ring says
   * where, and how much longer there is to move out of it. It is drawn from
   * `CastState` and the ability table, both of which came off the wire.
   */
  private syncTelegraphs(view: ClientView, frame: FrameInfo): void {
    const live = new Set<number>();

    for (const cast of view.casts) {
      const ability = abilityById(cast.abilityId);
      if (!ability?.radius || ability.kind !== 'ground') continue;
      live.add(cast.entityId);

      let mesh = this.telegraphs.get(cast.entityId);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CircleGeometry(ability.radius, 28),
          new THREE.MeshBasicMaterial({
            color: TELEGRAPH_COLOR,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        mesh.rotation.x = -Math.PI / 2;
        this.scene.add(mesh);
        this.telegraphs.set(cast.entityId, mesh);
      }

      const bar = castBar(cast, frame.tick, ability);
      mesh.position.set(
        cast.targetX,
        this.ground(cast.targetX, cast.targetY) + 1.2,
        cast.targetY,
      );
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = 0.14 + 0.4 * bar.progress;
    }

    for (const [id, mesh] of this.telegraphs) {
      if (live.has(id)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.telegraphs.delete(id);
    }
  }

  private ageEffects(): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      if (!effect) continue;
      effect.age += 1;
      const life = 1 - effect.age / effect.ttl;
      if (life <= 0) {
        this.scene.remove(effect.mesh);
        effect.mesh.geometry.dispose();
        this.effects.splice(i, 1);
        continue;
      }
      const material = effect.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = 0.4 * life;
      effect.mesh.scale.setScalar(1 + (1 - life) * 0.4);
    }
  }

  // --- camera, sun and lights -------------------------------------------

  private resize(): void {
    const hike = this.controls.hike();
    if (hike.lowRes) {
      this.resizeToVirtual(hike);
      return;
    }
    if (this.frame) this.releaseVirtual();

    const cssWidth = this.canvas.clientWidth || this.canvas.width || 1;
    const cssHeight = this.canvas.clientHeight || this.canvas.height || 1;
    const size = internalRenderSize(cssWidth, cssHeight);
    if (size.width === this.renderW && size.height === this.renderH) return;
    this.renderW = size.width;
    this.renderH = size.height;
    this.aspect = size.width / size.height;
    this.renderer.setSize(size.width, size.height, false);
    this.retro.setSize(size.width, size.height);
    this.lastHalfWidth = -1;
  }

  /**
   * Draw at a fixed virtual resolution and let CSS blow it up by a whole number
   * of device pixels, letterboxing what is left over (spec 099).
   *
   * There is no blit shader here on purpose. Sizing the canvas's backing store to
   * exactly the virtual buffer and giving it a CSS size of `scale` device pixels
   * per virtual pixel makes the browser's own upscale the integer one --
   * `image-rendering: pixelated` is defined as nearest-neighbour, and there is
   * nothing a quad of our own would do differently.
   *
   * It also buys the thing that would otherwise be the risky part of this change:
   * because the letterbox is the *canvas element's own box* rather than an inset
   * inside a full-bleed canvas, every cursor-to-world conversion in the renderer
   * keeps working untouched. They all derive NDC from `canvas.getBoundingClientRect()`,
   * which is now the letterboxed rect, so the offsets cancel without anybody
   * having to know they exist.
   *
   * The available box has to come from the *parent*, since the canvas is about to
   * stop filling it -- measuring the canvas would feed its own new size back in
   * and ratchet the scale down a step per frame.
   */
  private resizeToVirtual(hike: HikeSettings): void {
    const host = this.canvas.parentElement;
    const availWidth = (host?.clientWidth ?? this.canvas.clientWidth) || 1;
    const availHeight = (host?.clientHeight ?? this.canvas.clientHeight) || 1;
    const dpr = globalThis.devicePixelRatio || 1;
    const next = pixelFrame(availWidth, availHeight, dpr, hike.virtualWidth, hike.virtualHeight);
    const width = Math.max(1, Math.round(hike.virtualWidth));
    const height = Math.max(1, Math.round(hike.virtualHeight));

    const unchanged =
      this.frame !== null &&
      this.frame.scale === next.scale &&
      this.frame.cssWidth === next.cssWidth &&
      this.frame.cssHeight === next.cssHeight &&
      this.frame.offsetX === next.offsetX &&
      this.frame.offsetY === next.offsetY &&
      this.renderW === width &&
      this.renderH === height;
    if (unchanged) return;

    this.frame = next;
    this.renderW = width;
    this.renderH = height;
    // Fixed, and deliberately not the window's: a virtual resolution that took
    // the window's aspect would not be a fixed virtual resolution.
    this.aspect = width / height;
    this.renderer.setSize(width, height, false);
    this.retro.setSize(width, height);
    this.lastHalfWidth = -1;

    const style = this.canvas.style;
    style.inset = '';
    style.left = `${next.offsetX}px`;
    style.top = `${next.offsetY}px`;
    style.width = `${next.cssWidth}px`;
    style.height = `${next.cssHeight}px`;
  }

  /** Draw the outlines over the frame, or the edge mask on its own. */
  private drawEdges(hike: HikeSettings, maskOnly: boolean): void {
    const buffers = this.ensureBuffers();
    this.edges ??= new HikeEdges();
    this.edges.render(
      this.renderer,
      buffers.normalTexture,
      buffers.depthTexture,
      this.camera,
      this.renderW,
      this.renderH,
      hike,
      maskOnly,
      this.inkOrigin(),
    );
  }

  /**
   * The depth the distance treatment counts from: the camera's own distance to
   * what it is looking at.
   *
   * An orthographic camera parked 6,000 units back makes every pixel in the frame
   * about 6,000 units away, so a ramp measured from the camera is a ramp measured
   * from a constant. Measured from the focus, 0 is the ground under the player and
   * the settings are distances into the scene -- which is what they are named for,
   * and what survives the Distance slider moving the camera without moving the
   * world.
   */
  private inkOrigin(): number {
    return this.camOffsetCurrent.length();
  }

  /**
   * The depth/normal buffers, built on first use and kept at the render size.
   *
   * Lazily, so a session that never throws the switch never allocates a render
   * target and a depth texture it will not read.
   */
  private ensureBuffers(): HikeBuffers {
    const width = Math.max(1, this.renderW);
    const height = Math.max(1, this.renderH);
    if (!this.buffers) {
      this.buffers = new HikeBuffers(width, height);
    } else {
      this.buffers.setSize(width, height);
    }
    return this.buffers;
  }

  /** Give the canvas the whole box back, for a frame drawn the old way. */
  private releaseVirtual(): void {
    this.frame = null;
    const style = this.canvas.style;
    style.left = '';
    style.top = '';
    style.inset = '0';
    style.width = '100%';
    style.height = '100%';
    this.renderW = 0;
    this.renderH = 0;
  }

  /**
   * Where the drawn image sits inside the view, in CSS pixels.
   *
   * The DOM overlay has to be laid over *this* and not over the whole view, or
   * every health bar is displaced by the letterbox -- the anchors it positions
   * from are in canvas space.
   */
  viewport(): { x: number; y: number; width: number; height: number } {
    if (!this.frame) {
      return { x: 0, y: 0, width: this.canvas.clientWidth, height: this.canvas.clientHeight };
    }
    return {
      x: this.frame.offsetX,
      y: this.frame.offsetY,
      width: this.frame.cssWidth,
      height: this.frame.cssHeight,
    };
  }

  /**
   * Put the camera on the virtual pixel lattice for the draw, and hand back the
   * undo.
   *
   * Restored immediately afterwards because picking must not see it: a snapped
   * matrix answers "which cell is under the cursor" with up to a pixel of error,
   * and flips that error from one side to the other as the camera crosses a snap
   * boundary -- so a cell under a stationary cursor would change identity while
   * the player walks past. Everything the sim is told comes through those
   * conversions, which makes this the one place in the renderer where a rounding
   * choice could change an outcome.
   */
  private applyPixelSnap(hike: HikeSettings): (() => void) | null {
    if (!hike.snapCamera || this.renderW <= 0) return null;

    const step = worldPerPixel(this.camera.right - this.camera.left, this.renderW);
    this.camera.matrixWorld.extractBasis(this.snapRight, this.snapUp, this.snapForward);
    const snapped = snapToPixelGrid(this.camera.position, this.snapRight, this.snapUp, step);
    const before = this.snapBefore.copy(this.camera.position);
    if (snapped === this.camera.position) return null;

    this.camera.position.set(snapped.x, snapped.y, snapped.z);
    this.camera.updateMatrixWorld(true);
    return () => {
      this.camera.position.copy(before);
      this.camera.updateMatrixWorld(true);
    };
  }

  /**
   * Ease the look-at point toward the player rather than pinning it there (spec
   * 039), so they pull ahead of the frame as they set off and settle back when
   * they stop. The first frame snaps -- otherwise the view opens by gliding in
   * from wherever the camera happened to start.
   */
  private followSelf(position: Vec2, groundY: number, dt: number): void {
    if (!this.targetPlaced) {
      this.target.set(position.x, groundY, position.y);
      this.targetPlaced = true;
      return;
    }
    const alpha = followAlpha(dt, this.controls.followLagMs());
    this.target.x += (position.x - this.target.x) * alpha;
    this.target.y += (groundY - this.target.y) * alpha;
    this.target.z += (position.y - this.target.z) * alpha;
  }

  private applyControls(): void {
    const off = this.controls.cameraOffset();
    this.camOffsetTarget.set(off.x, off.y, off.z);
    this.camOffsetCurrent.lerp(this.camOffsetTarget, CAMERA_SMOOTH);
    this.camera.position.copy(this.target).add(this.camOffsetCurrent);

    const wanted = this.controls.viewHalfWidth();
    this.halfWidth += (wanted - this.halfWidth) * CAMERA_SMOOTH;
    if (Math.abs(this.halfWidth - this.lastHalfWidth) > 0.05) {
      const frustum = cameraFrustum(this.halfWidth, this.aspect);
      this.camera.left = -frustum.halfWidth;
      this.camera.right = frustum.halfWidth;
      this.camera.top = frustum.halfHeight;
      this.camera.bottom = -frustum.halfHeight;
      this.camera.updateProjectionMatrix();
      this.lastHalfWidth = this.halfWidth;
    }

    this.applySun();
    this.unwalkable.visible = this.controls.showUnwalkable();
  }

  private applySun(): void {
    const shadow = this.controls.dayNightEnabled() ? this.applyCycleSun() : this.applyManualSun();
    this.sun.castShadow = shadow.casting;

    const frame = shadowFrame(this.halfWidth);
    this.sun.target.position.copy(this.target);
    this.sun.position.copy(this.target).addScaledVector(this.sunDirection, frame.distance);

    if (shadowFrameStale(this.shadowHalfWidth, this.halfWidth)) {
      const cam = this.sun.shadow.camera;
      cam.left = -frame.radius;
      cam.right = frame.radius;
      cam.top = frame.radius;
      cam.bottom = -frame.radius;
      cam.near = frame.near;
      cam.far = frame.far;
      cam.updateProjectionMatrix();
      this.sun.shadow.normalBias = frame.normalBias;
      this.shadowHalfWidth = this.halfWidth;
    }
  }

  private applyCycleSun(): HorizonShadow {
    const sky = this.controls.sky();
    if (!sky) return this.applyManualSun();

    const d = sky.lightDirection;
    this.sunDirection.set(d.x, d.y, d.z).normalize();
    this.sun.color.setRGB(sky.lightColor.r, sky.lightColor.g, sky.lightColor.b, THREE.SRGBColorSpace);
    this.sun.intensity = sky.lightIntensity;
    this.ambient.color.setRGB(sky.ambientColor.r, sky.ambientColor.g, sky.ambientColor.b, THREE.SRGBColorSpace);
    this.ambient.intensity = sky.ambientIntensity;
    this.background.setRGB(sky.skyColor.r, sky.skyColor.g, sky.skyColor.b, THREE.SRGBColorSpace);
    return sky.shadow;
  }

  private applyManualSun(): HorizonShadow {
    const light = this.controls.lightOffset();
    const orbit = offsetToOrbit(light);
    const shadow = horizonShadow(orbit.elevation);
    const aimed = orbitToOffset({ azimuth: orbit.azimuth, elevation: shadow.castElevation, distance: 1 });

    this.sunDirection.set(aimed.x, aimed.y, aimed.z).normalize();
    this.sun.color.setHex(FIXED_DAYLIGHT.lightColor);
    this.sun.intensity = FIXED_DAYLIGHT.lightIntensity;
    this.ambient.color.setHex(FIXED_DAYLIGHT.ambientColor);
    this.ambient.intensity = FIXED_DAYLIGHT.ambientIntensity + shadowFillBoost(shadow.strength);
    this.background.setHex(PALETTE.sky);
    return shadow;
  }

  /**
   * The player's torch and floating orb (spec 047).
   *
   * The torch is *carried*: parented to whichever rig is the local player, so it
   * rides at the anchor in the rig's own space and swings round as they turn.
   * `TORCH_ANCHOR` is a rig-local offset -- forward, out to one side and above
   * head height -- and placing it in world space instead leaves the flame stuck
   * on the figure's chest facing east.
   *
   * Bodies are pooled by entity id and a respawn is a new entity, so the parent
   * is re-checked every frame rather than fixed at construction; that is one
   * reference comparison, and the alternative is the player's light going out
   * the first time they die.
   */
  private applyPlayerLights(position: Vec2, groundY: number): void {
    const settings = this.controls.playerLights();

    this.torch.visible = settings.torchOn;
    this.torchFlame.visible = settings.torchOn;
    if (settings.torchOn) {
      const flame = torchFlicker(this.elapsed, (this.map?.seed ?? 0), settings.torchFlicker);
      this.torch.castShadow = settings.torchShadows;
      this.torch.distance = settings.torchRange;
      this.torch.intensity =
        pointIntensity(settings.torchBrightness, settings.torchRange) * flame.intensity;
      this.torch.position.set(
        TORCH_ANCHOR.x + flame.sway.x,
        TORCH_ANCHOR.y + flame.sway.y,
        TORCH_ANCHOR.z + flame.sway.z,
      );
      this.torchFlame.position.copy(this.torch.position);
    }

    this.orb.visible = settings.magicOn;
    this.orbMesh.visible = settings.magicOn;
    if (settings.magicOn) {
      // The orbit is relative to the player's feet, so the orb is carried
      // without being parented to a rig that respawn would replace.
      const state = orbState(this.elapsed);
      this.orb.distance = settings.magicRange;
      this.orb.intensity = pointIntensity(settings.magicBrightness, settings.magicRange) * state.intensity;
      this.orb.position.set(
        position.x + state.offset.x,
        groundY + state.offset.y,
        position.y + state.offset.z,
      );
      this.orbMesh.position.copy(this.orb.position);
    }

    // No cube-map silhouette of the player across their own feet unless asked
    // for (spec 118). The anchor the lights are measured from is written after
    // the matrices are fresh, in `anchorPlayerLighting`.
    this.playerLighting.setCastsPointShadow(settings.torchPlayerShadow);
  }

  /**
   * Hand the player's own materials the point they measure the carried lights
   * from: the middle of the body, in view space (spec 118).
   *
   * View space because that is where `pointLight.position` already is by the
   * time a fragment shader sees it -- three transforms every light through the
   * view matrix in `WebGLLights`, so an anchor in world units would put the
   * apparent light somewhere behind the camera.
   *
   * Called after the camera and the scene have had their matrices updated, and
   * before the pixel snap: the snap moves the camera by a fraction of a virtual
   * pixel, which is nothing next to the tens of units this is measuring.
   */
  private anchorPlayerLighting(selfEntityId: number): void {
    const host = this.bodies.get(selfEntityId);
    if (!host) return;
    host.group.getWorldPosition(this.lightAnchor);
    // The rig's origin is at its feet, and lighting a standing figure from its
    // feet points every ray straight up. Half the height the health bar hangs at
    // is the middle of the body for a mech, a critter and an authored unit
    // alike, since that is the one measurement all three publish.
    this.lightAnchor.y += host.headroom * BODY_MIDDLE;
    this.lightAnchor.applyMatrix4(this.camera.matrixWorldInverse);
    this.playerLighting.setAnchor(this.lightAnchor.x, this.lightAnchor.y, this.lightAnchor.z);
  }

  /**
   * Project each body to a canvas pixel, so the DOM overlay can hang a health
   * bar or a damage number over it. Projection rather than a billboard mesh: the
   * text stays crisp at the window's real resolution instead of going through
   * the low-res buffer and the dither pass.
   */
  private collectAnchors(): void {
    this.anchors.length = 0;
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;

    for (const [id, body] of this.bodies) {
      this.projected.copy(body.group.position);
      this.projected.y += body.headroom;
      this.projected.project(this.camera);
      const x = (this.projected.x * 0.5 + 0.5) * width;
      const y = (-this.projected.y * 0.5 + 0.5) * height;
      this.anchors.push({
        id,
        x,
        y,
        onScreen:
          this.projected.z < 1 && x >= -80 && x <= width + 80 && y >= -80 && y <= height + 80,
      });
    }
  }
}

/**
 * The flat geometry for an aim shape (spec 080), built pointing down local +X.
 *
 * The mesh is laid flat by `rotation.x = -PI/2` and then spun by the heading,
 * under which local +X becomes the world direction from the caster to the
 * cursor -- so every shape is authored once, along one axis, and aimed by one
 * number.
 */
function buildAimGeometry(shape: AimShape): THREE.BufferGeometry {
  switch (shape.kind) {
    case 'circle':
      return new THREE.CircleGeometry(Math.max(1, shape.radius), 32);
    case 'cone':
      // A wedge symmetric about +X, with the half-angle the sim will actually
      // test -- `isInCone` measures from the captured aim, and so does this.
      return new THREE.CircleGeometry(
        Math.max(1, shape.length),
        32,
        -shape.halfAngle,
        shape.halfAngle * 2,
      );
    case 'line': {
      // The lane a shot flies down: as long as the ability reaches, as wide as
      // the projectile is, and starting at the caster rather than centred on
      // them -- a plane is built about its own middle.
      const plane = new THREE.PlaneGeometry(Math.max(1, shape.length), Math.max(1, shape.width));
      plane.translate(shape.length / 2, 0, 0);
      return plane;
    }
    case 'none':
      return new THREE.BufferGeometry();
  }
}
