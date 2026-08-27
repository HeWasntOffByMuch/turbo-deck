/**
 * What everything above the engine talks to (spec 229).
 *
 * Pure -- no Web Audio, no DOM, no clock. The types a caller needs, the handle
 * a driver holds, and a sink that does nothing.
 *
 * The split is `src/ui/core/sound.ts`'s, one layer up and for the same two
 * reasons. **A driver can be tested in Node**: every audio driver in the Play
 * tab takes an `Audio` and is exercised against a recording fake in `npm test`,
 * where an `AudioContext` does not exist. And **there is no optional engine**:
 * `createAudioEngine` answers `SILENT_AUDIO` where there is no Web Audio, so
 * every call site takes a non-nullable `Audio` -- an optional one and a `?.` at
 * thirty call sites is thirty chances to forget one, and the one that gets
 * forgotten is always the one added next.
 */

import type { BusId, SoundEventId } from './events.js';
import type { SoundCatalog } from './catalog.js';
import type { AudioMix } from './mix.js';

/**
 * Where the ears are.
 *
 * `forward` and `up` are unit vectors in world space. **Not the camera's
 * position**: this camera is orthographic and parks 6,000 units back, so a
 * listener mounted on it would put every source in the game at the same
 * distance in the same direction -- the identical failure `scene.ts` already
 * documents for the animation LOD and for the distance ink, both of which
 * rebased onto the focus for exactly this reason.
 */
export interface ListenerPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly forward: { readonly x: number; readonly y: number; readonly z: number };
  readonly up: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * Where a sound is, if anywhere.
 *
 * `x` and `z` are the world's horizontal axes and `y` is height, which is the
 * three.js convention and **not** the sim's: the sim is 2D and its `Vec2 {x, y}`
 * is world `(x, z)`. The field is named `z` here so that handing a sim point
 * straight in is a type error rather than a game whose every sound is mirrored
 * across the diagonal -- which at the default 45-degree camera azimuth is
 * precisely a left/right swap, and is the kind of bug that survives a playtest.
 */
export interface PlayOptions {
  readonly x?: number;
  /** Height. Defaults to the listener's own, so a caller with only a ground point is level with the ears. */
  readonly y?: number;
  readonly z?: number;
  /** Multiplied into the catalog's volume. For a blow that was bigger than usual. */
  readonly gain?: number;
  /** Multiplied into the drawn playback rate. For a variation the catalog cannot know about. */
  readonly rate?: number;
}

/**
 * A live looping sound.
 *
 * A number rather than an object, and generation-tagged, for the reason
 * `vfx/system.ts` returns one: a driver that holds an *id* cannot tell "asked
 * for, refused" from "playing", and a driver that holds an *object* keeps a
 * dead node alive. 0 is always dead, so a refusal needs no special case at the
 * call site.
 */
export type AudioHandle = number;
export const NO_HANDLE: AudioHandle = 0;

export type AudioState = 'unsupported' | 'idle' | 'running' | 'suspended';

/** What the readout shows. Numbers only -- nothing here decides anything. */
export interface AudioStats {
  readonly state: AudioState;
  readonly voices: number;
  readonly held: number;
  readonly buffers: number;
  readonly loading: number;
  /** Sounds that wanted to play and did not, since the last frame that read this. */
  readonly refused: number;
  readonly missing: number;
  /**
   * How many voices each event has actually **started**, for the session.
   *
   * Counted where `source.start()` is called rather than where `play` is, and
   * that distinction is the whole reason it exists: everything in this layer is
   * green in Node beside a mount that might call none of it, which is exactly
   * what spec 176 found for map markers. A probe reading what was *asked for*
   * would report a working game for a `view.ts` that asks and an engine that
   * refuses; reading what started reports the truth.
   */
  readonly started: Readonly<Record<string, number>>;
}

/**
 * Somewhere to build a procedural voice (spec 244).
 *
 * The one hole in this otherwise closed surface, and it is deliberately shaped
 * so that it is not a hole in the *mix*: `into` is a bus gain node, so a
 * dialogue voice is scaled by its bus and by master and is silenced by mute,
 * exactly like every file the catalog plays. What it is not scaled by is the
 * catalog, because there is nothing to look up -- a mumble is generated, not
 * fetched, which is the whole reason this exists.
 *
 * It takes a bus rather than owning one. A sixth, `voice`, was written and
 * taken out again: `BUSES` is the *sound event* vocabulary, `soundEventSections`
 * builds the SFX tab's tree from it, and `events.test.ts` asserts every bus
 * appears there in mixer order -- so a bus that can never hold a catalog event
 * is an empty folder in the tab and a slider with nothing behind it. A
 * dedicated Dialogue level is worth having and is a follow-up; it wants a
 * mixer that separates "a bus of events" from "a level", which is a change to
 * that vocabulary rather than a row in it.
 *
 * Null means "no Web Audio here", which is what Node gets and what a browser
 * that refused a context gets. The caller's answer to null is to make no sound,
 * never to build a second context of its own.
 */
