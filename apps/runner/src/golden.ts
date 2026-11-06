/**
 * 골든 로그 (11·12절): 휴리스틱 시즌 하나의 제출물(agents/<team>.jsonl)과 출력 해시를 고정한다.
 * 회귀 테스트는 ReplayAgent로 제출물을 재생해 season.json·race.json이 바이트 단위로 같은지 본다.
 * 보장은 같은 Node 버전까지 (11절 부동소수) — 만든 Node 버전을 매니페스트에 남긴다.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeuristicAgent, ReplayAgent } from '@f1sim/agents';
import { shortHash, type Regulations, type Track } from '@f1sim/core';
import { z } from 'zod';
import { gpDir, runSeason, type SeasonOutcome, type Team } from './orchestrate.js';

export const GOLDEN_DIR = fileURLToPath(new URL('../golden/', import.meta.url));

export const GoldenManifestSchema = z.strictObject({
  schema: z.literal('golden/1'),
  season: z.int(),
  seed: z.int(),
  /** 만든 Node 버전 (process.version). */
  node: z.string(),
  /** 입력 지문: 규정(공개+엔진 모델)과 캘린더 트랙. 다르면 해시가 어긋나는 게 정상이다 → 다시 만든다. */
  inputs: z.strictObject({ regulations: z.string(), tracks: z.string() }),
  teams: z.array(z.strictObject({ team: z.string(), agent: z.string(), model: z.string().optional() })).min(1),
  files: z.array(z.strictObject({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1),
  standings: z.array(z.strictObject({ team: z.string(), points: z.number() })),
});
export type GoldenManifest = z.infer<typeof GoldenManifestSchema>;

export function heuristicTeams(n: number): Team[] {
  return Array.from({ length: n }, (_, i) => ({ team: `heuristic-${String(i + 1).padStart(2, '0')}`, agent: new HeuristicAgent() }));
}

/** 시즌 출력 파일 (runs/<season>-s<seed>/ 기준 상대 경로 → 내용). 러너 CLI가 쓰는 바이트 그대로. */
export function seasonFiles(outcome: SeasonOutcome): [string, string][] {
  return [
    ['season.json', `${JSON.stringify(outcome.log, null, 1)}\n`],
    ...outcome.races.map((race): [string, string] => [`${gpDir(race.meta.gp, race.meta.track)}/race.json`, `${JSON.stringify(race)}\n`]),
  ];
}

/**
 * 제출물 로그 (agents/<team>.jsonl) — 재생의 입력이다. latency_s는 실행마다 달라 바이트 재현 대상이 아니다.
 * 골든에는 latency_s를 0으로 적는다 (다시 만들 때 diff 잡음 방지, 재생은 final만 쓴다).
 */
export function agentFiles(outcome: SeasonOutcome, options: { readonly zeroLatency?: boolean } = {}): [string, string][] {
  return [...outcome.agentLogs].map(([team, lines]) => [
    `agents/${team}.jsonl`,
    `${lines.map((l) => JSON.stringify(options.zeroLatency ? { ...l, latency_s: 0 } : l)).join('\n')}\n`,
  ]);
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const goldenName = (season: number, seed: number) => `${season}-s${seed}`;

export function inputFingerprint(regs: Regulations, calendar: readonly Track[]): GoldenManifest['inputs'] {
  return { regulations: shortHash(regs), tracks: shortHash(calendar) };
}

function replayTeams(manifest: GoldenManifest, jsonl: (team: string) => string): Team[] {
  return manifest.teams.map((t) => ({
    team: t.team,
    agent: ReplayAgent.fromJsonl(jsonl(t.team), { kind: t.agent, ...(t.model !== undefined ? { model: t.model } : {}) }),
  }));
}

export interface GoldenCheck {
  readonly manifest: GoldenManifest;
  /** 입력 지문이 다른 항목 (규정·트랙을 바꿨으면 여기 나온다). */
  readonly inputsChanged: readonly string[];
  readonly mismatches: readonly { readonly path: string; readonly expected: string; readonly actual: string | null }[];
  readonly nodeNow: string;
}

/** 골든 디렉터리의 제출물을 재생해 매니페스트의 해시와 대조한다. */
export async function checkGolden(dir: string, regs: Regulations, calendar: readonly Track[]): Promise<GoldenCheck> {
  const manifest = GoldenManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
  const now = inputFingerprint(regs, calendar);
  const inputsChanged = (['regulations', 'tracks'] as const).filter((k) => now[k] !== manifest.inputs[k]);
  const outcome = await runSeason({
    regs,
    season: manifest.season,
    seed: manifest.seed,
    calendar,
    teams: replayTeams(manifest, (team) => readFileSync(join(dir, 'agents', `${team}.jsonl`), 'utf8')),
  });
  const actual = new Map(seasonFiles(outcome).map(([path, text]) => [path, sha256(text)]));
  const mismatches = manifest.files
    .filter((f) => actual.get(f.path) !== f.sha256)
    .map((f) => ({ path: f.path, expected: f.sha256, actual: actual.get(f.path) ?? null }));
  for (const path of actual.keys()) {
    if (!manifest.files.some((f) => f.path === path)) mismatches.push({ path, expected: '(not in golden)', actual: actual.get(path) ?? null });
  }
  return { manifest, inputsChanged, mismatches, nodeNow: process.version };
}

/**
 * 휴리스틱 팀으로 시즌을 돌려 골든을 새로 만든다. 쓰기 전에 제출물을 재생해 같은 출력이 나오는지 확인한다.
 * 반환: 쓴 디렉터리와 매니페스트.
 */
export async function recordGolden(args: {
  readonly regs: Regulations;
  readonly calendar: readonly Track[];
  readonly season: number;
  readonly seed: number;
  readonly teams: number;
  readonly root?: string;
}): Promise<{ dir: string; manifest: GoldenManifest }> {
  const teams = heuristicTeams(args.teams);
  const outcome = await runSeason({ regs: args.regs, season: args.season, seed: args.seed, calendar: args.calendar, teams });
  const files = seasonFiles(outcome);
  const agents = new Map(agentFiles(outcome, { zeroLatency: true }));
  const manifest: GoldenManifest = {
    schema: 'golden/1',
    season: args.season,
    seed: args.seed,
    node: process.version,
    inputs: inputFingerprint(args.regs, args.calendar),
    teams: outcome.log.teams.map((t) => ({ team: t.team, agent: t.agent, ...(t.model !== undefined ? { model: t.model } : {}) })),
    files: files.map(([path, text]) => ({ path, sha256: sha256(text) })),
    standings: outcome.log.standings.map((s) => ({ team: s.team, points: s.points })),
  };
  const replayed = await runSeason({
    regs: args.regs,
    season: args.season,
    seed: args.seed,
    calendar: args.calendar,
    teams: replayTeams(manifest, (team) => agents.get(`agents/${team}.jsonl`) ?? ''),
  });
  const again = seasonFiles(replayed);
  files.forEach(([path, text], i) => {
    if (again[i]?.[0] !== path || again[i][1] !== text) throw new Error(`golden: replaying the submissions does not reproduce ${path}`);
  });

  const dir = goldenDir(args.season, args.seed, args.root);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of agents) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  return { dir, manifest };
}

export function goldenDir(season: number, seed: number, root = GOLDEN_DIR): string {
  return join(root, goldenName(season, seed));
}
