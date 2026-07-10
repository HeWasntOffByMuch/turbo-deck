import { afterEach, describe, expect, it } from 'vitest';
import { GameAudio } from './audio.js';

// audio.ts is the one browser-only module, but a tiny fake AudioContext gives it
// a headless surface — enough to pin the music-startup path, which has regressed
// more than once: SFX (which don't gate on the loop being started) stay audible
// while the background music goes silent. The failure mode is timing: on some
// browsers `ctx.resume()` resolves while the context is still 'suspended' and
// only flips to 'running' a beat later, so a one-shot startLoop() can miss.

interface OscRecord { freq: number; when: number }

class FakeParam {
  value: number;
  constructor(v: number) { this.value = v; }
  setValueAtTime(): this { return this; }
  linearRampToValueAtTime(): this { return this; }
  exponentialRampToValueAtTime(): this { return this; }
  cancelScheduledValues(): this { return this; }
}
class FakeGain {
  readonly gain = new FakeParam(1);
  connect(node: unknown): unknown { return node; }
}
class FakeOsc {
  type = 'sine';
  readonly frequency = new FakeParam(0);
  constructor(private readonly sink: OscRecord[]) {}
  connect(node: unknown): unknown { return node; }
  start(when: number): void { this.sink.push({ freq: this.frequency.value, when }); }
  stop(): void { /* fake: nothing to tear down */ }
}
class FakeBufferSource {
  buffer: unknown = null;
  connect(node: unknown): unknown { return node; }
  start(): void { /* fake: noise source is irrelevant to music scheduling */ }
  stop(): void { /* fake: nothing to tear down */ }
}

/**
 * A fake context whose `resume()` resolves the promise but leaves `state` as
 * `runningAtResume ? 'running' : 'suspended'`. When false, the test flips the
 * state to 'running' later, reproducing the lagging-transition browsers.
 */
function makeFakeContext(runningAtResume: boolean) {
  const oscillators: OscRecord[] = [];
  const clock = { t: 0 };
  const ctx = {
    state: 'suspended' as AudioContextState,
    sampleRate: 48000,
    get currentTime() { return clock.t; },
    destination: {},
    createGain: () => new FakeGain(),
    createOscillator: () => new FakeOsc(oscillators),
    createBufferSource: () => new FakeBufferSource(),
    createBuffer: () => ({ getChannelData: () => new Float32Array(8) }),
    resume(): Promise<void> {
      if (runningAtResume) ctx.state = 'running';
      return Promise.resolve();
    },
  };
  return { ctx, oscillators, clock };
}

function installWindow(ctx: unknown): void {
  (globalThis as { window?: unknown }).window = { AudioContext: function () { return ctx; } };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

async function driveFrames(audio: GameAudio, clock: { t: number }): Promise<void> {
  await Promise.resolve(); // let ctx.resume().then(startLoop) run
  await Promise.resolve();
  for (let f = 0; f < 30; f++) {
    clock.t += 0.016;
    audio.setMusicPhase(f > 3 ? 'combat' : 'calm');
    audio.update();
  }
}

describe('GameAudio music startup', () => {
  it('schedules music when the context is running as resume() resolves', async () => {
    const { ctx, oscillators, clock } = makeFakeContext(true);
    installWindow(ctx);
    const audio = new GameAudio();
    audio.resume();
    await driveFrames(audio, clock);
    expect(oscillators.length, 'no music notes scheduled').toBeGreaterThan(0);
  });

  it('still schedules music when the context reaches running only after resume() resolves', async () => {
    // The regression: startLoop() fired from resume() misses because the context
    // is not 'running' yet. update() must retry so the loop starts anyway.
    const { ctx, oscillators, clock } = makeFakeContext(false);
    installWindow(ctx);
    const audio = new GameAudio();
    audio.resume();
    await Promise.resolve();
    ctx.state = 'running'; // browser flips it a beat later
    await driveFrames(audio, clock);
    expect(oscillators.length, 'music stayed silent after the context started').toBeGreaterThan(0);
  });
});
