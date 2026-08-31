/**
 * The scale preference (spec 136).
 *
 * The store's whole job is to be unshakeable: whatever is in storage, the game
 * opens. So most of this is junk going in and `'auto'` coming out.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHOW_FPS,
  DISPLAY_KEY,
  DISPLAY_VERSION,
  loadDisplay,
  loadMaxZoom,
  loadScale,
  loadShowFps,
  resolveMaxZoom,
  saveMaxZoom,
  migrateDisplay,
  parseDisplay,
  saveScale,
  saveShowFps,
  scaleLabel,
  SCALE_CHOICES,
  type ScaleChoice,
} from './display-store.js';
import type { StorageLike } from '../core/layout-store.js';

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

describe('the scale preference across a reload', () => {
  it('reads back what was written, for every choice offered', () => {
    for (const choice of SCALE_CHOICES) {
      const store = storage();
      saveScale(store, choice);
      expect(loadScale(store)).toBe(choice);
    }
  });

  it('is auto when nothing was ever written', () => {
    expect(loadScale(storage())).toBe('auto');
  });

  it('writes under one key, so nothing else has to know the shape', () => {
    const store = storage();
    saveScale(store, 3);
    expect([...store.map.keys()]).toEqual([DISPLAY_KEY]);
    expect(JSON.parse(store.map.get(DISPLAY_KEY) ?? '')).toEqual({
      version: DISPLAY_VERSION,
      scale: 3,
      showFps: DEFAULT_SHOW_FPS,
      maxZoom: 'supported',
    });
  });
});

describe('what the store refuses', () => {
  it('falls back to auto rather than throwing on junk', () => {
    const store = storage();
    store.setItem(DISPLAY_KEY, 'not json {');
    expect(loadScale(store)).toBe('auto');
  });

  it('refuses a scale that is not one of the choices', () => {
    // 5 is a real `UI_SCALES` entry and still not offered here, which is the
    // case that would slip through a `typeof value === 'number'` check.
    expect(migrateDisplay({ version: 1, scale: 5 })).toBeNull();
    expect(migrateDisplay({ version: 1, scale: 0 })).toBeNull();
    expect(migrateDisplay({ version: 1, scale: 2.5 })).toBeNull();
    expect(migrateDisplay({ version: 1, scale: '2' })).toBeNull();
  });

  it('refuses a document from a build that knew more than this one', () => {
    expect(migrateDisplay({ version: DISPLAY_VERSION + 1, scale: 2 })).toBeNull();
  });

  it('refuses a document with no version', () => {
    expect(migrateDisplay({ scale: 2 })).toBeNull();
    expect(parseDisplay('null')).toBeNull();
    expect(parseDisplay(null)).toBeNull();
  });

  it('accepts the document it writes', () => {
    const store = storage();
    saveScale(store, 'auto');
    expect(parseDisplay(store.getItem(DISPLAY_KEY))).toEqual({
      version: DISPLAY_VERSION,
      scale: 'auto',
      showFps: DEFAULT_SHOW_FPS,
      maxZoom: 'supported',
    });
  });
});

describe('the frame-rate preference (specs 165, 253)', () => {
  it('is off unless somebody turned it on', () => {
    // Spec 165 defaulted this on, because it shipped behind a checkbox two
    // pages in and the first thing anybody asked was where it was. Spec 253
    // turns it back off: "anybody" there was a developer, and on the page a
    // player opens it is a frame-time graph and a draw-call counter over the
    // world before the first frame is drawn.
    expect(loadShowFps(storage())).toBe(false);
  });

  it('still reads back an explicit yes, so the meter is a click away in either build', () => {
    // The half that makes the default safe to move: what changes is only what
    // an *unwritten* profile means, and the Display page's own row is what
    // either kind of user presses.
    const store = storage();
    saveShowFps(store, true);
    expect(loadShowFps(store)).toBe(true);
  });

  it('reads back what was written', () => {
    const store = storage();
    saveShowFps(store, true);
    expect(loadShowFps(store)).toBe(true);
    saveShowFps(store, false);
    expect(loadShowFps(store)).toBe(false);
  });

  it('does not lose the scale when the readout is toggled, or the reverse', () => {
    // The reason `saveScale` became a read-modify-write. Two preferences in one
    // document, set from two rows of one page: a writer that rebuilt the whole
    // document from its own field alone would silently clear the other.
    const store = storage();
    saveScale(store, 3);
    saveShowFps(store, true);

    expect(loadScale(store)).toBe(3);
    expect(loadShowFps(store)).toBe(true);

    saveScale(store, 2);
    expect(loadShowFps(store)).toBe(true);
  });

  it('reads a version 1 document as having no preference', () => {
    // What every profile written before this spec looks like. It has a scale in
    // it that the player chose, and throwing that away over a missing field
    // would be the migration doing more damage than the upgrade.
    const store = storage();
    store.setItem(DISPLAY_KEY, JSON.stringify({ version: 1, scale: 4 }));

    expect(loadScale(store)).toBe(4);
    // Absent means the default, not "the player turned it off".
    expect(loadShowFps(store)).toBe(DEFAULT_SHOW_FPS);
  });

  it('treats a non-boolean as off rather than as a broken document', () => {
    const store = storage();
    store.setItem(DISPLAY_KEY, JSON.stringify({ version: DISPLAY_VERSION, scale: 2, showFps: 'yes' }));

    expect(loadScale(store)).toBe(2);
    expect(loadShowFps(store)).toBe(false);
  });

  it('survives a storage that refuses to answer', () => {
    const hostile: StorageLike = {
      getItem: () => '{{{',
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(loadShowFps(hostile)).toBe(DEFAULT_SHOW_FPS);
  });
});

describe('what a choice is called', () => {
  it('names auto and the numbers', () => {
    expect(scaleLabel('auto')).toBe('Auto');
    expect(SCALE_CHOICES.filter((c): c is Exclude<ScaleChoice, 'auto'> => c !== 'auto').map(scaleLabel)).toEqual([
      '1x',
      '2x',
      '3x',
      '4x',
    ]);
  });
});

describe('the widest-zoom preference (spec 202)', () => {
  it('reads as "supported" when nothing was ever written', () => {
    expect(loadMaxZoom(storage())).toBe('supported');
  });

  it('round-trips a number, and keeps the other preferences', () => {
    const store = storage();
    saveShowFps(store, false);
    saveMaxZoom(store, 900);
    expect(loadMaxZoom(store)).toBe(900);
    expect(loadShowFps(store)).toBe(false);
  });

  it('reads a document written before the setting existed', () => {
    // The whole reason the version is here rather than a reason to reject: a v2
    // profile has no zoom preference in it, which is the same thing as not
    // having one.
    const store = storage();
    store.setItem(DISPLAY_KEY, JSON.stringify({ version: 2, scale: 2, showFps: false }));
    const read = loadDisplay(store);
    expect(read.maxZoom).toBe('supported');
    expect(read.scale).toBe(2);
    expect(read.showFps).toBe(false);
  });

  it('costs the default rather than the document when the value is nonsense', () => {
    const store = storage();
    for (const bad of [0, -5, Number.NaN, 'wide', null, {}]) {
      store.setItem(DISPLAY_KEY, JSON.stringify({ version: 3, scale: 'auto', showFps: true, maxZoom: bad }));
      expect(loadDisplay(store).maxZoom).toBe('supported');
      // A camera that cannot frame anything would be a worse answer than a
      // default, and losing the scale beside it would be worse still.
      expect(loadDisplay(store).scale).toBe('auto');
    }
  });

  it('resolves the sentinel against whatever the build is sized for', () => {
    // The point of the sentinel: the number lives beside the camera, and this
    // module may not import it. So a cap that moves takes every profile that
    // never overrode it along.
    expect(resolveMaxZoom('supported', 420)).toBe(420);
    expect(resolveMaxZoom('supported', 380)).toBe(380);
    expect(resolveMaxZoom(900, 420)).toBe(900);
  });
});
