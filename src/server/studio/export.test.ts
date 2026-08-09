/**
 * Staging a job into the repository (spec 109).
 *
 * The property worth most here is the negative one: that an export will not
 * write a document it would have to invent a number for. `durationMs > 0` is the
 * only bound a schema can put on a clip length, so a made-up duration validates
 * cleanly, CI passes, and every action timing scaled against it is quietly
 * wrong. An absent file gets fixed; a plausible wrong one does not get noticed.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import skeletonDoc from '../../../assets/units/biped.skeleton.json' with { type: 'json' };
import type { Clip, StateMachine } from '../../units/index.js';
import { exportJob } from './export.js';
import { createJob } from './jobs.js';
import type { Job } from './types.js';

let dir: string;

/** A finished job with real files on disk, since export copies them. */
function finishedJob(patch: Partial<Job> = {}): Job {
  const base = createJob(
    {
      id: 'job-1',
      unitId: 'grunt',
      skeletonId: 'biped',
      establishesRigFamily: true,
      referenceImageSha256: 'a'.repeat(64),
      params: {
        modelVersion: 'P1-20260311',
        faceLimit: 8000,
        texture: true,
        pbr: false,
    orientation: 'default',
        clipIntents: ['idle', 'run'],
        outFormat: 'glb',
      },
    },
    0,
  );

  const meshPath = join(dir, 'mesh.glb');
  const riggedPath = join(dir, 'rigged.glb');
  const clipPath = join(dir, 'clips-0.glb');
  for (const path of [meshPath, riggedPath, clipPath]) writeFileSync(path, 'glb');

  return {
    ...base,
    status: 'succeeded',
    creditsSpent: 40,
    steps: base.steps.map((step) =>
      step.stage === 'download' ? step : { ...step, status: 'done', taskId: `task-${step.stage}` },
    ),
    artifacts: { meshGlb: meshPath, riggedGlb: riggedPath, clipGlbs: { idle: clipPath, run: clipPath } },
    ...patch,
  };
}

const CLIPS: readonly Clip[] = [
  { id: 'idle', source: 'clips/clips-0.glb', durationMs: 2000, loop: true, events: [] },
  { id: 'run', source: 'clips/clips-0.glb', durationMs: 800, loop: true, events: [] },
];

const MACHINE: StateMachine = {
  parameters: [{ name: 'speed', type: 'float' }],
  states: [
    { id: 'idle', clipRef: 'idle', loop: true, timeScale: 1, blendInMs: 120, category: 'loop' },
    { id: 'run', clipRef: 'run', loop: true, timeScale: 1, blendInMs: 120, category: 'loop' },
  ],
  blendTrees: [],
  transitions: [{ from: 'idle', to: 'run', condition: 'speed > 5', durationMs: 120, interruptible: true }],
  actionTimings: [],
};

