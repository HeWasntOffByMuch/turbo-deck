/**
 * Every authored unit in the repo, discovered rather than listed (spec 113).
 *
 * The impure edge of the unit system, and the only file in it that knows a unit
 * is made of files. Everything else -- the catalogue, the driver, the LOD, the
 * machine -- takes documents and numbers.
 *
 * ## Why this is a glob and not a list
 *
 * It used to be five hardcoded `?url` imports naming the dev mannequin, which
 * meant the answer to "I exported a unit, now what" was "nothing, the game has
 * no way to name it". Adding a unit meant editing a union type, adding five
 * imports and a `register` call -- for an asset the Studio tab had just written
 * to disk. Export produced files nothing could load.
 *
 * So the roster is the *contents of `assets/units/`*, resolved by
 * `import.meta.glob` at build time and indexed by the manifest the bake writes.
 * Exporting a unit and re-baking is the whole of adding one; no code changes.
 *
 * Build time, not runtime: `import.meta.glob` is statically analysed, so the
 * bundler emits exactly the assets that exist and a mesh is still a request made
 * only by the sessions that need one, rather than weight in the main bundle.
 *
 * **Validated, not cast.** Every document goes through `loadUnitBundle` -- the
 * same call the Studio tab makes -- so a broken unit is refused here with the
 * reasons rather than drawn wrong.
 */

import manifestDoc from '../../../../assets/units/manifest.json' with { type: 'json' };
import { bundleErrorText, loadUnitBundle } from '../../../units/bundle.js';
import { validateSkeleton } from '../../../units/validate.js';
import type { UnitManifest } from '../../../units/manifest.js';
import type { ClipLib, UnitDef } from '../../../units/types.js';
import type { UnitAssets } from '../unit-rig.js';

/** Any unit id the manifest carries. Checked against the registry, not the type. */
export type AuthoredUnitId = string;

export interface AuthoredUnit {
  readonly unit: UnitDef;
  readonly clipLib: ClipLib;
  readonly assets: UnitAssets;
}

/**
 * Every asset under `assets/units/`, keyed by the path Vite resolved it from.
 *
 * Eager, because the alternative is a promise per file and a loader that cannot
 * answer "does this unit exist" without awaiting. What is eager is the *URL*,
 * not the bytes -- a `?url` import is a string, and the mesh is fetched when
 * something asks for it.
 */
