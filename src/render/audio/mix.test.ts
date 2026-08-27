/**
 * The mix across a reload, and across a browser that will not co-operate
 * (spec 229).
 *
 * Two properties, and both of them fail silently.
 *
 * **A profile this build cannot read costs sliders, never the game.** This is
 * the first document read at mount, so every way it can go wrong -- a cleared
 * store, half a write, a profile from a build with a sixth bus, a private window
 * that throws on the read itself -- has to end at {@link AUDIO_DEFAULTS} rather
 * than in an exception on the way up. The throwing store is the case
 * `layout-store.ts` documents in as many words and the one nobody writes a test
 * for, because it never happens on the machine the code was written on.
 *
 * **Mute is a flag and not a zeroed slider**, which is only true for as long as
 * nothing on the mute path touches the stored numbers. `busGain` is where that
 * gets decided: it folds the master in and squares the result, so "it came back
 * where I left it" is a claim about arithmetic done on the way out rather than
 * about a level anybody wrote down -- exactly what a mute implemented as
 * `master = 0` cannot say, and what nobody notices is broken until they unmute.
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIO_DEFAULTS,
  AUDIO_KEY,
  AUDIO_VERSION,
  busGain,
  loadMix,
  migrateMix,
  saveMix,
  withBus,
  withMaster,
  withMuted,
  type AudioMix,
} from './mix.js';
import { BUSES, type BusId } from './events.js';
import type { StorageLike } from '../../ui/core/layout-store.js';

function storage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** A document the parser accepted, or a failure with the reason in it. */
function parsed(document: unknown): AudioMix {
  const mix = migrateMix(document);
  if (mix === null) throw new Error('the document was refused');
  return mix;
}

/** A mix with five distinct bus levels, so a value that moved is traceable to its slider. */
const DISTINCT: AudioMix = {
  version: AUDIO_VERSION,
  master: 0.55,
  buses: { player: 0.1, combat: 0.2, elemental: 0.3, ambience: 0.4, ui: 0.5 },
  muted: false,
};

/** The levels a slider can be dragged to, plus the ones only a bad document has. */
const RAW_LEVELS = [-1, -0.0001, 0, 0.25, 0.5, 1, 1.0001, 2, 1e9];
const NOT_LEVELS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.5', null, {}];

