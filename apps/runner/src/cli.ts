/**
 * 러너 CLI. `pnpm -F @f1sim/runner <command>`.
 *   race    [--gp 7] [--teams 10] [--seed 2026] [--out <dir>]   휴리스틱 팀으로 GP 하나 (프리시즌 설계 → 플랜 → 레이스)
 *   replay  <race.json> [--every 10]                             텍스트 리플레이 + 전략 트레이스
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HeuristicAgent } from '@f1sim/agents';
import { RaceLogSchema, type AgentIOLog, type CarSpec } from '@f1sim/core';
import { loadRegulations, loadSeasonTracks } from '@f1sim/harness';
import { preseasonDesign, runGP, type Team } from './orchestrate.js';
import { formatRace } from './text.js';

const SEASON = 2026;
const RUNS_DIR = fileURLToPath(new URL('../../../runs/', import.meta.url));

async function race(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      gp: { type: 'string', default: '7' },
      teams: { type: 'string', default: '10' },
      seed: { type: 'string', default: String(SEASON) },
      out: { type: 'string' },
    },
  });
  const regs = loadRegulations(SEASON);
  const calendar = loadSeasonTracks(SEASON, regs);
  const gp = Number(values.gp);
  const track = calendar[gp - 1];
  if (!track) throw new Error(`GP ${gp} is not on the ${SEASON} calendar (1–${calendar.length})`);
  const seed = Number(values.seed);
  const teams: Team[] = Array.from({ length: Number(values.teams) }, (_, i) => ({
    team: `heuristic-${String(i + 1).padStart(2, '0')}`,
    agent: new HeuristicAgent(),
  }));

  const logs = new Map<string, AgentIOLog[]>(teams.map((t) => [t.team, []]));
  const specs = new Map<string, CarSpec>();
  const penalties = new Set<string>();
  for (const team of teams) {
    const d = await preseasonDesign(regs, team, calendar, seed);
    specs.set(team.team, d.spec);
    if (d.gridPenalty) penalties.add(team.team);
    logs.get(team.team)?.push(d.log);
  }
  const { race: log, agentLogs } = await runGP({ regs, season: SEASON, seasonSeed: seed, gp, track, teams, specs, gridPenalty: penalties });
  for (const l of agentLogs) logs.get(l.team)?.push(l);

  const dir = values.out ?? join(RUNS_DIR, `${SEASON}-s${seed}`, `gp${String(gp).padStart(2, '0')}_${track.id}`);
  const agentsDir = join(dir, '..', 'agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(dir, 'race.json'), `${JSON.stringify(log, null, 1)}\n`);
  for (const [team, lines] of logs) writeFileSync(join(agentsDir, `${team}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  process.stdout.write(formatRace(log));
  console.log(`\nrace log: ${join(dir, 'race.json')}\nagent logs: ${agentsDir}/`);
}

function replay(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { every: { type: 'string', default: '10' } } });
  const file = positionals[0];
  if (!file) throw new Error('usage: replay <race.json> [--every 10]');
  const log = RaceLogSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  process.stdout.write(formatRace(log, { every: Number(values.every) }));
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'race':
    await race(rest);
    break;
  case 'replay':
    replay(rest);
    break;
  default:
    console.error(`unknown command "${command ?? ''}". commands: race, replay`);
    process.exitCode = 1;
}
