/**
 * Screenshot the two tuning sandboxes (spec 066), for the same reason
 * `preview-world.ts` exists: their pure half is tested headlessly and their
 * three.js half is not testable at all without a GPU and a DOM.
 *
 *   npx tsx scripts/preview-sandbox.ts
 *
 * Drives the real page: switch to the tab, right-click the ground to send the
 * unit walking, cycle the archetype, hop, and photograph each into
 * `.claude/screenshots/`. Requires a build first (`npm run build`); it serves
 * `dist/` rather than the dev server, so what is photographed is what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4321;

/** Prefer a browser already on the box; otherwise let Playwright find its own. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`  wrote ${name}.png`);
}

/**
 * The status line each sandbox keeps above its canvas -- unit, archetype, gait.
 * Read off its own element rather than out of the body text: the tuning panel
 * next to it is a thousand characters of slider labels with no line breaks.
 */
async function statusLine(page: Page): Promise<string> {
  const line = page.locator('div').filter({ hasText: /^(Unit: |Rig debug · )/ }).last();
  return ((await line.textContent()) ?? '(no status line)').trim();
}

/**
 * Send the unit walking. The sandbox canvases sit in the ordinary page flow, so
 * the click point is measured off the canvas itself rather than guessed at in
 * viewport coordinates -- and off the *visible* one, since the tabs that are
 * hidden keep their canvases mounted.
 */
async function walk(page: Page, dx: number, dy: number): Promise<void> {
  const box = await page.locator('canvas:visible').first().boundingBox();
  if (!box) throw new Error('no visible canvas to click');
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { button: 'right' });
}

/**
 * Every visible control in the panel, by its lil-gui name (spec 152).
 *
 * Scoped to what is actually on screen, because the tab shell keeps the hidden
 * tabs' panels mounted and the rig debugger's controllers carry some of the same
 * names -- so an unscoped query answers with the wrong tab's numbers and looks
 * right. A lil-gui controller is a `.lil-controller` div holding a `.lil-name`
 * and its widget -- classes prefixed in this build, the same `.lil-children`
 * lookup `editor/panel.ts` already makes. The widget is read by *kind* rather
 * than by input type, because lil-gui's number control is an `input[type=text]`
 * beside a `div` slider: asking for `type=number` or `type=range` finds neither
 * and quietly reports a panel with three controls in it.
 */
async function panelControls(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const row of Array.from(document.querySelectorAll('.lil-controller'))) {
      if ((row as HTMLElement).offsetParent === null) continue; // hidden tab or closed folder
      const name = row.querySelector('.lil-name')?.textContent?.trim() ?? '';
      if (name === '') continue;
      const select = row.querySelector<HTMLSelectElement>('select');
      if (select) {
        out[name] = select.value;
        continue;
      }
      const input = row.querySelector<HTMLInputElement>('input');
      if (!input) continue;
      out[name] = input.type === 'checkbox' ? String(input.checked) : input.value;
    }
    return out;
  });
}

/**
 * How many pixels of the visible canvas are within `tolerance` of an RGB.
 *
 * Read off a screenshot rather than out of the drawing buffer: the sandbox's
 * renderer has no `preserveDrawingBuffer`, so `readPixels` from page script
 * returns a cleared buffer and would report zero for a picture that is there.
 */
async function countNear(
  page: Page,
  [wantR, wantG, wantB]: readonly [number, number, number],
  tolerance = 40,
): Promise<number> {
  const shot = await page.locator('canvas:visible').first().screenshot();
  const png = PNG.sync.read(shot);
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const dr = Math.abs((png.data[i] as number) - wantR);
    const dg = Math.abs((png.data[i + 1] as number) - wantG);
    const db = Math.abs((png.data[i + 2] as number) - wantB);
    if (dr <= tolerance && dg <= tolerance && db <= tolerance) count++;
  }
  return count;
}

/**
 * Drive a named control the way lil-gui's own listeners hear it.
 *
 * Both events on purpose: lil-gui's number and colour controllers update on
 * `input` and its dropdowns on `change`, and firing one of the two silently does
 * nothing for half the controls in the panel.
 */
