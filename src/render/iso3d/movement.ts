import * as THREE from 'three';
import { initCombat, step } from '../../sim/combat.js';
import { characterAt } from '../../sim/characters.js';
import { ARENA_HEIGHT, ARENA_OBSTACLES, ARENA_WIDTH, TICK_RATE } from '../../sim/constants.js';
import type { CombatState, InputFrame, Vec2, WorldColliders } from '../../sim/types.js';
import { createWorldColliders } from '../../sim/collision.js';
import { defaultRobeTuning, type RobeTuning } from '../cloth/params.js';
import { IsoInputCapture } from './input.js';
import { PALETTE } from './palette.js';
import { makeHeadingArrow, makeMoveMarker, makeUnwalkableField, makeWall } from './meshes.js';
import {
  createArenaWorld,
  vegetationColliders,
  worldVegetation,
  type Prop,
  type TerrainWorld,
} from '../../terrain/index.js';
import { buildTerrainMesh } from './terrain-mesh.js';
import { defaultMechTuning, MechRig, type MechTuning } from './rigs.js';
import { buildPropField } from './props.js';
import { RobeRig } from './robe.js';
import { ROBE_TUNING_GROUPS } from './robe-panel.js';
import {
  buildTuningSection,
  LABEL_CSS,
  panelButton,
  panelButtonRow,
  type TuningGroup,
} from './tuning-panel.js';
import type { SandboxUnit, UnitKind } from './unit.js';
import { createViewControls, type ViewControls } from './view-controls.js';
import { CAMERA_FAR, CAMERA_NEAR, DEFAULT_CAMERA_OFFSET, DEFAULT_VIEW_HALF_WIDTH } from './view-settings.js';
import { viewSeed } from './seed.js';

// Per-frame easing fraction for camera framing changes (spec 034), matching IsoScene.
const CAMERA_SMOOTH = 0.15;

/**
 * The movement sandbox tab (spec 032/033/046): no game -- just one controllable
 * unit driven through the sim's MOBA movement so the turn-rate rules, the units'
 * legs and the robed figure's cloth can be watched and *tuned* in isolation. A
 * unit picker switches between the organic spider mech, a grey metal walker (a
 * rotating turret on a fixed animated leg base) and the hooded robe character. It
 * reuses the deterministic combat sim (no enemies, no ambient spawner) and only
 * ever feeds it movement inputs: a right-click move order, C to cycle the
 * movement archetype, J to hop the robed figure, and live speed/turn-rate overrides from the
 * side panel. Every other knob edits the active unit's cosmetic tuning. Game
 * rules stay in the sim; this layer only reads state and poses the (cosmetic) rig.
 */

export type { UnitKind } from './unit.js';

// Same low-res, upscaled retro look and fixed iso follow-camera as the combat view.
const RENDER_W = 480;
const RENDER_H = 300;
const DISPLAY_W = 640;
const DISPLAY_H = 400;
const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

