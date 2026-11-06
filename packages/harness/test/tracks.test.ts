import { profile, type TrackProfile } from '@f1sim/core';
import { describe, expect, it } from 'vitest';
import { listTrackIds, loadCalendar, loadRegulations, loadSeasonTracks } from '../src/data.js';
import { TRACK_BRIEFS } from '../src/track-briefs.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../src/data.js';
import { centerlineCsv, generateLayout, metaFor, metaYaml, seedFor } from '../src/trackgen.js';

const regs = loadRegulations(2026);
const tracks = loadSeasonTracks(2026, regs);
const profiles = tracks.map((t) => profile(t));
const range = (f: (p: TrackProfile) => number) => Math.max(...profiles.map(f)) - Math.min(...profiles.map(f));
const dominant = (p: TrackProfile) => {
  const c = { low: p.corners_low, mid: p.corners_mid, high: p.corners_high };
  return c.low >= c.mid && c.low >= c.high ? 'low' : c.mid >= c.high ? 'mid' : 'high';
};

describe('2026 calendar (DESIGN.md §2, §12 checklist 1)', () => {
  it('has 24 distinct GPs, all present under data/tracks', () => {
    const calendar = loadCalendar(2026);
    expect(calendar.gps).toHaveLength(24);
    expect(new Set(calendar.gps).size).toBe(24);
    expect(listTrackIds()).toEqual([...calendar.gps].sort());
  });

  it('spreads straight ratio, corner mix, abrasiveness and temperature', () => {
    expect(range((p) => p.straight_ratio)).toBeGreaterThanOrEqual(0.15);
    expect(range((p) => p.abrasiveness)).toBeGreaterThanOrEqual(0.6);
    expect(range((p) => p.temp_mean)).toBeGreaterThanOrEqual(20);
    expect(range((p) => p.length_km)).toBeGreaterThanOrEqual(2.5);
    for (const cls of ['low', 'mid', 'high'] as const) {
      expect(profiles.filter((p) => dominant(p) === cls).length).toBeGreaterThanOrEqual(3);
    }
    const bumpy = profiles.filter((p) => p.bumpiness >= regs.car.instability.bumpy_from).length;
    expect(bumpy).toBeGreaterThanOrEqual(6);
    expect(bumpy).toBeLessThanOrEqual(18);
    const hot = profiles.filter((p) => p.temp_mean > regs.car.cooling.derate_from_c).length;
    expect(hot).toBeGreaterThanOrEqual(3); // cooling 상호작용이 의미를 갖는 GP
  });
});

describe('track generator', () => {
  it('reproduces the committed data files exactly (deterministic generation)', () => {
    for (const brief of TRACK_BRIEFS) {
      const layout = generateLayout(brief, regs, seedFor(brief.id));
      const file = (ext: string) => readFileSync(join(DATA_DIR, 'tracks', `${brief.id}.${ext}`), 'utf8');
      expect(centerlineCsv(brief, layout)).toBe(file('csv'));
      expect(metaYaml(brief, metaFor(brief, layout))).toBe(file('yaml'));
    }
  });

  it('hits the brief straight ratio within the generator tolerance', () => {
    for (const brief of TRACK_BRIEFS.slice(0, 5)) {
      const layout = generateLayout(brief, regs, seedFor(brief.id));
      expect(Math.abs(layout.straightRatio - brief.straightRatio)).toBeLessThanOrEqual(0.01);
      expect(layout.length_m).toBeGreaterThanOrEqual(2800);
    }
  });
});
