import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  bareTrunkHeight,
  buildPropField,
  crownRadius,
  PROP_REGION_SIZE,
  propRegionKey,
  speciesHeight,
  speciesTierCounts,
  treeVariant,
  trunkHeight,
  trunkTopCover,
  brickCourse,
  TREE_SPECIES,
  type TreeSpecies,
} from './props.js';
import { buildRegionInstances } from './props.js';
import { propRegions, propRegionsOwed } from './editor/prop-residency.js';
import { LOBED, slabLayout, trunkProfile } from './lobe.js';
import { PALETTE } from './palette.js';
import { fenceRotation } from './editor/fence.js';
import { PLAYER_RADIUS } from '../../sim/constants.js';
import {
  FENCE_KINDS,
  FENCE_TILE_LENGTH,
  footprintRadius,
  HOUSE_PLAN,
  STRUCTURE_KINDS,
  WELL_RADIUS,
} from '../../terrain/vegetation.js';
import { worldVegetation } from '../../terrain/vegetation.js';
import { createArenaWorld } from '../../terrain/world.js';
import type { Prop } from '../../terrain/vegetation.js';

const tree = (x: number, y: number, tint = 0): Prop => ({ kind: 'tree', x, y, scale: 1, rotation: 0, tint });

describe('treeVariant (spec 045)', () => {
  const forest = worldVegetation(20260731, createArenaWorld(20260731)).filter((p) => p.kind === 'tree');

  it('is pure in the position: the same tree is the same tree every time', () => {
    expect(treeVariant(tree(412, -880))).toEqual(treeVariant(tree(412, -880)));
    // ...and it is the *position* that decides, not the rest of the prop.
    expect(treeVariant(tree(412, -880, 0.9))).toEqual(treeVariant(tree(412, -880, -0.9)));
  });

  it('grows every species across the world, none of them rare', () => {
    expect(forest.length).toBeGreaterThan(200);
    for (const species of TREE_SPECIES) {
      const share = forest.filter((p) => treeVariant(p).species === species).length / forest.length;
      expect(share).toBeGreaterThan(0.2);
      expect(share).toBeLessThan(0.5);
    }
  });

  it('varies the tier count within a species, so one outline is not stamped everywhere', () => {
    for (const species of ['fir', 'pine'] as const) {
      const counts = new Set(
        forest.map(treeVariant).filter((v) => v.species === species).map((v) => v.tierCount),
      );
      expect(counts.size).toBeGreaterThan(1);
    }
  });

  it('leans trees both ways, around a mean of roughly upright', () => {
    const asym = forest.map((p) => treeVariant(p).asymmetry);
    expect(Math.min(...asym)).toBeLessThan(-0.8);
    expect(Math.max(...asym)).toBeGreaterThan(0.8);
    expect(Math.abs(asym.reduce((a, b) => a + b, 0) / asym.length)).toBeLessThan(0.1);
  });

  it('decides species independently of the autumn tint', () => {
    // `tint` drives the autumn turn. If species were keyed off it too, every
    // autumn tree in the world would be the same shape.
    const autumn = forest.filter((p) => p.tint > 0.64);
    expect(autumn.length).toBeGreaterThan(20);
    const species = new Set(autumn.map((p) => treeVariant(p).species));
    expect([...species].sort()).toEqual([...TREE_SPECIES].sort());
  });

  it('keeps the lean and the tier count independent of each other', () => {
    const leaners = forest.map(treeVariant).filter((v) => v.asymmetry > 0.5);
    expect(new Set(leaners.map((v) => v.tierCount)).size).toBeGreaterThan(1);
  });
});

describe('the tree shapes themselves (spec 045)', () => {
  const species = TREE_SPECIES;

  it('leaves bare trunk standing under the canopy', () => {
    // The whole point of the reshape. The tree this replaced put a 34-radius
    // cone at y=26 over a 26-high trunk, so the trunk was hidden outright and
    // no tree in the world ever showed one.
    for (const s of species) {
      expect(bareTrunkHeight(s)).toBeGreaterThan(0.15 * speciesHeight(s));
    }
  });

  it('gives the pine a much longer bare trunk than the fir, so the two read apart', () => {
    expect(bareTrunkHeight('pine')).toBeGreaterThan(bareTrunkHeight('fir') * 1.5);
  });

  it('grows crowns wide enough to close over the gap the scatter has to leave', () => {
    // The scatter cannot pack trunks closer than a body's width apart without
    // walling the world off, so two neighbours in a saturated grove stand about
    // this far apart -- and the canopy only closes if the crowns reach further
    // than half of it.
    const meanScale = 1.125;
    const meanTrunkGap = 24 * meanScale * 2 + 2 * PLAYER_RADIUS;
    for (const s of species) {
      expect(2 * crownRadius(s) * meanScale).toBeGreaterThan(meanTrunkGap);
    }
    // ...which the 34-radius crown it replaced did not.
    expect(2 * 34 * meanScale).toBeLessThan(meanTrunkGap);
  });
});

describe('the trunk ends inside the canopy, not through it', () => {
  const species = ['fir', 'pine'] as const satisfies readonly TreeSpecies[];

  it('buries the trunk top in a frond for every shape a tree can take', () => {
    // The trunk is a solid column that stops in mid-air: wherever it ends, the
    // cap is either inside a cone or hanging out through the cone's sloped
    // side. The fir used to stand its trunk up to 86, where the frond around it
    // has narrowed to a ~3-unit radius -- 5 units of bare column stuck out into
    // open air, on every fir in the world.
    for (const s of species) {
      for (const tierCount of speciesTierCounts(s)) {
        // The lean and the drift are what pull the frond off the trunk's axis,
        // so sweep the whole band rather than trusting the upright case.
        for (let i = -20; i <= 20; i++) {
          const asymmetry = i / 20;
          const cover = trunkTopCover({ species: s, tierCount, asymmetry, leanAngle: 0 });
          expect(cover).toBeGreaterThan(0);
        }
      }
    }
  });

  it('buries it on every conifer the world actually grows', () => {
    const forest = worldVegetation(20260731, createArenaWorld(20260731))
      .filter((p) => p.kind === 'tree')
      .filter((p) => treeVariant(p).species !== 'lobed');
    expect(forest.length).toBeGreaterThan(200);
    const worst = Math.min(...forest.map((p) => trunkTopCover(treeVariant(p))));
    expect(worst).toBeGreaterThan(0);
  });

  it('reports the question as vacuous for the lobed tree rather than answering it', () => {
    // Its trunk narrows to a single vertex, so there is no flat cap to bury and
    // no corners to poke out through a frond. Saying `Infinity` is what stops
    // the sweep above quietly counting it as a pass on a shape it cannot judge.
    for (const tierCount of speciesTierCounts('lobed')) {
      expect(trunkTopCover({ species: 'lobed', tierCount, asymmetry: 1, leanAngle: 0 })).toBe(Infinity);
    }
  });

  it('ends every tree in the last frond it grew, not one the species might have', () => {
    // Spec 122. The cover is bought by ending the trunk lower, so the obvious
    // wrong fix is to end it below the foliage entirely -- which hides the
    // trunk's top by leaving the crown floating over a stump. The one it
    // *replaces* is subtler and was live: one height per species meant a
    // four-tier fir quit inside its second frond with two more above it.
    for (const s of species) {
      for (const tierCount of speciesTierCounts(s)) {
        const variant = { species: s, tierCount, asymmetry: 0, leanAngle: 0 };
        const top = tierBase(s, Math.min(tierCount, tierCount)) as [number, number];
        expect(trunkHeight(variant)).toBeGreaterThan(bareTrunkHeight(s));
        // Inside the topmost frond this tree grew: above its base plane, and
        // below its tip -- which is the definition, read off the built geometry
        // rather than off the same table the code derived it from.
        expect(trunkHeight(variant)).toBeGreaterThan(top[0]);
        expect(trunkHeight(variant)).toBeLessThan(top[1]);
      }
      // A taller tree of a species always carries the longer trunk.
      const counts = [...new Set(speciesTierCounts(s))].sort((a, b) => a - b);
      const heights = counts.map((tierCount) => trunkHeight({ species: s, tierCount, asymmetry: 0, leanAngle: 0 }));
      for (let i = 1; i < heights.length; i++) {
        expect(heights[i] as number).toBeGreaterThan(heights[i - 1] as number);
      }
    }
  });
});

