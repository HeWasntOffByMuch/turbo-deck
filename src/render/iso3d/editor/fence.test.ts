import { describe, expect, it } from 'vitest';
import { Rng } from '../../../shared/prng.js';
import {
  createLayer,
  createWorld,
  exportMap,
  FENCE_TILE_LENGTH,
  loadMap,
  parseMap,
  serializeMap,
  type ChunkOptions,
  type LoadedMap,
  type Prop,
  type Rect,
} from '../../../terrain/index.js';
import { EditHistory } from './history.js';
import {
  DEFAULT_FENCE,
  FENCE_STYLES,
  fencePropKind,
  fenceStep,
  fenceStroke,
  NO_FENCE_PATH,
  type FencePath,
  type FenceSettings,
} from './fence.js';

/**
 * Spec 058. A fence is the first tool here whose stroke is a *path* rather than
 * an area, and the property that makes it usable is one a screenshot cannot
 * show: tiles land exactly a tile apart however often the mouse is sampled. Draw
 * that wrong and a fence has gaps when the hand moves fast and doubles up when
 * it moves slowly, which no amount of looking at one still frame reveals.
 */

const BOUNDS: Rect = { minX: -400, minZ: -400, maxX: 400, maxZ: 400 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const LAYER = 'ground';

/** A gentle world; a fence does not care about slope, only about solid ground. */
function loaded(props: readonly Prop[] = []): LoadedMap {
  return loadMap(
    exportMap({
      world: createWorld([
        createLayer({
          id: LAYER,
          bounds: BOUNDS,
          baseY: -100,
          waterLevel: null,
          seed: 7,
          features: [{ kind: 'rolling', amplitude: 6 }],
        }),
      ]),
      props,
      seed: 7,
      arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
      options: OPT,
    }),
  );
}

const settings = (over: Partial<FenceSettings> = {}): FenceSettings => ({ ...DEFAULT_FENCE, ...over });

/** Drag from `from` to `to` in `samples` equal steps, as the frame loop would. */
function drag(
  map: LoadedMap,
  from: readonly [number, number],
  to: readonly [number, number],
  samples: number,
  over: Partial<FenceSettings> = {},
  onTouchChunk?: (cx: number, cz: number) => void,
): Prop[] {
  let rng = Rng.fromSeed(99);
  let path: FencePath = NO_FENCE_PATH;
  const added: Prop[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const at = {
      x: from[0] + (to[0] - from[0]) * t,
      z: from[1] + (to[1] - from[1]) * t,
      ...(onTouchChunk ? { onTouchChunk } : {}),
    };
    const out = fenceStroke(map.store, LAYER, settings(over), at, path, rng);
    path = out.path;
    rng = out.rng;
    added.push(...out.added);
  }
  return added;
}

describe('laying a fence', () => {
  it('lays nothing on the press: one point has no direction', () => {
    const map = loaded();
    const out = fenceStroke(map.store, LAYER, settings(), { x: 0, z: 0 }, NO_FENCE_PATH, Rng.fromSeed(1));
    expect(out.added).toHaveLength(0);
    expect(out.path).toEqual({ x: 0, z: 0, started: true });
  });

  it('lays tiles exactly a tile apart along the drag', () => {
    const map = loaded();
    const added = drag(map, [-200, 0], [200, 0], 40);
    expect(added.length).toBeGreaterThan(6);
    for (let i = 1; i < added.length; i++) {
      const a = added[i - 1] as Prop;
      const b = added[i] as Prop;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(FENCE_TILE_LENGTH, 6);
    }
  });

  it('lays the same fence however often the stroke is sampled', () => {
    // The property the whole path state exists for: a fast hand samples the same
    // line four times, a slow one forty, and both must build the same fence.
    const centres = (samples: number): string =>
      drag(loaded(), [-180, -60], [180, 140], samples)
        .map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`)
        .join(' ');
    expect(centres(4)).toBe(centres(40));
    expect(centres(4)).toBe(centres(97));
  });

  it('leaves nothing behind when the cursor has not moved a whole tile yet', () => {
    const map = loaded();
    const short = fenceStroke(
      map.store,
      LAYER,
      settings(),
      { x: FENCE_TILE_LENGTH - 1, z: 0 },
      { x: 0, z: 0, started: true },
      Rng.fromSeed(1),
    );
    expect(short.added).toHaveLength(0);
    // ...and the anchor is untouched, so the next sample measures from the same
    // place rather than losing the distance already covered.
    expect(short.path).toEqual({ x: 0, z: 0, started: true });
  });

  it('turns each tile onto the direction of travel', () => {
    const map = loaded();
    // A right-angle drag: down the +x axis, then up the +z one. The first leg is
    // a whole number of tiles long, so the corner lands on a tile boundary and
    // the second leg starts square -- a leg that starts mid-tile is mitred into
    // the turn instead, which is the right behaviour and a poor thing to assert
    // an exact angle against.
    let rng = Rng.fromSeed(3);
    let path: FencePath = NO_FENCE_PATH;
    const along: Prop[] = [];
    const corner = 3 * FENCE_TILE_LENGTH;
    for (const at of [{ x: -corner, z: 0 }, { x: corner, z: 0 }, { x: corner, z: 300 }]) {
      const out = fenceStroke(map.store, LAYER, settings(), at, path, rng);
      path = out.path;
      rng = out.rng;
      along.push(...out.added);
    }
    const east = along.filter((p) => Math.abs(p.y) < 1);
    const north = along.filter((p) => p.y > 20);
    expect(east.length).toBeGreaterThan(3);
    expect(north.length).toBeGreaterThan(3);
    // Rotations are constant within a leg and a quarter turn apart between them.
    for (const p of east) expect(p.rotation).toBeCloseTo(0, 6);
    for (const p of north) expect(p.rotation).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('scales the step with the tile, so a bigger fence still meets end to end', () => {
    const map = loaded();
    const added = drag(map, [-300, 0], [300, 0], 30, { fenceScale: 1.5 });
    const step = fenceStep(settings({ fenceScale: 1.5 }));
    expect(step).toBeCloseTo(FENCE_TILE_LENGTH * 1.5, 6);
    for (const prop of added) expect(prop.scale).toBeCloseTo(1.5, 6);
    for (let i = 1; i < added.length; i++) {
      const a = added[i - 1] as Prop;
      const b = added[i] as Prop;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(step, 6);
    }
  });

  it('stores the style the settings asked for', () => {
    // Every style gets its own kind, and 'wood' keeps the id already written
    // into saved maps.
    expect(fencePropKind('wood')).toBe('fence-wood');
    expect(fencePropKind('brick')).toBe('fence-brick');
    expect(new Set(FENCE_STYLES.map(fencePropKind)).size).toBe(FENCE_STYLES.length);
    for (const style of FENCE_STYLES) {
      const added = drag(loaded(), [-150, 0], [150, 0], 10, { style });
      expect(added.length).toBeGreaterThan(0);
      for (const prop of added) expect(prop.kind).toBe(fencePropKind(style));
    }
  });
});

describe('what a fence refuses to do', () => {
  it('does not double up when the same ground is dragged over again', () => {
    // Otherwise the first thing anyone drawing a paddock does -- going back over
    // a run to straighten it -- turns the run into a thicket of overlapping
    // tiles that then all have to be erased.
    const map = loaded();
    const first = drag(map, [-200, 0], [200, 0], 20).length;
    const again = drag(map, [-200, 0], [200, 0], 20).length;
    expect(first).toBeGreaterThan(6);
    expect(again).toBe(0);
  });

  it('lets a second fence of the other style share the ground', () => {
    const map = loaded();
    drag(map, [-200, 0], [200, 0], 20, { style: 'wood' });
    expect(drag(map, [-200, 0], [200, 0], 20, { style: 'brick' }).length).toBeGreaterThan(6);
  });

  it('skips ground the layer says is not solid, without giving up the run', () => {
    const map = loaded();
    const before = map.store.props(LAYER).length;
    // Straight out past the layer's own bounds and back is not possible in one
    // drag, so instead run along the very edge, where cells beyond the bounds
    // are not solid: nothing is planted out there.
    drag(map, [BOUNDS.minX - 300, 0], [BOUNDS.minX - 60, 0], 12);
    expect(map.store.props(LAYER).length).toBe(before);
  });

  it('stops one frame from laying an unbounded run when the cursor jumps', () => {
    const map = loaded();
    // A single sample across the whole world, as a tab regaining focus can give.
    const out = fenceStroke(
      map.store,
      LAYER,
      settings(),
      { x: 5000, z: 0 },
      { x: -5000, z: 0, started: true },
      Rng.fromSeed(1),
    );
    expect(out.added.length).toBeLessThanOrEqual(24);
    // The run resumes from the cursor rather than from where the cap stopped, so
    // the next frame does not carry on filling in the jump.
    expect(out.path).toEqual({ x: 5000, z: 0, started: true });
  });

  it('survives a non-finite sample and an unknown layer', () => {
    const map = loaded();
    const path = { x: 0, z: 0, started: true };
    expect(fenceStroke(map.store, LAYER, settings(), { x: NaN, z: 0 }, path, Rng.fromSeed(1)).added).toHaveLength(0);
    expect(fenceStroke(map.store, 'nope', settings(), { x: 100, z: 0 }, path, Rng.fromSeed(1)).added).toHaveLength(0);
  });
});

describe('the colour-variety option (spec 061)', () => {
  it('marks a tile uniform only when the variety is off', () => {
    // Absent rather than false for the default, so the document does not grow a
    // field per prop for the way every fence painted so far was already laid.
    for (const prop of drag(loaded(), [-200, 0], [200, 0], 20, { variedColor: true })) {
      expect('uniform' in prop).toBe(false);
    }
    const flat = drag(loaded(), [-200, 0], [200, 0], 20, { variedColor: false });
    expect(flat.length).toBeGreaterThan(6);
    for (const prop of flat) expect(prop.uniform).toBe(true);
  });

  it('carries the flag through a save and a load, in both directions', () => {
    const map = loaded();
    drag(map, [-200, -80], [200, -80], 20, { variedColor: false });
    drag(map, [-200, 80], [200, 80], 20, { variedColor: true });
    const reloaded = loadMap(parseMap(serializeMap(map.store.toDocument())));
    const props = reloaded.store.props(LAYER);
    expect(props.filter((p) => p.uniform === true).length).toBeGreaterThan(6);
    // ...and the varied ones come back varied, without the field appearing.
    const varied = props.filter((p) => p.uniform !== true);
    expect(varied.length).toBeGreaterThan(6);
    for (const prop of varied) expect('uniform' in prop).toBe(false);
  });

  it('leaves a document written before the option existed alone', () => {
    const map = loaded();
    drag(map, [-200, 0], [200, 0], 20, { variedColor: false });
    const text = serializeMap(map.store.toDocument());
    // Strip the field as an older writer would have, and it still parses and
    // still draws varied rather than failing or defaulting to flat.
    const older = parseMap(text.replace(/, "uniform": true/g, ''));
    const props = loadMap(older).store.props(LAYER);
    expect(props.length).toBeGreaterThan(6);
    for (const prop of props) expect('uniform' in prop).toBe(false);
  });
});

describe('the fence as an edit', () => {
  it('announces every chunk it touches before the prop lands in it', () => {
    // The undo rule: a snapshot taken after the edit restores the edit.
    const map = loaded();
    const history = new EditHistory();
    history.beginStroke();
    drag(map, [-200, -100], [200, 100], 20, {}, (cx, cz) => history.captureChunk(map.store, LAYER, cx, cz));
    history.endStroke();

    expect(map.store.props(LAYER).length).toBeGreaterThan(6);
    history.undo(map.store);
    expect(map.store.props(LAYER)).toHaveLength(0);
  });

  it('is a pure function of its inputs: the same drag builds the same fence', () => {
    const once = drag(loaded(), [-160, -40], [160, 120], 17);
    const twice = drag(loaded(), [-160, -40], [160, 120], 17);
    expect(twice).toEqual(once);
    // ...including the tint, which is the one part drawn from the Rng.
    expect(new Set(once.map((p) => p.tint)).size).toBeGreaterThan(1);
  });

  it('reports the chunks it dirtied, deduplicated', () => {
    const map = loaded();
    const out = fenceStroke(
      map.store,
      LAYER,
      settings(),
      { x: 200, z: 0 },
      { x: -200, z: 0, started: true },
      Rng.fromSeed(5),
    );
    expect(out.added.length).toBeGreaterThan(6);
    const keys = out.dirty.map((c) => `${c.cx},${c.cz}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(0);
  });
});
