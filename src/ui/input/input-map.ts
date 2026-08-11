/**
 * Physical keys in, action ids out (spec 123).
 *
 * The one place in the game allowed to think about a key. Everything downstream
 * asks "did `combat.cancel` fire", which is a question a player can rebind the
 * answer to.
 *
 * Two rules that are decisions rather than mechanics.
 *
 * **Conflicts are reported, never refused.** `bind` always succeeds. The window
 * asks "already bound to X -- replace?" first and then calls it, because a map
 * that silently declines an edit is a map the player fights, and because the
 * *right* resolution depends on what they meant, which only they know.
 *
 * **A saved profile stores only what differs.** Storing every binding means a
 * player who saved a profile before an action existed never receives its default,
 * and a rebalance of the shipped keys reaches nobody who has ever opened the
 * screen. See `toOverrides`.
 *
 * Pure. No DOM, no clock.
 */

import {
  ACTIONS,
  actionById,
  chordKey,
  chordsEqual,
  type ActionDefinition,
  type BindingContext,
  type Chord,
} from './actions.js';

export interface Modifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export type BindingSlot = 'primary' | 'secondary';

export interface Binding {
  readonly primary: Chord | null;
  readonly secondary: Chord | null;
}

/** One action's departure from the shipped defaults. */
export interface BindingOverride {
  readonly actionId: string;
  readonly primary: Chord | null;
  readonly secondary: Chord | null;
}

function defaultBinding(action: ActionDefinition): Binding {
  return { primary: action.primary, secondary: action.secondary ?? null };
}

/** A chord built from an event's code and modifiers, with the falses dropped. */
export function chordOf(code: string, mods: Modifiers): Chord {
  return {
    code,
    ...(mods.shift ? { shift: true } : {}),
    ...(mods.ctrl ? { ctrl: true } : {}),
    ...(mods.alt ? { alt: true } : {}),
    ...(mods.meta ? { meta: true } : {}),
  };
}

export class InputMap {
  private readonly bindings = new Map<string, Binding>();
  /** `context|chordKey` -> action ids. Rebuilt whenever a binding changes. */
  private index = new Map<string, string[]>();

  constructor(private readonly actions: readonly ActionDefinition[] = ACTIONS) {
    this.reset();
  }

  /** Every action, in registry order. */
  get definitions(): readonly ActionDefinition[] {
    return this.actions;
  }

  bindingsFor(actionId: string): Binding {
    return this.bindings.get(actionId) ?? { primary: null, secondary: null };
  }

  /**
   * Which actions this chord fires, in this context.
   *
   * Returns an array because two actions may legitimately share a chord -- the
   * map does not forbid it, the window merely warns about it -- and a caller that
   * assumed one would silently drop the other.
   */
  resolve(code: string, mods: Modifiers, context: BindingContext): readonly string[] {
    return this.index.get(`${context}|${chordKey(chordOf(code, mods))}`) ?? [];
  }

  /**
   * Every action with a chord on this key, *whatever* modifiers are held.
   *
   * What a key **release** has to use. Matching modifiers on release is the
   * obvious thing and it strands keys: press W, then press Shift, then release W,
   * and an exact match finds nothing -- so `move.north` stays held forever and the
   * player walks into a wall until they press and release W again.
   */
  actionsForCode(code: string, context: BindingContext): readonly string[] {
    const out: string[] = [];
    for (const action of this.actions) {
      if (action.context !== context) continue;
      const binding = this.bindings.get(action.id);
      if (!binding) continue;
      if (binding.primary?.code === code || binding.secondary?.code === code) out.push(action.id);
    }
    return out;
  }

  /** Whether this chord fires `actionId` in its own context. */
  fires(actionId: string, code: string, mods: Modifiers): boolean {
    const action = actionById(actionId);
    if (!action) return false;
    return this.resolve(code, mods, action.context).includes(actionId);
  }

  /** Other actions already using this chord in this context. */
  conflicts(chord: Chord, context: BindingContext, exceptAction?: string): readonly string[] {
    const found = this.index.get(`${context}|${chordKey(chord)}`) ?? [];
    return found.filter((id) => id !== exceptAction);
  }

  /** Set or clear one slot. Always succeeds -- see the note at the top. */
  bind(actionId: string, slot: BindingSlot, chord: Chord | null): void {
    const current = this.bindings.get(actionId);
    if (!current) return;
    this.bindings.set(actionId, { ...current, [slot]: chord });
    this.reindex();
  }

  /** Restore one action's defaults, or every action's. */
  reset(actionId?: string): void {
    if (actionId === undefined) {
      this.bindings.clear();
      for (const action of this.actions) this.bindings.set(action.id, defaultBinding(action));
    } else {
      const action = this.actions.find((candidate) => candidate.id === actionId);
      if (!action) return;
      this.bindings.set(actionId, defaultBinding(action));
    }
    this.reindex();
  }

  /** Whether an action has any chord at all. The window flags the ones that do not. */
  isUnbound(actionId: string): boolean {
    const binding = this.bindingsFor(actionId);
    return binding.primary === null && binding.secondary === null;
  }

  /** Whether this action differs from what it ships with. */
  isModified(actionId: string): boolean {
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action) return false;
    const current = this.bindingsFor(actionId);
    const shipped = defaultBinding(action);
    return (
      !chordsEqual(current.primary, shipped.primary) || !chordsEqual(current.secondary, shipped.secondary)
    );
  }

  /**
   * Only the actions that differ from their defaults.
   *
   * This is the whole persistence format, and the reason it is a diff rather than
   * a dump is above.
   */
  toOverrides(): readonly BindingOverride[] {
    const out: BindingOverride[] = [];
    for (const action of this.actions) {
      if (!this.isModified(action.id)) continue;
      const current = this.bindingsFor(action.id);
      out.push({ actionId: action.id, primary: current.primary, secondary: current.secondary });
    }
    return out;
  }

  /**
   * Apply stored overrides on top of the defaults.
   *
   * An override naming an action that no longer exists is ignored rather than
   * being an error: a profile outliving an action is normal, and refusing to load
   * it would throw away every *other* binding in the same document.
   */
  applyOverrides(overrides: readonly BindingOverride[]): void {
    this.reset();
    for (const override of overrides) {
      if (!this.bindings.has(override.actionId)) continue;
      this.bindings.set(override.actionId, {
        primary: override.primary,
        secondary: override.secondary,
      });
    }
    this.reindex();
  }

  private reindex(): void {
    const next = new Map<string, string[]>();
    for (const action of this.actions) {
      const binding = this.bindings.get(action.id);
      if (!binding) continue;
      for (const chord of [binding.primary, binding.secondary]) {
        if (!chord) continue;
        const key = `${action.context}|${chordKey(chord)}`;
        const list = next.get(key);
        if (list) list.push(action.id);
        else next.set(key, [action.id]);
      }
    }
    this.index = next;
  }
}
