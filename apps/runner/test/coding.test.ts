import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeuristicAgent, ReplayAgent, buildPreseasonPacket, checkDesignCar, makeDesignTools } from '@f1sim/agents';
import { AgentIOLogSchema, SeasonLogSchema, makeRng, type Regulations, type Track } from '@f1sim/core';
import { loadRegulations, loadTrack } from '@f1sim/harness';
import { afterAll, describe, expect, it } from 'vitest';
import { CodingAgent } from '../src/coding/agent.js';
import { seasonFiles } from '../src/golden.js';
import { preseasonDesign, runSeason, type Team } from '../src/orchestrate.js';
import { parseTeamsFile } from '../src/teams.js';

const regs = loadRegulations(2026);
const calendar: Track[] = ['mixed', 'tight-street'].map((id) => loadTrack(id, regs));
const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'f1sim-coding-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const agents: CodingAgent[] = [];
afterAll(() => agents.forEach((a) => a.dispose()));
function fake(mode: string, extra: { command?: readonly string[] | null; onEvent?: (m: string) => void } = {}): CodingAgent {
  n += 1;
  const a = new CodingAgent({
    label: 'fake',
    model: 'fake-1',
    workspace: join(root, `ws${n}`),
    ...(extra.command === null ? {} : { command: extra.command ?? ['node', FAKE, mode] }),
    pollMs: 20,
    ...(extra.onEvent ? { onEvent: extra.onEvent } : {}),
  });
  agents.push(a);
  return a;
}
const designTools = (r: Regulations = regs) => makeDesignTools(r, calendar, r.tools.wind_tunnel.runs_preseason, makeRng(1));
const preseason = (team: string, r: Regulations = regs) => buildPreseasonPacket(r, team, calendar);
const HALF = 0.5;

