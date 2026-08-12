import { describe, expect, it } from 'vitest';
import {
  castRefusalText,
  ErrorLog,
  MESSAGE_CAPACITY,
  MESSAGE_FADE_MS,
  MESSAGE_LIFE_MS,
  REFUSAL_PHRASES,
  refusalPhrase,
} from './error-log.js';
import { ALL_ABILITIES } from '../../../server/data/abilities.js';
import { hasGlyph, textWidth } from './pixel-font.js';
import { errorLineWidth, hudLayout, PHONE_LANDSCAPE } from './hud-layout.js';

/** Every reason `abilities.ts` and `world.ts` can refuse a cast with. */
const REASONS = [
  'onCooldown',
  'notEnoughResource',
  'outOfRange',
  'alreadyCasting',
  'noTarget',
  'unknownAbility',
  'dead',
  'withdrawn',
] as const;

/** The texts of a step, in the order the caller will draw them: top to bottom. */
function texts(log: ErrorLog, nowMs: number): string[] {
  return log.step(nowMs).live.map((line) => line.text);
}

describe('the stack', () => {
  it('hands lines back oldest first, so the newest is drawn at the bottom', () => {
    const log = new ErrorLog();
    log.step(1000);
    log.add('first');
    log.add('second');
    log.add('third');
    expect(texts(log, 1100)).toEqual(['FIRST', 'SECOND', 'THIRD']);
  });

  it('keeps that order after something in the middle of its life expires', () => {
    const log = new ErrorLog();
    log.step(0);
    log.add('old');
    log.step(MESSAGE_LIFE_MS - 100);
    log.add('new');
    // The old one goes; the new one has most of its life left and stays put.
    const step = log.step(MESSAGE_LIFE_MS + 1);
    expect(step.live.map((line) => line.text)).toEqual(['NEW']);
    log.add('newer');
    expect(texts(log, MESSAGE_LIFE_MS + 2)).toEqual(['NEW', 'NEWER']);
  });

  it('uppercases, because the face it is drawn in has one case', () => {
    const log = new ErrorLog();
    log.step(0);
    log.add('Slash: on cooldown');
    expect(texts(log, 1)).toEqual(['SLASH: ON COOLDOWN']);
  });
});

describe('decay', () => {
  it('is a few seconds of clock, whatever the step cadence', () => {
    // The bug this replaces: 120 *frames*, which is two seconds at 60fps and
    // five-sixths of one at 144.
    for (const stepMs of [1, 4, 16, 100, 1000]) {
      const log = new ErrorLog();
      log.step(0);
      log.add('refused');
      let gone = 0;
      for (let t = stepMs; t <= MESSAGE_LIFE_MS * 2; t += stepMs) {
        if (log.step(t).live.length === 0) {
          gone = t;
          break;
        }
      }
      expect(gone, `at a ${stepMs}ms step`).toBeGreaterThanOrEqual(MESSAGE_LIFE_MS);
      expect(gone, `at a ${stepMs}ms step`).toBeLessThan(MESSAGE_LIFE_MS + stepMs);
    }
  });

  it('is a few seconds and not a few minutes', () => {
    expect(MESSAGE_LIFE_MS).toBeGreaterThanOrEqual(2000);
    expect(MESSAGE_LIFE_MS).toBeLessThanOrEqual(6000);
  });

  it('fades out at the end, and never brightens on the way', () => {
    const log = new ErrorLog();
    log.step(0);
    const { id } = log.add('refused');

    let previous = Infinity;
    let faded = false;
    for (let t = 0; t < MESSAGE_LIFE_MS; t += 50) {
      const line = log.step(t).live.find((candidate) => candidate.id === id);
      expect(line, `alive at ${t}ms`).toBeDefined();
      const opacity = line?.opacity ?? 0;
      expect(opacity).toBeLessThanOrEqual(previous + 1e-9);
      expect(opacity).toBeGreaterThan(0);
      if (t < MESSAGE_LIFE_MS - MESSAGE_FADE_MS) expect(opacity).toBe(1);
      if (opacity < 1) faded = true;
      previous = opacity;
    }
    expect(faded, 'it should have started fading before it vanished').toBe(true);
  });

  it('starts a message added before the first frame at that first frame', () => {
    // `requestAnimationFrame` hands out timestamps counted from page load, so a
    // message stamped 0 and first stepped at 30000 would never be seen at all.
    const log = new ErrorLog();
    log.add('refused');
    expect(log.step(30_000).live).toHaveLength(1);
    expect(log.step(30_000 + MESSAGE_LIFE_MS - 1).live).toHaveLength(1);
    expect(log.step(30_000 + MESSAGE_LIFE_MS).live).toHaveLength(0);
  });

  it('gives the same answer to the same timestamps, twice', () => {
    const run = (): string[][] => {
      const log = new ErrorLog();
      const frames: string[][] = [];
      log.step(0);
      log.add('slash: on cooldown');
      for (let t = 0; t < MESSAGE_LIFE_MS + 100; t += 250) {
        if (t === 1000) log.add('slash: on cooldown');
        if (t === 1500) log.add('mend: not enough resource');
        frames.push(log.step(t).live.map((line) => `${line.text}@${line.opacity.toFixed(3)}`));
      }
      return frames;
    };
    expect(run()).toEqual(run());
  });
});

