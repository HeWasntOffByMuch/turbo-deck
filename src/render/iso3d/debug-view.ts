import * as THREE from 'three';
import { initCombat, step } from '../../sim/combat.js';
import { characterAt } from '../../sim/characters.js';
import { ARENA_HEIGHT, ARENA_WIDTH, TICK_RATE } from '../../sim/constants.js';
import type { CombatState, InputFrame, Vec2 } from '../../sim/types.js';
import { IsoInputCapture } from './input.js';
import { PALETTE } from './palette.js';
import { flatMaterial, makeHeadingArrow, makeMoveMarker } from './meshes.js';
import { defaultRobeTuning, type RobeTuning } from '../cloth/params.js';
import { defaultMechTuning, MechRig, type MechDebug, type MechTuning } from './rigs.js';
import { RobeRig, type RobeDebug } from './robe.js';
import { ClothDebugOverlay, defaultClothLayers, type ClothLayers } from './robe-debug.js';
import { buildPanel, type ViewHandle } from './movement.js';
import type { SandboxUnit, UnitKind } from './unit.js';
import { viewSeed } from './seed.js';

/**
 * The rig debug viewport (spec 035/037): a third sandbox tab that shows the same
 * controllable unit from two orthographic angles at once -- a world-aligned
 * top-down view and a heading-locked side profile -- with slow-motion /
 * single-step time control and toggleable debug overlays plus a live numeric
 * readout. For the mechs that means the leg skeleton, joint dots, foot targets
 * and step-trigger rings; for the robed figure it means the cloth's particles,
 * strained links, body capsules, reference pose and wind vector. It reuses the
 * deterministic sim movement and the movement sandbox's tuning panel, so the
 * exact rig can be driven, tuned, slowed right down and inspected -- which is
 * how the cloth was tuned in the first place. Entirely cosmetic/renderer-only:
 * it reads sim state and each rig's debug snapshot and never writes game state.
 */

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

// The split canvas: two square viewports side by side (top-left, side-right).
const VIEW = 380;
const CANVAS_W = VIEW * 2;
const CANVAS_H = VIEW;

const PANEL_TEXT = '#c9c9d8';
const LABEL_CSS = `font-family:'Segoe UI',system-ui,sans-serif;color:${PANEL_TEXT};`;
const MONO_CSS = "font-family:'Cascadia Code',Consolas,'SF Mono',monospace;";

// Debug overlay colours (bright, unmistakable against the muted scene).
const COL_PLANTED = 0x00e5ff;
const COL_STEPPING = 0xffa000;
const COL_HELD = 0xffe000;
const COL_HIP = 0x66ccff;
const COL_SHOULDER = 0x66ff99;
const COL_KNEE = 0xffff66;
const COL_FOOT = 0xffffff;
const COL_REST = 0x8890b0;
const COL_TRIGGER = 0x4a6bb0;

/** Colour a leg's skeleton/target by its plant state. */
function stateColor(stepping: boolean, held: boolean): number {
  return held ? COL_HELD : stepping ? COL_STEPPING : COL_PLANTED;
}

const dotGeo = new THREE.SphereGeometry(2.4, 8, 6);

/** A flat ground ring (laid in the XZ plane), for target paint and trigger radii. */
function flatRing(inner: number, outer: number, color: number, opacity: number): THREE.Mesh {
  const geo = new THREE.RingGeometry(inner, outer, 32);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 998;
  return mesh;
}

