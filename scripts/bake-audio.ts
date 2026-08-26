/**
 * The offline audio build (spec 229): production sources in, game-ready `.ogg` out.
 *
 * The sources under `assets/audio/raw/` are what a sound library ships -- 96kHz
 * 24-bit stereo, one file per take, named for the session that recorded it. None
 * of that is wrong; it is just not what a browser should be asked to download.
 * Measured on the delivered set: 51.56 MB across 74 files, of which a single
 * footstep is 1.85 MB for **0.2 seconds of content followed by 2.3 seconds of
 * digital silence**, and the whole library is 130 seconds of audio.
 *
 * So this is the same shape as `bake:units`: a source tree nobody serves, an
 * offline pass, and a baked tree that is committed and shipped. The three things
 * it does, each with a reason a listener can hear:
 *
 * - **48kHz, Vorbis q4.** `decodeAudioData` resamples to the context rate
 *   whatever we hand it, and every browser opens a context at 44.1 or 48 -- so
 *   96kHz is two octaves of content above hearing, paid for on the wire and
 *   thrown away on decode.
 * - **Mono for anything spatial.** A `PannerNode` downmixes a stereo buffer to
 *   mono before it pans it, so a stereo source is half the bytes for *nothing*:
 *   the stereo image is discarded and replaced by the panner's. The interface
 *   and the ambient bed are the exceptions and stay stereo, because they are the
 *   ones that never reach a panner (`isStereoPath`).
 * - **The tail is trimmed.** Trailing digital silence is decoded into memory as
 *   zeroes and held there for as long as the buffer is cached. Leading silence
 *   is deliberately *not* trimmed -- trimming the head would move the transient,
 *   and a footstep that fires late is worse than a footstep that is large.
 *
 * What it does **not** do is normalise. How loud a sound is relative to the rest
 * of the game is a mix decision, and the mix lives in `assets/audio/sfx.json`
 * where the SFX tab can change it without re-encoding anything. Baking a level
 * in would be the same number written down twice.
 *
 * ## It discovers; it is not told
 *
 * Every audio file under `assets/audio/raw/` is baked, and where it lands is
 * `bakedNameFor` -- the source tree's own structure, slugged. There used to be a
 * hand-written table of 74 rows here, which made **adding a sound a code edit**:
 * exactly the friction the split between the vocabulary and the catalog exists
 * to remove. The table survives in `paths.ts` as `BAKED_NAMES`, a rename map for
 * the delivered library alone, because those 74 paths are referenced by
 * `sfx.json` and are not free to move.
 *
 * ## Incremental, and it does not delete
 *
 * A take whose `.ogg` is newer than its source is skipped, so a re-bake after
 * dropping in one file costs one ffmpeg call rather than 74. `--force` re-encodes
 * everything.
 *
 * Nothing is ever removed without `--prune`, and that is a deliberate reversal:
 * the sources are gitignored, so a fresh clone has *none* of them, and a bake
 * that deleted what it could not account for would delete the entire committed
 * library the first time somebody ran it before checking the raws out. Orphans
 * are reported instead. `--prune` is the "I renamed something" button.
 *
 * ## Running it
 *
 * ```sh
 * npm run bake:audio            # everything new or changed
 * npm run bake:audio -- --force # re-encode everything
 * npm run bake:audio -- --prune # and delete outputs with no source
 * ```
 *
 * The SFX tab has an Import button that writes a file here and calls this, so
 * the ordinary path never touches a terminal at all.
 *
 * `assets/audio/raw/` is gitignored for the reason `.studio/` is: it is the raw
 * intermediate, not the deliverable. What gets committed is what this writes
 * into `public/audio/`, which is `publicDir` -- so one tree is served in dev by
 * vite and copied verbatim into `dist/` by a build, and the URL is the same
 * `/audio/...` in both. The delivered takes live on the `raw-audio-files`
 * branch: `git checkout raw-audio-files -- assets/audio`, then move the four
 * folders under `assets/audio/raw/`.
 *
 * ffmpeg is the one external tool this repo asks for, and only here: it is an
 * offline authoring step, like the Tripo calls behind `src/server/studio/`, and
 * nothing at runtime or in CI needs it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bakedNameFor, isSourceName, isStereoPath, urlForBaked } from '../src/render/audio/paths.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(repoRoot, 'assets', 'audio', 'raw');
const OUT_DIR = join(repoRoot, 'public', 'audio');
const MANIFEST = join(OUT_DIR, 'manifest.json');

/**
 * Trim the tail, and only the tail.
 *
 * `silenceremove` trims from the *start* of a stream, so the tail is reached by
 * reversing, trimming the (now leading) silence, and reversing back. `-60dB`
 * rather than a hard zero because a 24-bit fade does not land on exactly zero,
 * and `stop_periods` is deliberately not used: it would also cut the silence
 * *inside* a take, which for a two-hit clash is the gap between the hits.
 */
