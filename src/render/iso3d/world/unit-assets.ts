/**
 * Where an authored unit's bytes and documents actually come from (spec 111).
 *
 * The impure edge of the unit system, and the only file in it that knows a unit
 * is made of files. Everything else -- the catalogue, the driver, the LOD, the
 * machine -- takes documents and numbers.
 *
 * Bundled at build time through Vite's `?url` and JSON imports rather than
 * fetched from the authoring server, for the same reason the Studio preview
 * does it: the game has to work from a fresh clone with nothing generated and no
 * `npm run server` running. `?url` and not an inline import, so a skinned mesh
 * is a request made by the sessions that need it rather than weight in the main
 * bundle paid for by every session that does not.
 *
 * **Validated, not cast.** The documents go through `loadUnitBundle` -- the same
 * call the Studio tab makes -- so a unitdef that is broken is refused here with
 * the reasons, and the body falls back to the rig it would have had. A cast
 * would type-check, run, and make the game the one caller that never finds out.
 */

import meshUrl from '../../../../assets/units/dev/mannequin.glb?url';
import idleUrl from '../../../../assets/units/dev/clips/idle.glb?url';
import walkUrl from '../../../../assets/units/dev/clips/walk.glb?url';
import runUrl from '../../../../assets/units/dev/clips/run.glb?url';
import attackUrl from '../../../../assets/units/dev/clips/attack.glb?url';
import unitDoc from '../../../../assets/units/dev/mannequin.unitdef.json' with { type: 'json' };
import clipLibDoc from '../../../../assets/units/dev/biped-dev.core.cliplib.json' with { type: 'json' };
import skeletonDoc from '../../../../assets/units/dev/biped-dev.skeleton.json' with { type: 'json' };
import { bundleErrorText, loadUnitBundle } from '../../../units/bundle.js';
import { validateSkeleton } from '../../../units/validate.js';
import type { ClipLib, UnitDef } from '../../../units/types.js';
import type { UnitAssets } from '../unit-rig.js';
import type { AuthoredUnitId } from './unit-catalog.js';

export interface AuthoredUnit {
  readonly unit: UnitDef;
  readonly clipLib: ClipLib;
  readonly assets: UnitAssets;
}

/**
 * The rig's root bone, read off the skeleton document.
 *
 * Read rather than assumed. `mixamorig:Hips` is right for every rig this repo
 * has and would be wrong the first time it is not -- and a wrong root means the
 * root-motion check either misses translation that is there or strips a track
 * the rig needed. Null when the document does not validate, which turns the
 * check off rather than pointing it at a guess.
 */
function rootBoneOf(doc: unknown): string | undefined {
  const skeleton = validateSkeleton(doc).value;
  return skeleton?.bones.find((bone) => bone.parent === null)?.name;
}

const registry = new Map<AuthoredUnitId, AuthoredUnit>();
/** Why a unit is not in the registry, so a caller can say more than "missing". */
const refusals = new Map<AuthoredUnitId, string>();

function register(id: AuthoredUnitId, unitDocument: unknown, clipLibDocument: unknown, assets: UnitAssets): void {
  const bundle = loadUnitBundle(unitDocument, clipLibDocument);
  if (!bundle.value) {
    const why = bundleErrorText(bundle);
    refusals.set(id, why);
    console.error(`[units] "${id}" did not validate and will not be drawn: ${why}`);
    return;
  }
  registry.set(id, { unit: bundle.value.unit, clipLib: bundle.value.clipLib, assets });
}

const devRootBone = rootBoneOf(skeletonDoc);
register('mannequin', unitDoc, clipLibDoc, {
  meshUrl,
  clipUrls: { idle: idleUrl, walk: walkUrl, run: runUrl, attack: attackUrl },
  // The measured import scale off the authored rig's own height, not a number
  // somebody picked -- see `reference-unit.ts`.
  importScale: (unitDoc as { import: { scale: number } }).import.scale,
  // Spread rather than assigned: absent means "do not check", and under
  // `exactOptionalPropertyTypes` a present `undefined` is a different thing.
  ...(devRootBone === undefined ? {} : { rootBone: devRootBone }),
});

/** The unit, or null when it is not there or did not validate. */
export function authoredUnitAssets(id: AuthoredUnitId): AuthoredUnit | null {
  return registry.get(id) ?? null;
}

/** Why a unit was refused, or null. */
export function authoredUnitRefusal(id: AuthoredUnitId): string | null {
  return refusals.get(id) ?? null;
}