/** A conifer of a given species and tier count, found by walking the position hash. */
function coniferProp(species: TreeSpecies, tierCount: number): Prop {
  for (let i = 0; i < 40000; i++) {
    const prop: Prop = { kind: 'tree', x: i * 37, y: i * 53, scale: 1, rotation: 0, tint: 0 };
    const variant = treeVariant(prop);
    if (variant.species === species && variant.tierCount === tierCount) return prop;
  }
  throw new Error(`no ${species} with ${tierCount} tiers in the hash`);
}

/** Every instanced batch of a built field. */
function batchesOf(props: readonly Prop[]): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  buildPropField(props, () => 0).group.traverse((object) => {
    if (object instanceof THREE.InstancedMesh) out.push(object);
  });
  return out;
}

/** The trunk is the one part drawn in bark rather than in leaf. */
function isFoliage(mesh: THREE.InstancedMesh): boolean {
  const color = new THREE.Color();
  mesh.getColorAt(0, color);
  return color.getHex() !== new THREE.Color(PALETTE.trunk).getHex();
}

/** Every vertex of a batch's geometry as (radius from its axis, bearing, height). */
function vertices(mesh: THREE.InstancedMesh): { r: number; a: number; y: number }[] {
  const position = mesh.geometry.getAttribute('position');
  const out: { r: number; a: number; y: number }[] = [];
  for (let i = 0; i < position.count; i++) {
    out.push({
      r: Math.hypot(position.getX(i), position.getZ(i)),
      a: Math.atan2(position.getZ(i), position.getX(i)),
      y: position.getY(i),
    });
  }
  return out;
}

/** Where a batch's first instance sits, in world Y. */
function instanceY(mesh: THREE.InstancedMesh): number {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(0, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix).y;
}

/**
 * The base plane and the tip of the topmost frond a tree of `tierCount` grew,
 * read off the geometry `buildPropField` actually built rather than off the
 * tier table -- which is the table the trunk's height is derived from, so a test
 * that read it too would be checking the code against itself.
 */
function tierBase(species: TreeSpecies, tierCount: number): [number, number] {
  let base = -Infinity;
  let tip = -Infinity;
  for (const frond of batchesOf([coniferProp(species, tierCount)]).filter(isFoliage)) {
    const at = instanceY(frond);
    const points = vertices(frond).map((p) => at + p.y);
    // The topmost frond is the one whose base plane is highest.
    const low = Math.min(...points);
    if (low > base) [base, tip] = [low, Math.max(...points)];
  }
  return [base, tip];
}

/**
 * The conifer's frond, as `buildPropField` actually builds it (spec 121).
 *
 * `frond.test.ts` covers the hem's arithmetic -- where the tips and the clefts
 * sit. What is left is everything between that and a frame, and it is all one
 * claim: the bite is cut out of the cone the fir and the pine have always been,
 * and costs nothing that was not already being paid. Every vertex on that cone's
 * surface is what makes the trunk's derived height survive a cutout; the
 * triangle budget and the batch count are what make "no burden on performance"
 * a thing a test can fail rather than a sentence in a commit message.
 */
const conifers = ['fir', 'pine'] as const satisfies readonly TreeSpecies[];

describe('the conifer frond, as built', () => {
  const fronds = (species: TreeSpecies, tierCount: number): THREE.InstancedMesh[] =>
    batchesOf([coniferProp(species, tierCount)]).filter(isFoliage);

  it('puts every vertex of a frond on the cone it is cut from', () => {
    // The property the whole thing rests on. A vertex *off* that surface --
    // pulled in at its own height rather than lifted up the slope -- would take
    // cover the trunk's derived height is counting on, and nothing in the frame
    // would say so.
    for (const species of conifers) {
      for (const tierCount of new Set(speciesTierCounts(species))) {
        for (const frond of fronds(species, tierCount)) {
          const points = vertices(frond);
          const apex = Math.max(...points.map((p) => p.y));
          const foot = Math.min(...points.map((p) => p.y));
          const height = apex - foot;
          const radius = Math.max(...points.map((p) => p.r));
          for (const { r, y } of points) {
            // The axis carries the apex and the underside's centre; every other
            // vertex is on the slope, exactly.
            if (r < 1e-9) continue;
            // Loosely, because the buffer is float32 and a 44-unit radius has
            // about six digits in it -- the claim is "on the surface", not "to
            // the last bit of a float".
            expect(r).toBeCloseTo((radius * (apex - y)) / height, 4);
          }
        }
      }
    }
  });

  it('keeps a crown as wide as its species table says, and its base plane where it was', () => {
    for (const species of conifers) {
      const widest = Math.max(
        ...fronds(species, Math.max(...speciesTierCounts(species))).flatMap((frond) =>
          vertices(frond).map((p) => p.r),
        ),
      );
      expect(widest).toBeCloseTo(crownRadius(species), 6);
    }
    // ...and the lowest foliage still hangs exactly where `bareTrunkHeight`
    // promises, since the hem is cut *upward* out of the cone and never below it.
    for (const species of conifers) {
      const field = batchesOf([coniferProp(species, 2)]).filter(isFoliage);
      const lowest = Math.min(
        ...field.flatMap((frond) => {
          const matrix = new THREE.Matrix4();
          frond.getMatrixAt(0, matrix);
          const at = new THREE.Vector3().setFromMatrixPosition(matrix).y;
          return vertices(frond).map((p) => at + p.y);
        }),
      );
      expect(lowest).toBeCloseTo(bareTrunkHeight(species), 6);
    }
  });

  it('actually bites: a hem that is not the cone\'s own flat rim', () => {
    for (const species of conifers) {
      for (const frond of fronds(species, Math.max(...speciesTierCounts(species)))) {
        const points = vertices(frond);
        const foot = Math.min(...points.map((p) => p.y));
        const height = Math.max(...points.map((p) => p.y)) - foot;
        const rim = points.filter((p) => p.r > 1e-9);
        // One tip left at full reach, and a cut well up into the frond.
        expect(Math.min(...rim.map((p) => p.y - foot))).toBeCloseTo(0, 6);
        expect(Math.max(...rim.map((p) => p.y - foot))).toBeGreaterThan(0.15 * height);
      }
    }
  });

  it('costs a handful of triangles and not one extra batch', () => {
    for (const species of conifers) {
      for (const tierCount of new Set(speciesTierCounts(species))) {
        const batches = batchesOf([coniferProp(species, tierCount)]);
        // One trunk, one frond per tier it grew. The variety between two trees
        // is the instance matrix, so a bitten frond adds no draw call.
        expect(batches).toHaveLength(1 + tierCount);
        for (const frond of batches.filter(isFoliage)) {
          const triangles = frond.geometry.getAttribute('position').count / 3;
          // The cone was 7 sides and a cap; the clefts add at most three tips'
          // worth on top of that. A budget rather than an exact count, because
          // how many bites a frond takes is hashed.
          expect(triangles).toBeGreaterThanOrEqual(14);
          expect(triangles).toBeLessThanOrEqual(24);
        }
      }
    }
  });

  it('turns every frond differently while leaving the trunks alone', () => {
    // The variety is in the instance matrix, which is why one shared geometry
    // does not read as one shape stamped across a forest. A stand of firs that
    // all stand *unturned* -- one region, one batch, `rotation: 0` on every one
    // of them -- so the only thing that can separate their fronds is the spin.
    const stand: Prop[] = [];
    for (let i = 0; stand.length < 16 && i < 400; i++) {
      const prop = tree(40 + (i % 20) * 52, 40 + Math.floor(i / 20) * 52);
      const variant = treeVariant(prop);
      if (variant.species === 'fir' && variant.tierCount === 4) stand.push(prop);
    }
    expect(stand).toHaveLength(16);
    const yaws = (mesh: THREE.InstancedMesh): number[] => {
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      return Array.from({ length: mesh.count }, (_, i) => {
        mesh.getMatrixAt(i, matrix);
        quaternion.setFromRotationMatrix(matrix);
        const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
        return Math.atan2(axis.z, axis.x);
      });
    };
    const batches = batchesOf(stand);
    const foliage = batches.filter(isFoliage);
    expect(foliage).toHaveLength(4);
    for (const frond of foliage) {
      const spread = yaws(frond);
      expect(spread).toHaveLength(stand.length);
      // Turned across the whole compass rather than nudged: two neighbours
      // share a frond and must not share its bearing.
      expect(new Set(spread.map((y) => y.toFixed(3))).size).toBe(spread.length);
      expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(Math.PI);
    }
    // ...and no two tiers of one tree line up either, or a bite would run
    // straight down the side of the tree.
    const first = foliage.map((frond) => yaws(frond)[0] as number);
    for (let i = 1; i < first.length; i++) {
      expect(Math.abs((first[i] as number) - (first[0] as number))).toBeGreaterThan(0.05);
    }
    // The trunk is a square column and gets none of this: whatever the world
    // turned the tree by is what it is drawn at.
    for (const trunk of batches.filter((mesh) => !isFoliage(mesh))) {
      for (const yaw of yaws(trunk)) expect(yaw).toBeCloseTo(0, 9);
    }
  });

  it('spins a frond under the lean rather than turning the lean with it', () => {
    // The order that matters. Folded into the base yaw instead, the spin would
    // carry the lean's axis round with it, and one tree's tiers would tip in
    // four different compass directions while all drifting the same way -- the
    // canopy coming off the trunk, which is what the lean and the drift are
    // shaped to avoid.
    for (const species of conifers) {
      const prop = coniferProp(species, Math.max(...speciesTierCounts(species)));
      const variant = treeVariant(prop);
      expect(Math.abs(variant.asymmetry)).toBeGreaterThan(0.05);
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const bearings = fronds(species, variant.tierCount).map((frond) => {
        frond.getMatrixAt(0, matrix);
        quaternion.setFromRotationMatrix(matrix);
        const tipped = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
        return { bearing: Math.atan2(tipped.z, tipped.x), tilt: Math.hypot(tipped.x, tipped.z) };
      });
      for (const { tilt } of bearings) expect(tilt).toBeGreaterThan(1e-3);
      for (const { bearing } of bearings) expect(bearing).toBeCloseTo(bearings[0]?.bearing as number, 6);
    }
  });
});

