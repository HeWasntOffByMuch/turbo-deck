/**
 * What the day/night cycle actually does (spec 264).
 *
 * A `preview-` rather than a `probe-` because what is being judged is a
 * **schedule**: a thumbnail of a sunset says nothing about whether the sunset
 * takes four seconds or forty, and forty is the whole question. So this walks a
 * whole cycle through the real `worldClockAt` and the real `skyAt` and prints
 * the numbers a picture hides.
 *
 * Four sheets:
 *
 *  1. **The table** -- what each segment is authored as, and the rate that falls
 *     out of it. The rate is the thing nobody authored and everybody has to live
 *     with, since a piecewise clock's one hazard is a boundary where it jumps.
 *  2. **The boundaries** -- the rate either side of each seam, as a ratio. Two of
 *     the four step by about 5x and the other two barely move, and the two that
 *     step sit where the colour ramp is flattest.
 *  3. **The walk** -- the phase, the hour, darkness, the sun's true elevation and
 *     the sky's colour, sampled across the cycle, with a mark at each seam.
 *  4. **The acceptance numbers** -- the largest step any sky channel takes
 *     between two frames at 60fps, against the 1/12 the retro pass can resolve;
 *     and how long the sun is really up and down, which is not the same question
 *     as how long the Day and Night *phases* are.
 *
 * Nothing here is read at runtime, and nothing here rasterises: every number is
 * available in Node, which is exactly why this is the right instrument for it.
 */

import { SERVER_TICK_RATE } from '../src/server/config.js';
import {
  CYCLE_SECONDS,
  CYCLE_TICKS,
  DAY_NIGHT_CYCLE,
  DAY_PHASE_NAMES,
  formatWorldHours,
  worldClockAt,
  type DayNightSegment,
} from '../src/server/data/day-night.js';
import { SKY_KEY_HOURS, skyAt, type Rgb, type SkyState } from '../src/render/iso3d/daynight.js';

const DEG = 180 / Math.PI;

/** How many clock hours a segment covers, wrapping across midnight. */
function spanHours(part: DayNightSegment): number {
  const raw = part.toHours - part.fromHours;
  return raw > 0 ? raw : raw + 24;
}

/** Clock hours per real second -- the number nobody authored. */
function rateOf(part: DayNightSegment): number {
  return spanHours(part) / part.seconds;
}

function mmss(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
}