/** A small always-on-top dot at a joint. */
function jointDot(color: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
  const mesh = new THREE.Mesh(dotGeo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  return mesh;
}

/** The overlay meshes for a single leg, grouped by toggleable layer. */
interface LegVis {
  readonly line: THREE.Line;
  readonly lineMat: THREE.LineBasicMaterial;
  readonly dots: readonly THREE.Mesh[]; // hip, shoulder, knee, foot
  readonly target: THREE.Mesh;
  readonly targetMat: THREE.MeshBasicMaterial;
  readonly footMark: THREE.Mesh;
  readonly rest: THREE.Mesh;
  readonly trigger: THREE.Mesh;
}

/** Which overlay layers are visible; toggled by the checkboxes. */
export interface DebugLayers {
  skeleton: boolean;
  joints: boolean;
  targets: boolean;
  rings: boolean;
}

/**
 * The debug overlay for one rig: a group parented to `rig.group` (so every marker
 * shares the rig's world transform and lines up with the drawn legs) that reads
 * `rig.debugSnapshot()` each frame and repositions the per-leg skeleton, joint
 * dots, foot target, rest marker and trigger ring. Layers toggle by group
 * visibility. Adding a new debug cue means adding one mesh here -- nothing else.
 */
class DebugOverlay {
  private readonly skeletonGroup = new THREE.Group();
  private readonly jointsGroup = new THREE.Group();
  private readonly targetsGroup = new THREE.Group();
  private readonly ringsGroup = new THREE.Group();
  private readonly legs: LegVis[] = [];

  constructor(rig: MechRig, legCount: number) {
    const root = new THREE.Group();
    root.add(this.skeletonGroup, this.jointsGroup, this.targetsGroup, this.ringsGroup);
    rig.group.add(root);

    for (let i = 0; i < legCount; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
      const lineMat = new THREE.LineBasicMaterial({ color: COL_PLANTED, depthTest: false, transparent: true });
      const line = new THREE.Line(geo, lineMat);
      line.frustumCulled = false;
      line.renderOrder = 999;
      this.skeletonGroup.add(line);

      const dots = [jointDot(COL_HIP), jointDot(COL_SHOULDER), jointDot(COL_KNEE), jointDot(COL_FOOT)];
      for (const d of dots) this.jointsGroup.add(d);

      const target = flatRing(4.5, 7, COL_PLANTED, 0.85);
      const targetMat = target.material as THREE.MeshBasicMaterial;
      this.targetsGroup.add(target);
      const footMark = jointDot(COL_FOOT);
      footMark.scale.setScalar(0.7);
      this.targetsGroup.add(footMark);

      const rest = flatRing(0, 2.6, COL_REST, 0.9);
      this.ringsGroup.add(rest);
      const trigger = flatRing(0.97, 1.0, COL_TRIGGER, 0.7);
      this.ringsGroup.add(trigger);

      this.legs.push({ line, lineMat, dots, target, targetMat, footMark, rest, trigger });
    }
  }

  setLayers(layers: DebugLayers): void {
    this.skeletonGroup.visible = layers.skeleton;
    this.jointsGroup.visible = layers.joints;
    this.targetsGroup.visible = layers.targets;
    this.ringsGroup.visible = layers.rings;
  }

  /** Reposition every marker from the rig's solved state. */
  update(snap: MechDebug): void {
    for (let i = 0; i < this.legs.length; i++) {
      const v = this.legs[i];
      const d = snap.legs[i];
      if (!v || !d) continue;
      const col = stateColor(d.stepping, d.held);

      // Skeleton polyline hip -> shoulder -> knee -> foot.
      const pos = v.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const pts = [d.hip, d.shoulder, d.knee, d.foot];
      for (let j = 0; j < 4; j++) {
        const p = pts[j];
        if (p) pos.setXYZ(j, p.x, p.y, p.z);
        v.dots[j]?.position.copy(p ?? d.hip);
      }
      pos.needsUpdate = true;
      v.lineMat.color.setHex(col);

      // Foot target painted on the ground (project the lift height away).
      v.target.position.set(d.target.x, 0.5, d.target.z);
      v.targetMat.color.setHex(col);
      v.footMark.position.copy(d.foot);

      // Rest spot + step-trigger ring.
      v.rest.position.set(d.rest.x, 0.4, d.rest.z);
      v.trigger.position.set(d.rest.x, 0.3, d.rest.z);
      v.trigger.scale.set(d.triggerRadius, 1, d.triggerRadius);
    }
  }
}

/**
 * A plain, edgeless ground for the debug scene: a large solid plane kept centred
 * under the unit (so no border is ever visible) plus a faint world-locked grid
 * that re-snaps in whole cells, so the floor reads as infinite while the unit's
 * motion across it still shows (planted feet visibly slide back as the body
 * advances). No trees, bushes or markers -- a clean backdrop to watch the legs.
 */
class InfiniteGround {
  private static readonly STEP = 100; // world units between grid lines
  private static readonly GRID = 8000; // total grid extent (>> any viewport)
  readonly group = new THREE.Group();
  private readonly plane: THREE.Mesh;
  private readonly grid: THREE.GridHelper;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2); // face up
    this.plane = new THREE.Mesh(geo, flatMaterial(PALETTE.grassDark));
    this.plane.scale.set(20000, 1, 20000);
    this.plane.position.y = -1;

    const div = InfiniteGround.GRID / InfiniteGround.STEP;
    this.grid = new THREE.GridHelper(InfiniteGround.GRID, div, PALETTE.grassLight, PALETTE.grassLight);
    const gm = this.grid.material as THREE.Material;
    gm.transparent = true;
    gm.opacity = 0.3;
    this.grid.position.y = 0.2;

    this.group.add(this.plane, this.grid);
    scene.add(this.group);
  }

  /** Keep the floor under the unit: the plane follows exactly, the grid snaps to
   * whole cells so its lines stay world-locked (seamless as it recentres). */
  recenter(x: number, z: number): void {
    this.plane.position.set(x, -1, z);
    const s = InfiniteGround.STEP;
    this.grid.position.set(Math.round(x / s) * s, 0.2, Math.round(z / s) * s);
  }
}

