/**
 * What the torch actually does to the frame, at the zoom a player plays at.
 *
 *   npm run build && npx tsx scripts/probe-torch-zoom.ts
 *
 * A player reported that leaving the spawn area with the torch lit turned the
 * whole scene "blurry and skewed", and that switching the torch off OR walking
 * back fixed it. The screenshot that came with it is a wide view: the player is
 * a dozen pixels tall, the monsters are red bars over a dark mush, and there is
 * no visible pool of torchlight anywhere. That framing is the thing to measure
 * against, because it is not the one any other probe here uses -- every visual
 * check in this repo photographs the default 320-unit span, where the torch is
 * an unmissable bloom and the world is legible.
 *
 * Two questions, and they have different answers:
 *
 *  - **Does the torch light anything it should not?** Measured, not eyeballed:
 *    the same three patches of frame with the torch on and off, at both spans.
 *    A pool at the player and nothing at the edges is a light behaving; the
 *    edges moving with it would be a cutoff that is not biting. Worth measuring
 *    because the eye says otherwise -- against a dithered night frame the torch
 *    version reads as washed out across the whole picture, and it is not.
 *  - **What does it cost?** Frame time and draw calls per condition. The torch
 *    is a cube shadow map -- six passes -- and the panel already calls it the
 *    first thing to switch off if the view stutters. This says by how much, and
 *    whether zooming out multiplies it.
 *
 * Held at midnight throughout, since a torch against daylight is a warm patch on
 * an already-lit world and says nothing about either question.
 *
 * Serves the dev server rather than `vite preview`, because `?server` needs the
 * `/ws` proxy: without it the page silently falls back to a disconnected tab
 * with no world in it, which photographs as a clean empty frame.
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
const PORT = 4342;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The two spans compared: what the tab opens at, and what the wheel reaches. */
const SPANS = [320, 1400] as const;

/**
 * The patches each frame is measured over, in CSS pixels of a 1280x800 window.
 *
 * The camera keeps the player in the middle, so `pool` is where the torchlight
 * lands. The other two are corners of the world well outside any reach the
 * slider offers -- at the widest span they are over a thousand world units from
 * the flame, which is more than three times its default range.
 */
const PATCHES = [
  { name: 'pool', left: 560, top: 340, width: 160, height: 100 },
  { name: 'far top-left', left: 60, top: 200, width: 200, height: 120 },
  { name: 'far bottom-right', left: 900, top: 520, width: 240, height: 120 },
] as const;

/**
 * How far a far patch may move between torch on and torch off, per channel.
 *
 * Not zero: the world is live -- trees sway, monsters walk, the flame gutters --
 * and two frames seconds apart differ everywhere by a little. A couple of levels
 * is that churn; a light spilling past its cutoff would be worth tens.
 */
const SPILL_TOLERANCE = 3;

/** Per-frame counting hooks, installed before any page script runs. */
const INSTALL = `
(function () {
  var counts = {};
  window.__probe = { frames: [] };
  function bump(n) { counts[n] = (counts[n] || 0) + 1; }
  function patch(proto) {
    if (!proto || proto.__probed) return;
    proto.__probed = true;
    ['drawElements','drawArrays','useProgram','bindFramebuffer'].forEach(function (n) {
      var orig = proto[n];
      if (typeof orig !== 'function') return;
      proto[n] = function () { bump(n); return orig.apply(this, arguments); };
    });
  }
  if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);
  var last = performance.now();
  function tick() {
    var now = performance.now();
    window.__probe.frames.push({ dt: now - last, counts: counts });
    if (window.__probe.frames.length > 2000) window.__probe.frames.shift();
    last = now;
    counts = {};
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
`;

interface Frame {
  readonly dt: number;
  readonly counts: Record<string, number>;
}

