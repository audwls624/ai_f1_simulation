/**
 * 러너 CLI. `pnpm -F @f1sim/runner <command>`.
 *   race    [--gp 7] [--teams 10] [--seed 2026] [--out <dir>]   휴리스틱 팀으로 GP 하나 (프리시즌 설계 → 플랜 → 레이스)
 *   season  [--teams 10] [--seed 2026] [--out <dir>]             휴리스틱 팀으로 시즌 전체 (24전)
 *   replay  <race.json> [--every 10]                             텍스트 리플레이 + 전략 트레이스
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HeuristicAgent } from '@f1sim/agents';
import { RaceLogSchema, type AgentIOLog, type CarSpec } from '@f1sim/core';
import { DATA_DIR, loadRegulations, loadSeasonTracks } from '@f1sim/harness';
import { gpDir, preseasonDesign, runGP, runSeason, type Team } from './orchestrate.js';
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
  const teams = heuristicTeams(Number(values.teams));

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

  const dir = values.out ?? join(RUNS_DIR, `${SEASON}-s${seed}`, gpDir(gp, track.id));
  const agentsDir = join(dir, '..', 'agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(dir, 'race.json'), `${JSON.stringify(log, null, 1)}\n`);
  for (const [team, lines] of logs) writeFileSync(join(agentsDir, `${team}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  process.stdout.write(formatRace(log));
  console.log(`\nrace log: ${join(dir, 'race.json')}\nagent logs: ${agentsDir}/`);
}

function heuristicTeams(n: number): Team[] {
  return Array.from({ length: n }, (_, i) => ({ team: `heuristic-${String(i + 1).padStart(2, '0')}`, agent: new HeuristicAgent() }));
}

async function season(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { teams: { type: 'string', default: '10' }, seed: { type: 'string', default: String(SEASON) }, out: { type: 'string' } },
  });
  const regs = loadRegulations(SEASON);
  const calendar = loadSeasonTracks(SEASON, regs);
  const seed = Number(values.seed);
  const started = performance.now();
  const outcome = await runSeason({
    regs,
    season: SEASON,
    seed,
    calendar,
    teams: heuristicTeams(Number(values.teams)),
    onGp: (gp, r) => console.log(`GP ${String(gp).padStart(2)} ${r.meta.track.padEnd(18)} winner ${r.result[0]?.team ?? '-'}`),
  });
  const dir = values.out ?? join(RUNS_DIR, `${SEASON}-s${seed}`);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'season.json'), `${JSON.stringify(outcome.log, null, 1)}\n`);
  copyFileSync(join(DATA_DIR, 'regulations', `${SEASON}.yaml`), join(dir, 'regulations.yaml'));
  copyFileSync(join(DATA_DIR, 'model', `${SEASON}.yaml`), join(dir, 'model.yaml'));
  for (const race of outcome.races) {
    const gpPath = join(dir, gpDir(race.meta.gp, race.meta.track));
    mkdirSync(gpPath, { recursive: true });
    writeFileSync(join(gpPath, 'race.json'), `${JSON.stringify(race)}\n`);
  }
  for (const [team, lines] of outcome.agentLogs) {
    writeFileSync(join(dir, 'agents', `${team}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  console.log('\nStandings');
  for (const r of outcome.standings) {
    console.log(`  ${String(r.pos).padStart(2)}  ${r.team.padEnd(16)} ${String(r.points).padStart(4)} pts  wins ${r.wins}  DNF ${r.dnfs}`);
  }
  const [first, second] = outcome.standings;
  if (first && second && second.points > 0) {
    console.log(`\nchampion / runner-up points: ${(first.points / second.points).toFixed(2)} (DESIGN.md §12 checklist: < 1.5)`);
  }
  console.log(`season: ${join(dir, 'season.json')} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
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
  case 'season':
    await season(rest);
    break;
  case 'replay':
    replay(rest);
    break;
  default:
    console.error(`unknown command "${command ?? ''}". commands: race, season, replay`);
    process.exitCode = 1;
}
