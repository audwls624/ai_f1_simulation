/**
 * 가상 서킷 생성기 (DESIGN.md 14절: 데이터셋 라이선스 확인 전까지 "가상 서킷 24개를 프로파일 조합으로 생성").
 *
 * 별 모양 다각형(각도순 꼭짓점 → 항상 단순 다각형)의 꼭짓점을 코너 등급별 반경의 원호로 둥글린다.
 * 원호 반경은 브리프의 코너 구성에서, 다각형 크기는 목표 직선 비율에 맞게 이분 탐색으로 정한다.
 * 같은 브리프 + 같은 시드 = 같은 서킷 (core rng).
 */
import { makeRng, type Regulations, type Rng, type TrackMeta } from '@f1sim/core';

export interface TrackBrief {
  readonly id: string;
  /** 목표 직선 비율 (생성기 기준. parseTrack 프로파일과 ±0.03 정도 차이 난다). */
  readonly straightRatio: number;
  /** 코너 수 (꼭짓점 수 = 합). */
  readonly corners: { readonly low: number; readonly mid: number; readonly high: number };
  /** 꼭짓점 반지름의 흔들림 0–0.5. 클수록 오목한 꼭짓점(우회전, 시케인)이 많다. */
  readonly wiggle: number;
  readonly width_m: number;
  readonly meta: Pick<
    TrackMeta,
    'pit_loss_s' | 'sc_rate' | 'abrasiveness' | 'bumpiness' | 'temp_mean' | 'temp_sd' | 'rain_base_prob'
  >;
}

export interface Layout {
  /** 닫힌 센터라인 점열 (마지막 점 ≠ 첫 점). 첫 점 = 출발선 (가장 긴 직선의 가운데). */
  readonly points: readonly (readonly [number, number])[];
  readonly length_m: number;
  readonly straightRatio: number;
  /** 경로상 직선 구간 [from_m, to_m) (출발선 기준). 첫·마지막 조각은 출발선에서 나뉜 같은 직선. */
  readonly straights: readonly { readonly from_m: number; readonly to_m: number }[];
  readonly seed: number;
}

// 생성기 설정 (도구 설정이지 규정이 아니다).
const POINT_STEP_M = 3;
const MIN_STRAIGHT_M = 25;
const MAX_TURN_RAD = (160 * Math.PI) / 180;
const MIN_LENGTH_M = 2800;
const MAX_LENGTH_M = 6500;
const RATIO_TOLERANCE = 0.01;
const SCALE_RANGE_M: readonly [number, number] = [150, 4000];
const ANGLE_JITTER = 0.35;
const SCALE_SEARCH_GROWTH = 1.05;
const BISECTION_STEPS = 50;
const MAX_ATTEMPTS = 2000;
const SMALLEST_RADIUS_M = 14;
/** 레이스 거리 목표 (km). 랩 수 = round(이 값 / 랩 길이). */
const RACE_DISTANCE_KM = 300;
const DRS_MIN_STRAIGHT_M = 350;
const DRS_ENTRY_MARGIN_M = 40;
const DRS_EXIT_MARGIN_M = 30;

type CornerClass = 'low' | 'mid' | 'high';

/** 코너 등급별 원호 반경 범위. 규정의 등급 경계(regulations.track.corner_classes) 안쪽에 둔다. */
function radiusRanges(regs: Regulations): Record<CornerClass, readonly [number, number]> {
  const { low_max_radius_m: low, mid_max_radius_m: mid } = regs.track.corner_classes;
  return {
    low: [SMALLEST_RADIUS_M, low * 0.9],
    mid: [low * 1.15, mid * 0.9],
    high: [mid * 1.12, mid * 2.1],
  };
}

