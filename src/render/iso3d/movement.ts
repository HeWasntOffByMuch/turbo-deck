import * as THREE from 'three';
import { initCombat, step } from '../../sim/combat.js';
import { characterAt } from '../../sim/characters.js';
import { ARENA_HEIGHT, ARENA_WIDTH, TICK_RATE } from '../../sim/constants.js';
import type { CombatState, InputFrame, Vec2 } from '../../sim/types.js';
import { IsoInputCapture } from './input.js';
import { PALETTE } from './palette.js';
import { makeBush, makeGround, makeHeadingArrow, makeMoveMarker, makeTree } from './meshes.js';
import { MechRig } from './rigs.js';
import { scatterProps } from './scatter.js';
import { createViewControls, type ViewControls } from './view-controls.js';
import { DEFAULT_VIEW_HALF_WIDTH } from './view-settings.js';

/**
 * The movement sandbox tab (spec 032): no game -- just one controllable mech
 * driven through the sim's MOBA movement so the turn-rate rules and the mech's
 * ground-locking spider legs can be watched in isolation. It reuses the
 * deterministic combat sim (no enemies, no ambient spawner) and only ever feeds
 * it movement inputs: a right-click move order and C to cycle the movement
 * archetype. All game rules stay in the sim; this layer only reads state.
 */

// Same low-res, upscaled retro look and fixed iso follow-camera as the combat view.
const RENDER_W = 480;
const RENDER_H = 300;
const DISPLAY_W = 960;
const DISPLAY_H = 600;
const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

