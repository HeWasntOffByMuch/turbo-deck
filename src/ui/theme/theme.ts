/**
 * The theme, resolved once so that no widget ever sees a string (spec 123).
 *
 * `theme.json` is authored with palette *names* -- `"fill": "panelRaised"` --
 * because a document full of hex is a document nobody can retune. Everything
 * here turns those names into {@link Color}s at load, so a widget asks for
 * `style.fill` and gets four bytes. A widget that wanted to look a colour up by
 * name would be a widget that could get the name wrong at runtime; this way the
 * only place a name can be wrong is here, once, at startup.
 *
 * Structure is checked against `schemas/ui-theme.schema.json` with ajv in the
 * test beside this file, the same way the unit documents are. What a JSON Schema
 * cannot say is checked by hand below: that every palette reference resolves,
 * and that every spacing step is a whole multiple of the grid unit -- the second
 * being the rule the brief cares most about and the one a schema can only
 * express as "an integer".
 *
 * Pure. No DOM, no clock, no ajv at runtime.
 */

import { parseColor, type Color } from '../core/color.js';
import type { Size } from '../core/geom.js';
import document from './theme.json';

export type WidgetState = 'normal' | 'hover' | 'pressed' | 'disabled' | 'focused';

export const WIDGET_STATES: readonly WidgetState[] = [
  'normal',
  'hover',
  'pressed',
  'disabled',
  'focused',
];

/** Which of the two faces a run of text is set in. */
export type FontId = 'body' | 'numeric';

export interface StateStyle {
  readonly fill: Color;
  readonly frameTint: Color;
  readonly text: Color;
  /** A checkbox's tick, a slider's knob, a caret, a scrollbar's thumb. */
  readonly mark: Color;
}

export interface WidgetStyle {
  /** The 9-slice patch this widget's chrome is drawn from. */
  readonly frame: string;
  readonly padding: number;
  /** Widget-specific numbers: `minHeight`, `boxSize`, `barThickness` and so on. */
  readonly metrics: Readonly<Record<string, number>>;
  state(state: WidgetState): StateStyle;
  /** A widget-specific metric, or `fallback` when the theme does not set one. */
  metric(name: string, fallback: number): number;
}

export interface Spacing {
  readonly unit: number;
  readonly xs: number;
  readonly sm: number;
  readonly md: number;
  readonly lg: number;
  readonly xl: number;
}

export interface InputTokens {
  /** Movement past this many UI pixels turns a press into a drag (and not a click). */
  readonly dragThreshold: number;
  readonly doubleClickMs: number;
  /** The largest tap target the theme will draw, in UI pixels. Bounds the auto scale. */
  readonly maxTapUiPx: number;
  /** The smallest viewport every screen is designed to fit inside. */
  readonly minViewport: Size;
  /**
   * The viewport the auto scale aims for when the window can afford it.
   *
   * Twice the floor. A floor says what every screen must survive; this says what
   * to draw at, and maximising the scale against the floor instead is what put
   * two windows across a whole 1280x800 tab (spec 131).
   */
  readonly comfortViewport: Size;
  /** How long the pointer must rest before a tooltip appears. */
  readonly tooltipDelayMs: number;
  /** How much of a window's title bar must stay on screen. */
  readonly minVisible: number;
}

export interface Theme {
  readonly version: number;
  readonly palette: Readonly<Record<string, Color>>;
  readonly spacing: Spacing;
  readonly fonts: Readonly<Record<'body' | 'numeric', FontId>>;
  readonly input: InputTokens;
  /** Throws for an unknown name -- a widget naming a style that is not there is a bug. */
  widget(name: string): WidgetStyle;
  color(name: string): Color;
  /** Every patch name the theme references, for checking against a baked atlas. */
  framesUsed(): readonly string[];
}

/** The shape of the parsed document, after the schema has had its say. */
interface RawStateStyle {
  readonly fill: string;
  readonly frameTint: string;
  readonly text: string;
  readonly mark?: string;
}

