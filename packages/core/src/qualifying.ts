/**
 * 예선 (DESIGN.md 7절): quali_lap = base_lap(soft) + warmup_penalty_s + N(0, σ). 한 번만, 건조 노면.
 * 그리드 페널티(3절: 스펙 검증 실패 → 첫 GP 최후위)가 있는 차는 예선 순서를 유지한 채 맨 뒤로.
 */
import type { DerivedPerf } from './car.js';
import type { LapBreakdown } from './laptime.js';
import type { Regulations } from './regulations.js';
import type { Rng } from './rng.js';
import { tireOffset } from './tires.js';

export interface QualiEntry {
  readonly perf: Pick<DerivedPerf, 'warmup_penalty_s'>;
  /** 건조 노면 baseLap (예선 셋업). */
  readonly dryBase: LapBreakdown;
  readonly gridPenalty: boolean;
}

export interface QualiResult {
  readonly lap: number;
  /** 1부터. */
  readonly grid: number;
}

/** entries 순서대로 결과를 돌려준다. rng는 레이스 시드의 qualifying 스트림 (차마다 spawn). */
export function runQualifying(entries: readonly QualiEntry[], regs: Regulations, rng: Rng): QualiResult[] {
  const compound = regs.tires.qualifying.compound;
  const warmupLaps = regs.car.tire_management.warmup_laps.qualifying;
  const laps = entries.map(
    (e, i) =>
      e.dryBase.total +
      tireOffset(compound, 'dry', regs) +
      (warmupLaps > 0 ? e.perf.warmup_penalty_s : 0) +
      rng.spawn(String(i)).normal(0, regs.qualifying.noise_sd_s),
  );
  const order = entries
    .map((e, i) => ({ i, penalty: e.gridPenalty, lap: laps[i] ?? Infinity }))
    .sort((a, b) => Number(a.penalty) - Number(b.penalty) || a.lap - b.lap || a.i - b.i);
  const grid = new Array<number>(entries.length);
  order.forEach((o, k) => {
    grid[o.i] = k + 1;
  });
  return entries.map((_, i) => ({ lap: laps[i] ?? Infinity, grid: grid[i] ?? entries.length }));
}
