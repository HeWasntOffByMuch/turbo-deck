/** The budget's one judgement: it stops after work, never before it. */

import { describe, expect, it } from 'vitest';

import { FrameBudget } from './frame-budget.js';

function at(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)] ?? 0;
}

describe('FrameBudget', () => {
  it('is unspent while the frame is young', () => {
    expect(new FrameBudget(1000, 6, at([1003])).spent()).toBe(false);
  });

  it('is spent once the allowance is gone', () => {
    expect(new FrameBudget(1000, 6, at([1006])).spent()).toBe(true);
  });

  it('lets at least one unit of work happen', () => {
    // Checked after the work, so a job whose single unit costs more than the
    // whole budget still makes progress instead of starving forever.
    const budget = new FrameBudget(1000, 6, at([1050, 1050]));
    let done = 0;
    for (let i = 0; i < 3; i++) {
      done++;
      if (budget.spent()) break;
    }
    expect(done).toBe(1);
  });

  it('measures from the frame it was given, not from when it was made', () => {
    // The frame hands its own timestamp in, so a budget constructed part-way
    // through a frame still bounds that frame rather than starting a new one.
    expect(new FrameBudget(1000, 20, at([1015])).spent()).toBe(false);
    expect(new FrameBudget(1010, 20, at([1015])).spent()).toBe(false);
    expect(new FrameBudget(990, 20, at([1015])).spent()).toBe(true);
  });
});
