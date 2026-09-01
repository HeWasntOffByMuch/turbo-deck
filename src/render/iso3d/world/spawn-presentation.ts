/**
 * What a body's arrival looks like (spec 263).
 *
 * Nothing in this game arrives. A monster is a coordinate that did not have a
 * body on it and does on the next frame, and a player who presses Respawn is
 * standing on the pad between one frame and the next. Every other moment that
 * matters here has a picture -- a blow throws paint, a break rocks the body, an
 * item is thrown and withholds itself -- and the one moment a body enters the
 * world has none.
 *
 * Two presentations and no more:
 *
 *  - **generic**, a quick white poof at the spot, for everything.
 *  - **burrow**, for the spider and the Warden, which share the mech rig and so
 *    share this: the ground is disturbed, the legs come out first, and the legs
 *    pull the body up out of the hole.
 *
 * ## The two ways an arrival is noticed, and why they are different
 *
 * **A spawn is told and a respawn is watched**, and that is not an
 * inconsistency -- it is what the two events actually are.
 *
 * A body being *created* cannot be seen from here. `EntityField.Spawn` is set
 * "the first time an entity enters this client's interest set", which fires the
 * same way for a monster made a moment ago and for one the player has spent a
 * minute walking toward; drawing an arrival off that bit would poof every body
 * on the map as the player approached it. So the server records
 * {@link ReplicatedEntity.spawnTick} and this compares it against the clock,
 * which is `LootDrop`'s decision verbatim and for its stated reason: a client's
 * own "when did I first see this" would restart an arrival for somebody who
 * turned up halfway through one.
 *
 * A *respawn* is the other way round. `GameServer.respawn` heals and moves the
 * body it already has -- no body is created, the id survives, the `Spawn` field
 * is not re-sent, and the only thing another player's client is told is an
 * ordinary position-and-health delta. So this reads the edge it watched, which
 * is `stagger-flinch.ts`'s rule -- **the window is replicated, the start is
 * observed** -- with the same consequence: a client that arrives after somebody
 * else's respawn draws nothing, and that is right rather than a gap. The margin
 * runs the way spec 158's loot pop runs it. A missed arrival on a body nobody
 * was watching costs nothing; an arrival drawn for a body that has been
 * standing there is the screen reporting something that did not happen.
 *
 * ## What it does not do
 *
 * **It never holds the body.** There is no spawn state on `ServerEntity` and
 * this does not add one: a body is targetable, can move and can attack on
 * exactly the tick it always could. What this owns is a vertical offset added
 * to the drawn transform and nothing else, so the presentation yields to
 * gameplay rather than the other way round -- see {@link SpawnBody.committed}.
 *
 * Pure: no three.js and no DOM. `scene.ts` adds what this returns to the drawn
 * transform and decides nothing itself.
 */

import { EntityActivity, EntityKind } from '../../../server/net/protocol.js';
import type { Appearance } from './appearance.js';
import { monsterCritterFor } from './monster-critter.js';
import { BURROW_DIRT_TICKS } from '../vfx/brush.js';

export type SpawnStyle = 'generic' | 'burrow';

/**
 * How stale a `spawnTick` may be and still be an arrival, in ticks.
 *
 * Half a second, and it is a *latency* allowance rather than a look decision:
 * the first delta carrying a body is up to a broadcast interval behind the tick
 * it was made on, the wire adds its own, and `interpolate.ts` deliberately
 * draws remote bodies `PLAYBACK_DELAY_TICKS` in the past. Everything that is
 * genuinely an arrival lands well inside this; the case it exists to refuse --
 * a body walking into interest range -- is seconds or minutes old, so the two
 * are nowhere near each other and the exact number is not delicate.
 */
export const ARRIVAL_GRACE_TICKS = 30;

/**
 * How long an emergence takes, in ticks.
 *
 * Three quarters of a second, which is about a Warden's lock-on and rather less
 * than a slow weapon's swing -- long enough to read as three movements and
 * short enough that a body is never out of the fight for it. The dirt is
 * authored to exactly this, and that equality is asserted rather than trusted.
 */
