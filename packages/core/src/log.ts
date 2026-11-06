/**
 * 로그 포맷 (DESIGN.md 10절): RaceLog(리플레이·분석), AgentIOLog(감사), SeasonLog(집계). 전부 JSON.
 * 스키마가 곧 계약이다 — 렌더러(M7)와 분석 노트북이 이것만 본다.
 */
import { z } from 'zod';
import { CarSpecSchema, SetupSchema } from './car.js';
import { CompoundSchema, PaceModeSchema, SurfaceSchema } from './regulations.js';
import { ActionSchema } from './strategy.js';
import { RealizedWeatherSchema } from './weather.js';

const time = z.number().min(0);

export const LapCarSchema = z.strictObject({
  /** 이번 랩 시간 (s). */
  t: time,
  /** 누적 레이스 시간 (s). */
  cum: time,
  pos: z.int().min(1),
  compound: CompoundSchema,
  life: z.number().min(0).max(1),
  fuel: z.number().min(0),
  pace: PaceModeSchema,
  /** ERS 배터리 잔량 (MJ). */
  ers: z.number().min(0),
});

export const RaceLapSchema = z.strictObject({
  lap: z.int().min(1),
  /** 이 랩이 끝난 뒤 순위 (달리는 차만). */
  order: z.array(z.string()),
  surface: SurfaceSchema,
  sc: z.boolean(),
  /** 팀 → 상태. 키 순서 = 차량 인덱스 순. 리타이어한 차는 없다. */
  cars: z.record(z.string(), LapCarSchema),
});

export const RaceEventLogSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('overtake'), t: time, lap: z.int(), s: z.number(), car: z.string(), on: z.string() }),
  z.strictObject({ type: z.literal('overtake_failed'), t: time, lap: z.int(), s: z.number(), car: z.string(), on: z.string() }),
  z.strictObject({ type: z.literal('pit'), t: time, lap: z.int(), s: z.number(), car: z.string(), from: CompoundSchema, to: CompoundSchema, loss_s: z.number() }),
  z.strictObject({ type: z.literal('safety_car'), t: time, lap: z.int(), s: z.number(), duration_laps: z.int().min(1) }),
  z.strictObject({ type: z.literal('safety_car_end'), t: time, lap: z.int(), s: z.number() }),
  z.strictObject({ type: z.literal('rain_start'), t: time, lap: z.int(), s: z.number() }),
  z.strictObject({ type: z.literal('rain_stop'), t: time, lap: z.int(), s: z.number() }),
  z.strictObject({ type: z.literal('retirement'), t: time, lap: z.int(), s: z.number(), car: z.string(), reason: z.string() }),
]);
export type RaceEventLog = z.infer<typeof RaceEventLogSchema>;

/** 8절 전략 트레이스: 어느 랩에 무엇이 왜 일어났나. */
export const StrategyTraceSchema = z.strictObject({
  lap: z.int().min(1),
  car: z.string(),
  /** source가 rule일 때 규칙 인덱스. */
  rule_idx: z.int().min(0).optional(),
  action: ActionSchema,
  /** rule | planned | fallback:<reason> */
  source: z.string(),
  /** 원하는 컴파운드 세트가 없어서 바꿔 낀 경우의 실제 컴파운드. */
  fitted: CompoundSchema.optional(),
});
export type StrategyTrace = z.infer<typeof StrategyTraceSchema>;

export const PenaltySchema = z.strictObject({ reason: z.string(), s: z.number() });

export const RaceResultSchema = z.strictObject({
  team: z.string(),
  pos: z.int().min(1),
  /** 완주 시간 (벌점 포함). 리타이어면 null. */
  time: time.nullable(),
  laps: z.int().min(0),
  status: z.enum(['finished', 'retired']),
  points: z.number().min(0),
  penalties: z.array(PenaltySchema),
});

