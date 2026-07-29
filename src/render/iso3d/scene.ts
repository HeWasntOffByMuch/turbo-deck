import * as THREE from 'three';
import { ARENA_HEIGHT, ARENA_WIDTH, ATTACK_ANIM_TICKS } from '../../sim/constants.js';
import type { CombatState, Vec2 } from '../../sim/types.js';
import { PALETTE } from './palette.js';
import {
  makeAttackCone,
  makeBush,
  makeGround,
  makeMoveMarker,
  makeTree,
  makeUnwalkableMarker,
  sectorGeometry,
} from './meshes.js';
import { MechRig, Poofs, PlayerRig } from './rigs.js';
import { worldToIso, type IsoParams } from './projection.js';
import { footprintRadius, scatterProps } from './scatter.js';
import { createViewControls, type ViewControls } from './view-controls.js';
import { DEFAULT_CAMERA_OFFSET, DEFAULT_VIEW_HALF_WIDTH } from './view-settings.js';

// Fraction of the gap to the target camera framing closed each rendered frame,
// so orbit/zoom slider changes glide instead of snapping (spec 034).
const CAMERA_SMOOTH = 0.15;

/**
 * The isometric 3D view (spec 031): owns a three.js scene that draws the sim as
 * flat-shaded, blocky geometry under a single directional light. It reads sim
 * state and moves meshes to match -- no game rules here. The look is forced
 * retro on purpose: the WebGL canvas renders at a low internal resolution and
 * is upscaled with `image-rendering: pixelated`, antialiasing is off, and every
 * material is single-colour flat-shaded.
 *
 * For the MOBA move order (spec 028) it also raycasts the cursor onto the ground
 * so a screen right-click becomes a world point (`screenToWorld`).
 */

// Low internal resolution, upscaled by CSS -> chunky pixels. 16:10 to suit iso.
const RENDER_W = 480;
const RENDER_H = 300;
const DISPLAY_W = 960;
const DISPLAY_H = 600;

export class IsoScene {
  /** Camera/light control panel (spec 033); mount `.controls.element` beside the canvas. */
  readonly controls: ViewControls = createViewControls();
  private readonly renderer: THREE.WebGLRenderer;
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
  private readonly playerRig = new PlayerRig();
  private readonly poofs: Poofs;
  private readonly moveMarker: THREE.Mesh;
  private readonly attackCone: THREE.Mesh;
  // Arc the attack-cone geometry is currently built for, so it rebuilds only on change.
  private coneArcHalf = -1;
  private readonly enemies = new Map<number, MechRig>();
  private readonly target = new THREE.Vector3(ARENA_WIDTH / 2, 0, ARENA_HEIGHT / 2);
  // Frame timing + player gait tracking for foot poofs (cosmetic, not sim state).
  private lastNow = performance.now();
  private prevPlayerPos: Vec2 | null = null;
  private playerStride = 0;
  private footfalls = 0;
  // Reused across cursor raycasts so screenToWorld allocates nothing per frame.
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();

