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
import type { ClientView } from '../../../server/client/game-client.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { abilityById } from '../../../server/data/abilities.js';
import { PALETTE } from '../palette.js';
import { castsShadows, makeUnwalkableField } from '../meshes.js';
import { vegetationColliders } from '../../../terrain/vegetation.js';
import { buildTerrainMeshFromChunks, type TerrainMeshHandle } from '../terrain-mesh.js';
import type { ChunkFootprint, ChunkMeshArrays } from '../terrain-arrays.js';
import type { RegionInstances } from '../props.js';
import { StaggerFlinches } from './stagger-flinch.js';
import { TurnEase } from '../turn-ease.js';
import { turnLimitsFor } from './turn-limits.js';
import type { PerfFlags } from './perf-flags.js';
import {
  buildPropField,
  FLAT_SHADING,
  type PropFieldHandle,
  type PropRect,
  type PropShading,
} from '../props.js';
import { type HikeSettings } from '../hike.js';
import { CURVATURE_UNIFORMS } from '../terrain-curvature.js';
import { installPoissonShadows, shadowRadiusFor } from '../shadow-pcf.js';
import { DETAIL_UNIFORMS, buildDetailTexture } from '../terrain-detail.js';
import { MechRig, defaultMechTuning } from '../rigs.js';
import { monsterLookFor } from './monster-look.js';
import { DropRig } from '../drop-rig.js';
import {
  DropPresenter,
  popAt,
  POP_TICKS,
  tookRatherThanExpired,
} from './loot-drop.js';
import { DROP_LIFETIME_TICKS } from '../../../server/data/loot.js';
import { CritterRig, defaultCritterTuning } from '../critter.js';
import { monsterCritterFor } from './monster-critter.js';
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
import { VfxLayer } from '../vfx/layer.js';
import { ORDER_MARK_REACH } from '../vfx/brush.js';
import { markOriginY } from './order-mark.js';
import type { GoreLevel } from '../vfx/decals.js';
import type { PlayRequest } from './vfx-wire.js';
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
import { WeaponRig } from '../weapon-rig.js';
import { weaponAssets } from '../weapon-assets.js';
import { UnitMachine } from '../../../units/machine.js';
import type { UnitDef } from '../../../units/types.js';
import { authoredUnitFor } from './unit-catalog.js';
import { authoredUnitAssets } from './unit-assets.js';
import { weaponModelFor } from './weapon-look.js';
import {
  advanceSpeed,
  attackRateFrom,
  driveUnit,
  hasDeathAnimation,
  slewSpeed,
  STOPPED,
  type SpeedClock,
  type UnitFacts,
} from './unit-driver.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { drawnPixels, mixerCadence, shouldApply } from './unit-lod.js';
import { DEFAULT_CANONICAL_HEIGHT } from '../../../units/canonical-height.js';
import { ShotRig } from './shot.js';
import type { AimShape } from './aim.js';
import {
  SampledGround,
  aimTemplate,
  bodyRingRadius,
  bodyRingTemplate,
  discTemplate,
  projectDecal,
  ringTemplate,
  vertexCount,
  type DecalPlacement,
  type DecalTemplate,
  type HeightAt,
} from './ground-decal.js';
import { castBar } from './cast.js';
import { EntityMotion } from './interpolate.js';
import { AfflictionVfx } from './affliction-vfx.js';
import { AuraVfx, fieldStatusesOn } from './aura-vfx.js';
import { ShotVfx } from './shot-vfx.js';
import { sampleCapsuleSurface } from '../vfx/shapes.js';
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
 * How far above the ground an indicator floats (spec 153).
 *
 * Small, and it can afford to be, because a decal now follows the heightfield
 * rather than hovering at one sampled height: what the lift has to clear is the
 * error between two samples eleven units apart, not the whole fall of a
 * hillside. The order is the drawing order -- the range ring under the shape,
 * the shape under the telegraph -- since two of them are often over the same
 * ground and a tie is decided by whatever three drew last.
 */
const RANGE_RING_LIFT = 1.1;
const AIM_SHAPE_LIFT = 1.3;
const TELEGRAPH_LIFT = 1.5;
/**
 * The two rings drawn under a body, highest of the lot because they are the
 * ones that say *which* -- and because a body being attacked is often standing
 * inside the shape of the blow that is about to land on it.
 */
const TARGET_RING_LIFT = 1.6;
const AIM_UNIT_RING_LIFT = 1.7;
/**
 * How thick the range ring is, as a fraction of the range: the same 1.5% the
 * unit `RingGeometry` scaled to the range gave it, kept so that conforming to
 * the ground is the only thing this change did to the picture.
 */
const RANGE_RING_THICKNESS = 0.015;

/** How much wider than the body each ring sits. Unchanged from spec 070/080. */
const TARGET_RING_MARGIN = 8;
const AIM_UNIT_RING_MARGIN = 10;

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
  /** The document behind the machine, for questions about what it authored. */
  readonly def: UnitDef;
  /** Last tick's facts, so a cast's first tick can be told from its fifth. */
  previous: UnitFacts | null;
  /** Last drawn position, for the speed the blend tree reads. */
  previousPosition: { x: number; y: number } | null;
  /**
   * The weapon model currently wanted, and the rig that is drawing it (spec 165).
   *
   * Three fields rather than one because the body and the weapon are two
   * independent fetches and either can land first. `weaponId` is the intent and
   * is written the instant the equipment changes, so a mesh that arrives after
   * the player has switched again can tell that it is stale. `attached` is
   * whether the scene graph has actually been joined up, which cannot happen
   * until the *unit's* mesh has loaded and there is a bone to hang from.
   */
  weaponId: string | null;
  weapon: WeaponRig | null;
  weaponAttached: boolean;
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

/**
 * The volume the cursor picks a drop by (spec 158).
 *
 * Wider than the object is drawn and taller than it floats, because a drop is a
 * seven-unit shape at the far end of an isometric camera and a hitbox that
 * matched the mesh would be a thing the player has to aim at. The *pickup* is
 * still ranged by the server; this is only what the cursor catches.
 */
const DROP_PICK_RADIUS = 16;
const DROP_PICK_HEIGHT = 26;

/** A body on screen, pooled by entity id. */
interface Body {
  readonly group: THREE.Group;
  readonly kind: 'player' | 'monster' | 'projectile';
  /**
   * The critter rig drawing this body, for a player or for a monster that is an
   * animal (see `monster-critter.ts`).
   *
   * One field rather than one per kind: what the update loop needs to know is
   * *which rig to drive*, and a second field of the same type for the same job
   * would be a second thing every frame had to remember to tick.
   */
  readonly critter?: CritterRig;
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
  /**
   * The body's footprint radius, for the `surface` sampler (spec 215).
   *
   * The same number `appearanceOf` gives the hover volume, kept here so the
   * particle system can ask about a body it is attached to without the scene
   * having to hold a second map keyed the same way. Not readonly for the same
   * reason `headroom` is not: a rig can be replaced under one entity id.
   */
  radius: number;
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
  /**
   * The particle field (spec 118).
   *
   * A plain `Object3D` in this scene, which is the whole integration: `RetroPass`
   * draws `this.scene` into the low-resolution target, so every particle is
   * inside the pixel buffer by construction rather than by a pass anyone had to
   * remember to order correctly.
   *
   * It replaced `Poofs`, which this scene built and ticked every frame and never
   * once called `spawn` on -- dead in the Play tab and unreferenced everywhere
   * else in the repo.
   */
  private readonly vfx: VfxLayer;
  /** One rig per drop on screen (spec 158), pooled by entity id like a body. */
  private readonly dropRigs = new Map<number, DropRig>();
  /** Which of each drop's cues have already been heard. Pure; see `loot-drop.ts`. */
  private readonly dropPresenter = new DropPresenter();
  /**
   * Drops that have been taken and are still playing their pop (spec 158).
   *
   * Held past the entity that owned them, which is the only way the effect can
   * exist at all: the drop is gone from the world the instant it is picked up,
   * and a rig disposed on the same frame has nothing left to animate. Keyed by
   * the id it had, and carrying the tick it left on so the curve is read off the
   * drawn clock like everything else here rather than off a per-rig timer.
   */
  /** Each live drop's spawn tick, so a removal can tell taken from expired. */
  private readonly dropSpawnTicks = new Map<number, number>();
  private readonly poppingDrops = new Map<
    number,
    { readonly rig: DropRig; readonly leftAtTick: number; readonly spawnTick: number }
  >();