/**
 * The debug scene: one WebGL renderer drawing a shared scene twice via scissor
 * (top-down on the left, heading-locked side profile on the right), one
 * controllable unit (spider or grey walker) and its {@link DebugOverlay}. Follows
 * the unit and eases its ortho zoom. Reads sim state only.
 */
class DebugScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly topCam: THREE.OrthographicCamera;
  private readonly sideCam: THREE.OrthographicCamera;
  private readonly sharedTuning: MechTuning = defaultMechTuning();
  private readonly spider = new MechRig('ally', PALETTE.mechAlly, { tuning: this.sharedTuning });
  private readonly walker = new MechRig('ally', PALETTE.walkerBody, {
    tuning: this.sharedTuning,
    lowerBodyTurns: false,
  });
  /** The robed figure, built lazily -- its cloth is not free to construct. */
  private robeRig: RobeRig | null = null;
  private robeOverlay: ClothDebugOverlay | null = null;
  private readonly robeTuning: RobeTuning = defaultRobeTuning();
  private active: SandboxUnit = this.spider;
  private activeKind: UnitKind = 'spider';
  private readonly overlays = new Map<MechRig, DebugOverlay>();
  private readonly ground: InfiniteGround;
  private readonly headingArrow = makeHeadingArrow();
  private readonly sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
  private readonly moveMarker: THREE.Mesh;
  private readonly target = new THREE.Vector3(ARENA_WIDTH / 2, 0, ARENA_HEIGHT / 2);
  private halfWidth = 120;
  private drawnHalfWidth = -1;
  private layers: DebugLayers = { skeleton: true, joints: true, targets: true, rings: true };
  private clothLayers: ClothLayers = defaultClothLayers();
  // Reused across cursor raycasts so screenToWorld allocates nothing per frame.
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    canvas.style.width = `${CANVAS_W}px`;
    canvas.style.height = `${CANVAS_H}px`;
    canvas.style.display = 'block';
    canvas.style.borderRadius = '8px';
    canvas.style.boxShadow = '0 6px 24px rgba(0,0,0,.5)';

    // Antialiased and full-res (not the pixelated combat look): debug lines and
    // dots need to read cleanly.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(CANVAS_W, CANVAS_H, false);
    this.renderer.setScissorTest(true);
    this.scene.background = new THREE.Color(PALETTE.sky);

    const hw = this.halfWidth;
    this.topCam = new THREE.OrthographicCamera(-hw, hw, hw, -hw, 1, 5000);
    this.topCam.up.set(0, 0, -1); // world +X to the right, +Z downward on screen
    this.sideCam = new THREE.OrthographicCamera(-hw, hw, hw, -hw, 1, 5000);

    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0x8090a0, 1.1));

    // A plain, edgeless ground -- no trees or bushes -- so only the unit shows.
    this.ground = new InfiniteGround(this.scene);

    this.scene.add(this.headingArrow);
    this.scene.add(this.active.group);
    this.moveMarker = makeMoveMarker();
    this.moveMarker.visible = false;
    this.scene.add(this.moveMarker);

    this.overlays.set(this.spider, new DebugOverlay(this.spider, 4));
    this.overlays.set(this.walker, new DebugOverlay(this.walker, 4));
    this.applyLayers();
  }

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

  get unitState(): string {
    return this.active.locomotionState;
  }

  setUnit(kind: UnitKind): void {
    const next = kind === 'walker' ? this.walker : kind === 'robe' ? this.ensureRobe() : this.spider;
    if (next === this.active) return;
    this.scene.remove(this.active.group);
    this.active = next;
    this.activeKind = kind;
    this.scene.add(this.active.group);
    this.applyLayers();
  }

  /** Build the robed figure and its cloth overlay on first use. */
  private ensureRobe(): RobeRig {
    if (!this.robeRig) {
      this.robeRig = new RobeRig({ tuning: this.robeTuning });
      this.robeOverlay = new ClothDebugOverlay(this.robeRig);
      this.robeOverlay.setLayers(this.clothLayers);
    }
    return this.robeRig;
  }

  setClothLayers(layers: ClothLayers): void {
    this.clothLayers = layers;
    this.robeOverlay?.setLayers(layers);
  }

  setZoom(hw: number): void {
    this.halfWidth = hw;
  }

  setLayers(layers: DebugLayers): void {
    this.layers = layers;
    this.applyLayers();
  }

  private applyLayers(): void {
    if (this.active instanceof MechRig) this.overlays.get(this.active)?.setLayers(this.layers);
    else this.robeOverlay?.setLayers(this.clothLayers);
  }

  /** Raycast the cursor onto the ground through the top-down (left) viewport. */
  screenToWorld(cssX: number, cssY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    // The top view fills the left half of the canvas; map the cursor into it.
    const halfW = rect.width / 2;
    const ndcX = (Math.min(cssX, halfW) / halfW) * 2 - 1;
    const ndcY = -((cssY / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.topCam);
    const point = this.raycaster.ray.intersectPlane(this.groundPlane, this.hit);
    if (!point) return { x: this.target.x, y: this.target.z };
    return { x: point.x, y: point.z };
  }

  /**
   * Pose the rig from sim state (`dt` is sim time this frame, so slow-mo slows
   * the rig -- and the cloth -- too) and return the formatted numeric readout for
   * whichever unit is active.
   */
  render(state: CombatState, dt: number): string {
    const p = state.player;
    const ry = -p.facing;
    this.active.group.position.set(p.position.x, 0, p.position.y);
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

    let readout: string;
    if (this.active instanceof MechRig) {
      const snap = this.active.debugSnapshot();
      this.overlays.get(this.active)?.update(snap);
      readout = formatMechReadout(snap);
    } else {
      const rig = this.robeRig as RobeRig;
      this.robeOverlay?.update();
      readout = formatRobeReadout(rig.debugSnapshot());
    }

    this.target.set(p.position.x, 0, p.position.y);
    this.ground.recenter(p.position.x, p.position.y); // keep the floor edgeless
    this.updateCameras(ry);
    this.draw();
    return readout;
  }

  /** Follow the unit with both cameras; the side cam orbits so forward faces right. */
  private updateCameras(ry: number): void {
    // Refresh the shared ortho zoom only when it actually changed.
    if (Math.abs(this.halfWidth - this.drawnHalfWidth) > 0.01) {
      for (const cam of [this.topCam, this.sideCam]) {
        cam.left = -this.halfWidth;
        cam.right = this.halfWidth;
        cam.top = this.halfWidth;
        cam.bottom = -this.halfWidth;
        cam.updateProjectionMatrix();
      }
      this.drawnHalfWidth = this.halfWidth;
    }

    const tx = this.target.x;
    const tz = this.target.z;
    // Top-down: straight above, world-aligned.
    this.topCam.position.set(tx, 1500, tz);
    this.topCam.lookAt(tx, 0, tz);

    // Side: look along the unit's lateral axis so its forward (+x local) faces
    // screen-right and height runs up -- the profile view for reading leg swing.
    const latX = Math.sin(ry);
    const latZ = Math.cos(ry);
    // Centre the side view on the unit's mass: the humanoid stands far taller
    // than the mechs, and framing it on their body height cuts its head off.
    const midY = this.activeKind === 'robe' ? 48 * this.robeTuning.bodyScale : 30;
    this.sideCam.position.set(tx + latX * 1500, midY, tz + latZ * 1500);
    this.sideCam.up.set(0, 1, 0);
    this.sideCam.lookAt(tx, midY, tz);
  }

  private draw(): void {
    const r = this.renderer;
    const light = this.sun.position;
    light.set(this.target.x + 260, 700, this.target.z + 160);

    r.setViewport(0, 0, VIEW, VIEW);
    r.setScissor(0, 0, VIEW, VIEW);
    r.render(this.scene, this.topCam);

    r.setViewport(VIEW, 0, VIEW, VIEW);
    r.setScissor(VIEW, 0, VIEW, VIEW);
    r.render(this.scene, this.sideCam);
  }
}

