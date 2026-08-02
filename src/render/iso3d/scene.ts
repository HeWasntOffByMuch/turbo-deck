import * as THREE from 'three';
import { ARENA_HEIGHT, ARENA_OBSTACLES, ARENA_WIDTH, ATTACK_ANIM_TICKS, ENEMY_RADIUS, PLAYER_RADIUS } from '../../sim/constants.js';
import type { CombatState, Vec2, WorldColliders } from '../../sim/types.js';
import { createWorldColliders } from '../../sim/collision.js';
import { PALETTE } from './palette.js';
import {
  makeAttackCone,
  makeMoveMarker,
  makeQueuedMoveMarker,
  castsShadows,
  makeUnwalkableField,
  makeWall,
  sectorGeometry,
} from './meshes.js';
import {
  createArenaWorld,
  vegetationColliders,
  worldVegetation,
  type Prop,
  type TerrainWorld,
} from '../../terrain/index.js';
import { buildTerrainMesh } from './terrain-mesh.js';
import { attachOutline, type OutlineHandle } from './outline.js';
import { HOVER_PLAYER_ID, pickHoveredUnit, type HoverTarget } from './hover.js';
import type { ScreenPoint } from './input.js';
import { MechRig, Poofs, PlayerRig } from './rigs.js';
import { worldToIso, type IsoParams } from './projection.js';
import { buildPropField } from './props.js';
import { createViewControls, type ViewControls } from './view-controls.js';
import {
  CAMERA_FAR,
  CAMERA_NEAR,
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_VIEW_HALF_WIDTH,
  followAlpha,
  offsetToOrbit,
  orbitToOffset,
} from './view-settings.js';
import { cameraFrustum, cursorToNdc, internalRenderSize } from './view-frame.js';
import {
  horizonShadow,
  shadowFillBoost,
  shadowFrame,
  shadowFrameStale,
  SHADOW_MAP_SIZE,
  type HorizonShadow,
} from './shadow.js';
import { RetroPass } from './retro-pass.js';
import { FIXED_DAYLIGHT } from './daynight.js';
import {
  MAGIC_COLOR,
  MAX_LIGHT_RANGE,
  TORCH_ANCHOR,
  TORCH_COLOR,
  TORCH_DEFAULTS,
  orbState,
  pointIntensity,
  torchFlicker,
} from './player-lights.js';

// Fraction of the gap to the target camera framing closed each rendered frame,
// so orbit/zoom slider changes glide instead of snapping (spec 034).
const CAMERA_SMOOTH = 0.15;

/**
 * Resolution of the torch's shadow map, per cube face (spec 047). Half the
 * sun's, and for a reason beyond cost: this is a *cube* map, so it is six
 * renders of the scene per frame rather than one, and it only ever covers the
 * few hundred units around the player. At 512 a texel near the edge of the
 * torch's reach is a couple of world units -- the same chunky register as the
 * sun's shadows land in.
 */
const TORCH_SHADOW_MAP_SIZE = 512;

/**
 * Near/far planes of the torch's shadow cube. `far` is the widest the range
 * slider goes rather than the current range, so widening the torch never needs
 * the projection rebuilt mid-frame; the depth range is short enough that
 * spending it this way costs nothing visible.
 */
const TORCH_SHADOW_NEAR = 8;

/**
 * Offset along the surface normal before the torch's depth lookup. The torch is
 * a metre from a body it is lighting from the side, which is the worst case for
 * shadow acne -- grazing angles everywhere -- and this is sized against a cube
 * texel at the far end of the light's reach.
 */
const TORCH_SHADOW_NORMAL_BIAS = 2.5;

/** Radius of the unlit meshes that mark each light's source. */
const FLAME_RADIUS = 5;
const ORB_RADIUS = 7;

/**
 * The isometric 3D view (spec 031): owns a three.js scene that draws the sim as
 * flat-shaded, blocky geometry under a single directional light. It reads sim
 * state and moves meshes to match -- no game rules here. The look is forced
 * retro on purpose: the WebGL canvas renders at a low internal resolution and
 * is upscaled with `image-rendering: pixelated`, antialiasing is off, every
 * material is single-colour flat-shaded, and the finished image goes through the
 * dither/quantization post filter (spec 038) that gives flat colours their weave.
 *
 * For the MOBA move order (spec 028) it also raycasts the cursor onto the ground
 * so a screen right-click becomes a world point (`screenToWorld`).
 *
 * The canvas fills the game window (spec 041) and re-sizes with it: the internal
 * buffer keeps a fixed pixel height and takes the window's aspect, so the chunky
 * pixels stay the same size on any window shape and a wider window simply frames
 * more ground to the sides.
 */

