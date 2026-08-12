import { describe, expect, it } from 'vitest';
import { clipLibFixture, skeletonFixture, unitDefFixture } from './fixtures.js';
import type { Issue } from './issues.js';
import { validateClipLib, validateSkeleton, validateUnitBundle, validateUnitDef } from './validate.js';
import type { Clip, ClipLib, Skeleton, State, StateMachine, UnitDef } from './types.js';

/** Codes only: tests assert on the rule that fired, never on its wording. */
function codes(issues: readonly Issue[]): string[] {
  return issues.map((issue) => issue.code);
}

function errorCodes(issues: readonly Issue[]): string[] {
  return issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
}

/** A unitdef with its state machine patched, keeping everything else valid. */
function withMachine(patch: Partial<StateMachine>): UnitDef {
  const base = unitDefFixture();
  return { ...base, stateMachine: { ...base.stateMachine, ...patch } };
}

function bundleOf(unit: UnitDef, clipLib: ClipLib = clipLibFixture(), skeleton: Skeleton = skeletonFixture()) {
  return validateUnitBundle({ unit, skeleton, clipLib });
}

// --- skeleton ----------------------------------------------------------------

describe('validateSkeleton', () => {
  it('accepts the fixture with nothing to say', () => {
    const result = validateSkeleton(skeletonFixture());
    expect(result.issues).toEqual([]);
    expect(result.value).not.toBeNull();
  });

  it('hands back no value when there is an error', () => {
    // A caller that checks `value` must not be able to proceed on a broken
    // document by accident.
    const result = validateSkeleton(skeletonFixture({ sockets: [{ id: 'weapon.main', bone: 'nope' }] }));
    expect(result.value).toBeNull();
  });

  it('hands back a value when the only issues are warnings', () => {
    const result = validateSkeleton(skeletonFixture({ bindPose: null }));
    expect(codes(result.issues)).toEqual(['skeleton.provisional']);
    expect(result.value).not.toBeNull();
  });

  describe('the naming field against the bones (spec 120)', () => {
    /** A tripo-named biped: `Hip` not `Hips`, `L_Hand` not `LeftHand`. */
    const tripoBones = [
      { name: 'Root', parent: null },
      { name: 'Hip', parent: 'Root' },
      { name: 'Spine01', parent: 'Hip' },
      { name: 'Spine02', parent: 'Spine01' },
      { name: 'Neck', parent: 'Spine02' },
      { name: 'Head', parent: 'Neck' },
      { name: 'L_Upperarm', parent: 'Spine02' },
      { name: 'L_Forearm', parent: 'L_Upperarm' },
      { name: 'L_Hand', parent: 'L_Forearm' },
      { name: 'R_Upperarm', parent: 'Spine02' },
      { name: 'R_Forearm', parent: 'R_Upperarm' },
      { name: 'R_Hand', parent: 'R_Forearm' },
      { name: 'L_Thigh', parent: 'Hip' },
      { name: 'L_Calf', parent: 'L_Thigh' },
      { name: 'L_Foot', parent: 'L_Calf' },
      { name: 'R_Thigh', parent: 'Hip' },
      { name: 'R_Calf', parent: 'R_Thigh' },
      { name: 'R_Foot', parent: 'R_Calf' },
    ];

    it('refuses a document that claims a contract its bones do not follow', () => {
      // The exact shape `biped.skeleton.json` shipped in: tripo bones under a
      // mixamo claim. It validated clean, and every lookup that trusted the
      // field then found nothing -- sockets, facing, bind pose -- each failing
      // silently and separately.
      const result = validateSkeleton(skeletonFixture({ naming: 'mixamo', bones: tripoBones, bindPose: null }));
      expect(codes(result.issues)).toContain('skeleton.naming.mismatch');
      expect(result.value).toBeNull();
    });

    it('accepts the same bones once the document says what they are', () => {
      const result = validateSkeleton(skeletonFixture({ naming: 'tripo', bones: tripoBones, bindPose: null }));
      expect(codes(result.issues)).not.toContain('skeleton.naming.mismatch');
    });

    it('leaves a rig on neither contract alone, whichever it claims', () => {
      // Undetectable is not a disagreement. A rig off both vocabularies still
      // has to record the spec it was built for, and the warning for that is
      // raised where the document is written, not here.
      const odd = [
        { name: 'joint0', parent: null },
        { name: 'joint1', parent: 'joint0' },
        ...Array.from({ length: 14 }, (_, i) => ({ name: `joint${i + 2}`, parent: 'joint1' })),
      ];
      const result = validateSkeleton(skeletonFixture({ naming: 'mixamo', bones: odd, bindPose: null }));
      expect(codes(result.issues)).not.toContain('skeleton.naming.mismatch');
    });

    it('reads L_/R_ as a sided pair, so symmetry is checked on a tripo rig too', () => {
      // The same class of silence: `mirrorName` only knew Left/Right, so on a
      // generated rig it returned null for every bone and the symmetry rule
      // passed by never running.
      const lopsided = tripoBones.filter((bone) => bone.name !== 'R_Hand');
      const result = validateSkeleton(skeletonFixture({ naming: 'tripo', bones: lopsided, bindPose: null }));
      expect(codes(result.issues)).toContain('skeleton.symmetry');
    });
  });

  it('requires exactly one root', () => {
    const none = skeletonFixture({
      bones: skeletonFixture().bones.map((bone, i) => (i === 0 ? { ...bone, parent: 'mixamorig:Head' } : bone)),
      bindPose: null,
    });
    expect(errorCodes(validateSkeleton(none).issues)).toContain('skeleton.root.missing');

    const two = skeletonFixture({
      bones: skeletonFixture().bones.map((bone, i) => (i === 1 ? { ...bone, parent: null } : bone)),
      bindPose: null,
    });
    expect(errorCodes(validateSkeleton(two).issues)).toContain('skeleton.root.multiple');
  });

  it('requires a parent to appear earlier in the list', () => {
    // Parent-before-child is what makes the array order canonical: a consumer
    // can build the hierarchy in one forward pass with no second lookup.
    const bones = [...skeletonFixture().bones];
    const spine = bones[1];
    const spine1 = bones[2];
    if (!spine || !spine1) throw new Error('fixture changed');
    bones[1] = spine1;
    bones[2] = spine;
    expect(errorCodes(validateSkeleton(skeletonFixture({ bones, bindPose: null })).issues)).toContain(
      'skeleton.parent.forward',
    );
  });

  it('catches a cycle, because a cycle cannot survive parent-before-child', () => {
    const bones = skeletonFixture().bones.map((bone) =>
      bone.name === 'mixamorig:Hips' ? { ...bone, parent: 'mixamorig:Spine' } : bone,
    );
    expect(errorCodes(validateSkeleton(skeletonFixture({ bones, bindPose: null })).issues)).toContain(
      'skeleton.parent.forward',
    );
  });

  it('rejects an unknown parent', () => {
    const bones = skeletonFixture().bones.map((bone) =>
      bone.name === 'mixamorig:Head' ? { ...bone, parent: 'mixamorig:Ghost' } : bone,
    );
    expect(errorCodes(validateSkeleton(skeletonFixture({ bones, bindPose: null })).issues)).toContain(
      'skeleton.parent.forward',
    );
  });

  it('rejects duplicate bone names', () => {
    const bones = skeletonFixture().bones.map((bone, i) =>
      i === 4 ? { ...bone, name: 'mixamorig:Neck' } : bone,
    );
    expect(errorCodes(validateSkeleton(skeletonFixture({ bones, bindPose: null })).issues)).toContain(
      'skeleton.name.duplicate',
    );
  });

  it('enforces the bone budget in both directions', () => {
    const base = skeletonFixture();
    const tooFew = skeletonFixture({ bones: base.bones.slice(0, 14), bindPose: null });
    expect(errorCodes(validateSkeleton(tooFew).issues)).toContain('skeleton.boneBudget');

    const padded = [...base.bones];
    for (let i = 0; i < 20; i += 1) {
      padded.push({ name: `mixamorig:Filler${i}`, parent: 'mixamorig:Hips' });
    }
    expect(errorCodes(validateSkeleton(skeletonFixture({ bones: padded, bindPose: null })).issues)).toContain(
      'skeleton.boneBudget',
    );
  });

  it('rejects an inverted budget', () => {
    expect(
      errorCodes(validateSkeleton(skeletonFixture({ boneBudget: { min: 30, max: 15 } })).issues),
    ).toContain('skeleton.boneBudget.inverted');
  });

  it('warns about finger joints rather than failing on them', () => {
    // Wasteful, not broken: a hand is a few pixels at this camera.
    const bones = [
      ...skeletonFixture().bones,
      { name: 'mixamorig:LeftHandIndex1', parent: 'mixamorig:LeftHand' },
      { name: 'mixamorig:RightHandIndex1', parent: 'mixamorig:RightHand' },
    ];
    const result = validateSkeleton(skeletonFixture({ bones, bindPose: null }));
    expect(errorCodes(result.issues)).not.toContain('skeleton.fingers');
    expect(codes(result.issues).filter((code) => code === 'skeleton.fingers')).toHaveLength(2);
  });

  it('requires every sided bone to have its counterpart', () => {
    const bones = skeletonFixture().bones.filter((bone) => bone.name !== 'mixamorig:RightHand');
    const relinked = bones.map((bone) =>
      bone.parent === 'mixamorig:RightHand' ? { ...bone, parent: 'mixamorig:RightForeArm' } : bone,
    );
    const result = validateSkeleton(
      skeletonFixture({
        bones: relinked,
        boneBudget: { min: 14, max: 30 },
        sockets: [{ id: 'weapon.main', bone: 'mixamorig:LeftHand' }],
        bindPose: null,
      }),
    );
    expect(errorCodes(result.issues)).toContain('skeleton.symmetry');
  });

  it('rejects a socket hanging off a bone that does not exist', () => {
    const result = validateSkeleton(skeletonFixture({ sockets: [{ id: 'weapon.main', bone: 'mixamorig:Tail' }] }));
    expect(errorCodes(result.issues)).toContain('skeleton.socket.bone');
  });

  it('rejects duplicate socket ids', () => {
    const result = validateSkeleton(
      skeletonFixture({
        sockets: [
          { id: 'weapon.main', bone: 'mixamorig:RightHand' },
          { id: 'weapon.main', bone: 'mixamorig:LeftHand' },
        ],
      }),
    );
    expect(errorCodes(result.issues)).toContain('skeleton.socket.duplicate');
  });

  it('requires a bind pose to cover every bone and no others', () => {
    const base = skeletonFixture();
    const bindPose = base.bindPose;
    if (!bindPose) throw new Error('fixture changed');

    const short = { ...bindPose, bones: bindPose.bones.slice(0, 5) };
    expect(errorCodes(validateSkeleton(skeletonFixture({ bindPose: short })).issues)).toContain(
      'skeleton.bindPose.missing',
    );

    const extra = {
      ...bindPose,
      bones: [
        ...bindPose.bones,
        { name: 'mixamorig:Tail', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      ],
    } as Skeleton['bindPose'];
    expect(errorCodes(validateSkeleton(skeletonFixture({ bindPose: extra })).issues)).toContain(
      'skeleton.bindPose.extra',
    );
  });
});

// --- clip library ------------------------------------------------------------

describe('validateClipLib', () => {
  it('accepts the fixture with nothing to say', () => {
    expect(validateClipLib(clipLibFixture()).issues).toEqual([]);
  });

  it('rejects duplicate clip ids', () => {
    const lib = clipLibFixture();
    const first = lib.clips[0];
    if (!first) throw new Error('fixture changed');
    const issues = validateClipLib(clipLibFixture({ clips: [...lib.clips, first] })).issues;
    expect(errorCodes(issues)).toContain('cliplib.clip.duplicate');
  });

  it('requires events in ascending order', () => {
    const clip: Clip = {
      id: 'swing',
      source: 'clips/swing.glb',
      durationMs: 800,
      loop: false,
      events: [
        { name: 'b', normalizedTime: 0.6 },
        { name: 'a', normalizedTime: 0.2 },
      ],
    };
    expect(errorCodes(validateClipLib(clipLibFixture({ clips: [clip] })).issues)).toContain('cliplib.event.order');
  });

  it('rejects two events at the same time', () => {
    // Strictly ascending, not merely non-decreasing: two markers on the same
    // frame have no defined firing order, and the runtime would pick one.
    const clip: Clip = {
      id: 'swing',
      source: 'clips/swing.glb',
      durationMs: 800,
      loop: false,
      events: [
        { name: 'a', normalizedTime: 0.5 },
        { name: 'b', normalizedTime: 0.5 },
      ],
    };
    expect(errorCodes(validateClipLib(clipLibFixture({ clips: [clip] })).issues)).toContain('cliplib.event.order');
  });

  it('rejects two events with the same name in one clip', () => {
    const clip: Clip = {
      id: 'walk',
      source: 'clips/walk.glb',
      durationMs: 1000,
      loop: true,
      events: [
        { name: 'footstep', normalizedTime: 0.1 },
        { name: 'footstep', normalizedTime: 0.6 },
      ],
    };
    expect(errorCodes(validateClipLib(clipLibFixture({ clips: [clip] })).issues)).toContain(
      'cliplib.event.duplicate',
    );
  });

  it('rejects an event outside 0..1 at the schema layer', () => {
    const clip: Clip = {
      id: 'swing',
      source: 'clips/swing.glb',
      durationMs: 800,
      loop: false,
      events: [{ name: 'impact', normalizedTime: 1.2 }],
    };
    const issues = validateClipLib(clipLibFixture({ clips: [clip] })).issues;
    expect(issues.map((issue) => issue.path)).toContain('/clips/0/events/0/normalizedTime');
  });

  it('accepts an event on either boundary', () => {
    const clip: Clip = {
      id: 'swing',
      source: 'clips/swing.glb',
      durationMs: 800,
      loop: false,
      events: [
        { name: 'start', normalizedTime: 0 },
        { name: 'end', normalizedTime: 1 },
      ],
    };
    expect(validateClipLib(clipLibFixture({ clips: [clip] })).issues).toEqual([]);
  });
});

// --- unit definition, on its own ---------------------------------------------

describe('validateUnitDef', () => {
  it('accepts the fixture with nothing to say', () => {
    expect(validateUnitDef(unitDefFixture()).issues).toEqual([]);
  });

  it('rejects a state and a blend tree sharing an id', () => {
    // Transitions address both in one namespace, so a collision makes `to`
    // ambiguous rather than merely confusing.
    const unit = withMachine({
      blendTrees: [
        {
          id: 'idle',
          parameter: 'speed',
          thresholds: [
            { value: 0, clipRef: 'idle' },
            { value: 34, clipRef: 'walk' },
          ],
        },
      ],
    });
    expect(errorCodes(validateUnitDef(unit).issues)).toContain('unitdef.node.duplicate');
  });

  it('rejects duplicate parameters and duplicate actions', () => {
    const base = unitDefFixture().stateMachine;
    const parameter = base.parameters[0];
    const action = base.actionTimings[0];
    if (!parameter || !action) throw new Error('fixture changed');
    expect(errorCodes(validateUnitDef(withMachine({ parameters: [...base.parameters, parameter] })).issues)).toContain(
      'unitdef.parameter.duplicate',
    );
    expect(
      errorCodes(validateUnitDef(withMachine({ actionTimings: [...base.actionTimings, action] })).issues),
    ).toContain('unitdef.action.duplicate');
  });

  it('requires a blend tree to read a declared numeric parameter', () => {
    const undeclared = withMachine({
      blendTrees: [
        {
          id: 'move',
          parameter: 'velocity',
          thresholds: [
            { value: 0, clipRef: 'idle' },
            { value: 34, clipRef: 'walk' },
          ],
        },
      ],
    });
    expect(errorCodes(validateUnitDef(undeclared).issues)).toContain('unitdef.parameter.undeclared');

    const wrongType = withMachine({
      blendTrees: [
        {
          id: 'move',
          parameter: 'grounded',
          thresholds: [
            { value: 0, clipRef: 'idle' },
            { value: 34, clipRef: 'walk' },
          ],
        },
      ],
    });
    expect(errorCodes(validateUnitDef(wrongType).issues)).toContain('unitdef.parameter.type');
  });

  it('requires blend thresholds to ascend', () => {
    const unit = withMachine({
      blendTrees: [
        {
          id: 'move',
          parameter: 'speed',
          thresholds: [
            { value: 34, clipRef: 'walk' },
            { value: 0, clipRef: 'idle' },
          ],
        },
      ],
    });
    expect(errorCodes(validateUnitDef(unit).issues)).toContain('unitdef.blendTree.order');
  });

  it('rejects a transition to or from a node that does not exist', () => {
    const base = unitDefFixture().stateMachine;
    const unit = withMachine({
      transitions: [
        ...base.transitions,
        { from: 'ghost', to: 'idle', condition: 'exit', durationMs: 10, interruptible: true },
        { from: 'idle', to: 'ghost', condition: 'exit', durationMs: 10, interruptible: true },
      ],
    });
    const found = errorCodes(validateUnitDef(unit).issues);
    expect(found).toContain('unitdef.transition.from');
    expect(found).toContain('unitdef.transition.to');
  });

  it('accepts `*` as an any-state source', () => {
    expect(codes(validateUnitDef(unitDefFixture()).issues)).not.toContain('unitdef.transition.from');
  });

  it('refuses an exit from a terminal state', () => {
    const base = unitDefFixture().stateMachine;
    const unit = withMachine({
      transitions: [
        ...base.transitions,
        { from: 'death', to: 'idle', condition: 'exit', durationMs: 100, interruptible: false },
      ],
    });
    expect(errorCodes(validateUnitDef(unit).issues)).toContain('unitdef.transition.terminal');
  });

  it('refuses an interruptible exit from a locking state', () => {
    // A locking state refuses transitions until recovery ends. A transition out
    // of one marked interruptible says the opposite; one of the two is wrong.
    const base = unitDefFixture().stateMachine;
    const transitions = base.transitions.map((transition) =>
      transition.from === 'swing' ? { ...transition, interruptible: true } : transition,
    );
    expect(errorCodes(validateUnitDef(withMachine({ transitions })).issues)).toContain(
      'unitdef.transition.locking',
    );
  });

  it('rejects a condition it cannot parse', () => {
    const base = unitDefFixture().stateMachine;
    const transitions = [
      ...base.transitions,
      { from: 'idle', to: 'swing', condition: 'speed > 5 && attack', durationMs: 10, interruptible: true },
    ];
    expect(errorCodes(validateUnitDef(withMachine({ transitions })).issues)).toContain('unitdef.condition.parse');
  });

  it('rejects a condition reading an undeclared parameter', () => {
    const base = unitDefFixture().stateMachine;
    const transitions = [
      ...base.transitions,
      { from: 'idle', to: 'swing', condition: 'stamina > 5', durationMs: 10, interruptible: true },
    ];
    expect(errorCodes(validateUnitDef(withMachine({ transitions })).issues)).toContain(
      'unitdef.parameter.undeclared',
    );
  });

  it('rejects a parameter used at the wrong type', () => {
    const base = unitDefFixture().stateMachine;
    const compareABool = [
      ...base.transitions,
      { from: 'idle', to: 'swing', condition: 'grounded > 1', durationMs: 10, interruptible: true },
    ];
    expect(errorCodes(validateUnitDef(withMachine({ transitions: compareABool })).issues)).toContain(
      'unitdef.condition.type',
    );

    const flagAFloat = [
      ...base.transitions,
      { from: 'idle', to: 'swing', condition: 'speed', durationMs: 10, interruptible: true },
    ];
    expect(errorCodes(validateUnitDef(withMachine({ transitions: flagAFloat })).issues)).toContain(
      'unitdef.condition.type',
    );
  });

  it('rejects an action with no duration at all', () => {
    const unit = withMachine({
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 0,
          activeMs: 0,
          recoveryMs: 0,
          clipRef: 'swing',
          eventMap: {},
        },
      ],
    });
    expect(errorCodes(validateUnitDef(unit).issues)).toContain('unitdef.action.empty');
  });
});

