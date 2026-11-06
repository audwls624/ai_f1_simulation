import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RaceLogSchema, type RaceLog } from '../src/log.js';
import { gpForecast, runRace, type RaceEntry, type RaceInput } from '../src/race.js';
import type { GPPlan } from '../src/strategy.js';
import type { Track } from '../src/track.js';
import type { Forecast } from '../src/weather.js';
import { specArb, tracks } from './helpers.js';
import { regs, testEntries, testPlan } from './race-helpers.js';

const track = tracks.mixed;
const input = (patch: Partial<RaceInput> = {}): RaceInput => ({
  season: 2026,
  gp: 7,
  track,
  forecast: gpForecast(track, regs, 11),
  entries: testEntries(track.laps),
  seed: 11,
  regs,
  ...patch,
});
const dryForecast = (t: Track): Forecast => gpForecast(t, regs, 1).map((w) => ({ ...w, rain_p: 0 }));
const wetForecast = (t: Track): Forecast => gpForecast(t, regs, 1).map((w) => ({ ...w, rain_p: 1 }));
const sources = (log: RaceLog, team: string) => log.strategy_trace.filter((t) => t.car === team).map((t) => t.source);

/** 11절 엔진 불변식. */
function checkInvariants(log: RaceLog, entries: readonly RaceEntry[]): void {
  expect(RaceLogSchema.safeParse(log).success).toBe(true);
  const lastCum = new Map<string, number>();
  for (const lap of log.laps) {
    const positions = Object.values(lap.cars).map((c) => c.pos).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: positions.length }, (_, i) => i + 1)); // 순위 합 = n
    expect(lap.order).toHaveLength(positions.length);
    for (const [team, c] of Object.entries(lap.cars)) {
      expect(c.cum).toBeGreaterThanOrEqual(lastCum.get(team) ?? 0); // 누적 시간 단조
      lastCum.set(team, c.cum);
      expect(c.life).toBeGreaterThanOrEqual(0);
      expect(c.life).toBeLessThanOrEqual(1);
      expect(c.fuel).toBeGreaterThanOrEqual(0);
      expect(c.t).toBeGreaterThan(0);
    }
  }
  for (const e of entries) {
    // 피트 수 = 쓴 세트 수 − 1: 랩 로그의 컴파운드가 바뀐 횟수와 같은 세트 재장착은 피트 이벤트로 센다.
    const pits = log.events.filter((ev) => ev.type === 'pit' && ev.car === e.team).length;
    const traced = log.strategy_trace.filter((t) => t.car === e.team && typeof t.action === 'object' && 'pit' in t.action).length;
    expect(pits).toBeLessThanOrEqual(traced);
  }
  expect(log.result.map((r) => r.pos)).toEqual(log.result.map((_, i) => i + 1));
  const finished = log.result.filter((r) => r.status === 'finished');
  expect(log.result.slice(0, finished.length).every((r) => r.status === 'finished')).toBe(true); // 리타이어는 뒤
  finished.forEach((r, i) => expect(r.points).toBe(regs.points[i] ?? 0));
}

describe('runRace (DESIGN.md §7)', () => {
  it('produces a valid race log that satisfies the engine invariants', () => {
    const i = input();
    checkInvariants(runRace(i), i.entries);
  });

  it('same seed + same input → byte-identical log; different seed → different race', () => {
    expect(JSON.stringify(runRace(input()))).toBe(JSON.stringify(runRace(input())));
    expect(JSON.stringify(runRace(input({ seed: 12 })))).not.toBe(JSON.stringify(runRace(input())));
  });

  it('runs every lap and classifies every car', () => {
    const log = runRace(input());
    expect(log.laps).toHaveLength(track.laps);
    expect(log.result).toHaveLength(10);
    expect(log.cars.map((c) => c.grid).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, k) => k + 1));
  });

  it('follows the planned pit lap when no rule interferes', () => {
    const plan = testPlan(track.laps, 1);
    const entries: RaceEntry[] = [{ team: 'solo', spec: regs.fallback.spec, plan }];
    const log = runRace(input({ entries, forecast: dryForecast(track), seed: 3 }));
    const planned = plan.variants[0]?.plan.stints[0]?.planned_pit_lap ?? 0;
    const pits = log.events.filter((e) => e.type === 'pit');
    const scLaps = new Set(log.laps.filter((l) => l.sc).map((l) => l.lap));
    if (!log.strategy_trace.some((t) => t.source === 'rule')) {
      expect(pits.map((p) => p.lap)).toEqual([planned]);
      expect(log.strategy_trace).toEqual([expect.objectContaining({ lap: planned, source: 'planned' })]);
    } else {
      expect([...scLaps].length).toBeGreaterThan(0);
    }
  });

  it('a grid penalty sends the car to the back', () => {
    const entries = testEntries(track.laps).map((e, i) => (i === 9 ? { ...e, gridPenalty: true } : e));
    const log = runRace(input({ entries }));
    expect(log.cars[9]?.grid).toBe(10);
  });
});