/** A minimal three.js scene: ground + scenery + one controllable mech. */
class MovementScene {
  /** Camera/light control panel (spec 033); mount `.controls.element` beside the canvas. */
  readonly controls: ViewControls = createViewControls();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
  private readonly camOffset = new THREE.Vector3();
  private lastHalfWidth = -1;
  private readonly mech = new MechRig('ally', PALETTE.mechAlly);
  private readonly moveMarker: THREE.Mesh;
  private readonly target = new THREE.Vector3(ARENA_WIDTH / 2, 0, ARENA_HEIGHT / 2);
  private lastNow = performance.now();
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

    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0x8090a0, 1.1));

    const bleed = 600;
    const ground = makeGround(ARENA_WIDTH + bleed * 2, ARENA_HEIGHT + bleed * 2);
    ground.position.set(-bleed, 0, -bleed);
    this.scene.add(ground);
    this.addScenery(seed);

    // A heading arrow parented to the mech reads its facing (turn-rate movement).
    this.mech.group.add(makeHeadingArrow());
    this.scene.add(this.mech.group);
    this.moveMarker = makeMoveMarker();
    this.moveMarker.visible = false;
    this.scene.add(this.moveMarker);
  }

  private addScenery(seed: number): void {
    const props = scatterProps(seed, ARENA_WIDTH, ARENA_HEIGHT, [{ x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 }]);
    for (const prop of props) {
      const g = prop.kind === 'tree' ? makeTree() : makeBush();
      g.position.set(prop.x, 0, prop.y);
      g.scale.setScalar(prop.scale);
      g.rotation.y = prop.rotation;
      this.scene.add(g);
    }
  }

  /** Raycast the cursor (canvas CSS pixels) onto the ground for a move order. */
  screenToWorld(cssX: number, cssY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = (cssX / rect.width) * 2 - 1;
    const ndcY = -((cssY / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const point = this.raycaster.ray.intersectPlane(this.groundPlane, this.hit);
    if (!point) return { x: this.target.x, y: this.target.z };
    return { x: point.x, y: point.z };
  }

  render(state: CombatState): void {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;

    const p = state.player;
    // A mesh built facing +x maps to world facing `theta` at rotation.y = -theta.
    const ry = -p.facing;
    this.mech.group.position.set(p.position.x, 0, p.position.y);
    this.mech.group.rotation.y = ry;
    this.mech.update(dt, p.position, ry);

    if (p.moveTarget) {
      this.moveMarker.visible = true;
      this.moveMarker.position.set(p.moveTarget.x, 6, p.moveTarget.y);
    } else {
      this.moveMarker.visible = false;
    }

    this.target.set(p.position.x, 0, p.position.y);
    this.applyControls();
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  /** Place the camera/light and refresh the ortho zoom from the panel (spec 033). */
  private applyControls(): void {
    const off = this.controls.cameraOffset();
    this.camOffset.set(off.x, off.y, off.z);
    this.camera.position.copy(this.target).add(this.camOffset);

    const hw = this.controls.viewHalfWidth();
    if (hw !== this.lastHalfWidth) {
      const aspect = RENDER_W / RENDER_H;
      this.camera.left = -hw;
      this.camera.right = hw;
      this.camera.top = hw / aspect;
      this.camera.bottom = -hw / aspect;
      this.camera.updateProjectionMatrix();
      this.lastHalfWidth = hw;
    }

    const light = this.controls.lightOffset();
    this.sun.position.set(light.x, light.y, light.z);
  }
}

/** A mounted view the tab shell can pause: its loop and input stop when hidden. */
export interface ViewHandle {
  readonly element: HTMLElement;
  start(): void;
  stop(): void;
}

/**
 * Mount the movement sandbox into `container`, returning a start/stop handle. The
 * fixed-timestep loop is identical to the combat view's: real elapsed time
 * becomes whole ticks, inputs are fed one tick at a time, and the scene only
 * reads the resulting state.
 */
export function mountMovement(container: HTMLElement): ViewHandle {
  const root = document.createElement('div');
  const title = document.createElement('div');
  title.style.cssText = "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;margin:6px 2px 12px;font-size:13px;";
  root.appendChild(title);

  const seed = Date.now() >>> 0;
  const canvas = document.createElement('canvas');
  const scene = new MovementScene(canvas, seed);

  // Canvas with the camera/light control panel alongside it (spec 033).
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;';
  row.append(canvas, scene.controls.element);
  root.appendChild(row);
  container.appendChild(root);
  const input = new IsoInputCapture(canvas);
  // No enemies and no ambient spawner: a pure movement sandbox.
  let state: CombatState = initCombat(seed, { ambientSpawner: false, initialEnemies: 0 });

  const setTitle = (): void => {
    const name = characterAt(state.player.characterIndex).name;
    title.textContent =
      `turbo-deck · movement sandbox (spec 032) — right-click to move a mech unit. ` +
      `MOBA turn-rate movement: it turns to face the destination before it travels. ` +
      `C swaps the movement archetype (${name}).`;
  };
  setTitle();

  let running = false;
  let accumulator = 0;
  let lastFrame: number | undefined;

  const frame = (time: number): void => {
    if (!running) return;
    if (lastFrame !== undefined) accumulator = Math.min(accumulator + (time - lastFrame), TICK_MS * MAX_CATCH_UP);
    lastFrame = time;

    while (accumulator >= TICK_MS) {
      const cursor = input.mouseCanvas();
      const worldCursor = scene.screenToWorld(cursor.x, cursor.y);
      const s = input.sample(worldCursor, state.player.position, null);
      const combatInput: InputFrame = {
        attack: false,
        aimX: s.aimX,
        aimY: s.aimY,
        parry: false,
        dodge: false,
        ...(s.moveTarget ? { moveTarget: s.moveTarget } : {}),
        ...(s.cycleCharacter ? { cycleCharacter: true } : {}),
      };
      state = step(state, combatInput).state;
      accumulator -= TICK_MS;
    }

    scene.render(state);
    setTitle();
    requestAnimationFrame(frame);
  };

  return {
    element: root,
    start(): void {
      if (running) return;
      running = true;
      lastFrame = undefined;
      accumulator = 0;
      input.attach(window);
      requestAnimationFrame(frame);
    },
    stop(): void {
      running = false;
      input.detach();
    },
  };
}