describe('what a reload gets back', () => {
  it('is the defaults for everything that is not a document this build wrote', () => {
    const store = storage();
    // Nothing was ever written: the ordinary first run, and the same answer as
    // every corrupt case below, which is the point.
    expect(loadMix(store)).toEqual(AUDIO_DEFAULTS);

    for (const junk of [
      'not json {',
      '',
      'null',
      '[]',
      '"loud"',
      '42',
      '{}',
      '{"version":null}',
      JSON.stringify({ version: 0, master: 1 }),
      JSON.stringify({ version: '1', master: 1 }),
      JSON.stringify([{ version: AUDIO_VERSION }]),
    ]) {
      store.map.set(AUDIO_KEY, junk);
      expect(() => loadMix(store)).not.toThrow();
      expect(loadMix(store)).toEqual(AUDIO_DEFAULTS);
    }
  });

  it('refuses a document from a build that knew more than this one, whole', () => {
    // Not "read the fields I recognise": a newer document can mean anything by a
    // field this build also has, and the cost of defaulting is four sliders.
    const newer = { version: AUDIO_VERSION + 1, master: 0.2, muted: true, buses: { player: 0.1 } };
    expect(migrateMix(newer)).toBeNull();

    const store = storage();
    store.map.set(AUDIO_KEY, JSON.stringify(newer));
    expect(loadMix(store)).toEqual(AUDIO_DEFAULTS);
  });

  it('keeps every level a document does carry and defaults only the bus it is missing', () => {
    // The asymmetry the header states: a profile written by a build with a sixth
    // bus should cost you that bus's level, not every level you have ever set.
    const mix = parsed({
      version: AUDIO_VERSION,
      master: 0.35,
      muted: true,
      buses: { player: 0.1, combat: 0.2, elemental: 0.3, ui: 0.5 },
    });

    expect(mix.buses.ambience).toBe(AUDIO_DEFAULTS.buses.ambience);
    expect(mix.buses.player).toBe(0.1);
    expect(mix.buses.combat).toBe(0.2);
    expect(mix.buses.elemental).toBe(0.3);
    expect(mix.buses.ui).toBe(0.5);
    expect(mix.master).toBe(0.35);
    expect(mix.muted).toBe(true);
  });

  it('ignores a bus this build has never heard of', () => {
    const mix = parsed({
      version: AUDIO_VERSION,
      master: 0.35,
      buses: { ...DISTINCT.buses, dialogue: 0.9, music: 'loud' },
    });

    // Not carried through as a sixth key -- `busGain` would never read it and a
    // graph built from the document would be asked for a node that is not there.
    expect([...Object.keys(mix.buses)].sort()).toEqual([...BUSES].sort());
    expect(mix.buses).toEqual(DISTINCT.buses);
  });

  it('reads back exactly what was written, for every mix the sliders can produce', () => {
    for (const muted of [false, true]) {
      for (const bus of BUSES) {
        const mix = withMuted(withMaster(withBus(DISTINCT, bus, 0.75), 0.9), muted);
        const store = storage();
        saveMix(store, mix);
        expect(loadMix(store)).toEqual(mix);
        // One key, so nothing else has to know the shape.
        expect([...store.map.keys()]).toEqual([AUDIO_KEY]);
      }
    }
  });

  it('takes the key it is given, so a test or a second profile is not the game', () => {
    const store = storage();
    saveMix(store, withMaster(DISTINCT, 0.25), 'other');
    expect(loadMix(store, 'other').master).toBe(0.25);
    expect(loadMix(store)).toEqual(AUDIO_DEFAULTS);
  });
});

describe('a browser that refuses', () => {
  it('does not take the mount down when the store throws on the read', () => {
    // A private window and a sandboxed frame both throw here rather than
    // answering null, and this read happens before there is a game to see it
    // fail. Same rule, and the same comment, as `loadLayout`.
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(() => loadMix(hostile)).not.toThrow();
    expect(loadMix(hostile)).toEqual(AUDIO_DEFAULTS);
  });

  it('swallows a refused write, because a slider moves inside a frame', () => {
    const hostile: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    expect(() => saveMix(hostile, DISTINCT)).not.toThrow();
  });
});

describe('moving one slider', () => {
  it('never clears another', () => {
    // Read-modify-write, over every bus rather than the one somebody tried: a
    // writer that rebuilt the document from its own field alone would leave four
    // levels at their defaults and look right on the slider being dragged.
    for (const bus of BUSES) {
      const moved = withBus(DISTINCT, bus, 0.05);
      expect(moved.buses[bus]).toBe(0.05);
      for (const other of BUSES) {
        if (other === bus) continue;
        expect(moved.buses[other]).toBe(DISTINCT.buses[other]);
      }
      expect(moved.master).toBe(DISTINCT.master);
      expect(moved.muted).toBe(DISTINCT.muted);
    }
  });

  it('leaves the buses alone when the master or the mute moves', () => {
    expect(withMaster(DISTINCT, 0.1).buses).toEqual(DISTINCT.buses);
    expect(withMaster(DISTINCT, 0.1).muted).toBe(DISTINCT.muted);
    expect(withMuted(DISTINCT, true).buses).toEqual(DISTINCT.buses);
    expect(withMuted(DISTINCT, true).master).toBe(DISTINCT.master);
  });

  it('clamps into 0..1 whatever a widget hands it', () => {
    for (const raw of RAW_LEVELS) {
      const wanted = Math.min(1, Math.max(0, raw));
      expect(withMaster(DISTINCT, raw).master).toBe(wanted);
      for (const bus of BUSES) expect(withBus(DISTINCT, bus, raw).buses[bus]).toBe(wanted);
      expect(parsed({ version: AUDIO_VERSION, master: raw, buses: { player: raw } }).master).toBe(wanted);
    }
  });

  it('leaves a level where it was rather than at zero when the number is not one', () => {
    // A NaN through a clamp is NaN, and `Math.min(1, Math.max(0, NaN))` is NaN
    // rather than a loud failure -- a gain node set to it is silence for the
    // session, from a slider that reads correct.
    for (const raw of NOT_LEVELS) {
      expect(withMaster(DISTINCT, raw as number).master).toBe(DISTINCT.master);
      expect(withBus(DISTINCT, 'combat', raw as number).buses.combat).toBe(DISTINCT.buses.combat);
      expect(parsed({ version: AUDIO_VERSION, master: raw }).master).toBe(AUDIO_DEFAULTS.master);
    }
  });
});