export interface SpeechOutput {
  /** The one context. Nodes must be built from it; nothing else may be. */
  readonly context: BaseAudioContext;
  /** The bus to connect a finished voice into. Never `context.destination`. */
  readonly into: AudioNode;
}

export interface Audio {
  /** Fire and forget. Silent, never throwing, if the event has no files or nothing can be heard. */
  play(id: SoundEventId, options?: PlayOptions): void;
  /** Start a loop and keep the handle. The caller owes a {@link stop}. */
  hold(id: SoundEventId, options?: PlayOptions): AudioHandle;
  /** Move a held loop. Cheap enough to call every frame. */
  move(handle: AudioHandle, options: PlayOptions): void;
  /** Whether a handle still names the sound it was given for. */
  isLive(handle: AudioHandle): boolean;
  stop(handle: AudioHandle): void;
  setListener(pose: ListenerPose): void;
  setMix(mix: AudioMix): void;
  setCatalog(catalog: SoundCatalog): void;
  /** Fetch and decode everything on these buses, in the background. */
  warm(buses: readonly BusId[]): void;
  /**
   * Is there anything behind this event -- has the catalog given it files?
   *
   * A question about the *document*, not about whether a voice would start
   * right now: a buffer that has not decoded yet, a source past the cull and a
   * throttled repeat all still answer true, because all three are transient and
   * an event that is silent for one frame has not stopped existing.
   *
   * It exists so a caller can prefer a specific event and fall back to a general
   * one -- a footstep on grass to a plain footstep -- which is the only way the
   * "an event with no entry is silent" rule and a per-surface vocabulary can
   * both be true. Without it, adding six surface rows would take the sound of
   * walking out of the game until somebody had recorded six sets.
   */
  has(id: SoundEventId): boolean;
  /** Create the context, or bring it back. Must be called from a user gesture. */
  resume(): void;
  suspend(): void;
  stats(): AudioStats;
  /** Every held loop stopped and every voice ended. What leaving the tab does. */
  stopAll(): void;
  /**
   * Play one file directly, outside the catalog. For the SFX tab, and nothing else.
   *
   * On the interface rather than only on the concrete engine, because
   * `createAudioEngine` answers {@link SILENT_AUDIO} where there is no Web
   * Audio -- and a tab that reached for a method the silent one has not got
   * would be a tab that throws on the browser it was supposed to degrade for.
   *
   * Unlike `play`, a cache miss here **loads and then plays** rather than being
   * dropped, and the asymmetry is the point: pressing Preview is a request for
   * this file *whenever* it is ready, where a blow is a request for a sound
   * *now* or not at all.
   */
  preview(url: string, gain?: number, rate?: number): void;
  /**
   * The context and bus a procedural voice is built on, or null.
   *
   * Never creates one: it answers what {@link Audio.resume} has already made,
   * so a caller reaching for it before the first user gesture gets null and
   * makes no sound -- the same rule `play` follows, and for the same reason a
   * queue would be wrong. See {@link SpeechOutput}.
   */
  speech(bus: BusId): SpeechOutput | null;
}

/** A sink that does nothing, and what runs in Node. See the header. */
export const SILENT_AUDIO: Audio = {
  play(): void {
    /* nothing */
  },
  hold(): AudioHandle {
    return NO_HANDLE;
  },
  move(): void {
    /* nothing */
  },
  isLive(): boolean {
    return false;
  },
  stop(): void {
    /* nothing */
  },
  setListener(): void {
    /* nothing */
  },
  setMix(): void {
    /* nothing */
  },
  setCatalog(): void {
    /* nothing */
  },
  warm(): void {
    /* nothing */
  },
  has(): boolean {
    // A silent engine has nothing behind anything, which is the honest answer
    // and the one that makes a fallback chain resolve to its last entry.
    return false;
  },
  resume(): void {
    /* nothing */
  },
  suspend(): void {
    /* nothing */
  },
  stats(): AudioStats {
    return { state: 'unsupported', voices: 0, held: 0, buffers: 0, loading: 0, refused: 0, missing: 0, started: {} };
  },
  stopAll(): void {
    /* nothing */
  },
  preview(): void {
    /* nothing */
  },
  speech(): SpeechOutput | null {
    // No context, so nothing to build a voice on. This is what makes the whole
    // dialogue layer drivable in Node: the controller still schedules, still
    // cancels, still reveals text, and simply never makes a noise.
    return null;
  },
};