const TRIM = 'areverse,silenceremove=start_periods=1:start_threshold=-60dB:start_duration=0,areverse';

export interface BakeOptions {
  readonly force?: boolean;
  readonly prune?: boolean;
  /** Where progress goes. The dev endpoint collects it; the CLI prints it. */
  readonly log?: (line: string) => void;
}

export interface BakeResult {
  readonly encoded: number;
  readonly skipped: number;
  readonly clips: number;
  readonly orphans: readonly string[];
  readonly pruned: readonly string[];
  readonly sourceBytes: number;
  readonly bakedBytes: number;
  readonly seconds: number;
  readonly lines: readonly string[];
}

/** Every file under `dir`, as paths relative to it, in a stable order. */
function walk(dir: string, prefix = ''): readonly string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(join(dir, entry.name), path));
    else found.push(path);
  }
  return found;
}

function probeSeconds(path: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
    { encoding: 'utf8' },
  );
  const seconds = Number.parseFloat(out.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

function encode(from: string, to: string, stereo: boolean): void {
  mkdirSync(dirname(to), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-i', from,
      '-af', TRIM,
      '-ac', stereo ? '2' : '1',
      '-ar', '48000',
      '-c:a', 'libvorbis',
      '-q:a', '4',
      to,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

interface ClipEntry {
  readonly url: string;
  readonly seconds: number;
  readonly bytes: number;
  readonly channels: 1 | 2;
}

/**
 * The index the SFX tab's file picker reads.
 *
 * Written by the bake rather than globbed by vite, because these files live in
 * `publicDir` -- copied verbatim, never in the module graph, and so invisible to
 * `import.meta.glob` (which is how `unit-assets.ts` finds the `.glb`s that *are*
 * in it). A directory listing is not something a static host offers either, so
 * without this the picker would be a text box you type a path into and find out
 * later whether you got it right.
 *
 * Built by scanning the output tree rather than from the takes just encoded, so
 * it describes what is actually *there* -- which after an incremental bake is
 * not the same list. Durations are reused from the previous manifest wherever
 * the byte count is unchanged, because `ffprobe` on 74 files is most of what an
 * incremental bake would otherwise cost.
 */
function writeManifest(): { clips: number; bytes: number; seconds: number } {
  const known = new Map<string, ClipEntry>();
  try {
    const raw = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { clips?: readonly ClipEntry[] };
    for (const clip of raw.clips ?? []) known.set(clip.url, clip);
  } catch {
    // No manifest yet, or an unreadable one. Everything is probed.
  }

  const clips: ClipEntry[] = [];
  for (const name of walk(OUT_DIR)) {
    if (!name.endsWith('.ogg')) continue;
    const baked = name.replace(/\.ogg$/, '');
    const url = urlForBaked(baked);
    const bytes = statSync(join(OUT_DIR, name)).size;
    const cached = known.get(url);
    clips.push({
      url,
      seconds: cached?.bytes === bytes ? cached.seconds : Number(probeSeconds(join(OUT_DIR, name)).toFixed(3)),
      bytes,
      channels: isStereoPath(baked) ? 2 : 1,
    });
  }
  clips.sort((a, b) => a.url.localeCompare(b.url));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify({ version: 1, clips }, null, 2)}\n`);
  return {
    clips: clips.length,
    bytes: clips.reduce((sum, clip) => sum + clip.bytes, 0),
    seconds: clips.reduce((sum, clip) => sum + clip.seconds, 0),
  };
}

export function bakeAudio(options: BakeOptions = {}): BakeResult {
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
    options.log?.(line);
  };

  const sources = walk(SOURCE_DIR).filter(isSourceName);
  const wanted = new Map<string, string>();
  for (const source of sources) {
    const baked = bakedNameFor(source);
    const clash = wanted.get(baked);
    if (clash !== undefined) {
      throw new Error(`two sources bake to ${baked}.ogg:\n  ${clash}\n  ${source}`);
    }
    wanted.set(baked, source);
  }

  let encoded = 0;
  let skipped = 0;
  let sourceBytes = 0;
  for (const [baked, source] of wanted) {
    const from = join(SOURCE_DIR, source);
    const to = join(OUT_DIR, `${baked}.ogg`);
    sourceBytes += statSync(from).size;
    // Newer than its source, so nothing about it has changed. `mtimeMs` rather
    // than a hash: this is a local build step over files a person just dropped
    // in, and hashing 51 MB to avoid re-encoding is the wrong side of the trade.
    if (!options.force && existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs) {
      skipped += 1;
      continue;
    }
    try {
      encode(from, to, isStereoPath(baked));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ffmpeg could not encode ${source}\n  ${detail.split('\n').slice(-3).join('\n  ')}\n` +
          '  (is ffmpeg installed and on PATH? it is the one external tool this repo needs)',
      );
    }
    encoded += 1;
    say(`  + ${baked}.ogg`);
  }

  // An output with no source: a take that was renamed, or removed, or one that
  // is simply not checked out. Never deleted unless asked -- the sources are
  // gitignored, so a fresh clone has none of them, and a bake that tidied up
  // after itself would delete the whole committed library on its first run.
  const orphans = walk(OUT_DIR)
    .filter((name) => name.endsWith('.ogg'))
    .map((name) => name.replace(/\.ogg$/, ''))
    .filter((baked) => !wanted.has(baked));
  const pruned: string[] = [];
  if (options.prune) {
    for (const baked of orphans) {
      rmSync(join(OUT_DIR, `${baked}.ogg`));
      pruned.push(baked);
      say(`  - ${baked}.ogg (pruned)`);
    }
  }

  const manifest = writeManifest();
  const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} MB`;
  say(
    `baked ${String(encoded)} take${encoded === 1 ? '' : 's'}, skipped ${String(skipped)} already current; ` +
      `${String(manifest.clips)} clips in ${relative(repoRoot, OUT_DIR)}/`,
  );
  if (sourceBytes > 0) {
    say(
      `  ${mb(sourceBytes)} of sources -> ${mb(manifest.bytes)} ` +
        `(${(100 - (manifest.bytes / sourceBytes) * 100).toFixed(1)}% smaller), ` +
        `${manifest.seconds.toFixed(1)}s of audio`,
    );
  }
  if (sources.length === 0) {
    say('  no sources under assets/audio/raw/ -- nothing was encoded, and nothing was removed');
  }
  for (const baked of orphans.filter((name) => !pruned.includes(name))) {
    say(`  ? ${baked}.ogg has no source (--prune to remove)`);
  }

  return {
    encoded,
    skipped,
    clips: manifest.clips,
    orphans,
    pruned,
    sourceBytes,
    bakedBytes: manifest.bytes,
    seconds: manifest.seconds,
    lines,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  bakeAudio({
    force: argv.includes('--force'),
    prune: argv.includes('--prune'),
    log: (line) => process.stdout.write(`${line}\n`),
  });
}

// Run only as a script, so the dev server can import `bakeAudio` without baking
// the moment the module is loaded.
if (process.argv[1] !== undefined && process.argv[1].endsWith('bake-audio.ts')) main();
