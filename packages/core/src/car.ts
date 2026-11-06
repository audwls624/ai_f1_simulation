/**
 * 차량 스펙·셋업 스키마와 파생 성능치 (DESIGN.md 4절).
 *
 * derive()는 스펙 + 셋업 + 트랙 → DerivedPerf. 랩타임·레이스 모델은 DerivedPerf만 본다.
 * 계수는 전부 regulations(2026.yaml)의 `car` 블록에서 온다 — 여기에 게임 수치를 두지 않는다.
 */
import { z } from 'zod';
import type { Regulations } from './regulations.js';

// ── 제출 포맷의 값 범위 (4절). 포맷 자체의 일부라 yaml이 아니라 스키마가 소스다. ──
export const SPEC_PARAM_MIN = 0;
export const SPEC_PARAM_MAX = 1;
export const WING_LEVEL_MIN = 0;
export const WING_LEVEL_MAX = 10;

const SpecParam = z.number().min(SPEC_PARAM_MIN).max(SPEC_PARAM_MAX);

export const WheelbaseSchema = z.enum(['short', 'long']);
export const PhilosophySchema = z.enum(['floor', 'wing']);
export const RideHeightSchema = z.enum(['low', 'mid', 'high']);
export const ErsModeSchema = z.enum(['harvest', 'balanced', 'attack']);
export type Wheelbase = z.infer<typeof WheelbaseSchema>;
export type Philosophy = z.infer<typeof PhilosophySchema>;
export type RideHeight = z.infer<typeof RideHeightSchema>;
export type ErsMode = z.infer<typeof ErsModeSchema>;

/** 4절: 연속 파라미터 10개(0.0–1.0) + 아키텍처 2개. 필드 순서는 4절 표·제출 예시와 같다. */
export const CarSpecSchema = z.strictObject({
  powertrain: z.strictObject({
    thermal_efficiency: SpecParam,
    reliability: SpecParam,
    ers_capacity: SpecParam,
    cooling: SpecParam,
  }),
  chassis: z.strictObject({
    weight_reduction: SpecParam,
    mech_grip: SpecParam,
    tire_management: SpecParam,
    wheelbase: WheelbaseSchema,
  }),
  aero: z.strictObject({
    aero_efficiency: SpecParam,
    philosophy: PhilosophySchema,
    dirty_air_resistance: SpecParam,
    drs_effect: SpecParam,
  }),
});
export type CarSpec = z.infer<typeof CarSpecSchema>;

/** 4절: GP마다 제출하는 셋업. wing_level은 정수 0–10. */
export const SetupSchema = z.strictObject({
  wing_level: z.int().min(WING_LEVEL_MIN).max(WING_LEVEL_MAX),
  ride_height: RideHeightSchema,
  ers_mode: ErsModeSchema,
});
export type Setup = z.infer<typeof SetupSchema>;

interface SpecParamDef {
  readonly key: string;
  readonly path: string;
  readonly get: (spec: CarSpec) => number;
}

/**
 * 비용이 붙는 연속 파라미터 목록 (3절 표). 파라미터를 순회할 때는 항상 이 배열을 쓴다 (객체 키 순회 금지).
 * key는 regulations의 cost.weights 키와 같아야 한다 (테스트가 확인).
 */
export const SPEC_PARAMS = [
  { key: 'thermal_efficiency', path: 'powertrain.thermal_efficiency', get: (s) => s.powertrain.thermal_efficiency },
  { key: 'reliability', path: 'powertrain.reliability', get: (s) => s.powertrain.reliability },
  { key: 'ers_capacity', path: 'powertrain.ers_capacity', get: (s) => s.powertrain.ers_capacity },
  { key: 'cooling', path: 'powertrain.cooling', get: (s) => s.powertrain.cooling },
  { key: 'weight_reduction', path: 'chassis.weight_reduction', get: (s) => s.chassis.weight_reduction },
  { key: 'mech_grip', path: 'chassis.mech_grip', get: (s) => s.chassis.mech_grip },
  { key: 'tire_management', path: 'chassis.tire_management', get: (s) => s.chassis.tire_management },
  { key: 'aero_efficiency', path: 'aero.aero_efficiency', get: (s) => s.aero.aero_efficiency },
  { key: 'dirty_air_resistance', path: 'aero.dirty_air_resistance', get: (s) => s.aero.dirty_air_resistance },
  { key: 'drs_effect', path: 'aero.drs_effect', get: (s) => s.aero.drs_effect },
] as const satisfies readonly SpecParamDef[];
export type SpecParamKey = (typeof SPEC_PARAMS)[number]['key'];

/**
 * derive()가 트랙에서 읽는 값 (5절 프로파일 필드명).
 * M1 세션 2의 Track(track.ts)이 이 필드를 갖추면 그대로 넘길 수 있다.
 */
export interface DeriveTrackInput {
  /** 랩 길이 (m). 랩당 연료에 쓴다. */
  readonly length_m: number;
  /** 0–1. floor·low ride height 불안정의 입력. */
  readonly bumpiness: number;
  /** 평균 기온 (°C). derive의 기온 인자 기본값. */
  readonly temp_mean: number;
}

