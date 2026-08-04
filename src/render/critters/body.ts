/**
 * The shared anatomy vocabulary every critter is assembled from (spec 049).
 *
 * A species file should read like a description of an animal, not like a list of
 * boxes. These builders are where the geometry lives: given a profile and a few
 * numbers they return the {@link PartSpec}s for a torso, a head, a pair of arms,
 * a pair of legs, a muzzle, a set of ears. A pig and a cow differ in their
 * profiles and about six extra parts, and that is exactly how much a species
 * file should be.
 *
 * ## Why almost everything here is a hull
 *
 * The first version of this file built bodies out of intersecting ellipsoids and
 * cones, and the result looked like intersecting ellipsoids and cones: a lump at
 * every join, a silhouette that stepped instead of tapering, and markings that
 * had to *protrude* through the skin to be visible. A body is one surface. So
 * the torso, head, muzzle and limbs are each a single `hull` lofted through a
 * profile, and markings are painted onto the faces of that surface instead of
 * being more geometry stuck to it.
 *
 * Everything is expressed relative to the {@link FigureMetrics} it is handed, so
 * changing a species' proportions moves its geometry with it instead of stranding
 * a hard-coded offset three files away.
 */

import { BONE, type FigureMetrics } from '../cloth/figure.js';
import { hullExtent } from './resolve.js';
import type { CoatRole, HullRing, PaintBlob, PartSpec } from './types.js';

/**
 * A ball centred exactly on a joint's pivot, filling the wedge that opens
 * between two limb segments when the joint bends.
 *
 * ## How body-part transitions are masked
 *
 * There are two kinds of join on these characters and they need opposite fixes.
 *
 * **Rigid joins** -- muzzle into skull, head into torso -- never move relative
 * to each other, so they are masked by *overlap*: the child's first ring is
 * pushed inside the parent's surface and the parent's last ring inside the
 * child's, so neither end cap is ever on the silhouette. Two surfaces that meet
 * exactly at a shared plane always show the seam as a ledge, however well the
 * radii match.
 *
 * **Articulated joins** -- shoulder, elbow, hip, knee -- cannot be masked that
 * way, because overlap that closes at rest opens into a visible wedge the moment
 * the joint bends: the outside of the bend pulls the two segments apart. What
 * works is a volume that *rotation cannot move*. A sphere centred on the pivot
 * is exactly that: the joint rotates about its centre, so the sphere sits still
 * however far the limb swings, and as long as its radius covers the thicker of
 * the two segments there is no angle at which a gap can appear.
 *
 * This is why it is a ball and not, say, a longer overlap or a bridging cone --
 * only a shape centred on the axis of rotation is angle-independent. It is also
 * why these are cheap: 20 faces each, in the coat colour, and the ones buried
 * inside the torso cost nothing on screen.
 */
export function joint(opts: {
  readonly name: string;
  /** The bone whose *origin* is the pivot. */
  readonly bone: number;
  /** Must be at least the larger of the two segments' radii at this joint. */
  readonly radius: number;
  readonly role?: CoatRole;
}): PartSpec {
  const d = opts.radius * 2;
  return {
    name: opts.name,
    attach: opts.bone,
    shape: 'ball',
    role: opts.role ?? 'coat',
    size: [d, d, d],
    // The bone's own origin: the one point a rotation about this joint leaves
    // fixed. Offsetting it at all reintroduces the gap it exists to close.
    pos: [0, 0, 0],
  };
}

/** Assemble a lofted-hull part, deriving its extent from its own rings. */
export function hull(opts: {
  readonly name: string;
  readonly attach: number | string;
  readonly role: CoatRole;
  readonly rings: readonly HullRing[];
  readonly pos: readonly [number, number, number];
  readonly axis?: 'x' | 'y';
  readonly rot?: readonly [number, number, number];
  readonly mirror?: boolean;
  readonly facets?: number;
  readonly smooth?: number;
  readonly jitter?: number;
  readonly paint?: readonly PaintBlob[];
}): PartSpec {
  const axis = opts.axis ?? 'y';
  return {
    name: opts.name,
    attach: opts.attach,
    shape: 'hull',
    role: opts.role,
    size: hullExtent(opts.rings, axis),
    pos: opts.pos,
    rings: opts.rings,
    axis,
    ...(opts.rot ? { rot: opts.rot } : {}),
    ...(opts.mirror ? { mirror: true } : {}),
    ...(opts.facets ? { facets: opts.facets } : {}),
    ...(opts.smooth ? { smooth: opts.smooth } : {}),
    ...(opts.jitter ? { jitter: opts.jitter } : {}),
    ...(opts.paint ? { paint: opts.paint } : {}),
  };
}

