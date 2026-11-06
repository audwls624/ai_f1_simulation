/**
 * 트랙 (DESIGN.md 5절): 센터라인 스플라인 → 호길이 5 m 재샘플링 → 곡률 → 세그먼트 → 프로파일.
 *
 * 원본은 센터라인 점열 하나다. 랩타임 모델이 쓰는 세그먼트와 렌더러가 그릴 샘플이 같은 스플라인에서 나온다.
 * 스플라인은 닫힌 centripetal Catmull–Rom (제어점을 지나고, 점 간격이 고르지 않아도 꼬이지 않는다).
 */
import { z } from 'zod';
import { formatIssue, toIssues, yamlToJs, type Regulations, type ValidationIssue } from './regulations.js';

// ── 메타 (tracks/<id>.yaml) ─────────────────────────────────────────────

const fraction = z.number().min(0).max(1);

/** 5절 원본 데이터의 yaml 쪽: 랩 수, 피트, DRS 구간, 세이프티카, 마모도, 범프, 기온, 강우. */
export const TrackMetaSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    laps: z.int().min(1),
    pit_loss_s: z.number().positive(),
    /** 레이스 거리상 위치 (m, 출발선 기준). 계산에는 손실 시간만 쓰고 위치는 렌더러·로그용. */
    pit_entry_m: z.number().min(0),
    pit_exit_m: z.number().min(0),
    /** DRS 구간 [from_m, to_m). 그 안의 직선에서 드래그 × (1 − drs_gain). 출발선을 넘어가는 구간은 둘로 나눈다. */
    drs_zones: z.array(z.strictObject({ from_m: z.number().min(0), to_m: z.number().positive() })),
    sc_rate: fraction,
    abrasiveness: fraction,
    bumpiness: fraction,
    temp_mean: z.number(),
    temp_sd: z.number().min(0),
    rain_base_prob: fraction,
  })
  .superRefine((m, ctx) => {
    m.drs_zones.forEach((zone, i) => {
      if (zone.to_m <= zone.from_m) {
        ctx.addIssue({ code: 'custom', path: ['drs_zones', i, 'to_m'], message: 'must be greater than from_m' });
      }
    });
  });
export type TrackMeta = z.infer<typeof TrackMetaSchema>;

export class TrackError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(what: string, issues: readonly ValidationIssue[]) {
    super(`invalid track ${what}:\n${issues.map((i) => `  - ${formatIssue(i)}`).join('\n')}`);
    this.name = 'TrackError';
    this.issues = issues;
  }
}

/** tracks/<id>.yaml 텍스트 → 검증된 TrackMeta. 잘못되면 TrackError. */
export function parseTrackMeta(yamlText: string): TrackMeta {
  const raw = yamlToJs(yamlText);
  if (!raw.ok) throw new TrackError('meta', raw.issues);
  const parsed = TrackMetaSchema.safeParse(raw.value, { reportInput: true });
  if (!parsed.success) throw new TrackError('meta', toIssues(parsed.error.issues, TrackMetaSchema));
  return parsed.data;
}

// ── 트랙 구조 ──────────────────────────────────────────────────────────

export type CornerClass = 'low' | 'mid' | 'high';

export interface StraightSegment {
  readonly kind: 'straight';
  /** 시작 거리 (m, 출발선 기준). 로그의 거리 샘플과 매핑한다 (5절). */
  readonly s0: number;
  readonly length: number;
}

export interface CornerSegment {
  readonly kind: 'corner';
  readonly s0: number;
  readonly length: number;
  /** 1 / 평균 곡률 (m). */
  readonly radius: number;
  readonly class: CornerClass;
  readonly direction: 'left' | 'right';
}

export type Segment = StraightSegment | CornerSegment;

/** 재샘플링된 센터라인 한 점. 샘플 i는 [s, s + step_m) 구간을 대표한다. */
export interface TrackSample {
  readonly s: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w_left: number;
  readonly w_right: number;
  /** 부호 있는 곡률 1/m (왼쪽 +). */
  readonly curvature: number;
  /** segments 배열의 인덱스. */
  readonly segment: number;
  /** DRS 구간 안인가 (직선에서만 효과가 있다). */
  readonly drs: boolean;
}

/**
 * 파싱된 트랙. 메타 필드를 그대로 갖고(derive가 bumpiness·temp_mean을 읽는다) 기하 정보를 더한다.
 * segments는 출발선(s = 0)에서 시작한다. 출발선이 직선 중간에 있으면 그 직선은 처음과 끝 두 조각이 된다.
 */
