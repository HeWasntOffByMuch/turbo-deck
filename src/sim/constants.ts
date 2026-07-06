export const TICK_RATE = 60;

// Top-down rectangular arena, in world units.
export const ARENA_WIDTH = 480;
export const ARENA_HEIGHT = 360;

export const PLAYER_RADIUS = 16;
export const ENEMY_RADIUS = 22;

export const MOVE_SPEED_PER_TICK = 2.0;
export const ENEMY_MOVE_SPEED_PER_TICK = 1.0;
// Diagonal movement is scaled by 1/sqrt(2) so it isn't faster than cardinal.
export const DIAGONAL_SCALE = Math.SQRT1_2;

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

export const ENEMY_MAX_HEALTH = 150;
export const ENEMY_ATTACK_DAMAGE = 15;
// Radius of the telegraphed danger zone the enemy slams.
export const ENEMY_ATTACK_RADIUS = 52;
// Distance the enemy holds from the player while closing in.
export const ENEMY_STANDOFF = PLAYER_RADIUS + ENEMY_RADIUS + 8;
export const ENEMY_IDLE_TICKS = 66;
export const ENEMY_WINDUP_TICKS = 54;
export const ENEMY_RECOVERY_TICKS = 54;

export const PERFECT_WINDOW_TICKS = 4;
export const NORMAL_WINDOW_TICKS = 14;
export const DEFENSE_RECOVERY_TICKS = 12;

export const PLAYER_MAX_MANA = 10;
export const MANA_REGEN_PER_TICK = PLAYER_MAX_MANA / (5 * TICK_RATE);
