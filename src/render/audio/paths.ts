/**
 * How a source file becomes a URL the catalog can name (spec 229).
 *
 * Pure. No DOM, no fs, no Web Audio -- string arithmetic, which is what makes it
 * the one place this rule lives. Three things need it and they run in three
 * different places: `scripts/bake-audio.ts` writing the file, the dev server
 * deciding where an import may land, and the SFX tab predicting the URL a file
 * it just uploaded will have. Two implementations of "what is this file called
 * once it is baked" is an import that lands somewhere the tab then cannot find.
 *
 * ## Why the bake discovers rather than being told
 *
 * It used to be a hand-written table of 74 rows, on the argument that the
 * delivered sources are named by five libraries with five conventions and no
 * rule would cover them. That argument is still true and is now the *wrong
 * conclusion*: it made adding a sound a code edit, which is exactly what the
 * split between the vocabulary and the catalog exists to avoid. So the bake
 * walks the source tree and derives a name, and {@link BAKED_NAMES} survives as
 * a **rename map** for the delivered library alone -- the 74 paths `sfx.json`
 * already references, which must not move.
 */

/** What may be imported and baked. Anything ffmpeg reads that a person records into. */
export const SOURCE_EXTENSIONS: readonly string[] = ['.wav', '.flac', '.aif', '.aiff', '.ogg', '.mp3', '.m4a'];

/** What the bake writes. One format, so nothing downstream has to ask. */
export const BAKED_EXTENSION = '.ogg';

