/**
 * 사전 전략 DSL (DESIGN.md 8절): GPPlan = 셋업 + 그리드 조건별 RacePlan 변형.
 * 임의 코드 없이 고정된 트리거·액션 어휘만. 스키마(zod strict) → 검증(validatePlan: 거부) → 린트(lint: 경고).
 * 레이스 엔진은 selectVariant로 변형을 고르고, 매 랩 evaluateRules로 첫 매치 규칙을 실행한다.
 */
import { z } from 'zod';
import { SetupSchema } from './car.js';
import {
  CompoundSchema,
  PaceModeSchema,
  SurfaceSchema,
  toIssues,
  type Compound,
  type Result,
  type Rules,
  type ValidationIssue,
} from './regulations.js';

// ── 스키마 ─────────────────────────────────────────────────────────────

const lap = z.int().min(1);
const gap = z.number().min(0);

export const RaceEventSchema = z.enum(['safety_car', 'safety_car_end', 'rain_start', 'rain_stop']);
export type RaceEvent = z.infer<typeof RaceEventSchema>;

/** 규칙 조건 (8절 트리거 어휘). 한 when 안의 조건은 AND. */
export const RuleConditionsSchema = z.strictObject({
  lap_gte: lap.optional(),
  lap_lte: lap.optional(),
  lap_between: z.tuple([lap, lap]).optional(),
  laps_remaining_lte: z.int().min(0).optional(),
  event: RaceEventSchema.optional(),
  surface: SurfaceSchema.optional(),
  tire_life_lte: z.number().min(0).max(1).optional(),
  tire_age_gte: z.int().min(0).optional(),
  tire_compound: CompoundSchema.optional(),
  laps_on_compound_gte: z.int().min(0).optional(),
  position_lte: z.int().min(1).optional(),
  position_gte: z.int().min(1).optional(),
  gap_ahead_lte: gap.optional(),
  gap_behind_lte: gap.optional(),
  gap_behind_gte: gap.optional(),
  rival_ahead_pitted: z.boolean().optional(),
  rival_behind_pitted: z.boolean().optional(),
  stint_index_eq: z.int().min(0).optional(),
});
export type RuleConditions = z.infer<typeof RuleConditionsSchema>;

/** 변형 선택 조건 (grid_*는 여기서만). */
export const VariantConditionsSchema = z.strictObject({
  grid_lte: z.int().min(1).optional(),
  grid_gte: z.int().min(1).optional(),
});
export type VariantConditions = z.infer<typeof VariantConditionsSchema>;

const ACTION_HELP =
  'must be one of {pit: <compound>}, {pit: next_planned}, {pace: push|normal|conserve}, {extend_stint: <laps>} or none';

/** 액션 (한 규칙에 하나). */
export const ActionSchema = z.union(
  [
    z.strictObject({ pit: z.union([CompoundSchema, z.literal('next_planned')]) }),
    z.strictObject({ pace: PaceModeSchema }),
    z.strictObject({ extend_stint: z.int().min(1) }),
    z.literal('none'),
  ],
  { error: ACTION_HELP },
);
export type Action = z.infer<typeof ActionSchema>;

