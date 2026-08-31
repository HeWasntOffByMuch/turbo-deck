/**
 * Whether any of the audio framework is wired to anything (spec 229).
 *
 * `npm run build && npx tsx scripts/probe-audio.ts`
 *
 * This is the half no headless test can see, and on this feature that is not a
 * formality. Every rule in `src/render/audio/` and every driver in
 * `world/audio-*.ts` is asserted in `npm test` against a recording fake -- and
 * all of it would be green beside a `view.ts` that calls none of it. That is
 * exactly the state spec 176 found map markers in: a complete set of passing
 * tests about saving a marker, beside a tab that never called any of them on the
 * map anybody plays. So this drives the shipped bundle, plays the game, and
 * reads what the *engine* says started.
 *
 * ## What it measures, and why that and not something else
 *
 * `data-audio-started` is published from the engine's own counter, incremented
 * on the line that calls `source.start()` -- not from what a call site asked
 * for. A readout of requests would report a working game for a view that
 * requests and an engine that refuses, which is the failure mode with the
 * highest prior here (no context, no buffer yet, past the cull, over the cap).
 *
 * It cannot hear anything, and does not pretend to. What it can establish is the
 * chain: a context that reached `running`, buffers that decoded, and a voice
 * that started for a specific event because of a specific thing the player did.
 * Whether the sword sounds *right* is what the SFX tab is for.
 *
 * ## The control
 *
 * Every check here is a *rise* against a reading taken a moment earlier, never
 * an absolute count. A probe whose "after" is right and whose "before" was never
 * checked cannot tell a working driver from one that plays everything
 * constantly -- `probe-aura.ts` says the same thing about its own control, and
 * on a footstep it is the difference between "walking makes a sound" and "the
 * game makes that sound all the time".
 *
 * ## Two things it has to do that are not obvious
 *
 * **The autoplay gate must be opened with a real gesture.** Chromium is launched
 * with `--autoplay-policy=no-user-gesture-required` anyway, because a headless
 * run has no user and the alternative is a probe that measures the policy rather
 * than the game -- but the click is made regardless, since that is the path a
 * player takes and the one `armAudio` is on.
 *
 * **Every wait is a poll.** This environment paints a real page at about five
 * frames a second under software GL, and the readout is published from the
 * frame -- so a fixed 200ms wait is less than one frame and reads the state
 * before the thing it is checking. The lesson `probe-drop.ts` records having
 * learned by reporting a working drop as a failure exactly once.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

import { TERRAIN_MATERIALS } from '../src/terrain/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4331;
/** The second half runs against a real `npm run dev`, on a port of its own. */
const DEV_PORT = 4332;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  // No user in a headless run. Without it the context stays `suspended` and this
  // probe measures Chromium's policy rather than the game.
  '--autoplay-policy=no-user-gesture-required',
];

/** The bar ships empty (spec 164), so a skill has to be put in it to press. */
// Slot 3 is the **bow**, put on the bar the way slot 2's ember already is.
// Both are `basicAttack` rather than `skill`, so `startCast`'s ownership check
// does not apply and neither needs the weapon equipped -- which is what makes
// the shot reachable at all here. The other route to an arrow is
// `skill.poisonDart`, and that one is `targeting: 'unit'`: it needs a body
// under the cursor, and a click on grass is refused in a way that reads
// exactly like three sounds that did not fire.
const SLOTS = 'melee.heavy,ranged.ember,ranged.shot,self.mend';

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

async function waitForTick(page: Page, ticks: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const text = (await page.textContent('body')) ?? '';
    last = Number(/tick (\d+)/.exec(text)?.[1] ?? -1);
    if (last >= ticks) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`sim never reached tick ${ticks} (last seen: ${last})`);
}

interface AudioReadout {
  readonly state: string;
  readonly voices: number;
  readonly held: number;
  readonly buffers: number;
  readonly missing: number;
  readonly started: Readonly<Record<string, number>>;
  /** What the local player is standing on, or '' where it has not resolved. */
  readonly surface: string;
}

