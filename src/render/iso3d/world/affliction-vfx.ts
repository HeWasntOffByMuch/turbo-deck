/**
 * The paint on a body carrying an affliction, and the beat it lands on (spec 197).
 *
 * Pure -- no three.js, no DOM, no `GameClient`. It is handed replicated facts
 * and answers what to play, which is the discipline `vfx-wire.ts`, `auras.ts`
 * and `unit-driver.ts` all keep so that presentation has nothing it *could*
 * call. The one rule: every `if` in here decides which effect is drawn and none
 * of them decides a game outcome.
 *
 * ## Two kinds of thing, and they are driven differently
 *
 * `auras.ts` draws the line in one sentence -- *"a hit happens; a poison
 * lasts"* -- and an affliction is the first thing in this game that is both at
 * once:
 *
 * - **The cling is a state.** Started once when the affliction lands, stopped
 *   once when it ends. Nothing per frame, and a body that walks into view
 *   already burning is burning, because there is no start to have missed. That
 *   is exactly what makes it {@link afflictionCling}'s job to be *stateless*,
 *   the rule `stun-icon.ts` and `status-marks.ts` both keep.
 * - **The beat is an event.** It needs an edge, the way `stagger-flinch.ts`
 *   does, and for the same reason: a contact that fires twice is two contacts,
 *   and one that never fires is a jolt nobody saw.
 *
 * ## The beat is derived, not sent
 *
 * `WireStatus` carries an **absolute** `expiresAtTick`, and
 * `data/damage-over-time.ts` is shared code, so the whole schedule is
 * recoverable on the client:
 *
 * ```
 *   elapsed = tick - (expiresAtTick - dotDurationTicks(row))
 *   landed  = clamp(floor(elapsed / row.intervalTicks), 0, row.pulses)
 * ```
 *
 * The same shape `loot-drop.ts`'s reveal phase and `stun-icon.ts`'s swirl
 * already are: a comparison against replicated ticks. Every client beats
 * together, nothing new crosses the wire, and **the paint lands on the frame
 * the damage number does**.
 *
 * It is a *count* rather than a "does this tick equal a pulse tick", and that is
 * the load-bearing part. A frame drains several ticks -- three at 20fps, and
 * this environment paints a real page at about five -- so a rule that asked
 * whether `tick` were exactly a multiple would silently skip most beats and
 * skip *all* of them on a slow frame. Counting what has landed and firing on the
 * increase is frame-rate independent by construction, and it fires **once** for
 * a frame that drained three pulses, because a beat is a beat and not a
 * quantity.
 *
 * ### One stated limit
 *
 * The sim measures `elapsed` from `StatusState.appliedAtTick`, which a refresh
 * deliberately does *not* move (it is what keeps Frostbite's escalation
 * running). The client only has the expiry, which a refresh does move. So after
 * a refresh the derived phase can sit up to `intervalTicks - 1` off the sim's.
 * The **cadence stays exact** -- same interval, same rate, same number of beats
 * -- and the offset is under half a second on every row in the table. Accepted
 * rather than fixed with a protocol change: putting `appliedAtTick` on the wire
 * buys an alignment nobody can see.
 *
 * ## Absent is the default
 *
 * A status with no row in `DAMAGE_OVER_TIME` contributes nothing -- every boon,
 * and every internal family. The same rule `visualFor` keeps one level up, and
 * the reason a new status is invisible until somebody decides it should not be.
 */

import type { WireStatus } from '../../../server/net/messages.js';
import { visualByWire } from '../../../server/data/status-visuals.js';
import {
  ALL_DOTS,
  dotById,
  dotDurationTicks,
  dotRampAt,
  type DotDefinition,
} from '../../../server/data/damage-over-time.js';

/**
 * What each affliction is drawn with.
 *
 * A **table**, not a naming convention, for the reason `naming.ts` is a table
 * and `POINTER_CODES` is a closed list: a built id (`` `affliction_${dotId}` ``)
 * is a second, invisible answer that every boundary has to re-derive, it has
 * nowhere to say that Burn and Shock deliberately have no heavy tier, and a
 * typo in it survives as an effect that silently plays nothing.
 *
 * `heavy` is absent for the two rows that cannot get worse. Burn does not stack
 * and does not ramp; Shock does not either. There is no state of a body in this
 * game where either is more than it already is, so inventing a louder version
 * would be a picture of something that never happens.
 *
 * Both directions are asserted against the compiled registry in the test beside
 * this: every id here exists, and every `affliction_` effect in the registry is
 * named here. The second half is what catches an effect that was authored and
 * then reached by nothing -- the failure this whole spec exists to close.
 */
