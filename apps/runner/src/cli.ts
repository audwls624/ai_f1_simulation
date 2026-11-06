/**
 * 러너 CLI. `pnpm -F @f1sim/runner <command>`.
 *   race    [--gp 7] [--teams 10] [--seed 2026] [--out <dir>]   휴리스틱 팀으로 GP 하나 (프리시즌 설계 → 플랜 → 레이스)
 *   season  [--teams 10] [--seed 2026] [--out <dir>]             휴리스틱 팀으로 시즌 전체 (24전)
 *           [--teams-file <teams.yaml>] [--workspaces <dir>] [--tracks a,b] [--gps <n>] [--concurrency <n>]
 *                                                               --tracks: 캘린더 대신 이 트랙들로 (예: spa — 시험용)
 *                                                               팀 파일: 코딩 에이전트 팀 (헤드리스/수동) + 휴리스틱. --gps는 앞 n전만 (시험용)
 *   replay  <race.json> [--every 10]                             텍스트 리플레이 + 전략 트레이스
 *   golden  [--update] [--teams 10] [--seed 2026]                골든 로그 대조 (--update: 휴리스틱 시즌으로 다시 만든다)
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RaceLogSchema, type AgentIOLog, type CarSpec } from '@f1sim/core';
import { DATA_DIR, loadRegulations, loadSeasonTracks, loadTrack } from '@f1sim/harness';
import { agentFiles, checkGolden, goldenDir, heuristicTeams, recordGolden, seasonFiles } from './golden.js';
import { gpDir, preseasonDesign, runGP, runSeason, type Team } from './orchestrate.js';
import { buildTeams, parseTeamsFile } from './teams.js';
import type { CodingAgent } from './coding/agent.js';
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

async function season(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      teams: { type: 'string', default: '10' },
      seed: { type: 'string', default: String(SEASON) },
      out: { type: 'string' },
      'teams-file': { type: 'string' },
      workspaces: { type: 'string' },
      gps: { type: 'string' },
      tracks: { type: 'string' },
      concurrency: { type: 'string' },
    },
  });
  const regs = loadRegulations(SEASON);
  const fullCalendar = values.tracks
    ? values.tracks.split(',').map((id) => loadTrack(id.trim(), regs))
    : loadSeasonTracks(SEASON, regs);
  const calendar = values.gps !== undefined ? fullCalendar.slice(0, Number(values.gps)) : fullCalendar;
  const seed = Number(values.seed);
  const started = performance.now();
  let teams: Team[];
  let coding: CodingAgent[] = [];
  let runName = `${SEASON}-s${seed}`;
  if (values['teams-file']) {
    const file = parseTeamsFile(readFileSync(values['teams-file'], 'utf8'));
    // 레포 밖 (에이전트에게 가는 건 공개 규정뿐). 실행마다 새 디렉터리.
    const workspaces = values.workspaces ?? join(tmpdir(), 'f1sim-workspaces', `${SEASON}-s${seed}-${Date.now().toString(36)}`);
    runName = `${SEASON}-s${seed}-${basename(workspaces)}`.replace(/^(\d+-s\d+)-\1-/, '$1-');
    ({ teams, coding } = buildTeams(file, workspaces, (m) => console.log(`  · ${m}`)));
    if (coding.length > 0) console.log(`coding agent workspaces: ${workspaces}`);
  } else {
    teams = heuristicTeams(Number(values.teams));
  }
  const stop = () => {
    for (const a of coding) a.dispose();
  };
  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });
  const outcome = await runSeason({
    regs,
    season: SEASON,
    seed,
    calendar,
    teams,
    ...(values.concurrency !== undefined ? { concurrency: Number(values.concurrency) } : {}),
    onGp: (gp, r) => console.log(`GP ${String(gp).padStart(2)} ${r.meta.track.padEnd(18)} winner ${r.result[0]?.team ?? '-'}`),
  }).finally(stop);
  // 팀 파일로 돌린 시즌은 워크스페이스 이름을 붙여 따로 남긴다 (같은 시드의 휴리스틱 시즌 결과를 덮어쓰지 않게).
  const dir = values.out ?? join(RUNS_DIR, runName);
  for (const [path, text] of [...seasonFiles(outcome), ...agentFiles(outcome)]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  copyFileSync(join(DATA_DIR, 'regulations', `${SEASON}.yaml`), join(dir, 'regulations.yaml'));
  copyFileSync(join(DATA_DIR, 'model', `${SEASON}.yaml`), join(dir, 'model.yaml'));
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

async function golden(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      update: { type: 'boolean', default: false },
      teams: { type: 'string', default: '10' },
      seed: { type: 'string', default: String(SEASON) },
    },
  });
  const regs = loadRegulations(SEASON);
  const calendar = loadSeasonTracks(SEASON, regs);
  const seed = Number(values.seed);
  if (values.update) {
    const started = performance.now();
    const { dir, manifest } = await recordGolden({ regs, calendar, season: SEASON, seed, teams: Number(values.teams) });
    const [first, second] = manifest.standings;
    console.log(`golden written: ${dir} (${manifest.files.length} files, Node ${manifest.node}, ${((performance.now() - started) / 1000).toFixed(1)} s)`);
    if (first && second) console.log(`champion ${first.team} ${first.points} pts, runner-up ${second.team} ${second.points} pts`);
    return;
  }
  const check = await checkGolden(goldenDir(SEASON, seed), regs, calendar);
  if (check.inputsChanged.length > 0) console.log(`inputs changed since the golden was made: ${check.inputsChanged.join(', ')}`);
  if (check.manifest.node !== check.nodeNow) console.log(`golden made on Node ${check.manifest.node}, now ${check.nodeNow} (DESIGN.md §11)`);
  for (const m of check.mismatches) console.log(`  differs: ${m.path}`);
  if (check.mismatches.length === 0) console.log(`golden ok: ${check.manifest.files.length} files byte-identical`);
  else {
    console.log(`${check.mismatches.length} files differ. If the change is intended: pnpm -F @f1sim/runner golden --update`);
    process.exitCode = 1;
  }
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
  case 'golden':
    await golden(rest);
    break;
  default:
    console.error(`unknown command "${command ?? ''}". commands: race, season, replay, golden`);
    process.exitCode = 1;
}
