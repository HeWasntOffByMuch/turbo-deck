import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_CATEGORIES,
  actionById,
  actionsIn,
  chordKey,
  chordLabel,
  chordsEqual,
  isBindable,
  isPointerCode,
  POINTER_CODES,
  pointerCode,
  skillbarIndex,
  SKILLBAR_SLOTS,
  wheelCode,
} from './actions.js';
import document from './bindings.json';
import { chordOf, InputMap, type Modifiers } from './input-map.js';
import {
  BINDINGS_VERSION,
  captureBindings,
  loadBindings,
  migrateBindings,
  parseBindings,
  saveBindings,
} from './binding-store.js';
import type { StorageLike } from '../core/layout-store.js';

const NONE: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };
const SHIFT: Modifiers = { ...NONE, shift: true };

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

describe('the action registry', () => {
  it('validates against its schema', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../../schemas/ui-bindings.schema.json', import.meta.url), 'utf8'),
    ) as object;
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    validate(document);
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
  });

  it('gives every action a unique id', () => {
    const ids = ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('puts every action in a known category, and every category has actions', () => {
    for (const action of ACTIONS) {
      expect(ACTION_CATEGORIES, action.id).toContain(action.category);
    }
    for (const category of ACTION_CATEGORIES) {
      expect(actionsIn(category).length, category).toBeGreaterThan(0);
    }
  });

  it('ships every action with at least a primary chord', () => {
    // Half-added actions are the failure this catches: an id in the list that no
    // key reaches and nobody notices until a player looks for it.
    for (const action of ACTIONS) {
      expect(action.primary?.code, action.id).toBeTruthy();
    }
  });

  it('has the ten skillbar slots the brief asks for', () => {
    expect(SKILLBAR_SLOTS).toBe(10);
    expect(skillbarIndex('skillbar.1')).toBe(0);
    expect(skillbarIndex('skillbar.10')).toBe(9);
    expect(skillbarIndex('move.north')).toBe(-1);
  });

  it('returns null for an unknown id rather than guessing', () => {
    expect(actionById('nope.nothing')).toBe(null);
  });
});

describe('chords', () => {
  it('treats modifiers as part of the identity', () => {
    expect(chordKey({ code: 'KeyA' })).not.toBe(chordKey({ code: 'KeyA', shift: true }));
    expect(chordsEqual({ code: 'KeyA' }, { code: 'KeyA' })).toBe(true);
    expect(chordsEqual({ code: 'KeyA' }, { code: 'KeyA', ctrl: true })).toBe(false);
    expect(chordsEqual(null, null)).toBe(true);
    expect(chordsEqual(null, { code: 'KeyA' })).toBe(false);
  });

  it('shows a player a name rather than a DOM code', () => {
    expect(chordLabel({ code: 'KeyW' })).toBe('W');
    expect(chordLabel({ code: 'Digit1' })).toBe('1');
    expect(chordLabel({ code: 'ArrowUp' })).toBe('Up');
    expect(chordLabel({ code: 'Escape' })).toBe('Esc');
    expect(chordLabel({ code: 'KeyK', ctrl: true, shift: true })).toBe('Ctrl+Shift+K');
    expect(chordLabel(null)).toBe('Unbound');
  });

  it('refuses to bind a bare modifier or Escape', () => {
    // A modifier alone would fire on every chorded press of anything; Escape is
    // how a player leaves a capture they opened by accident.
    for (const code of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'Escape']) {
      expect(isBindable(code), code).toBe(false);
    }
    expect(isBindable('KeyW')).toBe(true);
  });
});

describe('resolving', () => {
  it('finds the action a chord is bound to, in its own context', () => {
    const map = new InputMap();
    expect(map.resolve('KeyW', NONE, 'gameplay')).toContain('move.north');
    expect(map.resolve('Digit1', NONE, 'gameplay')).toContain('skillbar.1');
  });

  it('does NOT fire a gameplay action from the ui context', () => {
    // The whole reason contexts exist: a rebind row must be able to capture
    // Digit1 without also casting.
    const map = new InputMap();
    expect(map.resolve('Digit1', NONE, 'ui')).toEqual([]);
    expect(map.resolve('KeyW', NONE, 'ui')).toEqual([]);
  });

  it('matches the secondary binding too, so the arrows still walk', () => {
    const map = new InputMap();
    expect(map.resolve('ArrowUp', NONE, 'gameplay')).toContain('move.north');
    expect(map.resolve('ArrowLeft', NONE, 'gameplay')).toContain('move.west');
  });

  it('requires the modifiers to match exactly', () => {
    const map = new InputMap();
    expect(map.resolve('KeyW', SHIFT, 'gameplay')).toEqual([]);
    expect(map.resolve('Tab', SHIFT, 'ui')).toContain('ui.focusPrevious');
    expect(map.resolve('Tab', NONE, 'ui')).toContain('ui.focusNext');
    expect(map.resolve('Tab', NONE, 'ui')).not.toContain('ui.focusPrevious');
  });

  it('answers `fires` in the action’s own context', () => {
    const map = new InputMap();
    expect(map.fires('move.north', 'KeyW', NONE)).toBe(true);
    expect(map.fires('move.north', 'KeyS', NONE)).toBe(false);
    expect(map.fires('nope.nothing', 'KeyW', NONE)).toBe(false);
  });
});

