/**
 * 랩타임 (DESIGN.md 6절).
 *
 * baseLap: 깨끗한 공기, 새 타이어, 연료 0. 재샘플링된 센터라인(5 m) 위의 준정상 랩 시뮬레이션:
 *   1) 코너 샘플마다 한계 속도 μ_eff·g·r = v², μ_eff = mech_grip + downforce_coeff·v²/(m·g) — 닫힌해.
 *   2) 앞으로: 구동력 = min(P/v, 트랙션 한계) − 공기저항, Δs 간격 적분 (DRS 구간은 드래그 × (1 − drs_gain)).
 *   3) 뒤로: 상수 감속도로 다음 코너 한계 속도까지 제동.
 *   4) 두 속도의 최솟값이 랩의 속도 프로파일. 가장 느린 코너 정점에서 시작해 한 바퀴 돌린다 (플라잉 랩).
 * raceLap: 6절 식 그대로. 노이즈는 만들지 않고 호출자가 넘긴 값을 더한다.
 */
import type { DerivedPerf } from './car.js';
import type { Compound, PaceMode, Regulations, Surface } from './regulations.js';
import { degradation, tireOffset, warmupPenalty } from './tires.js';
import type { CornerClass, Track } from './track.js';

/**
 * 랩 시간 내역 (s). total = straight + lowSpeed + midSpeed + highSpeed.
 * 구간을 "무엇이 속도를 정했나"로 나눈다:
 * - straight: 풀 스로틀 (출력 한계로 가속하거나 최고속). 휘어 있어도 풀 스로틀로 도는 고속 굽이는 여기.
 * - low/mid/highSpeed: 그 등급 코너에 걸린 시간 — 코너로 들어가는 제동, 그립 한계 정점, 트랙션 한계 탈출.
 */
export interface LapBreakdown {
  readonly total: number;
  readonly straight: number;
  readonly lowSpeed: number;
  readonly midSpeed: number;
  readonly highSpeed: number;
  readonly topSpeedKph: number;
}

// 단위 환산·수치 안전장치 (게임 수치 아님).
const W_PER_KW = 1000;
const KPH_PER_M_S = 3.6;
/** 적분 중 속도의 하한 (m/s). P/v 발산과 음수 제곱근을 막는다. */
const MIN_SPEED_M_S = 1;
/** 코너 세그먼트가 아닌 샘플, 또는 아직 코너를 지나지 않은 구간. */
const NO_CORNER = -1;

/** @internal 샘플별 속도와 구간별 귀속. 구간 i는 samples[i] → samples[i+1]. */
export interface LapTrace {
  /** 샘플별 속도 (m/s). */
  readonly speed: Float64Array;
  /** 구간 i의 시간이 붙는 코너 세그먼트 인덱스. 풀 스로틀이면 NO_CORNER(−1). */
  readonly owner: Int32Array;
}

