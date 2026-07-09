import { describe, expect, it } from 'vitest';
import { buildCalmSong, buildDeathSong, buildSong, midiToFreq, musicPhaseFor, musicPhaseForEnemyCount, type MusicVoice, type Song } from './music.js';

describe('midiToFreq', () => {
  it('anchors A4 (69) at 440Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
  });

  it('doubles frequency per octave', () => {
    expect(midiToFreq(81)).toBeCloseTo(880, 6);
    expect(midiToFreq(57)).toBeCloseTo(220, 6);
  });
});

// The invariants both themes must satisfy — a well-formed, loopable Song.
function assertWellFormed(build: () => Song): void {
  const song = build();

  it('is deterministic', () => {
    expect(build()).toEqual(build());
  });

  it('has a sane tempo and loop length', () => {
    expect(song.bpm).toBeGreaterThan(0);
    expect(song.lengthBeats).toBeGreaterThan(0);
    expect(song.notes.length).toBeGreaterThan(0);
  });

  it('returns notes sorted ascending by onset', () => {
    for (let i = 1; i < song.notes.length; i++) {
      const prev = song.notes[i - 1];
      const cur = song.notes[i];
      expect(cur && prev && cur.beat >= prev.beat).toBe(true);
    }
  });

  it('keeps every note inside the loop with a positive, bounded gain', () => {
    for (const note of song.notes) {
      expect(note.beat).toBeGreaterThanOrEqual(0);
      expect(note.beat).toBeLessThan(song.lengthBeats);
      expect(note.beat + note.duration).toBeLessThanOrEqual(song.lengthBeats + 1e-9);
      expect(note.duration).toBeGreaterThan(0);
      expect(note.gain).toBeGreaterThan(0);
      expect(note.gain).toBeLessThanOrEqual(1);
    }
  });

  it('includes all four voices', () => {
    const voices = new Set<MusicVoice>(song.notes.map((n) => n.voice));
    expect(voices).toEqual(new Set<MusicVoice>(['bass', 'arp', 'lead', 'pad']));
  });
}

describe('buildSong (combat theme)', () => {
  assertWellFormed(buildSong);
});

describe('buildCalmSong (no-wave theme)', () => {
  assertWellFormed(buildCalmSong);

  it('is a distinct theme from the combat song', () => {
    const calm = buildCalmSong();
    const combat = buildSong();
    expect(calm.bpm).not.toBe(combat.bpm);
    const calmLead = calm.notes.filter((n) => n.voice === 'lead').map((n) => n.midi);
    const combatLead = combat.notes.filter((n) => n.voice === 'lead').map((n) => n.midi);
    expect(calmLead).not.toEqual(combatLead);
  });

  it('voices its lead melody in D natural minor', () => {
    // D natural minor pitch classes: D E F G A A#/Bb C.
    const dMinor = new Set([2, 4, 5, 7, 9, 10, 0]);
    for (const note of buildCalmSong().notes) {
      if (note.voice !== 'lead') continue;
      expect(dMinor.has(note.midi % 12)).toBe(true);
    }
  });
});

describe('buildDeathSong (death dirge)', () => {
  assertWellFormed(buildDeathSong);

  it('is slower and distinct from the other themes', () => {
    const death = buildDeathSong();
    expect(death.bpm).toBeLessThan(buildCalmSong().bpm);
    expect(death.bpm).toBeLessThan(buildSong().bpm);
    const deathLead = death.notes.filter((n) => n.voice === 'lead').map((n) => n.midi);
    const calmLead = buildCalmSong().notes.filter((n) => n.voice === 'lead').map((n) => n.midi);
    expect(deathLead).not.toEqual(calmLead);
  });

  it('bends sinister: the lead carries the Phrygian ♭2 (E♭) and the A-major leading tone (C♯)', () => {
    const leadPcs = new Set(buildDeathSong().notes.filter((n) => n.voice === 'lead').map((n) => n.midi % 12));
    expect(leadPcs.has(3)).toBe(true); // E♭ — outside D natural minor
    expect(leadPcs.has(1)).toBe(true); // C♯ — the raised leading tone
  });
});

describe('musicPhaseForEnemyCount', () => {
  it('is calm with an empty arena and combat once a wave is present', () => {
    expect(musicPhaseForEnemyCount(0)).toBe('calm');
    expect(musicPhaseForEnemyCount(1)).toBe('combat');
    expect(musicPhaseForEnemyCount(7)).toBe('combat');
  });
});

describe('musicPhaseFor', () => {
  it('plays the death dirge once defeated, whatever the arena holds', () => {
    expect(musicPhaseFor(0, true)).toBe('death');
    expect(musicPhaseFor(5, true)).toBe('death');
  });

  it('follows the enemy count while alive', () => {
    expect(musicPhaseFor(0, false)).toBe('calm');
    expect(musicPhaseFor(3, false)).toBe('combat');
  });
});
