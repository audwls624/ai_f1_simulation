import { HeuristicAgent, type TeamAgent } from '@f1sim/agents';
import { SeasonLogSchema, standings, type CarSpec, type Track } from '@f1sim/core';
import { loadRegulations, loadTrack } from '@f1sim/harness';
import { describe, expect, it } from 'vitest';
import { runSeason, type Team } from '../src/orchestrate.js';

const regs = loadRegulations(2026);
const calendar: Track[] = ['tight-street', 'fast-oval', 'mixed'].map((id) => loadTrack(id, regs));

describe('runSeason (DESIGN.md §2, §10)', () => {
  it('runs every GP, keeps standings consistent with the race results, and writes a valid SeasonLog', async () => {
    const teams: Team[] = ['a', 'b', 'c'].map((team) => ({ team, agent: new HeuristicAgent() }));
    const out = await runSeason({ regs, season: 2026, seed: 5, calendar, teams });
    expect(out.races.map((r) => r.meta.track)).toEqual(['tight-street', 'fast-oval', 'mixed']);
    expect(SeasonLogSchema.safeParse(out.log).success).toBe(true);
    expect(out.log.gps.map((g) => g.winner)).toEqual(out.races.map((r) => r.result[0]?.team));
    expect(out.log.gps[0]?.race).toBe('gp01_tight-street/race.json');
    const expected = standings(['a', 'b', 'c'], out.races.map((r) => r.result));
    expect(out.log.standings).toEqual(expected.map((r) => ({ team: r.team, points: r.points, pos: r.pos })));
    // GP 패킷에 그때까지의 순위가 들어간다 → GP마다 packet_hash가 다르다.
    const hashes = (out.agentLogs.get('a') ?? []).filter((l) => l.call === 'plan_gp').map((l) => l.packet_hash);
    expect(new Set(hashes).size).toBe(3);
  }, 120_000);

  it('the spec-failure grid penalty applies to the first GP only (DESIGN.md §3)', async () => {
    const heuristic = new HeuristicAgent();
    const bad: TeamAgent = {
      kind: 'bad',
      designCar: () => Promise.resolve({} as CarSpec),
      planGp: (p, t) => heuristic.planGp(p, t),
    };
    const teams: Team[] = [{ team: 'bad', agent: bad }, { team: 'x', agent: new HeuristicAgent() }];
    const out = await runSeason({ regs, season: 2026, seed: 6, calendar: calendar.slice(0, 2), teams });
    expect(out.races[0]?.cars.find((c) => c.team === 'bad')?.grid).toBe(2);
    expect(out.specs.get('bad')).toEqual(regs.fallback.spec);
    const second = out.races[1]?.cars.find((c) => c.team === 'bad');
    const other = out.races[1]?.cars.find((c) => c.team === 'x');
    expect((second?.quali_lap ?? 0) < (other?.quali_lap ?? 0) ? second?.grid : 1).toBe(1);
  }, 120_000);
});
