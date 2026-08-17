/**
 * The player's own health and resource, as two bars (spec 164).
 *
 * Both numbers have been on the wire since spec 069 and both were text in a
 * `display:none` developer readout. The floating bar over your own head is the
 * other place health appears, and it is the wrong place to read it from: it is
 * in the middle of the fight, it moves with the body, and it is the same bar
 * every enemy wears.
 *
 * The health bar here is the *same* bar mechanically -- `HealthFlashes` from
 * spec 145 reads it, so the white chunk a blow leaves and the flinch it kicks
 * with (spec 146) are the ones already on screen rather than a second
 * implementation that would drift. This module answers what the numbers are;
 * that one answers what a blow does to them, and `hud.ts` owns the elements.
 * The same division the floating bars and the damage numbers already have.
 *
 * Pure, and it holds one judgement: **an unknown maximum is not a maximum of
 * zero.** Before the first `Stats` message there is no stat block at all, and
 * dividing by the zero that stands in for it paints an empty health bar over a
 * player at full health for the first frames of every session.
 */

import type { ClientView } from '../../../server/client/game-client.js';

export interface PoolBar {
  readonly current: number;
  readonly max: number;
  /**
   * 0..1, clamped. Zero when the maximum is not known yet.
   *
   * What the *resource* bar is drawn from directly. The health bar's fill comes
   * from `HealthFlashes` instead, which needs `current` and `max` rather than
   * the ratio -- health kept in health units is what stops a changing maximum
   * reading as a blow.
   */
  readonly fraction: number;
  /**
   * "179 / 218", rounded -- the bar's own label.
   *
   * Every character in it has a glyph in `pixel-font.ts` (the digits, the space
   * and, since spec 164, the slash), because this is drawn in the game's own
   * font and anything else comes out as a solid block. That is why an unknown
   * maximum is dashes rather than an em dash.
   */
  readonly text: string;
  /** Whether the maximum is known. False before the first `Stats` message. */
  readonly known: boolean;
}

export interface PoolBars {
  readonly health: PoolBar;
  readonly resource: PoolBar;
}

function bar(current: number, max: number): PoolBar {
  const known = Number.isFinite(max) && max > 0;
  const safeMax = known ? max : 0;
  const safeCurrent = Number.isFinite(current) ? Math.max(0, Math.min(current, safeMax)) : 0;
  return {
    current: safeCurrent,
    max: safeMax,
    fraction: known ? safeCurrent / safeMax : 0,
    text: known ? `${Math.round(safeCurrent)} / ${Math.round(safeMax)}` : '-- / --',
    known,
  };
}

/**
 * Both pools, off the view.
 *
 * Health comes from the *entity* and resource from the client's own model of the
 * pool (`view.resource`, spec 069) -- which is the server's last word regenerated
 * forward minus what unanswered casts have spent. Deliberately the same number
 * the hotbar greys buttons out against, so a bar showing enough for a bolt and a
 * button saying otherwise is not a state this can produce.
 */
export function poolBars(view: ClientView): PoolBars {
  const self = view.entities.find((entity) => entity.id === view.selfEntityId);
  return {
    health: bar(self?.health ?? 0, view.stats?.maxHealth ?? 0),
    resource: bar(view.resource, view.stats?.maxResource ?? 0),
  };
}
