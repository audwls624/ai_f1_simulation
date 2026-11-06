import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import type { CarSpec, DeriveTrackInput, Setup } from '../src/car.js';
import { parseRegulations, type Regulations } from '../src/regulations.js';
import { parseTrack, parseTrackMeta, type Track } from '../src/track.js';

export const rulesYaml = readFileSync(new URL('../../../data/regulations/2026.yaml', import.meta.url), 'utf8');
export const modelYaml = readFileSync(new URL('../../../data/model/2026.yaml', import.meta.url), 'utf8');
export const regs: Regulations = parseRegulations(rulesYaml, modelYaml);

/** M1 가상 서킷 (DESIGN.md 16절). */
export const TRACK_IDS = ['fast-oval', 'mixed', 'tight-street'] as const;
export type TrackId = (typeof TRACK_IDS)[number];

export function trackFiles(id: string): { csv: string; yaml: string } {
  const dir = new URL('../../../data/tracks/', import.meta.url);
  return { csv: readFileSync(new URL(`${id}.csv`, dir), 'utf8'), yaml: readFileSync(new URL(`${id}.yaml`, dir), 'utf8') };
}

export function loadTrack(id: string): Track {
  const { csv, yaml } = trackFiles(id);
  return parseTrack(csv, parseTrackMeta(yaml), regs);
}

export const tracks: Record<TrackId, Track> = {
  'fast-oval': loadTrack('fast-oval'),
  mixed: loadTrack('mixed'),
  'tight-street': loadTrack('tight-street'),
};

/** DESIGN.md 4절 제출 예시 그대로. */
export const docExampleSpec: CarSpec = {
  powertrain: { thermal_efficiency: 0.72, reliability: 0.6, ers_capacity: 0.8, cooling: 0.4 },
  chassis: { weight_reduction: 0.9, mech_grip: 0.7, tire_management: 0.5, wheelbase: 'long' },
  aero: { aero_efficiency: 0.85, philosophy: 'floor', dirty_air_resistance: 0.3, drs_effect: 0.6 },
};

/** 모든 연속 파라미터를 x로. */
export function uniformSpec(x: number, arch: Partial<Pick<CarSpec['aero'], 'philosophy'>> = {}): CarSpec {
  return {
    powertrain: { thermal_efficiency: x, reliability: x, ers_capacity: x, cooling: x },
    chassis: { weight_reduction: x, mech_grip: x, tire_management: x, wheelbase: 'long' },
    aero: { aero_efficiency: x, philosophy: arch.philosophy ?? 'wing', dirty_air_resistance: x, drs_effect: x },
  };
}

export interface SpecPatch {
  readonly powertrain?: Partial<CarSpec['powertrain']>;
  readonly chassis?: Partial<CarSpec['chassis']>;
  readonly aero?: Partial<CarSpec['aero']>;
}

export function withSpec(base: CarSpec, patch: SpecPatch): CarSpec {
  return {
    powertrain: { ...base.powertrain, ...patch.powertrain },
    chassis: { ...base.chassis, ...patch.chassis },
    aero: { ...base.aero, ...patch.aero },
  };
}

export const baseSpec: CarSpec = uniformSpec(0.5);
export const baseSetup: Setup = { wing_level: 5, ride_height: 'mid', ers_mode: 'balanced' };
/** 범프가 거의 없는 온화한 트랙. */
export const smoothTrack: DeriveTrackInput = { length_m: 5000, bumpiness: 0.1, temp_mean: 22 };
/** 범피한 트랙 (bumpy_from 0.5 위). */
export const bumpyTrack: DeriveTrackInput = { length_m: 3400, bumpiness: 0.9, temp_mean: 22 };

// ── fast-check arbitraries ─────────────────────────────────────────────

const unit = fc.double({ min: 0, max: 1, noNaN: true });

export const specArb: fc.Arbitrary<CarSpec> = fc.record({
  powertrain: fc.record({ thermal_efficiency: unit, reliability: unit, ers_capacity: unit, cooling: unit }),
  chassis: fc.record({
    weight_reduction: unit,
    mech_grip: unit,
    tire_management: unit,
    wheelbase: fc.constantFrom('short' as const, 'long' as const),
  }),
  aero: fc.record({
    aero_efficiency: unit,
    philosophy: fc.constantFrom('floor' as const, 'wing' as const),
    dirty_air_resistance: unit,
    drs_effect: unit,
  }),
});

export const setupArb: fc.Arbitrary<Setup> = fc.record({
  wing_level: fc.integer({ min: 0, max: 10 }),
  ride_height: fc.constantFrom('low' as const, 'mid' as const, 'high' as const),
  ers_mode: fc.constantFrom('harvest' as const, 'balanced' as const, 'attack' as const),
});

export const trackArb: fc.Arbitrary<DeriveTrackInput> = fc.record({
  length_m: fc.double({ min: 3000, max: 7500, noNaN: true }),
  bumpiness: unit,
  temp_mean: fc.double({ min: 5, max: 45, noNaN: true }),
});
