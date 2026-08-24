import { describe, expect, it } from 'vitest';
import { BONE, BONE_COUNT } from '../cloth/figure.js';
import { contrastRatio, luminance } from './color.js';
import { CRITTERS, CRITTER_IDS } from './index.js';
import { deriveCoat, MIN_ACCENT_CONTRAST, PLAYER_COATS } from './palette.js';
import {
  attachmentNames,
  boneOrigins,
  boundsOf,
  resolveParts,
  resolveSockets,
  speciesBounds,
} from './resolve.js';
import { COAT_ROLES, MIN_FEATURE_UNITS, type CoatRole, type CritterSpecies } from './types.js';

/**
 * Invariants of the critter species data (spec 055).
 *
 * The species files are the whole character system -- proportions, blocks and
 * colours, with no rendering code -- so *this* is where the interesting
 * properties live, and they can all be checked with no GL context and no canvas.
 *
 * The legibility cases deserve a word, because they are the ones that will fire
 * on somebody later. A unit is drawn about 64 px tall, which is ~1.33 world
 * units per pixel, and two things go wrong at that size in ways that are
 * invisible while you are modelling at 400 px: detail thinner than a couple of
 * pixels stops existing, and two flat colours close in value stop being two
 * shapes. Both are cheap to assert and impossible to eyeball across 2 species x
 * 12 coats, which is exactly the shape of a test.
 *
 * Every case runs over the registry, so a new animal is covered the moment it is
 * added -- no per-species test to remember to write.
 */

const SPECIES: readonly CritterSpecies[] = CRITTER_IDS.map((id) => CRITTERS[id]);

/** The coat roles follow the player's pick; only the rest are "accents". */
const COAT_TONES: ReadonlySet<CoatRole> = new Set<CoatRole>(['coat', 'coatShade', 'coatLight']);

/** Roles a species actually draws with, accents only. */
function accentRoles(species: CritterSpecies): CoatRole[] {
  const used = new Set(resolveParts(species).map((p) => p.role));
  return [...used].filter((r) => !COAT_TONES.has(r));
}

/** Parts belonging to the head: on the head bone, or on a socket hung off it. */
function isHeadPart(species: CritterSpecies): (p: { attach: number | string }) => boolean {
  const headSockets = new Set(
    resolveSockets(species)
      .filter((s) => s.parentBone === BONE.head)
      .map((s) => s.name),
  );
  return (p) => p.attach === BONE.head || (typeof p.attach === 'string' && headSockets.has(p.attach));
}

describe.each(SPECIES.map((s) => [s.name, s] as const))('%s: structure', (_name, species) => {
  it('attaches every part to a bone or a declared socket', () => {
    const legal = attachmentNames(species);
    for (const part of resolveParts(species)) {
      expect(legal.has(part.attach), `${part.name} -> ${String(part.attach)}`).toBe(true);
    }
  });

  it('hangs every socket off a real bone', () => {
    for (const socket of resolveSockets(species)) {
      expect(socket.parentBone, socket.name).toBeGreaterThanOrEqual(0);
      expect(socket.parentBone, socket.name).toBeLessThan(BONE_COUNT);
    }
  });

  it('mirrors sockets and parts into matched pairs', () => {
    for (const spec of species.sockets) {
      if (!spec.mirror) continue;
      const resolved = resolveSockets(species);
      const left = resolved.find((s) => s.name === spec.socket);
      const right = resolved.find((s) => s.name === `${spec.socket}R`);
      expect(left, spec.socket).toBeDefined();
      expect(right, `${spec.socket}R`).toBeDefined();
      // Mirrored across z: position negated in z, x/y rotations opposed, and the
      // flip sign opposed so the pair wobbles outward rather than in parallel.
      expect(right?.pos[2]).toBeCloseTo(-(left?.pos[2] ?? 0), 10);
      expect(right?.rot[0]).toBeCloseTo(-(left?.rot[0] ?? 0), 10);
      expect(right?.rot[2]).toBeCloseTo(left?.rot[2] ?? 0, 10);
      expect((left?.flip ?? 0) * (right?.flip ?? 0)).toBe(-1);
    }
  });

  it('puts the feet exactly on the ground', () => {
    // The skeleton hangs the legs off the pelvis by these three lengths, so if
    // they disagree with the hip height the character floats or sinks -- and it
    // is not obvious in a still render, only in a walk.
    const m = species.metrics;
    expect(m.ankleY + m.shinLen + m.thighLen).toBeCloseTo(m.hipY, 6);
    // A quadruped stands on its forelegs too, and until there was one nothing
    // here had any reason to look at the arm chain: it has to bring the same
    // three lengths to the same floor, or the animal stands with its front end
    // sunk into the ground or up on tiptoe.
    if ((species.stance ?? 'biped') === 'quadruped') {
      expect(m.ankleY + m.forearmLen + m.upperArmLen).toBeCloseTo(m.shoulderY, 6);
    }
    // And the *drawn* feet have to reach it. Everything above is the skeleton's
    // promise; this is whether the geometry hung off it keeps one. A body whose
    // lowest point is a couple of units up hovers, and it is invisible in a
    // still render because nothing in the frame says where the floor is.
    expect(speciesBounds(species).minY, 'lowest point of the body').toBeLessThan(1);
  });
});