/** @internal 속도 프로파일과 귀속을 함께 계산한다 (baseLap, 이후 레이스 로그의 거리 샘플이 같이 쓴다). */
export function lapTrace(perf: DerivedPerf, track: Track, surface: Surface, regs: Regulations): LapTrace {
  const g = regs.physics.gravity_m_s2;
  const grip = regs.laptime.surface_grip[surface];
  const mass = perf.mass_kg;
  const power = perf.power_kw * W_PER_KW;
  const mu = perf.mech_grip * grip;
  const aero = perf.downforce_coeff * grip; // 에어로 그립 힘 = aero · v²
  const decel = regs.laptime.braking_decel_m_s2 * grip;
  const traction = regs.laptime.traction_share;
  const n = track.samples.length;
  const ds = track.step_m;
  const substeps = Math.max(1, Math.round(ds / regs.laptime.straight_step_m));
  const h = ds / substeps;

  const limit = new Float64Array(n);
  const drag = new Float64Array(n);
  const corner = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const sample = track.samples[i];
    const index = sample?.segment ?? 0;
    const seg = track.segments[index];
    corner[i] = seg?.kind === 'corner' ? index : NO_CORNER;
    if (seg?.kind === 'corner') {
      const denom = 1 - (aero * seg.radius) / mass;
      limit[i] = denom > 0 ? Math.sqrt((g * seg.radius * mu) / denom) : Infinity;
    } else {
      limit[i] = Infinity;
    }
    drag[i] = perf.drag_coeff * (sample?.drs && seg?.kind === 'straight' ? 1 - perf.drs_gain : 1);
  }

  const tractionForce = (v: number): number => traction * (mu * mass * g + aero * v * v);
  const accel = (v: number, d: number): number => (Math.min(power / v, tractionForce(v)) - d * v * v) / mass;
  const forward = (v0: number, d: number): number => {
    let v = v0;
    for (let k = 0; k < substeps; k++) {
      const vMid = Math.sqrt(Math.max(v * v + accel(v, d) * h, MIN_SPEED_M_S ** 2));
      v = Math.sqrt(Math.max(v * v + 2 * accel(vMid, d) * h, MIN_SPEED_M_S ** 2));
    }
    return v;
  };

  // 가장 느린 코너 정점에서 출발한다 (그 점의 속도는 한계 속도로 확정).
  let start = 0;
  for (let i = 1; i < n; i++) if ((limit[i] ?? Infinity) < (limit[start] ?? Infinity)) start = i;
  const topSpeed = Math.cbrt(power / (drag[start] ?? perf.drag_coeff)); // P = D·v³
  const v0 = Math.min(limit[start] ?? Infinity, topSpeed);

  // 앞으로: 가속 한계. fromCorner = 이 가속이 시작된 (마지막으로 속도를 묶은) 코너.
  const vf = new Float64Array(n);
  const fromCorner = new Int32Array(n);
  vf[start] = v0;
  fromCorner[start] = corner[start] ?? NO_CORNER;
  for (let k = 1; k < n; k++) {
    const i = (start + k) % n;
    const prev = (i - 1 + n) % n;
    const reach = forward(vf[prev] ?? v0, drag[prev] ?? perf.drag_coeff);
    const lim = limit[i] ?? Infinity;
    vf[i] = Math.min(lim, reach);
    fromCorner[i] = lim <= reach ? (corner[i] ?? NO_CORNER) : (fromCorner[prev] ?? NO_CORNER);
  }
  // 뒤로: 제동 한계. toCorner = 이 제동이 향하는 코너.
  const vb = new Float64Array(n);
  const toCorner = new Int32Array(n);
  vb[start] = v0;
  toCorner[start] = corner[start] ?? NO_CORNER;
  for (let k = 1; k < n; k++) {
    const i = (start - k + n) % n;
    const next = (i + 1) % n;
    const reach = Math.sqrt((vb[next] ?? v0) ** 2 + 2 * decel * ds);
    const lim = limit[i] ?? Infinity;
    vb[i] = Math.min(lim, reach);
    toCorner[i] = lim <= reach ? (corner[i] ?? NO_CORNER) : (toCorner[next] ?? NO_CORNER);
  }

  const speed = new Float64Array(n);
  const owner = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const f = vf[i] ?? v0;
    const b = vb[i] ?? v0;
    const v = Math.min(f, b);
    speed[i] = v;
    if (b < f) owner[i] = toCorner[i] ?? NO_CORNER; // 제동: 들어갈 코너
    else if (v >= (limit[i] ?? Infinity)) owner[i] = corner[i] ?? NO_CORNER; // 그립 한계
    else if (tractionForce(v) < power / v) owner[i] = fromCorner[i] ?? NO_CORNER; // 트랙션 한계 탈출
    else owner[i] = NO_CORNER; // 풀 스로틀
  }
  return { speed, owner };
}

