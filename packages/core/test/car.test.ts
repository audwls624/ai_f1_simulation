import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CarSpecSchema, SetupSchema, derive, type DeriveTrackInput, type Setup } from '../src/car.js';
import {
  type SpecPatch,
  baseSetup,
  baseSpec,
  bumpyTrack,
  docExampleSpec,
  regs,
  setupArb,
  smoothTrack,
  specArb,
  trackArb,
  withSpec,
} from './helpers.js';

/** baseSpec·baseSetup·smoothTrack에서 일부만 바꿔 derive. */
function perf(patch: SpecPatch = {}, setup: Partial<Setup> = {}, track: DeriveTrackInput = smoothTrack, tempC?: number) {
  return derive(withSpec(baseSpec, patch), { ...baseSetup, ...setup }, track, regs, tempC);
}

describe('CarSpecSchema / SetupSchema', () => {
  it('accept the DESIGN.md §4 example and a normal setup', () => {
    expect(CarSpecSchema.safeParse(docExampleSpec).success).toBe(true);
    expect(SetupSchema.safeParse(baseSetup).success).toBe(true);
  });

  it.each([
    [{ ...baseSetup, wing_level: 11 }],
    [{ ...baseSetup, wing_level: -1 }],
    [{ ...baseSetup, wing_level: 5.5 }],
    [{ ...baseSetup, ride_height: 'ultra' }],
    [{ ...baseSetup, ers_mode: 'boost' }],
    [{ ...baseSetup, fuel_kg: 100 }],
  ])('setup rejects %j', (setup) => {
    expect(SetupSchema.safeParse(setup).success).toBe(false);
  });
});

describe('derive: weight (DESIGN.md §16)', () => {
  it('weight_reduction 1.0 → minimum weight, 0.0 → +30 kg (no ERS battery)', () => {
    expect(perf({ chassis: { weight_reduction: 1 }, powertrain: { ers_capacity: 0 } }).mass_kg).toBe(798);
    expect(perf({ chassis: { weight_reduction: 0 }, powertrain: { ers_capacity: 0 } }).mass_kg).toBe(828);
  });

  it('property: weight_reduction spans exactly 30 kg for any other parameters, never below 798 kg', () => {
    fc.assert(
      fc.property(specArb, setupArb, trackArb, (spec, setup, track) => {
        const at = (wr: number) => derive(withSpec(spec, { chassis: { weight_reduction: wr } }), setup, track, regs);
        expect(at(0).mass_kg - at(1).mass_kg).toBeCloseTo(30, 9);
        expect(derive(spec, setup, track, regs).mass_kg).toBeGreaterThanOrEqual(798);
      }),
    );
  });

  it('a bigger ERS battery is heavier (4절: 배터리 무게↑)', () => {
    expect(perf({ powertrain: { ers_capacity: 1 } }).mass_kg).toBeGreaterThan(
      perf({ powertrain: { ers_capacity: 0 } }).mass_kg,
    );
  });
});

describe('derive: cooling × air temperature (DESIGN.md §4 interaction 1, §16)', () => {
  const noCooling: SpecPatch = { powertrain: { cooling: 0 } };

  it('insufficient cooling at 35°C → heat_derate > 0; at 20°C → 0', () => {
    expect(perf(noCooling, {}, smoothTrack, 35).heat_derate).toBeGreaterThan(0);
    expect(perf(noCooling, {}, smoothTrack, 20).heat_derate).toBe(0);
  });

  it('uses the track mean temperature when no race temperature is given', () => {
    const hot = { ...smoothTrack, temp_mean: 35 };
    expect(perf(noCooling, {}, hot).heat_derate).toBe(perf(noCooling, {}, smoothTrack, 35).heat_derate);
  });

  it('no derate at or below 30°C, whatever the cooling', () => {
    expect(perf(noCooling, {}, smoothTrack, 30).heat_derate).toBe(0);
    expect(perf(noCooling, {}, smoothTrack, -5).heat_derate).toBe(0);
  });

  it('derate costs power, grows with temperature and shrinks with cooling', () => {
    expect(perf(noCooling, {}, smoothTrack, 35).power_kw).toBeLessThan(perf(noCooling, {}, smoothTrack, 20).power_kw);
    const derate = (cooling: number, t: number) => perf({ powertrain: { cooling } }, {}, smoothTrack, t).heat_derate;
    expect(derate(0, 40)).toBeGreaterThan(derate(0, 35));
    expect(derate(0.2, 40)).toBeLessThan(derate(0, 40));
    expect(derate(1, 45)).toBe(0);
  });

  it('cooling costs drag (radiator opening)', () => {
    expect(perf({ powertrain: { cooling: 1 } }).drag_coeff).toBeGreaterThan(perf(noCooling).drag_coeff);
  });
});