/**
 * Split one continuous body silhouette into the torso and head hulls.
 *
 * ## Why the profile is written as one curve
 *
 * On these animals there is barely a neck: the head is a swelling at the top of
 * the shoulders, and the narrowest point between them is still most of the
 * head's width. Describing the torso and the head as two separate profiles makes
 * that shape almost impossible to hit -- each one gets its own end taper, and the
 * union reads as a head sat *on* a body rather than growing out of it, however
 * carefully the two are overlapped.
 *
 * So a species writes the whole silhouette once, crotch to crown, and this cuts
 * it in two. Both halves are sampled from the *same* ring list with a band of
 * overlap either side of the cut, so the union is exactly the declared curve and
 * the two hulls cannot drift apart. Where the cut falls is invisible: it is in
 * the middle of a region both meshes occupy.
 *
 * They stay two meshes on two bones rather than becoming one, so a head that
 * later needs to turn still can.
 */
export function splitBodyProfile(
  rings: readonly HullRing[],
  opts: { readonly cutAt: number; readonly overlap: number },
): { torso: HullRing[]; head: HullRing[] } {
  const { cutAt, overlap } = opts;
  const sample = (along: number): HullRing => {
    // Linear between the two declared rings that bracket it. The loft's own
    // Catmull-Rom smooths the result, so this only has to land on the curve.
    let lo = rings[0] as HullRing;
    let hi = rings[rings.length - 1] as HullRing;
    for (let i = 0; i < rings.length - 1; i++) {
      const a = rings[i] as HullRing;
      const b = rings[i + 1] as HullRing;
      if (along >= a.along && along <= b.along) {
        lo = a;
        hi = b;
        break;
      }
    }
    const span = hi.along - lo.along;
    const t = span === 0 ? 0 : (along - lo.along) / span;
    const mix = (a: number, b: number): number => a + (b - a) * t;
    return {
      along,
      rx: mix(lo.rx, hi.rx),
      rz: mix(lo.rz, hi.rz),
      dx: mix(lo.dx ?? 0, hi.dx ?? 0),
      dz: mix(lo.dz ?? 0, hi.dz ?? 0),
    };
  };

  const torsoTop = cutAt + overlap;
  const headBottom = cutAt - overlap;
  const torso = [...rings.filter((r) => r.along < torsoTop), sample(torsoTop)];
  const head = [sample(headBottom), ...rings.filter((r) => r.along > headBottom)];
  return { torso, head };
}

/**
 * The body: one skin from the hang of the belly up to the base of the neck.
 *
 * Rings are given in **world height at rest** and rebased onto the chest bone
 * here, so a species writes "the belly is widest at y = 32" -- a number it can
 * read straight off a reference image -- rather than an offset from a joint.
 *
 * It hangs off the chest rather than being split between chest and pelvis
 * because the gait counter-twists those two against each other, and a torso
 * split across that joint visibly shears at a run. Riding the chest instead
 * gives the whole barrel a gentle sway, which is what you want anyway.
 *
 * The top ring should run *past* the neck and inside the head, and the head's
 * bottom ring back down inside the torso -- see {@link joint} for why a rigid
 * join wants overlap rather than a shared plane.
 */
export function torso(
  f: FigureMetrics,
  rings: readonly HullRing[],
  opts: {
    readonly paint?: readonly PaintBlob[];
    readonly sides?: number;
    readonly smooth?: number;
    readonly jitter?: number;
  } = {},
): PartSpec {
  return hull({
    name: 'torso',
    attach: BONE.chest,
    role: 'coat',
    rings: rings.map((r) => ({ ...r, along: r.along - f.chestY })),
    pos: [0, 0, 0],
    ...(opts.sides ? { facets: opts.sides } : {}),
    ...(opts.smooth ? { smooth: opts.smooth } : {}),
    ...(opts.jitter ? { jitter: opts.jitter } : {}),
    ...(opts.paint
      ? { paint: opts.paint.map((b) => ({ ...b, at: [b.at[0], b.at[1] - f.chestY, b.at[2]] as const })) }
      : {}),
  });
}

/**
 * The head: one skin from the neck to the crown, again in world height at rest.
 * The muzzle is a separate hull because it runs forward rather than up, but its
 * base ring sits inside the skull so the two read as one form.
 */
