import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  rootMotionChannels,
  rootMotionMessage,
  rootMotionTrackNames,
  trackTravel,
  travelChannels,
  travelMessage,
  withoutRootMotion,
  withoutTravel,
} from './root-motion.js';

function gltf(channels: readonly { node: number; path: string }[], animationName = 'walk'): unknown {
  return {
    nodes: [{ name: 'Hips' }, { name: 'Spine' }, { name: 'LeftUpLeg' }],
    animations: [{ name: animationName, channels: channels.map((channel) => ({ target: channel })) }],
  };
}

describe('rootMotionChannels', () => {
  it('finds translation on the root bone', () => {
    const found = rootMotionChannels(gltf([{ node: 0, path: 'translation' }]), 'Hips');
    expect(found).toEqual([{ animation: 'walk', bone: 'Hips', path: 'translation' }]);
  });

  it('leaves rotation on the root alone', () => {
    // A clip that turns the hips is doing its job. Only position moves a body.
    expect(rootMotionChannels(gltf([{ node: 0, path: 'rotation' }]), 'Hips')).toEqual([]);
  });

  it('leaves translation on any other bone alone', () => {
    // A shoulder that slides or a squash is a rig doing something unusual, not
    // root motion, and refusing it would be inventing a rule nobody asked for.
    expect(rootMotionChannels(gltf([{ node: 1, path: 'translation' }]), 'Hips')).toEqual([]);
    expect(rootMotionChannels(gltf([{ node: 2, path: 'translation' }]), 'Hips')).toEqual([]);
  });

  it('reports every offending channel, across every animation', () => {
    const doc = {
      nodes: [{ name: 'Hips' }],
      animations: [
        { name: 'walk', channels: [{ target: { node: 0, path: 'translation' } }] },
        { name: 'run', channels: [{ target: { node: 0, path: 'translation' } }] },
      ],
    };
    expect(rootMotionChannels(doc, 'Hips').map((channel) => channel.animation)).toEqual(['walk', 'run']);
  });

  it('survives a document it cannot read rather than throwing', () => {
    // Whatever is wrong with a file this cannot parse, the validator that
    // *parsed* it has the real error. Throwing here would replace it.
    for (const bad of [null, undefined, 42, 'nope', {}, { nodes: 3, animations: 'x' }]) {
      expect(rootMotionChannels(bad, 'Hips')).toEqual([]);
    }
  });

  it('does not crash on a channel pointing at a node that is not there', () => {
    expect(rootMotionChannels(gltf([{ node: 99, path: 'translation' }]), 'Hips')).toEqual([]);
  });
});

describe('rootMotionTrackNames', () => {
  it('matches both spellings three.js uses', () => {
    expect(rootMotionTrackNames(['Hips.position', '.bones[Hips].position'], 'Hips')).toEqual([
      'Hips.position',
      '.bones[Hips].position',
    ]);
  });

  it('ignores rotation and scale', () => {
    expect(rootMotionTrackNames(['Hips.quaternion', 'Hips.scale'], 'Hips')).toEqual([]);
  });

  it('ignores another bone with the root as a prefix', () => {
    // `HipsExtra` starts with `Hips` and is a different bone; a `startsWith`
    // would strip a track the rig needs.
    expect(rootMotionTrackNames(['HipsExtra.position', '.bones[HipsExtra].position'], 'Hips')).toEqual([]);
  });

  it('ignores a property that merely starts with position', () => {
    expect(rootMotionTrackNames(['Hips.positionOffset'], 'Hips')).toEqual([]);
  });
});

describe('rootMotionMessage', () => {
  it('names the unit, the clip, the bone and the remedy', () => {
    const message = rootMotionMessage('mannequin', 'walk', ['Hips']);
    expect(message).toContain('mannequin/walk');
    expect(message).toContain('"Hips"');
    expect(message).toContain('stripped at import');
    expect(message).toContain('root locked');
  });
});

/**
 * The rig that got past this check, and what it cost.
 *
 * A real generated rig carries its travel on a node the skin does not deform:
 * `Root` sits above `Hip`, moves the character across the floor, and is not one
 * of the skin's joints. The importer asked three for the topmost *joint*, got
 * `Hip`, matched nothing, stripped nothing, and reported a clean import -- while
 * the preview showed the body sliding out of the scene.
 */
