// Browser-only Web Audio glue. This is the one audio module that touches the
// platform (AudioContext, oscillators); it holds no musical or game decisions —
// it renders the pure descriptions from music.ts and sfx.ts. Because the
// interesting choices live in those testable modules, this stays thin.

import { buildSong, midiToFreq, type Song, type Waveform } from './music.js';
import { SFX, sfxForEvent, type SfxSegment } from './sfx.js';
import type { GameEvent } from '../game/session.js';

const MASTER_GAIN = 0.55;
const MUSIC_GAIN = 0.7;
const SFX_GAIN = 0.9;
// How far ahead of the audio clock we queue music notes each update. Larger
// than a render frame (~16ms) so we never starve even after a hitch.
const SCHEDULE_AHEAD_S = 0.2;

/** A short, self-contained white-noise buffer reused for percussive segments. */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export class GameAudio {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private musicBus: GainNode | undefined;
  private sfxBus: GainNode | undefined;
  private noiseBuffer: AudioBuffer | undefined;
  private readonly song: Song = buildSong();
  private readonly secondsPerBeat: number;
  private readonly loopSeconds: number;
  /** Audio-clock time at which the current loop iteration started. */
  private loopStart = 0;
  /** Index into the (beat-sorted) song of the next note to schedule. */
  private cursor = 0;
  private muted = false;
  private started = false;

  constructor() {
    this.secondsPerBeat = 60 / this.song.bpm;
    this.loopSeconds = this.song.lengthBeats * this.secondsPerBeat;
  }

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
  }

  /** Kick off the look-ahead music loop once the context is actually running. */
  private startLoop(): void {
    if (!this.ctx || this.started || this.ctx.state !== 'running') return;
    this.started = true;
    this.loopStart = this.ctx.currentTime + 0.1;
    this.cursor = 0;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
    return this.muted;
  }

  /** Voice every audible event produced by the sim this tick. */
  handleEvents(events: readonly GameEvent[]): void {
    if (!this.ctx || this.muted) return;
    for (const event of events) {
      const id = sfxForEvent(event);
      if (id) this.playSfx(id);
    }
  }

  /** Called each render frame: keep the look-ahead music queue topped up. */
  update(): void {
    const musicBus = this.musicBus;
    if (!this.ctx || !musicBus || !this.started || this.muted) return;
    const until = this.ctx.currentTime + SCHEDULE_AHEAD_S;
    // Advance the loop window forward past any iterations that have fully elapsed.
    while (this.loopStart + this.loopSeconds <= this.ctx.currentTime) {
      this.loopStart += this.loopSeconds;
      this.cursor = 0;
    }
    while (this.cursor < this.song.notes.length) {
      const note = this.song.notes[this.cursor];
      if (!note) break;
      const when = this.loopStart + note.beat * this.secondsPerBeat;
      if (when > until) break;
      this.scheduleTone(midiToFreq(note.midi), midiToFreq(note.midi), note.wave, note.duration * this.secondsPerBeat, note.gain, when, musicBus);
      this.cursor++;
    }
    // If we scheduled the whole loop, wrap for the next iteration immediately so
    // there is no gap at the seam.
    if (this.cursor >= this.song.notes.length && this.loopStart + this.loopSeconds <= until) {
      this.loopStart += this.loopSeconds;
      this.cursor = 0;
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
