/**
 * How the ability pool refills (spec 068).
 *
 * One line, in one place, because two things now depend on agreeing about it
 * exactly: the sim regenerates the pool a tick at a time, and the client models
 * the same curve forward from the last number the server sent it so that a
 * button can be greyed out without waiting for a round trip. A second copy of
 * "plus regen, capped at max" would be a rulebook that drifts.
 *
 * Pure, and closed-form rather than a loop: regen is constant and the clamp is
 * a ceiling, so a hundred ticks of it is the same as one multiplication. The
 * client is often catching up several ticks at once and must land on exactly
 * what the sim would have.
 */
export function regenerated(
  resource: number,
  regenPerTick: number,
  maxResource: number,
  ticks: number,
): number {
  if (ticks <= 0) return Math.min(maxResource, Math.max(0, resource));
  return Math.min(maxResource, Math.max(0, resource) + regenPerTick * ticks);
}
