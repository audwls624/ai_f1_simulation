import { lint, makeRng, validatePlan, type CarSpec, type GPPlan } from '@f1sim/core';
import { describe, expect, it } from 'vitest';
import { loadRegulations, loadTrack } from '../src/data.js';
import { bestSetupLap, raceOnlyFixed, sampleSpec } from '../src/design.js';
import { runStrategyExploration } from '../src/strategy-explore.js';
import { STRATEGY_CRITERIA, strategyMetrics } from '../src/strategy-report.js';
import {
  describePlan,
  fallbacksPerRace,
  luck,
  pickDiverseSpecs,
  randomPlan,
  strategySpread,
  topPlanSamples,
  type StrategySample,
} from '../src/strategy.js';

const regs = loadRegulations(2026);
const trackIds = ['fast-oval', 'mixed', 'tight-street', 'highland'];

describe('randomPlan (DESIGN.md §12 strategy space)', () => {
  it('passes validation without lint warnings on every track', () => {
    const rng = makeRng(3);
    for (const id of trackIds) {
      const track = loadTrack(id, regs);
      const setup = bestSetupLap(regs.fallback.spec, track, regs).setup;
      for (let i = 0; i < 60; i++) {
        const plan = randomPlan(track, regs, rng, setup);
        expect(validatePlan(plan, regs, { laps: track.laps }).ok).toBe(true);
        expect(lint(plan)).toEqual([]);
        expect(plan.setup).toEqual(setup);
      }
    }
  });

  it('is reproducible for the same rng and covers 1–4 stints and rule counts 0–4', () => {
    const track = loadTrack('mixed', regs);
    const setup = regs.fallback.setup;
    const a = Array.from({ length: 80 }, (_, k) => randomPlan(track, regs, makeRng(9).spawn(`p${k}`), setup));
    const b = Array.from({ length: 80 }, (_, k) => randomPlan(track, regs, makeRng(9).spawn(`p${k}`), setup));
    expect(a).toEqual(b);
    const stints = new Set(a.map((p) => p.variants[0]?.plan.stints.length));
    const rules = new Set(a.map((p) => p.variants[0]?.plan.rules.length));
    expect([...stints].sort()).toEqual([1, 2, 3, 4]);
    expect([...rules].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(describePlan(a[0] as GPPlan)).toMatch(/^([SMHIW](→\d+)? ?)+ · \w+ · \d rules$/);
  });
});

describe('pickDiverseSpecs', () => {
  it('starts with the fastest spec of each architecture cell, then spreads out, all distinct', () => {
    const rng = makeRng(5);
    const specs: CarSpec[] = Array.from({ length: 200 }, () => sampleSpec(regs, rng, { fixed: raceOnlyFixed(regs) }));
    const times = specs.map((_, i) => (i * 7919) % 200); // 결정적인 가짜 시즌 시간
    const chosen = pickDiverseSpecs(specs, times, 10);
    expect(chosen).toHaveLength(10);
    expect(new Set(chosen).size).toBe(10);
    const cells = new Set(chosen.slice(0, 4).map((s) => `${s.aero.philosophy}/${s.chassis.wheelbase}`));
    expect(cells.size).toBe(4);
    const pool = new Set([...specs.keys()].sort((a, b) => (times[a] ?? 0) - (times[b] ?? 0)).slice(0, 50).map((i) => specs[i]));
    for (const s of chosen) expect(pool.has(s)).toBe(true);
  });
});

describe('strategy metrics (DESIGN.md §12 metrics 4–6)', () => {
  const sample = (over: Partial<StrategySample>): StrategySample => ({
    spec: 0, plan: 0, track: 0, seed: 0, pos: 5, time: 5000, fallbacks: 0, pits: 1, sc: false, rain: false, anyDnf: false, ...over,
  });

  it('spread = mean of the bottom share minus the top share of per-plan mean times', () => {
    const samples = Array.from({ length: 10 }, (_, plan) => [0, 1].map((seed) => sample({ plan, seed, time: 5000 + plan * 10 + seed }))).flat();
    const [cell] = strategySpread(samples, 0.1);
    expect(cell).toMatchObject({ spec: 0, track: 0, best: 0, worst: 9 });
    expect(cell?.spread).toBeCloseTo(90);
    // 리타이어(time null)는 분산 계산에서 빠진다
    expect(strategySpread([...samples, sample({ plan: 3, seed: 2, time: null })], 0.1)[0]?.spread).toBeCloseTo(90);
  });

  it('luck = per (spec, plan, track) sample sd of positions; fallbacks = mean per race', () => {
    const samples = [sample({ pos: 1 }), sample({ pos: 3, seed: 1 }), sample({ plan: 1, pos: 4 }), sample({ plan: 1, pos: 4, seed: 1, fallbacks: 2 })];
    expect(luck(samples)).toEqual([Math.SQRT2, 0]);
    expect(fallbacksPerRace(samples)).toBe(0.5);
  });

  it('topPlanSamples keeps only the best share of plans per (spec, track)', () => {
    const samples = Array.from({ length: 10 }, (_, plan) => [0, 1].map((spec) => sample({ plan, spec, time: 5000 + (spec ? -plan : plan) }))).flat();
    const top = topPlanSamples(samples, 0.2);
    expect(top.filter((s) => s.spec === 0).map((s) => s.plan)).toEqual([0, 1]);
    expect(top.filter((s) => s.spec === 1).map((s) => s.plan)).toEqual([8, 9]);
  });
});

describe('runStrategyExploration', () => {
  it('is deterministic across worker counts and yields one sample per (plan, spec, seed)', async () => {
    const opts = { season: 2026, seed: 11, plans: 2, seeds: 2, trackIds: ['mixed', 'tight-street'], specCount: 4, designSpecs: 24 } as const;
    const inline = await runStrategyExploration({ ...opts, workers: 1 });
    const threaded = await runStrategyExploration({ ...opts, workers: 2 });
    expect(threaded.samples).toEqual(inline.samples);
    expect(inline.samples).toHaveLength(opts.plans * opts.specCount * opts.seeds);
    expect(threaded.baseline).toEqual(inline.baseline);
    expect(inline.baseline).toHaveLength(opts.trackIds.length * opts.specCount * opts.seeds);
    expect(inline.baseline.every((s) => s.plan === -1)).toBe(true);
    const m = strategyMetrics(inline);
    expect(Number.isFinite(m.metric5.meanSd)).toBe(true);
    expect(m.metric6.pass).toBe(m.metric6.fallbacks < STRATEGY_CRITERIA.maxFallbacksPerRace);
  }, 120_000);
});
