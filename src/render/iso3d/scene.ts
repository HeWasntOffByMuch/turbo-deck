import * as THREE from 'three';
import { ARENA_HEIGHT, ARENA_WIDTH, ATTACK_ANIM_TICKS } from '../../sim/constants.js';
import type { CombatState, Vec2 } from '../../sim/types.js';
import { PALETTE } from './palette.js';
import {
  makeAttackCone,
  makeBush,
  makeEnemy,
  makeGround,
  makeHeadingArrow,
  makeMoveMarker,
  makePlayer,
  makeTree,
  sectorGeometry,
} from './meshes.js';
import { worldToIso, type IsoParams } from './projection.js';
import { scatterProps } from './scatter.js';

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

// Half-width of the world region the fixed ortho camera frames (world units).
const VIEW_HALF_WIDTH = 320;
// Fixed isometric offset from the followed target to the camera (world units).
const CAMERA_OFFSET = new THREE.Vector3(420, 520, 420);

export class IsoScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly player: THREE.Group;
  private readonly moveMarker: THREE.Mesh;
  private readonly attackCone: THREE.Mesh;
  // Arc the attack-cone geometry is currently built for, so it rebuilds only on change.
  private coneArcHalf = -1;
  private readonly enemies = new Map<number, THREE.Group>();
  private readonly target = new THREE.Vector3(ARENA_WIDTH / 2, 0, ARENA_HEIGHT / 2);
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
    this.camera = new THREE.OrthographicCamera(
      -VIEW_HALF_WIDTH,
      VIEW_HALF_WIDTH,
      VIEW_HALF_WIDTH / aspect,
      -VIEW_HALF_WIDTH / aspect,
      1,
      4000,
    );

    // A single directional light from the upper-left, like the reference art,
    // plus a soft ambient fill so shadowed faces stay in-palette (not black).
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
    sun.position.set(-0.6, 1.4, -0.5);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x8090a0, 1.1));

    // Bleed the ground well past the play bounds so the camera never frames the
    // void beyond the arena edge while following the player.
    const bleed = 600;
    const ground = makeGround(ARENA_WIDTH + bleed * 2, ARENA_HEIGHT + bleed * 2);
    ground.position.set(-bleed, 0, -bleed);
    this.scene.add(ground);
    this.addScenery(seed);

    this.player = makePlayer();
    this.player.add(makeHeadingArrow()); // parented: inherits the unit's facing
    this.scene.add(this.player);
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
    const p = state.player;
    this.player.position.set(p.position.x, 0, p.position.y);
    // Orient by the sim's heading (spec 028): a mesh built facing +x maps to
    // world facing `theta` at rotation.y = -theta.
    this.player.rotation.y = -p.facing;

    if (p.moveTarget) {
      this.moveMarker.visible = true;
      this.moveMarker.position.set(p.moveTarget.x, 6, p.moveTarget.y);
    } else {
      this.moveMarker.visible = false;
    }

    this.updateAttackCone(state);
    this.syncEnemies(state);

    // Fixed-angle follow: keep the player centred without rotating the camera.
    this.target.set(p.position.x, 0, p.position.y);
    this.camera.position.copy(this.target).add(CAMERA_OFFSET);
    this.camera.lookAt(this.target);

    this.renderer.render(this.scene, this.camera);
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

  private syncEnemies(state: CombatState): void {
    const live = new Set<number>();
    for (const enemy of state.enemies) {
      live.add(enemy.id);
      let g = this.enemies.get(enemy.id);
      if (!g) {
        g = makeEnemy(enemy.type);
        this.enemies.set(enemy.id, g);
        this.scene.add(g);
      }
      g.position.set(enemy.position.x, 0, enemy.position.y);
      const dir = { x: state.player.position.x - enemy.position.x, y: state.player.position.y - enemy.position.y };
      g.rotation.y = Math.atan2(-dir.y, dir.x);
    }
    for (const [id, g] of this.enemies) {
      if (!live.has(id)) {
        this.scene.remove(g);
        this.enemies.delete(id);
      }
    }
  }
}