describe('derive: powertrain directions (DESIGN.md §4)', () => {
  it('thermal_efficiency ↑ → power ↑, fuel per lap ↓, failure rate slightly ↑', () => {
    const lo = perf({ powertrain: { thermal_efficiency: 0.2 } });
    const hi = perf({ powertrain: { thermal_efficiency: 0.9 } });
    expect(hi.power_kw).toBeGreaterThan(lo.power_kw);
    expect(hi.fuel_per_lap_kg).toBeLessThan(lo.fuel_per_lap_kg);
    expect(hi.failure_rate_per_lap).toBeGreaterThan(lo.failure_rate_per_lap);
  });

  it('reliability ↑ → failure rate ↓, power slightly ↓ (conservative map)', () => {
    const lo = perf({ powertrain: { reliability: 0.1 } });
    const hi = perf({ powertrain: { reliability: 0.9 } });
    expect(hi.failure_rate_per_lap).toBeLessThan(lo.failure_rate_per_lap);
    expect(hi.power_kw).toBeLessThan(lo.power_kw);
    expect(hi.power_kw / lo.power_kw).toBeGreaterThan(0.97);
  });

  it('ers_mode: attack > balanced > harvest for lap power and overtaking boost', () => {
    const [h, b, a] = (['harvest', 'balanced', 'attack'] as const).map((ers_mode) => perf({}, { ers_mode }));
    expect(a?.power_kw).toBeGreaterThan(b?.power_kw ?? Infinity);
    expect(b?.power_kw).toBeGreaterThan(h?.power_kw ?? Infinity);
    expect(a?.ers_boost).toBeGreaterThan(b?.ers_boost ?? Infinity);
    expect(b?.ers_boost).toBeGreaterThan(h?.ers_boost ?? Infinity);
  });

  it('attack depletes less with more ERS capacity; balanced lap power ignores capacity', () => {
    const gain = (ers_capacity: number) =>
      perf({ powertrain: { ers_capacity } }, { ers_mode: 'attack' }).power_kw -
      perf({ powertrain: { ers_capacity } }, { ers_mode: 'balanced' }).power_kw;
    expect(gain(1)).toBeGreaterThan(gain(0));
    expect(gain(0)).toBeGreaterThan(0);
    expect(perf({ powertrain: { ers_capacity: 1 } }).power_kw).toBe(perf({ powertrain: { ers_capacity: 0 } }).power_kw);
  });

  it('ers_capacity ↑ → overtaking/defence boost ↑', () => {
    expect(perf({ powertrain: { ers_capacity: 1 } }).ers_boost).toBeGreaterThan(
      perf({ powertrain: { ers_capacity: 0 } }).ers_boost,
    );
  });

  it('fuel per lap scales with lap length', () => {
    const short = perf({}, {}, { ...smoothTrack, length_m: 3000 }).fuel_per_lap_kg;
    const long = perf({}, {}, { ...smoothTrack, length_m: 6000 }).fuel_per_lap_kg;
    expect(long / short).toBeCloseTo(2, 9);
  });
});

