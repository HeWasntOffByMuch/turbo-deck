/**
 * The body colliders the cloth is pushed out of (spec 037): a fixed-size set of
 * capsules (a segment plus a radius), stored in flat arrays and rewritten in
 * place every frame from the skeleton's bone transforms. Pure and three.js-free
 * so the solver stays testable in Node; the rig is what knows about bones.
 *
 * A capsule is the right primitive here: a limb *is* a segment with a thickness,
 * one capsule replaces a chain of spheres, and the closest-point test is a few
 * multiplies with no branches worth worrying about.
 *
 * Every capsule carries a **mask** bit. Each cloth piece only tests the capsules
 * whose mask it shares, so the lower robe never tests the arms and a sleeve only
 * tests its own arm plus the torso -- an easy constant-factor win, and the hook a
 * future piece of equipment would use to opt into (or out of) colliding.
 */

/** Collider mask bits. A piece's mask is the OR of the parts it may touch. */
export const MASK = {
  head: 1 << 0,
  torso: 1 << 1,
  armL: 1 << 2,
  armR: 1 << 3,
  legs: 1 << 4,
} as const;

/** Every mask bit set: collide with the whole body. */
export const MASK_ALL = MASK.head | MASK.torso | MASK.armL | MASK.armR | MASK.legs;

/**
 * A fixed-capacity set of capsules in world space. Allocated once by the rig and
 * refilled each frame with {@link set}; never grows, so stepping the cloth
 * allocates nothing.
 */
export class CapsuleSet {
  /** Segment start points, 3 floats per capsule. */
  readonly a: Float64Array;
  /** Segment end points, 3 floats per capsule. */
  readonly b: Float64Array;
  readonly radius: Float64Array;
  readonly mask: Int32Array;

  constructor(readonly count: number) {
    this.a = new Float64Array(count * 3);
    this.b = new Float64Array(count * 3);
    this.radius = new Float64Array(count);
    this.mask = new Int32Array(count);
  }

  /** Rewrite capsule `i`. Out-of-range indices are ignored (never throws mid-frame). */
  set(
    i: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    radius: number,
    mask: number,
  ): void {
    if (i < 0 || i >= this.count) return;
    const i3 = i * 3;
    this.a[i3] = ax;
    this.a[i3 + 1] = ay;
    this.a[i3 + 2] = az;
    this.b[i3] = bx;
    this.b[i3 + 1] = by;
    this.b[i3 + 2] = bz;
    this.radius[i] = radius;
    this.mask[i] = mask;
  }
}
