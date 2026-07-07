/**
 * The few enemy types that populate the arena. Only health, attack damage, and
 * homing speed vary by type; radius, telegraph size, and attack cadence stay
 * shared (see constants.ts) so collision and defense timing are uniform. The
 * `key` doubles as the sprite seed (spec 011), so each type looks distinct.
 */
export interface EnemyType {
  readonly key: string;
  readonly maxHealth: number;
  readonly attackDamage: number;
  /** Homing speed per tick while hunting the player. */
  readonly moveSpeed: number;
}

export const ENEMY_TYPES: readonly EnemyType[] = [
  { key: 'brawler', maxHealth: 150, attackDamage: 15, moveSpeed: 1.0 },
  { key: 'skitter', maxHealth: 80, attackDamage: 9, moveSpeed: 1.7 },
  { key: 'brute', maxHealth: 240, attackDamage: 24, moveSpeed: 0.65 },
];

const BY_KEY = new Map(ENEMY_TYPES.map((t) => [t.key, t]));

/** Look up a type by key, falling back to the first type for unknown keys. */
export function enemyTypeByKey(key: string): EnemyType {
  return BY_KEY.get(key) ?? (ENEMY_TYPES[0] as EnemyType);
}
