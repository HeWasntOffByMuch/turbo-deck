import { describe, expect, it } from 'vitest';
import type { WireStatus } from '../../../server/net/messages.js';
import { StatusId } from '../../../server/sim/statuses.js';
import { visualFor } from '../../../server/data/status-visuals.js';
import { MAGIC_DEFAULTS, TORCH_DEFAULTS } from '../player-lights.js';
import type { PlayerLightSettings } from '../view-controls.js';
import { carriesTorch, hasConjuredLight, resolveCarriedLights } from './carried-light.js';

/**
 * Spec 248. Two things decide one light now, and the whole of this file is the
 * rule that keeps them from arguing: the panel wins where it is asking for
 * something, and the game decides where it is not.
 */

/** The panel as it opens: both switches off, so the game has the whole say. */
const PANEL_OFF: PlayerLightSettings = {
  torchOn: false,
  torchRange: 500,
  torchBrightness: 3,
  torchFlicker: 2,
  torchShadows: true,
  torchPlayerShadow: false,
  magicOn: false,
  magicRange: 700,
  magicBrightness: 2,
};

const EMPTY = { offHand: null, conjured: false };

function status(id: string, expiresAtTick: number): WireStatus {
  const visual = visualFor(id);
  if (!visual) throw new Error(`no visual for ${id}`);
  return { wire: visual.wire, stacks: 1, expiresAtTick };
}

describe('what the player is carrying (spec 248)', () => {
  it('recognises the torch, and nothing else in the off hand', () => {
    expect(carriesTorch('torch.hand')).toBe(true);
    expect(carriesTorch('shield.oak')).toBe(false);
    expect(carriesTorch(null)).toBe(false);
    expect(carriesTorch(undefined)).toBe(false);
  });

  it('reads a conjured light off the replicated statuses', () => {
    expect(hasConjuredLight([status(StatusId.MagicLight, 100)], 50)).toBe(true);
    expect(hasConjuredLight([status(StatusId.Flow, 100)], 50)).toBe(false);
    expect(hasConjuredLight([], 50)).toBe(false);
  });

  /**
   * On the client's own comparison against the tick being drawn, which is
   * `status-marks.ts`'s rule: correctness must not depend on whether the delta
   * saying "it went out" has arrived yet.
   */
  it('stops seeing an expired light without being told', () => {
    const held = [status(StatusId.MagicLight, 100)];
    expect(hasConjuredLight(held, 99)).toBe(true);
    expect(hasConjuredLight(held, 100)).toBe(false);
  });

  it('ignores a wire index this build has no row for', () => {
    expect(hasConjuredLight([{ wire: 250, stacks: 1, expiresAtTick: 999 }], 0)).toBe(false);
  });
});

describe('resolving the two carried lights (spec 248)', () => {
  it('is off for a player carrying nothing, with the panel untouched', () => {
    const lights = resolveCarriedLights(PANEL_OFF, EMPTY);
    expect(lights.torch.on).toBe(false);
    expect(lights.orb.on).toBe(false);
  });

  /**
   * The panel is not changed by this spec, and this is the assertion of it:
   * every switch it can be in still produces exactly the numbers it names.
   */
  it('hands back the panel unchanged wherever the panel is asking for a light', () => {
    for (const shadows of [false, true]) {
      for (const playerShadow of [false, true]) {
        const settings: PlayerLightSettings = {
          ...PANEL_OFF,
          torchOn: true,
          magicOn: true,
          torchShadows: shadows,
          torchPlayerShadow: playerShadow,
        };
        // With the item in hand as well, so the panel is proved to win rather
        // than to merely agree.
        const lights = resolveCarriedLights(settings, { offHand: 'torch.hand', conjured: true });
        expect(lights.torch).toEqual({
          on: true,
          range: settings.torchRange,
          brightness: settings.torchBrightness,
          flicker: settings.torchFlicker,
          shadows,
        });
        expect(lights.orb.range).toBe(settings.magicRange);
        expect(lights.orb.brightness).toBe(settings.magicBrightness);
        expect(lights.playerShadow).toBe(playerShadow);
      }
    }
  });

  it("lights a carried torch at the item's numbers when the panel is off", () => {
    const lights = resolveCarriedLights(PANEL_OFF, { offHand: 'torch.hand', conjured: false });
    expect(lights.torch.on).toBe(true);
    expect(lights.torch.range).toBe(TORCH_DEFAULTS.range);
    expect(lights.torch.brightness).toBe(TORCH_DEFAULTS.brightness);
    expect(lights.torch.flicker).toBe(TORCH_DEFAULTS.flicker);
  });

  /**
   * The one number about a carried torch that is a decision rather than a
   * default. A shadow-casting point light re-renders the scene into six cube
   * faces every frame, and this one moves every frame -- so it is the one light
   * in the game that could never be baked the way a fixture is.
   */
  it('never casts a shadow from a carried torch', () => {
    const lights = resolveCarriedLights(PANEL_OFF, { offHand: 'torch.hand', conjured: false });
    expect(lights.torch.shadows).toBe(false);
  });

  it('lights a conjured orb from the status, and never casts from it', () => {
    const lights = resolveCarriedLights(PANEL_OFF, { offHand: null, conjured: true });
    expect(lights.orb.on).toBe(true);
    expect(lights.orb.range).toBe(MAGIC_DEFAULTS.range);
    expect(lights.orb.brightness).toBe(MAGIC_DEFAULTS.brightness);
    expect(lights.orb.shadows).toBe(false);
    // The panel cannot make it cast either: a conjured light *is* the one that
    // does not, which is what spec 047 says separates it from a lantern.
    expect(resolveCarriedLights({ ...PANEL_OFF, magicOn: true }, EMPTY).orb.shadows).toBe(false);
  });

  it('keeps the two independent', () => {
    const torchOnly = resolveCarriedLights(PANEL_OFF, { offHand: 'torch.hand', conjured: false });
    expect(torchOnly.orb.on).toBe(false);
    const orbOnly = resolveCarriedLights(PANEL_OFF, { offHand: 'shield.oak', conjured: true });
    expect(orbOnly.torch.on).toBe(false);
  });

  it('leaves the player out of point-light shadow maps by default (spec 118)', () => {
    expect(resolveCarriedLights(PANEL_OFF, EMPTY).playerShadow).toBe(false);
  });
});
