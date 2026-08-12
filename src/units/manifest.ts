/**
 * What the assets are, as one hash both ends can compare (spec 113).
 *
 * Everything else in this pipeline has a way of noticing when it is wrong. The
 * documents are validated, the clip lengths are measured, the import scale is
 * measured, the root bone is read off the rig. A client running against stale
 * assets has no such tell: it draws a unit that used to be right, at timings
 * that used to be right, and the fight on screen is not the fight the server is
 * running. Nothing goes wrong visibly until somebody notices a hit landing on a
 * frame it should not.
 *
 * So the bytes get a hash, the hash is exchanged at connect, and a difference
 * is a refused connection -- which is the loudest available version of the same
 * fact.
 *
 * Pure. Hashing is passed in rather than imported, because this module is part
 * of the deterministic core and `node:crypto` is not available in a browser
 * anyway. The one *rule* it owns is what goes into the hash and in what order.
 */

/** One file in the manifest. */
export interface UnitAssetEntry {
  /** Relative to `assets/units/`, with forward slashes on every platform. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface UnitManifestUnit {
  readonly id: string;
  /** The rig family, so a stale family is visible without reading every path. */
  readonly family: string;
  readonly entries: readonly UnitAssetEntry[];
}

export interface UnitManifest {
  readonly formatVersion: 1;
  /** The hash both ends compare. Derived; never edited by hand. */
  readonly hash: string;
  /**
   * Which bake stages actually ran.
   *
   * Empty is an honest answer and the current one. A stage that passed the
   * bytes through unchanged while claiming to have compressed them would be
   * worse than an absent stage, so what ran is recorded rather than assumed.
   */
  readonly builtStages: readonly string[];
  readonly units: readonly UnitManifestUnit[];
}

/** Hashes a string. Injected: `node:crypto` in the bake, nothing in the browser. */
export type HashText = (text: string) => string;

/**
 * The canonical text the manifest hash is taken over.
 *
 * Sorted, and made of the path and the digest and nothing else. Deliberately
 * excludes every fact that is true of *this build* rather than of the assets --
 * the time it ran, the absolute directory it ran in, the order the filesystem
 * happened to list things in. A hash that moved when none of the bytes did would
 * be a hash nobody could trust, and the first mismatch would teach everyone to
 * ignore the next one.
 *
 * The path is JSON-quoted rather than written raw, which is not fussiness: with
 * a bare `path:sha` joined by newlines, one file named with a colon and a
 * newline in it encodes identically to two ordinary files. Filenames come off a
 * filesystem and a newline is a legal character in one, so the separator has to
 * be one the path cannot contain -- and JSON escaping is the shortest way to
 * guarantee that.
 */
export function manifestBody(entries: readonly UnitAssetEntry[]): string {
  return [...entries]
    .map((entry) => `${JSON.stringify(entry.path)}:${entry.sha256}`)
    .sort()
    .join('\n');
}

/** The one number both ends compare. */
export function manifestHash(entries: readonly UnitAssetEntry[], hashText: HashText): string {
  return hashText(manifestBody(entries));
}

/** Every file in a manifest, across every unit. */
export function allEntries(manifest: UnitManifest): readonly UnitAssetEntry[] {
  return manifest.units.flatMap((unit) => unit.entries);
}

/**
 * Whether a manifest's recorded hash is the one its contents imply.
 *
 * Guards the case where somebody edits the file by hand -- a path corrected, a
 * unit removed -- and leaves the hash saying what it used to. The server would
 * then enforce agreement on a number that describes nothing.
 */
export function manifestIsSelfConsistent(manifest: UnitManifest, hashText: HashText): boolean {
  return manifest.hash === manifestHash(allEntries(manifest), hashText);
}

export type ManifestVerdict = 'match' | 'mismatch' | 'client-has-none' | 'server-has-none';

/**
 * Whether a connecting client may proceed.
 *
 * An **empty client hash is allowed**, and this is the interesting decision in
 * the file. Two reasons, and neither is laziness. The bot harness and the
 * in-tab single-player server share a process with the thing they are
 * connecting to, so they cannot be out of date with themselves and asking them
 * to prove it is ceremony. And a gate that fails closed on absence would have
 * to have been committed in the same instant as the first manifest, and every
 * asset change forever after would be a two-repository atomic commit.
 *
 * A hash that is *present and different* is the case the brief is about, and it
 * is refused.
 */
export function compareManifest(clientHash: string, serverHash: string): ManifestVerdict {
  if (clientHash === '') return 'client-has-none';
  if (serverHash === '') return 'server-has-none';
  return clientHash === serverHash ? 'match' : 'mismatch';
}

/** True when the verdict should close the connection. */
export function refusesConnection(verdict: ManifestVerdict): boolean {
  return verdict === 'mismatch';
}

/**
 * What to tell somebody whose assets do not match.
 *
 * Both hashes, because "your assets are stale" is only actionable if you can
 * tell which side moved -- and the remedy is different: a player rebuilds, an
 * operator redeploys.
 */
export function mismatchMessage(clientHash: string, serverHash: string): string {
  return (
    `asset manifest mismatch: this client was built against ${short(clientHash)} and the server is serving ` +
    `${short(serverHash)}. Rebuild the client (\`npm run bake:units && npm run build\`) or point it at a server on the same assets.`
  );
}

function short(hash: string): string {
  return hash === '' ? '(none)' : hash.slice(0, 12);
}
