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
 * two grids are independent by design, so retuning either is a local change.
 * At 100 units a sprinting player crosses a chunk several times a second, which
 * is chatty but cheap; raising this is a one-line change with no protocol
 * impact, since chunk size is announced in the welcome message.
 */
export const CHUNK_SIZE = 100;

/**
 * How many chunks out from their own a player is told about. 3 gives a
 * 700x700-unit window, comfortably past the far edge of a zoomed-out camera.
 */
export const INTEREST_CHUNK_RADIUS = 3;

/**
 * Bumped whenever the wire format changes incompatibly; checked on connect.
 *
 * 2: the welcome carries the world seed (spec 063), so a client can build the
 * ground and the trees the server is colliding against.
 * 3: knockback and hitstop left the sim, and with them four fields of the combat
 * result and one derived stat (spec 065).
 */
export const PROTOCOL_VERSION = 3;

/** How long a dead player lies there before the server puts them back (spec 057). */
export const RESPAWN_DELAY_TICKS = SERVER_TICK_RATE * 3;

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
  /** Ceiling on simulated entities in one chunk, so a raid can't wedge a chunk. */
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
  maxEntitiesPerChunk: 12,
  correctionThreshold: 48,
  speedTolerance: 1.15,
  // 5 seconds at 60Hz, the same wall-clock cadence 100 ticks bought at 20Hz.
  spawnIntervalTicks: 300,
};

export type LiveConfigKey = keyof LiveConfig;

export const LIVE_CONFIG_KEYS: readonly LiveConfigKey[] = [
  'spawnRateMultiplier',
  'dropRateMultiplier',
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
