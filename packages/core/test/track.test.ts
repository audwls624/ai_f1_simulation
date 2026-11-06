import { describe, expect, it } from 'vitest';
import { TrackError, TrackProfileSchema, parseTrack, parseTrackMeta, profile, type TrackMeta } from '../src/track.js';
import { TRACK_IDS, regs, trackFiles, tracks } from './helpers.js';

const HEADER = 'x_m,y_m,z_m,w_left_m,w_right_m';

/** 테스트용 메타 (DRS·피트는 0 근처). */
const meta = (id: string, patch: Partial<TrackMeta> = {}): TrackMeta => ({
  id,
  laps: 10,
  pit_loss_s: 20,
  pit_entry_m: 0,
  pit_exit_m: 1,
  drs_zones: [],
  sc_rate: 0.01,
  abrasiveness: 0.5,
  bumpiness: 0.2,
  temp_mean: 20,
  temp_sd: 3,
  rain_base_prob: 0.1,
  ...patch,
});

function csv(points: readonly (readonly [number, number])[]): string {
  return [HEADER, ...points.map(([x, y]) => `${x},${y},0,6,6`)].join('\n');
}

/** 반지름 r 원 (반시계, 점 간격 ≈ step m). */
function circle(r: number, step = 3): [number, number][] {
  const n = Math.round((2 * Math.PI * r) / step);
  return Array.from({ length: n }, (_, k) => [r * Math.cos((2 * Math.PI * k) / n), r * Math.sin((2 * Math.PI * k) / n)]);
}

/** 직선 길이 L, 반원 반지름 r 스타디움 (반시계). startMidStraight면 출발선이 아래 직선 가운데. */
function stadium(L: number, r: number, startMidStraight = true, step = 3): [number, number][] {
  const pts: [number, number][] = [];
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.round(Math.hypot(x1 - x0, y1 - y0) / step);
    for (let k = 0; k < n; k++) pts.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  };
  const arc = (cx: number, cy: number, a0: number) => {
    const n = Math.round((Math.PI * r) / step);
    for (let k = 0; k < n; k++) pts.push([cx + r * Math.cos(a0 + (Math.PI * k) / n), cy + r * Math.sin(a0 + (Math.PI * k) / n)]);
  };
  const x0 = startMidStraight ? L / 2 : 0;
  line(x0, -r, L, -r);
  arc(L, 0, -Math.PI / 2);
  line(L, r, 0, r);
  arc(0, 0, Math.PI / 2);
  if (startMidStraight) line(0, -r, x0, -r);
  return pts;
}

function trackError(fn: () => unknown): TrackError {
  try {
    fn();
  } catch (e) {
    if (e instanceof TrackError) return e;
    throw e;
  }
  throw new Error('expected a TrackError');
}

describe('parseTrack geometry', () => {
  it('a circle of radius 120 m: length 2πr ± 1 m, one left corner of radius ≈ 120 m', () => {
    const t = parseTrack(csv(circle(120)), meta('circle'), regs);
    expect(Math.abs(t.length_m - 2 * Math.PI * 120)).toBeLessThan(1);
    expect(t.segments).toHaveLength(1);
    const [seg] = t.segments;
    expect(seg?.kind).toBe('corner');
    if (seg?.kind === 'corner') {
      expect(seg.radius).toBeCloseTo(120, 0);
      expect(seg.class).toBe('mid');
      expect(seg.direction).toBe('left');
    }
  });

  it('a stadium oval: two straights and two corners, straight ratio as built', () => {
    const L = 600;
    const r = 60;
    const t = parseTrack(csv(stadium(L, r)), meta('stadium'), regs);
    const expectedLength = 2 * L + 2 * Math.PI * r;
    expect(Math.abs(t.length_m - expectedLength)).toBeLessThan(1);
    expect(profile(t).straight_ratio).toBeCloseTo((2 * L) / expectedLength, 1);
    const corners = t.segments.filter((s) => s.kind === 'corner');
    expect(corners).toHaveLength(2);
    for (const c of corners) if (c.kind === 'corner') expect(c.radius / r).toBeCloseTo(1, 1);
    expect(profile(t).corners_mid).toBe(2);
  });

  it('counts a corner split by the start/finish line once', () => {
    const t = parseTrack(csv(stadium(600, 60, false)), meta('stadium-edge'), regs);
    expect(profile(t).corners_mid).toBe(2);
    expect(profile(t).corners_low + profile(t).corners_high).toBe(0);
  });

  it('resamples at ≈ resample_step_m and segment lengths add up to the lap', () => {
    for (const id of TRACK_IDS) {
      const t = tracks[id];
      expect(Math.abs(t.step_m - regs.track.resample_step_m)).toBeLessThan(0.05);
      expect(t.samples.length * t.step_m).toBeCloseTo(t.length_m, 6);
      const total = t.segments.reduce((s, seg) => s + seg.length, 0);
      expect(Math.abs(total - t.length_m)).toBeLessThan(1);
      let s0 = 0;
      for (const seg of t.segments) {
        expect(seg.s0).toBeCloseTo(s0, 6);
        s0 += seg.length;
      }
    }
  });

  it('splits an S-bend into two corners of opposite direction', () => {
    const t = tracks['fast-oval'];
    const kinds = t.segments.map((s) => (s.kind === 'corner' ? s.direction : 'S'));
    // 시케인 (오른쪽 → 왼쪽)이 첫 직선 뒤에 온다.
    expect(kinds.slice(0, 4)).toEqual(['S', 'right', 'S', 'left']);
  });

  it('marks DRS samples only inside the configured zones', () => {
    const t = tracks['fast-oval'];
    for (const sample of t.samples) {
      const inside = t.drs_zones.some((z) => sample.s >= z.from_m && sample.s < z.to_m);
      expect(sample.drs).toBe(inside);
    }
    expect(t.samples.some((s) => s.drs)).toBe(true);
  });

  it('ignores a repeated closing point and is deterministic', () => {
    const pts = circle(80);
    const first = pts[0];
    if (!first) throw new Error('no points');
    const open = parseTrack(csv(pts), meta('c'), regs);
    const closed = parseTrack(csv([...pts, first]), meta('c'), regs);
    expect(closed).toEqual(open);
    expect(parseTrack(csv(pts), meta('c'), regs)).toEqual(open);
  });
});

