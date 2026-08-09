/**
 * Credit accounting and the ceilings (spec 108).
 *
 * The ledger is **append-only** and every entry records what the API said it
 * charged, not what we guessed it would. Those are different numbers and keeping
 * them apart is the whole point: a running total built from projections is a
 * restatement of our own arithmetic, and would agree with itself forever while
 * disagreeing with the bill.
 *
 * The ceilings are checked *before* a request goes out, against the projection
 * plus everything already spent. Checking after would be a report, not a limit.
 *
 * Pure: the day boundary, the totals and the decision are all functions of an
 * entry list and a millisecond timestamp handed in.
 */

import type { Stage } from './types.js';

export interface LedgerEntry {
  readonly jobId: string;
  readonly stage: Stage;
  readonly taskId: string | null;
  /** Straight off the task result's `credits_consumed`. Never a projection. */
  readonly credits: number;
  /**
   * Whether the API actually told us what it charged.
   *
   * False means `credits` is a zero we invented because the field was absent,
   * and the running total is a lower bound rather than a figure. Recording that
   * distinction is the difference between a ledger that is incomplete and one
   * that is quietly wrong.
   */
  readonly reported: boolean;
  readonly atMs: number;
}

export interface Ceilings {
  /** Most a single job may spend. Null disables the ceiling. */
  readonly perRun: number | null;
  /** Most all jobs together may spend in one UTC day. Null disables it. */
  readonly perDay: number | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * The UTC day an instant falls in, as `YYYY-MM-DD`.
 *
 * UTC rather than local, because a server and the person watching it are not
 * reliably in the same place, and a "daily" ceiling that resets at a different
 * moment than the operator expects is worse than no ceiling.
 *
 * Computed arithmetically rather than through `new Date(atMs).toISOString()`,
 * for one reason worth the extra dozen lines: this module is linted as part of
 * the deterministic core, where the `Date` global is banned outright. The ban is
 * blunt -- formatting a timestamp that was handed in is not reading a clock --
 * but working *with* it here costs a known algorithm and buys a module with no
 * ambient anything in it, which is exactly what a file that decides whether to
 * spend money should be.
 *
 * This is Howard Hinnant's civil-from-days: shift the epoch to March 1st of year
 * zero so a leap day lands at the end of the cycle and never in the middle of
 * one, then unwind the 400/100/4-year cycles.
 */
export function dayKeyOf(atMs: number): string {
  // Floor, not truncate: a negative timestamp is before 1970 and must round the
  // same direction as every other day boundary.
  const days = Math.floor(atMs / MS_PER_DAY);
  const shifted = days + 719_468; // days from 0000-03-01 rather than 1970-01-01
  const era = Math.floor(shifted / 146_097); // one 400-year cycle
  const dayOfEra = shifted - era * 146_097; // 0..146096
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153); // 0..11, March-based
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  const year = era * 400 + yearOfEra + (month <= 2 ? 1 : 0);

  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function runTotal(entries: readonly LedgerEntry[], jobId: string): number {
  return entries.reduce((sum, entry) => (entry.jobId === jobId ? sum + entry.credits : sum), 0);
}

export function dayTotal(entries: readonly LedgerEntry[], dayKey: string): number {
  return entries.reduce((sum, entry) => (dayKeyOf(entry.atMs) === dayKey ? sum + entry.credits : sum), 0);
}

export function grandTotal(entries: readonly LedgerEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.credits, 0);
}

export type CeilingVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly ceiling: 'perRun' | 'perDay'; readonly reason: string };

export interface CeilingCheck {
  readonly entries: readonly LedgerEntry[];
  readonly jobId: string;
  /** What the next call (or the whole remaining plan) is projected to cost. */
  readonly projectedCredits: number;
  readonly nowMs: number;
  readonly ceilings: Ceilings;
}

/**
 * Whether the projected spend fits under both ceilings.
 *
 * Checked as "already spent plus what this will cost", so a job that has been
 * running for a while cannot creep past its own ceiling one cheap call at a
 * time. A ceiling of exactly the projected total passes -- a limit somebody set
 * to the price of the thing they want to buy should let them buy it once.
 */
export function checkCeilings(check: CeilingCheck): CeilingVerdict {
  const { entries, jobId, projectedCredits, nowMs, ceilings } = check;

  if (ceilings.perRun !== null) {
    const spent = runTotal(entries, jobId);
    const after = spent + projectedCredits;
    if (after > ceilings.perRun) {
      return {
        ok: false,
        ceiling: 'perRun',
        reason: `this run has spent ${spent} and would reach ${after}, over the per-run ceiling of ${ceilings.perRun}`,
      };
    }
  }

  if (ceilings.perDay !== null) {
    const today = dayKeyOf(nowMs);
    const spent = dayTotal(entries, today);
    const after = spent + projectedCredits;
    if (after > ceilings.perDay) {
      return {
        ok: false,
        ceiling: 'perDay',
        reason: `${today} has spent ${spent} and would reach ${after}, over the per-day ceiling of ${ceilings.perDay}`,
      };
    }
  }

  return { ok: true };
}

export interface CreditSummary {
  readonly total: number;
  readonly today: number;
  readonly dayKey: string;
  readonly ceilings: Ceilings;
  /** What is left under the day ceiling, or null when there is no ceiling. */
  readonly dayHeadroom: number | null;
  /**
   * How many entries the API never gave a figure for. Non-zero means every
   * total above is a lower bound, and the UI has to say so rather than showing
   * a confident number.
   */
  readonly unreportedCalls: number;
}

export function summarize(entries: readonly LedgerEntry[], nowMs: number, ceilings: Ceilings): CreditSummary {
  const dayKey = dayKeyOf(nowMs);
  const today = dayTotal(entries, dayKey);
  return {
    total: grandTotal(entries),
    today,
    dayKey,
    ceilings,
    dayHeadroom: ceilings.perDay === null ? null : Math.max(0, ceilings.perDay - today),
    unreportedCalls: entries.reduce((count, entry) => (entry.reported ? count : count + 1), 0),
  };
}
