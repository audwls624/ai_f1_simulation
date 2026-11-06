/**
 * 에이전트 툴 (DESIGN.md 9절). 횟수는 공통 측이 세고, 초과하면 오류를 던진다 (에이전트가 세지 않는다).
 * 설계 툴(풍동, 프리시즌)과 플랜 툴(전략 시뮬, GP마다).
 */
import {
  baseLap,
  defaultPlan,
  derive,
  runRace,
  validatePlan,
  validateSetup,
  validateSpec,
  wearPerLap,
  type CarSpec,
  type Forecast,
  type GPPlan,
  type LapBreakdown,
  type RaceEntry,
  type Regulations,
  type Rng,
  type Setup,
  type Track,
  type ValidationIssue,
} from '@f1sim/core';
import type { PlanTools, StrategySimResult } from './base.js';

/** 풍동 결과: 이 트랙에서의 기본 랩타임 내역(노이즈 포함) + 마모율 추정 (9절). */
export interface WindTunnelResult {
  /** baseLap에 N(0, noiseSd) 노이즈를 더한 값. 노이즈는 각 구간 시간에 비례 배분한다 (최고속은 그대로). */
  readonly lap: LapBreakdown;
  /** 기준 컴파운드(regulations.tools.wind_tunnel.wear_compound)로 normal 페이스, 깨끗한 공기, 건조 노면 랩당 life 감소. */
  readonly wearEstimate: number;
  readonly noiseSd: number;
}

export interface DesignTools {
  /**
   * 후보 스펙 + 셋업을 트랙에서 돌린다. 남은 횟수가 0이면 ToolBudgetError.
   * 입력이 잘못되면(스키마·코스트 캡·모르는 트랙) ToolInputError — 횟수도 난수도 쓰지 않는다.
   */
  windTunnel(spec: CarSpec, setup: Setup, trackId: string): WindTunnelResult;
  readonly remaining: number;
}

/** 툴 사용 횟수를 다 썼다. */
export class ToolBudgetError extends Error {
  constructor(tool: string, budget: number) {
    super(`${tool}: no runs left (all ${budget} runs used)`);
    this.name = 'ToolBudgetError';
  }
}

/** 툴 입력이 잘못됐다 (스키마 오류, 모르는 트랙). 횟수는 차감하지 않는다. */
export class ToolInputError extends Error {
  readonly problems: readonly string[];

