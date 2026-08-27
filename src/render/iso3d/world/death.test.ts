/**
 * What the overlay says, given the one answer to "am I dead" (specs 164, 229).
 *
 * The three cases this file used to own -- a living body, a welcome that has not
 * landed, and a body missing from the replicated set -- are `selfDead`'s since
 * spec 229, and are asserted where they can actually arise, against a real
 * client, in `server/client/death-prediction.test.ts`. They moved because the
 * *legs* need the same answer, and two copies of `health <= 0` are two answers:
 * an overlay saying you are dead while the body walks off is precisely the
 * disagreement `death.ts` was written to avoid, one level up.
 *
 * What is left here is the mapping, which is all this module is now, and the
 * shape of it: null rather than `{ dead: false }`, because a value that can be
 * present and false is a value with an extra way to be wrong.
 */

import { describe, expect, it } from 'vitest';
import type { ClientView } from '../../../server/client/game-client.js';
import { DEATH_TEXT, deathOverlay } from './death.js';

function viewFixture(selfDead: boolean): ClientView {
  return { selfDead } as unknown as ClientView;
}

describe('the death overlay', () => {
  it('says nothing over a living body', () => {
    expect(deathOverlay(viewFixture(false))).toBeNull();
  });

  it('says so once the client is dead', () => {
    expect(deathOverlay(viewFixture(true))?.text).toBe(DEATH_TEXT);
  });
});