export interface AfflictionArt {
  /** Played while the affliction is on the body, and stopped when it is not. */
  readonly cling: string;
  /** The louder cling, for a row that stacks or ramps. */
  readonly heavy?: string;
  /** One-shot, on the tick a pulse lands. */
  readonly pulse: string;
}

export const AFFLICTION_ART: Readonly<Record<string, AfflictionArt>> = {
  burn: { cling: 'affliction_burn', pulse: 'affliction_burn_pulse' },
  bleed: {
    cling: 'affliction_bleed',
    heavy: 'affliction_bleed_heavy',
    pulse: 'affliction_bleed_pulse',
  },
  poison: {
    cling: 'affliction_poison',
    heavy: 'affliction_poison_heavy',
    pulse: 'affliction_poison_pulse',
  },
  corrosion: {
    cling: 'affliction_corrosion',
    heavy: 'affliction_corrosion_heavy',
    pulse: 'affliction_corrosion_pulse',
  },
  shock: { cling: 'affliction_shock', pulse: 'affliction_shock_pulse' },
  frostbite: {
    cling: 'affliction_frostbite',
    heavy: 'affliction_frostbite_heavy',
    pulse: 'affliction_frostbite_pulse',
  },
  decay: { cling: 'affliction_decay', pulse: 'affliction_decay_pulse' },
};

/** One affliction on one body, resolved against the tick being drawn. */
export interface LiveAffliction {
  /** The `StatusId`, which is also the `DotDefinition` id. */
  readonly dotId: string;
  /**
   * `StatusVisual.wire`, which is what the list is ordered by.
   *
   * Carried rather than looked up again, because the sort has to happen here and
   * a second `visualByWire` call per comparison would be a table lookup inside a
   * comparator.
   */
  readonly wire: number;
  /** The cling to play -- the heavy one where this has got worse. */
  readonly cling: string;
  readonly pulse: string;
  /** Ticks since it landed. Never negative. */
  readonly elapsedTicks: number;
  /** Pulses that have landed as of this tick, `0..row.pulses`. */
  readonly landed: number;
}

/** Nothing, shared, so a body with no afflictions allocates nothing per frame. */
const NONE: readonly LiveAffliction[] = [];

/**
 * How far into its life an affliction is, from its replicated expiry.
 *
 * Clamped at zero rather than allowed negative: a status whose expiry is further
 * out than its own authored duration is one the server has extended somehow, and
 * a negative elapsed would report a beat that has not happened.
 */
function elapsedOf(row: DotDefinition, expiresAtTick: number, tick: number): number {
  return Math.max(0, tick - (expiresAtTick - dotDurationTicks(row)));
}

/**
 * Pulses landed as of `tick`, `0..row.pulses`.
 *
 * `floor(elapsed / interval)` and not `elapsed % interval === 0`: see the header.
 * Capped at `row.pulses` because the window carries one tick of slack past the
 * last pulse (`dotDurationTicks`'s `+ 1`), and an uncapped count would report an
 * extra beat on that tick for every affliction in the table at once.
 */
export function pulsesLanded(row: DotDefinition, expiresAtTick: number, tick: number): number {
  const elapsed = elapsedOf(row, expiresAtTick, tick);
  return Math.max(0, Math.min(row.pulses, Math.floor(elapsed / row.intervalTicks)));
}

/**
 * Whether this affliction has got bad enough to be drawn louder.
 *
 * Two inputs, because the table has two ways of getting worse and a row uses
 * exactly one of them. A stacking row crosses at **half its own maximum**, which
 * is the honest resolution: five stacks of Poison and four are not two pictures
 * anybody can tell apart at three hundred pixels tall, and the count is already
 * drawn -- the mark over the head carries it (spec 186). What the paint owes is
 * *severity*.
 *
 * A ramping row crosses at **half its own escalation**, measured from the same
 * elapsed the beat is. Frostbite is the only one, and it is the whole of that
 * row's design: harmless for a moment, dangerous if you let it stay on.
 *
 * Never brightness. Brightness is what the beat says, and one signal meaning two
 * things is a legend nobody can read -- so severity is *more paint* and nothing
 * else.
 */