/**
 * 파생 성능치 (4절 목록 그대로). 에이전트에게 직접 노출하지 않는다.
 * 하위 모델(laptime·race)은 이 구조체만 입력으로 받는다.
 */
export interface DerivedPerf {
  /** 유효 출력 kW. 열 디레이팅과 ERS 모드가 이미 반영돼 있다. */
  readonly power_kw: number;
  /** 연료를 뺀 차량 무게 kg (드라이버 포함, 배터리 포함). */
  readonly mass_kg: number;
  /** ½ρ·Cd·A [kg/m]. 공기저항 F = drag_coeff · v². DRS 개방 시 × (1 − drs_gain). */
  readonly drag_coeff: number;
  /** μ·½ρ·Cl·A [kg/m]. 6절 μ_eff = mech_grip + downforce_coeff · v² / (mass · g). */
  readonly downforce_coeff: number;
  /** 기계적 마찰계수 μ (무차원). */
  readonly mech_grip: number;
  /** normal 페이스 기준 랩당 연료 kg. 페이스 승수는 레이스에서 곱한다. */
  readonly fuel_per_lap_kg: number;
  /** 타이어 마모 승수: tire_management(1.0 → 0.6) × 다운포스 슬라이딩 감소 × floor 불안정. */
  readonly deg_multiplier: number;
  /** 타이어 워밍업 페널티 s/lap (tire_management가 높을수록 큼). 적용 랩 수는 regulations에. */
  readonly warmup_penalty_s: number;
  /** 랩당 고장 확률. 기온·페이스 승수는 레이스(7절)에서 곱한다. */
  readonly failure_rate_per_lap: number;
  /** 0–1 출력 감소율 (power_kw에 이미 반영됨). 레이스의 고장률 열 승수 입력. */
  readonly heat_derate: number;
  /** 앞차 뒤(더티 에어)에서 다운포스 손실률. */
  readonly dirty_air_loss: number;
  /** DRS 개방 시 드래그 감소율. */
  readonly drs_gain: number;
  /** 추월·방어 ERS 보너스 (무차원, 7절 추월 식 입력). */
  readonly ers_boost: number;
}

type CarModel = Regulations['car'];
type Pair = readonly [number, number];

// 단위 환산 (게임 수치 아님).
const SECONDS_PER_HOUR = 3600;
const KW_PER_MW = 1000;
const M_PER_KM = 1000;