export interface Track extends TrackMeta {
  readonly length_m: number;
  /** 실제 샘플 간격 = length_m / samples.length (≈ regulations.track.resample_step_m). */
  readonly step_m: number;
  readonly samples: readonly TrackSample[];
  readonly segments: readonly Segment[];
  /** 출발선에서 나뉜 조각을 이어 붙인 가장 긴 직선 (m). */
  readonly longest_straight_m: number;
  /** 0–1, 추월 확률 식의 입력 (7절). 최장 직선이 짧을수록 어렵다. */
  readonly overtake_difficulty: number;
}

// ── 센터라인 CSV ───────────────────────────────────────────────────────

const CSV_COLUMNS = ['x_m', 'y_m', 'z_m', 'w_left_m', 'w_right_m'] as const;
/** 스플라인 구간을 호길이 계산용으로 나누는 수 (수치 해상도, 게임 수치 아님). */
const SPLINE_SUBDIVISIONS = 8;
const M_PER_KM = 1000;
/** 닫힌 곡선으로 볼 최소 제어점 수. */
const MIN_POINTS = 4;
/** 첫 점과 같다고 보는 마지막 점의 거리 (m). 닫힘 표시로 반복된 점을 지운다. */
const CLOSING_POINT_TOLERANCE_M = 1e-6;

interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly wl: number;
  readonly wr: number;
}

function parseCenterline(csv: string): Point[] {
  const issues: ValidationIssue[] = [];
  const points: Point[] = [];
  let headerSeen = false;
  csv.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const where = `line ${index + 1}`;
    if (line === '' || line.startsWith('#')) return;
    const cells = line.split(',').map((c) => c.trim());
    if (!headerSeen) {
      headerSeen = true;
      if (cells.join(',') !== CSV_COLUMNS.join(',')) {
        issues.push({ path: where, message: `header must be "${CSV_COLUMNS.join(',')}" (got "${line}")` });
      }
      return;
    }
    if (cells.length !== CSV_COLUMNS.length) {
      issues.push({ path: where, message: `expected ${CSV_COLUMNS.length} numbers, got ${cells.length}` });
      return;
    }
    const v = cells.map((c) => (c === '' ? Number.NaN : Number(c)));
    if (!v.every(Number.isFinite)) {
      issues.push({ path: where, message: `every column must be a finite number (got "${line}")` });
      return;
    }
    const [x = 0, y = 0, zc = 0, wl = 0, wr = 0] = v;
    if (wl <= 0 || wr <= 0) issues.push({ path: where, message: 'track widths must be positive' });
    points.push({ x, y, z: zc, wl, wr });
  });
  if (!headerSeen) issues.push({ path: '', message: 'centerline CSV is empty' });
  const first = points[0];
  const last = points.at(-1);
  if (first && last && points.length > 1 && dist(first, last) < CLOSING_POINT_TOLERANCE_M) points.pop();
  if (issues.length === 0 && points.length < MIN_POINTS) {
    issues.push({ path: '', message: `a closed centerline needs at least ${MIN_POINTS} points (got ${points.length})` });
  }
  points.forEach((p, i) => {
    const next = points[(i + 1) % points.length];
    if (next && points.length > 1 && dist(p, next) === 0) {
      issues.push({ path: `point ${i + 1}`, message: 'repeats the next point; consecutive points must differ' });
    }
  });
  if (issues.length > 0) throw new TrackError('centerline', issues);
  return points;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

// ── 스플라인 → 재샘플링 ────────────────────────────────────────────────

/** 닫힌 centripetal Catmull–Rom 위의 점 (Barry–Goldman). t ∈ [0, 1] 은 p1 → p2 구간. */
function catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t1 = Math.sqrt(dist(p0, p1));
  const t2 = t1 + Math.sqrt(dist(p1, p2));
  const t3 = t2 + Math.sqrt(dist(p2, p3));
  const u = t1 + (t2 - t1) * t;
  const mix = (a: Point, b: Point, ta: number, tb: number): Point => {
    const wa = (tb - u) / (tb - ta);
    const wb = (u - ta) / (tb - ta);
    return {
      x: wa * a.x + wb * b.x,
      y: wa * a.y + wb * b.y,
      z: wa * a.z + wb * b.z,
      wl: wa * a.wl + wb * b.wl,
      wr: wa * a.wr + wb * b.wr,
    };
  };
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, 0, t2);
  const b2 = mix(a2, a3, t1, t3);
  const c = mix(b1, b2, t1, t2);
  // 폭은 위치처럼 휘지 않게 p1 → p2 선형으로.
  return { x: c.x, y: c.y, z: c.z, wl: p1.wl + (p2.wl - p1.wl) * t, wr: p1.wr + (p2.wr - p1.wr) * t };
}

