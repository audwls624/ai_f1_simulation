import { readFileSync } from 'node:fs';
import {
  baseLap,
  derive,
  makeRng,
  parseRegulations,
  parseTrack,
  parseTrackMeta,
  type CarSpec,
  type Setup,
  type Track,
} from '@f1sim/core';
import { describe, expect, it } from 'vitest';
import { ToolBudgetError, ToolInputError, makeDesignTools } from '../src/tools.js';

const data = new URL('../../../data/', import.meta.url);
const regs = parseRegulations(readFileSync(new URL('regulations/2026.yaml', data), 'utf8'));
const tracks: Track[] = ['fast-oval', 'mixed', 'tight-street'].map((id) =>
  parseTrack(
    readFileSync(new URL(`tracks/${id}.csv`, data), 'utf8'),
    parseTrackMeta(readFileSync(new URL(`tracks/${id}.yaml`, data), 'utf8')),
    regs,
  ),
);
const spec: CarSpec = regs.fallback.spec;
const setup: Setup = { wing_level: 5, ride_height: 'mid', ers_mode: 'balanced' };

describe('makeDesignTools / windTunnel (DESIGN.md §9, §16)', () => {
  it('runs exactly `budget` times, then throws', () => {
    const tools = makeDesignTools(regs, tracks, 3, makeRng(1));
    for (let left = 2; left >= 0; left--) {
      tools.windTunnel(spec, setup, 'mixed');
      expect(tools.remaining).toBe(left);
    }
    expect(() => tools.windTunnel(spec, setup, 'mixed')).toThrow(ToolBudgetError);
    expect(() => tools.windTunnel(spec, setup, 'mixed')).toThrow('wind_tunnel: no runs left (all 3 runs used)');
  });

  it('starts with the preseason budget from the regulations', () => {
    expect(makeDesignTools(regs, tracks, regs.tools.wind_tunnel.runs_preseason, makeRng(1)).remaining).toBe(20);
  });

  it('same rng seed → same noise; different seed → different noise', () => {
    const run = (seed: number) => {
      const tools = makeDesignTools(regs, tracks, 5, makeRng(seed));
      return Array.from({ length: 5 }, () => tools.windTunnel(spec, setup, 'fast-oval').lap.total);
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('lap.total stays within baseLap ± 0.5 s and the breakdown still adds up', () => {
    const tools = makeDesignTools(regs, tracks, 60, makeRng(7));
    for (const track of tracks) {
      const clean = baseLap(derive(spec, setup, track, regs), track, 'dry', regs);
      for (let k = 0; k < 20; k++) {
        const r = tools.windTunnel(spec, setup, track.id);
        expect(Math.abs(r.lap.total - clean.total)).toBeLessThan(0.5);
        expect(r.lap.straight + r.lap.lowSpeed + r.lap.midSpeed + r.lap.highSpeed).toBeCloseTo(r.lap.total, 9);
        expect(r.lap.topSpeedKph).toBe(clean.topSpeedKph);
        expect(r.noiseSd).toBe(regs.tools.wind_tunnel.noise_sd_s);
        expect(r.wearEstimate).toBeGreaterThan(0);
      }
    }
  });

  it('reports the wear of the reference compound, higher on the more abrasive track', () => {
    const tools = makeDesignTools(regs, tracks, 2, makeRng(1));
    expect(tools.windTunnel(spec, setup, 'mixed').wearEstimate).toBeGreaterThan(
      tools.windTunnel(spec, setup, 'fast-oval').wearEstimate,
    );
  });

  it('rejects bad input with readable messages, without spending a run or a random number', () => {
    const tools = makeDesignTools(regs, tracks, 2, makeRng(9));
    const badSpec = { ...spec, chassis: { ...spec.chassis, mech_grip: 1.4 } };
    const badSetup = { ...setup, wing_level: 12 };
    try {
      tools.windTunnel(badSpec, badSetup, 'monaco');
      throw new Error('expected ToolInputError');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolInputError);
      expect((e as ToolInputError).problems).toEqual([
        'spec.chassis.mech_grip: must be at most 1 (got 1.4)',
        'setup.wing_level: must be at most 10 (got 12)',
        'trackId: unknown track "monaco"; known tracks are fast-oval, mixed, tight-street',
      ]);
    }
    const overBudget = {
      powertrain: { thermal_efficiency: 1, reliability: 1, ers_capacity: 1, cooling: 1 },
      chassis: { weight_reduction: 1, mech_grip: 1, tire_management: 1, wheelbase: 'long' },
      aero: { aero_efficiency: 1, philosophy: 'wing', dirty_air_resistance: 1, drs_effect: 1 },
    } as const;
    expect(() => tools.windTunnel(overBudget, setup, 'mixed')).toThrow(/spec: total cost 106\.00 credits exceeds/);
    expect(tools.remaining).toBe(2);
    // 실패한 호출이 난수를 쓰지 않았으므로, 새 툴의 첫 결과와 같다.
    const fresh = makeDesignTools(regs, tracks, 1, makeRng(9));
    expect(tools.windTunnel(spec, setup, 'mixed')).toEqual(fresh.windTunnel(spec, setup, 'mixed'));
  });

  it('rejects a negative budget and duplicate track ids', () => {
    expect(() => makeDesignTools(regs, tracks, -1, makeRng(1))).toThrow(RangeError);
    const first = tracks[0];
    if (!first) throw new Error('no tracks');
    expect(() => makeDesignTools(regs, [first, first], 1, makeRng(1))).toThrow('duplicate track id');
  });
});
