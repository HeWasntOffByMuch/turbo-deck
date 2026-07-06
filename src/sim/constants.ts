export const TICK_RATE = 60;

// Top-down rectangular arena, in world units.
export const ARENA_WIDTH = 480;
export const ARENA_HEIGHT = 360;

export const PLAYER_RADIUS = 14;
export const ENEMY_RADIUS = 18;

export const MOVE_SPEED_PER_TICK = 2.4;
export const ENEMY_MOVE_SPEED_PER_TICK = 1.3;
// Diagonal movement is scaled by 1/sqrt(2) so it isn't faster than cardinal.
export const DIAGONAL_SCALE = Math.SQRT1_2;

export const PLAYER_MAX_HEALTH = 100;
// Reach of the player's melee strike, measured from the player's centre to the
// enemy's centre it must be within (ENEMY_RADIUS is added at the call site).
export const PLAYER_ATTACK_RANGE = 46;
// Squared cosine of the aim cone half-angle. 0.5 == cos(45 deg)^2, a 90 deg cone.
export const ATTACK_ARC_COS_SQ = 0.5;
export const PLAYER_ATTACK_DAMAGE = 8;
export const PLAYER_ATTACK_COOLDOWN_TICKS = 18;

export const ENEMY_MAX_HEALTH = 150;
export const ENEMY_ATTACK_DAMAGE = 15;
// Radius of the telegraphed danger zone the enemy slams.
export const ENEMY_ATTACK_RADIUS = 44;
// Distance the enemy holds from the player while closing in.
export const ENEMY_STANDOFF = PLAYER_RADIUS + ENEMY_RADIUS + 6;
export const ENEMY_IDLE_TICKS = 60;
export const ENEMY_WINDUP_TICKS = 24;
export const ENEMY_RECOVERY_TICKS = 36;

export const PERFECT_WINDOW_TICKS = 3;
export const NORMAL_WINDOW_TICKS = 10;
export const DEFENSE_RECOVERY_TICKS = 12;

export const PLAYER_MAX_MANA = 10;
export const MANA_REGEN_PER_TICK = PLAYER_MAX_MANA / (5 * TICK_RATE);