describe('conflicts', () => {
  it('names every other action already using a chord', () => {
    const map = new InputMap();
    expect(map.conflicts({ code: 'KeyW' }, 'gameplay')).toEqual(['move.north']);
    expect(map.conflicts({ code: 'KeyW' }, 'gameplay', 'move.north')).toEqual([]);
    expect(map.conflicts({ code: 'F12' }, 'gameplay')).toEqual([]);
  });

  it('reports rather than refuses -- both bindings stay live', () => {
    // Refusing would make swapping two keys impossible: every intermediate state
    // is a conflict.
    const map = new InputMap();
    map.bind('move.south', 'primary', { code: 'KeyW' });
    expect([...map.resolve('KeyW', NONE, 'gameplay')].sort()).toEqual(['move.north', 'move.south']);
  });

  it('does not see across contexts', () => {
    const map = new InputMap();
    // Escape is combat.cancel in gameplay and ui.closeTopmost in ui, deliberately.
    expect(map.conflicts({ code: 'Escape' }, 'gameplay')).toEqual(['combat.cancel']);
    expect(map.conflicts({ code: 'Escape' }, 'ui')).toEqual(['ui.closeTopmost']);
  });
});

describe('rebinding', () => {
  it('binds, and the old chord stops firing', () => {
    const map = new InputMap();
    map.bind('move.north', 'primary', { code: 'KeyT' });
    expect(map.resolve('KeyT', NONE, 'gameplay')).toContain('move.north');
    expect(map.resolve('KeyW', NONE, 'gameplay')).not.toContain('move.north');
  });

  it('unbinds to nothing, and says the action is unbound', () => {
    const map = new InputMap();
    map.bind('combat.stop', 'primary', null);
    expect(map.isUnbound('combat.stop')).toBe(true);
    expect(map.resolve('KeyX', NONE, 'gameplay')).toEqual([]);
  });

  it('an action with only a secondary is not unbound', () => {
    const map = new InputMap();
    map.bind('move.north', 'primary', null);
    expect(map.isUnbound('move.north')).toBe(false);
    expect(map.resolve('ArrowUp', NONE, 'gameplay')).toContain('move.north');
  });

  it('resets one action, and all of them', () => {
    const map = new InputMap();
    map.bind('move.north', 'primary', { code: 'KeyT' });
    map.bind('move.south', 'primary', { code: 'KeyG' });
    expect(map.isModified('move.north')).toBe(true);

    map.reset('move.north');
    expect(map.isModified('move.north')).toBe(false);
    expect(map.isModified('move.south')).toBe(true);

    map.reset();
    expect(map.isModified('move.south')).toBe(false);
    expect(map.toOverrides()).toEqual([]);
  });

  it('ignores a bind for an action that does not exist', () => {
    const map = new InputMap();
    expect(() => {
      map.bind('nope.nothing', 'primary', { code: 'KeyZ' });
      map.reset('nope.nothing');
    }).not.toThrow();
  });
});

