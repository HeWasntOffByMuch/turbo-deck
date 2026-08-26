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
};
