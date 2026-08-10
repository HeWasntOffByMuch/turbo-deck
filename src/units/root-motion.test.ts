import { describe, expect, it } from 'vitest';
import { rootMotionChannels, rootMotionMessage, rootMotionTrackNames } from './root-motion.js';

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