/** A minimal three.js scene: ground + scenery + one controllable mech. */
class MovementScene {
  /** Camera/light control panel (spec 033); mount `.controls.element` beside the canvas. */
  readonly controls: ViewControls = createViewControls({ zoom: DEFAULT_VIEW_HALF_WIDTH });
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  // Both mechs share one tuning object so the panel drives whichever is active;
  // the grey mech only differs in colour and a non-turning lower body.
  private readonly sharedTuning: MechTuning = defaultMechTuning();
  private readonly spider = new MechRig('ally', PALETTE.mechAlly, { tuning: this.sharedTuning });
  private readonly walker = new MechRig('ally', PALETTE.walkerBody, {
    tuning: this.sharedTuning,
    lowerBodyTurns: false,
  });
  /** The robed figure (spec 046), built lazily so its cloth costs nothing unless picked. */
  private robeRig: RobeRig | null = null;
  private readonly robeTuning: RobeTuning = defaultRobeTuning();
  private active: SandboxUnit = this.spider;
  private readonly headingArrow = makeHeadingArrow();
  private readonly sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
  private readonly unwalkable = new THREE.Group();
  private readonly camOffsetCurrent = new THREE.Vector3(
    DEFAULT_CAMERA_OFFSET.x,
    DEFAULT_CAMERA_OFFSET.y,
    DEFAULT_CAMERA_OFFSET.z,
  );
  private readonly camOffsetTarget = new THREE.Vector3();
  private halfWidth = DEFAULT_VIEW_HALF_WIDTH;
  private lastHalfWidth = -1;
  private readonly moveMarker: THREE.Mesh;
  private readonly target = new THREE.Vector3(ARENA_WIDTH / 2, 0, ARENA_HEIGHT / 2);
  private lastNow = performance.now();
  // Reused across cursor raycasts so screenToWorld allocates nothing per frame.
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();
  // The sandbox stands on the same terrain the game does (spec 043), and walks
  // around the same trees and bushes (spec 044).
  private readonly terrain: TerrainWorld;
  private readonly vegetation: readonly Prop[];
  private readonly terrainPick: THREE.Object3D[];
  private readonly terrainHits: THREE.Intersection[] = [];

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
    this.camera = new THREE.OrthographicCamera(-hw, hw, hw / aspect, -hw / aspect, CAMERA_NEAR, CAMERA_FAR);

    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0x8090a0, 1.1));

    this.terrain = createArenaWorld(seed);
    this.vegetation = worldVegetation(seed, this.terrain);
    const terrainMesh = buildTerrainMesh(this.terrain);
    this.terrainPick = terrainMesh.pickTargets;
    this.scene.add(terrainMesh.group);
    this.addScenery();
    this.addWalls();
    this.scene.add(this.unwalkable);

    // A scene-managed heading arrow shows the facing for either unit (the walker
    // keeps its group un-yawed, so the arrow can't be parented to it).
    this.scene.add(this.headingArrow);
    this.scene.add(this.active.group);
    this.moveMarker = makeMoveMarker();
    this.moveMarker.visible = false;
    this.scene.add(this.moveMarker);

    // The wheel over the view is the zoom, alongside the panel's slider (spec 042).
    this.controls.attachWheelZoom(canvas);
  }

  /** The static world the sim collides against here: walls plus vegetation (spec 044). */
  worldColliders(): WorldColliders {
    return createWorldColliders(ARENA_OBSTACLES, vegetationColliders(this.vegetation));
  }

  /** The shared live-editable tuning both mechs use (the panel binds to it). */
  get tuning(): MechTuning {
    return this.sharedTuning;
  }

  /** The robe's live-editable tuning (the panel binds to it). */
  get robe(): RobeTuning {
    return this.robeTuning;
  }

  /** The robed figure, once it has been picked at least once. */
  get robeUnit(): RobeRig | null {
    return this.robeRig;
  }

  /** The active unit's locomotion state, for the status line. */
  get unitState(): string {
    return this.active.locomotionState;
  }

  /** Swap the controllable unit, keeping the sim (position/heading) running. */
  setUnit(kind: UnitKind): void {
    const next = kind === 'walker' ? this.walker : kind === 'robe' ? this.ensureRobe() : this.spider;
    if (next === this.active) return;
    this.scene.remove(this.active.group);
    this.active = next;
    this.scene.add(this.active.group);
  }

  /** Build the robed figure on first use; its cloth is not free to construct. */
  private ensureRobe(): RobeRig {
    this.robeRig ??= new RobeRig({ tuning: this.robeTuning });
    return this.robeRig;
  }

  /**
   * The arena's static walls (spec 037), sunk to the lowest terrain under each
   * footprint so a wall on a slope still meets the ground (spec 043).
   */
  private addWalls(): void {
    for (const rect of ARENA_OBSTACLES) {
      const wall = makeWall(rect.w, rect.h);
      const low = Math.min(
        this.terrain.heightAt(rect.x, rect.y),
        this.terrain.heightAt(rect.x + rect.w, rect.y),
        this.terrain.heightAt(rect.x, rect.y + rect.h),
        this.terrain.heightAt(rect.x + rect.w, rect.y + rect.h),
        this.terrain.heightAt(rect.x + rect.w / 2, rect.y + rect.h / 2),
      );
      wall.position.set(rect.x, low, rect.y);
      this.scene.add(wall);
    }
  }

  /** The same vegetation the game view draws -- and the same the sim blocks on (spec 044). */
  private addScenery(): void {
    const field = buildPropField(this.vegetation, (x, z) => this.terrain.heightAt(x, z));
    this.scene.add(field.group);
    this.unwalkable.add(
      makeUnwalkableField(vegetationColliders(this.vegetation), (x, z) => this.terrain.heightAt(x, z)),
    );
  }

  /** Raycast the cursor (canvas CSS pixels) onto the terrain for a move order (spec 043). */
  screenToWorld(cssX: number, cssY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = (cssX / rect.width) * 2 - 1;
    const ndcY = -((cssY / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    this.terrainHits.length = 0;
    this.raycaster.intersectObjects(this.terrainPick, false, this.terrainHits);
    const ground = this.terrainHits[0];
    if (ground) return { x: ground.point.x, y: ground.point.z };
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
    // Terrain sets only how high the unit is drawn; the sim stays flat (spec 043).
    const groundY = this.terrain.heightAt(p.position.x, p.position.y);
    this.active.group.position.set(p.position.x, groundY, p.position.y);
    // The spider turns its whole group to face; the walker keeps its base
    // un-yawed and turns only its turret internally.
    this.active.group.rotation.y = this.active.orientsWithGroupYaw ? ry : 0;
    this.active.update(dt, p.position, ry);
    this.headingArrow.position.set(p.position.x, groundY + 3, p.position.y);
    this.headingArrow.rotation.y = ry;

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

    this.target.set(p.position.x, groundY, p.position.y);
    this.applyControls();
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  /** Ease the camera/light and refresh the ortho zoom from the panel (spec 033/034). */
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
}

/** A mounted view the tab shell can pause: its loop and input stop when hidden. */
export interface ViewHandle {
  readonly element: HTMLElement;
  start(): void;
  stop(): void;
}

/**
 * Movement knobs that are *sim inputs* rather than cosmetics, so they apply to
 * whichever unit is active and stay visible in the panel at all times. They live
 * on the mech tuning purely because that is the object the sandbox already feeds
 * to the combat step as its per-tick overrides.
 */
const MOVEMENT_GROUP: TuningGroup<MechTuning> = {
  title: 'Movement (sim)',
  rows: [
    {
      label: 'Move speed',
      min: 100,
      max: 400,
      step: 5,
      key: 'moveSpeed',
      tip: 'Base travel speed in world units per second (the sim clamps it to 100–550). Fed to the movement sim as a live override.',
    },
    {
      label: 'Turn rate (°/s)',
      min: 60,
      max: 720,
      step: 10,
      key: 'turnRate',
      tip: 'How fast the unit rotates to face its destination, in degrees per second. MOBA movement turns to face before it travels.',
    },
  ],
};

const MECH_TUNING_GROUPS: readonly TuningGroup<MechTuning>[] = [
  {
    title: 'Unit',
    rows: [
      {
        label: 'Size',
        min: 0.4,
        max: 2.5,
        step: 0.05,
        key: 'sizeScale',
        digits: 2,
        tip: 'Overall creature size — scales every leg and body dimension and how far each step reaches.',
      },
      {
        label: 'Legs',
        min: 3,
        max: 8,
        step: 1,
        key: 'numLegs',
        tip:
          'How many legs the unit walks on (3–8). They are spaced evenly around the body on its oval footprint, ' +
          'and a leg only swings while both of its neighbours are planted — so four legs walk on alternating ' +
          'diagonals, six fall into an insect tripod, and three can only ever lift one leg at a time. ' +
          'Changing this rebuilds the legs and re-plants the feet.',
      },
    ],
  },
  {
    title: 'Gait',
    rows: [
      {
        label: 'Step trigger',
        min: 6,
        max: 40,
        step: 1,
        key: 'stepTrigger',
        tip: 'How far a foot may drift from its resting spot before the leg picks up and re-plants. Lower means more, smaller steps.',
      },
      {
        label: 'Step lead · walk',
        min: 0,
        max: 40,
        step: 1,
        key: 'stepLeadWalk',
        tip: 'How far ahead of its resting spot a foot plants when walking — the stride length at walk pace.',
      },
      {
        label: 'Step lead · run',
        min: 0,
        max: 70,
        step: 1,
        key: 'stepLeadRun',
        tip: 'How far ahead of its resting spot a foot plants when running — the stride length at run pace.',
      },
      {
        label: 'Step height · walk',
        min: 2,
        max: 40,
        step: 1,
        key: 'stepHeightWalk',
        tip: "Peak height of the foot's arc during a walking step.",
      },
      {
        label: 'Step height · run',
        min: 2,
        max: 50,
        step: 1,
        key: 'stepHeightRun',
        tip: "Peak height of the foot's arc during a running step.",
      },
      {
        label: 'Step time · walk (s)',
        min: 0.08,
        max: 0.45,
        step: 0.01,
        key: 'stepDurWalk',
        digits: 2,
        tip: "Time in seconds for one walking step's swing-and-plant. Lower is quicker footwork.",
      },
      {
        label: 'Step time · run (s)',
        min: 0.06,
        max: 0.35,
        step: 0.01,
        key: 'stepDurRun',
        digits: 2,
        tip: "Time in seconds for one running step's swing-and-plant. Lower is quicker footwork.",
      },
      {
        label: 'Legs airborne',
        min: 1,
        max: 2,
        step: 1,
        key: 'maxStepping',
        tip:
          'How many legs may be off the ground at once on a four-legged unit — 1 is a careful gait, 2 allows a ' +
          'diagonal trot. With more legs this scales up in proportion (a 6-legged unit gets 3), never lifting ' +
          'more than half of them, so extra legs do not each have to wait longer for a turn to step.',
      },
      {
        label: 'Raised legs',
        min: 0,
        max: 1,
        step: 1,
        key: 'raisedLegs',
        tip: 'How many legs may lift into a slightly-raised "recovery" hold while waiting to step (0 or 1).',
      },
    ],
  },
  {
    title: 'Turning',
    rows: [
      {
        label: 'Body yaw lag',
        min: 0,
        max: 1,
        step: 0.05,
        key: 'yawLag',
        digits: 2,
        tip: 'How much the body trails its heading through a turn. 0 is near-rigid tracking; 1 leans into the turn and settles afterwards (spring + inertia).',
      },
      {
        label: 'Step prediction',
        min: 0,
        max: 1,
        step: 0.05,
        key: 'stepPredict',
        digits: 2,
        tip: 'How far a step anticipates the turn — planting where the body will be facing when the foot lands, not where it faces now.',
      },
      {
        label: 'Diff. step bias',
        min: 0,
        max: 1,
        step: 0.05,
        key: 'turnStepBias',
        digits: 2,
        tip: 'How hard inside legs shorten and outside legs lengthen their steps while turning (differential stride).',
      },
    ],
  },
  {
    title: 'Body',
    rows: [
      {
        label: 'Center-of-mass lean',
        min: 0,
        max: 0.5,
        step: 0.01,
        key: 'comShift',
        digits: 2,
        tip: 'How far the body leans toward the centre of its planted feet (center-of-mass shift).',
      },
      {
        label: 'Bob amplitude',
        min: 0,
        max: 12,
        step: 0.5,
        key: 'bobAmp',
        digits: 1,
        tip: 'How much the body bobs up and down vertically at full run.',
      },
      {
        label: 'Pitch gain',
        min: 0,
        max: 0.005,
        step: 0.0002,
        key: 'pitchGain',
        digits: 4,
        tip: 'How much the nose dips or lifts under acceleration — radians of pitch per unit/s² of acceleration.',
      },
      {
        label: 'Roll gain',
        min: 0,
        max: 0.3,
        step: 0.01,
        key: 'rollGain',
        digits: 2,
        tip: 'How much the body banks into a turn — radians of roll per rad/s of turning.',
      },
      {
        label: 'Knee sway',
        min: 0,
        max: 0.4,
        step: 0.02,
        key: 'kneeSway',
        digits: 2,
        tip: 'Sideways knee-sway amplitude, adding organic variation to the joints.',
      },
      {
        label: 'Hip joint reach',
        min: 0,
        max: 3,
        step: 0.05,
        key: 'coxaReach',
        digits: 2,
        tip: "How much of a leg's outward reach comes from the hip joint (coxa). 0 collapses it to a bare knee leg; higher throws the foot further from the hip.",
      },
      {
        label: 'Hip fore/aft swing',
        min: 0,
        max: 3,
        step: 0.05,
        key: 'coxaSwing',
        digits: 2,
        tip: "How much the hip joint carries the whole leg front-to-back, pivoting the entire limb at the hip so it reaches toward the target. 0 keeps the coxa pointing out to the side (all fore/aft in the knee); 1 makes the hip do all the reach; higher exaggerates it.",
      },
      {
        label: 'Thigh length',
        min: 0,
        max: 3,
        step: 0.05,
        key: 'femurScale',
        digits: 2,
        tip: 'Length of the thigh (femur) — the middle leg segment from the shoulder up to the knee. 1 is natural; higher gives a longer, higher-kneed thigh; 0 removes the thigh entirely, so the shin runs straight from the hip to the foot.',
      },
      {
        label: 'Foot follow (smooth)',
        min: 4,
        max: 60,
        step: 1,
        key: 'footSmooth',
        tip: 'How fast the drawn foot may chase its target (per second). Higher snaps tighter to the gait; lower moves limbs slowly and smooths out twitch.',
      },
    ],
  },
];

/** Everything the sandbox panel needs to drive: two tunings and a set of actions. */
export interface SandboxPanelOptions {
  /** The mech tuning (also the holder of the sim move-speed/turn-rate overrides). */
  readonly mech: MechTuning;
  /** The robed figure's cloth/figure/wind tuning. */
  readonly robe: RobeTuning;
  /** Restore the active unit's tuning to its defaults. */
  readonly onReset: () => void;
  readonly onUnit: (kind: UnitKind) => void;
  /** Robe-only actions, exposed as buttons alongside its sliders. */
  readonly onJump: () => void;
  readonly onDrop: () => void;
  readonly onGust: () => void;
  readonly onResettle: () => void;
}

export interface SandboxPanel {
  readonly element: HTMLElement;
  /** Push both tunings' current values back into the controls (after a reset). */
  sync(): void;
}

/** The units the picker offers, in order. */
const UNIT_CHIPS: readonly { kind: UnitKind; label: string; tip: string }[] = [
  {
    kind: 'spider',
    label: 'Spider',
    tip: 'Control the organic spider mech — its whole body turns to face where it moves.',
  },
  {
    kind: 'walker',
    label: 'Mech (grey)',
    tip: 'Control the grey metal walker — same leg mechanics, but its lower body stays put while only the upper body rotates to face.',
  },
  {
    kind: 'robe',
    label: 'Hooded robe',
    tip: 'Control the hooded robe character — a humanoid whose hood, cape, lower robe and sleeves are driven by a cloth simulation.',
  },
];

/**
 * Build the side control panel. The unit picker swaps which tuning section is
 * shown -- the mech's leg/gait knobs or the robe's fabric, force and wind knobs
 * -- while the sim movement group stays visible for both, since it drives the
 * combat step rather than either rig.
 */
export function buildPanel(opts: SandboxPanelOptions): SandboxPanel {
  const panel = document.createElement('div');
  panel.style.cssText =
    `${LABEL_CSS}width:300px;max-height:${DISPLAY_H}px;overflow-y:auto;padding:4px 12px 12px;` +
    'background:#16161e;border:1px solid #2a2a3a;border-radius:8px;font-size:12px;box-sizing:border-box;';

  const help = document.createElement('div');
  help.style.cssText = 'line-height:1.5;color:#9a9ab0;margin:6px 0 10px;';
  help.innerHTML =
    '<b style="color:#f0f0f8;">Movement sandbox</b><br>' +
    '<b>Right-click</b> the ground to move. MOBA turn-rate: the unit turns to face ' +
    'the destination before it travels.<br>' +
    '<b>C</b> loads the next archetype preset into the sliders. ' +
    '<b>J</b> makes the robed figure hop.<br>' +
    'Pick a unit below.';
  panel.appendChild(help);

  // Unit picker: one chip per controllable unit.
  const pickerLabel = document.createElement('div');
  pickerLabel.textContent = 'Unit';
  pickerLabel.title = "Choose which unit the sandbox controls; the sliders below follow the choice.";
  pickerLabel.style.cssText = 'color:#f0f0f8;font-weight:600;margin:2px 0 4px;letter-spacing:.03em;';
  panel.appendChild(pickerLabel);
  const picker = document.createElement('div');
  picker.style.cssText = 'display:flex;gap:6px;margin:0 0 6px;';
  const chips: HTMLButtonElement[] = [];
  const styleChip = (btn: HTMLButtonElement, on: boolean): void => {
    btn.style.cssText =
      `${LABEL_CSS}flex:1;padding:6px 2px;border-radius:6px;cursor:pointer;font-size:11px;border:1px solid #2a2a3a;` +
      (on ? 'background:#3a5c7a;color:#f0f0f8;' : 'background:#20202c;color:#9a9ab0;');
  };

  const movement = buildTuningSection([MOVEMENT_GROUP], opts.mech);
  const mech = buildTuningSection(MECH_TUNING_GROUPS, opts.mech);
  const robe = buildTuningSection(ROBE_TUNING_GROUPS, opts.robe);

  // Robe-only actions: the discrete events the cloth reacts to, which cannot be
  // produced by dragging a slider.
  const robeActions = document.createElement('div');
  robeActions.appendChild(
    panelButtonRow(
      panelButton('Jump', 'Hop the figure (or press J) and watch the robe trail, then flare on landing.', opts.onJump),
      panelButton('Drop', 'Drop the figure from a height, to watch the robe billow through a long fall.', opts.onDrop),
    ),
  );
  robeActions.appendChild(
    panelButtonRow(
      panelButton('Gust', 'Fire a one-shot gust of wind on top of the sustained wind.', opts.onGust),
      panelButton('Re-settle', 'Drop every garment back onto its rest pose at rest. Useful after a big retune.', opts.onResettle),
    ),
  );

  panel.append(picker, movement.element, mech.element, robe.element, robeActions);

  const showUnit = (kind: UnitKind): void => {
    const isRobe = kind === 'robe';
    mech.setVisible(!isRobe);
    robe.setVisible(isRobe);
    robeActions.style.display = isRobe ? 'block' : 'none';
  };

  UNIT_CHIPS.forEach((u, i) => {
    const btn = document.createElement('button');
    btn.textContent = u.label;
    btn.title = u.tip;
    styleChip(btn, i === 0);
    btn.addEventListener('click', () => {
      chips.forEach((c, j) => styleChip(c, j === i));
      showUnit(u.kind);
      opts.onUnit(u.kind);
    });
    picker.appendChild(btn);
    chips.push(btn);
  });
  showUnit('spider');

  const reset = panelButton('Reset to defaults', "Restore every slider above to the active unit's default tuning.", opts.onReset);
  reset.style.marginTop = '14px';
  panel.appendChild(panelButtonRow(reset));

  return {
    element: panel,
    sync: () => {
      movement.sync();
      mech.sync();
      robe.sync();
    },
  };
}

/**
 * Mount the movement sandbox into `container`, returning a start/stop handle. The
 * fixed-timestep loop is identical to the combat view's: real elapsed time
 * becomes whole ticks, inputs are fed one tick at a time, and the scene only
 * reads the resulting state. The side panel edits the rig tuning live and feeds
 * the sim its move-speed / turn-rate overrides.
 */
export function mountMovement(container: HTMLElement): ViewHandle {
  // The tab shell toggles `root.style.display` (block/none), so the flex row lives
  // in an inner wrapper it does not touch.
  const root = document.createElement('div');
  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;';
  root.appendChild(layout);

  const left = document.createElement('div');
  const status = document.createElement('div');
  status.style.cssText = `${LABEL_CSS}margin:6px 2px 8px;font-size:13px;`;
  left.appendChild(status);
  const canvas = document.createElement('canvas');
  left.appendChild(canvas);
  layout.appendChild(left);
  container.appendChild(root);

  const seed = viewSeed();
  const scene = new MovementScene(canvas, seed);
  const tuning = scene.tuning;
  const input = new IsoInputCapture(canvas);
  // No enemies and no ambient spawner: a pure movement sandbox.
  let state: CombatState = initCombat(seed, {
    ambientSpawner: false,
    initialEnemies: 0,
    world: scene.worldColliders(),
  });

  let unit: UnitKind = 'spider';
  const panel = buildPanel({
    mech: tuning,
    robe: scene.robe,
    onReset: () => {
      if (unit === 'robe') Object.assign(scene.robe, defaultRobeTuning());
      else Object.assign(tuning, defaultMechTuning());
      panel.sync();
    },
    onUnit: (kind) => {
      unit = kind;
      scene.setUnit(kind);
    },
    onJump: () => scene.robeUnit?.jump(),
    onDrop: () => scene.robeUnit?.drop(),
    onGust: () => scene.robeUnit?.gust(),
    onResettle: () => scene.robeUnit?.resettle(),
  });
  layout.appendChild(panel.element);
  // The camera/light control panel (spec 033/034) sits alongside the tuning panel.
  layout.appendChild(scene.controls.element);

  const setStatus = (): void => {
    const name = characterAt(state.player.characterIndex).name;
    const unitName = UNIT_CHIPS.find((u) => u.kind === unit)?.label ?? 'Spider';
    status.textContent = `Unit: ${unitName}  ·  Archetype: ${name} (C to cycle)  ·  gait: ${scene.unitState}`;
  };
  setStatus();

  // Load the active character's preset into the sliders when C cycles it.
  let lastCharacter = state.player.characterIndex;
  const syncCharacter = (): void => {
    if (state.player.characterIndex === lastCharacter) return;
    lastCharacter = state.player.characterIndex;
    const c = characterAt(lastCharacter);
    tuning.moveSpeed = c.moveSpeed;
    tuning.turnRate = c.turnRate;
    panel.sync();
  };

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
        // Live speed/turn-rate overrides from the panel (sandbox-only input),
        // finite-guarded so a bad value can never feed the sim a NaN heading.
        moveSpeedOverride: Number.isFinite(tuning.moveSpeed) ? tuning.moveSpeed : 147.5,
        turnRateOverride: Number.isFinite(tuning.turnRate) ? tuning.turnRate : 180,
        ...(s.moveTarget ? { moveTarget: s.moveTarget } : {}),
        ...(s.cycleCharacter ? { cycleCharacter: true } : {}),
      };
      state = step(state, combatInput).state;
      // A cosmetic hop: the sim has no notion of height, so this never enters
      // the input frame above and can decide no game outcome.
      if (input.takeJump()) scene.robeUnit?.jump();
      syncCharacter();
      accumulator -= TICK_MS;
    }

    scene.render(state);
    setStatus();
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
