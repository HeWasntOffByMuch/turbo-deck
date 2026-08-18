/**
 * Server-wide tuning (spec 056).
 *
 * Split into two halves on purpose: constants that are baked into the wire
 * format or the sim's shape and can only change with a restart, and
 * {@link LiveConfig} -- the knobs an admin turns at runtime without one.
 */

/**
 * The authoritative simulation rate (spec 057).
 *
 * 60Hz, matching `src/sim/`, and deliberately *not* the broadcast rate. Spec 056
 * ran the sim at 20 because it sat beside the single-player game and nothing
 * depended on it; once the game itself routes through here, a 50ms tick cannot
 * express the 66ms perfect-parry window (`PERFECT_WINDOW_TICKS` = 4 at 60Hz)
 * that the card economy is built on -- it would round a quarter tighter or half
 * again looser, and that timing is the game.
 *
 * Keeping 60 also means every duration constant in `src/sim/constants.ts` keeps
 * meaning what it says, and CLAUDE.md's fixed-60-ticks rule stays true of the
 * whole codebase rather than half of it.
 */
export const SERVER_TICK_RATE = 60;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_RATE;

/**
 * Deltas go out every Nth tick, so the network rate is 20Hz while the sim runs
 * at 60. These were one number in spec 056 and separating them is the whole
 * point of 057: interest management and delta tracking were never coupled to
 * how often the world advanced, only to how often it is described.
 */
export const BROADCAST_EVERY_N_TICKS = 3;

/** Deltas per second, for the welcome message and for sanity in tests. */
export const BROADCAST_RATE = SERVER_TICK_RATE / BROADCAST_EVERY_N_TICKS;

/**
 * Edge length of a network chunk, in world units.
 *
 * This is an interest-management grid and has nothing to do with
 * `src/terrain/chunk.ts`, whose 616-unit chunks are sized for draw calls. The
 * two grids are independent by design, so retuning either is a local change --
 * and it has no protocol impact, since chunk size is announced in the welcome.
 *
 * Was 100, which turned out to be far too fine once something actually drew the
 * world: bodies winked out well inside the frame. See {@link INTEREST_CHUNK_RADIUS}.
 */
export const CHUNK_SIZE = 400;

/**
 * How many chunks out from their own a player is told about.
 *
 * This has to cover **what the camera can frame**, and the old 3-at-100-units
 * did not come close. Measured against the real camera at a 1280x800 window: the
 * default zoom frames +-320 by +-441 world units and the widest frames +-1400 by
 * +-1927, against an interest window that reached 300 to 400. Monsters vanished
 * on screen at every zoom, which is exactly what was reported.
 *
 * 8 at 400 units guarantees 3200, which covers the widest zoom on a 32:9
 * monitor (~3110). It has to be sized off the *window shape*, not just the zoom:
 * `internalRenderSize` trades height rather than capping the aspect past 2.53,
 * so the horizontal ground reach keeps growing with the window and there is no
 * ceiling to aim at. 32:9 is where real monitors stop; a pathological aspect at
 * maximum zoom could still outrun this, and the answer there would be a cap on
 * the zoom rather than an ever-wider window.
 *
 * The window is 17x17 chunks -- 289 rather than the 49 it was. That is 289 map
 * lookups per connection per broadcast, twenty times a second, which is nothing.
 *
 * Worth being straight about the consequence: the generated world is ~4400 by
 * ~4100, so a window this wide contains most of it and culling currently culls
 * almost nothing. That is the right trade -- a player seeing bodies wink out
 * inside the frame is a bug, and an optimisation with nothing to optimise is
 * not -- but interest management only starts earning its keep again when the
 * map outgrows the camera.
 *
 * `src/render/iso3d/world/interest.test.ts` asserts the relationship rather than
 * the numbers, so the next person to touch the camera finds out here.
 */
export const INTEREST_CHUNK_RADIUS = 8;

