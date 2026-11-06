import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { derive, type CarSpec, type Setup } from '../src/car.js';
import { baseLap, lapProgress, raceLap, type LapBreakdown, type LapState } from '../src/laptime.js';
import type { Surface } from '../src/regulations.js';
import { TRACK_IDS, baseSetup, docExampleSpec, regs, setupArb, specArb, tracks, withSpec, type TrackId } from './helpers.js';

const fixedSpec: CarSpec = regs.fallback.spec; // "고정 스펙" (16절): 규정의 기본 스펙
const lap = (id: TrackId, spec: CarSpec = fixedSpec, setup: Partial<Setup> = {}, surface: Surface = 'dry'): LapBreakdown =>
  baseLap(derive(spec, { ...baseSetup, ...setup }, tracks[id], regs), tracks[id], surface, regs);
const corners = (b: LapBreakdown) => b.lowSpeed + b.midSpeed + b.highSpeed;
const bestWing = (id: TrackId, spec: CarSpec = fixedSpec) => {
  const totals = Array.from({ length: 11 }, (_, wing_level) => lap(id, spec, { wing_level }).total);
  return totals.indexOf(Math.min(...totals));
};

describe('baseLap monotonicity (DESIGN.md §16)', () => {
  it.each(TRACK_IDS)('%s: thermal_efficiency ↑ → straight ↓', (id) => {
    const lo = lap(id, withSpec(fixedSpec, { powertrain: { thermal_efficiency: 0.2 } }));
    const hi = lap(id, withSpec(fixedSpec, { powertrain: { thermal_efficiency: 0.9 } }));
    expect(hi.straight).toBeLessThan(lo.straight);
  });

  it.each(TRACK_IDS)('%s: wing_level ↑ → corners ↓, straight ↑', (id) => {
    for (const [a, b] of [[0, 5], [5, 10], [2, 8]] as const) {
      const lo = lap(id, fixedSpec, { wing_level: a });
      const hi = lap(id, fixedSpec, { wing_level: b });
      expect(corners(hi)).toBeLessThan(corners(lo));
      expect(hi.straight).toBeGreaterThan(lo.straight);
    }
  });

  it.each(TRACK_IDS)('%s: more mass → slower lap', (id) => {
    const light = lap(id, withSpec(fixedSpec, { chassis: { weight_reduction: 1 } }));
    const heavy = lap(id, withSpec(fixedSpec, { chassis: { weight_reduction: 0 } }));
    expect(heavy.total).toBeGreaterThan(light.total);
  });

  it.each(TRACK_IDS)('%s: mech_grip ↑ → lowSpeed ↓, and highSpeed moves less than lowSpeed', (id) => {
    const lo = lap(id, withSpec(fixedSpec, { chassis: { mech_grip: 0.5 } }));
    const hi = lap(id, withSpec(fixedSpec, { chassis: { mech_grip: 1 } }));
    expect(hi.lowSpeed).toBeLessThan(lo.lowSpeed);
    expect(Math.abs(hi.highSpeed - lo.highSpeed)).toBeLessThan(Math.abs(hi.lowSpeed - lo.lowSpeed));
  });

  it('a wetter surface is slower', () => {
    for (const id of TRACK_IDS) {
      expect(lap(id, fixedSpec, {}, 'damp').total).toBeGreaterThan(lap(id).total);
      expect(lap(id, fixedSpec, {}, 'wet').total).toBeGreaterThan(lap(id, fixedSpec, {}, 'damp').total);
    }
  });

  it('a stronger DRS helps where there are DRS zones', () => {
    const weak = lap('fast-oval', withSpec(fixedSpec, { aero: { drs_effect: 0 } }));
    const strong = lap('fast-oval', withSpec(fixedSpec, { aero: { drs_effect: 1 } }));
    expect(strong.total).toBeLessThan(weak.total);
    expect(strong.topSpeedKph).toBeGreaterThan(weak.topSpeedKph);
  });
});

describe('baseLap track discrimination (DESIGN.md §16)', () => {
  it.each([
    ['the fallback spec', fixedSpec],
    ['the §4 example spec', docExampleSpec],
  ])('best wing_level for %s: fast-oval < mixed < tight-street', (_name, spec) => {
    const fast = bestWing('fast-oval', spec);
    const mixed = bestWing('mixed', spec);
    const street = bestWing('tight-street', spec);
    expect(fast).toBeLessThan(mixed);
    expect(mixed).toBeLessThan(street);
  });

  it('philosophy=floor is penalised at ride_height=low on bumpy tight-street, but not on smooth tracks', () => {
    const floor = withSpec(fixedSpec, { aero: { philosophy: 'floor' } });
    expect(lap('tight-street', floor, { ride_height: 'low' }).total).toBeGreaterThan(
      lap('tight-street', floor, { ride_height: 'mid' }).total,
    );
    for (const id of ['mixed', 'fast-oval'] as const) {
      expect(lap(id, floor, { ride_height: 'low' }).total).toBeLessThan(lap(id, floor, { ride_height: 'mid' }).total);
    }
  });
});