export function afflictionIsHeavy(
  row: DotDefinition,
  stacks: number,
  elapsedTicks: number,
): boolean {
  if (row.maxStacks > 1) return stacks * 2 >= row.maxStacks;
  if (row.rampPerSecond === undefined) return false;
  const cap = row.rampCap ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(cap)) return false;
  return dotRampAt(row, elapsedTicks) >= 1 + (cap - 1) / 2;
}

/**
 * Every affliction live on this body right now, in wire order.
 *
 * Stateless, and a stale entry is refused on read by the same
 * `tick >= expiresAtTick` comparison `statusOf` makes in the sim and
 * `statusMarks` makes beside this. Nothing prunes `ReplicatedEntity.statuses`,
 * so that comparison is what makes correctness independent of whether the delta
 * saying "it fell off" has arrived.
 *
 * Order is by **wire index**, for the reason `AURA_ORDER` is fixed: two bodies
 * carrying the same afflictions must produce the same list, and a mark must not
 * move because something else was applied. The wire is already sorted by index
 * (`visibleStatusesOf`), so this changes nothing today -- and does not depend on
 * it, because it sorts on the index it was sent rather than trusting the order
 * it arrived in.
 */
export function afflictionsOn(
  statuses: readonly WireStatus[],
  tick: number,
): readonly LiveAffliction[] {
  if (statuses.length === 0) return NONE;
  let live: LiveAffliction[] | null = null;
  for (const status of statuses) {
    if (tick >= status.expiresAtTick) continue;
    const visual = visualByWire(status.wire);
    if (!visual) continue;
    const row = dotById(visual.id);
    if (!row) continue;
    const art = AFFLICTION_ART[row.id];
    if (!art) continue;
    const elapsedTicks = elapsedOf(row, status.expiresAtTick, tick);
    const heavy = afflictionIsHeavy(row, status.stacks, elapsedTicks);
    live ??= [];
    live.push({
      dotId: row.id,
      wire: visual.wire,
      cling: (heavy ? art.heavy : undefined) ?? art.cling,
      pulse: art.pulse,
      elapsedTicks,
      landed: pulsesLanded(row, status.expiresAtTick, tick),
    });
  }
  if (live === null) return NONE;
  // Sorted here rather than trusted from the wire, and the distinction is the
  // whole of the header's claim above. `visibleStatusesOf` does end on a sort by
  // wire index, so today this changes nothing -- which is exactly what makes it
  // worth doing: the day a second producer packs a status list (the developer
  // trigger, a replay, a test fixture) two identical bodies would wear their
  // paint in a different order with every test still green. A list this short is
  // a handful of comparisons and the alternative is a latent ordering bug whose
  // symptom is "it looked different that time".
  live.sort((a, b) => a.wire - b.wire);
  return live;
}

// --- the driver --------------------------------------------------------------

/**
 * The two calls this needs from the particle system.
 *
 * An interface rather than `VfxLayer`, so the driver is pure and the whole
 * feature is testable in Node -- the same reason `unit-driver.ts` takes a
 * snapshot rather than a `GameClient`. `VfxLayer` satisfies it structurally and
 * a test satisfies it with a recorder.
 */
export interface VfxPlayer {
  play(
    id: string,
    options: {
      x: number;
      y: number;
      z: number;
      seed: number;
      scale?: number;
      attach?: { kind: 'entity'; entityId: number };
    },
  ): number;
  stop(handle: number): void;
  has(id: string): boolean;
  /**
   * Whether a handle still names a running effect.
   *
   * Not a nicety. When the instance pool is full, `claimInstance` does not
   * refuse -- it **evicts** the lowest-priority, furthest instance it can find
   * and hands the slot over, bumping the slot's generation so every handle to
   * it goes stale. A cling is `priority: 1` and therefore the first thing in the
   * game to be evicted, which is the right call: a fight in front of you matters
   * more than paint on a body across the arena.
   *
   * What is *not* right is a driver that goes on believing it. Without this the
   * held handle stays non-zero, the restart never happens, and the body has lost
   * its paint permanently -- silently, and only in the crowded fight where the
   * pressure came from.
   */
  isLive(handle: number): boolean;
}

/** Where a body is, and how big it is. */
export interface AfflictedBody {
  readonly entityId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * The body's footprint radius, which is the effect's `scale`.
   *
   * Every length in `brushAffliction` is authored as a multiple of this and the
   * `surface` hook answers in the same units, so one definition fits a spider
   * and a player: `system.ts` multiplies both the shape's local coordinates and
   * the size curve by the instance scale.
   */
  readonly radius: number;
}