/** What the engine says, off the root element the frame writes it to. */
async function readAudio(page: Page): Promise<AudioReadout> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-audio-state]');
    const started: Record<string, number> = {};
    for (const pair of (root?.dataset['audioStarted'] ?? '').split(',')) {
      if (pair === '') continue;
      const cut = pair.lastIndexOf('=');
      if (cut > 0) started[pair.slice(0, cut)] = Number(pair.slice(cut + 1));
    }
    return {
      state: root?.dataset['audioState'] ?? '(none)',
      voices: Number(root?.dataset['audioVoices'] ?? -1),
      held: Number(root?.dataset['audioHeld'] ?? -1),
      buffers: Number(root?.dataset['audioBuffers'] ?? -1),
      missing: Number(root?.dataset['audioMissing'] ?? -1),
      started,
      surface: root?.dataset['audioSurface'] ?? '',
    };
  });
}

/** A poll, not a wait. See the header. */
async function settles(
  page: Page,
  wanted: (readout: AudioReadout) => boolean,
  timeoutMs = 12_000,
): Promise<AudioReadout> {
  const deadline = Date.now() + timeoutMs;
  let seen = await readAudio(page);
  while (Date.now() < deadline) {
    if (wanted(seen)) return seen;
    await page.waitForTimeout(150);
    seen = await readAudio(page);
  }
  return seen;
}

/**
 * Poll until the body's own position has held still for two readings.
 *
 * `data-self-at` is rounded world units, published from the frame and only when
 * it changes -- so two equal readings a beat apart is the page saying the body
 * is not moving, rather than this script guessing how long a stop takes.
 */
async function stopped(page: Page, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let same = 0;
  while (Date.now() < deadline) {
    const at = await page.getAttribute('[data-self-at]', 'data-self-at');
    if (at !== null && at === last) {
      same += 1;
      if (same >= 2) return;
    } else {
      same = 0;
    }
    last = at ?? '';
    await page.waitForTimeout(250);
  }
}

const count = (readout: AudioReadout, id: string): number => readout.started[id] ?? 0;

/** How many voices started in total, across every event. */
const total = (readout: AudioReadout): number =>
  Object.values(readout.started).reduce((sum, value) => sum + value, 0);

/**
 * Record where every voice is placed, relative to the ears.
 *
 * The engine's own readout counts voices and cannot say *where* they went, and
 * where they went is the whole of one class of bug: a sound at the wrong
 * position is a sound that started, decoded and played, so every counter in the
 * game reads perfectly while the player hears their own footsteps in the wrong
 * speaker.
 *
 * Installed as an init script so it is in place before the page's first line
 * runs -- the context is built on the first input, and a patch applied after
 * that would miss it. It wraps `createPanner` and records the distance from the
 * listener at the moment each voice was placed, which is the one number that
 * answers the question without needing to know which body a sound came from.
 */
async function installPannerRecorder(page: Page): Promise<void> {
  // Source text rather than a function, and that is not a style choice: an init
  // script passed as a function is serialised from *transpiled* output, and this
  // file is run through tsx -- whose `keepNames` wraps every named function in a
  // `__name(...)` helper that exists only in the bundle it came from. The page
  // gets a script referencing an identifier nothing defines, and the whole
  // recorder throws on the first line with the game none the wiser.
  //
  // It records what the engine **commands** rather than what the parameter
  // currently reads, and that distinction is the whole reliability of this
  // check. `AudioParam.value` reflects the last value the *audio thread* has
  // applied, so a position written with `setValueAtTime` reads back as the
  // default 0 until that thread reaches the scheduled time -- which for a
  // `setTimeout(0)` read is a coin toss. Measured: the same walk reported
  // panners exactly on the listener in one run and at the origin in the next,
  // with the game byte-identical. Wrapping the setter has no clock in it at all.
  await page.addInitScript({
    content: `
      (() => {
        const distances = [];
        globalThis.__pannerDistances = distances;
        // The control. A voice at the ears and a voice nowhere are the same
        // reading -- 0.0 -- if neither position was ever written, so the
        // listener's own coordinate is recorded beside the offsets and checked
        // to be somewhere in a real world.
        globalThis.__listenerAt = null;

        let ears = null;
        const watch = (param, onSet) => {
          if (!param) return;
          const set = param.setValueAtTime.bind(param);
          param.setValueAtTime = (value, when) => { onSet(value); return set(value, when); };
        };

        const proto = AudioContext.prototype;
        const make = proto.createPanner;
        proto.createPanner = function () {
          const panner = make.call(this);
          const listener = this.listener;
          if (listener && listener.positionX && ears === null) {
            ears = { x: 0, z: 0 };
            watch(listener.positionX, (v) => { ears.x = v; });
            watch(listener.positionZ, (v) => { ears.z = v; });
          }
          const at = { x: null, z: null };
          const record = () => {
            if (at.x === null || at.z === null || ears === null) return;
            distances.push(Math.hypot(at.x - ears.x, at.z - ears.z));
            globalThis.__listenerAt = { x: ears.x, z: ears.z };
            at.x = null;
            at.z = null;
          };
          watch(panner.positionX, (v) => { at.x = v; record(); });
          watch(panner.positionZ, (v) => { at.z = v; record(); });
          return panner;
        };
      })();
    `,
  });
}