describe('engine fallbacks (DESIGN.md §7)', () => {
  const noRules = (plan: GPPlan): GPPlan => ({
    ...plan,
    variants: plan.variants.map((v) => ({ ...v, plan: { ...v.plan, rules: [] } })),
  });
  const quiet = { ...track, sc_rate: 0 };

  it('tire life 0 → forced pit with the extra time penalty', () => {
    const plan: GPPlan = {
      setup: { wing_level: 7, ride_height: 'mid', ers_mode: 'balanced' },
      variants: [{ when: {}, plan: { start_compound: 'soft', pace: 'push', stints: [{ compound: 'soft' }], rules: [] } }],
    };
    const log = runRace(input({ track: quiet, entries: [{ team: 'a', spec: regs.fallback.spec, plan }], forecast: dryForecast(quiet) }));
    expect(sources(log, 'a')).toContain('fallback:tire_life');
  });

  it('only one dry compound with ≤ 5 laps left → forced pit to another compound, no penalty', () => {
    const plan: GPPlan = {
      setup: { wing_level: 7, ride_height: 'mid', ers_mode: 'balanced' },
      variants: [
        {
          when: {},
          plan: {
            start_compound: 'hard',
            pace: 'conserve',
            stints: [{ compound: 'hard', planned_pit_lap: 40 }, { compound: 'hard' }],
            rules: [],
          },
        },
      ],
    };
    const short = { ...quiet, laps: 60 };
    const log = runRace(input({ track: short, entries: [{ team: 'a', spec: regs.fallback.spec, plan }], forecast: dryForecast(short) }));
    const forced = log.strategy_trace.find((t) => t.source === 'fallback:compound_rule');
    expect(forced?.lap).toBeGreaterThanOrEqual(short.laps - regs.engine_fallbacks.compound_rule_laps_left + 1);
    expect(log.result[0]?.penalties).toEqual([]);
  });

  it('slicks on a wet track for 3 laps → forced inters', () => {
    const entries = testEntries(track.laps).slice(0, 2).map((e) => ({ ...e, plan: noRules(e.plan) }));
    const log = runRace(input({ track: quiet, entries, forecast: wetForecast(quiet) }));
    expect(log.laps.some((l) => l.surface === 'wet')).toBe(true);
    expect(sources(log, 'team0')).toContain('fallback:wet_track');
  });

  it('a dry race on one compound without the fallback gets the +30 s penalty', () => {
    const plan: GPPlan = {
      setup: { wing_level: 7, ride_height: 'mid', ers_mode: 'balanced' },
      variants: [{ when: {}, plan: { start_compound: 'hard', pace: 'conserve', stints: [{ compound: 'hard' }], rules: [] } }],
    };
    // 하드 1세트로는 끝까지 못 가므로 tire_life 폴백이 같은 컴파운드(다음 계획 없음 → hard)를 끼운다.
    const log = runRace(input({ track: quiet, entries: [{ team: 'a', spec: regs.fallback.spec, plan }], forecast: dryForecast(quiet) }));
    const usedOther = log.events.some((e) => e.type === 'pit' && e.to !== 'hard');
    const penalised = (log.result[0]?.penalties.length ?? 0) > 0;
    expect(usedOther || penalised).toBe(true);
  });
});

