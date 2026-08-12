/**
 * An authored unit as a sandbox unit, holding a weapon (spec 140).
 *
 * The seam between two things that had never met: `UnitRig` + `UnitMachine`,
 * which is how the Play tab draws a generated body, and `SandboxUnit`, which is
 * the contract the movement and rig-debug tabs drive a controllable body
 * through. Neither knew about the other, so the only place an authored unit
 * could be watched was a live server.
 *
 * ## Why the pose is written on ticks and the scene is drawn on frames
 *
 * `SandboxUnit.update` is handed a frame's `dt`, and the machine counts whole
 * 60Hz ticks -- so this takes both. {@link stepTicks} is called from the tab's
 * fixed-timestep loop and is the only thing that advances anything; `update`
 * writes the poses the machine already decided. Letting `update` step the
 * machine by `dt` would put an event's frame index on the renderer's clock,
 * which is the single rule `machine.ts` is arranged to keep.
 */

import * as THREE from 'three';
import { UnitMachine, type FiredEvent } from '../../units/machine.js';
import type { ClipLib, Skeleton, UnitDef } from '../../units/types.js';
import type { WeaponDef } from '../../items/types.js';
import { UnitRig, type UnitAssets } from './unit-rig.js';
import { WeaponRig } from './weapon-rig.js';
import { attackTiming, type AttackTuning } from './sandbox-attack.js';
import type { SandboxUnit } from './unit.js';

/** Everything needed to stand one up: the documents, and where the bytes are. */
export interface AuthoredUnitSource {
  readonly unit: UnitDef;
  readonly clipLib: ClipLib;
  readonly skeleton: Skeleton;
  readonly assets: UnitAssets;
}

/** A weapon the sandbox can put in its hand. */
export interface SandboxWeapon {
  readonly def: WeaponDef;
  readonly meshUrl: string;
}

/** The clip the swing plays, in the retarget's own preset vocabulary. */
const SWING_CLIP = 'slash';
/** The speed above which the blend tree is walking rather than standing. */
const MOVING = 5;

export class AuthoredUnit implements SandboxUnit {
  readonly group = new THREE.Group();
  /** The body turns to face where it moves, like the spider and the critters. */
  readonly orientsWithGroupYaw = true;

  private readonly rig = new UnitRig();
  private readonly machine: UnitMachine;
  private weapon: WeaponRig | null = null;
  private sheathed = false;
  private lastEvents: readonly FiredEvent[] = [];
  private speed = 0;

  constructor(private readonly source: AuthoredUnitSource) {
    this.group.add(this.rig.object);
    this.rig.setSockets(source.skeleton.sockets);
    this.machine = new UnitMachine({ unit: source.unit, clipLib: source.clipLib });
  }

  get locomotionState(): string {
    const snapshot = this.machine.snapshot();
    return `${snapshot.stateId}${snapshot.blend < 1 ? ` <- ${snapshot.previousStateId ?? ''}` : ''}`;
  }

  get loaded(): boolean {
    return this.rig.loaded;
  }

  get error(): string | null {
    return this.rig.error;
  }

  /** What the last stepped tick fired, for a caller that wants to react to a hit. */
  get events(): readonly FiredEvent[] {
    return this.lastEvents;
  }

  async load(): Promise<void> {
    await this.rig.load(this.source.assets, this.source.unit.id);
  }

  /**
   * Puts a weapon in the hand, or takes it away.
   *
   * Reloads rather than caches: a sandbox switches weapons about as often as
   * somebody clicks a chip, and a cache of loaded meshes here would be an
   * optimisation with a lifetime bug in it for no measurable gain.
   */
  async setWeapon(weapon: SandboxWeapon | null): Promise<void> {
    this.clearWeapon();
    if (!weapon) return;
    const rig = new WeaponRig(weapon.def);
    await rig.load({ meshUrl: weapon.meshUrl });
    if (rig.error !== null) return;
    this.weapon = rig;
    this.mountWeapon();
  }

  /** Draw it or put it away. Instant -- the animation between is not this spec. */
  setSheathed(sheathed: boolean): void {
    if (sheathed === this.sheathed) return;
    this.sheathed = sheathed;
    this.mountWeapon();
  }

  get isSheathed(): boolean {
    return this.sheathed;
  }

  /** Which socket the weapon is in right now, or null when it is holding none. */
  get heldIn(): string | null {
    const def = this.weapon?.weapon;
    if (!def) return null;
    return this.sheathed ? (def.stowSocket ?? null) : def.socket;
  }

  private clearWeapon(): void {
    const def = this.weapon?.weapon;
    if (def) {
      this.rig.detach(def.socket);
      if (def.stowSocket) this.rig.detach(def.stowSocket);
    }
    this.weapon?.dispose();
    this.weapon = null;
  }

  /** Moves the held object to whichever socket the drawn/sheathed flag names. */
  private mountWeapon(): void {
    const rig = this.weapon;
    if (!rig) return;
    const def = rig.weapon;
    // Both are detached first, so a socket the weapon is *not* in can never keep
    // a copy -- which is what would draw two swords through one body.
    this.rig.detach(def.socket);
    if (def.stowSocket) this.rig.detach(def.stowSocket);
    const socket = this.sheathed ? def.stowSocket : def.socket;
    if (socket) this.rig.attach(socket, rig.object);
  }

  /**
   * Advances the machine by whole ticks and returns what fired.
   *
   * `swing` is the edge that commits a blow; `timing` is the panel's, so the
   * clip is rescaled to whatever the sliders currently say. The two are handed
   * in together because a swing with no timing is the document's swing, and this
   * tab exists to ask what a different one would look like.
   */
  stepTicks(ticks: number, speed: number, swing: boolean, timing: AttackTuning): readonly FiredEvent[] {
    this.speed = speed;
    this.machine.setParameter('speed', speed);
    this.machine.setParameter('dead', false);
    if (swing) {
      // `startAction` rather than the `attack` trigger, because only the former
      // carries a rate -- and the rate is the whole demonstration. The trigger
      // is what the *game* raises, and it reaches the same state.
      if (!this.machine.startAction('basic.attack', attackTiming(timing, SWING_CLIP))) {
        this.machine.trigger('attack');
      }
    }
    this.lastEvents = this.machine.step(ticks);
    return this.lastEvents;
  }

  /**
   * Writes the pose three frames from.
   *
   * Takes `dt` because the contract does and ignores it, deliberately: nothing
   * here may advance on a frame. The mixer is stepped with a zero delta inside
   * `applyPoses` for the same reason it is everywhere else.
   */
  update(_dt: number, _worldPos: { x: number; y: number }, _ry: number): void {
    this.rig.applyPoses(this.machine.poses());
  }

  /** For the status line: what the body thinks it is doing. */
  get debugLine(): string {
    const snapshot = this.machine.snapshot();
    const held = this.heldIn;
    return (
      `${snapshot.stateId} @${snapshot.normalizedTime.toFixed(2)}` +
      `  speed ${this.speed.toFixed(0)}${this.speed > MOVING ? '' : ' (still)'}` +
      `  ${held === null ? 'unarmed' : `${this.weapon?.weapon.name ?? '?'} in ${held}`}`
    );
  }

  dispose(): void {
    this.clearWeapon();
    this.rig.dispose();
    this.group.clear();
  }
}