  constructor(readonly canvas: HTMLCanvasElement, seed: number) {
    canvas.width = RENDER_W;
    canvas.height = RENDER_H;
    canvas.style.width = `${DISPLAY_W}px`;
    canvas.style.height = `${DISPLAY_H}px`;
    canvas.style.imageRendering = 'pixelated';
    canvas.style.display = 'block';
    canvas.style.borderRadius = '8px';
    canvas.style.boxShadow = '0 6px 24px rgba(0,0,0,.5)';

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(RENDER_W, RENDER_H, false);
    this.scene.background = new THREE.Color(PALETTE.sky);

    const aspect = RENDER_W / RENDER_H;
    const hw = DEFAULT_VIEW_HALF_WIDTH;
    this.camera = new THREE.OrthographicCamera(-hw, hw, hw / aspect, -hw / aspect, 1, 4000);

    // A single directional light (movable via the controls, spec 033), plus a
    // soft ambient fill so shadowed faces stay in-palette (not black).
    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0x8090a0, 1.1));

    // Bleed the ground well past the play bounds so the camera never frames the
    // void beyond the arena edge while following the player.
    const bleed = 600;
    const ground = makeGround(ARENA_WIDTH + bleed * 2, ARENA_HEIGHT + bleed * 2);
    ground.position.set(-bleed, 0, -bleed);
    this.scene.add(ground);
    this.addScenery(seed);
    this.scene.add(this.unwalkable);

    this.scene.add(this.playerRig.group);
    this.poofs = new Poofs(this.scene);
    this.moveMarker = makeMoveMarker();
    this.moveMarker.visible = false;
    this.scene.add(this.moveMarker);
    this.attackCone = makeAttackCone();
    this.scene.add(this.attackCone);
  }

  /** Deterministic trees + bushes, kept clear of the arena centre / spawn. */
  private addScenery(seed: number): void {
    const props = scatterProps(seed, ARENA_WIDTH, ARENA_HEIGHT, [
      { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 },
    ]);
    for (const prop of props) {
      const g = prop.kind === 'tree' ? makeTree() : makeBush();
      g.position.set(prop.x, 0, prop.y);
      g.scale.setScalar(prop.scale);
      g.rotation.y = prop.rotation;
      this.scene.add(g);

      // A ground footprint marking this prop as unwalkable terrain (spec 034).
      const r = footprintRadius(prop);
      const marker = makeUnwalkableMarker();
      marker.position.set(prop.x, 0, prop.y);
      marker.scale.set(r, 1, r);
      this.unwalkable.add(marker);
    }
  }

  /**
   * Raycast the cursor (in canvas CSS pixels) onto the ground plane, returning
   * the world point for a MOBA move order / aim target. The fixed camera makes
   * this a pure projection; the display size (not the low internal resolution)
   * sets the NDC so upscaling doesn't skew the pick.
   */
  screenToWorld(cssX: number, cssY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = (cssX / rect.width) * 2 - 1;
    const ndcY = -((cssY / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const point = this.raycaster.ray.intersectPlane(this.groundPlane, this.hit);
    if (!point) return { x: this.target.x, y: this.target.z };
    return { x: point.x, y: point.z };
  }

  /** World ground position -> isometric screen point (for optional 2D overlays). */
  worldToScreen(pos: Vec2, params?: IsoParams): Vec2 {
    return worldToIso(pos, params);
  }

  render(state: CombatState): void {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;

    const p = state.player;
    this.playerRig.group.position.set(p.position.x, 0, p.position.y);
    // Orient by the sim's heading (spec 028): a mesh built facing +x maps to
    // world facing `theta` at rotation.y = -theta.
    this.playerRig.group.rotation.y = -p.facing;

    const moved = this.prevPlayerPos ? Math.hypot(p.position.x - this.prevPlayerPos.x, p.position.y - this.prevPlayerPos.y) : 0;
    this.prevPlayerPos = { x: p.position.x, y: p.position.y };
    this.playerRig.update(dt, moved);
    this.spawnFootPoofs(p.position, p.facing, moved);
    this.poofs.update(dt);

    if (p.moveTarget) {
      this.moveMarker.visible = true;
      this.moveMarker.position.set(p.moveTarget.x, 6, p.moveTarget.y);
    } else {
      this.moveMarker.visible = false;
    }

    this.updateAttackCone(state);
    this.syncEnemies(state, dt);

    // Follow the player, framed by the current camera/light controls (spec 033).
    this.target.set(p.position.x, 0, p.position.y);
    this.applyControls();
    this.camera.lookAt(this.target);

    this.renderer.render(this.scene, this.camera);
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
      const aspect = RENDER_W / RENDER_H;
      const hw = this.halfWidth;
      this.camera.left = -hw;
      this.camera.right = hw;
      this.camera.top = hw / aspect;
      this.camera.bottom = -hw / aspect;
      this.camera.updateProjectionMatrix();
      this.lastHalfWidth = hw;
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
  private spawnFootPoofs(pos: Vec2, facing: number, moved: number): void {
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
      this.poofs.spawn(wx, wz);
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
    this.attackCone.visible = true;
    this.attackCone.position.set(state.player.position.x, 2, state.player.position.y);
    this.attackCone.rotation.y = -Math.atan2(pa.effect.aimY, pa.effect.aimX);
    this.attackCone.scale.set(r, 1, r);
    (this.attackCone.material as THREE.MeshBasicMaterial).opacity = 0.1 + 0.28 * charge;
  }

  private syncEnemies(state: CombatState, dt: number): void {
    const live = new Set<number>();
    for (const enemy of state.enemies) {
      live.add(enemy.id);
      let rig = this.enemies.get(enemy.id);
      if (!rig) {
        rig = new MechRig(enemy.type);
        this.enemies.set(enemy.id, rig);
        this.scene.add(rig.group);
      }
      rig.group.position.set(enemy.position.x, 0, enemy.position.y);
      const dir = { x: state.player.position.x - enemy.position.x, y: state.player.position.y - enemy.position.y };
      const ry = Math.atan2(-dir.y, dir.x);
      rig.group.rotation.y = ry;
      rig.update(dt, enemy.position, ry);
    }
    for (const [id, rig] of this.enemies) {
      if (!live.has(id)) {
        this.scene.remove(rig.group);
        this.enemies.delete(id);
      }
    }
  }
}
