/**
 * 날씨 (DESIGN.md 5절): 예보 → 실현 → 노면 상태.
 *
 * - 예보 (전략 제출 전 공개): 윈도우(rules.forecast.window_laps)별 강우 확률 + 기온.
 *   강우 확률 = 트랙 기본 확률 + 이웃 윈도우끼리 상관된 노이즈 (model.weather).
 * - 실현 (레이스 시드의 weather 스트림): 윈도우마다 그 확률로 비가 오고, 시작 랩은 윈도우 안에서 균등,
 *   지속은 model.weather.rain_duration_laps에서 균등. 기온은 레이스 시작 시 1회 N(temp_mean, temp_sd).
 * - 노면: 젖음 카운터 (비 오는 랩 +1, 마른 랩 −1). 카운터 ≥ damp면 damp, ≥ wet면 wet (rules.surface).
 */
import { z } from 'zod';
import type { Regulations, Surface } from './regulations.js';
import type { Rng } from './rng.js';

export const ForecastWindowSchema = z.strictObject({
  /** [첫 랩, 마지막 랩] (1부터, 양끝 포함). */
  laps: z.tuple([z.int().min(1), z.int().min(1)]),
  rain_p: z.number().min(0).max(1),
  temp_c: z.number(),
});
export const ForecastSchema = z.array(ForecastWindowSchema).min(1);
export type ForecastWindow = z.infer<typeof ForecastWindowSchema>;
export type Forecast = z.infer<typeof ForecastSchema>;

export const RealizedWeatherSchema = z.strictObject({
  temp_c: z.number(),
  /** 비가 오는 랩 구간 [시작, 끝] (양끝 포함, 겹치지 않고 오름차순). */
  rain: z.array(z.tuple([z.int().min(1), z.int().min(1)])),
});
export type RealizedWeather = z.infer<typeof RealizedWeatherSchema>;

export interface WeatherTrack {
  readonly laps: number;
  readonly rain_base_prob: number;
  readonly temp_mean: number;
  readonly temp_sd: number;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** 예보. rng는 이 GP의 예보 전용 스트림. */
export function makeForecast(track: WeatherTrack, regs: Regulations, rng: Rng): Forecast {
  const size = regs.forecast.window_laps;
  const { forecast_noise_sd: sd, forecast_persistence: rho } = regs.weather;
  const out: ForecastWindow[] = [];
  let noise = 0;
  for (let first = 1, w = 0; first <= track.laps; first += size, w++) {
    const fresh = rng.normal(0, sd);
    noise = w === 0 ? fresh : rho * noise + Math.sqrt(1 - rho * rho) * fresh;
    out.push({
      laps: [first, Math.min(track.laps, first + size - 1)],
      rain_p: clamp01(track.rain_base_prob + noise),
      temp_c: track.temp_mean,
    });
  }
  return out;
}

/** 예보에서 실제 날씨를 뽑는다. rng는 레이스 시드의 weather 스트림. */
export function realize(forecast: Forecast, track: WeatherTrack, regs: Regulations, rng: Rng): RealizedWeather {
  const temp_c = rng.normal(track.temp_mean, track.temp_sd);
  const [shortest, longest] = regs.weather.rain_duration_laps;
  const spells: [number, number][] = [];
  for (const window of forecast) {
    // 윈도우마다 균등 난수 3개를 항상 쓴다 (비가 안 와도) → 소비량이 예보 값과 무관.
    const rains = rng.next() < window.rain_p;
    const startU = rng.next();
    const lengthU = rng.next();
    if (!rains) continue;
    const [a, b] = window.laps;
    const start = a + Math.floor(startU * (b - a + 1));
    const length = shortest + Math.floor(lengthU * (longest - shortest + 1));
    spells.push([start, Math.min(track.laps, start + length - 1)]);
  }
  const merged: [number, number][] = [];
  for (const s of spells) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return { temp_c, rain: merged };
}

/** 이 랩에 비가 오는가. */
export function isRaining(weather: RealizedWeather, lap: number): boolean {
  return weather.rain.some(([a, b]) => lap >= a && lap <= b);
}

/** 랩별 노면 (인덱스 0 = 1랩). 1랩은 마른 노면에서 시작한다. */
export function surfaceByLap(weather: RealizedWeather, laps: number, regs: Regulations): Surface[] {
  const { damp_after_rain_laps: damp, wet_after_rain_laps: wet } = regs.surface;
  const out: Surface[] = [];
  let wetness = 0;
  for (let lap = 1; lap <= laps; lap++) {
    out.push(wetness >= wet ? 'wet' : wetness >= damp ? 'damp' : 'dry');
    wetness = Math.min(wet, Math.max(0, wetness + (isRaining(weather, lap) ? 1 : -1)));
  }
  return out;
}

/** 레이스가 처음부터 끝까지 dry였나 (2종 컴파운드 의무는 건조 레이스에만, 3절). */
export function isDryRace(surfaces: readonly Surface[]): boolean {
  return surfaces.every((s) => s === 'dry');
}
