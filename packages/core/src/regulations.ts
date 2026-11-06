/**
 * 규정 스키마·파서, 비용, 스펙 검증 (DESIGN.md 3절, 16절 공개 API).
 *
 * 값은 전부 data/regulations/<season>.yaml에 있고, 이 파일은 구조와 검증만 정의한다.
 * 검증 오류 메시지는 사람이 읽는 문장이다 — LLM 재제출과 사람 팀 UI가 같은 문자열을 본다 (9절).
 */
import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  CarSpecSchema,
  ErsModeSchema,
  PhilosophySchema,
  RideHeightSchema,
  SPEC_PARAMS,
  SetupSchema,
  WheelbaseSchema,
  type CarSpec,
  type Setup,
} from './car.js';

// ── 결과 타입 (16절) ───────────────────────────────────────────────────

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: E };

export interface ValidationIssue {
  /** 문제 필드 경로 (`chassis.mech_grip`, `rules[3].when`). 제출물 전체에 대한 문제면 빈 문자열. */
  readonly path: string;
  /** 사람이 읽는 문장. */
  readonly message: string;
}

/** `path: message` 한 줄 (경로가 없으면 message만). AgentIOLog의 errors 목록 형식 (10절). */
export function formatIssue(issue: ValidationIssue): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;
}

// ── 규정 어휘 ──────────────────────────────────────────────────────────

export const CompoundSchema = z.enum(['soft', 'medium', 'hard', 'inter', 'wet']);
export type Compound = z.infer<typeof CompoundSchema>;
/** 드라이 컴파운드 (3절 2종 의무의 대상). */
export const DRY_COMPOUNDS = ['soft', 'medium', 'hard'] as const satisfies readonly Compound[];

export const SurfaceSchema = z.enum(['dry', 'damp', 'wet']);
export type Surface = z.infer<typeof SurfaceSchema>;

export const PaceModeSchema = z.enum(['push', 'normal', 'conserve']);
export type PaceMode = z.infer<typeof PaceModeSchema>;

// ── Regulations 스키마 (yaml 구조와 1:1, strict) ───────────────────────

const finite = z.number();
const nonNegative = z.number().min(0);
const positive = z.number().positive();
const fraction = z.number().min(0).max(1);
const count = z.int().min(0);
const positiveCount = z.int().min(1);
/** [파라미터 0.0일 때, 1.0일 때]. derive()가 선형 보간한다. */
const pairOf = <T extends z.ZodType>(item: T) => z.tuple([item, item]);

/** 3절 코스트 캡: 비용 = Σ weights_i · x_i^exponent ≤ cap_credits. 키는 SPEC_PARAMS와 같다. */
const CostSchema = z.strictObject({
  cap_credits: positive,
  exponent: positive,
  weights: z.strictObject({
    aero_efficiency: positive,
    thermal_efficiency: positive,
    weight_reduction: positive,
    mech_grip: positive,
    tire_management: positive,
    ers_capacity: positive,
    reliability: positive,
    cooling: positive,
    dirty_air_resistance: positive,
    drs_effect: positive,
  }),
});
type CostRules = z.infer<typeof CostSchema>;

const CompoundRulesSchema = z.strictObject({
  offset_s: z.record(SurfaceSchema, finite),
  wear_per_lap: positive,
  dry_wear_mult: positive,
  cliff_life: z.number().gt(0).lt(1),
  warmup_laps: count,
});

const PaceModeRulesSchema = z.strictObject({
  lap_delta_s: finite,
  wear_mult: positive,
  fuel_mult: positive,
  failure_mult: nonNegative,
});

const AeroMultSchema = z.strictObject({ downforce: positive, drag: positive });