/** Time-scale presets for the slow-motion control (Pause == 0). */
const TIME_SCALES: readonly { label: string; scale: number }[] = [
  { label: 'Pause', scale: 0 },
  { label: '0.1×', scale: 0.1 },
  { label: '0.25×', scale: 0.25 },
  { label: '0.5×', scale: 0.5 },
  { label: '1×', scale: 1 },
];

/** Build the debug-controls column: time scale, single-step, zoom, layers, angle readout. */
function buildDebugControls(opts: {
  onScale: (s: number) => void;
  onStep: () => void;
  onZoom: (hw: number) => void;
  onLayers: (l: DebugLayers) => void;
  onClothLayers: (l: ClothLayers) => void;
  onClothVisible: (v: boolean) => void;
  onBodyVisible: (v: boolean) => void;
}): { element: HTMLElement; setReadout: (text: string) => void; setUnit: (kind: UnitKind) => void } {
  const panel = document.createElement('div');
  panel.style.cssText =
    `${LABEL_CSS}width:280px;max-height:${CANVAS_H}px;overflow-y:auto;padding:10px 12px 12px;box-sizing:border-box;` +
    'background:#16161e;border:1px solid #2a2a3a;border-radius:8px;font-size:12px;';

  const heading = (text: string): HTMLElement => {
    const h = document.createElement('div');
    h.textContent = text;
    h.style.cssText = 'color:#f0f0f8;font-weight:600;margin:10px 0 5px;letter-spacing:.03em;';
    return h;
  };

  // --- Time control -------------------------------------------------------
  panel.appendChild(heading('Time'));
  const timeRow = document.createElement('div');
  timeRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
  const timeBtns: HTMLButtonElement[] = [];
  const styleTime = (btn: HTMLButtonElement, on: boolean): void => {
    btn.style.cssText =
      `${LABEL_CSS}flex:1;min-width:44px;padding:6px 4px;border-radius:6px;cursor:pointer;font-size:12px;border:1px solid #2a2a3a;` +
      (on ? 'background:#3a5c7a;color:#f0f0f8;' : 'background:#20202c;color:#9a9ab0;');
  };
  TIME_SCALES.forEach((ts, i) => {
    const btn = document.createElement('button');
    btn.textContent = ts.label;
    btn.title = ts.scale === 0 ? 'Freeze the sim (use Step to advance one tick).' : `Run at ${ts.label} real time.`;
    styleTime(btn, ts.scale === 1);
    btn.addEventListener('click', () => {
      timeBtns.forEach((b, j) => styleTime(b, j === i));
      opts.onScale(ts.scale);
    });
    timeRow.appendChild(btn);
    timeBtns.push(btn);
  });
  // Default the active chip to 1x.
  timeBtns.forEach((b, j) => styleTime(b, j === TIME_SCALES.length - 1));
  panel.appendChild(timeRow);

  const step = document.createElement('button');
  step.textContent = 'Step one tick ▸';
  step.title = 'Advance the sim by exactly one 60 Hz tick (works while paused).';
  step.style.cssText =
    `${LABEL_CSS}margin-top:6px;width:100%;padding:7px;border-radius:6px;cursor:pointer;` +
    'border:1px solid #2a2a3a;background:#2a2a3a;color:#f0f0f8;font-size:12px;';
  step.addEventListener('click', () => opts.onStep());
  panel.appendChild(step);

  // --- Zoom ---------------------------------------------------------------
  panel.appendChild(heading('Zoom'));
  const zoomRow = document.createElement('div');
  zoomRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
  zoomRow.title = 'Ortho half-width of both viewports (smaller = closer).';
  const zoom = document.createElement('input');
  zoom.type = 'range';
  zoom.min = '40';
  zoom.max = '300';
  zoom.step = '5';
  zoom.value = '120';
  zoom.style.cssText = 'flex:1;min-width:0;accent-color:#4a7fb0;';
  const zoomVal = document.createElement('span');
  zoomVal.textContent = '120';
  zoomVal.style.cssText = 'flex:0 0 34px;text-align:right;font-variant-numeric:tabular-nums;color:#e0e0ee;';
  zoom.addEventListener('input', () => {
    zoomVal.textContent = zoom.value;
    opts.onZoom(Number(zoom.value));
  });
  zoomRow.append(zoom, zoomVal);
  panel.appendChild(zoomRow);

  // --- Layers -------------------------------------------------------------
  // Two independent overlay sets: the mechs' leg diagnostics and the robe's
  // cloth diagnostics. Only the active unit's set is shown, so the column stays
  // short and no checkbox toggles something you cannot see.
  const mechOverlays = document.createElement('div');
  const clothOverlays = document.createElement('div');

  /** A labelled checkbox row that writes `key` on `flags` and reports the change. */
  const checkbox = (
    label: string,
    tip: string,
    checked: boolean,
    onChange: (value: boolean) => void,
  ): HTMLElement => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;';
    row.title = tip;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.style.accentColor = '#4a7fb0';
    cb.addEventListener('change', () => onChange(cb.checked));
    const span = document.createElement('span');
    span.textContent = label;
    row.append(cb, span);
    return row;
  };

  mechOverlays.appendChild(heading('Overlays'));
  const layers: DebugLayers = { skeleton: true, joints: true, targets: true, rings: true };
  const layerDefs: readonly { key: keyof DebugLayers; label: string; tip: string }[] = [
    { key: 'skeleton', label: 'Leg skeleton', tip: 'The hip → shoulder → knee → foot bone chain per leg.' },
    { key: 'joints', label: 'Joint dots', tip: 'A coloured dot at every joint (hip/shoulder/knee/foot).' },
    { key: 'targets', label: 'Foot targets', tip: 'Where each foot is planted / heading (ground ring) + the drawn foot.' },
    { key: 'rings', label: 'Rest + trigger', tip: "Each leg's rest spot and its step-trigger radius ring." },
  ];
  for (const def of layerDefs) {
    mechOverlays.appendChild(
      checkbox(def.label, def.tip, true, (v) => {
        layers[def.key] = v;
        opts.onLayers({ ...layers });
      }),
    );
  }

  clothOverlays.appendChild(heading('Cloth overlays'));
  const cloth = defaultClothLayers();
  const clothDefs: readonly { key: keyof ClothLayers; label: string; tip: string }[] = [
    { key: 'particles', label: 'Particles', tip: 'Every cloth particle: cyan where pinned to a bone, pale where simulated.' },
    { key: 'links', label: 'Links (strain)', tip: 'Structural and shear constraints, coloured green → yellow → red by how far they are strained toward the Max stretch cap.' },
    { key: 'bend', label: 'Bend links', tip: 'The second-order constraints that resist folding. Drawn separately because they clutter the mesh.' },
    { key: 'colliders', label: 'Body capsules', tip: 'The capsules the cloth is pushed out of. If fabric is clipping the body, check these first.' },
    { key: 'reference', label: 'Reference pose', tip: 'The skinned rest pose the pose-retention spring pulls toward — where the garment would hang if it were rigid.' },
    { key: 'skeleton', label: 'Bone chain', tip: "The figure's skeleton under the robe." },
    { key: 'wind', label: 'Wind vector', tip: 'An arrow above the figure showing the current wind direction; its length is the wind strength.' },
  ];
  for (const def of clothDefs) {
    clothOverlays.appendChild(
      checkbox(def.label, def.tip, cloth[def.key], (v) => {
        cloth[def.key] = v;
        opts.onClothLayers({ ...cloth });
      }),
    );
  }
  clothOverlays.appendChild(
    checkbox('Draw garments', 'Hide the shaded cloth to see the simulation overlays unobstructed.', true, opts.onClothVisible),
  );
  clothOverlays.appendChild(
    checkbox('Draw figure', 'Hide the solid body under the robe, to check what the garments alone cover.', true, opts.onBodyVisible),
  );

  panel.append(mechOverlays, clothOverlays);

  // --- Numeric readout ----------------------------------------------------
  const readoutHeading = heading('Joint angles');
  panel.appendChild(readoutHeading);
  const readout = document.createElement('pre');
  readout.style.cssText =
    `${MONO_CSS}margin:0;font-size:11px;line-height:1.45;color:#d0d6e6;white-space:pre;` +
    'background:#0e0e14;border:1px solid #2a2a3a;border-radius:6px;padding:8px;overflow-x:auto;';
  readout.textContent = '—';
  panel.appendChild(readout);

  const setUnit = (kind: UnitKind): void => {
    const isRobe = kind === 'robe';
    mechOverlays.style.display = isRobe ? 'none' : 'block';
    clothOverlays.style.display = isRobe ? 'block' : 'none';
    readoutHeading.textContent = isRobe ? 'Cloth state' : 'Joint angles';
  };
  setUnit('spider');

  return { element: panel, setReadout: (t) => (readout.textContent = t), setUnit };
}

