/**
 * The respawn cover (spec 281).
 *
 * Every rule here is one the cover is wrong without, and three of them are the
 * ones that would make it wrong *invisibly*: lifting a frame before the teleport
 * lands, never lifting at all, and staying up over a second death.
 */

import { describe, expect, it } from 'vitest';

import {
  ASKING_DETAIL,
  BUILDING_DETAIL,
  COUNTDOWN_VISIBLE_MS,
  COVER_LABEL,
  RESPAWN_COVER_TIMEOUT_MS,
  RespawnGate,
  coverTextDrawable,
  type RespawnGateInput,
} from './respawn-gate.js';

/** A body alive on ground that has entirely arrived. */
const SETTLED: RespawnGateInput = {
  nowMs: 0,
  dead: false,
  needed: 25,
  held: 25,
  meshPending: 0,
};

const at = (nowMs: number, over: Partial<RespawnGateInput> = {}): RespawnGateInput => ({
  ...SETTLED,
  nowMs,
  ...over,
});

describe('RespawnGate', () => {
  it('covers nothing until the button is pressed', () => {
    const gate = new RespawnGate();
    // Including over ground that has not arrived: a gate that armed itself off
    // thin ground would be the fog the boot gate exists to refuse.
    expect(gate.read(at(0, { held: 0 }))).toBeNull();
    expect(gate.read(at(16, { held: 0, meshPending: 4 }))).toBeNull();
  });

  it('covers while the server has not answered, whatever the chunks say', () => {
    const gate = new RespawnGate();
    gate.ask(0);
    // The death site is fully loaded, which is exactly why this is the rule that
    // matters: reading coverage first would report a finished return on the
    // frame before the one that moves the player.
    const cover = gate.read(at(16, { dead: true }));
    expect(cover?.phase).toBe('asking');
    expect(cover?.label).toBe(COVER_LABEL);
    expect(cover?.detail).toBe(ASKING_DETAIL);
  });

  it('covers while the ground around the spawn is still short', () => {
    const gate = new RespawnGate();
    gate.ask(0);
    gate.read(at(16, { dead: true }));
    const cover = gate.read(at(32, { held: 4 }));
    expect(cover?.phase).toBe('arriving');
    expect(cover?.detail).toBe('4 / 25 CHUNKS');
    expect(cover?.fraction).toBeGreaterThan(0);
    expect(cover?.fraction).toBeLessThan(1);
  });

  it('covers while the ground is all in and not all drawn', () => {
    const gate = new RespawnGate();
    gate.ask(0);
    gate.read(at(16, { dead: true }));
    const cover = gate.read(at(32, { meshPending: 3 }));
    expect(cover?.phase).toBe('arriving');
    expect(cover?.detail).toBe(BUILDING_DETAIL);
  });

  it('lifts on the frame the world is whole, and stays lifted', () => {
    const gate = new RespawnGate();
    gate.ask(0);
    gate.read(at(16, { dead: true }));
    gate.read(at(32, { held: 9 }));
    expect(gate.read(at(48))).toBeNull();
    // Without a second `ask`: a return that lifted and came back would be a
    // world that flickers every time a chunk is evicted behind the player.
    expect(gate.read(at(64, { held: 0, meshPending: 6 }))).toBeNull();
  });

  it('lifts at once when the return has nothing to wait for', () => {
    // Dying next to the spawn: the ground is already held, so the cover is one
    // round trip of "waiting for the server" and no more.
    const gate = new RespawnGate();
    gate.ask(0);
    expect(gate.read(at(16, { dead: true }))?.phase).toBe('asking');
    expect(gate.read(at(32))).toBeNull();
  });

  it('gives up at the deadline with the ground still short', () => {
    const gate = new RespawnGate();
    gate.ask(0);
    gate.read(at(16, { dead: true }));
    const last = gate.read(at(RESPAWN_COVER_TIMEOUT_MS - 1, { held: 0 }));
    expect(last?.secondsLeft).toBe(1);
    expect(gate.read(at(RESPAWN_COVER_TIMEOUT_MS, { held: 0 }))).toBeNull();
    // ...and stays down, rather than covering again on the next frame.
    expect(gate.read(at(RESPAWN_COVER_TIMEOUT_MS + 16, { held: 0 }))).toBeNull();
  });

  it('gives up at the deadline on a respawn the server never answered', () => {
    // The `asking` half has to bail out too, or a refused respawn is a covered
    // world for the rest of the session.
    const gate = new RespawnGate();
    gate.ask(0);
    expect(gate.read(at(RESPAWN_COVER_TIMEOUT_MS - 1, { dead: true }))).not.toBeNull();
    expect(gate.read(at(RESPAWN_COVER_TIMEOUT_MS, { dead: true }))).toBeNull();
  });

  it('counts whole seconds down and never past zero', () => {
    const gate = new RespawnGate();
    gate.ask(0);
    expect(gate.read(at(0, { dead: true }))?.secondsLeft).toBe(RESPAWN_COVER_TIMEOUT_MS / 1000);
    expect(gate.read(at(1500, { dead: true }))?.secondsLeft).toBe(
      Math.ceil((RESPAWN_COVER_TIMEOUT_MS - 1500) / 1000),
    );
    expect(gate.read(at(RESPAWN_COVER_TIMEOUT_MS - 1, { dead: true }))?.secondsLeft).toBe(1);
  });

  it('shows the countdown only once the deadline is close', () => {
    const gate = new RespawnGate();
    gate.ask(0);
    const early = RESPAWN_COVER_TIMEOUT_MS - COUNTDOWN_VISIBLE_MS - 1;
    expect(gate.read(at(early, { held: 2 }))?.detail).toBe('2 / 25 CHUNKS');
    const late = RESPAWN_COVER_TIMEOUT_MS - COUNTDOWN_VISIBLE_MS;
    expect(gate.read(at(late, { held: 2 }))?.detail).toBe(
      `SHOWING THE WORLD IN ${String(COUNTDOWN_VISIBLE_MS / 1000)}`,
    );
  });

  it('never walks the bar backwards, and resets it on the next return', () => {
    const gate = new RespawnGate();
    gate.ask(0);
    const high = gate.read(at(16, { held: 20 }))?.fraction ?? 0;
    // `needed` grows as the body settles into a chunk with more declared around
    // it, which is the case that would otherwise show a bar going backwards.
    const later = gate.read(at(32, { held: 20, needed: 40 }))?.fraction ?? 0;
    expect(later).toBe(high);

    gate.ask(1000);
    expect(gate.read(at(1016, { dead: true }))?.fraction).toBe(0);
  });

  it('drops the cover when the player dies again', () => {
    const gate = new RespawnGate();
    gate.ask(0);
    gate.read(at(16, { dead: true }));
    expect(gate.read(at(32, { held: 1 }))?.phase).toBe('arriving');
    // Killed on the spawn pad before the ground finished arriving. What belongs
    // on screen is the death banner, not a return that is not happening.
    expect(gate.read(at(48, { dead: true, held: 1 }))).toBeNull();
    // ...and does not come back when the ground finally arrives.
    expect(gate.read(at(64, { dead: true }))).toBeNull();
  });

  it('can draw every string it produces', () => {
    // The face has one case and a fixed symbol set, and a character with no
    // glyph draws as a solid block rather than failing -- so this is a claim
    // that has to be asserted rather than looked at.
    const gate = new RespawnGate();
    const seen = new Set<string>();
    for (const step of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      gate.ask(0);
      const nowMs = step * 1000;
      for (const input of [
        at(nowMs, { dead: true }),
        at(nowMs, { held: 0 }),
        at(nowMs, { held: 7 }),
        at(nowMs, { held: 25, meshPending: 2 }),
      ]) {
        const cover = gate.read(input);
        if (!cover) continue;
        seen.add(cover.label);
        seen.add(cover.detail);
      }
    }
    expect(seen.size).toBeGreaterThan(3);
    for (const text of seen) expect([text, coverTextDrawable(text)]).toEqual([text, true]);
  });
});