/** What one body currently owns. */
interface Owned {
  /** The cling id playing, and the handle that stops it. */
  clingId: string;
  clingHandle: number;
  /** Pulses this client has already drawn a beat for. */
  landed: number;
}

/**
 * Starts, stops and beats the paint on every afflicted body.
 *
 * Impure only in that it *remembers*; it holds no three.js and no DOM, so it is
 * driven end to end in Node against a recording {@link VfxPlayer}.
 *
 * ## Why this does the diff itself rather than through `AuraTracker`
 *
 * `AuraTracker` (spec 121) is the tested machinery for exactly this shape and is
 * still the right thing for the rings it was written for. It cannot be used
 * here, for one specific reason: **`play` returns `0` on refusal** -- unknown
 * id, over budget, or beyond `cullDistance` -- and a tracker that records *ids*
 * has no way to say "wanted, asked for, did not start". Committing a refused id
 * would leave a body silently unmarked for the rest of its life, which is much
 * the worse of the two failures. Holding **handles** makes a refusal mean "not
 * started yet", so a body that walks into range gets its paint on the frame it
 * does, and a body under budget pressure gets it when the pressure lifts.
 *
 * ## The obligation that comes with holding a handle
 *
 * On despawn **nothing stops itself.** The attach hook answers false, the
 * instance stays where it last resolved, and a `durationTicks: 0` effect hangs
 * in the air forever holding an instance slot. Nothing in this game has ever
 * held a persistent attached effect before, so {@link forget} is the pattern
 * rather than a use of one -- and it is called from the despawn sweep, not
 * inferred from an absence.
 */
export class AfflictionVfx {
  private readonly owned = new Map<number, Map<string, Owned>>();

  constructor(private readonly player: VfxPlayer) {}

  /**
   * Bring one body up to date. Idempotent: the same facts on the next frame
   * start nothing, stop nothing and beat nothing.
   */
  step(body: AfflictedBody, statuses: readonly WireStatus[], tick: number): void {
    const live = afflictionsOn(statuses, tick);
    let held = this.owned.get(body.entityId);

    if (live.length === 0) {
      if (held) this.forget(body.entityId);
      return;
    }

    if (!held) {
      held = new Map<string, Owned>();
      this.owned.set(body.entityId, held);
    }

    for (const affliction of live) {
      let own = held.get(affliction.dotId);
      if (!own) {
        // `landed` starts where the affliction already is rather than at zero,
        // so a body that walks into view four pulses in does not fire four
        // beats to catch up. A beat is a contact and a contact nobody watched
        // did not happen to them -- the same rule `stagger-flinch.ts` keeps
        // when it refuses to flinch for a body that arrived already broken.
        own = { clingId: '', clingHandle: 0, landed: affliction.landed };
        held.set(affliction.dotId, own);
      }

      // Evicted out from under us. The pool is full and something with a better
      // claim took the slot, so the handle names nothing and the paint is gone:
      // forget it and let the restart below try again. It may well be refused
      // again this frame, which is exactly what should happen while the pressure
      // lasts -- and the moment it lifts, the body gets its paint back.
      if (own.clingHandle !== 0 && !this.player.isLive(own.clingHandle)) {
        own.clingHandle = 0;
      }

      // The severity changed, so the cling is a different effect. Stopping the
      // old one first is what keeps a body from wearing both at once.
      if (own.clingHandle !== 0 && own.clingId !== affliction.cling) {
        this.player.stop(own.clingHandle);
        own.clingHandle = 0;
      }
      if (own.clingHandle === 0) {
        own.clingId = affliction.cling;
        own.clingHandle = this.start(affliction.cling, body);
      }

      if (affliction.landed > own.landed) {
        // Once per frame however many beats it drained. A frame that swallowed
        // three pulses is a slow frame, not three jolts.
        this.beat(affliction.pulse, body, affliction.landed);
      }
      // Written unconditionally, so a refresh -- which moves the expiry back and
      // therefore drops the derived count -- re-baselines instead of holding a
      // number the next beat has to climb past. The same shape `xp-gain.ts`
      // uses for a backwards move: report nothing, and start again from here.
      own.landed = affliction.landed;
    }

    // Anything held that is no longer live has ended.
    for (const [dotId, own] of held) {
      if (live.some((affliction) => affliction.dotId === dotId)) continue;
      if (own.clingHandle !== 0) this.player.stop(own.clingHandle);
      held.delete(dotId);
    }
    if (held.size === 0) this.owned.delete(body.entityId);
  }