function hex(rgb: Rgb): string {
  const byte = (channel: number): string =>
    Math.round(Math.min(1, Math.max(0, channel)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(rgb.r)}${byte(rgb.g)}${byte(rgb.b)}`;
}

/** A coarse bar, so the shape of a curve is readable down a column of text. */
function bar(value: number, width = 12): string {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * width);
  return '#'.repeat(filled) + '.'.repeat(width - filled);
}

function heading(title: string): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// --- 1: the table ----------------------------------------------------------

heading('The cycle');
console.log(
  `one cycle is ${mmss(CYCLE_SECONDS)} (${String(CYCLE_TICKS)} ticks at ${String(SERVER_TICK_RATE)}Hz)`,
);
console.log('');
console.log('  phase   real      ticks   clock hours     span    hours/sec   on a keyframe');
for (const part of DAY_NIGHT_CYCLE) {
  const onKeys = SKY_KEY_HOURS.includes(part.fromHours) && SKY_KEY_HOURS.includes(part.toHours);
  console.log(
    `  ${DAY_PHASE_NAMES[part.phase].padEnd(6)}` +
      `  ${mmss(part.seconds).padStart(6)}` +
      `  ${String(part.ticks).padStart(6)}` +
      `   ${formatWorldHours(part.fromHours)} -> ${formatWorldHours(part.toHours)}` +
      `  ${spanHours(part).toFixed(2).padStart(5)}h` +
      `   ${rateOf(part).toFixed(4).padStart(9)}` +
      `   ${onKeys ? 'yes' : 'NO -- a seam mid-transition'}`,
  );
}

// --- 2: the boundaries -----------------------------------------------------

heading('The seams');
console.log('A piecewise clock can only show a kink where its rate jumps.');
console.log('');
console.log('  seam            rate before   rate after    ratio   sky moves by');
for (let i = 0; i < DAY_NIGHT_CYCLE.length; i++) {
  const before = DAY_NIGHT_CYCLE[i] as DayNightSegment;
  const after = DAY_NIGHT_CYCLE[(i + 1) % DAY_NIGHT_CYCLE.length] as DayNightSegment;

  // How fast the *colour* is moving either side of the seam, which is what
  // decides whether a rate change is visible at all.
  let seamTick = 0;
  for (let j = 0; j <= i; j++) seamTick += (DAY_NIGHT_CYCLE[j] as DayNightSegment).ticks;
  const back = skyAt(worldClockAt(seamTick - 1).hours);
  const at = skyAt(worldClockAt(seamTick).hours);
  const ahead = skyAt(worldClockAt(seamTick + 1).hours);
  const channelStep = (a: SkyState, b: SkyState): number =>
    Math.max(
      Math.abs(a.skyColor.r - b.skyColor.r),
      Math.abs(a.skyColor.g - b.skyColor.g),
      Math.abs(a.skyColor.b - b.skyColor.b),
    );

  const label = `${DAY_PHASE_NAMES[before.phase]}->${DAY_PHASE_NAMES[after.phase]}`;
  console.log(
    `  ${label.padEnd(14)}` +
      `  ${rateOf(before).toFixed(4).padStart(11)}` +
      `  ${rateOf(after).toFixed(4).padStart(11)}` +
      `  ${(rateOf(after) / rateOf(before)).toFixed(2).padStart(6)}x` +
      `   ${channelStep(back, at).toFixed(6)} -> ${channelStep(at, ahead).toFixed(6)} per frame`,
  );
}

// --- 3: the walk -----------------------------------------------------------

heading('A cycle, walked');

const seamTicks = new Set<number>();
{
  let at = 0;
  for (const part of DAY_NIGHT_CYCLE) {
    seamTicks.add(at);
    at += part.ticks;
  }
}

// Dense enough through the transitions to see them, sparse through the flats.
const samples: number[] = [];
{
  let at = 0;
  for (const part of DAY_NIGHT_CYCLE) {
    const steps = part.seconds >= 300 ? 10 : 6;
    for (let i = 0; i < steps; i++) samples.push(at + Math.floor((part.ticks * i) / steps));
    at += part.ticks;
  }
}
for (const tick of seamTicks) if (!samples.includes(tick)) samples.push(tick);
samples.sort((a, b) => a - b);

console.log('  t (s)   phase   clock   darkness       sun el.   key light   sky');
for (const tick of samples) {
  const clock = worldClockAt(tick);
  const sky = skyAt(clock.hours);
  console.log(
    `  ${(tick / SERVER_TICK_RATE).toFixed(1).padStart(6)}` +
      `  ${DAY_PHASE_NAMES[clock.phase].padEnd(6)}` +
      `  ${formatWorldHours(clock.hours)}` +
      `  ${bar(clock.darkness)} ${clock.darkness.toFixed(2)}` +
      `  ${(sky.sunElevation * DEG).toFixed(1).padStart(6)}deg` +
      `  ${sky.lightIntensity.toFixed(2).padStart(5)}` +
      `  ${hex(sky.skyColor)}` +
      `${seamTicks.has(tick) ? `   <- ${DAY_PHASE_NAMES[clock.phase]} begins` : ''}`,
  );
}

// --- 4: the acceptance numbers ---------------------------------------------

heading('Acceptance');

let worstChannel = 0;
let worstChannelAt = 0;
let worstIntensity = 0;
let sunUpTicks = 0;
let heldFrames = 0;
for (let tick = 1; tick <= CYCLE_TICKS; tick++) {
  const before = skyAt(worldClockAt(tick - 1).hours);
  const now = skyAt(worldClockAt(tick).hours);
  if (worldClockAt(tick).sunUp) sunUpTicks++;

  for (const key of ['skyColor', 'lightColor', 'ambientColor'] as const) {
    const step = Math.max(
      Math.abs(now[key].r - before[key].r),
      Math.abs(now[key].g - before[key].g),
      Math.abs(now[key].b - before[key].b),
    );
    if (step > worstChannel) {
      worstChannel = step;
      worstChannelAt = tick;
    }
  }
  worstIntensity = Math.max(
    worstIntensity,
    Math.abs(now.lightIntensity - before.lightIntensity),
    Math.abs(now.ambientIntensity - before.ambientIntensity),
  );
  if (now.skyColor.r === before.skyColor.r && now.skyColor.g === before.skyColor.g) heldFrames++;
}

const RETRO_STEP = 1 / 12;
const worstClock = worldClockAt(worstChannelAt);
console.log(
  `  largest colour step between frames   ${worstChannel.toFixed(6)}` +
    `  (${(worstChannel / RETRO_STEP).toFixed(4)} of a retro band, at ` +
    `${formatWorldHours(worstClock.hours)} in ${DAY_PHASE_NAMES[worstClock.phase]})`,
);
console.log(`  largest intensity step between frames  ${worstIntensity.toFixed(6)}`);
console.log(
  `  frames the sky colour held still     ${String(heldFrames)} of ${String(CYCLE_TICKS)}` +
    `  (the ramp's 21:00 and 00:00 keys are the same colour, so deep night is` +
    ` genuinely one sky)`,
);
console.log('');
console.log(
  `  Day phase    ${mmss(600)}      sun above the horizon  ${mmss(sunUpTicks / SERVER_TICK_RATE)}`,
);
console.log(
  `  Night phase  ${mmss(120)}      sun below the horizon  ` +
    `${mmss((CYCLE_TICKS - sunUpTicks) / SERVER_TICK_RATE)}`,
);
console.log(
  `  ratio        ${(600 / 120).toFixed(1)}:1        ` +
    `                       ${(sunUpTicks / (CYCLE_TICKS - sunUpTicks)).toFixed(2)}:1`,
);
console.log('');
console.log('  The two columns are different questions: the named phases are the flat');
console.log('  parts, and dawn and dusk divide their 45s each between light and dark.');
console.log('');
