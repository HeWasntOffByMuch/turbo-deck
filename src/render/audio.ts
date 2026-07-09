// Browser-only Web Audio glue. This is the one audio module that touches the
// platform (AudioContext, oscillators); it holds no musical or game decisions —
// it renders the pure descriptions from music.ts and sfx.ts. Because the
// interesting choices live in those testable modules, this stays thin.

import { buildCalmSong, buildDeathSong, buildSong, midiToFreq, type MusicPhase, type Song, type Waveform } from './music.js';
import { SFX, sfxForEvent, spellEventSfx, type SfxSegment } from './sfx.js';
import type { GameEvent } from '../game/session.js';
import type { SpellGameEvent } from '../game/spell-session.js';

const MASTER_GAIN = 0.55;
const MUSIC_GAIN = 0.7;
const SFX_GAIN = 0.9;
// How far ahead of the audio clock we queue music notes each top-up. Kept well
// over a second because background tabs throttle timers (and stop rAF entirely):
// as long as we re-queue before this buffer drains, playback in a hidden tab
// stays smooth instead of grinding to a halt.
const SCHEDULE_AHEAD_S = 2.0;
// How often the self-driving scheduler tops the queue up. Foreground it fires at
// this rate; a background tab throttles it toward ~1s, still inside the buffer.
const SCHEDULE_INTERVAL_MS = 400;
// Seconds to fade one theme out and the other in when the wave state flips.
const CROSSFADE_S = 0.7;

/** A short, self-contained white-noise buffer reused for percussive segments. */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * One looping theme's scheduler state. Both themes run continuously on their own
 * cursor and sub-bus so switching phase is just a gain cross-fade between the
 * two buses — no cursor reset, no seam.
 */
interface MusicLoop {
  readonly song: Song;
  readonly secondsPerBeat: number;
  readonly loopSeconds: number;
  readonly phase: MusicPhase;
  /** Audio-clock time at which the current loop iteration started. */
  loopStart: number;
  /** Index into the (beat-sorted) song of the next note to schedule. */
  cursor: number;
  /** Per-theme gain node; cross-faded to 1 when this theme's phase is active. */
  bus: GainNode | undefined;
}

function makeLoop(song: Song, phase: MusicPhase): MusicLoop {
  const secondsPerBeat = 60 / song.bpm;
  return {
    song,
    secondsPerBeat,
    loopSeconds: song.lengthBeats * secondsPerBeat,
    phase,
    loopStart: 0,
    cursor: 0,
    bus: undefined,
  };
}

export class GameAudio {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private musicBus: GainNode | undefined;
  private sfxBus: GainNode | undefined;
  private noiseBuffer: AudioBuffer | undefined;
  // Every theme is always scheduled; `phase` selects which one is audible.
  private readonly loops: readonly MusicLoop[] = [
    makeLoop(buildSong(), 'combat'),
    makeLoop(buildCalmSong(), 'calm'),
    makeLoop(buildDeathSong(), 'death'),
  ];
  private phase: MusicPhase = 'calm';
  private muted = false;
  private started = false;
  // Music scheduling runs on its own timer, not the render loop, so a
  // backgrounded tab (where rAF stops) keeps the queue fed.
  private schedulerTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Create/resume the AudioContext. Must be called from a user gesture, since
   * browsers block autoplay; safe to call repeatedly. Kicks off the music loop
   * on first success.
   */
  resume(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return; // no Web Audio support; run silently
      const ctx = new Ctor();
      this.ctx = ctx;
      this.noiseBuffer = makeNoiseBuffer(ctx);

      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
      this.master.connect(ctx.destination);

      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = MUSIC_GAIN;
      this.musicBus.connect(this.master);

      // One sub-bus per theme, feeding the shared music bus, so we can cross-fade
      // the two loops independently. Start each at its phase's target gain.
      for (const loop of this.loops) {
        const bus = ctx.createGain();
        bus.gain.value = loop.phase === this.phase ? 1 : 0;
        bus.connect(this.musicBus);
        loop.bus = bus;
      }

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = SFX_GAIN;
      this.sfxBus.connect(this.master);
    }
    // `resume()` is async: a context created during a gesture starts
    // 'suspended' and only flips to 'running' a microtask later, so checking
    // the state synchronously here would miss the first gesture and leave the
    // music silent until some later input. Start the loop when resume settles
    // (and also try synchronously, for a context that is already running).
    void this.ctx.resume().then(() => this.startLoop());
    this.startLoop();

