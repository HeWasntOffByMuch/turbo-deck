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

/**
 * How long the throw takes, in ticks. ~0.3s at 60Hz.
 *
 * Short: this is a body dropping something, not a lobbed shot. Long enough that
 * the object visibly *travels* rather than teleporting to its landing spot,
 * which is the whole of what "it looks dropped" means.
 */
export const TOSS_TICKS = 18;

/** How high above the straight line the throw arcs, as a fraction of its span. */
const TOSS_ARC = 0.45;
/** The lowest an arc ever rises, so a drop that barely moved still hops. */
const TOSS_ARC_MIN = 10;

/**
 * The beat's period, in ticks. One second, which is a resting human heart.
 *
 * Slow on purpose. A fast pulse reads as an alarm; this is meant to read as
 * something quietly alive lying in the grass.
 */
export const HEARTBEAT_TICKS = 60;
/** Where the second, smaller beat falls in the cycle -- the "dub" of lub-dub. */
const HEARTBEAT_DUB_AT = 10;
/** How sharp each beat is. Smaller is a tighter thump. */
const HEARTBEAT_WIDTH = 3.2;
/** How much bigger the object gets at the top of a full beat. Slight. */
const HEARTBEAT_SCALE = 0.13;

/**
 * How long the tier's colour takes to arrive once the item is known, in ticks.
 *
 * Not instant: a hard colour swap is a state change the eye reads as a glitch,
 * and this is the moment the whole feature exists for. Short enough to be a
 * resolution rather than a transition.
 */
export const TIER_BLEND_TICKS = 12;

export interface DropPresentation {
  readonly phase: RevealPhaseValue;
  /**
   * Where to draw it: on the arc while it is still in the air, at its landing
   * spot after (spec 156). Both ends came off the wire, so every client draws
   * the same throw and one that arrived late draws none of it.
   */
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /**
   * How far the tier's colour has arrived, 0..1 (spec 156).
   *
   * **0 until the reveal**, which is what makes this a rarity reveal rather
   * than a rarity *brightness* reveal: an unrevealed drop is drawn in the
   * neutral colour ordinary loot wears, so the tier is not readable off it.
   * That misdirection is deliberate -- what you can tell early is that
   * *something* is unusual (the pulse, the swell), never how unusual.
   */
  readonly tierMix: number;
  /**
   * A scale multiplier, ~1, carrying the heartbeat (spec 156). Exactly 1 for a
   * tier with no pulse, so a common drop is inert by arithmetic.
   */
  readonly beat: number;
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

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
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

/**
 * Where a drop is at `tick`: on its arc, or resting where it landed.
 *
 * A parabola between two authoritative points over a fixed span, so it is a
 * pure function of what the wire carried and the clock -- which is what makes
 * two players watching the same kill watch the same throw. Past `TOSS_TICKS` it
 * is exactly `landing`, so a client that connected a minute later computes the
 * resting position without a branch saying so.
 */
export function tossAt(drop: DropView, landing: Vec3Like, tick: number): Vec3Like {
  const through = (tick - drop.spawnTick) / TOSS_TICKS;
  if (!(through > 0)) return { x: drop.origin.x, y: drop.origin.y, z: drop.origin.z };
  if (through >= 1) return landing;

  const span = Math.hypot(landing.x - drop.origin.x, landing.y - drop.origin.y);
  const peak = Math.max(TOSS_ARC_MIN, span * TOSS_ARC);
  // `4t(1-t)` is 0 at both ends and 1 in the middle: the whole arc in one term,
  // with no easing to pick and no way for it to miss its landing.
  const lift = 4 * through * (1 - through) * peak;
  return {
    x: drop.origin.x + (landing.x - drop.origin.x) * through,
    y: drop.origin.y + (landing.y - drop.origin.y) * through,
    z: drop.origin.z + (landing.z - drop.origin.z) * through + lift,
  };
}

/** One beat: a bump centred at `at`, in ticks, falling off either side. */
function thump(t: number, at: number, amplitude: number): number {
  const d = (t - at) / HEARTBEAT_WIDTH;
  return amplitude * Math.exp(-d * d);
}

/**
 * The pulse, as a scale multiplier around 1 (spec 156).
 *
 * Two beats per cycle, the second smaller and close behind the first, which is
 * what makes it read as a heart rather than as a blink -- lub-dub, then quiet
 * for most of the second. Phased off `spawnTick` rather than off any local
 * clock, so every client's copy of the same drop beats together.
 *
 * Exactly 1 for a tier with no pulse, so "common loot does not move" needs no
 * branch at the call site.
 */
export function heartbeatAt(drop: DropView, tick: number): number {
  if (!rarityRow(drop.rarity).heartbeat) return 1;
  const since = tick - drop.spawnTick;
  if (!(since >= 0)) return 1;
  const t = since % HEARTBEAT_TICKS;
  // The dub of the *previous* cycle can still be decaying into this one, so the
  // wrap is summed rather than cut -- otherwise every cycle starts with a seam.
  const beat =
    thump(t, 0, 1) +
    thump(t, HEARTBEAT_TICKS, 1) +
    thump(t, HEARTBEAT_DUB_AT, 0.55);
  return 1 + HEARTBEAT_SCALE * Math.min(1, beat);
}

/**
 * How far the tier's colour has arrived, 0..1 (spec 156).
 *
 * Zero for the whole of `Spawned` and `Anticipation`, which is the correction
 * this spec needed: colouring a drop by its tier from the first frame answers
 * the question the reveal exists to ask. A common drop's mix is 1 immediately
 * and it does not matter, because its tier colour *is* the neutral one.
 */
export function tierMixAt(drop: DropView, tick: number): number {
  if (tick < drop.revealTick) return 0;
  return smooth((tick - drop.revealTick) / TIER_BLEND_TICKS);
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

  read(drop: DropView, landing: Vec3Like, tick: number): DropPresentation {
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
      position: tossAt(drop, landing, tick),
      tierMix: tierMixAt(drop, tick),
      beat: heartbeatAt(drop, tick),
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
