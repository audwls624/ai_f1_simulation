// @f1sim/core 공개 API (DESIGN.md 16절). M1: rng, regulations, car, track, tires, laptime.
export { makeRng, type Rng } from './rng.js';

export {
  CompoundSchema,
  DRY_COMPOUNDS,
  PaceModeSchema,
  ModelSchema,
  RegulationsError,
  RegulationsSchema,
  RulesSchema,
  SurfaceSchema,
  cost,
  formatIssue,
  parseRegulations,
  publicRules,
  validateSetup,
  validateSpec,
  type Compound,
  type PaceMode,
  type EngineModel,
  type Regulations,
  type Rules,
  type Result,
  type Surface,
  type ValidationIssue,
} from './regulations.js';

export {
  CarSpecSchema,
  ErsModeSchema,
  PhilosophySchema,
  RideHeightSchema,
  SPEC_PARAMS,
  SPEC_PARAM_MAX,
  SPEC_PARAM_MIN,
  SetupSchema,
  WING_LEVEL_MAX,
  WING_LEVEL_MIN,
  WheelbaseSchema,
  derive,
  type CarSpec,
  type DeriveTrackInput,
  type DerivedPerf,
  type ErsMode,
  type Philosophy,
  type RideHeight,
  type Setup,
  type SpecParamKey,
  type Wheelbase,
} from './car.js';

export {
  TrackError,
  TrackMetaSchema,
  TrackProfileSchema,
  parseTrack,
  parseTrackMeta,
  profile,
  type CornerClass,
  type CornerSegment,
  type Segment,
  type StraightSegment,
  type Track,
  type TrackMeta,
  type TrackProfile,
  type TrackSample,
} from './track.js';

export { degradation, tireOffset, warmupPenalty, wearPerLap } from './tires.js';

export { baseLap, inDirtyAir, raceLap, type LapBreakdown, type LapState } from './laptime.js';

export {
  ForecastSchema,
  ForecastWindowSchema,
  RealizedWeatherSchema,
  isDryRace,
  isRaining,
  makeForecast,
  realize,
  surfaceByLap,
  type Forecast,
  type ForecastWindow,
  type RealizedWeather,
  type WeatherTrack,
} from './weather.js';
