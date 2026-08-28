import * as THREE from 'three';
import GUI from 'lil-gui';
import { characterAt } from '../../sim/characters.js';
import { ARENA_HEIGHT, ARENA_WIDTH, TICK_RATE } from '../../sim/constants.js';
import type { Vec2, WorldColliders } from '../../sim/types.js';
import { createWorldColliders } from '../../sim/collision.js';
import { defaultRobeTuning, type RobeTuning } from '../cloth/params.js';
import { SandboxInput } from './sandbox-input.js';
import { initMover, stepMover, type MoverInput, type MoverState } from './sandbox-mover.js';
import type { ViewHandle } from './view-handle.js';
import { PALETTE } from './palette.js';
import { makeHeadingArrow, makeMoveMarker, makeUnwalkableField } from './meshes.js';
import {
  createArenaWorld,
  vegetationColliders,
  worldVegetation,
  type Prop,
  type TerrainWorld,
} from '../../terrain/index.js';
import { buildTerrainMesh } from './terrain-mesh.js';
import {
  defaultMechAppearance,
  defaultMechTuning,
  MechRig,
  type MechAppearance,
  type MechTuning,
} from './rigs.js';
import { monsterLookFor, type MechRigTuning } from './world/monster-look.js';
import { buildPropField } from './props.js';
import { RobeRig } from './robe.js';
import { ROBE_TUNING_GROUPS } from './robe-panel.js';
import { CritterRig, defaultCritterTuning, type CritterTuning } from './critter.js';
import { buildCoatPicker, CRITTER_TUNING_GROUPS } from './critter-panel.js';
import { CRITTERS, CRITTER_IDS, isCritterId, type CritterId } from '../critters/index.js';
import {
  addTuningGroups,
  embedGui,
  fitPanelHeight,
  LABEL_CSS,
  type TuningGroup,
} from './tuning-panel.js';
import { authoredIdOf, isAuthoredKind, type SandboxUnit, type UnitKind } from './unit.js';
import { AuthoredUnit } from './authored-unit.js';
import { authoredUnitAssets, authoredUnitIds, authoredUnitRefusal } from './world/unit-assets.js';
import { weaponAssets, weaponIds } from './weapon-assets.js';
import { SandboxDummy, DUMMY_DISTANCE } from './sandbox-dummy.js';
import {
  ATTACK_READY,
  defaultAttackTuning,
  stepAttack,
  type AttackState,
  type AttackTuning,
} from './sandbox-attack.js';
import { createViewControls, type ViewControls } from './view-controls.js';
import { CAMERA_FAR, CAMERA_NEAR, DEFAULT_CAMERA_OFFSET, DEFAULT_VIEW_HALF_WIDTH } from './view-settings.js';
import { viewSeed } from './seed.js';

// Per-frame easing fraction for camera framing changes (spec 034), matching IsoScene.
const CAMERA_SMOOTH = 0.15;

/** The monster id whose look the sandbox's small-spider chip mirrors. */
const SMALL_SPIDER_ID = 'small_spider';

/**
 * What each mech chip loads into the two shared records (spec 152).
 *
 * The mechs have always shared one tuning object, which is what makes the
 * panel's mech section one set of sliders rather than one per unit. A third
 * mech with *different* numbers therefore has to load them, exactly as the C key
 * already loads an archetype preset and the reset button loads the defaults.
 *
 * The two halves carry separate ids because they change on different picks.
 * Spider and walker have always differed in colour and never in tuning, so
 * moving between them must not touch a slider somebody has dragged -- while
 * moving to or from the small spider must, or the chip shows a body that is not
 * the one in the game.
 */
interface MechPreset {
  /** Which chips share this tuning; picking within a group loads nothing. */
  readonly tuningId: string;
  /** Overrides on top of `defaultMechTuning()`. Empty is the default mech. */
  readonly tuning: MechRigTuning;
  readonly appearanceId: string;
  readonly appearance: MechAppearance;
}