export class IsoScene {
  /** Camera/light control panel (spec 033); mount `.controls.element` over the canvas. */
  readonly controls: ViewControls = createViewControls();
  private readonly renderer: THREE.WebGLRenderer;
  // The retro dither/quantization post filter the finished frame goes through
  // (spec 038); `resize` keeps its buffer matched to the window.
  private readonly retro = new RetroPass(1, 1);
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly sun = new THREE.DirectionalLight(FIXED_DAYLIGHT.lightColor, FIXED_DAYLIGHT.lightIntensity);
  // The sky fill. A field, not an inline `add`, because the day/night cycle
  // retunes its colour and intensity every frame (spec 047).
  private readonly ambient = new THREE.AmbientLight(
    FIXED_DAYLIGHT.ambientColor,
    FIXED_DAYLIGHT.ambientIntensity,
  );
  // The background colour, likewise driven by the clock.
  private readonly background = new THREE.Color(PALETTE.sky);
  /**
   * The player's torch (spec 047): a point light parented to the rig, so it
   * travels and turns with them. It casts -- that is what separates it from the
   * orb below, and the swinging shadows are most of the reason to carry one.
   */
  private readonly torch = new THREE.PointLight(TORCH_COLOR, 0, TORCH_DEFAULTS.range);
  private readonly torchFlame: THREE.Mesh;
  // Whether the torch's cube shadow map is currently switched on. Tracked so
  // the flag is only written when it changes: three allocates the cube map on
  // the first frame `castShadow` is true, and rewriting it every frame would
  // keep asking for that work.
  private torchShadowsOn = true;
  /**
   * The floating magic light (spec 047): the deliberate opposite of the torch.
   * `castShadow` stays false for the whole life of the scene -- it only raises
   * the light level within its range, which is what makes it read as conjured
   * fill rather than as a second lantern. Positioned in world space rather than
   * parented to the rig, so its orbit is its own and does not spin when the
   * player turns on the spot.
   */
  private readonly orb = new THREE.PointLight(MAGIC_COLOR, 0, 0);
  private readonly orbMesh: THREE.Mesh;
  // Real seconds since the scene opened, driving the flame and the orb. Purely
  // cosmetic, like the rest of this class -- the sim keeps its own tick count.
  private elapsed = 0;
  // Seeds the flame, so two scenes on different seeds gutter differently.
  private readonly lightSeed: number;
  // Overlay marking scenery footprints as unwalkable; toggled via the controls (spec 034).
  private readonly unwalkable = new THREE.Group();
  // Eased camera framing: the current offset/zoom glide toward the control values.
  private readonly camOffsetCurrent = new THREE.Vector3(
    DEFAULT_CAMERA_OFFSET.x,
    DEFAULT_CAMERA_OFFSET.y,
    DEFAULT_CAMERA_OFFSET.z,
  );
  private readonly camOffsetTarget = new THREE.Vector3();
  private halfWidth = DEFAULT_VIEW_HALF_WIDTH;
  private lastHalfWidth = -1;
  // View span the sun's shadow camera was last sized for (spec 045); it is
  // resized only when the zoom has actually moved, not every eased frame.
  private shadowHalfWidth = -1;
  // Reused each frame to aim the sun without allocating.
  private readonly sunDirection = new THREE.Vector3();
  // Internal buffer the canvas was last sized for, so a resize is detected cheaply.
  private renderW = 0;
  private renderH = 0;
  private aspect = 1;
  private readonly playerRig = new PlayerRig();
  private readonly playerOutline: OutlineHandle;
  private readonly poofs: Poofs;
  private readonly moveMarker: THREE.Mesh;
  // Ground markers for the destinations stacked behind the standing order (spec 040).
  private readonly queuedMarkers: THREE.Mesh[] = [];
  private readonly attackCone: THREE.Mesh;
  // Arc the attack-cone geometry is currently built for, so it rebuilds only on change.
  private coneArcHalf = -1;
  private readonly enemies = new Map<number, { rig: MechRig; outline: OutlineHandle }>();
  // Cursor in canvas CSS pixels, for the hover raycast; null when off the window.
  private cursorScreen: ScreenPoint | null = null;
  // Reused by the hover raycast so it allocates nothing per frame.
  private readonly hoverRaycaster = new THREE.Raycaster();
  private readonly hoverNdc = new THREE.Vector2();
  private readonly hoverTargets: HoverTarget[] = [];
  // The camera's look-at point: it trails the player rather than being pinned to
  // them (spec 039), and starts pinned so the first frame doesn't glide in.
  private readonly target = new THREE.Vector3(ARENA_WIDTH / 2, 0, ARENA_HEIGHT / 2);
  private targetPlaced = false;
  // Frame timing + player gait tracking for foot poofs (cosmetic, not sim state).
  private lastNow = performance.now();
  private prevPlayerPos: Vec2 | null = null;
  private playerStride = 0;
  private footfalls = 0;
  // The terrain the scene stands on (spec 043): pure data, meshed once here.
  private readonly terrain: TerrainWorld;
  // Every tree and bush in the world (spec 044). The sim collides against this
  // same list -- `worldColliders` hands it over -- so what is drawn is what blocks.
  private readonly vegetation: readonly Prop[];
  private readonly terrainPick: THREE.Object3D[];
  // Reused across cursor raycasts so screenToWorld allocates nothing per frame.
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundNdc = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();
  private readonly terrainHits: THREE.Intersection[] = [];
  // Last ground pick, keyed by everything it depends on. The fixed-timestep loop
  // asks for the cursor's world point once per *tick* -- up to eight times in one
  // frame -- with the cursor and camera unchanged between them, so without this
  // the terrain gets raycast eight times over for one answer.
  private readonly pickCache = {
    cssX: NaN, cssY: NaN, camX: NaN, camY: NaN, camZ: NaN, hw: NaN, w: NaN, h: NaN, x: 0, y: 0,
  };