export function head(
  f: FigureMetrics,
  rings: readonly HullRing[],
  opts: {
    readonly paint?: readonly PaintBlob[];
    readonly sides?: number;
    readonly smooth?: number;
    readonly jitter?: number;
  } = {},
): PartSpec {
  return hull({
    name: 'head',
    attach: BONE.head,
    role: 'coat',
    rings: rings.map((r) => ({ ...r, along: r.along - f.neckY })),
    pos: [0, 0, 0],
    ...(opts.sides ? { facets: opts.sides } : {}),
    ...(opts.smooth ? { smooth: opts.smooth } : {}),
    ...(opts.jitter ? { jitter: opts.jitter } : {}),
    ...(opts.paint
      ? { paint: opts.paint.map((b) => ({ ...b, at: [b.at[0], b.at[1] - f.neckY, b.at[2]] as const })) }
      : {}),
  });
}

/**
 * A muzzle lofted forward out of the skull, with its tip painted as the nose
 * pad. Painting the pad rather than adding a ball for it is what keeps the snout
 * one continuous form -- and the pad is the highest-contrast thing on the face,
 * so it is worth getting flush rather than bolted on.
 */
export function muzzle(opts: {
  /** Height of the muzzle's axis, in world height at rest. */
  readonly atY: number;
  readonly f: FigureMetrics;
  /** Rings along +x: `along` is how far forward, `rx` is half-height, `rz` half-width. */
  readonly rings: readonly HullRing[];
  /** How far back from the tip the nose pad reaches. */
  readonly padDepth: number;
  /** Nostril block size and their lateral spacing. */
  readonly nostril: readonly [number, number, number];
  readonly nostrilSpread: number;
}): PartSpec[] {
  const last = opts.rings[opts.rings.length - 1] as HullRing;
  const tipX = last.along;
  const tipY = last.dx ?? 0;
  const y = opts.atY - opts.f.neckY;
  return [
    hull({
      name: 'muzzle',
      attach: BONE.head,
      role: 'coat',
      axis: 'x',
      rings: opts.rings,
      smooth: 3,
      pos: [0, y, 0],
      paint: [
        {
          role: 'skin',
          at: [tipX, tipY, 0],
          // Generous in y/z so the whole end cap is caught, tight in x so the
          // pad stops where the snout does.
          r: [opts.padDepth, last.rx * 2.4, last.rz * 2.4],
        },
      ],
    }),
    {
      name: 'nostril',
      attach: BONE.head,
      shape: 'box',
      role: 'skinDeep',
      size: opts.nostril,
      pos: [tipX + y * 0, y + tipY, -opts.nostrilSpread],
      mirror: true,
    },
  ];
}

/** Two dark eyes set on the skull's front quarters, where the iso camera sees them. */
export function eyes(opts: {
  readonly at: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly f: FigureMetrics;
}): PartSpec {
  const [x, y, z] = opts.at;
  return {
    name: 'eye',
    attach: BONE.head,
    shape: 'box',
    role: 'eye',
    size: opts.size,
    pos: [x, y - opts.f.neckY, z],
    mirror: true,
  };
}

/**
 * Both arms, as tapered hulls with a hand at the wrist. Emitted per bone rather
 * than mirrored, because the skeleton already has a left and a right arm and the
 * gait swings them in opposition.
 */
export function bipedArms(
  f: FigureMetrics,
  opts: {
    /** Half-widths at shoulder, elbow and wrist. */
    readonly taper: readonly [number, number, number];
    readonly hand: readonly [number, number, number];
    readonly handRole?: CoatRole;
  },
): PartSpec[] {
  const [shoulder, elbow, wrist] = opts.taper;
  const [hw, hh, hd] = opts.hand;
  const out: PartSpec[] = [];
  const sides: readonly [string, number, number][] = [
    ['L', BONE.upperArmL, BONE.forearmL],
    ['R', BONE.upperArmR, BONE.forearmR],
  ];
  for (const [tag, upper, fore] of sides) {
    out.push(
      hull({
        name: `upperArm${tag}`,
        attach: upper,
        role: 'coat',
        facets: 8,
        smooth: 2,
        rings: [
          { along: 0.5, rx: shoulder, rz: shoulder },
          { along: -f.upperArmLen * 0.5, rx: (shoulder + elbow) / 2, rz: (shoulder + elbow) / 2 },
          { along: -f.upperArmLen, rx: elbow, rz: elbow },
        ],
        pos: [0, 0, 0],
      }),
    );
    out.push(
      hull({
        name: `forearm${tag}`,
        attach: fore,
        role: 'coat',
        facets: 8,
        smooth: 2,
        rings: [
          { along: 0.5, rx: elbow, rz: elbow },
          { along: -f.forearmLen, rx: wrist, rz: wrist },
        ],
        pos: [0, 0, 0],
      }),
    );
    out.push(joint({ name: `shoulder${tag}`, bone: upper, radius: shoulder }));
    out.push(joint({ name: `elbow${tag}`, bone: fore, radius: elbow }));
    out.push({
      name: `hand${tag}`,
      attach: fore,
      shape: 'box',
      role: opts.handRole ?? 'hoof',
      size: [hw, hh, hd],
      pos: [0, -f.forearmLen - hh * 0.3, 0],
    });
  }
  return out;
}

