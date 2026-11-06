/**
 * 설계 공간 탐색 (DESIGN.md 12절): 랜덤 스펙 × 트랙 → 트랙별 최적 셋업의 기본 랩타임, 지표 1–3.
 * 순수 계산만 여기 두고, 병렬 실행(worker_threads)과 리포트는 explore.ts / report.ts.
 */
import {
  CarSpecSchema,
  ErsModeSchema,
  RideHeightSchema,
  SPEC_PARAMS,
  WING_LEVEL_MAX,
  WING_LEVEL_MIN,
  baseLap,
  cost,
  derive,
  type CarSpec,
  type ErsMode,
  type Regulations,
  type RideHeight,
  type Rng,
  type Setup,
  type Track,
} from '@f1sim/core';

// ── 스펙 샘플링 ────────────────────────────────────────────────────────

export type Sampling = 'budget-surface' | 'budget-volume';

const BISECTION_STEPS = 60;

function specFrom(values: readonly number[], philosophy: 'floor' | 'wing', wheelbase: 'short' | 'long'): CarSpec {
  const v = (key: (typeof SPEC_PARAMS)[number]['key']) => values[SPEC_PARAMS.findIndex((p) => p.key === key)] ?? 0;
  return CarSpecSchema.parse({
    powertrain: {
      thermal_efficiency: v('thermal_efficiency'),
      reliability: v('reliability'),
      ers_capacity: v('ers_capacity'),
      cooling: v('cooling'),
    },
    chassis: { weight_reduction: v('weight_reduction'), mech_grip: v('mech_grip'), tire_management: v('tire_management'), wheelbase },
    aero: { aero_efficiency: v('aero_efficiency'), philosophy, dirty_air_resistance: v('dirty_air_resistance'), drs_effect: v('drs_effect') },
  });
}

/**
 * 랜덤 스펙 한 개.
 * - budget-surface (기본): 방향을 [0,1]^10에서 균등하게 뽑고, 코스트 캡에 닿을 때까지 늘린다 (각 값 ≤ 1).
 *   예산을 다 쓰는 스펙끼리 배분만 비교한다 — 업그레이드가 없으면 남긴 크레딧은 쓸 데가 없다.
 * - budget-volume: 12절 문구 그대로 "예산 제약 내 균등" (거절 샘플링). 평균 지출이 캡의 1/3 정도라
 *   지출 많은 스펙이 어디서나 이기므로 배분 비교에는 덜 맞다.
 * 아키텍처(philosophy, wheelbase)는 각각 반반.
 */
export function sampleSpec(regs: Regulations, rng: Rng, sampling: Sampling = 'budget-surface'): CarSpec {
  const philosophy = rng.next() < 0.5 ? 'floor' : 'wing';
  const wheelbase = rng.next() < 0.5 ? 'short' : 'long';
  const direction = SPEC_PARAMS.map(() => rng.next());
  if (sampling === 'budget-volume') {
    for (;;) {
      const spec = specFrom(direction, philosophy, wheelbase);
      if (cost(spec, regs) <= regs.cost.cap_credits) return spec;
      for (let i = 0; i < direction.length; i++) direction[i] = rng.next();
    }
  }
  const at = (s: number) => specFrom(direction.map((x) => Math.min(1, x * s)), philosophy, wheelbase);
  let lo = 0;
  let hi = 1 / Math.max(Math.min(...direction), Number.MIN_VALUE);
  if (cost(at(hi), regs) <= regs.cost.cap_credits) return at(hi);
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2;
    if (cost(at(mid), regs) <= regs.cost.cap_credits) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

// ── 트랙별 최적 셋업 ───────────────────────────────────────────────────

export interface BestLap {
  readonly lap: number;
  readonly setup: Setup;
}

const WINGS = Array.from({ length: WING_LEVEL_MAX - WING_LEVEL_MIN + 1 }, (_, i) => WING_LEVEL_MIN + i);
const RIDE_HEIGHTS: readonly RideHeight[] = RideHeightSchema.options;
const ERS_MODES: readonly ErsMode[] = ErsModeSchema.options;

/** 이 트랙에서 가장 빠른 셋업 (윙 × 지상고 × ERS 모드 전수, 건조 노면 baseLap). 동률이면 먼저 찾은 것. */
export function bestSetupLap(spec: CarSpec, track: Track, regs: Regulations): BestLap {
  let best: BestLap | null = null;
  for (const ers_mode of ERS_MODES) {
    for (const ride_height of RIDE_HEIGHTS) {
      for (const wing_level of WINGS) {
        const setup: Setup = { wing_level, ride_height, ers_mode };
        const lap = baseLap(derive(spec, setup, track, regs), track, 'dry', regs).total;
        if (!best || lap < best.lap) best = { lap, setup };
      }
    }
  }
  if (!best) throw new Error('no setups to try');
  return best;
}

/** 시즌 총 랩타임 = Σ 트랙 랩 수 × 최적 기본 랩 (12절 지표 2의 목표 변수). */
export function seasonTime(bestLaps: readonly number[], tracks: readonly Track[]): number {
  let total = 0;
  for (let t = 0; t < tracks.length; t++) total += (tracks[t]?.laps ?? 0) * (bestLaps[t] ?? 0);
  return total;
}

// ── 지표 (12절) ────────────────────────────────────────────────────────

/** 지표 1: 한 스펙이 최속인 트랙 비율의 최댓값. winners[t] = 트랙 t에서 가장 빠른 스펙 인덱스. */
export function winners(laps: readonly (readonly number[])[], trackCount: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < trackCount; t++) {
    let best = 0;
    for (let s = 1; s < laps.length; s++) if ((laps[s]?.[t] ?? Infinity) < (laps[best]?.[t] ?? Infinity)) best = s;
    out.push(best);
  }
  return out;
}

