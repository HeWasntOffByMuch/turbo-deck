import { describe, expect, it } from 'vitest';
import { buildSong, midiToFreq, type MusicVoice } from './music.js';

describe('midiToFreq', () => {
  it('anchors A4 (69) at 440Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
  });

  it('doubles frequency per octave', () => {
    expect(midiToFreq(81)).toBeCloseTo(880, 6);
    expect(midiToFreq(57)).toBeCloseTo(220, 6);
  });
});

describe('buildSong', () => {
  const song = buildSong();

  it('is deterministic', () => {
    expect(buildSong()).toEqual(buildSong());
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
});
