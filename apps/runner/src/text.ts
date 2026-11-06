/**
 * 텍스트 리플레이 (M3 완료 기준): race.json → 사람이 읽는 랩 요약, 이벤트, 결과, 전략 트레이스.
 */
import type { RaceLog } from '@f1sim/core';

const S_PER_MIN = 60;
const MIN_PER_H = 60;

export function raceTime(s: number): string {
  const h = Math.floor(s / (S_PER_MIN * MIN_PER_H));
  const m = Math.floor((s % (S_PER_MIN * MIN_PER_H)) / S_PER_MIN);
  const rest = s % S_PER_MIN;
  return `${h}:${String(m).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
}

const C = { soft: 'S', medium: 'M', hard: 'H', inter: 'I', wet: 'W' } as const;

function actionText(a: RaceLog['strategy_trace'][number]['action']): string {
  if (a === 'none') return 'none';
  if ('pit' in a) return `pit ${a.pit}`;
  if ('pace' in a) return `pace ${a.pace}`;
  return `extend_stint ${a.extend_stint}`;
}

export interface TextOptions {
  /** 랩 요약 간격 (기본 10랩, 이벤트가 있는 랩은 항상). */
  readonly every?: number;
  /** 랩 요약에 보여줄 순위 수. */
  readonly top?: number;
}

export function formatRace(log: RaceLog, opts: TextOptions = {}): string {
  const every = opts.every ?? 10;
  const top = opts.top ?? 10;
  const w = log.meta.weather_realized;
  const rain = w.rain.length ? `rain ${w.rain.map(([a, b]) => `L${a}–${b}`).join(', ')}` : 'dry';
  const out: string[] = [];
  out.push(`GP ${log.meta.gp} · ${log.meta.track} · ${log.meta.laps} laps · seed ${log.meta.seed} · ${w.temp_c.toFixed(1)}°C · ${rain}`);
  out.push('');
  out.push('Grid');
  for (const c of [...log.cars].sort((a, b) => a.grid - b.grid)) {
    out.push(`  ${String(c.grid).padStart(2)}  ${c.team.padEnd(16)} ${c.quali_lap.toFixed(3)}  wing ${c.setup.wing_level} ${c.setup.ride_height} ${c.setup.ers_mode}  variant ${c.variant_selected}`);
  }
  out.push('');
  out.push('Laps (gap to leader, tyre/life)');
  const eventLaps = new Set(log.events.filter((e) => e.type !== 'overtake_failed').map((e) => e.lap));
  for (const lap of log.laps) {
    if (lap.lap !== 1 && lap.lap % every !== 0 && lap.lap !== log.meta.laps && !eventLaps.has(lap.lap)) continue;
    const leader = lap.cars[lap.order[0] ?? ''];
    const cells = lap.order.slice(0, top).map((team, k) => {
      const c = lap.cars[team];
      const gap = k === 0 || !c || !leader ? '' : ` +${(c.cum - leader.cum).toFixed(1)}`;
      return `${k + 1}.${team}${gap} ${c ? `${C[c.compound]}${Math.round(c.life * 100)}` : ''}`;
    });
    const flags = [lap.sc ? 'SC' : '', lap.surface !== 'dry' ? lap.surface : ''].filter(Boolean).join(' ');
    out.push(`  L${String(lap.lap).padStart(3)} ${flags.padEnd(8)} ${cells.join(' | ')}`);
  }
  out.push('');
  out.push('Events');
  for (const e of log.events) {
    const lap = `  L${String(e.lap).padStart(3)}`;
    switch (e.type) {
      case 'overtake':
        out.push(`${lap} overtake  ${e.car} passes ${e.on}`);
        break;
      case 'pit':
        out.push(`${lap} pit       ${e.car} ${e.from} → ${e.to} (${e.loss_s.toFixed(1)} s)`);
        break;
      case 'safety_car':
        out.push(`${lap} SAFETY CAR (${e.duration_laps} laps)`);
        break;
      case 'safety_car_end':
        out.push(`${lap} safety car in`);
        break;
      case 'rain_start':
        out.push(`${lap} rain starts`);
        break;
      case 'rain_stop':
        out.push(`${lap} rain stops`);
        break;
      case 'retirement':
        out.push(`${lap} RETIRED   ${e.car} (${e.reason})`);
        break;
      default:
        break;
    }
  }
  const failed = log.events.filter((e) => e.type === 'overtake_failed').length;
  if (failed) out.push(`  (${failed} failed overtake attempts not listed)`);
  out.push('');
  out.push('Result');
  const winner = log.result[0]?.time ?? 0;
  for (const r of log.result) {
    const time = r.time === null ? `DNF (${r.laps} laps)` : r.pos === 1 ? raceTime(r.time) : `+${(r.time - winner).toFixed(3)}`;
    const pen = r.penalties.length ? `  penalty ${r.penalties.map((p) => `${p.reason} +${p.s}s`).join(', ')}` : '';
    out.push(`  ${String(r.pos).padStart(2)}  ${r.team.padEnd(16)} ${time.padStart(14)}  ${String(r.points).padStart(2)} pts${pen}`);
  }
  out.push('');
  out.push(formatTrace(log));
  return `${out.join('\n')}\n`;
}

/** 8절 전략 트레이스: 어느 랩에 어느 규칙·계획·폴백이 무엇을 했나. */
export function formatTrace(log: RaceLog): string {
  const out = ['Strategy trace (lap, team, source, action)'];
  for (const t of log.strategy_trace) {
    const source = t.source === 'rule' ? `rule[${t.rule_idx ?? '?'}]` : t.source;
    const fitted = t.fitted ? ` (fitted ${t.fitted})` : '';
    out.push(`  L${String(t.lap).padStart(3)}  ${t.car.padEnd(16)} ${source.padEnd(24)} ${actionText(t.action)}${fitted}`);
  }
  return out.join('\n');
}