describe('parseTrack input validation', () => {
  it.each([
    ['bad header', 'x,y\n1,2', 'line 1'],
    ['wrong column count', `${HEADER}\n1,2,3`, 'line 2'],
    ['not a number', `${HEADER}\n1,a,0,6,6`, 'line 2'],
    ['non-positive width', `${HEADER}\n1,2,0,0,6`, 'line 2'],
  ])('rejects %s with the line number', (_name, text, path) => {
    expect(trackError(() => parseTrack(text, meta('x'), regs)).issues[0]?.path).toBe(path);
  });

  it('rejects too few points and repeated consecutive points', () => {
    expect(trackError(() => parseTrack(csv([[0, 0], [1, 0], [1, 1]]), meta('x'), regs)).message).toContain('at least 4');
    const dup = trackError(() => parseTrack(csv([[0, 0], [10, 0], [10, 0], [10, 10], [0, 10]]), meta('x'), regs));
    expect(dup.issues[0]?.path).toBe('point 2');
  });

  it('rejects DRS zones and pit positions beyond the lap', () => {
    const e = trackError(() =>
      parseTrack(csv(circle(50)), meta('x', { drs_zones: [{ from_m: 10, to_m: 5000 }], pit_entry_m: 4000 }), regs),
    );
    expect(e.issues.map((i) => i.path)).toEqual(['drs_zones[0].to_m', 'pit_entry_m']);
  });
});

describe('parseTrackMeta', () => {
  it('parses the three M1 circuits and their ids match the file names', () => {
    for (const id of TRACK_IDS) expect(parseTrackMeta(trackFiles(id).yaml).id).toBe(id);
  });

  it('rejects unknown fields and inverted DRS zones with a path', () => {
    const yaml = trackFiles('mixed').yaml;
    expect(trackError(() => parseTrackMeta(`${yaml}\nturbo: 1\n`)).issues).toEqual([
      expect.objectContaining({ path: 'turbo' }),
    ]);
    const inverted = yaml.replace('{ from_m: 3200, to_m: 3550 }', '{ from_m: 3550, to_m: 3200 }');
    expect(trackError(() => parseTrackMeta(inverted)).issues).toEqual([
      expect.objectContaining({ path: 'drs_zones[0].to_m', message: 'must be greater than from_m' }),
    ]);
  });
});

describe('profile (DESIGN.md §5, §16)', () => {
  const p = (id: (typeof TRACK_IDS)[number]) => profile(tracks[id]);

  it('every field is in range', () => {
    for (const id of TRACK_IDS) expect(TrackProfileSchema.safeParse(p(id)).success).toBe(true);
  });

  it('straight ratio: fast-oval > mixed > tight-street', () => {
    expect(p('fast-oval').straight_ratio).toBeGreaterThan(p('mixed').straight_ratio);
    expect(p('mixed').straight_ratio).toBeGreaterThan(p('tight-street').straight_ratio);
    expect(p('fast-oval').straight_ratio).toBeCloseTo(0.7, 1);
  });

  it('corner mix matches the design intent', () => {
    const fast = p('fast-oval');
    const street = p('tight-street');
    expect(fast.corners_high).toBeGreaterThan(fast.corners_low + fast.corners_mid); // 고속 코너 위주
    expect(street.corners_low).toBeGreaterThan(street.corners_mid + street.corners_high); // 저속 코너 위주
    expect(street.bumpiness).toBeGreaterThanOrEqual(regs.car.instability.bumpy_from); // 범피
    expect(p('mixed').bumpiness).toBeLessThan(regs.car.instability.bumpy_from);
  });

  it('overtaking gets harder as the longest straight shrinks', () => {
    expect(p('tight-street').overtake_difficulty).toBeGreaterThan(p('mixed').overtake_difficulty);
    expect(p('mixed').overtake_difficulty).toBeGreaterThan(p('fast-oval').overtake_difficulty);
  });

  it('counts a straight split by the start/finish line once', () => {
    const t = tracks['fast-oval'];
    const first = t.segments[0];
    const last = t.segments.at(-1);
    expect(first?.kind).toBe('straight');
    expect(last?.kind).toBe('straight');
    expect(t.longest_straight_m).toBeCloseTo((first?.length ?? 0) + (last?.length ?? 0), 6);
  });
});
