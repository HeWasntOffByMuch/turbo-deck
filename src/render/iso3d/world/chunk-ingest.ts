/**
 * What ground is still owed a mesh, and what ground owes its trees (spec 165).
 *
 * Two decisions used to be taken implicitly inside `view.ts`'s ingest loop, and
 * the grown map turned both of them into stutter.
 *
 * **How much to mesh.** Every chunk that arrived in a frame was meshed in that
 * frame, plus up to four edge neighbours each -- a pump of arrivals is up to
 * forty full geometry rebuilds between one paint and the next. Spec 165 made
 * that a queue with a per-frame budget; spec 180 took the meshing off the
 * thread entirely, so what is left here is the *ledger* -- offered when the
 * ground lands, completed when its triangles come back. `pending` therefore
 * means "offered and not yet on screen", which is what the load gate always
 * read it as meaning and not what it meant.
 *
 * **When to rebuild the props.** The first rule was two frames with nothing
 * arriving. Deltas land every 50ms and frames every ~16ms, so *there are always
 * two quiet frames between deltas* -- the settle fired between every pump of the
 * stream rather than once at the end of it, and each firing rebuilt all 6942
 * props in the world. The second rule was a wall-clock quiet period over the
 * whole stream, and it went too far the other way: a cold start is never quiet
 * until its last chunk lands, so every tree in the world appeared at once,
 * seconds after the ground beneath it.
 *
 * The rule now is per *region*. The prop field is bucketed into regions for
 * culling already (spec 086), and a region whose own ground has stopped moving
 * can have its trees drawn whatever the rest of the map is doing -- which is
 * both the earliest that is correct and the latest anybody would want.
 *
 * Pure -- no three.js, no DOM, and time is an argument, so a test drives a whole
 * cold start by handing it numbers.
 */

import type { ChunkRef } from '../../../server/client/streamed-map.js';

export interface WorldRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface IngestOptions {
  /** Wall-clock quiet before the props are rebuilt. Must exceed the delta gap. */
  readonly settleMs: number;
  /** The prop field's own bucketing step, so a rect lands on region bounds. */
  readonly regionSize: number;
  /**
   * How long a region whose ground is *incomplete* waits before its trees are
   * drawn anyway (spec 180).
   *
   * The completeness rule is a rule about the common case: a leading-edge
   * region rebuilt once its whole ground is in is rebuilt once instead of two
   * to four times. What it cannot decide is ground that is declared and is
   * never coming -- a chunk outside the request radius arrives when the player
   * walks toward it and not before, and a region straddling that boundary would
   * hold its trees for as long as they stayed away. So the settle timer stays,
   * lengthened: completeness wins a race it can win quickly, and the clock ends
   * one it cannot.
   */
  readonly incompleteHoldMs: number;
  /**
   * Regions handed back per flush.
   *
   * Rebuilding one region's props is ~60ms on the grown map, so several in a
   * frame is a visible lurch even though each is small against the whole field.
   * One at a time turns a lurch into a ripple: the regions still settle in the
   * order their ground did, just a frame apart.
   */
  readonly regionsPerFlush: number;
  /**
   * How long an offered chunk may go unmeshed before it stops counting
   * (spec 214).
   *
   * The ledger is a promise in two halves -- `offer` when the ground lands and
   * `complete` when its triangles come back -- and until this existed nothing
   * ever failed the second half. A mesh reply can simply not arrive: the worker
   * drops one for a layer it cannot mesh or a chunk that will not build, and the
   * renderer skips `complete` when the scene refuses the adopt. Nothing re-offers
   * and nothing aged the queue out, so one lost reply held its regions `inFlight`
   * **for the session** -- their trees never drawn -- and left `pending` above
   * zero forever, which is the count the load gate and the first ground build
   * both wait on.
   *
   * Generous rather than tight, because this is a backstop and not a schedule:
   * a chunk swept while its mesh was merely slow costs one extra prop rebuild,
   * and a chunk swept too late costs nothing at all, so the only mistake worth
   * avoiding is sweeping a live one.
   */
  readonly meshTimeoutMs: number;
}

export class ChunkIngest {
  private readonly options: IngestOptions;
  /** Queued in arrival order, one entry per `(layer, cx, cz)`. */
  private readonly queue = new Map<string, ChunkRef>();
  /** When each queued chunk was offered, so one that never came back ages out. */
  private readonly offeredAt = new Map<string, number>();
  /** Chunks swept for never being meshed. A readout, so a wedge is visible. */
  private abandoned = 0;
  /**
   * Region keys whose props are stale, against when their ground last moved.
   *
   * Per region rather than one clock for the whole map (spec 165 follow-up 5).
   * The settle used to be global -- every chunk drained and the *whole stream*
   * quiet -- and on a cold start the stream is never quiet until the last chunk
   * of the last pump has landed. So the trees appeared all at once, seconds
   * after the ground they stand on, which is the "trees show up really late"
   * report. A region's own ground going quiet is the fact that actually decides
   * whether its trees can be drawn.
   */
  private readonly dirtyRegions = new Map<string, number>();
  /** Chunks drawn over the session. */
  private meshedTotal = 0;
  /** When a chunk was last offered. See {@link quietForMs}. */
  private lastOfferMs = 0;

