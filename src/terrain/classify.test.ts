import { describe, expect, it } from 'vitest';
import { classify, DEFAULT_BANDS } from './classify.js';
import type { TerrainMaterial } from './types.js';

const flat = { slope: 0, region: 'default', waterLevel: 0 } as const;

describe('classify', () => {
  it('reaches every material', () => {
    const seen = new Set<TerrainMaterial>([
      classify({ ...flat, height: -10 }), // water
      classify({ ...flat, height: 10 }), // sand (inside the shore band)
      classify({ ...flat, height: 100 }), // grass
      classify({ ...flat, height: 100, region: 'path' }), // dirt
      classify({ ...flat, height: 200 }), // rock (above the rock line)
      classify({ ...flat, height: 400 }), // snow
    ]);
    expect([...seen].sort()).toEqual(['dirt', 'grass', 'rock', 'sand', 'snow', 'water']);
  });

  it('lets an authored path win over height and slope', () => {
    for (const height of [-100, 0, 100, 300, 1000]) {
      for (const slope of [0, 0.5, 3]) {
        expect(classify({ height, slope, region: 'path', waterLevel: 0 })).toBe('dirt');
      }
    }
  });

  it('floods everything at or below the water level', () => {
    expect(classify({ ...flat, height: -0.001 })).toBe('water');
    expect(classify({ ...flat, height: 0 })).toBe('water');
    // Steepness and a rocky tag do not lift ground out of the water.
    expect(classify({ height: -50, slope: 5, region: 'rocky', waterLevel: 0 })).toBe('water');
  });

  it('bands the shoreline just above the water, and only there', () => {
    const { shoreBand } = DEFAULT_BANDS;
    expect(classify({ ...flat, height: shoreBand })).toBe('sand');
    expect(classify({ ...flat, height: shoreBand + 0.001 })).toBe('grass');
  });

  it('has no water or shore at all on a dry layer', () => {
    expect(classify({ height: -500, slope: 0, region: 'default', waterLevel: null })).toBe('grass');
  });

  it('turns grass to dirt then rock as the ground steepens', () => {
    const at = (slope: number): TerrainMaterial => classify({ ...flat, height: 100, slope });
    expect(at(0)).toBe('grass');
    expect(at(DEFAULT_BANDS.dirtSlope)).toBe('dirt');
    expect(at(DEFAULT_BANDS.rockSlope)).toBe('rock');
  });

  it('bares the ground to rock by height, and caps it with snow', () => {
    expect(classify({ ...flat, height: DEFAULT_BANDS.rockLine - 0.001 })).toBe('grass');
    expect(classify({ ...flat, height: DEFAULT_BANDS.rockLine })).toBe('rock');
    expect(classify({ ...flat, height: DEFAULT_BANDS.snowLine })).toBe('snow');
  });

  it('makes an authored rocky region rock even where it is level', () => {
    expect(classify({ height: 40, slope: 0, region: 'rocky', waterLevel: null })).toBe('rock');
  });

  it('honours retuned bands', () => {
    const arctic = { ...DEFAULT_BANDS, snowLine: 50 };
    expect(classify({ ...flat, height: 60 })).toBe('grass');
    expect(classify({ ...flat, height: 60 }, arctic)).toBe('snow');
  });
});
