/**
 * The offline audio build (spec 229): production sources in, game-ready `.ogg` out.
 *
 * The sources under `assets/audio/` are what a sound library ships -- 96kHz
 * 24-bit stereo, one file per take, named for the session that recorded it. None
 * of that is wrong; it is just not what a browser should be asked to download.
 * Measured on the delivered set: 51.6 MB across 74 files, of which a single
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
 *   the stereo image is discarded and replaced by the panner's. UI sounds are
 *   the exception and stay stereo, because they are the ones that never reach a
 *   panner.
 * - **The tail is trimmed.** Trailing digital silence is decoded into memory as
 *   zeroes and held there for as long as the buffer is cached. Leading silence
 *   is deliberately *not* trimmed and is not present in this library anyway --
 *   trimming the head would move the transient, and a footstep that fires late
 *   is worse than a footstep that is large.
 *
 * What it does **not** do is normalise. How loud a sound is relative to the rest
 * of the game is a mix decision, and the mix lives in `assets/audio/sfx.json`
 * where the SFX tab can change it without re-encoding anything. Baking a level
 * in would be the same number written down twice.
 *
 * ## Running it
 *
 * ```sh
 * git checkout raw-audio-files -- assets/audio   # the sources, if you have not got them
 * # (they arrive as assets/audio/{UI,combat,events,steps}; move them under assets/audio/raw/)
 * npm run bake:audio
 * ```
 *
 * `assets/audio/raw/` is gitignored for the reason `.studio/` is: it is the
 * raw intermediate, not the deliverable. What gets committed is what this writes
 * into `public/audio/`, which is `publicDir` -- so one tree is served in dev by
 * vite and copied verbatim into `dist/` by a build, and the URL is the same
 * `/audio/...` in both.
 *
 * ffmpeg is the one external tool this repo asks for, and only here: it is an
 * offline authoring step, like the Tripo calls behind `src/server/studio/`, and
 * nothing at runtime or in CI needs it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(repoRoot, 'assets', 'audio', 'raw');
const OUT_DIR = join(repoRoot, 'public', 'audio');

/**
 * One source take and where it lands.
 *
 * A table rather than a rule that derives the name, because the sources are
 * named by five different libraries with five different conventions and any rule
 * that covered them would be longer than the table and would silently
 * mis-classify the next one. A missing source is an error rather than a skip:
 * a bake that quietly produced 60 files instead of 74 is a bake nobody notices.
 */
interface Take {
  /** Path under `assets/audio/`. */
  readonly from: string;
  /** Path under `public/audio/`, without the extension. */
  readonly to: string;
}

const STEPS = 'steps';
const SWORD = 'combat/Sword';
const ELEM = 'combat/elemental effects';

function numbered(fromDir: string, fromStem: string, toDir: string, toStem: string, count: number, pad = 3): readonly Take[] {
  return Array.from({ length: count }, (_unused, i) => {
    const n = String(i + 1).padStart(pad, '0');
    const out = String(i + 1).padStart(2, '0');
    return { from: `${fromDir}/${fromStem}${n}.wav`, to: `${toDir}/${toStem}_${out}` };
  });
}