/** 기본 랩타임과 내역 (6절 base_lap). 내역의 귀속은 LapBreakdown 참고. */
export function baseLap(perf: DerivedPerf, track: Track, surface: Surface, regs: Regulations): LapBreakdown {
  const { speed, owner } = lapTrace(perf, track, surface, regs);
  const n = speed.length;
  const ds = track.step_m;
  const byClass: Record<CornerClass, number> = { low: 0, mid: 0, high: 0 };
  let straight = 0;
  let top = 0;
  for (let i = 0; i < n; i++) {
    const a = speed[i] ?? 0;
    const b = speed[(i + 1) % n] ?? 0;
    top = Math.max(top, a);
    const dt = (2 * ds) / (a + b);
    const seg = track.segments[owner[i] ?? NO_CORNER];
    if (seg?.kind === 'corner') byClass[seg.class] += dt;
    else straight += dt;
  }
  return {
    total: straight + byClass.low + byClass.mid + byClass.high,
    straight,
    lowSpeed: byClass.low,
    midSpeed: byClass.mid,
    highSpeed: byClass.high,
    topSpeedKph: top * KPH_PER_M_S,
  };
}

/** raceLap 입력. 같은 랩의 baseLap은 같은 노면으로 계산돼 있어야 한다. */
export interface LapState {
  readonly compound: Compound;
  readonly surface: Surface;
  /** 1.0 = 새 타이어. */
  readonly tire_life: number;
  /** 이 세트로 끝낸 랩 수 (새 세트의 첫 랩 = 0). */
  readonly tire_age_laps: number;
  readonly fuel_kg: number;
  readonly pace: PaceMode;
  /** 앞차와의 간격 (s). 앞차가 없으면 Infinity. */
  readonly gap_ahead_s: number;
  /** DerivedPerf.dirty_air_loss */
  readonly dirty_air_loss: number;
  /** DerivedPerf.warmup_penalty_s */
  readonly warmup_penalty_s: number;
  /** 호출자가 rng로 뽑은 랩 노이즈 (보통 N(0, laptime.noise_sd_s)). */
  readonly noise_s: number;
}

/** 앞차와 이 간격 미만이면 더티 에어 (wearPerLap의 dirtyAir 인자와 같은 판정). */
/**
 * 랩 안에서의 진행 (리플레이용): progress[i] = 출발선에서 samples[i]까지 걸린 시간 / 랩 시간. progress[0] = 0, 단조 증가, 1 미만.
 * 레이스 로그에는 랩 시간만 있으므로, 렌더러는 이 곡선으로 랩 안의 위치를 보간한다 (코너에서 느리게, 직선에서 빠르게).
 */
export function lapProgress(perf: DerivedPerf, track: Track, surface: Surface, regs: Regulations): number[] {
  const { speed } = lapTrace(perf, track, surface, regs);
  const n = speed.length;
  const ds = track.step_m;
  const cum = new Array<number>(n).fill(0);
  let t = 0;
  for (let i = 0; i < n; i++) {
    cum[i] = t;
    const a = speed[i] ?? 0;
    const b = speed[(i + 1) % n] ?? 0;
    t += (2 * ds) / (a + b);
  }
  return cum.map((c) => c / t);
}

export function inDirtyAir(gapAheadS: number, regs: Regulations): boolean {
  return gapAheadS < regs.laptime.dirty_air.gap_s;
}

/**
 * 레이스 랩타임 (6절):
 * base + tire_offset + deg(life) + 0.03·fuel + pace_delta + dirty_air + warmup + noise.
 * 더티 에어는 다운포스 손실이 코너 구간 시간에만 붙는다고 보고 dirty_air_loss × factor × 코너 시간.
 */
export function raceLap(base: LapBreakdown, state: LapState, regs: Regulations): number {
  const cornerTime = base.lowSpeed + base.midSpeed + base.highSpeed;
  const dirtyAir = inDirtyAir(state.gap_ahead_s, regs)
    ? state.dirty_air_loss * regs.laptime.dirty_air.corner_time_factor * cornerTime
    : 0;
  return (
    base.total +
    tireOffset(state.compound, state.surface, regs) +
    degradation(state.compound, state.tire_life, regs) +
    regs.fuel.lap_time_per_kg_s * state.fuel_kg +
    regs.pace_modes[state.pace].lap_delta_s +
    dirtyAir +
    warmupPenalty(state.compound, state.tire_age_laps, state.warmup_penalty_s, regs) +
    state.noise_s
  );
}
