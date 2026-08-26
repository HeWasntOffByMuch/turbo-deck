/**
 * The one module in this repo that owns an `AudioContext` (spec 229).
 *
 * Everything above it -- `events.ts`, `catalog.ts`, `variants.ts`, `mix.ts`, and
 * every gameplay call site -- deals in names, numbers and world points, and is
 * pure and tested in Node. This is where a name becomes a buffer and a world
 * point becomes a pan, and it is the only place a `PannerNode` exists. That
 * split is the same one `src/ui/core/sound.ts` already draws for the interface,
 * one layer down: *"nothing under src/ui/ learns what a sound is"*, and now
 * there is something for its sink to be plugged into.
 *
 * ## The graph
 *
 * ```
 *   AudioBufferSourceNode -> GainNode -> [PannerNode] -> bus GainNode -> destination
 * ```
 *
 * Five bus gains for the whole game and nothing else permanent. There is
 * deliberately **no master node**: the master is folded into each bus's gain by
 * `busGain`, which is one multiply on five numbers when a slider moves against
 * one more node in the path of every voice for the life of the process.
 *
 * ## Why there is no voice pool
 *
 * Because `AudioBufferSourceNode` cannot be pooled: the spec makes it
 * single-use -- once started and stopped it can never play again -- and it is
 * designed to be cheap to allocate for exactly that reason. Pooling the *panner*
 * and *gain* would be possible and is not worth it either: `equalpower` panning
 * is a couple of multiplies, and a voice's three nodes are unlinked on `ended`
 * and collected. What this does have, because these are the things that actually
 * go wrong, is a **cap** on how many voices may be live at once and a
 * **distance cull** so a sound nobody could hear is never allocated at all.
 *
 * The extension point, stated so nobody has to guess: if a voice cap of
 * {@link MAX_VOICES} ever starts refusing sounds a player wanted, the fix is
 * priority (refuse the *furthest* live voice and steal its slot), not a pool.
 *
 * ## Autoplay, and why nothing is created at mount
 *
 * A browser will not let a page make noise before somebody has interacted with
 * it, and a context constructed anyway starts `suspended` and stays there in a
 * way that is invisible until a playtester says "there's no sound". So the
 * context is created by {@link resume}, which the Play tab calls from the first
 * real input, and every `play` before that is dropped rather than queued: a
 * queue would empty itself into the first click as a burst of everything that
 * happened while the page was silent.
 *
 * ## In Node
 *
 * `npm test` never opens a browser and `presentation-only.test.ts` drives the
 * whole presentation layer headlessly. So {@link createAudioEngine} answers
 * {@link SILENT_AUDIO} where there is no `AudioContext`, and every caller takes
 * a non-nullable {@link Audio}. An optional engine and a `?.` at each of thirty
 * call sites is thirty chances to forget one -- the argument `SILENT` in
 * `src/ui/core/sound.ts` already makes about an optional sink.
 */

import {
  resolveSound,
  type ResolvedSound,
  type SoundCatalog,
} from './catalog.js';
import { BUSES, soundEvent, type BusId, type SoundEventId } from './events.js';
import {
  NO_HANDLE,
  SILENT_AUDIO,
  type Audio,
  type AudioHandle,
  type AudioState,
  type AudioStats,
  type ListenerPose,
  type PlayOptions,
} from './sink.js';
import { AUDIO_DEFAULTS, busGain, type AudioMix } from './mix.js';
import { drawRate, PlayThrottle, VariantPicker, type Random } from './variants.js';

/** How many one-shots may be live at once. See the header. */
export const MAX_VOICES = 32;

/** How many files may be fetched at a time by {@link Audio.warm}. */
const WARM_CONCURRENCY = 4;

/**
 * How long a stopped loop takes to go away, in seconds.
 *
 * Not zero: a looping buffer cut on an arbitrary sample is a click, and a click
 * is the one artefact a listener always notices. 60ms is under the point where
 * the stop reads as late.
 */
const LOOP_FADE_SECONDS = 0.06;

interface HeldVoice {
  readonly handle: AudioHandle;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode | null;
  readonly sound: ResolvedSound;
}

type ContextFactory = () => AudioContext;

export interface AudioEngineOptions {
  readonly context: ContextFactory;
  /** `Math.random` in the game, a sequence in a test. */
  readonly random?: Random;
  /** `performance.now`, injected for the same reason the random source is. */
  readonly now?: () => number;
  readonly mix?: AudioMix;
}