  constructor(readonly canvas: HTMLCanvasElement, seed: number) {
    // The canvas fills whatever box the game window gives it; the internal buffer
    // is set by `resize` from that box (spec 041).
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.display = 'block';

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(1);
    // Hard, unfiltered shadows (spec 045): `BasicShadowMap` does one depth
    // comparison per pixel, so an edge is a step between lit and unlit rather
    // than a gradient -- the only kind that belongs in a posterized frame.
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
    this.resize();

    // A single directional light (movable via the controls, spec 033), plus a
    // soft ambient fill so shadowed faces stay in-palette (not black).
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    // A directional light points from its position at its target, and the target
    // has to be in the graph for its world matrix to be kept up to date.
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    // Cool sky fill. Stronger here than in the sandboxes (spec 045): with the
    // sun casting, a shadowed surface is lit by this and nothing else, and at
    // the intensity tuned for an unshadowed scene the shade crushed to a
    // near-black that swallowed the palette. Cool rather than warm on purpose,
    // so shade reads as sky bouncing into it and holds against the warm sun.
    // The day/night cycle moves both its colour and its level (spec 047).
    this.scene.add(this.ambient);

    // The world's terrain (spec 043). Its bounds bleed well past the play area
    // so the camera never frames the void beyond the arena edge while following
    // the player, even at the widest zoom.
    this.terrain = createArenaWorld(seed);
    this.vegetation = worldVegetation(seed, this.terrain);
    const terrainMesh = buildTerrainMesh(this.terrain);
    this.terrainPick = terrainMesh.pickTargets;
    this.scene.add(terrainMesh.group);
    this.addScenery();
    this.addWalls();
    this.scene.add(this.unwalkable);

    this.scene.add(this.playerRig.group);
    castsShadows(this.playerRig.group);
    this.playerOutline = attachOutline(this.playerRig.group);

    // The player's lights go on after `castsShadows` and `attachOutline`, so
    // neither touches them: a light source that cast its own shadow onto the
    // world, or wore a white hover outline, would be wrong on both counts.
    this.lightSeed = seed;
    this.torchFlame = this.buildTorch();
    this.orbMesh = this.buildOrb();

    this.poofs = new Poofs(this.scene);
    this.moveMarker = makeMoveMarker();
    this.moveMarker.visible = false;
    this.scene.add(this.moveMarker);
    this.attackCone = makeAttackCone();
    this.scene.add(this.attackCone);

    // The wheel over the view is the zoom, alongside the panel's slider (spec 042).
    this.controls.attachWheelZoom(canvas);
  }