/**
 * The conifer's trunk, as `buildPropField` actually builds it (spec 122).
 *
 * The height's own invariant -- that a tree ends its trunk in the frond it grew
 * -- is up with the burial sweep it belongs to. What is left here is the column
 * itself: round, thinning, and one geometry per tier count without a tree ever
 * drawing two of them.
 */
describe('the conifer trunk, as built', () => {
  const trunkOf = (species: TreeSpecies, tierCount: number): THREE.InstancedMesh => {
    const trunks = batchesOf([coniferProp(species, tierCount)]).filter((mesh) => !isFoliage(mesh));
    // The claim that costs money if it is wrong: the counts *partition* the
    // trees between the trunk batches, so a tree draws one and the field draws
    // no more trunks than it did when there was one geometry for the species.
    expect(trunks).toHaveLength(1);
    return trunks[0] as THREE.InstancedMesh;
  };

  it('stands round, on the ground, on every size of tree', () => {
    for (const species of conifers) {
      for (const tierCount of new Set(speciesTierCounts(species))) {
        const trunk = trunkOf(species, tierCount);
        const points = vertices(trunk);
        // Built standing on its own origin, so the instance sits at the ground
        // and the geometry runs up from zero.
        expect(Math.min(...points.map((p) => p.y))).toBeCloseTo(0, 6);
        expect(instanceY(trunk)).toBeCloseTo(0, 6);
        // Round: the foot is a ring of one radius at many bearings. A square
        // column has four bearings and two radii, its side and its corner.
        const foot = points.filter((p) => p.y < 1e-6 && p.r > 1e-9);
        expect(Math.max(...foot.map((p) => p.r)) - Math.min(...foot.map((p) => p.r))).toBeLessThan(1e-3);
        expect(new Set(foot.map((p) => p.a.toFixed(4))).size).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('thins as it climbs, and ends in a cap rather than a point', () => {
    for (const species of conifers) {
      for (const tierCount of new Set(speciesTierCounts(species))) {
        const points = vertices(trunkOf(species, tierCount));
        const top = Math.max(...points.map((p) => p.y));
        const widest = new Map<string, number>();
        for (const { r, y } of points) widest.set(y.toFixed(4), Math.max(widest.get(y.toFixed(4)) ?? 0, r));
        const rings = [...widest.entries()].map(([y, r]) => ({ y: Number(y), r })).sort((a, b) => a.y - b.y);
        expect(rings.length).toBeGreaterThan(3);
        for (let i = 1; i < rings.length; i++) {
          expect((rings[i] as { r: number }).r).toBeLessThan((rings[i - 1] as { r: number }).r);
        }
        // Thinner at the top but still a column: a trunk that tapered to a
        // vertex would have no cap to bury, and the burial sweep would be
        // vacuously true rather than true.
        const tip = rings[rings.length - 1] as { r: number };
        expect(tip.r).toBeGreaterThan(0.5);
        expect(tip.r).toBeLessThan(0.8 * (rings[0] as { r: number }).r);
        const crown = points.filter((p) => p.y > top - 1e-6);
        expect(crown.some((p) => p.r < 1e-9)).toBe(true);
        for (const p of crown) expect(p.r === 0 || Math.abs(p.r - tip.r) < 1e-3).toBe(true);
      }
    }
  });

  it('slices every size of one species out of a single profile', () => {
    // Two neighbours of different sizes are the same thickness at the same
    // height. Tapering each variant over its *own* length instead would leave a
    // sapling visibly thinner than the tree beside it at knee height.
    for (const species of conifers) {
      const counts = [...new Set(speciesTierCounts(species))];
      const profiles = counts.map((tierCount) => vertices(trunkOf(species, tierCount)));
      const shortest = Math.min(...profiles.map((points) => Math.max(...points.map((p) => p.y))));
      for (const points of profiles) {
        const first = profiles[0] as { r: number; y: number }[];
        for (const { r, y } of points) {
          if (y > shortest || r < 1e-9) continue;
          // The radius the other variants have at this height, interpolated
          // between their own rings.
          const below = Math.max(...first.filter((p) => p.y <= y + 1e-6).map((p) => p.y));
          const above = Math.min(...first.filter((p) => p.y >= y - 1e-6).map((p) => p.y));
          const at = (h: number): number => Math.max(...first.filter((p) => Math.abs(p.y - h) < 1e-6).map((p) => p.r));
          const want = above - below < 1e-6 ? at(below) : at(below) + ((at(above) - at(below)) * (y - below)) / (above - below);
          expect(r).toBeCloseTo(want, 3);
        }
      }
    }
  });
});

/**
 * Spec 058. A fence tile is the first prop whose *parts* have to line up with
 * the world -- a tree can be turned any way at all and nobody can tell, but a
 * tile's uprights sit along its own local +X and have to come out along the run.
 *
 * So these read the built instance matrices rather than any number in
 * isolation: the contract that matters is between `fenceRotation`, the part
 * offsets and three.js's rotation convention, and only a real field exercises
 * all three at once.
 */
describe('the buildings as they are actually built (spec 224)', () => {
  const flat = (): number => 0;

  const structure = (kind: 'house' | 'well', rotation = 0, scale = 1): Prop => ({
    kind,
    x: 0,
    y: 0,
    scale,
    rotation,
    tint: 0,
  });

  interface Part {
    readonly min: THREE.Vector3;
    readonly max: THREE.Vector3;
    readonly color: THREE.Color;
  }

  /**
   * Every vertex a prop puts in the world, gathered per batch.
   *
   * Off the built field rather than off the part list, because what is being
   * asked is where the geometry *lands* -- an offset applied the wrong way or a
   * roof left at its own origin is invisible in a part table and obvious here.
   */
  function partsOf(prop: Prop): Part[] {
    const field = buildPropField([prop], flat);
    const matrix = new THREE.Matrix4();
    const point = new THREE.Vector3();
    const parts: Part[] = [];
    field.group.updateMatrixWorld(true);
    field.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      const position = object.geometry.getAttribute('position');
      const color = new THREE.Color();
      if (object.instanceColor) object.getColorAt(0, color);
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, matrix);
        matrix.premultiply(object.matrixWorld);
        for (let v = 0; v < position.count; v++) {
          point.set(position.getX(v), position.getY(v), position.getZ(v)).applyMatrix4(matrix);
          min.min(point);
          max.max(point);
        }
      }
      parts.push({ min, max, color: color.clone() });
    });
    field.dispose();
    return parts;
  }

  /**
   * The batch drawn in one palette tone.
   *
   * A part is named by what it is *made of*, which is the only unambiguous
   * handle a built field offers: the geometry has been merged and instanced by
   * then, and every rule of thumb about height or width picks up a neighbour --
   * the first cut of this asked for "the widest thing under the eaves" and got
   * the corner posts, which are wider than the walls by exactly the half of
   * themselves that stands proud of each one.
   *
   * Exact rather than near: a prop at tint 0 takes the base colour untouched,
   * so the two hexes are the same number or the part is not the one asked for.
   */
  function toned(parts: readonly Part[], hex: number): Part[] {
    const want = new THREE.Color().setHex(hex);
    return parts.filter((p) => p.color.getHex() === want.getHex());
  }

  /** The union of some parts, as one box. */
  function span(parts: readonly Part[]): { min: THREE.Vector3; max: THREE.Vector3 } {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const part of parts) {
      min.min(part.min);
      max.max(part.max);
    }
    return { min, max };
  }

  it('draws both kinds, and gives each more than a box', () => {
    for (const kind of STRUCTURE_KINDS) {
      const parts = partsOf(structure(kind));
      expect(parts.length).toBeGreaterThan(3);
      expect(span(parts).max.y).toBeGreaterThan(60);
    }
  });

  it('builds the hut\'s walls to the plan its collider is derived from', () => {
    // The one number both halves read. A wall drawn wider than `HOUSE_PLAN` is
    // a building somebody can stand in the side of, whatever the circle says.
    const walls = toned(partsOf(structure('house')), PALETTE.hutWall);
    expect(walls).toHaveLength(1);
    const box = span(walls);
    expect(box.max.x - box.min.x).toBeCloseTo(HOUSE_PLAN.width, 3);
    expect(box.max.z - box.min.z).toBeCloseTo(HOUSE_PLAN.depth, 3);
  });

  it('sinks a building into the ground, so a slope shows no daylight under it', () => {
    for (const kind of STRUCTURE_KINDS) {
      // Ground is at 0 here, so anything below it is buried skirt.
      expect(span(partsOf(structure(kind))).min.y).toBeLessThan(-4);
    }
  });

  it('stands the straw on the walls, with no gap and nothing floating', () => {
    // The failure this is written against is a roof left at its own origin -- a
    // hut with a slab of thatch lying on the grass beside it -- and its
    // neighbour, a roof a few units clear of the wall because an offset was
    // measured from the wrong datum.
    const parts = partsOf(structure('house'));
    const walls = span(toned(parts, PALETTE.hutWall));
    const straw = span([
      ...toned(parts, PALETTE.thatch),
      ...toned(parts, PALETTE.thatchDeep),
      ...toned(parts, PALETTE.thatchPale),
    ]);
    expect(straw.min.y).toBeCloseTo(walls.max.y, 6);
    // ...and it reaches past the walls on every side, or the roof reads as a
    // lid sitting exactly on a box.
    expect(straw.min.x).toBeLessThan(-HOUSE_PLAN.width / 2);
    expect(straw.max.x).toBeGreaterThan(HOUSE_PLAN.width / 2);
    expect(straw.min.z).toBeLessThan(-HOUSE_PLAN.depth / 2);
    expect(straw.max.z).toBeGreaterThan(HOUSE_PLAN.depth / 2);
  });

  it('puts the door in the wall it faces, not through it', () => {
    // The door is the one part whose *side* matters: it says which way a hut is
    // turned, and the editor's facing slider turns it. Front is local +Z.
    const door = span(toned(partsOf(structure('house')), PALETTE.hollow));
    expect(door.min.z).toBeGreaterThan(HOUSE_PLAN.depth / 2 - 3);
    expect(door.min.y).toBeCloseTo(0, 6);
  });

  it('keeps the well\'s kerb inside the circle that blocks it', () => {
    // The well is the one prop here whose collider is exact rather than erring
    // wide, so the stonework must not reach past it -- stone you can walk
    // through is the same bug as air you cannot, in the other direction. The
    // batter at the foot is the buried part and is allowed its 3 units.
    const kerb = span(toned(partsOf(structure('well')), PALETTE.drystone));
    const reach = Math.max(-kerb.min.x, kerb.max.x, -kerb.min.z, kerb.max.z);
    expect(reach).toBeLessThanOrEqual(WELL_RADIUS + 3.001);
    expect(footprintRadius(structure('well'))).toBeCloseTo(WELL_RADIUS, 6);
  });

  it('turns the whole building, walls and roof together', () => {
    // A quarter turn swaps the plan's two spans. If a part's local offsets
    // turned the opposite way to its mesh -- the mistake a fence tile catches
    // at once -- the straw would come off the hut instead.
    const upright = span(partsOf(structure('house')));
    const turned = span(partsOf(structure('house', Math.PI / 2)));
    expect(turned.max.x - turned.min.x).toBeCloseTo(upright.max.z - upright.min.z, 3);
    expect(turned.max.z - turned.min.z).toBeCloseTo(upright.max.x - upright.min.x, 3);
    expect(turned.max.y).toBeCloseTo(upright.max.y, 6);
    // ...and the door has come round with it.
    const door = span(toned(partsOf(structure('house', Math.PI / 2)), PALETTE.hollow));
    expect(door.min.x).toBeGreaterThan(HOUSE_PLAN.depth / 2 - 3);
  });

  it('scales a building whole, so a bigger hut is the same hut', () => {
    const one = span(partsOf(structure('house')));
    const big = span(partsOf(structure('house', 0, 2)));
    expect(big.max.y).toBeCloseTo(one.max.y * 2, 4);
    expect(big.max.x - big.min.x).toBeCloseTo((one.max.x - one.min.x) * 2, 4);
  });

  it('does not sway: a house is not a tree', () => {
    // `buildRegionInstances` produces sway buffers only where every instance in
    // a batch leans, and a building that leaned in the wind would be a building
    // falling down.
    const region = buildRegionInstances([structure('house'), structure('well')], flat);
    expect(region.batches.length).toBeGreaterThan(0);
    for (const batch of region.batches) expect(batch.sway).toBeNull();
  });

  it('is a kind the field knows it can draw', () => {
    // The counterpart to the batch above: an unknown kind is counted as undrawn
    // and warned about, and a building that landed there would be a prop saved
    // into the map and never seen again.
    expect(buildRegionInstances([structure('house'), structure('well')], flat).undrawnKinds).toEqual([]);
  });
});

