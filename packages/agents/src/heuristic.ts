/**
 * 휴리스틱 설계 (DESIGN.md 12절): LLM 팀의 기준선.
 * 캘린더 프로파일의 가중 평균으로 "평균 트랙"을 정하고(풍동은 실제 트랙에서만 돌므로 평균에 가장 가까운 트랙),
 * 풍동 횟수를 좌표 하강에 쓴다: 아키텍처 2회 → 파라미터마다 "이것을 올리고 나머지를 줄이기"를 시도.
 *
 * 입력은 공개 정보만: 코스트 규칙과 트랙 프로파일. 엔진 모델 계수(regulations.car 등)는 받지 않는다.
 */
import {
  CarSpecSchema,
  SPEC_PARAMS,
  type CarSpec,
  type Regulations,
  type Setup,
  type SpecParamKey,
  type TrackProfile,
} from '@f1sim/core';
import type { DesignTools } from './tools.js';

export interface DesignInputs {
  readonly cost: Regulations['cost'];
  /** 캘린더 순서의 트랙 프로파일. */
  readonly tracks: readonly { readonly id: string; readonly profile: TrackProfile }[];
}

// 휴리스틱 자체의 설정 (규정이 아니다).
const FIRST_STEP = 0.15;
const MIN_STEP = 0.02;
const BISECTION_STEPS = 50;
/** 직선 비율 → 풍동에 쓸 윙: 비율 0.5에서 윙 10, 0.8에서 윙 1 쯤. */
const WING_AT_RATIO_05 = 10;
const WING_PER_RATIO = 30;

type Values = Record<SpecParamKey, number>;

function costOf(values: Values, rules: Regulations['cost']): number {
  let total = 0;
  for (const p of SPEC_PARAMS) total += rules.weights[p.key] * values[p.key] ** rules.exponent;
  return total;
}

function toSpec(values: Values, arch: { philosophy: 'floor' | 'wing'; wheelbase: 'short' | 'long' }): CarSpec {
  return CarSpecSchema.parse({
    powertrain: {
      thermal_efficiency: values.thermal_efficiency,
      reliability: values.reliability,
      ers_capacity: values.ers_capacity,
      cooling: values.cooling,
    },
    chassis: {
      weight_reduction: values.weight_reduction,
      mech_grip: values.mech_grip,
      tire_management: values.tire_management,
      wheelbase: arch.wheelbase,
    },
    aero: {
      aero_efficiency: values.aero_efficiency,
      philosophy: arch.philosophy,
      dirty_air_resistance: values.dirty_air_resistance,
      drs_effect: values.drs_effect,
    },
  });
}

/** key를 target으로 고정하고 나머지를 같은 비율로 늘이거나 줄여 정확히 캡에 맞춘다 (각 값 ≤ 1). */
function rebalance(values: Values, key: SpecParamKey, target: number, rules: Regulations['cost']): Values | null {
  const fixed = Math.min(1, Math.max(0, target));
  const at = (s: number): Values => {
    const out = { ...values };
    for (const p of SPEC_PARAMS) out[p.key] = p.key === key ? fixed : Math.min(1, values[p.key] * s);
    return out;
  };
  if (costOf(at(0), rules) > rules.cap_credits) return null;
  let lo = 0;
  let hi = 1;
  while (costOf(at(hi), rules) < rules.cap_credits && hi < 1e6) hi *= 2;
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2;
    if (costOf(at(mid), rules) <= rules.cap_credits) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

/** 레이스 거리로 가중한 평균 프로파일에 가장 가까운 캘린더 트랙 (정규화한 특성 거리). */
export function representativeTrack(tracks: DesignInputs['tracks']): string {
  const features = (p: TrackProfile) => {
    const corners = Math.max(1, p.corners_low + p.corners_mid + p.corners_high);
    return [p.straight_ratio, p.corners_low / corners, p.corners_mid / corners, p.corners_high / corners, p.bumpiness, p.temp_mean];
  };
  const rows = tracks.map((t) => ({ id: t.id, f: features(t.profile), w: t.profile.laps * t.profile.length_km }));
  const dims = rows[0]?.f.length ?? 0;
  const totalW = rows.reduce((s, r) => s + r.w, 0);
  const mean = Array.from({ length: dims }, (_, d) => rows.reduce((s, r) => s + (r.f[d] ?? 0) * r.w, 0) / totalW);
  const span = Array.from({ length: dims }, (_, d) => {
    const v = rows.map((r) => r.f[d] ?? 0);
    return Math.max(...v) - Math.min(...v) || 1;
  });
  let best = rows[0];
  let bestDist = Infinity;
  for (const r of rows) {
    const dist = r.f.reduce((s, v, d) => s + ((v - (mean[d] ?? 0)) / (span[d] ?? 1)) ** 2, 0);
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  if (!best) throw new Error('no tracks');
  return best.id;
}

/** 설계 휴리스틱. 풍동을 최대 tools.remaining회 쓰고(보폭이 MIN_STEP 아래로 줄면 멈춘다), 가장 빨랐던 스펙을 낸다. */
export function heuristicDesign(inputs: DesignInputs, tools: DesignTools): CarSpec {
  const rules = inputs.cost;
  const trackId = representativeTrack(inputs.tracks);
  const ratio = inputs.tracks.find((t) => t.id === trackId)?.profile.straight_ratio ?? 0.6;
  const wing = Math.round(Math.min(10, Math.max(0, WING_AT_RATIO_05 - (ratio - 0.5) * WING_PER_RATIO)));
  const setupFor = (philosophy: 'floor' | 'wing'): Setup => ({
    wing_level: wing,
    ride_height: philosophy === 'floor' ? 'low' : 'mid',
    ers_mode: 'balanced',
  });

  // 출발점: 모든 파라미터를 같은 값으로, 정확히 캡에.
  const weightSum = SPEC_PARAMS.reduce((s, p) => s + rules.weights[p.key], 0);
  const uniform = Math.min(1, (rules.cap_credits / weightSum) ** (1 / rules.exponent));
  let values = Object.fromEntries(SPEC_PARAMS.map((p) => [p.key, uniform])) as Values;
  let arch = { philosophy: 'wing' as 'floor' | 'wing', wheelbase: 'long' as 'short' | 'long' };
  const run = (v: Values, a: typeof arch) => tools.windTunnel(toSpec(v, a), setupFor(a.philosophy), trackId).lap.total;

  if (tools.remaining === 0) return toSpec(values, arch);
  let best = run(values, arch);
  for (const change of [{ philosophy: 'floor' }, { wheelbase: 'short' }] as const) {
    if (tools.remaining === 0) break;
    const candidate = { ...arch, ...change };
    const t = run(values, candidate);
    if (t < best) {
      best = t;
      arch = candidate;
    }
  }

  let step = FIRST_STEP;
  while (tools.remaining > 0 && step >= MIN_STEP) {
    let improved = false;
    for (const p of SPEC_PARAMS) {
      if (tools.remaining === 0) break;
      const next = rebalance(values, p.key, values[p.key] + step, rules);
      if (!next || next[p.key] === values[p.key]) continue;
      const t = run(next, arch);
      if (t < best) {
        best = t;
        values = next;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return toSpec(values, arch);
}
