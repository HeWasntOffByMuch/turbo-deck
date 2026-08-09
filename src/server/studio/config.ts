/**
 * Studio configuration, read from the process environment (spec 108).
 *
 * The key lives here and nowhere else. It is never bundled -- this subtree is
 * Node-only and `src/server/index.ts` is the only thing that imports it -- never
 * returned in a response, and never logged. {@link describeConfig} exists so the
 * boot line can say what is configured without saying what the key is.
 *
 * Every ceiling and price is configurable, because a third party's prices are
 * not ours to hardcode and a budget is not ours to choose. What is *not*
 * configurable is whether the ceilings are checked.
 */

import { DEFAULT_MAX_TIME_SCALE } from '../../units/timing.js';
import type { Ceilings } from './ledger.js';
import { DEFAULT_MIN_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS } from './pacing.js';
import { DEFAULT_PRICES, type PriceList } from './pricing.js';
import { DEFAULT_BASE_URL } from './tripo.js';

export interface StudioConfig {
  /** Null when no key is configured: the routes mount and refuse to spend. */
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly modelVersion: string;
  /**
   * The **rig** model version, which is a different date-stamped id from the
   * generation one. The server's own default is rejected, so it has to be sent.
   */
  readonly rigModelVersion: string;
  /** The bone naming contract the rig is asked for. `mixamo` for a biped. */
  readonly rigSpec: string;
  /** How a generated mesh is oriented. See `GenerationParams.orientation`. */
  readonly orientation: 'default' | 'align_image';
  readonly defaultFaceLimit: number;
  readonly ceilings: Ceilings;
  readonly prices: PriceList;
  readonly pollIntervalMs: number;
  readonly minRequestIntervalMs: number;
  /** Where jobs.json, ledger.jsonl and downloaded assets live. */
  readonly dataDir: string;
  /** Optional completion callback. Polling is the default and always runs. */
  readonly webhookUrl: string | undefined;
  readonly maxTimeScale: number;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * A ceiling, where an explicit `none` is the only way to switch one off.
 *
 * An unset variable falls back to the default rather than to "unlimited",
 * because the failure mode of a mistyped variable name must not be an
 * uncapped spend.
 */
function ceiling(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw.trim().toLowerCase() === 'none') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Sized off what a unit actually costs, now that that is known.
 *
 * A biped with three clips is 50 + 0 + 25 + 3x25 = 150 at the measured prices,
 * so the old per-run 100 stopped a perfectly ordinary job two calls in. A limit
 * that cannot let one normal unit through is not protecting anything -- it just
 * leaves half-finished paid work and something to go and fix.
 *
 * 250 covers one unit with room for a few more clips; 1000 is about six units in
 * a day. Both are the runaway guard they were meant to be rather than a speed
 * bump, and both are still overridable, including to `none`.
 */
export const DEFAULT_PER_RUN_CEILING = 250;
export const DEFAULT_PER_DAY_CEILING = 1000;

export function loadStudioConfig(env: NodeJS.ProcessEnv, repoRoot: string): StudioConfig {
  const key = env['TRIPO_API_KEY']?.trim();
  return {
    apiKey: key === undefined || key === '' ? null : key,
    baseUrl: env['TRIPO_BASE_URL']?.trim() || DEFAULT_BASE_URL,
    modelVersion: env['TRIPO_MODEL_VERSION']?.trim() || 'P1-20260311',
    rigModelVersion: env['TRIPO_RIG_MODEL_VERSION']?.trim() || 'v2.5-20260210',
    rigSpec: env['TRIPO_RIG_SPEC']?.trim() || 'mixamo',
    // `default` preserves what this pipeline got implicitly before the field was
    // sent at all, so turning it on changes nothing until somebody decides it
    // should. See `GenerationParams.orientation` for which way each one fails.
    orientation: env['TRIPO_ORIENTATION']?.trim() === 'align_image' ? 'align_image' : 'default',
    defaultFaceLimit: num(env['STUDIO_FACE_LIMIT'], 8000),
    ceilings: {
      perRun: ceiling(env['STUDIO_CEILING_PER_RUN'], DEFAULT_PER_RUN_CEILING),
      perDay: ceiling(env['STUDIO_CEILING_PER_DAY'], DEFAULT_PER_DAY_CEILING),
    },
    prices: {
      imageToModel: num(env['STUDIO_PRICE_IMAGE_TO_MODEL'], DEFAULT_PRICES.imageToModel),
      rigCheck: num(env['STUDIO_PRICE_RIG_CHECK'], DEFAULT_PRICES.rigCheck),
      rig: num(env['STUDIO_PRICE_RIG'], DEFAULT_PRICES.rig),
      retargetPerCall: num(env['STUDIO_PRICE_RETARGET'], DEFAULT_PRICES.retargetPerCall),
    },
    pollIntervalMs: num(env['STUDIO_POLL_INTERVAL_MS'], DEFAULT_POLL_INTERVAL_MS),
    minRequestIntervalMs: num(env['STUDIO_MIN_REQUEST_INTERVAL_MS'], DEFAULT_MIN_INTERVAL_MS),
    dataDir: env['STUDIO_DATA_DIR']?.trim() || `${repoRoot}/.studio`,
    webhookUrl: env['STUDIO_WEBHOOK_URL']?.trim() || undefined,
    maxTimeScale: num(env['STUDIO_MAX_TIME_SCALE'], DEFAULT_MAX_TIME_SCALE),
  };
}

/** Everything about the configuration except the one thing that is a secret. */
export function describeConfig(config: StudioConfig): string {
  const perRun = config.ceilings.perRun === null ? 'none' : String(config.ceilings.perRun);
  const perDay = config.ceilings.perDay === null ? 'none' : String(config.ceilings.perDay);
  return [
    `key ${config.apiKey === null ? 'NOT SET (generation disabled)' : 'set'}`,
    `model ${config.modelVersion}`,
    `rig ${config.rigModelVersion}/${config.rigSpec}`,
    `orientation ${config.orientation}`,
    `ceilings run=${perRun} day=${perDay}`,
    `data ${config.dataDir}`,
    config.webhookUrl === undefined ? 'polling' : 'polling + webhook',
  ].join(', ');
}
