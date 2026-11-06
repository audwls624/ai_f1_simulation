import { readFileSync } from 'node:fs';
import { baseLap, derive, makeRng, parseRegulations, parseTrack, parseTrackMeta, profile, validateSpec, type CarSpec, type Track } from '@f1sim/core';
import { describe, expect, it } from 'vitest';
import { heuristicDesign, representativeTrack, type DesignInputs } from '../src/heuristic.js';
import { makeDesignTools } from '../src/tools.js';

const data = new URL('../../../data/', import.meta.url);
const regs = parseRegulations(readFileSync(new URL('regulations/2026.yaml', data), 'utf8'));
const ids = ['fast-oval', 'mixed', 'tight-street'];
const tracks: Track[] = ids.map((id) =>
  parseTrack(readFileSync(new URL(`tracks/${id}.csv`, data), 'utf8'), parseTrackMeta(readFileSync(new URL(`tracks/${id}.yaml`, data), 'utf8')), regs),
);
const inputs: DesignInputs = { cost: regs.cost, tracks: tracks.map((t) => ({ id: t.id, profile: profile(t) })) };
const runs = regs.tools.wind_tunnel.runs_preseason;

describe('heuristicDesign (DESIGN.md §12)', () => {
  it('returns a legal spec and spends at most the wind tunnel budget', () => {
    const tools = makeDesignTools(regs, tracks, runs, makeRng(1));
    const spec = heuristicDesign(inputs, tools);
    expect(validateSpec(spec, regs).ok).toBe(true);
    expect(tools.remaining).toBeGreaterThanOrEqual(0);
    expect(tools.remaining).toBeLessThan(runs);
  });

  it('is deterministic for the same tool seed', () => {
    const a = heuristicDesign(inputs, makeDesignTools(regs, tracks, runs, makeRng(5)));
    const b = heuristicDesign(inputs, makeDesignTools(regs, tracks, runs, makeRng(5)));
    expect(a).toEqual(b);
  });

  it('picks the calendar track closest to the average profile', () => {
    expect(ids).toContain(representativeTrack(inputs.tracks));
    const one = inputs.tracks.slice(0, 1);
    expect(representativeTrack(one)).toBe(one[0]?.id);
  });

  it('beats its uniform starting point on the track it tuned for (noise-free check)', () => {
    const spec = heuristicDesign(inputs, makeDesignTools(regs, tracks, runs, makeRng(2)));
    const track = tracks.find((t) => t.id === representativeTrack(inputs.tracks)) as Track;
    const weightSum = Object.values(regs.cost.weights).reduce((s, w) => s + w, 0);
    const x = Math.min(1, (regs.cost.cap_credits / weightSum) ** (1 / regs.cost.exponent));
    const uniform: CarSpec = {
      powertrain: { thermal_efficiency: x, reliability: x, ers_capacity: x, cooling: x },
      chassis: { weight_reduction: x, mech_grip: x, tire_management: x, wheelbase: 'long' },
      aero: { aero_efficiency: x, philosophy: 'wing', dirty_air_resistance: x, drs_effect: x },
    };
    const lap = (s: CarSpec) => baseLap(derive(s, { wing_level: 6, ride_height: 'mid', ers_mode: 'balanced' }, track, regs), track, 'dry', regs).total;
    expect(lap(spec)).toBeLessThan(lap(uniform));
  });

  it('does nothing without wind tunnel runs', () => {
    const tools = makeDesignTools(regs, tracks, 0, makeRng(1));
    expect(validateSpec(heuristicDesign(inputs, tools), regs).ok).toBe(true);
  });
});
