/**
 * Every weapon in the repo, discovered rather than listed (spec 140).
 *
 * The same shape and the same reason as `world/unit-assets.ts`: the roster is
 * the *contents of `assets/items/`*, resolved by `import.meta.glob` at build
 * time, so adding a weapon is adding a folder and no code changes. A hardcoded
 * list is how a format ends up producing files nothing can load.
 *
 * Build time, not runtime: the glob is statically analysed, so the bundler emits
 * exactly the meshes that exist and a `.glb` is still a request made only by the
 * session that asks for one.
 *
 * **Validated, not cast.** Every document goes through `validateWeaponDef`, the
 * same call `npm run validate:items` makes, so a broken weapon is refused here
 * with its reasons rather than drawn in the wrong place.
 */

import { validateWeaponDef } from '../../items/validate.js';
import { formatIssue } from '../../units/issues.js';
import type { WeaponDef } from '../../items/types.js';

export interface WeaponEntry {
  readonly def: WeaponDef;
  readonly meshUrl: string;
}

const glbUrls = import.meta.glob('../../../assets/items/**/*.glb', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const documents = import.meta.glob('../../../assets/items/**/*.weapondef.json', { eager: true }) as Record<
  string,
  { default: unknown }
>;

/** Matched on the suffix, so a change to either side's base cannot resolve to nothing. */
function lookup<T>(table: Record<string, T>, suffix: string): T | undefined {
  for (const [key, value] of Object.entries(table)) {
    if (key.endsWith(suffix)) return value;
  }
  return undefined;
}

const registry = new Map<string, WeaponEntry>();

for (const [path, module] of Object.entries(documents)) {
  const result = validateWeaponDef(module.default);
  const def = result.value;
  if (!def) {
    // Said out loud rather than skipped silently: a weapon that fails to load is
    // a weapon somebody is about to go looking for in the picker.
    console.error(`[items] ${path} is not a valid weapon:\n${result.issues.map(formatIssue).join('\n')}`);
    continue;
  }
  const directory = path.slice(0, path.lastIndexOf('/'));
  const meshUrl = lookup(glbUrls, `${directory.slice(directory.lastIndexOf('/'))}/${def.meshRef}`);
  if (meshUrl === undefined) {
    console.error(`[items] ${def.id} names ${def.meshRef}, which is not beside it`);
    continue;
  }
  registry.set(def.id, { def, meshUrl });
}

/** Every weapon this build has, sorted so the picker is stable across builds. */
export function weaponIds(): readonly string[] {
  return [...registry.keys()].sort();
}

export function weaponAssets(id: string): WeaponEntry | null {
  return registry.get(id) ?? null;
}
