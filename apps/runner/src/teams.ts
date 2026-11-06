/**
 * 시즌 참가 팀 파일 (러너 설정): 휴리스틱 팀과 코딩 에이전트 팀. 코딩 에이전트는 팀마다 헤드리스(command) 또는 수동.
 * 워크스페이스는 레포 밖에 둔다 (기본: OS 임시 디렉터리) — 에이전트에게 가는 건 공개 규정뿐이다.
 */
import { join } from 'node:path';
import { HeuristicAgent } from '@f1sim/agents';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CodingAgent } from './coding/agent.js';
import type { Team } from './orchestrate.js';

const TeamName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'use 1–32 lowercase letters, digits and dashes');

export const TeamEntrySchema = z.discriminatedUnion('agent', [
  z.strictObject({ team: TeamName, agent: z.literal('heuristic') }),
  z.strictObject({
    team: TeamName,
    agent: z.literal('coding'),
    /** 코딩 에이전트 이름 (cursor, antigravity, opencode, claude-code …) → SeasonLog agent = coding:<label>. */
    label: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    /** SeasonLog teams[].model. */
    model: z.string().min(1).optional(),
    /** 헤드리스 명령 (argv, "{prompt}" 치환). 없으면 수동: 러너가 안내를 내고 제출을 기다린다. */
    command: z.array(z.string().min(1)).min(1).optional(),
  }),
]);
export type TeamEntry = z.infer<typeof TeamEntrySchema>;

export const TeamsFileSchema = z
  .strictObject({ teams: z.array(TeamEntrySchema).min(2) })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.teams.forEach((t, i) => {
      if (seen.has(t.team)) ctx.addIssue({ code: 'custom', path: ['teams', i, 'team'], message: `team "${t.team}" appears twice` });
      seen.add(t.team);
    });
  });
export type TeamsFile = z.infer<typeof TeamsFileSchema>;

export function parseTeamsFile(text: string): TeamsFile {
  return TeamsFileSchema.parse(parseYaml(text));
}

/** 팀 파일 → 오케스트레이터 팀. 코딩 에이전트 팀은 workspaces/<team>/에 워크스페이스를 만든다. */
export function buildTeams(file: TeamsFile, workspaces: string, onEvent?: (message: string) => void): { teams: Team[]; coding: CodingAgent[] } {
  const coding: CodingAgent[] = [];
  const teams = file.teams.map((t): Team => {
    if (t.agent === 'heuristic') return { team: t.team, agent: new HeuristicAgent() };
    const agent = new CodingAgent({
      label: t.label,
      workspace: join(workspaces, t.team),
      ...(t.model !== undefined ? { model: t.model } : {}),
      ...(t.command !== undefined ? { command: t.command } : {}),
      ...(onEvent ? { onEvent } : {}),
    });
    coding.push(agent);
    return { team: t.team, agent };
  });
  return { teams, coding };
}