  /**
   * Build the torch (spec 047) and hang it off the player rig, so it inherits
   * their position and heading for free -- the flame is carried, not followed.
   * Returns the unlit flame mesh that marks where the light is coming from.
   */
  private buildTorch(): THREE.Mesh {
    this.torch.castShadow = true;
    this.torch.shadow.mapSize.set(TORCH_SHADOW_MAP_SIZE, TORCH_SHADOW_MAP_SIZE);
    this.torch.shadow.camera.near = TORCH_SHADOW_NEAR;
    this.torch.shadow.camera.far = MAX_LIGHT_RANGE;
    this.torch.shadow.normalBias = TORCH_SHADOW_NORMAL_BIAS;
    this.torch.position.set(TORCH_ANCHOR.x, TORCH_ANCHOR.y, TORCH_ANCHOR.z);
    this.playerRig.group.add(this.torch);

    // Unlit, so the flame stays the brightest thing in frame at midnight
    // instead of being shaded by the very light it is emitting.
    const flame = new THREE.Mesh(
      new THREE.IcosahedronGeometry(FLAME_RADIUS, 0),
      new THREE.MeshBasicMaterial({ color: PALETTE.torchCore }),
    );
    flame.position.copy(this.torch.position);
    this.playerRig.group.add(flame);
    return flame;
  }