/**
 * Bumped whenever the wire format changes incompatibly; checked on connect.
 *
 * 2: the welcome carries the world seed (spec 063), so a client can build the
 * ground and the trees the server is colliding against.
 * 3: knockback and hitstop left the sim, and with them four fields of the combat
 * result and one derived stat (spec 065).
 * 4: an ability request says which input it was made on, so a commit lands at
 * the same point in the input stream on both ends (spec 067).
 * 5: the cooldown message carries the caster's live resource and the tick it was
 * true on, so a client can decide whether it can afford a blow (spec 069).
 * 6: an ability request names the entity it means to hit, not just a point, so
 * a right-click lands on the unit under it (spec 070).
 * 7: the world is a map document rather than a seed, so terrain travels as
 * `MapInfo` plus requested `MapChunk`s instead of being rederived (spec 072).
 * 8: a client can ask to be told what the map's spawners are doing, for the
 * overlay behind the "show spawners" setting (spec 076).
 * 9: the stat block names the body's auto-attack, so a client knows what its
 * right-click reaches with rather than assuming a sword (spec 079).
 * 10, 11: two bumps that were never written down here. Recovered in spec 145
 * rather than left as a gap, since this list is the only account of what a
 * version number means and a hole in it makes every entry below it suspect.
 * 12: an entity delta can carry who a player is -- their name and their turn
 * rate -- so another player is somebody rather than an anonymous shape, and
 * `turn-limits.ts` stops guessing a rate it was never sent (spec 145).
 * 13: the pong says how deep this connection's input queue is, so the client
 * can steer its own clock by it rather than drifting until the queue caps and
 * the server drops the oldest thing in it (spec 148).
 * 14: an input says how far behind the server's clock the world it was made
 * against is being drawn, so a blow can be resolved against what the attacker
 * was actually looking at (spec 149).
 * 15: the welcome issues a session token and a hello may present one, so a
 * dropped socket can come back to the same body instead of spawning a new one;
 * and a goodbye says a disconnection was meant (spec 150).
 * 16, 17: items drop (spec 158). A *sixth* entity kind -- spec 156's mote took
 * the fifth -- plus a `LootDrop` describing one, with its identity withheld
 * until an authoritative reveal tick and carrying the point it was thrown from
 * so every client draws the same arc, and a `PickUpItem` to take it. The bump
 * also covers spec 156's `Restoration` and its mote kind, which landed without
 * one.
 */
export const PROTOCOL_VERSION = 17;

/**
 * How far from a map chunk a player may be and still be sent it (spec 072).
 *
 * In *map* chunks -- the document's own 616-unit geometry buckets -- not the
 * 400-unit interest chunks of {@link CHUNK_SIZE}. Three independent grids now
 * exist and merging them would couple a draw-call decision to a bandwidth one.
 *
 * Sized off what the camera can frame, exactly as {@link INTEREST_CHUNK_RADIUS}
 * is, and for a worse failure: a monster outside the interest window winks out,
 * but terrain outside this one is a hole with the sky showing through.
 *
 * It has to be sized off the *window shape*, not just the zoom -- the same trap
 * `INTEREST_CHUNK_RADIUS` documents. 4 looked right against the widest zoom's
 * +-1400 by +-1927 on a 16:9 window and was wrong: `internalRenderSize` trades
 * height rather than capping the aspect, so a 32:9 monitor at maximum zoom
 * reaches ~3107 units and radius 4 guarantees only 4 * 616 = 2464. 6 guarantees
 * 3696, which covers it with room to spare.
 *
 * `src/render/iso3d/world/map-radius.test.ts` asserts that relationship rather
 * than the literal 6 -- it is the test that caught the 4.
 */
export const MAP_CHUNK_REQUEST_RADIUS = 6;

/**
 * How long a chunk request goes unanswered before the client asks again
 * (spec 147). Three seconds at 60Hz.
 *
 * Nothing retransmits: a lost `RequestChunk` is a question the server never
 * heard, and a lost `MapChunk` is an answer that never came. Either way the
 * client used to wait forever, and the ground stayed missing for the session --
 * which is what a browser on a 5% wire actually looked like.
 *
 * Three seconds rather than something snappier because a chunk is large and the
 * server throttles: re-asking early costs bandwidth on exactly the connection
 * that has none. A hole for three seconds is a hole somebody might notice; a
 * hole forever is a bug report.
 */
export const CHUNK_RETRY_TICKS = 180;

/**
 * How far a blow may be resolved into the past (spec 149). 200ms at 60Hz.
 *
 * Three readings agree on twelve. It is under half the shortest wind-up in the
 * table (27 ticks), so a dodge begun in the first half of any wind-up still
 * works whatever the attacker's connection -- which is the rule `landOnTarget`
 * says the whole design rests on. It is exactly the worst connection
 * `latency.test.ts` characterises, so compensation covers everything prediction
 * was measured against and nothing beyond. And at 155 units/s it is about two
 * body-widths of cover, which is the price paid by whoever thought they had got
 * behind the rock.
 */
export const MAX_REWIND_TICKS = 12;

/**
 * How long a dropped player's body stands in the world before it is reaped
 * (spec 150). Thirty seconds at 60Hz.
 *
 * Comfortably past the reconnecting channel's whole backoff ladder (~15s), so a
 * client that is going to come back has come back. The body standing there is
 * deliberate: it is what stops pulling the plug being an escape from a fight.
 * The trade is *not* held for it -- see `disconnect`.
 */
export const RESUME_GRACE_TICKS = 1800;

