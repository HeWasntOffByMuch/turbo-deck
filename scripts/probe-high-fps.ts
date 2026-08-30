/**
 * Is the frame loop capped at 60, or is it capped by what a frame costs?
 * `npx tsx scripts/probe-high-fps.ts`
 *
 * The two are indistinguishable from a fps counter on a 60Hz screen, and they
 * have opposite fixes. If the *loop* is capped -- a fixed step driving the
 * draw, a timer, a self-imposed limiter -- then no amount of optimisation moves
 * the number and the work is structural. If the *frame* is the cap, the loop is
 * already right and the work is the ~625 draw calls spec 165's ninth follow-up
 * took apart.
 *
 * This answers it directly, and the trick is that it does not need a fast
 * machine to do it. Two readings from the same browser:
 *
 *  - **full** -- the shipped frame, everything on.
 *  - **stripped** -- `?perf=noshadow,noprops,noterrain` in a small viewport,
 *    which is not a configuration anybody plays; it is a frame made cheap on
 *    purpose so that whatever is left holding the rate is the *loop*.
 *
 * If the loop were capped, `stripped` would stop at 60 however cheap the frame
 * got. It does not, which is the finding -- and this container rasterises in
 * software, so the demonstration is the *shape* of the two rows rather than
 * either number: a machine that cannot draw the real frame at 10fps still runs
 * the loop past 60 when the frame is cheap enough.
 *
 * Chromium is launched with vsync and the frame-rate limiter off. **In this
 * container that does not work**, which is why the first row of the output is a
 * *control*: `requestAnimationFrame` on a blank page, same flags, no game. It
 * comes back at 60.2fps with the flags off and 57.1 with them on -- headless
 * Chromium's frame source is pinned at 60Hz here and neither switch lifts it.
 *
 * So the control is not a formality, it is the whole reading. Without it a game
 * row at 46fps looks like evidence of a cap in this repo, and it is evidence of
 * the browser. With it the probe can say which of the two it measured, and on a
 * machine whose browser is not pinned it says the thing it was written to say.
 *
 * `t/f` is the corroborating number and the one that says the split is honest:
 * the sim is a fixed 60Hz accumulator, so above 60fps a frame must drain *less
 * than one tick on average*. A `t/f` of 1.00 at 90fps would mean the sim was
 * being stepped per frame and the whole rate split was a fiction.
 */

import { chromium, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const PORT = Number(process.env["PORT"] ?? 8817);
const PAGE_PORT = Number(process.env["PAGE_PORT"] ?? 4327);
const CHROMIUM_PATH =
  process.env["CHROMIUM_PATH"] ?? "/opt/pw-browsers/chromium";

/**
 * The last two are the point. Chromium's headless compositor throttles
 * `requestAnimationFrame` to the display's nominal 60Hz whatever the page
 * costs, so without them every row of this table reads 60 and the probe
 * measures the browser rather than the game.
 */
const CHROMIUM_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
];

interface Variant {
  readonly label: string;
  readonly perf: string;
  /** Small for the stripped row: software rasterisation is fill-bound where a
   *  real GPU is not, so the viewport is what makes the frame cheap here. */
  readonly viewport: { readonly width: number; readonly height: number };
}

const VARIANTS: readonly Variant[] = [
  { label: "full frame", perf: "", viewport: { width: 1280, height: 800 } },
  {
    label: "stripped frame",
    perf: "noshadow,noprops,noterrain",
    viewport: { width: 480, height: 270 },
  },
  // Smaller again, because the first cut of this probe stopped at 42.8fps with
  // 18.25ms of its 23ms frame still inside the draw call -- software
  // rasterisation is fill-bound where a real GPU is not, so the viewport had to
  // come down until what was left holding the rate was this game's loop rather
  // than SwiftShader's fill. A frame this size is not a configuration anybody
  // plays; it is the control that makes the cap testable at all on a machine
  // that cannot draw the real one.
  {
    label: "tiny frame",
    perf: "noshadow,noprops,noterrain",
    viewport: { width: 192, height: 108 },
  },
];

interface Reading {
  label: string;
  fps: number;
  ticksPerFrame: number;
  simMs: number;
  prepareMs: number;
  drawMs: number;
  restMs: number;
  calls: number;
}