/** Start a fresh measurement window. See {@link nearestVoice}. */
async function clearVoices(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = (globalThis as unknown as { __pannerDistances?: number[] }).__pannerDistances;
    if (held) held.length = 0;
  });
}

/**
 * The closest any voice was placed to the ears, since the last reading, and
 * where the ears were when it was placed.
 *
 * Both, because 0.0 is the right answer *and* what a run where nothing was ever
 * positioned looks like. The listener coordinate is the control: the arena is
 * hundreds of units across and the spawn is nowhere near the origin, so ears at
 * (0, 0) mean the recorder measured two unset values against each other.
 */
async function nearestVoice(page: Page): Promise<{ nearest: number; ears: number }> {
  return page.evaluate(() => {
    const scope = globalThis as unknown as {
      __pannerDistances?: number[];
      __listenerAt?: { x: number; z: number } | null;
    };
    const held = scope.__pannerDistances ?? [];
    const nearest = held.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...held);
    held.length = 0;
    const at = scope.__listenerAt ?? null;
    return { nearest, ears: at === null ? 0 : Math.hypot(at.x, at.z) };
  });
}

/**
 * The half that closes the loop: a real `npx vite`, Import, Bake, Save.
 *
 * The built page above establishes that the framework is wired to the *game*.
 * This establishes the other thing spec 229 promises, which is that **adding a
 * sound is not a code edit**: a file chosen in the tab is written under
 * `assets/audio/raw/`, encoded by ffmpeg, offered by the picker and assigned to
 * an event, and Save puts that in the document the game boots from. Every rule
 * behind that is pure and asserted in `npm test` -- and all of it would be green
 * beside a tab whose button called none of it, which is the entire reason this
 * file exists. Two runs, the shape `probe-map-editor.ts` arrived at for the same
 * reason on the same kind of endpoint.
 *
 * **The take is `public/audio/ui/denied.ogg`**, which is committed, tiny, and a
 * format the bake reads. Importing one of the gitignored production `.wav`s
 * would make this probe unrunnable on a fresh clone -- which is the state CI and
 * anybody who has not checked out `raw-audio-files` is in.
 *
 * Everything it touches is put back in a `finally`, because there is no way to
 * check that a button writes the catalog without writing it.
 */
