/**
 * Which rings are under a unit, and when they start and stop (spec 121).
 *
 * Pure -- no three.js, no DOM, no `GameClient`.
 *
 * ## Auras are state, and everything else in this system is an event
 *
 * A hit happens; a poison lasts. The particle system plays effects, so an aura
 * has to be started once when a condition becomes true and stopped once when it
 * stops being true -- which is bookkeeping, and bookkeeping done per-frame in a
 * render loop is where double-started effects and orphaned rings come from.
 * {@link AuraTracker} does the diffing in one tested place.
 *
 * ## What the client actually knows
 *
 * Not much, and this is the honest state of it: **no status is replicated.**
 * `ReplicatedEntity` carries id, kind, typeId, position, facing, health,
 * maxHealth, activity, activityUntilTick and level. `StatModifier` exists on the
 * server and never reaches a client, and there is no buff or debuff list on the
 * wire at all.
 *
 * So the brief's "hook them to the existing debuff/status tracking so applying a
 * status shows its aura automatically" cannot be honoured as written -- the
 * tracking does not exist here, and adding it is a protocol change, which the
 * arc rules out.
 *
 * What is built instead is the whole path against facts, driven by what the
 * client does know: a cast in progress, the selected target, a telegraph, a
 * body's health. Every status aura is authored and reachable. The day a status
 * list is replicated, {@link aurasFor} gains a branch and nothing else in the
 * renderer changes.
 *
 * ## What the client knows now (spec 223)
 *
 * The status list **is** replicated: spec 186 put it on `EntityDelta`, and the
 * paragraph above is kept as written because it is the reason this module has
 * the shape it does. The promised branch is {@link AuraFacts.fields}, and it is
 * exactly one branch -- a status that is an aura field names its own ring in
 * `data/aura-fields.ts`, so the mapping is a table lookup and not a rule.
 *
 * It is narrower than `statuses` on purpose. A field is a status whose whole
 * identity is *a region on the ground*, so a ring is the honest picture of one;
 * the generic five above are still unwired, because "which of a boon, a debuff,
 * a poison, a shield and a heal is this" is a decision per status row and not
 * one this spec is in a position to take for sixteen of them.
 */

import { auraFieldById } from '../../../server/data/aura-fields.js';

/** Everything the ring under a unit is decided from. */
export interface AuraFacts {
  readonly entityId: number;
  /** Winding up an ability. */
  readonly casting: boolean;
  /** A channel, which is longer and worth its own ring. */
  readonly channelling: boolean;
  /** The player's current target. */
  readonly selected: boolean;
  /** An incoming blast the player is standing in. */
  readonly telegraphing: boolean;
  /** 0..1. */
  readonly healthFraction: number;
  /**
   * Statuses, once they are replicated. Empty today, and the parameter exists so
   * that wiring them is a change to the caller rather than to this signature.
   */
  readonly statuses?: readonly StatusKind[];
  /**
   * Status ids of the **aura fields** this body is carrying (spec 223).
   *
   * Ids rather than a kind, because a field already names the ring it wears:
   * `AuraFieldDefinition.auraEffectId` sits beside the radius that ring is drawn
   * at, so the picture and the reach are one row. An id with no field row
   * contributes nothing, which is what makes a client reading a newer server
   * draw no ring rather than the wrong one.
   */
  readonly fields?: readonly string[];
}

export type StatusKind = 'buff' | 'debuff' | 'poison' | 'shield' | 'heal';

const STATUS_AURA: Record<StatusKind, string> = {
  buff: 'aura_buff',
  debuff: 'aura_debuff',
  poison: 'aura_poison',
  shield: 'aura_shield',
  heal: 'aura_heal',
};

/**
 * The order rings are drawn in, innermost first.
 *
 * Fixed rather than derived from the order conditions happened to be checked in,
 * so two units with the same statuses always show the same picture -- and so a
 * ring never changes radius because something else was applied.
 */
