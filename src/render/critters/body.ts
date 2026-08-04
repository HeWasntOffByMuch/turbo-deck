/**
 * The shared anatomy vocabulary every critter is assembled from (spec 049).
 *
 * A species file should read like a description of an animal, not like a list of
 * boxes. These builders are where the boxes live: given a few numbers they
 * return the {@link PartSpec}s for a barrel torso, a pair of arms, a pair of
 * legs, a muzzle, a set of ears. A pig and a cow differ in about a dozen numbers
 * and four extra parts, and that is exactly how much a species file should be.
 *
 * Everything is expressed relative to the {@link FigureMetrics} it is handed, so
 * changing a species' proportions moves its geometry with it instead of stranding
 * a hard-coded offset three files away.
 */

import { BONE, type FigureMetrics } from '../cloth/figure.js';
import type { PartSpec } from './types.js';

/**
 * The rounded, pear-shaped body these characters are built on: a heavy low belly
 * under a narrower chest, with a lit front panel so the mass reads even when the
 * silhouette is flat against the ground.
 *
 * Both balls hang off the chest bone rather than being split between chest and
 * pelvis. The gait counter-twists chest against pelvis, and a torso split across
 * that joint shears visibly at a run.
 */
export function barrelTorso(
  f: FigureMetrics,
  opts: {
    /** Belly width, height and depth. */
    readonly belly: readonly [number, number, number];
    /** Chest width, height and depth. */
    readonly chest: readonly [number, number, number];
    /** How far below the chest bone the belly's centre sits. */
    readonly bellyDrop: number;
    /** How far above it the chest's centre sits. */
    readonly chestRise: number;
  },
): PartSpec[] {
  const [bw, bh, bd] = opts.belly;
  const [cw, ch, cd] = opts.chest;
  return [
    {
      name: 'belly',
      attach: BONE.chest,
      shape: 'ball',
      role: 'coat',
      size: [bw, bh, bd],
      pos: [0, -opts.bellyDrop, 0],
    },
    {
      name: 'chest',
      attach: BONE.chest,
      shape: 'ball',
      role: 'coat',
      size: [cw, ch, cd],
      pos: [0, opts.chestRise, 0],
    },
    // A lighter panel proud of the lower front of the belly. Cheaper than a
    // gradient and it survives the flat-shaded look: from the iso camera the
    // character shows its front-top, so this is the face that catches the eye.
    // Kept well under the belly's own size -- a large one reads as a bib.
    {
      name: 'bellyFront',
      attach: BONE.chest,
      shape: 'ball',
      role: 'coatLight',
      size: [bw * 0.6, bh * 0.56, bd * 0.58],
      pos: [bd * 0.26, -opts.bellyDrop - bh * 0.14, 0],
    },
    // The rump: keeps the profile from tapering to nothing behind the hips.
    {
      name: 'rump',
      attach: BONE.pelvis,
      shape: 'ball',
      role: 'coatShade',
      size: [bw * 0.62, bh * 0.44, bd * 0.82],
      pos: [-bd * 0.18, f.waistY - f.hipY - bh * 0.08, 0],
    },
  ];
}

/**
 * The neck block that stops the head reading as a balloon on a string. Short and
 * broad by default: these are heavy-set animals whose heads sit on their
 * shoulders, and a visible neck immediately makes them read as people in suits.
 */
export function neck(f: FigureMetrics, width: number, depth: number): PartSpec {
  const len = Math.max(4, f.neckY - f.shoulderY + 4);
  return {
    name: 'neck',
    attach: BONE.chest,
    shape: 'cone',
    role: 'coat',
    taper: 0.78,
    facets: 6,
    size: [width, len, depth],
    pos: [1.5, f.shoulderY - f.chestY + len * 0.4, 0],
  };
}

/**
 * Both arms, as tapered upper/fore segments with a hand at the wrist. Emitted
 * per bone rather than mirrored, because the skeleton already has a left and a
 * right arm and the gait swings them in opposition.
 */
export function bipedArms(
  f: FigureMetrics,
  opts: { readonly thickness: number; readonly hand: readonly [number, number, number]; readonly handRole?: 'hoof' | 'coatShade' },
): PartSpec[] {
  const t = opts.thickness;
  const [hw, hh, hd] = opts.hand;
  const out: PartSpec[] = [];
  const sides: readonly [string, number, number][] = [
    ['L', BONE.upperArmL, BONE.forearmL],
    ['R', BONE.upperArmR, BONE.forearmR],
  ];
  for (const [tag, upper, fore] of sides) {
    out.push({
      name: `upperArm${tag}`,
      attach: upper,
      shape: 'cone',
      role: 'coat',
      taper: 0.82,
      facets: 6,
      size: [t, f.upperArmLen, t],
      pos: [0, -f.upperArmLen / 2, 0],
      rot: [0, 0, Math.PI],
    });
    out.push({
      name: `forearm${tag}`,
      attach: fore,
      shape: 'cone',
      role: 'coatShade',
      taper: 0.8,
      facets: 6,
      size: [t * 0.86, f.forearmLen, t * 0.86],
      pos: [0, -f.forearmLen / 2, 0],
      rot: [0, 0, Math.PI],
    });
    out.push({
      name: `hand${tag}`,
      attach: fore,
      shape: 'box',
      role: opts.handRole ?? 'hoof',
      size: [hw, hh, hd],
      pos: [0, -f.forearmLen - hh * 0.4, 0],
    });
  }
  return out;
}

