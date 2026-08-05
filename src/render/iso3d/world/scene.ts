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
import type { BuiltWorld } from '../../../server/world/build.js';
import type { ClientView } from '../../../server/client/game-client.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { abilityById } from '../../../server/data/abilities.js';
import { PALETTE } from '../palette.js';
import { castsShadows, makeUnwalkableField, makeWall } from '../meshes.js';
import { ARENA_OBSTACLES } from '../../../sim/constants.js';
import { vegetationColliders } from '../../../terrain/vegetation.js';
import { buildTerrainMesh, type TerrainMeshHandle } from '../terrain-mesh.js';
import { buildPropField, type PropFieldHandle } from '../props.js';
import { MechRig, PlayerRig, Poofs } from '../rigs.js';
import { attachOutline, type OutlineHandle } from '../outline.js';
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
import { cameraFrustum, cursorToNdc, internalRenderSize } from '../view-frame.js';
import {
  horizonShadow,
  shadowFillBoost,
  shadowFrame,
  shadowFrameStale,
  SHADOW_MAP_SIZE,
  type HorizonShadow,
} from '../shadow.js';
import { RetroPass } from '../retro-pass.js';
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
import { appearanceOf } from './appearance.js';
import { castBar } from './cast.js';
import { EntityMotion } from './interpolate.js';

/** Fraction of the gap to the target framing closed each frame (spec 034). */
const CAMERA_SMOOTH = 0.15;

const TORCH_SHADOW_MAP_SIZE = 512;
const TORCH_SHADOW_NEAR = 8;
const TORCH_SHADOW_NORMAL_BIAS = 2.5;
/** The ring under a ground-targeted cast. Warm red: it is about to hurt. */
const TELEGRAPH_COLOR = 0xff785a;

const FLAME_RADIUS = 5;
const ORB_RADIUS = 7;

/** What the view hands the scene each frame. All presentation, no state. */
export interface FrameInfo {
  /** Real seconds since the last frame, for animation. */
  readonly dt: number;
  /** How far through the current delta interval this frame is, in [0, 1]. */
  readonly alpha: number;
  /**
   * The sim tick to read cast bars against, fractional. Interpolated the same
   * way positions are, so a wind-up fills smoothly rather than in 20Hz steps.
   */
  readonly tick: number;
}

