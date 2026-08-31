/**
 * A cooldown that got *shorter* (spec 253).
 *
 * The server never says "I took 1.2s off Arc Lash". It sends the owner their
 * whole cooldown table whenever it changes, so a refund is a **difference**
 * between two of those tables -- the same shape `world/xp-gain.ts` is, and for
 * the same reason: a client that wants to report an event the protocol does not
 * carry has to derive it from the state that is carried.
 *
 * Deriving it rather than adding a message also means this reports *whatever
 * actually happened*: Mobile Offense walking out of a follow-through today, and
 * Strength's `breakCooldownRefund` on a guard break, with no second case. The
 * fact a player wants is "that got shorter, by this much", and its cause is not
 * something the bar can or should draw.
 *
 * **The table has to be the server's own**, never `visibleCooldowns()`. That one
 * raises the server's entries by what this client has spent and not yet been
 * told about, so a prediction retiring -- the guess dropping away and leaving
 * the server's slightly lower number -- is a *decrease* that nothing refunded.
 * The one caller is the `Cooldowns` handler, which is where the confirmed table
 * is replaced and the only place both halves exist at once.
 */

/** One ability's reduction, in ticks. */
export interface CooldownRefund {
  readonly abilityId: string;
  readonly ticks: number;
}

/**
 * What went down between two confirmed cooldown tables.
 *
 * Only ids present in **both** count, which is what makes the three ways an
 * entry can legitimately vanish -- it expired, the wind-up it stamped was
 * withdrawn from (`cancelWindup` rebuilds the map without the key), the body
 * respawned -- silent rather than a refund of the whole remaining cooldown.
 * An entry going *up* is an ability that was just cast.
 *
 * Sorted by id, so the order is a property of the pair rather than of whichever
 * order the entries happened to arrive on the wire.
 */
export function refundsBetween(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): readonly CooldownRefund[] {
  const refunds: CooldownRefund[] = [];
  for (const [abilityId, readyAt] of Object.entries(after)) {
    const was = before[abilityId];
    if (was === undefined || !(was > readyAt)) continue;
    refunds.push({ abilityId, ticks: was - readyAt });
  }
  return refunds.sort((a, b) => (a.abilityId < b.abilityId ? -1 : 1));
}
