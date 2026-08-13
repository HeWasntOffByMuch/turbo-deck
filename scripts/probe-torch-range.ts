/**
 * Walk away from spawn with the torch lit, and watch what the frame does.
 *
 *   npm run build && npx tsx scripts/probe-torch-zoom.ts   (the measurement)
 *   npm run build && npx tsx scripts/probe-torch-range.ts  (this, the walk)
 *
 * A player reported that leaving the spawn area with the torch on wrecked the
 * screen, and that switching the torch off OR walking back fixed it. Neither
 * half is reachable from Node: it needs a GL context to happen in, and it needs
 * the chunk stream to have delivered ground that was not there at spawn.
 *
 * This is the *distance* half, and what it establishes is a negative: sixteen
 * legs round the compass at midnight with the torch lit, and the frame stays
 * correct throughout -- no shader relink, no GL error, no lost body, and a draw
 * count that tracks how many monsters are replicated rather than how far the
 * walk has gone. What the report turned out to be about is the *zoom*, which
 * `probe-torch-zoom.ts` measures. This is kept because standing up a real
 * server, a proxied page and a player who walks is the expensive part of asking
 * any question of this kind, and because a negative nobody can re-run is not a
 * negative.
 *
 * Three things in it were each learned by writing the version without them.
 * It serves the **dev server** rather than `vite preview`, because `?server`
 * needs the `/ws` proxy and `preview` has none -- without it the page falls back
 * to a disconnected tab with no world in it, which photographs as a clean empty
 * frame and reads as "no fault found". It walks by **right-clicking** rather
 * than by holding WASD, because this environment paints about two frames a
 * second and a whole keypress lands inside one of them; a move order is a single
 * event the server keeps acting on between frames, which is the only kind of
 * input that travels here. And it opens the day/night **cycle** before holding
 * the clock, because the cycle is off by default and the Time slider is inert
 * without it -- the first version held midnight over a scene in fixed daylight
 * and reported on a torch nobody could see against the sun.
 *
 * Counts are meaningful on this machine even though timings are not-ish; see
 * probe-drawcalls.ts.
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
const PORT = 4341;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** Counting hooks, installed before any page script runs (as probe-drawcalls.ts). */
const INSTALL = `
(function () {
  var counts = {};
  var errors = [];
  window.__probe = { frames: [], errors: errors };
  function bump(n) { counts[n] = (counts[n] || 0) + 1; }
  function patch(proto) {
    if (!proto || proto.__probed) return;
    proto.__probed = true;
    ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced',
     'useProgram','bindFramebuffer','compileShader','linkProgram','texImage2D'
    ].forEach(function (n) {
      var orig = proto[n];
      if (typeof orig !== 'function') return;
      proto[n] = function () { bump(n); return orig.apply(this, arguments); };
    });
    var getError = proto.getError;
    if (typeof getError === 'function') {
      proto.getError = function () {
        var e = getError.apply(this, arguments);
        if (e !== 0 && errors.length < 40) errors.push(e);
        return e;
      };
    }
  }
  if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);
  var last = performance.now();
  function tick() {
    var now = performance.now();
    window.__probe.frames.push({ dt: now - last, counts: counts });
    if (window.__probe.frames.length > 4000) window.__probe.frames.shift();
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

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
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

/** Empty the per-frame log, so a leg is measured on its own. */
async function reset(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (window as unknown as { __probe: { frames: unknown[] } }).__probe;
    probe.frames.length = 0;
  });
}

async function drain(page: Page): Promise<{ frames: Frame[]; errors: number[] }> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __probe: { frames: Frame[]; errors: number[] } }).__probe;
    return { frames: probe.frames.slice(), errors: probe.errors.slice() };
  }) as Promise<{ frames: Frame[]; errors: number[] }>;
}

function summarise(name: string, frames: Frame[]): void {
  const drawn = frames.filter((f) => (f.counts['drawElements'] ?? 0) > 0);
  const mean = (key: string): number =>
    drawn.length === 0
      ? 0
      : drawn.reduce((a, f) => a + (f.counts[key] ?? 0), 0) / drawn.length;
  const dt = drawn.length === 0 ? 0 : drawn.reduce((a, f) => a + f.dt, 0) / drawn.length;
  const compiles = frames.reduce((a, f) => a + (f.counts['compileShader'] ?? 0), 0);
  const links = frames.reduce((a, f) => a + (f.counts['linkProgram'] ?? 0), 0);
  console.log(
    `  ${name.padEnd(22)} frames ${String(drawn.length).padStart(4)}  ` +
      `dt ${dt.toFixed(0).padStart(5)}ms  draws ${mean('drawElements').toFixed(0).padStart(5)}  ` +
      `instanced ${mean('drawElementsInstanced').toFixed(0).padStart(4)}  ` +
      `programs ${mean('useProgram').toFixed(0).padStart(4)}  ` +
      `fbo ${mean('bindFramebuffer').toFixed(0).padStart(4)}  ` +
      `compiles ${compiles}  links ${links}`,
  );
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outDir, `torch-${name}.png`) });
  console.log(`  wrote torch-${name}.png`);
}

/**
 * The camera's zoom span, published on the canvas because a phone has no slider
 * to read it off (`view-controls.ts`).
 */
async function zoom(page: Page): Promise<string> {
  return (await page.getAttribute('[data-camera-zoom]', 'data-camera-zoom')) ?? '?';
}

/** Where the local player's own health bar is, which is where the body is. */
async function selfBar(page: Page): Promise<{ x: number; y: number } | null> {
  const found = await page.$$eval('[data-entity]', (nodes) =>
    nodes
      .map((node) => node as HTMLElement)
      .filter((element) => element.dataset['self'] !== undefined)
      .map((element) => ({ x: element.offsetLeft + element.offsetWidth / 2, y: element.offsetTop })),
  );
  return found[0] ?? null;
}

/**
 * How many pixels the player's body is actually made of, found rather than
 * guessed: hovering a unit brightens its rig and nothing else in the scene
 * (spec 095), so the pixels that move when the cursor lands on it *are* the rig.
 * A body drawn black and a body not drawn at all look the same in a screenshot;
 * they do not look the same to this.
 */
async function bodyPixels(page: Page): Promise<number> {
  const bar = await selfBar(page);
  if (bar === null) return -1;
  const box = { left: Math.round(bar.x - 60), top: Math.round(bar.y - 10), width: 120, height: 140 };
  const parked = { x: Math.max(20, bar.x - 380), y: bar.y + 260 };

  await page.mouse.move(parked.x, parked.y);
  await page.waitForTimeout(900);
  const cold = PNG.sync.read(await page.screenshot());

  let best = 0;
  for (const drop of [42, 30, 55, 68, 20]) {
    await page.mouse.move(bar.x, bar.y + drop);
    await page.waitForTimeout(900);
    const warm = PNG.sync.read(await page.screenshot());
    let moved = 0;
    for (let y = box.top; y < Math.min(cold.height, box.top + box.height); y++) {
      for (let x = box.left; x < Math.min(cold.width, box.left + box.width); x++) {
        const i = (y * cold.width + x) * 4;
        const a = ((cold.data[i] ?? 0) + (cold.data[i + 1] ?? 0) + (cold.data[i + 2] ?? 0)) / 3;
        const b = ((warm.data[i] ?? 0) + (warm.data[i + 1] ?? 0) + (warm.data[i + 2] ?? 0)) / 3;
        if (b - a > 10) moved++;
      }
    }
    if (moved > best) best = moved;
    if (best > 300) break;
  }
  await page.mouse.move(parked.x, parked.y);
  return best;
}

/**
 * Walk by right-clicking the ground, repeatedly, toward one edge of the frame.
 *
 * Not WASD: a held key reached the page and moved nothing, because this
 * environment paints about two frames a second and the whole keypress lands
 * inside one of them. A move *order* is a single event the server keeps acting
 * on between frames, which is the only kind of input that travels here.
 */
async function walk(
  page: Page,
  towards: { x: number; y: number },
  presses: number,
): Promise<void> {
  for (let i = 0; i < presses; i++) {
    await page.mouse.click(towards.x, towards.y, { button: 'right' });
    await page.waitForTimeout(2500);
  }
}

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
 * Hold the sky at midnight. The report is about a torch, and a torch against
 * daylight is a warm patch on an already-lit world -- the condition it was seen
 * in is the one where the torch is the only light there is.
 */
async function holdAtMidnight(page: Page): Promise<void> {
  await withMenu(page, 'Day and night', async () => {
    // The cycle first, and it is off by default: without it the sun comes from
    // the two manual sliders and the Time slider is inert, so the first version
    // of this "held midnight" over a scene in fixed daylight.
    await setCheckbox(page, 'Day/night cycle', true);
    await setCheckbox(page, 'Run the clock', false);
    await setSlider(page, 'Time', 0);
  });
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  // The real authoritative server on the real arena document, reached through
  // the dev server's `/ws` proxy -- which is what `?server` means and what the
  // report was made against. `vite preview` has no proxy, so the page there
  // silently falls back to a disconnected tab with no world in it.
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

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const console_: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console_.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => console_.push(`pageerror: ${e.message}`));
    await page.addInitScript(INSTALL);
    await page.goto(`http://localhost:${PORT}/?server&name=Probe`);
    await waitForTick(page, 120);
    await page.waitForTimeout(2000);

    // The torch is what is on trial, so make sure it is lit and hold the flame
    // still enough that two frames are comparable.
    await holdAtMidnight(page);
    await withMenu(page, 'Player lights', async () => {
      await setCheckbox(page, 'Torch', true);
    });
    await page.waitForTimeout(1500);

    console.log('\nat spawn:');
    await reset(page);
    await page.waitForTimeout(4000);
    summarise('spawn', (await drain(page)).frames);
    await shoot(page, 'spawn');

    // Zoomed out, because the reported frame is: the player is a dozen pixels
    // tall and there is no visible pool of torchlight at all, which is what a
    // 300-unit reach looks like across a 2800-unit view. The wheel rather than
    // the slider, so this is the zoom a player actually reaches for.
    await page.mouse.move(640, 400);
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 240);
    await page.waitForTimeout(2500);
    console.log(`  view span now ${await zoom(page)}`);
    await reset(page);
    await page.waitForTimeout(4000);
    summarise('spawn, zoomed out', (await drain(page)).frames);
    await shoot(page, 'spawn-wide');

    // Round the compass rather than in one line: the report is "leaving the
    // spawn area", and the edge of the document is a wall the walk would stop
    // at long before nineteen minutes of play had streamed anything like the
    // ground that player crossed.
    const compass = [
      { x: 200, y: 200 },
      { x: 1080, y: 200 },
      { x: 1080, y: 620 },
      { x: 200, y: 620 },
    ];
    for (let leg = 1; leg <= 16; leg++) {
      const away = compass[(leg - 1) % compass.length];
      if (away === undefined) continue;
      await reset(page);
      await walk(page, away, 5);
      summarise(`away-${leg}`, (await drain(page)).frames);
      await shoot(page, `away-${leg}`);
    }

    // Which half of the torch loses the body: the shader patch that re-sites the
    // point lights for the player's own materials, or the cube shadow map it
    // takes the player out of.
    console.log('\nfar from spawn, one switch at a time:');
    const conditions: { name: string; torch: boolean; shadows: boolean; self: boolean }[] = [
      { name: 'torch-off', torch: false, shadows: true, self: false },
      { name: 'torch-on', torch: true, shadows: true, self: false },
      { name: 'torch-no-shadows', torch: true, shadows: false, self: false },
      { name: 'torch-self-shadow', torch: true, shadows: true, self: true },
    ];
    let back = { frames: [] as Frame[], errors: [] as number[] };
    for (const condition of conditions) {
      await withMenu(page, 'Player lights', async () => {
        await setCheckbox(page, 'Torch', condition.torch);
        if (condition.torch) {
          await setCheckbox(page, 'Torch shadows', condition.shadows);
          await setCheckbox(page, 'Player casts torch shadow', condition.self);
        }
      });
      await reset(page);
      await page.waitForTimeout(4000);
      back = await drain(page);
      summarise(condition.name, back.frames);
      console.log(`    body pixels: ${await bodyPixels(page)}`);
      await shoot(page, `far-${condition.name}`);
    }

    console.log(`\nGL errors seen: ${back.errors.length}${back.errors.length ? ` ${back.errors.join(',')}` : ''}`);
    if (console_.length > 0) {
      console.log('console:');
      for (const line of console_.slice(0, 30)) console.log(`  ${line}`);
      if (console_.length > 30) console.log(`  ... ${console_.length - 30} more`);
    } else {
      console.log('console: clean');
    }
  } finally {
    await browser.close();
    server.kill();
    // Its own process group, so the tsx wrapper does not leave the server
    // holding the port (probe-admin-console.ts learned this one).
    if (game.pid !== undefined) {
      try {
        process.kill(-game.pid, 'SIGTERM');
      } catch {
        game.kill();
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
