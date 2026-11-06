import { describe, expect, it } from 'vitest';
import type { RaceLog } from '../src/log.js';
import { CalendarSchema, standings } from '../src/season.js';

type Row = RaceLog['result'][number];
const row = (team: string, pos: number, points: number, status: Row['status'] = 'finished'): Row => ({
  team,
  pos,
  time: status === 'finished' ? 5000 + pos : null,
  laps: 50,
  status,
  points,
  penalties: [],
});

describe('standings (DESIGN.md §2)', () => {
  it('sums points and orders by them', () => {
    const s = standings(['a', 'b', 'c'], [
      [row('a', 1, 25), row('b', 2, 18), row('c', 3, 15)],
      [row('b', 1, 25), row('c', 2, 18), row('a', 3, 15, 'finished')],
    ]);
    expect(s.map((r) => [r.team, r.points, r.pos])).toEqual([['b', 43, 1], ['a', 40, 2], ['c', 33, 3]]);
  });

  it('breaks ties by countback (more wins first), then by name', () => {
    const s = standings(['x', 'y', 'z'], [
      [row('x', 1, 25), row('y', 2, 18), row('z', 3, 0, 'retired')],
      [row('y', 1, 25), row('x', 3, 18), row('z', 2, 0)],
    ]);
    expect(s[0]?.team).toBe('y'); // 43 vs 43: 둘 다 1승 → 2위 횟수에서 y
    expect(s[0]?.wins).toBe(1);
    expect(s.find((r) => r.team === 'z')?.dnfs).toBe(1);
    const tie = standings(['b', 'a'], [[row('a', 1, 10), row('b', 1, 10)]]);
    expect(tie.map((r) => r.team)).toEqual(['a', 'b']);
  });

  it('does not depend on the order of the team list', () => {
    const races = [[row('a', 2, 18), row('b', 1, 25)]];
    expect(standings(['a', 'b'], races)).toEqual(standings(['b', 'a'], races));
  });
});

describe('CalendarSchema', () => {
  it('rejects a track listed twice', () => {
    const r = CalendarSchema.safeParse({ season: 2026, gps: ['a', 'b', 'a'] });
    expect(r.success).toBe(false);
  });
});
