/**
 * 시즌 (DESIGN.md 2·10절): 캘린더, 포인트 집계, 순위.
 * 시즌 루프 자체는 에이전트 호출(비동기)이 끼므로 오케스트레이터(runner)가 돌고, 여기는 순수 계산만.
 */
import { z } from 'zod';
import type { RaceLog } from './log.js';

/** data/calendar/<season>.yaml (2절: 프리시즌에 규정과 함께 공개). */
export const CalendarSchema = z
  .strictObject({
    season: z.int(),
    gps: z.array(z.string().min(1)).min(1),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.gps.forEach((id, i) => {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['gps', i], message: `"${id}" is already on the calendar` });
      seen.add(id);
    });
  });
export type Calendar = z.infer<typeof CalendarSchema>;

export interface StandingRow {
  readonly team: string;
  readonly points: number;
  readonly pos: number;
  /** finishes[k] = k+1위로 끝난 횟수 (카운트백용). */
  readonly finishes: readonly number[];
  readonly wins: number;
  readonly dnfs: number;
}

/**
 * 레이스 결과들 → 순위. 포인트 합, 동점이면 카운트백 (1위 횟수, 그다음 2위 횟수, …), 그래도 같으면 팀 이름순.
 * teams 순서는 결과에 영향이 없다 (결정적).
 */
export function standings(teams: readonly string[], results: readonly RaceLog['result'][]): StandingRow[] {
  const size = Math.max(teams.length, ...results.map((r) => r.length));
  const rows = teams.map((team) => {
    const finishes = new Array<number>(size).fill(0);
    let points = 0;
    let dnfs = 0;
    for (const race of results) {
      const r = race.find((x) => x.team === team);
      if (!r) continue;
      points += r.points;
      if (r.status === 'finished') finishes[r.pos - 1] = (finishes[r.pos - 1] ?? 0) + 1;
      else dnfs += 1;
    }
    return { team, points, finishes, wins: finishes[0] ?? 0, dnfs };
  });
  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    for (let k = 0; k < size; k++) {
      const d = (b.finishes[k] ?? 0) - (a.finishes[k] ?? 0);
      if (d !== 0) return d;
    }
    return a.team < b.team ? -1 : a.team > b.team ? 1 : 0;
  });
  return rows.map((r, i) => ({ ...r, pos: i + 1 }));
}
