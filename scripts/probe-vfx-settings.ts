/**
 * Do the two effects settings do anything? (spec 182)
 *
 *   npm run build && npx tsx scripts/probe-vfx-settings.ts
 *
 * `system.test.ts` proves the intensity scale, `decals.test.ts` proves the gore
 * gate, and `vfx-wire.test.ts` proves which effect a blow asks for. All three
 * were green while the panel in the corner did almost nothing: `Blood: Off` left
 * every red brush mark exactly as it was, because gore reached the decal field
 * and the *spatter* is not a decal, and `Blood: Less` was byte-identical to
 * `Full`, because nothing anywhere read level 1.
 *
 * A test cannot catch that, because each half is individually correct. So this
 * drives the shipped page and reads the layer's own state back off `data-vfx-*`
 * -- published from the system and the field that act on the setting rather than
 * from the panel that asked, so a button that lit up and reached nothing reads
 * as unchanged.
 *
 * ## Two halves, and only one of them fails a run
 *
 * **Asserted**: pressing each of the seven buttons and reading the level back
 * off the layer. Deterministic, true whatever the world is doing, and precisely
 * the thing no test in the tree can say.
 *
 * **Reported**: everything that needs a fight. The arena has no body that both
 * bleeds and stands its ground -- six grazers, which are `skittish` and run from
 * a blow, and a stalker and a ravager, which have armour, and armour means
 * `blocked`, and `blocked` means no blood at any setting (see {@link BLEEDS}).
 * So a window can come back empty for reasons that have nothing to do with this
 * spec, and a probe that fails on a quiet afternoon is one people learn to
 * ignore. What is not allowed is a silent skip: every window says whether it
 * measured anything, and what these windows watch is asserted exactly in
 * `vfx-wire.test.ts` and `decals.test.ts`.
 *
 * What it reads per window is `data-vfx-started`: the effects that *began* in
 * the last three quarters of a second. Not what is live, which was the first cut
 * and is unanswerable -- a burst instance is retired on the tick it fires, so a
 * blood hit exists as an instance for one 60Hz tick while this environment
 * paints about five frames a second. That version reported "no blood effect was
 * ever played" for a window that had just laid twenty-one blood stains.
 *
 * Serves `dist/` rather than the dev server, for the reason `preview-world.ts`
 * gives: what is measured is what ships.
 *
 * Every wait in here is a *poll*, for the reason `probe-drop.ts` states: this
 * environment paints about five frames a second under software GL and the
 * readout is published from the frame, so a fixed wait shorter than one frame
 * reads the state from before the click it is checking.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4327;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'];

/**
 * How long one setting is watched for, in ms: at least the first, at most the
 * second.
 *
 * The numbers are peaks over the window rather than a single reading, because a
 * particle field empties between blows and one sample lands wherever it lands.
 *
 * A *range* rather than a duration because every check in this probe is an
 * absence -- no blood at Off, no pool at Less -- and a window in which nothing
 * was hit passes all of them perfectly. A fixed timer measured exactly that: the
 * first window killed what it was fighting, and the five after it watched an
 * empty field and reported green. So a window runs until it has seen a blow land
 * and then keeps going, and one that reaches the ceiling with nothing in it is a
 * failure rather than a pass.
 */
const WATCH_MIN_MS = 4_000;
const WATCH_MAX_MS = 25_000;

/**
 * How long a window swings at one body before looking for a better one.
 *
 * Generous, because a target has to be *walked to*: an impatient version
 * re-picked every five seconds, which restarted the approach every time and
 * landed no blow at all in a run that had managed one before.
 */
const RETARGET_MS = 14_000;

/**
 * Effect ids that mean an **open** blow landed on something that bleeds.
 *
 * The distinction is the whole evidence rule. `hit_block` is a blow that landed
 * and opened nothing, so it draws no blood at any setting and is worth nothing
 * as a control -- and it is what the arena serves up for minutes at a time once
 * the first thing has died. A window whose only impact was a block used to
 * report "Less drew no brush hit", which is a true sentence about a measurement
 * that never happened.
 *
 * So the evidence is either the blood vocabulary or the damage-type flash a
 * bleeding body falls back to at `Off` -- one of which is always what the
 * setting under test is *supposed* to produce, which is what makes each window
 * its own control.
 */
const OPEN_HIT = /^(blood_|death_blood|hit_(physical|fire|poison|ice|lightning|arcane)$)/;

/** Any impact at all, which is all the Effect detail rows need to have happened. */
const IMPACT = /^(hit_|blood_|death_blood|impact_)/;