export function isSourceName(name: string): boolean {
  const lower = name.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * One path segment, made safe and predictable.
 *
 * Lowercase, and anything that is not a letter or a digit becomes an
 * underscore. Deliberately aggressive: these names end up in URLs, in a JSON
 * document a person reads, and in a `<select>` -- and the delivered library
 * alone contains spaces, full stops, hyphens and a `+`. A rule that tried to
 * preserve some of them would be a rule with an opinion about which, and the
 * first file that disagreed would produce a URL that needed escaping.
 *
 * An empty result becomes `sound`, because a file called `___.wav` is still a
 * file and a path segment of nothing is a path that means something else.
 */
export function slugSegment(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug === '' ? 'sound' : slug;
}

/**
 * Where a source lands, as a path under `public/audio/` without the extension.
 *
 * The folder structure is **mirrored, not invented**: a file at
 * `raw/combat/swings/Parry 01.wav` bakes to `combat/swings/parry_01.ogg`. That
 * is the whole reason the import endpoint chooses a folder rather than a flat
 * name -- where you put it is where it ends up, and there is nothing to look up.
 */
export function bakedPathFor(sourceRelative: string): string {
  const parts = sourceRelative.split('/').filter((part) => part !== '');
  const file = parts.pop() ?? '';
  const stem = file.replace(/\.[^.]+$/, '');
  return [...parts.map(slugSegment), slugSegment(stem)].join('/');
}

/**
 * The rename map for the delivered library.
 *
 * Every one of these 74 paths is referenced by `assets/audio/sfx.json`, so they
 * are not free to move: derivation would rename
 * `player/footsteps/boots_01.ogg` to
 * `steps/generic/feetmisc_step_boots_on_generic_ground_1_hy_pc_001.ogg` and
 * every variant in the catalog would point at nothing.
 *
 * Nothing new goes in here. A file dropped into the source tree today is named
 * by {@link bakedPathFor}, and if its derived name is ugly the fix is to move
 * the *file*, not to add a row.
 */
export const BAKED_NAMES: Readonly<Record<string, string>> = buildRenames();

function buildRenames(): Record<string, string> {
  const out: Record<string, string> = {};
  const numbered = (
    fromDir: string,
    fromStem: string,
    toDir: string,
    toStem: string,
    count: number,
    pad = 3,
  ): void => {
    for (let i = 1; i <= count; i++) {
      out[`${fromDir}/${fromStem}${String(i).padStart(pad, '0')}.wav`] =
        `${toDir}/${toStem}_${String(i).padStart(2, '0')}`;
    }
  };
  const SWORD = 'combat/Sword';
  const ELEM = 'combat/elemental effects';

  // Two surfaces, kept apart rather than merged into one bag of twelve: which
  // set a body walks on is a thing the catalog chooses, and a boot and a sandal
  // in one variant list is a player whose shoes change every other step.
  numbered('steps/generic', 'FEETMisc_STEP-Boots on Generic Ground 1_HY_PC-', 'player/footsteps', 'boots', 6);
  numbered('steps/other', 'FEETMisc_STEP-Sandals on Ground_HY_PC-', 'player/footsteps', 'sandals', 6);

  numbered(`${SWORD}/2. Sword Slash`, 'Sword Slash ', 'combat/swings', 'sword_slash', 3, 2);
  numbered(`${SWORD}/3. Sword Swoosh`, 'Sword Swoosh Light ', 'combat/swings', 'sword_swoosh_light', 3, 2);
  numbered(`${SWORD}/3. Sword Swoosh`, 'Sword Swoosh Heavy ', 'combat/swings', 'sword_swoosh_heavy', 3, 2);
  numbered(`${SWORD}/1. Sword Stab`, 'Sword Stab Light ', 'combat/swings', 'sword_stab_light', 3, 2);
  numbered(`${SWORD}/1. Sword Stab`, 'Sword Stab Heavy ', 'combat/swings', 'sword_stab_heavy', 3, 2);
  numbered('combat/Generic Swoosh', 'Punch Swoosh ', 'combat/swings', 'punch', 3, 2);
  numbered('combat/Generic Hit', 'Hammer Hit ', 'combat/hits', 'blunt', 3, 2);
  numbered(`${SWORD}/4. Sword Clash`, 'Sword Clash ', 'combat/hits', 'sword_clash', 3, 2);
  numbered('combat/magical attack', 'Fire_AttackF', 'elemental/fire', 'cast', 3, 1);
  numbered('combat/magical hit', 'Fire_ImpactF', 'elemental/fire', 'impact', 3, 1);

  const one: Readonly<Record<string, string>> = {
    'events/death/DSGNErie_NoiseBoxHit_36_InMotionAudio_SinisterTextures4.wav': 'combat/death/death_01',
    [`${ELEM}/Mgc_Fire_Cast_01.wav`]: 'elemental/fire/cast_long_01',
    [`${ELEM}/Mgc_Fire_Hold_01.wav`]: 'elemental/fire/hold_01',
    [`${ELEM}/Mgc_Fire_Throw_01.wav`]: 'elemental/fire/throw_01',
    [`${ELEM}/Mgc_Fire_Impact_01.wav`]: 'elemental/fire/impact_heavy_01',
    [`${ELEM}/Mgc_Fading_Drops_Fire_01.wav`]: 'elemental/fire/embers_01',
    'combat/Skills/fire/FIREWhsh_Whoosh Fire Deep Growl Monster Saturated Crisp 03_ESM_EMWI.wav':
      'elemental/fire/whoosh_01',
    [`${ELEM}/Mgc_Ice_Ball_Cast_01.wav`]: 'elemental/ice/cast_01',
    [`${ELEM}/Mgc_Ice_Arrow_Cast_01.wav`]: 'elemental/ice/arrow_cast_01',
    [`${ELEM}/Mgc_Ice_Arrow_Fly_01.wav`]: 'elemental/ice/arrow_fly_01',
    [`${ELEM}/Mgc_Ice_Arrow_Hit_01.wav`]: 'elemental/ice/arrow_hit_01',
    [`${ELEM}/Mgc_Glacier_Cast_01.wav`]: 'elemental/ice/glacier_cast_01',
    [`${ELEM}/Mgc_Glacier_Impact_01.wav`]: 'elemental/ice/glacier_impact_01',
    [`${ELEM}/Mgc_Electric_Throw_01.wav`]: 'elemental/lightning/throw_01',
    [`${ELEM}/Mgc_Electric_Hit_01.wav`]: 'elemental/lightning/hit_01',
    [`${ELEM}/Mgc_Electric_Impact_01.wav`]: 'elemental/lightning/impact_01',
    [`${ELEM}/Mgc_Water_Cast_01.wav`]: 'elemental/water/cast_01',
    [`${ELEM}/Mgc_Water_Throw_01.wav`]: 'elemental/water/throw_01',
    [`${ELEM}/Mgc_Water_Throw_02.wav`]: 'elemental/water/throw_02',
    [`${ELEM}/Mgc_Water_Hit_01.wav`]: 'elemental/water/hit_01',
    [`${ELEM}/Mgc_Water_Hit_Short_01.wav`]: 'elemental/water/hit_short_01',
    [`${ELEM}/Mgc_Water_Impact_01.wav`]: 'elemental/water/impact_01',
  };
  for (const [from, to] of Object.entries(one)) out[from] = to;
  for (const name of [
    'attribute_up',
    'denied',
    'drop_item',
    'equip_item_skill',
    'move_item',
    'pick_up_item',
    'skill_equip_cancelled',
    'skill_up',
    'trade_complete',
    'trade_request',
  ]) {
    out[`UI/${name}.wav`] = `ui/${name}`;
  }
  return out;
}

/** Where a source lands: its rename if it has one, its derived name otherwise. */
export function bakedNameFor(sourceRelative: string): string {
  return BAKED_NAMES[sourceRelative] ?? bakedPathFor(sourceRelative);
}

/**
 * Whether a baked file keeps two channels.
 *
 * Only the sounds that never reach a `PannerNode`, which downmixes stereo to
 * mono before it pans -- so anything spatial is twice the bytes for an image
 * that is discarded on the way in. Two places qualify: the interface, and the
 * ambient bed, which is `placement: 'flat'` precisely because it is everywhere
 * and panning it would be a lie.
 *
 * Keyed on the path rather than on the catalog, because a file is baked before
 * anything has assigned it to an event -- there is no catalog entry to ask yet.
 * The import endpoint puts a file under the folder its event's bus names, so the
 * two agree without either knowing about the other.
 */
export function isStereoPath(bakedName: string): boolean {
  return bakedName.startsWith('ui/') || bakedName.startsWith('ambience/world');
}

/** The URL a baked name is served at. `publicDir` is copied verbatim, so this is both. */
export function urlForBaked(bakedName: string): string {
  return `/audio/${bakedName}${BAKED_EXTENSION}`;
}

/**
 * Where an import for this event should land in the source tree.
 *
 * `combat.hit.flesh` becomes `combat/hit_flesh`, which bakes to
 * `/audio/combat/hit_flesh/<name>.ogg`. Derived from the id rather than chosen,
 * so a person importing three takes for one event does not have to invent a
 * folder and does not have to remember where they put the last one -- and so the
 * tab can predict the URL without waiting to be told.
 *
 * The delivered library's folders (`combat/swings`, `player/footsteps`) do not
 * follow this and are not meant to: they are one library's own grouping, several
 * events share each of them, and {@link BAKED_NAMES} pins them. This is the rule
 * for what arrives from now on.
 */
export function importFolderFor(eventId: string): string {
  const [bus, ...rest] = eventId.split('.');
  return `${slugSegment(bus ?? 'misc')}/${slugSegment(rest.join('_'))}`;
}

export type ImportTarget = { readonly path: string } | { readonly refusal: string };

/**
 * The source path an upload may be written to, or why it may not.
 *
 * A path *relative to the source root*, with the same shape of rules
 * `resolveMapWrite` applies and for the same reason: "write whatever path the
 * browser asked for" is how a dev server becomes a file-writing primitive for
 * any page the browser happens to have open. Segments are slugged rather than
 * merely checked, so there is nothing left to traverse with -- a `..` is not
 * refused, it is turned into `_` and stops being a path component at all.
 *
 * The extension is the one part carried through unslugged, and it must be one
 * this can bake.
 */
export function resolveImport(folder: string, fileName: string): ImportTarget {
  if (fileName === '' || fileName.includes('\0')) return { refusal: 'no file name' };
  if (!isSourceName(fileName)) {
    return { refusal: `"${fileName}" is not one of ${SOURCE_EXTENSIONS.join(', ')}` };
  }
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  const stem = slugSegment(fileName.slice(0, fileName.length - extension.length));
  const raw = folder.split('/').filter((part) => part !== '');
  if (raw.length === 0) return { refusal: 'no folder given' };
  // A segment with no letter or digit in it is not a folder somebody meant --
  // it is `..`, or `.`, or punctuation. Slugging it would answer `sound` and
  // quietly succeed, writing junk inside the sandbox rather than outside it.
  // Safe either way; refusing is the one that says so.
  const junk = raw.find((part) => !/[a-z0-9]/i.test(part));
  if (junk !== undefined) return { refusal: `"${junk}" is not a folder name` };
  const parts = raw.map(slugSegment);
  // A folder deep enough to be a mistake. The delivered library is three deep at
  // its worst; four is room to spare and still refuses a path built by a loop.
  if (parts.length > 4) return { refusal: 'folder is too deep' };
  return { path: `${parts.join('/')}/${stem}${extension}` };
}
