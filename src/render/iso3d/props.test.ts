import { describe, expect, it } from 'vitest';
import {
  bareTrunkHeight,
  crownRadius,
  speciesHeight,
  speciesTierCounts,
  treeVariant,
  trunkHeight,
  trunkTopCover,
  type TreeSpecies,
} from './props.js';
import { PLAYER_RADIUS } from '../../sim/constants.js';
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