describe('baseLap properties', () => {
  it('breakdown adds up, times are positive, top speed is plausible', () => {
    fc.assert(
      fc.property(specArb, setupArb, fc.constantFrom(...TRACK_IDS), (spec, setup, id) => {
        const b = baseLap(derive(spec, setup, tracks[id], regs), tracks[id], 'dry', regs);
        expect(b.straight + b.lowSpeed + b.midSpeed + b.highSpeed).toBeCloseTo(b.total, 9);
        for (const part of [b.straight, b.lowSpeed, b.midSpeed, b.highSpeed]) expect(part).toBeGreaterThanOrEqual(0);
        expect(b.total).toBeGreaterThan(0);
        expect(b.topSpeedKph).toBeGreaterThan(200);
        expect(b.topSpeedKph).toBeLessThan(420);
      }),
      { numRuns: 60 },
    );
  });

  it('is deterministic', () => {
    for (const id of TRACK_IDS) expect(lap(id)).toEqual(lap(id));
  });
});

describe('lapProgress (replay interpolation)', () => {
  it('starts at 0, rises monotonically below 1, and climbs faster per metre in corners than on straights', () => {
    for (const id of TRACK_IDS) {
      const track = tracks[id];
      const perf = derive(docExampleSpec, baseSetup, track, regs);
      const p = lapProgress(perf, track, 'dry', regs);
      expect(p).toHaveLength(track.samples.length);
      expect(p[0]).toBe(0);
      for (let i = 1; i < p.length; i++) expect(p[i] ?? 0).toBeGreaterThan(p[i - 1] ?? 0);
      expect(p.at(-1) ?? 1).toBeLessThan(1);
      const rate = (kind: 'straight' | 'corner') => {
        const steps = p.slice(0, -1).map((v, i) => ({ d: (p[i + 1] ?? 0) - v, kind: track.segments[track.samples[i]?.segment ?? 0]?.kind }));
        const xs = steps.filter((x) => x.kind === kind).map((x) => x.d);
        return xs.reduce((a, b) => a + b, 0) / xs.length;
      };
      expect(rate('corner')).toBeGreaterThan(rate('straight'));
    }
  });
});

describe('raceLap (DESIGN.md §6, §16)', () => {
  const base = lap('mixed');
  const perf = derive(fixedSpec, baseSetup, tracks.mixed, regs);
  const state: LapState = {
    compound: 'medium',
    surface: 'dry',
    tire_life: 1,
    tire_age_laps: 5,
    fuel_kg: 0,
    pace: 'normal',
    gap_ahead_s: Infinity,
    dirty_air_loss: perf.dirty_air_loss,
    warmup_penalty_s: perf.warmup_penalty_s,
    noise_s: 0,
  };
  const race = (patch: Partial<LapState> = {}) => raceLap(base, { ...state, ...patch }, regs);

  it('a fresh, warm medium with no fuel in clean air is exactly the base lap', () => {
    expect(race()).toBe(base.total);
  });

  it('tire_life ↓ → slower', () => {
    expect(race({ tire_life: 0.6 })).toBeGreaterThan(race());
    expect(race({ tire_life: 0.1 })).toBeGreaterThan(race({ tire_life: 0.6 }));
  });

  it('fuel ↓ → faster, at fuel.lap_time_per_kg_s per kg', () => {
    expect(race({ fuel_kg: 50 })).toBeLessThan(race({ fuel_kg: 100 }));
    expect(race({ fuel_kg: 100 }) - race()).toBeCloseTo(100 * regs.fuel.lap_time_per_kg_s, 9);
  });

  it('push < normal < conserve', () => {
    expect(race({ pace: 'push' })).toBeLessThan(race());
    expect(race()).toBeLessThan(race({ pace: 'conserve' }));
  });

  it('dirty air only within the gap threshold, and costs less with better dirty_air_resistance', () => {
    const gap = regs.laptime.dirty_air.gap_s;
    expect(race({ gap_ahead_s: gap * 0.5 })).toBeGreaterThan(race());
    expect(race({ gap_ahead_s: gap * 1.5 })).toBe(race());
    expect(race({ gap_ahead_s: 0.5, dirty_air_loss: 0.1 })).toBeLessThan(race({ gap_ahead_s: 0.5, dirty_air_loss: 0.3 }));
  });

  it('new tyres pay the warm-up penalty; the caller-supplied noise is added as is', () => {
    expect(race({ tire_age_laps: 0 })).toBeGreaterThan(race());
    expect(race({ noise_s: 0.37 }) - race()).toBeCloseTo(0.37, 12);
  });

  it('wrong compound for the surface is slow', () => {
    expect(race({ compound: 'wet' })).toBeGreaterThan(race({ compound: 'hard' }));
  });
});