describe('derive: aero directions (DESIGN.md §4)', () => {
  it('wing_level ↑ → downforce ↑ and drag ↑ at every step', () => {
    for (let w = 0; w < 10; w++) {
      const lo = perf({}, { wing_level: w });
      const hi = perf({}, { wing_level: w + 1 });
      expect(hi.downforce_coeff).toBeGreaterThan(lo.downforce_coeff);
      expect(hi.drag_coeff).toBeGreaterThan(lo.drag_coeff);
    }
  });

  it('efficiency curve: each extra unit of downforce costs more drag at high wing', () => {
    const marginal = (w: number) => {
      const a = perf({}, { wing_level: w });
      const b = perf({}, { wing_level: w + 1 });
      return (b.drag_coeff - a.drag_coeff) / (b.downforce_coeff - a.downforce_coeff);
    };
    expect(marginal(9)).toBeGreaterThan(marginal(1));
  });

  it('aero_efficiency ↑ → less drag at the same downforce', () => {
    const lo = perf({ aero: { aero_efficiency: 0 } });
    const hi = perf({ aero: { aero_efficiency: 1 } });
    expect(hi.drag_coeff).toBeLessThan(lo.drag_coeff);
    expect(hi.downforce_coeff).toBe(lo.downforce_coeff);
  });

  it('drs_effect ↑ → DRS gain ↑, slight permanent drag cost', () => {
    const lo = perf({ aero: { drs_effect: 0 } });
    const hi = perf({ aero: { drs_effect: 1 } });
    expect(hi.drs_gain).toBeGreaterThan(lo.drs_gain);
    expect(hi.drag_coeff).toBeGreaterThan(lo.drag_coeff);
    expect(hi.drag_coeff / lo.drag_coeff).toBeLessThan(1.05);
  });

  it('dirty_air_resistance ↑ → less downforce lost behind a car', () => {
    expect(perf({ aero: { dirty_air_resistance: 1 } }).dirty_air_loss).toBeLessThan(
      perf({ aero: { dirty_air_resistance: 0 } }).dirty_air_loss,
    );
  });

  it('wheelbase: long → more downforce (aero platform), short → more mechanical grip', () => {
    const long = perf({ chassis: { wheelbase: 'long' } });
    const short = perf({ chassis: { wheelbase: 'short' } });
    expect(long.downforce_coeff).toBeGreaterThan(short.downforce_coeff);
    expect(short.mech_grip).toBeGreaterThan(long.mech_grip);
  });
});

describe('derive: chassis and tyre directions (DESIGN.md §4, §6)', () => {
  it('mech_grip ↑ → mechanical grip ↑, aero unchanged', () => {
    const lo = perf({ chassis: { mech_grip: 0.6 } });
    const hi = perf({ chassis: { mech_grip: 1 } });
    expect(hi.mech_grip).toBeGreaterThan(lo.mech_grip);
    expect(hi.downforce_coeff).toBe(lo.downforce_coeff);
  });

  it('tire_management maps the wear multiplier 1.0 → 0.6 (at wing 0) and slows warm-up', () => {
    expect(perf({ chassis: { tire_management: 0 } }, { wing_level: 0 }).deg_multiplier).toBeCloseTo(1.0, 12);
    expect(perf({ chassis: { tire_management: 1 } }, { wing_level: 0 }).deg_multiplier).toBeCloseTo(0.6, 12);
    expect(perf({ chassis: { tire_management: 1 } }).warmup_penalty_s).toBeGreaterThan(
      perf({ chassis: { tire_management: 0 } }).warmup_penalty_s,
    );
  });

  it('more downforce slides less: wear × (1 − 0.1 · wing_level/10)', () => {
    const w0 = perf({}, { wing_level: 0 }).deg_multiplier;
    const w10 = perf({}, { wing_level: 10 }).deg_multiplier;
    expect(w10 / w0).toBeCloseTo(0.9, 12);
  });
});

