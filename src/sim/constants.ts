import {
  PLAY_HEIGHT,
  PLAY_WIDTH,
  SEA_LEVEL,
  WORLD_MAX_X,
  WORLD_MAX_Y,
  WORLD_MIN_X,
  WORLD_MIN_Y,
} from '../shared/world.js';
import type { Rect } from './types.js';

export const TICK_RATE = 60;

// The play area, in world units: where the fight is staged, where enemies spawn
// and where the herd grazes. It is NOT a wall -- since spec 044 a unit may walk
// straight out of it and off across the rest of the world.
export const ARENA_WIDTH = PLAY_WIDTH;
export const ARENA_HEIGHT = PLAY_HEIGHT;

// The only bound left on movement (spec 044): the outer edge of the ground that
// exists. Past it there is nothing to stand on, which is the whole reason it is
// a bound -- the arena border it replaced was an invisible wall around a
// rectangle the world had long since grown past.
export const WORLD_BOUNDS: Rect = {
  x: WORLD_MIN_X,
  y: WORLD_MIN_Y,
  w: WORLD_MAX_X - WORLD_MIN_X,
  h: WORLD_MAX_Y - WORLD_MIN_Y,
};

export const PLAYER_RADIUS = 16;
export const ENEMY_RADIUS = 22;

export const ENEMY_MOVE_SPEED_PER_TICK = 1.0;

// --- MOBA-style player movement (spec 028) ---
// A unit's movement speed and turn rate come from its selected character (see
// characters.ts). Speed is hard-capped to [100, 550] u/s, mirroring HoN's caps.
export const MOVE_SPEED_HARD_MIN = 100;
export const MOVE_SPEED_HARD_MAX = 550;
// A unit must be facing within this many degrees of its intended move direction
// before it begins to translate; otherwise it rotates in place. So a full 180
// reversal only needs a 45-degree turn (135 from the opposite heading) to start
// moving, then it travels in a straight line (no arc).
export const MOVE_FACING_THRESHOLD_DEG = 135;
// A move order is considered fulfilled once the unit is within this distance of
// the destination, at which point the standing order is cleared.
export const MOVE_ARRIVE_EPS = 2;
// Most destinations a shift-click may stack behind the standing order (spec 040).
// Past the cap the extra click is dropped, so a mashed shift can't grow the plan
// without bound.
export const MOVE_QUEUE_MAX = 8;
// Attack animation (spec 028): once the unit has turned to face the attack aim,
// it winds up for this long before the attack actually fires. Moving during this
// window (or the turn before it) cancels the attack. ~0.2s at 60Hz.
export const ATTACK_ANIM_TICKS = 12;

// --- RPG progression (spec 029): three stats, gained by levelling ---
// Clearing a wave grants a level and this many stat points to spend.
export const STAT_POINTS_PER_LEVEL = 1;
// Strength: each point adds this much maximum health.
export const HP_PER_STRENGTH = 10;
// Agility: each point adds this much damage reduction (armor), this much turn
// rate (deg/s), and this fractional attack-speed bonus (shorter attack animation).
export const ARMOR_PER_AGILITY = 0.03;
export const TURN_RATE_PER_AGILITY = 30;
export const ATTACK_SPEED_PER_AGILITY = 0.05;
// Intelligence: each point adds this fraction to all spell damage.
export const SPELL_DAMAGE_PER_INTELLIGENCE = 0.06;

export const PLAYER_MAX_HEALTH = 25;
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

// --- Arena obstacles ---
// There are none, and that is the point (spec 221). Spec 037 compiled six
// hand-authored rects in here -- barricades around a spawn at the centre of a
// flat 1200x900 arena -- and they outlived both halves of their premise: spec
// 072 made the map document the world, and spec 165 grew it to 18,480x16,632,
// leaving that arena as 0.35% of one corner with a hillside running through it.
// A wall somebody wants comes from `maps/`, where every other collider in the
// game already comes from. `WorldColliders.rects` is still the facility for
// one; nothing hard-codes its contents.

// --- Collision resolution ---
// Pairwise separation passes run after every unit has moved. Separation is an
// iterative solver -- fixing one pair can nudge another back together -- and
// four passes keep a whole wave pressing on the player under a unit of residual
// overlap, which is invisible on a 44-unit body. Cost is trivial: the arena
// holds a few dozen units at most.
export const SEPARATION_ITERATIONS = 4;

