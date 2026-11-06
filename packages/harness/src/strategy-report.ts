/** 전략 탐색 리포트 (12절 지표 4–6). */
import { cost, type Regulations } from '@f1sim/core';
import { average, describePlan, fallbacksPerRace, luck, strategySpread } from './strategy.js';
import type { StrategyRun } from './strategy-explore.js';

/** 12절 지표 4–6의 통과 기준. */
export const STRATEGY_CRITERIA = {
  /** 지표 4: 상위 10% 플랜과 하위 10% 플랜의 평균 결과 차이 ≥ 피트 손실 1회분 (모든 스펙×트랙에서). */
  spreadInPitLosses: 1,
  topShare: 0.1,
  /** 지표 5: 같은 스펙·같은 플랜의 시드별 순위 표준편차 ≤ 1.5 (평균). */
  maxPositionSd: 1.5,
  /** 지표 6: 랜덤 플랜에서도 폴백이 레이스당 평균 1회 미만. */
  maxFallbacksPerRace: 1,
} as const;

export function strategyMetrics(run: StrategyRun) {
  const spread = strategySpread(run.samples, STRATEGY_CRITERIA.topShare).map((c) => {
    const pitLoss = run.tracks[c.track]?.pit_loss_s ?? 0;
    return { ...c, pitLoss, ratio: c.spread / pitLoss };
  });
  const minRatio = Math.min(...spread.map((c) => c.ratio));
  const sds = luck(run.samples);
  const meanSd = average(sds);
  const fallbacks = fallbacksPerRace(run.samples);
  return {
    metric4: { cells: spread, minRatio, pass: minRatio >= STRATEGY_CRITERIA.spreadInPitLosses },
    metric5: { meanSd, medianSd: [...sds].sort((a, b) => a - b)[Math.floor(sds.length / 2)] ?? 0, shareOk: sds.filter((s) => s <= STRATEGY_CRITERIA.maxPositionSd).length / Math.max(1, sds.length), pass: meanSd <= STRATEGY_CRITERIA.maxPositionSd },
    metric6: { fallbacks, pass: fallbacks < STRATEGY_CRITERIA.maxFallbacksPerRace },
  };
}

const ok = (b: boolean) => (b ? '통과' : '**실패**');

export function strategyReport(run: StrategyRun, regs: Regulations, date: string, extra = ''): string {
  const m = strategyMetrics(run);
  const o = run.options;
  const races = run.samples.length;
  const lines: string[] = [];
  lines.push(`# 전략 공간 탐색 — ${date}`, '');
  lines.push(
    `고정 스펙 ${run.specs.length}개 (설계 탐색 ${o.designSpecs}개에서 다양하게) × 랜덤 플랜 ${run.plans.length}개 (${run.tracks.map((t) => t.id).join(', ')}에 나눔) × 시드 ${o.seeds}개 = 레이스 ${races}회. ` +
      '랜덤 플랜 차 1대 + 나머지 9대는 각자의 휴리스틱 플랜, 셋업은 스펙별 최적. 모든 플랜이 같은 시드 묶음을 쓴다.',
    '',
  );
  lines.push('## 지표 (DESIGN.md 12절)', '', '| 지표 | 값 | 기준 | 결과 |', '| --- | --- | --- | --- |');
  lines.push(`| 4. 전략 분산 | 상위·하위 10% 차이 최소 ${m.metric4.minRatio.toFixed(2)} × 피트 손실 (스펙×트랙 ${m.metric4.cells.length}칸) | ≥ 1 | ${ok(m.metric4.pass)} |`);
  lines.push(`| 5. 운 비중 | 순위 σ 평균 ${m.metric5.meanSd.toFixed(2)} (중앙값 ${m.metric5.medianSd.toFixed(2)}, ≤ 1.5인 칸 ${(m.metric5.shareOk * 100).toFixed(0)}%) | ≤ 1.5 | ${ok(m.metric5.pass)} |`);
  lines.push(`| 6. 폴백 빈도 | 레이스당 ${m.metric6.fallbacks.toFixed(2)}회 | < 1 | ${ok(m.metric6.pass)} |`);
  lines.push('');
  type Sample = (typeof run.samples)[number];
  const conditional = (label: string, keep: (x: Sample) => boolean) => {
    const cell = (all: readonly Sample[]) => {
      const s = all.filter(keep);
      return `${((s.length / Math.max(1, all.length)) * 100).toFixed(0)}% | ${average(luck(s)).toFixed(2)}`;
    };
    return `| ${label} | ${cell(run.samples)} | ${cell(run.baseline)} |`;
  };
  lines.push(
    '## 지표 5 분해: 어떤 레이스에서 순위가 흔들리나',
    '',
    '참고 열은 같은 스펙·같은 시드에서 10대 전원이 휴리스틱 플랜일 때 (스펙 × 트랙 칸마다 시드별 순위 σ). 지표 판정에는 안 쓴다.',
    '',
    '| 레이스 | 랜덤 플랜: 비율 | 순위 σ | 참고 — 휴리스틱 플랜: 비율 | 순위 σ |',
    '| --- | --- | --- | --- | --- |',
  );
  lines.push(conditional('전부', () => true));
  lines.push(conditional('세이프티카 없음', (x) => !x.sc));
  lines.push(conditional('비 없음', (x) => !x.rain));
  lines.push(conditional('리타이어 없음', (x) => !x.anyDnf));
  lines.push(conditional('세이프티카·비·리타이어 없음', (x) => !x.sc && !x.rain && !x.anyDnf));
  lines.push('');
  lines.push('## 트랙별', '', '| 트랙 | 피트 손실 | 전략 분산 (중앙값) | 순위 σ | 폴백/레이스 | DNF | 피트/레이스 |', '| --- | --- | --- | --- | --- | --- | --- |');
  run.tracks.forEach((track, t) => {
    const s = run.samples.filter((x) => x.track === t);
    const cells = m.metric4.cells.filter((c) => c.track === t).map((c) => c.spread).sort((a, b) => a - b);
    const sds = luck(s);
    lines.push(
      `| ${track.id} | ${track.pit_loss_s} s | ${(cells[Math.floor(cells.length / 2)] ?? 0).toFixed(1)} s | ${average(sds).toFixed(2)} | ${fallbacksPerRace(s).toFixed(2)} | ${((s.filter((x) => x.time === null).length / Math.max(1, s.length)) * 100).toFixed(1)}% | ${average(s.map((x) => x.pits)).toFixed(2)} |`,
    );
  });
  lines.push('');
  lines.push('## 고정 스펙', '');
  run.specs.forEach((spec, i) => lines.push(`- s${i}: ${spec.aero.philosophy}/${spec.chassis.wheelbase}, ${cost(spec, regs).toFixed(1)} cr`));
  lines.push('');
  lines.push('## 플랜 예시 (스펙 s0)', '');
  for (const c of m.metric4.cells.filter((x) => x.spec === 0)) {
    const best = run.plans[c.best]?.plan;
    const worst = run.plans[c.worst]?.plan;
    lines.push(`- ${run.tracks[c.track]?.id}: 최고 ${best ? describePlan(best) : '-'} / 최저 ${worst ? describePlan(worst) : '-'} (차이 ${c.spread.toFixed(1)} s)`);
  }
  if (extra) lines.push('', extra);
  return `${lines.join('\n')}\n`;
}
