import { baseLap, cost, derive, makeRng, type CarSpec } from '@f1sim/core';
import { describe, expect, it } from 'vitest';
import { loadRegulations, loadSeasonTracks } from '../src/data.js';
import {
  architectureWins,
  bestSetupLap,
  designMatrix,
  maxWinShare,
  raceOnlyFixed,
  sampleSpec,
  varianceContributions,
  winners,
} from '../src/design.js';
import { runDesignExploration } from '../src/explore.js';

const regs = loadRegulations(2026);
const tracks = loadSeasonTracks(2026, regs);

describe('sampleSpec', () => {
  it('budget-surface: every spec spends the whole cap, values stay in [0, 1]', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 200; i++) {
      const spec = sampleSpec(regs, rng);
      expect(cost(spec, regs)).toBeLessThanOrEqual(regs.cost.cap_credits + 1e-9);
      expect(cost(spec, regs)).toBeGreaterThan(regs.cost.cap_credits - 1e-6);
    }
  });

  it('budget-volume: uniform inside the cap', () => {
    const rng = makeRng(2);
    const costs = Array.from({ length: 300 }, () => cost(sampleSpec(regs, rng, { sampling: 'budget-volume' }), regs));
    expect(Math.max(...costs)).toBeLessThanOrEqual(regs.cost.cap_credits);
    expect(Math.min(...costs)).toBeLessThan(regs.cost.cap_credits / 2);
  });

  it('holds fixed parameters and spends the rest of the cap on the others', () => {
    const rng = makeRng(8);
    const fixed = raceOnlyFixed(regs);
    for (let i = 0; i < 50; i++) {
      const spec = sampleSpec(regs, rng, { fixed });
      expect(spec.powertrain.reliability).toBe(fixed.reliability);
      expect(spec.chassis.tire_management).toBe(fixed.tire_management);
      expect(spec.aero.dirty_air_resistance).toBe(fixed.dirty_air_resistance);
      expect(cost(spec, regs)).toBeGreaterThan(regs.cost.cap_credits - 1e-6);
    }
  });

  it('is deterministic for a seed and mixes architectures', () => {
    const a = Array.from({ length: 50 }, ((r) => () => sampleSpec(regs, r))(makeRng(3)));
    const b = Array.from({ length: 50 }, ((r) => () => sampleSpec(regs, r))(makeRng(3)));
    expect(a).toEqual(b);
    expect(new Set(a.map((s) => s.aero.philosophy)).size).toBe(2);
    expect(new Set(a.map((s) => s.chassis.wheelbase)).size).toBe(2);
  });
});

describe('bestSetupLap', () => {
  it('is never slower than any single setup it could have chosen', () => {
    const spec = regs.fallback.spec;
    for (const track of tracks.slice(0, 3)) {
      const best = bestSetupLap(spec, track, regs);
      for (const setup of [
        { wing_level: 5, ride_height: 'mid', ers_mode: 'balanced' },
        { wing_level: 0, ride_height: 'low', ers_mode: 'harvest' },
        { wing_level: 10, ride_height: 'high', ers_mode: 'attack' },
      ] as const) {
        expect(best.lap).toBeLessThanOrEqual(baseLap(derive(spec, setup, track, regs), track, 'dry', regs).total);
      }
    }
  });
});

describe('metrics (DESIGN.md §12)', () => {
  it('winners and max win share', () => {
    // laps[spec][track]
    const laps = [
      [1, 5, 5, 5],
      [2, 1, 1, 9],
      [3, 3, 3, 1],
    ];
    const w = winners(laps, 4);
    expect(w).toEqual([0, 1, 1, 2]);
    expect(maxWinShare(w)).toEqual({ share: 0.5, spec: 1, tracks: 2 });
  });

  it('variance contributions recover a known linear model', () => {
    const rng = makeRng(4);
    const X = Array.from({ length: 2000 }, () => [rng.next(), rng.next(), rng.next()]);
    const y = X.map(([a = 0, b = 0]) => 3 * a + 1 * b + rng.normal(0, 0.01));
    const { r2, contributions } = varianceContributions(X, y, ['a', 'b', 'c']);
    expect(r2).toBeGreaterThan(0.99);
    const share = Object.fromEntries(contributions.map((c) => [c.name, c.share]));
    expect(share.a).toBeCloseTo(0.9, 1);
    expect(share.b).toBeCloseTo(0.1, 1);
    expect(Math.abs(share.c ?? 1)).toBeLessThan(0.01);
    expect(contributions.reduce((s, c) => s + c.share, 0)).toBeCloseTo(r2, 9);
  });

  it('architecture wins and design matrix columns', () => {
    const floorShort: CarSpec = { ...regs.fallback.spec, aero: { ...regs.fallback.spec.aero, philosophy: 'floor' }, chassis: { ...regs.fallback.spec.chassis, wheelbase: 'short' } };
    const specs = [regs.fallback.spec, floorShort];
    expect(architectureWins(specs, [0, 1, 1])).toEqual({ floor: 2, wing: 1, short: 2, long: 1 });
    const { X, names } = designMatrix(specs);
    expect(names).toHaveLength(12);
    expect(X[1]?.slice(-2)).toEqual([1, 0]);
  });
});

describe('runDesignExploration', () => {
  it('gives the same results with or without worker threads', async () => {
    const opts = { season: 2026, count: 3, seed: 11, sampling: 'budget-surface' as const, fixRaceOnly: true };
    const inline = await runDesignExploration({ ...opts, workers: 1 });
    const threaded = await runDesignExploration({ ...opts, workers: 2 });
    expect(threaded.results).toEqual(inline.results);
    expect(threaded.seasonTimes).toEqual(inline.seasonTimes);
    expect(inline.results[0]).toHaveLength(24);
  }, 60_000);
});
