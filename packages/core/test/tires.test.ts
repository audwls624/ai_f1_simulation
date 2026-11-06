import { describe, expect, it } from 'vitest';
import { DRY_COMPOUNDS, type Compound } from '../src/regulations.js';
import { degradation, tireOffset, warmupPenalty, wearPerLap } from '../src/tires.js';
import { regs } from './helpers.js';

const COMPOUNDS: readonly Compound[] = ['soft', 'medium', 'hard', 'inter', 'wet'];
const perf = { deg_multiplier: 0.8 };
const track = { abrasiveness: 0.5 };

describe('degradation (DESIGN.md §6, §16)', () => {
  it.each(COMPOUNDS)('%s: zero on new tyres, increases monotonically as life drops', (c) => {
    expect(degradation(c, 1, regs)).toBe(0);
    let prev = -Infinity;
    for (let life = 1; life >= 0; life -= 0.01) {
      const d = degradation(c, life, regs);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it.each(COMPOUNDS)('%s: the slope jumps below the cliff', (c) => {
    const cliff = regs.tires.compounds[c].cliff_life;
    const step = 0.02;
    const above = degradation(c, cliff + step, regs) - degradation(c, cliff + 2 * step, regs);
    const below = degradation(c, cliff - 2 * step, regs) - degradation(c, cliff - step, regs);
    expect(below).toBeGreaterThan(5 * above);
    // 클리프를 넘는 순간 linear_max_s → cliff_base_s로 뛴다.
    expect(degradation(c, cliff - 1e-9, regs) - degradation(c, cliff, regs)).toBeCloseTo(
      regs.tires.degradation.cliff_base_s - regs.tires.degradation.linear_max_s,
      6,
    );
  });

  it('clamps life outside [0, 1]', () => {
    expect(degradation('soft', 1.5, regs)).toBe(0);
    expect(degradation('soft', -0.5, regs)).toBe(degradation('soft', 0, regs));
  });
});

describe('wearPerLap (DESIGN.md §6, §16)', () => {
  const wear = (c: Compound, patch: Partial<{ pace: 'push' | 'normal' | 'conserve'; dirty: boolean; surface: 'dry' | 'damp' | 'wet' }> = {}) =>
    wearPerLap(c, perf, track, patch.pace ?? 'normal', patch.dirty ?? false, patch.surface ?? 'dry', regs);

  it('soft wears faster than medium, medium faster than hard', () => {
    expect(wear('soft')).toBeGreaterThan(wear('medium'));
    expect(wear('medium')).toBeGreaterThan(wear('hard'));
  });

  it('scales with abrasiveness and deg_multiplier', () => {
    const base = wear('medium');
    expect(wearPerLap('medium', perf, { abrasiveness: 1 }, 'normal', false, 'dry', regs)).toBeCloseTo(2 * base, 12);
    expect(wearPerLap('medium', { deg_multiplier: 0.4 }, track, 'normal', false, 'dry', regs)).toBeCloseTo(base / 2, 12);
  });

  it('push > normal > conserve, and dirty air adds 10%', () => {
    expect(wear('medium', { pace: 'push' })).toBeGreaterThan(wear('medium'));
    expect(wear('medium')).toBeGreaterThan(wear('medium', { pace: 'conserve' }));
    expect(wear('medium', { dirty: true }) / wear('medium')).toBeCloseTo(1 + regs.tires.dirty_air_wear, 12);
  });

  it('inter ×3 and wet ×4 on a dry track, normal rate on damp', () => {
    expect(wear('inter') / wear('inter', { surface: 'damp' })).toBeCloseTo(3, 12);
    expect(wear('wet') / wear('wet', { surface: 'wet' })).toBeCloseTo(4, 12);
    expect(wear('soft') / wear('soft', { surface: 'wet' })).toBeCloseTo(1, 12);
  });
});

describe('tireOffset', () => {
  it('the right tyre is fastest on each surface', () => {
    const fastest = (surface: 'dry' | 'damp' | 'wet') =>
      COMPOUNDS.reduce((best, c) => (tireOffset(c, surface, regs) < tireOffset(best, surface, regs) ? c : best));
    expect(fastest('dry')).toBe('soft');
    expect(fastest('damp')).toBe('inter');
    expect(fastest('wet')).toBe('wet');
    for (const c of DRY_COMPOUNDS) expect(tireOffset(c, 'wet', regs)).toBeGreaterThan(tireOffset('wet', 'dry', regs));
  });
});

describe('warmupPenalty', () => {
  const car = 0.3;

  it('compound warm-up laps: hard 2, medium 1, soft 0', () => {
    const compoundPart = (c: Compound, age: number) => warmupPenalty(c, age, 0, regs);
    expect([0, 1, 2].map((age) => compoundPart('hard', age) > 0)).toEqual([true, true, false]);
    expect([0, 1].map((age) => compoundPart('medium', age) > 0)).toEqual([true, false]);
    expect(compoundPart('soft', 0)).toBe(0);
  });

  it('the car penalty (tire_management) applies for the first race laps of each set', () => {
    const laps = regs.car.tire_management.warmup_laps.race;
    expect(warmupPenalty('soft', 0, car, regs)).toBe(car);
    expect(warmupPenalty('soft', laps - 1, car, regs)).toBe(car);
    expect(warmupPenalty('soft', laps, car, regs)).toBe(0);
    expect(warmupPenalty('hard', 0, car, regs)).toBeCloseTo(car + regs.tires.compound_warmup_penalty_s, 12);
  });
});