describe('a rig whose travel is above the skin', () => {
  const named = (names: readonly string[]): unknown => ({
    nodes: names.map((name) => ({ name })),
    animations: [{ name: 'walk', channels: [{ target: { node: 0, path: 'translation' } }] }],
  });

  it('misses the travel when only the topmost joint is checked', () => {
    // The bug, pinned so the fix cannot quietly regress to it.
    expect(rootMotionChannels(named(['Root', 'Hip', 'Spine01']), 'Hip')).toEqual([]);
    expect(rootMotionTrackNames(['Root.position', 'Hip.quaternion'], 'Hip')).toEqual([]);
  });

  it('finds it when the whole chain above the root is checked', () => {
    const found = rootMotionChannels(named(['Root', 'Hip', 'Spine01']), ['Hip', 'Root', 'Armature']);
    expect(found.map((channel) => channel.bone)).toEqual(['Root']);
    expect(rootMotionTrackNames(['Root.position', 'Hip.quaternion'], ['Hip', 'Root'])).toEqual(['Root.position']);
  });

  it('still ignores translation on a bone that merely poses the body', () => {
    // The chain is the root and its ancestors, never a shoulder that slides.
    expect(rootMotionTrackNames(['Spine01.position'], ['Hip', 'Root', 'Armature'])).toEqual([]);
  });

  it('takes a single name too, so every existing caller still reads', () => {
    expect(rootMotionTrackNames(['Hips.position'], 'Hips')).toEqual(['Hips.position']);
  });
});

describe('withoutRootMotion', () => {
  const doc = (): Record<string, unknown> => ({
    nodes: [{ name: 'Armature' }, { name: 'Root' }, { name: 'Hip' }, { name: 'L_Calf' }],
    animations: [
      {
        name: 'walk',
        channels: [
          { target: { node: 1, path: 'translation' } },
          { target: { node: 0, path: 'translation' } },
          { target: { node: 1, path: 'rotation' } },
          { target: { node: 2, path: 'translation' } },
          { target: { node: 3, path: 'rotation' } },
        ],
      },
    ],
  });

  it('removes translation on the root chain and nothing else', () => {
    const { json, removed } = withoutRootMotion(doc(), ['Root', 'Armature']);
    expect(removed.map((channel) => channel.bone).sort()).toEqual(['Armature', 'Root']);
    const channels = (json['animations'] as { channels: { target: { node: number; path: string } }[] }[])[0]
      ?.channels;
    // The root's *rotation* survives: a clip that turns the body is doing its
    // job, and only the travel is the server's business.
    expect(channels).toEqual([
      { target: { node: 1, path: 'rotation' } },
      { target: { node: 2, path: 'translation' } },
      { target: { node: 3, path: 'rotation' } },
    ]);
  });

  it('keeps the pelvis, which bobs and shifts weight on purpose', () => {
    // The mistake this pins: `Hip` is the root bone's *child*, not the root.
    // Stripping it takes the weight shift out of every walk in the library.
    const { removed } = withoutRootMotion(doc(), ['Root', 'Armature']);
    expect(removed.map((channel) => channel.bone)).not.toContain('Hip');
  });

  it('hands back the same document when there is nothing to remove', () => {
    const original = doc();
    const { json, removed } = withoutRootMotion(original, ['NoSuchBone']);
    expect(removed).toEqual([]);
    expect(json).toBe(original);
  });
});

describe('trackTravel', () => {
  it('is zero for a track that returns to its first key', () => {
    // A cycle ends where it began, whatever it does in between. This is the
    // idle: 0.163 of sway and not one unit of travel.
    const bob = [0, 1, 0, 0, 1.2, 0, 0, 0.8, 0, 0, 1, 0];
    expect(trackTravel(bob).distance).toBe(0);
    expect(trackTravel(bob).axis).toEqual([0, 0, 0]);
  });

  it('is the first-to-last distance when it does not', () => {
    const stride = [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0];
    expect(trackTravel(stride)).toEqual({ distance: 3, axis: [1, 0, 0] });
  });

  it('is zero for a track with nothing to compare', () => {
    expect(trackTravel([]).distance).toBe(0);
    expect(trackTravel([1, 2, 3]).distance).toBe(0);
  });
});

