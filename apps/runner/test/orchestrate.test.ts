import { HeuristicAgent, ReplayAgent, type TeamAgent } from '@f1sim/agents';
import { AgentIOLogSchema, RaceLogSchema, type AgentIOLog, type CarSpec, type Track } from '@f1sim/core';
import { loadRegulations, loadSeasonTracks } from '@f1sim/harness';
import { describe, expect, it } from 'vitest';
import { preseasonDesign, runGP, type Team } from '../src/orchestrate.js';
import { formatRace } from '../src/text.js';

const regs = loadRegulations(2026);
const calendar = loadSeasonTracks(2026, regs);
const GP = 7;
const track = calendar[GP - 1] as Track;
const SEED = 99;

async function season(teams: readonly Team[]) {
  const logs: AgentIOLog[] = [];
  const specs = new Map<string, CarSpec>();
  const penalties = new Set<string>();
  for (const team of teams) {
    const d = await preseasonDesign(regs, team, calendar, SEED);
    specs.set(team.team, d.spec);
    if (d.gridPenalty) penalties.add(team.team);
    logs.push(d.log);
  }
  const gp = await runGP({ regs, season: 2026, seasonSeed: SEED, gp: GP, track, teams, specs, gridPenalty: penalties });
  return { race: gp.race, logs: [...logs, ...gp.agentLogs] };
}

const heuristics = (n: number): Team[] => Array.from({ length: n }, (_, i) => ({ team: `h${i + 1}`, agent: new HeuristicAgent() }));

describe('orchestration (DESIGN.md §2, §9)', () => {
  it('runs a GP with heuristic teams and records valid agent I/O logs', async () => {
    const { race, logs } = await season(heuristics(3));
    expect(RaceLogSchema.safeParse(race).success).toBe(true);
    expect(race.result).toHaveLength(3);
    for (const l of logs) expect(AgentIOLogSchema.safeParse(l).success).toBe(true);
    const design = logs.filter((l) => l.call === 'design_car');
    expect(design).toHaveLength(3);
    for (const d of design) {
      expect(d.tool_calls.length).toBeGreaterThan(0);
      expect(d.tool_calls.length).toBeLessThanOrEqual(regs.tools.wind_tunnel.runs_preseason);
      expect(d.fallback_used).toBe(false);
    }
    for (const p of logs.filter((l) => l.call === 'plan_gp')) {
      expect(p.tool_calls.every((c) => c.tool === 'strategy_sim')).toBe(true);
      expect(p.tool_calls.length).toBeLessThanOrEqual(regs.tools.strategy_sim.runs_per_gp);
    }
  }, 60_000);

  it('replaying the recorded submissions reproduces the race byte for byte (DESIGN.md §11)', async () => {
    const original = await season(heuristics(3));
    const jsonlFor = (team: string) =>
      original.logs
        .filter((l) => l.team === team)
        .map((l) => JSON.stringify(l))
        .join('\n');
    const replayed = await season(
      ['h1', 'h2', 'h3'].map((team) => ({ team, agent: ReplayAgent.fromJsonl(jsonlFor(team)) })),
    );
    expect(JSON.stringify(replayed.race)).toBe(JSON.stringify(original.race));
  }, 60_000);

  it('invalid submissions get one resubmission, then the fallback and the grid penalty (DESIGN.md §3)', async () => {
    const bad: TeamAgent = {
      kind: 'bad',
      designCar: () => Promise.resolve({ powertrain: { turbo: 1 } } as unknown as CarSpec),
      planGp: () => Promise.reject(new Error('model refused')),
    };
    const { race, logs } = await season([{ team: 'bad', agent: bad }, ...heuristics(2)]);
    const design = logs.find((l) => l.team === 'bad' && l.call === 'design_car');
    expect(design?.validation.ok).toBe(false);
    expect(design?.resubmission?.validation.ok).toBe(false);
    expect(design?.fallback_used).toBe(true);
    expect(design?.final).toEqual(regs.fallback.spec);
    expect(race.cars.find((c) => c.team === 'bad')?.grid).toBe(3);
    const plan = logs.find((l) => l.team === 'bad' && l.call === 'plan_gp');
    expect(plan?.validation.errors).toEqual(['model refused']);
    expect(plan?.fallback_used).toBe(true);
  }, 60_000);

  it('formats a text replay with grid, laps, events, result and strategy trace', async () => {
    const { race } = await season(heuristics(2));
    const text = formatRace(race);
    for (const section of ['Grid', 'Laps', 'Events', 'Result', 'Strategy trace']) expect(text).toContain(section);
    expect(text).toMatch(/L\s+\d+\s+h\d\s+(planned|rule\[\d+\]|fallback:\w+)/);
  }, 60_000);
});
