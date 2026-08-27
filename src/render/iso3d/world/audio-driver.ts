/**
 * What the Play tab hears, frame by frame (spec 229).
 *
 * Pure -- no Web Audio, no three.js, no DOM, no `GameClient`. It is handed an
 * {@link Audio} (an interface, and `SILENT_AUDIO` in Node) plus replicated facts,
 * and it decides what to play. That is the same shape `ShotVfx` has and it buys
 * the same thing: the whole audio layer can be driven in `npm test` against a
 * recording fake, so "does a swing make one sound or two" is an assertion rather
 * than something judged by ear in a browser.
 *
 * ## Two kinds of sound, and they need different machinery
 *
 * `auras.ts` draws the line in one sentence -- *"a hit happens; a poison lasts"*
 * -- and both are here.
 *
 * A **hit** needs an *edge*: something has to notice that this frame differs from
 * the last. A blow arrives as a callback and is an edge already; a stagger does
 * not (`poiseBroken` never reaches the wire, so it is knowable only as
 * `activity === Stunned && tick < activityUntilTick`) and gets the same
 * previous-read track `StaggerFlinches` keeps, for the same stated reason: the
 * window is many ticks long and firing on each of them is a machine gun.
 *
 * A **state** needs a *handle*: an ember in flight and a body carrying a fire
 * field are started once, stopped once, and nothing in between. Those follow the
 * three rules spec 215 and spec 218 learned, and they are not optional:
 *
 * - **Handles, not ids.** `hold` returns `NO_HANDLE` on refusal -- an unassigned
 *   row, no context yet, over the voice cap, past the cull. A driver holding an
 *   id could not tell "asked for, did not start" from "started", so a shot
 *   refused on the frame it spawned would fly the rest of its life silent.
 * - **Ask every frame.** A handle can go stale on its own; `isLive` is the only
 *   honest question.
 * - **The stop is owed.** Nothing in the engine stops a loop when the body it
 *   was about goes away. {@link AudioDriver.forget} is called from the sweep that
 *   already knows, never inferred from an absence.
 *
 * ## What it deliberately does not do
 *
 * It does not read the clock, so a test drives it by handing it ticks. It does
 * not decide *which file* -- `audio-wire.ts` maps facts to event ids and the
 * catalog maps ids to files. And no `if` in it changes a game outcome, which is
 * the standing rule for `src/render/` and here is the whole contract.
 */

import type { Audio, AudioHandle, ListenerPose, PlayOptions } from '../../audio/sink.js';
import type { SoundEventId } from '../../audio/events.js';
import { isSoundEventId } from '../../audio/events.js';
import {
  soundForAfflictionTick,
  soundForEffect,
  soundForProjectile,
  soundForProjectileImpact,
  soundForProjectileLaunch,
  soundForWindup,
  soundsForBlow,
  type BlowFacts,
} from './audio-wire.js';
import type { WeaponType } from './weapon-look.js';
import { Footsteps } from './footsteps.js';

/** `EntityActivity` values this cares about. Copied rather than imported: see below. */
const ACTIVITY_STUNNED = 3;
const ACTIVITY_DEAD = 4;

/**
 * How high above a body's feet a sound about that body is placed.
 *
 * About half a body (`DEFAULT_CANONICAL_HEIGHT` is 55.65), which is where the
 * listener sits too -- so a body standing next to you is level with your ears
 * rather than at your shins. It matters less than it looks: with the listener at
 * the same height, a 30-unit vertical offset on a source 200 units away moves
 * the distance by two percent.
 */
export const BODY_SOUND_HEIGHT = 30;

/** What the driver needs to know about one body this frame. Facts, not objects. */
export interface AudioBody {
  readonly entityId: number;
  /** World X. */
  readonly x: number;
  /** World Z -- the sim's second axis, which its `Vec2` calls `y`. */
  readonly z: number;
  /** The ground under it. */
  readonly ground: number;
  readonly activity: number;
  readonly activityUntilTick: number;
  /** True for anything with legs. False for a projectile, a drop, a mote, a prop. */
  readonly walks: boolean;
  /** A projectile's look (`'ember'`, `'arrow'`, ...), or null for anything else. */
  readonly projectileLook: string | null;
  /** Whether this body is carrying an aura field (spec 223). */
  readonly field: boolean;
}

interface Track {
  /** Whether the body was inside a stagger window at the last read. */
  broken: boolean;
  /** The loop this body is carrying because of what it is, or 0. */
  loop: AudioHandle;
  /** Which event {@link loop} is playing, so a change of state can restart it. */
  loopId: SoundEventId | null;
  seen: boolean;
  /**
   * The impact this body owes when it stops existing, or null.
   *
   * A shot's landing has to be played from the sweep, which is the one place
   * that knows a body has gone -- and the sweep is handed an id and nothing
   * else. So the *decision* is taken on first sight, when the look is in hand,
   * and the position is refreshed every frame; what is left at the end is where
   * it was last seen, which is where it stopped.
   */
  endsWith: SoundEventId | null;
  /** Where it was last seen, for {@link endsWith}. */
  at: PlayOptions;
}