const TAKES: readonly Take[] = [
  // --- player -------------------------------------------------------------
  // Two surfaces, kept apart rather than merged into one bag of twelve: which
  // set a body walks on is a thing the catalog chooses, and a boot and a sandal
  // in one variant list is a player whose shoes change every other step.
  ...numbered(`${STEPS}/generic`, 'FEETMisc_STEP-Boots on Generic Ground 1_HY_PC-', 'player/footsteps', 'boots', 6),
  ...numbered(`${STEPS}/other`, 'FEETMisc_STEP-Sandals on Ground_HY_PC-', 'player/footsteps', 'sandals', 6),

  // --- combat: swings -----------------------------------------------------
  ...numbered(`${SWORD}/2. Sword Slash`, 'Sword Slash ', 'combat/swings', 'sword_slash', 3, 2),
  ...numbered(`${SWORD}/3. Sword Swoosh`, 'Sword Swoosh Light ', 'combat/swings', 'sword_swoosh_light', 3, 2),
  ...numbered(`${SWORD}/3. Sword Swoosh`, 'Sword Swoosh Heavy ', 'combat/swings', 'sword_swoosh_heavy', 3, 2),
  ...numbered(`${SWORD}/1. Sword Stab`, 'Sword Stab Light ', 'combat/swings', 'sword_stab_light', 3, 2),
  ...numbered(`${SWORD}/1. Sword Stab`, 'Sword Stab Heavy ', 'combat/swings', 'sword_stab_heavy', 3, 2),
  ...numbered('combat/Generic Swoosh', 'Punch Swoosh ', 'combat/swings', 'punch', 3, 2),

  // --- combat: contact ----------------------------------------------------
  ...numbered('combat/Generic Hit', 'Hammer Hit ', 'combat/hits', 'blunt', 3, 2),
  ...numbered(`${SWORD}/4. Sword Clash`, 'Sword Clash ', 'combat/hits', 'sword_clash', 3, 2),
  {
    from: 'events/death/DSGNErie_NoiseBoxHit_36_InMotionAudio_SinisterTextures4.wav',
    to: 'combat/death/death_01',
  },

  // --- elemental: fire ----------------------------------------------------
  ...numbered('combat/magical attack', 'Fire_AttackF', 'elemental/fire', 'cast', 3, 1),
  ...numbered('combat/magical hit', 'Fire_ImpactF', 'elemental/fire', 'impact', 3, 1),
  { from: `${ELEM}/Mgc_Fire_Cast_01.wav`, to: 'elemental/fire/cast_long_01' },
  { from: `${ELEM}/Mgc_Fire_Hold_01.wav`, to: 'elemental/fire/hold_01' },
  { from: `${ELEM}/Mgc_Fire_Throw_01.wav`, to: 'elemental/fire/throw_01' },
  { from: `${ELEM}/Mgc_Fire_Impact_01.wav`, to: 'elemental/fire/impact_heavy_01' },
  { from: `${ELEM}/Mgc_Fading_Drops_Fire_01.wav`, to: 'elemental/fire/embers_01' },
  {
    from: 'combat/Skills/fire/FIREWhsh_Whoosh Fire Deep Growl Monster Saturated Crisp 03_ESM_EMWI.wav',
    to: 'elemental/fire/whoosh_01',
  },

  // --- elemental: ice -----------------------------------------------------
  { from: `${ELEM}/Mgc_Ice_Ball_Cast_01.wav`, to: 'elemental/ice/cast_01' },
  { from: `${ELEM}/Mgc_Ice_Arrow_Cast_01.wav`, to: 'elemental/ice/arrow_cast_01' },
  { from: `${ELEM}/Mgc_Ice_Arrow_Fly_01.wav`, to: 'elemental/ice/arrow_fly_01' },
  { from: `${ELEM}/Mgc_Ice_Arrow_Hit_01.wav`, to: 'elemental/ice/arrow_hit_01' },
  { from: `${ELEM}/Mgc_Glacier_Cast_01.wav`, to: 'elemental/ice/glacier_cast_01' },
  { from: `${ELEM}/Mgc_Glacier_Impact_01.wav`, to: 'elemental/ice/glacier_impact_01' },

  // --- elemental: lightning ------------------------------------------------
  { from: `${ELEM}/Mgc_Electric_Throw_01.wav`, to: 'elemental/lightning/throw_01' },
  { from: `${ELEM}/Mgc_Electric_Hit_01.wav`, to: 'elemental/lightning/hit_01' },
  { from: `${ELEM}/Mgc_Electric_Impact_01.wav`, to: 'elemental/lightning/impact_01' },

  // --- elemental: water ----------------------------------------------------
  { from: `${ELEM}/Mgc_Water_Cast_01.wav`, to: 'elemental/water/cast_01' },
  { from: `${ELEM}/Mgc_Water_Throw_01.wav`, to: 'elemental/water/throw_01' },
  { from: `${ELEM}/Mgc_Water_Throw_02.wav`, to: 'elemental/water/throw_02' },
  { from: `${ELEM}/Mgc_Water_Hit_01.wav`, to: 'elemental/water/hit_01' },
  { from: `${ELEM}/Mgc_Water_Hit_Short_01.wav`, to: 'elemental/water/hit_short_01' },
  { from: `${ELEM}/Mgc_Water_Impact_01.wav`, to: 'elemental/water/impact_01' },

  // --- ui -----------------------------------------------------------------
  ...(
    [
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
    ] as const
  ).map((name) => ({ from: `UI/${name}.wav`, to: `ui/${name}` })),
];

/**
 * Whether a baked file keeps two channels.
 *
 * Only the sounds that never reach a `PannerNode`. Everything else is downmixed
 * by the panner anyway, so shipping stereo would be twice the bytes for a stereo
 * image that is discarded on the way in.
 */