// --- the three documents together --------------------------------------------

describe('validateUnitBundle', () => {
  it('accepts the fixtures with nothing to say', () => {
    expect(bundleOf(unitDefFixture())).toEqual([]);
  });

  it('refuses to validate a unit against a provisional skeleton', () => {
    // Writing the bone contract down early is the point; binding a unit to a rig
    // nobody has measured is where that stops being harmless.
    const issues = bundleOf(unitDefFixture(), clipLibFixture(), skeletonFixture({ bindPose: null }));
    expect(errorCodes(issues)).toContain('bundle.skeleton.provisional');
  });

  it('rejects a state naming a clip that does not exist', () => {
    const unit = unitDefFixture();
    const states = unit.stateMachine.states.map((state) =>
      state.id === 'swing' ? { ...state, clipRef: 'uppercut' } : state,
    );
    expect(errorCodes(bundleOf({ ...unit, stateMachine: { ...unit.stateMachine, states } }))).toContain(
      'bundle.clipRef.unknown',
    );
  });

  it('accepts a state naming a blend tree instead of a clip', () => {
    // That is how a locomotion state gets a speed-driven pose.
    expect(bundleOf(unitDefFixture())).toEqual([]);
  });

  it('rejects a blend tree threshold naming a clip that does not exist', () => {
    const unit = withMachine({
      blendTrees: [
        {
          id: 'move',
          parameter: 'speed',
          thresholds: [
            { value: 0, clipRef: 'idle' },
            { value: 34, clipRef: 'sprint' },
          ],
        },
      ],
    });
    expect(errorCodes(bundleOf(unit))).toContain('bundle.clipRef.unknown');
  });

  it('rejects a blend tree that shadows a clip of the same name', () => {
    // A state's clipRef resolves as a tree first, so the clip becomes
    // unreachable and nothing anywhere says so.
    const unit = withMachine({
      blendTrees: [
        {
          id: 'walk',
          parameter: 'speed',
          thresholds: [
            { value: 0, clipRef: 'idle' },
            { value: 34, clipRef: 'walk' },
          ],
        },
      ],
      states: unitDefFixture().stateMachine.states.map((state) =>
        state.id === 'locomotion' ? { ...state, clipRef: 'walk' } : state,
      ),
    });
    expect(errorCodes(bundleOf(unit))).toContain('bundle.blendTree.shadowsClip');
  });

  it('rejects an action stretched past the limit, in the slow direction', () => {
    // A 300ms clip dragged over a 1400ms action is 4.7x: slow motion, not a
    // swing. The timing is authoritative, so the answer is a different clip.
    const unit = withMachine({
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 600,
          activeMs: 200,
          recoveryMs: 600,
          clipRef: 'swing',
          eventMap: {},
        },
      ],
    });
    const lib = clipLibFixture({
      clips: clipLibFixture().clips.map((clip) => (clip.id === 'swing' ? { ...clip, durationMs: 300 } : clip)),
    });
    const issues = bundleOf(unit, lib);
    expect(errorCodes(issues)).toContain('bundle.timeScale.exceeded');
    expect(issues.find((issue) => issue.code === 'bundle.timeScale.exceeded')?.message).toContain('4.67x');
  });

  it('rejects an action crammed past the limit, in the fast direction', () => {
    // The bound is two-sided on purpose: "make the wind-up snappier" must not be
    // able to quietly become a flicker.
    const unit = withMachine({
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 60,
          activeMs: 30,
          recoveryMs: 60,
          clipRef: 'swing',
          eventMap: {},
        },
      ],
    });
    expect(errorCodes(bundleOf(unit))).toContain('bundle.timeScale.exceeded');
  });

  it('accepts an action sitting exactly on the limit', () => {
    // 800ms of clip over a 400ms action is exactly 2.0x.
    const unit = withMachine({
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 200,
          activeMs: 100,
          recoveryMs: 100,
          clipRef: 'swing',
          eventMap: {},
        },
      ],
    });
    expect(errorCodes(bundleOf(unit))).not.toContain('bundle.timeScale.exceeded');
  });

  it('honours a unit that raises its own limit', () => {
    const base = withMachine({
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 60,
          activeMs: 30,
          recoveryMs: 60,
          clipRef: 'swing',
          eventMap: {},
        },
      ],
    });
    expect(errorCodes(bundleOf({ ...base, maxTimeScale: 8 }))).not.toContain('bundle.timeScale.exceeded');
  });

  it('bounds an authored state timeScale the same way', () => {
    const unit = unitDefFixture();
    const states: State[] = unit.stateMachine.states.map((state) =>
      state.id === 'swing' ? { ...state, timeScale: 0.25 } : state,
    );
    expect(errorCodes(bundleOf({ ...unit, stateMachine: { ...unit.stateMachine, states } }))).toContain(
      'bundle.timeScale.exceeded',
    );
  });

  it('rejects an event map pointing at an event the clip does not have', () => {
    const unit = withMachine({
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 300,
          activeMs: 120,
          recoveryMs: 280,
          clipRef: 'swing',
          eventMap: { active: 'swing.contact' },
        },
      ],
    });
    expect(errorCodes(bundleOf(unit))).toContain('bundle.event.unknown');
  });

  it('rejects an event mapped to a phase it does not land in', () => {
    // swing.impact is at 0.55; the wind-up window ends at 0.43.
    const unit = withMachine({
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 300,
          activeMs: 120,
          recoveryMs: 280,
          clipRef: 'swing',
          eventMap: { windup: 'swing.impact' },
        },
      ],
    });
    expect(errorCodes(bundleOf(unit))).toContain('bundle.event.window');
  });

  it('leaves a free-form event map key alone as long as the event exists', () => {
    const unit = withMachine({
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 300,
          activeMs: 120,
          recoveryMs: 280,
          clipRef: 'swing',
          eventMap: { whoosh: 'swing.start' },
        },
      ],
    });
    expect(errorCodes(bundleOf(unit))).toEqual([]);
  });

  it('warns when a looping state plays a clip not authored to loop', () => {
    const unit = unitDefFixture();
    const states = unit.stateMachine.states.map((state) =>
      state.id === 'idle' ? { ...state, clipRef: 'death' } : state,
    );
    const issues = bundleOf({ ...unit, stateMachine: { ...unit.stateMachine, states } });
    expect(codes(issues)).toContain('bundle.loop.mismatch');
    expect(errorCodes(issues)).not.toContain('bundle.loop.mismatch');
  });

  it('reports every problem in one pass rather than stopping at the first', () => {
    const unit = withMachine({
      states: [
        { id: 'a', clipRef: 'nope1', loop: true, timeScale: 1, blendInMs: 0, category: 'loop' },
        { id: 'b', clipRef: 'nope2', loop: true, timeScale: 1, blendInMs: 0, category: 'loop' },
      ],
      blendTrees: [],
      transitions: [],
      actionTimings: [],
    });
    expect(errorCodes(bundleOf(unit)).filter((code) => code === 'bundle.clipRef.unknown')).toHaveLength(2);
  });
});

// --- issue shape -------------------------------------------------------------

describe('issues', () => {
  it('carry a JSON pointer that addresses the offending field', () => {
    const unit = unitDefFixture();
    const states = unit.stateMachine.states.map((state) =>
      state.id === 'swing' ? { ...state, clipRef: 'uppercut' } : state,
    );
    const issues = bundleOf({ ...unit, stateMachine: { ...unit.stateMachine, states } });
    const issue = issues.find((candidate) => candidate.code === 'bundle.clipRef.unknown');
    expect(issue?.path).toBe('/stateMachine/states/2/clipRef');
  });
});
