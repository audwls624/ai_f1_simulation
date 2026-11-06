/**
 * 에이전트 프로토콜 (DESIGN.md 9절). 엔진과 오케스트레이터는 이 인터페이스만 본다 —
 * 뒤에 LLM이 있는지, 휴리스틱인지, 사람인지 모른다 (1절 원칙 5).
 *
 * 패킷에는 공개 정보만: 공개 규정(Rules), 트랙 프로파일, 예보, 자기 차의 요약, 순위, 공개 로그.
 * 엔진 모델 계수·세그먼트 원본·라이벌의 스펙·규칙 원문은 들어가지 않는다.
 */
import type {
  CarSpec,
  Compound,
  Forecast,
  GPPlan,
  LapBreakdown,
  PublicRaceLog,
  Rules,
  Setup,
  TrackProfile,
} from '@f1sim/core';
import type { DesignTools } from './tools.js';

export interface CalendarEntry {
  readonly gp: number;
  readonly track_id: string;
  readonly profile: TrackProfile;
}

/** 프리시즌 (9절): 규정 전문, 트랙 프로파일 24개, 지난 시즌 공개 로그(있으면), 풍동 잔여. */
export interface PreseasonPacket {
  readonly season: number;
  readonly team: string;
  readonly rules: Rules;
  readonly calendar: readonly CalendarEntry[];
  readonly previous_season: readonly PublicRaceLog[];
  readonly wind_tunnel_remaining: number;
}

/** 자기 차의 이 트랙 풍동 요약 (노이즈 없음). */
export interface WindTunnelSummary {
  readonly setup: Setup;
  readonly lap: LapBreakdown;
  /** 기준 컴파운드 랩당 life 감소 (rules.tools.wind_tunnel.wear_compound). */
  readonly wear_per_lap: number;
}

export interface Standing {
  readonly team: string;
  readonly points: number;
}

/** GP 직전 (9절): 트랙 프로파일, 예보, 타이어 배분, 자기 차 풍동 요약, 순위, 지난 GP 공개 로그, 전략 시뮬 잔여. */
export interface GPPacket {
  readonly season: number;
  readonly gp: number;
  readonly team: string;
  readonly rules: Rules;
  readonly track_id: string;
  readonly profile: TrackProfile;
  readonly forecast: Forecast;
  /** 예선 사용분을 뺀 레이스용 세트 수. */
  readonly tire_sets: Readonly<Record<Compound, number>>;
  readonly own_spec: CarSpec;
  readonly wind_tunnel_summary: readonly WindTunnelSummary[];
  readonly standings: readonly Standing[];
  readonly last_gp: PublicRaceLog | null;
  readonly strategy_sim_remaining: number;
}

/** 9절 strategy_sim 결과: 자기 플랜을 n개 시드로 돌린 분포. */
export interface StrategySimResult {
  readonly samples: number;
  readonly mean_position: number;
  /** position_counts[k] = k+1위로 끝난 횟수. */
  readonly position_counts: readonly number[];
  /** 완주한 샘플의 평균 레이스 시간 (벌점 포함). 완주가 없으면 null. */
  readonly mean_race_time_s: number | null;
  readonly dnf_rate: number;
  /** 레이스당 평균 엔진 폴백 발동 수. */
  readonly fallbacks_per_race: number;
  readonly mean_pit_stops: number;
}

export interface PlanTools {
  /** 남은 횟수가 0이면 ToolBudgetError, 플랜이 검증에 실패하면 ToolInputError (횟수 차감 없음). */
  strategySim(plan: GPPlan, nSamples?: number): StrategySimResult;
  readonly remaining: number;
}

export interface TeamAgent {
  /** 에이전트 종류 (heuristic, replay, llm:anthropic …). SeasonLog에 남는다. */
  readonly kind: string;
  designCar(packet: PreseasonPacket, tools: DesignTools): Promise<CarSpec>;
  planGp(packet: GPPacket, tools: PlanTools): Promise<GPPlan>;
}