describe('fence tiles as they are actually built', () => {
  const flat = (): number => 0;

  /** Every instance position in a built field, world space. */
  function instancePositions(props: readonly Prop[]): THREE.Vector3[] {
    const field = buildPropField(props, flat);
    const out: THREE.Vector3[] = [];
    const matrix = new THREE.Matrix4();
    const at = new THREE.Vector3();
    field.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, matrix);
        out.push(at.setFromMatrixPosition(matrix).clone());
      }
    });
    field.dispose();
    return out;
  }

  const fenceProp = (rotation: number): Prop => ({
    kind: 'fence-wood',
    x: 0,
    y: 0,
    scale: 1,
    rotation,
    tint: 0,
  });

  it('lays a tile\'s parts along the run', () => {
    // A tile pointed down +x: every part sits on the x axis, none off it.
    const along = instancePositions([fenceProp(fenceRotation(1, 0))]);
    expect(along.length).toBeGreaterThan(3);
    for (const p of along) expect(Math.abs(p.z)).toBeLessThan(8);
    expect(Math.max(...along.map((p) => Math.abs(p.x)))).toBeGreaterThan(10);

    // ...and a quarter turn later, the same parts sit on the z axis instead.
    const across = instancePositions([fenceProp(fenceRotation(0, 1))]);
    for (const p of across) expect(Math.abs(p.x)).toBeLessThan(8);
    expect(Math.max(...across.map((p) => Math.abs(p.z)))).toBeGreaterThan(10);
  });

  it('puts the post at the end of the tile the run comes from, at any bearing', () => {
    // The assertion that pins the rotation *convention* rather than just the
    // axis. A tile is not symmetric along its run -- the post sits at local
    // -L/2 and the pickets at -L/6 and +L/6 -- so turning the part offsets the
    // opposite way to the mesh (which is what the code used to do) builds a
    // mirrored tile: post at the far end, rails on the wrong face. Along an
    // axis that still looks like a fence; on a diagonal the whole tile is
    // reflected off the line being drawn.
    const half = FENCE_TILE_LENGTH / 2;
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0.6, 0.8]] as const) {
      const at = instancePositions([fenceProp(fenceRotation(dx, dz))]);
      // Distance along the run, signed: the post is the one at -half.
      const along = at.map((p) => p.x * dx + p.z * dz);
      expect(Math.min(...along)).toBeCloseTo(-half, 4);
      // ...and nothing reaches the far end, because there is no post there.
      expect(Math.max(...along)).toBeCloseTo(FENCE_TILE_LENGTH / 6, 4);
    }
  });

  it('places every style\'s parts within half a tile of the tile centre', () => {
    // The whole seamless-tiling argument rests on this: parts placed inside
    // [-L/2, +L/2] meet the neighbour's rather than reaching over it.
    for (const kind of FENCE_KINDS) {
      const at = instancePositions([{ kind, x: 0, y: 0, scale: 1, rotation: 0, tint: 0 }]);
      expect(at.length).toBeGreaterThan(3);
      expect(Math.max(...at.map((p) => Math.abs(p.x)))).toBeLessThanOrEqual(FENCE_TILE_LENGTH / 2 + 1e-6);
    }
  });

  it('builds every style, and keeps them in separate batches from the plants', () => {
    const props: Prop[] = [
      ...FENCE_KINDS.map((kind, i) => ({ kind, x: i * 200, y: 0, scale: 1, rotation: 0, tint: i / 5 })),
      { kind: 'bush' as const, x: 1200, y: 0, scale: 1, rotation: 0, tint: 0 },
    ];
    const field = buildPropField(props, flat);
    const meshes: THREE.InstancedMesh[] = [];
    field.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) meshes.push(o);
    });
    // One instance per part per kind: no batch mixes two props.
    expect(meshes.length).toBeGreaterThan(6);
    for (const mesh of meshes) expect(mesh.count).toBe(1);
    field.dispose();
  });

  it('says so when it has no geometry for a kind, rather than drawing nothing', () => {
    // The failure this exists for: a map written by a newer build, or a dev
    // server serving a half-updated module graph. The prop is placed, saved and
    // reloaded correctly and simply never appears, which reads as the tool
    // being broken -- and there is nothing on screen or in the log to say
    // otherwise. `undrawn` is what the editor's readout reports.
    const unknown = { kind: 'fence-wattle' as Prop['kind'], x: 0, y: 0, scale: 1, rotation: 0, tint: 0 };
    const field = buildPropField([unknown, tree(200, 0)], () => 0);
    expect(field.undrawn).toBe(1);
    field.dispose();

    const known = buildPropField(FENCE_KINDS.map((kind, i) => ({
      kind, x: i * 200, y: 0, scale: 1, rotation: 0, tint: 0,
    })), () => 0);
    expect(known.undrawn).toBe(0);
    known.dispose();
  });

  it('varies one tile from the next without moving where it stands', () => {
    // A run of identical tiles reads as one extruded ribbon, so the parts jitter
    // -- but hashed from the position, so a rebuild mid-stroke does not reshuffle
    // the wall someone is looking at.
    const run: Prop[] = [0, 1, 2, 3, 4].map((i) => ({
      kind: 'fence-rubble' as const,
      x: i * FENCE_TILE_LENGTH,
      y: 0,
      scale: 1,
      rotation: 0,
      tint: i / 5,
    }));
    const once = instancePositions(run).map((p) => `${p.x.toFixed(6)},${p.z.toFixed(6)}`);
    const twice = instancePositions(run).map((p) => `${p.x.toFixed(6)},${p.z.toFixed(6)}`);
    expect(twice).toEqual(once);
    // Tiles differ from each other: the same part is not at the same offset on
    // every one of them.
    expect(new Set(once.map((key) => key.split(',')[1])).size).toBeGreaterThan(1);
  });
});