function run(options: { clips?: readonly Clip[]; stateMachine?: StateMachine; job?: Job } = {}) {
  return exportJob({
    job: options.job ?? finishedJob(),
    unitsDir: join(dir, 'units'),
    skeletonRef: 'biped.skeleton.json',
    skeletonDoc,
    clipLibId: 'biped.core',
    clips: options.clips,
    stateMachine: options.stateMachine,
    maxTimeScale: 2,
    nowIso: '2026-08-09T09:00:00Z',
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-export-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('staging the binaries', () => {
  it('copies the rigged mesh in under the unit id', () => {
    const result = run();
    expect(result.written).toContain(join('grunt', 'grunt.glb'));
    expect(existsSync(join(dir, 'units', 'grunt', 'grunt.glb'))).toBe(true);
  });

  it('keeps the un-rigged mesh alongside, for comparing a rig that came back wrong', () => {
    expect(run().written).toContain(join('grunt', 'grunt.unrigged.glb'));
  });

  it('copies rather than moves, so an export cannot consume what was paid for', () => {
    const job = finishedJob();
    run({ job });
    expect(existsSync(job.artifacts.riggedGlb ?? '')).toBe(true);
  });

  it('copies the clip files', () => {
    expect(run().written.some((path) => path.includes('clips'))).toBe(true);
  });

  it('refuses a job with no mesh on disk', () => {
    const empty = finishedJob({ artifacts: { meshGlb: null, riggedGlb: null, clipGlbs: {} } });
    const result = run({ job: empty });
    expect(result.ok).toBe(false);
    expect(result.pending.join(' ')).toContain('no mesh');
  });
});

describe('what it will not invent', () => {
  it('writes no cliplib when it has not been given durations', () => {
    // The whole point. A guessed duration would validate and then silently
    // rescale every action timing measured against it.
    const result = run();
    expect(result.written.some((path) => path.endsWith('.cliplib.json'))).toBe(false);
    expect(result.pending.join(' ')).toContain('duration');
  });

  it('says why, in words that name the consequence', () => {
    expect(run().pending.join(' ')).toContain('rescale');
  });

  it('writes no unitdef without a state machine', () => {
    const result = run({ clips: CLIPS });
    expect(result.written.some((path) => path.endsWith('.unitdef.json'))).toBe(false);
    expect(result.pending.join(' ')).toContain('state machine');
  });

  it('records an unmeasured import scale as 1 rather than a plausible guess', () => {
    // The real factor is around thirty. A number invented here would put a unit
    // in the world at the wrong size and look deliberate while doing it.
    run({ clips: CLIPS, stateMachine: MACHINE });
    const text = readFileSync(join(dir, 'units', 'grunt', 'grunt.unitdef.json'), 'utf8');
    expect((JSON.parse(text) as { import: { scale: number } }).import.scale).toBe(1);
  });
});

describe('the documents it does write', () => {
  it('writes a cliplib once it has real durations', () => {
    const result = run({ clips: CLIPS });
    expect(result.written).toContain(join('grunt', 'biped.core.cliplib.json'));
    const doc = JSON.parse(readFileSync(join(dir, 'units', 'grunt', 'biped.core.cliplib.json'), 'utf8')) as {
      clips: Clip[];
    };
    expect(doc.clips.map((clip) => clip.durationMs)).toEqual([2000, 800]);
  });

  it('writes a unitdef whose provenance is what was actually charged', () => {
    run({ clips: CLIPS, stateMachine: MACHINE });
    const doc = JSON.parse(readFileSync(join(dir, 'units', 'grunt', 'grunt.unitdef.json'), 'utf8')) as {
      provenance: { creditsSpent: number; referenceImageSha256: string; tripoTaskIds: { retarget: string[] } };
    };
    expect(doc.provenance.creditsSpent).toBe(40);
    expect(doc.provenance.referenceImageSha256).toBe('a'.repeat(64));
    expect(doc.provenance.tripoTaskIds.retarget).toEqual(['task-retarget']);
  });

  it('leaves the retarget task list empty for a unit reusing a rig family', () => {
    // The shared-skeleton rule, visible in a committed file: a populated array
    // on a second unit of a family is the bug, and it shows up in a diff.
    const reusing = finishedJob({ establishesRigFamily: false });
    run({ job: reusing, clips: CLIPS, stateMachine: MACHINE });
    const doc = JSON.parse(readFileSync(join(dir, 'units', 'grunt', 'grunt.unitdef.json'), 'utf8')) as {
      provenance: { tripoTaskIds: { retarget: string[] } };
    };
    expect(doc.provenance.tripoTaskIds.retarget).toEqual([]);
  });
});

describe('validation', () => {
  it('reports the provisional skeleton rather than claiming a clean export', () => {
    // The shipped biped skeleton has no measured bind pose yet, and a unit may
    // not ship against one. Export says so instead of writing a green tick.
    const result = run({ clips: CLIPS, stateMachine: MACHINE });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('bundle.skeleton.provisional');
  });

  it('surfaces a broken state machine as errors rather than writing it', () => {
    const broken: StateMachine = {
      ...MACHINE,
      states: [{ id: 'idle', clipRef: 'nope', loop: true, timeScale: 1, blendInMs: 0, category: 'loop' }],
      transitions: [],
    };
    const result = run({ clips: CLIPS, stateMachine: broken });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('bundle.clipRef.unknown');
  });
});
