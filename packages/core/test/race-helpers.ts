import type { CarSpec } from '../src/car.js';
import type { RaceEntry } from '../src/race.js';
import type { GPPlan } from '../src/strategy.js';
import { regs, uniformSpec, withSpec } from './helpers.js';

/** 1스톱 medium→hard 또는 2스톱 soft→medium→hard + 세이프티카·비 규칙 (12절 휴리스틱 모양). */
export function testPlan(laps: number, stops: 1 | 2, patch: Partial<GPPlan['setup']> = {}): GPPlan {
  const stints =
    stops === 1
      ? [{ compound: 'medium' as const, planned_pit_lap: Math.round(laps * 0.45) }, { compound: 'hard' as const }]
      : [
          { compound: 'soft' as const, planned_pit_lap: Math.round(laps * 0.28) },
          { compound: 'medium' as const, planned_pit_lap: Math.round(laps * 0.62) },
          { compound: 'hard' as const },
        ];
  return {
    setup: { wing_level: 7, ride_height: 'mid', ers_mode: 'balanced', ...patch },
    variants: [
      {
        when: {},
        plan: {
          start_compound: stints[0]?.compound ?? 'medium',
          pace: 'normal',
          stints,
          rules: [
            { when: { event: 'safety_car', tire_age_gte: 8 }, do: { pit: 'next_planned' }, cooldown: 10 },
            { when: { event: 'rain_start' }, do: { pit: 'inter' }, once: true },
            { when: { surface: 'dry', tire_compound: 'inter', laps_on_compound_gte: 2 }, do: { pit: 'next_planned' }, cooldown: 5 },
          ],
        },
      },
    ],
  };
}

/** 10팀: 균등 스펙을 조금씩 다르게 (0.62–0.80), 1·2스톱 번갈아. */
export function testEntries(laps: number): RaceEntry[] {
  return Array.from({ length: 10 }, (_, i) => {
    const x = 0.62 + i * 0.02;
    const spec: CarSpec = withSpec(uniformSpec(x), { aero: { philosophy: i % 3 === 0 ? 'floor' : 'wing' } });
    const plan = testPlan(laps, i % 2 === 0 ? 1 : 2, i % 3 === 0 ? { ride_height: 'low' } : {});
    return { team: `team${i}`, spec, plan };
  });
}

export { regs };