export const RuleSchema = z.strictObject({
  when: RuleConditionsSchema,
  do: ActionSchema,
  once: z.boolean().optional(),
  cooldown: z.int().min(1).optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const StintSchema = z.strictObject({
  compound: CompoundSchema,
  planned_pit_lap: lap.optional(),
});
export type Stint = z.infer<typeof StintSchema>;

export const RacePlanSchema = z.strictObject({
  start_compound: CompoundSchema,
  pace: PaceModeSchema,
  stints: z.array(StintSchema).min(1),
  rules: z.array(RuleSchema),
});
export type RacePlan = z.infer<typeof RacePlanSchema>;

export const VariantSchema = z.strictObject({
  when: VariantConditionsSchema,
  plan: RacePlanSchema,
});

export const GPPlanSchema = z.strictObject({
  setup: SetupSchema,
  variants: z.array(VariantSchema).min(1),
});
export type GPPlan = z.infer<typeof GPPlanSchema>;

// ── 검증 (거부) ────────────────────────────────────────────────────────

export interface PlanContext {
  /** 레이스 랩 수 (planned_pit_lap 범위 검사). */
  readonly laps?: number;
}

const RULE_CONDITION_KEYS = RuleConditionsSchema.keyof().options;
const VARIANT_CONDITION_KEYS = VariantConditionsSchema.keyof().options;

function ruleConditionCount(when: RuleConditions): number {
  return RULE_CONDITION_KEYS.filter((k) => when[k] !== undefined).length;
}

function variantConditionCount(when: VariantConditions): number {
  return VARIANT_CONDITION_KEYS.filter((k) => when[k] !== undefined).length;
}

/** 예선 후 이 GP에 쓸 수 있는 컴파운드별 세트 수 (배분 − 예선 사용). */
export function raceSets(rules: Pick<Rules, 'tires'>): Record<Compound, number> {
  const t = rules.tires;
  const sets = { ...t.allocation_sets };
  sets[t.qualifying.compound] = Math.max(0, sets[t.qualifying.compound] - t.qualifying.sets);
  return sets;
}

/**
 * 제출된 GPPlan 검증 (9절 파이프라인 1–3의 거부 부분): 스키마 → 8절 제한 → 배분·스틴트 정합성.
 * 메시지는 사람이 읽는 문장 (LLM 재제출과 사람 팀 UI가 같은 문자열을 본다).
 */
export function validatePlan(
  plan: unknown,
  rules: Pick<Rules, 'tires' | 'strategy'>,
  context: PlanContext = {},
): Result<GPPlan, ValidationIssue[]> {
  const parsed = GPPlanSchema.safeParse(plan, { reportInput: true });
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error.issues, GPPlanSchema) };
  const p = parsed.data;
  const limits = rules.strategy;
  const issues: ValidationIssue[] = [];
  if (p.variants.length > limits.max_variants) {
    issues.push({ path: 'variants', message: `at most ${limits.max_variants} variants are allowed (got ${p.variants.length})` });
  }
  const sets = raceSets(rules);
  p.variants.forEach((variant, v) => {
    const at = `variants[${v}]`;
    const plan_ = variant.plan;
    if (plan_.rules.length > limits.max_rules) {
      issues.push({ path: `${at}.plan.rules`, message: `at most ${limits.max_rules} rules per variant (got ${plan_.rules.length})` });
    }
    if (plan_.stints.length > limits.max_stints) {
      issues.push({ path: `${at}.plan.stints`, message: `at most ${limits.max_stints} stints (got ${plan_.stints.length})` });
    }
    if (plan_.stints[0]?.compound !== plan_.start_compound) {
      issues.push({
        path: `${at}.plan.start_compound`,
        message: `must match the first stint's compound "${plan_.stints[0]?.compound ?? ''}" (got "${plan_.start_compound}")`,
      });
    }
    const used: Partial<Record<Compound, number>> = {};
    let previousPit = 0;
    plan_.stints.forEach((stint, k) => {
      used[stint.compound] = (used[stint.compound] ?? 0) + 1;
      const last = k === plan_.stints.length - 1;
      if (stint.planned_pit_lap !== undefined) {
        if (last) {
          issues.push({ path: `${at}.plan.stints[${k}].planned_pit_lap`, message: 'the last stint cannot have a planned pit lap (no stint follows it)' });
        } else if (stint.planned_pit_lap <= previousPit) {
          issues.push({ path: `${at}.plan.stints[${k}].planned_pit_lap`, message: `must be later than the previous planned pit lap ${previousPit}` });
        } else if (context.laps !== undefined && stint.planned_pit_lap >= context.laps) {
          issues.push({ path: `${at}.plan.stints[${k}].planned_pit_lap`, message: `must be before the last lap (race has ${context.laps} laps)` });
        }
        previousPit = stint.planned_pit_lap;
      }
    });
    for (const compound of CompoundSchema.options) {
      const n = used[compound] ?? 0;
      if (n > sets[compound]) {
        issues.push({ path: `${at}.plan.stints`, message: `plans ${n} ${compound} stints but only ${sets[compound]} ${compound} sets are available for the race` });
      }
    }
    plan_.rules.forEach((rule, r) => {
      const where = `${at}.plan.rules[${r}]`;
      if (ruleConditionCount(rule.when) > limits.max_conditions) {
        issues.push({ path: `${where}.when`, message: `at most ${limits.max_conditions} conditions per rule (got ${ruleConditionCount(rule.when)})` });
      }
      const between = rule.when.lap_between;
      if (between && between[0] > between[1]) {
        issues.push({ path: `${where}.when.lap_between`, message: `must be [first, last] with first ≤ last (got [${between[0]}, ${between[1]}])` });
      }
      if (typeof rule.do === 'object' && 'pit' in rule.do && rule.do.pit !== 'next_planned' && sets[rule.do.pit] === 0) {
        issues.push({ path: `${where}.do.pit`, message: `no ${rule.do.pit} sets are available for the race` });
      }
      if (rule.once && rule.cooldown !== undefined) {
        issues.push({ path: `${where}`, message: 'use either once or cooldown, not both' });
      }
    });
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: p };
}

/** 위험하지만 허용되는 패턴 (9절 파이프라인 3의 경고 부분). */
export function lint(plan: GPPlan): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  plan.variants.forEach((variant, v) => {
    const at = `variants[${v}]`;
    variant.plan.rules.forEach((rule, r) => {
      if (typeof rule.do === 'object' && 'pit' in rule.do && !rule.once && rule.cooldown === undefined) {
        warnings.push({
          path: `${at}.plan.rules[${r}]`,
          message: 'pit rule without once or cooldown fires every lap while its conditions hold',
        });
      }
      if (ruleConditionCount(rule.when) === 0 && r < variant.plan.rules.length - 1 && !rule.once && rule.cooldown === undefined) {
        warnings.push({ path: `${at}.plan.rules[${r}]`, message: 'rule with no conditions always matches, so the rules below it never run' });
      }
    });
  });
  const last = plan.variants.at(-1);
  if (last && variantConditionCount(last.when) > 0) {
    warnings.push({ path: `variants[${plan.variants.length - 1}].when`, message: 'the last variant is the default when nothing matches; its conditions are ignored' });
  }
  return warnings;
}