interface Vertex {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

interface Corner {
  readonly v: Vertex;
  readonly phi: number;
  readonly t: number;
  readonly din: readonly [number, number];
  readonly tin: readonly [number, number];
  readonly tout: readonly [number, number];
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

function corners(verts: readonly Vertex[]): Corner[] | null {
  const n = verts.length;
  const out: Corner[] = [];
  for (let i = 0; i < n; i++) {
    const v = verts[i] as Vertex;
    const p = verts[(i - 1 + n) % n] as Vertex;
    const q = verts[(i + 1) % n] as Vertex;
    const lin = Math.hypot(v.x - p.x, v.y - p.y);
    const lout = Math.hypot(q.x - v.x, q.y - v.y);
    const din = [(v.x - p.x) / lin, (v.y - p.y) / lin] as const;
    const dout = [(q.x - v.x) / lout, (q.y - v.y) / lout] as const;
    const phi = Math.atan2(din[0] * dout[1] - din[1] * dout[0], din[0] * dout[0] + din[1] * dout[1]);
    if (Math.abs(phi) > MAX_TURN_RAD) return null;
    const t = v.r * Math.tan(Math.abs(phi) / 2);
    out.push({ v, phi, t, din, tin: [v.x - din[0] * t, v.y - din[1] * t], tout: [v.x + dout[0] * t, v.y + dout[1] * t] });
  }
  return out;
}

/** 직선 길이 목록 (꼭짓점 i → i+1). 필렛이 들어가지 않으면 null. */
function straightLengths(cs: readonly Corner[]): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i] as Corner;
    const b = cs[(i + 1) % cs.length] as Corner;
    const s = Math.hypot(b.v.x - a.v.x, b.v.y - a.v.y) - a.t - b.t;
    if (s < MIN_STRAIGHT_M) return null;
    out.push(s);
  }
  return out;
}

function ratioOf(cs: readonly Corner[], straights: readonly number[]): number {
  const s = straights.reduce((x, y) => x + y, 0);
  const arcs = cs.reduce((x, c) => x + Math.abs(c.phi) * c.v.r, 0);
  return s / (s + arcs);
}

function crosses(points: readonly (readonly [number, number])[]): boolean {
  const n = points.length;
  const cr = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
    ((a[0] ?? 0) - (o[0] ?? 0)) * ((b[1] ?? 0) - (o[1] ?? 0)) - ((a[1] ?? 0) - (o[1] ?? 0)) * ((b[0] ?? 0) - (o[0] ?? 0));
  for (let i = 0; i < n; i++) {
    const p1 = points[i] as readonly [number, number];
    const p2 = points[(i + 1) % n] as readonly [number, number];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const p3 = points[j] as readonly [number, number];
      const p4 = points[(j + 1) % n] as readonly [number, number];
      if (cr(p1, p2, p3) * cr(p1, p2, p4) < 0 && cr(p3, p4, p1) * cr(p3, p4, p2) < 0) return true;
    }
  }
  return false;
}

/** 가장 긴 직선의 가운데에서 출발해 한 바퀴 점을 찍는다. */
function trace(cs: readonly Corner[], straights: readonly number[]): Omit<Layout, 'seed'> {
  const n = cs.length;
  let k = 0;
  for (let i = 1; i < n; i++) if ((straights[i] ?? 0) > (straights[k] ?? 0)) k = i;
  const a = cs[k] as Corner;
  const b = cs[(k + 1) % n] as Corner;
  const start: [number, number] = [(a.tout[0] + b.tin[0]) / 2, (a.tout[1] + b.tin[1]) / 2];
  const points: [number, number][] = [start];
  const segs: { from_m: number; to_m: number }[] = [];
  let s = 0;
  let straightTotal = 0;
  const line = (to: readonly [number, number]) => {
    const from = points.at(-1) as [number, number];
    const L = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const m = Math.max(1, Math.round(L / POINT_STEP_M));
    for (let j = 1; j <= m; j++) points.push([from[0] + ((to[0] - from[0]) * j) / m, from[1] + ((to[1] - from[1]) * j) / m]);
    segs.push({ from_m: s, to_m: s + L });
    s += L;
    straightTotal += L;
  };
  const arc = (c: Corner) => {
    const sg = Math.sign(c.phi);
    const cx = c.tin[0] - c.din[1] * c.v.r * sg;
    const cy = c.tin[1] + c.din[0] * c.v.r * sg;
    const a0 = Math.atan2(c.tin[1] - cy, c.tin[0] - cx);
    const m = Math.max(2, Math.round((Math.abs(c.phi) * c.v.r) / POINT_STEP_M));
    for (let j = 1; j <= m; j++) {
      const ang = a0 + (c.phi * j) / m;
      points.push([cx + Math.cos(ang) * c.v.r, cy + Math.sin(ang) * c.v.r]);
    }
    s += Math.abs(c.phi) * c.v.r;
  };
  for (let j = 1; j <= n; j++) {
    const c = cs[(k + j) % n] as Corner;
    line(c.tin);
    arc(c);
  }
  line(start);
  points.pop(); // 마지막 점 = 출발점
  return { points, length_m: s, straightRatio: straightTotal / s, straights: segs };
}