/**
 * The engine.
 *
 * Everything it holds that is not a Web Audio node is a cache or a counter. The
 * decisions -- which take, at what pitch, whether at all -- are made by the pure
 * modules and handed here as numbers.
 */
export class AudioEngine implements Audio {
  private context: AudioContext | null = null;
  private buses: Record<BusId, GainNode> | null = null;

  private resolved = new Map<SoundEventId, ResolvedSound>();
  private mix: AudioMix;

  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
  /** Files that could not be fetched or decoded. Remembered so we stop asking. */
  private readonly broken = new Set<string>();

  private readonly picker = new VariantPicker();
  private readonly throttle = new PlayThrottle();

  /** Buses somebody has asked for, so a context arriving later can honour it. */
  private readonly wanted = new Set<BusId>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private workers = 0;

  private voices = 0;
  /** Per event, how many voices actually started. See {@link AudioStats.started}. */
  private readonly started: Record<string, number> = {};
  private readonly held = new Map<AudioHandle, HeldVoice>();
  private nextHandle = 1;
  private refused = 0;

  private listener: ListenerPose = {
    x: 0,
    y: 0,
    z: 0,
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  };

  private readonly random: Random;
  private readonly clock: () => number;
  private readonly makeContext: ContextFactory;

  constructor(options: AudioEngineOptions) {
    this.makeContext = options.context;
    this.random = options.random ?? Math.random;
    this.clock = options.now ?? (() => performance.now());
    this.mix = options.mix ?? AUDIO_DEFAULTS;
  }

  // --- lifecycle ---------------------------------------------------------

  /**
   * Create the context, or bring a suspended one back.
   *
   * Must be reached from a user gesture. Called more than once on purpose: a
   * browser can suspend a context on its own (a hidden tab, an OS audio focus
   * change) and the cheapest correct answer is to ask on every input rather than
   * to track whose fault it was.
   */
  resume(): void {
    if (this.context === null) {
      let created: AudioContext;
      try {
        created = this.makeContext();
      } catch {
        // No Web Audio, or the browser refused. Nothing else in this class
        // works without it and every method below checks, so this is the whole
        // of the failure handling.
        return;
      }
      this.context = created;
      this.buses = buildBuses(created, this.mix);
      this.applyListener();
      // Everything asked for before there was anything to decode with. See
      // `pump`: a warm that ran against a null context loaded nothing at all.
      if (this.wanted.size > 0) this.enqueue([...this.wanted]);
      this.pump();
    }
    if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
  }

  suspend(): void {
    const context = this.context;
    if (context === null || context.state !== 'running') return;
    void context.suspend().catch(() => undefined);
  }

  // --- configuration -----------------------------------------------------

  setCatalog(catalog: SoundCatalog): void {
    this.resolved = new Map();
    for (const [id, entry] of catalog) this.resolved.set(id, resolveSound(id, entry));
    // A remembered variant index is an index into a list that may have been
    // re-ordered, so the memory is of the wrong take. Harmless except that the
    // first press after an edit is exactly when somebody is listening for a
    // repeat.
    this.picker.reset();
    // A catalog can arrive after a warm was asked for -- and in the Play tab it
    // always does, since the request names buses and the buses are empty until
    // the document lands. Re-queued rather than left to the next `warm`, or a
    // reload of the catalog in the SFX tab would silently stop warming.
    if (this.wanted.size > 0) {
      this.enqueue([...this.wanted]);
      this.pump();
    }
    // Buffers are keyed by URL rather than by event, so a re-assignment keeps
    // every file it still uses decoded and simply stops asking for the rest.
    // Nothing is evicted: 74 files at 48kHz mono is a few tens of MB decoded,
    // and evicting on a catalog edit would make the SFX tab re-fetch what it
    // just previewed.
  }

  setMix(mix: AudioMix): void {
    this.mix = mix;
    const context = this.context;
    const buses = this.buses;
    if (context === null || buses === null) return;
    for (const bus of BUSES) {
      // Ramped rather than assigned: a `gain.value` step mid-signal is a
      // discontinuity, which on a sustained sound is an audible tick. 20ms is
      // instant to a person dragging a slider.
      const node = buses[bus].gain;
      node.cancelScheduledValues(context.currentTime);
      node.setTargetAtTime(busGain(mix, bus), context.currentTime, 0.02);
    }
  }

  setListener(pose: ListenerPose): void {
    this.listener = pose;
    this.applyListener();
  }