describe('persistence', () => {
  it('stores only what differs from the defaults', () => {
    // The load-bearing decision: a full dump means a profile saved before an
    // action existed never receives its default.
    const map = new InputMap();
    expect(captureBindings(map).overrides).toEqual([]);

    map.bind('move.north', 'primary', { code: 'KeyT' });
    const stored = captureBindings(map);
    expect(stored.overrides).toHaveLength(1);
    expect(stored.overrides[0]?.actionId).toBe('move.north');
  });

  it('round trips through storage', () => {
    const store = storage();
    const saved = new InputMap();
    saved.bind('skillbar.1', 'primary', { code: 'KeyQ' });
    saved.bind('combat.stop', 'primary', null);
    saveBindings(store, saved);

    const loaded = new InputMap();
    expect(loadBindings(store, loaded)).toBe(true);
    expect(loaded.resolve('KeyQ', NONE, 'gameplay')).toContain('skillbar.1');
    expect(loaded.isUnbound('combat.stop')).toBe(true);
    expect(loaded.isModified('move.north')).toBe(false);
  });

  it('a profile that predates an action still gets that action’s default', () => {
    const store = storage();
    store.setItem(
      'turbo-deck.ui.bindings',
      JSON.stringify({ version: 1, overrides: [{ actionId: 'move.north', primary: { code: 'KeyT' }, secondary: null }] }),
    );
    const map = new InputMap();
    loadBindings(store, map);
    // Nothing was said about skillbar.5, so it keeps what it ships with.
    expect(map.resolve('Digit5', NONE, 'gameplay')).toContain('skillbar.5');
  });

  it('ignores an override for an action that no longer exists', () => {
    const map = new InputMap();
    expect(() => {
      map.applyOverrides([{ actionId: 'ghost.gone', primary: { code: 'KeyZ' }, secondary: null }]);
    }).not.toThrow();
    expect(map.resolve('KeyZ', NONE, 'gameplay')).toEqual([]);
    expect(map.resolve('KeyW', NONE, 'gameplay')).toContain('move.north');
  });

  it('returns null for junk rather than throwing', () => {
    for (const junk of ['', 'not json', '{', '[]', 'null', '{"version":0}']) {
      expect(parseBindings(junk), junk).toBe(null);
    }
    expect(parseBindings(null)).toBe(null);
    expect(migrateBindings({ version: BINDINGS_VERSION })).toBe(null);
    expect(migrateBindings({ version: BINDINGS_VERSION + 1, overrides: [] })).toBe(null);
  });

  it('drops malformed overrides and keeps the good ones', () => {
    const parsed = migrateBindings({
      version: BINDINGS_VERSION,
      overrides: [
        { actionId: 'move.north', primary: { code: 'KeyT' }, secondary: null },
        { actionId: '', primary: { code: 'KeyT' } },
        { primary: { code: 'KeyT' } },
        null,
      ],
    });
    expect(parsed?.overrides.map((entry) => entry.actionId)).toEqual(['move.north']);
  });

  it('drops a chord with no code rather than storing a broken one', () => {
    const parsed = migrateBindings({
      version: BINDINGS_VERSION,
      overrides: [{ actionId: 'move.north', primary: { code: '' }, secondary: { nope: 1 } }],
    });
    expect(parsed?.overrides[0]?.primary).toBe(null);
    expect(parsed?.overrides[0]?.secondary).toBe(null);
  });

  it('says false when there is nothing stored', () => {
    expect(loadBindings(storage(), new InputMap())).toBe(false);
  });
});

describe('chordOf', () => {
  it('omits the modifiers that are not held, so keys compare equal', () => {
    expect(chordOf('KeyW', NONE)).toEqual({ code: 'KeyW' });
    expect(chordOf('KeyW', SHIFT)).toEqual({ code: 'KeyW', shift: true });
  });
});

/**
 * The mouse in the binding format (spec 189).
 *
 * What these are really asserting is a *negative*: that putting a pointer control
 * in `code` cost the rest of the system nothing. So they check the pieces that
 * were free -- the identity, the index, the round trip, the release path -- as
 * hard as the pieces that were written.
 */