async function setControl(page: Page, name: string, value: string): Promise<void> {
  await page.evaluate(
    ({ name, value }) => {
      for (const row of Array.from(document.querySelectorAll('.lil-controller'))) {
        if ((row as HTMLElement).offsetParent === null) continue;
        if ((row.querySelector('.lil-name')?.textContent ?? '').trim() !== name) continue;
        const field =
          row.querySelector<HTMLSelectElement>('select') ??
          row.querySelector<HTMLInputElement>('input');
        if (!field) continue;
        if (field instanceof HTMLInputElement && field.type === 'checkbox') {
          field.checked = value === 'true';
        } else {
          field.value = value;
        }
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      throw new Error(`no visible control named ${name}`);
    },
    { name, value },
  );
}

/** Pick a unit from the panel's Unit dropdown, which used to be a row of chips. */
async function pickUnit(page: Page, label: string): Promise<void> {
  await setControl(page, 'Unit', label);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const server = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore' },
  );

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');

    // --- Movement sandbox ---------------------------------------------------
    await page.getByRole('button', { name: 'Movement sandbox' }).click();
    // Terrain, vegetation and the prop field are built before the first frame,
    // and under software WebGL that is seconds rather than milliseconds.
    await page.waitForTimeout(4000);
    await shoot(page, 'sandbox-movement');
    console.log(`  ${await statusLine(page)}`);

    await walk(page, -160, 60);
    await page.waitForTimeout(700);
    await shoot(page, 'sandbox-walking');
    console.log(`  ${await statusLine(page)}`);

    // The critter's coat is a free colour now (spec 152), not a grid of twelve.
    await pickUnit(page, 'Pig');
    await page.waitForTimeout(900);
    await setControl(page, 'Colour', '#3f7a33');
    await page.waitForTimeout(500);
    const coated = await countNear(page, [0x3f, 0x7a, 0x33], 34);
    console.log(`  a green pig: ${coated} px of a colour no preset offers`);
    if (coated < 50) problems.push(`the free coat colour painted ${coated} px, expected an animal`);
    await pickUnit(page, 'Spider');
    await page.waitForTimeout(600);

    // C cycles the movement archetype (and loads its preset into the sliders).
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(200);
    console.log(`  after C: ${await statusLine(page)}`);

    // --- The small spider, and tuning it (spec 152) --------------------------
    // The chip has to LOAD the shipped look, or somebody tunes a body that is
    // not the one in the game. Read back off the real controls, because that is
    // the half no headless test can see.
    await pickUnit(page, 'Small spider');
    await page.waitForTimeout(900);
    const spider = await panelControls(page);
    console.log(
      `  small spider: size ${spider['Size']}, body size ${spider['Body size']}, ` +
        `body ${spider['Body']}, legs ${spider['Legs']}`,
    );
    // Numbers compared as numbers: lil-gui formats a control's text to the
    // decimals it was given, so `0.6` reads back as `0.60` and a string test
    // would fail on the formatting rather than on the value.
    for (const [label, want] of [
      ['Size', 0.6],
      ['Body size', 1.25],
    ] as const) {
      if (Number(spider[label]) !== want) {
        problems.push(`the Small spider chip left ${label} at ${spider[label]}, wanted ${want}`);
      }
    }
    for (const label of ['Body', 'Legs'] as const) {
      if (spider[label] !== '#3d3846') {
        problems.push(`the Small spider chip left ${label} at ${spider[label]}, wanted #3d3846`);
      }
    }
    // Photographed standing rather than mid-walk: this shot is about how big the
    // body is and what colour it is, and a unit crossing the frame at 148 units
    // a second is wherever the camera's easing left it.
    await page.waitForTimeout(600);
    await shoot(page, 'sandbox-small-spider');

    // Now change the two things the chip exists to let somebody change, and
    // check the colour actually reaches the screen. A well that writes into a
    // record nothing re-reads looks identical in a screenshot of a black body
    // on dark grass, which is exactly the mistake worth catching here.
    await setControl(page, 'Body size', '2.2');
    await setControl(page, 'Body', '#c83c28');
    await setControl(page, 'Legs', '#f0e6c8');
    await page.waitForTimeout(700);
    await shoot(page, 'sandbox-small-spider-tuned');
    const painted = await countNear(page, [0xc8, 0x3c, 0x28]);
    console.log(`  after tuning: ${painted} px of the picked body colour`);
    if (painted < 50) problems.push(`the body colour well painted ${painted} px, expected a body`);

    // And back: the plain spider must not have kept the small one's numbers.
    await pickUnit(page, 'Spider');
    await page.waitForTimeout(600);
    const back = await panelControls(page);
    console.log(`  back on Spider: size ${back['Size']}, body ${back['Body']}`);
    if (Number(back['Size']) !== 1) problems.push(`switching back left Size at ${back['Size']}, wanted 1`);

    // The hooded robe, and J to hop it: the cloth is the reason this tab exists.
    await pickUnit(page, 'Hooded robe');
    await page.waitForTimeout(1200);
    await walk(page, 150, -40);
    await page.waitForTimeout(500);
    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(250);
    await shoot(page, 'sandbox-robe-jump');
    console.log(`  ${await statusLine(page)}`);

    // --- Rig debug ----------------------------------------------------------
    await page.getByRole('button', { name: 'Rig debug' }).click();
    await page.waitForTimeout(2500);
    await shoot(page, 'sandbox-rig-debug');
    console.log(`  ${await statusLine(page)}`);

    // Right-click in the top-down (left) viewport to walk, so the leg overlays
    // are photographed mid-gait rather than standing.
    await walk(page, -150, 90);
    await page.waitForTimeout(600);
    await shoot(page, 'sandbox-rig-walking');

    // Slow-mo is what the viewport is for: the same gait, one tenth the speed.
    await setControl(page, 'Speed', '0.1×');
    await page.waitForTimeout(600);
    await shoot(page, 'sandbox-rig-slowmo');
    console.log(`  ${await statusLine(page)}`);

    if (problems.length > 0) {
      console.error('\npage reported errors:');
      for (const problem of problems) console.error(`  ${problem}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();