// --- Walking on ground that has height (spec 056) ---
// The steepest single-tick climb a body may make. A move that would gain more
// height than this is a cliff, and refusing it is what stops a client walking up
// a wall -- the heightfield half of collision, next to the collider half in
// collision.ts.
//
// Here rather than in the server since spec 130, because the router has to
// refuse exactly the steps movement refuses. `src/server/world/terrain.ts`
// re-exports it, so the sim's own callers are unchanged.
export const MAX_STEP_HEIGHT = 24;
// Ground at or below this is deep water; nothing walks there, and nothing is
// routed through it.
export const WALKABLE_MIN_HEIGHT = SEA_LEVEL;

// --- Pathfinding (spec 037) ---
// Nav-grid cell size, and so the pitch at which the world is sampled. A cell is
// judged by its centre, so this is also the floor on how well a gap can be
// resolved: a corridor is only found when a cell centre lands in the band of
// standable positions across it, and that band is (gap width - 2 * radius)
// wide. At the 30 this used to be, the 32-to-40-unit gaps the scatter actually
// produces were found or missed on alignment alone (spec 067).
export const NAV_CELL_SIZE = 10;

/**
 * Cells per nav tile, per axis (spec 205).
 *
 * The lattice is cut into tiles so a nav grid is sized by where players are
 * rather than by how big the map is. The unit is the **interest chunk**:
 * `CHUNK_SIZE` is 400 and this is `400 / NAV_CELL_SIZE`, exactly.
 *
 * That exactness is the whole reason for the choice, and the reason the obvious
 * unit was refused: a *map* chunk is `cellSize 22 x chunkCells 28` = 616 units,
 * which is 61.6 cells, and tiles of 61.6 cells do not tile a lattice of whole
 * ones. The interest chunk divides, and is already what residency is counted in
 * -- `activeChunks` and `isSimulated` both read it.
 *
 * Written as a literal rather than derived, because `sim/` may not import
 * `server/config.ts`: the deterministic core does not depend on the server's
 * knobs. `nav-tiles.test.ts` asserts the two agree, so the divisibility is
 * checked rather than remembered.
 */
export const NAV_TILE_CELLS = 40;
// Elbow room a route prefers to keep beyond the body radius, so it does not hug
// a wall closely enough for separation to shove a unit into one.
//
// A preference, not a requirement (spec 067). Cells where the body fits but this
// margin does not are NAV_TIGHT: passable, at NAV_TIGHT_COST per step. Making it
// a requirement is what stopped the router from using gaps the world was
// deliberately scattered to leave open.
export const NAV_CLEARANCE = 4;
// What a step into a NAV_TIGHT cell costs, in ordinary steps. High enough that a
// comfortable detour wins over a squeeze whenever there is one, low enough that
// a long squeeze still beats a hopeless-looking way round.
export const NAV_TIGHT_COST = 3;
// How far from a blocked start or goal to look for a stand-in cell. In world
// units rather than cells, so shrinking NAV_CELL_SIZE does not quietly shorten
// the reach: a click into a grove needs to find the ground outside it.
export const NAV_RELOCATE_RADIUS = 160;
// A hunter whose line to the player is blocked re-runs the search this often.
export const PATH_REPLAN_TICKS = 20;
// How long a body waits before asking again after a search came back empty
// (spec 073). A failure is the expensive answer and the stable one -- it changes
// only when the world or the target's side of it does -- so it is asked once a
// second rather than sixty times. Short enough that an opened gate is noticed
// while the player is still standing in it.
export const PATH_RETRY_TICKS = 60;
// Distance at which a waypoint counts as reached and is consumed.
export const PATH_WAYPOINT_EPS = 14;
// Hard ceiling on cells expanded per search, so an unreachable goal is cheap.
// Sized for the whole world rather than the play area (spec 044), and raised
// with the cell size in spec 067 to keep the same reach in world units: a
// 2000-unit route over the real world expands ~6k cells at the 90th percentile,
// so this leaves room for the hard ones without letting a sealed box run away.
export const PATH_MAX_NODES = 40000;

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