const MECH_PRESETS: Readonly<Record<string, MechPreset>> = {
  spider: {
    tuningId: 'default',
    tuning: {},
    appearanceId: 'spider',
    appearance: defaultMechAppearance(PALETTE.mechAlly),
  },
  walker: {
    tuningId: 'default',
    tuning: {},
    appearanceId: 'walker',
    appearance: defaultMechAppearance(PALETTE.walkerBody),
  },
  'spider-small': {
    tuningId: 'small-spider',
    // Read from the table the game draws it from rather than copied, so the
    // sandbox cannot show a spider the arena does not have.
    tuning: monsterLookFor(SMALL_SPIDER_ID)?.tuning ?? {},
    appearanceId: 'small-spider',
    appearance:
      monsterLookFor(SMALL_SPIDER_ID)?.appearance ?? defaultMechAppearance(PALETTE.mechAlly),
  },
};

/**
 * The movement sandbox tab (spec 032/033/046, restored by 066): no game -- just
 * one controllable unit driven through MOBA movement so the turn-rate rules, the
 * units' legs and the robed figure's cloth can be watched and *tuned* in
 * isolation. A unit picker switches between the organic spider mech, a grey
 * metal walker (a rotating turret on a fixed animated leg base), the hooded robe
 * character and every critter species.
 *
 * It drove the single-player combat sim until 062 deleted that; it now drives
 * the sandbox mover (spec 066), which is the small pure thing this tab always
 * actually wanted -- a position, a heading and a move order -- rather than a
 * second simulation. The inputs are the same three: a right-click move order, C
 * to cycle the movement archetype, J to hop, plus live speed/turn-rate overrides
 * from the side panel. Every other knob edits the active unit's cosmetic tuning.
 * This layer only reads mover state and poses the (cosmetic) rig.
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
  // No day/night, player lights or colour filter here (spec 047): the sandbox
  // keeps the single unshadowed light it has had since spec 045 and runs no
  // post pass, so those rows would be controls that visibly do nothing.
  readonly controls: ViewControls = createViewControls({
    zoom: DEFAULT_VIEW_HALF_WIDTH,
    lighting: false,
  });
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  // Every mech shares one tuning object and one appearance object, so the panel
  // drives whichever is active; the chips differ in what they *load* into the
  // two (see MECH_PRESETS) and, for the grey walker, a non-turning lower body.
  private readonly sharedTuning: MechTuning = defaultMechTuning();
  private readonly sharedAppearance: MechAppearance = defaultMechAppearance(PALETTE.mechAlly);
  private readonly spider = new MechRig('ally', PALETTE.mechAlly, {
    tuning: this.sharedTuning,
    appearance: this.sharedAppearance,
  });
  private readonly walker = new MechRig('ally', PALETTE.walkerBody, {
    tuning: this.sharedTuning,
    appearance: this.sharedAppearance,
    lowerBodyTurns: false,
  });
  /**
   * The shipped small spider (spec 152) as a third body on the same rig, so the
   * enemy that is in the game can be tuned rather than a lookalike rebuilt from
   * memory. It shares the two records like the others; its chip loads the look
   * table's values into them.
   */
  private readonly smallSpider = new MechRig('small_spider', undefined, {
    tuning: this.sharedTuning,
    appearance: this.sharedAppearance,
  });
  /** Which preset is currently loaded into each shared record; see `loadMechPreset`. */
  private loadedTuningPreset = 'default';
  private loadedAppearancePreset = 'spider';
  /** The robed figure (spec 046), built lazily so its cloth costs nothing unless picked. */
  private robeRig: RobeRig | null = null;
  private readonly robeTuning: RobeTuning = defaultRobeTuning();
  /**
   * The critters (spec 055), also built lazily, and each remembering its own
   * coat -- so switching pig -> cow -> pig comes back to the colour that was
   * picked rather than resetting to the species default.
   */
  private readonly critterRigs = new Map<CritterId, CritterRig>();
  private readonly critterTuning: CritterTuning = defaultCritterTuning();
  private active: SandboxUnit = this.spider;
  private activeCritter: CritterRig | null = null;
  /**
   * The authored units (spec 140), built lazily and kept: a body is three
   * documents and four `.glb`s over the network, so switching away and back
   * should not pay for it twice.
   */
  private readonly authoredUnits = new Map<string, AuthoredUnit>();
  private activeAuthored: AuthoredUnit | null = null;
  /** Something to hit, and the only thing in this tab that reacts to a swing. */
  private readonly dummy = new SandboxDummy();
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
    this.scene.add(this.unwalkable);

    // A scene-managed heading arrow shows the facing for either unit (the walker
    // keeps its group un-yawed, so the arrow can't be parented to it).
    this.scene.add(this.headingArrow);
    this.scene.add(this.active.group);
    this.moveMarker = makeMoveMarker();
    this.moveMarker.visible = false;
    this.scene.add(this.moveMarker);

    // Something to hit (spec 140), standing in front of the spawn so a swing
    // has a subject without anybody having to walk anywhere first.
    const dummyX = ARENA_WIDTH / 2 + DUMMY_DISTANCE;
    const dummyZ = ARENA_HEIGHT / 2;
    this.dummy.group.position.set(dummyX, this.terrain.heightAt(dummyX, dummyZ), dummyZ);
    this.dummy.group.rotation.y = Math.PI / 2;
    this.scene.add(this.dummy.group);

    // The wheel over the view is the zoom, alongside the panel's slider (spec 042).
    this.controls.attachWheelZoom(canvas);
  }

  /** The static world the sim collides against here: the vegetation (spec 044). */
  worldColliders(): WorldColliders {
    return createWorldColliders([], vegetationColliders(this.vegetation));
  }

  /** The shared live-editable tuning every mech uses (the panel binds to it). */
  get tuning(): MechTuning {
    return this.sharedTuning;
  }

  /** The shared live-editable shape and colours (the colour wells bind to it). */
  get appearance(): MechAppearance {
    return this.sharedAppearance;
  }

  /** The robe's live-editable tuning (the panel binds to it). */
  get robe(): RobeTuning {
    return this.robeTuning;
  }

  /** The robed figure, once it has been picked at least once. */
  get robeUnit(): RobeRig | null {
    return this.robeRig;
  }

  /** The critters' shared live-editable tuning (the panel binds to it). */
  get critter(): CritterTuning {
    return this.critterTuning;
  }

  /** The critter currently being controlled, if the active unit is one. */
  get critterUnit(): CritterRig | null {
    return this.activeCritter;
  }

  /** The active unit's locomotion state, for the status line. */
  get unitState(): string {
    return this.active.locomotionState;
  }

  /** The authored unit currently being controlled, if the active unit is one. */
  get authoredUnit(): AuthoredUnit | null {
    return this.activeAuthored;
  }

  /** The dummy, so the loop can settle it when a swing lands. */
  get hitTarget(): SandboxDummy {
    return this.dummy;
  }

  /**
   * Swap the controllable unit, keeping the sim (position/heading) running.
   *
   * Returns whether the panel's controls need re-reading, which is true exactly
   * when a mech chip loaded a preset the sliders are not already showing.
   */
  setUnit(kind: UnitKind): boolean {
    const critter = isCritterId(kind) ? this.ensureCritter(kind) : null;
    const authored = isAuthoredKind(kind) ? this.ensureAuthored(authoredIdOf(kind)) : null;
    this.activeCritter = critter;
    this.activeAuthored = authored;
    const loaded = this.loadMechPreset(kind);
    const next =
      authored ??
      critter ??
      (kind === 'walker'
        ? this.walker
        : kind === 'robe'
          ? this.ensureRobe()
          : kind === 'spider-small'
            ? this.smallSpider
            : this.spider);
    if (next !== this.active) {
      this.scene.remove(this.active.group);
      this.active = next;
      this.scene.add(this.active.group);
    }
    return loaded;
  }

  /**
   * Load a mech chip's preset into the two shared records, and say whether
   * anything moved.
   *
   * Each half is loaded only when its id changes, so picking between two chips
   * that agree about it leaves a dragged slider or a picked colour alone. With
   * `force` it always loads, which is what the reset button wants: reset while
   * the small spider is up should restore the *small spider*, not the mech.
   */
  private loadMechPreset(kind: UnitKind, force = false): boolean {
    const preset = MECH_PRESETS[kind];
    if (preset === undefined) return false;
    let loaded = false;
    if (force || preset.tuningId !== this.loadedTuningPreset) {
      this.loadedTuningPreset = preset.tuningId;
      Object.assign(this.sharedTuning, defaultMechTuning(), preset.tuning);
      loaded = true;
    }
    if (force || preset.appearanceId !== this.loadedAppearancePreset) {
      this.loadedAppearancePreset = preset.appearanceId;
      Object.assign(this.sharedAppearance, preset.appearance);
      loaded = true;
    }
    return loaded;
  }

  /** Restore the active mech chip's own preset, for the panel's reset button. */
  resetMech(kind: UnitKind): void {
    this.loadMechPreset(kind, true);
  }

  /**
   * Build an authored unit on first use and start its documents loading.
   *
   * The load is deliberately not awaited: `setUnit` is called from a click
   * handler, and a picker that froze until a mesh arrived would be a worse tool
   * than one that shows an empty group for a frame. `UnitRig` draws nothing
   * until it resolves and says why in `error` if it never does.
   */
  private ensureAuthored(id: string): AuthoredUnit | null {
    const existing = this.authoredUnits.get(id);
    if (existing) return existing;

    const found = authoredUnitAssets(id);
    if (!found?.skeleton) {
      console.error(`[sandbox] no authored unit "${id}": ${authoredUnitRefusal(id) ?? 'it has no skeleton document'}`);
      return null;
    }
    const unit = new AuthoredUnit({
      unit: found.unit,
      clipLib: found.clipLib,
      skeleton: found.skeleton,
      assets: found.assets,
    });
    this.authoredUnits.set(id, unit);
    void unit.load();
    return unit;
  }

  /** Build the robed figure on first use; its cloth is not free to construct. */
  private ensureRobe(): RobeRig {
    this.robeRig ??= new RobeRig({ tuning: this.robeTuning });
    return this.robeRig;
  }

  /** Build a critter on first use, sharing the one tuning object the panel edits. */
  private ensureCritter(id: CritterId): CritterRig {
    let rig = this.critterRigs.get(id);
    if (!rig) {
      rig = new CritterRig(CRITTERS[id], { tuning: this.critterTuning });
      this.critterRigs.set(id, rig);
    }
    return rig;
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

  render(p: MoverState): void {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;

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

/**
 * Movement knobs that are *mover inputs* rather than cosmetics, so they apply to
 * whichever unit is active and stay visible in the panel at all times. They live
 * on the mech tuning purely because that is the object the sandbox already feeds
 * to the mover as its per-tick overrides.
 */
const MOVEMENT_GROUP: TuningGroup<MechTuning> = {
  title: 'Movement',
  rows: [
    {
      label: 'Move speed',
      min: 100,
      max: 400,
      step: 5,
      key: 'moveSpeed',
      tip: 'Base travel speed in world units per second (clamped to 100–550). Fed to the mover as a live override.',
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

/**
 * The attack timings (spec 140), which drive the rehearsal rather than any rig.
 *
 * Beside the movement group and above the unit's own knobs, because these two
 * are what the *body* does and everything below them is what the body looks
 * like. Dragging the wind-up retimes the swing: the clip is rescaled to fit the
 * timing, never the other way round, which is the rule this tab exists to make
 * visible.
 */
const ATTACK_GROUP: TuningGroup<AttackTuning> = {
  title: 'Attack',
  rows: [
    {
      label: 'Wind-up (ms)',
      min: 100,
      max: 1600,
      step: 10,
      key: 'windupMs',
      tip: 'From committing to the blow to the blow landing. melee.slash ships at 500ms. The swing is rescaled to fit this, so a long wind-up is a slow swing rather than a pause before a fast one.',
    },
    {
      label: 'Active (ms)',
      min: 20,
      max: 600,
      step: 10,
      key: 'activeMs',
      tip: 'How long the blade is considered to be passing through. Animation only here -- the server frees the caster at the release.',
    },
    {
      label: 'Recovery (ms)',
      min: 0,
      max: 900,
      step: 10,
      key: 'recoveryMs',
      tip: 'The settle after the blow. Part of what the clip is stretched over, so a longer recovery slows the whole swing.',
    },
    {
      label: 'Cooldown (ms)',
      min: 100,
      max: 3000,
      step: 25,
      key: 'cooldownMs',
      tip: 'From the START of one swing to when the next may begin, which is how melee.slash stamps it -- a long wind-up eats into the cooldown rather than adding to it.',
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
        label: 'Body size',
        min: 0.2,
        max: 3,
        step: 0.05,
        key: 'bodySize',
        digits: 2,
        tip:
          'How big the body is against its own legs — the sphere’s radius on a round body, the chassis and everything bolted to it on a boxy one. ' +
          'Separate from Size, which moves the body and the legs together and so cannot change the proportion between them.',
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

/**
 * The mech's colours (spec 152), in their own group because they are the two
 * rows in this panel that are not numbers you drag.
 *
 * The hex beside each well is the readout on purpose: it is what somebody
 * copies out of here and pastes into `monster-look.ts` or the palette.
 */
const MECH_LOOK_GROUP: TuningGroup<MechAppearance> = {
  title: 'Colour',
  rows: [
    {
      label: 'Body',
      key: 'bodyColor',
      swatch: true,
      tip: 'The upper body’s colour. The chassis variant darkens its own top plate off this; the sphere is this exact colour.',
    },
    {
      label: 'Legs',
      key: 'legColor',
      swatch: true,
      tip: 'The legs’ colour. The hip and the shin are drawn a little darker than this, so a leg still reads as three segments.',
    },
  ],
};

/** Everything the sandbox panel needs to drive: the tunings and a set of actions. */
export interface SandboxPanelOptions {
  /** The mech tuning (also the holder of the sim move-speed/turn-rate overrides). */
  readonly mech: MechTuning;
  /**
   * The mech's live shape and colours (spec 152), edited by the colour wells.
   *
   * Optional for the same reason `attack` is: the rig debugger mounts this panel
   * over two mechs whose colours are fixed at construction, so absent means the
   * colour rows are never shown rather than shown and inert.
   */
  readonly appearance?: MechAppearance;
  /** The robed figure's cloth/figure/wind tuning. */
  readonly robe: RobeTuning;
  /** The critters' shared cosmetic tuning. */
  readonly critter: CritterTuning;
  /**
   * The attack rehearsal's timings (spec 140), edited live like the rest.
   *
   * Optional, because the rig debugger mounts this same panel and has no
   * authored unit to swing anything: absent means the attack rows and the
   * weapon picker are never built into the tree at all, rather than built and
   * hidden. A control that visibly does nothing is this tab's one standing rule
   * against itself (spec 047).
   */
  readonly attack?: AttackTuning;
  /** Restore the active unit's tuning to its defaults. */
  readonly onReset: () => void;
  readonly onUnit: (kind: UnitKind) => void;
  /** Recolour the active critter. */
  readonly onCoat: (hex: number) => void;
  /** The coat the active critter is wearing, so the picker can show it. */
  readonly coatOf: (kind: UnitKind) => number | null;
  /** Robe-only actions, exposed as buttons alongside its sliders. */
  readonly onJump: () => void;
  readonly onDrop: () => void;
  readonly onGust: () => void;
  readonly onResettle: () => void;
  /** Throw a swing from the panel, for somebody who would rather click than type. */
  readonly onSwing?: () => void;
  /** Put a weapon in the hand, or `null` to empty it. */
  readonly onWeapon?: (id: string | null) => void;
  /** Draw it or sheathe it. */
  readonly onSheathed?: (sheathed: boolean) => void;
}

export interface SandboxPanel {
  readonly element: HTMLElement;
  /** Push every tuning's current values back into the controls (after a reset). */
  sync(): void;
  /**
   * Re-measure the column so it runs to the bottom of the window.
   *
   * Called by the tab's `start()` rather than at build time, because the shell
   * makes a tab visible and only then starts it -- and a panel measured while
   * its tab is `display:none` has no box to measure.
   */
  fit(): void;
}

/**
 * The units the picker offers, in order: the three hand-built rigs, then one
 * chip per critter species, generated from the registry -- so a new animal
 * appears here without this file changing.
 */
const UNIT_CHIPS: readonly { kind: UnitKind; label: string; tip: string }[] = [
  {
    kind: 'spider',
    label: 'Spider',
    tip: 'Control the organic spider mech — its whole body turns to face where it moves.',
  },
  {
    kind: 'spider-small',
    label: 'Small spider',
    tip: 'The enemy that is in the game (spec 152), loaded from the same look table the arena draws it from — so the size, gait and colours below are the shipped ones, ready to be changed.',
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
  ...CRITTER_IDS.map((id) => ({
    kind: id as UnitKind,
    label: CRITTERS[id].name,
    tip: `${CRITTERS[id].blurb} Pick a coat below to recolour it.`,
  })),
  // One chip per authored unit (spec 140), generated from what this build has --
  // so exporting a unit puts it in the picker without this file changing, the
  // same property the critter chips above have.
  ...authoredUnitIds().map((id) => ({
    kind: `authored:${id}` as UnitKind,
    label: id.replace(/_/g, ' '),
    tip: `The authored unit "${id}": a generated body posed by its own state machine, with a weapon in its hand. Space swings it.`,
  })),
];

/**
 * Build the side control panel (spec 032, on lil-gui since 152).
 *
 * The unit picker swaps which folders are shown -- the mech's leg/gait knobs or
 * the robe's fabric, force and wind knobs -- while the movement group stays
 * visible for all of them, since it drives the mover rather than any rig.
 *
 * The picker is a dropdown rather than the row of chips it used to be, and that
 * is a fix rather than a translation: the chips were one flex row across a
 * 300px panel, and the roster has grown past what that can hold -- with two
 * critters and one authored unit the last chip was already being clipped
 * mid-word. A list that is as long as the roster costs one click and cannot
 * overflow.
 */
export function buildPanel(opts: SandboxPanelOptions): SandboxPanel {
  const panel = document.createElement('div');
  // No cap of its own: `fit` measures where the column starts and runs it to
  // the bottom of the window. `100vh` until then, so the very first frame is
  // bounded by something even if it is never fitted.
  panel.style.cssText = `${LABEL_CSS}width:300px;max-height:100vh;overflow-y:auto;box-sizing:border-box;`;

  const help = document.createElement('div');
  help.style.cssText =
    'line-height:1.5;color:#9a9ab0;margin:6px 0 10px;font-size:12px;background:#16161e;' +
    'border:1px solid #2a2a3a;border-radius:8px;padding:8px 10px;';
  help.innerHTML =
    '<b style="color:#f0f0f8;">Movement sandbox</b><br>' +
    '<b>Right-click</b> the ground to move. MOBA turn-rate: the unit turns to face ' +
    'the destination before it travels.<br>' +
    '<b>C</b> loads the next archetype preset into the sliders. ' +
    '<b>J</b> makes the robed figure or the critter hop.<br>' +
    'Pick a unit below.';
  panel.appendChild(help);

  const gui = embedGui(new GUI({ container: panel, title: 'Tuning', width: 300 }));

  const unitState = { unit: (UNIT_CHIPS[0]?.kind ?? 'spider') as UnitKind };
  const unitOptions: Record<string, UnitKind> = {};
  for (const chip of UNIT_CHIPS) unitOptions[chip.label] = chip.kind;
  const unit = gui
    .add(unitState, 'unit', unitOptions)
    .name('Unit')
    .onChange((kind: UnitKind) => {
      // Swap the unit *before* refreshing the panel: `showUnit` reads the new
      // unit's coat, which does not exist until the rig has been built.
      opts.onUnit(kind);
      showUnit(kind);
    });
  unit.domElement.title =
    'Which unit the sandbox controls. The folders below follow the choice, and each unit’s tips describe it.';

  const movement = addTuningGroups(gui, [MOVEMENT_GROUP], opts.mech);
  const attackTarget = opts.attack ?? null;
  const attack = addTuningGroups(gui, [ATTACK_GROUP], attackTarget ?? defaultAttackTuning());

  // The authored unit's own controls: a swing, a weapon, and whether it is
  // drawn. Built once and shown only for an authored unit, the same way the
  // robe's cloth buttons are.
  const held = gui.addFolder('Weapon');
  const weaponNames: Record<string, string> = { None: '' };
  for (const id of weaponIds()) weaponNames[weaponAssets(id)?.def.name ?? id] = id;
  const heldState = {
    swing: () => opts.onSwing?.(),
    weapon: weaponIds()[0] ?? '',
    sheathed: false,
  };
  held
    .add(heldState, 'swing')
    .name('Swing')
    .domElement.title =
    'Throw one attack (or press Space). Refused while the last one is still running or on cooldown.';
  held
    .add(heldState, 'weapon', weaponNames)
    .name('Held')
    .onChange((id: string) => opts.onWeapon?.(id === '' ? null : id))
    .domElement.title =
    'Which held object to hold. Which hand it goes in is the weapon document\'s own `socket` -- the swords take weapon.main and the bow takes weapon.off. Read from assets/items/, so a new weapon appears here on its own.';
  held
    .add(heldState, 'sheathed')
    .name('Sheathed (weapon.stow)')
    .onChange((on: boolean) => opts.onSheathed?.(on))
    .domElement.title =
    'Move the weapon to the stow socket on the back. Instant -- the unsheathing animation is not built yet.';

  const mech = addTuningGroups(gui, MECH_TUNING_GROUPS, opts.mech);
  const lookTarget = opts.appearance ?? null;
  const mechLook = addTuningGroups(gui, [MECH_LOOK_GROUP], lookTarget ?? defaultMechAppearance(0));
  const robe = addTuningGroups(gui, ROBE_TUNING_GROUPS, opts.robe);

  // Robe-only actions: the discrete events the cloth reacts to, which cannot be
  // produced by dragging a slider.
  const cloth = gui.addFolder('Cloth actions');
  const clothActions = {
    jump: () => opts.onJump(),
    drop: () => opts.onDrop(),
    gust: () => opts.onGust(),
    resettle: () => opts.onResettle(),
  };
  cloth.add(clothActions, 'jump').name('Jump').domElement.title =
    'Hop the figure (or press J) and watch the robe trail, then flare on landing.';
  cloth.add(clothActions, 'drop').name('Drop').domElement.title =
    'Drop the figure from a height, to watch the robe billow through a long fall.';
  cloth.add(clothActions, 'gust').name('Gust').domElement.title =
    'Fire a one-shot gust of wind on top of the sustained wind.';
  cloth.add(clothActions, 'resettle').name('Re-settle').domElement.title =
    'Drop every garment back onto its rest pose at rest. Useful after a big retune.';

  const coats = buildCoatPicker(gui, (hex) => opts.onCoat(hex));
  const critter = addTuningGroups(gui, CRITTER_TUNING_GROUPS, opts.critter);

  const reset = gui.add({ reset: () => opts.onReset() }, 'reset').name('Reset to defaults');
  reset.domElement.title = "Restore every control above to the active unit's default tuning.";

  function showUnit(kind: UnitKind): void {
    const isRobe = kind === 'robe';
    const isCritter = isCritterId(kind);
    const isAuthored = isAuthoredKind(kind) && attackTarget !== null;
    // The attack rehearsal only drives an authored unit's machine: the mech, the
    // robe and the critters have no swing to play, and a slider that visibly
    // does nothing is worse than an absent one (spec 047's rule for this tab).
    attack.setVisible(isAuthored);
    held.show(isAuthored);
    const isMech = !isRobe && !isCritter && !isAuthored;
    mech.setVisible(isMech);
    mechLook.setVisible(isMech && lookTarget !== null);
    robe.setVisible(isRobe);
    cloth.show(isRobe);
    critter.setVisible(isCritter);
    coats.setVisible(isCritter);
    const coat = opts.coatOf(kind);
    if (coat !== null) coats.setActive(coat);
  }
  showUnit(unitState.unit);

  return {
    element: panel,
    fit: () => fitPanelHeight(panel),
    sync: () => {
      unit.updateDisplay();
      movement.sync();
      attack.sync();
      mech.sync();
      mechLook.sync();
      robe.sync();
      critter.sync();
    },
  };
}

/**
 * Mount the movement sandbox into `container`, returning a start/stop handle. The
 * fixed-timestep loop is the one every view here runs: real elapsed time becomes
 * whole 60Hz ticks, inputs are fed one tick at a time, and the scene only reads
 * the resulting state. The side panel edits the rig tuning live and feeds the
 * mover its move-speed / turn-rate overrides.
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
  const input = new SandboxInput(canvas);
  // The walls and vegetation the scene just built are what the mover collides
  // against, so the unit walks around the trees it is standing among.
  const world = scene.worldColliders();
  let state: MoverState = initMover({ x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 });

  let unit: UnitKind = 'spider';
  // The attack rehearsal's state and its tuning (spec 140). The tuning is the
  // object the panel's sliders mutate in place, exactly like every other tuning
  // in this tab; the state is the tick machine that reads it.
  const attackTuning: AttackTuning = defaultAttackTuning();
  let attackState: AttackState = ATTACK_READY;
  let weaponId: string | null = weaponIds()[0] ?? null;
  let sheathed = false;

  /** Puts the picked weapon on whichever authored unit is active. */
  const applyWeapon = (): void => {
    const authored = scene.authoredUnit;
    if (!authored) return;
    const entry = weaponId === null ? null : weaponAssets(weaponId);
    void authored
      .setWeapon(entry === null ? null : { def: entry.def, meshUrl: entry.meshUrl })
      .then(() => authored.setSheathed(sheathed));
  };

  const panel = buildPanel({
    mech: tuning,
    appearance: scene.appearance,
    robe: scene.robe,
    critter: scene.critter,
    attack: attackTuning,
    onReset: () => {
      if (unit === 'robe') Object.assign(scene.robe, defaultRobeTuning());
      else if (isCritterId(unit)) Object.assign(scene.critter, defaultCritterTuning());
      else if (isAuthoredKind(unit)) Object.assign(attackTuning, defaultAttackTuning());
      // A mech resets to its own chip's preset rather than to the bare defaults:
      // reset while the small spider is up must restore the small spider, or the
      // button silently turns the unit into a different one.
      else scene.resetMech(unit);
      panel.sync();
    },
    onUnit: (kind) => {
      unit = kind;
      // Picking a mech chip may load a preset into the shared tuning and the
      // shared colours, and the controls are showing the old ones until told.
      if (scene.setUnit(kind)) panel.sync();
      // A body that has just been built is holding nothing, so the picked
      // weapon has to be put back into it -- switching units and finding an
      // empty hand would read as the weapon picker having broken.
      applyWeapon();
    },
    onCoat: (hex) => scene.critterUnit?.setCoat(hex),
    coatOf: (kind) => (isCritterId(kind) ? scene.critterUnit?.coat ?? null : null),
    onJump: () => scene.robeUnit?.jump(),
    onDrop: () => scene.robeUnit?.drop(),
    onGust: () => scene.robeUnit?.gust(),
    onResettle: () => scene.robeUnit?.resettle(),
    onSwing: () => input.queueAttack(),
    onWeapon: (id) => {
      weaponId = id;
      applyWeapon();
    },
    onSheathed: (next) => {
      sheathed = next;
      scene.authoredUnit?.setSheathed(next);
    },
  });
  layout.appendChild(panel.element);
  // The camera/light control panel (spec 033/034) sits alongside the tuning panel.
  layout.appendChild(scene.controls.element);

  const setStatus = (): void => {
    const name = characterAt(state.characterIndex).name;
    const unitName = UNIT_CHIPS.find((u) => u.kind === unit)?.label ?? 'Spider';
    const authored = scene.authoredUnit;
    const swing = authored === null ? '' : `  ·  attack: ${attackState.phase}  ·  ${authored.debugLine}`;
    status.textContent = `Unit: ${unitName}  ·  Archetype: ${name} (C to cycle)  ·  gait: ${scene.unitState}${swing}`;
  };
  setStatus();

  // Load the active character's preset into the sliders when C cycles it.
  let lastCharacter = state.characterIndex;
  const syncCharacter = (): void => {
    if (state.characterIndex === lastCharacter) return;
    lastCharacter = state.characterIndex;
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
      const moverInput: MoverInput = {
        // Live speed/turn-rate overrides from the panel. The mover ignores a
        // value that is not a number, so a half-typed slider cannot feed it NaN.
        moveSpeed: tuning.moveSpeed,
        turnRate: tuning.turnRate,
        ...(input.takeMoveOrder() ? { moveTarget: scene.screenToWorld(cursor.x, cursor.y) } : {}),
        ...(input.takeCycleCharacter() ? { cycleCharacter: true } : {}),
      };
      const before = state.position;
      state = stepMover(state, moverInput, world);
      // A cosmetic hop: the mover has no notion of height, so this never enters
      // its input and can decide no outcome.
      if (input.takeJump()) {
        scene.robeUnit?.jump();
        scene.critterUnit?.jump();
      }

      // The swing (spec 140). All of it is on the tick clock: the rehearsal, the
      // machine it drives, and the dummy's flinch -- so the blow lands on the
      // same tick whatever the frame rate, and the three cannot drift apart.
      const swung = input.takeAttack();
      const step = stepAttack(attackState, attackTuning, swung, TICK_MS);
      attackState = step.state;
      const authored = scene.authoredUnit;
      if (authored) {
        // Speed measured off the drawn positions rather than off the mover's
        // own number, so the blend tree matches the feet the eye is following.
        const travelled = Math.hypot(state.position.x - before.x, state.position.y - before.y);
        authored.stepTicks(1, travelled / (TICK_MS / 1000), step.started, attackTuning);
      }
      if (step.hit) scene.hitTarget.hit();
      scene.hitTarget.step(1);

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
      // The shell shows the tab and then starts it, so this is the first moment
      // the panel has a box to measure.
      panel.fit();
      input.attach(window);
      requestAnimationFrame(frame);
    },
    stop(): void {
      running = false;
      input.detach();
    },
  };
}
