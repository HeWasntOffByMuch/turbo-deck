import * as THREE from 'three';
import { initCombat, step } from '../../sim/combat.js';
import { characterAt } from '../../sim/characters.js';
import { ARENA_HEIGHT, ARENA_WIDTH, TICK_RATE } from '../../sim/constants.js';
import type { CombatState, InputFrame, Vec2 } from '../../sim/types.js';
import { IsoInputCapture } from './input.js';
import { PALETTE } from './palette.js';
import { makeBush, makeGround, makeHeadingArrow, makeMoveMarker, makeTree } from './meshes.js';
import { defaultMechTuning, MechRig, WalkerRig, type MechTuning } from './rigs.js';
import { scatterProps } from './scatter.js';

/**
 * The movement sandbox tab (spec 032/033): no game -- just one controllable unit
 * driven through the sim's MOBA movement so the turn-rate rules and the units'
 * legs can be watched and *tuned* in isolation. A unit picker switches between the
 * organic spider mech and a grey metal walker (a rotating turret on a fixed
 * animated leg base). It reuses the deterministic combat sim (no enemies, no
 * ambient spawner) and only ever feeds it movement inputs: a right-click move
 * order, C to cycle the movement archetype, and live speed/turn-rate overrides
 * from the side panel. Every other knob edits the spider's cosmetic tuning. Game
 * rules stay in the sim; this layer only reads state and poses the (cosmetic) rig.
 */

/** The selectable sandbox units. */
export type UnitKind = 'spider' | 'walker';

// Same low-res, upscaled retro look and fixed iso follow-camera as the combat view.
const RENDER_W = 480;
const RENDER_H = 300;
const DISPLAY_W = 640;
const DISPLAY_H = 400;
const VIEW_HALF_WIDTH = 320;
const CAMERA_OFFSET = new THREE.Vector3(420, 520, 420);

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

/** A minimal three.js scene: ground + scenery + one controllable mech. */
class MovementScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly spider = new MechRig('ally', PALETTE.mechAlly);
  private readonly walker = new WalkerRig(PALETTE.walkerBody);
  private active: MechRig | WalkerRig = this.spider;
  private readonly headingArrow = makeHeadingArrow();
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
    this.camera = new THREE.OrthographicCamera(
      -VIEW_HALF_WIDTH,
      VIEW_HALF_WIDTH,
      VIEW_HALF_WIDTH / aspect,
      -VIEW_HALF_WIDTH / aspect,
      1,
      4000,
    );

    const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
    sun.position.set(-0.6, 1.4, -0.5);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x8090a0, 1.1));

    const bleed = 600;
    const ground = makeGround(ARENA_WIDTH + bleed * 2, ARENA_HEIGHT + bleed * 2);
    ground.position.set(-bleed, 0, -bleed);
    this.scene.add(ground);
    this.addScenery(seed);

    // A scene-managed heading arrow shows the facing for either unit (the walker
    // keeps its group un-yawed, so the arrow can't be parented to it).
    this.scene.add(this.headingArrow);
    this.scene.add(this.active.group);
    this.moveMarker = makeMoveMarker();
    this.moveMarker.visible = false;
    this.scene.add(this.moveMarker);
  }

  /** The spider's live-editable tuning (the panel binds to it; the walker ignores it). */
  get tuning(): MechTuning {
    return this.spider.tuning;
  }

  /** The active unit's locomotion state, for the status line. */
  get unitState(): string {
    return this.active.locomotionState;
  }

  /** Swap the controllable unit, keeping the sim (position/heading) running. */
  setUnit(kind: UnitKind): void {
    const next = kind === 'walker' ? this.walker : this.spider;
    if (next === this.active) return;
    this.scene.remove(this.active.group);
    this.active = next;
    this.scene.add(this.active.group);
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
    this.active.group.position.set(p.position.x, 0, p.position.y);
    // The spider turns its whole group to face; the walker keeps its base
    // un-yawed and turns only its turret internally.
    this.active.group.rotation.y = this.active.orientsWithGroupYaw ? ry : 0;
    this.active.update(dt, p.position, ry);
    this.headingArrow.position.set(p.position.x, 3, p.position.y);
    this.headingArrow.rotation.y = ry;

    if (p.moveTarget) {
      this.moveMarker.visible = true;
      this.moveMarker.position.set(p.moveTarget.x, 6, p.moveTarget.y);
    } else {
      this.moveMarker.visible = false;
    }

    this.target.set(p.position.x, 0, p.position.y);
    this.camera.position.copy(this.target).add(CAMERA_OFFSET);
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
  }
}