describe('derive: floor philosophy and instability (DESIGN.md §4 interaction 2, ride_height)', () => {
  const floor = (patch: SpecPatch = {}) => withSpec(baseSpec, { ...patch, aero: { philosophy: 'floor', ...patch.aero } });
  const at = (spec = floor(), setup: Partial<Setup> = {}, track: DeriveTrackInput = smoothTrack) =>
    derive(spec, { ...baseSetup, ...setup }, track, regs);

  it('floor is more efficient than wing only at low ride height (narrow setup window)', () => {
    const wing = withSpec(baseSpec, { aero: { philosophy: 'wing' } });
    expect(at(floor(), { ride_height: 'low' }).downforce_coeff).toBeGreaterThan(at(wing, { ride_height: 'low' }).downforce_coeff);
    expect(at(floor(), { ride_height: 'low' }).drag_coeff).toBeLessThan(at(wing, { ride_height: 'low' }).drag_coeff);
    for (const ride_height of ['mid', 'high'] as const) {
      expect(at(floor(), { ride_height }).downforce_coeff).toBeLessThanOrEqual(at(wing, { ride_height }).downforce_coeff);
    }
  });

  it('floor × mech_grip < 0.5 → unstable: less downforce, wear × 1.15', () => {
    const stable = at(floor({ chassis: { mech_grip: 0.5 } }));
    const unstable = at(floor({ chassis: { mech_grip: 0.45 } }));
    expect(unstable.downforce_coeff).toBeLessThan(stable.downforce_coeff);
    expect(unstable.deg_multiplier / stable.deg_multiplier).toBeCloseTo(1.15, 12);
  });

  it('floor on a bumpy track → wear × 1.15 at any ride height', () => {
    for (const ride_height of ['low', 'mid', 'high'] as const) {
      const ratio = at(floor(), { ride_height }, bumpyTrack).deg_multiplier / at(floor(), { ride_height }).deg_multiplier;
      expect(ratio).toBeCloseTo(1.15, 12);
    }
  });

  it('bumpy track: floor loses its low-ride-height advantage (mid beats low), smooth track keeps it', () => {
    expect(at(floor(), { ride_height: 'low' }).downforce_coeff).toBeGreaterThan(
      at(floor(), { ride_height: 'mid' }).downforce_coeff,
    );
    expect(at(floor(), { ride_height: 'mid' }, bumpyTrack).downforce_coeff).toBeGreaterThan(
      at(floor(), { ride_height: 'low' }, bumpyTrack).downforce_coeff,
    );
    expect(at(floor(), { ride_height: 'low' }, bumpyTrack).mech_grip).toBeLessThan(at(floor(), { ride_height: 'low' }).mech_grip);
  });

  it('wing cars are less bump-sensitive and unaffected at high ride height', () => {
    const wing = withSpec(baseSpec, { aero: { philosophy: 'wing' } });
    const lossAtLow = (spec = wing) =>
      at(spec, { ride_height: 'low' }, bumpyTrack).downforce_coeff / at(spec, { ride_height: 'low' }).downforce_coeff;
    expect(lossAtLow(wing)).toBeLessThan(1);
    expect(lossAtLow(wing)).toBeGreaterThan(lossAtLow(floor()));
    const sameTrackSmooth = { ...bumpyTrack, bumpiness: 0 };
    expect(at(wing, { ride_height: 'high' }, bumpyTrack)).toEqual(at(wing, { ride_height: 'high' }, sameTrackSmooth));
  });
});

describe('derive: properties over the whole input space', () => {
  it('outputs are finite and physically bounded', () => {
    fc.assert(
      fc.property(specArb, setupArb, trackArb, fc.double({ min: -10, max: 50, noNaN: true }), (spec, setup, track, t) => {
        const p = derive(spec, setup, track, regs, t);
        for (const v of [
          p.power_kw,
          p.mass_kg,
          p.drag_coeff,
          p.downforce_coeff,
          p.mech_grip,
          p.fuel_per_lap_kg,
          p.deg_multiplier,
          p.warmup_penalty_s,
          p.failure_rate_per_lap,
          p.heat_derate,
          p.dirty_air_loss,
          p.drs_gain,
          p.ers_boost,
        ]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(p.power_kw).toBeGreaterThan(0);
        expect(p.drag_coeff).toBeGreaterThan(0);
        expect(p.downforce_coeff).toBeGreaterThan(0);
        expect(p.mech_grip).toBeGreaterThan(0);
        expect(p.fuel_per_lap_kg).toBeGreaterThan(0);
        expect(p.deg_multiplier).toBeGreaterThan(0);
        expect(p.warmup_penalty_s).toBeGreaterThanOrEqual(0);
        expect(p.failure_rate_per_lap).toBeGreaterThanOrEqual(0);
        expect(p.failure_rate_per_lap).toBeLessThan(1);
        expect(p.heat_derate).toBeGreaterThanOrEqual(0);
        expect(p.heat_derate).toBeLessThanOrEqual(regs.car.cooling.max_derate);
        expect(p.dirty_air_loss).toBeGreaterThanOrEqual(0);
        expect(p.dirty_air_loss).toBeLessThan(1);
        expect(p.drs_gain).toBeGreaterThan(0);
        expect(p.drs_gain).toBeLessThan(1);
        expect(p.ers_boost).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('is deterministic and does not mutate its inputs', () => {
    fc.assert(
      fc.property(specArb, setupArb, trackArb, (spec, setup, track) => {
        const frozen = <T extends object>(o: T): T => {
          for (const v of Object.values(o)) if (typeof v === 'object' && v !== null) Object.freeze(v);
          return Object.freeze(o);
        };
        const a = derive(frozen(structuredClone(spec)), frozen({ ...setup }), frozen({ ...track }), regs);
        expect(derive(spec, setup, track, regs)).toEqual(a);
      }),
    );
  });
});
