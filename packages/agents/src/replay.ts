/**
 * ReplayAgent (9·11절): AgentIOLog의 final 제출물을 그대로 낸다 → 시즌 전체를 LLM 호출 없이 재생.
 * 골든 로그와 비교하는 회귀 테스트의 바탕이다. 툴은 쓰지 않는다.
 */
import { AgentIOLogSchema, CarSpecSchema, GPPlanSchema, type AgentIOLog, type CarSpec, type GPPlan } from '@f1sim/core';
import type { GPPacket, PreseasonPacket, TeamAgent } from './base.js';

export class ReplayAgent implements TeamAgent {
  readonly kind = 'replay';
  readonly #lines: readonly AgentIOLog[];

  constructor(lines: readonly AgentIOLog[]) {
    this.#lines = lines;
  }

  /** agents/<team>.jsonl 텍스트에서 만든다 (빈 줄 무시). */
  static fromJsonl(text: string): ReplayAgent {
    const lines = text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => AgentIOLogSchema.parse(JSON.parse(l)));
    return new ReplayAgent(lines);
  }

  designCar(packet: PreseasonPacket): Promise<CarSpec> {
    const line = this.#lines.find((l) => l.call === 'design_car' && l.team === packet.team);
    if (!line) return Promise.reject(new Error(`replay: no design_car record for ${packet.team}`));
    return Promise.resolve(CarSpecSchema.parse(line.final));
  }

  planGp(packet: GPPacket): Promise<GPPlan> {
    const line = this.#lines.find((l) => l.call === 'plan_gp' && l.team === packet.team && l.gp === packet.gp);
    if (!line) return Promise.reject(new Error(`replay: no plan_gp record for ${packet.team} GP ${packet.gp}`));
    return Promise.resolve(GPPlanSchema.parse(line.final));
  }
}