  /** Build the magic orb (spec 047). It lives in world space, not on the rig. */
  private buildOrb(): THREE.Mesh {
    // Never set to true anywhere, on purpose: casting no shadow is the whole
    // point of this light.
    this.orb.castShadow = false;
    this.scene.add(this.orb);

    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(ORB_RADIUS, 0),
      new THREE.MeshBasicMaterial({ color: PALETTE.magicCore }),
    );
    this.scene.add(mesh);
    return mesh;
  }

  /**
   * Match the internal buffer to the canvas's CSS box (spec 041). The buffer
   * keeps a fixed pixel height, so growing the window enlarges the framed area
   * rather than the pixels; the camera's vertical span is held constant and its
   * width follows the aspect. Cheap to call every frame: it early-outs unless
   * the box actually changed.
   */
  private resize(): void {
    const cssWidth = this.canvas.clientWidth || this.canvas.width || 1;
    const cssHeight = this.canvas.clientHeight || this.canvas.height || 1;
    const size = internalRenderSize(cssWidth, cssHeight);
    if (size.width === this.renderW && size.height === this.renderH) return;
    this.renderW = size.width;
    this.renderH = size.height;
    this.aspect = size.width / size.height;
    this.renderer.setSize(size.width, size.height, false);
    this.retro.setSize(size.width, size.height);
    this.lastHalfWidth = -1; // force the frustum to be rebuilt for the new aspect
  }

  /**
   * The static world the sim should collide against (spec 044): the arena's
   * walls plus every tree and bush this scene drew. Handed to `initCombat` so
   * the sim blocks on exactly the scenery the player can see.
   */
  worldColliders(): WorldColliders {
    return createWorldColliders(ARENA_OBSTACLES, vegetationColliders(this.vegetation));
  }

  /**
   * The arena's static walls (spec 037), straight from the sim's obstacle list.
   * Each is sunk to the lowest terrain under its footprint so a wall crossing a
   * slope still meets the ground along its whole length (spec 043).
   */
  private addWalls(): void {
    for (const rect of ARENA_OBSTACLES) {
      const wall = makeWall(rect.w, rect.h);
      wall.position.set(rect.x, this.lowestGroundIn(rect.x, rect.y, rect.w, rect.h), rect.y);
      castsShadows(wall);
      this.scene.add(wall);
    }
  }

  /** The lowest terrain height sampled over a footprint's corners and centre. */
  private lowestGroundIn(x: number, z: number, w: number, d: number): number {
    let low = Infinity;
    for (const [sx, sz] of [
      [x, z],
      [x + w, z],
      [x, z + d],
      [x + w, z + d],
      [x + w / 2, z + d / 2],
    ] as const) {
      low = Math.min(low, this.terrain.heightAt(sx, sz));
    }
    return low;
  }

  /**
   * Draw the world's vegetation (spec 043/044). The list itself comes from
   * `worldVegetation` -- the same list the sim is colliding against, since a
   * tree drawn here blocks the way a wall does -- and goes into one instanced
   * field, so the whole world's trees and bushes cost a handful of draw calls.
   * The unwalkable overlay marks every one of them.
   */
  private addScenery(): void {
    const field = buildPropField(this.vegetation, (x, z) => this.terrain.heightAt(x, z));
    this.scene.add(field.group);
    this.unwalkable.add(
      makeUnwalkableField(vegetationColliders(this.vegetation), (x, z) => this.terrain.heightAt(x, z)),
    );
  }

  /**
   * Raycast the cursor (in canvas CSS pixels) onto the ground, returning the
   * world point for a MOBA move order / aim target. The pick is against the
   * terrain mesh itself (spec 043), so clicking the side of a hill orders a move
   * to the spot the cursor is actually over rather than to where the y=0 plane
   * happens to be behind it; the flat plane stays the fallback for a ray that
   * misses the world entirely. The display size (not the low internal
   * resolution) sets the NDC so upscaling doesn't skew the pick.
   */
  screenToWorld(cssX: number, cssY: number): Vec2 {
    const cache = this.pickCache;
    const cam = this.camera.position;
    if (
      cache.cssX === cssX &&
      cache.cssY === cssY &&
      cache.camX === cam.x &&
      cache.camY === cam.y &&
      cache.camZ === cam.z &&
      cache.hw === this.halfWidth &&
      cache.w === this.renderW &&
      cache.h === this.renderH
    ) {
      return { x: cache.x, y: cache.y };
    }

    const rect = this.canvas.getBoundingClientRect();
    const ndc = cursorToNdc(cssX, cssY, rect.width, rect.height);
    this.raycaster.setFromCamera(this.groundNdc.set(ndc.x, ndc.y), this.camera);

    this.terrainHits.length = 0;
    this.raycaster.intersectObjects(this.terrainPick, false, this.terrainHits);
    const ground = this.terrainHits[0];
    const point = ground ? ground.point : this.raycaster.ray.intersectPlane(this.groundPlane, this.hit);
    const world = point ? { x: point.x, y: point.z } : { x: this.target.x, y: this.target.z };

    cache.cssX = cssX;
    cache.cssY = cssY;
    cache.camX = cam.x;
    cache.camY = cam.y;
    cache.camZ = cam.z;
    cache.hw = this.halfWidth;
    cache.w = this.renderW;
    cache.h = this.renderH;
    cache.x = world.x;
    cache.y = world.y;
    return world;
  }

  /** World ground position -> isometric screen point (for optional 2D overlays). */
  worldToScreen(pos: Vec2, params?: IsoParams): Vec2 {
    return worldToIso(pos, params);
  }

  /**
   * Tell the scene where the cursor is, in canvas CSS pixels, so the unit under
   * it gets its white outline (spec 041). The pick is a raycast against the
   * models, so pointing at a unit's *body* hovers it, not only its feet. Pass
   * null when the cursor is off the game window. Cosmetic only -- hovering
   * changes nothing in the sim.
   */
  setCursorScreen(point: ScreenPoint | null): void {
    this.cursorScreen = point;
  }

  render(state: CombatState): void {
    this.resize();
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    // Cosmetic clocks: the flame's own time, and the day/night cycle's hour
    // (spec 047). Both run on real elapsed time, never on sim ticks.
    this.elapsed += dt;
    this.controls.advanceClock(dt);

    const p = state.player;
    // The sim is still flat (spec 043): terrain decides only how high a unit is
    // *drawn*, never where it is. Sim positions stay 2D and terrain-unaware.
    const playerY = this.terrain.heightAt(p.position.x, p.position.y);
    this.playerRig.group.position.set(p.position.x, playerY, p.position.y);
    // Orient by the sim's heading (spec 028): a mesh built facing +x maps to
    // world facing `theta` at rotation.y = -theta.
    this.playerRig.group.rotation.y = -p.facing;

    const moved = this.prevPlayerPos ? Math.hypot(p.position.x - this.prevPlayerPos.x, p.position.y - this.prevPlayerPos.y) : 0;
    this.prevPlayerPos = { x: p.position.x, y: p.position.y };
    this.playerRig.update(dt, moved);
    this.spawnFootPoofs(p.position, p.facing, moved, playerY);
    this.poofs.update(dt);

    if (p.moveTarget) {
      this.moveMarker.visible = true;
      this.moveMarker.position.set(
        p.moveTarget.x,
        this.terrain.heightAt(p.moveTarget.x, p.moveTarget.y) + 6,
        p.moveTarget.y,
      );
    } else {
      this.moveMarker.visible = false;
    }
    this.updateQueuedMarkers(p.moveQueue);

    this.updateAttackCone(state);
    this.syncEnemies(state, dt);
    this.applyPlayerLights(p.position, playerY);

    // Trail the player (spec 039), framed by the camera/light controls (spec 033).
    this.followPlayer(p.position, playerY, dt);
    this.applyControls();
    this.camera.lookAt(this.target);

    // Hovering is picked against this frame's camera and posed rigs, so the
    // outline tracks the models exactly as they are about to be drawn.
    this.camera.updateMatrixWorld();
    this.scene.updateMatrixWorld();
    this.updateHover(state);

    this.retro.set(this.controls.retro());
    this.retro.setGrade(this.controls.grade());
    this.retro.render(this.renderer, this.scene, this.camera);
  }

  /**
   * Ease the camera's look-at point toward the unit instead of pinning it there
   * (spec 039), so the unit pulls ahead of the frame as it starts moving and
   * settles back when it stops. The easing is derived from the frame's elapsed
   * time, so the trailing distance is the same at any frame rate. The first
   * frame snaps -- otherwise the view would open by gliding in from the arena
   * centre.
   *
   * The look-at point tracks the unit's terrain height too (spec 043), so
   * walking up a hill moves the world under the unit rather than sliding the
   * unit up the screen.
   */
  private followPlayer(position: Vec2, groundY: number, dt: number): void {
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

  /**
   * Read the control panel (spec 033/034): ease the camera offset and ortho zoom
   * toward the slider values (so changes glide instead of snapping), swing the sun
   * to the light offset, and show/hide the unwalkable-terrain overlay. The camera
   * still only follows; it never rotates the world, so screen->world picking stays
   * a plain projection.
   */
  private applyControls(): void {
    const off = this.controls.cameraOffset();
    this.camOffsetTarget.set(off.x, off.y, off.z);
    this.camOffsetCurrent.lerp(this.camOffsetTarget, CAMERA_SMOOTH);
    this.camera.position.copy(this.target).add(this.camOffsetCurrent);

    const targetHalfWidth = this.controls.viewHalfWidth();
    this.halfWidth += (targetHalfWidth - this.halfWidth) * CAMERA_SMOOTH;
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

  /**
   * Aim the sun and drag its shadow camera along with the view (spec 045),
   * taking its direction, colour and level from whichever source owns it: the
   * day/night clock, or the panel's manual sliders when the cycle is off
   * (spec 047).
   *
   * The direction is a *direction* -- a unit-ish offset whose length says
   * nothing -- so the sun is placed that far up it from the point the camera is
   * looking at, and aimed back at it. Both have to follow the target: an
   * orthographic shadow camera only covers the box it is given, and one pinned
   * to the arena centre would drop every shadow the moment the player walked
   * out of it.
   */
  private applySun(): void {
    const shadow = this.controls.dayNightEnabled() ? this.applyCycleSun() : this.applyManualSun();

    // The horizon effect's last say (spec 047): below the horizon nothing casts
    // at all, which is also what keeps the moon from throwing hard black
    // shadows across a scene the torch is supposed to be lighting.
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

  /**
   * The sun as the day/night clock has it (spec 047): direction, colour, level
   * and sky all read off the hour. The direction already carries the horizon
   * effect's elevation clamp, so a sunset lengthens shadows only up to the
   * bound and then stops.
   *
   * The clock's colours arrive as unrounded sRGB channels rather than packed
   * hex (spec 047), so they are applied with `setRGB` and the colour space
   * named explicitly -- `setHex` assumes sRGB, `setRGB` assumes the working
   * space, and the two would differ silently otherwise.
   */
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

  /**
   * The sun where the panel's `Direction`/`Elevation` sliders put it (spec
   * 033), at the fixed daylight the view had before the clock existed. Colour
   * and level are restored explicitly rather than left wherever the cycle last
   * set them -- otherwise unticking the cycle at midnight would leave a
   * moon-blue "sun" pointing wherever the sliders happen to be.
   *
   * The horizon effect applies here too. The `Elevation` slider bottoms out at
   * 10 degrees, above the 8-degree floor, so this changes no direction the
   * slider can reach; what it does add is the contrast fade at the shallow end,
   * where a hand-placed sun has the same over-long shadows a setting one does.
   */
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
   * Pose and burn the player's two lights (spec 047).
   *
   * The torch is parented to the rig, so only its flicker offset is written
   * here; the orb is in world space and is placed against the player's feet. An
   * invisible light is skipped by the renderer entirely, so switching either
   * off costs nothing -- which matters most for the torch, whose shadow is a
   * cube map and therefore six extra passes over the scene.
   */
  private applyPlayerLights(position: Vec2, groundY: number): void {
    const settings = this.controls.playerLights();

    this.torch.visible = settings.torchOn;
    this.torchFlame.visible = settings.torchOn;
    if (settings.torchOn) {
      const flame = torchFlicker(this.elapsed, this.lightSeed, settings.torchFlicker);
      this.torch.distance = settings.torchRange;
      this.torch.intensity = pointIntensity(settings.torchBrightness, settings.torchRange) * flame.intensity;
      this.torch.position.set(
        TORCH_ANCHOR.x + flame.sway.x,
        TORCH_ANCHOR.y + flame.sway.y,
        TORCH_ANCHOR.z + flame.sway.z,
      );
      // The flame mesh rides with the light and swells with it, so the thing
      // you can see and the thing doing the lighting are never out of step.
      this.torchFlame.position.copy(this.torch.position);
      const swell = 0.75 + 0.35 * flame.intensity;
      this.torchFlame.scale.set(swell, swell * 1.3, swell);

      if (settings.torchShadows !== this.torchShadowsOn) {
        this.torch.castShadow = settings.torchShadows;
        this.torchShadowsOn = settings.torchShadows;
      }
    }

    this.orb.visible = settings.magicOn;
    this.orbMesh.visible = settings.magicOn;
    if (settings.magicOn) {
      const orb = orbState(this.elapsed);
      this.orb.distance = settings.magicRange;
      this.orb.intensity = pointIntensity(settings.magicBrightness, settings.magicRange) * orb.intensity;
      this.orb.position.set(
        position.x + orb.offset.x,
        groundY + orb.offset.y,
        position.y + orb.offset.z,
      );
      this.orbMesh.position.copy(this.orb.position);
    }
  }

  /**
   * Drop a dust poof under whichever foot just planted. A footfall happens every
   * half stride; the plant alternates feet, so the poof sits under that foot --
   * a little behind the hero, offset to that side, rotated into world space by
   * the heading. Capped per frame so a big jump (a dash) can't spew a burst.
   */
  private spawnFootPoofs(pos: Vec2, facing: number, moved: number, groundY: number): void {
    if (moved <= 0.03) return;
    const halfStride = PlayerRig.STRIDE / 2;
    let guard = 0;
    while (this.playerStride + moved >= (this.footfalls + 1) * halfStride && guard++ < 3) {
      this.footfalls += 1;
      const side = this.footfalls % 2 === 0 ? -1 : 1;
      const lx = -4;
      const lz = side * PlayerRig.FOOT_SPREAD;
      const wx = pos.x + lx * Math.cos(facing) - lz * Math.sin(facing);
      const wz = pos.y + lx * Math.sin(facing) + lz * Math.cos(facing);
      this.poofs.spawn(wx, wz, groundY);
    }
    this.playerStride += moved;
  }

  /**
   * The charging attack cone (spec 028): while an attack is pending, the unit
   * turns to face the aim and then winds up. The wedge is oriented to the aim,
   * grows and brightens as the animation nears its release, and vanishes on fire
   * or when a move cancels it -- so the turn-to-attack and the cancel window read.
   */
  private updateAttackCone(state: CombatState): void {
    const pa = state.player.pendingAttack;
    if (!pa) {
      this.attackCone.visible = false;
      return;
    }
    const cone = pa.effect.spells.find((s) => s.kind === 'cone');
    const range = cone && cone.kind === 'cone' ? cone.range : 90;
    const arcHalf = cone && cone.kind === 'cone' ? Math.acos(Math.sqrt(cone.arcCosSq)) : Math.PI / 5;
    if (arcHalf !== this.coneArcHalf) {
      this.attackCone.geometry.dispose();
      this.attackCone.geometry = sectorGeometry(arcHalf);
      this.coneArcHalf = arcHalf;
    }
    // 0 while still turning (fireAtTick 0), then ramps 0..1 across the animation.
    const charge = pa.fireAtTick === 0 ? 0 : 1 - Math.max(0, pa.fireAtTick - state.tick) / ATTACK_ANIM_TICKS;
    const r = range * (0.4 + 0.6 * charge);
    const { x, y } = state.player.position;
    this.attackCone.visible = true;
    this.attackCone.position.set(x, this.terrain.heightAt(x, y) + 2, y);
    this.attackCone.rotation.y = -Math.atan2(pa.effect.aimY, pa.effect.aimX);
    this.attackCone.scale.set(r, 1, r);
    (this.attackCone.material as THREE.MeshBasicMaterial).opacity = 0.1 + 0.28 * charge;
  }

  private syncEnemies(state: CombatState, dt: number): void {
    const live = new Set<number>();
    for (const enemy of state.enemies) {
      live.add(enemy.id);
      let entry = this.enemies.get(enemy.id);
      if (!entry) {
        const rig = new MechRig(enemy.type);
        entry = { rig, outline: attachOutline(rig.group) };
        this.enemies.set(enemy.id, entry);
        this.scene.add(rig.group);
        castsShadows(rig.group);
      }
      const rig = entry.rig;
      rig.group.position.set(
        enemy.position.x,
        this.terrain.heightAt(enemy.position.x, enemy.position.y),
        enemy.position.y,
      );
      const dir = { x: state.player.position.x - enemy.position.x, y: state.player.position.y - enemy.position.y };
      const ry = Math.atan2(-dir.y, dir.x);
      rig.group.rotation.y = ry;
      rig.update(dt, enemy.position, ry);
    }
    for (const [id, entry] of this.enemies) {
      if (!live.has(id)) {
        this.scene.remove(entry.rig.group);
        this.enemies.delete(id);
      }
    }
  }

  /**
   * Light the white outline on whichever unit's model the cursor is over (spec
   * 039), and only that one -- the frontmost model wins, so two overlapping
   * units never both light up.
   */
  private updateHover(state: CombatState): void {
    let hovered: number | null = null;
    if (this.cursorScreen) {
      const cursor = this.cursorScreen;
      const ndc = cursorToNdc(cursor.x, cursor.y, this.canvas.clientWidth, this.canvas.clientHeight);
      this.hoverNdc.set(ndc.x, ndc.y);
      this.hoverRaycaster.setFromCamera(this.hoverNdc, this.camera);

      this.hoverTargets.length = 0;
      this.hoverTargets.push({
        id: HOVER_PLAYER_ID,
        object: this.playerRig.group,
        position: state.player.position,
        radius: PLAYER_RADIUS,
      });
      for (const enemy of state.enemies) {
        const entry = this.enemies.get(enemy.id);
        if (entry) {
          this.hoverTargets.push({ id: enemy.id, object: entry.rig.group, position: enemy.position, radius: ENEMY_RADIUS });
        }
      }
      hovered = pickHoveredUnit(this.hoverRaycaster, this.hoverTargets, this.screenToWorld(cursor.x, cursor.y));
    }
    this.playerOutline.setVisible(hovered === HOVER_PLAYER_ID);
    for (const [id, entry] of this.enemies) entry.outline.setVisible(hovered === id);
  }

  /**
   * Drop a dimmer marker on each destination stacked behind the standing order
   * (spec 040), so a shift-clicked plan is visible. Markers are pooled: the list
   * only ever grows to the sim's queue cap.
   */
  private updateQueuedMarkers(queue: readonly Vec2[]): void {
    while (this.queuedMarkers.length < queue.length) {
      const marker = makeQueuedMoveMarker();
      this.queuedMarkers.push(marker);
      this.scene.add(marker);
    }
    this.queuedMarkers.forEach((marker, i) => {
      const point = queue[i];
      marker.visible = point !== undefined;
      if (point) marker.position.set(point.x, this.terrain.heightAt(point.x, point.y) + 5, point.y);
    });
  }
}
