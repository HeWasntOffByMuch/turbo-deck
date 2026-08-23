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
 * This has to cover **what the camera can frame** at the widest zoom the game is
 * *sized for* -- `SUPPORTED_MAX_VIEW_HALF_WIDTH`, 420 since spec 202, rather
 * than the 1400 the slider still reaches. Measured through the real
 * `cameraFrustum` across every window shape a real monitor comes in, 420 reaches
 * 932 world units; 3 chunks of 400 guarantees 1200, which covers it.
 *
 * It has to be sized off the *window shape*, not just the zoom:
 * `internalRenderSize` trades height rather than capping the aspect past 2.53,
 * so horizontal ground reach keeps growing with the window and 32:9 is simply
 * where monitors stop. A pathological aspect at maximum zoom could still outrun
 * this, and the answer there would be a cap on the zoom rather than an
 * ever-wider window.
 *
 * Was 8, which guaranteed 3200 against the 3107 the *slider's* maximum frames.
 * That is a 17x17 window of 289 chunks against the 7x7 and 49 this is -- nearly
 * six times the interest set, permanently, for a zoom the game is not played at.
 * Past the supported band a body outside the window winks out, which is the
 * degradation the Display page's dev-setting warning names.
 *
 * `src/render/iso3d/world/interest.test.ts` asserts the relationship rather than
 * the numbers, so the next person to touch the camera finds out here.
 */
export const INTEREST_CHUNK_RADIUS = 3;

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
 * 18: a tenth entity field carrying the statuses a body is visibly holding
 * (spec 186). Spec 147 built a progression that is almost entirely
 * status-driven and replicated none of it; this is the wire half of showing it.
 * Only the ids `data/status-visuals.ts` names ride, as a table index rather
 * than a string, and each carries an absolute expiry so the mark drawn from it
 * needs no client state.
 * 19: a map chunk no longer carries baked walkability (spec 204). It was a run
 * list per chunk sent to every client, and its only reader was the editor's nav
 * overlay -- which loads the map off disk and has never streamed. Removed from
 * the document in the same change, so there is nothing left to send.
 */
export const PROTOCOL_VERSION = 19;

/**
 * How far from a map chunk a player may be and still be sent it (spec 072).
 *
 * In *map* chunks -- the document's own 616-unit geometry buckets -- not the
 * 400-unit interest chunks of {@link CHUNK_SIZE}. Three independent grids now
 * exist and merging them would couple a draw-call decision to a bandwidth one.
 *
 * Sized off what the camera can frame at `SUPPORTED_MAX_VIEW_HALF_WIDTH`,
 * exactly as {@link INTEREST_CHUNK_RADIUS} is, and for a worse failure: a
 * monster outside the interest window winks out, but terrain outside this one is
 * a hole with the sky showing through. 420 reaches 932 units and 2 chunks of 616
 * guarantees 1232.
 *
 * It has to be sized off the *window shape*, not just the zoom -- the same trap
 * `INTEREST_CHUNK_RADIUS` documents.
 *
 * Was 6, sized against the 3107 units the slider's own maximum frames: a 13x13
 * window of 169 chunks against the 5x5 and 25 this is. At the ~10ms a cold chunk
 * costs to bring resident (spec 213) that is a quarter-second of prefetch rather
 * than two and a half seconds, which is what makes bounded residency affordable
 * at all.
 *
 * **Nothing may make this a function of a client's zoom.** It is the guard that
 * bounds *where* a client may read, checked against the server's own position
 * for that player, and a radius derived from a value the client reported would
 * be the client widening its own read window. `map-radius.test.ts` asserts that
 * `MapChunkCache.wanted` does not read the zoom.
 *
 * `src/render/iso3d/world/map-radius.test.ts` asserts that relationship rather
 * than the literal 2.
 */
export const MAP_CHUNK_REQUEST_RADIUS = 2;

/**
 * How far a client keeps a chunk it has stopped asking for (spec 208).
 *
 * Derived from the request radius rather than chosen, because the one thing
 * eviction must not do is fight the streamer. A chunk is requested inside
 * `MAP_CHUNK_REQUEST_RADIUS` and dropped outside this, so the two chunks between
 * them are held and not asked for: a player crosses 1,232 units past the edge of
 * what they are streaming before anything goes, and the same distance back
 * before it is asked for again. There is no position at which one pass drops
 * what the next pass asks for, and `map-cache.test.ts` asserts that over every
 * position in a chunk rather than over one.
 *
 * The cost is what is held: 9x9 rather than 5x5, 81 chunks against 25 -- against
 * the 392 a circuit of the shipped map used to leave behind, and against a whole
 * 12,960-chunk world at the size this is heading for.
 *
 * Two rather than one because one is not "comfortably wider": at +1 the band is
 * a single chunk, and a player walking a diagonal crosses a corner in and out of
 * it within a few hundred units.
 */
export const MAP_CHUNK_KEEP_RADIUS = MAP_CHUNK_REQUEST_RADIUS + 2;