describe('the gain a bus is actually set to', () => {
  const levels = [0, 0.25, 0.5, 0.75, 1];

  function grid(): { mix: AudioMix; bus: BusId; master: number; level: number }[] {
    const out: { mix: AudioMix; bus: BusId; master: number; level: number }[] = [];
    for (const master of levels) {
      for (const level of levels) {
        for (const bus of BUSES) {
          out.push({ mix: withMaster(withBus(DISTINCT, bus, level), master), bus, master, level });
        }
      }
    }
    return out;
  }

  it('is silence when muted, whatever the levels say', () => {
    for (const { mix, bus } of grid()) expect(busGain(withMuted(mix, true), bus)).toBe(0);
  });

  it('is the master folded in and the whole thing squared', () => {
    // Squared because a slider is linear in position and hearing is not: half a
    // slider is a quarter of the gain, which is the claim, and a linear version
    // would pass a bounds check and do nothing over its top half.
    expect(busGain({ ...DISTINCT, master: 1, buses: { ...DISTINCT.buses, ui: 1 } }, 'ui')).toBe(1);
    expect(busGain({ ...DISTINCT, master: 1, buses: { ...DISTINCT.buses, ui: 0.5 } }, 'ui')).toBe(0.25);
    expect(busGain({ ...DISTINCT, master: 0.5, buses: { ...DISTINCT.buses, ui: 1 } }, 'ui')).toBe(0.25);
    // And the master is a multiply rather than a node of its own, so it is the
    // product that gets squared, not each half separately.
    for (const { mix, bus, master, level } of grid()) {
      expect(busGain(mix, bus)).toBeCloseTo((master * level) ** 2, 12);
    }
  });

  it('is between silence and full for every reachable mix', () => {
    for (const { mix, bus } of grid()) {
      const gain = busGain(mix, bus);
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });

  it('never turns a slider down as it is turned up', () => {
    for (const bus of BUSES) {
      let previous = -1;
      for (const level of levels) {
        const gain = busGain(withBus(DISTINCT, bus, level), bus);
        expect(gain).toBeGreaterThanOrEqual(previous);
        previous = gain;
      }
    }
  });

  it('gives the level back on unmuting, which is why mute is a flag', () => {
    // The whole argument for `muted` being a field rather than `master = 0`: a
    // zeroed slider has nowhere to put the level back from, and the failure only
    // shows up on the press that is meant to undo it.
    const before = BUSES.map((bus) => busGain(DISTINCT, bus));
    const roundTrip = withMuted(withMuted(DISTINCT, true), false);

    expect(roundTrip).toEqual(DISTINCT);
    expect(BUSES.map((bus) => busGain(roundTrip, bus))).toEqual(before);
    // It survives the reload too: a mute must not be written down as a level.
    const store = storage();
    saveMix(store, withMuted(DISTINCT, true));
    expect(BUSES.map((bus) => busGain(withMuted(loadMix(store), false), bus))).toEqual(before);
  });
});