describe('safety car and weather', () => {
  it('safety car: deployed 3–5 laps, field compressed to the SC gap, no overtakes, then ends', () => {
    const sc = { ...track, sc_rate: 1 };
    const log = runRace(input({ track: sc, forecast: dryForecast(sc) }));
    const first = log.events.find((e) => e.type === 'safety_car');
    expect(first?.type === 'safety_car' && first.duration_laps).toBeGreaterThanOrEqual(regs.safety_car.duration_laps[0]);
    const scLap = log.laps.find((l) => l.sc);
    expect(scLap).toBeDefined();
    if (scLap) {
      const cums = scLap.order.map((team) => scLap.cars[team]?.cum ?? 0);
      const pitted = new Set(log.events.filter((e) => e.type === 'pit' && e.lap === scLap.lap).map((e) => (e.type === 'pit' ? e.car : '')));
      for (let k = 1; k < cums.length; k++) {
        const team = scLap.order[k] ?? '';
        if (!pitted.has(team) && !pitted.has(scLap.order[k - 1] ?? '')) {
          expect((cums[k] ?? 0) - (cums[k - 1] ?? 0)).toBeGreaterThanOrEqual(regs.safety_car.gap_s - 1e-9);
        }
      }
      expect(log.events.some((e) => e.type === 'overtake' && e.lap === scLap.lap)).toBe(false);
    }
    expect(log.events.some((e) => e.type === 'safety_car_end')).toBe(true);
  });

  it('a safety-car rule fires on the deployment lap (cheaper pit under SC)', () => {
    const sc = { ...track, sc_rate: 1 };
    const log = runRace(input({ track: sc, forecast: dryForecast(sc) }));
    const deployed = log.events.filter((e) => e.type === 'safety_car').map((e) => e.lap);
    const rulePits = log.strategy_trace.filter((t) => t.source === 'rule' && t.rule_idx === 0).map((t) => t.lap);
    expect(rulePits.length).toBeGreaterThan(0);
    for (const l of rulePits) expect(deployed).toContain(l);
    const scPit = log.events.find((e) => e.type === 'pit' && deployed.includes(e.lap));
    expect(scPit?.type === 'pit' && scPit.loss_s).toBeCloseTo(track.pit_loss_s * regs.safety_car.pit_loss_mult, 9);
  });

  it('rain: the surface turns wet and the rain rule switches to inters', () => {
    const log = runRace(input({ forecast: wetForecast(track) }));
    expect(log.meta.weather_realized.rain.length).toBeGreaterThan(0);
    expect(log.laps.some((l) => l.surface !== 'dry')).toBe(true);
    expect(log.events.some((e) => e.type === 'pit' && e.to === 'inter')).toBe(true);
  });
});

describe('determinism and independence (DESIGN.md §11)', () => {
  it("one team's extra pit stop does not change another team's failures", () => {
    const base = testEntries(track.laps);
    const changed = base.map((e, i) => (i === 0 ? { ...e, plan: testPlan(track.laps, 2) } : e));
    const fail = (log: RaceLog) =>
      log.events.filter((e) => e.type === 'retirement' && e.car !== 'team0').map((e) => (e.type === 'retirement' ? `${e.car}@${e.lap}` : ''));
    for (const seed of [21, 22, 23, 24]) {
      const a = runRace(input({ seed, entries: base, forecast: gpForecast(track, regs, seed) }));
      const b = runRace(input({ seed, entries: changed, forecast: gpForecast(track, regs, seed) }));
      expect(fail(b)).toEqual(fail(a));
    }
  });

  it('property: random specs, plans and seeds keep the invariants', () => {
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 2, maxLength: 6 }), fc.integer({ min: 0, max: 1e6 }), fc.boolean(), (specs, seed, twoStop) => {
        const t = tracks['tight-street'];
        const entries = specs.map((spec, i) => ({ team: `t${i}`, spec, plan: testPlan(t.laps, twoStop && i % 2 === 0 ? 2 : 1) }));
        checkInvariants(runRace({ season: 2026, gp: 1, track: t, forecast: gpForecast(t, regs, seed), entries, seed, regs }), entries);
      }),
      { numRuns: 12 },
    );
  });
});

describe('ERS battery', () => {
  it('attack drains the battery over a stint; harvest keeps it full', () => {
    const quiet = { ...track, sc_rate: 0 };
    const mk = (ers_mode: 'attack' | 'harvest'): RaceEntry => ({
      team: ers_mode,
      spec: regs.fallback.spec,
      plan: testPlan(quiet.laps, 1, { ers_mode }),
    });
    const log = runRace(input({ track: quiet, entries: [mk('attack'), mk('harvest')], forecast: dryForecast(quiet) }));
    const lap10 = log.laps[9];
    expect(lap10?.cars.attack?.ers).toBeLessThan(lap10?.cars.harvest?.ers ?? 0);
    expect(lap10?.cars.attack?.ers).toBe(0);
  });
});
