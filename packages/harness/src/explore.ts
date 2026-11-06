/**
 * 설계 공간 탐색 실행기: 스펙을 뽑고 worker_threads로 나눠 평가한다.
 * 결과는 스펙 순서로 모으므로 워커 수와 무관하게 같다.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { makeRng, type CarSpec, type Track } from '@f1sim/core';
import { loadRegulations, loadSeasonTracks } from './data.js';
import { bestSetupLap, raceOnlyFixed, sampleSpec, seasonTime, type BestLap, type Sampling } from './design.js';

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

export function defaultWorkers(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 1));
}

const FROM_SOURCE = import.meta.url.endsWith('.ts');

function workerUrl(): URL {
  return new URL(FROM_SOURCE ? './design-worker.ts' : './design-worker.js', import.meta.url);
}

/**
 * TS 소스에서 돌 때(tsx CLI, vitest) 워커를 tsx 로더 + 소스 조건으로 띄운다 (부모 플래그는 물려받지 않는다:
 * tsx·vitest 내부 플래그가 섞여 있다). 빌드된 JS면 기본 상속.
 */
function workerExecArgv(): string[] | undefined {
  return FROM_SOURCE ? ['--import', 'tsx', '--conditions=@f1sim/source'] : undefined;
}

function runChunk(season: number, specs: readonly CarSpec[]): Promise<BestLap[][]> {
  return new Promise((resolve, reject) => {
    const execArgv = workerExecArgv();
    const worker = new Worker(workerUrl(), { workerData: { season, specs }, ...(execArgv ? { execArgv } : {}) });
    worker.once('message', (m: BestLap[][]) => {
      resolve(m);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
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
    const size = Math.ceil(specs.length / options.workers);
    const chunks = Array.from({ length: options.workers }, (_, i) => specs.slice(i * size, (i + 1) * size)).filter((c) => c.length > 0);
    results = (await Promise.all(chunks.map((c) => runChunk(options.season, c)))).flat();
  }
  return {
    options,
    tracks,
    specs,
    results,
    seasonTimes: results.map((row) => seasonTime(row.map((r) => r.lap), tracks)),
  };
}
