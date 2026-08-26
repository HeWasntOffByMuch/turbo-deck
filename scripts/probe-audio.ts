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
import { existsSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const PORT = 4331;
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
const SLOTS = 'melee.heavy,ranged.ember,bolt.seek,self.mend';

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

const count = (readout: AudioReadout, id: string): number => readout.started[id] ?? 0;

/** How many voices started in total, across every event. */
const total = (readout: AudioReadout): number =>
  Object.values(readout.started).reduce((sum, value) => sum + value, 0);

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
    await page.goto(`http://localhost:${PORT}/?seed=20260806&slots=${SLOTS}`, { waitUntil: 'load' });
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
    await page.keyboard.down('KeyW');
    const walked = await settles(page, (readout) => count(readout, 'player.footstep') > count(standing, 'player.footstep'), 8000);
    await page.keyboard.up('KeyW');
    const steps = count(walked, 'player.footstep') - count(standing, 'player.footstep');
    console.log(`  walking:           ${String(steps)} footsteps`);
    if (steps === 0) problems.push('walking produced no footstep');

    // ...and the other half of the control: standing still produces none.
    // Without this, a driver that played a footstep every frame passes above.
    const rested = await readAudio(page);
    await page.waitForTimeout(2500);
    const stillRested = await readAudio(page);
    const drift = count(stillRested, 'player.footstep') - count(rested, 'player.footstep');
    console.log(`  standing still:    ${String(drift)} footsteps over 2.5s`);
    // Not zero: the body eases to a stop over a few frames after the key is
    // released, and one step banked on the way is honest. More than a couple is
    // a body making noise while it is not moving.
    if (drift > 2) problems.push(`standing still produced ${String(drift)} footsteps`);

    // --- a swing: the wind-up, not the contact -----------------------------
    const beforeSwing = await readAudio(page);
    await page.keyboard.press('Digit1');
    await page.mouse.click(700, 420);
    const swung = await settles(
      page,
      (readout) => count(readout, 'combat.swing.heavy') > count(beforeSwing, 'combat.swing.heavy'),
      8000,
    );
    const swings = count(swung, 'combat.swing.heavy') - count(beforeSwing, 'combat.swing.heavy');
    console.log(`  heavy swing:       ${String(swings)}`);
    if (swings === 0) problems.push('a heavy swing produced no swing sound');

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
  console.log('\naudio is wired: a context, decoded buffers, and a voice for each of four real events.');
}

void main();
