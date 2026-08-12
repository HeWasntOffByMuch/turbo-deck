/**
 * Something to hit (spec 140).
 *
 * A post on a base, standing at a fixed distance in front of where the sandbox
 * spawns. Its whole job is to answer one question by being looked at: **did the
 * picture and the blow agree?** A swing with nothing to hit is a swing whose
 * timing cannot be checked, because "the blade looks like it arrives about now"
 * is not a claim anybody can make about a number.
 *
 * So it flinches on the tick the swing's `hit` fires, and on no other. The
 * flinch's shape is {@link dummyLean}, which is pure and a function of a tick
 * count -- so it is the same at any frame rate and a screenshot of tick 7 is the
 * same picture on every machine.
 *
 * Cosmetic, entirely. Nothing here decides anything: no collision is tested, no
 * range is checked, the dummy takes a hit because the *rehearsal* said a hit
 * landed. That is the honest boundary for a tab whose mover is explicitly not a
 * sim, and it is why this draws a post rather than pretending to be a target.
 */

import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { dummyLean } from './sandbox-attack.js';

/** How far in front of the spawn it stands, in world units. */
export const DUMMY_DISTANCE = 90;
/** Post height, a little over a body so the blade meets it around the middle. */
const POST_HEIGHT = 62;
const POST_RADIUS = 7;

export class SandboxDummy {
  readonly group = new THREE.Group();

  private readonly post = new THREE.Group();
  /** Ticks since the last hit, or null when it has not been struck. */
  private struck: number | null = null;

  constructor() {
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(POST_RADIUS * 0.8, POST_RADIUS, POST_HEIGHT, 8),
      new THREE.MeshLambertMaterial({ color: PALETTE.enemyBrawler, flatShading: true }),
    );
    body.position.y = POST_HEIGHT / 2;
    body.castShadow = true;
    body.receiveShadow = true;

    // A crossbar, so a rotation is visible. A plain cylinder leaning is a
    // cylinder, and the flinch would read as nothing at all.
    const arms = new THREE.Mesh(
      new THREE.BoxGeometry(POST_RADIUS * 6, POST_RADIUS * 0.9, POST_RADIUS * 0.9),
      new THREE.MeshLambertMaterial({ color: PALETTE.walkerBody, flatShading: true }),
    );
    arms.position.y = POST_HEIGHT * 0.72;
    arms.castShadow = true;

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(POST_RADIUS * 2, POST_RADIUS * 2.2, 4, 10),
      new THREE.MeshLambertMaterial({ color: PALETTE.walkerBody, flatShading: true }),
    );
    base.position.y = 2;
    base.receiveShadow = true;

    this.post.add(body, arms);
    this.group.add(this.post, base);
  }

  /** Struck now: restart the flinch from its first frame. */
  hit(): void {
    this.struck = 0;
  }

  /**
   * One tick of settling.
   *
   * Ticks rather than seconds, and stepped from the tab's fixed-timestep loop,
   * so the reaction is on the same clock as the swing that caused it. A flinch
   * advanced on frame time would drift away from the hit that started it at
   * exactly the frame rates where somebody is looking for a problem.
   */
  step(ticks: number): void {
    if (this.struck === null) return;
    this.struck += Math.max(0, Math.floor(ticks));
    const lean = dummyLean(this.struck);
    // Below a thousandth of a radian it has stopped; letting it decay forever
    // costs a rotation write per tick for a picture nobody can tell apart.
    if (Math.abs(lean) < 0.001) {
      this.struck = null;
      this.post.rotation.set(0, 0, 0);
      return;
    }
    this.post.rotation.z = lean;
  }

  /** Whether it is currently reacting, for the status line. */
  get reacting(): boolean {
    return this.struck !== null;
  }
}
