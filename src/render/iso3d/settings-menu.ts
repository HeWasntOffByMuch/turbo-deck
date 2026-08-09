import type { MenuGroup, MenuHandle } from './menu-group.js';

/**
 * A settings button and the popover it opens (spec 107).
 *
 * The cog and its panel were built once in `view-controls.ts` and copied once
 * into `weather-controls.ts`, whose own comment said the third panel was the
 * moment to lift the shape out. Spec 107 adds four, so here it is: the styling,
 * the button, the section heading and the Reset, in one place.
 *
 * The *sliders* deliberately stay where they are. `view-controls.ts` builds
 * widgets a caller polls each frame and `weather-controls.ts` builds ones that
 * push into the wind uniforms on change; that difference is real, and threading
 * a callback through sixty rows to serve three would be the wrong trade.
 */

/** Anything the panel's Reset can put back — every widget handle here has this. */
export interface Resettable {
  reset(): void;
}

export interface SettingsMenu {
  /** The button and its popover; mount this in the corner's button row. */
  readonly element: HTMLElement;
  /** The popover itself. Append rows to it. */
  readonly panel: HTMLElement;
  /** This menu's end of the group, for a caller that wants to open or close it. */
  readonly handle: MenuHandle;
}

export interface SettingsMenuOptions {
  /** The button's face. A plain symbol, never an emoji — see below. */
  readonly glyph: string;
  /** The button's tooltip and its accessible name. */
  readonly label: string;
  /** The group that keeps one popover open at a time. */
  readonly group: MenuGroup;
  /** Glyph size in px; they are not all the same weight at the same size. */
  readonly fontSize?: number;
}

/** A section heading inside a popover. */
export function section(text: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'font-weight:600;color:#e8e8f2;letter-spacing:.04em;text-transform:uppercase;font-size:11px;';
  return el;
}

/**
 * A popover's Reset, restoring the widgets in *that* popover.
 *
 * Per panel rather than one for all six (spec 107): a button that silently put
 * back five popovers you were not looking at would be worse than the single
 * panel this replaced.
 */
export function resetButton(tip: string, widgets: readonly Resettable[]): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Reset';
  button.title = tip;
  button.style.cssText =
    "font-family:inherit;font-size:12px;margin-top:2px;padding:6px 10px;border-radius:6px;cursor:pointer;" +
    'border:1px solid #2a2a3a;background:#252533;color:#e8e8f2;';
  button.addEventListener('click', () => {
    for (const widget of widgets) widget.reset();
  });
  return button;
}

/**
 * Build a button plus the popover it toggles, joined to `group`.
 *
 * The glyph must be a plain symbol rather than an emoji, for the reason spec 075
 * gives: a headless Chromium has no colour emoji font and draws a tofu box, and
 * so does any player whose system stack is equally sparse. U+2699, U+2600,
 * U+2726, U+25A6, U+2756 and U+224B are all in the ordinary UI faces.
 */
export function createSettingsMenu(opts: SettingsMenuOptions): SettingsMenu {
  const panel = document.createElement('div');
  panel.style.cssText =
    "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;font-size:12px;" +
    'display:none;flex-direction:column;gap:10px;width:210px;padding:14px;box-sizing:border-box;' +
    // Anchored to its button's right edge so it opens *inward*: the buttons sit
    // in the game window's top-right corner, and a left-anchored panel would
    // open off the viewport. Capped in height (and scrollable) so a short window
    // can't push its lower rows off the bottom either.
    'position:absolute;top:38px;right:0;z-index:10;max-height:calc(100vh - 90px);overflow-y:auto;' +
    'background:#1c1c26;border:1px solid #2a2a3a;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = opts.glyph;
  button.title = opts.label;
  button.setAttribute('aria-label', opts.label);

  const style = (open: boolean): void => {
    button.style.cssText =
      `font-size:${opts.fontSize ?? 18}px;line-height:1;width:32px;height:32px;border-radius:8px;cursor:pointer;` +
      'border:1px solid #2a2a3a;color:#e8e8f2;' +
      (open ? 'background:#2a2a3a;' : 'background:#1c1c26;');
    button.setAttribute('aria-expanded', String(open));
  };
  style(false);

  // The group owns which one is open; this only draws whatever it is told.
  const handle = opts.group.add((open) => {
    panel.style.display = open ? 'flex' : 'none';
    style(open);
  });
  button.addEventListener('click', () => handle.toggle());

  const element = document.createElement('div');
  element.style.cssText = 'position:relative;';
  element.append(button, panel);

  return { element, panel, handle };
}
