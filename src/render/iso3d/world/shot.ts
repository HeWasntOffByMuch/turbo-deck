/**
 * The three.js half of a projectile in flight (spec 081).
 *
 * `projectile-shape.ts` says where the vertices go; this turns that into
 * meshes and moves them. Everything in here is presentation: a shot's position
 * arrives already computed by the server, and nothing this file works out is
 * ever sent anywhere.
 *
 * The rig owns the two things a still frame cannot show -- an arrow's pitch,
 * which comes from where it has been rather than from any field on the wire,
 * and a shuriken's spin, which is a clock. Both are driven from the *drawn*
 * pose, so they stay right through interpolation between 20Hz deltas.
 */

import * as THREE from 'three';
import type { ProjectileLook } from '../../../server/data/abilities.js';
import { PALETTE } from '../palette.js';
import {
  arrowProfile,
  SHURIKEN_POINTS,
  SHURIKEN_SPIN_TURNS_PER_SECOND,
  shurikenDrawRadius,
  shurikenOutline,
  shurikenThickness,
} from './projectile-shape.js';

/** How fast the drawn pitch chases the measured one, per second. */
const PITCH_CHASE = 12;

export class ShotRig {
  readonly group = new THREE.Group();

  /** Yawed by the caller; this is what pitches and spins inside that. */
  private readonly pivot = new THREE.Group();
  private readonly spinner: THREE.Object3D | null;
  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  private pitch = 0;
  private spin = 0;
  private previous: { x: number; y: number; z: number } | null = null;

  constructor(
    readonly look: ProjectileLook,
    radius: number,
  ) {
    this.group.add(this.pivot);

    switch (look) {
      case 'arrow':
        this.spinner = null;
        this.buildArrow(radius);
        break;
      case 'shuriken':
        this.spinner = this.buildShuriken(radius);
        break;
      default:
        this.spinner = null;
        this.buildOrb(radius);
        break;
    }
  }

  /**
   * One frame. `dt` is seconds, and the position is where the body is *drawn*.
   *
   * The pitch is measured from the step just taken rather than from the arc the
   * server flew, because that step is what the eye is following: a shot climbing
   * on screen should have its nose up on screen, whatever the interpolator did
   * to get it there.
   */
  update(dt: number, x: number, y: number, z: number): void {
    if (this.spinner) {
      this.spin += dt * SHURIKEN_SPIN_TURNS_PER_SECOND * Math.PI * 2;
      this.spinner.rotation.z = this.spin;
    }

    const from = this.previous;
    this.previous = { x, y, z };
    if (this.look !== 'arrow' || !from) return;

    const along = Math.hypot(x - from.x, y - from.y);
    // Below a whisker of travel the direction is noise, so the last pitch
    // stands rather than being recomputed from nothing.
    if (along > 1e-4) {
      const measured = Math.atan2(z - from.z, along);
      // Chased rather than snapped: a delta boundary can hand over a step with
      // a slightly different slope, and a nose that flicked on every third tick
      // would be more distracting than a nose that lags a hundredth of a second.
      const blend = Math.min(1, dt * PITCH_CHASE);
      this.pitch += (measured - this.pitch) * blend;
    }
    this.pivot.rotation.z = this.pitch;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
  }

  private track<T extends THREE.BufferGeometry | THREE.Material>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  /** The look every shot had before this spec, and what an unknown one gets. */
  private buildOrb(radius: number): void {
    const mesh = new THREE.Mesh(
      this.track(new THREE.IcosahedronGeometry(Math.max(3, radius), 0)),
      this.track(new THREE.MeshBasicMaterial({ color: PALETTE.magicCore })),
    );
    this.pivot.add(mesh);
  }

  /**
   * An arrow along +x -- the convention the caller yaws to, and the direction
   * the sim re-stamps a shot's facing to every tick of its flight.
   *
   * Hung off its own midpoint, so the point the server is moving is the middle
   * of the arrow rather than its nose. An arrow drawn from its nose backwards
   * arrives a whole arrow-length before its damage does.
   */
  private buildArrow(radius: number): void {
    const arrow = arrowProfile(radius);
    const nose = arrow.centreOffset;

    const shaft = new THREE.Mesh(
      this.track(
        new THREE.CylinderGeometry(arrow.shaftRadius, arrow.shaftRadius, arrow.shaftLength, 6),
      ),
      this.track(new THREE.MeshBasicMaterial({ color: PALETTE.arrowShaft })),
    );
    // A cylinder is built up the +y axis; the arrow lies along +x.
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.x = nose - arrow.headLength - arrow.shaftLength / 2;
    this.pivot.add(shaft);

    const head = new THREE.Mesh(
      this.track(new THREE.ConeGeometry(arrow.headRadius, arrow.headLength, 6)),
      this.track(new THREE.MeshBasicMaterial({ color: PALETTE.arrowHead })),
    );
    head.rotation.z = -Math.PI / 2;
    head.position.x = nose - arrow.headLength / 2;
    this.pivot.add(head);

    // Two crossed vanes rather than one, so the tail does not disappear when
    // the camera happens to look down the plane of a single one.
    const fletchGeometry = this.track(new THREE.PlaneGeometry(arrow.fletchLength, arrow.fletchSpan * 2));
    const fletchMaterial = this.track(
      new THREE.MeshBasicMaterial({ color: PALETTE.arrowFletch, side: THREE.DoubleSide }),
    );
    for (const roll of [0, Math.PI / 2]) {
      const vane = new THREE.Mesh(fletchGeometry, fletchMaterial);
      vane.rotation.x = roll;
      vane.position.x = nose - arrow.length + arrow.fletchLength / 2;
      this.pivot.add(vane);
    }
  }

  /**
   * A star lying flat in the ground plane, spinning about its own normal.
   *
   * Flat because the camera looks down: a shuriken spinning edge-on to an
   * isometric view is a flickering line, and the four points are the whole
   * reason it is not an orb. Two nested objects rather than one Euler triple,
   * so "lay it down" and "spin it" cannot fight over rotation order.
   */
  private buildShuriken(collisionRadius: number): THREE.Object3D {
    const radius = shurikenDrawRadius(collisionRadius);
    const outline = shurikenOutline(radius, SHURIKEN_POINTS);
    const shape = new THREE.Shape();
    outline.forEach((point, i) => {
      if (i === 0) shape.moveTo(point.x, point.y);
      else shape.lineTo(point.x, point.y);
    });
    shape.closePath();

    const thickness = shurikenThickness(radius);
    const geometry = this.track(
      new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false }),
    );
    // Extruded along +z from the shape's plane; centre it on that plane so the
    // plate spins about its own middle.
    geometry.translate(0, 0, -thickness / 2);

    const plate = new THREE.Mesh(
      geometry,
      this.track(new THREE.MeshBasicMaterial({ color: PALETTE.shurikenSteel, side: THREE.DoubleSide })),
    );

    const flat = new THREE.Group();
    flat.rotation.x = -Math.PI / 2;
    flat.add(plate);
    this.pivot.add(flat);
    return plate;
  }
}