const glbUrls = import.meta.glob('../../../../assets/units/**/*.glb', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const jsonDocs = import.meta.glob('../../../../assets/units/**/*.json', { eager: true }) as Record<
  string,
  { default: unknown }
>;

const MANIFEST = manifestDoc as unknown as UnitManifest;

/** The manifest hash this build was made against, for the connect-time check. */
export const ASSET_MANIFEST_HASH: string = MANIFEST.hash;

/**
 * Resolves a manifest path -- relative to `assets/units/` -- to a glob key.
 *
 * The two disagree about prefix and nothing else: the manifest says
 * `dev/mannequin.glb` because that is what it is relative to, and the glob keys
 * are relative to this file. Matched on the suffix rather than reconstructed, so
 * a change to either side's base cannot silently resolve to nothing.
 */
function lookup<T>(table: Record<string, T>, path: string): T | undefined {
  const suffix = `/assets/units/${normalize(path)}`;
  for (const [key, value] of Object.entries(table)) {
    if (key.endsWith(suffix)) return value;
  }
  return undefined;
}

/**
 * Flattens `.` and `..` out of a manifest-relative path.
 *
 * A reference is relative to the document that *made* it, and a unit that
 * borrows another's clip library reaches sideways to do it -- `../pig.skeleton.json`
 * from a unit folder, `clips/walk.glb` from a library one folder over. The glob
 * keys have no `..` in them, so a path carrying one matches nothing, and the two
 * callers below both treat "no match" as "leave it out" rather than as an error.
 * That is how the fox came to be drawn with an empty clip set: every lookup
 * missed, every clip was skipped, and the body stood in its bind pose with the
 * machine ticking happily above it.
 */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

const registry = new Map<AuthoredUnitId, AuthoredUnit>();
/** Why a unit is not in the registry, so a caller can say more than "missing". */
const refusals = new Map<AuthoredUnitId, string>();

/**
 * The rig's root bone, read off the skeleton document rather than assumed.
 *
 * Undefined turns the root-motion check off instead of pointing it at a guess.
 * A wrong root either misses translation that is there or condemns a track the
 * rig needed -- and three sanitises `:` out of bone names, so a name from a
 * document has to be checked against the loaded rig anyway.
 */
function rootBoneOf(doc: unknown): string | undefined {
  return validateSkeleton(doc).value?.bones.find((bone) => bone.parent === null)?.name;
}

for (const entry of MANIFEST.units) {
  const unitDocPath = entry.entries.find((file) => file.path.endsWith('.unitdef.json'))?.path;
  if (unitDocPath === undefined) {
    refusals.set(entry.id, 'the manifest lists no unitdef for it');
    continue;
  }

  const dir = unitDocPath.slice(0, unitDocPath.lastIndexOf('/') + 1);
  const unitDoc = lookup(jsonDocs, unitDocPath)?.default;
  const clipLibPath = entry.entries.find((file) => file.path.endsWith('.cliplib.json'))?.path;
  const clipLibDoc = clipLibPath === undefined ? undefined : lookup(jsonDocs, clipLibPath)?.default;

  const bundle = loadUnitBundle(unitDoc, clipLibDoc);
  if (!bundle.value) {
    const why = bundleErrorText(bundle) || 'its documents are not in the bundle';
    refusals.set(entry.id, why);
    console.error(`[units] "${entry.id}" did not validate and will not be drawn: ${why}`);
    continue;
  }
  const { unit, clipLib } = bundle.value;

  const meshUrl = lookup(glbUrls, `${dir}${unit.meshRef}`);
  if (meshUrl === undefined) {
    refusals.set(entry.id, `its mesh ${unit.meshRef} is not in the bundle`);
    continue;
  }

  // Clip ids are the keys the machine names; the paths come from the library --
  // and they are relative to the *library*, not to the unit. Those are the same
  // folder only while a unit owns its clips, which is the case this format
  // exists to stop being the only one: a rig family's library serves every unit
  // in it, and the second unit to join one is reaching into another folder.
  // Resolving against `dir` silently found nothing there and left the clip out.
  const clipDir = clipLibPath === undefined ? dir : clipLibPath.slice(0, clipLibPath.lastIndexOf('/') + 1);
  const clipUrls: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const clip of clipLib.clips) {
    const url = lookup(glbUrls, `${clipDir}${clip.source}`);
    if (url !== undefined) clipUrls[clip.id] = url;
    else unresolved.push(clip.source);
  }
  // Said out loud, because the failure it replaces was silent in the one way
  // that matters: a unit with no clips loads, draws, and poses nothing, which
  // looks exactly like a unit whose animation is merely bad.
  if (unresolved.length > 0) {
    console.error(
      `[units] "${entry.id}" could not resolve ${unresolved.length} clip(s) and will not animate them: ` +
        `${unresolved.join(', ')}`,
    );
  }

  const skeletonDoc = lookup(jsonDocs, `${dir}${unit.skeletonRef}`)?.default;
  const rootBone = skeletonDoc === undefined ? undefined : rootBoneOf(skeletonDoc);

  registry.set(unit.id, {
    unit,
    clipLib,
    assets: {
      meshUrl,
      clipUrls,
      // The measured import scale off the rig itself, never a number somebody
      // picked -- see `UnitRig.fitToHeight` and `reference-unit.ts`.
      importScale: unit.import.scale,
      // Spread rather than assigned: absent means "do not check", and under
      // `exactOptionalPropertyTypes` a present `undefined` is a different thing.
      ...(rootBone === undefined ? {} : { rootBone }),
    },
  });
}

/** The unit, or null when it is not there or did not validate. */
export function authoredUnitAssets(id: AuthoredUnitId): AuthoredUnit | null {
  return registry.get(id) ?? null;
}

/** Why a unit was refused, or null. */
export function authoredUnitRefusal(id: AuthoredUnitId): string | null {
  return refusals.get(id) ?? null;
}

/** Every unit this build can draw, for a panel or a `?units=` typo. */
export function authoredUnitIds(): readonly AuthoredUnitId[] {
  return [...registry.keys()].sort();
}