async function devHalf(browser: Browser, problems: string[]): Promise<void> {
  const CATALOG = join(root, 'assets', 'audio', 'sfx.json');
  const MANIFEST = join(root, 'public', 'audio', 'manifest.json');
  // A silent event, so "a variant appeared" is unambiguous rather than a count
  // that has to be differenced. Its import folder is derived from the id.
  const EVENT = 'combat.death';
  const SOURCE = join(root, 'public', 'audio', 'ui', 'denied.ogg');
  const TAKE = 'probe_take.ogg';
  const rawTake = join(root, 'assets', 'audio', 'raw', 'combat', 'death', TAKE);
  const bakedTake = join(root, 'public', 'audio', 'combat', 'death', TAKE);
  const bakedUrl = '/audio/combat/death/probe_take.ogg';

  const catalogBackup = `${CATALOG}.probe-backup`;
  const manifestBackup = `${MANIFEST}.probe-backup`;
  copyFileSync(CATALOG, catalogBackup);
  copyFileSync(MANIFEST, manifestBackup);

  // `node_modules/.bin/vite` in its own process group rather than `npx vite`:
  // `npx` is a wrapper, and a SIGTERM to it leaves the grandchild holding the
  // port -- the trap `probe-admin-console.ts` documents and `probe-map-editor.ts`
  // repeats.
  const dev = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(DEV_PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    detached: true,
  });
  try {
    await waitForServer(`http://localhost:${DEV_PORT}/`, 60_000);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => problems.push(String(error)));
    await page.goto(`http://localhost:${DEV_PORT}/`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'SFX', exact: true }).click();
    await page.waitForSelector('#sfx-tab [data-sfx-row]', { timeout: 60_000 });
    await page.click(`#sfx-tab [data-sfx-row="${EVENT}"]`);

    const wasSilent = /None\. This event is silent\./.test((await page.textContent('#sfx-tab')) ?? '');
    if (!wasSilent) {
      problems.push(`${EVENT} already has files -- pick another event for the import check`);
      await page.close();
      return;
    }

    // The gesture. `setInputFiles` on the tab's own hidden input is the same
    // path the Import button opens; the drop handler hands the same list to the
    // same function, so this covers both. Named so a leftover is obviously the
    // probe's rather than somebody's take.
    const chooser = await page.$('#sfx-tab input[type=file]');
    if (chooser === null) throw new Error('the SFX editor has no file input -- Import is not mounted');
    await chooser.setInputFiles([{ name: TAKE, mimeType: 'audio/ogg', buffer: readFileSync(SOURCE) }]);

    // A poll, not a wait: the import is an upload, an ffmpeg call and a re-read
    // of the manifest, and this page paints a few frames a second.
    await page.waitForFunction(
      (event) => new RegExp(`added \\d+ to ${event}|failed|refused|no dev server`).test(
        document.querySelector('#sfx-tab')?.textContent ?? '',
      ),
      EVENT,
      { timeout: 120_000 },
    );
    const said = (await page.textContent('#sfx-tab')) ?? '';
    const imported = new RegExp(`added \\d+ to ${EVENT}`).test(said);
    console.log(`  import:            ${imported ? 'added a take' : 'DID NOT'}`);
    if (!imported) {
      problems.push(`Import said something other than success: ${/(?:failed|refused|no dev server)[^\n]{0,80}/.exec(said)?.[0] ?? '(nothing)'}`);
    }

    // Three separate claims, because three separate things could have failed
    // silently: the upload, the bake, and the assignment. A tab that assigned a
    // URL the bake never produced is the failure mode `paths.ts` exists to
    // prevent, and it looks exactly like success from inside the browser.
    console.log(`  source written:    ${existsSync(rawTake) ? 'yes' : 'NO'}`);
    if (!existsSync(rawTake)) problems.push('the take never reached assets/audio/raw/');
    console.log(`  baked on disk:     ${existsSync(bakedTake) ? 'yes' : 'NO'}`);
    if (!existsSync(bakedTake)) problems.push('the take was uploaded but never encoded into public/audio/');
    const listed = (await page.textContent('#sfx-tab'))?.includes('probe_take') ?? false;
    console.log(`  shown as a variant:${listed ? ' yes' : ' NO'}`);
    if (!listed) problems.push('the baked take was not assigned as a variant of the event');

    // And Save writes it, against the endpoint the built page does not have --
    // the other half of the message the first run checked.
    await page.getByRole('button', { name: /^Save to assets\/?/ }).click();
    await page.waitForFunction(
      () => /wrote assets|no-endpoint|refused|unreachable/.test(document.querySelector('#sfx-tab')?.textContent ?? ''),
      undefined,
      { timeout: 30_000 },
    );
    const wrote = ((await page.textContent('#sfx-tab')) ?? '').includes('wrote assets');
    const onDisk = readFileSync(CATALOG, 'utf8').includes(bakedUrl);
    console.log(`  save on dev:       ${wrote ? 'wrote assets/audio/sfx.json' : 'said something else'}`);
    console.log(`  catalog on disk:   ${onDisk ? 'has the new variant' : 'DOES NOT'}`);
    if (!wrote) problems.push('Save against a real dev server did not report a write');
    if (!onDisk) problems.push('the catalog on disk does not name the imported take -- the write did not land');
    await page.close();
  } finally {
    copyFileSync(catalogBackup, CATALOG);
    copyFileSync(manifestBackup, MANIFEST);
    rmSync(catalogBackup, { force: true });
    rmSync(manifestBackup, { force: true });
    rmSync(rawTake, { force: true });
    rmSync(bakedTake, { force: true });
    if (dev.pid !== undefined) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        dev.kill('SIGTERM');
      }
    }
  }
}

