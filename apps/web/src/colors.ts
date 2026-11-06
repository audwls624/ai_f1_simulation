/**
 * 팀 색과 약칭. 범주형 8색 (dataviz 기본 팔레트, 라이트·다크 각각 검증됨) — 순서대로 배정하고 순환하지 않는다.
 * 색은 코딩 에이전트 팀에 먼저 (팀 파일 순), 휴리스틱·9번째 이후는 중립 회색. 색만으로 구분하지 않도록 점마다 약칭을 붙인다.
 */
export const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
} as const;
export const NEUTRAL = { light: '#8b8a84', dark: '#8f8e88' } as const;

export interface TeamRef {
  readonly team: string;
  readonly agent: string;
}

/** 팀 → 색 슬롯 (0–7) 또는 null (중립). 휴리스틱이 아닌 팀이 하나도 없으면 앞의 8팀에 준다. */
export function colorSlots(teams: readonly TeamRef[]): Map<string, number | null> {
  const featured = teams.some((t) => t.agent !== 'heuristic') ? teams.filter((t) => t.agent !== 'heuristic') : teams;
  const slots = new Map<string, number | null>(teams.map((t) => [t.team, null]));
  featured.slice(0, SERIES.light.length).forEach((t, i) => slots.set(t.team, i));
  return slots;
}

/** F1식 세 글자 약칭 (heuristic-01 → H01). 겹치면 글자를 늘린다. */
export function shortCodes(teams: readonly string[]): Map<string, string> {
  const base = (name: string, n: number) => {
    const m = /^([a-z])[a-z]*-(\d+)$/i.exec(name);
    if (m) return `${(m[1] ?? '').toUpperCase()}${m[2] ?? ''}`;
    return name.replace(/[^a-z0-9]/gi, '').slice(0, n).toUpperCase();
  };
  const out = new Map<string, string>();
  for (let n = 3; n <= 8; n++) {
    const codes = teams.map((t) => base(t, n));
    const unique = new Set(codes).size === codes.length;
    if (unique || n === 8) {
      teams.forEach((t, i) => out.set(t, codes[i] ?? t));
      break;
    }
  }
  return out;
}
