/**
 * `?wire=` (spec 147): the conditions, written down.
 *
 * Separate from `unreliable.ts` because that file is the wire and this is a
 * string format, and separate from the Play tab because a preview script wants
 * to set a connection up without a browser. Pure, total, and forgiving by
 * design: an unparseable field is ignored rather than fatal, because a
 * mistyped debug parameter must cost a default and never a black screen.
 *
 *   ?wire=delay:6,jitter:3,loss:0.02,dup:0.01
 */

import { PERFECT_WIRE, type WireConditions } from './unreliable.js';

/** Sliders and query alike stop here; past it nothing arrives and nothing is learned. */
export const MAX_DELAY_TICKS = 60;
export const MAX_JITTER_TICKS = 30;

function number(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Read the conditions out of a `?wire=` value.
 *
 * An empty or absent value is a perfect wire, which is what every tab that has
 * not asked for anything gets. Unknown keys are skipped: this is a debug knob
 * and a typo in one field must not throw the other three away.
 */
export function parseWire(raw: string | null | undefined): WireConditions {
  if (raw === null || raw === undefined || raw === '') return PERFECT_WIRE;

  let delayTicks = 0;
  let jitterTicks = 0;
  let loss = 0;
  let duplicate = 0;

  for (const field of raw.split(',')) {
    const [key, rest] = field.split(':');
    const value = number(rest);
    if (key === undefined || value === null) continue;
    switch (key.trim().toLowerCase()) {
      case 'delay':
        delayTicks = clamp(Math.floor(value), 0, MAX_DELAY_TICKS);
        break;
      case 'jitter':
        jitterTicks = clamp(Math.floor(value), 0, MAX_JITTER_TICKS);
        break;
      case 'loss':
        loss = clamp(value, 0, 1);
        break;
      case 'dup':
        duplicate = clamp(value, 0, 1);
        break;
      default:
        break;
    }
  }

  return { delayTicks, jitterTicks, loss, duplicate };
}

/** The inverse, for a control panel that wants to show what it would take to get here. */
export function formatWire(conditions: WireConditions): string {
  return [
    `delay:${conditions.delayTicks}`,
    `jitter:${conditions.jitterTicks}`,
    `loss:${conditions.loss}`,
    `dup:${conditions.duplicate}`,
  ].join(',');
}
