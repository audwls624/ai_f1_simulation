/**
 * Node 쪽 데이터 로더 (DESIGN.md 13절 data/). core는 파일을 못 읽으므로 하네스·러너가 여기서 읽어 넘긴다.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRegulations, parseTrack, parseTrackMeta, type Regulations, type Track } from '@f1sim/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** 레포의 data/ 디렉터리. */
export const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));

export function loadRegulations(season: number, dataDir = DATA_DIR): Regulations {
  return parseRegulations(readFileSync(join(dataDir, 'regulations', `${season}.yaml`), 'utf8'));
}

export function loadTrack(id: string, regs: Regulations, dataDir = DATA_DIR): Track {
  const dir = join(dataDir, 'tracks');
  const meta = parseTrackMeta(readFileSync(join(dir, `${id}.yaml`), 'utf8'));
  if (meta.id !== id) throw new Error(`tracks/${id}.yaml has id "${meta.id}"`);
  return parseTrack(readFileSync(join(dir, `${id}.csv`), 'utf8'), meta, regs);
}

/** data/tracks에 있는 트랙 id 전부 (이름순 — 결정적 순서). */
export function listTrackIds(dataDir = DATA_DIR): string[] {
  return readdirSync(join(dataDir, 'tracks'))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

/** 시즌 캘린더 (2절). season.ts(M4)가 생기면 스키마는 core로 옮긴다. */
export const CalendarSchema = z.strictObject({
  season: z.int(),
  gps: z.array(z.string()).min(1),
});
export type Calendar = z.infer<typeof CalendarSchema>;

export function loadCalendar(season: number, dataDir = DATA_DIR): Calendar {
  const calendar = CalendarSchema.parse(parseYaml(readFileSync(join(dataDir, 'calendar', `${season}.yaml`), 'utf8')));
  if (calendar.season !== season) throw new Error(`calendar/${season}.yaml says season ${calendar.season}`);
  const seen = new Set<string>();
  for (const id of calendar.gps) {
    if (seen.has(id)) throw new Error(`calendar/${season}.yaml lists "${id}" twice`);
    seen.add(id);
  }
  return calendar;
}

/** 캘린더 순서대로 트랙을 읽는다. */
export function loadSeasonTracks(season: number, regs: Regulations, dataDir = DATA_DIR): Track[] {
  return loadCalendar(season, dataDir).gps.map((id) => loadTrack(id, regs, dataDir));
}
