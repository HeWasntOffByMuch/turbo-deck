import * as THREE from 'three';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../../sim/constants.js';
import type { CombatState, Vec2 } from '../../sim/types.js';
import { PALETTE } from './palette.js';
import { makeBush, makeEnemy, makeGround, makePlayer, makeTree } from './meshes.js';
import { worldToIso, type IsoParams } from './projection.js';
import { scatterProps } from './scatter.js';

/**
 * The isometric 3D view (spec 018): owns a three.js scene that draws the sim as
 * flat-shaded, blocky geometry under a single directional light. It reads sim
 * state and moves meshes to match -- no game rules here. The look is forced
 * retro on purpose: the WebGL canvas renders at a low internal resolution and
 * is upscaled with `image-rendering: pixelated`, antialiasing is off, and
 * every material is single-colour flat-shaded.
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
  private readonly enemies = new Map<number, THREE.Group>();
  private readonly target = new THREE.Vector3(ARENA_WIDTH / 2, 0, ARENA_HEIGHT / 2);
  private facing = 0;

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
    this.scene.add(this.player);
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

  /** World ground position -> isometric screen point (for optional 2D overlays). */
  worldToScreen(pos: Vec2, params?: IsoParams): Vec2 {
    return worldToIso(pos, params);
  }

  render(state: CombatState): void {
    const p = state.player;
    this.player.position.set(p.position.x, 0, p.position.y);
    if (p.attackAimX !== 0 || p.attackAimY !== 0) {
      this.facing = Math.atan2(-p.attackAimY, p.attackAimX);
    }
    this.player.rotation.y = this.facing;

    this.syncEnemies(state);

    // Fixed-angle follow: keep the player centred without rotating the camera.
    this.target.set(p.position.x, 0, p.position.y);
    this.camera.position.copy(this.target).add(CAMERA_OFFSET);
    this.camera.lookAt(this.target);

    this.renderer.render(this.scene, this.camera);
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
