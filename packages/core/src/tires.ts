/**
 * 타이어 (DESIGN.md 6절): 열화(deg), 랩당 마모, 컴파운드 오프셋, 워밍업.
 * 숫자는 전부 regulations.tires / regulations.pace_modes / regulations.car.tire_management에서 온다.
 */
import type { DerivedPerf } from './car.js';
import type { Compound, PaceMode, Regulations, Surface } from './regulations.js';

/**
 * 타이어 열화 랩타임 페널티 (s/lap).
 * life가 클리프 위면 선형 (life 1.0 → 0, 클리프 → linear_max_s),
 * 클리프 아래면 cliff_base_s에서 시작해 cliff_slope_s 기울기로 가파르게 증가.
 * life는 [0, 1]로 자른다. life 0은 강제 피트 대상 (7절 폴백, 레이스 엔진 몫).
 */
export function degradation(compound: Compound, life: number, regs: Regulations): number {
  const cliff = regs.tires.compounds[compound].cliff_life;
  const d = regs.tires.degradation;
  const l = Math.min(1, Math.max(0, life));
  if (l >= cliff) return (d.linear_max_s * (1 - l)) / (1 - cliff);
  return d.cliff_base_s + d.cliff_slope_s * (cliff - l);
}

/**
 * 한 랩의 life 감소량 (6절):
 * 마모율 × abrasiveness × deg_multiplier × pace_wear × (1 + dirty_air_wear · dirty_air) × (dry 노면이면 dry_wear_mult).
 * deg_multiplier에는 tire_management, 다운포스 슬라이딩 감소, floor 불안정이 이미 들어 있다 (derive).
 */
export function wearPerLap(
  compound: Compound,
  perf: Pick<DerivedPerf, 'deg_multiplier'>,
  track: { readonly abrasiveness: number },
  pace: PaceMode,
  dirtyAir: boolean,
  surface: Surface,
  regs: Regulations,
): number {
  const c = regs.tires.compounds[compound];
  return (
    c.wear_per_lap *
    track.abrasiveness *
    perf.deg_multiplier *
    regs.pace_modes[pace].wear_mult *
    (dirtyAir ? 1 + regs.tires.dirty_air_wear : 1) *
    (surface === 'dry' ? c.dry_wear_mult : 1)
  );
}

/** 컴파운드 × 노면 랩타임 오프셋 (s/lap, 6절 표). 맞지 않는 노면의 컴파운드가 받는 페널티도 여기. */
export function tireOffset(compound: Compound, surface: Surface, regs: Regulations): number {
  return regs.tires.compounds[compound].offset_s[surface];
}

/**
 * 새 타이어 워밍업 페널티 (s). tireAgeLaps는 이 세트로 이미 끝낸 랩 수 (첫 랩 = 0).
 * - 컴파운드: 표의 warmup_laps 동안 compound_warmup_penalty_s.
 * - 차량: tire_management가 높을수록 커지는 carPenaltyS(DerivedPerf.warmup_penalty_s)를 레이스 초반 랩 동안.
 */
export function warmupPenalty(compound: Compound, tireAgeLaps: number, carPenaltyS: number, regs: Regulations): number {
  const compoundLaps = regs.tires.compounds[compound].warmup_laps;
  const carLaps = regs.car.tire_management.warmup_laps.race;
  return (
    (tireAgeLaps < compoundLaps ? regs.tires.compound_warmup_penalty_s : 0) + (tireAgeLaps < carLaps ? carPenaltyS : 0)
  );
}
