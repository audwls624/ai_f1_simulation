/**
 * 레이스 엔진 (DESIGN.md 7절): GPPlan과 시드만 받아 예선부터 체커까지 돈다. 레이스 중 에이전트 호출은 없다.
 *
 * 랩 루프 (랩마다, 이 순서로):
 *   1 날씨 전이  2 세이프티카  3 전략 (엔진 폴백 → 팀 규칙 → 계획 피트)  4 랩타임  5 추월
 *   6 고장  7 피트스톱  8 순위·로그
 *
 * 난수 (11절): 레이스 시드 → 스트림(weather, safety_car, failures, overtaking, laptime_noise, qualifying, start).
 * 차·랩 단위 난수는 stream.spawn("<차 인덱스>/<랩>")으로 뽑는다 — 한 팀의 선택이 다른 팀의 난수를 바꾸지 않는다.
 */
import { derive, type CarSpec, type DerivedPerf, type Setup } from './car.js';
import { baseLap, inDirtyAir, raceLap, type LapBreakdown } from './laptime.js';
import { RaceLogSchema, shortHash, type RaceEventLog, type RaceLog, type StrategyTrace } from './log.js';
import { runQualifying } from './qualifying.js';
import { DRY_COMPOUNDS, type Compound, type PaceMode, type Regulations, type Surface } from './regulations.js';
import { makeRng, type Rng } from './rng.js';
import {
  evaluateRules,
  initialRuleState,
  nextPlannedCompound,
  raceSets,
  selectVariant,
  type Action,
  type GPPlan,
  type RaceEvent,
  type RacePlan,
  type RuleState,
} from './strategy.js';
import { wearPerLap } from './tires.js';
import type { Track } from './track.js';
import { isDryRace, isRaining, makeForecast, realize, surfaceByLap, type Forecast } from './weather.js';

export interface RaceEntry {
  readonly team: string;
  /** 검증된 스펙 (validateSpec 통과본). */
  readonly spec: CarSpec;
  /** 검증된 플랜 (validatePlan 통과본). */
  readonly plan: GPPlan;
  /** 3절: 스펙 검증 실패 페널티 — 그리드 최후위. */
  readonly gridPenalty?: boolean;
}

export interface RaceInput {
  readonly season: number;
  readonly gp: number;
  readonly track: Track;
  /** 플랜 제출 전에 공개된 예보 (gpForecast). */
  readonly forecast: Forecast;
  readonly entries: readonly RaceEntry[];
  /** 레이스 시드 (11절 race_seed). */
  readonly seed: number;
  readonly regs: Regulations;
}

/** 이 GP의 예보 (전략 제출 전 공개). 같은 레이스 시드의 forecast 스트림. */
export function gpForecast(track: Track, regs: Regulations, seed: number): Forecast {
  return makeForecast(track, regs, makeRng(seed).spawn('forecast'));
}

const SLICKS: ReadonlySet<Compound> = new Set(DRY_COMPOUNDS);
const NO_SETS_ORDER: Readonly<Record<Compound, readonly Compound[]>> = {
  soft: ['soft', 'medium', 'hard'],
  medium: ['medium', 'hard', 'soft'],
  hard: ['hard', 'medium', 'soft'],
  inter: ['inter', 'wet'],
  wet: ['wet', 'inter'],
};

interface PendingPit {
  readonly compound: Compound;
  readonly extraS: number;
}

interface Car {
  readonly index: number;
  readonly team: string;
  readonly setup: Setup;
  readonly perf: DerivedPerf;
  readonly spec: CarSpec;
  /** 서페이스별 baseLap (셋업 그대로 / attack이면 배터리가 비었을 때의 balanced). */
  readonly base: Readonly<Record<Surface, LapBreakdown>>;
  readonly baseDepleted: Readonly<Record<Surface, LapBreakdown>> | null;
  readonly plan: RacePlan;
  readonly variant: number;
  readonly grid: number;
  readonly qualiLap: number;
  readonly plannedPit: (number | undefined)[];
  readonly setsLeft: Record<Compound, number>;
  readonly dryUsed: Set<Compound>;
  readonly penalties: { reason: string; s: number }[];
  readonly socCap: number;
  ruleState: RuleState;
  cum: number;
  laps: number;
  retiredLap: number | null;
  compound: Compound;
  life: number;
  age: number;
  lapsOnCompound: number;
  stintIndex: number;
  pace: PaceMode;
  fuel: number;
  soc: number;
  wrongTireLaps: number;
  pittedLastLap: boolean;
}

