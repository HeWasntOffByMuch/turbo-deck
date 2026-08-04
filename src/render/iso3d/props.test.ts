import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  bareTrunkHeight,
  buildPropField,
  crownRadius,
  speciesHeight,
  speciesTierCounts,
  treeVariant,
  trunkHeight,
  trunkTopCover,
  type TreeSpecies,
} from './props.js';
import { fenceRotation } from './editor/fence.js';
import { PLAYER_RADIUS } from '../../sim/constants.js';
import { FENCE_TILE_LENGTH } from '../../terrain/vegetation.js';
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

  it('grows both species across the world, neither of them rare', () => {
    expect(forest.length).toBeGreaterThan(200);
    const pines = forest.filter((p) => treeVariant(p).species === 'pine').length;
    const share = pines / forest.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.5);
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
    expect(species.size).toBe(2);
  });

  it('keeps the lean and the tier count independent of each other', () => {
    const leaners = forest.map(treeVariant).filter((v) => v.asymmetry > 0.5);
    expect(new Set(leaners.map((v) => v.tierCount)).size).toBeGreaterThan(1);
  });
});

describe('the tree shapes themselves (spec 045)', () => {
  const species = ['fir', 'pine'] as const satisfies readonly TreeSpecies[];

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
    // cap and its corners are either inside a cone or hanging out through the
    // cone's sloped side. The fir used to stand its trunk up to 86, where the
    // frond around it has narrowed to a ~3-unit radius -- 5 units of bare
    // column stuck out into open air, on every fir in the world.
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

  it('buries it on every tree the world actually grows', () => {
    const forest = worldVegetation(20260731, createArenaWorld(20260731)).filter((p) => p.kind === 'tree');
    expect(forest.length).toBeGreaterThan(200);
    const worst = Math.min(...forest.map((p) => trunkTopCover(treeVariant(p))));
    expect(worst).toBeGreaterThan(0);
  });

  it('still runs the trunk up through the canopy rather than stopping under it', () => {
    // The cover is bought by ending the trunk lower, so the obvious wrong fix
    // is to end it below the foliage entirely -- which hides the trunk's top by
    // leaving the crown floating over a stump.
    for (const s of species) {
      expect(trunkHeight(s)).toBeGreaterThan(bareTrunkHeight(s));
      // Well up into the crown, not just past the lowest frond's base.
      expect(trunkHeight(s)).toBeGreaterThan(0.5 * speciesHeight(s));
    }
    // ...and the pine's is still the longer of the two, as its silhouette wants.
    expect(trunkHeight('pine')).toBeGreaterThan(trunkHeight('fir'));
  });
});

/**
 * Spec 056. A fence tile is the first prop whose *parts* have to line up with
 * the world -- a tree can be turned any way at all and nobody can tell, but a
 * tile's uprights sit along its own local +X and have to come out along the run.
 *
 * So these read the built instance matrices rather than any number in
 * isolation: the contract that matters is between `fenceRotation`, the part
 * offsets and three.js's rotation convention, and only a real field exercises
 * all three at once.
 */
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

  it('draws a tile no longer than the step the fence tool lays it at', () => {
    // The whole seamless-tiling argument rests on this: parts inside
    // [-L/2, +L/2] meet the neighbour's and nothing overhangs into it.
    const reach = Math.max(...instancePositions([fenceProp(0)]).map((p) => Math.abs(p.x)));
    expect(reach).toBeLessThanOrEqual(FENCE_TILE_LENGTH / 2 + 1e-6);
  });

  it('builds both styles, and keeps them in separate batches from the plants', () => {
    const props: Prop[] = [
      { kind: 'fence-wood', x: 0, y: 0, scale: 1, rotation: 0, tint: 0 },
      { kind: 'fence-stone', x: 60, y: 0, scale: 1, rotation: 0, tint: 0.3 },
      { kind: 'bush', x: 120, y: 0, scale: 1, rotation: 0, tint: 0 },
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

  it('varies one tile from the next without moving where it stands', () => {
    // A run of identical tiles reads as one extruded ribbon, so the parts jitter
    // -- but hashed from the position, so a rebuild mid-stroke does not reshuffle
    // the wall someone is looking at.
    const run: Prop[] = [0, 1, 2, 3, 4].map((i) => ({
      kind: 'fence-stone' as const,
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
