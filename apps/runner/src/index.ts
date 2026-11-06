// @f1sim/runner — 시즌 실행 CLI (DESIGN.md 13절). API 키는 이 앱에만 둔다 (M5).
export { gpDir, preseasonDesign, runGP, runSeason, type DesignOutcome, type GPOutcome, type SeasonOutcome, type Team } from './orchestrate.js';
export { formatRace, formatTrace, raceTime, type TextOptions } from './text.js';
export {
  GOLDEN_DIR,
  GoldenManifestSchema,
  agentFiles,
  checkGolden,
  goldenDir,
  heuristicTeams,
  inputFingerprint,
  recordGolden,
  seasonFiles,
  sha256,
  type GoldenCheck,
  type GoldenManifest,
} from './golden.js';
