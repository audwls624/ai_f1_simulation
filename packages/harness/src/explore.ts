/**
 * 설계 공간 탐색 실행기: 스펙을 뽑고 worker_threads로 나눠 평가한다.
 * 결과는 스펙 순서로 모으므로 워커 수와 무관하게 같다.
 */
import { makeRng, type CarSpec, type Track } from '@f1sim/core';
import { loadRegulations, loadSeasonTracks } from './data.js';
import { bestSetupLap, raceOnlyFixed, sampleSpec, seasonTime, type BestLap, type Sampling } from './design.js';
import { chunks, defaultWorkers, runWorker } from './workers.js';

export { defaultWorkers };

export interface DesignRunOptions {
  readonly season: number;
  readonly count: number;
  readonly seed: number;
  readonly sampling: Sampling;
  /** 레이스 전용 파라미터를 균등 배분값으로 고정 (기본 true, design.ts RACE_ONLY_PARAMS 참고). */
  readonly fixRaceOnly: boolean;
  /** 1이면 메인 스레드에서 직접 돈다 (테스트용). */
  readonly workers: number;
}

export interface DesignRun {
  readonly options: DesignRunOptions;
  readonly tracks: readonly Track[];
  readonly specs: readonly CarSpec[];
  /** results[spec][track] */
  readonly results: readonly (readonly BestLap[])[];
  readonly seasonTimes: readonly number[];
}

export async function runDesignExploration(options: DesignRunOptions): Promise<DesignRun> {
  const regs = loadRegulations(options.season);
  const tracks = loadSeasonTracks(options.season, regs);
  const rng = makeRng(options.seed).spawn('design-specs');
  const fixed = options.fixRaceOnly ? raceOnlyFixed(regs) : {};
  const specs = Array.from({ length: options.count }, () => sampleSpec(regs, rng, { sampling: options.sampling, fixed }));

  let results: BestLap[][];
  if (options.workers <= 1) {
    results = specs.map((spec) => tracks.map((track) => bestSetupLap(spec, track, regs)));
  } else {
    const parts = chunks(specs, options.workers);
    results = (await Promise.all(parts.map((c) => runWorker<BestLap[][]>(import.meta.url, 'design-worker', { season: options.season, specs: c })))).flat();
  }
  return {
    options,
    tracks,
    specs,
    results,
    seasonTimes: results.map((row) => seasonTime(row.map((r) => r.lap), tracks)),
  };
}
