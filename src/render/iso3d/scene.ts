import * as THREE from 'three';
import { ARENA_HEIGHT, ARENA_OBSTACLES, ARENA_WIDTH, ATTACK_ANIM_TICKS, ENEMY_RADIUS, PLAYER_RADIUS } from '../../sim/constants.js';
import type { CombatState, Vec2 } from '../../sim/types.js';
import { PALETTE } from './palette.js';
import {
  makeAttackCone,
  makeBush,
  makeMoveMarker,
  makeQueuedMoveMarker,
  makeTree,
  makeUnwalkableMarker,
  makeWall,
  sectorGeometry,
} from './meshes.js';
import { createArenaWorld, type TerrainWorld } from '../../terrain/index.js';
import { buildTerrainMesh } from './terrain-mesh.js';
import { attachOutline, type OutlineHandle } from './outline.js';
import { HOVER_PLAYER_ID, pickHoveredUnit, type HoverTarget } from './hover.js';
import type { ScreenPoint } from './input.js';
import { MechRig, Poofs, PlayerRig } from './rigs.js';
import { worldToIso, type IsoParams } from './projection.js';
import { footprintRadius, scatterProps } from './scatter.js';
import { createViewControls, type ViewControls } from './view-controls.js';
import { DEFAULT_CAMERA_OFFSET, DEFAULT_VIEW_HALF_WIDTH, followAlpha } from './view-settings.js';
import { cameraFrustum, cursorToNdc, internalRenderSize } from './view-frame.js';
import { RetroPass } from './retro-pass.js';

// Fraction of the gap to the target camera framing closed each rendered frame,
// so orbit/zoom slider changes glide instead of snapping (spec 034).
const CAMERA_SMOOTH = 0.15;

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
  private readonly sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
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
    this.scene.background = new THREE.Color(PALETTE.sky);

    const frustum = cameraFrustum(DEFAULT_VIEW_HALF_WIDTH, 1);
    this.camera = new THREE.OrthographicCamera(
      -frustum.halfWidth,
      frustum.halfWidth,
      frustum.halfHeight,
      -frustum.halfHeight,
      1,
      4000,
    );
    this.resize();

    // A single directional light (movable via the controls, spec 033), plus a
    // soft ambient fill so shadowed faces stay in-palette (not black).
    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0x8090a0, 1.1));

    // The world's terrain (spec 043). Its bounds bleed well past the play area
    // so the camera never frames the void beyond the arena edge while following
    // the player, even at the widest zoom.
    this.terrain = createArenaWorld(seed);
    const terrainMesh = buildTerrainMesh(this.terrain);
    this.terrainPick = terrainMesh.pickTargets;
    this.scene.add(terrainMesh.group);
    this.addScenery(seed);
    this.addWalls();
    this.scene.add(this.unwalkable);

    this.scene.add(this.playerRig.group);
    this.playerOutline = attachOutline(this.playerRig.group);
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
   * The arena's static walls (spec 037), straight from the sim's obstacle list.
   * Each is sunk to the lowest terrain under its footprint so a wall crossing a
   * slope still meets the ground along its whole length (spec 043).
   */
  private addWalls(): void {
    for (const rect of ARENA_OBSTACLES) {
      const wall = makeWall(rect.w, rect.h);
      wall.position.set(rect.x, this.lowestGroundIn(rect.x, rect.y, rect.w, rect.h), rect.y);
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

  /** Deterministic trees + bushes, kept clear of the arena centre / spawn. */
  private addScenery(seed: number): void {
    const props = scatterProps(seed, ARENA_WIDTH, ARENA_HEIGHT, [
      { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 },
    ]);
    for (const prop of props) {
      const g = prop.kind === 'tree' ? makeTree() : makeBush();
      const groundY = this.terrain.heightAt(prop.x, prop.y);
      g.position.set(prop.x, groundY, prop.y);
      g.scale.setScalar(prop.scale);
      g.rotation.y = prop.rotation;
      this.scene.add(g);

      // A ground footprint marking this prop as unwalkable terrain (spec 034).
      const r = footprintRadius(prop);
      const marker = makeUnwalkableMarker();
      marker.position.set(prop.x, groundY, prop.y);
      marker.scale.set(r, 1, r);
      this.unwalkable.add(marker);
    }
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

    const light = this.controls.lightOffset();
    this.sun.position.set(light.x, light.y, light.z);

    this.unwalkable.visible = this.controls.showUnwalkable();
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