/** A mounted view the tab shell can pause: its loop and input stop when hidden. */
export interface ViewHandle {
  readonly element: HTMLElement;
  start(): void;
  stop(): void;
}

// One editable tuning field: label, range, and how to read/write it on the tuning.
interface SliderSpec {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly key: keyof MechTuning;
  /** Decimal places to show in the readout (0 => integer). */
  readonly digits?: number;
}

const SLIDER_GROUPS: readonly { readonly title: string; readonly rows: readonly SliderSpec[] }[] = [
  {
    title: 'Unit',
    rows: [
      { label: 'Size', min: 0.4, max: 2.5, step: 0.05, key: 'sizeScale', digits: 2 },
      { label: 'Move speed', min: 100, max: 400, step: 5, key: 'moveSpeed' },
      { label: 'Turn rate (°/s)', min: 60, max: 720, step: 10, key: 'turnRate' },
    ],
  },
  {
    title: 'Gait',
    rows: [
      { label: 'Step trigger', min: 6, max: 40, step: 1, key: 'stepTrigger' },
      { label: 'Step lead · walk', min: 0, max: 40, step: 1, key: 'stepLeadWalk' },
      { label: 'Step lead · run', min: 0, max: 70, step: 1, key: 'stepLeadRun' },
      { label: 'Step height · walk', min: 2, max: 40, step: 1, key: 'stepHeightWalk' },
      { label: 'Step height · run', min: 2, max: 50, step: 1, key: 'stepHeightRun' },
      { label: 'Step time · walk (s)', min: 0.08, max: 0.45, step: 0.01, key: 'stepDurWalk', digits: 2 },
      { label: 'Step time · run (s)', min: 0.06, max: 0.35, step: 0.01, key: 'stepDurRun', digits: 2 },
      { label: 'Legs airborne', min: 1, max: 2, step: 1, key: 'maxStepping' },
      { label: 'Raised legs', min: 0, max: 1, step: 1, key: 'raisedLegs' },
    ],
  },
  {
    title: 'Turning',
    rows: [
      { label: 'Body yaw lag', min: 0, max: 1, step: 0.05, key: 'yawLag', digits: 2 },
      { label: 'Step prediction', min: 0, max: 1, step: 0.05, key: 'stepPredict', digits: 2 },
      { label: 'Diff. step bias', min: 0, max: 1, step: 0.05, key: 'turnStepBias', digits: 2 },
    ],
  },
  {
    title: 'Body',
    rows: [
      { label: 'Center-of-mass lean', min: 0, max: 0.5, step: 0.01, key: 'comShift', digits: 2 },
      { label: 'Bob amplitude', min: 0, max: 12, step: 0.5, key: 'bobAmp', digits: 1 },
      { label: 'Pitch gain', min: 0, max: 0.005, step: 0.0002, key: 'pitchGain', digits: 4 },
      { label: 'Roll gain', min: 0, max: 0.3, step: 0.01, key: 'rollGain', digits: 2 },
      { label: 'Knee sway', min: 0, max: 0.4, step: 0.02, key: 'kneeSway', digits: 2 },
      { label: 'Foot follow (smooth)', min: 4, max: 60, step: 1, key: 'footSmooth' },
    ],
  },
];

const PANEL_TEXT = '#c9c9d8';
const LABEL_CSS = `font-family:'Segoe UI',system-ui,sans-serif;color:${PANEL_TEXT};`;

