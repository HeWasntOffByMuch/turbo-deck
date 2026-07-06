export const TICK_RATE = 60;

export const ARENA_MIN = 0;
export const ARENA_MAX = 200;
export const MOVE_SPEED_PER_TICK = 2;

export const PLAYER_MAX_HEALTH = 100;
export const ATTACK_RANGE = 20;
export const PLAYER_ATTACK_DAMAGE = 8;
export const PLAYER_ATTACK_COOLDOWN_TICKS = 18;

export const ENEMY_MAX_HEALTH = 150;
export const ENEMY_ATTACK_DAMAGE = 15;
export const ENEMY_IDLE_TICKS = 60;
export const ENEMY_WINDUP_TICKS = 24;
export const ENEMY_RECOVERY_TICKS = 36;

export const PERFECT_WINDOW_TICKS = 3;
export const NORMAL_WINDOW_TICKS = 10;
export const DEFENSE_RECOVERY_TICKS = 12;

export const PLAYER_MAX_MANA = 10;
export const MANA_REGEN_PER_TICK = PLAYER_MAX_MANA / (5 * TICK_RATE);
