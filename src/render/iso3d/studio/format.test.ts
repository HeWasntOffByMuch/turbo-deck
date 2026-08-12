import { describe, expect, it } from 'vitest';
import { STAGES, type JobStatus } from '../../../server/studio/types.js';
import {
  formatBytes,
  formatCredits,
  formatDuration,
  formatTimestamp,
  jobProgress,
  STAGE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
} from './format.js';

const ALL_STATUSES: readonly JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'];

describe('labels', () => {
  it('cover every stage, so a new one cannot render as undefined', () => {
    for (const stage of STAGES) {
      expect(STAGE_LABELS[stage], stage).toBeTruthy();
    }
  });

  it('cover every job status', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_LABELS[status], status).toBeTruthy();
      expect(STATUS_COLORS[status], status).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('say rig-check is free, because that is the reason it is never skipped', () => {
    expect(STAGE_LABELS.rigCheck.toLowerCase()).toContain('free');
  });

  it('do not paint a blocked job the same colour as a failed one', () => {
    // Nothing was charged and nothing went wrong; the two must not look alike in
    // the one place where telling them apart decides what you do next.
    expect(STATUS_COLORS.blocked).not.toBe(STATUS_COLORS.failed);
  });
});

describe('formatCredits', () => {
  it('shows a whole number plainly', () => {
    expect(formatCredits(40)).toBe('40');
    expect(formatCredits(0)).toBe('0');
  });

  it('shows two places for a fraction', () => {
    expect(formatCredits(12.5)).toBe('12.50');
  });

  it('marks a total as a lower bound when a call went unpriced', () => {
    // The API not reporting credits_consumed makes every total below it a floor,
    // and showing a bare number would be a confident answer to an open question.
    expect(formatCredits(40, 1)).toBe('≥ 40');
    expect(formatCredits(40, 0)).toBe('40');
  });
});

describe('formatBytes', () => {
  it('scales through the units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('formatDuration', () => {
  it('reads as seconds, minutes and hours', () => {
    expect(formatDuration(4200)).toBe('4s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_930_000)).toBe('1h 5m');
  });

  it('never shows a negative time', () => {
    expect(formatDuration(-100)).toBe('0s');
  });
});

describe('formatTimestamp', () => {
  it('trims to what a person reads', () => {
    expect(formatTimestamp(Date.parse('2026-08-09T09:00:00Z'))).toBe('2026-08-09 09:00:00');
  });

  it('is empty for a missing value rather than showing the epoch', () => {
    expect(formatTimestamp(0)).toBe('');
    expect(formatTimestamp(Number.NaN)).toBe('');
  });
});

describe('jobProgress', () => {
  it('counts a skipped step as done', () => {
    // A unit reusing an established rig family skips the retarget, and a bar
    // permanently stuck at four fifths would read as a stall.
    const steps = [
      { status: 'done' },
      { status: 'done' },
      { status: 'done' },
      { status: 'skipped' },
      { status: 'done' },
    ];
    expect(jobProgress(steps)).toBe(1);
  });

  it('is zero for no steps and a fraction part-way', () => {
    expect(jobProgress([])).toBe(0);
    expect(jobProgress([{ status: 'done' }, { status: 'pending' }])).toBe(0.5);
  });
});
