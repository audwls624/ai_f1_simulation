/**
 * 전략 공간 탐색 실행기 (12절): 설계 탐색에서 다양한 고정 스펙 10개를 고르고,
 * 트랙마다 랜덤 플랜을 만들어 (스펙 × 시드)로 레이스한다. 라이벌 9대는 그 스펙의 휴리스틱 플랜.
 * 모든 플랜이 같은 시드 묶음을 쓴다 (공통 난수 → 플랜 차이가 운이 아니라 전략에서 나온다).
 */
import { buildGPPacket, heuristicPlan, makePlanTools } from '@f1sim/agents';
import { deriveSeed, gpForecast, makeRng, type CarSpec, type GPPlan, type Setup, type Track } from '@f1sim/core';
import { loadRegulations, loadTrack } from './data.js';
import { bestSetupLap } from './design.js';
import { runDesignExploration } from './explore.js';
import { pickDiverseSpecs, randomPlan, type StrategySample } from './strategy.js';
import { chunks, runWorker } from './workers.js';

export interface StrategyRunOptions {
  readonly season: number;
  readonly seed: number;
  /** 랜덤 플랜 총수 (트랙에 고르게 나눈다). */
  readonly plans: number;
  readonly seeds: number;
  readonly trackIds: readonly string[];
  readonly specCount: number;
  /** 고정 스펙을 고를 설계 탐색의 스펙 수. */
  readonly designSpecs: number;
  readonly workers: number;
}

export interface StrategyRun {
  readonly options: StrategyRunOptions;
  readonly tracks: readonly Track[];
  readonly specs: readonly CarSpec[];
  /** plans[k] = { track 인덱스, 플랜 } (셋업은 스펙마다 그 스펙의 최적 셋업으로 바꿔 끼운다). */
  readonly plans: readonly { readonly track: number; readonly plan: GPPlan }[];
  readonly samples: readonly StrategySample[];
  /** 참고용 기준선: 전원 휴리스틱 플랜, (스펙 × 트랙 × 시드), plan = -1. 지표 4–6에는 안 들어간다. */
  readonly baseline: readonly StrategySample[];
}

export const DEFAULT_STRATEGY_TRACKS = ['fast-oval', 'mixed', 'tight-street', 'highland'] as const;

export async function runStrategyExploration(options: StrategyRunOptions): Promise<StrategyRun> {
  const regs = loadRegulations(options.season);
  const design = await runDesignExploration({
    season: options.season,
    count: options.designSpecs,
    seed: options.seed,
    sampling: 'budget-surface',
    // 레이스를 돌릴 차이므로 레이스 전용 파라미터(신뢰성 등)를 아끼지 않은 스펙에서 고른다 (랩타임 상위만 고르면 신뢰성이 바닥이다).
    fixRaceOnly: true,
    workers: options.workers,
  });
  const specs = pickDiverseSpecs(design.specs, design.seasonTimes, options.specCount);
  const tracks = options.trackIds.map((id) => loadTrack(id, regs));
  const perTrack = Math.ceil(options.plans / tracks.length);
  const rng = makeRng(options.seed).spawn('strategy-plans');
  const plans: { track: number; plan: GPPlan }[] = [];
  const samples: StrategySample[] = [];
  const baseline: StrategySample[] = [];

  for (let t = 0; t < tracks.length; t++) {
    const track = tracks[t] as Track;
    const setups: Setup[] = specs.map((spec) => bestSetupLap(spec, track, regs).setup);
    const rivalPlans: GPPlan[] = specs.map((spec, i) => {
      const forecast = gpForecast(track, regs, options.seed);
      const packet = buildGPPacket({ regs, team: `s${i}`, gp: 1, track, forecast, ownSpec: spec, standings: [], lastGp: null });
      const noSims = makePlanTools({ regs, season: options.season, gp: 1, track, forecast, team: `s${i}`, ownSpec: spec, rivals: [], budget: 0, rng });
      return heuristicPlan(packet, noSims);
    });
    const trackPlans = Array.from({ length: perTrack }, (_, k) => ({
      index: plans.length + k,
      plan: randomPlan(track, regs, rng.spawn(`${track.id}/${k}`), setups[0] as Setup),
    }));
    for (const p of trackPlans) plans.push({ track: t, plan: p.plan });
    const seeds = Array.from({ length: options.seeds }, (_, k) => deriveSeed(options.seed, `strategy:${track.id}:${k}`));
    const job = { season: options.season, trackId: track.id, trackIndex: t, specs, setups, rivalPlans, seeds };
    const [base, ...results] = await Promise.all([
      runWorker<StrategySample[]>(import.meta.url, 'strategy-worker', { ...job, plans: [], baseline: true }),
      ...chunks(trackPlans, options.workers).map((part) => runWorker<StrategySample[]>(import.meta.url, 'strategy-worker', { ...job, plans: part })),
    ]);
    baseline.push(...(base ?? []));
    for (const r of results) samples.push(...r);
  }
  return { options, tracks, specs, plans, samples, baseline };
}