async function main(): Promise<void> {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  const problems: string[] = [];
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => problems.push(String(error)));
    await installPannerRecorder(page);
    // The built page is the game client since spec 253 and builds no tab strip at
    // all; this harness drives the SFX tab (only on this dist pass -- `devHalf`
    // above runs against the dev server, which is the workbench already), so it
    // asks the workbench back.
    await page.goto(`http://localhost:${PORT}/?seed=20260806&slots=${SLOTS}&client=workbench`, { waitUntil: 'load' });
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await waitForTick(page, 120);

    // --- the control: silent before anything is pressed --------------------
    //
    // The context is not created until the first input, so this is a stronger
    // statement than "nothing has played": there is nothing that *could* have.
    const before = await readAudio(page);
    console.log(`  before any input:  state=${before.state} buffers=${String(before.buffers)} started=${String(total(before))}`);
    if (before.state !== 'idle') {
      problems.push(`the context existed before any input (state=${before.state}) -- the autoplay gate is open too early`);
    }

    // --- the gate ----------------------------------------------------------
    await page.mouse.click(640, 420);
    const armed = await settles(page, (readout) => readout.state === 'running' && readout.buffers > 0, 20_000);
    console.log(`  after one click:   state=${armed.state} buffers=${String(armed.buffers)} missing=${String(armed.missing)}`);
    if (armed.state !== 'running') problems.push(`the context never reached running (state=${armed.state})`);
    if (armed.buffers === 0) problems.push('no buffer ever decoded -- nothing was warmed or every fetch failed');
    if (armed.missing > 0) problems.push(`${String(armed.missing)} files could not be fetched or decoded`);

    // --- footsteps: a rise, against a body that was standing still ---------
    const standing = await readAudio(page);
    // Cleared here so the window below holds *this walk* and nothing else. It
    // used to be everything since page load, which made the spatial check a
    // lottery: `nearest` is a minimum, so one stray voice is harmless, but a
    // window that happens to contain only other bodies' voices reports a
    // working fix as broken. Seen exactly once, and not reproducible -- which
    // is the signature of a sampling window rather than a bug.
    await clearVoices(page);
    await page.keyboard.down('KeyW');
    // Several steps rather than the first one, for the same reason: the player's
    // own footsteps are what the spatial check is about, so the window has to be
    // guaranteed to contain some.
    const walked = await settles(
      page,
      (readout) => count(readout, 'player.footstep') >= count(standing, 'player.footstep') + 3,
      15_000,
    );
    await page.keyboard.up('KeyW');
    const steps = count(walked, 'player.footstep') - count(standing, 'player.footstep');
    console.log(`  walking:           ${String(steps)} footsteps`);
    if (steps === 0) problems.push('walking produced no footstep');

    // --- and where those footsteps were -----------------------------------
    //
    // Your own body is the one place a small position error is not small. The
    // listener sits on the *predicted* self and the replicated entities lag it,
    // and for a monster across the arena that lag is a rounding error on a long
    // vector. At zero distance there is nothing for it to be small against: the
    // offset IS the source position, so a panner given it pans your own
    // footsteps entirely by your own network lag -- and the lag points backwards
    // along the way you are going, so walking one way puts your feet in the
    // other speaker.
    //
    // Which is why this is measured rather than reasoned about: every counter in
    // the game reads perfectly for that bug. The nearest voice placed while
    // walking has to be your own feet, at your own ears.
    // --- and what it was standing on --------------------------------------
    //
    // The per-surface footstep rows all ship unassigned, so they fall back to
    // the plain one and the game sounds exactly as it did. Which means the whole
    // join can be dead -- `view.ts` handing the driver a null surface forever --
    // with every test in Node passing, because falling back is precisely what
    // they assert. Only a browser can say whether the ground is being read at
    // all, and the day somebody drops a take on `player.footstep.snow` is far
    // too late to find out it never was.
    const surface = walked.surface;
    console.log(`  standing on:       ${surface === '' ? 'NOTHING RESOLVED' : surface}`);
    if (!TERRAIN_MATERIALS.includes(surface as (typeof TERRAIN_MATERIALS)[number])) {
      problems.push(
        `the ground under the player read as "${surface}" -- the per-surface footstep has nothing to key on`,
      );
    }

    const { nearest, ears } = await nearestVoice(page);
    console.log(
      `  nearest voice:     ${nearest === Number.POSITIVE_INFINITY ? 'none placed' : `${nearest.toFixed(1)} units from the ears`}` +
        `, ears ${ears.toFixed(0)} from the origin`,
    );
    if (ears < 1) {
      problems.push('the listener was never positioned -- the offset above is two unset values, not a measurement');
    }
    // A body's radius is 10 and a footstep stride is 48, so anything past a few
    // units is a systematic offset rather than a rounding one. Not exactly zero:
    // the panner is placed at the body's sound height above the ground, and the
    // listener at ear height, and those are two different constants.
    if (nearest > 5) {
      problems.push(
        `the nearest voice while walking was ${nearest.toFixed(1)} units from the listener -- ` +
          'your own body is not being emitted at your own ears',
      );
    }

    // ...and the other half of the control: a body that is not walking does not
    // make walking noises. Without this, a driver that played a footstep every
    // frame passes everything above.
    //
    // The baseline is taken **after the player has actually stopped**, not at
    // the moment the key came up. A release is not an instant halt from the
    // page's side -- the keyup has to reach the client, the input has to reach
    // the server, and the readout is published from a frame this environment
    // draws about five times a second -- so a window that straddles the release
    // contains real ground covered at a run and banks two or three perfectly
    // honest footsteps. That is the probe measuring its own latency.
    await stopped(page);
    const rested = await readAudio(page);
    await page.waitForTimeout(2500);
    const stillRested = await readAudio(page);
    const drift = count(stillRested, 'player.footstep') - count(rested, 'player.footstep');
    console.log(`  standing still:    ${String(drift)} footsteps over 2.5s`);
    // And it is bounded rather than zero, because `player.footstep` is what
    // *any* walking body plays and the arena's monsters mill about when nobody
    // is fighting them (spec 213). A handful of steps from a grazer wandering
    // past the listener is the feature working. What this separates it from is
    // the bug: one per body per frame is a dozen frames times every walking
    // thing in range, which is an order of magnitude above anything a few idle
    // monsters can produce. Measured at 1-3 across runs.
    const IDLE_STEP_BUDGET = 6;
    if (drift > IDLE_STEP_BUDGET) {
      problems.push(
        `${String(drift)} footsteps over 2.5s with the player stationary -- more than wandering monsters explain`,
      );
    }

    // --- a swing: at the wind-up, and with the player's own weapon ---------
    //
    // Two claims in one press. It fires at the wind-up rather than the contact,
    // which is the tell this game is built on; and it is the sound of the
    // weapon in hand rather than a weight class. A maul and a sword used to
    // wind up identically, because the sound was chosen by the *ability's*
    // damage and nothing anywhere asked what was equipped.
    //
    // The character starts with the worn sword, so `melee.heavy` here has to be
    // a **sword** swing and must not be the light/heavy pair -- those two rows
    // are now the weapon-unknown case, which is every monster and every other
    // player, since equipment is replicated to its owner alone.
    //
    // Only the sword is reachable from a browser: the weapon switch offers the
    // starting kit and spec 218 narrowed it, so the maul and the staff have no
    // button and their rows are asserted in `audio-wire.test.ts` instead. What
    // this adds over those is the **join** -- whether `view.ts` hands the wire
    // the equipped weapon at all, which can be null forever with every unit
    // test green.
    const beforeSwing = await readAudio(page);
    await page.keyboard.press('Digit1');
    await page.mouse.click(700, 420);
    const swung = await settles(
      page,
      (readout) => count(readout, 'combat.swing.sword') > count(beforeSwing, 'combat.swing.sword'),
      12_000,
    );
    const swings = count(swung, 'combat.swing.sword') - count(beforeSwing, 'combat.swing.sword');
    const generic =
      count(swung, 'combat.swing.heavy') -
      count(beforeSwing, 'combat.swing.heavy') +
      (count(swung, 'combat.swing.light') - count(beforeSwing, 'combat.swing.light'));
    console.log(`  swing:             sword=${String(swings)} unknown-weapon=${String(generic)}`);
    if (swings === 0) problems.push('a heavy swing with a sword equipped produced no sword swing');
    if (generic > 0) {
      problems.push(`a swing with a known weapon played ${String(generic)} unknown-weapon swing(s)`);
    }

    // --- an elemental cast, and the loop it holds --------------------------
    //
    // `ranged.ember` is the one projectile whose look carries a held sound, so
    // this checks both halves of the driver at once: the one-shot at the wind-up
    // and the loop that is started when the shot appears and owed a stop when it
    // does not.
    const beforeCast = await readAudio(page);
    await page.keyboard.press('Digit2');
    await page.mouse.click(760, 380);
    const cast = await settles(
      page,
      (readout) => count(readout, 'elemental.fire.cast') > count(beforeCast, 'elemental.fire.cast'),
      9000,
    );
    const casts = count(cast, 'elemental.fire.cast') - count(beforeCast, 'elemental.fire.cast');
    console.log(`  fire cast:         ${String(casts)}`);
    if (casts === 0) problems.push('an ember shot produced no fire cast');

    // The held loop, and **both halves of it**. An ember is the one projectile
    // whose look carries a sound in flight, so a loop has to *rise* while it is
    // in the air and fall when it is not.
    //
    // Checking only the fall is the mistake this probe would otherwise make and
    // that `probe-aura.ts` names about its own control: `held === 0` after a
    // shot is also what a driver that never started one looks like, so the
    // check would pass for the bug it exists to catch. An ember lives about a
    // second and a half, and this page paints a few frames a second, so the
    // rise is polled hard and from immediately after the click.
    const inFlight = await settles(page, (readout) => readout.held > 0, 6000);
    console.log(`  ember in flight:   held=${String(inFlight.held)}`);
    if (inFlight.held === 0) {
      problems.push('an ember in flight held no looping sound -- the travel loop never started');
    }

    // And the owed stop. Nothing in the engine notices a body leaving, so a
    // driver that did not let go would be visible here as a count that only
    // ever climbs -- a leak running at the rate of the shooting.
    const settled = await settles(page, (readout) => readout.held === 0 && readout.voices === 0, 12_000);
    console.log(`  after the shot:    held=${String(settled.held)} voices=${String(settled.voices)}`);
    if (settled.held !== 0) problems.push(`${String(settled.held)} loops were still held after every shot had landed`);
    // And the count itself comes back to zero. A looping source has no natural
    // end, so its `onended` fires only when `stop` schedules one -- without that
    // the count climbs by one per shot for the life of the session until
    // `MAX_VOICES` refuses everything, which is silence that arrives after
    // twenty minutes of play and never in a test.
    if (settled.voices !== 0) {
      problems.push(`${String(settled.voices)} voices were still counted with nothing playing -- a voice leak`);
    }

    // --- a shot from end to end -------------------------------------------
    //
    // Three moments, and until spec 229's follow-up only the first was ever
    // heard: both projectile rows were in the vocabulary and fired by nothing,
    // so a bow had a draw and then silence. Checked because each fails silently
    // and differently -- the draw is a table lookup keyed on the look, the
    // loose is taken on a body's first frame, and the landing is owed from the
    // sweep that notices the body has gone.
    //
    // Last, because this fires an arrow that lives two seconds and the checks
    // above measure a held count coming back to zero.
    // Equipped, through the real weapon switch, because that is how a player
    // gets a bow and because the wind-up now reads the equipped weapon: with the
    // sword still in hand this would draw the bow and swing a sword.
    const bowButton = await page.$('[data-weapon="bow.hunting"]');
    if (bowButton === null) problems.push('the weapon switch has no bow');
    else await bowButton.click();
    const beforeShot = await readAudio(page);
    await page.keyboard.press('Digit3');
    await page.mouse.click(760, 300);
    const shot = await settles(
      page,
      (readout) =>
        count(readout, 'combat.projectile.impact') > count(beforeShot, 'combat.projectile.impact'),
      15_000,
    );
    const moments = (
      ['combat.bow.draw', 'combat.projectile.launch', 'combat.projectile.impact'] as const
    ).map((id) => [id, count(shot, id) - count(beforeShot, id)] as const);
    console.log(
      `  a shot:            ${moments.map(([id, n]) => `${id.split('.').pop() ?? id}=${String(n)}`).join(' ')}`,
    );
    for (const [id, n] of moments) {
      if (n === 0) problems.push(`an arrow produced no ${id}`);
    }
    // ...and it is a bow rather than the swing the physical branch falls
    // through to. The wind-up is the one of the three that had a *wrong* answer
    // available to it rather than no answer at all.
    const strayed = count(shot, 'combat.swing.light') - count(beforeShot, 'combat.swing.light');
    if (strayed > 0) problems.push(`shooting an arrow also played ${String(strayed)} sword swing(s)`);

    // --- the seventh tab ---------------------------------------------------
    //
    // Here rather than in a probe of its own for the reason it is checked at
    // all: one more entry in a tab array cannot fail a typecheck and cannot
    // fail a headless test, so every rule in `sfx/model.ts` can be green in
    // Node beside a shell that never mounts the thing. That is the state spec
    // 176 found map markers in.
    await page.getByRole('button', { name: 'SFX', exact: true }).click();
    await page.waitForSelector('#sfx-tab [data-sfx-row]', { timeout: 20_000 });
    const rows = await page.$$eval('#sfx-tab [data-sfx-row]', (nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset['sfxRow'] ?? ''),
    );
    console.log(`  SFX tab:           ${String(rows.length)} rows`);
    if (rows.length < 40) problems.push(`the SFX tree drew ${String(rows.length)} rows, not the whole vocabulary`);

    // A row with files behind it, opened: the editor has to show them. Picked
    // by id rather than by position, because the tree is filtered and ordered
    // by the vocabulary and a positional pick would silently follow it.
    await page.click('#sfx-tab [data-sfx-row="combat.hit.flesh"]');
    const editor = (await page.textContent('#sfx-tab')) ?? '';
    const variantsShown = /sword_clash_01/.test(editor);
    console.log(`  editor:            variants ${variantsShown ? 'shown' : 'MISSING'}`);
    if (!variantsShown) problems.push('opening an assigned event showed none of its files');

    // The built page has no `POST /api/sfx` -- the plugin is `apply: 'serve'`.
    // So Save must say *that*, and not "failed": "there is no dev server here",
    // "the server said no" and "nothing answered" have three different fixes.
    await page.getByRole('button', { name: /^Save to assets\/?/ }).click();
    const said = await page.waitForFunction(
      () => {
        const text = document.querySelector('#sfx-tab')?.textContent ?? '';
        return /no-endpoint|refused|unreachable|wrote/.test(text) ? text : null;
      },
      undefined,
      { timeout: 15_000 },
    );
    const message = String(await said.jsonValue());
    const toldTheTruth = message.includes('no-endpoint');
    console.log(`  save on a build:   ${toldTheTruth ? 'says there is no dev server' : 'said something else'}`);
    if (!toldTheTruth) problems.push('Save on a built page did not report a missing endpoint');

    const end = await readAudio(page);
    const heard = Object.entries(end.started)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${id}=${String(n)}`);
    console.log(`\n  heard: ${heard.join(' ')}`);
    await page.close();

    // --- the second run: a real dev server ---------------------------------
    //
    // The preview server is still up and does not matter; what follows needs
    // the `apply: 'serve'` endpoints, which only `npx vite` has.
    console.log('\nagainst a real dev server:');
    await devHalf(browser, problems);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  if (problems.length > 0) {
    console.error(`\n${String(problems.length)} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    '\naudio is wired: a context, decoded buffers, a voice for each of four real events,\n' +
      'and a take that went from a file chooser to the catalog without a terminal.',
  );
}

void main();
