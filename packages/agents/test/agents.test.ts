import { readFileSync } from 'node:fs';
import {
  AgentIOLogSchema,
  gpForecast,
  makeRng,
  parseRegulations,
  parseTrack,
  parseTrackMeta,
  shortHash,
  validatePlan,
  type AgentIOLog,
  type CarSpec,
  type GPPlan,
  type Track,
} from '@f1sim/core';
import { describe, expect, it } from 'vitest';
import type { GPPacket, PreseasonPacket, TeamAgent } from '../src/base.js';
import { checkDesignCar, checkPlanGp } from '../src/conformance/index.js';
import { HeuristicAgent, bestWingFromSummary } from '../src/heuristic.js';
import { SUMMARY_WINGS, buildGPPacket, buildPreseasonPacket } from '../src/packets.js';
import { ReplayAgent } from '../src/replay.js';
import { ToolBudgetError, ToolInputError, makeDesignTools, makePlanTools } from '../src/tools.js';

const data = new URL('../../../data/', import.meta.url);
const regs = parseRegulations(
  readFileSync(new URL('regulations/2026.yaml', data), 'utf8'),
  readFileSync(new URL('model/2026.yaml', data), 'utf8'),
);
const load = (id: string): Track =>
  parseTrack(
    readFileSync(new URL(`tracks/${id}.csv`, data), 'utf8'),
    parseTrackMeta(readFileSync(new URL(`tracks/${id}.yaml`, data), 'utf8')),
    regs,
  );
const calendar = ['fast-oval', 'mixed', 'tight-street'].map(load);
const mixed = calendar[1] as Track;

const preseason = (team = 'h1'): PreseasonPacket => buildPreseasonPacket(regs, team, calendar);
const gpPacket = (spec: CarSpec, team = 'h1', track = mixed): GPPacket =>
  buildGPPacket({ regs, team, gp: 2, track, forecast: gpForecast(track, regs, 5), ownSpec: spec, standings: [], lastGp: null });
const designTools = (seed = 1) => makeDesignTools(regs, calendar, regs.tools.wind_tunnel.runs_preseason, makeRng(seed));
const planTools = (spec: CarSpec, team = 'h1', budget = regs.tools.strategy_sim.runs_per_gp, track = mixed) =>
  makePlanTools({
    regs,
    season: 2026,
    gp: 2,
    track,
    forecast: gpForecast(track, regs, 5),
    team,
    ownSpec: spec,
    rivals: ['r1', 'r2', 'r3'].map((t) => ({ team: t, spec: regs.fallback.spec })),
    budget,
    rng: makeRng(77),
  });

describe('packets (DESIGN.md §9)', () => {
  it('carry the public rules only — no engine model', () => {
    const p = preseason() as unknown as { rules: Record<string, unknown> };
    for (const key of ['car', 'laptime', 'physics', 'overtaking', 'ers_battery']) expect(p.rules).not.toHaveProperty(key);
    const g = gpPacket(regs.fallback.spec) as unknown as { rules: Record<string, unknown> };
    expect(g.rules).not.toHaveProperty('car');
  });

  it('preseason: every calendar profile and the wind tunnel budget', () => {
    const p = preseason();
    expect(p.calendar.map((c) => c.track_id)).toEqual(['fast-oval', 'mixed', 'tight-street']);
    expect(p.wind_tunnel_remaining).toBe(regs.tools.wind_tunnel.runs_preseason);
  });

  it('GP: wind tunnel summary for three wing levels, race tyre sets after qualifying', () => {
    const g = gpPacket(regs.fallback.spec);
    expect(g.wind_tunnel_summary.map((s) => s.setup.wing_level)).toEqual([...SUMMARY_WINGS]);
    expect(g.tire_sets.soft).toBe(regs.tires.allocation_sets.soft - regs.tires.qualifying.sets);
    expect(g.strategy_sim_remaining).toBe(regs.tools.strategy_sim.runs_per_gp);
  });
});

describe('strategySim (DESIGN.md §9)', () => {
  const plan = (): GPPlan => {
    const p = gpPacket(regs.fallback.spec);
    return new HeuristicAgent().planGp(p, planTools(regs.fallback.spec, 'h1', 0)) as unknown as GPPlan;
  };

  it('returns a distribution and spends one run per call', async () => {
    const tools = planTools(regs.fallback.spec);
    const r = tools.strategySim(await plan(), 8);
    expect(tools.remaining).toBe(regs.tools.strategy_sim.runs_per_gp - 1);
    expect(r.samples).toBe(8);
    expect(r.position_counts.reduce((s, n) => s + n, 0)).toBe(8);
    expect(r.mean_position).toBeGreaterThanOrEqual(1);
    expect(r.mean_position).toBeLessThanOrEqual(4);
    expect(r.dnf_rate).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic for the tool seed, rejects bad plans without spending, stops at the budget', async () => {
    const p = await plan();
    expect(planTools(regs.fallback.spec).strategySim(p, 4)).toEqual(planTools(regs.fallback.spec).strategySim(p, 4));
    const tools = planTools(regs.fallback.spec, 'h1', 1);
    expect(() => tools.strategySim({ ...p, variants: [] })).toThrow(ToolInputError);
    expect(() => tools.strategySim(p, 0)).toThrow(/nSamples/);
    expect(tools.remaining).toBe(1);
    tools.strategySim(p, 2);
    expect(() => tools.strategySim(p, 2)).toThrow(ToolBudgetError);
  });
});

