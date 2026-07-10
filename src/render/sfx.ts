// Synthesized sound effects, described as data. Pure module: no Web Audio, no
// DOM. Each effect is a short stack of frequency sweeps that audio.ts renders
// on oscillators (or a noise buffer) with a quick envelope — the crunchy,
// bleepy palette of an 80s cabinet. This file also owns the routing from a
// game event to the effect that voices it, so "attacks" are audible.

import type { GameEvent } from '../game/session.js';
import type { SpellGameEvent } from '../game/spell-session.js';
import type { SpellId } from '../cards/spells.js';
import type { Waveform } from './music.js';

export interface SfxSegment {
  /** Oscillator shape, or filtered white noise for percussive hits. */
  readonly wave: Waveform | 'noise';
  /** Frequency (Hz) at the start of the segment; ignored for noise. */
  readonly startFreq: number;
  /** Frequency (Hz) it glides to over `duration` (exponential ramp). */
  readonly endFreq: number;
  /** Segment length in seconds. */
  readonly duration: number;
  /** Peak gain, 0..1, before the master/sfx mix. */
  readonly gain: number;
  /** Seconds after the trigger before this segment starts (for layering). */
  readonly delay?: number;
}

export interface SfxSpec {
  readonly segments: readonly SfxSegment[];
}

/**
 * The effect library. Attacks get bright, aggressive sweeps; defense and heals
 * get consonant arpeggios; getting hit is a dirty downward buzz.
 */