export const BURROW_TICKS = BURROW_DIRT_TICKS;

/**
 * When the legs break the surface, and when they stop digging, as fractions of
 * {@link BURROW_TICKS}.
 *
 * The staging:
 *
 * ```
 * 0 ......... FEET_OUT ......... DIG_UNTIL ............... 1
 * under        legs break         knees arch,          standing
 * (dirt)       the surface        body breaks it
 * ```
 *
 * What makes the first stage read as *being pushed up* rather than as being
 * translated is that the body's own height above the ground does not change at
 * all across it: `buried` gives the depth up as the feet rise and `bodyDrop`
 * takes exactly as much back, so the only thing that moves is the legs.
 */
export const FEET_OUT = 0.26;
export const DIG_UNTIL = 0.55;

/**
 * How far the body is still dropped at the end of the dig, 0..1.
 *
 * The one number here that was **measured rather than chosen**, and the whole
 * of what separates a readable emergence from a hole with two stubs beside it.
 *
 * A leg has a fixed reach, so how far a knee can arch above the ground is
 * decided by how much slack is left after it has spanned from a sunken hip to a
 * planted foot -- and at a drop deep enough to hide the body outright there is
 * almost none. Photographed through `preview-emergence.ts` at the full depth,
 * every leg on both bodies came out straight: the small spider's knees cleared
 * the ground by about a unit and the Warden's did not clear it at all, so the
 * stage whose entire job is *legs, no body yet* drew nothing on the larger of
 * the two bodies.
 *
 * At 0.78 the small spider's knees stand about seven units clear and *above the
 * top of its own body*, so what is over the ground through the dig is legs
 * arching over a shoulder. What it costs is that the body's top edge breaks the
 * surface during the dig instead of staying under it, which is the right trade
 * and arguably the better picture: a thing clawing out of a hole is not
 * invisible.
 *
 * It is also what stops the dig being a **pause**. Held at the full depth the
 * middle stage was two identical frames -- the legs had arrived and nothing
 * moved until the body came up -- where now the knees rise through the whole of
 * it, which is what "the feet push against the ground" has to look like.
 *
 * **What it cannot fix is the Warden**, and that is a proportion rather than a
 * tuning failure worth recording. Its reach is 60 against a 34-unit foot offset
 * and a body 56 tall, so `D + knee(D)` never reaches the body's own height at
 * any drop: there is no value of this constant at which the Warden's body is
 * hidden and any part of its leg is above the ground. It is a box on short
 * legs, and it heaves up with its shoulders and its knees together where the
 * spider leads with its legs. The staging is tuned to the spider for that
 * reason -- the reading it can achieve -- and the Warden gets as much of it as
 * its own body allows.
 */
export const DIG_DROP = 0.78;

/** What to add to one body's drawn transform this frame. */
export interface SpawnStage {
  readonly style: SpawnStyle;
  /**
   * True on the one frame the effect is fired.
   *
   * An edge rather than a level, the way `swing-vfx.ts` paints a sweep: both
   * effects are one-shots that retire themselves, so what a caller owes is a
   * single `play` and never a stop.
   */
  readonly began: boolean;
  /** 0..1 through the arrival. 1 for a body that has arrived. */
  readonly phase: number;
  /**
   * How far under its own hidden depth the whole rig sits, 0..1.
   *
   * Multiplied by `MechRig.hiddenDepth` and *subtracted from the ground* by the
   * scene, so it moves the feet along with everything else -- this is the body
   * being under the ground rather than inside it.
   */
  readonly buried: number;
  /** How far the body is dropped below its own legs, 0..1. `MechRig.burrow`. */
  readonly bodyDrop: number;
}

/** A body that has arrived, or one that never had an arrival to draw. */
export const SETTLED: SpawnStage = {
  style: 'generic',
  began: false,
  phase: 1,
  buried: 0,
  bodyDrop: 0,
};

