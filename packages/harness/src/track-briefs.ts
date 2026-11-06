/**
 * M2 가상 서킷 21개의 브리프 (M1의 fast-oval·mixed·tight-street와 합쳐 24개).
 * 직선 비율·코너 구성·마모도·범프·기온이 고루 퍼지도록 골랐다 (12절 체크리스트 1). 값은 전부 TODO(balance).
 * sc(랩당 세이프티카 확률)는 M4에서 출발값의 0.2배로 낮췄다 — 레이스당 SC 확률 약 15–40% (12절 지표 5: 운 비중).
 * 바꾼 뒤 `pnpm -F @f1sim/harness gen-tracks`로 data/tracks/를 다시 만든다.
 */
import type { TrackBrief } from './trackgen.js';

type Row = [
  id: string,
  straightRatio: number,
  low: number,
  mid: number,
  high: number,
  wiggle: number,
  abrasiveness: number,
  bumpiness: number,
  tempMean: number,
  tempSd: number,
  rain: number,
  scRate: number,
  pitLoss: number,
];

// prettier-ignore
const ROWS: readonly Row[] = [
  // id                 ratio   L   M   H  wiggle abr   bump  temp sd  rain  sc     pit
  ['harbour-street',    0.58,  12,  6,  2, 0.50,  0.45, 0.75, 23,  4,  0.15, 0.0060, 19],
  ['desert-sweep',      0.72,   3,  5,  8, 0.30,  0.70, 0.20, 34,  4,  0.03, 0.0020, 22],
  ['pinewood',          0.62,   5, 10,  5, 0.40,  0.50, 0.35, 18,  5,  0.35, 0.0030, 21],
  ['lakeside',          0.68,   5,  6,  6, 0.35,  0.30, 0.15, 21,  5,  0.25, 0.0024, 22],
  ['old-town',          0.56,  12,  7,  1, 0.55,  0.35, 0.85, 26,  4,  0.10, 0.0070, 18],
  ['canyon',            0.60,   6,  8,  5, 0.45,  0.80, 0.50, 30,  5,  0.05, 0.0040, 21],
  ['airfield',          0.75,   5,  3,  3, 0.30,  0.25, 0.40, 16,  6,  0.40, 0.0020, 24],
  ['highland',          0.58,   5,  8,  6, 0.45,  0.60, 0.30, 13,  5,  0.45, 0.0036, 20],
  ['coastal',           0.66,   6,  6,  5, 0.40,  0.55, 0.20, 28,  4,  0.20, 0.0030, 21],
  ['river-park',        0.64,   8,  6,  3, 0.40,  0.40, 0.45, 20,  5,  0.30, 0.0040, 20],
  ['quarry',            0.56,  10,  8,  2, 0.50,  0.90, 0.60, 27,  4,  0.10, 0.0040, 19],
  ['vineyard',          0.63,   5,  8,  6, 0.35,  0.45, 0.25, 24,  5,  0.20, 0.0024, 22],
  ['sunset-boulevard',  0.70,  10,  3,  3, 0.45,  0.30, 0.70, 31,  3,  0.05, 0.0060, 20],
  ['glacier',           0.60,   6,  6,  6, 0.40,  0.20, 0.10, 12,  4,  0.50, 0.0030, 21],
  ['oasis',             0.74,   3,  5,  6, 0.30,  0.65, 0.10, 36,  3,  0.02, 0.0016, 23],
  ['forest-ring',       0.57,   3, 10,  8, 0.40,  0.50, 0.35, 17,  5,  0.40, 0.0040, 22],
  ['marina',            0.60,  11,  5,  2, 0.50,  0.40, 0.60, 29,  3,  0.15, 0.0050, 19],
  ['plateau',           0.69,   5,  5,  8, 0.35,  0.60, 0.20, 22,  6,  0.15, 0.0024, 23],
  ['stadium-loop',      0.73,   6,  3,  3, 0.35,  0.35, 0.30, 25,  4,  0.20, 0.0030, 21],
  ['hillside',          0.55,   8, 10,  3, 0.45,  0.70, 0.55, 19,  5,  0.30, 0.0040, 20],
  ['riverside-night',   0.65,   8,  5,  5, 0.40,  0.30, 0.40, 30,  3,  0.10, 0.0040, 21],
];

const WIDTH_M = 13;

export const TRACK_BRIEFS: readonly TrackBrief[] = ROWS.map(
  ([id, straightRatio, low, mid, high, wiggle, abrasiveness, bumpiness, temp_mean, temp_sd, rain_base_prob, sc_rate, pit_loss_s]) => ({
    id,
    straightRatio,
    corners: { low, mid, high },
    wiggle,
    width_m: WIDTH_M,
    meta: { pit_loss_s, sc_rate, abrasiveness, bumpiness, temp_mean, temp_sd, rain_base_prob },
  }),
);
