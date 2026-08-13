/**
 * How a drop looks while it is still deciding what to tell you (spec 156).
 *
 * Everything about the reveal that a renderer needs is here, and none of it is
 * a timer: the phase is a comparison against two ticks the server sent, and the
 * flare is a curve through them. That is the whole reason this file exists --
 * scattering "and then wait 45 ticks" through `scene.ts` would make "when does
 * the label appear" a different answer per frame rate, and a different one
 * again for whoever reconnected halfway through.
 *
 * Pure: no three.js, no DOM, and **time is an argument** -- the drawn tick, the
 * same one the health bars are placed by, never a second clock.
 *
 * The cues are *names* (`'loot.reveal.rare'`), not assets. This layer decides
 * when something should be heard and seen; what it sounds like is somebody
 * else's file, and the server has never heard of either.
 */

import { rarityRow } from '../../../server/data/loot.js';
import type { DropView } from '../../../server/client/game-client.js';
import { RevealPhase, revealPhaseAt, type RevealPhaseValue } from '../../../server/sim/loot.js';

/**
 * How long the flash at the reveal takes to settle back, in ticks. ~0.4s.
 *
 * Short. The reveal is a *resolution*, not a second event: the thing being
 * announced already happened when the drop landed, and a long decay here would
 * turn a beat into a fanfare -- exactly the presentation
 * `docs/reward-philosophy.md` §10 rules out.
 */
export const REVEAL_SETTLE_TICKS = 24;

export interface DropPresentation {
  readonly phase: RevealPhaseValue;
  /**
   * What to scale and light the drop's glow by, 0..1.
   *
   * A single number rather than a colour or a size, so the scene decides what
   * "brighter" means for its own materials and this file never learns.
   */
  readonly flare: number;
  /**
   * The name to draw, or **null while the item is still being withheld**.
   *
   * Null rather than a placeholder: a made-up label is a lie the player reads as
   * a fact, and "???" is a UI element announcing that the UI is hiding
   * something, which is the opposite of noticing an unusual object.
   */
  readonly label: string | null;
  /** Cue names that crossed into this read. Usually empty. */
  readonly cues: readonly string[];
}

/** Smooth both ends, so neither the run-up nor the settle starts with a step. */
function smooth(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * The flare curve, as a pure function of one drop and one tick.
 *
 * Three segments and one rule holding them together: the curve never leaves
 * `[restFlare, peakFlare]`. For a common drop those two are equal, so its curve
 * is a flat line at the dimmest value in the table -- which is what makes
 * "ordinary loot is quieter than everything else at every instant" true by
 * construction rather than by two curves happening not to cross.
 */
export function flareAt(drop: DropView, tick: number): number {
  const row = rarityRow(drop.rarity);
  const phase = revealPhaseAt(drop, tick);

  if (phase === RevealPhase.Spawned) return row.restFlare;
  if (phase === RevealPhase.Anticipation) {
    const span = drop.revealTick - drop.anticipationTick;
    const through = span <= 0 ? 1 : (tick - drop.anticipationTick) / span;
    return row.restFlare + (row.peakFlare - row.restFlare) * smooth(through);
  }
  const settled = smooth((tick - drop.revealTick) / REVEAL_SETTLE_TICKS);
  return row.peakFlare + (row.restFlare - row.peakFlare) * settled;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface PickupInput {
  /** Where we are: the predicted position, not the replica. */
  readonly self: Point;
  /** Our own health. A corpse picks nothing up, and the server agrees. */
  readonly selfHealth: number;
  /** The drop being walked to, or null when no order is standing. */
  readonly drop: (Point & { readonly entityId: number }) | null;
  /** `PICKUP_RANGE` plus our own body radius -- the server's own reach. */
  readonly reach: number;
  /** True while a request of ours is unanswered, so we do not ask again. */
  readonly pending: boolean;
}

export interface PickupOrder {
  /** Where to walk to close the gap, or null when there is nothing to close. */
  readonly walkTo: Point | null;
  /** Whether to ask the server for it this tick. */
  readonly ask: boolean;
}

/**
 * Walk to the drop, then ask for it (spec 156).
 *
 * The same shape `target.ts` uses for an attack order and for the same reason:
 * routing the walk client-side is what keeps prediction exact, and the decision
 * itself is a few numbers in and a decision out, so "does the player stop
 * walking once they are close enough" is answerable in Node.
 *
 * It is a *prediction* of the server's reach, never a second opinion about it:
 * `reach` is the server's own `PICKUP_RANGE`, and asking too early costs one
 * refused message rather than a wrong outcome.
 */
export function pickupOrderFor(input: PickupInput): PickupOrder {
  const { drop } = input;
  if (!drop || input.selfHealth <= 0) return { walkTo: null, ask: false };
  const near = Math.hypot(drop.x - input.self.x, drop.y - input.self.y) <= input.reach;
  if (!near) return { walkTo: { x: drop.x, y: drop.y }, ask: false };
  // Standing on it: stop walking, and ask once. `pending` is what keeps that
  // one ask from becoming sixty a second while the answer is in flight.
  return { walkTo: null, ask: !input.pending };
}

/**
 * The drops on screen, and which of their cues have already been heard.
 *
 * A small object with memory rather than a pure function, for the reason
 * `HealthFlashes` is one: a cue is an *edge*, and an edge needs to know what
 * the last read said. Everything else about a drop is stateless and is
 * recomputed from the tick.
 *
 * Two rules the memory exists to enforce. **A cue fires once**, so a frame
 * drawn twice on the same tick is silent the second time. And **the first read
 * of a drop establishes its baseline**: a player who walks up to something that
 * revealed a minute ago gets the spawn cue and nothing else, rather than a
 * fanfare for an event they missed.
 */
export class DropPresenter {
  private readonly heard = new Map<number, Set<string>>();

  read(drop: DropView, tick: number): DropPresentation {
    const row = rarityRow(drop.rarity);
    const phase = revealPhaseAt(drop, tick);
    let heard = this.heard.get(drop.entityId);
    const first = heard === undefined;
    if (!heard) {
      heard = new Set<string>();
      this.heard.set(drop.entityId, heard);
    }

    const cues: string[] = [];
    const fire = (name: string): void => {
      if (name === '' || heard.has(name)) return;
      heard.add(name);
      cues.push(name);
    };

    fire(row.cues.spawn);
    // On a first sighting the later cues are *marked heard without firing*: the
    // transitions they announce happened before this client was looking, and
    // announcing them now would be a reveal cue for somebody who arrived after
    // the reveal.
    if (first && phase !== RevealPhase.Spawned) heard.add(row.cues.anticipation);
    if (first && phase === RevealPhase.Revealed) heard.add(row.cues.reveal);

    if (phase !== RevealPhase.Spawned) fire(row.cues.anticipation);
    if (phase === RevealPhase.Revealed) fire(row.cues.reveal);

    return {
      phase,
      flare: flareAt(drop, tick),
      // Straight from the view, which is null until the server said otherwise.
      // There is no branch here that could produce a name early, because there
      // is no name here to produce.
      label: drop.name,
      cues,
    };
  }

  /** Forget every drop not in `live`, so a session does not accumulate ids. */
  retain(live: ReadonlySet<number>): void {
    for (const id of this.heard.keys()) {
      if (!live.has(id)) this.heard.delete(id);
    }
  }

  get tracked(): number {
    return this.heard.size;
  }
}