/**
 * Spec 059. The two rough variants are irregular on purpose, which makes most
 * of them a matter for the eye and `scripts/preview-fence.ts`. Two things are
 * not: that the irregularity does not open a hole in what is meant to be a
 * continuous barrier, and that it actually varies rather than merely looking
 * like it might.
 */
describe('the rough fence variants', () => {
  const tile = (kind: Prop['kind'], x = 0): Prop => ({ kind, x, y: 0, scale: 1, rotation: 0, tint: 0 });

  /** Each drawn part's extent along the run, in world units. */
  function partSpans(props: readonly Prop[]): { min: number; max: number }[] {
    const field = buildPropField(props, () => 0);
    const spans: { min: number; max: number }[] = [];
    const matrix = new THREE.Matrix4();
    field.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      object.geometry.computeBoundingBox();
      const box = object.geometry.boundingBox;
      if (!box) return;
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, matrix);
        const world = box.clone().applyMatrix4(matrix);
        spans.push({ min: world.min.x, max: world.max.x });
      }
    });
    field.dispose();
    return spans.sort((a, b) => a.min - b.min);
  }

  /** Every instance colour in a built field, as hex. */
  function instanceColors(props: readonly Prop[]): number[] {
    const field = buildPropField(props, () => 0);
    const colors: number[] = [];
    const color = new THREE.Color();
    field.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh) || !object.instanceColor) return;
      for (let i = 0; i < object.count; i++) {
        object.getColorAt(i, color);
        colors.push(color.getHex());
      }
    });
    field.dispose();
    return colors;
  }

  for (const kind of ['fence-boards', 'fence-rubble'] as const) {
    it(`covers ${kind} end to end along the run, with no gap to see through`, () => {
      // A fence with a hole in it is not a fence, and an irregular layout is
      // exactly the kind that grows one when a width is nudged.
      const half = FENCE_TILE_LENGTH / 2;
      const spans = partSpans([tile(kind)]);
      expect((spans[0] as { min: number }).min).toBeLessThanOrEqual(-half);
      let reach = -Infinity;
      for (const span of spans) {
        if (span.min > reach && reach > -Infinity) {
          throw new Error(`${kind} has a gap from ${reach.toFixed(2)} to ${span.min.toFixed(2)}`);
        }
        reach = Math.max(reach, span.max);
      }
      expect(reach).toBeGreaterThanOrEqual(half);
    });
  }

  it('lays boards of differing widths, so the palisade is not a barcode', () => {
    const widths = partSpans([tile('fence-boards')]).map((s) => Number((s.max - s.min).toFixed(3)));
    expect(widths.length).toBeGreaterThan(4);
    expect(new Set(widths).size).toBeGreaterThan(3);
  });

  it('stacks stones of differing sizes', () => {
    const sizes = partSpans([tile('fence-rubble')]).map((s) => Number((s.max - s.min).toFixed(3)));
    expect(sizes.length).toBeGreaterThan(8);
    expect(new Set(sizes).size).toBeGreaterThan(4);
  });

  it('gives one tile several colours, not one', () => {
    for (const kind of ['fence-boards', 'fence-rubble'] as const) {
      expect(new Set(instanceColors([tile(kind)])).size).toBeGreaterThan(2);
    }
  });

  it('varies one tile from the next, and stays put when rebuilt', () => {
    // Both halves matter: without the first a run is one tile stamped fifty
    // times, and without the second the wall reshuffles itself mid-stroke.
    const run = [0, 1, 2, 3].map((i) => tile('fence-boards', i * FENCE_TILE_LENGTH));
    const key = (): string[] =>
      partSpans(run).map((s) => `${s.min.toFixed(4)},${s.max.toFixed(4)}`);
    expect(key()).toEqual(key());
    // Same part on two tiles: its width relative to its own tile differs.
    const widths = partSpans(run).map((s) => Number((s.max - s.min).toFixed(4)));
    expect(new Set(widths).size).toBeGreaterThan(7);
  });

  it('keeps a stone whole: the hash that roughens it never tears a corner apart', () => {
    // The perturbation is keyed by vertex *position* because the geometry is
    // non-indexed; keyed by index the copies of a shared corner would separate.
    const field = buildPropField([tile('fence-rubble')], () => 0);
    field.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      const position = object.geometry.getAttribute('position');
      const corners = new Map<string, string>();
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const y = position.getY(i);
        const z = position.getZ(i);
        expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
        // Every copy of a corner has to have landed in the same place. Keyed on
        // the *direction* it started in, which the knock does not change.
        const length = Math.hypot(x, y, z);
        const key = [x / length, y / length, z / length].map((n) => n.toFixed(3)).join(' ');
        const at = [x, y, z].map((n) => n.toFixed(4)).join(' ');
        const seen = corners.get(key);
        if (seen !== undefined) expect(at).toBe(seen);
        else corners.set(key, at);
      }
    });
    field.dispose();
  });
});

