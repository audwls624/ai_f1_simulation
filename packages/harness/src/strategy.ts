/**
 * 전략 공간 탐색 (DESIGN.md 12절): 고정 스펙 × 랜덤 플랜 × 시드, 레이스 전체 실행 → 지표 4–6.
 * 순수 계산만 여기 두고, 병렬 실행과 리포트는 strategy-explore.ts / strategy-report.ts.
 */
import {
  CompoundSchema,
  DRY_COMPOUNDS,
  GPPlanSchema,
  PaceModeSchema,
  RaceEventSchema,
  SPEC_PARAMS,
  SurfaceSchema,
  raceSets,
  validatePlan,
  type Action,
  type CarSpec,
  type Compound,
  type GPPlan,
  type Regulations,
  type Rng,
  type Rule,
  type RuleConditions,
  type Setup,
  type Stint,
  type Track,
} from '@f1sim/core';

// ── 랜덤 플랜 (검증은 통과하지만 현명하다는 보장은 없다) ───────────────

const MAX_STINTS = 4;
const MAX_RULES = 4;
const MAX_CONDITIONS_PER_RULE = 3;
const PIT_LAP_MARGIN = 3;
const MAX_TRIES = 200;

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng.next() * items.length)] as T;
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng.next() * (hi - lo + 1));

function randomCondition(rng: Rng, laps: number, when: Record<string, unknown>): void {
  const generators: readonly (() => void)[] = [
    () => (when.lap_gte = int(rng, 2, laps - 2)),
    () => (when.laps_remaining_lte = int(rng, 2, Math.floor(laps / 2))),
    () => (when.event = pick(rng, RaceEventSchema.options)),
    () => (when.surface = pick(rng, SurfaceSchema.options)),
    () => (when.tire_life_lte = Math.round(rng.next() * 100) / 100),
    () => (when.tire_age_gte = int(rng, 1, Math.floor(laps / 2))),
    () => (when.position_lte = int(rng, 1, 10)),
    () => (when.gap_ahead_lte = Math.round(rng.next() * 50) / 10),
    () => (when.gap_behind_gte = Math.round(rng.next() * 100) / 10),
    () => (when.rival_ahead_pitted = rng.next() < 0.5),
    () => (when.stint_index_eq = int(rng, 0, 2)),
  ];
  pick(rng, generators)();
}

function randomAction(rng: Rng): Action {
  const r = rng.next();
  if (r < 0.45) return { pit: rng.next() < 0.5 ? 'next_planned' : pick(rng, CompoundSchema.options) };
  if (r < 0.8) return { pace: pick(rng, PaceModeSchema.options) };
  if (r < 0.95) return { extend_stint: int(rng, 1, 8) };
  return 'none';
}

function randomRule(rng: Rng, laps: number): Rule {
  const when: Record<string, unknown> = {};
  const n = int(rng, 1, MAX_CONDITIONS_PER_RULE);
  for (let k = 0; k < n; k++) randomCondition(rng, laps, when);
  const gate = rng.next();
  const action = randomAction(rng);
  const isPit = typeof action === 'object' && 'pit' in action;
  return {
    when: when as RuleConditions,
    do: action,
    ...(gate < 0.4 ? { once: true } : gate < 0.8 || isPit ? { cooldown: int(rng, 1, 15) } : {}),
  };
}

function randomStints(rng: Rng, laps: number, sets: Record<Compound, number>): Stint[] {
  const k = int(rng, 1, MAX_STINTS);
  const left = { ...sets };
  const compounds: Compound[] = [];
  for (let i = 0; i < k; i++) {
    const options = DRY_COMPOUNDS.filter((c) => left[c] > 0);
    const c = pick(rng, options);
    left[c] -= 1;
    compounds.push(c);
  }
  const pitLaps = new Set<number>();
  while (pitLaps.size < k - 1) pitLaps.add(int(rng, PIT_LAP_MARGIN, laps - PIT_LAP_MARGIN));
  const sorted = [...pitLaps].sort((a, b) => a - b);
  return compounds.map((compound, i) => (i < k - 1 ? { compound, planned_pit_lap: sorted[i] as number } : { compound }));
}

/** 이 트랙용 랜덤 GPPlan: 검증 통과 + 린트 경고 없음 (pit 규칙은 once 또는 cooldown). 셋업은 주어진 것 (보통 그 스펙의 최적 셋업). */
export function randomPlan(track: Track, regs: Regulations, rng: Rng, setup: Setup): GPPlan {
  const sets = raceSets(regs);
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const stints = randomStints(rng, track.laps, sets);
    const rules = Array.from({ length: int(rng, 0, MAX_RULES) }, () => randomRule(rng, track.laps));
    const plan = GPPlanSchema.parse({
      setup,
      variants: [{ when: {}, plan: { start_compound: stints[0]?.compound, pace: pick(rng, PaceModeSchema.options), stints, rules } }],
    });
    if (validatePlan(plan, regs, { laps: track.laps }).ok) return plan;
  }
  throw new Error(`no valid random plan for ${track.id} in ${MAX_TRIES} tries`);
}