  private readonly motion = new EntityMotion();
  /**
   * The drawn yaw, eased (spec 142). A second presentation-only track beside
   * `motion`: the sim owns the heading, this owns how a body gets to it.
   */
  private readonly turnEase = new TurnEase();
  /** The rock a poise break puts on a body (spec 173). Presentation only. */
  private readonly staggerFlinches = new StaggerFlinches();
  private readonly bodies = new Map<number, Body>();
  /**
   * The paint on every afflicted body, and the beat it lands on (spec 215).
   *
   * Assigned in the constructor because it needs the layer, and `readonly`
   * because nothing may swap it: it is holding the handles that stop the
   * effects, and a replacement would leave every cling in the world running
   * with nothing left able to stop it.
   */
  private readonly afflictions: AfflictionVfx;
  private readonly auras: AuraVfx;
  /**
   * The paint a shot flies with (spec 218). A second driver rather than a
   * branch in the one above, because the two answer different questions from
   * different facts -- one reads a body's replicated statuses, the other reads
   * what a projectile *is*.
   */
  private readonly shots: ShotVfx;
  /**
   * The groups `RetroPass` leaves out of the quantize (spec 138).
   *
   * Every player, not just the local one: a second person on screen is the same
   * kind of thing to look at, and one of the two coming out banded while the
   * other did not would read as a bug about *whose* character it is. Rebuilt
   * per frame rather than maintained, because a respawn is a new entity and
   * therefore a new group, and a stale reference here would exempt a body that
   * has left the scene.
   */
  private readonly exemptBodies: THREE.Object3D[] = [];
  private readonly telegraphs = new Map<number, GroundDecal>();
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
  /** Which ability each caster is casting, so the driver can pick its clip. */
  private readonly castAbilities = new Map<number, string>();
  /** How much of each cast is left, so a cancellation can be told from an end. */
  private readonly castTicksLeft = new Map<number, number>();
  /** Attack-speed factor per casting entity, for the swing's playback rate. */
  private readonly attackRates = new Map<number, number>();
  private hovered: number | null = null;
  /** The ring under the body being attacked (spec 070). */
  private readonly targetRing: GroundDecal;
  /**
   * The aim indicator (spec 080): the shape of the blow, the range ring that
   * says the confirm will be a walk, and the ring under a named body.
   *
   * All three are ground decals -- their vertices are placed on the heightfield
   * rather than the mesh being moved to one sampled height, which is the only
   * way a shape drawn across a hillside can be right anywhere but its own
   * centre. Spec 153 converted the first two and left the ring on a flat mesh
   * because it is body-sized; spec 164 reversed that, because how far a flat
   * mesh is buried is its half-width times the *gradient* under it and only the
   * half-width had been counted. On the arena's steepest ground a ring at
   * radius 30 was fifty units into the hill.
   */
  private readonly aimShapeDecal: GroundDecal;
  private readonly aimRangeDecal: GroundDecal;
  private readonly aimUnitRing: GroundDecal;
  /**
   * The ground, as the decals ask about it: memoized, because they ask about
   * thousands of points a frame and `heightAt` is a five-microsecond question
   * (see {@link SampledGround}). Invalidated whenever the terrain changes under
   * it -- a height sampled over ground that had not streamed in yet is a height
   * that has to be thrown away.
   */
  private readonly sampledGround = new SampledGround((x, z) => this.ground(x, z));
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
    // Counted per *frame* rather than per `render` call (spec 165 follow-up 7).
    // This frame draws the world more than once -- the shadow maps, the hike
    // buffers, then the picture -- and three resets its counters at the top of
    // every `render`, so the default reading is whichever pass happened to go
    // last. What anybody debugging a frame rate wants is the total.
    this.renderer.info.autoReset = false;
    // Hard, unfiltered shadows (spec 045): one depth comparison per pixel, so an
    // edge is a step rather than a gradient -- the only kind that belongs in a
    // posterized frame.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    // Shadow maps are built once a frame, by us, rather than once per
    // `renderer.render` call.
    //
    // three rebuilds every shadow map at the top of *each* `render`, and this
    // frame calls `render` over the whole scene more than once: the hike buffers
    // capture depth and normals, then the retro pass draws the picture. Left on
    // three's default, that is the sun's 1024x1024 map and the torch's six
    // 512x512 cube faces rendered twice from an identical camera over identical
    // geometry -- measured at 1040 of the frame's 2673 draw calls, thrown away.
    //
    // `needsUpdate` is set in `render` below, immediately before the pass that
    // actually samples the maps. The capture pass writes view-space normals and
    // depth through an override material and never reads a shadow, so it is
    // content with whatever is already there.
    this.renderer.shadowMap.autoUpdate = false;
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
    // No `attachWheelZoom` here since spec 189. The wheel is a binding now, so
    // `world/view.ts` resolves the notch and calls `zoomNotch` -- a listener the
    // scene attached would be a second opinion about what the wheel does, and it
    // would win, because it is on the canvas and the binding is read on `root`.
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

    this.torchFlame = this.buildTorch();
    this.orbMesh = this.buildOrb();
    this.vfx = new VfxLayer({
      hooks: {
        // Injected rather than imported, so the sim stays free of terrain.
        ground: (x, z) => this.ground(x, z),
        attach: (entityId, _socket, out, at) => {
          const body = this.bodies.get(entityId);
          if (!body) return false;
          // Entity-level for now. Socket resolution has to find the bone in the
          // *loaded rig* rather than by a name out of a skeleton document --
          // three sanitises `mixamorig:Hips` to `mixamorigHips`, so a documented
          // name matches nothing and looks exactly like a clean import
          // (`unit-rig.ts`). The effects that need a socket -- a burning unit, a
          // weapon trail -- arrive with the fire and slash work.
          out[at] = body.group.position.x;
          out[at + 1] = body.group.position.y;
          out[at + 2] = body.group.position.z;
          return true;
        },
        /**
         * A point on a body's own volume, for `mesh` emitter shapes (spec 215).
         *
         * The socket the format has had since spec 118 -- *"the surface of
         * whatever the effect is attached to ... which is what makes a
         * burning-unit definition safe to preview in isolation"* -- and which
         * nothing supplied, so in the game that shape had never once resolved
         * to anything but a point.
         *
         * **A capsule, not the mesh.** Reading vertices would mean skinning on
         * the CPU per spawned particle, for a body a couple of hundred pixels
         * tall carrying marks several pixels across. What a painted stain needs
         * is to be *on* the body rather than on a particular triangle of it,
         * and the two numbers that answer that are already here: the footprint
         * radius every hover volume is built from, and the headroom the health
         * bar hangs off.
         *
         * **It answers in the effect's own scale units**, not in world units,
         * because `system.ts` multiplies what this writes by the instance
         * scale -- the same treatment an authored `circle` or `sphere` shape
         * gets. `AfflictionVfx` plays with `scale` set to the body's radius, so
         * writing a unit-radius capsule here means one authored definition
         * lands correctly on a spider and on a player, at the right place *and*
         * at the right size. Dividing the height by the radius rather than
         * normalising both is what preserves the body's actual proportions:
         * a tall thin body gets a tall thin capsule.
         *
         * Drawn from the system's own `VfxRng`, never `Math.random`: a
         * continuous emitter carries its generator across ticks, and this is
         * called from inside that stream.
         *
         * The sampling itself is `sampleCapsuleSurface`, shared with the judging
         * rig rather than written twice. A rig that distributed paint
         * differently from the game would be evidence about the rig -- the
         * failure `probe-chat.ts` records having shipped once, where a clearance
         * check measured the wrong furniture and passed while the log sat on the
         * button beside it.
         */
        surface: (entityId, rng, out, at) => {
          const body = this.bodies.get(entityId);
          if (!body) return false;
          const radius = Math.max(1, body.radius);
          // Height in radii, so the capsule keeps the body's proportions once
          // the instance scale multiplies it back up.
          sampleCapsuleSurface(rng, out, at, Math.max(2, body.headroom / radius));
          return true;
        },
      },
    });
    // The paint on an afflicted body (spec 215). Given the layer rather than the
    // scene, so the whole driver is pure and is driven end to end in Node
    // against a recorder -- the same reason `unit-driver.ts` takes a snapshot
    // and not a `GameClient`.
    this.afflictions = new AfflictionVfx({
      play: (id, options) => this.vfx.play(id, options),
      stop: (handle) => this.vfx.stop(handle),
      has: (id) => this.vfx.system.has(id),
      // A cling is the lowest-priority thing in the game and the first the
      // instance pool evicts under pressure. Asking rather than assuming is what
      // lets the driver put it back afterwards (spec 215).
      isLive: (handle) => this.vfx.system.isLive(handle),
    });
    // The ring under a body carrying an aura field (spec 222). The same four
    // calls again, and for the third time the same two reasons: a persistent
    // attached effect needs a handle it can find out has been evicted, and it
    // needs somebody to owe it a stop.
    this.auras = new AuraVfx({
      play: (id, options) => this.vfx.play(id, options),
      stop: (handle) => this.vfx.stop(handle),
      has: (id) => this.vfx.system.has(id),
      isLive: (handle) => this.vfx.system.isLive(handle),
    });
    // The paint a shot flies with (spec 218), on the same four calls and for the
    // same reasons -- a persistent attached effect needs a handle it can find
    // out has been evicted, and it needs somebody to owe it a stop.
    this.shots = new ShotVfx({
      play: (id, options) => this.vfx.play(id, options),
      stop: (handle) => this.vfx.stop(handle),
      has: (id) => this.vfx.system.has(id),
      isLive: (handle) => this.vfx.system.isLive(handle),
    });
    this.scene.add(this.vfx.root);

