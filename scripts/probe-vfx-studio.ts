// Dev-only: does editing a field in the VFX tab actually change what is drawn?
// `npx tsx scripts/probe-vfx-studio.ts`
//
// The tab has had no browser check on its *editing* path at all. `preview-studio`
// asserts it mounts and has three columns; `vfx-panels.test.ts` asserts the field
// table partitions and that JSON round-trips. Between them a row can be missing
// from the panel, or present and wired to nothing, and every check stays green --
// which is exactly the class of failure this exists to catch, and the one that was
// reported: a new field added to the table, offered in the panel, and apparently
// doing nothing.
//
// ## The clock
//
// The preview replays on a real-time loop, so two screenshots of "the same" edit
// are two different moments and cannot be compared. `probe-health-flash.ts` hit
// this first and solved it the same way: the page's clock is replaced before any
// module runs, and the probe advances it by whole frames. The tab then draws a
// pure function of how many frames were pumped, so the only difference between
// two captures is the edit.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4329;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** A virtual clock, installed before the app's modules run. */
const CLOCK = `
(() => {
  let now = 0;
  const queue = [];
  performance.now = () => now;
  Date.now = () => 1700000000000 + now;
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  // One frame: 1/60s of virtual time, and every callback waiting for it.
  window.__frame = () => {
    now += 1000 / 60;
    const due = queue.splice(0, queue.length);
    for (const cb of due) { try { cb(now); } catch { /* the page's problem, not the clock's */ } }
    return due.length;
  };
})();
`;