/**
 * Both legs: heavy thighs, narrower shins, and a foot that sticks *forward*.
 * The forward foot is doing real work at 64 px -- it is what tells a viewer the
 * character is standing on the ground rather than floating over it, and it is
 * the first thing a walk cycle reads through.
 */
export function bipedLegs(
  f: FigureMetrics,
  opts: {
    readonly thigh: number;
    readonly shin: number;
    readonly foot: readonly [number, number, number];
    /** Shin colour. Defaults to the coat -- a darker shin reads as a boot. */
    readonly shinRole?: 'coat' | 'coatShade';
  },
): PartSpec[] {
  const [fw, fh, fd] = opts.foot;
  const out: PartSpec[] = [];
  const sides: readonly [string, number, number][] = [
    ['L', BONE.thighL, BONE.shinL],
    ['R', BONE.thighR, BONE.shinR],
  ];
  for (const [tag, thigh, shin] of sides) {
    out.push({
      name: `thigh${tag}`,
      attach: thigh,
      shape: 'cone',
      role: 'coat',
      taper: 0.66,
      facets: 6,
      size: [opts.thigh, f.thighLen, opts.thigh],
      pos: [0, -f.thighLen / 2, 0],
      rot: [0, 0, Math.PI],
    });
    out.push({
      name: `shin${tag}`,
      attach: shin,
      shape: 'cone',
      role: opts.shinRole ?? 'coat',
      taper: 0.78,
      facets: 6,
      size: [opts.shin, f.shinLen, opts.shin],
      pos: [0, -f.shinLen / 2, 0],
      rot: [0, 0, Math.PI],
    });
    out.push({
      name: `hoof${tag}`,
      attach: shin,
      shape: 'box',
      role: 'hoof',
      // Sunk half a unit into the shin so no gap opens when the ankle swings.
      size: [fw, fh, fd],
      pos: [fd * 0.18, -f.shinLen - fh * 0.36, 0],
    });
  }
  return out;
}

/**
 * A muzzle projecting from the skull along +x, ending in a nose pad with
 * nostrils. The single most species-defining feature on the model, and the one
 * that survives being 12 px wide.
 */
export function muzzle(opts: {
  /** Where the muzzle's root sits in the head bone's frame. */
  readonly at: readonly [number, number, number];
  readonly length: number;
  readonly width: number;
  readonly height: number;
  /** Nose pad thickness along +x, and how much wider/taller than the muzzle it is. */
  readonly padDepth: number;
  readonly padFlare: number;
  /** Nostril block size and their lateral spacing. */
  readonly nostril: readonly [number, number, number];
  readonly nostrilSpread: number;
  /** Taper of the muzzle block toward the pad (1 is a straight snout). */
  readonly taper?: number;
}): PartSpec[] {
  const [ax, ay, az] = opts.at;
  const tipX = ax + opts.length;
  const [nw, nh, nd] = opts.nostril;
  return [
    {
      name: 'muzzle',
      attach: BONE.head,
      shape: 'cone',
      role: 'coat',
      taper: opts.taper ?? 0.92,
      facets: 6,
      // Cones are built along +y; rotating -90° about z lays the axis along +x,
      // which maps local (x, y, z) onto world (height, length, width).
      size: [opts.height, opts.length, opts.width],
      pos: [ax + opts.length / 2, ay, az],
      rot: [0, 0, -Math.PI / 2],
    },
    {
      name: 'nosePad',
      attach: BONE.head,
      shape: 'ball',
      role: 'skin',
      size: [opts.padDepth, opts.height * opts.padFlare, opts.width * opts.padFlare],
      pos: [tipX, ay, az],
    },
    {
      name: 'nostril',
      attach: BONE.head,
      shape: 'box',
      role: 'skinDeep',
      size: [nw, nh, nd],
      pos: [tipX + opts.padDepth * 0.34, ay, az - opts.nostrilSpread],
      mirror: true,
    },
  ];
}

/** Two dark eyes set on the skull's front quarters, where the iso camera sees them. */
export function eyes(opts: {
  readonly at: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}): PartSpec {
  const [x, y, z] = opts.at;
  const [w, h, d] = opts.size;
  return {
    name: 'eye',
    attach: BONE.head,
    shape: 'box',
    role: 'eye',
    size: [w, h, d],
    pos: [x, y, z],
    mirror: true,
  };
}

/**
 * An ear as two cones -- an outer shell in the coat colour and a lining in skin
 * -- built on a socket so it can flap. Returned parts attach to `socket` and its
 * mirrored twin `${socket}R`, so a species declares one ear and gets a pair.
 */
export function earPair(
  socket: string,
  opts: {
    readonly length: number;
    readonly width: number;
    readonly thickness: number;
    readonly liningRole?: 'skin' | 'marking';
    readonly shellRole?: 'coat' | 'coatShade' | 'marking';
  },
): PartSpec[] {
  const shell = (target: string): PartSpec => ({
    name: `${target}Shell`,
    attach: target,
    shape: 'cone',
    role: opts.shellRole ?? 'coat',
    taper: 0.14,
    facets: 5,
    size: [opts.width, opts.length, opts.thickness],
    pos: [0, opts.length / 2, 0],
  });
  const lining = (target: string): PartSpec => ({
    name: `${target}Lining`,
    attach: target,
    shape: 'cone',
    role: opts.liningRole ?? 'skin',
    taper: 0.12,
    facets: 5,
    size: [opts.width * 0.6, opts.length * 0.74, opts.thickness * 0.5],
    pos: [opts.thickness * 0.45, opts.length * 0.42, 0],
  });
  return [shell(socket), lining(socket), shell(`${socket}R`), lining(`${socket}R`)];
}
