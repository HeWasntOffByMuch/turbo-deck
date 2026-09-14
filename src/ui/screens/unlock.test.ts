import { describe, expect, it } from 'vitest';
import { UnlockScreen, UNLOCK_HOLD_MS, UNLOCK_QUEUE_MAX, type UnlockNotice } from './unlock.js';
import { THEME } from '../theme/theme.js';

function screen(): UnlockScreen {
  return new UnlockScreen({ theme: THEME });
}

function notice(id: string): UnlockNotice {
  return { id, title: id, lines: [{ text: `about ${id}` }] };
}

describe('UnlockScreen (spec 283)', () => {
  it('draws nothing until there is something to say', () => {
    // The state it spends a whole session in. A panel outline across the top of
    // an empty screen is the interface announcing that a feature exists.
    const ui = screen();
    ui.update(0);
    expect(ui.visible).toBe(false);
    expect(ui.showing).toBe(false);
  });

  it('shows a pushed notice and retires it when its life is spent', () => {
    const ui = screen();
    ui.push(notice('a'), 1000);
    ui.update(1000);
    expect(ui.visible).toBe(true);
    ui.update(1000 + UNLOCK_HOLD_MS - 1);
    expect(ui.visible).toBe(true);
    ui.update(1000 + UNLOCK_HOLD_MS);
    expect(ui.visible).toBe(false);
  });

  it('shows a queue one at a time', () => {
    // Two side by side is a reward screen, which is what reward-philosophy §1
    // forbids in as many words.
    const ui = screen();
    ui.push(notice('a'), 0);
    ui.push(notice('b'), 0);
    ui.update(0);
    expect(ui.showing).toBe(true);
    ui.update(UNLOCK_HOLD_MS);
    // Still showing: the second one has taken the first one's place.
    expect(ui.showing).toBe(true);
    expect(ui.visible).toBe(true);
    ui.update(UNLOCK_HOLD_MS * 2);
    expect(ui.showing).toBe(false);
  });

  it('drains a backlog rather than playing it out at the frame rate', () => {
    // A backgrounded tab hands back one frame covering many holds. Retiring one
    // notice per frame there would replay the queue in real time on return.
    const ui = screen();
    ui.push(notice('a'), 0);
    ui.push(notice('b'), 0);
    ui.update(UNLOCK_HOLD_MS * 10);
    expect(ui.showing).toBe(false);
    expect(ui.visible).toBe(false);
  });

  it('ignores an id already queued', () => {
    // `Stats` arrives on login, on every equip and on every spend, so a caller
    // diffing it can see one change twice.
    const ui = screen();
    ui.push(notice('a'), 0);
    ui.push(notice('a'), 0);
    ui.update(0);
    ui.update(UNLOCK_HOLD_MS);
    expect(ui.showing).toBe(false);
  });

  it('drops past the queue cap rather than holding a player hostage', () => {
    // The case that produces fifteen is an admin `setLevel`, and two minutes of
    // notices is the interface operating on the player. The sheet is the
    // permanent answer, which is spec 256's own ruling for the controls card.
    const ui = screen();
    for (let index = 0; index < UNLOCK_QUEUE_MAX + 5; index++) ui.push(notice(`n${index}`), 0);
    ui.update(UNLOCK_HOLD_MS * UNLOCK_QUEUE_MAX);
    expect(ui.showing).toBe(false);
  });

  it('clears outright when there is nothing left to say', () => {
    const ui = screen();
    ui.push(notice('a'), 0);
    ui.update(0);
    ui.clear();
    ui.update(0);
    expect(ui.visible).toBe(false);
    expect(ui.showing).toBe(false);
  });

  it('takes no pointer', () => {
    // The world is underneath, and this sits across it at exactly the moment
    // the player has been handed something to try.
    expect(screen().pointerTransparent).toBe(true);
  });
});