function isStereo(to: string): boolean {
  return to.startsWith('ui/');
}

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

interface Baked {
  readonly to: string;
  readonly sourceBytes: number;
  readonly bakedBytes: number;
  readonly seconds: number;
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
 * It carries the duration and the size because those are what a person choosing
 * between two takes wants to know, and both are free here and impossible in the
 * browser without fetching and decoding the file.
 */
interface ClipEntry {
  /** The URL, exactly as a catalog entry names it. */
  readonly url: string;
  readonly seconds: number;
  readonly bytes: number;
  readonly channels: 1 | 2;
}

function writeManifest(baked: readonly Baked[]): void {
  const clips: readonly ClipEntry[] = [...baked]
    .sort((a, b) => a.to.localeCompare(b.to))
    .map((b) => ({
      url: `/audio/${b.to}.ogg`,
      seconds: Number(b.seconds.toFixed(3)),
      bytes: b.bakedBytes,
      channels: isStereo(b.to) ? (2 as const) : (1 as const),
    }));
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify({ version: 1, clips }, null, 2)}\n`);
}

function probeSeconds(path: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
    { encoding: 'utf8' },
  );
  return Number.parseFloat(out.trim());
}

function bake(take: Take): Baked {
  const from = join(SOURCE_DIR, take.from);
  if (!existsSync(from)) {
    throw new Error(
      `missing source: assets/audio/${take.from}\n` +
        '  the raw takes live on the raw-audio-files branch:\n' +
        '  git checkout raw-audio-files -- assets/audio && mv assets/audio/{UI,combat,events,steps} assets/audio/raw/',
    );
  }
  const to = join(OUT_DIR, `${take.to}.ogg`);
  mkdirSync(dirname(to), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-i', from,
      '-af', TRIM,
      '-ac', isStereo(take.to) ? '2' : '1',
      '-ar', '48000',
      '-c:a', 'libvorbis',
      '-q:a', '4',
      to,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return {
    to: take.to,
    sourceBytes: statSync(from).size,
    bakedBytes: statSync(to).size,
    seconds: probeSeconds(to),
  };
}

/** Every `.ogg` already under `public/audio/`, as paths without the extension. */
function existingBaked(dir: string, prefix = ''): readonly string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...existingBaked(join(dir, entry.name), path));
    else if (entry.name.endsWith('.ogg')) found.push(path.replace(/\.ogg$/, ''));
  }
  return found;
}

function main(): void {
  const duplicates = TAKES.map((t) => t.to).filter((to, i, all) => all.indexOf(to) !== i);
  if (duplicates.length > 0) throw new Error(`two takes bake to the same name: ${duplicates.join(', ')}`);

  const before = new Set(existingBaked(OUT_DIR));
  const baked = TAKES.map(bake);

  // A take removed from the table leaves a file behind that nothing references
  // and the SFX tab still offers. Same rule the map's region writer follows: the
  // table is what makes a file reachable, so the table is what says it is not.
  const wanted = new Set(baked.map((b) => b.to));
  const stale = [...before].filter((name) => !wanted.has(name));
  for (const name of stale) rmSync(join(OUT_DIR, `${name}.ogg`));

  writeManifest(baked);

  const sourceBytes = baked.reduce((sum, b) => sum + b.sourceBytes, 0);
  const bakedBytes = baked.reduce((sum, b) => sum + b.bakedBytes, 0);
  const seconds = baked.reduce((sum, b) => sum + b.seconds, 0);

  const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(2)} MB`;
  process.stdout.write(`baked ${String(baked.length)} takes into ${relative(repoRoot, OUT_DIR)}/\n`);
  for (const name of stale) process.stdout.write(`  removed stale ${name}.ogg\n`);
  process.stdout.write(
    `  ${mb(sourceBytes)} of sources -> ${mb(bakedBytes)} ` +
      `(${(100 - (bakedBytes / sourceBytes) * 100).toFixed(1)}% smaller), ` +
      `${seconds.toFixed(1)}s of audio\n`,
  );

  // The five biggest, because the only thing that ever goes wrong here is one
  // file quietly being a tenth of the bake.
  const biggest = [...baked].sort((a, b) => b.bakedBytes - a.bakedBytes).slice(0, 5);
  for (const b of biggest) {
    process.stdout.write(`  ${b.to.padEnd(40)} ${mb(b.bakedBytes).padStart(9)}  ${b.seconds.toFixed(2)}s\n`);
  }
}

main();