/**
 * Both legs: heavy thighs tapering to narrow ankles, with a hoof that sticks
 * *forward*. The forward hoof is doing real work at 64 px -- it is what tells a
 * viewer the character is standing on the ground rather than floating over it,
 * and it is the first thing a walk cycle reads through.
 */
export function bipedLegs(
  f: FigureMetrics,
  opts: {
    /** Half-widths at hip, knee and ankle. */
    readonly taper: readonly [number, number, number];
    readonly hoof: readonly [number, number, number];
  },
): PartSpec[] {
  const [hip, knee, ankle] = opts.taper;
  const [fw, fh, fd] = opts.hoof;
  const out: PartSpec[] = [];
  const sides: readonly [string, number, number][] = [
    ['L', BONE.thighL, BONE.shinL],
    ['R', BONE.thighR, BONE.shinR],
  ];
  for (const [tag, thigh, shin] of sides) {
    out.push(
      hull({
        name: `thigh${tag}`,
        attach: thigh,
        role: 'coat',
        facets: 9,
        smooth: 2,
        rings: [
          { along: 1, rx: hip * 0.86, rz: hip * 0.86 },
          { along: -f.thighLen * 0.35, rx: hip, rz: hip },
          { along: -f.thighLen, rx: knee, rz: knee },
        ],
        pos: [0, 0, 0],
      }),
    );
    out.push(
      hull({
        name: `shin${tag}`,
        attach: shin,
        role: 'coat',
        facets: 9,
        smooth: 2,
        rings: [
          { along: 0.5, rx: knee, rz: knee },
          { along: -f.shinLen * 0.6, rx: (knee + ankle) / 2, rz: (knee + ankle) / 2 },
          { along: -f.shinLen, rx: ankle, rz: ankle },
        ],
        pos: [0, 0, 0],
      }),
    );
    out.push(joint({ name: `hip${tag}`, bone: thigh, radius: hip * 0.9 }));
    // The knee is the one joint on these characters that bends far enough to
    // matter -- a walk cycle takes it past a radian at a run.
    out.push(joint({ name: `knee${tag}`, bone: shin, radius: knee }));
    out.push({
      name: `hoof${tag}`,
      attach: shin,
      shape: 'box',
      // Sunk into the ankle so no gap opens when it swings.
      role: 'hoof',
      size: [fw, fh, fd],
      pos: [fd * 0.2, -f.shinLen - fh * 0.3, 0],
    });
  }
  return out;
}

/**
 * An ear as a flat lofted flap: wide fore-and-aft, thin across, tapering to a
 * rounded tip, with the inner surface painted as its lining.
 *
 * A flap rather than a cone on purpose. The socket's splay is a rotation about
 * x, which leaves the ear's local x pointing fore-and-aft -- so `rx` is the
 * ear's width and `rz` its thickness, whatever angle it is held at. A five-sided
 * cone in the same place reads as a horn, which is a problem when the animal
 * next to it has actual horns.
 */
export function earPair(
  socket: string,
  opts: {
    readonly length: number;
    readonly width: number;
    readonly thickness: number;
    readonly liningRole?: CoatRole;
    readonly shellRole?: CoatRole;
  },
): PartSpec[] {
  const w = opts.width / 2;
  const t = opts.thickness / 2;
  const L = opts.length;
  const build = (target: string): PartSpec =>
    hull({
      name: `${target}Flap`,
      attach: target,
      role: opts.shellRole ?? 'coat',
      facets: 8,
      smooth: 2,
      rings: [
        { along: 0, rx: w * 0.72, rz: t * 0.8 },
        { along: L * 0.22, rx: w, rz: t },
        { along: L * 0.62, rx: w * 0.72, rz: t * 0.78 },
        { along: L * 0.88, rx: w * 0.34, rz: t * 0.42 },
        { along: L, rx: w * 0.1, rz: t * 0.16 },
      ],
      pos: [0, 0, 0],
      paint: [
        {
          role: opts.liningRole ?? 'skin',
          // The forward-facing half of the flap, which is the side a viewer
          // above and in front of the character actually sees.
          at: [w * 0.9, L * 0.34, 0],
          r: [w * 1.1, L * 0.62, t * 3],
        },
      ],
    });
  return [build(socket), build(`${socket}R`)];
}
