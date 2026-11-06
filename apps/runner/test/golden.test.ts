import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentIOLogSchema, GPPlanSchema, type Track } from '@f1sim/core';
import { loadRegulations, loadSeasonTracks, loadTrack } from '@f1sim/harness';
import { afterAll, describe, expect, it } from 'vitest';
import { GoldenManifestSchema, checkGolden, goldenDir, recordGolden } from '../src/golden.js';

const SEASON = 2026;
const SEED = 2026;
const regs = loadRegulations(SEASON);
const calendar = loadSeasonTracks(SEASON, regs);
const dir = goldenDir(SEASON, SEED);
const manifest = () => GoldenManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));

describe('golden log (DESIGN.md §11, §12)', () => {
  it('replaying the golden submissions reproduces season.json and every race.json byte for byte', async () => {
    const check = await checkGolden(dir, regs, calendar);
    const hint =
      `inputs changed: [${check.inputsChanged.join(', ')}], golden made on Node ${check.manifest.node}, now ${check.nodeNow}. ` +
      'If the change is intended: pnpm -F @f1sim/runner golden --update';
    expect(check.inputsChanged, hint).toEqual([]);
    expect(check.mismatches.map((m) => m.path), hint).toEqual([]);
    expect(check.manifest.files).toHaveLength(1 + calendar.length);
  }, 120_000);

  it('records the Node version it was made on — the pinned major (DESIGN.md §11)', () => {
    const m = manifest();
    expect(m.node).toMatch(/^v24\.\d+\.\d+$/);
    expect(m.node.split('.')[0]).toBe(process.version.split('.')[0]);
  });

  it('the golden heuristic season: 10 teams, champion < 1.5 × runner-up (§12 checklist)', () => {
    const m = manifest();
    expect(m.teams).toHaveLength(10);
    expect(m.teams.every((t) => t.agent === 'heuristic')).toBe(true);
    const [first, second] = m.standings;
    expect(first?.points ?? 0).toBeLessThan(1.5 * (second?.points ?? 0));
  });
});

describe('recordGolden / checkGolden', () => {
  const root = mkdtempSync(join(tmpdir(), 'f1sim-golden-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const short: Track[] = ['mixed', 'tight-street'].map((id) => loadTrack(id, regs));

  it('round-trips, and a changed submission shows up as a changed race log', async () => {
    const { dir: d, manifest: m } = await recordGolden({ regs, calendar: short, season: SEASON, seed: 3, teams: 3, root });
    expect(m.files.map((f) => f.path)).toEqual(['season.json', 'gp01_mixed/race.json', 'gp02_tight-street/race.json']);
    expect((await checkGolden(d, regs, short)).mismatches).toEqual([]);

    // 팀 1의 GP 2 플랜 페이스를 바꾼다 → GP 2 레이스 로그가 달라져야 한다 (GP 1은 그대로).
    const file = join(d, 'agents', `${m.teams[0]?.team ?? ''}.jsonl`);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => AgentIOLogSchema.parse(JSON.parse(l)));
    const edited = lines.map((l) => {
      if (l.call !== 'plan_gp' || l.gp !== 2) return l;
      const plan = GPPlanSchema.parse(l.final);
      const variants = plan.variants.map((v) => ({ ...v, plan: { ...v.plan, pace: v.plan.pace === 'push' ? 'conserve' : 'push' } }));
      return { ...l, final: { ...plan, variants } };
    });
    writeFileSync(file, `${edited.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const paths = (await checkGolden(d, regs, short)).mismatches.map((x) => x.path);
    expect(paths).toContain('gp02_tight-street/race.json');
    expect(paths).not.toContain('gp01_mixed/race.json');

    // 입력(트랙)이 바뀌면 지문이 알려 준다.
    expect((await checkGolden(d, regs, [...short].reverse())).inputsChanged).toEqual(['tracks']);
  }, 120_000);
});