/** 플랜 한 줄 요약 (리포트용). */
export function describePlan(plan: GPPlan): string {
  const p = plan.variants[0]?.plan;
  if (!p) return '-';
  const stints = p.stints.map((s) => `${s.compound[0]?.toUpperCase() ?? '?'}${s.planned_pit_lap !== undefined ? `→${s.planned_pit_lap}` : ''}`).join(' ');
  return `${stints} · ${p.pace} · ${p.rules.length} rules`;
}

// ── 고정 스펙 고르기 ───────────────────────────────────────────────────

function features(spec: CarSpec): number[] {
  return [...SPEC_PARAMS.map((p) => p.get(spec)), spec.aero.philosophy === 'floor' ? 1 : 0, spec.chassis.wheelbase === 'long' ? 1 : 0];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(a.reduce((s, v, i) => s + (v - (b[i] ?? 0)) ** 2, 0));
}

/**
 * 12절 "위 탐색에서 고른 다양한 스펙": 시즌 시간 상위 pool 안에서 아키텍처 칸(floor/wing × short/long)마다
 * 가장 빠른 것을 먼저 넣고, 나머지는 이미 고른 것들과 가장 먼 스펙을 차례로 (farthest-point).
 */
export function pickDiverseSpecs(specs: readonly CarSpec[], seasonTimes: readonly number[], n: number, poolShare = 0.25): CarSpec[] {
  const order = specs.map((_, i) => i).sort((a, b) => (seasonTimes[a] ?? 0) - (seasonTimes[b] ?? 0) || a - b);
  const pool = order.slice(0, Math.max(n, Math.ceil(order.length * poolShare)));
  const chosen: number[] = [];
  for (const philosophy of ['floor', 'wing'] as const) {
    for (const wheelbase of ['short', 'long'] as const) {
      const best = pool.find((i) => specs[i]?.aero.philosophy === philosophy && specs[i]?.chassis.wheelbase === wheelbase);
      if (best !== undefined && chosen.length < n) chosen.push(best);
    }
  }
  while (chosen.length < n && chosen.length < pool.length) {
    let bestIdx = -1;
    let bestDist = -1;
    for (const i of pool) {
      if (chosen.includes(i)) continue;
      const d = Math.min(...chosen.map((j) => distance(features(specs[i] as CarSpec), features(specs[j] as CarSpec))));
      if (d > bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    chosen.push(bestIdx);
  }
  return chosen.map((i) => specs[i] as CarSpec);
}

// ── 지표 (12절) ────────────────────────────────────────────────────────

/** 한 레이스에서 랜덤 플랜 차의 결과. */
export interface StrategySample {
  readonly spec: number;
  readonly plan: number;
  readonly track: number;
  readonly seed: number;
  readonly pos: number;
  readonly time: number | null;
  readonly fallbacks: number;
  readonly pits: number;
  /** 이 레이스에 세이프티카 / 비 / (어느 차든) 리타이어가 있었나 — 운 분해용. */
  readonly sc: boolean;
  readonly rain: boolean;
  readonly anyDnf: boolean;
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const sd = (xs: readonly number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

/** (스펙, 트랙)마다 플랜별 평균 레이스 시간 → 상위·하위 10% 평균의 차 (지표 4). */
export function strategySpread(samples: readonly StrategySample[], share = 0.1) {
  const cells = new Map<string, Map<number, number[]>>();
  for (const s of samples) {
    if (s.time === null) continue;
    const key = `${s.spec}/${s.track}`;
    const plans = cells.get(key) ?? new Map<number, number[]>();
    const times = plans.get(s.plan) ?? [];
    times.push(s.time);
    plans.set(s.plan, times);
    cells.set(key, plans);
  }
  const out: { spec: number; track: number; spread: number; best: number; worst: number }[] = [];
  for (const [key, plans] of [...cells].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [spec = 0, track = 0] = key.split('/').map(Number);
    const means = [...plans].map(([plan, times]) => ({ plan, t: mean(times) })).sort((a, b) => a.t - b.t || a.plan - b.plan);
    const k = Math.max(1, Math.floor(means.length * share));
    const top = mean(means.slice(0, k).map((m) => m.t));
    const bottom = mean(means.slice(-k).map((m) => m.t));
    out.push({ spec, track, spread: bottom - top, best: means[0]?.plan ?? 0, worst: means.at(-1)?.plan ?? 0 });
  }
  return out;
}

/** (스펙, 플랜, 트랙)마다 시드별 순위 표준편차 (지표 5). */
export function luck(samples: readonly StrategySample[]): number[] {
  const cells = new Map<string, number[]>();
  for (const s of samples) {
    const key = `${s.spec}/${s.plan}/${s.track}`;
    const pos = cells.get(key) ?? [];
    pos.push(s.pos);
    cells.set(key, pos);
  }
  return [...cells.values()].map(sd);
}

/** 랜덤 플랜 차의 레이스당 평균 폴백 수 (지표 6). */
export function fallbacksPerRace(samples: readonly StrategySample[]): number {
  return mean(samples.map((s) => s.fallbacks));
}

export { mean as average, sd as standardDeviation };