/** 브리프마다 떨어진 시드 공간 (브리프 순서가 바뀌어도 각 서킷은 그대로). gen-tracks가 쓰는 시드. */
export function seedFor(id: string): number {
  const SEED_STRIDE = 100_000;
  const SEED_BUCKETS = 10_007;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % SEED_BUCKETS;
  return h * SEED_STRIDE;
}

/** 브리프에 맞는 레이아웃을 찾는다 (시드를 바꿔 가며). 못 찾으면 throw. */
export function generateLayout(brief: TrackBrief, regs: Regulations, baseSeed: number): Layout {
  const ranges = radiusRanges(regs);
  const classes: CornerClass[] = [
    ...Array<CornerClass>(brief.corners.low).fill('low'),
    ...Array<CornerClass>(brief.corners.mid).fill('mid'),
    ...Array<CornerClass>(brief.corners.high).fill('high'),
  ];
  const n = classes.length;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = baseSeed + attempt;
    const rng = makeRng(seed);
    const order = shuffle(classes, rng);
    const angles = order.map((_, i) => ((i + (rng.next() * 2 - 1) * ANGLE_JITTER) * 2 * Math.PI) / n);
    const radial = order.map(() => 1 + brief.wiggle * (rng.next() * 2 - 1));
    const fillet = order.map((c) => {
      const [lo, hi] = ranges[c];
      return lo + (hi - lo) * rng.next();
    });
    const build = (scale: number) => {
      const verts = angles.map((a, i) => ({
        x: scale * (radial[i] ?? 1) * Math.cos(a),
        y: scale * (radial[i] ?? 1) * Math.sin(a),
        r: fillet[i] ?? SMALLEST_RADIUS_M,
      }));
      const cs = corners(verts);
      const st = cs && straightLengths(cs);
      return cs && st ? { cs, st, ratio: ratioOf(cs, st) } : null;
    };
    // 크기가 커지면 필렛이 들어갈 자리가 늘고(가능 여부 단조), 직선 비율도 커진다(원호 길이는 고정).
    let lo = SCALE_RANGE_M[0];
    while (lo < SCALE_RANGE_M[1] && !build(lo)) lo *= SCALE_SEARCH_GROWTH;
    const atLo = build(lo);
    const atHi = build(SCALE_RANGE_M[1]);
    if (!atLo || !atHi || brief.straightRatio < atLo.ratio - RATIO_TOLERANCE || brief.straightRatio > atHi.ratio) continue;
    let a = lo;
    let b = SCALE_RANGE_M[1];
    for (let it = 0; it < BISECTION_STEPS; it++) {
      const mid = (a + b) / 2;
      if ((build(mid)?.ratio ?? 0) < brief.straightRatio) a = mid;
      else b = mid;
    }
    const best = build(b);
    if (!best || Math.abs(best.ratio - brief.straightRatio) > RATIO_TOLERANCE) continue;
    const layout = trace(best.cs, best.st);
    if (layout.length_m < MIN_LENGTH_M || layout.length_m > MAX_LENGTH_M) continue;
    if (crosses(layout.points)) continue;
    return { ...layout, seed };
  }
  throw new Error(`${brief.id}: no layout found in ${MAX_ATTEMPTS} attempts`);
}