describe('HeuristicAgent', () => {
  it('passes conformance for designCar and planGp', async () => {
    const agent = new HeuristicAgent();
    const design = await checkDesignCar(agent, preseason(), designTools());
    expect(design.problems).toEqual([]);
    expect(design.ok).toBe(true);
    for (const track of calendar) {
      const spec = design.value as CarSpec;
      const plan = await checkPlanGp(agent, gpPacket(spec, 'h1', track), planTools(spec, 'h1', 5, track));
      expect(plan.problems).toEqual([]);
      expect(plan.warnings).toEqual([]);
    }
  });

  it('plans 1 or 2 stops from its own measured wear, with one SC rule and two rain rules', async () => {
    const spec = regs.fallback.spec;
    const plan = await new HeuristicAgent().planGp(gpPacket(spec), planTools(spec));
    const p = plan.variants[0]?.plan;
    expect([2, 3]).toContain(p?.stints.length);
    expect(p?.rules.map((r) => ('event' in r.when ? r.when.event : r.when.surface))).toEqual(['safety_car', 'rain_start', 'dry']);
    expect(validatePlan(plan, regs, { laps: mixed.laps }).ok).toBe(true);
  });

  it('estimates the best wing from three summary points', () => {
    expect(bestWingFromSummary([{ wing: 2, lap: 60 }, { wing: 5, lap: 58 }, { wing: 8, lap: 60 }])).toBe(5);
    expect(bestWingFromSummary([{ wing: 2, lap: 60 }, { wing: 5, lap: 58 }, { wing: 8, lap: 59 }])).toBe(6); // 꼭짓점 5.5
    expect(bestWingFromSummary([{ wing: 2, lap: 62 }, { wing: 5, lap: 60 }, { wing: 8, lap: 59 }])).toBeGreaterThanOrEqual(8);
  });
});

describe('ReplayAgent (DESIGN.md §11)', () => {
  it('replays recorded final submissions and passes conformance', async () => {
    const heuristic = new HeuristicAgent();
    const spec = await heuristic.designCar(preseason(), designTools());
    const plan = await heuristic.planGp(gpPacket(spec), planTools(spec));
    const line = (call: AgentIOLog['call'], final: unknown, gp?: number): AgentIOLog =>
      AgentIOLogSchema.parse({
        call,
        team: 'h1',
        ...(gp !== undefined ? { gp } : {}),
        packet_hash: shortHash(call),
        tool_calls: [],
        raw_response: JSON.stringify(final),
        validation: { ok: true },
        final,
        fallback_used: false,
        latency_s: 0,
      });
    const jsonl = [line('design_car', spec), line('plan_gp', plan, 2)].map((l) => JSON.stringify(l)).join('\n');
    const replay = ReplayAgent.fromJsonl(jsonl);
    const d = await checkDesignCar(replay, preseason(), designTools());
    expect(d.value).toEqual(spec);
    const g = await checkPlanGp(replay, gpPacket(spec), planTools(spec));
    expect(g.value).toEqual(plan);
    const missing = await checkPlanGp(replay, { ...gpPacket(spec), gp: 9 }, planTools(spec));
    expect(missing.ok).toBe(false);
    expect(missing.problems[0]).toMatch(/no plan_gp record/);
  });
});

describe('conformance catches broken agents', () => {
  const broken = (overrides: Partial<Pick<TeamAgent, 'designCar' | 'planGp'>>): TeamAgent => {
    const base = new HeuristicAgent();
    return {
      kind: 'broken',
      designCar: overrides.designCar ?? ((packet, tools) => base.designCar(packet, tools)),
      planGp: overrides.planGp ?? ((packet, tools) => base.planGp(packet, tools)),
    };
  };

  it('over-budget spec, invalid plan, exceeding the tool budget, and timeouts', async () => {
    const all1: CarSpec = {
      powertrain: { thermal_efficiency: 1, reliability: 1, ers_capacity: 1, cooling: 1 },
      chassis: { weight_reduction: 1, mech_grip: 1, tire_management: 1, wheelbase: 'long' },
      aero: { aero_efficiency: 1, philosophy: 'wing', dirty_air_resistance: 1, drs_effect: 1 },
    };
    const greedy = await checkDesignCar(broken({ designCar: () => Promise.resolve(all1) }), preseason(), designTools());
    expect(greedy.ok).toBe(false);
    expect(greedy.problems[0]).toMatch(/exceeds the cost cap/);

    const badPlan = await checkPlanGp(
      broken({ planGp: () => Promise.resolve({ setup: { wing_level: 12 } } as unknown as GPPlan) }),
      gpPacket(regs.fallback.spec),
      planTools(regs.fallback.spec),
    );
    expect(badPlan.ok).toBe(false);

    const spender = broken({
      designCar: (_p, tools) => {
        for (let i = 0; i <= regs.tools.wind_tunnel.runs_preseason; i++) tools.windTunnel(regs.fallback.spec, regs.fallback.setup, 'mixed');
        return Promise.resolve(regs.fallback.spec);
      },
    });
    const overspent = await checkDesignCar(spender, preseason(), designTools());
    expect(overspent.problems[0]).toMatch(/no runs left/);

    const slowPacket = { ...preseason(), rules: { ...preseason().rules, penalties: { ...preseason().rules.penalties, response_timeout_s: 0.05 } } };
    const sleeper = broken({ designCar: () => new Promise((resolve) => setTimeout(() => resolve(regs.fallback.spec), 300)) });
    const slow = await checkDesignCar(sleeper, slowPacket, designTools());
    expect(slow.problems[0]).toMatch(/no response within 0.05 s/);
  });
});