  /** Everything this body still owns, on its way out of the scene. */
  forget(entityId: number): void {
    const held = this.owned.get(entityId);
    if (!held) return;
    for (const own of held.values()) {
      if (own.clingHandle !== 0) this.player.stop(own.clingHandle);
    }
    this.owned.delete(entityId);
  }

  /** Every body this driver still believes is wearing something. */
  entities(): readonly number[] {
    return [...this.owned.keys()];
  }

  clear(): void {
    for (const entityId of [...this.owned.keys()]) this.forget(entityId);
  }

  private start(id: string, body: AfflictedBody): number {
    // `playCue`'s rule rather than `addEffect`'s: an id the registry does not
    // know is silence, never a fallback ring. A debug ring under every body
    // carrying an unauthored status is the exact noise the restrained-
    // presentation rule exists to prevent.
    if (!this.player.has(id)) return 0;
    return this.player.play(id, {
      x: body.x,
      y: body.y,
      z: body.z,
      // Derived from the body and the effect rather than drawn, so two clients
      // watching one poisoned body see the same marks -- the reason `seed` has
      // no default in `PlayOptions` at all.
      seed: seedFor(body.entityId, id, 0),
      scale: body.radius,
      attach: { kind: 'entity', entityId: body.entityId },
    });
  }

  private beat(id: string, body: AfflictedBody, index: number): void {
    if (!this.player.has(id)) return;
    // The handle is dropped on the floor deliberately: a burst instance retires
    // within a tick or two of firing and a held handle to one is a stale
    // reference at best. Only a continuous effect is worth keeping one for.
    this.player.play(id, {
      x: body.x,
      y: body.y,
      z: body.z,
      // The pulse index is in the seed, so successive beats on one body are
      // different paintings rather than the same one played over.
      seed: seedFor(body.entityId, id, index),
      scale: body.radius,
      attach: { kind: 'entity', entityId: body.entityId },
    });
  }
}

/**
 * A seed from facts every client shares.
 *
 * No clock and no `Math.random`: the entity, the effect and which beat this is.
 * FNV-1a over the id's bytes mixed with the two numbers -- cheap, and it spreads
 * ids that differ in one character, which `affliction_burn` and
 * `affliction_bleed` very nearly do.
 */
export function seedFor(entityId: number, id: string, index: number): number {
  let hash = 0x811c9dc5 ^ (entityId * 0x01000193) ^ (index * 0x85ebca6b);
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 0x7fffffff;
}

// --- reaching one from the shipped page --------------------------------------

/**
 * The afflictions a `?afflict=` query parameter asks for, as ordinals into
 * `ALL_DOTS`.
 *
 * A developer path and nothing else, in the same register as `?seed=`,
 * `?wire=`, `?units=` and `?slots=` -- and it exists for exactly the reason
 * `?slots=` does, restated one system along. **Nothing a player can do from the
 * shipped page applies an affliction.** Every one of the seven arrives through
 * a skill sigil that has to be looted and equipped, or through a monster that
 * has to be authored to carry one, and no monster in the roster does. So the
 * whole of spec 197 was unreachable from the Play tab: the paint could be
 * asserted in Node and photographed in a rig, and nobody could walk up to a
 * burning body in the game and look at it.
 *
 * Names rather than numbers -- `?afflict=burn,poison` -- because an ordinal is
 * a thing you have to go and count, and the point of a developer path is that
 * it is faster than the alternative. An unknown name is **dropped rather than
 * refused**: a parameter is typed by hand and half a list arriving is better
 * than none of it, and the tab has no way to report a parse error that anybody
 * would see.
 *
 * Pure and returned in table order, so `?afflict=decay,burn` and
 * `?afflict=burn,decay` are the same request.
 */
export function afflictionsFromQuery(search: string): readonly number[] {
  const raw = new URLSearchParams(search).get('afflict');
  if (raw === null) return [];
  const wanted = new Set(
    raw
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ''),
  );
  if (wanted.size === 0) return [];
  // `all` is a shorthand worth having: the seven together is the state the
  // budget and the legibility both have to survive, and typing it out is the
  // sort of thing that quietly stops being done.
  const every = wanted.has('all');
  const ordinals: number[] = [];
  ALL_DOTS.forEach((row, index) => {
    if (every || wanted.has(row.id)) ordinals.push(index);
  });
  return ordinals;
}