/** A body on screen, pooled by entity id. */
interface Body {
  readonly group: THREE.Group;
  readonly kind: 'player' | 'monster' | 'projectile';
  readonly player?: PlayerRig;
  readonly mech?: MechRig;
  readonly outline?: OutlineHandle;
  /** Last drawn ground position, for the gait's distance-moved input. */
  previous: Vec2 | null;
}

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
  private readonly unwalkable = new THREE.Group();

  private readonly terrainMesh: TerrainMeshHandle;
  private readonly propField: PropFieldHandle;
  private readonly poofs: Poofs;

  private readonly motion = new EntityMotion();
  private readonly bodies = new Map<number, Body>();
  private readonly telegraphs = new Map<number, THREE.Mesh>();
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

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();
  private readonly terrainHits: THREE.Intersection[] = [];
  private readonly projected = new THREE.Vector3();

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly world: BuiltWorld,
  ) {
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
    this.resize();

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.scene.add(this.sun, this.sun.target, this.ambient);

    // The ground and the trees the server is running, not a second scatter.
    this.terrainMesh = buildTerrainMesh(world.terrain);
    this.scene.add(this.terrainMesh.group);
    this.propField = buildPropField(world.props, (x, z) => world.terrain.heightAt(x, z));
    this.scene.add(this.propField.group);
    this.unwalkable.add(
      makeUnwalkableField(vegetationColliders(world.props), (x, z) => world.terrain.heightAt(x, z)),
    );
    this.scene.add(this.unwalkable);
    this.addWalls();

    this.torchFlame = this.buildTorch();
    this.orbMesh = this.buildOrb();
    this.poofs = new Poofs(this.scene);

    this.controls = createViewControls();
    this.controls.attachWheelZoom(canvas);
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
    this.raycaster.intersectObjects(this.terrainMesh.pickTargets, false, this.terrainHits);
    const ground = this.terrainHits[0];
    const hit = ground ? ground.point : this.raycaster.ray.intersectPlane(this.groundPlane, this.hit);
    return hit ? { x: hit.x, y: hit.z } : { x: this.target.x, y: this.target.z };
  }

  /** Where the bodies drawn last frame are on screen, for the DOM overlay. */
  screenAnchors(): readonly ScreenAnchor[] {
    return this.anchors;
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
    mesh.position.set(x, this.world.terrain.heightAt(x, y) + 1.5, y);
    this.scene.add(mesh);
    this.effects.push({ mesh, age: 0, ttl: Math.max(6, durationTicks) });
  }

  render(view: ClientView, frame: FrameInfo): void {
    this.resize();
    const dt = Math.min(0.05, Math.max(0, frame.dt));
    this.elapsed += dt;
    this.controls.advanceClock(dt);

    this.observe(view);
    this.syncBodies(view, frame, dt);
    this.carryTorch(view.selfEntityId);
    this.syncTelegraphs(view, frame);
    this.ageEffects();
    this.poofs.update(dt);

    // The camera follows the *predicted* self, not an interpolated replica: the
    // one body that must never lag its own input is this one.
    const me = view.self ?? { x: this.target.x, y: this.target.z };
    const groundY = this.world.terrain.heightAt(me.x, me.y);
    this.followSelf(me, groundY, dt);
    this.applyControls();
    this.applyPlayerLights(me, groundY);
    this.camera.lookAt(this.target);

    this.camera.updateMatrixWorld();
    this.scene.updateMatrixWorld();
    this.collectAnchors();

    this.retro.set(this.controls.retro());
    this.retro.setGrade(this.controls.grade());
    this.retro.render(this.renderer, this.scene, this.camera);
  }

  dispose(): void {
    for (const body of this.bodies.values()) this.scene.remove(body.group);
    this.bodies.clear();
    for (const effect of this.effects) this.scene.remove(effect.mesh);
    this.effects.length = 0;
    for (const mesh of this.telegraphs.values()) this.scene.remove(mesh);
    this.telegraphs.clear();
    this.terrainMesh.dispose();
    this.propField.dispose();
    this.renderer.dispose();
  }

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
      low = Math.min(low, this.world.terrain.heightAt(sx, sz));
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

    for (const entity of view.entities) {
      live.add(entity.id);
      const look = appearanceOf(entity);
      const body = this.bodyFor(entity.id, look.rig, look.typeId, look.radius);
      const isSelf = entity.id === view.selfEntityId;

      // The local player is drawn at its prediction; everything else at its
      // smoothed replica. Interpolating our own body would add a frame of lag to
      // the one thing that must feel immediate.
      const pose = this.motion.sample(entity.id, frame.alpha);
      const x = isSelf && view.self ? view.self.x : (pose?.x ?? entity.x);
      const y = isSelf && view.self ? view.self.y : (pose?.y ?? entity.y);
      const facing = pose?.facing ?? entity.facing;

      const ground =
        entity.kind === EntityKind.Projectile
          ? (pose?.z ?? entity.z)
          : this.world.terrain.heightAt(x, y);

      body.group.position.set(x, ground, y);
      // A mesh built facing +x sits at world heading `theta` when yawed -theta.
      body.group.rotation.y = -facing;

      const moved = body.previous ? Math.hypot(x - body.previous.x, y - body.previous.y) : 0;
      body.previous = { x, y };

      body.player?.update(dt, moved);
      body.mech?.update(dt, { x, y }, -facing);

      // A corpse lies where it fell and stops animating, so a kill reads.
      const dead = entity.maxHealth > 0 && entity.health <= 0;
      body.group.scale.setScalar(dead ? 0.6 : 1);
      body.outline?.setVisible(false);
    }

    for (const [id, body] of this.bodies) {
      if (live.has(id)) continue;
      this.scene.remove(body.group);
      this.bodies.delete(id);
    }
  }

  /** Hang the torch off the local player's rig; see {@link applyPlayerLights}. */
  private carryTorch(selfEntityId: number): void {
    const host = this.bodies.get(selfEntityId)?.group ?? null;
    if (host === this.torchHost) return;
    this.torchHost = host;
    // Before the first delta places us there is no rig to carry it; parking the
    // pair on the scene keeps them in the graph without lighting anything, since
    // both are hidden until the panel says otherwise.
    const parent = host ?? this.scene;
    parent.add(this.torch, this.torchFlame);
  }

  private bodyFor(id: number, rig: string, typeId: string, radius: number): Body {
    const existing = this.bodies.get(id);
    if (existing) return existing;

    let body: Body;
    if (rig === 'player') {
      const player = new PlayerRig();
      body = { group: player.group, kind: 'player', player, outline: attachOutline(player.group), previous: null };
    } else if (rig === 'projectile') {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(Math.max(3, radius), 0),
        new THREE.MeshBasicMaterial({ color: PALETTE.magicCore }),
      );
      group.add(mesh);
      body = { group, kind: 'projectile', previous: null };
    } else {
      const mech = new MechRig(typeId);
      body = { group: mech.group, kind: 'monster', mech, outline: attachOutline(mech.group), previous: null };
    }

    this.scene.add(body.group);
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
        this.world.terrain.heightAt(cast.targetX, cast.targetY) + 1.2,
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
      const flame = torchFlicker(this.elapsed, this.world.seed, settings.torchFlicker);
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
      this.projected.y += 46;
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