// ── 실행 ───────────────────────────────────────────────────────────────

/** 예선 후 변형 선택 (7절): 위에서부터 첫 매치, 없으면 마지막. */
export function selectVariant(plan: GPPlan, grid: number): { readonly index: number; readonly plan: RacePlan } {
  const index = plan.variants.findIndex(
    (v) => (v.when.grid_lte === undefined || grid <= v.when.grid_lte) && (v.when.grid_gte === undefined || grid >= v.when.grid_gte),
  );
  const chosen = index >= 0 ? index : plan.variants.length - 1;
  const variant = plan.variants[chosen];
  if (!variant) throw new Error('plan has no variants');
  return { index: chosen, plan: variant.plan };
}

/** 랩 시작 시점(S/F 라인)에 한 차가 보는 상태 (8절 평가 의미론 1). */
export interface RuleView {
  readonly lap: number;
  readonly laps_remaining: number;
  readonly events: ReadonlySet<RaceEvent>;
  readonly surface: z.infer<typeof SurfaceSchema>;
  readonly tire_life: number;
  readonly tire_age: number;
  readonly tire_compound: Compound;
  readonly laps_on_compound: number;
  readonly position: number;
  /** 앞차와의 간격 s (선두면 Infinity). */
  readonly gap_ahead: number;
  /** 뒤차와의 간격 s (최후미면 Infinity). */
  readonly gap_behind: number;
  readonly rival_ahead_pitted: boolean;
  readonly rival_behind_pitted: boolean;
  readonly stint_index: number;
}