export const SFX: Record<string, SfxSpec> = {
  // Melee swing that connects: a snappy zap with a noise transient.
  hit: {
    segments: [
      { wave: 'square', startFreq: 720, endFreq: 180, duration: 0.12, gain: 0.3 },
      { wave: 'noise', startFreq: 0, endFreq: 0, duration: 0.06, gain: 0.18 },
    ],
  },
  // Melee swing through empty air: airy descending whoosh.
  swing: {
    segments: [{ wave: 'triangle', startFreq: 520, endFreq: 240, duration: 0.1, gain: 0.14 }],
  },
  // Fireball: rising then bursting hot square-wave zap.
  fireball: {
    segments: [
      { wave: 'sawtooth', startFreq: 240, endFreq: 900, duration: 0.09, gain: 0.24 },
      { wave: 'square', startFreq: 900, endFreq: 120, duration: 0.14, gain: 0.22, delay: 0.07 },
    ],
  },
  // Ice shard: crystalline high blip that shivers downward.
  iceshard: {
    segments: [
      { wave: 'triangle', startFreq: 1600, endFreq: 1200, duration: 0.08, gain: 0.2 },
      { wave: 'sine', startFreq: 2100, endFreq: 1400, duration: 0.12, gain: 0.14, delay: 0.04 },
    ],
  },
  // Generic spell cast (AOE actives): a warbling rising sweep.
  cast: {
    segments: [
      { wave: 'sawtooth', startFreq: 180, endFreq: 620, duration: 0.16, gain: 0.2 },
      { wave: 'square', startFreq: 620, endFreq: 520, duration: 0.1, gain: 0.14, delay: 0.14 },
    ],
  },
  // Guard break: metallic clang — two clashing detuned squares.
  guardbreak: {
    segments: [
      { wave: 'square', startFreq: 300, endFreq: 300, duration: 0.14, gain: 0.22 },
      { wave: 'square', startFreq: 317, endFreq: 150, duration: 0.16, gain: 0.18 },
    ],
  },
  // Buff (War Cry): confident rising fanfare stab.
  buff: {
    segments: [
      { wave: 'sawtooth', startFreq: 330, endFreq: 494, duration: 0.12, gain: 0.2 },
      { wave: 'sawtooth', startFreq: 494, endFreq: 660, duration: 0.14, gain: 0.18, delay: 0.1 },
    ],
  },
  // Retiring a passive: a soft neutral downward blip.
  retire: {
    segments: [{ wave: 'triangle', startFreq: 440, endFreq: 300, duration: 0.1, gain: 0.12 }],
  },
  // Heal: gentle major-third chime rising.
  heal: {
    segments: [
      { wave: 'sine', startFreq: 523, endFreq: 523, duration: 0.14, gain: 0.18 },
      { wave: 'sine', startFreq: 659, endFreq: 784, duration: 0.18, gain: 0.16, delay: 0.09 },
    ],
  },
  // Perfect parry/dodge: bright triumphant three-note arpeggio.
  perfect: {
    segments: [
      { wave: 'square', startFreq: 659, endFreq: 659, duration: 0.07, gain: 0.2 },
      { wave: 'square', startFreq: 880, endFreq: 880, duration: 0.07, gain: 0.2, delay: 0.06 },
      { wave: 'square', startFreq: 1319, endFreq: 1319, duration: 0.12, gain: 0.2, delay: 0.12 },
    ],
  },
  // Partial block: a single muted thunk.
  block: {
    segments: [{ wave: 'square', startFreq: 330, endFreq: 220, duration: 0.09, gain: 0.16 }],
  },
  // Player takes damage: dirty descending sawtooth buzz with noise grit.
  hurt: {
    segments: [
      { wave: 'sawtooth', startFreq: 300, endFreq: 90, duration: 0.18, gain: 0.24 },
      { wave: 'noise', startFreq: 0, endFreq: 0, duration: 0.1, gain: 0.14 },
    ],
  },
  // Enemy defeated: quick descending arcade "down" fanfare.
  enemyDown: {
    segments: [
      { wave: 'square', startFreq: 784, endFreq: 784, duration: 0.07, gain: 0.2 },
      { wave: 'square', startFreq: 587, endFreq: 587, duration: 0.07, gain: 0.2, delay: 0.07 },
      { wave: 'square', startFreq: 392, endFreq: 262, duration: 0.16, gain: 0.2, delay: 0.14 },
    ],
  },
  // Player defeated: long sad descending glide.
  gameOver: {
    segments: [
      { wave: 'sawtooth', startFreq: 440, endFreq: 110, duration: 0.5, gain: 0.24 },
      { wave: 'square', startFreq: 330, endFreq: 82, duration: 0.6, gain: 0.18, delay: 0.12 },
    ],
  },
  // Bonus card drawn: cheerful pickup blip up an octave.
  bonusDraw: {
    segments: [
      { wave: 'square', startFreq: 880, endFreq: 880, duration: 0.06, gain: 0.18 },
      { wave: 'square', startFreq: 1319, endFreq: 1319, duration: 0.1, gain: 0.18, delay: 0.05 },
    ],
  },

  // --- Spell-card voices (spec 018/019) ---
  // Tiny select tick when a card is played into the window.
  select: {
    segments: [{ wave: 'square', startFreq: 1200, endFreq: 980, duration: 0.03, gain: 0.1 }],
  },
  // Attack cone: a snappy physical slash with a noise edge.
  slash: {
    segments: [
      { wave: 'triangle', startFreq: 640, endFreq: 240, duration: 0.09, gain: 0.2 },
      { wave: 'noise', startFreq: 0, endFreq: 0, duration: 0.05, gain: 0.13 },
    ],
  },
  // Dash: an airy rising whoosh.
  dashWhoosh: {
    segments: [
      { wave: 'sine', startFreq: 300, endFreq: 760, duration: 0.14, gain: 0.14 },
      { wave: 'noise', startFreq: 0, endFreq: 0, duration: 0.12, gain: 0.1 },
    ],
  },
  // Fire Blast cone: a hot rising zap that bursts downward.
  fireCone: {
    segments: [
      { wave: 'sawtooth', startFreq: 200, endFreq: 780, duration: 0.09, gain: 0.24 },
      { wave: 'square', startFreq: 780, endFreq: 170, duration: 0.15, gain: 0.2, delay: 0.07 },
    ],
  },
  // Blaze Aura / Basking Path ignition: a crackling swell.
  ignite: {
    segments: [
      { wave: 'sawtooth', startFreq: 120, endFreq: 380, duration: 0.2, gain: 0.18 },
      { wave: 'noise', startFreq: 0, endFreq: 0, duration: 0.14, gain: 0.1, delay: 0.04 },
    ],
  },
  // Meteor / Fire Storm launch: a rising whistle telegraphing the drop.
  launch: {
    segments: [{ wave: 'sine', startFreq: 300, endFreq: 1200, duration: 0.24, gain: 0.16 }],
  },
  // Telegraphed AOE impact: a low, gritty boom.
  boom: {
    segments: [
      { wave: 'sawtooth', startFreq: 180, endFreq: 55, duration: 0.24, gain: 0.28 },
      { wave: 'noise', startFreq: 0, endFreq: 0, duration: 0.14, gain: 0.2 },
    ],
  },
  // Conjure Flame: a magical shimmer charging up.
  charge: {
    segments: [
      { wave: 'triangle', startFreq: 440, endFreq: 880, duration: 0.14, gain: 0.16 },
      { wave: 'sine', startFreq: 660, endFreq: 990, duration: 0.18, gain: 0.12, delay: 0.1 },
    ],
  },
  // Ground Stomp: a heavy low thud.
  quake: {
    segments: [
      { wave: 'square', startFreq: 150, endFreq: 68, duration: 0.16, gain: 0.26 },
      { wave: 'noise', startFreq: 0, endFreq: 0, duration: 0.09, gain: 0.16 },
    ],
  },
  // Rocky Raise: a warm rising shield chord.
  shieldUp: {
    segments: [
      { wave: 'triangle', startFreq: 330, endFreq: 330, duration: 0.14, gain: 0.18 },
      { wave: 'triangle', startFreq: 494, endFreq: 494, duration: 0.2, gain: 0.14, delay: 0.06 },
    ],
  },
  // Bury Feet: a low grinding rumble.
  rumble: {
    segments: [
      { wave: 'sawtooth', startFreq: 92, endFreq: 66, duration: 0.3, gain: 0.22 },
      { wave: 'noise', startFreq: 0, endFreq: 0, duration: 0.18, gain: 0.12 },
    ],
  },
  // Synergy fusion: a bright ascending three-note flourish.
  synergy: {
    segments: [
      { wave: 'square', startFreq: 659, endFreq: 659, duration: 0.06, gain: 0.2 },
      { wave: 'square', startFreq: 880, endFreq: 880, duration: 0.06, gain: 0.2, delay: 0.06 },
      { wave: 'square', startFreq: 1319, endFreq: 1319, duration: 0.13, gain: 0.21, delay: 0.12 },
    ],
  },
  // Wave cleared: a triumphant little jingle.
  waveClear: {
    segments: [
      { wave: 'square', startFreq: 784, endFreq: 784, duration: 0.08, gain: 0.2 },
      { wave: 'square', startFreq: 988, endFreq: 988, duration: 0.08, gain: 0.2, delay: 0.08 },
      { wave: 'square', startFreq: 1319, endFreq: 1319, duration: 0.16, gain: 0.21, delay: 0.16 },
    ],
  },
  // Reward chosen: a soft confirming blip.
  reward: {
    segments: [
      { wave: 'sine', startFreq: 660, endFreq: 660, duration: 0.07, gain: 0.16 },
      { wave: 'sine', startFreq: 990, endFreq: 990, duration: 0.1, gain: 0.16, delay: 0.06 },
    ],
  },
  // Mis-timed window: a deflating, sludgy downward buzz — the sound of a fumble.
  fumble: {
    segments: [
      { wave: 'sawtooth', startFreq: 300, endFreq: 90, duration: 0.3, gain: 0.18 },
      { wave: 'square', startFreq: 180, endFreq: 70, duration: 0.22, gain: 0.1, delay: 0.05 },
    ],
  },
};