export function maxWinShare(winnerIndex: readonly number[]): { share: number; spec: number; tracks: number } {
  const counts = new Map<number, number>();
  for (const w of winnerIndex) counts.set(w, (counts.get(w) ?? 0) + 1);
  let spec = winnerIndex[0] ?? 0;
  for (const w of winnerIndex) if ((counts.get(w) ?? 0) > (counts.get(spec) ?? 0) || ((counts.get(w) ?? 0) === (counts.get(spec) ?? 0) && w < spec)) spec = w;
  const tracks = counts.get(spec) ?? 0;
  return { share: tracks / Math.max(1, winnerIndex.length), spec, tracks };
}

export interface Contribution {
  readonly name: string;
  /** Pratt 분해: 표준화 회귀계수 × 상관계수. 전부 더하면 R². */
  readonly share: number;
  /** 단변량 R² (참고용). */
  readonly r2: number;
  /** 표준화 회귀계수 (부호: + 면 값이 클수록 시즌 시간이 길다 = 느리다). */
  readonly beta: number;
}

/** 지표 2: 시즌 시간 y를 설명변수 X(열 이름 names)로 선형 회귀하고 변수별 설명 분산을 나눈다. */
export function varianceContributions(
  X: readonly (readonly number[])[],
  y: readonly number[],
  names: readonly string[],
): { r2: number; contributions: Contribution[] } {
  const n = y.length;
  const k = names.length;
  const mean = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const sd = (a: readonly number[], m: number) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  const cols = names.map((_, j) => X.map((row) => row[j] ?? 0));
  const colMean = cols.map(mean);
  const colSd = cols.map((c, j) => sd(c, colMean[j] ?? 0));
  const yMean = mean(y);
  const ySd = sd(y, yMean);
  const Z = cols.map((c, j) => c.map((v) => ((v - (colMean[j] ?? 0)) / ((colSd[j] ?? 1) || 1))));
  const zy = y.map((v) => (v - yMean) / (ySd || 1));
  // 상관행렬 R, 상관벡터 r → β = R⁻¹ r (가우스 소거, 부분 피벗).
  const corr = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0) / (n - 1);
  const R = Z.map((a) => Z.map((b) => corr(a, b)));
  const r = Z.map((a) => corr(a, zy));
  const beta = solve(R, r);
  const contributions = names.map((name, j) => ({
    name,
    share: (beta[j] ?? 0) * (r[j] ?? 0),
    r2: (r[j] ?? 0) ** 2,
    beta: beta[j] ?? 0,
  }));
  return { r2: contributions.reduce((s, c) => s + c.share, 0), contributions: contributions.slice(0, k) };
}

/** 작은 선형계 Ax = b (부분 피벗 가우스 소거). 특이하면 해당 성분 0. */
function solve(A: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]?.[c] ?? 0) > Math.abs(M[p]?.[c] ?? 0)) p = r;
    [M[c], M[p]] = [M[p] as number[], M[c] as number[]];
    const pivot = M[c]?.[c] ?? 0;
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = (M[r]?.[c] ?? 0) / pivot;
      for (let j = c; j <= n; j++) (M[r] as number[])[j] = (M[r]?.[j] ?? 0) - f * (M[c]?.[j] ?? 0);
    }
  }
  return M.map((row, i) => (Math.abs(row[i] ?? 0) < 1e-12 ? 0 : (row[n] ?? 0) / (row[i] ?? 1)));
}

/** 지표 3: 트랙별 최속 스펙의 아키텍처 집계. */
export function architectureWins(specs: readonly CarSpec[], winnerIndex: readonly number[]) {
  const count = { floor: 0, wing: 0, short: 0, long: 0 };
  for (const w of winnerIndex) {
    const spec = specs[w];
    if (!spec) continue;
    count[spec.aero.philosophy] += 1;
    count[spec.chassis.wheelbase] += 1;
  }
  return count;
}

/** 회귀 설명변수: 연속 파라미터 10개 + 아키텍처 더미 2개 (floor = 1, long = 1). */
export function designMatrix(specs: readonly CarSpec[]): { X: number[][]; names: string[] } {
  const names = [...SPEC_PARAMS.map((p) => p.key), 'philosophy=floor', 'wheelbase=long'];
  const X = specs.map((s) => [
    ...SPEC_PARAMS.map((p) => p.get(s)),
    s.aero.philosophy === 'floor' ? 1 : 0,
    s.chassis.wheelbase === 'long' ? 1 : 0,
  ]);
  return { X, names };
}