/**
 * How long a connection may say nothing before it is treated as lost
 * (spec 150). Ten seconds at 60Hz.
 *
 * The half a `close` event cannot cover: a socket killed by a dead router or a
 * suspended phone never delivers one, and before this its entity stayed
 * forever. The client pings every 30 ticks, so this is twenty missed
 * heartbeats -- long enough that a stall is not a disconnection.
 */
export const CONNECTION_TIMEOUT_TICKS = 600;

/**
 * Token bucket on chunk sends, per connection (spec 072).
 *
 * The radius check bounds *where* a client may read; this bounds how fast. They
 * are not the same guard: every chunk under a standing player is permanently in
 * range, so without a bucket a client can ask for one legal chunk in a loop and
 * make the server serialize ~12 KB per request for as long as it likes.
 *
 * The burst has to cover a **whole cold start**, not part of one. 24 did not,
 * and the effect was measurable: the shipped map's 56 chunks took about five
 * seconds to arrive over a loopback, because the first 24 went instantly and the
 * remaining 32 trickled in at the refill rate. The terrain visibly filled in and
 * the trees appeared last. That is the throttle shaping normal play, which is
 * exactly what it is not for.
 *
 * 64 covers the shipped map outright, so a cold start is paced by the link and
 * by `CHUNK_REQUESTS_PER_PASS`, never by this. What the bucket still bounds is
 * the case it was written for: a client re-asking for one permanently-in-range
 * chunk forever. At 16/s sustained that costs ~190 KB/s of serialization, and a
 * player would have to cross a whole 616-unit chunk sixteen times a second to
 * need it legitimately.
 *
 * A map much larger than this one would want the burst raised with it, or the
 * cold start starts trickling again -- which is why the first symptom to look
 * for is "the far half of the world arrives late".
 */
export const MAP_CHUNK_BURST = 64;
export const MAP_CHUNK_REFILL_PER_SECOND = 16;

/**
 * How far the client's modelled resource may be from the server's before it is
 * told (spec 069).
 *
 * Small, because it gates a yes/no: sitting a hair under a cost and believing
 * you are over it is a predicted cast the server refuses, which is the visible
 * failure this whole spec exists to avoid. Well above f32 wire rounding.
 */
export const RESOURCE_EPSILON = 0.05;

/**
 * Ceiling on {@link LiveConfig.lootRevealScale} (spec 158).
 *
 * Picking a drop up is legal throughout its reveal, so a long delay costs
 * nobody their loot -- but a reveal that outlived `DROP_LIFETIME_TICKS` would
 * leave an item that expired without ever having said what it was, which is a
 * bug with a config value in front of it. Ten is far past any tuning pass and
 * far short of the lifetime.
 */
export const MAX_REVEAL_SCALE = 10;

/**
 * How many drops one connection may have waiting for a turn (spec 172).
 *
 * A drop waits for the body to come round to it, so a player emptying a bag
 * fast can genuinely have several in flight -- and they should all happen, in
 * the order they were asked for. What this bounds is the absurd case: a client
 * queueing a thousand aims is a client making the server turn for a minute.
 * Well past four clicks inside one turn, which is the most a hand can do.
 */
export const MAX_PENDING_DROPS = 8;

/**
 * How long a drop waits for the heading it asked for, in ticks (spec 172).
 *
 * Two seconds, which is several times the longest turn a body in this game can
 * be asked for -- half a revolution at the slowest authored `turnRate`. It is
 * not a pacing knob: it is the answer to "what if the heading never arrives",
 * which a body that cannot turn at all (a `turnRate` of zero) and a body held
 * facing elsewhere by something longer than itself can both produce. The item
 * is still in the bag when it fires, so the cost of it being wrong is a refusal
 * rather than a loss.
 */
export const DROP_TURN_TIMEOUT_TICKS = 120;

// There is deliberately no respawn delay here any more (spec 164). A dead player
// lies there until they ask to get up -- `ClientMessageType.Respawn` -- so the
// three-second timer this used to hold has no reader, and a constant nothing
// reads is a claim that something does.

/** Body radius used for server-side movement collision, matching the sim's player. */
export const SERVER_PLAYER_RADIUS = 16;

/**
 * How many ticks of input a client may have in flight before the server stops
 * buffering. Sized well past a bad connection's round trip; past it the oldest
 * inputs are dropped rather than letting a stalled client bank a rewind. At
 * 60Hz this is a second of backlog.
 */
export const MAX_BUFFERED_INPUTS = 60;

/**
 * Knobs an admin can turn on a running server (`admin:setConfig`). Every value
 * is a plain number so the wire encoding stays a name plus an f64, and so a
 * future config UI needs no per-key schema.
 */