/** derive() 계수 (4절). 문서에 값이 없는 것들이라 대부분 TODO(balance). */
const CarModelSchema = z.strictObject({
  power: z.strictObject({
    fuel_energy_mj_per_kg: positive,
    thermal_efficiency_eta: pairOf(z.number().gt(0).lt(1)),
    reliability_power_loss: fraction,
  }),
  cooling: z.strictObject({
    derate_from_c: finite,
    full_cooling_at_c: finite,
    max_derate: fraction,
    drag_at_full: nonNegative,
  }),
  mass: z.strictObject({ battery_kg_at_full_ers: nonNegative }),
  ers: z.strictObject({
    boost: pairOf(nonNegative),
    modes: z.record(
      ErsModeSchema,
      z.strictObject({ power_kw: finite, depletion: fraction, boost_mult: nonNegative }),
    ),
  }),
  aero: z.strictObject({
    downforce_area_m2: pairOf(positive),
    drag_area_m2: pairOf(positive),
    downforce_curve_exponent: positive,
    drag_curve_exponent: positive,
    aero_grip_mu: positive,
    efficiency_drag_cut: z.number().min(0).lt(1),
    drs_gain: pairOf(z.number().min(0).lt(1)),
    drs_drag_cost: nonNegative,
    dirty_air_loss: pairOf(z.number().min(0).lt(1)),
    ride_height: z.record(PhilosophySchema, z.record(RideHeightSchema, AeroMultSchema)),
  }),
  chassis: z.strictObject({
    mech_grip_mu: pairOf(positive),
    wheelbase: z.record(WheelbaseSchema, z.strictObject({ downforce: positive, mech_grip: positive })),
  }),
  instability: z.strictObject({
    bumpy_from: z.number().min(0).lt(1),
    floor_min_mech_grip: fraction,
    floor: z.strictObject({ downforce_loss: fraction, wear_mult: positive }),
    low_ride_on_bumps: z.strictObject({
      ride_height_sensitivity: z.record(RideHeightSchema, fraction),
      philosophy_sensitivity: z.record(PhilosophySchema, fraction),
      downforce_loss: fraction,
      mech_grip_loss: fraction,
    }),
  }),
  tire_management: z.strictObject({
    deg_multiplier: pairOf(positive),
    warmup_penalty_s: pairOf(nonNegative),
    warmup_laps: z.strictObject({ qualifying: count, race: count }),
  }),
  reliability: z.strictObject({
    failure_rate_per_lap: pairOf(z.number().min(0).lt(1)),
    thermal_efficiency_failure: nonNegative,
  }),
  fuel: z.strictObject({
    per_km_kg: positive,
    thermal_efficiency_saving: z.number().min(0).lt(1),
  }),
});

export const RegulationsSchema = z
  .strictObject({
    season: z.int(),
    cost: CostSchema,
    limits: z.strictObject({
      fuel_flow_kg_per_h: positive,
      min_weight_kg: positive,
      weight_reduction_span_kg: nonNegative,
    }),
    tools: z.strictObject({
      wind_tunnel: z.strictObject({
        runs_preseason: count,
        noise_sd_s: nonNegative,
        wear_compound: CompoundSchema,
      }),
      strategy_sim: z.strictObject({ runs_per_gp: count }),
    }),
    points: z.array(nonNegative).min(1),
    penalties: z.strictObject({
      dry_compound_rule_s: nonNegative,
      resubmissions: count,
      response_timeout_s: positive,
    }),
    fallback: z.strictObject({ spec: CarSpecSchema }),
    tires: z.strictObject({
      allocation_sets: z.record(CompoundSchema, count),
      qualifying: z.strictObject({ compound: CompoundSchema, sets: positiveCount }),
      dry_race_min_compounds: positiveCount,
      compounds: z.record(CompoundSchema, CompoundRulesSchema),
      degradation: z.strictObject({
        linear_max_s: nonNegative,
        cliff_base_s: nonNegative,
        cliff_slope_s: nonNegative,
      }),
      downforce_wear_relief: fraction,
      dirty_air_wear: nonNegative,
      compound_warmup_penalty_s: nonNegative,
    }),
    pace_modes: z.record(PaceModeSchema, PaceModeRulesSchema),
    fuel: z.strictObject({
      reserve_kg: nonNegative,
      lap_time_per_kg_s: nonNegative,
    }),
    laptime: z.strictObject({
      noise_sd_s: nonNegative,
      surface_grip: z.record(SurfaceSchema, positive),
      straight_step_m: positive,
      braking_decel_m_s2: positive,
      traction_share: fraction,
      dirty_air: z.strictObject({ gap_s: positive, corner_time_factor: nonNegative }),
    }),
    track: z.strictObject({
      resample_step_m: positive,
      straight_max_curvature: positive,
      corner_classes: z.strictObject({ low_max_radius_m: positive, mid_max_radius_m: positive }),
      overtake_reference_straight_m: positive,
    }),
    physics: z.strictObject({
      gravity_m_s2: positive,
      air_density_kg_m3: positive,
    }),
    car: CarModelSchema,
  })
  .superRefine((r, ctx) => {
    const fallbackCost = specCost(r.fallback.spec, r.cost);
    if (fallbackCost > r.cost.cap_credits + COST_EPSILON) {
      ctx.addIssue({
        code: 'custom',
        path: ['fallback', 'spec'],
        message: `the fallback spec costs ${credits(fallbackCost)} credits, over the cost cap of ${r.cost.cap_credits}`,
      });
    }
    const q = r.tires.qualifying;
    if (q.sets > r.tires.allocation_sets[q.compound]) {
      ctx.addIssue({
        code: 'custom',
        path: ['tires', 'qualifying', 'sets'],
        message: `qualifying uses ${q.sets} ${q.compound} sets but only ${r.tires.allocation_sets[q.compound]} are allocated`,
      });
    }
    if (r.tires.dry_race_min_compounds > DRY_COMPOUNDS.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['tires', 'dry_race_min_compounds'],
        message: `cannot require more than ${DRY_COMPOUNDS.length} dry compounds`,
      });
    }
    const classes = r.track.corner_classes;
    if (classes.mid_max_radius_m <= classes.low_max_radius_m) {
      ctx.addIssue({
        code: 'custom',
        path: ['track', 'corner_classes', 'mid_max_radius_m'],
        message: 'must be larger than low_max_radius_m',
      });
    }
    if (r.car.cooling.full_cooling_at_c <= r.car.cooling.derate_from_c) {
      ctx.addIssue({
        code: 'custom',
        path: ['car', 'cooling', 'full_cooling_at_c'],
        message: 'must be higher than derate_from_c',
      });
    }
  });