    this.targetRing = new GroundDecal(decalMaterial(TARGET_RING_COLOR, 0.85));
    this.scene.add(this.targetRing.mesh);

    // The aim (spec 080). Unlit and never depth-writing, exactly like the ground
    // telegraph and the blast effects it sits among -- and since spec 153 lying
    // on the ground rather than over it.
    this.aimShapeDecal = new GroundDecal(decalMaterial(AIM_COLOR, 0.28));
    this.scene.add(this.aimShapeDecal.mesh);

    this.aimRangeDecal = new GroundDecal(decalMaterial(AIM_COLOR, 0.35));
    this.scene.add(this.aimRangeDecal.mesh);

    this.aimUnitRing = new GroundDecal(decalMaterial(AIM_COLOR, 0.9));
    this.scene.add(this.aimUnitRing.mesh);
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
    this.sampledGround.invalidate();
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

  /**
   * Contributors taken out of the frame for measuring (spec 165 follow-up 9).
   *
   * Held rather than applied once, because `applySun` rewrites `castShadow`
   * every frame from the day/night state -- a one-shot assignment would be
   * overwritten by the next frame and the measurement would quietly be of the
   * baseline.
   */
  private cost: { prepareMs: number; drawMs: number } = { prepareMs: 0, drawMs: 0 };

  private perf: PerfFlags = {
    noShadow: false,
    noProps: false,
    noTerrain: false,
    noWorker: false,
    any: false,
  };