describe('repeats', () => {
  it('coalesce into one line with a count and a reset clock', () => {
    const log = new ErrorLog();
    log.step(0);
    const first = log.add('slash: on cooldown');
    const again = log.add('slash: on cooldown');
    expect(again.id).toBe(first.id);
    expect(log.count).toBe(1);
    expect(texts(log, 0)).toEqual(['SLASH: ON COOLDOWN X2']);

    // Said again just before it would have gone: it lives a full life from there.
    log.step(MESSAGE_LIFE_MS - 1);
    log.add('slash: on cooldown');
    expect(texts(log, MESSAGE_LIFE_MS + 100)).toEqual(['SLASH: ON COOLDOWN X3']);
  });

  it('survive auto-attack, which refuses once a tick', () => {
    // The comment in `target.test.ts`: one held swing turned into sixty requests
    // a second, each refused, each a line.
    const log = new ErrorLog();
    log.step(0);
    for (let tick = 0; tick < 180; tick++) {
      log.add('slash: on cooldown');
      log.step(tick * (1000 / 60));
    }
    expect(log.count).toBe(1);
    expect(texts(log, 3000)).toEqual(['SLASH: ON COOLDOWN X180']);
  });

  it('keep their place rather than jumping to the bottom', () => {
    const log = new ErrorLog();
    log.step(0);
    log.add('first');
    log.add('second');
    log.add('first');
    expect(texts(log, 0)).toEqual(['FIRST X2', 'SECOND']);
  });

  it('are a new line once the first has expired', () => {
    const log = new ErrorLog();
    log.step(0);
    const first = log.add('refused');
    log.step(MESSAGE_LIFE_MS);
    const second = log.add('refused');
    expect(second.id).not.toBe(first.id);
    expect(texts(log, MESSAGE_LIFE_MS)).toEqual(['REFUSED']);
  });

  it('do not coalesce two different messages', () => {
    const log = new ErrorLog();
    log.step(0);
    log.add('slash: on cooldown');
    log.add('mend: not enough resource');
    log.add('slash: on cooldown');
    log.add('mend: not enough resource');
    expect(log.count).toBe(2);
    expect(texts(log, 0)).toEqual(['SLASH: ON COOLDOWN X2', 'MEND: NOT ENOUGH RESOURCE X2']);
  });
});

describe('capacity', () => {
  it('drops the oldest rather than growing without bound', () => {
    const log = new ErrorLog();
    log.step(0);
    for (let i = 0; i < MESSAGE_CAPACITY + 3; i++) log.add(`message ${i}`);
    expect(log.count).toBe(MESSAGE_CAPACITY);
    expect(texts(log, 0)[0]).toBe(`MESSAGE ${3}`);
  });

  it('reports every id it ever handed out as expired, exactly once', () => {
    // The caller holds an element per id. One never reported is one that stays
    // on the screen forever.
    const log = new ErrorLog();
    const issued = new Set<number>();
    const retired: number[] = [];

    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += 137;
      const added = log.add(`message ${i % 9}`);
      issued.add(added.id);
      retired.push(...added.expired);
      retired.push(...log.step(t).expired);
    }
    // Run the clock out so nothing is still alive at the end.
    retired.push(...log.step(t + MESSAGE_LIFE_MS).expired);

    expect(log.count).toBe(0);
    expect(new Set(retired)).toEqual(issued);
    expect(retired).toHaveLength(issued.size);
  });
});

describe('the wording', () => {
  it('covers every reason the server can send, and invents none', () => {
    expect(Object.keys(REFUSAL_PHRASES).sort()).toEqual([...REASONS].sort());
  });

  it('turns an unworded code into words rather than showing the code', () => {
    expect(refusalPhrase('someNewReason')).toBe('some new reason');
    expect(refusalPhrase('silenced')).toBe('silenced');
  });

  it('names the ability that was refused', () => {
    expect(castRefusalText('Slash', 'onCooldown')).toBe('SLASH: ON COOLDOWN');
    expect(castRefusalText('Throwing Star', 'outOfRange')).toBe('THROWING STAR: OUT OF RANGE');
  });
});

describe('what actually gets drawn', () => {
  it('uses no character the font has to fall back on', () => {
    // The fallback is a solid block. Twenty-six of them is not a warning.
    for (const ability of ALL_ABILITIES) {
      for (const reason of REASONS) {
        const text = `${castRefusalText(ability.name, reason)} X12`;
        for (const character of text) {
          expect(hasGlyph(character), `${JSON.stringify(character)} in "${text}"`).toBe(true);
        }
      }
    }
  });

  it('fits across a phone at the compact scale, clear of both edges', () => {
    const layout = hudLayout(true);
    let widest = '';
    for (const ability of ALL_ABILITIES) {
      for (const reason of REASONS) {
        const text = `${castRefusalText(ability.name, reason)} X12`;
        if (textWidth(text) > textWidth(widest)) widest = text;
      }
    }
    const room = PHONE_LANDSCAPE.width - layout.edge * 2;
    expect(errorLineWidth(layout, widest), `"${widest}"`).toBeLessThanOrEqual(room);
  });
});
