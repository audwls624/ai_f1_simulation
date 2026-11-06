/**
 * 오케스트레이션 (2·9절): 패킷을 만들어 에이전트를 부르고, 툴 호출을 기록하고, 제출물을 검증해 엔진에 넘긴다.
 * 엔진은 전 팀의 제출물을 다 받은 뒤에만 다음 단계를 돈다 (호출 순서·응답 속도가 결과에 영향 없음).
 */
import {
  buildGPPacket,
  buildPreseasonPacket,
  makeDesignTools,
  makePlanTools,
  type DesignTools,
  type PlanTools,
  type TeamAgent,
} from '@f1sim/agents';
import {
  defaultPlan,
  deriveSeed,
  formatIssue,
  gpForecast,
  lint,
  makeRng,
  runRace,
  shortHash,
  validatePlan,
  validateSpec,
  type AgentIOLog,
  type CarSpec,
  type GPPlan,
  type RaceLog,
  type Regulations,
  type Track,
} from '@f1sim/core';

export interface Team {
  readonly team: string;
  readonly agent: TeamAgent;
}

type ToolCall = AgentIOLog['tool_calls'][number];

function recordDesignTools(tools: DesignTools, calls: ToolCall[]): DesignTools {
  return {
    get remaining() {
      return tools.remaining;
    },
    windTunnel(spec, setup, trackId) {
      const r = tools.windTunnel(spec, setup, trackId);
      calls.push({ tool: 'wind_tunnel', args_hash: shortHash({ spec, setup, trackId }), result_summary: { lap: r.lap.total, wear: r.wearEstimate } });
      return r;
    },
  };
}

function recordPlanTools(tools: PlanTools, calls: ToolCall[]): PlanTools {
  return {
    get remaining() {
      return tools.remaining;
    },
    strategySim(plan, nSamples) {
      const r = tools.strategySim(plan, nSamples);
      calls.push({ tool: 'strategy_sim', args_hash: shortHash({ plan, nSamples }), result_summary: { mean_pos: r.mean_position, dnf: r.dnf_rate } });
      return r;
    },
  };
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: unknown; error: string | null; latency: number }> {
  const t0 = performance.now();
  try {
    const value = await work();
    return { value, error: null, latency: (performance.now() - t0) / 1000 };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e), latency: (performance.now() - t0) / 1000 };
  }
}

export interface DesignOutcome {
  readonly spec: CarSpec;
  /** 3절: 검증 실패 → 기본 스펙 + 첫 GP 그리드 최후위. */
  readonly gridPenalty: boolean;
  readonly log: AgentIOLog;
}

/** 프리시즌 설계 (재제출 1회 → 실패하면 기본 스펙 + 그리드 페널티). */
export async function preseasonDesign(regs: Regulations, team: Team, calendar: readonly Track[], seasonSeed: number): Promise<DesignOutcome> {
  const packet = buildPreseasonPacket(regs, team.team, calendar);
  const calls: ToolCall[] = [];
  const tools = recordDesignTools(
    makeDesignTools(regs, calendar, regs.tools.wind_tunnel.runs_preseason, makeRng(deriveSeed(seasonSeed, `tool:wind_tunnel:${team.team}`))),
    calls,
  );
  const attempt = async () => {
    const r = await timed(() => team.agent.designCar(packet, tools));
    const checked = r.error === null ? validateSpec(r.value, regs) : null;
    return { r, checked, errors: r.error !== null ? [r.error] : checked && !checked.ok ? checked.issues.map(formatIssue) : [] };
  };
  const first = await attempt();
  let final = first;
  let resubmission: AgentIOLog['resubmission'];
  if (first.errors.length > 0 && regs.penalties.resubmissions > 0) {
    final = await attempt();
    resubmission = { raw_response: JSON.stringify(final.r.value ?? null), validation: { ok: final.errors.length === 0, ...(final.errors.length ? { errors: final.errors } : {}) } };
  }
  const ok = final.checked?.ok === true;
  const spec = final.checked?.ok ? final.checked.value : regs.fallback.spec;
  return {
    spec,
    gridPenalty: !ok,
    log: {
      call: 'design_car',
      team: team.team,
      packet_hash: shortHash(packet),
      tool_calls: calls,
      raw_response: JSON.stringify(first.r.value ?? null),
      validation: { ok: first.errors.length === 0, ...(first.errors.length ? { errors: first.errors } : {}) },
      ...(resubmission ? { resubmission } : {}),
      final: spec,
      fallback_used: !ok,
      latency_s: first.r.latency + (resubmission ? final.r.latency : 0),
    },
  };
}

