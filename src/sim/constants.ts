export const TICK_RATE = 60;

// Top-down rectangular arena, in world units. Roomy so a small population and
// their grazing read; the camera follows the player across it.
export const ARENA_WIDTH = 1200;
export const ARENA_HEIGHT = 900;

export const PLAYER_RADIUS = 16;
export const ENEMY_RADIUS = 22;

export const ENEMY_MOVE_SPEED_PER_TICK = 1.0;

// --- MOBA-style player movement (spec 028) ---
// Base movement speed in world units per second (HoN-style). The sim converts
// it to a per-tick step via TICK_RATE. Speed is hard-capped to [100, 550] u/s,
// mirroring HoN's caps.
export const PLAYER_BASE_MOVE_SPEED = 300;
export const MOVE_SPEED_HARD_MIN = 100;
export const MOVE_SPEED_HARD_MAX = 550;
// Turn rate in degrees per second: how fast the unit can rotate its heading.
// 360 => 0.5s to turn 180 degrees; 540 is nimble but not instant.
export const PLAYER_TURN_RATE = 540;
// A unit must be facing within this many degrees of its intended move direction
// before it begins to translate; otherwise it rotates in place. So a full 180
// reversal only needs a 45-degree turn (135 from the opposite heading) to start
// moving, then it travels in a straight line (no arc).
export const MOVE_FACING_THRESHOLD_DEG = 135;
// A move order is considered fulfilled once the unit is within this distance of
// the destination, at which point the standing order is cleared.
export const MOVE_ARRIVE_EPS = 2;

export const PLAYER_MAX_HEALTH = 100;
// Reach of the player's melee strike, measured from the player's centre to the
// enemy's centre it must be within (ENEMY_RADIUS is added at the call site).
export const PLAYER_ATTACK_RANGE = 50;
// Squared cosine of the aim cone half-angle. 0.5 == cos(45 deg)^2, a 90 deg cone.
export const ATTACK_ARC_COS_SQ = 0.5;
export const PLAYER_ATTACK_DAMAGE = 8;
export const PLAYER_ATTACK_COOLDOWN_TICKS = 24;
// Anticipation before a pressed attack actually lands. The aim is captured when
// the swing begins and the strike resolves this many ticks later.
export const PLAYER_ATTACK_WINDUP_TICKS = 12;
// Post-strike recovery: the player stays rooted this long after the hit lands.
export const ATTACK_ROOT_TICKS = 6;

export const ENEMY_MAX_HEALTH = 21;
export const ENEMY_ATTACK_DAMAGE = 15;
// The enemy slam is a forward cone (wedge), not a circle: it reaches this far
// from the enemy's own (planted) centre, within a wedge aimed where the player
// stood when the wind-up began. Side-stepping out of the arc dodges it.
export const ENEMY_ATTACK_RANGE = 120;
// Squared cosine of the cone half-angle. 0.5 == cos(45 deg)^2, a 90 deg wedge.
export const ENEMY_ATTACK_ARC_COS_SQ = 0.5;
// An enemy commits to a wind-up only once the player is within this distance of
// its centre; beyond it the enemy keeps closing instead of slamming empty air.
export const ENEMY_ATTACK_TRIGGER_RANGE = 96;
// Distance the enemy holds from the player while closing in.
export const ENEMY_STANDOFF = PLAYER_RADIUS + ENEMY_RADIUS + 8;
export const ENEMY_IDLE_TICKS = 66;
export const ENEMY_WINDUP_TICKS = 54;
export const ENEMY_RECOVERY_TICKS = 54;

export const PERFECT_WINDOW_TICKS = 4;
export const NORMAL_WINDOW_TICKS = 14;
export const DEFENSE_RECOVERY_TICKS = 12;

// Movement speed multiplier while the player is slowed by a mis-timed window
// (spec 021): playing non-synergising cards together drags you to a crawl.
export const PLAYER_SLOW_MULTIPLIER = 0.4;

// Burning condition (spec 022) ticks on this shared cadence, so damage-over-time
// stays deterministic integer chunks (dps * interval / TICK_RATE per pulse).
export const BURN_PULSE_INTERVAL_TICKS = 30;

// Adrenaline (spec 023): a basic attack that connects banks one point, capped
// here; spell cards spend it to be played.
export const MAX_ADRENALINE = 5;
// Each banked point speeds the player's walk by this much (spec 025): +4%/point,
// so a full bank of 5 is +20% movement.
export const ADRENALINE_SPEED_PER_POINT = 0.04;

export const PLAYER_MAX_MANA = 10;
export const MANA_REGEN_PER_TICK = PLAYER_MAX_MANA / (5 * TICK_RATE);

// --- Population + spawner ---
// Hard cap on live enemies; the spawner refills toward this but never past it.
export const MAX_ENEMIES = 5;
// Enemies present when combat starts.
export const INITIAL_ENEMIES = 2;
// Ticks between spawn attempts once below the cap (2s at 60Hz).
export const ENEMY_SPAWN_INTERVAL_TICKS = 120;
// A spawn is placed at least this far from the player so nothing appears on top of them.
export const SPAWN_MIN_PLAYER_DIST = 220;

// --- Waves (poker-combo prototype, spec 014) ---
// Wave N spawns WAVE_BASE_COUNT + N hunting enemies (N starts at 1).
export const WAVE_BASE_COUNT = 2;
// Per-wave scaling of enemy toughness, compounding by wave index (wave 1 = x1).
export const WAVE_HEALTH_GROWTH = 0.35;
export const WAVE_DAMAGE_GROWTH = 0.25;
// Per-wave scaling of enemy homing speed and attack cadence (wave 1 = x1).
// Kept smaller than health/damage growth: speed compounds difficulty quickly.
export const WAVE_SPEED_GROWTH = 0.12;
export const WAVE_ATTACK_SPEED_GROWTH = 0.15;
// A hard ceiling on live enemies even in wave mode, so the arena never gridlocks.
export const WAVE_MAX_ENEMIES = 40;
// Cap on stacked incoming-damage reduction (stance + guard), so nothing is fully immune.
export const MAX_DAMAGE_REDUCTION = 0.85;

// --- Grazing behaviour (passive enemies) ---
// Grazing amble speed, slower than a hunting enemy's homing speed.
export const GRAZE_MOVE_SPEED_PER_TICK = 0.45;
// A new graze target is chosen within this radius of the enemy's current spot.
export const GRAZE_WANDER_RADIUS = 160;
// The enemy stands and "eats" for a random pause in this range before wandering on.
export const GRAZE_PAUSE_MIN_TICKS = 60;
export const GRAZE_PAUSE_MAX_TICKS = 210;
// Reached-target epsilon (squared) for the graze walk.
export const GRAZE_ARRIVE_EPS_SQ = 4;