export interface LiveConfig {
  /** Scales how often the ambient spawner adds an entity. 0 disables spawning. */
  readonly spawnRateMultiplier: number;
  /** Scales drop chance on entity death. Read by the loot roll, not by the sim's shape. */
  readonly dropRateMultiplier: number;
  /**
   * Scales how long a drop's rarity takes to resolve (spec 158).
   *
   * A presentation knob and only that -- it moves the reveal clock stamped on a
   * drop at the instant it lands and reaches nothing about what dropped. `0`
   * reveals everything at once, which is what a load test and the balance
   * harness want; `1` is the authored timing.
   *
   * Snapshotted per drop, so turning it affects the next one rather than the one
   * already lying in the grass -- the rule spec 144 established for attack
   * timing, and it matters here for the same reason: a reveal whose finish line
   * moved while it ran could be put in the past.
   */
  readonly lootRevealScale: number;
  /**
   * Ceiling on simulated entities in one chunk, so a raid can't wedge a chunk.
   * A safety valve rather than a density knob -- it moved with `CHUNK_SIZE`,
   * which grew sixteenfold in area.
   */
  readonly maxEntitiesPerChunk: number;
  /**
   * Divergence in world units past which the server stops trusting a client's
   * predicted position and sends a hard correction. Under it, the client's own
   * prediction is left alone -- that is the whole point of reconciliation.
   */
  readonly correctionThreshold: number;
  /**
   * Slack on the per-tick distance check before an input is treated as a speed
   * hack. 1.15 absorbs float drift and a tick of jitter without opening a
   * meaningful cheating window.
   */
  readonly speedTolerance: number;
  /**
   * Ticks between ambient spawn attempts in an active chunk, before the
   * multiplier. In *ticks*, so it had to move with the rate change in spec 057
   * -- left at its old value the 60Hz sim would have tripled monster density
   * against a number nobody had touched.
   */
  readonly spawnIntervalTicks: number;
}

export const DEFAULT_LIVE_CONFIG: LiveConfig = {
  spawnRateMultiplier: 1,
  dropRateMultiplier: 1,
  lootRevealScale: 1,
  maxEntitiesPerChunk: 40,
  correctionThreshold: 48,
  speedTolerance: 1.15,
  // 5 seconds at 60Hz, the same wall-clock cadence 100 ticks bought at 20Hz.
  spawnIntervalTicks: 300,
};

export type LiveConfigKey = keyof LiveConfig;

export const LIVE_CONFIG_KEYS: readonly LiveConfigKey[] = [
  'spawnRateMultiplier',
  'dropRateMultiplier',
  'lootRevealScale',
  'maxEntitiesPerChunk',
  'correctionThreshold',
  'speedTolerance',
  'spawnIntervalTicks',
];

export function isLiveConfigKey(key: string): key is LiveConfigKey {
  return (LIVE_CONFIG_KEYS as readonly string[]).includes(key);
}

/**
 * Holds the live config behind a setter that validates, so an admin typo can
 * never put a NaN into the sim. Reads return a frozen snapshot: the sim takes
 * its config once per tick and never sees it change mid-step.
 */
export class LiveConfigStore {
  private current: LiveConfig;

  constructor(initial: LiveConfig = DEFAULT_LIVE_CONFIG) {
    this.current = { ...initial };
  }

  get(): LiveConfig {
    return this.current;
  }

  /**
   * Applies one key. Returns the clamped value that was stored, or null when
   * the key is unknown or the value is not a finite number -- the caller turns
   * that into a rejection the admin sees, rather than silently doing nothing.
   */
  set(key: string, value: number): number | null {
    if (!isLiveConfigKey(key)) return null;
    if (!Number.isFinite(value)) return null;
    const stored = clampConfigValue(key, value);
    this.current = { ...this.current, [key]: stored };
    return stored;
  }

  reset(): void {
    this.current = { ...DEFAULT_LIVE_CONFIG };
  }
}

/** Per-key sane bounds. Multipliers may go to zero (off) but never negative. */
function clampConfigValue(key: LiveConfigKey, value: number): number {
  switch (key) {
    case 'spawnRateMultiplier':
    case 'dropRateMultiplier':
      return Math.max(0, Math.min(100, value));
    // Bounded by `MAX_REVEAL_SCALE` rather than by the 100 above: a reveal that
    // outlived its drop would leave an item that expired without ever having
    // said what it was, which is a bug with a config value in front of it.
    case 'lootRevealScale':
      return Math.max(0, Math.min(MAX_REVEAL_SCALE, value));
    case 'maxEntitiesPerChunk':
      return Math.max(0, Math.min(1000, Math.floor(value)));
    case 'correctionThreshold':
      return Math.max(1, Math.min(10000, value));
    case 'speedTolerance':
      return Math.max(1, Math.min(4, value));
    case 'spawnIntervalTicks':
      return Math.max(1, Math.min(100000, Math.floor(value)));
  }
}
