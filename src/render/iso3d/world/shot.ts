/**
 * The three.js half of a projectile in flight (spec 087).
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
import { Trail } from './trail.js';

/** How fast the drawn pitch chases the measured one, per second. */
const PITCH_CHASE = 12;

/**
 * The shuriken's streak: how many points it holds, how far apart it lays them,
 * how wide it starts and how far it floats above the shot.
 *
 * The spacing and the width are fractions of the plate, so a bigger star leaves
 * a proportionally bigger streak. The lift is what keeps the strip off the
 * terrain a flat shot skims -- `arcHeight` is 0 for a star, so its own height
 * *is* the ground.
 */
const TRACE_SAMPLES = 16;
const TRACE_SPACING = 0.55;
const TRACE_WIDTH = 0.42;
const TRACE_LIFT = 2.5;

export class ShotRig {
  readonly group = new THREE.Group();

  /**
   * The streak this shot leaves, or null for one that leaves none.
   *
   * Not a child of {@link group}: the streak is a record of where the shot has
   * *been*, in world space, and parenting it to something that moves and yaws
   * would drag the trail along behind the star like a scarf. The caller adds it
   * to the scene root beside the body, and takes it away again with the body.
   */
  readonly trace: THREE.Object3D | null;

  /** Yawed by the caller; this is what pitches and spins inside that. */
  private readonly pivot = new THREE.Group();
  private readonly spinner: THREE.Object3D | null;
  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  private readonly trail: Trail | null;
  private readonly traceGeometry: THREE.BufferGeometry | null = null;
  private readonly traceWidth: number;

  private pitch = 0;
  private spin = 0;
  private previous: { x: number; y: number; z: number } | null = null;

  constructor(
    readonly look: ProjectileLook,
    radius: number,
    /**
     * An override colour for the orb, or absent for the arcane core it has
     * always been (spec 154).
     *
     * Orb only, and deliberately: an arrow and a star are *objects* whose
     * materials say what they are made of, where an orb is a bead of light and
     * its colour is the whole of its identity. A mote reuses this rig rather
     * than growing a second one, and this is the one thing it has to change.
     */
    tint?: number,
    /**
     * Icosahedron subdivisions for the orb, or absent for the faceted default
     * (spec 154). A mote wants a sphere; a conjured bolt is supposed to look
     * cut from glass and is on screen for a moment.
     */
    detail?: number,
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
        this.buildOrb(radius, tint, detail);
        break;
    }

    // Only the star traces. An arrow is long enough to show its own direction,
    // and a conjured orb streaking would read as a second spell.
    if (look === 'shuriken') {
      const plate = shurikenDrawRadius(radius);
      this.trail = new Trail(TRACE_SAMPLES, plate * TRACE_SPACING);
      this.traceWidth = plate * TRACE_WIDTH;
      const built = this.buildTrace();
      this.traceGeometry = built.geometry;
      this.trace = built.mesh;
    } else {
      this.trail = null;
      this.traceWidth = 0;
      this.trace = null;
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
    if (this.trail) {
      this.trail.push({ x, y, z });
      this.updateTrace();
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

  /**
   * The streak's mesh, allocated once at full capacity.
   *
   * The buffers never grow: `Trail` is bounded, so the geometry is sized for a
   * full one on the first frame and the draw range is what moves. A shot lives
   * a second or two, and reallocating a buffer per frame per arrow in the air
   * is the kind of cost that only shows up once a fight is worth watching.
   */
  private buildTrace(): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry } {
    const vertices = TRACE_SAMPLES * 2;
    const geometry = this.track(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    // Four components, so the alpha rides the colour: the taper is what makes
    // the tail end in air rather than in a cut edge.
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertices * 4), 4));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array((TRACE_SAMPLES - 1) * 6), 1));
    geometry.setDrawRange(0, 0);

    const mesh = new THREE.Mesh(
      geometry,
      this.track(
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          // Written into by nothing and behind nothing: a streak that wrote
          // depth would punch a fading hole through whatever it crossed.
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      ),
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return { mesh, geometry };
  }

  /** Refill the streak's buffers from the trail, in three.js's axis order. */
  private updateTrace(): void {
    const geometry = this.traceGeometry;
    if (!this.trail || !geometry) return;

    const ribbon = this.trail.ribbon(this.traceWidth, TRACE_LIFT);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = geometry.getAttribute('color') as THREE.BufferAttribute;
    const index = geometry.getIndex();
    if (!index) return;

    const tint = new THREE.Color(PALETTE.shurikenTrace);
    const vertices = ribbon.alphas.length;
    for (let i = 0; i < vertices; i++) {
      // The ribbon is world-space (x, y across the ground, z up); three.js puts
      // height in y, so the last two swap on the way in.
      position.setXYZ(
        i,
        ribbon.positions[i * 3] as number,
        ribbon.positions[i * 3 + 2] as number,
        ribbon.positions[i * 3 + 1] as number,
      );
      color.setXYZW(i, tint.r, tint.g, tint.b, ribbon.alphas[i] as number);
    }
    for (let i = 0; i < ribbon.indices.length; i++) index.setX(i, ribbon.indices[i] as number);

    position.needsUpdate = true;
    color.needsUpdate = true;
    index.needsUpdate = true;
    geometry.setDrawRange(0, ribbon.indices.length);
  }

  /** The look every shot had before this spec, and what an unknown one gets. */
  private buildOrb(radius: number, tint?: number, detail?: number): void {
    const mesh = new THREE.Mesh(
      this.track(new THREE.IcosahedronGeometry(Math.max(3, radius), detail ?? 0)),
      this.track(new THREE.MeshBasicMaterial({ color: tint ?? PALETTE.magicCore })),
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
