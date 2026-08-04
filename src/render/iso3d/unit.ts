import type * as THREE from 'three';
import type { Vec2 } from '../../sim/types.js';
import type { CritterId } from '../critters/types.js';

/**
 * The contract the sandbox and rig-debug scenes drive a controllable unit
 * through (specs 032/035/037). Both scenes place the unit from sim state and
 * then hand it the frame's elapsed time; everything else -- gait, cloth, IK --
 * is the unit's own business.
 *
 * It lives in its own module so a unit implementation never has to import the
 * view that mounts it (which would be a cycle), and so adding a unit is one new
 * file plus one entry in the picker.
 */
export interface SandboxUnit {
  /** The unit's root; the scene sets its world position and yaw. */
  readonly group: THREE.Group;
  /**
   * Whether the scene should yaw `group` to the heading (a spider, a walking
   * figure) or leave it at 0 because the unit turns something internally
   * instead (the grey mech's turret).
   */
  readonly orientsWithGroupYaw: boolean;
  /** A short label for the status line: the gait or locomotion state. */
  readonly locomotionState: string;
  /**
   * Pose the unit. `dt` is elapsed *sim* time (so slow motion slows the unit),
   * `worldPos` is the sim position, and `ry` is the `group.rotation.y` matching
   * the sim heading.
   */
  update(dt: number, worldPos: Vec2, ry: number): void;
}

/**
 * The units the sandbox and debug views can control.
 *
 * Every critter species (spec 055) is a unit kind by construction, so adding an
 * animal puts it in both pickers without either view learning its name.
 */
export type UnitKind = 'spider' | 'walker' | 'robe' | CritterId;