/**
 * How far a chunk may be from the *server's* own position and still be served
 * (spec 213).
 *
 * The pair of guards in `map-request.ts` have always been described as bounding
 * different things -- range bounds *where* a client may read, the bucket bounds
 * how fast -- and this is the third thing neither of them was bounding: the two
 * positions the range is measured between are not the same position.
 * `requestChunks` asks from `prediction.drawn` and `handleChunkRequest`
 * measures from the entity, correctly refusing to trust the client's claim. A
 * predicting client leads the server by its own latency, so whenever the two
 * straddle a chunk boundary the entire leading-edge column comes back
 * `OutOfRange` -- a whole 5-wide column on a measured fourteen-second run at
 * `MOVE_SPEED_HARD_MAX`, every one on the edge the body was running toward, and
 * every one legal a tick later. Spec 208 made that cost more rather than less:
 * at radius 2 a refused column is a fifth of everything the client holds, where
 * at 6 it was a thirteenth.
 *
 * One chunk of slack, and it is **derived rather than judged**. The sim already
 * keeps a client's claim within `correctionThreshold` of the server's position,
 * and `drawn` adds at most `MAX_EASED_OFFSET` of visual offset that has not
 * decayed yet -- under a hundred units of honest disagreement, on a grid whose
 * chunks are 616 units wide. A disagreement smaller than a chunk cannot move a
 * chunk index by more than one, so this is exactly the slack a correct client
 * needs and no more. `map-request.test.ts` asserts that relationship rather than
 * the number 3.
 *
 * It sits between the two radii spec 208 derived and disturbs neither:
 * {@link MAP_CHUNK_KEEP_RADIUS} is `R + 2`, so the band a client holds without
 * asking is still two chunks wide, and {@link MAP_CHUNK_BURST} still prices a
 * cold start off the *request* radius, which is what a client actually asks for.
 *
 * What it does not widen: a client claiming to stand across the map is still
 * refused, because the claim never enters this arithmetic at all.
 */
export const MAP_CHUNK_SERVE_RADIUS = MAP_CHUNK_REQUEST_RADIUS + 1;

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
 * Ms between the server's protocol-level pings (spec 197).
 *
 * The application heartbeat rides the client's timers, and Chrome throttles a
 * page hidden for five minutes down to one timer firing a minute -- so the
 * heartbeat that has to be relied on is the one the page is not holding. A
 * WebSocket pong is answered in the peer's network stack; the tab's JavaScript
 * never sees it and cannot be throttled out of it.
 *
 * Three chances inside {@link CONNECTION_TIMEOUT_TICKS}, so a single dropped
 * pong is not a disconnection. `transport-ws.test.ts` asserts that relationship
 * rather than trusting the two numbers to be edited together.
 */
export const SERVER_PING_MS = 3000;

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
 * 64 covered the 56-chunk map outright, and then the map grew to 210 and the
 * symptom this comment predicted -- "the far half of the world arrives late" --
 * is exactly what happened: the radius can ask for 169 chunks, 105 of them came
 * out of the refill at 16/s, and the cold start trickled for six seconds
 * (spec 165).
 *
 * So the burst is now **derived** rather than typed in. The quantity it has to
 * cover is not "the map" -- a map may be arbitrarily larger than what one
 * player can see -- it is every chunk {@link MAP_CHUNK_REQUEST_RADIUS} is
 * allowed to ask for, which is the (2R+1)^2 square around them. Growing the map
 * again cannot re-open this; only widening the radius can, and that moves this
 * with it.
 *
 * What the bucket still bounds is the case it was written for: a client
 * re-asking for one permanently-in-range chunk forever. The refill is what
 * prices that, and it is the only half of this pair that is a judgement --
 * 32/s is ~380 KB/s of serialization sustained, against a player who would have
 * to cross a whole 616-unit chunk thirty-two times a second to need it.
 */
export const MAP_CHUNK_BURST = (2 * MAP_CHUNK_REQUEST_RADIUS + 1) ** 2;
/**
 * The sustained rate, and since spec 202 it is derived rather than typed in.
 *
 * It was 32, chosen against a burst of 169. Narrowing the request radius took
 * the burst to 25 and left the refill **above** it -- a bucket that refills more
 * than a whole burst every second is not a throttle at all, which is what
 * `map-radius.test.ts` caught the moment the radius moved.
 *
 * So it is derived from the same quantity the burst is. Crossing one chunk
 * boundary brings a whole edge row of the window into range -- `2R+1` chunks --
 * and twice that per second is the rate. At the shipped radius that is 10/s
 * against the ~1.25/s a player walking at 155 units/s actually needs (a
 * 616-unit chunk takes four seconds to cross), so it is eight times what
 * ordinary play asks for and still a third of a burst.
 *
 * Reassuringly it also reproduces roughly the old constant at the old radius:
 * `2 * 13` is 26 against the 32 that was there. The number was about right and
 * only its *relationship* to the burst was missing.
 */
export const MAP_CHUNK_REFILL_PER_SECOND = 2 * (2 * MAP_CHUNK_REQUEST_RADIUS + 1);

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