// Which effect voices each played active card. Falls back to 'cast' for any
// active without a bespoke sound.
const CARD_SFX: Record<string, string> = {
  fireball: 'fireball',
  iceshard: 'iceshard',
  emberlash: 'fireball',
  guardbreak: 'guardbreak',
  mend: 'heal',
  warcry: 'buff',
};

/**
 * Route a game/sim event to the SFX that should play, or `undefined` for events
 * that are purely cosmetic (or already covered by a sibling event, e.g. we
 * voice the card play itself, not the enemyHit it also produces would double up
 * — that's handled by the caller choosing which events to feed us). Every
 * returned key is guaranteed to exist in `SFX`.
 */
export function sfxForEvent(event: GameEvent): string | undefined {
  switch (event.kind) {
    case 'cardPlayed':
    case 'bonusCardPlayed':
      return CARD_SFX[event.defId] ?? 'cast';
    case 'passiveRetired':
      return 'retire';
    case 'bonusCardDrawn':
      return 'bonusDraw';
    case 'enemyHit':
      return 'hit';
    case 'attackMissed':
      return 'swing';
    case 'perfectDefense':
      return 'perfect';
    case 'normalDefense':
      return 'block';
    case 'playerHit':
      return 'hurt';
    case 'playerHealed':
      return 'heal';
    case 'enemyDefeated':
      return 'enemyDown';
    case 'playerDefeated':
      return 'gameOver';
    default:
      return undefined;
  }
}

// The signature voice of each spell card, played once when its cast resolves.
// Every value exists in `SFX`.
const CARD_SFX_ID: Record<SpellId, string> = {
  attack: 'slash',
  dash: 'dashWhoosh',
  fireBlast: 'fireCone',
  blazeAura: 'ignite',
  meteorStrike: 'launch',
  baskingPath: 'ignite',
  conjureFlame: 'charge',
  fireStorm: 'launch',
  burningSpeed: 'ignite',
  groundStomp: 'quake',
  rockyRaise: 'shieldUp',
  buryFeet: 'rumble',
};

/**
 * Route a spell-game event (spec 018/019) to the SFX ids it should voice -- a
 * list, since a resolved window may fire several cards at once. Card casts voice
 * per distinct card (plus a synergy flourish when copies fused); telegraphed
 * blasts boom on impact; wave clears and rewards get their own jingles. Frequent
 * per-hit damage events stay silent so damage-over-time never becomes a wall of
 * noise -- the cast and death sounds carry the feedback. Every id exists in `SFX`.
 */
export function spellEventSfx(event: SpellGameEvent): string[] {
  switch (event.kind) {
    case 'cardPlayed':
      return ['select'];
    case 'spellsResolved': {
      const distinct = [...new Set(event.ids)];
      const out = distinct.map((id) => CARD_SFX_ID[id]);
      if (event.ids.length > distinct.length) out.push('synergy'); // two-of-a-kind fused
      return out;
    }
    case 'aoeImpact':
      return ['boom'];
    case 'playerSlowed':
      return ['fumble'];
    case 'rewardOffered':
      return ['waveClear'];
    case 'rewardChosen':
      return ['reward'];
    case 'playerHit':
      return ['hurt'];
    case 'playerHealed':
      return ['heal'];
    case 'enemyDefeated':
      return ['enemyDown'];
    case 'playerDefeated':
      return ['gameOver'];
    default:
      // enemyHit, spellCast, dashPerformed, cosmetic events: silent (covered elsewhere).
      return [];
  }
}