describe.each(SPECIES.map((s) => [s.name, s] as const))('%s: legibility at 64px', (_name, species) => {
  it('has no sub-pixel detail', () => {
    for (const part of resolveParts(species)) {
      const largest = Math.max(...part.size);
      expect(largest, `${part.name} is ${largest.toFixed(2)} units at its longest`).toBeGreaterThanOrEqual(
        MIN_FEATURE_UNITS,
      );
    }
  });

  it('keeps every accent readable against all twelve coats', () => {
    const roles = accentRoles(species);
    expect(roles.length).toBeGreaterThan(0);
    for (const swatch of PLAYER_COATS) {
      const colors = deriveCoat(species, swatch.hex);
      for (const role of roles) {
        const ratio = contrastRatio(colors[role], swatch.hex);
        expect(ratio, `${role} on ${swatch.name}`).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
      }
    }
  });

  it('gives the head a third of the silhouette', () => {
    // A small head is the single fastest way to lose a character at unit size:
    // it is the part carrying the species, the facing and the expression.
    const whole = speciesBounds(species);
    const head = boundsOf(species, isHeadPart(species));
    const bodyWidth = whole.maxZ - whole.minZ;
    const headWidth = head.maxZ - head.minZ;
    const totalHeight = whole.maxY - whole.minY;
    expect(headWidth / bodyWidth).toBeGreaterThan(0.3);
    expect((head.maxY - head.minY) / totalHeight).toBeGreaterThan(0.22);
  });

  it('stands at unit scale, feet on the floor', () => {
    // How tall a body should be depends on what it is. A biped here is a body a
    // *player* is drawn as, and lives between the robed figure (82) and the
    // scene's trees (86): tall enough to read as a character, short enough not
    // to dwarf the world. A quadruped is livestock standing beside one, and
    // holding it to the same band would be asking for a sheep the size of a
    // person -- so it gets its own, checked just as tightly at the bottom end,
    // because the failure that actually happens is an animal drawn so low it
    // reads as a rock.
    const b = speciesBounds(species);
    const upright = (species.stance ?? 'biped') === 'biped';
    expect(b.maxY).toBeGreaterThan(upright ? 70 : 30);
    expect(b.maxY).toBeLessThan(upright ? 95 : 60);
    // Nothing may hang more than a hair below the ground plane the sim puts the
    // unit on, or the character reads as sunk into the terrain.
    expect(b.minY).toBeGreaterThan(-2);
  });

  it('separates the feet, so a stride reads', () => {
    const left = boundsOf(species, (p) => p.name.startsWith('hoofL'));
    const right = boundsOf(species, (p) => p.name.startsWith('hoofR'));
    expect(left.maxZ).toBeLessThan(right.minZ);
    expect(right.minZ - left.maxZ).toBeGreaterThan(2);
  });
});

