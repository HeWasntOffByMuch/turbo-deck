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

/** Conservative enough that a typo in a face limit cannot empty an account. */
export const DEFAULT_PER_RUN_CEILING = 100;
export const DEFAULT_PER_DAY_CEILING = 500;

export function loadStudioConfig(env: NodeJS.ProcessEnv, repoRoot: string): StudioConfig {
  const key = env['TRIPO_API_KEY']?.trim();
  return {
    apiKey: key === undefined || key === '' ? null : key,
    baseUrl: env['TRIPO_BASE_URL']?.trim() || DEFAULT_BASE_URL,
    modelVersion: env['TRIPO_MODEL_VERSION']?.trim() || 'P1-20260311',
    rigModelVersion: env['TRIPO_RIG_MODEL_VERSION']?.trim() || 'v2.5-20260210',
    rigSpec: env['TRIPO_RIG_SPEC']?.trim() || 'mixamo',
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
    `ceilings run=${perRun} day=${perDay}`,
    `data ${config.dataDir}`,
    config.webhookUrl === undefined ? 'polling' : 'polling + webhook',
  ].join(', ');
}