/** What this reads off a body each frame. */
export interface SpawnBody {
  readonly id: number;
  readonly style: SpawnStyle;
  /** {@link ReplicatedEntity.spawnTick}: when the server made this body. */
  readonly spawnTick: number;
  /** At or below zero health this frame. */
  readonly dead: boolean;
  /**
   * Whether the body is committed to something the player must be able to see.
   *
   * The whole of "a unit does not attack from under the ground", and it is a
   * *yield* rather than a lock: an arrival that meets one settles on the spot,
   * so the body is at the surface on the frame it commits. That is the right
   * way round -- the server decides what a body is doing and this decides what
   * that looks like, never the reverse.
   *
   * Walking is deliberately **not** committed. A monster's idle plan sets off on
   * its second tick (`sim/idle.ts`), so a rule that yielded to movement would be
   * a rule under which the emergence never plays at all; and the offsets below
   * are added to the body's *drawn* position every frame, so a body that walks
   * during its arrival comes up as it goes rather than sliding out of its own
   * hole.
   */
  readonly committed: boolean;
}

/** Whether an activity is a commitment an arrival must get out of the way of. */
export function isCommitted(activity: number): boolean {
  return activity === EntityActivity.Casting;
}

/**
 * Which arrival a body draws.
 *
 * `burrow` is the mech rig and only the mech rig, which is the whole of why the
 * spider and the Warden share a presentation: they share a rig, and it is the
 * one rig in this renderer with **world-locked feet** -- `MechRig.stabilise`
 * draws each leg from a hip carried through the carriage to a foot that is
 * independent of it, so the body can be pushed down while the feet stay
 * planted. `Humanoid.poseLegs` is sine-driven bone rotation of one skeleton
 * with no plant to hold, so an emergence is not expressible on the critter rig,
 * and an authored unit would need a clip nobody has authored.
 *
 * The rule rather than a list of type ids: this is `bodyFor`'s own construction
 * chain read back, so a spider given a critter row or an authored unit stops
 * burrowing without anybody remembering to edit a table here.
 *
 * `authored` is passed in rather than looked up, and that is not a courtesy to
 * the caller. `unit-catalog.ts` reaches the asset registry, which is a
 * `import.meta.glob` and therefore exists only under a bundler -- importing it
 * would make this module unloadable from a plain script, which is what the
 * preview that photographs the emergence is. It is also the *same* call
 * `bodyFor` makes to decide the rig, so the two cannot come to different
 * answers about a unit this build has not baked.
 */
export function spawnStyleFor(appearance: Appearance, authored: boolean): SpawnStyle {
  if (appearance.rig !== 'monster') return 'generic';
  if (authored) return 'generic';
  return monsterCritterFor(appearance.typeId) === null ? 'burrow' : 'generic';
}

/**
 * Whether a body's kind is one that arrives at all.
 *
 * A projectile, a prop, a drop and a mote all carry their own entrance already
 * -- a shot is drawn flying, a drop is *thrown* and withholds itself (spec 158),
 * a mote hops (spec 156) -- and a poof under each of them would be a second
 * answer to a question those already answer better.
 */
export function arrives(kind: number): boolean {
  return kind === EntityKind.Player || kind === EntityKind.Monster;
}

/** How long a track is kept after its arrival is over, in ticks. */
const TRACK_KEEP_TICKS = 4;

interface Track {
  /** The drawn tick the arrival began on, or null once it is over. */
  since: number | null;
  /** Whether this body was at zero health when last read. */
  dead: boolean;
  /** The `spawnTick` this body was last seen with, so a reused id re-arrives. */
  spawnTick: number;
}

/**
 * One arrival per body, tracked across frames.
 *
 * The same shape as {@link StaggerFlinches} and for its reason: half of what
 * this answers is "changed since the last time this body was read", which only
 * something holding the previous read can say.
 */
export class SpawnPresentations {
  private readonly tracks = new Map<number, Track>();

  /** How many bodies are being tracked. Diagnostics, and a leak check. */
  get tracked(): number {
    return this.tracks.size;
  }