    // Top the music queue up on a timer independent of the render loop. rAF is
    // paused in a hidden tab, but this keeps scheduling notes onto the audio
    // clock so playback there doesn't slow to a crawl.
    if (this.schedulerTimer === undefined && typeof setInterval === 'function') {
      this.schedulerTimer = setInterval(() => this.update(), SCHEDULE_INTERVAL_MS);
    }
  }

  /** Kick off the look-ahead music loop once the context is actually running. */
  private startLoop(): void {
    if (!this.ctx || this.started || this.ctx.state !== 'running') return;
    this.started = true;
    const at = this.ctx.currentTime + 0.1;
    for (const loop of this.loops) {
      loop.loopStart = at;
      loop.cursor = 0;
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
    return this.muted;
  }

  /**
   * Select which theme is audible (spec 017): the combat loop during a wave, the
   * calm loop in the between-wave lull. Cross-fades the two music sub-buses; a
   * no-op when the phase is unchanged, so it is safe to call every frame.
   */
  setMusicPhase(phase: MusicPhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const loop of this.loops) {
      const bus = loop.bus;
      if (!bus) continue;
      const target = loop.phase === phase ? 1 : 0;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.linearRampToValueAtTime(target, now + CROSSFADE_S);
    }
  }

  /** Voice every audible event produced by the sim this tick. */
  handleEvents(events: readonly GameEvent[]): void {
    if (!this.ctx || this.muted) return;
    for (const event of events) {
      const id = sfxForEvent(event);
      if (id) this.playSfx(id);
    }
  }

  /** As `handleEvents`, but for the spell game's event stream (spec 018/019). */
  handleSpellEvents(events: readonly SpellGameEvent[]): void {
    if (!this.ctx || this.muted) return;
    for (const event of events) {
      for (const id of spellEventSfx(event)) this.playSfx(id);
    }
  }

  /** Called each render frame: keep the look-ahead music queue topped up. */
  update(): void {
    if (!this.ctx || !this.started || this.muted) return;
    const until = this.ctx.currentTime + SCHEDULE_AHEAD_S;
    for (const loop of this.loops) this.scheduleLoop(loop, until);
  }

  /** Top up one theme's look-ahead queue up to `until` on its own sub-bus. */
  private scheduleLoop(loop: MusicLoop, until: number): void {
    const ctx = this.ctx;
    const bus = loop.bus;
    if (!ctx || !bus) return;
    // Advance the loop window forward past any iterations that have fully elapsed.
    while (loop.loopStart + loop.loopSeconds <= ctx.currentTime) {
      loop.loopStart += loop.loopSeconds;
      loop.cursor = 0;
    }
    while (loop.cursor < loop.song.notes.length) {
      const note = loop.song.notes[loop.cursor];
      if (!note) break;
      const when = loop.loopStart + note.beat * loop.secondsPerBeat;
      if (when > until) break;
      this.scheduleTone(midiToFreq(note.midi), midiToFreq(note.midi), note.wave, note.duration * loop.secondsPerBeat, note.gain, when, bus);
      loop.cursor++;
    }
    // If we scheduled the whole loop, wrap for the next iteration immediately so
    // there is no gap at the seam.
    if (loop.cursor >= loop.song.notes.length && loop.loopStart + loop.loopSeconds <= until) {
      loop.loopStart += loop.loopSeconds;
      loop.cursor = 0;
    }
  }

  private playSfx(id: string): void {
    const spec = SFX[id];
    if (!spec || !this.ctx || !this.sfxBus) return;
    const now = this.ctx.currentTime;
    for (const seg of spec.segments) {
      const when = now + (seg.delay ?? 0);
      if (seg.wave === 'noise') this.scheduleNoise(seg, when);
      else this.scheduleTone(seg.startFreq, seg.endFreq, seg.wave, seg.duration, seg.gain, when, this.sfxBus);
    }
  }

  /** One enveloped oscillator note; frequency glides start->end over its life. */
  private scheduleTone(startFreq: number, endFreq: number, wave: Waveform, duration: number, gain: number, when: number, bus: GainNode): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(Math.max(1, startFreq), when);
    if (endFreq !== startFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), when + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(gain, when + Math.min(0.01, duration * 0.2));
    env.gain.exponentialRampToValueAtTime(0.0001, when + duration);

    osc.connect(env).connect(bus);
    osc.start(when);
    osc.stop(when + duration + 0.02);
  }

  /** A percussive noise burst for hit transients. */
  private scheduleNoise(seg: SfxSegment, when: number): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus || !this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const env = ctx.createGain();
    env.gain.setValueAtTime(seg.gain, when);
    env.gain.exponentialRampToValueAtTime(0.0001, when + seg.duration);

    src.connect(env).connect(sfxBus);
    src.start(when);
    src.stop(when + seg.duration + 0.02);
  }
}