/**
 * Spec 060. Brick is the one style whose whole point is regularity, so the
 * property worth pinning is not that it varies but that its bond *lines up* --
 * specifically across a tile boundary, where the failure is two bricks in the
 * same world space z-fighting the length of a wall.
 */
describe('the brick bond', () => {
  const half = FENCE_TILE_LENGTH / 2;
  /** A course as [start, end] spans, sorted along the run. */
  const spans = (course: number): [number, number][] =>
    brickCourse(course)
      .map(([centre, run]) => [centre - run / 2, centre + run / 2] as [number, number])
      .sort((a, b) => a[0] - b[0]);

  it('keeps every brick inside its own tile', () => {
    for (let course = 0; course < 6; course++) {
      for (const [from, to] of spans(course)) {
        expect(from).toBeGreaterThanOrEqual(-half - 1e-9);
        expect(to).toBeLessThanOrEqual(half + 1e-9);
      }
    }
  });

  it('leaves a joint between bricks, and never overlaps them', () => {
    for (let course = 0; course < 6; course++) {
      const laid = spans(course);
      for (let i = 1; i < laid.length; i++) {
        const gap = (laid[i] as [number, number])[0] - (laid[i - 1] as [number, number])[1];
        expect(gap).toBeGreaterThan(0);
      }
    }
  });

  it('offsets alternate courses, which is what a running bond is', () => {
    const even = spans(0).map(([from]) => from);
    const odd = spans(1).map(([from]) => from);
    expect(odd).not.toEqual(even);
    // No joint sits above a joint: the ends of one course fall inside the bricks
    // of the one below, which is the whole structural point of the pattern.
    for (let i = 1; i < spans(1).length; i++) {
      const joint = (spans(1)[i] as [number, number])[0];
      const under = spans(0).find(([from, to]) => joint > from && joint < to);
      expect(under).toBeDefined();
    }
  });

  it('carries the bond across a tile boundary without doubling a brick', () => {
    // This tile's last brick and the next tile's first, in one coordinate frame.
    for (const course of [0, 1]) {
      const here = spans(course);
      const next = spans(course).map(([from, to]) => [from + FENCE_TILE_LENGTH, to + FENCE_TILE_LENGTH]);
      const lastEnd = (here[here.length - 1] as [number, number])[1];
      const firstStart = (next[0] as number[])[0] as number;
      // They may meet exactly (the two halves of one brick) or leave a joint,
      // but they must never overlap.
      expect(firstStart).toBeGreaterThanOrEqual(lastEnd - 1e-9);
      // ...and the odd course's halves must add up to a whole brick, or the
      // pattern visibly breaks at every junction.
      if (course === 1) {
        const merged = (next[0] as number[])[1] as number - lastEnd + (lastEnd - (here[here.length - 1] as [number, number])[0]);
        const whole = (here[1] as [number, number])[1] - (here[1] as [number, number])[0];
        expect(merged).toBeCloseTo(whole, 6);
      }
    }
  });
});

/**
 * Spec 061. The flag says only "do not vary my colours"; everything else about
 * the tile -- where its parts sit, how many there are, what shape they take --
 * has to be untouched, or a setting people reach for to calm a wall down would
 * quietly rebuild it.
 */
describe('uniform fence colour', () => {
  const flat = (): number => 0;
  const tile = (kind: Prop['kind'], over: Partial<Prop> = {}): Prop => ({
    kind,
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    tint: 0.4,
    ...over,
  });

  function drawn(props: readonly Prop[]): { colors: number[]; positions: string[] } {
    const field = buildPropField(props, flat);
    const colors: number[] = [];
    const positions: string[] = [];
    const matrix = new THREE.Matrix4();
    const at = new THREE.Vector3();
    const color = new THREE.Color();
    field.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, matrix);
        positions.push(at.setFromMatrixPosition(matrix).toArray().map((n) => n.toFixed(5)).join(','));
        if (object.instanceColor) {
          object.getColorAt(i, color);
          colors.push(color.getHex());
        }
      }
    });
    field.dispose();
    return { colors, positions };
  }

  for (const kind of ['fence-boards', 'fence-brick', 'fence-rubble'] as const) {
    it(`draws ${kind} in fewer colours when asked for one flat tone`, () => {
      const varied = new Set(drawn([tile(kind)]).colors).size;
      const uniform = new Set(drawn([tile(kind, { uniform: true })]).colors).size;
      expect(uniform).toBeGreaterThan(0);
      expect(uniform).toBeLessThan(varied);
    });

    it(`gives every ${kind} tile the same colours, wherever it stands`, () => {
      // The point of the option: a run reads as one batch of material rather
      // than as fifty tiles that each drifted somewhere else.
      const here = drawn([tile(kind, { uniform: true })]).colors;
      const there = drawn([tile(kind, { uniform: true, x: 480, y: 240, tint: -0.9 })]).colors;
      expect(there).toEqual(here);
      // ...which is exactly what a varied tile does *not* do.
      const variedThere = drawn([tile(kind, { x: 480, y: 240, tint: -0.9 })]).colors;
      expect(variedThere).not.toEqual(drawn([tile(kind)]).colors);
    });

    it(`changes nothing but colour on a ${kind} tile`, () => {
      expect(drawn([tile(kind, { uniform: true })]).positions).toEqual(drawn([tile(kind)]).positions);
    });
  }

  it('keeps colour that is structural rather than decorative', () => {
    // A picket's posts are darker than its rails because they are a different
    // piece of timber. Flattening that would be flattening the design, not the
    // variety, so the parts that carry it have no uniform tone to fall back to.
    expect(new Set(drawn([tile('fence-wood', { uniform: true })]).colors).size).toBeGreaterThan(1);
  });
});

/**
 * The lobed canopy tree as `buildPropField` actually builds it (spec 077).
 *
 * `lobe.test.ts` covers the arithmetic -- where the slabs go, what the outline
 * is, how the trunk tapers. What is left is everything between that and a frame:
 * whether the tip really is one vertex rather than a cap collapsed to nothing,
 * whether the dome came out convex on top and concave underneath, and whether
 * the canopy is wired to the wind differently from the trunk it hangs off.
 * Every one of those draws *something* when it is wrong.
 */