interface RawWidgetStyle {
  readonly frame: string;
  readonly padding: number;
  readonly states: Readonly<Record<WidgetState, RawStateStyle>>;
  readonly [metric: string]: unknown;
}

interface RawTheme {
  readonly version: number;
  readonly palette: Readonly<Record<string, string>>;
  readonly spacing: Spacing;
  readonly fonts: { readonly body: FontId; readonly numeric: FontId };
  readonly input: InputTokens;
  readonly widgets: Readonly<Record<string, RawWidgetStyle>>;
}

const NON_METRIC_KEYS = new Set(['frame', 'padding', 'states']);

/**
 * Resolve a parsed theme document.
 *
 * Exported separately from {@link THEME} so a test can feed it a deliberately
 * broken document and assert on the message, which is the only way to know the
 * checks below actually fire.
 */
export function resolveTheme(raw: RawTheme): Theme {
  const palette: Record<string, Color> = {};
  for (const [name, hex] of Object.entries(raw.palette)) {
    palette[name] = parseColor(hex);
  }

  const color = (name: string, where: string): Color => {
    const found = palette[name];
    if (!found) throw new Error(`theme: ${where} names a colour that is not in the palette: ${name}`);
    return found;
  };

  // A schema can say "integer"; it cannot say "on the 4px grid", which is the
  // rule the whole visual direction rests on.
  const unit = raw.spacing.unit;
  for (const key of ['xs', 'sm', 'md', 'lg', 'xl'] as const) {
    const value = raw.spacing[key];
    if (value % unit !== 0) {
      throw new Error(`theme: spacing.${key} is ${value}, which is not a multiple of the ${unit}px grid`);
    }
  }

  const widgets: Record<string, WidgetStyle> = {};
  for (const [name, rawStyle] of Object.entries(raw.widgets)) {
    if (rawStyle.padding % unit !== 0) {
      throw new Error(
        `theme: widgets.${name}.padding is ${rawStyle.padding}, which is not a multiple of the ${unit}px grid`,
      );
    }

    const metrics: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawStyle)) {
      if (NON_METRIC_KEYS.has(key)) continue;
      if (typeof value === 'number') metrics[key] = value;
    }

    const states: Record<string, StateStyle> = {};
    for (const state of WIDGET_STATES) {
      const rawState = rawStyle.states[state];
      const where = `widgets.${name}.states.${state}`;
      states[state] = {
        fill: color(rawState.fill, `${where}.fill`),
        frameTint: color(rawState.frameTint, `${where}.frameTint`),
        text: color(rawState.text, `${where}.text`),
        // `mark` is optional: most widgets have no furniture of their own, and
        // defaulting it to the text colour is better than making every entry
        // repeat itself.
        mark: rawState.mark === undefined ? color(rawState.text, `${where}.text`) : color(rawState.mark, `${where}.mark`),
      };
    }

    widgets[name] = {
      frame: rawStyle.frame,
      padding: rawStyle.padding,
      metrics,
      state: (state) => {
        const found = states[state];
        if (!found) throw new Error(`theme: widgets.${name} has no ${state} state`);
        return found;
      },
      metric: (metricName, fallback) => metrics[metricName] ?? fallback,
    };
  }

  return {
    version: raw.version,
    palette,
    spacing: raw.spacing,
    fonts: raw.fonts,
    input: raw.input,
    widget: (name) => {
      const found = widgets[name];
      if (!found) throw new Error(`theme: no widget style named ${name}`);
      return found;
    },
    color: (name) => color(name, 'caller'),
    framesUsed: () => [...new Set(Object.values(raw.widgets).map((style) => style.frame))].sort(),
  };
}

/** The committed theme. One instance; nothing mutates it. */
export const THEME: Theme = resolveTheme(document as unknown as RawTheme);
