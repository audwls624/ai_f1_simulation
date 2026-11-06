/**
 * 리플레이 모델 (순수 계산, DOM 없음). 레이스 로그에는 랩 끝 누적 시간만 있으므로(거리 샘플은 M7),
 * 랩 안의 위치는 core의 lapProgress 곡선으로 보간한다 — 코너에서 느리고 직선에서 빠르다.
 * 피트 랩: 손실 시간만큼 랩 끝(피트)에서 멈춰 있다. 리타이어: 그 지점에서 멈춘다.
 */
import type { Compound, RaceEventLog, RaceLog, Surface, Track } from '@f1sim/core';

/** 스타트 그리드 간격 (m, 화면용). */
const GRID_SPACING_M = 8;

export type CarState = 'grid' | 'racing' | 'pit' | 'finished' | 'retired';

export interface CarTimeline {
  readonly team: string;
  readonly grid: number;
  /** ends[k] = k+1랩을 끝낸 누적 시간. */
  readonly ends: readonly number[];
  /** 랩 번호 → 그 랩 끝 피트 손실 (s). */
  readonly pitLoss: ReadonlyMap<number, number>;
  readonly retired: { readonly t: number; readonly lap: number; readonly s: number } | null;
  readonly finished: boolean;
}

export interface ReplayTrack {
  readonly length: number;
  readonly step: number;
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly drs: readonly boolean[];
}

export interface Replay {
  readonly log: RaceLog;
  readonly track: ReplayTrack;
  /** lapProgress: 샘플별 랩 시간 비율 (0에서 시작, 단조 증가). */
  readonly progress: readonly number[];
  readonly cars: readonly CarTimeline[];
  /** 마지막 차가 끝나거나 멈춘 시각. */
  readonly duration: number;
  /** 첫 랩 시간의 중앙값 — 첫 랩에 리타이어한 차를 움직일 때 쓴다. */
  readonly firstLap: number;
}

export interface CarPosition {
  /** 랩 안의 거리 (m, 0 ≤ s < length). */
  readonly s: number;
  /** 지금 달리는 랩 (1부터). 완주하면 laps. */
  readonly lap: number;
  /** 레이스 누적 거리 (m) — 순위 비교용. */
  readonly distance: number;
  readonly state: CarState;
}