/** 조건이 모두 참인가 (AND). 비어 있으면 참. */
export function matches(when: RuleConditions, v: RuleView): boolean {
  const ok = (cond: unknown, test: () => boolean) => cond === undefined || test();
  return (
    ok(when.lap_gte, () => v.lap >= (when.lap_gte ?? 0)) &&
    ok(when.lap_lte, () => v.lap <= (when.lap_lte ?? 0)) &&
    ok(when.lap_between, () => v.lap >= (when.lap_between?.[0] ?? 0) && v.lap <= (when.lap_between?.[1] ?? 0)) &&
    ok(when.laps_remaining_lte, () => v.laps_remaining <= (when.laps_remaining_lte ?? 0)) &&
    ok(when.event, () => v.events.has(when.event as RaceEvent)) &&
    ok(when.surface, () => v.surface === when.surface) &&
    ok(when.tire_life_lte, () => v.tire_life <= (when.tire_life_lte ?? 0)) &&
    ok(when.tire_age_gte, () => v.tire_age >= (when.tire_age_gte ?? 0)) &&
    ok(when.tire_compound, () => v.tire_compound === when.tire_compound) &&
    ok(when.laps_on_compound_gte, () => v.laps_on_compound >= (when.laps_on_compound_gte ?? 0)) &&
    ok(when.position_lte, () => v.position <= (when.position_lte ?? 0)) &&
    ok(when.position_gte, () => v.position >= (when.position_gte ?? 0)) &&
    ok(when.gap_ahead_lte, () => v.gap_ahead <= (when.gap_ahead_lte ?? 0)) &&
    ok(when.gap_behind_lte, () => v.gap_behind <= (when.gap_behind_lte ?? 0)) &&
    ok(when.gap_behind_gte, () => v.gap_behind >= (when.gap_behind_gte ?? 0)) &&
    ok(when.rival_ahead_pitted, () => v.rival_ahead_pitted === when.rival_ahead_pitted) &&
    ok(when.rival_behind_pitted, () => v.rival_behind_pitted === when.rival_behind_pitted) &&
    ok(when.stint_index_eq, () => v.stint_index === when.stint_index_eq)
  );
}

/** 규칙별 비활성 상태: 이 랩까지 꺼져 있다 (once면 Infinity). */
export type RuleState = readonly number[];

export function initialRuleState(plan: RacePlan): RuleState {
  return plan.rules.map(() => 0);
}

/**
 * 첫 매치 규칙 (8절 평가 의미론 2–3). 꺼진 규칙은 건너뛴다.
 * 발동하면 새 상태를 돌려준다: once → 영구 비활성, cooldown n → 다음 n랩 비활성.
 */
export function evaluateRules(
  plan: RacePlan,
  view: RuleView,
  state: RuleState,
): { readonly fired: { readonly index: number; readonly action: Action } | null; readonly state: RuleState } {
  for (let i = 0; i < plan.rules.length; i++) {
    const rule = plan.rules[i];
    if (!rule || view.lap <= (state[i] ?? 0)) continue;
    if (!matches(rule.when, view)) continue;
    const next = [...state];
    if (rule.once) next[i] = Infinity;
    else if (rule.cooldown !== undefined) next[i] = view.lap + rule.cooldown;
    return { fired: { index: i, action: rule.do }, state: next };
  }
  return { fired: null, state };
}

/** 피트할 때 낄 컴파운드: 다음 계획 스틴트, 없으면 hard (8절 next_planned). */
export function nextPlannedCompound(plan: RacePlan, stintIndex: number, fallback: Compound = 'hard'): Compound {
  return plan.stints[stintIndex + 1]?.compound ?? fallback;
}

