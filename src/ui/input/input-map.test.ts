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
  skillbarIndex,
  SKILLBAR_SLOTS,
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