interface Patch {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

interface Reading {
  readonly patches: Patch[];
  readonly dt: number;
  readonly draws: number;
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server never came up at ${url}`);
}

async function waitForTick(page: Page, ticks: number, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const text = (await page.textContent('body')) ?? '';
    last = Number(/tick (\d+)/.exec(text)?.[1] ?? -1);
    if (last >= ticks) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`sim never reached tick ${ticks} (last seen ${last})`);
}

/** Open a settings popover by the label on its button, and close it again. */
async function withMenu(page: Page, label: string, body: () => Promise<void>): Promise<void> {
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForTimeout(150);
  await body();
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForTimeout(150);
}

async function setCheckbox(page: Page, label: string, on: boolean): Promise<void> {
  const selector = `label:has-text("${label}") input[type=checkbox]`;
  const checked = await page.$eval(selector, (node) => (node as HTMLInputElement).checked);
  if (checked !== on) await page.click(selector);
}

/** Set a range input by the text of the row it sits in. */
async function setSlider(page: Page, label: string, value: number): Promise<void> {
  await page.$eval(
    `label:has-text("${label}") input[type=range]`,
    (node, v) => {
      const input = node as HTMLInputElement;
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
}

/**
 * Hold the sky at midnight.
 *
 * The cycle checkbox first, and it is off by default: without it the sun comes
 * from the two manual sliders and the Time slider is inert, so the first version
 * of this "held midnight" over a scene in fixed daylight and measured nothing.
 */
async function holdAtMidnight(page: Page): Promise<void> {
  await withMenu(page, 'Day and night', async () => {
    await setCheckbox(page, 'Day/night cycle', true);
    await setCheckbox(page, 'Run the clock', false);
    await setSlider(page, 'Time', 0);
  });
}

function samplePatch(png: PNG, box: (typeof PATCHES)[number]): Patch {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = box.top; y < Math.min(png.height, box.top + box.height); y++) {
    for (let x = box.left; x < Math.min(png.width, box.left + box.width); x++) {
      const i = (y * png.width + x) * 4;
      r += png.data[i] ?? 0;
      g += png.data[i + 1] ?? 0;
      b += png.data[i + 2] ?? 0;
      n++;
    }
  }
  const count = Math.max(1, n);
  return { r: r / count, g: g / count, b: b / count };
}

async function read(page: Page, name: string): Promise<Reading> {
  await page.evaluate(() => {
    (window as unknown as { __probe: { frames: unknown[] } }).__probe.frames.length = 0;
  });
  await page.waitForTimeout(5000);
  const frames = (await page.evaluate(
    () => (window as unknown as { __probe: { frames: Frame[] } }).__probe.frames.slice(),
  )) as Frame[];
  const png = PNG.sync.read(await page.screenshot());
  await page.screenshot({ path: join(outDir, `zoom-${name}.png`) });

  // Only frames that actually drew: this environment paints a couple of times a
  // second under software GL, and the animation frames in between would average
  // the cost of the scene down toward the cost of doing nothing.
  const drawn = frames.filter((frame) => (frame.counts['drawElements'] ?? 0) > 0);
  const total = (key: string): number =>
    drawn.reduce((sum, frame) => sum + (frame.counts[key] ?? 0), 0);
  return {
    patches: PATCHES.map((box) => samplePatch(png, box)),
    dt: drawn.length === 0 ? 0 : drawn.reduce((sum, frame) => sum + frame.dt, 0) / drawn.length,
    draws: drawn.length === 0 ? 0 : total('drawElements') / drawn.length,
  };
}

function channels(patch: Patch): string {
  return `${patch.r.toFixed(0)}/${patch.g.toFixed(0)}/${patch.b.toFixed(0)}`;
}

function biggestShift(before: Patch, after: Patch): number {
  return Math.max(
    Math.abs(after.r - before.r),
    Math.abs(after.g - before.g),
    Math.abs(after.b - before.b),
  );
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const game = spawn('node_modules/.bin/tsx', ['src/server/index.ts'], {
    cwd: root,
    stdio: 'ignore',
    detached: true,
  });
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(INSTALL);
    await page.goto(`http://localhost:${PORT}/?server&name=Zoom`);
    await waitForTick(page, 120);
    await page.waitForTimeout(2500);
    await holdAtMidnight(page);

    for (const span of SPANS) {
      console.log(`\nview span ${span}:`);
      await withMenu(page, 'View settings', async () => {
        await setSlider(page, 'View span', span);
      });

      await withMenu(page, 'Player lights', async () => {
        await setCheckbox(page, 'Torch', false);
      });
      const off = await read(page, `span${span}-torch-off`);
      await withMenu(page, 'Player lights', async () => {
        await setCheckbox(page, 'Torch', true);
      });
      const on = await read(page, `span${span}-torch-on`);

      PATCHES.forEach((box, i) => {
        const before = off.patches[i];
        const after = on.patches[i];
        if (before === undefined || after === undefined) return;
        const shift = biggestShift(before, after);
        console.log(
          `    ${box.name.padEnd(18)} off ${channels(before).padStart(12)}` +
            `   on ${channels(after).padStart(12)}   shift ${shift.toFixed(1)}`,
        );
        // The first patch is the pool the torch is standing in and must move a
        // long way; every other one is a corner of the world outside any reach
        // the slider offers, and must not move at all.
        check(
          i === 0 ? shift > 20 : shift <= SPILL_TOLERANCE,
          i === 0
            ? `span ${span}: the torch lights the ground it is standing on`
            : `span ${span}: nothing at "${box.name}" moves with the torch`,
        );
      });
      console.log(
        `    cost: ${off.dt.toFixed(0)}ms/${off.draws.toFixed(0)} draws with it off, ` +
          `${on.dt.toFixed(0)}ms/${on.draws.toFixed(0)} draws with it on ` +
          `(${(on.dt / Math.max(1, off.dt)).toFixed(2)}x)`,
      );
    }
  } finally {
    await browser.close();
    server.kill();
    // Its own process group: `tsx` is a wrapper, and a SIGTERM to it leaves the
    // grandchild holding the port (probe-admin-console.ts learned this one).
    if (game.pid !== undefined) {
      try {
        process.kill(-game.pid, 'SIGTERM');
      } catch {
        game.kill();
      }
    }
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} problem(s):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\nthe torch lights its pool and nothing else, at both spans.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