  private applyListener(): void {
    const context = this.context;
    if (context === null) return;
    const { listener } = context;
    const pose = this.listener;
    // Two APIs for one thing. The `AudioParam` form is current and the six
    // setters are deprecated -- but Safari still only has the setters, and a
    // game with no positional audio on one browser is worse than four lines.
    if (listener.positionX) {
      const at = context.currentTime;
      listener.positionX.setValueAtTime(pose.x, at);
      listener.positionY.setValueAtTime(pose.y, at);
      listener.positionZ.setValueAtTime(pose.z, at);
      listener.forwardX.setValueAtTime(pose.forward.x, at);
      listener.forwardY.setValueAtTime(pose.forward.y, at);
      listener.forwardZ.setValueAtTime(pose.forward.z, at);
      listener.upX.setValueAtTime(pose.up.x, at);
      listener.upY.setValueAtTime(pose.up.y, at);
      listener.upZ.setValueAtTime(pose.up.z, at);
      return;
    }
    listener.setPosition(pose.x, pose.y, pose.z);
    listener.setOrientation(pose.forward.x, pose.forward.y, pose.forward.z, pose.up.x, pose.up.y, pose.up.z);
  }

  // --- playing -----------------------------------------------------------

  play(id: SoundEventId, options: PlayOptions = {}): void {
    const started = this.start(id, options, false);
    if (started) this.retire(started);
  }

  hold(id: SoundEventId, options: PlayOptions = {}): AudioHandle {
    const started = this.start(id, options, true);
    if (!started) return NO_HANDLE;
    // A loop is retired the same way a one-shot is, and it has to be: a looping
    // source never ends on its own, so its `onended` fires only when `stop`
    // schedules one -- and without this the voice count climbs by one per shot
    // for the life of the session, until `MAX_VOICES` refuses everything.
    // Caught by `probe-audio.ts` reading `voices=1` after every loop had been
    // let go of, which is a number that should have been 0.
    this.retire(started);
    this.held.set(started.handle, started);
    return started.handle;
  }

  move(handle: AudioHandle, options: PlayOptions): void {
    const voice = this.held.get(handle);
    if (!voice?.panner) return;
    const context = this.context;
    if (context === null) return;
    positionPanner(voice.panner, options, this.listener, context.currentTime);
  }

  isLive(handle: AudioHandle): boolean {
    return handle !== NO_HANDLE && this.held.has(handle);
  }