  constructor(options: IngestOptions) {
    this.options = options;
  }

  /**
   * Queue chunks that need meshing.
   *
   * Keyed by coordinate, so a chunk re-offered because a neighbour arrived
   * replaces the queued copy rather than meshing the same ground twice -- during
   * a burst that is the common case, not the corner one: five chunks arriving in
   * a row along an edge each re-dirty the one before them.
   */
  offer(chunks: readonly ChunkRef[], nowMs: number): void {
    if (chunks.length === 0) return;
    this.lastOfferMs = nowMs;
    for (const chunk of chunks) {
      const key = `${chunk.layer}:${chunk.cx},${chunk.cz}`;
      this.queue.set(key, chunk);
      // Re-offered means re-promised: the clock restarts, so a chunk redrawn
      // because a neighbour landed is not swept for the first offer's age.
      this.offeredAt.set(key, nowMs);
      // Touched on arrival as well as on meshing, so a region with ground still
      // in flight cannot settle just because the queue reached it slowly.
      this.touch(chunk.rect, nowMs);
    }
  }

  /**
   * Mark one chunk drawn, and say whether it was owed (spec 180).
   *
   * This replaces `takeMesh`, and the change of shape is the change of design:
   * meshing used to be something the frame *did*, so the queue was drained by
   * whoever was about to do it. It is something another thread does now, so the
   * queue is drained by the result coming back -- which makes `pending` mean
   * "offered and not yet on screen" rather than "not yet started", and makes
   * the load gate's count honest for the first time.
   *
   * A chunk re-offered while its mesh was in flight is completed by the first
   * result and re-completed by the second, which returns false and does
   * nothing. That is harmless rather than merely tolerable: what a settled
   * region needs is that the *store* has its ground, and the store had it at
   * insert -- the mesh is the picture, not the data the trees stand on.
   */
  complete(layer: number, cx: number, cz: number, nowMs: number): boolean {
    const key = `${layer}:${cx},${cz}`;
    const chunk = this.queue.get(key);
    if (!chunk) return false;
    this.queue.delete(key);
    this.offeredAt.delete(key);
    this.meshedTotal++;
    this.touch(chunk.rect, nowMs);
    return true;
  }

  /**
   * The rectangles owed a prop rebuild, or nothing while the stream is live.
   *
   * Empties itself per region: a caller that takes a rectangle owns it.
   *
   * A region is handed back once its own ground has been quiet for `settleMs`,
   * nothing still queued overlaps it, and `covered` says every chunk the map
   * declares over it has arrived. The second matters because rebuilding props
   * over ground about to be re-meshed is work done twice; the third because a
   * region on the stream's leading edge is otherwise rebuilt once per column
   * that reaches it. `incompleteHoldMs` is the backstop for ground that is
   * declared and never coming.
   */
  takePropRects(
    nowMs: number,
    budget = this.options.regionsPerFlush,
    covered: (rect: WorldRect) => boolean = () => true,
  ): readonly WorldRect[] {
    this.sweep(nowMs);
    if (this.dirtyRegions.size === 0) return [];

    // Regions any queued chunk still touches are not settled, whatever their
    // clock says: rebuilding props over ground about to be re-meshed is work
    // done twice and trees standing at heights that are about to change.
    const inFlight = new Set<string>();
    for (const chunk of this.queue.values()) {
      for (const key of this.regionsOf(chunk.rect)) inFlight.add(key);
    }

    const size = this.options.regionSize;
    const out: WorldRect[] = [];
    for (const key of [...this.dirtyRegions.keys()].sort()) {
      if (out.length >= budget) break;
      if (inFlight.has(key)) continue;
      const touched = this.dirtyRegions.get(key) ?? 0;
      const since = nowMs - touched;
      if (since < this.options.settleMs) continue;
      const [rx, rz] = key.split(',').map(Number) as [number, number];
      const rect = { minX: rx * size, minZ: rz * size, maxX: (rx + 1) * size, maxZ: (rz + 1) * size };
      // Quiet is not the same as finished (spec 180). A region whose ground is
      // still arriving is rebuilt again the moment it does, so it waits -- but
      // only until the longer clock, because ground outside the request radius
      // is declared, absent, and not on its way.
      if (!covered(rect) && since < this.options.incompleteHoldMs) continue;
      this.dirtyRegions.delete(key);
      out.push(rect);
    }
    return out;
  }