describe('the lobed canopy tree, as built', () => {
  /** A lobed tree of a given slab count, found by walking the position hash. */
  function lobedProp(tierCount: number, species: TreeSpecies = 'lobed'): Prop {
    for (let i = 0; i < 40000; i++) {
      const prop: Prop = { kind: 'tree', x: i * 37, y: i * 53, scale: 1, rotation: 0, tint: 0 };
      const variant = treeVariant(prop);
      if (variant.species === species && variant.tierCount === tierCount) return prop;
    }
    throw new Error(`no ${species} tree with ${tierCount} slabs in the hash`);
  }

  /** Every batch of one tree, with the world Y its instance sits at. */
  function partsOf(prop: Prop): { mesh: THREE.InstancedMesh; y: number; color: THREE.Color }[] {
    const field = buildPropField([prop], () => 0);
    const out: { mesh: THREE.InstancedMesh; y: number; color: THREE.Color }[] = [];
    const matrix = new THREE.Matrix4();
    field.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      object.getMatrixAt(0, matrix);
      const color = new THREE.Color();
      object.getColorAt(0, color);
      out.push({ mesh: object, y: new THREE.Vector3().setFromMatrixPosition(matrix).y, color });
    });
    return out;
  }

  /** The trunk is the one part drawn in bark rather than in leaf. */
  const isTrunk = (part: { color: THREE.Color }): boolean =>
    part.color.getHex() === new THREE.Color(PALETTE.trunk).getHex();

  /** The uniforms a patched material would hand three.js, without a GL context. */
  function swayUniforms(material: THREE.Material): Record<string, THREE.IUniform> {
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '', fragmentShader: '' };
    material.onBeforeCompile?.(shader as never, null as never);
    return shader.uniforms;
  }

  it('draws one trunk and exactly the slabs the count asks for', () => {
    for (const count of new Set(speciesTierCounts('lobed'))) {
      const parts = partsOf(lobedProp(count));
      expect(parts.filter(isTrunk)).toHaveLength(1);
      expect(parts.filter((p) => !isTrunk(p))).toHaveLength(count);
    }
  });

  it('keeps the canopy top where it is however few slabs it grows', () => {
    // The failure `grownAt` exists to prevent: slabs dropped off the top instead
    // of out of the middle leave a three-slab tree as a tall bare whip.
    const tops = [...new Set(speciesTierCounts('lobed'))].map((count) =>
      Math.max(...partsOf(lobedProp(count)).filter((p) => !isTrunk(p)).map((p) => p.y)),
    );
    for (const top of tops) expect(top).toBeCloseTo(tops[0] as number, 6);
    // ...and every count still leaves the tapered tip standing above the crown.
    expect(Math.max(...tops)).toBeLessThan(speciesHeight('lobed'));
  });

  it('ends the trunk in a single vertex, not a cap', () => {
    const trunk = partsOf(lobedProp(5)).find(isTrunk);
    const position = (trunk as { mesh: THREE.InstancedMesh }).mesh.geometry.getAttribute('position');
    let top = -Infinity;
    for (let i = 0; i < position.count; i++) top = Math.max(top, position.getY(i));
    expect(top).toBeCloseTo(speciesHeight('lobed'), 6);
    // Every vertex up there is the *same* vertex. A `radiusTop: 0` cylinder
    // would put one per side at the same height and a hair apart in XZ, which
    // draws the same picture and Z-fights at the top of every tree in the world.
    const apex: [number, number][] = [];
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) > top - 1e-6) apex.push([position.getX(i), position.getZ(i)]);
    }
    expect(apex.length).toBeGreaterThan(2);
    for (const [x, z] of apex) {
      expect(x).toBeCloseTo(apex[0]?.[0] as number, 9);
      expect(z).toBeCloseTo(apex[0]?.[1] as number, 9);
    }
  });

  it('tapers the trunk all the way, so no ring is wider than the one below it', () => {
    const trunk = partsOf(lobedProp(5)).find(isTrunk);
    const position = (trunk as { mesh: THREE.InstancedMesh }).mesh.geometry.getAttribute('position');
    // The widest vertex at each height, against the profile's own centre line.
    const widest = new Map<number, number>();
    const centres = new Map<number, [number, number]>();
    for (const ring of trunkProfile(LOBED)) centres.set(Math.round(ring.y * 1e6), [ring.x, ring.z]);
    for (let i = 0; i < position.count; i++) {
      const key = Math.round(position.getY(i) * 1e6);
      const centre = centres.get(key);
      if (!centre) continue;
      const r = Math.hypot(position.getX(i) - centre[0], position.getZ(i) - centre[1]);
      widest.set(key, Math.max(widest.get(key) ?? 0, r));
    }
    const byHeight = [...widest.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    expect(byHeight.length).toBe(LOBED.trunkRings + 1);
    for (let i = 1; i < byHeight.length; i++) {
      expect(byHeight[i] as number).toBeLessThan(byHeight[i - 1] as number);
    }
    expect(byHeight[0] as number).toBeCloseTo(LOBED.trunkRadius, 4);
    // A single point, to within what a Float32 buffer can hold at this height.
    expect(byHeight[byHeight.length - 1] as number).toBeCloseTo(0, 5);
  });

  it('domes each slab up over a concave underside', () => {
    // A slab's vertices sit at exactly two surfaces, `thickness` apart, each of
    // them `rise * (1 - u^2)` over its ring fraction. Pinning the whole set of
    // heights is what says the top is convex *and* the underside mirrors it:
    // a flat bottom would be missing the upper half of this list.
    const slabs = slabLayout(LOBED);
    for (const part of partsOf(lobedProp(5)).filter((p) => !isTrunk(p))) {
      const slab = slabs.find((s) => Math.abs(s.y - part.y) < 1e-3);
      expect(slab).toBeDefined();
      const rise = (slab as (typeof slabs)[number]).rise;
      const expected: number[] = [];
      for (let ring = 0; ring <= LOBED.lobeRings; ring++) {
        const u = ring / LOBED.lobeRings;
        const dome = rise * (1 - u * u);
        expected.push(dome, dome - LOBED.slabThickness);
      }
      const position = part.mesh.geometry.getAttribute('position');
      const seen = new Set<number>();
      for (let i = 0; i < position.count; i++) seen.add(position.getY(i));
      const wanted = [...new Set(expected)].sort((a, b) => a - b);
      const got = [...seen].sort((a, b) => a - b);
      // Compared one by one rather than deeply: the buffer is Float32 and the
      // expectation is doubles, so `13.2` and `13.2` are not the same number.
      expect(got).toHaveLength(wanted.length);
      got.forEach((y, i) => expect(y).toBeCloseTo(wanted[i] as number, 4));
      // Convex on top: highest in the middle, exactly flat at the rim so two
      // neighbouring slabs meet cleanly rather than at a lip.
      expect(Math.max(...expected)).toBeCloseTo(rise, 9);
      expect(expected).toContain(0);
    }
  });

  it('is a sheet with a rim rather than a slab of cake', () => {
    const slabs = slabLayout(LOBED);
    for (const part of partsOf(lobedProp(5)).filter((p) => !isTrunk(p))) {
      const slab = slabs.find((s) => Math.abs(s.y - part.y) < 1e-3) as (typeof slabs)[number];
      expect(LOBED.slabThickness / (2 * slab.radius)).toBeLessThan(0.1);
    }
  });

  it('paints the canopy in two tones and no more', () => {
    const tones = new Set(partsOf(lobedProp(5)).filter((p) => !isTrunk(p)).map((p) => p.color.getHex()));
    expect(tones.size).toBe(2);
  });

  it('keeps to two tones when it turns autumn as well', () => {
    // The autumn ramp is indexed per part, and the conifers index it by tier so
    // it climbs dark to bright over four of them. Indexed the same way here the
    // canopy would come out a three-colour gradient, which is the one thing a
    // flat two-tone palette is not.
    const autumn = { ...lobedProp(5), tint: 0.9 };
    const tones = new Set(partsOf(autumn).filter((p) => !isTrunk(p)).map((p) => p.color.getHex()));
    expect(tones.size).toBe(2);
  });

  it('lags each slab behind the trunk, and tilts it, while the trunk does neither', () => {
    // The wind is spec 074's and there is only one of it. What a slab gets is
    // two per-batch uniforms on top: a lag, so the canopy trails, and a tilt
    // about the slab's own origin, because a flat plate rides the trunk's arc
    // perfectly horizontally and would otherwise never lean at all.
    const parts = partsOf(lobedProp(5));
    const trunk = swayUniforms((parts.find(isTrunk) as { mesh: THREE.InstancedMesh }).mesh
      .material as THREE.Material);
    expect(trunk['uSwayLag']?.value).toBe(0);
    expect(trunk['uSwayTilt']?.value).toBe(0);

    const lags: number[] = [];
    for (const part of parts.filter((p) => !isTrunk(p)).sort((a, b) => a.y - b.y)) {
      const uniforms = swayUniforms(part.mesh.material as THREE.Material);
      expect(uniforms['uSwayTilt']?.value).toBeGreaterThan(0);
      lags.push(uniforms['uSwayLag']?.value as number);
      // The shadow passes bend with their own materials, so they need the same
      // two numbers or the shade under a tree trails on a different clock.
      for (const shadow of [part.mesh.customDepthMaterial, part.mesh.customDistanceMaterial]) {
        const theirs = swayUniforms(shadow as THREE.Material);
        expect(theirs['uSwayLag']?.value).toBe(uniforms['uSwayLag']?.value);
        expect(theirs['uSwayTilt']?.value).toBe(uniforms['uSwayTilt']?.value);
      }
    }
    // A gust reaches the top of a tree last, so the lag climbs with the slab.
    for (let i = 1; i < lags.length; i++) expect(lags[i] as number).toBeGreaterThan(lags[i - 1] as number);
    expect(Math.min(...lags)).toBeGreaterThan(0);
  });

  it('leaves the conifers on exactly the shader they were on', () => {
    // The lag and the tilt are uniform *values*, never generated source. If they
    // were spliced in as literals every species would need its own compiled
    // program, and `customProgramCacheKey` -- which is one constant string --
    // would hand one of them the other's shader.
    const source = (material: THREE.Material): string => {
      const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: '#include <common>\n#include <project_vertex>\n#include <worldpos_vertex>',
        fragmentShader: '',
      };
      material.onBeforeCompile?.(shader as never, null as never);
      return shader.vertexShader;
    };
    const conifer = partsOf(tree(0, 0)).find(isTrunk) as { mesh: THREE.InstancedMesh };
    const slab = partsOf(lobedProp(5)).find((p) => !isTrunk(p)) as { mesh: THREE.InstancedMesh };
    expect(source(slab.mesh.material as THREE.Material)).toBe(source(conifer.mesh.material as THREE.Material));
    expect((slab.mesh.material as THREE.Material).customProgramCacheKey?.()).toBe(
      (conifer.mesh.material as THREE.Material).customProgramCacheKey?.(),
    );
  });
});