  /**
   * Read one body's arrival, and notice one that has started since the last
   * read.
   *
   * Called once per body per frame from the loop that draws them, so "since the
   * last read" is "since the last frame this body was on screen". Idempotent:
   * the same facts on the next frame begin nothing.
   */
  read(body: SpawnBody, drawnTick: number): SpawnStage {
    const now = Number.isFinite(drawnTick) ? drawnTick : 0;
    const spawnTick = Number.isFinite(body.spawnTick) ? body.spawnTick : 0;
    const track = this.tracks.get(body.id);

    if (!track) {
      // First sight. An arrival only if the server says this body was made just
      // now -- anything older is a body walking into range, which is the whole
      // case `spawnTick` exists to separate. A body seen first *dead* is a
      // corpse whether it was made a moment ago or not.
      const fresh = !body.dead && isRecent(spawnTick, now);
      const since = fresh && !body.committed ? now : null;
      this.tracks.set(body.id, { since, dead: body.dead, spawnTick });
      return since === null ? SETTLED : this.stageAt(body.style, since, now, true);
    }

    // A respawn: the body this client watched die is alive again. Watched
    // rather than told, because nothing on the wire says so -- the entity is
    // reused, so there is no second `Spawn` field to carry a fresh tick.
    //
    // `spawnTick` moving is the other door into the same state and covers an id
    // the server has reused for a different body: the client would otherwise
    // hold a track that outlives the body it describes.
    const revived = track.dead && !body.dead;
    const remade = spawnTick !== track.spawnTick && isRecent(spawnTick, now);
    let began = false;
    if ((revived || remade) && !body.committed) {
      track.since = now;
      began = true;
    }
    track.dead = body.dead;
    track.spawnTick = spawnTick;

    if (track.since === null) return SETTLED;

    // The yield. A body that has died or committed to something is a body the
    // player has to be able to see, so the arrival ends where it stands rather
    // than holding a corpse or a swing under the ground.
    if (body.dead || body.committed) {
      track.since = null;
      return SETTLED;
    }

    const stage = this.stageAt(body.style, track.since, now, began);
    // Kept a few frames past the end rather than dropped on the tick it
    // finishes, so `dead` and `spawnTick` survive for the respawn edge above --
    // dropping the track here would make the next respawn read as a first
    // sight, and a first sight of a body with an old `spawnTick` draws nothing.
    if (stage.phase >= 1 && now - track.since > this.lengthOf(body.style) + TRACK_KEEP_TICKS) {
      track.since = null;
    }
    return stage;
  }

  /**
   * A body has gone.
   *
   * Called from the despawn sweep that already knows, never inferred from an
   * absence: a body simply missing from one frame's list is one outside interest
   * range, and forgetting it there would replay its arrival when it came back --
   * which `spawnTick` would refuse anyway, but the track is also what remembers
   * that this body was lying dead.
   */
  forget(id: number): void {
    this.tracks.delete(id);
  }

  /**
   * Keeps only the bodies still in the world, the shape `TurnEase` and
   * `StaggerFlinches` use. A per-entity map in a render loop is a leak unless
   * something prunes it.
   */
  retain(live: ReadonlySet<number>): void {
    for (const id of this.tracks.keys()) if (!live.has(id)) this.tracks.delete(id);
  }

  private lengthOf(style: SpawnStyle): number {
    return style === 'burrow' ? BURROW_TICKS : 1;
  }

  private stageAt(style: SpawnStyle, since: number, now: number, began: boolean): SpawnStage {
    if (style !== 'burrow') {
      // Nothing to stage. The poof is the whole presentation and it is fired on
      // the frame it begins; the body is drawn exactly as it always is, which
      // is what "the unit appears in coordination with the smoke" means when
      // the rig has no emergence in it.
      return { style, began, phase: 1, buried: 0, bodyDrop: 0 };
    }
    const phase = clamp01((now - since) / BURROW_TICKS);
    return { style, began, phase, buried: buriedAt(phase), bodyDrop: bodyDropAt(phase) };
  }
}