/** 레이아웃 + 브리프 → 트랙 메타 (랩 수, DRS, 피트 위치 계산). */
export function metaFor(brief: TrackBrief, layout: Layout): TrackMeta {
  const L = layout.length_m;
  const first = layout.straights[0];
  const last = layout.straights.at(-1);
  if (!first || !last) throw new Error(`${brief.id}: layout has no straights`);
  const drs: { from_m: number; to_m: number }[] = [
    { from_m: 0, to_m: Math.floor(first.to_m - DRS_EXIT_MARGIN_M) },
    { from_m: Math.ceil(last.from_m + DRS_ENTRY_MARGIN_M), to_m: Math.floor(L - 1) },
  ];
  // 메인 직선 말고 가장 긴 직선 하나에 DRS를 더 준다 (충분히 길면).
  const inner = layout.straights.slice(1, -1).reduce<{ from_m: number; to_m: number } | null>(
    (best, s) => (!best || s.to_m - s.from_m > best.to_m - best.from_m ? s : best),
    null,
  );
  if (inner && inner.to_m - inner.from_m >= DRS_MIN_STRAIGHT_M) {
    drs.push({ from_m: Math.ceil(inner.from_m + DRS_ENTRY_MARGIN_M), to_m: Math.floor(inner.to_m - DRS_EXIT_MARGIN_M) });
  }
  return {
    id: brief.id,
    laps: Math.max(1, Math.round(RACE_DISTANCE_KM / (L / 1000))),
    pit_loss_s: brief.meta.pit_loss_s,
    pit_entry_m: Math.floor(last.from_m + (L - last.from_m) / 2),
    pit_exit_m: Math.floor(first.to_m / 2),
    drs_zones: drs.filter((z) => z.to_m > z.from_m),
    sc_rate: brief.meta.sc_rate,
    abrasiveness: brief.meta.abrasiveness,
    bumpiness: brief.meta.bumpiness,
    temp_mean: brief.meta.temp_mean,
    temp_sd: brief.meta.temp_sd,
    rain_base_prob: brief.meta.rain_base_prob,
  };
}

export function centerlineCsv(brief: TrackBrief, layout: Layout): string {
  const half = (brief.width_m / 2).toFixed(1);
  return [
    `# ${brief.id}: generated by @f1sim/harness gen-tracks (seed ${layout.seed}). Edit the brief, not this file.`,
    '# First row = start/finish line; row order = driving direction.',
    'x_m,y_m,z_m,w_left_m,w_right_m',
    ...layout.points.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)},0.000,${half},${half}`),
    '',
  ].join('\n');
}

export function metaYaml(brief: TrackBrief, meta: TrackMeta): string {
  const zones = meta.drs_zones.map((z) => `  - { from_m: ${z.from_m}, to_m: ${z.to_m} }`).join('\n');
  return [
    `# ${brief.id} — 가상 서킷 (generated by @f1sim/harness gen-tracks; 브리프는 harness/src/track-briefs.ts).`,
    '# 마모도·범프·기온·강우·세이프티카는 브리프 값, 랩 수·DRS·피트 위치는 레이아웃에서 계산. 전부 TODO(balance).',
    `id: ${meta.id}`,
    `laps: ${meta.laps}`,
    `pit_loss_s: ${meta.pit_loss_s}`,
    `pit_entry_m: ${meta.pit_entry_m}`,
    `pit_exit_m: ${meta.pit_exit_m}`,
    'drs_zones:',
    zones,
    `sc_rate: ${meta.sc_rate}`,
    `abrasiveness: ${meta.abrasiveness}`,
    `bumpiness: ${meta.bumpiness}`,
    `temp_mean: ${meta.temp_mean}`,
    `temp_sd: ${meta.temp_sd}`,
    `rain_base_prob: ${meta.rain_base_prob}`,
    '',
  ].join('\n');
}