const LEG_NAMES = ['FL', 'FR', 'BL', 'BR'] as const;

/** Format a signed fixed-width degree value. */
function deg(v: number): string {
  return `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(0).padStart(3, ' ')}`;
}

/** Render the per-leg angle table + summary line for the mech readout. */
function formatMechReadout(snap: MechDebug): string {
  const rows = [' leg  swing femur knee  tibia  state'];
  snap.legs.forEach((d, i) => {
    const name = (LEG_NAMES[i] ?? '??').padEnd(3, ' ');
    const s = d.held ? 'held' : d.stepping ? 'step' : 'plant';
    rows.push(
      ` ${name} ${deg(d.coxaSwingDeg)}  ${deg(d.femurPitchDeg)}  ${d.kneeDeg.toFixed(0).padStart(3, ' ')}  ${deg(d.tibiaPitchDeg)}  ${s}`,
    );
  });
  rows.push('');
  rows.push(` state: ${snap.state}   yaw-lag: ${deg(snap.bodyYawLagDeg)}°`);
  return rows.join('\n');
}

/**
 * Render the robe's cloth readout: per-piece particle/link counts and the worst
 * strain in each, then the motion the forces are derived from, the wind, and
 * what the solve actually cost. The strain column is the one to watch while
 * tuning -- anything creeping toward the Max stretch setting means the fabric is
 * being asked for more than the constraint solve can deliver.
 */