/** [x=0일 때 값, x=1일 때 값] 선형 보간. */
function lerp([at0, at1]: Pair, x: number): number {
  return at0 + (at1 - at0) * x;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** 4절 상호작용 1: 기온이 derate_from_c를 넘으면 필요 냉각량이 늘고, cooling 부족분만큼 출력 디레이팅. */
function heatDerate(cooling: number, airTempC: number, c: CarModel['cooling']): number {
  const required = clamp01((airTempC - c.derate_from_c) / (c.full_cooling_at_c - c.derate_from_c));
  return Math.max(0, required - cooling) * c.max_derate;
}

interface Instability {
  readonly downforceMult: number;
  readonly mechGripMult: number;
  readonly wearMult: number;
}

/**
 * 4절 불안정 두 갈래:
 * - 상호작용 2: floor × (mech_grip < floor_min_mech_grip 또는 범피 트랙) → 다운포스 손실 + 마모 × wear_mult.
 * - ride_height: 범피 트랙에서 low(일수록) 불안정. 심각도 = 범피 초과분 × 지상고·철학 민감도.
 */
function instability(spec: CarSpec, setup: Setup, track: DeriveTrackInput, c: CarModel['instability']): Instability {
  const bumpy = track.bumpiness >= c.bumpy_from;
  const bumpExcess = bumpy ? (track.bumpiness - c.bumpy_from) / (1 - c.bumpy_from) : 0;
  const bumps = c.low_ride_on_bumps;
  const severity =
    bumpExcess * bumps.ride_height_sensitivity[setup.ride_height] * bumps.philosophy_sensitivity[spec.aero.philosophy];
  const floorUnstable =
    spec.aero.philosophy === 'floor' && (spec.chassis.mech_grip < c.floor_min_mech_grip || bumpy);
  return {
    downforceMult: (1 - bumps.downforce_loss * severity) * (floorUnstable ? 1 - c.floor.downforce_loss : 1),
    mechGripMult: 1 - bumps.mech_grip_loss * severity,
    wearMult: floorUnstable ? c.floor.wear_mult : 1,
  };
}

/**
 * 스펙 + 셋업 + 트랙 → 파생 성능치 (4절).
 *
 * @param airTempC 레이스 기온 (°C). 기본값은 트랙 평균 기온. 레이스(M3)는 날씨 스트림에서 실현한 기온을 넘긴다 (5절).
 */
export function derive(
  spec: CarSpec,
  setup: Setup,
  track: DeriveTrackInput,
  regs: Regulations,
  airTempC: number = track.temp_mean,
): DerivedPerf {
  const m = regs.car;
  const { powertrain: pt, chassis: ch, aero: ae } = spec;
  const wing = (setup.wing_level - WING_LEVEL_MIN) / (WING_LEVEL_MAX - WING_LEVEL_MIN);

  // 출력: 연료 유량 상한(3절) × 발열량 × 열효율. reliability는 보수적 맵으로 출력 소폭 감소.
  const eta = lerp(m.power.thermal_efficiency_eta, pt.thermal_efficiency);
  const fuelKgPerS = regs.limits.fuel_flow_kg_per_h / SECONDS_PER_HOUR;
  const iceKw = fuelKgPerS * m.power.fuel_energy_mj_per_kg * KW_PER_MW * eta;
  const heat_derate = heatDerate(pt.cooling, airTempC, m.cooling);
  const ers = m.ers.modes[setup.ers_mode];
  // depletion: 에너지 고갈로 잃는 비율. ers_capacity가 클수록 덜 고갈된다.
  const ersKw = ers.power_kw * (1 - ers.depletion * (1 - pt.ers_capacity));
  const power_kw = iceKw * (1 - m.power.reliability_power_loss * pt.reliability) * (1 - heat_derate) + ersKw;

  // 무게: weight_reduction 1.0 = 최소 무게, 0.0 = + span (3절). ERS 배터리는 그 위에 더해진다 (4절).
  const mass_kg =
    regs.limits.min_weight_kg +
    regs.limits.weight_reduction_span_kg * (1 - ch.weight_reduction) +
    m.mass.battery_kg_at_full_ers * pt.ers_capacity;

  const inst = instability(spec, setup, track, m.instability);

  // 에어로: wing_level이 효율 곡선 위에서 다운포스·드래그를 같이 올린다.
  // 다운포스는 지수 < 1로 점점 덜 늘고, 드래그는 지수 > 1로 점점 더 는다 → 윙의 한계 효율이 줄어든다.
  const rideHeight = m.aero.ride_height[ae.philosophy][setup.ride_height];
  const wheelbase = m.chassis.wheelbase[ch.wheelbase];
  const [clAt0, clAt1] = m.aero.downforce_area_m2;
  const downforceArea =
    (clAt0 + (clAt1 - clAt0) * wing ** m.aero.downforce_curve_exponent) *
    rideHeight.downforce *
    wheelbase.downforce *
    inst.downforceMult;
  const [cdAt0, cdAt1] = m.aero.drag_area_m2;
  const dragArea =
    (cdAt0 + (cdAt1 - cdAt0) * wing ** m.aero.drag_curve_exponent) *
    rideHeight.drag *
    (1 - m.aero.efficiency_drag_cut * ae.aero_efficiency) *
    (1 + m.cooling.drag_at_full * pt.cooling) *
    (1 + m.aero.drs_drag_cost * ae.drs_effect);
  const halfRho = 0.5 * regs.physics.air_density_kg_m3; // ½ρ
  const drag_coeff = halfRho * dragArea;
  const downforce_coeff = m.aero.aero_grip_mu * halfRho * downforceArea;

  // 타이어 하중 민감도: 무거울수록 마찰계수가 준다 (최소 무게 기준). 4절 "kg당 0.03 s/lap"을 맞추는 항.
  const loadFactor = (regs.limits.min_weight_kg / mass_kg) ** m.chassis.load_sensitivity;
  const mech_grip =
    lerp(m.chassis.mech_grip_mu, ch.mech_grip) * wheelbase.mech_grip * inst.mechGripMult * loadFactor;

  const fuel_per_lap_kg =
    (track.length_m / M_PER_KM) * m.fuel.per_km_kg * (1 - m.fuel.thermal_efficiency_saving * pt.thermal_efficiency);

  // 6절: 다운포스가 높으면 슬라이딩이 줄어 마모 소폭 감소 × (1 − relief · wing_level/10).
  const deg_multiplier =
    lerp(m.tire_management.deg_multiplier, ch.tire_management) *
    (1 - regs.tires.downforce_wear_relief * wing) *
    inst.wearMult;
  const warmup_penalty_s = lerp(m.tire_management.warmup_penalty_s, ch.tire_management);

  const failure_rate_per_lap =
    lerp(m.reliability.failure_rate_per_lap, pt.reliability) *
    (1 + m.reliability.thermal_efficiency_failure * pt.thermal_efficiency);

  return {
    power_kw,
    mass_kg,
    drag_coeff,
    downforce_coeff,
    mech_grip,
    fuel_per_lap_kg,
    deg_multiplier,
    warmup_penalty_s,
    failure_rate_per_lap,
    heat_derate,
    dirty_air_loss: lerp(m.aero.dirty_air_loss, ae.dirty_air_resistance),
    drs_gain: lerp(m.aero.drs_gain, ae.drs_effect),
    ers_boost: lerp(m.ers.boost, pt.ers_capacity) * ers.boost_mult,
  };
}