export class AudioDriver {
  private readonly footsteps = new Footsteps();
  private readonly tracks = new Map<number, Track>();
  /** The world's ambient bed, or 0. See {@link ambience}. */
  private bed: AudioHandle = 0;

  constructor(private readonly audio: Audio) {}

  // --- the frame ---------------------------------------------------------

  /**
   * Where the ears are this frame.
   *
   * Separate from {@link body} because it must happen whether or not there is
   * anything to hear, and *before* anything is played: a voice allocated against
   * last frame's listener is a voice panned to where the camera used to be.
   */
  listener(pose: ListenerPose): void {
    this.audio.setListener(pose);
  }

  /**
   * One body, once a frame.
   *
   * Called from the loop that already walks the replicated entities, so nothing
   * is allocated per frame and "since the last read" means "since the last frame
   * this body was in the world".
   */
  body(body: AudioBody, drawnTick: number): void {
    const at: PlayOptions = { x: body.x, y: body.ground + BODY_SOUND_HEIGHT, z: body.z };

    let track = this.tracks.get(body.entityId);
    if (!track) {
      track = { broken: false, loop: 0, loopId: null, seen: true, endsWith: null, at };
      this.tracks.set(body.entityId, track);
      // --- the loose ------------------------------------------------------
      //
      // A physical projectile's first frame is the frame it was thrown on: the
      // server creates the entity at the release tick, so first sight *is* the
      // release and there is no separate message to wait for. Decided here, on
      // the one frame the look is known to be new, rather than by asking every
      // frame whether this is still the first one.
      const look = body.projectileLook ?? '';
      const launch = soundForProjectileLaunch(look);
      if (launch !== null) this.audio.play(launch, at);
      track.endsWith = soundForProjectileImpact(look);
      // First sight is never an edge. A body that walks into view already
      // staggered is not a break somebody watched land -- the rule
      // `StaggerFlinches` states, and the same one that stops a reconnect
      // mid-fight from replaying every contact of the last ten seconds.
      track.broken = body.activity === ACTIVITY_STUNNED && drawnTick < body.activityUntilTick;
    }
    track.seen = true;
    track.at = at;

    // --- the edge: a guard breaking ---------------------------------------
    const broken = body.activity === ACTIVITY_STUNNED && drawnTick < body.activityUntilTick;
    if (broken && !track.broken) this.audio.play('combat.stagger', at);
    track.broken = broken;

    // --- the state: what this body is carrying ----------------------------
    // One loop per body, because a body is one thing at a time and two held
    // sounds on one entity is a mix nobody authored. Which one it is comes from
    // what the body *is* (a projectile) before what it *has* (a field), since a
    // burning projectile is a projectile.
    const wanted =
      soundForProjectile(body.projectileLook ?? '') ?? (body.field ? 'elemental.fire.field' : null);
    this.hold(track, wanted, at);

    // --- the accumulator: legs --------------------------------------------
    if (
      body.walks &&
      this.footsteps.step({
        entityId: body.entityId,
        x: body.x,
        z: body.z,
        // A stagger roots the legs and a corpse has none, but the body is still
        // being shoved around by `resolveCrowding` -- so it covers ground and
        // must not bank it.
        walks: body.activity !== ACTIVITY_STUNNED && body.activity !== ACTIVITY_DEAD,
      })
    ) {
      this.audio.play('player.footstep', { x: body.x, y: body.ground, z: body.z });
    }
  }

  /**
   * Everything not seen this frame lets go of what it was holding.
   *
   * Called once, after every body has been offered. This is the "owed stop": a
   * loop whose body has left is a voice that plays until the tab closes, because
   * nothing in the engine notices an absence.
   */
  sweep(): void {
    for (const [id, track] of this.tracks) {
      if (track.seen) {
        track.seen = false;
        continue;
      }
      this.end(track);
      this.tracks.delete(id);
    }
    this.footsteps.sweep();
  }

  /** A body has gone. Called from the despawn sweep that already knows. */
  forget(entityId: number): void {
    const track = this.tracks.get(entityId);
    if (track) this.end(track);
    this.tracks.delete(entityId);
    this.footsteps.forget(entityId);
  }

  /**
   * A body has left: drop what it was holding, and play what it owed.
   *
   * One function because there are two doors out -- the sweep and an explicit
   * `forget` -- and a shot that only made a sound through one of them would be
   * an arrow that lands audibly or silently depending on which pass noticed
   * first. Neither can fire twice, because both delete the track.
   */
  private end(track: Track): void {
    if (track.loop !== 0) this.audio.stop(track.loop);
    if (track.endsWith !== null) this.audio.play(track.endsWith, track.at);
  }

