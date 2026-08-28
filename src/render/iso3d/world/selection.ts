/**
 * The body a left click named, as a panel can read it (spec 196).
 *
 * Beside `character-model.ts` and `inventory-model.ts`, and out here for the
 * reason those are: `src/ui/` may not reach the sim, so the replicated facts
 * and the content tables are turned into plain rows on this side of the fence.
 * A screen renders what it is handed and decides nothing -- including what a
 * line is worth saying, which is the same division the item tooltip keeps.
 *
 * The whole of what makes this a module rather than four lines in `view.ts` is
 * that the statuses come from **`statusMarks`**, the same function the marks
 * over the head are built from. The corner panel and the body are two views of
 * one list, and a second derivation would be a second answer to "has this
 * expired" -- exactly the disagreement spec 186 wrote its refused-on-read rule
 * to prevent.
 *
 * Pure. No DOM, no clock: the tick being drawn arrives from the caller, the way
 * it does for every other reading of a replicated window.
 */

import { SERVER_TICK_RATE } from '../../../server/config.js';
import type { ReplicatedEntity } from '../../../server/client/replica.js';
import { EntityKind } from '../../../server/net/protocol.js';
import type { SelectedUnitView, StatusRowView } from '../../../ui/screens/selected-unit.js';
import { displayName } from './appearance.js';
import { FADE_TICKS, statusMarks, type StatusMark } from './status-marks.js';

export interface SelectionInput {
  /** What the player clicked, or null. Client state: nothing here is replicated. */
  readonly selectedId: number | null;
  readonly entities: readonly ReplicatedEntity[];
  /** The interpolated presentation tick, as every other timed reading takes it. */
  readonly drawnTick: number;
}

/**
 * Which kinds may be selected.
 *
 * Bodies, and only bodies. A projectile is in flight for a third of a second, a
 * drop is a thing you pick up rather than inspect, a prop has no health and a
 * mote is replicated to exactly one client -- and none of the four can carry a
 * status, which is what the panel exists to show. `pickUnitAt` already looks at
 * units alone; this is the same rule stated somewhere it can be tested.
 */
export function selectableKind(kind: number): boolean {
  return kind === EntityKind.Player || kind === EntityKind.Monster;
}

/**
 * The panel's view for the selected body, or null when there is nothing to show.
 *
 * Null rather than a view with a flag on it, for the reason `death.ts` gives
 * about the respawn overlay: a shape that can be present and false is a shape
 * with an extra way to be wrong, and every caller asks the same question --
 * draw it, or do not.
 *
 * A selection pointing at a body that has left the replicated set answers null,
 * and the caller drops the id. There is no state in which an id outlives the
 * thing it named: entity ids are reused, so a stale selection would eventually
 * come back pointing at a stranger.
 */
export function selectionOf(input: SelectionInput): SelectedUnitView | null {
  if (input.selectedId === null) return null;
  // `?? []` and `entity.statuses ?? []` below for the reason `hud.ts` gives
  // where it draws the marks: several harnesses fabricate a view by hand, and a
  // field added to `ClientView` or to `ReplicatedEntity` is not a field they
  // know to set. The types say both are always there; the rigs say otherwise,
  // and a readout that throws on a missing field takes the whole frame with it.
  const entity = (input.entities ?? []).find((candidate) => candidate.id === input.selectedId);
  if (!entity || !selectableKind(entity.kind)) return null;

  const level = Math.max(1, Math.round(entity.level));
  return {
    name: displayName(entity),
    // A player's own name says nothing about what they are, so theirs names it;
    // a grazer's name is already its kind, so its level stands on its own.
    detail: entity.kind === EntityKind.Player ? `Lv ${level} Player` : `Lv ${level}`,
    health: {
      current: Math.max(0, entity.health),
      max: Math.max(0, entity.maxHealth),
    },
    dead: entity.health <= 0,
    statuses: statusMarks(entity.statuses ?? [], input.drawnTick).map(statusRow),
  };
}

/**
 * One mark, said the way a player reads it.
 *
 * The stack count rides *in the label* rather than in a column of its own,
 * because `showsCount` is false for six of the eight rows and a column that is
 * empty three quarters of the time is a column of air in a 124-pixel panel.
 *
 * `fading` is the mark's own window rather than a second threshold: the row
 * dims over exactly the ticks the glyph over the head thins out across, so the
 * two surfaces say "this is about to go" at the same instant.
 */
function statusRow(mark: StatusMark): StatusRowView {
  return {
    id: mark.id,
    label: mark.showsCount ? `${mark.name} x${mark.stacks}` : mark.name,
    remaining: formatRemaining(mark.ticksLeft),
    tone: mark.kind,
    fading: mark.ticksLeft < FADE_TICKS,
  };
}

/**
 * Ticks as the seconds a player reads.
 *
 * One decimal under ten seconds and a whole number above, which is the rule the
 * action bar's countdown already follows: a tenth is the difference between
 * "now" and "not yet" at the bottom of a window and is noise at the top of one.
 * Rounded *up*, so a status with any time left never reads `0.0s` -- a row
 * saying zero while it is still on the body is the one number here that would
 * be a lie.
 */
export function formatRemaining(ticks: number): string {
  if (!Number.isFinite(ticks) || ticks <= 0) return '';
  const seconds = ticks / SERVER_TICK_RATE;
  if (seconds >= 10) return `${Math.ceil(seconds)}s`;
  return `${(Math.ceil(seconds * 10) / 10).toFixed(1)}s`;
}
