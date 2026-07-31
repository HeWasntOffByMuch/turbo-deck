/**
 * The seed every view opens on.
 *
 * Normally the wall clock, so each reload is a fresh world. But the seed decides
 * the terrain, where every tree stands and how the fight rolls, which makes an
 * unpinned seed useless for looking at the *renderer*: two screenshots of a
 * scene-look change would differ because the world differed, not because the
 * change did. `?seed=` pins it, so a before/after pair is the same world twice.
 *
 * Renderer-only: the sim is handed whatever number this returns and neither
 * knows nor cares where it came from.
 */
export function viewSeed(search: string = globalThis.location?.search ?? ''): number {
  const raw = new URLSearchParams(search).get('seed');
  const parsed = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed >>> 0 : Date.now() >>> 0;
}
