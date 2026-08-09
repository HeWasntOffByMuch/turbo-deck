/**
 * What a generation will cost, before it is confirmed (spec 108).
 *
 * Every number here is an **estimate against a published price list**, and the
 * price list is configuration rather than a constant, because a third party's
 * prices are not ours to hardcode. What the pipeline records afterwards is the
 * `credits_consumed` the API actually reported -- the projection is what the
 * confirmation dialog shows and what the ceilings are checked against, never
 * what gets written to the ledger.
 *
 * The two must not be conflated. A projection that quietly became the recorded
 * spend would make the credit total a restatement of our own guess instead of a
 * record of what was billed.
 */

import type { GenerationParams, Job, Stage } from './types.js';

/** Credits per call, by stage. rig-check is free and is priced as such. */
export interface PriceList {
  readonly imageToModel: number;
  readonly rigCheck: number;
  readonly rig: number;
  /** Per retarget call, and a call is one clip. */
  readonly retargetPerCall: number;
}

/**
 * Clips per retarget call.
 *
 * **One.** This was written as five, from the v2-era batching in the brief, and
 * the live API rejects a multi-preset batch outright. The correction is a cost
 * one rather than a shape one: five clips are five calls, so the projection this
 * feeds -- and the ceiling checked against it -- were understating a clip set by
 * a factor of five. A number that is wrong in the cheap direction is exactly the
 * kind that makes a spending limit decorative.
 */
export const RETARGET_BATCH_SIZE = 1;

/**
 * Defaults, overridable from the environment.
 *
 * The first two are **measured**, off a real run's `credits_consumed`: an
 * image-to-model at the default face limit charged 50 and the auto-rig charged
 * 25. They were placeholders at 20 and 10, which is how a job that was quoted
 * 60 got two thirds of the way through a 100 ceiling on its first two calls --
 * a projection that reads low does not just mislead, it makes the ceiling fire
 * in the middle of a job instead of before it.
 *
 * `retargetPerCall` is still unmeasured and is pitched at the rig's price, which
 * is the nearest thing to evidence there is. It will be a real number after the
 * first retarget, and it is deliberately not lower: a projection that flatters
 * is the one failure mode a cost estimate must never have.
 */
export const DEFAULT_PRICES: PriceList = {
  imageToModel: 50,
  rigCheck: 0,
  rig: 25,
  retargetPerCall: 25,
};

export interface PlannedStep {
  readonly stage: Stage;
  /** How many calls this stage will make. More than one only for retarget. */
  readonly calls: number;
  readonly credits: number;
}

export interface CostProjection {
  readonly steps: readonly PlannedStep[];
  readonly totalCredits: number;
}

export interface PlanInput {
  readonly params: GenerationParams;
  /** False for a unit reusing an established rig family: no retarget at all. */
  readonly establishesRigFamily: boolean;
  readonly prices: PriceList;
}

export function retargetCalls(clipCount: number): number {
  return clipCount <= 0 ? 0 : Math.ceil(clipCount / RETARGET_BATCH_SIZE);
}

/**
 * The whole plan, priced.
 *
 * `download` is listed with zero credits rather than omitted: the pipeline has a
 * download stage, and a projection whose steps do not match the steps the
 * progress UI shows would have somebody counting them and finding four.
 */
export function projectCost(input: PlanInput): CostProjection {
  const { params, establishesRigFamily, prices } = input;
  const clipCount = new Set(params.clipIntents).size;
  const calls = establishesRigFamily ? retargetCalls(clipCount) : 0;

  const steps: PlannedStep[] = [
    { stage: 'imageToModel', calls: 1, credits: prices.imageToModel },
    { stage: 'rigCheck', calls: 1, credits: prices.rigCheck },
    { stage: 'rig', calls: 1, credits: prices.rig },
    { stage: 'retarget', calls, credits: calls * prices.retargetPerCall },
    { stage: 'download', calls: 0, credits: 0 },
  ];

  return { steps, totalCredits: steps.reduce((sum, step) => sum + step.credits, 0) };
}

/**
 * What is left to buy on a job that has already spent something.
 *
 * The price a retry is confirmed against, and it is not the price of the job.
 * A retarget that failed on its third of five clips has a mesh and a rig on
 * disk and two clips downloaded: quoting the full 175 would be asking somebody
 * to approve a charge four times what carrying on actually costs, and a
 * confirmation dialog that overstates gets dismissed unread just as fast as one
 * that understates.
 *
 * A stage that is `done` or `skipped` costs nothing. Everything else is priced
 * in full -- including the stage that failed, because it will be attempted
 * again. The retarget is priced per clip *not already on disk*, which is the
 * same arithmetic `runRetarget` does when it decides what to skip, so the quote
 * and the spend cannot disagree.
 */
export function projectRemaining(job: Job, prices: PriceList): CostProjection {
  const full = projectCost({
    params: job.params,
    establishesRigFamily: job.establishesRigFamily,
    prices,
  });
  const clipsLeft = job.establishesRigFamily
    ? [...new Set(job.params.clipIntents)].filter((intent) => job.artifacts.clipGlbs[intent] === undefined).length
    : 0;

  const steps = full.steps.map((step): PlannedStep => {
    const record = job.steps.find((entry) => entry.stage === step.stage);
    if (record?.status === 'done' || record?.status === 'skipped') return { ...step, calls: 0, credits: 0 };
    if (step.stage === 'retarget') {
      const calls = retargetCalls(clipsLeft);
      return { stage: 'retarget', calls, credits: calls * prices.retargetPerCall };
    }
    return step;
  });

  return { steps, totalCredits: steps.reduce((sum, step) => sum + step.credits, 0) };
}
