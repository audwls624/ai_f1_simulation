/**
 * 설계 탐색 리포트 (12절: 결과는 harness/reports/<date>.md).
 */
import { SPEC_PARAMS, cost, profile, type CarSpec, type Regulations } from '@f1sim/core';
import { architectureWins, designMatrix, maxWinShare, varianceContributions, winners } from './design.js';
import type { DesignRun } from './explore.js';

/** 12절 지표 1–3의 통과 기준. */
export const DESIGN_CRITERIA = {
  /** 지표 1: 한 스펙이 최속인 트랙 비율의 최댓값 < 35%. */
  maxWinShare: 0.35,
  /** 지표 2: 한 파라미터가 시즌 랩타임 분산의 50% 이상을 설명하면 안 된다. */
  maxVarianceShare: 0.5,
  /** 지표 3: floor/wing, short/long 각각이 최속인 트랙 ≥ 6. */
  minArchitectureTracks: 6,
} as const;

export interface DesignMetrics {
  readonly metric1: { share: number; spec: number; tracks: number; pass: boolean };
  readonly metric2: { r2: number; top: { name: string; share: number }; pass: boolean; contributions: ReturnType<typeof varianceContributions>['contributions'] };
  readonly metric3: { floor: number; wing: number; short: number; long: number; pass: boolean };
  readonly winners: readonly number[];
}

export function designMetrics(run: DesignRun): DesignMetrics {
  const laps = run.results.map((row) => row.map((r) => r.lap));
  const w = winners(laps, run.tracks.length);
  const m1 = maxWinShare(w);
  const { X, names } = designMatrix(run.specs);
  const m2 = varianceContributions(X, run.seasonTimes, names);
  const top = m2.contributions.reduce((a, b) => (b.share > a.share ? b : a));
  const arch = architectureWins(run.specs, w);
  const min = DESIGN_CRITERIA.minArchitectureTracks;
  return {
    metric1: { ...m1, pass: m1.share < DESIGN_CRITERIA.maxWinShare },
    metric2: { r2: m2.r2, top: { name: top.name, share: top.share }, pass: top.share < DESIGN_CRITERIA.maxVarianceShare, contributions: m2.contributions },
    metric3: { ...arch, pass: arch.floor >= min && arch.wing >= min && arch.short >= min && arch.long >= min },
    winners: w,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ok = (b: boolean) => (b ? '통과' : '**실패**');

function specLine(spec: CarSpec, regs: Regulations): string {
  const v = SPEC_PARAMS.map((p) => `${p.key.replace(/_/g, ' ')} ${p.get(spec).toFixed(2)}`).join(', ');
  return `${spec.aero.philosophy}/${spec.chassis.wheelbase} · ${cost(spec, regs).toFixed(1)} cr · ${v}`;
}

export interface ExtraSection {
  readonly title: string;
  readonly body: string;
}

export function designReport(run: DesignRun, regs: Regulations, date: string, extra: readonly ExtraSection[] = []): string {
  const m = designMetrics(run);
  const o = run.options;
  const lines: string[] = [];
  lines.push(`# 설계 공간 탐색 — ${date}`, '');
  lines.push(
    `규정 ${regs.season} · 캘린더 ${run.tracks.length}전 · 스펙 ${run.specs.length}개 (${o.sampling}, seed ${o.seed}) · ` +
      '스펙×트랙마다 최적 셋업(윙 0–10 × 지상고 × ERS 모드), 건조 baseLap.',
    '',
  );
  lines.push('## 지표 (DESIGN.md 12절)', '', '| 지표 | 값 | 기준 | 결과 |', '| --- | --- | --- | --- |');
  lines.push(`| 1. 최속 스펙 집중도 | 스펙 #${m.metric1.spec}이 ${m.metric1.tracks}/${run.tracks.length} 트랙 (${pct(m.metric1.share)}) | < ${pct(DESIGN_CRITERIA.maxWinShare)} | ${ok(m.metric1.pass)} |`);
  lines.push(`| 2. 파라미터 기여도 | 최대 ${m.metric2.top.name} ${pct(m.metric2.top.share)} (R² ${m.metric2.r2.toFixed(3)}) | < ${pct(DESIGN_CRITERIA.maxVarianceShare)} | ${ok(m.metric2.pass)} |`);
  lines.push(`| 3. 아키텍처 균형 | floor ${m.metric3.floor} / wing ${m.metric3.wing}, short ${m.metric3.short} / long ${m.metric3.long} | 각 ≥ ${DESIGN_CRITERIA.minArchitectureTracks} | ${ok(m.metric3.pass)} |`);
  lines.push('');

  lines.push('## 지표 2: 시즌 랩타임 분산 분해', '', 'Pratt 분해 (표준화 회귀계수 × 상관계수, 합 = R²). β < 0이면 값이 클수록 빠르다.', '');
  lines.push('| 변수 | 설명 분산 | 단변량 R² | β |', '| --- | --- | --- | --- |');
  for (const c of [...m.metric2.contributions].sort((a, b) => b.share - a.share || a.name.localeCompare(b.name))) {
    lines.push(`| ${c.name} | ${pct(c.share)} | ${c.r2.toFixed(3)} | ${c.beta.toFixed(3)} |`);
  }
  lines.push('');

  lines.push('## 트랙별 최속 스펙', '', '| GP | 트랙 | 길이 | 직선 비율 | 코너 L/M/H | 범프 | 최속 스펙 | 랩 | 셋업 (윙/지상고/ERS) | 중앙값 랩 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  run.tracks.forEach((track, t) => {
    const p = profile(track);
    const wi = m.winners[t] ?? 0;
    const best = run.results[wi]?.[t];
    const spec = run.specs[wi];
    const sorted = run.results.map((row) => row[t]?.lap ?? 0).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    lines.push(
      `| ${t + 1} | ${track.id} | ${p.length_km.toFixed(2)} | ${p.straight_ratio.toFixed(2)} | ${p.corners_low}/${p.corners_mid}/${p.corners_high} | ${p.bumpiness.toFixed(2)} | ` +
        `#${wi} ${spec?.aero.philosophy}/${spec?.chassis.wheelbase} | ${best?.lap.toFixed(3)} | ${best?.setup.wing_level}/${best?.setup.ride_height}/${best?.setup.ers_mode} | ${median.toFixed(3)} |`,
    );
  });
  lines.push('');

  const winnerSet = [...new Set(m.winners)].sort((a, b) => a - b);
  lines.push('## 트랙 최속 스펙 목록', '');
  for (const wi of winnerSet) {
    const spec = run.specs[wi];
    if (spec) lines.push(`- #${wi} (${m.winners.filter((x) => x === wi).length}트랙): ${specLine(spec, regs)}`);
  }
  lines.push('');

  const ers = { harvest: 0, balanced: 0, attack: 0 };
  const ride = { low: 0, mid: 0, high: 0 };
  for (const row of run.results) for (const r of row) {
    ers[r.setup.ers_mode] += 1;
    ride[r.setup.ride_height] += 1;
  }
  const total = run.results.length * run.tracks.length;
  lines.push('## 최적 셋업 분포 (스펙×트랙 전체)', '');
  lines.push(`- ERS 모드: harvest ${pct(ers.harvest / total)}, balanced ${pct(ers.balanced / total)}, attack ${pct(ers.attack / total)}`);
  lines.push(`- 지상고: low ${pct(ride.low / total)}, mid ${pct(ride.mid / total)}, high ${pct(ride.high / total)}`);
  lines.push('');

  for (const s of extra) lines.push(`## ${s.title}`, '', s.body, '');
  return `${lines.join('\n')}\n`;
}