function formatRobeReadout(snap: RobeDebug): string {
  const rows = [' piece     parts links  strain'];
  for (const p of snap.pieces) {
    rows.push(
      ` ${p.name.padEnd(8, ' ')} ${String(p.count).padStart(5, ' ')} ${String(p.links).padStart(5, ' ')}  ${p.stretch.toFixed(3)}`,
    );
  }
  rows.push('');
  rows.push(` gait:   ${snap.gait.padEnd(9, ' ')} stride: ${snap.stridePhase.toFixed(2)}`);
  rows.push(` speed:  ${snap.speed.toFixed(0).padStart(4, ' ')} u/s     accel: ${deg(snap.accel)}`);
  rows.push(` turn:   ${snap.turnRate.toFixed(2).padStart(5, ' ')} rad/s  idle:  ${snap.idle.toFixed(2)}`);
  rows.push(` lift:   ${snap.liftY.toFixed(1).padStart(5, ' ')}        jump:  ${snap.jumpState}`);
  rows.push(` wind:   ${snap.windSpeed.toFixed(0).padStart(4, ' ')} u/s     dir:   ${deg(snap.windHeadingDeg)}°`);
  rows.push('');
  rows.push(` solve:  ${snap.solveMs.toFixed(2)} ms  ·  ${snap.particles} particles, ${snap.links} links`);
  return rows.join('\n');
}