/**
 * Monsters this probe is willing to measure blood on.
 *
 * `blocked` on the wire is `armor > 0 && damage < raw` (`server/sim/blow.ts`) --
 * "armour reduced this blow" rather than "the guard stopped it" -- and
 * `effectsForBlow` reads it as the second and draws `hit_block` with no blood.
 * So the stalker (armour 0.05) and the ravager (0.18) never bleed at any
 * setting, and a window spent on one measures nothing about this spec. That is
 * a real thing to fix and it is not this spec's; here it is a reason to fight
 * something else.
 */
const BLEEDS = /slinger|spider|dummy|grazer/i;

interface Counts {
  readonly intensity: number;
  readonly gore: number;
  /** The most particles alive in any one sampled frame. */
  readonly particles: number;
  /** The most stains held at once. */
  readonly decals: number;
  /** Every effect id seen starting over the window, unioned across samples. */
  readonly playing: ReadonlySet<string>;
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server never came up at ${url}`);
}

async function readCounts(page: Page): Promise<Counts> {
  const raw = await page.evaluate(() => {
    const element = document.querySelector('[data-world-ready]') as HTMLElement | null;
    return {
      intensity: Number(element?.dataset['vfxIntensity'] ?? -1),
      gore: Number(element?.dataset['vfxGore'] ?? -1),
      particles: Number(element?.dataset['vfxParticles'] ?? -1),
      decals: Number(element?.dataset['vfxDecals'] ?? -1),
      playing: element?.dataset['vfxStarted'] ?? '',
    };
  });
  return { ...raw, playing: new Set(raw.playing.split(',').filter((id) => id !== '')) };
}

/** Where every body with a bar is, and which one is us. */
async function bars(page: Page): Promise<{ x: number; y: number; self: boolean }[]> {
  return page.$$eval('[data-entity]', (nodes) =>
    nodes.map((node) => {
      const element = node as HTMLElement;
      return { x: element.offsetLeft, y: element.offsetTop, self: element.dataset['self'] !== undefined };
    }),
  );
}

/** Whether a fight is on right now, read off the developer readout's target line. */
async function hasTarget(page: Page): Promise<boolean> {
  return page.$$eval('div', (nodes) => nodes.some((node) => /^target .*$/m.test(node.textContent ?? '')));
}

/** The developer readout's target line, or '' when there is none. */
async function targetLine(page: Page): Promise<string> {
  // The status block is one element of several lines (`white-space:pre`), so the
  // target line is matched *inside* its text rather than at the start of it --
  // looking for a div whose text begins "target" finds nothing.
  return page.$$eval('div', (nodes) => {
    for (const node of nodes) {
      const line = /^target .*$/m.exec(node.textContent ?? '');
      if (line) return line[0];
    }
    return '';
  });
}

/**
 * Right-click bodies until something that bleeds is being attacked (spec 070).
 *
 * The loop is lifted from `probe-health-flash.ts`, which needed a fight for the
 * same reason. What is added is *which* fight: see {@link BLEEDS}.
 */
async function pickAFight(page: Page, mustBleed: boolean): Promise<boolean> {
  let fallback: { x: number; y: number } | null = null;
  for (const target of (await bars(page)).filter((bar) => !bar.self)) {
    await page.mouse.click(target.x, target.y + 40, { button: 'right' });
    await page.waitForTimeout(400);
    const readout = await targetLine(page);
    if (!readout || /no target/.test(readout)) continue;
    if (!mustBleed || BLEEDS.test(readout)) {
      console.log(`    fighting: ${readout.trim()}`);
      return true;
    }
    fallback ??= target;
  }
  // Nothing that bleeds is on screen. Take whatever there was rather than
  // leaving the *last* body clicked as the target, which is how a preference for
  // a grazer turned into "always fight whichever one happens to be last".
  if (fallback) {
    await page.mouse.click(fallback.x, fallback.y + 40, { button: 'right' });
    await page.waitForTimeout(400);
    console.log(`    fighting (nothing unarmoured on screen): ${(await targetLine(page)).trim()}`);
    return true;
  }
  return false;
}

/** Press one of the panel's radio buttons by the row it is in and its face. */
async function press(page: Page, caption: string, text: string): Promise<boolean> {
  return page.evaluate(
    ([wantCaption, wantText]) => {
      for (const row of Array.from(document.querySelectorAll('div'))) {
        if (row.firstElementChild?.textContent !== wantCaption) continue;
        for (const button of Array.from(row.querySelectorAll('button'))) {
          if (button.textContent === wantText) {
            button.click();
            return true;
          }
        }
      }
      return false;
    },
    [caption, text] as const,
  );
}

/** Whether a window has seen an open blow land on something that bleeds. */
function sawABlow(counts: Counts): boolean {
  return [...counts.playing].some((id) => OPEN_HIT.test(id));
}

/** Whether a window has seen any impact at all, blocked ones included. */
function sawAnImpact(counts: Counts): boolean {
  return [...counts.playing].some((id) => IMPACT.test(id));
}

/**
 * Fight until the window has what it needs, then report the loudest frame of it.
 *
 * `enough` is the window's own evidence rule, and the two rows need different
 * ones: a Blood window learns nothing from a blow that armour reduced, and an
 * Effect detail window learns everything it needs from one.
 */
async function watch(page: Page, enough: (counts: Counts) => boolean, mustBleed: boolean): Promise<Counts> {
  const started = Date.now();
  const base = await readCounts(page);
  let peak: Counts = { ...base, particles: 0, decals: 0, playing: new Set<string>() };
  let lastPick = Date.now();
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed >= WATCH_MAX_MS) break;
    if (elapsed >= WATCH_MIN_MS && enough(peak)) break;

    const now = await readCounts(page);
    peak = {
      intensity: now.intensity,
      gore: now.gore,
      particles: Math.max(peak.particles, now.particles),
      decals: Math.max(peak.decals, now.decals),
      // Unioned rather than sampled: the readout reports three quarters of a
      // second of starts and this environment paints about five frames a second,
      // so one reading covers one frame's worth of a fight and no more.
      playing: new Set([...peak.playing, ...now.playing]),
    };
    // Keep the fight going: a Grazer does not survive the whole run, and a dead
    // target is a window with nothing in it. And re-pick on a *stalemate* too --
    // a window that has been swinging at an armoured body for five seconds has
    // learned everything that body can teach it.
    const stalled = Date.now() - lastPick > RETARGET_MS && !enough(peak);
    if (stalled || !(await hasTarget(page))) {
      await pickAFight(page, mustBleed);
      lastPick = Date.now();
    }
    await page.waitForTimeout(120);
  }
  return peak;
}

async function main(): Promise<void> {
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    console.error('  no dist/ -- run `npm run build` first');
    process.exitCode = 1;
    return;
  }

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const problems: string[] = [];

  try {
    const browser = await chromium.launch({
      args: CHROMIUM_ARGS,
      ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
    });
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://localhost:${PORT}/?seed=7`);
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });

    const effects = await page.$('button[aria-label="Effects"]');
    if (!effects) {
      console.error('  FAIL there is no Effects button in the corner');
      process.exitCode = 1;
      await browser.close();
      return;
    }
    await effects.click();

    // --- what is asserted -------------------------------------------------
    //
    // Pressing a button and reading the level back off the layer. This is the
    // one thing no test in the tree can do and the one thing that is true
    // whatever the arena is doing, so it is the part that fails a run.
    for (const [caption, choice, field, want] of [
      ['Effect detail', 'Off', 'intensity', 0],
      ['Effect detail', 'Low', 'intensity', 1],
      ['Effect detail', 'Med', 'intensity', 2],
      ['Effect detail', 'Full', 'intensity', 3],
      ['Blood', 'Off', 'gore', 0],
      ['Blood', 'Less', 'gore', 1],
      ['Blood', 'Full', 'gore', 2],
    ] as const) {
      if (!(await press(page, caption, choice))) {
        problems.push(`the panel has no "${choice}" under "${caption}"`);
        continue;
      }
      // Polled: the readout is published from the frame, and this environment
      // paints about five of those a second.
      let got = -1;
      for (let attempt = 0; attempt < 20 && got !== want; attempt++) {
        got = (await readCounts(page))[field];
        if (got !== want) await page.waitForTimeout(150);
      }
      console.log(`  ${caption} = ${choice.padEnd(5)} -> ${field} ${got}`);
      if (got !== want) problems.push(`${caption} "${choice}" left ${field} at ${got}, not ${want}`);
    }

    // --- what is reported -------------------------------------------------
    //
    // Everything below needs the arena to hand this run an open blow on
    // something that bleeds, and the arena often will not. Grazers -- the only
    // unarmoured thing there are six of -- are `skittish` and run from a blow;
    // the stalker and the ravager have armour, and armour means `blocked`, and
    // `blocked` means no blood at any setting (see the note on BLEEDS). So a
    // window here can come back empty for reasons that have nothing to do with
    // this spec, and a probe that fails on a quiet afternoon is a probe people
    // learn to ignore. What is *not* allowed is a silent skip: every window says
    // whether it measured anything, and the arithmetic these windows watch is
    // asserted exactly in `vfx-wire.test.ts` and `decals.test.ts`.
    console.log('\n  and now the part that needs a fight:');
    if (!(await pickAFight(page, true))) console.log('    nothing to attack at all');

    const measured = new Map<string, Counts>();
    const report = (caption: string, choice: string, counts: Counts): void => {
      const seen = [...counts.playing].sort();
      console.log(
        `  ${caption} = ${choice.padEnd(5)} -> ${String(counts.particles).padStart(4)} particles, ` +
          `${String(counts.decals).padStart(4)} stains` +
          `\n${' '.repeat(24)}started: ${seen.length > 0 ? seen.join(' ') : 'nothing'}`,
      );
    };

    // `Off` first, then `Less`, then `Full`. Each window carries its own control
    // -- what the level is *supposed* to draw is also the evidence that a blow
    // landed in it -- so they can be ordered by what matters rather than by the
    // panel's own order, and what matters is the level this spec exists for. The
    // arena is at its most generous at the start of a run.
    for (const choice of ['Off', 'Less', 'Full'] as const) {
      // Cleared between measurements the only way a player can -- off and back
      // again -- or a stale field is credited to the setting that replaced it.
      await press(page, 'Blood', 'Off');
      await press(page, 'Blood', choice);
      const counts = await watch(page, sawABlow, true);
      measured.set(`Blood/${choice}`, counts);
      report('Blood', choice, counts);
    }
    for (const choice of ['Off', 'Low', 'Full'] as const) {
      // Blood back on, or the loudest effects in the game are missing from
      // exactly the measurement that counts particles.
      await press(page, 'Blood', 'Full');
      await press(page, 'Effect detail', choice);
      const counts = await watch(page, choice === 'Off' ? () => true : sawAnImpact, false);
      measured.set(`Effect detail/${choice}`, counts);
      report('Effect detail', choice, counts);
    }

    const detailFull = measured.get('Effect detail/Full');
    const detailLow = measured.get('Effect detail/Low');
    const detailOff = measured.get('Effect detail/Off');
    const bloodFull = measured.get('Blood/Full');
    const bloodLess = measured.get('Blood/Less');
    const bloodOff = measured.get('Blood/Off');

    const bloodIds = (counts: Counts | undefined): string[] =>
      [...(counts?.playing ?? [])].filter((id) => /blood/.test(id));

    console.log('');
    // At intensity 0 nothing can start, whatever the arena is doing, so this one
    // is a finding rather than an observation.
    if (detailOff && (detailOff.particles > 0 || detailOff.playing.size > 0)) {
      problems.push(
        `Effect detail Off still drew ${detailOff.particles} particles and started ` +
          `${[...detailOff.playing].join(', ') || 'nothing'}`,
      );
    }

    // Each of the three below is an absence, and each is only worth reading once
    // its own window is known to have held an open blow.
    if (!bloodFull || !sawABlow(bloodFull)) {
      console.log('  ~ Blood Full never landed an open blow, so the blood checks measured nothing');
    } else {
      if (!bloodIds(bloodFull).some((id) => id.startsWith('blood_hit_brush'))) {
        problems.push('Blood Full landed an open blow and drew no brush hit');
      }
      if (bloodFull.decals === 0) problems.push('Blood Full landed an open blow and left no stain');
    }

    if (!bloodOff || !sawABlow(bloodOff)) {
      console.log('  ~ Blood Off never landed an open blow, so what it draws was not measured');
    } else {
      if (bloodIds(bloodOff).length > 0) problems.push(`Blood Off still played ${bloodIds(bloodOff).join(', ')}`);
      if (bloodOff.decals > 0) problems.push(`Blood Off still laid ${bloodOff.decals} stains`);
      // The other half of the same claim: what it draws *instead*. Without this
      // the check above passes for a body that drew nothing at all, which would
      // be the setting overshooting into "a hit you cannot see".
      if (!bloodOff.playing.has('hit_physical')) {
        problems.push('Blood Off drew no impact flash -- a hit on flesh has to still read as a hit');
      }
    }

    if (!bloodLess || !sawABlow(bloodLess)) {
      console.log('  ~ Blood Less never landed an open blow, so what it draws was not measured');
    } else {
      if (!bloodIds(bloodLess).includes('blood_hit_brush')) {
        problems.push('Blood Less landed an open blow and drew no brush hit');
      }
      for (const id of ['death_blood', 'blood_hit_brush_heavy']) {
        if (bloodIds(bloodLess).includes(id)) problems.push(`Blood Less still played ${id}`);
      }
    }

    if (!detailFull || detailFull.particles === 0) {
      console.log('  ~ nothing was drawn at Effect detail Full, so Low was not compared against it');
    } else if (detailLow && detailLow.particles >= detailFull.particles) {
      problems.push(`Effect detail Low drew ${detailLow.particles} particles against Full's ${detailFull.particles}`);
    }

    await browser.close();
  } finally {
    server.kill();
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n  both rows change what the layer actually holds');
}

void main();
