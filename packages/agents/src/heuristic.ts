/**
 * 휴리스틱 설계 (DESIGN.md 12절): LLM 팀의 기준선.
 * 캘린더 프로파일의 가중 평균으로 "평균 트랙"을 정하고(풍동은 실제 트랙에서만 돌므로 평균에 가장 가까운 트랙),
 * 풍동 횟수를 좌표 하강에 쓴다: 아키텍처 2회 → 파라미터마다 "이것을 올리고 나머지를 줄이기"를 시도.
 *
 * 입력은 공개 정보만: 코스트 규칙과 트랙 프로파일. 엔진 모델 계수(regulations.car 등)는 받지 않는다.
 */
import {
  CarSpecSchema,
  GPPlanSchema,
  SPEC_PARAMS,
  type CarSpec,
  type Compound,
  type GPPlan,
  type Regulations,
  type Rule,
  type Setup,
  type SpecParamKey,
  type Stint,
  type TrackProfile,
} from '@f1sim/core';
import type { GPPacket, PlanTools, PreseasonPacket, TeamAgent } from './base.js';
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

// ── GP 플랜 (12절: 마모도에 따라 1스톱 medium→hard 또는 2스톱 soft→medium→hard, SC 규칙 1개, 비 규칙 2개) ──

/** 클리프 전에 피트하려고 남기는 life 여유. */
const LIFE_MARGIN = 0.05;
/** 1스톱이 가능하다고 볼 때 두 스틴트가 레이스를 덮어야 하는 배수. */
const ONE_STOP_COVER = 1.0;
const SC_RULE_MIN_TIRE_AGE = 8;
const RAIN_RULE_COOLDOWN = 8;
const DRY_AGAIN_LAPS = 2;
const DRY_AGAIN_COOLDOWN = 5;
/** 범프가 이보다 크면 floor 차도 지상고를 mid로 (공개 프로파일만 보는 휴리스틱 기준). */
const FLOOR_LOW_MAX_BUMPINESS = 0.5;

/** 풍동 요약 세 점(윙, 랩)에 포물선을 맞춰 최적 윙을 추정한다. */
export function bestWingFromSummary(points: readonly { wing: number; lap: number }[]): number {
  const sorted = [...points].sort((a, b) => a.wing - b.wing);
  const best = sorted.reduce((a, b) => (b.lap < a.lap ? b : a));
  const [p0, p1, p2] = sorted;
  if (!p0 || !p1 || !p2) return best.wing;
  const denom = (p0.wing - p1.wing) * (p0.wing - p2.wing) * (p1.wing - p2.wing);
  const a = (p2.wing * (p1.lap - p0.lap) + p1.wing * (p0.lap - p2.lap) + p0.wing * (p2.lap - p1.lap)) / denom;
  const b = (p2.wing ** 2 * (p0.lap - p1.lap) + p1.wing ** 2 * (p2.lap - p0.lap) + p0.wing ** 2 * (p1.lap - p2.lap)) / denom;
  const vertex = a > 0 ? -b / (2 * a) : best.wing;
  return Math.round(Math.min(10, Math.max(0, vertex)));
}

function stintPlan(compounds: readonly Compound[], usable: (c: Compound) => number, laps: number): Stint[] {
  const total = compounds.reduce((s, c) => s + usable(c), 0);
  let lap = 0;
  return compounds.map((compound, i) => {
    if (i === compounds.length - 1) return { compound };
    lap += (laps * usable(compound)) / total;
    return { compound, planned_pit_lap: Math.max(1, Math.min(laps - 1, Math.round(lap))) };
  });
}

function rulesFor(): Rule[] {
  return [
    { when: { event: 'safety_car', tire_age_gte: SC_RULE_MIN_TIRE_AGE, stint_index_eq: 0 }, do: { pit: 'next_planned' }, once: true },
    { when: { event: 'rain_start' }, do: { pit: 'inter' }, cooldown: RAIN_RULE_COOLDOWN },
    {
      when: { surface: 'dry', tire_compound: 'inter', laps_on_compound_gte: DRY_AGAIN_LAPS },
      do: { pit: 'next_planned' },
      cooldown: DRY_AGAIN_COOLDOWN,
    },
  ];
}

/** 휴리스틱 GP 플랜. 1스톱과 2스톱 후보를 만들고, 시뮬 횟수가 있으면 둘을 비교한다. */
export function heuristicPlan(packet: GPPacket, tools: PlanTools): GPPlan {
  const rules = packet.rules;
  const laps = packet.profile.laps;
  const wing = bestWingFromSummary(packet.wind_tunnel_summary.map((s) => ({ wing: s.setup.wing_level, lap: s.lap.total })));
  const floor = packet.own_spec.aero.philosophy === 'floor';
  const setup: Setup = {
    wing_level: wing,
    ride_height: floor && packet.profile.bumpiness < FLOOR_LOW_MAX_BUMPINESS ? 'low' : 'mid',
    ers_mode: 'balanced',
  };
  const nearest = packet.wind_tunnel_summary.reduce((a, b) =>
    Math.abs(b.setup.wing_level - wing) < Math.abs(a.setup.wing_level - wing) ? b : a,
  );
  const reference = rules.tools.wind_tunnel.wear_compound;
  const wearOf = (c: Compound) =>
    (nearest.wear_per_lap * rules.tires.compounds[c].wear_per_lap) / rules.tires.compounds[reference].wear_per_lap;
  const usable = (c: Compound) => Math.max(1, (1 - rules.tires.compounds[c].cliff_life - LIFE_MARGIN) / wearOf(c));

  const make = (compounds: readonly Compound[]): GPPlan =>
    GPPlanSchema.parse({
      setup,
      variants: [
        {
          when: {},
          plan: { start_compound: compounds[0], pace: 'normal', stints: stintPlan(compounds, usable, laps), rules: rulesFor() },
        },
      ],
    });
  const twoStop = make(['soft', 'medium', 'hard']);
  if (usable('medium') + usable('hard') < laps * ONE_STOP_COVER) return twoStop;
  const oneStop = make(['medium', 'hard']);
  if (tools.remaining < 2) return oneStop;
  const a = tools.strategySim(oneStop);
  const b = tools.strategySim(twoStop);
  const score = (r: typeof a) => [r.mean_position, r.mean_race_time_s ?? Infinity] as const;
  const [ap, at] = score(a);
  const [bp, bt] = score(b);
  return bp < ap || (bp === ap && bt < at) ? twoStop : oneStop;
}

/** 12절 휴리스틱 에이전트: 밸런스 기준선이자 LLM 팀의 비교 대상. */
export class HeuristicAgent implements TeamAgent {
  readonly kind = 'heuristic';

  designCar(packet: PreseasonPacket, tools: DesignTools): Promise<CarSpec> {
    return Promise.resolve(
      heuristicDesign({ cost: packet.rules.cost, tracks: packet.calendar.map((c) => ({ id: c.track_id, profile: c.profile })) }, tools),
    );
  }

  planGp(packet: GPPacket, tools: PlanTools): Promise<GPPlan> {
    return Promise.resolve(heuristicPlan(packet, tools));
  }
}
