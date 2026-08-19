import { describe, expect, it } from 'vitest';
import { ChatLog, HISTORY, QUIET_MS, SCROLLBACK, WIPE_MS, revealAt } from './chat-log.js';

describe('the chat log', () => {
  it('keeps what was said, oldest first, with monotonic ids', () => {
    const log = new ChatLog();
    log.append(0, 'Ada', 'watch the ravager', 100);
    log.append(1, '', 'Grazer was slain by Bru', 200);

    expect(log.entries.map((entry) => entry.text)).toEqual([
      'watch the ravager',
      'Grazer was slain by Bru',
    ]);
    expect(log.entries[0]?.id).toBeLessThan(log.entries[1]?.id ?? 0);
    expect(log.entries.map((entry) => entry.channel)).toEqual([0, 1]);
  });

  it('caps the scrollback, dropping the oldest', () => {
    const log = new ChatLog();
    for (let i = 0; i < SCROLLBACK + 10; i++) log.append(0, 'Ada', `line ${i}`, i);

    expect(log.entries).toHaveLength(SCROLLBACK);
    expect(log.entries[0]?.text).toBe('line 10');
    expect(log.entries[SCROLLBACK - 1]?.text).toBe(`line ${SCROLLBACK + 9}`);
    // ...and the ids stay monotonic across the eviction, so nothing that keys a
    // widget off one can be handed the same id twice.
    const ids = log.entries.map((entry) => entry.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('takes a channel byte it has no colour for as a say', () => {
    // Off the wire, so a future server's fourth channel must draw as something
    // a person typed rather than throw inside a network callback.
    const log = new ChatLog();
    log.append(9, 'Ada', 'hello', 0);
    expect(log.entries[0]?.channel).toBe(0);
  });

  it('bumps its revision only when something arrives', () => {
    // The entries array is mutated in place, so its identity says nothing.
    const log = new ChatLog();
    const before = log.revision;
    log.touch(500);
    expect(log.revision).toBe(before);
    log.append(0, 'Ada', 'hi', 600);
    expect(log.revision).toBeGreaterThan(before);
  });
});

describe('what the player said, for Up and Down', () => {
  it('walks back through it, and the newest end is empty', () => {
    const log = new ChatLog();
    log.remember('first');
    log.remember('second');

    expect(log.recall(-1)).toBe('second');
    expect(log.recall(-1)).toBe('first');
    // ...and stops at the oldest rather than wrapping round to the newest.
    expect(log.recall(-1)).toBe('first');
    expect(log.recall(1)).toBe('second');
    // Down past the end clears the field, which is the only way back to a blank
    // line without holding Backspace.
    expect(log.recall(1)).toBe('');
  });

  it('does not remember the same line twice in a row', () => {
    const log = new ChatLog();
    log.remember('ready');
    log.remember('ready');
    log.remember('ready');

    expect(log.recall(-1)).toBe('ready');
    expect(log.recall(-1)).toBe('ready');
    expect(log.recall(1)).toBe('');
  });

  it('caps the ring', () => {
    const log = new ChatLog();
    for (let i = 0; i < HISTORY + 5; i++) log.remember(`line ${i}`);

    let walked = 0;
    let last = '';
    for (let i = 0; i < HISTORY + 10; i++) {
      const next = log.recall(-1);
      if (next === last) break;
      last = next;
      walked++;
    }
    expect(walked).toBe(HISTORY);
    expect(last).toBe('line 5');
  });

  it('starts from the empty end again once a line is sent', () => {
    const log = new ChatLog();
    log.remember('first');
    log.remember('second');
    expect(log.recall(-1)).toBe('second');
    // Walked back one; sending resets, so the next Up is the newest again
    // rather than continuing from where the last walk stopped.
    log.remember('third');
    expect(log.recall(-1)).toBe('third');
  });

  it('ignores an empty line', () => {
    const log = new ChatLog();
    log.remember('');
    expect(log.recall(-1)).toBe('');
  });
});

describe('when the log is on screen', () => {
  it('is nothing at all before anything has been said', () => {
    // Negative infinity rather than zero, or a session opens with the log wiping
    // out of a corner it was never in.
    const log = new ChatLog();
    expect(revealAt(log.lastAtMs, 0, false)).toBe(0);
    expect(revealAt(log.lastAtMs, 60_000, false)).toBe(0);
  });

  it('is whole for the quiet window, then wipes out', () => {
    const said = 1_000;
    expect(revealAt(said, said, false)).toBe(1);
    expect(revealAt(said, said + QUIET_MS, false)).toBe(1);
    expect(revealAt(said, said + QUIET_MS + WIPE_MS / 2, false)).toBeCloseTo(0.5);
    expect(revealAt(said, said + QUIET_MS + WIPE_MS, false)).toBe(0);
    expect(revealAt(said, said + QUIET_MS + WIPE_MS * 4, false)).toBe(0);
  });

  it('never goes back up on its own', () => {
    const said = 0;
    let previous = 1;
    for (let now = 0; now <= QUIET_MS + WIPE_MS * 2; now += 20) {
      const shown = revealAt(said, now, false);
      expect(shown).toBeLessThanOrEqual(previous);
      previous = shown;
    }
  });

  it('is whole while the field is open, however long the silence', () => {
    // A player staring at the field they are typing into must not watch the log
    // slide out from over it.
    expect(revealAt(0, QUIET_MS * 10, true)).toBe(1);
  });

  it('comes back whole when a line lands mid-wipe', () => {
    const log = new ChatLog();
    log.append(0, 'Ada', 'first', 0);
    const leaving = QUIET_MS + WIPE_MS / 2;
    expect(revealAt(log.lastAtMs, leaving, false)).toBeLessThan(1);

    log.append(0, 'Bru', 'second', leaving);
    expect(revealAt(log.lastAtMs, leaving, false)).toBe(1);
  });

  it('restarts the quiet window when the field is put away', () => {
    // Closing after a long silence must not make the log vanish on the same
    // frame: the player is looking straight at it.
    const log = new ChatLog();
    log.append(0, 'Ada', 'first', 0);
    const late = QUIET_MS * 3;
    expect(revealAt(log.lastAtMs, late, false)).toBe(0);

    log.touch(late);
    expect(revealAt(log.lastAtMs, late, false)).toBe(1);
  });
});