export const RaceLogSchema = z.strictObject({
  schema: z.literal('racelog/1'),
  meta: z.strictObject({
    season: z.int(),
    gp: z.int().min(1),
    track: z.string(),
    seed: z.int(),
    laps: z.int().min(1),
    weather_realized: RealizedWeatherSchema,
    /** 거리 샘플(<race>.samples.json.gz)은 렌더러(M7)에서. 아직 없으면 null. */
    sample_interval_m: z.number().positive().nullable(),
  }),
  cars: z.array(
    z.strictObject({
      team: z.string(),
      spec_hash: z.string(),
      setup: SetupSchema,
      variant_selected: z.int().min(0),
      grid: z.int().min(1),
      quali_lap: time,
    }),
  ),
  laps: z.array(RaceLapSchema),
  events: z.array(RaceEventLogSchema),
  strategy_trace: z.array(StrategyTraceSchema),
  result: z.array(RaceResultSchema),
});
export type RaceLog = z.infer<typeof RaceLogSchema>;

/**
 * 공개 레이스 로그 (9절): 결과·랩타임·피트 타이밍은 공개, 스펙·셋업·규칙(전략 트레이스)은 비공개.
 * 라이벌의 전략 성향은 이것만 보고 추론해야 한다.
 */
export const PublicRaceLogSchema = z.strictObject({
  schema: z.literal('racelog-public/1'),
  meta: RaceLogSchema.shape.meta,
  cars: z.array(z.strictObject({ team: z.string(), grid: z.int().min(1), quali_lap: time })),
  laps: RaceLogSchema.shape.laps,
  events: RaceLogSchema.shape.events,
  result: RaceLogSchema.shape.result,
});
export type PublicRaceLog = z.infer<typeof PublicRaceLogSchema>;

export function publicRaceLog(log: RaceLog): PublicRaceLog {
  return PublicRaceLogSchema.parse({
    schema: 'racelog-public/1',
    meta: log.meta,
    cars: log.cars.map((c) => ({ team: c.team, grid: c.grid, quali_lap: c.quali_lap })),
    laps: log.laps,
    events: log.events,
    result: log.result,
  });
}

/** 10절 AgentIOLog: 팀별 JSONL, 호출마다 한 줄. ReplayAgent는 final만 읽는다. */
export const AgentIOLogSchema = z.strictObject({
  call: z.enum(['design_car', 'plan_gp']),
  team: z.string(),
  gp: z.int().min(1).optional(),
  packet_hash: z.string(),
  tool_calls: z.array(
    z.strictObject({ tool: z.string(), args_hash: z.string(), result_summary: z.record(z.string(), z.unknown()) }),
  ),
  raw_response: z.string(),
  validation: z.strictObject({ ok: z.boolean(), errors: z.array(z.string()).optional(), warnings: z.array(z.string()).optional() }),
  resubmission: z
    .strictObject({
      raw_response: z.string(),
      validation: z.strictObject({ ok: z.boolean(), errors: z.array(z.string()).optional() }),
    })
    .optional(),
  /** 실제로 쓴 제출물 (검증 통과본, 또는 폴백). */
  final: z.unknown(),
  fallback_used: z.boolean(),
  latency_s: z.number().min(0),
  tokens: z.strictObject({ in: z.int().min(0), out: z.int().min(0) }).optional(),
});
export type AgentIOLog = z.infer<typeof AgentIOLogSchema>;

/** 10절 SeasonLog: 시즌 시드, 규정 버전, 팀 목록, GP 결과 포인터, 최종 순위. */
export const SeasonLogSchema = z.strictObject({
  schema: z.literal('seasonlog/1'),
  season: z.int(),
  seed: z.int(),
  regulations_hash: z.string(),
  teams: z.array(z.strictObject({ team: z.string(), agent: z.string(), model: z.string().optional(), spec: CarSpecSchema })),
  gps: z.array(z.strictObject({ gp: z.int().min(1), track: z.string(), race: z.string(), winner: z.string() })),
  standings: z.array(z.strictObject({ team: z.string(), points: z.number().min(0), pos: z.int().min(1) })),
});
export type SeasonLog = z.infer<typeof SeasonLogSchema>;

/** 짧은 내용 해시 (FNV-1a 32비트, 8자리 hex). spec_hash·packet_hash용 — 보안 용도 아님. */
export function shortHash(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