/** How far under the ground the whole rig sits at this point in the emergence. */
export function buriedAt(phase: number): number {
  const p = clamp01(phase);
  if (p >= FEET_OUT) return 0;
  // The legs coming out. Eased so the first thing that happens is slow -- the
  // ground being broken rather than a body being ejected from it.
  return 1 - smoothstep(p / FEET_OUT);
}

/** How far the body is dropped below its own legs at this point. */
export function bodyDropAt(phase: number): number {
  const p = clamp01(phase);
  // Rising exactly as fast as `buriedAt` falls, so the body's own height above
  // the ground does not change at all while the legs come out. This is the
  // whole of "the feet emerge first".
  if (p < FEET_OUT) return smoothstep(p / FEET_OUT);
  // The dig. The legs are planted and take up their slack, which arches the
  // knees clear of the ground -- see {@link DIG_DROP} for why this moves at all
  // rather than holding at the full depth.
  if (p < DIG_UNTIL) {
    // Eased *in* rather than smoothly, which is the difference between a body
    // that heaves and one that floats: the drop barely moves for the first half
    // of the dig, so there is a real window of legs-out-and-nothing-else before
    // the shoulders break the surface, and then it accelerates into the push.
    // It is that window rather than a fourth stage with a constant to name.
    const t = (p - FEET_OUT) / (DIG_UNTIL - FEET_OUT);
    return 1 - (1 - DIG_DROP) * t * t;
  }
  // The push. The legs straighten under it and the body comes up to standing.
  return DIG_DROP * (1 - smoothstep((p - DIG_UNTIL) / (1 - DIG_UNTIL)));
}

/**
 * Whether a spawn tick is recent enough to be an arrival rather than a body
 * this client has walked up to.
 *
 * **Symmetric**, and the negative half is the one that had to be thought about:
 * `estimatedTick` is a forward-biased ratchet that adds half the measured round
 * trip, so it usually *leads* the server -- but before the first round trip is
 * measured it can sit behind, which is exactly the moment the local player's own
 * body is created. A one-sided `now >= spawnTick` would drop that arrival in
 * silence, and it is the one every session opens with.
 *
 * Nothing is lost by allowing it: the case this exists to refuse is a body
 * walking into interest range, whose spawn tick is seconds or minutes old, so
 * the two are nowhere near a window measured in half a second.
 */
function isRecent(spawnTick: number, now: number): boolean {
  return Math.abs(now - spawnTick) <= ARRIVAL_GRACE_TICKS;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The one easing here: slow off both ends, which is what effort looks like. */
function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Which effect an arrival fires. */
export function spawnEffectFor(style: SpawnStyle): string {
  return style === 'burrow' ? 'spawn_burrow_dirt' : 'spawn_poof';
}

/**
 * How much wider than the body its arrival is drawn.
 *
 * Both effects author their lengths in *effect radii*, `brushFire`'s convention,
 * so what a caller supplies is a length rather than a multiplier. Half again
 * over the body: a cloud exactly as wide as what came out of it reads as part
 * of the body, and one much wider reads as a blast.
 */
export const SPAWN_EFFECT_SPREAD = 1.6;

/** The scale to play an arrival at, for a body of this radius. */
export function spawnEffectScale(radius: number): number {
  // Floored rather than trusted: `radius` comes off an appearance table and a
  // zero would collapse every mark in the effect to nothing, which is a silent
  // arrival rather than a visible mistake.
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  return r * SPAWN_EFFECT_SPREAD;
}

/**
 * A seed that is a function of *which body* and *when*, so two clients watching
 * one arrival watch the same one.
 *
 * `spawnTick` rather than the drawn tick, because the drawn tick differs
 * between two clients by their own latency -- and it falls back to the drawn
 * one for a respawn, which has no fresh spawn tick to key on and is the one
 * arrival that can happen twice on the same id.
 */
export function spawnSeed(entityId: number, spawnTick: number, drawnTick: number): number {
  const when = Number.isFinite(spawnTick) && spawnTick > 0 ? spawnTick : drawnTick;
  return (
    (Math.imul(entityId | 0, 73856093) ^ Math.imul((when | 0) + 1, 19349663)) | 0
  );
}