describe.each(SPECIES.map((s) => [s.name, s] as const))('%s: joins', (_name, species) => {
  /** Bones the gait rotates, and which the limb hulls hang off. */
  const ARTICULATED = [
    BONE.upperArmL,
    BONE.forearmL,
    BONE.upperArmR,
    BONE.forearmR,
    BONE.thighL,
    BONE.shinL,
    BONE.thighR,
    BONE.shinR,
  ] as const;

  it('covers every articulated joint with a ball on its pivot', () => {
    // How the seam between two limb segments is masked, and the only way that
    // survives the joint bending: a sphere centred exactly on the pivot. The
    // pivot is the one point a rotation about it leaves fixed, so the sphere
    // does not move however far the limb swings, and while its radius covers the
    // thicker of the two segments no angle can open a gap.
    //
    // Overlap -- which is what masks the *rigid* joins -- cannot do this job. An
    // overlap tuned to close at rest pulls apart on the outside of the bend, and
    // a walk cycle takes these knees past a radian at a run.
    const parts = resolveParts(species);
    for (const bone of ARTICULATED) {
      const hulls = parts.filter((p) => p.attach === bone && p.shape === 'hull');
      if (hulls.length === 0) continue;

      const balls = parts.filter(
        (p) =>
          p.attach === bone &&
          p.shape === 'ball' &&
          Math.hypot(p.pos[0], p.pos[1], p.pos[2]) < 1e-6,
      );
      expect(balls.length, `bone ${bone} has no joint ball on its pivot`).toBeGreaterThan(0);

      // The ball has to be at least as fat as the segment leaving the joint.
      const widest = Math.max(...hulls.map((h) => Math.max(h.size[0], h.size[2])));
      const ball = Math.max(...balls.map((b) => Math.max(b.size[0], b.size[2])));
      expect(ball, `bone ${bone}: joint ${ball} vs limb ${widest}`).toBeGreaterThanOrEqual(
        widest * 0.9,
      );
    }
  });

  it('overlaps the head and torso rather than butting them together', () => {
    // The rigid joins are masked the other way round: neither end cap may sit on
    // the silhouette, so the torso runs on inside the skull and the head starts
    // back inside the torso. Two surfaces meeting at a shared plane show the
    // seam as a ledge however well their radii match.
    //
    // *Which way* they run into each other is the stance. An upright animal
    // stacks its head above its chest, so the overlap is in height and both
    // hulls loft along y; a quadruped hangs its head off the front, so the
    // overlap is along the body and both loft along x. Same rule, measured on
    // the axis the two hulls actually meet on -- which is read off the parts
    // rather than assumed, so a species that lofts one of them the other way
    // fails here rather than passing on an axis nobody compared.
    const parts = resolveParts(species);
    const torso = parts.find((p) => p.name === 'torso');
    const head = parts.find((p) => p.name === 'head');
    expect(torso?.rings, 'no torso hull').toBeDefined();
    expect(head?.rings, 'no head hull').toBeDefined();
    if (!torso?.rings || !head?.rings) return;

    const along = (species.stance ?? 'biped') === 'biped' ? 'y' : 'x';
    expect(torso.axis ?? 'y', 'torso lofts along the stance axis').toBe(along);
    expect(head.axis ?? 'y', 'head lofts along the stance axis').toBe(along);

    // Both hang off different bones, so they are compared where they end up: in
    // world height for an upright body, and in world *reach* for one on all
    // fours, which is what `chestForward`/`headForward` put on the x axis.
    const bones = boneOrigins(species.metrics);
    const chest = bones[BONE.chest];
    const skull = bones[BONE.head];
    const base = (node: typeof chest): number => (along === 'y' ? (node?.y ?? 0) : (node?.x ?? 0));
    const torsoEnd = Math.max(...torso.rings.map((r) => r.along)) + base(chest);
    const headStart = Math.min(...head.rings.map((r) => r.along)) + base(skull);
    expect(torsoEnd, 'torso stops before the head starts').toBeGreaterThan(headStart + 2);
  });
});

describe('coat derivation', () => {
  it('resolves every role for every species and every coat', () => {
    for (const species of SPECIES) {
      for (const swatch of PLAYER_COATS) {
        const colors = deriveCoat(species, swatch.hex);
        for (const role of COAT_ROLES) {
          const value = colors[role];
          expect(Number.isInteger(value), `${species.id}.${role}`).toBe(true);
          expect(value, `${species.id}.${role}`).toBeGreaterThanOrEqual(0);
          expect(value, `${species.id}.${role}`).toBeLessThanOrEqual(0xffffff);
        }
      }
    }
  });

  it('orders the coat tones dark to light', () => {
    for (const species of SPECIES) {
      for (const swatch of PLAYER_COATS) {
        const c = deriveCoat(species, swatch.hex);
        expect(c.coat).toBe(swatch.hex);
        expect(luminance(c.coatShade), `shade on ${swatch.name}`).toBeLessThan(luminance(c.coat));
        expect(luminance(c.coatLight), `light on ${swatch.name}`).toBeGreaterThan(luminance(c.coat));
      }
    }
  });

  it('is a pure function of species and coat', () => {
    for (const species of SPECIES) {
      const a = deriveCoat(species, 0x9ba58a);
      const b = deriveCoat(species, 0x9ba58a);
      expect(a).toEqual(b);
    }
  });

  it('offers coats that are distinct and mid-value', () => {
    const seen = new Set<number>();
    for (const swatch of PLAYER_COATS) {
      expect(seen.has(swatch.hex), swatch.name).toBe(false);
      seen.add(swatch.hex);
      // Room to shade *and* to tint. A near-black or near-white coat would
      // collapse one end of every derived scheme.
      const l = luminance(swatch.hex);
      expect(l, `${swatch.name} is too dark`).toBeGreaterThan(0.1);
      expect(l, `${swatch.name} is too light`).toBeLessThan(0.6);
    }
  });
});