  stop(handle: AudioHandle): void {
    const voice = this.held.get(handle);
    if (!voice) return;
    this.held.delete(handle);
    const context = this.context;
    if (context === null) return;
    // Faded, not cut. A loop stopped on an arbitrary sample is a click.
    const at = context.currentTime;
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, at);
    voice.gain.gain.linearRampToValueAtTime(0, at + LOOP_FADE_SECONDS);
    try {
      voice.source.stop(at + LOOP_FADE_SECONDS);
    } catch {
      // Already stopped. Not a case worth distinguishing.
    }
  }

  stopAll(): void {
    for (const handle of [...this.held.keys()]) this.stop(handle);
  }

  /**
   * The whole of "should this be heard, and what does it sound like".
   *
   * Returns the voice it started, or null. Every refusal is counted rather than
   * logged: a sound that did not play is a normal event dozens of times a
   * minute (a distant fight, an unassigned row), and a console line per refusal
   * is a console nobody reads.
   */
  private start(id: SoundEventId, options: PlayOptions, loop: boolean): HeldVoice | null {
    const context = this.context;
    const buses = this.buses;
    // Before the gesture that creates the context. Dropped rather than queued:
    // see the header.
    if (context === null || buses === null || context.state === 'closed') return null;

    const sound = this.resolved.get(id);
    // No entry is silence, and is the normal state of an unassigned event. Not
    // counted as a refusal, because it is not one.
    if (!sound || sound.variants.length === 0) return null;

    const event = soundEvent(id);
    const bus = event?.bus ?? 'combat';

    // Too far to hear. Answered before anything is allocated or decoded, which
    // is what makes a fight on the other side of the map cost nothing at all.
    const spatial = sound.spatial;
    let distanceSq = 0;
    if (spatial) {
      const dx = (options.x ?? this.listener.x) - this.listener.x;
      const dy = (options.y ?? this.listener.y) - this.listener.y;
      const dz = (options.z ?? this.listener.z) - this.listener.z;
      distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq > sound.distance.max * sound.distance.max) return null;
    }

    // The same event six times in one frame is one sound (see `PlayThrottle`).
    // Loops are exempt: a held sound is started once by a driver that owns it,
    // and throttling one would leave that driver holding NO_HANDLE and never
    // trying again.
    if (!loop && !this.throttle.admit(id, this.clock(), sound.cooldownMs)) return null;

    if (this.voices >= MAX_VOICES) {
      this.refused += 1;
      return null;
    }

    const index = this.picker.pick(id, sound.variants.length, this.random);
    const url = sound.variants[index];
    if (url === undefined) return null;
    const buffer = this.buffers.get(url);
    if (!buffer) {
      // The first time a sound is asked for it is not ready, and it plays
      // nothing rather than playing late: a hit that arrives 200ms after the
      // blow is worse than a hit that did not arrive. The fetch starts here, so
      // the *second* one is on time -- and `warm` exists so that the sounds
      // that matter never take this path at all.
      void this.load(url);
      return null;
    }

    const gain = context.createGain();
    gain.gain.value = sound.volume * (options.gain ?? 1);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = drawRate(sound.pitch, this.random) * (options.rate ?? 1);

    let panner: PannerNode | null = null;
    if (spatial) {
      panner = context.createPanner();
      // `equalpower` rather than `HRTF`: HRTF is a convolution per voice, and
      // this camera looks down at 27 degrees on a ground plane, where what a
      // player needs from audio is *which side* and *how far* -- both of which
      // equalpower gives exactly. HRTF's elevation cues would be spent on an
      // axis nothing in this game moves along.
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = sound.distance.ref;
      panner.maxDistance = sound.distance.max;
      panner.rolloffFactor = sound.distance.rolloff;
      positionPanner(panner, options, this.listener, context.currentTime);
      source.connect(gain).connect(panner).connect(buses[bus]);
    } else {
      source.connect(gain).connect(buses[bus]);
    }

    this.voices += 1;
    source.start();
    // Counted here and nowhere earlier: this is the line that made a noise.
    this.started[id] = (this.started[id] ?? 0) + 1;
    return { handle: this.nextHandle++, source, gain, panner, sound };
  }

  /**
   * Unlink a voice when it ends. The whole of this engine's leak protection.
   *
   * For a one-shot that is when the buffer runs out; for a held loop it is when
   * {@link stop} schedules one, since a looping source has no natural end. Both
   * go through here so there is one place the count comes back down and one
   * place the nodes are disconnected.
   */
  private retire(voice: HeldVoice): void {
    voice.source.onended = (): void => {
      this.voices -= 1;
      voice.source.disconnect();
      voice.gain.disconnect();
      voice.panner?.disconnect();
    };
  }

  // --- loading -----------------------------------------------------------

  /**
   * Fetch and decode one file, once.
   *
   * The promise is cached rather than the buffer, so two call sites racing the
   * first play of a sound produce one fetch -- the same reason `map-asset.ts`
   * memoises its promise. A failure is remembered in `broken` so a missing file
   * costs one 404 for the session rather than one per swing.
   */
  private async load(url: string): Promise<AudioBuffer | null> {
    const existing = this.buffers.get(url);
    if (existing) return existing;
    if (this.broken.has(url)) return null;
    const inFlight = this.loading.get(url);
    if (inFlight) return inFlight;

    const context = this.context;
    if (context === null) return null;

    const pending = (async (): Promise<AudioBuffer | null> => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${String(response.status)} ${response.statusText}`);
        const bytes = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes);
        this.buffers.set(url, buffer);
        return buffer;
      } catch {
        this.broken.add(url);
        return null;
      } finally {
        this.loading.delete(url);
      }
    })();
    this.loading.set(url, pending);
    return pending;
  }

  /**
   * Decode everything on these buses, a few files at a time.
   *
   * The policy this exists to implement: **the sounds that fire in the first ten
   * seconds are warmed, and the rest arrive when they are first wanted.** A
   * footstep, a swing and a button are warmed at load because they are certain
   * and because the cost of the first one being silent is a player who thinks
   * the game has no sound; an ice impact is not warmed because it needs a skill
   * nobody has yet, and paying for it at load is paying for the whole library.
   *
   * Bounded concurrency because the alternative is 74 simultaneous fetches on
   * the same connection the map is streaming over.
   */
  warm(buses: readonly BusId[]): void {
    for (const bus of buses) this.wanted.add(bus);
    this.enqueue(buses);
    this.pump();
  }

  /**
   * Put every unloaded file on these buses at the back of the queue.
   *
   * One queue rather than one drain per call, so two overlapping `warm`s do not
   * run at twice the concurrency and the **order is kept**: the hot buses go in
   * first and are decoded first, which is the whole of the policy.
   */
  private enqueue(buses: readonly BusId[]): void {
    const wanted = new Set(buses);
    for (const [id, sound] of this.resolved) {
      if (!wanted.has(soundEvent(id)?.bus ?? 'combat')) continue;
      for (const url of sound.variants) {
        if (this.buffers.has(url) || this.broken.has(url) || this.queued.has(url)) continue;
        this.queued.add(url);
        this.queue.push(url);
      }
    }
  }

  /**
   * Run the queue, up to {@link WARM_CONCURRENCY} at a time.
   *
   * Idempotent: a second call while workers are running adds nothing. The queue
   * is drained rather than snapshotted, so a `warm` that arrives mid-run is
   * picked up by a worker already going rather than starting a second set.
   */
  private pump(): void {
    // Without a context there is nothing to decode with, and `load` would
    // answer null for every file and cache nothing. This is the bug the browser
    // probe found: the catalog lands well before the first click, so the whole
    // warm ran against a null context, did nothing, and left every sound to be
    // loaded on the first press that wanted it -- which is the one press that
    // is then silent. `resume` calls this again for exactly that reason.
    if (this.context === null) return;
    while (this.workers < WARM_CONCURRENCY && this.queue.length > 0) {
      this.workers += 1;
      void this.work();
    }
  }

  private async work(): Promise<void> {
    for (;;) {
      const url = this.queue.shift();
      if (url === undefined) break;
      await this.load(url);
    }
    this.workers -= 1;
  }

  // --- readout -----------------------------------------------------------

  stats(): AudioStats {
    const refused = this.refused;
    this.refused = 0;
    const state: AudioState = this.context === null ? 'idle' : (this.context.state as AudioState);
    return {
      state,
      voices: this.voices,
      held: this.held.size,
      buffers: this.buffers.size,
      loading: this.loading.size,
      refused,
      missing: this.broken.size,
      started: this.started,
    };
  }

  /** For the SFX tab: everything, whatever bus it is on. */
  warmAll(): void {
    this.warm(BUSES);
  }

  /** For the SFX tab's preview: play one file directly, outside the catalog. */
  preview(url: string, gain = 1, rate = 1): void {
    const context = this.context;
    const buses = this.buses;
    if (context === null || buses === null) return;
    const buffer = this.buffers.get(url);
    if (!buffer) {
      void this.load(url).then((loaded) => {
        // Played on arrival rather than refused, which is the opposite of the
        // rule for a gameplay sound and is right for the same reason: pressing
        // Preview is a request for this file *whenever* it is ready, where a
        // blow is a request for a sound *now* or not at all.
        if (loaded) this.preview(url, gain, rate);
      });
      return;
    }
    const node = context.createGain();
    node.gain.value = gain;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(node).connect(buses.ui);
    source.onended = (): void => {
      source.disconnect();
      node.disconnect();
    };
    source.start();
  }
}

function buildBuses(context: AudioContext, mix: AudioMix): Record<BusId, GainNode> {
  const out = {} as Record<BusId, GainNode>;
  for (const bus of BUSES) {
    const node = context.createGain();
    node.gain.value = busGain(mix, bus);
    node.connect(context.destination);
    out[bus] = node;
  }
  return out;
}

function positionPanner(panner: PannerNode, options: PlayOptions, listener: ListenerPose, at: number): void {
  const x = options.x ?? listener.x;
  const y = options.y ?? listener.y;
  const z = options.z ?? listener.z;
  if (panner.positionX) {
    panner.positionX.setValueAtTime(x, at);
    panner.positionY.setValueAtTime(y, at);
    panner.positionZ.setValueAtTime(z, at);
    return;
  }
  panner.setPosition(x, y, z);
}

/**
 * The engine, or {@link SILENT_AUDIO} where there is no Web Audio.
 *
 * The check is for the constructor rather than for a `window`, because that is
 * the thing actually needed and because jsdom has a `window` and no
 * `AudioContext`.
 */
export function createAudioEngine(options: Partial<AudioEngineOptions> = {}): Audio {
  const factory = options.context ?? defaultContext();
  if (factory === null) return SILENT_AUDIO;
  return new AudioEngine({ ...options, context: factory });
}

function defaultContext(): ContextFactory | null {
  const global = globalThis as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  const Ctor = global.AudioContext ?? global.webkitAudioContext;
  if (!Ctor) return null;
  return () => new Ctor();
}
