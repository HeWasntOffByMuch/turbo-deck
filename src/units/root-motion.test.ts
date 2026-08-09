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
