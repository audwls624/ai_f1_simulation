/**
 * 컨포먼스 (13절): 어떤 에이전트(휴리스틱, 리플레이, LLM 어댑터, 사람)든 통과해야 하는 검사.
 * 테스트 프레임워크와 무관한 함수라 어댑터 패키지의 테스트에서 그대로 불러 쓴다.
 */
import { formatIssue, lint, validatePlan, validateSpec, type CarSpec, type GPPlan } from '@f1sim/core';
import type { GPPacket, PlanTools, PreseasonPacket, TeamAgent } from '../base.js';
import type { DesignTools } from '../tools.js';

export interface ConformanceReport<T> {
  readonly ok: boolean;
  readonly value: T | null;
  /** 실패 사유 (있으면 ok = false). */
  readonly problems: readonly string[];
  /** 통과는 하지만 알려 줄 것 (린트 경고 등). */
  readonly warnings: readonly string[];
}

const MS_PER_S = 1000;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

async function withTimeout<T>(work: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no response within ${seconds} s`)), seconds * MS_PER_S);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function call<T>(work: () => Promise<T>, seconds: number): Promise<{ value: T | null; problem: string | null }> {
  try {
    return { value: await withTimeout(work(), seconds), problem: null };
  } catch (e) {
    return { value: null, problem: `threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** designCar: 제한 시간 안에 응답, 규정을 지키는 스펙, 패킷을 바꾸지 않음, 툴 예산 안. */
export async function checkDesignCar(agent: TeamAgent, packet: PreseasonPacket, tools: DesignTools): Promise<ConformanceReport<CarSpec>> {
  const frozen = deepFreeze(structuredClone(packet));
  const { value, problem } = await call(() => agent.designCar(frozen, tools), packet.rules.penalties.response_timeout_s);
  if (problem) return { ok: false, value: null, problems: [problem], warnings: [] };
  const checked = validateSpec(value, packet.rules);
  const problems = checked.ok ? [] : checked.issues.map(formatIssue);
  if (tools.remaining < 0) problems.push('used more wind tunnel runs than allowed');
  return { ok: problems.length === 0, value: checked.ok ? checked.value : null, problems, warnings: [] };
}

/** planGp: 제한 시간 안에 응답, 검증을 통과하는 플랜(린트 경고는 warnings), 패킷을 바꾸지 않음. */
export async function checkPlanGp(agent: TeamAgent, packet: GPPacket, tools: PlanTools): Promise<ConformanceReport<GPPlan>> {
  const frozen = deepFreeze(structuredClone(packet));
  const { value, problem } = await call(() => agent.planGp(frozen, tools), packet.rules.penalties.response_timeout_s);
  if (problem) return { ok: false, value: null, problems: [problem], warnings: [] };
  const checked = validatePlan(value, packet.rules, { laps: packet.profile.laps });
  if (!checked.ok) return { ok: false, value: null, problems: checked.issues.map(formatIssue), warnings: [] };
  return { ok: true, value: checked.value, problems: [], warnings: lint(checked.value).map(formatIssue) };
}
