// @f1sim/harness — 밸런스 테스트 하네스 (DESIGN.md 12절). Node 전용 (worker_threads, fs).
export {
  CalendarSchema,
  DATA_DIR,
  listTrackIds,
  loadCalendar,
  loadRegulations,
  loadSeasonTracks,
  loadTrack,
  type Calendar,
} from './data.js';
export { centerlineCsv, generateLayout, metaFor, metaYaml, seedFor, type Layout, type TrackBrief } from './trackgen.js';