function lerpBreakdown(a: LapBreakdown, b: LapBreakdown, f: number): LapBreakdown {
  const mix = (x: number, y: number) => x + (y - x) * f;
  return {
    total: mix(a.total, b.total),
    straight: mix(a.straight, b.straight),
    lowSpeed: mix(a.lowSpeed, b.lowSpeed),
    midSpeed: mix(a.midSpeed, b.midSpeed),
    highSpeed: mix(a.highSpeed, b.highSpeed),
    topSpeedKph: mix(a.topSpeedKph, b.topSpeedKph),
  };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function surfaceBases(perf: DerivedPerf, track: Track, regs: Regulations): Record<Surface, LapBreakdown> {
  return {
    dry: baseLap(perf, track, 'dry', regs),
    damp: baseLap(perf, track, 'damp', regs),
    wet: baseLap(perf, track, 'wet', regs),
  };
}

function wrongTires(surface: Surface, compound: Compound): boolean {
  return (surface === 'wet' && SLICKS.has(compound)) || (surface === 'dry' && !SLICKS.has(compound));
}

/** 이번 랩 행동 결정: 엔진 폴백 → 팀 규칙 → 계획 피트 (8절 평가 의미론, 7절 폴백 표). */
function decide(
  car: Car,
  ctx: { lap: number; laps: number; surface: Surface; events: ReadonlySet<RaceEvent>; dryRaceSoFar: boolean },
  view: { position: number; gapAhead: number; gapBehind: number; aheadPitted: boolean; behindPitted: boolean },
  regs: Regulations,
  trace: StrategyTrace[],
): PendingPit | null {
  const fb = regs.engine_fallbacks;
  const lapsRemaining = ctx.laps - ctx.lap + 1;
  const planned = (fallback: Compound) => nextPlannedCompound(car.plan, car.stintIndex, fallback);
  const record = (action: Action, source: string, ruleIdx?: number) =>
    trace.push({ lap: ctx.lap, car: car.team, action, source, ...(ruleIdx !== undefined ? { rule_idx: ruleIdx } : {}) });

  // 1) 엔진 폴백 (항상 최우선)
  let fallback: { compound: Compound; reason: string; extra: number } | null = null;
  if (car.life <= 0) {
    fallback = { compound: planned('hard'), reason: 'tire_life', extra: fb.tire_out_extra_s };
  } else if (ctx.surface === 'wet' && SLICKS.has(car.compound) && car.wrongTireLaps >= fb.wrong_tire_laps) {
    fallback = { compound: 'inter', reason: 'wet_track', extra: 0 };
  } else if (ctx.surface === 'dry' && !SLICKS.has(car.compound) && car.wrongTireLaps >= fb.wrong_tire_laps) {
    const nextDry = car.plan.stints.slice(car.stintIndex + 1).find((s) => SLICKS.has(s.compound))?.compound ?? 'hard';
    fallback = { compound: nextDry, reason: 'dry_track', extra: 0 };
  } else if (
    ctx.dryRaceSoFar &&
    lapsRemaining <= fb.compound_rule_laps_left &&
    SLICKS.has(car.compound) &&
    car.dryUsed.size < regs.tires.dry_race_min_compounds
  ) {
    const candidates = [planned('hard'), ...DRY_COMPOUNDS];
    const unused = candidates.find((c) => SLICKS.has(c) && !car.dryUsed.has(c) && car.setsLeft[c] > 0);
    if (unused) fallback = { compound: unused, reason: 'compound_rule', extra: 0 };
  }
  if (fallback) {
    record({ pit: fallback.compound }, `fallback:${fallback.reason}`);
    return { compound: fallback.compound, extraS: fallback.extra };
  }

  // 2) 팀 규칙 (첫 매치)
  let pit: PendingPit | null = null;
  const result = evaluateRules(
    car.plan,
    {
      lap: ctx.lap,
      laps_remaining: lapsRemaining,
      events: ctx.events,
      surface: ctx.surface,
      tire_life: car.life,
      tire_age: car.age,
      tire_compound: car.compound,
      laps_on_compound: car.lapsOnCompound,
      position: view.position,
      gap_ahead: view.gapAhead,
      gap_behind: view.gapBehind,
      rival_ahead_pitted: view.aheadPitted,
      rival_behind_pitted: view.behindPitted,
      stint_index: car.stintIndex,
    },
    car.ruleState,
  );
  car.ruleState = result.state;
  if (result.fired) {
    const { index, action } = result.fired;
    record(action, 'rule', index);
    if (action === 'none') {
      // 아래 규칙 차단용. 계획 피트는 그대로 둔다.
    } else if ('pit' in action) {
      pit = { compound: action.pit === 'next_planned' ? planned('hard') : action.pit, extraS: 0 };
    } else if ('pace' in action) {
      car.pace = action.pace;
    } else {
      const lapNow = car.plannedPit[car.stintIndex];
      if (lapNow !== undefined) car.plannedPit[car.stintIndex] = lapNow + action.extend_stint;
    }
  }

  // 3) 계획 피트 (지나간 계획 랩이면 즉시)
  const plannedLap = car.plannedPit[car.stintIndex];
  if (!pit && plannedLap !== undefined && ctx.lap >= plannedLap) {
    const compound = planned('hard');
    record({ pit: 'next_planned' }, 'planned');
    pit = { compound, extraS: 0 };
  }
  return pit;
}

/** 세트가 없으면 비슷한 컴파운드로 바꾼다. 아무것도 없으면 null (피트 안 함). */
function fit(car: Car, wanted: Compound): Compound | null {
  return NO_SETS_ORDER[wanted].find((c) => car.setsLeft[c] > 0) ?? null;
}

/** 레이스 한 판. 결과는 RaceLog (10절). 같은 입력이면 바이트 단위로 같은 로그. */
export function runRace(input: RaceInput): RaceLog {
  const { track, regs, entries } = input;
  const L = track.laps;
  const root = makeRng(input.seed);
  const streams = {
    weather: root.spawn('weather'),
    safetyCar: root.spawn('safety_car'),
    failures: root.spawn('failures'),
    overtaking: root.spawn('overtaking'),
    noise: root.spawn('laptime_noise'),
    qualifying: root.spawn('qualifying'),
    start: root.spawn('start'),
  };
  const draw = (stream: Rng, key: string) => stream.spawn(key);

  const weather = realize(input.forecast, track, regs, streams.weather);
  const surfaces = surfaceByLap(weather, L, regs);

  // 차 준비: 실현 기온으로 derive, 서페이스별 baseLap 캐시.
  const prepared = entries.map((entry) => {
    const setup = entry.plan.setup;
    const perf = derive(entry.spec, setup, track, regs, weather.temp_c);
    const depleted = setup.ers_mode === 'attack' ? derive(entry.spec, { ...setup, ers_mode: 'balanced' }, track, regs, weather.temp_c) : null;
    return { entry, setup, perf, base: surfaceBases(perf, track, regs), baseDepleted: depleted ? surfaceBases(depleted, track, regs) : null };
  });

  // 예선 → 그리드 → 변형.
  const quali = runQualifying(
    prepared.map((p) => ({ perf: p.perf, dryBase: p.base.dry, gridPenalty: p.entry.gridPenalty ?? false })),
    regs,
    streams.qualifying,
  );
  const cars: Car[] = prepared.map((p, index) => {
    const q = quali[index] ?? { lap: 0, grid: index + 1 };
    const { index: variant, plan } = selectVariant(p.entry.plan, q.grid);
    const socCap =
      regs.ers_battery.capacity_mj[0] +
      (regs.ers_battery.capacity_mj[1] - regs.ers_battery.capacity_mj[0]) * p.entry.spec.powertrain.ers_capacity;
    const setsLeft = raceSets(regs);
    const start = plan.start_compound;
    setsLeft[start] = Math.max(0, setsLeft[start] - 1);
    return {
      index,
      team: p.entry.team,
      setup: p.setup,
      perf: p.perf,
      spec: p.entry.spec,
      base: p.base,
      baseDepleted: p.baseDepleted,
      plan,
      variant,
      grid: q.grid,
      qualiLap: q.lap,
      plannedPit: plan.stints.map((s) => s.planned_pit_lap),
      setsLeft,
      dryUsed: new Set(SLICKS.has(start) ? [start] : []),
      penalties: [],
      socCap,
      ruleState: initialRuleState(plan),
      cum: 0,
      laps: 0,
      retiredLap: null,
      compound: start,
      life: 1,
      age: 0,
      lapsOnCompound: 0,
      stintIndex: 0,
      pace: plan.pace,
      fuel: L * p.perf.fuel_per_lap_kg * regs.pace_modes[plan.pace].fuel_mult + regs.fuel.reserve_kg,
      soc: socCap,
      wrongTireLaps: 0,
      pittedLastLap: false,
    };
  });

  // 스타트: 그리드 + N(0, σ)로 정렬, 순서마다 grid_gap_s.
  let order = cars
    .map((c) => ({ c, key: c.grid + draw(streams.start, String(c.index)).normal(0, regs.start.noise_sd_positions) }))
    .sort((a, b) => a.key - b.key || a.c.index - b.c.index)
    .map((x) => x.c);
  order.forEach((c, k) => {
    c.cum = k * regs.start.grid_gap_s;
  });

  const laps: RaceLog['laps'] = [];
  const events: RaceEventLog[] = [];
  const trace: StrategyTrace[] = [];
  const longestDrs = track.drs_zones[0]?.from_m ?? 0;
  let scLeft = 0;
  let scJustEnded = false;
  let failureLastLap = false;

  for (let lap = 1; lap <= L; lap++) {
    const surface = surfaces[lap - 1] ?? 'dry';
    const running = order.filter((c) => c.retiredLap === null);
    const startCum = new Map(running.map((c) => [c.index, c.cum]));
    const leaderCum = running[0]?.cum ?? 0;
    const lapEvents = new Set<RaceEvent>();

    // 1) 날씨
    const rainNow = isRaining(weather, lap);
    const rainBefore = lap > 1 && isRaining(weather, lap - 1);
    if (rainNow && !rainBefore) {
      lapEvents.add('rain_start');
      events.push({ type: 'rain_start', t: leaderCum, lap, s: 0 });
    }
    if (!rainNow && rainBefore) {
      lapEvents.add('rain_stop');
      events.push({ type: 'rain_stop', t: leaderCum, lap, s: 0 });
    }

    // 2) 세이프티카
    let sc = scLeft > 0;
    if (!sc) {
      if (scJustEnded) {
        lapEvents.add('safety_car_end');
        events.push({ type: 'safety_car_end', t: leaderCum, lap, s: 0 });
      }
      const r = draw(streams.safetyCar, `lap/${lap}`);
      const u = r.next();
      const durationU = r.next();
      const p = track.sc_rate * (failureLastLap ? regs.failures.sc_mult_after_failure : 1);
      if (u < p && lap < L) {
        const [lo, hi] = regs.safety_car.duration_laps;
        scLeft = lo + Math.floor(durationU * (hi - lo + 1));
        sc = true;
        lapEvents.add('safety_car');
        events.push({ type: 'safety_car', t: leaderCum, lap, s: 0, duration_laps: scLeft });
      }
    }
    scJustEnded = false;

    // 3) 전략 (차량 인덱스 순)
    const position = new Map(running.map((c, k) => [c.index, k]));
    const dryRaceSoFar = isDryRace(surfaces.slice(0, lap));
    const pending = new Map<number, PendingPit>();
    for (const car of cars) {
      if (car.retiredLap !== null) continue;
      const k = position.get(car.index) ?? 0;
      const ahead = running[k - 1];
      const behind = running[k + 1];
      const pit = decide(
        car,
        { lap, laps: L, surface, events: lapEvents, dryRaceSoFar },
        {
          position: k + 1,
          gapAhead: ahead ? car.cum - ahead.cum : Infinity,
          gapBehind: behind ? behind.cum - car.cum : Infinity,
          aheadPitted: ahead?.pittedLastLap ?? false,
          behindPitted: behind?.pittedLastLap ?? false,
        },
        regs,
        trace,
      );
      if (pit) pending.set(car.index, pit);
    }

    // 4) 랩타임 (배터리 포함)
    const lapTime = new Map<number, number>();
    const dirty = new Map<number, boolean>();
    for (const car of running) {
      const k = position.get(car.index) ?? 0;
      const ahead = running[k - 1];
      const gapAhead = ahead ? car.cum - ahead.cum : Infinity;
      const perLap = regs.ers_battery.per_lap_mj[car.setup.ers_mode];
      let base = car.base[surface];
      if (perLap < 0 && car.baseDepleted) {
        const frac = Math.min(1, car.soc / -perLap);
        base = lerpBreakdown(car.baseDepleted[surface], car.base[surface], frac);
        car.soc = Math.max(0, car.soc + perLap * frac);
      } else {
        car.soc = Math.min(car.socCap, car.soc + perLap);
      }
      const inDirty = !sc && inDirtyAir(gapAhead, regs);
      dirty.set(car.index, inDirty);
      const t = raceLap(
        base,
        {
          compound: car.compound,
          surface,
          tire_life: car.life,
          tire_age_laps: car.age,
          fuel_kg: car.fuel,
          pace: car.pace,
          gap_ahead_s: sc ? Infinity : gapAhead,
          dirty_air_loss: car.perf.dirty_air_loss,
          warmup_penalty_s: car.perf.warmup_penalty_s,
          noise_s: draw(streams.noise, `${car.index}/${lap}`).normal(0, regs.laptime.noise_sd_s),
        },
        regs,
      );
      lapTime.set(car.index, t + (pending.get(car.index)?.extraS ?? 0));
    }

    // 5) 추월 (세이프티카 중이면 대열 압축)
    const next = new Map<number, number>();
    const newOrder = [...running];
    if (sc) {
      // 선두는 세이프티카 페이스(×1.4). 뒤차들은 자기 랩타임만큼만 따라붙고, 앞차와 gap_s보다 가까워지지 않는다.
      newOrder.forEach((car, k) => {
        const prev = newOrder[k - 1];
        const own = lapTime.get(car.index) ?? 0;
        next.set(
          car.index,
          prev
            ? Math.max((next.get(prev.index) ?? 0) + regs.safety_car.gap_s, car.cum + own)
            : car.cum + own * regs.safety_car.lap_time_mult,
        );
      });
    } else {
      for (const car of running) next.set(car.index, car.cum + (lapTime.get(car.index) ?? 0));
      const ov = regs.overtaking;
      for (let k = 1; k < newOrder.length; k++) {
        const leader = newOrder[k - 1];
        const follower = newOrder[k];
        if (!leader || !follower) continue;
        const tl = lapTime.get(leader.index) ?? 0;
        const tf = lapTime.get(follower.index) ?? 0;
        const startGap = follower.cum - leader.cum;
        const leaderEnd = next.get(leader.index) ?? 0;
        const followerEnd = next.get(follower.index) ?? 0;
        if (tf < tl && startGap < ov.gap_s) {
          const boost = (car: Car) => {
            const available = ov.ers > 0 && regs.ers_battery.overtake_mj > 0 ? Math.min(1, car.soc / regs.ers_battery.overtake_mj) : 0;
            car.soc = Math.max(0, car.soc - regs.ers_battery.overtake_mj);
            return car.perf.ers_boost * available;
          };
          const logit =
            ov.bias +
            ov.pace * (tl - tf) +
            ov.drs * (track.drs_zones.length > 0 ? follower.perf.drs_gain : 0) +
            ov.ers * boost(follower) +
            ov.dirty_air_resistance * follower.spec.aero.dirty_air_resistance -
            ov.difficulty * track.overtake_difficulty -
            ov.defense * boost(leader);
          const passed = draw(streams.overtaking, `${follower.index}/${lap}`).next() < sigmoid(logit);
          if (passed) {
            next.set(follower.index, Math.min(followerEnd, leaderEnd - ov.pass_margin_s));
            newOrder[k - 1] = follower;
            newOrder[k] = leader;
            events.push({ type: 'overtake', t: next.get(follower.index) ?? 0, lap, s: longestDrs, car: follower.team, on: leader.team });
          } else {
            next.set(follower.index, Math.max(followerEnd, leaderEnd + ov.fail_gap_s));
            dirty.set(follower.index, true);
            events.push({ type: 'overtake_failed', t: next.get(follower.index) ?? 0, lap, s: longestDrs, car: follower.team, on: leader.team });
          }
        } else if (followerEnd <= leaderEnd) {
          // 시도 없이 앞지를 수는 없다: 앞차 뒤에 붙는다.
          next.set(follower.index, leaderEnd + ov.fail_gap_s);
        }
      }
    }

    // 6) 고장
    let failedThisLap = false;
    for (const car of cars) {
      if (car.retiredLap !== null) continue;
      const p =
        car.perf.failure_rate_per_lap *
        (1 + regs.failures.heat_mult_per_derate * car.perf.heat_derate) *
        regs.pace_modes[car.pace].failure_mult;
      if (draw(streams.failures, `${car.index}/${lap}`).next() < p) {
        car.retiredLap = lap;
        failedThisLap = true;
        pending.delete(car.index);
        events.push({ type: 'retirement', t: car.cum, lap, s: 0, car: car.team, reason: 'failure' });
      }
    }

    // 7) 피트 + 타이어·연료 갱신
    for (const car of cars) {
      if (car.retiredLap !== null) continue;
      const before = car.cum;
      let cum = next.get(car.index) ?? car.cum;
      car.life = Math.max(
        0,
        car.life - wearPerLap(car.compound, car.perf, track, car.pace, dirty.get(car.index) ?? false, surface, regs),
      );
      car.fuel = Math.max(0, car.fuel - car.perf.fuel_per_lap_kg * regs.pace_modes[car.pace].fuel_mult);
      car.age += 1;
      car.lapsOnCompound += 1;
      car.wrongTireLaps = wrongTires(surface, car.compound) ? car.wrongTireLaps + 1 : 0;
      car.pittedLastLap = false;
      const pit = pending.get(car.index);
      if (pit) {
        const fitted = fit(car, pit.compound);
        if (fitted) {
          const loss = track.pit_loss_s * (sc ? regs.safety_car.pit_loss_mult : 1);
          cum += loss;
          events.push({ type: 'pit', t: cum, lap, s: track.pit_entry_m, car: car.team, from: car.compound, to: fitted, loss_s: loss });
          if (fitted !== pit.compound) {
            const last = trace.findLast((tr) => tr.car === car.team && tr.lap === lap);
            if (last) trace[trace.lastIndexOf(last)] = { ...last, fitted };
          }
          car.setsLeft[fitted] -= 1;
          if (fitted !== car.compound) car.lapsOnCompound = 0;
          if (SLICKS.has(fitted)) car.dryUsed.add(fitted);
          car.compound = fitted;
          car.life = 1;
          car.age = 0;
          car.stintIndex += 1;
          car.wrongTireLaps = 0;
          car.pittedLastLap = true;
        }
      }
      car.cum = Math.max(cum, before);
      car.laps = lap;
    }

    // 8) 순위·로그
    order = [
      ...cars
        .filter((c) => c.retiredLap === null)
        .sort((a, b) => a.cum - b.cum || newOrder.indexOf(a) - newOrder.indexOf(b)),
      ...cars
        .filter((c) => c.retiredLap !== null)
        .sort((a, b) => (b.retiredLap ?? 0) - (a.retiredLap ?? 0) || a.index - b.index),
    ];
    const runningNow = order.filter((c) => c.retiredLap === null);
    const lapCars: RaceLog['laps'][number]['cars'] = {};
    for (const car of cars) {
      if (car.retiredLap !== null) continue;
      lapCars[car.team] = {
        t: car.cum - (startCum.get(car.index) ?? car.cum),
        cum: car.cum,
        pos: runningNow.indexOf(car) + 1,
        compound: car.compound,
        life: car.life,
        fuel: car.fuel,
        pace: car.pace,
        ers: car.soc,
      };
    }
    laps.push({ lap, order: runningNow.map((c) => c.team), surface, sc, cars: lapCars });

    if (sc) {
      scLeft -= 1;
      if (scLeft === 0) scJustEnded = true;
    }
    failureLastLap = failedThisLap;
  }

  // 피니시: 2종 컴파운드 → 벌점 → 순위 → 포인트 (7절).
  const dryRace = isDryRace(surfaces);
  for (const car of cars) {
    if (car.retiredLap === null && dryRace && car.dryUsed.size < regs.tires.dry_race_min_compounds) {
      car.penalties.push({ reason: 'dry_compound_rule', s: regs.penalties.dry_compound_rule_s });
    }
  }
  const total = (c: Car) => c.cum + c.penalties.reduce((s, p) => s + p.s, 0);
  const classified = [
    ...cars.filter((c) => c.retiredLap === null).sort((a, b) => total(a) - total(b) || a.index - b.index),
    ...cars.filter((c) => c.retiredLap !== null).sort((a, b) => b.laps - a.laps || a.index - b.index),
  ];
  const result = classified.map((c, k) => {
    const finished = c.retiredLap === null;
    return {
      team: c.team,
      pos: k + 1,
      time: finished ? total(c) : null,
      laps: c.laps,
      status: finished ? ('finished' as const) : ('retired' as const),
      points: finished ? (regs.points[k] ?? 0) : 0,
      penalties: c.penalties,
    };
  });

  return RaceLogSchema.parse({
    schema: 'racelog/1',
    meta: {
      season: input.season,
      gp: input.gp,
      track: track.id,
      seed: input.seed,
      laps: L,
      weather_realized: weather,
      sample_interval_m: null,
    },
    cars: cars.map((c) => ({
      team: c.team,
      spec_hash: shortHash(c.spec),
      setup: c.setup,
      variant_selected: c.variant,
      grid: c.grid,
      quali_lap: c.qualiLap,
    })),
    laps,
    events,
    strategy_trace: trace,
    result,
  });
}