export type Regulations = z.infer<typeof RegulationsSchema>;

export class RegulationsError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(`invalid regulations:\n${issues.map((i) => `  - ${formatIssue(i)}`).join('\n')}`);
    this.name = 'RegulationsError';
    this.issues = issues;
  }
}

/**
 * @internal yaml 텍스트 → JS 값. 문법 오류·경고(중복 키 등)는 issue로 돌려준다.
 * yaml의 parse()는 경고를 console/process로 내보내므로 쓰지 않는다. logLevel 'error'면 toJS()도 조용하다.
 */
export function yamlToJs(yamlText: string): Result<unknown, ValidationIssue[]> {
  const doc = parseDocument(yamlText, { logLevel: 'error' });
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0) {
    return { ok: false, issues: problems.map((e) => ({ path: '', message: `YAML ${e.code}: ${e.message}` })) };
  }
  return { ok: true, value: doc.toJS() };
}

/** yaml 텍스트 → 검증된 Regulations. 잘못되면 모든 문제를 담은 RegulationsError를 던진다. */
export function parseRegulations(yamlText: string): Regulations {
  const raw = yamlToJs(yamlText);
  if (!raw.ok) throw new RegulationsError(raw.issues);
  const parsed = RegulationsSchema.safeParse(raw.value, { reportInput: true });
  if (!parsed.success) throw new RegulationsError(toIssues(parsed.error.issues, RegulationsSchema));
  return parsed.data;
}

// ── 비용 (3절) ─────────────────────────────────────────────────────────

/** 부동소수 오차 허용치 — 정확히 상한에 맞춘 스펙이 반올림 때문에 거부되지 않게. 게임 수치 아님. */
const COST_EPSILON = 1e-9;
/** 예산 초과 메시지에 보여줄 비싼 항목 수. */
const BUDGET_HINT_ITEMS = 3;

function specCost(spec: CarSpec, rules: CostRules): number {
  let total = 0;
  for (const p of SPEC_PARAMS) total += rules.weights[p.key] * p.get(spec) ** rules.exponent;
  return total;
}

/** 스펙의 총 비용 (크레딧) = Σ w_i · x_i^p. 아키텍처 선택은 비용 0. */
export function cost(spec: CarSpec, regs: Regulations): number {
  return specCost(spec, regs.cost);
}

function credits(x: number): string {
  return x.toFixed(2);
}

function budgetIssue(spec: CarSpec, total: number, rules: CostRules): ValidationIssue {
  const items = SPEC_PARAMS.map((p, order) => ({
    path: p.path,
    credits: rules.weights[p.key] * p.get(spec) ** rules.exponent,
    order,
  }))
    .sort((a, b) => b.credits - a.credits || a.order - b.order)
    .slice(0, BUDGET_HINT_ITEMS);
  const top = items.map((i) => `${i.path} ${credits(i.credits)}`).join(', ');
  return {
    path: '',
    message:
      `total cost ${credits(total)} credits exceeds the cost cap of ${rules.cap_credits} credits ` +
      `by ${credits(total - rules.cap_credits)}. Each item costs weight × value^${rules.exponent}; ` +
      `the most expensive are ${top}.`,
  };
}

// ── 스펙 검증 (3·9절: 스키마 → 규정) ───────────────────────────────────

/**
 * 제출된 스펙 검증: 스키마(필드·타입·범위, 알 수 없는 필드 거부) → 규정(코스트 캡).
 * 스키마 오류가 있으면 비용은 계산하지 않는다. 한 번에 고칠 수 있게 스키마 오류는 전부 모아 돌려준다.
 */