/**
 * Rebuilding one batching region (spec 086).
 *
 * The field has always been grouped into regions so the camera can cull them.
 * This makes that grouping the unit of *invalidation* too: an edit rebuilds the
 * regions it touched instead of every batch in the world, which is what stops a
 * map part costing the whole map to draw.
 */
describe('rebuildWithin', () => {
  const R = PROP_REGION_SIZE;
  /** A tree in region 0,0 and one two regions east, so they never share a batch. */
  const near = tree(R * 0.5, R * 0.5);
  const far = tree(R * 2.5, R * 0.5);

  const meshCount = (o: THREE.Object3D): number => {
    let n = 0;
    o.traverse((child) => {
      if ((child as THREE.InstancedMesh).isInstancedMesh) n++;
    });
    return n;
  };

  it('names the region a point falls in', () => {
    expect(propRegionKey(R * 0.5, R * 0.5)).toBe('0,0');
    expect(propRegionKey(R * 2.5, R * 0.5)).toBe('2,0');
    // Negative coordinates floor away from zero, so a grown map's west side
    // does not fold onto its east.
    expect(propRegionKey(-R * 0.5, -R * 1.5)).toBe('-1,-2');
  });

  it('leaves the batches of regions it did not touch alone, object for object', () => {
    const field = buildPropField([near, far], () => 0);
    const before: THREE.Object3D[] = [];
    field.group.traverse((c) => {
      if ((c as THREE.InstancedMesh).isInstancedMesh) before.push(c);
    });
    expect(before.length).toBeGreaterThan(1);

    // Rebuild only region 0,0.
    field.rebuildWithin([near, far], { minX: R * 0.1, minZ: R * 0.1, maxX: R * 0.9, maxZ: R * 0.9 });

    const after: THREE.Object3D[] = [];
    field.group.traverse((c) => {
      if ((c as THREE.InstancedMesh).isInstancedMesh) after.push(c);
    });
    // The far region's meshes are the *same objects*: untouched, not rebuilt.
    expect(after.length).toBe(before.length);
    const shared = after.filter((m) => before.includes(m));
    expect(shared.length).toBeGreaterThan(0);
    field.dispose();
  });

  it('draws a prop added to a region it rebuilds', () => {
    const field = buildPropField([far], () => 0);
    const before = meshCount(field.group);

    field.rebuildWithin([far, near], { minX: 0, minZ: 0, maxX: R * 0.9, maxZ: R * 0.9 });
    expect(meshCount(field.group)).toBeGreaterThan(before);
    field.dispose();
  });

  it('drops a region emptied by an erase rather than leaving an empty group', () => {
    const field = buildPropField([near, far], () => 0);
    const before = meshCount(field.group);

    field.rebuildWithin([far], { minX: 0, minZ: 0, maxX: R * 0.9, maxZ: R * 0.9 });
    expect(meshCount(field.group)).toBeLessThan(before);
    // The far tree is still drawn: only the named region was rebuilt.
    expect(meshCount(field.group)).toBeGreaterThan(0);
    field.dispose();
  });

  it('recounts what it could not draw', () => {
    const unknown = { kind: 'fence-wattle' as Prop['kind'], x: R * 0.5, y: R * 0.5, scale: 1, rotation: 0, tint: 0 };
    const field = buildPropField([near], () => 0);
    expect(field.undrawn).toBe(0);

    field.rebuildWithin([near, unknown], { minX: 0, minZ: 0, maxX: R * 0.9, maxZ: R * 0.9 });
    expect(field.undrawn).toBe(1);
    field.dispose();
  });

  it('rebuilds every region a wide rectangle covers', () => {
    const field = buildPropField([near, far], () => 0);
    const all = meshCount(field.group);
    // A rectangle spanning both regions, with both props removed: nothing left.
    field.rebuildWithin([], { minX: 0, minZ: 0, maxX: R * 2.9, maxZ: R * 0.9 });
    expect(all).toBeGreaterThan(0);
    expect(meshCount(field.group)).toBe(0);
    field.dispose();
  });
});

describe('a deferred prop field (spec 211)', () => {
  const heightAt = (x: number, z: number): number => Math.sin(x / 300) * 40 + Math.cos(z / 210) * 25;
  const normalAt = (x: number, z: number): readonly [number, number, number] => {
    const n = new THREE.Vector3(Math.sin(x / 500) * 0.2, 1, Math.cos(z / 500) * 0.2).normalize();
    return [n.x, n.y, n.z];
  };

  /** Props spread over several regions, and a few kinds, deliberately small. */
  const props: Prop[] = [];
  for (const [rx, rz] of [[0, 0], [1, 0], [0, 1], [-1, 2]] as const) {
    for (let i = 0; i < 6; i++) {
      const x = rx * PROP_REGION_SIZE + 100 + i * 90;
      const y = rz * PROP_REGION_SIZE + 140 + i * 70;
      props.push({ kind: 'tree', x, y, scale: 0.9 + i * 0.05, rotation: i * 0.4, tint: i * 0.1 });
      props.push({ kind: 'bush', x: x + 40, y: y + 30, scale: 1, rotation: i, tint: 0 });
    }
  }

  /**
   * Every instanced batch a field holds, as comparable data.
   *
   * Sorted, because the two fields hang their regions in different orders on
   * purpose: the eager one builds in sorted key order and the deferred one
   * composes nearest the camera first. What has to match is the *content* --
   * every batch, every matrix, every colour -- not the order of the children.
   */
  const batchesOf = (group: THREE.Object3D): string[] => {
    const out: string[] = [];
    group.traverse((child) => {
      if (!(child instanceof THREE.InstancedMesh)) return;
      out.push(
        JSON.stringify({
          count: child.count,
          matrices: Array.from(child.instanceMatrix.array).map((v) => Number(v.toFixed(5))),
          colors: child.instanceColor ? Array.from(child.instanceColor.array).map((v) => Number(v.toFixed(5))) : null,
        }),
      );
    });
    return out.sort();
  };

  it('composes nothing at build time', () => {
    const field = buildPropField(props, heightAt, normalAt, undefined, { deferred: true });
    expect(batchesOf(field.group)).toEqual([]);
    field.dispose();
  });

  it('still counts what it cannot draw, before anything is composed', () => {
    // `undrawn` is a fact about the prop list, not about what has arrived, or a
    // tool looks broken for as long as the region holding them has not landed.
    const withUnknown = [...props, { kind: 'gazebo', x: 10, y: 10, scale: 1, rotation: 0, tint: 0 } as unknown as Prop];
    const field = buildPropField(withUnknown, heightAt, normalAt, undefined, { deferred: true });
    expect(field.undrawn).toBe(1);
    field.dispose();
  });

  it('drained of everything it owes, is the field the eager build returns', () => {
    const eager = buildPropField(props, heightAt, normalAt);
    const deferred = buildPropField(props, heightAt, normalAt, undefined, { deferred: true });

    // Composed in pivot order -- deliberately not the eager build's sorted key
    // order, so the assertion is about content rather than about luck.
    const buckets = propRegions(props);
    for (const key of propRegionsOwed(buckets, { x: -PROP_REGION_SIZE, z: 2 * PROP_REGION_SIZE }, new Set())) {
      deferred.adoptRegion(key, buildRegionInstances(buckets.get(key) ?? [], heightAt, normalAt));
    }

    expect(batchesOf(deferred.group)).toEqual(batchesOf(eager.group));
    expect(batchesOf(eager.group).length).toBeGreaterThan(0);
    eager.dispose();
    deferred.dispose();
  });

  it('composing a region twice leaves one copy of it', () => {
    // `adoptRegion` frees what was there first, which is what lets an edit and
    // the fill both reach the same region without doubling its trees.
    const buckets = propRegions(props);
    const key = [...buckets.keys()].sort()[0] ?? '';
    const field = buildPropField(props, heightAt, normalAt, undefined, { deferred: true });
    field.adoptRegion(key, buildRegionInstances(buckets.get(key) ?? [], heightAt, normalAt));
    const once = batchesOf(field.group);
    field.adoptRegion(key, buildRegionInstances(buckets.get(key) ?? [], heightAt, normalAt));
    expect(batchesOf(field.group)).toEqual(once);
    field.dispose();
  });
});