describe('CodingAgent (DESIGN.md §9: coding agents in a team workspace)', () => {
  it('prepares the workspace, serves the tools through ./f1sim and returns the submission', async () => {
    const agent = fake('good');
    const tools = designTools();
    const spec = await agent.designCar(preseason('t1'), tools);
    expect(spec.chassis.mech_grip).toBe(HALF);
    expect(tools.remaining).toBe(regs.tools.wind_tunnel.runs_preseason - 2);
    for (const f of ['BRIEF.md', 'TASK.md', 'packet.json', 'f1sim', 'schemas/car-spec.schema.json', 'schemas/gp-plan.schema.json']) {
      expect(existsSync(join(agent.workspace, f))).toBe(true);
    }
    expect(readFileSync(join(agent.workspace, 'BRIEF.md'), 'utf8')).not.toMatch(/failure_rate|mech_grip_mu|aero_grip/); // 엔진 모델 계수 없음
    expect(agent.takeReport()?.raw_response).toBe(readFileSync(join(agent.workspace, 'answer.json'), 'utf8'));
    expect(agent.takeReport()).toBeUndefined();
  }, 30_000);

  it('passes the designCar conformance check', async () => {
    const report = await checkDesignCar(fake('good'), preseason('t2'), designTools());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  }, 30_000);

  it('over-budget runs are refused by the runner; the budget never goes below zero', async () => {
    const agent = fake('greedy');
    const tools = designTools();
    await agent.designCar(preseason('t3'), tools);
    expect(tools.remaining).toBe(0);
    const notes = JSON.parse(readFileSync(join(agent.workspace, 'notes.json'), 'utf8')) as { code: number; err: string }[];
    expect(notes.at(-1)).toMatchObject({ code: 1 });
    expect(notes.at(-1)?.err).toMatch(/no runs left/);
  }, 60_000);

  it('a rejected first submission is answered in the same session and the resubmission is used (orchestrator)', async () => {
    const out = await preseasonDesign(regs, { team: 't4', agent: fake('bad-first') }, calendar, 7);
    expect(out.log.validation.ok).toBe(false);
    expect(out.log.validation.errors?.[0]).toMatch(/mech_grip/);
    expect(out.log.resubmission?.validation.ok).toBe(true);
    expect(out.log.fallback_used).toBe(false);
    expect(out.gridPenalty).toBe(false);
    expect(out.spec.chassis.mech_grip).toBe(HALF);
    expect(out.log.raw_response).toMatch(/1\.5/);
    expect(out.log.tool_calls.filter((c) => c.tool === 'wind_tunnel')).toHaveLength(2);
  }, 30_000);

  it('an agent that exits without submitting is relaunched once with the error, then the fallback applies', async () => {
    const out = await preseasonDesign(regs, { team: 't5', agent: fake('silent') }, calendar, 7);
    expect(out.log.validation.errors).toEqual(['the coding agent exited without submitting']);
    expect(out.log.resubmission?.validation.ok).toBe(false);
    expect(out.gridPenalty).toBe(true);
    expect(out.spec).toEqual(regs.fallback.spec);
  }, 30_000);

  it('enforces the response time limit and stops the agent process', async () => {
    const quick: Regulations = { ...regs, penalties: { ...regs.penalties, response_timeout_s: 1 } };
    const agent = fake('slow');
    await expect(agent.designCar(preseason('t6', quick), designTools(quick))).rejects.toThrow('no response within 1 s');
  }, 30_000);

  it('manual mode: announces the workspace and waits until someone runs the agent there', async () => {
    const events: string[] = [];
    const agent = fake('good', { command: null, onEvent: (m) => events.push(m) });
    const pending = agent.designCar(preseason('t7'), designTools());
    await new Promise((r) => setTimeout(r, 100));
    expect(events.join('\n')).toMatch(/open .* in the team's coding agent and ask it to follow TASK\.md/);
    // 사람이 에이전트를 연다 (비동기로 — 러너가 같은 프로세스에서 요청을 받아야 한다):
    const exit = new Promise<number | null>((resolve) => spawn('node', [FAKE, 'good'], { cwd: agent.workspace, stdio: 'ignore' }).once('exit', resolve));
    expect((await pending).chassis.mech_grip).toBe(HALF);
    expect(await exit).toBe(0);
  }, 30_000);
});

describe('a season with a coding agent team (DESIGN.md §13 M5)', () => {
  it('logs every call, and replaying the logs reproduces season.json and the race logs byte for byte', async () => {
    const teams: Team[] = [
      { team: 'coder', agent: fake('good') },
      { team: 'h1', agent: new HeuristicAgent() },
      { team: 'h2', agent: new HeuristicAgent() },
    ];
    const original = await runSeason({ regs, season: 2026, seed: 11, calendar, teams });
    expect(SeasonLogSchema.parse(original.log).teams[0]).toMatchObject({ team: 'coder', agent: 'coding:fake', model: 'fake-1' });
    const logs = original.agentLogs.get('coder') ?? [];
    expect(logs.map((l) => l.call)).toEqual(['design_car', 'plan_gp', 'plan_gp']);
    for (const l of logs) {
      expect(AgentIOLogSchema.safeParse(l).success).toBe(true);
      expect(l.fallback_used).toBe(false);
    }
    expect(logs.slice(1).every((l) => l.tool_calls.length === 1 && l.tool_calls[0]?.tool === 'strategy_sim')).toBe(true);

    const replay = (team: string, kind: string, model?: string) =>
      ReplayAgent.fromJsonl((original.agentLogs.get(team) ?? []).map((l) => JSON.stringify(l)).join('\n'), { kind, ...(model ? { model } : {}) });
    const replayed = await runSeason({
      regs,
      season: 2026,
      seed: 11,
      calendar,
      teams: [
        { team: 'coder', agent: replay('coder', 'coding:fake', 'fake-1') },
        { team: 'h1', agent: replay('h1', 'heuristic') },
        { team: 'h2', agent: replay('h2', 'heuristic') },
      ],
    });
    expect(seasonFiles(replayed)).toEqual(seasonFiles(original));
  }, 60_000);
});

describe('teams file', () => {
  it('parses heuristic and coding teams (headless or manual) and rejects mistakes', () => {
    const file = parseTeamsFile(
      [
        'teams:',
        '  - { team: claude, agent: coding, label: claude-code, model: claude-opus-5-5, command: [claude, -p, "{prompt}"] }',
        '  - { team: gemini, agent: coding, label: antigravity }',
        '  - { team: heuristic-01, agent: heuristic }',
      ].join('\n'),
    );
    expect(file.teams.map((t) => t.agent)).toEqual(['coding', 'coding', 'heuristic']);
    expect(() => parseTeamsFile('teams:\n  - { team: a, agent: heuristic }\n  - { team: a, agent: heuristic }\n')).toThrow(/appears twice/);
    expect(() => parseTeamsFile('teams:\n  - { team: a, agent: robot }\n  - { team: b, agent: heuristic }\n')).toThrow();
    const example = parseTeamsFile(readFileSync(fileURLToPath(new URL('../teams.example.yaml', import.meta.url)), 'utf8'));
    expect(example.teams).toHaveLength(10);
  });
});