declare global {
  interface Window {
    __frame?: () => number;
  }
}

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server at ${url} never came up`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Pump `count` whole frames of the page's virtual clock. */
async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) window.__frame?.();
  }, count);
}

/** Pick an effect out of the tab's browser column. */
async function selectEffect(page: Page, id: string): Promise<void> {
  await page.evaluate((wanted) => {
    const tab = document.getElementById('vfx-studio');
    const button = Array.from(tab?.querySelectorAll('button') ?? []).find((node) => node.textContent === wanted);
    (button as HTMLButtonElement | undefined)?.click();
  }, id);
}

/**
 * Every field row the panel is currently offering, by its label.
 *
 * A number row is `label > div > span(name) + span(value)`, so the obvious read
 * of the row's first div returns "Radius8" and every name check fails. The first
 * version of this reported three rows missing that were on screen the whole
 * time -- a probe that lies in the direction of "something is broken" is worse
 * than no probe, because the bug it invents gets fixed.
 */
async function panelRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const panel = document.getElementById('vfx-studio')?.lastElementChild;
    return Array.from(panel?.querySelectorAll('label') ?? [])
      .map((node) => {
        const head = node.querySelector('div');
        return (head?.querySelector('span')?.textContent ?? head?.textContent ?? '').trim();
      })
      .filter((text) => text.length > 0);
  });
}

/** Switch the panel to one of the effect's emitters, by its id. */
async function selectEmitter(page: Page, id: string): Promise<void> {
  await page.evaluate((wanted) => {
    const panel = document.getElementById('vfx-studio')?.lastElementChild;
    const button = Array.from(panel?.querySelectorAll('button') ?? []).find((node) => node.textContent === wanted);
    (button as HTMLButtonElement | undefined)?.click();
  }, id);
}

/** Drag a slider row to a value and fire the input the panel listens for. */
async function setNumber(page: Page, label: string, value: number): Promise<boolean> {
  return page.evaluate(
    ([wanted, next]) => {
      const panel = document.getElementById('vfx-studio')?.lastElementChild;
      for (const row of Array.from(panel?.querySelectorAll('label') ?? [])) {
        if (row.querySelector('div')?.querySelector('span')?.textContent !== wanted) continue;
        const slider = row.querySelector('input[type=range]') as HTMLInputElement | null;
        if (!slider) return false;
        slider.value = String(next);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    },
    [label, value] as const,
  );
}

/** Read a `<select>` row by its label. */
async function readSelect(page: Page, label: string): Promise<string | null> {
  return page.evaluate((wanted) => {
    const panel = document.getElementById('vfx-studio')?.lastElementChild;
    for (const row of Array.from(panel?.querySelectorAll('label') ?? [])) {
      if (row.querySelector('div')?.textContent !== wanted) continue;
      const pick = row.querySelector('select');
      return pick ? pick.value : null;
    }
    return null;
  }, label);
}

/** Set a `<select>` row and fire the change the panel listens for. */
async function setSelect(page: Page, label: string, value: string): Promise<boolean> {
  return page.evaluate(
    ([wanted, next]) => {
      const panel = document.getElementById('vfx-studio')?.lastElementChild;
      for (const row of Array.from(panel?.querySelectorAll('label') ?? [])) {
        if (row.querySelector('div')?.textContent !== wanted) continue;
        const pick = row.querySelector('select');
        if (!pick) return false;
        pick.value = next as string;
        pick.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    },
    [label, value] as const,
  );
}

/** The tab's own JSON export, which is what it believes it is editing. */
async function exportedJson(page: Page): Promise<string> {
  return page.evaluate(() => {
    const tab = document.getElementById('vfx-studio');
    const button = Array.from(tab?.querySelectorAll('button') ?? []).find((node) => node.textContent === 'Export JSON');
    (button as HTMLButtonElement | undefined)?.click();
    return (tab?.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? '';
  });
}

/** Replay from the start and draw exactly `ticks` frames of it. */
async function shotAt(page: Page, ticks: number): Promise<PNG> {
  await page.evaluate(() => {
    const tab = document.getElementById('vfx-studio');
    const button = Array.from(tab?.querySelectorAll('button') ?? []).find((node) => node.textContent === 'Replay');
    (button as HTMLButtonElement | undefined)?.click();
  });
  // One frame to rebuild (the replay is deferred), then the run itself.
  await frames(page, ticks + 1);
  const canvas = page.locator('#vfx-studio canvas').first();
  return PNG.sync.read(await canvas.screenshot());
}

/**
 * How many separate blobs of effect the frame holds.
 *
 * The measure that actually states the claim. A broken stroke and an intact one
 * overlap everywhere except the gap, so *how many pixels changed* is small even
 * when the read is completely different -- the first version of this gated on
 * that and would have had the shader retuned to satisfy a number rather than the
 * picture. Counting pieces asks the question directly: a mark that has come
 * apart is more of them.
 *
 * Against a baseline frame with the effect finished, rather than a colour rule.
 * The version that tested "is this pixel red" also matched the tab's default
 * dirt ground, so every frame came back as one enormous piece and the check
 * reported no difference at all -- the same trap `preview-brush-vfx.ts` fell
 * into and solved the same way.
 */
function inkPieces(png: PNG, base: PNG): number {
  const w = png.width;
  const h = png.height;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const at = i * 4;
    const dr = Math.abs((png.data[at] ?? 0) - (base.data[at] ?? 0));
    const dg = Math.abs((png.data[at + 1] ?? 0) - (base.data[at + 1] ?? 0));
    const db = Math.abs((png.data[at + 2] ?? 0) - (base.data[at + 2] ?? 0));
    if (Math.max(dr, dg, db) > 14) mask[i] = 1;
  }
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let pieces = 0;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const at = stack.pop() as number;
      size += 1;
      const x = at % w;
      const y = Math.floor(at / w);
      for (const next of [x > 0 ? at - 1 : -1, x < w - 1 ? at + 1 : -1, y > 0 ? at - w : -1, y < h - 1 ? at + w : -1]) {
        if (next < 0 || seen[next] || !mask[next]) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    // Specks are the anti-aliased fringe of something else, not a piece.
    if (size >= 12) pieces += 1;
  }
  return pieces;
}

/** The fraction of pixels where two frames disagree. */
function difference(a: PNG, b: PNG): number {
  const total = Math.min(a.width * a.height, b.width * b.height);
  let differing = 0;
  for (let i = 0; i < total; i++) {
    const at = i * 4;
    const dr = Math.abs((a.data[at] ?? 0) - (b.data[at] ?? 0));
    const dg = Math.abs((a.data[at + 1] ?? 0) - (b.data[at + 1] ?? 0));
    const db = Math.abs((a.data[at + 2] ?? 0) - (b.data[at + 2] ?? 0));
    if (Math.max(dr, dg, db) > 12) differing += 1;
  }
  return differing / total;
}

async function main(): Promise<void> {
  const shots = join(root, '.claude', 'screenshots');
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });
  const failures: string[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.addInitScript(CLOCK);
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

    // The shell mounts on its own frames, so pump some before touching anything.
    await frames(page, 20);
    await page.getByRole('button', { name: 'VFX', exact: true }).click();
    await frames(page, 20);

    // --- the rows the panel offers -----------------------------------------
    await selectEffect(page, 'blood_hit_brush_mist');
    await frames(page, 4);
    // Looping restarts a finished effect, and a restarted effect is identical
    // whichever ending it was given -- which quietly turns a late sample into a
    // comparison of two fresh replays.
    await page.evaluate(() => {
      const tab = document.getElementById('vfx-studio');
      const button = Array.from(tab?.querySelectorAll('button') ?? []).find((node) =>
        node.textContent?.startsWith('Loop: on'),
      );
      (button as HTMLButtonElement | undefined)?.click();
    });
    await frames(page, 4);
    const rows = await panelRows(page);
    console.log(`  panel offers ${rows.length} rows on blood_hit_brush_mist/primary`);
    for (const wanted of ['Ends by', 'Solid', 'Render as', 'Blend', 'Shape']) {
      if (!rows.includes(wanted)) failures.push(`the panel has no "${wanted}" row`);
    }
    // The four shape numbers this arc added. A `fan` carries all three of these,
    // so if they are missing the panel is dropping fields that exist.
    for (const wanted of ['Radius', 'Angle', 'Rise']) {
      if (!rows.includes(wanted)) failures.push(`the panel has no "${wanted}" row on a fan emitter`);
    }

    // --- does the field read what the definition says? ----------------------
    const decay = await readSelect(page, 'Ends by');
    console.log(`  "Ends by" reads ${decay ?? 'nothing'} on the mist`);
    if (decay !== 'fizzle') failures.push(`"Ends by" reads ${decay ?? 'nothing'}, expected fizzle`);

    // --- does changing it reach the definition, and the pixels? -------------
    //
    // Sampled across the ENDING rather than at one tick. The two decays are
    // identical until 58% of a mark's life, which on this effect is past tick
    // 26 -- the first version of this compared two frames from before either
    // ending had started and reported that the field did nothing.
    // Turn the company down to one mark each.
    //
    // The field under test decides how ONE stroke ends, and the effect draws
    // eleven marks -- so with all of them playing the measurement is nine dabs
    // and a scatter plus the thing being measured, and a stroke breaking in two
    // moves the piece count by one. Reducing the other layers to a single mark
    // is not making the test easier; it is pointing it at the claim.
    for (const layer of ['secondary', 'fragments']) {
      await selectEmitter(page, layer);
      await frames(page, 2);
      if (!(await setNumber(page, 'Count', 1))) failures.push(`could not turn ${layer} down`);
      await frames(page, 2);
    }
    await selectEmitter(page, 'primary');
    await frames(page, 2);

    // The same frame with nothing left playing, so the marks can be isolated
    // from the scene behind them.
    const empty = await shotAt(page, 400);

    const ENDING = [28, 33, 38, 43];
    const fizzled: PNG[] = [];
    for (const tick of ENDING) fizzled.push(await shotAt(page, tick));

    if (!(await setSelect(page, 'Ends by', 'retract'))) failures.push('could not set "Ends by"');
    await frames(page, 4);
    const json = await exportedJson(page);
    const says = /"strokeDecay"\s*:\s*"retract"/.test(json);
    console.log(`  after the change the tab exports strokeDecay retract: ${says}`);
    if (!says) failures.push('the change did not reach the definition the tab exports');

    let moved = 0;
    let movedAt = 0;
    let brokeMore = 0;
    for (let i = 0; i < ENDING.length; i++) {
      const retracted = await shotAt(page, ENDING[i] ?? 0);
      const delta = difference(fizzled[i] as PNG, retracted);
      const apart = inkPieces(fizzled[i] as PNG, empty);
      const whole = inkPieces(retracted, empty);
      brokeMore = Math.max(brokeMore, apart - whole);
      console.log(
        `    tick ${ENDING[i]}: ${(delta * 100).toFixed(3)}% of the canvas differs; ` +
          `fizzle is in ${apart} pieces, retract in ${whole}`,
      );
      if (delta > moved) {
        moved = delta;
        movedAt = i;
        writeFileSync(join(shots, 'vfx-studio-fizzle.png'), PNG.sync.write(fizzled[i] as PNG));
        writeFileSync(join(shots, 'vfx-studio-retract.png'), PNG.sync.write(retracted));
      }
    }
    console.log(`  worst tick is ${ENDING[movedAt]}, at ${(moved * 100).toFixed(3)}%`);
    console.log(`  at its most broken the fizzle is in ${brokeMore} more pieces than the retract`);
    // One is the signal, not a weak version of it: a stroke that breaks in two
    // is exactly one more piece. What this catches is the field not arriving at
    // the shader at all, which scores zero.
    if (brokeMore < 1) {
      failures.push(`the fizzle never came apart into more pieces than the retract (best: +${brokeMore})`);
    }
    // What the effect looks like at full strength, for a person to look at. A
    // difference measured in hundredths of a percent means nothing until it is
    // known how much of the canvas the effect covers at all.
    writeFileSync(join(shots, 'vfx-studio-alive.png'), PNG.sync.write(await shotAt(page, 12)));
    // Held against the control rather than against a fixed number, because what
    // counts as "visible" depends entirely on how big the effect is drawn -- and
    // the framing bug this probe found is exactly the case where an absolute
    // threshold would have been retuned instead of the bug being fixed.
    if (moved < 0.0005) failures.push(`switching "Ends by" never changed more than ${(moved * 100).toFixed(3)}% of the frame`);

    // --- and a control: a field that has always worked ----------------------
    await selectEffect(page, 'blood_hit_brush_mist');
    await frames(page, 4);
    const plain = await shotAt(page, 14);
    await setSelect(page, 'Solid', 'brush-blot');
    await frames(page, 4);
    const swapped = await shotAt(page, 14);
    const control = difference(plain, swapped);
    console.log(`  swapping the solid changed ${(control * 100).toFixed(3)}% of the canvas (the control)`);
    if (control < 0.0015) failures.push('the control edit changed nothing either -- the harness is not driving the tab');


    // Shader and script failures only. The unit importer logs a couple of
    // expected warnings through `console.error` on every page load, and a probe
    // that reports those as its own findings is a probe nobody reads.
    const shaderProblems = logs.filter(
      (line) => /shader|could not compile|pageerror/i.test(line) && !/favicon|404/i.test(line),
    );
    if (shaderProblems.length > 0) failures.push(...shaderProblems.slice(0, 3));
  } finally {
    await browser.close();
    server.kill();
  }

  if (failures.length > 0) {
    console.error('\nproblems:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('\nthe VFX tab respects the fields it offers');
  }
}

await main();