export interface GPOutcome {
  readonly race: RaceLog;
  readonly agentLogs: readonly AgentIOLog[];
}

/** GP 하나: 예보 공개 → 전 팀 플랜 (재제출 1회 → 실패하면 기본 셋업·기본 전략) → 레이스. */
export async function runGP(args: {
  readonly regs: Regulations;
  readonly season: number;
  readonly seasonSeed: number;
  readonly gp: number;
  readonly track: Track;
  readonly teams: readonly Team[];
  readonly specs: ReadonlyMap<string, CarSpec>;
  readonly gridPenalty: ReadonlySet<string>;
}): Promise<GPOutcome> {
  const { regs, track } = args;
  const raceSeed = deriveSeed(args.seasonSeed, `gp:${args.gp}`);
  const forecast = gpForecast(track, regs, raceSeed);
  const plans = new Map<string, GPPlan>();
  const agentLogs: AgentIOLog[] = [];
  for (const team of args.teams) {
    const spec = args.specs.get(team.team) ?? regs.fallback.spec;
    const packet = buildGPPacket({ regs, team: team.team, gp: args.gp, track, forecast, ownSpec: spec, standings: [], lastGp: null });
    const calls: ToolCall[] = [];
    const tools = recordPlanTools(
      makePlanTools({
        regs,
        season: args.season,
        gp: args.gp,
        track,
        forecast,
        team: team.team,
        ownSpec: spec,
        // 9절: 라이벌은 스펙 추정치 + 기본 전략. 공개 정보로 추정할 근거가 아직 없어 규정의 기본 스펙을 쓴다.
        rivals: args.teams.filter((t) => t.team !== team.team).map((t) => ({ team: t.team, spec: regs.fallback.spec })),
        budget: regs.tools.strategy_sim.runs_per_gp,
        rng: makeRng(deriveSeed(raceSeed, `tool:strategy_sim:${team.team}`)),
      }),
      calls,
    );
    const attempt = async () => {
      const r = await timed(() => team.agent.planGp(packet, tools));
      const checked = r.error === null ? validatePlan(r.value, regs, { laps: track.laps }) : null;
      return { r, checked, errors: r.error !== null ? [r.error] : checked && !checked.ok ? checked.issues.map(formatIssue) : [] };
    };
    const first = await attempt();
    let final = first;
    let resubmission: AgentIOLog['resubmission'];
    if (first.errors.length > 0 && regs.penalties.resubmissions > 0) {
      final = await attempt();
      resubmission = { raw_response: JSON.stringify(final.r.value ?? null), validation: { ok: final.errors.length === 0, ...(final.errors.length ? { errors: final.errors } : {}) } };
    }
    const plan = final.checked?.ok ? final.checked.value : defaultPlan(regs, track.laps);
    plans.set(team.team, plan);
    const warnings = final.checked?.ok ? lint(final.checked.value).map(formatIssue) : [];
    agentLogs.push({
      call: 'plan_gp',
      team: team.team,
      gp: args.gp,
      packet_hash: shortHash(packet),
      tool_calls: calls,
      raw_response: JSON.stringify(first.r.value ?? null),
      validation: { ok: first.errors.length === 0, ...(first.errors.length ? { errors: first.errors } : {}), ...(warnings.length ? { warnings } : {}) },
      ...(resubmission ? { resubmission } : {}),
      final: plan,
      fallback_used: final.checked?.ok !== true,
      latency_s: first.r.latency + (resubmission ? final.r.latency : 0),
    });
  }
  const race = runRace({
    season: args.season,
    gp: args.gp,
    track,
    forecast,
    seed: raceSeed,
    regs,
    entries: args.teams.map((t) => ({
      team: t.team,
      spec: args.specs.get(t.team) ?? regs.fallback.spec,
      plan: plans.get(t.team) ?? defaultPlan(regs, track.laps),
      gridPenalty: args.gridPenalty.has(t.team),
    })),
  });
  return { race, agentLogs };
}
