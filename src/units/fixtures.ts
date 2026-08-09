/**
 * Valid documents for the tests to break (spec 107).
 *
 * Every test in this directory starts from one of these and mutates one field,
 * so a failure names the rule that broke rather than a wall of unrelated schema
 * errors. Written as builders taking a patch, because a fixture that tests share
 * by reference is a fixture one test can poison for the next.
 *
 * Kept out of a `.test.ts` file so the runner and any future consumer can use
 * the same known-good documents rather than inventing their own.
 */

import type { ClipLib, Skeleton, UnitDef } from './types.js';

/**
 * A minimal but real biped: one root, a spine, a symmetric pair of arms and
 * legs. Fifteen bones, which is exactly the shipped skeleton's budget floor --
 * so a test that removes one is testing the budget rule and not an accident.
 */
export function skeletonFixture(patch: Partial<Skeleton> = {}): Skeleton {
  return {
    formatVersion: 1,
    id: 'biped.test',
    naming: 'mixamo',
    upAxis: '+Y',
    forwardAxis: '+X',
    canonicalHeight: 55.65,
    boneBudget: { min: 15, max: 30 },
    bones: [
      { name: 'mixamorig:Hips', parent: null },
      { name: 'mixamorig:Spine', parent: 'mixamorig:Hips' },
      { name: 'mixamorig:Spine1', parent: 'mixamorig:Spine' },
      { name: 'mixamorig:Neck', parent: 'mixamorig:Spine1' },
      { name: 'mixamorig:Head', parent: 'mixamorig:Neck' },
      { name: 'mixamorig:LeftArm', parent: 'mixamorig:Spine1' },
      { name: 'mixamorig:LeftForeArm', parent: 'mixamorig:LeftArm' },
      { name: 'mixamorig:LeftHand', parent: 'mixamorig:LeftForeArm' },
      { name: 'mixamorig:RightArm', parent: 'mixamorig:Spine1' },
      { name: 'mixamorig:RightForeArm', parent: 'mixamorig:RightArm' },
      { name: 'mixamorig:RightHand', parent: 'mixamorig:RightForeArm' },
      { name: 'mixamorig:LeftUpLeg', parent: 'mixamorig:Hips' },
      { name: 'mixamorig:LeftLeg', parent: 'mixamorig:LeftUpLeg' },
      { name: 'mixamorig:RightUpLeg', parent: 'mixamorig:Hips' },
      { name: 'mixamorig:RightLeg', parent: 'mixamorig:RightUpLeg' },
    ],
    sockets: [{ id: 'weapon.main', bone: 'mixamorig:RightHand' }],
    bindPose: {
      source: 'clips/bind.glb',
      bones: [
        { name: 'mixamorig:Hips', translation: [0, 30, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:Spine', translation: [0, 6, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:Spine1', translation: [0, 6, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:Neck', translation: [0, 6, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:Head', translation: [0, 4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:LeftArm', translation: [0, 2, -5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:LeftForeArm', translation: [0, -8, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:LeftHand', translation: [0, -8, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:RightArm', translation: [0, 2, 5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:RightForeArm', translation: [0, -8, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:RightHand', translation: [0, -8, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:LeftUpLeg', translation: [0, -2, -4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:LeftLeg', translation: [0, -14, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:RightUpLeg', translation: [0, -2, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'mixamorig:RightLeg', translation: [0, -14, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      ],
    },
    ...patch,
  };
}

/** Idle, a walk/run pair for a blend, and a swing carrying an impact marker. */
export function clipLibFixture(patch: Partial<ClipLib> = {}): ClipLib {
  return {
    formatVersion: 1,
    id: 'biped.core',
    skeletonRef: 'biped.skeleton.json',
    clips: [
      { id: 'idle', source: 'clips/idle.glb', durationMs: 2000, loop: true, events: [] },
      {
        id: 'walk',
        source: 'clips/walk.glb',
        durationMs: 1000,
        loop: true,
        events: [
          { name: 'footstep.l', normalizedTime: 0.1 },
          { name: 'footstep.r', normalizedTime: 0.6 },
        ],
      },
      { id: 'run', source: 'clips/run.glb', durationMs: 700, loop: true, events: [] },
      {
        id: 'swing',
        source: 'clips/swing.glb',
        durationMs: 800,
        loop: false,
        events: [
          { name: 'swing.start', normalizedTime: 0 },
          { name: 'swing.impact', normalizedTime: 0.55 },
        ],
      },
      { id: 'death', source: 'clips/death.glb', durationMs: 1200, loop: false, events: [] },
    ],
    ...patch,
  };
}

/**
 * A unit wired the way a real one would be: a speed-blended locomotion state, a
 * locking swing whose impact lands in its active window, and a terminal death.
 *
 * The swing's numbers are chosen so the stretch is comfortable -- 800ms of clip
 * over a 700ms action is a 1.14x rate -- so a test that pushes it over the limit
 * is moving one number and not rescuing a fixture that was already marginal.
 */
export function unitDefFixture(patch: Partial<UnitDef> = {}): UnitDef {
  return {
    formatVersion: 1,
    id: 'grunt',
    meshRef: 'units/grunt.glb',
    skeletonRef: 'biped.skeleton.json',
    clipLibRef: 'biped.core.cliplib.json',
    provenance: {
      tripoTaskIds: {
        imageToModel: 'task-i2m-0001',
        rigCheck: 'task-rigcheck-0001',
        rig: 'task-rig-0001',
        retarget: ['task-retarget-0001'],
      },
      modelVersion: 'P1-20260311',
      faceLimit: 8000,
      referenceImageSha256: 'a'.repeat(64),
      creditsSpent: 42,
      generatedAt: '2026-08-09T12:00:00Z',
    },
    import: { normals: 'flat', targetTris: 8000, scale: 34.2, upAxis: '+Y' },
    maxTimeScale: 2,
    stateMachine: {
      parameters: [
        { name: 'speed', type: 'float' },
        { name: 'grounded', type: 'bool' },
        { name: 'attack', type: 'trigger' },
      ],
      states: [
        { id: 'idle', clipRef: 'idle', loop: true, timeScale: 1, blendInMs: 120, category: 'loop' },
        { id: 'locomotion', clipRef: 'move', loop: true, timeScale: 1, blendInMs: 120, category: 'loop' },
        { id: 'swing', clipRef: 'swing', loop: false, timeScale: 1, blendInMs: 60, category: 'locking' },
        { id: 'death', clipRef: 'death', loop: false, timeScale: 1, blendInMs: 80, category: 'terminal' },
      ],
      blendTrees: [
        {
          id: 'move',
          parameter: 'speed',
          thresholds: [
            { value: 0, clipRef: 'idle' },
            { value: 34, clipRef: 'walk' },
            { value: 150, clipRef: 'run' },
          ],
        },
      ],
      transitions: [
        { from: 'idle', to: 'locomotion', condition: 'speed > 5', durationMs: 120, interruptible: true },
        { from: 'locomotion', to: 'idle', condition: 'speed < 5', durationMs: 120, interruptible: true },
        { from: '*', to: 'swing', condition: 'attack', durationMs: 60, interruptible: false },
        { from: 'swing', to: 'idle', condition: 'exit', durationMs: 100, interruptible: false },
        { from: '*', to: 'death', condition: '!grounded', durationMs: 80, interruptible: true },
      ],
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 300,
          activeMs: 120,
          recoveryMs: 280,
          clipRef: 'swing',
          eventMap: { windup: 'swing.start', active: 'swing.impact' },
        },
      ],
    },
    ...patch,
  };
}
