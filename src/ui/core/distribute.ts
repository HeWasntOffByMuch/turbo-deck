/**
 * Sharing leftover pixels out, deterministically (spec 121).
 *
 * A row of three children growing into 100 pixels cannot each get 33.333. Some
 * child has to get the extra pixel, and *which* one has to be decided the same
 * way every time or a layout shimmers by a pixel between frames and a golden
 * image is unrepeatable.
 *
 * The rule: each child gets `floor(total * weight / totalWeight)`, then the
 * remainder is handed out one pixel each to the leftmost children in order. So
 * the widths always sum to exactly `total` -- never one short, never one over --
 * and the answer is a pure function of the weights.
 *
 * Small enough to read in one sitting and load-bearing enough to have its own
 * file, because "the columns do not line up" is otherwise a bug hunt through a
 * container.
 */

/**
 * Split `total` between `weights`, in whole units, summing to exactly `total`.
 *
 * Non-positive weights get nothing and take part in no remainder. When every
 * weight is zero the whole of `total` is left undistributed and an array of
 * zeroes comes back -- the caller asked for nothing to grow, so nothing does.
 */
export function distribute(total: number, weights: readonly number[]): number[] {
  const out = new Array<number>(weights.length).fill(0);
  if (total <= 0 || weights.length === 0) return out;

  let totalWeight = 0;
  for (const weight of weights) {
    if (weight > 0) totalWeight += weight;
  }
  if (totalWeight <= 0) return out;

  let assigned = 0;
  for (let i = 0; i < weights.length; i++) {
    const weight = weights[i] ?? 0;
    if (weight <= 0) continue;
    const share = Math.floor((total * weight) / totalWeight);
    out[i] = share;
    assigned += share;
  }

  // The remainder is at most `count - 1` pixels, by construction: every share
  // lost strictly less than one pixel to the floor.
  let remainder = total - assigned;
  for (let i = 0; i < weights.length && remainder > 0; i++) {
    if ((weights[i] ?? 0) <= 0) continue;
    out[i] = (out[i] ?? 0) + 1;
    remainder--;
  }
  return out;
}

/**
 * Take `overflow` pixels *back* from `sizes`, in whole units, never below
 * `minimums`.
 *
 * The shrink half of the same problem, and it is not the mirror image: a child
 * that has already hit its minimum cannot give any more, so the shortfall has to
 * be re-offered to the ones that can. Hence the loop -- it terminates because
 * every pass either removes a pixel or finds nothing left able to give one.
 */
export function shrinkToFit(
  sizes: readonly number[],
  minimums: readonly number[],
  overflow: number,
): number[] {
  const out = [...sizes];
  let remaining = Math.max(0, Math.floor(overflow));

  while (remaining > 0) {
    let giversFound = 0;
    for (let i = 0; i < out.length && remaining > 0; i++) {
      const min = minimums[i] ?? 0;
      const current = out[i] ?? 0;
      if (current <= min) continue;
      out[i] = current - 1;
      remaining--;
      giversFound++;
    }
    if (giversFound === 0) break;
  }
  return out;
}
