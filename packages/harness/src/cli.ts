/**
 * 하네스 CLI. `pnpm -F @f1sim/harness <command>`.
 *   gen-tracks   track-briefs.ts → data/tracks/<id>.csv, .yaml
 *   design       12절 설계 공간 탐색 → reports/<date>-design.md
 *                [--specs 2000] [--seed 2026] [--sampling budget-surface|budget-volume] [--workers N]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { heuristicDesign, makeDesignTools } from '@f1sim/agents';
import { makeRng, parseTrack, profile } from '@f1sim/core';
import { DATA_DIR, loadRegulations } from './data.js';
import { bestSetupLap, seasonTime, type Sampling } from './design.js';
import { defaultWorkers, runDesignExploration } from './explore.js';
import { designMetrics, designReport } from './report.js';
import { TRACK_BRIEFS } from './track-briefs.js';
import { centerlineCsv, generateLayout, metaFor, metaYaml, seedFor } from './trackgen.js';

const SEASON = 2026;

function genTracks(): void {
  const regs = loadRegulations(SEASON);
  for (const brief of TRACK_BRIEFS) {
    const layout = generateLayout(brief, regs, seedFor(brief.id));
    const meta = metaFor(brief, layout);
    const csv = centerlineCsv(brief, layout);
    const p = profile(parseTrack(csv, meta, regs));
    writeFileSync(join(DATA_DIR, 'tracks', `${brief.id}.csv`), csv);
    writeFileSync(join(DATA_DIR, 'tracks', `${brief.id}.yaml`), metaYaml(brief, meta));
    console.log(
      `${brief.id.padEnd(18)} ${(layout.length_m / 1000).toFixed(2)} km  ratio ${p.straight_ratio.toFixed(3)} (brief ${brief.straightRatio})  ` +
        `corners L${p.corners_low}/M${p.corners_mid}/H${p.corners_high} (brief ${brief.corners.low}/${brief.corners.mid}/${brief.corners.high})  seed ${layout.seed}`,
    );
  }
}

const REPORTS_DIR = fileURLToPath(new URL('../reports/', import.meta.url));

async function design(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      specs: { type: 'string', default: '2000' },
      seed: { type: 'string', default: String(SEASON) },
      sampling: { type: 'string', default: 'budget-surface' },
      workers: { type: 'string', default: String(defaultWorkers()) },
    },
  });
  const sampling = values.sampling as Sampling;
  if (sampling !== 'budget-surface' && sampling !== 'budget-volume') throw new Error(`unknown sampling "${sampling}"`);
  const started = performance.now();
  const run = await runDesignExploration({
    season: SEASON,
    count: Number(values.specs),
    seed: Number(values.seed),
    sampling,
    workers: Number(values.workers),
  });
  const regs = loadRegulations(SEASON);
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(REPORTS_DIR, { recursive: true });
  const suffix = sampling === 'budget-surface' ? '' : `-${sampling}`;
  const out = join(REPORTS_DIR, `${date}-design${suffix}.md`);
  writeFileSync(out, designReport(run, regs, date, [heuristicSection(run, regs, Number(values.seed))]));
  const m = designMetrics(run);
  console.log(`metric 1 (max win share): ${(m.metric1.share * 100).toFixed(1)}% ${m.metric1.pass ? 'pass' : 'FAIL'}`);
  console.log(`metric 2 (max variance share): ${m.metric2.top.name} ${(m.metric2.top.share * 100).toFixed(1)}% ${m.metric2.pass ? 'pass' : 'FAIL'}`);
  console.log(`metric 3 (architecture): floor ${m.metric3.floor} wing ${m.metric3.wing} short ${m.metric3.short} long ${m.metric3.long} ${m.metric3.pass ? 'pass' : 'FAIL'}`);
  console.log(`report: ${out} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}

/** 휴리스틱 설계를 같은 조건으로 평가해 랜덤 스펙 분포 안의 위치를 보여준다 (12절: LLM 팀의 기준선). */
function heuristicSection(run: Awaited<ReturnType<typeof runDesignExploration>>, regs: ReturnType<typeof loadRegulations>, seed: number) {
  const tools = makeDesignTools(regs, run.tracks, regs.tools.wind_tunnel.runs_preseason, makeRng(seed).spawn('heuristic-tools'));
  const spec = heuristicDesign({ cost: regs.cost, tracks: run.tracks.map((t) => ({ id: t.id, profile: profile(t) })) }, tools);
  const time = seasonTime(run.tracks.map((t) => bestSetupLap(spec, t, regs).lap), run.tracks);
  const better = run.seasonTimes.filter((x) => x < time).length;
  const bestRandom = Math.min(...run.seasonTimes);
  const body = [
    `- 스펙: ${spec.aero.philosophy}/${spec.chassis.wheelbase}, ` +
      Object.entries({ ...spec.powertrain, ...spec.chassis, ...spec.aero })
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => `${k} ${(v as number).toFixed(2)}`)
        .join(', '),
    `- 시즌 시간 ${time.toFixed(1)} s — 랜덤 스펙 ${run.seasonTimes.length}개 중 ${better}개가 더 빠름 (상위 ${((better / run.seasonTimes.length) * 100).toFixed(1)}%)`,
    `- 랜덤 최고 대비 +${(time - bestRandom).toFixed(1)} s, 풍동 ${regs.tools.wind_tunnel.runs_preseason - tools.remaining}회 사용`,
  ].join('\n');
  return { title: '휴리스틱 설계 (기준선)', body };
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'gen-tracks':
    genTracks();
    break;
  case 'design':
    await design(rest);
    break;
  default:
    console.error(`unknown command "${command ?? ''}". commands: gen-tracks, design`);
    process.exitCode = 1;
}