/**
 * Mount the rig debug viewport into `container`, returning a start/stop handle.
 * The loop is the sandbox's fixed-timestep one, scaled by the slow-motion time
 * factor (so real elapsed time becomes fewer ticks), with a single-step button
 * that injects exactly one tick while paused. The scene reads state + the rig's
 * debug snapshot; the tuning panel edits the rig live.
 */
export function mountDebug(container: HTMLElement): ViewHandle {
  const root = document.createElement('div');
  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;';
  root.appendChild(layout);

  const left = document.createElement('div');
  const status = document.createElement('div');
  status.style.cssText = `${LABEL_CSS}margin:6px 2px 8px;font-size:13px;`;
  left.appendChild(status);

  // Little TOP / SIDE captions over the two viewports.
  const caps = document.createElement('div');
  caps.style.cssText = `${LABEL_CSS}display:flex;width:${CANVAS_W}px;margin:0 0 4px;font-size:11px;color:#9a9ab0;letter-spacing:.08em;`;
  const capTop = document.createElement('div');
  capTop.textContent = 'TOP · world-aligned';
  capTop.style.cssText = `width:${VIEW}px;text-align:center;`;
  const capSide = document.createElement('div');
  capSide.textContent = 'SIDE · faces right';
  capSide.style.cssText = `width:${VIEW}px;text-align:center;`;
  caps.append(capTop, capSide);
  left.appendChild(caps);

  const canvas = document.createElement('canvas');
  left.appendChild(canvas);
  layout.appendChild(left);
  container.appendChild(root);

  const seed = viewSeed();
  const scene = new DebugScene(canvas);
  const tuning = scene.tuning;
  const input = new IsoInputCapture(canvas);
  let state: CombatState = initCombat(seed, { ambientSpawner: false, initialEnemies: 0 });

  let timeScale = 1;
  let pendingSteps = 0;

  const controls = buildDebugControls({
    onScale: (s) => {
      timeScale = s;
    },
    onStep: () => {
      pendingSteps += 1;
    },
    onZoom: (hw) => scene.setZoom(hw),
    onLayers: (l) => scene.setLayers(l),
    onClothLayers: (l) => scene.setClothLayers(l),
    onClothVisible: (v) => scene.robeUnit?.setClothVisible(v),
    onBodyVisible: (v) => scene.robeUnit?.setBodyVisible(v),
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
      controls.setUnit(kind);
    },
    onJump: () => scene.robeUnit?.jump(),
    onDrop: () => scene.robeUnit?.drop(),
    onGust: () => scene.robeUnit?.gust(),
    onResettle: () => scene.robeUnit?.resettle(),
  });

  layout.appendChild(controls.element);
  layout.appendChild(panel.element);

  const setStatus = (): void => {
    const name = characterAt(state.player.characterIndex).name;
    const unitName = unit === 'walker' ? 'Mech (grey)' : unit === 'robe' ? 'Hooded robe' : 'Spider';
    const t = timeScale === 0 ? 'paused' : `${timeScale}×`;
    status.textContent =
      `Rig debug · Unit: ${unitName} · Archetype: ${name} (C to cycle) · gait: ${scene.unitState} · time: ${t}` +
      ` · right-click (top view) to move`;
  };
  setStatus();

  let lastCharacter = state.player.characterIndex;
  const syncCharacter = (): void => {
    if (state.player.characterIndex === lastCharacter) return;
    lastCharacter = state.player.characterIndex;
    const c = characterAt(lastCharacter);
    tuning.moveSpeed = c.moveSpeed;
    tuning.turnRate = c.turnRate;
    panel.sync();
  };

  const stepOnce = (): void => {
    const cursor = input.mouseCanvas();
    const worldCursor = scene.screenToWorld(cursor.x, cursor.y);
    const s = input.sample(worldCursor, state.player.position, null);
    const combatInput: InputFrame = {
      attack: false,
      aimX: s.aimX,
      aimY: s.aimY,
      parry: false,
      dodge: false,
      moveSpeedOverride: Number.isFinite(tuning.moveSpeed) ? tuning.moveSpeed : 147.5,
      turnRateOverride: Number.isFinite(tuning.turnRate) ? tuning.turnRate : 180,
      ...(s.moveTarget ? { moveTarget: s.moveTarget } : {}),
      ...(s.cycleCharacter ? { cycleCharacter: true } : {}),
    };
    state = step(state, combatInput).state;
    // Cosmetic hop (spec 037): never enters the sim's input frame.
    if (input.takeJump()) scene.robeUnit?.jump();
    syncCharacter();
  };

  let running = false;
  let accumulator = 0;
  let lastFrame: number | undefined;

  const frame = (time: number): void => {
    if (!running) return;
    if (lastFrame !== undefined) {
      // Scale real elapsed time by the slow-motion factor, then convert to ticks.
      accumulator = Math.min(accumulator + (time - lastFrame) * timeScale, TICK_MS * MAX_CATCH_UP);
    }
    lastFrame = time;

    let ticks = 0;
    while (accumulator >= TICK_MS) {
      stepOnce();
      accumulator -= TICK_MS;
      ticks++;
    }
    // Single-step button: advance exactly one tick regardless of time scale.
    while (pendingSteps > 0) {
      stepOnce();
      pendingSteps--;
      ticks++;
    }

    // Feed the rig the sim time that actually elapsed, so slow-mo slows the legs
    // and the cloth (and a paused frame poses the rig at dt≈0 -- it holds its
    // last state, which is exactly what makes single-stepping the solver useful).
    controls.setReadout(scene.render(state, ticks / TICK_RATE));
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
