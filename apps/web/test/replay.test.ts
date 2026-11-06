import { readFileSync } from 'node:fs';
import {
  defaultPlan,
  derive,
  gpForecast,
  lapProgress,
  parseRegulations,
  parseTrack,
  parseTrackMeta,
  runRace,
  type CarSpec,
  type RaceLog,
} from '@f1sim/core';
import { describe, expect, it } from 'vitest';
import { colorSlots, shortCodes } from '../src/colors.js';
import { buildReplay, carPosition, distanceFraction, eventsUntil, raceLap, tower, trackPoint, type Replay } from '../src/replay.js';

const data = new URL('../../../data/', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, data), 'utf8');
const regs = parseRegulations(read('regulations/2026.yaml'), read('model/2026.yaml'));
const track = parseTrack(read('tracks/tight-street.csv'), parseTrackMeta(read('tracks/tight-street.yaml')), regs);
const progress = lapProgress(derive(regs.fallback.spec, regs.fallback.setup, track, regs), track, 'dry', regs);

/** 실제 엔진 레이스 하나: 신뢰성을 낮춘 차 하나를 넣어 리타이어도 나오게 시드를 고른다. */
function race(): RaceLog {
  const fragile: CarSpec = { ...regs.fallback.spec, powertrain: { ...regs.fallback.spec.powertrain, reliability: 0 } };
  for (let seed = 1; seed < 200; seed++) {
    const log = runRace({
      season: 2026,
      gp: 1,
      track,
      forecast: gpForecast(track, regs, seed),
      seed,
      regs,
      entries: ['a', 'b', 'c', 'd'].map((team, i) => ({ team, spec: i === 3 ? fragile : regs.fallback.spec, plan: defaultPlan(regs, track.laps) })),
    });
    if (log.events.some((e) => e.type === 'retirement') && log.events.some((e) => e.type === 'pit')) return log;
  }
  throw new Error('no race with a retirement');
}

const log = race();
const r: Replay = buildReplay(log, track, progress);
const L = track.length_m;

describe('distanceFraction (inverse of lapProgress)', () => {
  it('maps 0 → 0, 1 → 1 and inverts the progress curve at the samples', () => {
    expect(distanceFraction(progress, 0)).toBe(0);
    expect(distanceFraction(progress, 1)).toBe(1);
    for (const i of [1, 10, 100, progress.length - 1]) expect(distanceFraction(progress, progress[i] ?? 0)).toBeCloseTo(i / progress.length, 9);
  });
});

describe('carPosition', () => {
  it('starts on the grid behind the line in grid order', () => {
    const at0 = r.cars.map((c) => ({ grid: c.grid, p: carPosition(r, c, 0) }));
    expect(at0.every((x) => x.p.state === 'grid')).toBe(true);
    const byGrid = [...at0].sort((a, b) => a.grid - b.grid).map((x) => x.p.distance);
    expect(byGrid).toEqual([...byGrid].sort((a, b) => b - a));
  });

  it('is at the line when a lap ends, and never moves backwards', () => {
    for (const car of r.cars) {
      car.ends.forEach((end, k) => {
        const p = carPosition(r, car, end - 1e-6);
        expect(p.distance).toBeCloseTo((k + 1) * L, 0);
      });
      let prev = -Infinity;
      for (let t = 0; t <= r.duration; t += r.duration / 2000) {
        const d = carPosition(r, car, t).distance;
        expect(d).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = d;
      }
    }
  });

  it('waits in the pit at the end of a pit lap and stops where it retired', () => {
    const pit = log.events.find((e) => e.type === 'pit');
    if (pit?.type !== 'pit') throw new Error('no pit');
    const car = r.cars.find((c) => c.team === pit.car);
    if (!car) throw new Error('no car');
    const end = car.ends[pit.lap - 1] ?? 0;
    expect(carPosition(r, car, end - pit.loss_s / 2).state).toBe('pit');
    const ret = log.events.find((e) => e.type === 'retirement');
    if (ret?.type !== 'retirement') throw new Error('no retirement');
    const out = r.cars.find((c) => c.team === ret.car);
    if (!out) throw new Error('no car');
    const p = carPosition(r, out, ret.t + 100);
    expect(p).toMatchObject({ state: 'retired', distance: (ret.lap - 1) * L + ret.s });
  });
});

describe('tower, raceLap, events', () => {
  it('ends in the official result order with retirements last', () => {
    const rows = tower(r, r.duration + 1);
    expect(rows.map((x) => x.team)).toEqual(log.result.map((x) => x.team));
    expect(rows.at(-1)?.state).toBe('retired');
    expect(rows[0]?.gap).toBe(0);
  });

  it('gaps come from the last line crossing; lap and events follow the clock', () => {
    const leader = log.result[0]?.team ?? '';
    const lead = r.cars.find((c) => c.team === leader);
    const t = (lead?.ends[4] ?? 0) + 1;
    const rows = tower(r, t);
    for (const row of rows.filter((x) => x.state === 'racing' && x.gap !== null)) expect(row.gap).toBeGreaterThanOrEqual(0);
    expect(raceLap(r, t).lap).toBe(6);
    expect(eventsUntil(r, t).every((e) => e.t <= t && e.type !== 'overtake_failed')).toBe(true);
  });

  it('trackPoint interpolates between samples and wraps at the line', () => {
    const s0 = track.samples[0];
    expect(trackPoint(r.track, 0)).toEqual({ x: s0?.x, y: s0?.y });
    expect(trackPoint(r.track, L)).toEqual(trackPoint(r.track, 0));
  });
});

describe('colors and codes', () => {
  it('coding teams get the categorical slots in order; heuristics stay neutral', () => {
    const slots = colorSlots([
      { team: 'opus', agent: 'coding:claude-code' },
      { team: 'heuristic-01', agent: 'heuristic' },
      { team: 'sol', agent: 'coding:codex' },
    ]);
    expect([...slots]).toEqual([
      ['opus', 0],
      ['heuristic-01', null],
      ['sol', 1],
    ]);
    const all = colorSlots(Array.from({ length: 10 }, (_, i) => ({ team: `h${i}`, agent: 'heuristic' })));
    expect([...all.values()].filter((x) => x !== null)).toHaveLength(8);
  });

  it('three-letter codes, H01 for numbered teams, longer when they collide', () => {
    const codes = shortCodes(['opus', 'sonnet', 'heuristic-01', 'terra', 'tera']);
    expect(codes.get('opus')).toBe('OPUS'); // TER가 겹쳐 전부 네 글자로
    expect(codes.get('heuristic-01')).toBe('H01');
    expect(new Set(codes.values()).size).toBe(5);
  });
});