  /** Leaving the tab. Every held loop stopped and every accumulator cleared. */
  stopAll(): void {
    // Deliberately not `end`: leaving the tab is not a dozen arrows landing at
    // once. An owed impact is owed to a body that stopped travelling, and this
    // is the listener stopping instead.
    for (const track of this.tracks.values()) if (track.loop !== 0) this.audio.stop(track.loop);
    if (this.bed !== 0) this.audio.stop(this.bed);
    this.bed = 0;
    this.tracks.clear();
    this.footsteps.clear();
    this.audio.stopAll();
  }

  private hold(track: Track, wanted: SoundEventId | null, at: PlayOptions): void {
    if (wanted === null) {
      if (track.loop !== 0) this.audio.stop(track.loop);
      track.loop = 0;
      track.loopId = null;
      return;
    }
    if (track.loopId !== wanted && track.loop !== 0) {
      this.audio.stop(track.loop);
      track.loop = 0;
    }
    track.loopId = wanted;
    // Asked every frame, because a handle can go stale on its own -- see the
    // header. A refusal leaves it at 0 and the next frame tries again, which is
    // exactly what makes "the pressure lifted" recoverable.
    if (track.loop !== 0 && !this.audio.isLive(track.loop)) track.loop = 0;
    if (track.loop === 0) track.loop = this.audio.hold(wanted, at);
    else this.audio.move(track.loop, at);
  }

  // --- the edges that arrive as callbacks --------------------------------

  /** A blow, a heal, or an affliction's beat. Straight through `soundsForBlow`. */
  blow(facts: BlowFacts): void {
    for (const request of soundsForBlow(facts)) {
      this.audio.play(request.id, {
        x: request.x,
        y: request.y,
        z: request.z,
        ...(request.gain === undefined ? {} : { gain: request.gain }),
      });
    }
  }

  /**
   * A wind-up begins.
   *
   * At the wind-up rather than the contact, which is the whole point: this game
   * is built on a blow being long enough to read and withdraw from, and a swing
   * that makes no sound until it lands has no tell.
   */
  windup(
    abilityId: string,
    isHeavy: boolean,
    at: PlayOptions,
    projectileLook: string | null = null,
    weaponType: WeaponType | null = null,
  ): void {
    const id = soundForWindup(abilityId, isHeavy, projectileLook, weaponType);
    if (id !== null) this.audio.play(id, at);
  }

  /**
   * The server's own point cue.
   *
   * `effectId` is `${ability.id}.impact`, and it is the only place an ability id
   * reaches the client at impact time -- so it is where an element's impact
   * comes from. See `audio-wire.ts`'s header.
   */
  serverEffect(effectId: string, at: PlayOptions): void {
    const id = soundForEffect(effectId);
    if (id !== null) this.audio.play(id, at);
  }

  /**
   * One beat of an affliction.
   *
   * Driven from wherever already derives the beat, not from the blow: an
   * affliction's damage arrives as a `Periodic` blow whose attacker walked off
   * seconds ago, and `soundsForBlow` refuses it for exactly that reason.
   */
  afflictionTick(dotId: string, at: PlayOptions): void {
    const id = soundForAfflictionTick(dotId);
    if (id !== null) this.audio.play(id, at);
  }

  /**
   * A **name**, from a table that is not ours.
   *
   * Two seams in this repo emit sound cues as strings and had nothing to hand
   * them to: `RARITIES[].cues` (spec 158, *"the renderer decides what a name
   * sounds and looks like"*) and `VfxHooks.sound` (spec 121, whose comment says
   * *"a sink today; there is no audio system to wire it to"*). Both go through
   * here, and the guard is the whole of the integration: a cue that does not
   * name a row in `events.ts` is silence, exactly as `vfx.system.has(cue)`
   * already makes an unauthored cue draw nothing.
   */
  cue(name: string, at: PlayOptions): void {
    if (isSoundEventId(name)) this.audio.play(name, at);
  }

  /** Anything the interface asks for, and anything with no place in the world. */
  flat(id: SoundEventId): void {
    this.audio.play(id);
  }

  /**
   * The map's ambient bed, held for as long as the tab is showing (spec 229).
   *
   * Called every frame and idempotent, which is the same three rules the
   * per-body loops follow and is here for the third one especially: `hold`
   * answers `NO_HANDLE` when the row has no file, when the context does not
   * exist yet, or when the buffer has not decoded -- all three of which are true
   * for the first second of every session -- so a driver that started it once
   * would have a bed that never came on. Asking each frame costs a comparison
   * and turns every one of those into "not yet".
   *
   * `ambience.world` ships **unassigned**, and that is the point rather than an
   * omission: this library has no bed in it and inventing one out of a combat
   * pack would be worse than silence. With this wired, adding one is a file
   * assignment in the SFX tab -- which is the whole promise of the split between
   * the vocabulary and the catalog.
   */
  ambience(): void {
    if (this.bed !== 0 && !this.audio.isLive(this.bed)) this.bed = 0;
    if (this.bed === 0) this.bed = this.audio.hold('ambience.world');
  }

  /** How many bodies are tracked. For the readout, and as a leak check in a test. */
  get tracked(): number {
    return this.tracks.size;
  }
}
