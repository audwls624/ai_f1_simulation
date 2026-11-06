// @f1sim/harness — 밸런스 테스트 하네스 (DESIGN.md 12절). Node 전용 (worker_threads, fs).
export {
  DATA_DIR,
  listTrackIds,
  loadCalendar,
  loadRegulations,
  loadSeasonTracks,
  loadTrack,
} from './data.js';
export { centerlineCsv, generateLayout, metaFor, metaYaml, seedFor, type Layout, type TrackBrief } from './trackgen.js';