  constructor(tool: string, problems: readonly string[]) {
    super(`${tool}: invalid input\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ToolInputError';
    this.problems = problems;
  }
}

const WIND_TUNNEL = 'wind_tunnel';

/** `spec.chassis.mech_grip: must be at most 1 (got 1.2)` — 제출 검증과 같은 문장에 인자 이름을 붙인다. */
function argIssue(arg: string, issue: ValidationIssue): string {
  return `${issue.path === '' ? arg : `${arg}.${issue.path}`}: ${issue.message}`;
}

/**
 * 설계 툴 묶음. budget은 사용 가능 횟수 (프리시즌이면 regulations.tools.wind_tunnel.runs_preseason).
 * rng는 이 팀의 툴 전용 스트림이어야 한다 (11절: 실제 레이스와 다른 시드). 호출마다 정규 난수 1개를 쓴다.
 */
export function makeDesignTools(regs: Regulations, tracks: readonly Track[], budget: number, rng: Rng): DesignTools {
  if (!Number.isInteger(budget) || budget < 0) throw new RangeError(`budget must be a non-negative integer (got ${budget})`);
  const byId = new Map<string, Track>();
  for (const track of tracks) {
    if (byId.has(track.id)) throw new Error(`duplicate track id "${track.id}"`);
    byId.set(track.id, track);
  }
  const rules = regs.tools.wind_tunnel;
  let remaining = budget;

  return {
    get remaining() {
      return remaining;
    },
    windTunnel(spec, setup, trackId) {
      if (remaining <= 0) throw new ToolBudgetError(WIND_TUNNEL, budget);
      const checkedSpec = validateSpec(spec, regs);
      const checkedSetup = validateSetup(setup);
      const track = byId.get(trackId);
      const problems = [
        ...(checkedSpec.ok ? [] : checkedSpec.issues.map((i) => argIssue('spec', i))),
        ...(checkedSetup.ok ? [] : checkedSetup.issues.map((i) => argIssue('setup', i))),
        ...(track ? [] : [`trackId: unknown track "${trackId}"; known tracks are ${[...byId.keys()].join(', ')}`]),
      ];
      if (!checkedSpec.ok || !checkedSetup.ok || !track) throw new ToolInputError(WIND_TUNNEL, problems);

      const perf = derive(checkedSpec.value, checkedSetup.value, track, regs);
      const clean = baseLap(perf, track, 'dry', regs);
      const noise = rng.normal(0, rules.noise_sd_s);
      const scale = (clean.total + noise) / clean.total;
      remaining -= 1;
      return {
        lap: {
          total: clean.total * scale,
          straight: clean.straight * scale,
          lowSpeed: clean.lowSpeed * scale,
          midSpeed: clean.midSpeed * scale,
          highSpeed: clean.highSpeed * scale,
          topSpeedKph: clean.topSpeedKph,
        },
        wearEstimate: wearPerLap(rules.wear_compound, perf, track, 'normal', false, 'dry', regs),
        noiseSd: rules.noise_sd_s,
      };
    },
  };
}

const STRATEGY_SIM = 'strategy_sim';
const UINT32_RANGE = 2 ** 32;

export interface PlanToolsArgs {
  readonly regs: Regulations;
  readonly season: number;
  readonly gp: number;
  readonly track: Track;
  readonly forecast: Forecast;
  readonly team: string;
  readonly ownSpec: CarSpec;
  /** 라이벌 스펙 추정치 (9절: 지난 GP 스펙 추정치). 라이벌은 기본 전략으로 달린다. */
  readonly rivals: readonly { readonly team: string; readonly spec: CarSpec }[];
  readonly budget: number;
  /** 이 팀·이 GP의 툴 전용 스트림 (11절: 실제 레이스와 다른 시드). */
  readonly rng: Rng;
}

/**
 * 9절 strategy_sim: 자기 GPPlan을 n개 시드로 돌린 결과 분포. 라이벌은 추정 스펙 + 기본 전략(3절).
 * 호출마다 횟수 1회. 플랜이 검증에 실패하면 ToolInputError (횟수·난수 그대로).
 */
export function makePlanTools(args: PlanToolsArgs): PlanTools {
  const { regs, track } = args;
  if (!Number.isInteger(args.budget) || args.budget < 0) throw new RangeError(`budget must be a non-negative integer (got ${args.budget})`);
  let remaining = args.budget;
  const rivals: RaceEntry[] = args.rivals.map((r) => ({ team: r.team, spec: r.spec, plan: defaultPlan(regs, track.laps) }));
  return {
    get remaining() {
      return remaining;
    },
    strategySim(plan: GPPlan, nSamples?: number): StrategySimResult {
      if (remaining <= 0) throw new ToolBudgetError(STRATEGY_SIM, args.budget);
      const checked = validatePlan(plan, regs, { laps: track.laps });
      const samples = nSamples ?? regs.tools.strategy_sim.default_samples;
      const problems = [
        ...(checked.ok ? [] : checked.issues.map((i) => argIssue('plan', i))),
        ...(Number.isInteger(samples) && samples >= 1 && samples <= regs.tools.strategy_sim.max_samples
          ? []
          : [`nSamples: must be an integer from 1 to ${regs.tools.strategy_sim.max_samples} (got ${samples})`]),
      ];
      if (!checked.ok || problems.length > 0) throw new ToolInputError(STRATEGY_SIM, problems);
      remaining -= 1;
      const own: RaceEntry = { team: args.team, spec: args.ownSpec, plan: checked.value };
      const positions = new Array<number>(rivals.length + 1).fill(0);
      let posSum = 0;
      let timeSum = 0;
      let finished = 0;
      let fallbacks = 0;
      let pits = 0;
      for (let k = 0; k < samples; k++) {
        const seed = Math.floor(args.rng.next() * UINT32_RANGE);
        const log = runRace({ season: args.season, gp: args.gp, track, forecast: args.forecast, entries: [own, ...rivals], seed, regs });
        const me = log.result.find((r) => r.team === args.team);
        if (!me) continue;
        positions[me.pos - 1] = (positions[me.pos - 1] ?? 0) + 1;
        posSum += me.pos;
        if (me.time !== null) {
          timeSum += me.time;
          finished += 1;
        }
        fallbacks += log.strategy_trace.filter((t) => t.car === args.team && t.source.startsWith('fallback')).length;
        pits += log.events.filter((e) => e.type === 'pit' && e.car === args.team).length;
      }
      return {
        samples,
        mean_position: posSum / samples,
        position_counts: positions,
        mean_race_time_s: finished > 0 ? timeSum / finished : null,
        dnf_rate: 1 - finished / samples,
        fallbacks_per_race: fallbacks / samples,
        mean_pit_stops: pits / samples,
      };
    },
  };
}