export const AURA_ORDER: readonly string[] = [
  'aura_selected',
  'aura_buff',
  'aura_debuff',
  'aura_poison',
  'aura_shield',
  'aura_heal',
  'aura_channel',
  'aura_telegraph',
  // Outermost, because it is the only ring here whose radius means something in
  // the world: it is where the fire is (spec 223), so it cannot be moved to
  // make room for anything and everything else is inside it anyway.
  'aura_scorched',
];

/**
 * Which auras should be live on a unit right now.
 *
 * A pure function of the facts, returned in {@link AURA_ORDER} so the same state
 * always produces the same rings in the same order.
 */
export function aurasFor(facts: AuraFacts): readonly string[] {
  const wanted = new Set<string>();

  if (facts.selected) wanted.add('aura_selected');
  // A channel gets its own ring; an ordinary wind-up does not, because it is
  // over in a few ticks and a ring that flashes on and off every swing is noise.
  if (facts.channelling) wanted.add('aura_channel');
  if (facts.telegraphing) wanted.add('aura_telegraph');

  for (const status of facts.statuses ?? []) {
    const id = STATUS_AURA[status];
    if (id) wanted.add(id);
  }

  // The branch this module's header has promised since spec 121 (spec 223).
  // A field names its own ring, so there is nothing to decide here.
  for (const statusId of facts.fields ?? []) {
    const field = auraFieldById(statusId);
    if (field) wanted.add(field.auraEffectId);
  }

  return AURA_ORDER.filter((id) => wanted.has(id));
}

export interface AuraChange {
  readonly start: readonly string[];
  readonly stop: readonly string[];
}

const NOTHING: AuraChange = { start: [], stop: [] };

/**
 * Diffs what is wanted against what is running, per entity.
 *
 * The whole point is that a caller can hand it the same answer every frame and
 * get an empty change back. Started once, stopped once, and never left running
 * on a body that despawned.
 */
export class AuraTracker {
  private readonly live = new Map<number, string[]>();

  /** What to start and stop for one entity this frame. */
  step(entityId: number, wanted: readonly string[]): AuraChange {
    const running = this.live.get(entityId);
    if (!running) {
      if (wanted.length === 0) return NOTHING;
      this.live.set(entityId, [...wanted]);
      return { start: [...wanted], stop: [] };
    }

    const start = wanted.filter((id) => !running.includes(id));
    const stop = running.filter((id) => !wanted.includes(id));
    if (start.length === 0 && stop.length === 0) return NOTHING;

    if (wanted.length === 0) this.live.delete(entityId);
    else this.live.set(entityId, [...wanted]);
    return { start, stop };
  }

  /** Everything an entity owns, on its way out. Called when a body despawns. */
  forget(entityId: number): readonly string[] {
    const running = this.live.get(entityId);
    if (!running) return [];
    this.live.delete(entityId);
    return running;
  }

  /** Entities the tracker still believes have auras up. */
  entities(): readonly number[] {
    return [...this.live.keys()];
  }

  running(entityId: number): readonly string[] {
    return this.live.get(entityId) ?? [];
  }

  clear(): void {
    this.live.clear();
  }
}

// --- readability at gameplay zoom -------------------------------------------

/**
 * How many virtual pixels a world-space length covers.
 *
 * The camera is orthographic, so this is a ratio and not a projection: the frame
 * is `renderWidth` pixels across and shows `viewWidth` world units.
 */
export function pixelsForWorld(world: number, viewWidth: number, renderWidth: number): number {
  if (viewWidth <= 0) return 0;
  return (world / viewWidth) * renderWidth;
}

/**
 * Whether two ring radii are far enough apart to read as two rings.
 *
 * The check that keeps "stacking two statuses looks intentional" from being an
 * intention. At the frame's real resolution two rings a world unit apart are the
 * same pixel, and a player sees one thick smear whose colour is neither status.
 */
export function ringsSeparated(
  innerRadius: number,
  outerRadius: number,
  viewWidth: number,
  renderWidth: number,
  minimumPixels = 2,
): boolean {
  const gap = pixelsForWorld(Math.abs(outerRadius - innerRadius), viewWidth, renderWidth);
  return gap >= minimumPixels;
}
