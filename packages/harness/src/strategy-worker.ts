// worker_threads 엔트리: 플랜 덩어리를 (스펙 × 시드)로 레이스 돌려 랜덤 플랜 차의 결과를 돌려준다.
import { parentPort, workerData } from 'node:worker_threads';
import { gpForecast, runRace, type CarSpec, type GPPlan, type RaceLog, type Setup } from '@f1sim/core';
import { loadRegulations, loadTrack } from './data.js';
import type { StrategySample } from './strategy.js';

interface Job {
  readonly season: number;
  readonly trackId: string;
  readonly trackIndex: number;
  readonly specs: CarSpec[];
  readonly setups: Setup[];
  readonly rivalPlans: GPPlan[];
  readonly plans: { index: number; plan: GPPlan }[];
  readonly seeds: number[];
  /** true면 plans 대신 전원 휴리스틱 플랜으로 시드마다 한 번 (기준선, plan = -1). */
  readonly baseline?: boolean;
}

const job = workerData as Job;
const regs = loadRegulations(job.season);
const track = loadTrack(job.trackId, regs);
const forecasts = job.seeds.map((seed) => gpForecast(track, regs, seed));
const out: StrategySample[] = [];
const flags = (log: RaceLog) => ({
  sc: log.events.some((e) => e.type === 'safety_car'),
  rain: log.meta.weather_realized.rain.length > 0,
  anyDnf: log.result.some((r) => r.status === 'retired'),
});
const sampleOf = (log: RaceLog, i: number, plan: number, k: number): StrategySample => {
  const me = log.result.find((r) => r.team === `s${i}`);
  return {
    spec: i,
    plan,
    track: job.trackIndex,
    seed: k,
    pos: me?.pos ?? job.specs.length,
    time: me?.time ?? null,
    fallbacks: log.strategy_trace.filter((t) => t.car === `s${i}` && t.source.startsWith('fallback')).length,
    pits: log.events.filter((e) => e.type === 'pit' && e.car === `s${i}`).length,
    ...flags(log),
  };
};
if (job.baseline) {
  const entries = job.specs.map((spec, j) => ({ team: `s${j}`, spec, plan: job.rivalPlans[j] as GPPlan }));
  job.seeds.forEach((seed, k) => {
    const log = runRace({ season: job.season, gp: 1, track, forecast: forecasts[k] ?? [], entries, seed, regs });
    for (let i = 0; i < job.specs.length; i++) out.push(sampleOf(log, i, -1, k));
  });
}
for (const { index, plan } of job.plans) {
  for (let i = 0; i < job.specs.length; i++) {
    const mine: GPPlan = { ...plan, setup: job.setups[i] as Setup };
    const entries = job.specs.map((spec, j) => ({ team: `s${j}`, spec, plan: j === i ? mine : (job.rivalPlans[j] as GPPlan) }));
    job.seeds.forEach((seed, k) => {
      const log = runRace({ season: job.season, gp: 1, track, forecast: forecasts[k] ?? [], entries, seed, regs });
      out.push(sampleOf(log, i, index, k));
    });
  }
}
parentPort?.postMessage(out);