function run(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn("node_modules/.bin/tsx", [script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  return child;
}

function stop(child: ChildProcess | null): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function refuseIfTaken(port: number): Promise<void> {
  const alive = await fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  );
  if (alive)
    throw new Error(
      `port ${port} already answers -- a previous run leaked a server`,
    );
}

/** Median, so one hitch does not decide the row. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function readVariant(
  page: Page,
  url: string,
  variant: Variant,
): Promise<Reading> {
  await page.setViewportSize({ ...variant.viewport });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-world-ready]", { timeout: 300_000 });
  // Standing still, after the loader has stopped: the frame being measured is
  // the one somebody spends their time in, not the one that was loading.
  await sleep(8000);

  const samples: Reading[] = [];
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    // No helper function inside the page callback: `tsx` compiles this file
    // with esbuild, which injects a `__name` shim around any named function it
    // finds -- and that shim does not exist in the page, so the evaluate throws
    // `__name is not defined` at the first sample.
    const now = await page.evaluate(() => {
      const d =
        document.querySelector<HTMLElement>("[data-fps-value]")?.dataset;
      return {
        fps: Number(d?.["fpsValue"] ?? 0),
        ticksPerFrame: Number(d?.["fpsTicksPerFrame"] ?? 0),
        simMs: Number(d?.["fpsSim"] ?? 0),
        prepareMs: Number(d?.["fpsPrepare"] ?? 0),
        drawMs: Number(d?.["fpsDraw"] ?? 0),
        restMs: Number(d?.["fpsRest"] ?? 0),
        calls: Number(d?.["fpsDrawCalls"] ?? 0),
      };
    });
    samples.push({ label: variant.label, ...now });
  }
  return {
    label: variant.label,
    fps: median(samples.map((s) => s.fps)),
    ticksPerFrame: median(samples.map((s) => s.ticksPerFrame)),
    simMs: median(samples.map((s) => s.simMs)),
    prepareMs: median(samples.map((s) => s.prepareMs)),
    drawMs: median(samples.map((s) => s.drawMs)),
    restMs: median(samples.map((s) => s.restMs)),
    calls: median(samples.map((s) => s.calls)),
  };
}

/**
 * What `requestAnimationFrame` does on a page with nothing in it.
 *
 * The ceiling every row below is measured against. A game row can only be read
 * as "the loop is capped" if this row is higher than it -- and where this row is
 * itself 60, nothing measured on this machine can answer the question at all,
 * which is a result worth printing rather than a run worth throwing away.
 */
async function blankPageRate(args: readonly string[]): Promise<number> {
  const browser = await chromium.launch({
    args: [...args],
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 192, height: 108 },
    });
    await page.setContent('<body style="background:#123"></body>');
    // Handed over as a *string* rather than as a function, and that is not a
    // style choice: `tsx` compiles this file with esbuild, which wraps any named
    // function it finds in a `__name` shim -- and the shim does not exist in the
    // page, so a recursive `requestAnimationFrame` callback written the obvious
    // way throws `__name is not defined` on the first frame. A string never
    // passes through the compiler.
    return await page.evaluate<number>(`new Promise((resolve) => {
      let frames = 0;
      const started = performance.now();
      requestAnimationFrame(function step() {
        frames += 1;
        const spent = performance.now() - started;
        if (spent >= 3000) resolve((frames * 1000) / spent);
        else requestAnimationFrame(step);
      });
    })`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  await refuseIfTaken(PORT);
  await refuseIfTaken(PAGE_PORT);
  const server = run("src/server/index.ts", {
    PORT: String(PORT),
    TICK_RATE: "60",
  });

  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".glb": "model/gltf-binary",
  };
  const pages = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const file = join("dist", path === "/" ? "index.html" : path.slice(1));
    readFile(file).then(
      (body) => {
        res.writeHead(200, {
          "content-type": types[extname(file)] ?? "application/octet-stream",
        });
        res.end(body);
      },
      () => {
        res.writeHead(404);
        res.end();
      },
    );
  });
  await new Promise<void>((resolve) => pages.listen(PAGE_PORT, resolve));

  console.log("  measuring the control (a blank page)...");
  const ceiling = await blankPageRate(CHROMIUM_ARGS);

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const readings: Reading[] = [];

  try {
    await sleep(9000);
    for (const variant of VARIANTS) {
      const query = `?server=ws://127.0.0.1:${PORT}${variant.perf ? `&perf=${variant.perf}` : ""}`;
      console.log(`  measuring ${variant.label}...`);
      readings.push(
        await readVariant(
          page,
          `http://127.0.0.1:${PAGE_PORT}/${query}`,
          variant,
        ),
      );
    }
  } finally {
    await browser.close();
    pages.closeAllConnections();
    pages.close();
    stop(server);
  }

  console.log(
    "\nvariant             fps    t/f     sim    prep    draw    rest   draws",
  );
  for (const row of readings) {
    console.log(
      `${row.label.padEnd(16)} ${row.fps.toFixed(1).padStart(6)} ` +
        `${row.ticksPerFrame.toFixed(2).padStart(6)} ` +
        `${row.simMs.toFixed(2).padStart(7)} ${row.prepareMs.toFixed(2).padStart(7)} ` +
        `${row.drawMs.toFixed(2).padStart(7)} ${row.restMs.toFixed(2).padStart(7)} ` +
        `${String(row.calls).padStart(7)}`,
    );
  }

  const cheapest = readings.find((r) => r.label === "tiny frame");
  console.log(
    `\ncontrol: a blank page runs at ${ceiling.toFixed(1)}fps on this browser.`,
  );
  if (ceiling <= 65) {
    console.log(
      "which is the 60Hz frame source, not a fact about this game -- so nothing measured\n" +
        "here can show a page of any kind above 60, and the fps column below is not evidence\n" +
        "either way. Read `prep`, `sim` and `draws`: those are what a faster machine has to fit\n" +
        "into a shorter frame, and they transfer.",
    );
  } else if (cheapest && cheapest.fps > 60) {
    console.log(
      `the loop is not capped: ${cheapest.fps.toFixed(1)}fps with the frame made cheap, and ` +
        `${cheapest.ticksPerFrame.toFixed(2)} sim ticks a frame under it -- the fixed 60Hz step\n` +
        "is still 60Hz beneath a faster draw, which is what the split is supposed to do.",
    );
  } else if (cheapest) {
    console.log(
      `inconclusive: the browser would allow ${ceiling.toFixed(1)}fps and the cheapest frame ` +
        `reached ${cheapest.fps.toFixed(1)}. Make the frame cheaper.`,
    );
  }
  console.log(
    "\nthe fps here is software rasterised and transfers to nothing; `prep`, `sim` and",
  );
  console.log("`draws` are what transfer to a real GPU.");
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
