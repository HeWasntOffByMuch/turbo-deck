/**
 * One-shot confirmation tokens (spec 108).
 *
 * The rule is that no paid call happens without an explicit confirmation that
 * showed the projected cost. A boolean in a request body cannot enforce that --
 * a resubmitted form sends the same boolean again, and a client that never saw a
 * projection can send one too.
 *
 * So confirmation is a token the *server* issued alongside a projection, that
 * redeems exactly once. A double-submitted form redeems something that is
 * already gone. A client that skipped the estimate has nothing to send. And
 * because the projection is stored with the token, the cost the user agreed to
 * is the cost that gets checked against the ceilings -- not a number the browser
 * sent back, which it could have edited.
 *
 * Pure: the token string and the time both arrive as arguments, so the caller's
 * `randomBytes` and clock stay in the Node half.
 */

import type { CostProjection } from './pricing.js';

/** Long enough that a person can read a dialog; short enough to not be a queue. */
export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export interface Confirmation {
  readonly token: string;
  /** What the user was shown. The ceiling check uses this, never a client value. */
  readonly projection: CostProjection;
  /** Ties the token to one request, so it cannot authorise a different one. */
  readonly cacheKey: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export type RedeemResult =
  | { readonly ok: true; readonly confirmation: Confirmation }
  | { readonly ok: false; readonly reason: string };

export class ConfirmationStore {
  private readonly issued = new Map<string, Confirmation>();

  constructor(private readonly ttlMs: number = DEFAULT_CONFIRMATION_TTL_MS) {}

  issue(token: string, projection: CostProjection, cacheKey: string, nowMs: number): Confirmation {
    const confirmation: Confirmation = {
      token,
      projection,
      cacheKey,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };
    this.issued.set(token, confirmation);
    return confirmation;
  }

  /**
   * Consumes a token.
   *
   * Deleted before any check that could fail, so a token presented twice is gone
   * either way. Redeeming and *then* rejecting would leave a token that a caller
   * could keep trying, and the whole value of one-shot is that there is nothing
   * left to try.
   */
  redeem(token: string, cacheKey: string, nowMs: number): RedeemResult {
    const confirmation = this.issued.get(token);
    if (!confirmation) {
      return { ok: false, reason: 'no such confirmation, or it has already been used' };
    }
    this.issued.delete(token);

    if (nowMs >= confirmation.expiresAtMs) {
      return { ok: false, reason: 'confirmation expired; price it again' };
    }
    // A token authorises the request it was quoted for. Without this, an
    // estimate for a cheap job would confirm an expensive one.
    if (confirmation.cacheKey !== cacheKey) {
      return { ok: false, reason: 'confirmation was issued for a different request' };
    }
    return { ok: true, confirmation };
  }

  /** Drops expired tokens. Called opportunistically; correctness never needs it. */
  sweep(nowMs: number): number {
    let dropped = 0;
    for (const [token, confirmation] of this.issued) {
      if (nowMs >= confirmation.expiresAtMs) {
        this.issued.delete(token);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.issued.size;
  }
}