/** Build the side control panel; returns the element and a fn to sync sliders to tuning. */
function buildPanel(
  tuning: MechTuning,
  onReset: () => void,
  onUnit: (kind: UnitKind) => void,
): { element: HTMLElement; sync: () => void } {
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
    '<b>C</b> loads the next archetype preset into the sliders.<br>' +
    'Pick a unit below; the sliders retune the <b>spider</b>.';
  panel.appendChild(help);

  // Unit picker: two chips choosing which unit the sandbox controls.
  const pickerLabel = document.createElement('div');
  pickerLabel.textContent = 'Unit';
  pickerLabel.style.cssText = 'color:#f0f0f8;font-weight:600;margin:2px 0 4px;letter-spacing:.03em;';
  panel.appendChild(pickerLabel);
  const picker = document.createElement('div');
  picker.style.cssText = 'display:flex;gap:6px;margin:0 0 6px;';
  const units: readonly { kind: UnitKind; label: string }[] = [
    { kind: 'spider', label: 'Spider' },
    { kind: 'walker', label: 'Mech (grey)' },
  ];
  const chips: HTMLButtonElement[] = [];
  const styleChip = (btn: HTMLButtonElement, on: boolean): void => {
    btn.style.cssText =
      `${LABEL_CSS}flex:1;padding:6px;border-radius:6px;cursor:pointer;font-size:12px;border:1px solid #2a2a3a;` +
      (on ? 'background:#3a5c7a;color:#f0f0f8;' : 'background:#20202c;color:#9a9ab0;');
  };
  units.forEach((u, i) => {
    const btn = document.createElement('button');
    btn.textContent = u.label;
    styleChip(btn, i === 0);
    btn.addEventListener('click', () => {
      chips.forEach((c, j) => styleChip(c, j === i));
      onUnit(u.kind);
    });
    picker.appendChild(btn);
    chips.push(btn);
  });
  panel.appendChild(picker);

  const refreshers: (() => void)[] = [];

  for (const group of SLIDER_GROUPS) {
    const heading = document.createElement('div');
    heading.textContent = group.title;
    heading.style.cssText = 'color:#f0f0f8;font-weight:600;margin:12px 0 4px;letter-spacing:.03em;';
    panel.appendChild(heading);

    for (const spec of group.rows) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:5px 0;';
      const label = document.createElement('label');
      label.textContent = spec.label;
      label.style.cssText = 'flex:0 0 44%;';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.style.cssText = 'flex:1;min-width:0;accent-color:#4a7fb0;';
      const value = document.createElement('span');
      value.style.cssText = 'flex:0 0 44px;text-align:right;font-variant-numeric:tabular-nums;color:#e0e0ee;';

      const fmt = (v: number): string => (spec.digits ? v.toFixed(spec.digits) : String(Math.round(v)));
      const refresh = (): void => {
        const v = tuning[spec.key];
        input.value = String(v);
        value.textContent = fmt(v);
      };
      input.addEventListener('input', () => {
        tuning[spec.key] = Number(input.value);
        value.textContent = fmt(Number(input.value));
      });
      refresh();
      refreshers.push(refresh);
      row.append(label, input, value);
      panel.appendChild(row);
    }
  }

  const reset = document.createElement('button');
  reset.textContent = 'Reset to defaults';
  reset.style.cssText =
    `${LABEL_CSS}margin-top:14px;width:100%;padding:7px;border-radius:6px;cursor:pointer;` +
    'border:1px solid #2a2a3a;background:#2a2a3a;color:#f0f0f8;font-size:12px;';
  reset.addEventListener('click', onReset);
  panel.appendChild(reset);

  return { element: panel, sync: () => refreshers.forEach((r) => r()) };
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

  const seed = Date.now() >>> 0;
  const scene = new MovementScene(canvas, seed);
  const tuning = scene.tuning;
  const input = new IsoInputCapture(canvas);
  // No enemies and no ambient spawner: a pure movement sandbox.
  let state: CombatState = initCombat(seed, { ambientSpawner: false, initialEnemies: 0 });

  let unit: UnitKind = 'spider';
  const panel = buildPanel(
    tuning,
    () => {
      Object.assign(tuning, defaultMechTuning());
      panel.sync();
    },
    (kind) => {
      unit = kind;
      scene.setUnit(kind);
    },
  );
  layout.appendChild(panel.element);

  const setStatus = (): void => {
    const name = characterAt(state.player.characterIndex).name;
    const unitName = unit === 'walker' ? 'Mech (grey)' : 'Spider';
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
        // Live speed/turn-rate overrides from the panel (sandbox-only input).
        moveSpeedOverride: tuning.moveSpeed,
        turnRateOverride: tuning.turnRate,
        ...(s.moveTarget ? { moveTarget: s.moveTarget } : {}),
        ...(s.cycleCharacter ? { cycleCharacter: true } : {}),
      };
      state = step(state, combatInput).state;
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
