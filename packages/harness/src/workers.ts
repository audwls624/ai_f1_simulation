/** worker_threads 공용: TS 소스에서 돌 때(tsx CLI, vitest)는 워커를 tsx 로더 + 소스 조건으로 띄운다. */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

export function defaultWorkers(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 1));
}

/** 엔트리 파일(같은 디렉터리의 <name>.ts / .js)로 워커 하나를 돌려 메시지 하나를 받는다. */
export function runWorker<T>(from: string, name: string, workerData: unknown): Promise<T> {
  const fromSource = from.endsWith('.ts');
  const url = new URL(`./${name}.${fromSource ? 'ts' : 'js'}`, from);
  // 부모 플래그는 물려받지 않는다 (tsx·vitest 내부 플래그가 섞여 있다). 빌드된 JS면 기본 상속.
  const execArgv = fromSource ? ['--import', 'tsx', '--conditions=@f1sim/source'] : undefined;
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData, ...(execArgv ? { execArgv } : {}) });
    worker.once('message', (m: T) => {
      resolve(m);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
}

/** 작업을 n개 덩어리로 나눈다 (순서 유지). */
export function chunks<T>(items: readonly T[], n: number): T[][] {
  const size = Math.ceil(items.length / Math.max(1, n));
  return Array.from({ length: Math.max(1, n) }, (_, i) => items.slice(i * size, (i + 1) * size)).filter((c) => c.length > 0);
}