describe('pointer chords', () => {
  it('names every pointer control exactly once, with a label', () => {
    for (const [code, label] of Object.entries(POINTER_CODES)) {
      expect(label.length, code).toBeGreaterThan(0);
      expect(isPointerCode(code), code).toBe(true);
    }
    expect(new Set(Object.values(POINTER_CODES)).size).toBe(Object.keys(POINTER_CODES).length);
    expect(isPointerCode('KeyW')).toBe(false);
    // Not a prototype lookup: an inherited property is not a binding.
    expect(isPointerCode('toString')).toBe(false);
  });

  it('maps the five named buttons and nothing past them', () => {
    expect(pointerCode(0)).toBe('MouseLeft');
    expect(pointerCode(1)).toBe('MouseMiddle');
    expect(pointerCode(2)).toBe('MouseRight');
    expect(pointerCode(3)).toBe('Mouse4');
    expect(pointerCode(4)).toBe('Mouse5');
    // A sixth button gets no invented code: one with no row has no label and no
    // schema entry, and a binding nobody can read back is worse than one that
    // cannot be made.
    expect(pointerCode(5)).toBe(null);
    expect(pointerCode(-1)).toBe(null);
    for (const button of [0, 1, 2, 3, 4]) {
      expect(isPointerCode(pointerCode(button) ?? ''), String(button)).toBe(true);
    }
  });

  it('turns a wheel notch into a code, and a still wheel into nothing', () => {
    expect(wheelCode(1)).toBe('WheelUp');
    expect(wheelCode(-1)).toBe('WheelDown');
    expect(wheelCode(0)).toBe(null);
  });

  it('costs the chord identity nothing', () => {
    // `chordKey` is the identity function for the whole system and it never
    // opened `code`. If that is still true, a pointer chord behaves like any
    // other one here without a line being written for it.
    expect(chordKey({ code: 'MouseRight' })).not.toBe(chordKey({ code: 'MouseRight', shift: true }));
    expect(chordsEqual({ code: 'MouseRight' }, { code: 'MouseRight' })).toBe(true);
    expect(chordsEqual({ code: 'MouseRight' }, { code: 'MouseLeft' })).toBe(false);
    expect(isBindable('MouseLeft')).toBe(true);
    expect(isBindable('WheelUp')).toBe(true);
  });

  it('labels a button as a player reads it, and never as a key already reads', () => {
    expect(chordLabel({ code: 'MouseRight' })).toBe('RMB');
    expect(chordLabel({ code: 'MouseRight', shift: true })).toBe('Shift+RMB');
    expect(chordLabel({ code: 'WheelUp' })).toBe('Wheel Up');
    // `keyLabel('ArrowRight')` is already `Right`, so a pointer label of `Right`
    // would put two rows in the same window reading identically.
    const keyLabels = new Set(
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Space', 'Enter', 'Tab'].map(
        (code) => chordLabel({ code }),
      ),
    );
    for (const label of Object.values(POINTER_CODES)) {
      expect(keyLabels.has(label), label).toBe(false);
    }
  });

  it('ships the pointer verbs bound, and resolves them exactly in modifiers', () => {
    const map = new InputMap();
    expect(map.resolve('MouseLeft', NONE, 'gameplay')).toEqual(['world.confirmAim']);
    expect(map.resolve('MouseRight', NONE, 'gameplay')).toEqual(['world.order']);
    // The trade is the same button with shift, and the exactness is what keeps
    // the two apart -- the same rule that keeps `Shift+KeyA` off bare `KeyA`.
    expect(map.resolve('MouseRight', SHIFT, 'gameplay')).toEqual(['world.trade']);
    expect(map.resolve('WheelUp', NONE, 'gameplay')).toEqual(['camera.zoomIn']);
    expect(map.resolve('WheelDown', NONE, 'gameplay')).toEqual(['camera.zoomOut']);
  });

  it('releases a held action on a button, whatever modifiers are down', () => {
    // The release path matches on the code alone, and a held button is stranded
    // by exactly the sequence a held key is: press, then press shift, then let go.
    const map = new InputMap();
    map.bind('move.north', 'primary', { code: 'MouseMiddle' });
    expect(map.resolve('MouseMiddle', NONE, 'gameplay')).toEqual(['move.north']);
    expect(map.resolve('MouseMiddle', SHIFT, 'gameplay')).toEqual([]);
    expect(map.actionsForCode('MouseMiddle', 'gameplay')).toEqual(['move.north']);
  });

  it('round-trips through a stored profile without moving the version', () => {
    const map = new InputMap();
    map.bind('world.order', 'primary', { code: 'Mouse4' });
    map.bind('camera.zoomIn', 'secondary', { code: 'Mouse5', ctrl: true });
    const store = storage();
    saveBindings(store, map);

    const stored = JSON.parse(store.map.get('turbo-deck.ui.bindings') ?? '{}') as {
      version: number;
      overrides: { actionId: string; primary: unknown }[];
    };
    expect(stored.version).toBe(BINDINGS_VERSION);
    expect(stored.overrides.find((o) => o.actionId === 'world.order')?.primary).toEqual({
      code: 'Mouse4',
    });

    const restored = new InputMap();
    expect(loadBindings(store, restored)).toBe(true);
    expect(restored.bindingsFor('world.order').primary).toEqual({ code: 'Mouse4' });
    expect(restored.bindingsFor('camera.zoomIn').secondary).toEqual({
      code: 'Mouse5',
      ctrl: true,
    });
  });

  it('is loadable by a build that has never heard of the actions', () => {
    // The reason the version does not move. A profile written here and read by a
    // build from before spec 189 loses the rows it cannot name and keeps every
    // other binding -- where a bump to 2 would make `migrateBindings` throw the
    // whole document away, so trying this build and going back would cost a
    // player every keyboard rebind they had ever made.
    const older = new InputMap(ACTIONS.filter((action) => !action.id.startsWith('world.')));
    older.applyOverrides([
      { actionId: 'world.order', primary: { code: 'Mouse4' }, secondary: null },
      { actionId: 'move.north', primary: { code: 'KeyT' }, secondary: null },
    ]);
    expect(older.bindingsFor('world.order')).toEqual({ primary: null, secondary: null });
    expect(older.bindingsFor('move.north').primary).toEqual({ code: 'KeyT' });

    expect(migrateBindings({ version: 1, overrides: [{ actionId: 'world.order', primary: { code: 'MouseRight' } }] })).toEqual({
      version: 1,
      overrides: [{ actionId: 'world.order', primary: { code: 'MouseRight' }, secondary: null }],
    });
  });
});
