/**
 * The bars and the skillbar (spec 128).
 *
 * The first screen that is updated every frame rather than every click, and the
 * whole discipline is one line: `setView` writes fields and invalidates nothing
 * unless something *structural* changed. Health going down, a cooldown running
 * and a cast bar filling are all paint-time facts, so a fight costs zero layout
 * passes -- which is the entire justification for retained mode over immediate
 * (`docs/ui/00-architecture.md` §12).
 *
 * The HUD is also the one screen that must not eat the pointer. It is always on
 * top and the world is underneath it, so everything here is
 * `pointerTransparent` except the slots, which are buttons.
 *
 * Pure. No DOM, no clock: the view arrives from the caller.
 */

import { Column, Row } from '../core/containers.js';
import { uniformInsets } from '../core/geom.js';
import type { Theme } from '../theme/theme.js';
import { Label } from '../widgets/label.js';
import { Meter } from '../widgets/meter.js';
import { SkillSlot, type AbilityView } from '../widgets/skill-slot.js';

export type { AbilityView } from '../widgets/skill-slot.js';

export interface HudView {
  readonly health: { readonly current: number; readonly max: number };
  readonly resource: { readonly current: number; readonly max: number };
  /** What is winding up, and how far through. Null when nothing is. */
  readonly cast: { readonly name: string; readonly progress: number } | null;
  /** One entry per slot; null for a slot with nothing bound to it. */
  readonly slots: readonly (AbilityView | null)[];
  /** What each slot's key is called, from the InputMap. */
  readonly keyLabels: readonly string[];
}

export interface HudOptions {
  readonly theme: Theme;
  readonly slotCount?: number;
}

const DEFAULT_SLOTS = 8;

export class HudScreen extends Column {
  readonly health = new Meter('hud:health');
  readonly resource = new Meter('hud:resource');
  readonly cast = new Meter('hud:cast');
  private readonly castLabel = new Label('', 'body');
  private readonly castRow: Column;
  private readonly slotWidgets: SkillSlot[] = [];
  private castShown = false;
  onUse: ((index: number) => void) | null = null;

  constructor(options: HudOptions) {
    super('hud');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.padding = uniformInsets(theme.spacing.xs);
    this.pointerTransparent = true;

    this.health.fillToken = 'danger';
    this.resource.fillToken = 'focus';
    this.cast.fillToken = 'accent';
    // No caption on the cast bar -- the ability's name is the line above it --
    // so it can be thin.
    this.cast.thickness = 4;

    const bars = new Column('hud:bars');
    bars.gap = theme.spacing.xs;
    bars.pointerTransparent = true;
    bars.addAll([this.health, this.resource]);

    const castRow = new Column('hud:cast');
    castRow.gap = 0;
    castRow.pointerTransparent = true;
    this.castLabel.colorToken = 'textDim';
    castRow.addAll([this.castLabel, this.cast]);
    // Hidden rather than absent: a cast bar that appears and disappears would
    // move the skillbar under it on every swing, which is the one thing a
    // skillbar must never do.
    castRow.visible = false;

    const bar = new Row('hud:slots');
    bar.gap = theme.spacing.xs;
    bar.pointerTransparent = true;
    for (let i = 0; i < (options.slotCount ?? DEFAULT_SLOTS); i++) {
      const slot = new SkillSlot(i, `slot:${i}`);
      slot.onActivate = (index) => this.onUse?.(index);
      this.slotWidgets.push(slot);
      bar.add(slot);
    }

    this.castRow = castRow;
    this.addAll([bars, castRow, bar]);
  }

  get slots(): readonly SkillSlot[] {
    return this.slotWidgets;
  }

  /**
   * Called once per frame.
   *
   * Everything here is a field write. The one thing that can invalidate is a
   * slot's *ability identity* changing, and `SkillSlot.setAbility` decides that
   * for itself -- so a screen full of running cooldowns is free and a weapon
   * swap costs one pass.
   */
  setView(view: HudView): void {
    this.health.setValue(view.health.current, view.health.max);
    this.health.caption = `${Math.round(view.health.current)}/${Math.round(view.health.max)}`;
    this.resource.setValue(view.resource.current, view.resource.max);
    this.resource.caption = `${Math.round(view.resource.current)}/${Math.round(view.resource.max)}`;

    const casting = view.cast !== null;
    if (casting !== this.castShown) {
      // Visibility *is* layout -- a hidden widget measures to nothing -- so this
      // is the one field here that has to invalidate, and it changes twice per
      // cast rather than sixty times a second.
      this.castShown = casting;
      this.castRow.visible = casting;
      this.invalidateMeasure();
    }
    if (view.cast) {
      this.cast.fraction = view.cast.progress;
      this.castLabel.setText(view.cast.name);
    }

    for (const [index, slot] of this.slotWidgets.entries()) {
      slot.setAbility(view.slots[index] ?? null);
      const label = view.keyLabels[index] ?? '';
      if (slot.keyLabel !== label) {
        slot.keyLabel = label;
        // A key label is drawn, not measured against anything -- but it *is*
        // structural in the sense that it never changes during a fight, so
        // paying a pass for a rebind is honest.
        slot.invalidateArrange();
      }
    }
  }
}