describe('withoutTravel', () => {
  /** A stride along -y with a bob on z and a constant offset on x. */
  function walking(keys: number): number[] {
    const values: number[] = [];
    for (let key = 0; key < keys; key += 1) {
      const u = key / (keys - 1);
      values.push(0.5, -2 * u, 1 + 0.1 * Math.sin(u * Math.PI * 2));
    }
    return values;
  }

  it('leaves a track with no travel byte for byte alone', () => {
    const bob = [0, 1, 0, 0, 1.2, 0, 0, 0.8, 0, 0, 1, 0];
    expect(withoutTravel(bob, [0, 0, 0])).toEqual(bob);
  });

  it('closes the loop: the last key lands back on the first', () => {
    const corrected = withoutTravel(walking(9), [0, 0, 0]);
    const last = corrected.length - 3;
    for (let axis = 0; axis < 3; axis += 1) {
      expect(corrected[last + axis]).toBeCloseTo(corrected[axis] ?? 0, 10);
    }
  });

  it('keeps what is perpendicular to the travel, key for key', () => {
    // The whole reason this is not a `delete the track`. What runs across the
    // stride is the bob, the sway and the crouch a run holds its hips in.
    const before = walking(9);
    const after = withoutTravel(before, [0, 0, 0]);
    for (let key = 0; key * 3 < before.length; key += 1) {
      expect(after[key * 3 + 0]).toBeCloseTo(before[key * 3 + 0] ?? 0, 10);
      expect(after[key * 3 + 2]).toBeCloseTo(before[key * 3 + 2] ?? 0, 10);
    }
  });

  it('puts the along-axis mean at the bone rest value', () => {
    // Without this the run's hips sit half a stride ahead of the idle's, and
    // the body jumps the moment a blend crosses between them.
    const corrected = withoutTravel(walking(9), [0, -0.25, 0]);
    let total = 0;
    for (let key = 0; key * 3 < corrected.length; key += 1) total += corrected[key * 3 + 1] ?? 0;
    expect(total / (corrected.length / 3)).toBeCloseTo(-0.25, 10);
  });

  it('spreads the ramp by time when the keys are not evenly spaced', () => {
    const values = [0, 0, 0, 0, 1, 0, 0, 4, 0];
    const times = [0, 0.25, 1];
    const corrected = withoutTravel(values, [0, 0, 0], times);
    // Each key loses its own share: 0, a quarter of 4, and all of it.
    expect(corrected[1]).toBeCloseTo(corrected[7] ?? 0, 10);
    expect((corrected[4] ?? 0) - (corrected[1] ?? 0)).toBeCloseTo(0, 10);
  });

  it('is idempotent', () => {
    // A clip that has already been corrected has no travel left to find, so a
    // second pass must be a no-op rather than another shift.
    const once = withoutTravel(walking(9), [0, 0, 0]);
    expect(withoutTravel(once, [0, 0, 0])).toEqual(once);
  });
});

describe('travelMessage', () => {
  it('names the clip, the bone and how far it went', () => {
    const message = travelMessage('biped.core', 'run', 'Hip', 2.86018);
    expect(message).toContain('biped.core/run');
    expect(message).toContain('"Hip"');
    expect(message).toContain('2.860');
  });
});

describe('travelChannels, over the committed biped clips (spec 118)', () => {
  const clips = join('assets', 'units', 'clips');
  /** A tenth of the rig's reach. The pig's skeleton spans about one unit. */
  const MINIMUM = 0.1;

  function travelling(clip: string): readonly { node: string; distance: number }[] {
    const found = travelChannels(new Uint8Array(readFileSync(join(clips, `${clip}.glb`))), MINIMUM);
    return found.map((channel) => ({ node: channel.node, distance: channel.distance }));
  }

  it('finds the stride the root-bone rule cannot see', () => {
    // The bug, as data. `Root` carries no translation channel at all, so the
    // rule that looks at the root passed every one of these clips while the
    // body slid 160 world units forward per cycle.
    expect(travelling('run')).toHaveLength(1);
    expect(travelling('run')[0]?.node).toBe('Hip');
    expect(travelling('run')[0]?.distance).toBeCloseTo(2.86, 2);
    expect(travelling('walk')[0]).toMatchObject({ node: 'Hip' });
  });

  it('leaves the clips that stay put alone', () => {
    // Both have translation on the same bone. The idle sways 0.163 and comes
    // back; the hurt drifts 0.017, which is what a retarget leaves behind.
    expect(travelling('idle')).toEqual([]);
    expect(travelling('hurt')).toEqual([]);
    expect(travelling('defeat_02')).toEqual([]);
  });
});