export function validateSpec(spec: unknown, regs: Regulations): Result<CarSpec, ValidationIssue[]> {
  const parsed = CarSpecSchema.safeParse(spec, { reportInput: true });
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error.issues, CarSpecSchema) };
  const total = cost(parsed.data, regs);
  if (total > regs.cost.cap_credits + COST_EPSILON) {
    return { ok: false, issues: [budgetIssue(parsed.data, total, regs.cost)] };
  }
  return { ok: true, value: parsed.data };
}

/** GP 셋업 검증 (4절 범위, 알 수 없는 필드 거부). */
export function validateSetup(setup: unknown): Result<Setup, ValidationIssue[]> {
  const parsed = SetupSchema.safeParse(setup, { reportInput: true });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: toIssues(parsed.error.issues, SetupSchema) };
}

// ── zod 이슈 → 사람이 읽는 문장 ────────────────────────────────────────

type ZodIssue = z.core.$ZodIssue;

/** 메시지에 입력값을 보여줄 최대 길이. */
const MAX_SHOWN_CHARS = 60;

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

function show(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS - 1)}…` : text;
}

function expectedNoun(expected: string): string {
  switch (expected) {
    case 'number':
      return 'a number';
    case 'int':
      return 'an integer';
    case 'object':
      return 'an object';
    case 'array':
      return 'a list';
    case 'string':
      return 'a string';
    case 'boolean':
      return 'true or false';
    default:
      return expected;
  }
}

/** 경로가 가리키는 하위 스키마 (오류 메시지에 허용 필드를 나열하려고). */
function schemaAt(root: z.core.$ZodType, path: readonly PropertyKey[]): z.core.$ZodType | undefined {
  let cur: z.core.$ZodType | undefined = root;
  for (const seg of path) {
    if (cur instanceof z.ZodObject && typeof seg === 'string') cur = cur.shape[seg];
    else if (cur instanceof z.ZodRecord) cur = cur.valueType;
    else if (cur instanceof z.ZodArray) cur = cur.element;
    else return undefined;
  }
  return cur;
}

function allowedKeys(schema: z.core.$ZodType | undefined): readonly string[] {
  if (schema instanceof z.ZodObject) return schema.keyof().options;
  if (schema instanceof z.ZodRecord && schema.keyType instanceof z.ZodEnum) {
    return schema.keyType.options.map(String);
  }
  return [];
}

function bound(
  kind: 'most' | 'least',
  origin: string,
  limit: unknown,
  inclusive: boolean | undefined,
  input: unknown,
): string {
  if (origin === 'array' || origin === 'set') {
    const size = Array.isArray(input) ? ` (got ${input.length})` : '';
    return `must have at ${kind} ${String(limit)} items${size}`;
  }
  if (origin === 'string') return `must be at ${kind} ${String(limit)} characters long`;
  const relation = inclusive === false ? (kind === 'most' ? 'less than' : 'greater than') : `at ${kind}`;
  return `must be ${relation} ${String(limit)} (got ${show(input)})`;
}

/** 타입 불일치 문장. 객체 안의 필드가 아예 없으면 "missing required field". */
function mismatch(expected: string, path: readonly PropertyKey[], input: unknown): string {
  return input === undefined && path.length > 0
    ? `missing required field (expected ${expected})`
    : `expected ${expected}, got ${show(input)}`;
}

/** @internal zod 이슈 → 사람이 읽는 ValidationIssue. root는 허용 필드 목록을 찾을 스키마. */
export function toIssues(issues: readonly ZodIssue[], root: z.core.$ZodType): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const issue of issues) {
    const path = formatPath(issue.path);
    switch (issue.code) {
      case 'unrecognized_keys': {
        const allowed = allowedKeys(schemaAt(root, issue.path));
        const hint = allowed.length > 0 ? `; allowed fields are ${allowed.join(', ')}` : '';
        for (const key of issue.keys) {
          out.push({ path: formatPath([...issue.path, key]), message: `unknown field "${key}"${hint}` });
        }
        break;
      }
      case 'invalid_type':
        out.push({ path, message: mismatch(expectedNoun(issue.expected), issue.path, issue.input) });
        break;
      case 'too_big':
        out.push({ path, message: bound('most', issue.origin, issue.maximum, issue.inclusive, issue.input) });
        break;
      case 'too_small':
        out.push({ path, message: bound('least', issue.origin, issue.minimum, issue.inclusive, issue.input) });
        break;
      case 'invalid_value': {
        const options = `one of ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`;
        out.push({
          path,
          message:
            issue.input === undefined && issue.path.length > 0
              ? `missing required field (expected ${options})`
              : `must be ${options} (got ${show(issue.input)})`,
        });
        break;
      }
      default:
        out.push({ path, message: issue.message });
    }
  }
  return out;
}