  /** Take contributors out of the frame. See {@link PerfFlags}. */
  setPerfFlags(flags: PerfFlags): void {
    this.perf = flags;
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
  /**
   * Draw a chunk whose triangles were built on the worker (spec 180).
   *
   * The counterpart to `invalidateGroundSamples` below, and split from it on
   * purpose: the *store* gained this ground when the chunk was inserted, which
   * is a frame or more before its triangles come back, and the memo is about
   * the store rather than about the picture.
   */
  adoptTerrainChunk(footprint: ChunkFootprint, arrays: ChunkMeshArrays): boolean {
    return this.terrainMesh?.adopt(footprint, arrays) ?? false;
  }

  /**
   * Stop drawing a chunk, and dispose its geometry (spec 208).
   *
   * The counterpart to {@link adoptTerrainChunk}, through the same
   * `TerrainMeshHandle.remove` the editor uses to take a map part away
   * (spec 085) -- which has existed since then with no caller on the streaming
   * path, so a session drew every chunk it had ever walked past.
   */
  dropTerrainChunk(layerId: string, cx: number, cz: number): boolean {
    return this.terrainMesh?.remove(layerId, cx, cz) ?? false;
  }

  /**
   * Forget the sampled-ground memo, because the ground under it moved.
   *
   * Everything it holds near an arriving chunk was sampled over a hole
   * (spec 153) -- and a decal drawn from stale heights is drawn on terrain that
   * no longer exists.
   */
  invalidateGroundSamples(): void {
    this.sampledGround.invalidate();
  }


  /**
   * Rebuild the instanced prop field from everything held.
   *
   * Deliberately *not* per chunk. One instanced mesh per species over the whole
   * map is a handful of draw calls; one per chunk would be 210 times that, every
   * frame, forever -- trading a startup cost for a permanent one.
   *
   * This is the whole-field version, and it is now the *rare* one: it is for a
   * shading change, which rebakes every normal in the world and so genuinely has
   * no smaller unit. A chunk arriving wants {@link refreshPropsWithin} instead.
   * On the grown map a full pass is ~6900 props and the streaming client used to
   * pay for one between every pair of deltas (spec 165).
   */
  refreshProps(): void {
    if (!this.map || !this.propField) return;
    const props = this.map.props();
    const heightAt = (x: number, z: number): number => this.ground(x, z);

    this.scene.remove(this.propField.group);
    this.propField.dispose();
    this.propField = buildPropField(props, heightAt, undefined, this.propShading);
    this.scene.add(this.propField.group);
    this.unwalkableStale = true;
  }

  /**
   * Rebuild only the batching regions overlapping a world rectangle (spec 165).
   *
   * The seam is spec 086's: the prop field is already grouped into 1100-unit
   * regions so the camera can cull them, and `rebuildWithin` makes that grouping
   * the unit of invalidation too. The editor's brush has used it since 086; the
   * streaming client is what never did, and rebuilt the world's trees on every
   * pump of the chunk stream instead.
   *
   * The props list handed down is the full current one -- the region re-buckets
   * itself from it, so the caller only has to know which *ground* changed, which
   * is the one thing a chunk arrival actually knows.
   */
  /**
   * Hang one region's prop batches on the scene graph, composed elsewhere
   * (spec 181).
   *
   * The counterpart to `adoptTerrainChunk`. What is left on this thread is the
   * shell, the material, the mesh and the sway patch -- about 4ms against the
   * 32.7ms a region rebuild used to be.
   */
  adoptPropRegion(key: string, instances: RegionInstances): void {
    this.propField?.adoptRegion(key, instances);
    this.unwalkableStale = true;
  }

  /**
   * Stop drawing one region's props, and dispose them (spec 215).
   *
   * The counterpart to {@link adoptPropRegion}, as `dropTerrainChunk` is to
   * `adoptTerrainChunk` -- and the same story: the takedown existed inside
   * `adoptRegion` from spec 086 and could only be reached by composing an empty
   * region, which is the one thing a client that has just thrown the ground
   * away cannot do.
   */
  dropPropRegion(key: string): boolean {
    const dropped = this.propField?.dropRegion(key) ?? false;
    if (dropped) this.unwalkableStale = true;
    return dropped;
  }

  /** Region keys with props on the scene graph. For the drop pass to reconcile. */
  heldPropRegions(): readonly string[] {
    return this.propField?.heldRegions() ?? [];
  }

  /**
   * Bodies with an aura ring running under them (spec 222).
   *
   * A readout and nothing else: `data-auras` is published from it, and nothing
   * in the game reads it. Taken from the **driver's own held set** rather than
   * from the replicated statuses, the rule `data-held-weapons` and
   * `data-prop-regions` both keep -- a ring that was wanted and refused, or
   * evicted, should read as absent, because that is the failure a probe exists
   * to see. Reading the statuses back would report the thing that was asked for
   * and tell nobody whether it arrived.
   */
  heldAuras(): readonly number[] {
    return this.auras.entities();
  }

  refreshPropsWithin(rects: PropRect | readonly PropRect[]): void {
    if (!this.map || !this.propField) return;
    if (Array.isArray(rects) && rects.length === 0) return;
    this.propField.rebuildWithin(this.map.props(), rects);
    this.unwalkableStale = true;
  }

  /**
   * Whether the unwalkable overlay owes a rebuild before it is next shown.
   *
   * The overlay is a debug switch in the tuning panel and is off in every played
   * session, but it used to be rebuilt inside `refreshProps` regardless: two
   * `InstancedMesh`es over every vegetation collider in the world, one `heightAt`
   * apiece at 5.6us a call. On the grown map that is ~78ms per refresh spent
   * drawing something nobody asked to see (spec 165).
   *
   * So it is built on the frame it is first shown and not before. The flag is
   * what carries "the world moved under it while you were not looking" across to
   * that frame.
   */
  private unwalkableStale = true;

  /**
   * Build the unwalkable overlay if it is being shown and owes a rebuild.
   *
   * Called from the frame, after the panel has been read. Costs two comparisons
   * in the session where the switch is off, which is all of them.
   */
  private syncUnwalkable(visible: boolean): void {
    this.unwalkable.visible = visible;
    if (!visible || !this.unwalkableStale || !this.map) return;
    this.unwalkableStale = false;
    this.unwalkable.clear();
    this.unwalkable.add(
      makeUnwalkableField(vegetationColliders(this.map.props()), (x, z) => this.ground(x, z)),
    );
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
  /**
   * The entity under the cursor as of this frame's `syncHover`, or null.
   *
   * A render-local pick, which is why it is read off the scene rather than off
   * the view: nothing about which body a cursor is over is replicated, and
   * nothing about it may reach the sim.
   */
  get hoveredEntityId(): number | null {
    return this.hovered;
  }

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

  /**
   * Play what a blow asked for (spec 120).
   *
   * Handed a request `vfx-wire.ts` already decided on, so this end makes no
   * judgement at all -- it turns a ground position into a world one and plays the
   * id it was given. Every `if` about what a blow looks like lives in that pure
   * module, where a test can reach it.
   */
  playEffect(request: PlayRequest): void {
    this.vfx.play(request.id, {
      x: request.x,
      y: this.ground(request.x, request.z) + request.y,
      z: request.z,
      rotation: request.rotation,
      scale: request.scale,
      seed: request.seed,
    });
  }

  /**
   * A walk order was given here (specs 127, 175).
   *
   * The whole picture of a move order: a cross painted where the click landed, a
   * third of a second, gone. Nothing is left behind and nothing draws the
   * standing order afterwards -- the answer a player wants is *did that land*,
   * and it is answered while they are still looking at the cursor.
   *
   * The height is the one thing decided out here, because it is the one thing
   * the effect table cannot know: `order-mark.ts` lays it over the highest
   * ground it covers, so a mark on a hillside is on the hillside rather than in
   * it. The memoized ground rather than the raw heightfield, for the reason spec
   * 153 measured -- nine `heightAt` calls at 5.6us each is a click that costs
   * more than the frame it lands on.
   */
  playMoveOrder(x: number, z: number): void {
    this.vfx.play('order_move', {
      x,
      y: markOriginY(x, z, ORDER_MARK_REACH, this.sampledGround.at),
      z,
      // Derived from where it landed, like a blast's, so nothing about this
      // reaches for a clock or a random number.
      seed: (Math.round(x) * 73856093) ^ (Math.round(z) * 19349663),
    });
  }

  /** 0 off, 1 reduced, 2 full. Off removes the decal work, not just the pixels. */
  setGore(level: GoreLevel): void {
    this.vfx.setGore(level);
  }

  /** 0 off, 1 low, 2 medium, 3 full. Off skips the simulation rather than hiding it. */
  setVfxIntensity(intensity: number): void {
    this.vfx.setIntensity(intensity);
  }

  /** What the VFX debug readout shows. */
  vfxReadout(): ReturnType<VfxLayer['readout']> {
    return this.vfx.readout();
  }

  /**
   * A blast landed. Purely something to look at; the damage already happened.
   *
   * `effectId` is the one the server already sends on `EffectMessage` -- it has
   * carried `${ability.id}.impact` since spec 062 and this renderer threw it away
   * and drew one hardcoded ring for every ability in the game. When the registry
   * knows the id it plays the authored effect; when it does not, the ring is
   * still what happens, so abilities keep their cue until the effect library
   * gives each of them a real one.
   */
  addEffect(effectId: string, x: number, y: number, radius: number, durationTicks: number): void {
    if (this.vfx.system.has(effectId)) {
      this.vfx.play(effectId, {
        x,
        y: this.ground(x, y) + 2,
        z: y,
        // One, and an authored effect is therefore drawn at the size it was
        // authored at (spec 218).
        //
        // The `max(0.25, radius / 40)` this replaces could not have worked, and
        // not by a little. `scale` multiplies the shape's local coordinates and
        // the size curve and **nothing else** -- a particle's speed, the
        // constant push on it and its turbulence are integrated in world units
        // -- so an explosion authored at radius R and played at a quarter is
        // quarter-sized marks thrown at full-sized velocities, which is a
        // scatter and not a burst. And a quarter is not an edge case: the radius
        // a projectile's *direct hit* carries is the shot's own collision
        // radius, 6 to 12 units against a nominal 40, so every direct hit in the
        // game sat on that floor. The message's radius means two different
        // things on its two branches -- the blast for a burst, the shot for a
        // hit -- and one conversion cannot serve both.
        //
        // Changing it is free because this branch had never run: the server can
        // send 46 effect ids (`${ability.id}.impact` and `.self` over
        // `ALL_ABILITIES`) and until spec 218 the registry held none of them, so
        // every ability in this game had drawn the ring below since spec 062.
        //
        // The day a *burst* wants its picture sized by its blast, the honest way
        // is `brushExplosionRequest`, which already exists, already treats a
        // radius as a length rather than as a multiplier, and already picks the
        // preset nearest the size asked for so the scale stays near one.
        scale: 1,
        // Derived from where it landed, so the same blast in the same place looks
        // the same on every client watching it.
        seed: (Math.round(x) * 73856093) ^ (Math.round(y) * 19349663),
      });
      return;
    }
    // The fallback ring, which is what `radius` still sizes and the only thing
    // it ever honestly could.
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
    const startedAt = performance.now();
    this.renderer.info.reset();
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
    this.syncDrops(view, frame, dt);
    this.carryTorch(view.selfEntityId);

    this.syncTelegraphs(view, frame);
    this.ageEffects();
    // Advanced on whole 60Hz steps, never on `dt`: an effect stepped by elapsed
    // time is a different effect at 30fps and at 144, and "the same seed draws
    // the same thing" stops being assertable. Same reason the unit machines take
    // `frame.ticks`.
    this.vfx.setViewpoint(this.target.x, this.target.y, this.target.z);
    // The direction the camera looks along, for the transparency sort (spec
    // 123). Taken from *last* frame's camera, since this one is not aimed until
    // `lookAt` below -- which costs nothing, because the only thing that turns
    // this camera is a view control, and a sort order one frame stale is not a
    // sort order anybody can see.
    this.vfx.setViewDirection(
      this.target.x - this.camera.position.x,
      this.target.y - this.camera.position.y,
      this.target.z - this.camera.position.z,
    );
    this.vfx.update(frame.ticks);

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

    // The split this whole readout exists for (spec 194): everything above is
    // JavaScript preparing the frame -- posing rigs, ageing effects, walking the
    // scene graph -- and everything below is handing it to the driver. They are
    // two different problems with two different fixes, and a single "render"
    // number cannot tell them apart.
    const drawAt = performance.now();
    this.cost = { prepareMs: drawAt - startedAt, drawMs: this.cost.drawMs };

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
      // Who the filter lets keep their colours (spec 138). The pass has no idea
      // what a player is and should not; this is the only place that does.
      this.exemptBodies.length = 0;
      for (const body of this.bodies.values()) {
        if (body.kind === 'player') this.exemptBodies.push(body.group);
      }
      this.retro.setExempt(this.exemptBodies);
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
      // The one pass in the frame that samples a shadow map, so the one pass
      // that pays for building them (see `autoUpdate` in the constructor).
      // three clears the flag itself once the maps are drawn, which is what
      // keeps the mask pass inside `retro.render` from rebuilding them again.
      this.renderer.shadowMap.needsUpdate = true;
      this.retro.render(this.renderer, this.scene, this.camera);
      // Over the finished frame, which is where a line belongs: the fills are
      // settled, so the outline is a constant dark value rather than something
      // the quantizer gets to round.
      if (hike.edges) this.drawEdges(hike, false);
    }
    this.cost = { prepareMs: this.cost.prepareMs, drawMs: performance.now() - drawAt };
    unsnap?.();
  }

  /**
   * What the last frame spent in JavaScript, split at the first draw call.
   *
   * `drawMs` is **submission**, not GPU time: WebGL commands are queued and
   * return, so a fast number here with a slow frame around it means the time
   * went somewhere this cannot see -- the driver, the GPU, the compositor. That
   * is the reading the readout is for, and it is why the frame publishes a
   * remainder rather than pretending these two add up to a frame.
   *
   * The one thing that muddies it: when the command queue backs up, the driver
   * blocks *inside* a later GL call, so genuine GPU time can land in `drawMs`.
   * A `drawMs` that is large and a remainder that is small still means "the GPU
   * is the problem", not "submission is expensive".
   */
  renderCost(): { readonly prepareMs: number; readonly drawMs: number } {
    return this.cost;
  }

  /**
   * What the last frame actually submitted, across every pass.
   *
   * For the frame-rate readout and for nothing else. A draw-call count is the
   * first thing worth knowing when a frame is slow and no loader is running:
   * it separates "the scene is too big" from "the scene is drawn too often",
   * and those have nothing in common as problems.
   */
  renderStats(): { calls: number; triangles: number } {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  dispose(): void {
    // Before the layer goes: every handle it is holding names an instance in
    // that layer's system.
    this.afflictions.clear();
    this.auras.clear();
    this.shots.clear();
    this.vfx.dispose();
    for (const body of this.bodies.values()) {
      this.scene.remove(body.group);
      if (body.shot?.trace) this.scene.remove(body.shot.trace);
      body.shot?.dispose();
    }
    this.bodies.clear();
    for (const effect of this.effects) this.scene.remove(effect.mesh);
    this.effects.length = 0;
    for (const decal of this.telegraphs.values()) {
      this.scene.remove(decal.mesh);
      decal.dispose();
    }
    this.telegraphs.clear();
    this.aimShapeDecal.dispose();
    this.aimRangeDecal.dispose();
    // The two body rings, which leaked their geometry and material while they
    // were hand-built meshes nobody had listed here (spec 164).
    this.aimUnitRing.dispose();
    this.targetRing.dispose();
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
    const live = new Set(view.entities.map((entity) => entity.id));
    this.motion.retain(live);
    // The drawn yaw keeps per-body state for the same reason the drawn position
    // does, and is dropped on the same pass (spec 142).
    this.turnEase.retain(live);
    this.staggerFlinches.retain(live);
  }

  private syncBodies(view: ClientView, frame: FrameInfo, dt: number): void {
    const live = new Set<number>();
    this.hoverTargets.length = 0;
    this.castPhases.clear();
    this.castAbilities.clear();
    this.castTicksLeft.clear();
    this.attackRates.clear();
    for (const cast of view.casts) {
      this.castPhases.set(cast.entityId, cast.phase);
      // Which ability, not just that there is one (spec 164): a sword swing and
      // a bow draw are the same activity on the wire and two different clips.
      this.castAbilities.set(cast.entityId, cast.abilityId);
      // And how much of it is left to run (spec 166), so the frame the cast
      // vanishes can be read as "finished" or "called off". Against the drawn
      // tick rather than the replicated one, because that is the clock the
      // machine is being stepped on.
      this.castTicksLeft.set(cast.entityId, cast.endTick - frame.tick);
      // Measured off the ticks the server sent rather than off anyone's stats
      // (spec 144): the ratio of the authored wind-up to the one actually being
      // run is the attack-speed factor, so a hasted body's swing animation
      // shortens with its wind-up instead of trailing behind it.
      this.attackRates.set(
        cast.entityId,
        attackRateFrom(
          abilityById(cast.abilityId)?.windupTicks ?? 0,
          cast.startTick,
          cast.releaseTick,
        ),
      );
    }

    for (const entity of view.entities) {
      // Drops are drawn by `syncDrops` instead (spec 158): what a drop is lit
      // by comes from `view.drops` rather than from the entity record, and
      // threading a rarity through `bodyFor` would put the one field this
      // feature exists to withhold into the pooled-rig key.
      if (entity.kind === EntityKind.Drop) continue;
      live.add(entity.id);
      const look = appearanceOf(entity);
      const body = this.bodyFor(entity.id, look);
      const isSelf = entity.id === view.selfEntityId;
      // Only our own body, because only our own equipment is on the wire: a
      // remote player's `mainHand` is not replicated, so drawing one would mean
      // inventing what they are holding (spec 165).
      if (isSelf && body.unit) this.syncHeldWeapon(body.unit, view.equipment.mainHand);

      // The local player is drawn at its prediction; everything else at its
      // smoothed replica. Interpolating our own body would add a frame of lag to
      // the one thing that must feel immediate.
      const pose = this.motion.sample(entity.id, frame.alpha);
      const x = isSelf && view.self ? view.self.x : (pose?.x ?? entity.x);
      const y = isSelf && view.self ? view.self.y : (pose?.y ?? entity.y);
      // What the sim says this body's heading is -- the prediction for our own
      // body, the smoothed replica for everything else.
      const heading = isSelf ? frame.selfFacing : (pose?.facing ?? entity.facing);
      // What to actually yaw it by (spec 142). `turnToward` steps angular
      // velocity from nothing to the full rate in one tick and back in one tick;
      // this gives that a beginning and an end. Presentation only: `heading` is
      // what every decision is still made against, and nothing reads this back.
      const limits = turnLimitsFor(entity, isSelf, view.stats?.turnRate ?? null, SERVER_TICK_RATE);
      const facing = limits === null ? heading : this.turnEase.step(entity.id, heading, limits, dt);

      const ground =
        entity.kind === EntityKind.Projectile
          ? (pose?.z ?? entity.z)
          : this.ground(x, y);

      // The poise break's rock (spec 173), added to the drawn transform and to
      // nothing else. `frame.tick` is the same clock the bodies above are
      // interpolated by, so this lands on the same frame at 30fps and at 144.
      const flinch = this.staggerFlinches.read(
        entity.id,
        entity.activity,
        entity.activityUntilTick,
        frame.tick,
      );

      body.group.position.set(x, ground, y);
      // A mesh built facing +x sits at world heading `theta` when yawed -theta.
      body.group.rotation.y = -facing + flinch.yaw;
      // Rocked back about the lateral axis. Written every frame rather than
      // only while flinching, so a body that settles is put back flat.
      body.group.rotation.z = flinch.pitch;

      // Both rigs read their own gait out of the positions they are handed, so
      // neither needs the scene to remember where it drew them last frame.
      body.critter?.update(dt, { x, y }, -facing);
      body.mech?.update(dt, { x, y }, -facing);
      if (body.unit) this.driveAuthoredUnit(body.unit, entity, { x, y }, frame);
      // Fed the *drawn* pose, so an arrow's nose follows the curve the eye is
      // following rather than the one the deltas describe (spec 087).
      body.shot?.update(dt, x, y, ground);
      // And the paint that flies with it (spec 218), off the same drawn pose.
      // Only the initial position is passed -- after that the attach hook
      // resolves `body.group.position` every tick, which the line above has
      // already set -- but passing it means the first frame's marks are born on
      // the shot rather than at wherever the last delta put it.
      if (body.kind === 'projectile') {
        this.shots.step({ entityId: entity.id, x, y: ground, z: y, radius: look.radius, look: look.look });
      }

      // A corpse lies where it fell and stops animating, so a kill reads. The
      // squash is how that reads for the procedural rigs, which have no death
      // clip -- a body with an authored `terminal` state is already lying down
      // by its own animation, and squashing that as well drew the pig at half
      // size for the whole of its collapse.
      const dead = entity.maxHealth > 0 && entity.health <= 0;
      const fallen = body.unit !== undefined && hasDeathAnimation(body.unit.def);
      body.group.scale.setScalar(dead && !fallen ? 0.6 : 1);

      // The paint on an afflicted body (spec 215).
      //
      // Fed the **drawn** position and the **drawn** tick -- the same `x`,
      // `ground` and `frame.tick` the body itself is placed by -- so the marks
      // sit where the body is being shown rather than where the last delta put
      // it, and a beat lands on the same frame at 30fps as at 144.
      //
      // A corpse wears nothing. The line above says what a dead body is here:
      // it lies where it fell and stops animating, because that is how a kill
      // reads. Paint on it would be a picture of damage still being done to
      // something that is already dead -- and the capsule the surface sampler
      // draws from is a *standing* body's, so the marks would hang in the air
      // over a rig lying flat.
      //
      // `?? []` for the reason `hud.ts` gives at its own two call sites: several
      // harnesses fabricate a `ClientView` by hand and do not know to set a
      // field added to `ReplicatedEntity`, and a frame that throws on a missing
      // one takes the whole render loop rather than one body's marks.
      //
      // The ring under a field's carrier goes on the same two branches and for
      // the same reason (spec 222): a corpse's field is over, and a sigil left
      // burning on the ground under a dead body would be a hazard nothing is
      // producing.
      if (dead) {
        this.afflictions.forget(entity.id);
        this.auras.forget(entity.id);
      } else {
        this.afflictions.step(
          { entityId: entity.id, x, y: ground, z: y, radius: look.radius },
          entity.statuses ?? [],
          frame.tick,
        );
        this.auras.step(
          { entityId: entity.id, x, y: ground, z: y },
          {
            entityId: entity.id,
            // The four `aurasFor` was written for in spec 121 and which this
            // spec deliberately does not switch on. Each is its own decision --
            // the selected ring would be a second answer to what `targetRing`
            // already draws, and the other three are a look change nobody asked
            // for -- so they are stated false rather than left to a default.
            casting: false,
            channelling: false,
            selected: false,
            telegraphing: false,
            healthFraction: entity.maxHealth > 0 ? entity.health / entity.maxHealth : 1,
            fields: fieldStatusesOn(entity.statuses ?? [], frame.tick),
          },
        );
      }
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
      // A held weapon is a loaded mesh hanging off a bone that is about to
      // leave the scene, so it goes with it.
      if (body.unit) this.dropHeldWeapon(body.unit);
      // Nothing in the particle system stops itself when the body it is
      // attached to goes away (spec 215): the attach hook simply answers false,
      // the instance stays wherever it last resolved, and a `durationTicks: 0`
      // effect hangs in the air forever holding one of 128 instance slots. The
      // stop is the caller's, so it is made here -- from the sweep that already
      // knows a body has left -- rather than inferred from an absence.
      this.afflictions.forget(id);
      this.auras.forget(id);
      // The same obligation for a shot's paint, and it bites harder: a shot
      // lives a second and a half, so an unstopped one is a leak that runs at
      // the rate of the shooting (spec 218).
      this.shots.forget(id);
      this.bodies.delete(id);
    }
  }

  /**
   * Puts the equipped weapon in the player's hand, and keeps it there (spec 165).
   *
   * Called every frame for the local body, and does nothing on almost all of
   * them. Two things make it worth a per-frame call rather than an event.
   *
   * **The two halves land in either order.** The unit's mesh and the weapon's
   * mesh are separate fetches, and `attach` needs a *bone*, which does not exist
   * until the body has loaded. So the attach is retried until it takes, which is
   * one boolean test on the frames where it already has.
   *
   * **A switch mid-fetch must not resurrect the old weapon.** `weaponId` is
   * written before the load starts and re-checked after it resolves, so a bow
   * that arrives after the player has gone back to the sword is disposed instead
   * of drawn. Without that the race is invisible on a fast connection and
   * reliable on a slow one, which is the worst shape a bug can have.
   */
  private syncHeldWeapon(unit: DrivenUnit, itemId: string | null): void {
    const wanted = weaponModelFor(itemId);
    if (wanted !== unit.weaponId) {
      unit.weaponId = wanted;
      this.dropHeldWeapon(unit);
      const assets = wanted === null ? null : weaponAssets(wanted);
      if (assets) {
        const rig = new WeaponRig(assets.def);
        void rig.load({ meshUrl: assets.meshUrl }).then(() => {
          // Superseded while the bytes were in flight, or the mesh is broken.
          // Both are "do not draw it", and neither is worth a console line on a
          // path a player can take by clicking the weapon switch twice.
          if (unit.weaponId !== wanted) {
            rig.dispose();
            return;
          }
          if (rig.error !== null) {
            // Said out loud rather than left as empty hands, the same rule
            // `weapon-assets.ts` applies to a document that will not validate:
            // a weapon that fails here is one the player is about to go looking
            // for, and silence is indistinguishable from a socket that missed.
            console.error(`[items] ${wanted} did not load: ${rig.error}`);
            rig.dispose();
            return;
          }
          // Whatever is in the hand comes out first, even when it is the same
          // model. Two loads of one weapon can be in flight at once -- switch
          // away and back inside a fetch and both have the same `wanted`, so
          // both pass the test above -- and assigning over the first would
          // leave it attached to the bone with nothing left holding a
          // reference to detach it.
          this.dropHeldWeapon(unit);
          unit.weapon = rig;
          castsShadows(rig.object);
        });
      }
    }

    const held = unit.weapon;
    if (held === null || unit.weaponAttached) return;
    unit.weaponAttached = unit.rig.attach(held.weapon.socket, held.object);
    if (!unit.weaponAttached && unit.rig.loaded) {
      // The body has a skeleton and the socket still did not resolve, so this
      // is a document naming a socket or a bone that does not exist -- not the
      // ordinary "the mesh has not arrived yet" case, which is what the
      // `loaded` test above excludes. Once, because the retry is per frame.
      console.error(`[items] ${held.weapon.id} names socket ${held.weapon.socket}, which this rig has nowhere to hang`);
      unit.weaponAttached = true;
    }
  }

  /** Takes the held weapon off the bone and frees it. Safe on an empty hand. */
  private dropHeldWeapon(unit: DrivenUnit): void {
    const held = unit.weapon;
    if (held) {
      unit.rig.detach(held.weapon.socket);
      held.dispose();
    }
    unit.weapon = null;
    unit.weaponAttached = false;
  }

  /**
   * The items lying in the world (spec 158).
   *
   * Its own pass rather than a branch in `syncBodies`, because a drop is joined
   * from two halves that arrive on different messages: the *position* comes off
   * the entity delta like everything else, and everything else -- the tier, the
   * clock, and the identity once the server allows it -- comes off `LootDrop`.
   * Folding it into the body pass would mean `bodyFor` taking a rarity, and the
   * pooled-rig key is the last place the withheld half should end up.
   *
   * Nothing here decides *when*: `DropPresenter` is pure, takes the drawn tick
   * as an argument, and hands back a flare, a label and the cues that crossed
   * into this frame.
   */
  private syncDrops(view: ClientView, frame: FrameInfo, dt: number): void {
    const live = new Set<number>();
    const positions = new Map<number, { x: number; y: number }>();
    for (const entity of view.entities) {
      if (entity.kind === EntityKind.Drop) positions.set(entity.id, { x: entity.x, y: entity.y });
    }

    for (const drop of view.drops) {
      const at = positions.get(drop.entityId);
      // Described but not replicated: the `LootDrop` outran its delta, or the
      // entity has gone. Either way there is nowhere to draw it.
      if (!at) continue;
      live.add(drop.entityId);

      let rig = this.dropRigs.get(drop.entityId);
      if (!rig) {
        rig = new DropRig(drop.rarity);
        this.dropRigs.set(drop.entityId, rig);
        this.scene.add(rig.group);
      }
      // Kept beside the rig because the removal pass runs after the drop has
      // left `view.drops` and can no longer ask it anything.
      this.dropSpawnTicks.set(drop.entityId, drop.spawnTick);

      // The entity's replicated position is where it *landed*; the throw that
      // got it there is drawn between that and the origin the wire carried
      // (spec 158).
      const landing = { x: at.x, y: at.y, z: this.ground(at.x, at.y) };
      const shown = this.dropPresenter.read(drop, landing, frame.tick);
      // Cleared here and turned back on by `syncHover`, the same handshake a
      // body's highlight uses -- so exactly one thing is ever lit.
      rig.setHovered(false);
      rig.group.position.set(shown.position.x, shown.position.z, shown.position.y);
      rig.setTierMix(shown.tierMix);
      rig.update(dt, shown.flare, shown.beat);
      for (const cue of shown.cues) this.playCue(cue, at.x, at.y);

      // Pickable while it is there, at the same footprint the server measures
      // its reach against, so what the cursor catches and what the pickup
      // accepts are the same object.
      this.hoverTargets.push({
        id: drop.entityId,
        object: rig.group,
        // Picked at where it *landed* rather than where it is mid-flight: the
        // hitbox must not chase a thing through the air, and the pickup the
        // server checks is measured to the landing spot anyway.
        position: at,
        radius: DROP_PICK_RADIUS,
        base: landing.z,
        height: DROP_PICK_HEIGHT,
      });
    }

    for (const [id, rig] of this.dropRigs) {
      if (live.has(id)) continue;
      this.dropRigs.delete(id);
      // Taken, or merely rotted? The client can tell without being told: there
      // are two ways a drop leaves and it has the spawn tick for both (spec
      // 158). Only a pickup earns the pop -- one on an item that quietly
      // expired would be a lie about a reward.
      const spawnTick = this.dropSpawnTicks.get(id);
      this.dropSpawnTicks.delete(id);
      if (spawnTick !== undefined && tookRatherThanExpired(spawnTick, DROP_LIFETIME_TICKS, frame.tick)) {
        this.poppingDrops.set(id, { rig, leftAtTick: frame.tick, spawnTick });
        continue;
      }
      this.scene.remove(rig.group);
      rig.dispose();
    }
    this.dropPresenter.retain(live);
    this.advancePops(frame, dt);
  }

  /**
   * One frame of every drop on its way out.
   *
   * Driven off the drawn tick rather than a per-rig clock, so the pop is the
   * same length at 30fps and at 144 -- the rule every other curve in this
   * feature follows. The flare is frozen at the tier's rest for the duration:
   * what is being watched is the object leaving, and a glow still resolving
   * underneath it would be two things happening at once.
   */
  private advancePops(frame: FrameInfo, dt: number): void {
    for (const [id, popping] of this.poppingDrops) {
      const through = (frame.tick - popping.leftAtTick) / POP_TICKS;
      if (through >= 1) {
        this.scene.remove(popping.rig.group);
        popping.rig.dispose();
        this.poppingDrops.delete(id);
        continue;
      }
      popping.rig.setHovered(false);
      popping.rig.setPop(popAt(through));
      popping.rig.update(dt, 0, 1);
    }
  }

  /**
   * A loot cue, if anything has been authored for it (spec 158).
   *
   * A cue is a *name*, and this is the whole of the hook: when the effect
   * library knows the id it plays it, and when it does not this is silent.
   * Deliberately not `addEffect`, whose fallback draws a ring for any id it does
   * not recognise -- a ring under every potion that ever drops is exactly the
   * noise the restrained-presentation rule exists to prevent, and silence is the
   * right placeholder for an effect nobody has made yet.
   */
  private playCue(cue: string, x: number, y: number): void {
    if (!this.vfx.system.has(cue)) return;
    this.vfx.play(cue, {
      x,
      y: this.ground(x, y) + 2,
      z: y,
      scale: 1,
      seed: (Math.round(x) * 73856093) ^ (Math.round(y) * 19349663),
    });
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
    // A respawn is a teleport home, and the ground it covered is not travel.
    // Measured as travel it is thousands of units in one tick, which the slew
    // then walks the blend parameter up through -- so a body that has just
    // stood up takes a stride it never made. Forgetting the last drawn position
    // is the whole fix: the frame the body reappears measures nothing, and the
    // frame after it measures from where it actually is.
    if (unit.previous?.dead === true && !dead) {
      unit.previousPosition = null;
      unit.speed = STOPPED;
      unit.blendSpeed = 0;
    }
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
      attackRate: this.attackRates.get(entity.id) ?? 1,
      abilityId: this.castAbilities.get(entity.id) ?? null,
      castTicksLeft: this.castTicksLeft.get(entity.id) ?? null,
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
  authoredUnitReadout(): {
    readonly loaded: number;
    readonly bones: number;
    readonly states: string;
    readonly held: string;
  } {
    let loaded = 0;
    let bones = 0;
    const states: string[] = [];
    const held: string[] = [];
    for (const body of this.bodies.values()) {
      if (!body.unit?.rig.loaded) continue;
      loaded += 1;
      bones = Math.max(bones, body.unit.bones);
      states.push(`${body.unit.machine.stateId}@${body.unit.machine.tick}`);
      // What is actually hanging off a bone, not what was asked for (spec 165).
      // The whole failure this exists to catch is a weapon that is wanted,
      // fetched, and attached to nothing -- an uncalibrated socket id, a rig
      // whose mesh had not loaded yet -- and every one of those leaves
      // `weaponId` set and the scene graph empty.
      if (body.unit.weapon && body.unit.weaponAttached) {
        held.push(`${body.unit.weapon.weapon.socket}=${body.unit.weapon.weapon.id}`);
      }
    }
    return { loaded, bones, states: states.sort().join(','), held: held.sort().join(',') };
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

    if (this.hovered !== null) {
      this.bodies.get(this.hovered)?.highlight?.setHighlighted(true);
      // A drop is not in `bodies` (spec 158), so it lights itself. Its response
      // is the ground ring rather than an outline, because the object is already
      // glowing and a second glow would read as part of the reveal.
      this.dropRigs.get(this.hovered)?.setHovered(true);
    }

    const target =
      frame.targetEntityId === null
        ? undefined
        : this.hoverTargets.find((candidate) => candidate.id === frame.targetEntityId);
    if (target) {
      // Sized to the body it is under, so a ravager's ring is not a grazer's --
      // and built at that radius rather than scaled to it, because a decal has
      // no transform to scale (spec 164).
      const outer = bodyRingRadius(target.radius, TARGET_RING_MARGIN);
      this.targetRing.lay(
        `body:${outer}`,
        () => bodyRingTemplate(outer),
        {
          x: target.position.x,
          z: target.position.y,
          heading: 0,
          lift: TARGET_RING_LIFT,
        },
        this.sampledGround.at,
      );
    } else {
      this.targetRing.hide();
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
      this.aimShapeDecal.hide();
      this.aimRangeDecal.hide();
      this.aimUnitRing.hide();
      return;
    }

    // The ring under the body a click would pick, or the one already picked.
    const named =
      aim.unitId === null
        ? undefined
        : this.hoverTargets.find((candidate) => candidate.id === aim.unitId);
    if (named) {
      const outer = bodyRingRadius(named.radius, AIM_UNIT_RING_MARGIN);
      this.aimUnitRing.lay(
        `body:${outer}`,
        () => bodyRingTemplate(outer),
        { x: named.position.x, z: named.position.y, heading: 0, lift: AIM_UNIT_RING_LIFT },
        this.sampledGround.at,
      );
    } else {
      this.aimUnitRing.hide();
    }

    // Out of range is the one thing the picture has to say that the shape
    // cannot: the confirm will be a walk before it is a blow. It is also the
    // largest thing drawn on the ground -- 700 units across at the top of the
    // ability table, which is thirty terrain cells -- and so the one a flat mesh
    // was most wrong about.
    if (!aim.inRange && aim.range > 0) {
      const range = aim.range;
      this.aimRangeDecal.lay(
        `ring:${range}`,
        () => ringTemplate(range * (1 - RANGE_RING_THICKNESS), range),
        { x: aim.origin.x, z: aim.origin.y, heading: 0, lift: RANGE_RING_LIFT },
        this.sampledGround.at,
      );
    } else {
      this.aimRangeDecal.hide();
    }

    const shape = aim.shape;
    if (shape.kind === 'none') {
      this.aimShapeDecal.hide();
      return;
    }

    const dx = aim.point.x - aim.origin.x;
    const dy = aim.point.y - aim.origin.y;
    const heading = Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dy, dx) : 0;
    // A burst lands where it was placed and nothing about it points anywhere; a
    // cone and a lane both run from the caster toward the cursor. That is the
    // whole difference between them here -- the template is authored down local
    // +X either way, and `projectDecal` turns it.
    const placed = shape.kind === 'circle';
    this.aimShapeDecal.lay(
      JSON.stringify(shape),
      () => aimTemplate(shape),
      {
        x: placed ? aim.point.x : aim.origin.x,
        z: placed ? aim.point.y : aim.origin.y,
        heading: placed ? 0 : heading,
        lift: AIM_SHAPE_LIFT,
      },
      this.sampledGround.at,
    );
    // Dimmer out of range: the same shape, said less certainly.
    this.aimShapeDecal.material.opacity = aim.inRange ? 0.3 : 0.15;
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

    const { rig, typeId, radius, look, tint, detail, outline } = appearance;
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
      // Without this `attach` has no socket to resolve and silently draws no
      // weapon (spec 165). The sandbox has always called it; the Play tab never
      // did, because until now nothing here had anything to hang.
      if (authoredUnit.skeleton) unitRig.setSockets(authoredUnit.skeleton.sockets);
      const driven: DrivenUnit = {
        rig: unitRig,
        machine: new UnitMachine({ unit: authoredUnit.unit, clipLib: authoredUnit.clipLib }),
        def: authoredUnit.unit,
        previous: null,
        previousPosition: null,
        weaponId: null,
        weapon: null,
        weaponAttached: false,
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
        radius,
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
        critter: player,
        highlight: attachHighlight(player.group),
        // Read off the species rather than measured: the metrics are what the
        // skeleton is built from, so a taller animal moves its own bar.
        headroom:
          (species.metrics.headY + species.metrics.headRadius) * PLAYER_FIGURE.bodyScale +
          HEADROOM_GAP,
        radius,
      };
    } else if (rig === 'projectile') {
      // The silhouette comes from the ability that threw it (spec 087), so a
      // thrown weapon reads as one in the air rather than as a bead of light.
      const shot = new ShotRig(look ?? 'orb', radius, { tint, detail, outline });
      // A shot never shows a bar, so its headroom is the shared default rather
      // than anything measured off the mesh.
      body = { group: shot.group, kind: 'projectile', shot, headroom: DEFAULT_HEADROOM, radius };
    } else {
      // No authored unit for this type, so the procedural rig it has always
      // had. Additive on purpose: the roster moves over when there is a roster.
      //
      // What that rig is built with comes from the look table (spec 152), and a
      // type with no row there gets exactly what it got before: the defaults,
      // the chassis body and `enemyColor`'s answer. The tuning is merged here
      // rather than in the table because `defaultMechTuning` lives in the rig
      // module, and the pure half of this directory does not import three.
      // Some monsters are animals rather than machines, and no tuning of the
      // mech rig makes one into the other -- so they are built by the same
      // critter rig that draws the player, off a row in `monster-critter.ts`.
      // A type with no row there falls through to the mech below, unchanged.
      const animal = monsterCritterFor(typeId);
      if (animal) {
        const species = CRITTERS[animal.species];
        const critter = new CritterRig(species, {
          tuning: { ...defaultCritterTuning(), ...animal.figure },
        });
        body = {
          group: critter.group,
          kind: 'monster',
          critter,
          highlight: attachHighlight(critter.group),
          // Off the species' own metrics and its own scale, the way the player's
          // is -- `DEFAULT_HEADROOM` is a number tuned for the mech chassis and
          // hangs the bar through a taller animal's head.
          headroom:
            (species.metrics.headY + species.metrics.headRadius) * animal.figure.bodyScale +
            HEADROOM_GAP,
          radius,
        };
      } else {
        const look = monsterLookFor(typeId);
        const mech = new MechRig(typeId, undefined, {
          tuning: { ...defaultMechTuning(), ...look?.tuning },
          ...(look === null ? {} : { appearance: look.appearance }),
        });
        body = {
          group: mech.group,
          kind: 'monster',
          mech,
          highlight: attachHighlight(mech.group),
          headroom: DEFAULT_HEADROOM,
          radius,
        };
      }
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

      let decal = this.telegraphs.get(cast.entityId);
      if (!decal) {
        // A ground decal for the same reason the aim above it is one (spec
        // 153): this is the same picture the aim was drawing a moment ago, so
        // leaving it flat would have a conforming shape snap level at the
        // instant of commitment -- which is the frame the player is watching.
        decal = new GroundDecal(decalMaterial(TELEGRAPH_COLOR, 0.3));
        this.scene.add(decal.mesh);
        this.telegraphs.set(cast.entityId, decal);
      }

      const bar = castBar(cast, frame.tick);
      const radius = ability.radius;
      decal.lay(
        `disc:${radius}`,
        () => discTemplate(radius),
        { x: cast.targetX, z: cast.targetY, heading: 0, lift: TELEGRAPH_LIFT },
        this.sampledGround.at,
      );
      decal.material.opacity = 0.14 + 0.4 * bar.progress;
    }

    for (const [id, decal] of this.telegraphs) {
      if (live.has(id)) continue;
      this.scene.remove(decal.mesh);
      decal.dispose();
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
    this.syncUnwalkable(this.controls.showUnwalkable());
    // Applied per frame, beside the switches that own these objects the rest of
    // the time: the prop field is replaced whenever a region rebuilds, and the
    // terrain group outlives every chunk, so a one-shot hide would come back.
    if (this.perf.noProps && this.propField) this.propField.group.visible = false;
    if (this.perf.noTerrain && this.terrainMesh) this.terrainMesh.group.visible = false;
  }

  private applySun(): void {
    const shadow = this.controls.dayNightEnabled() ? this.applyCycleSun() : this.applyManualSun();
    this.sun.castShadow = shadow.casting && !this.perf.noShadow;

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
 * An indicator drawn on the ground rather than over it (spec 153).
 *
 * The mesh's transform is never touched: position, rotation and scale stay
 * identity and the vertices are world-space, because a transform is exactly the
 * thing that cannot express "and follow the hill". Where it goes and which way
 * it points are arguments to {@link lay}, applied per vertex by `projectDecal`
 * where the ground can be asked about the answer.
 *
 * The template is rebuilt only when the shape changes -- the cursor moves every
 * frame, and a geometry allocated at 60Hz for as long as somebody is deciding is
 * a garbage-collection pause during the one moment the player is looking
 * closely. What happens per frame is a rewrite of a `Float32Array` that already
 * exists.
 */
/**
 * The material every ground decal shares the shape of: unlit, translucent, and
 * never writing depth, so nothing it is drawn over gets an edge from it.
 *
 * The polygon offset is the second half of the lift: a decal that follows the
 * ground is a fraction of a unit above ground whose depth is quantized, and a
 * bias toward the camera settles the ties the lift alone leaves.
 */
function decalMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

class GroundDecal {
  readonly mesh: THREE.Mesh;
  private template: DecalTemplate | null = null;
  private key = '';
  private world = new Float32Array(0);

  constructor(readonly material: THREE.MeshBasicMaterial) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    // World-space vertices, so three's bounding sphere is stale the moment the
    // decal moves and culling by it would blink the indicator out at the edge
    // of the frame. There are three of these; the draw is cheaper than the box.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * Lay `template` on the ground at `placement`. `key` names the shape: an
   * unchanged key reuses everything and only the heights are re-read.
   */
  lay(key: string, build: () => DecalTemplate, placement: DecalPlacement, heightAt: HeightAt): void {
    if (key !== this.key || !this.template) {
      this.key = key;
      this.template = build();
      this.world = new Float32Array(vertexCount(this.template) * 3);
      this.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(this.world, 3));
      this.mesh.geometry.setIndex(new THREE.BufferAttribute(this.template.index, 1));
    }
    projectDecal(this.template, placement, heightAt, this.world);
    this.mesh.geometry.getAttribute('position').needsUpdate = true;
    this.mesh.visible = this.world.length > 0;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