/** 스플라인을 촘촘히 샘플링한 닫힌 폴리라인과 누적 호길이. 마지막 원소는 첫 점(닫힘). */
function densify(points: readonly Point[]): { pts: Point[]; cum: number[] } {
  const n = points.length;
  const at = (i: number): Point => points[((i % n) + n) % n] as Point;
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < SPLINE_SUBDIVISIONS; j++) {
      pts.push(catmullRom(at(i - 1), at(i), at(i + 1), at(i + 2), j / SPLINE_SUBDIVISIONS));
    }
  }
  pts.push(pts[0] as Point);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] ?? 0) + dist(pts[i - 1] as Point, pts[i] as Point));
  return { pts, cum };
}

/** 같은 호길이 간격 count개로 다시 뽑는다 (첫 샘플 = 출발선). */
function resample(pts: readonly Point[], cum: readonly number[], count: number, length: number): Point[] {
  const out: Point[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const s = (length * k) / count;
    while (j < cum.length - 2 && (cum[j + 1] ?? Infinity) < s) j++;
    const a = pts[j] as Point;
    const b = pts[j + 1] as Point;
    const span = (cum[j + 1] ?? 0) - (cum[j] ?? 0);
    const f = span > 0 ? (s - (cum[j] ?? 0)) / span : 0;
    out.push({
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      wl: a.wl + (b.wl - a.wl) * f,
      wr: a.wr + (b.wr - a.wr) * f,
    });
  }
  return out;
}

/** 세 점의 부호 있는 Menger 곡률 (xy 평면, 왼쪽으로 휘면 +). */
function signedCurvature(a: Point, b: Point, c: Point): number {
  const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  const d = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y) * Math.hypot(c.x - a.x, c.y - a.y);
  return d === 0 ? 0 : (2 * cross) / d;
}

function cornerClass(radius: number, c: Regulations['track']['corner_classes']): CornerClass {
  if (radius < c.low_max_radius_m) return 'low';
  return radius <= c.mid_max_radius_m ? 'mid' : 'high';
}

/** 출발선에서 나뉜 처음·끝 조각이 같은 종류면 하나로 본 세그먼트 목록 (통계용). */
function wrappedSegments(segments: readonly Segment[]): Segment[] {
  const first = segments[0];
  const last = segments.at(-1);
  if (!first || !last || segments.length < 2) return [...segments];
  const same =
    first.kind === last.kind && (first.kind === 'straight' || (last.kind === 'corner' && first.direction === last.direction));
  if (!same) return [...segments];
  const merged: Segment =
    first.kind === 'straight'
      ? { kind: 'straight', s0: last.s0, length: last.length + first.length }
      : {
          ...first,
          s0: last.s0,
          length: last.length + first.length,
          radius: (last.length + first.length) / (last.length / (last as CornerSegment).radius + first.length / first.radius),
        };
  return [merged, ...segments.slice(1, -1)];
}

/**
 * 센터라인 CSV + 메타 → Track (5절 세그먼트 파생).
 * 1) 닫힌 스플라인을 호길이 기준으로 재샘플링 (resample_step_m)  2) 샘플마다 곡률
 * 3) |곡률| < straight_max_curvature면 직선, 아니면 코너. 같은 방향의 연속된 코너 샘플을 하나로 합치고
 *    반경 = 1 / 평균 곡률. 방향이 바뀌면(시케인) 별개의 코너로 나눈다.
 */
