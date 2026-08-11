/**
 * Who hears an input (spec 131).
 *
 * The case that matters is the second one: a click that nothing consumed, while
 * a modal is up. Every other row here is obvious and this one is the reason the
 * function takes two booleans instead of one.
 */

import { describe, expect, it } from 'vitest';
import { escapeTaken, reachesGameplay } from './ui-routing.js';

describe('reachesGameplay', () => {
  it('lets an untouched event through', () => {
    expect(reachesGameplay({ consumed: false, blocked: false })).toBe(true);
  });

  it('stops one a widget handled', () => {
    expect(reachesGameplay({ consumed: true, blocked: false })).toBe(false);
  });

  /**
   * The click beside the dialog. Nothing consumed it -- it landed on empty
   * space -- and if that were the only question asked, the character would walk
   * across the map while a question about selling their sword was on screen.
   */
  it('stops one nothing handled while a modal is up', () => {
    expect(reachesGameplay({ consumed: false, blocked: true })).toBe(false);
  });

  it('stops one that is both', () => {
    expect(reachesGameplay({ consumed: true, blocked: true })).toBe(false);
  });
});

describe('escapeTaken', () => {
  it('runs the steps in order and stops at the first that acts', () => {
    const ran: string[] = [];
    const step = (name: string, acts: boolean) => (): boolean => {
      ran.push(name);
      return acts;
    };
    expect(escapeTaken([step('drag', false), step('dialog', true), step('window', true)])).toBe(true);
    // The window is never asked: the dialog answered.
    expect(ran).toEqual(['drag', 'dialog']);
  });

  it('says nothing took it when nothing did, so gameplay may have it', () => {
    const ran: string[] = [];
    const step = (name: string) => (): boolean => {
      ran.push(name);
      return false;
    };
    expect(escapeTaken([step('drag'), step('dialog'), step('window')])).toBe(false);
    expect(ran).toEqual(['drag', 'dialog', 'window']);
  });

  it('is false for no steps at all', () => {
    expect(escapeTaken([])).toBe(false);
  });

  /**
   * A drag beats a dialog beats a window. Asserted as the order rather than as
   * three separate cases, because the order *is* the rule -- letting go of a
   * mis-grabbed item must not close the window it was grabbed in.
   */
  it('gives a drag the first refusal', () => {
    const ran: string[] = [];
    escapeTaken([
      () => {
        ran.push('drag');
        return true;
      },
      () => {
        ran.push('dialog');
        return true;
      },
    ]);
    expect(ran).toEqual(['drag']);
  });
});