export function buildReplay(log: RaceLog, track: Pick<Track, 'length_m' | 'step_m' | 'samples'>, progress: readonly number[]): Replay {
  const cars = log.cars.map((c): CarTimeline => {
    const ends: number[] = [];
    for (const lap of log.laps) {
      const state = lap.cars[c.team];
      if (!state) break;
      ends.push(state.cum);
    }
    const pitLoss = new Map<number, number>();
    let retired: CarTimeline['retired'] = null;
    for (const e of log.events) {
      if (e.type === 'pit' && e.car === c.team) pitLoss.set(e.lap, e.loss_s);
      if (e.type === 'retirement' && e.car === c.team) retired = { t: e.t, lap: e.lap, s: e.s };
    }
    const result = log.result.find((r) => r.team === c.team);
    return { team: c.team, grid: c.grid, ends, pitLoss, retired, finished: result?.status === 'finished' };
  });
  const duration = Math.max(0, ...cars.map((c) => Math.max(c.ends.at(-1) ?? 0, c.retired?.t ?? 0)));
  const firsts = cars.map((c) => c.ends[0]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  const firstLap = firsts[Math.floor(firsts.length / 2)] ?? 1;
  return {
    log,
    track: {
      length: track.length_m,
      step: track.step_m,
      xs: track.samples.map((p) => p.x),
      ys: track.samples.map((p) => p.y),
      drs: track.samples.map((p) => p.drs),
    },
    progress,
    cars,
    duration,
    firstLap,
  };
}

/** 랩 시간 비율 f (0–1) → 랩 안 거리 비율 (lapProgress의 역함수, 선형 보간). */
export function distanceFraction(progress: readonly number[], f: number): number {
  const n = progress.length;
  if (n === 0 || f <= 0) return 0;
  if (f >= 1) return 1;
  let lo = 0;
  let hi = n - 1;
  if (f >= (progress[hi] ?? 0)) {
    const p = progress[hi] ?? 0;
    return (hi + (f - p) / (1 - p)) / n;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((progress[mid] ?? 0) <= f) lo = mid;
    else hi = mid;
  }
  const a = progress[lo] ?? 0;
  const b = progress[hi] ?? 1;
  return (lo + (f - a) / (b - a)) / n;
}

export function carPosition(r: Replay, car: CarTimeline, t: number): CarPosition {
  const L = r.track.length;
  const laps = r.log.meta.laps;
  const gridOffset = -GRID_SPACING_M * (car.grid - 1);
  const wrap = (s: number) => ((s % L) + L) % L;
  // 이벤트의 s는 랩 안 거리다. 고장은 그 랩을 시작하는 시점(출발선, s = 0)에 기록된다.
  if (car.retired && t >= car.retired.t) return { s: wrap(car.retired.s), lap: car.retired.lap, distance: (car.retired.lap - 1) * L + car.retired.s, state: 'retired' };
  if (t <= 0) return { s: wrap(gridOffset), lap: 1, distance: gridOffset, state: 'grid' };
  let k = 0; // 끝낸 랩 수
  while (k < car.ends.length && (car.ends[k] ?? Infinity) <= t) k++;
  if (car.finished && k >= laps) return { s: 0, lap: laps, distance: laps * L, state: 'finished' };

  const start = k === 0 ? 0 : (car.ends[k - 1] ?? 0);
  const lap = k + 1;
  // 리타이어하는 랩은 끝 시각이 없다: 직전 랩 시간으로 달리다 리타이어 지점에서 멈춘다.
  const previous = k > 0 ? (car.ends[k - 1] ?? 0) - (k > 1 ? (car.ends[k - 2] ?? 0) : 0) : (car.ends[0] ?? r.firstLap);
  const end = car.ends[k] ?? start + previous;
  const loss = car.pitLoss.get(lap) ?? 0;
  const racing = Math.max(1e-6, end - start - loss);
  const elapsed = t - start;
  const from = lap === 1 ? gridOffset : 0;
  if (elapsed >= racing && loss > 0) return { s: 0, lap, distance: k * L + L, state: 'pit' };
  const d = from + distanceFraction(r.progress, Math.min(1, elapsed / racing)) * (L - from);
  return { s: wrap(d), lap, distance: k * L + d, state: 'racing' };
}

export function trackPoint(track: ReplayTrack, s: number): { x: number; y: number } {
  const n = track.xs.length;
  const u = (((s / track.step) % n) + n) % n;
  const i = Math.floor(u);
  const j = (i + 1) % n;
  const w = u - i;
  return {
    x: (track.xs[i] ?? 0) * (1 - w) + (track.xs[j] ?? 0) * w,
    y: (track.ys[i] ?? 0) * (1 - w) + (track.ys[j] ?? 0) * w,
  };
}

export interface TowerRow {
  readonly pos: number;
  readonly team: string;
  readonly state: CarState;
  readonly lap: number;
  /** 선두와의 차이 (마지막으로 지난 출발선 기준, s). 선두는 0, 아직 첫 랩 전이면 null. */
  readonly gap: number | null;
  readonly compound: Compound | null;
  readonly life: number | null;
  readonly pits: number;
}

/** 지금 순위 (달린 거리 순, 완주는 결과 순, 리타이어는 맨 뒤). */
export function tower(r: Replay, t: number): TowerRow[] {
  const result = new Map(r.log.result.map((x) => [x.team, x.pos]));
  const rows = r.cars.map((car) => {
    const p = carPosition(r, car, t);
    let k = 0;
    while (k < car.ends.length && (car.ends[k] ?? Infinity) <= t) k++;
    const lapState = k > 0 ? r.log.laps[k - 1]?.cars[car.team] : r.log.laps[0]?.cars[car.team];
    const pits = r.log.events.filter((e) => e.type === 'pit' && e.car === car.team && e.t <= t).length;
    return { car, p, k, lapState, pits };
  });
  const firstAt = (k: number) => Math.min(...r.cars.map((c) => c.ends[k - 1] ?? Infinity));
  rows.sort((a, b) => {
    const rank = (x: (typeof rows)[number]) => (x.p.state === 'retired' ? 2 : x.p.state === 'finished' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.p.state === 'finished') return (result.get(a.car.team) ?? 0) - (result.get(b.car.team) ?? 0);
    return b.p.distance - a.p.distance || a.car.grid - b.car.grid;
  });
  return rows.map((x, i) => ({
    pos: i + 1,
    team: x.car.team,
    state: x.p.state,
    lap: x.p.lap,
    gap: x.k > 0 ? (x.car.ends[x.k - 1] ?? 0) - firstAt(x.k) : null,
    compound: x.lapState?.compound ?? null,
    life: x.k > 0 ? (x.lapState?.life ?? null) : null,
    pits: x.pits,
  }));
}

/** 선두가 달리는 랩과 그 랩의 노면·세이프티카. */
export function raceLap(r: Replay, t: number): { lap: number; surface: Surface; sc: boolean } {
  const lap = Math.max(1, ...r.cars.map((c) => carPosition(r, c, t).lap));
  const info = r.log.laps[Math.min(lap, r.log.laps.length) - 1];
  return { lap, surface: info?.surface ?? 'dry', sc: info?.sc ?? false };
}

/** t까지 일어난 이벤트 (최근 것부터). 실패한 추월 시도는 뺀다. */
export function eventsUntil(r: Replay, t: number): RaceEventLog[] {
  return r.log.events.filter((e) => e.t <= t && e.type !== 'overtake_failed').reverse();
}