  /**
   * Drop what is owed for regions whose ground has gone (spec 215).
   *
   * A region is dirtied when its ground moves and cleared when its trees are
   * handed out. Eviction is the third way it can end: the ground it was dirtied
   * for is not coming back until the player does, and `takePropRects` would
   * otherwise hand it out anyway once `incompleteHoldMs` expired -- a region
   * composed on the far thread out of props that thread has also evicted, to
   * take down batches this side took down already.
   *
   * A predicate over this ledger rather than a list of what was dropped, and
   * that is the whole of it: the regions *drawn* are not the regions *owed*. A
   * region whose ground arrived and was evicted again inside one settle period
   * was never drawn, so it appears in no drop list -- and it is precisely the
   * one still sitting here waiting for its clock to run out.
   *
   * Answers how many entries went, because "nothing is owed for ground we do
   * not have" is otherwise a claim with nothing to read it off.
   */
  forgetRegions(lost: (key: string) => boolean): number {
    let gone = 0;
    for (const key of [...this.dirtyRegions.keys()]) {
      if (lost(key) && this.dirtyRegions.delete(key)) gone++;
    }
    return gone;
  }

  /** Chunks queued and not yet meshed. */
  get pending(): number {
    return this.queue.size;
  }

  /**
   * Chunks given up on for never being meshed (spec 214).
   *
   * A readout rather than an input -- nothing branches on it. It is here because
   * a wedge that is quietly worked around is a wedge nobody ever fixes, and this
   * is the number that says one happened.
   */
  get abandonedCount(): number {
    return this.abandoned;
  }

  /**
   * Give up on chunks whose mesh never came back (spec 214).
   *
   * Dropping one from the queue is the whole repair, and it is the *right*
   * repair rather than a shrug: what a settled region needs is that the store
   * has its ground, and the store had it at insert -- the mesh is the picture,
   * not the data the trees stand on. So the region stays dirty and rebuilds from
   * the store on the next flush, which is exactly what would have happened if
   * the reply had arrived.
   *
   * The region is deliberately **not** touched here. Touching restarts its
   * settle clock, and a chunk being swept is the one case where the ground has
   * demonstrably stopped moving -- restarting the clock would hold the trees
   * back for another settle for the sake of an event that is the absence of one.
   *
   * A late reply for a swept chunk finds no key and returns false, which is what
   * `complete` already does for anything it does not hold.
   */
  private sweep(nowMs: number): void {
    if (this.queue.size === 0) return;
    for (const [key, offered] of this.offeredAt) {
      if (nowMs - offered < this.options.meshTimeoutMs) continue;
      this.offeredAt.delete(key);
      if (this.queue.delete(key)) this.abandoned++;
    }
  }

  /**
   * Regions still owed a prop rebuild.
   *
   * Read by the load gate, which waits for it: a region rebuilt after the world
   * is shown is a ~170ms hitch in a world that has told the player it is ready
   * (spec 165 follow-up 7). Behind the loading screen it is just part of the
   * load.
   */
  get dirtyRegionCount(): number {
    return this.dirtyRegions.size;
  }

  /** Chunks meshed over the session. For the loading gate and the readout. */
  get meshed(): number {
    return this.meshedTotal;
  }

  /**
   * How long since anything last arrived, anywhere.
   *
   * The *global* clock, kept beside the per-region ones because two different
   * jobs want two different answers: a region's trees can be drawn as soon as
   * that region stops moving, but anything derived from the whole world -- the
   * collider set, the nav grid -- should wait for the whole world to stop.
   */
  quietForMs(nowMs: number): number {
    return nowMs - this.lastOfferMs;
  }

  /** Nothing queued and nothing owed -- the stream has caught up. */
  get idle(): boolean {
    return this.queue.size === 0 && this.dirtyRegions.size === 0;
  }

  /** Mark every region the rectangle touches as moved at `nowMs`. */
  private touch(rect: WorldRect, nowMs: number): void {
    for (const key of this.regionsOf(rect)) this.dirtyRegions.set(key, nowMs);
  }

  /** Every region key the rectangle touches, inclusive of the far edge. */
  private regionsOf(rect: WorldRect): readonly string[] {
    const size = this.options.regionSize;
    const lox = Math.floor(rect.minX / size);
    const loz = Math.floor(rect.minZ / size);
    const hix = Math.floor(rect.maxX / size);
    const hiz = Math.floor(rect.maxZ / size);
    const keys: string[] = [];
    for (let rz = loz; rz <= hiz; rz++) {
      for (let rx = lox; rx <= hix; rx++) keys.push(`${rx},${rz}`);
    }
    return keys;
  }
}