export function parseTrack(centerlineCsv: string, meta: TrackMeta, regs: Regulations): Track {
  const checked = TrackMetaSchema.safeParse(meta, { reportInput: true });
  if (!checked.success) throw new TrackError('meta', toIssues(checked.error.issues, TrackMetaSchema));
  const points = parseCenterline(centerlineCsv);
  const rules = regs.track;

  const { pts, cum } = densify(points);
  const length = cum.at(-1) ?? 0;
  const count = Math.max(MIN_POINTS, Math.round(length / rules.resample_step_m));
  const step = length / count;
  const grid = resample(pts, cum, count, length);
  const curvature = grid.map((p, i) => signedCurvature(grid[(i - 1 + count) % count] as Point, p, grid[(i + 1) % count] as Point));

  // 런 → 세그먼트
  const segments: Segment[] = [];
  const segmentOf: number[] = [];
  let i = 0;
  while (i < count) {
    const k0 = curvature[i] ?? 0;
    const isCorner = Math.abs(k0) >= rules.straight_max_curvature;
    const sign = Math.sign(k0);
    let j = i;
    let sumAbs = 0;
    while (j < count) {
      const k = curvature[j] ?? 0;
      const corner = Math.abs(k) >= rules.straight_max_curvature;
      if (corner !== isCorner || (corner && Math.sign(k) !== sign)) break;
      sumAbs += Math.abs(k);
      j++;
    }
    const n = j - i;
    const index = segments.length;
    for (let k = i; k < j; k++) segmentOf.push(index);
    if (isCorner) {
      const radius = n / sumAbs;
      segments.push({
        kind: 'corner',
        s0: i * step,
        length: n * step,
        radius,
        class: cornerClass(radius, rules.corner_classes),
        direction: sign > 0 ? 'left' : 'right',
      });
    } else {
      segments.push({ kind: 'straight', s0: i * step, length: n * step });
    }
    i = j;
  }

  const issues: ValidationIssue[] = [];
  checked.data.drs_zones.forEach((zone, k) => {
    if (zone.to_m > length) {
      issues.push({ path: `drs_zones[${k}].to_m`, message: `must be within the lap length ${length.toFixed(1)} m` });
    }
  });
  for (const key of ['pit_entry_m', 'pit_exit_m'] as const) {
    if (checked.data[key] >= length) {
      issues.push({ path: key, message: `must be within the lap length ${length.toFixed(1)} m` });
    }
  }
  if (issues.length > 0) throw new TrackError(checked.data.id, issues);

  const samples: TrackSample[] = grid.map((p, k) => {
    const s = k * step;
    return {
      s,
      x: p.x,
      y: p.y,
      z: p.z,
      w_left: p.wl,
      w_right: p.wr,
      curvature: curvature[k] ?? 0,
      segment: segmentOf[k] ?? 0,
      drs: checked.data.drs_zones.some((zone) => s >= zone.from_m && s < zone.to_m),
    };
  });

  let longest = 0;
  for (const seg of wrappedSegments(segments)) if (seg.kind === 'straight') longest = Math.max(longest, seg.length);

  return {
    ...checked.data,
    length_m: length,
    step_m: step,
    samples,
    segments,
    longest_straight_m: longest,
    overtake_difficulty: Math.min(1, Math.max(0, 1 - longest / rules.overtake_reference_straight_m)),
  };
}

// ── 프로파일 (에이전트 공개용, 5절 표) ─────────────────────────────────

export const TrackProfileSchema = z.strictObject({
  length_km: z.number().positive(),
  laps: z.int().min(1),
  straight_ratio: fraction,
  corners_low: z.int().min(0),
  corners_mid: z.int().min(0),
  corners_high: z.int().min(0),
  overtake_difficulty: fraction,
  abrasiveness: fraction,
  bumpiness: fraction,
  temp_mean: z.number(),
  temp_sd: z.number().min(0),
  sc_rate: fraction,
  pit_loss_s: z.number().positive(),
  rain_base_prob: fraction,
});
export type TrackProfile = z.infer<typeof TrackProfileSchema>;

/** 5절 프로파일. 엔진이 쓰는 세그먼트에서 계산한다 (세그먼트 원본은 에이전트에게 주지 않는다). */
export function profile(track: Track): TrackProfile {
  let straight = 0;
  const corners = { low: 0, mid: 0, high: 0 };
  for (const seg of wrappedSegments(track.segments)) {
    if (seg.kind === 'straight') straight += seg.length;
    else corners[seg.class] += 1;
  }
  return {
    length_km: track.length_m / M_PER_KM,
    laps: track.laps,
    straight_ratio: straight / track.length_m,
    corners_low: corners.low,
    corners_mid: corners.mid,
    corners_high: corners.high,
    overtake_difficulty: track.overtake_difficulty,
    abrasiveness: track.abrasiveness,
    bumpiness: track.bumpiness,
    temp_mean: track.temp_mean,
    temp_sd: track.temp_sd,
    sc_rate: track.sc_rate,
    pit_loss_s: track.pit_loss_s,
    rain_base_prob: track.rain_base_prob,
  };
}
