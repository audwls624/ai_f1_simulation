import { describe, expect, it } from 'vitest';
import { makeRng } from '../src/rng.js';
import {
  ForecastSchema,
  RealizedWeatherSchema,
  isDryRace,
  isRaining,
  makeForecast,
  realize,
  surfaceByLap,
  type RealizedWeather,
} from '../src/weather.js';
import { regs } from './helpers.js';

const track = { laps: 57, rain_base_prob: 0.3, temp_mean: 24, temp_sd: 4 };

describe('makeForecast (DESIGN.md §5)', () => {
  it('covers every lap with 10-lap windows and valid probabilities', () => {
    const f = makeForecast(track, regs, makeRng(1));
    expect(ForecastSchema.safeParse(f).success).toBe(true);
    expect(f.map((w) => w.laps)).toEqual([[1, 10], [11, 20], [21, 30], [31, 40], [41, 50], [51, 57]]);
    expect(f.every((w) => w.temp_c === track.temp_mean)).toBe(true);
  });

  it('is deterministic; a race gets rain about rain_base_prob of the time', () => {
    expect(makeForecast(track, regs, makeRng(2))).toEqual(makeForecast(track, regs, makeRng(2)));
    const rng = makeRng(3);
    const races = 4000;
    let wet = 0;
    for (let i = 0; i < races; i++) if (realize(makeForecast(track, regs, rng), track, regs, rng).rain.length > 0) wet++;
    expect(wet / races).toBeGreaterThan(track.rain_base_prob - 0.05);
    expect(wet / races).toBeLessThan(track.rain_base_prob + 0.05);
  });
});

describe('realize', () => {
  it('keeps rain spells inside the race, sorted and non-overlapping', () => {
    const rng = makeRng(4);
    for (let k = 0; k < 300; k++) {
      const w = realize(makeForecast(track, regs, rng), track, regs, rng);
      expect(RealizedWeatherSchema.safeParse(w).success).toBe(true);
      for (const [a, b] of w.rain) {
        expect(a).toBeLessThanOrEqual(b);
        expect(b).toBeLessThanOrEqual(track.laps);
      }
      for (let i = 1; i < w.rain.length; i++) expect(w.rain[i]?.[0]).toBeGreaterThan((w.rain[i - 1]?.[1] ?? 0) + 1);
    }
  });

  it('rains about as often as forecast, never with rain_p 0, always with rain_p 1', () => {
    const dryForecast = makeForecast({ ...track, rain_base_prob: 0 }, regs, makeRng(5)).map((w) => ({ ...w, rain_p: 0 }));
    const wetForecast = dryForecast.map((w) => ({ ...w, rain_p: 1 }));
    expect(realize(dryForecast, track, regs, makeRng(6)).rain).toEqual([]);
    expect(realize(wetForecast, track, regs, makeRng(6)).rain.length).toBeGreaterThan(0);
  });

  it('draws the race temperature once from N(temp_mean, temp_sd)', () => {
    const rng = makeRng(7);
    const f = makeForecast(track, regs, rng);
    const temps = Array.from({ length: 4000 }, () => realize(f, track, regs, rng).temp_c);
    const mean = temps.reduce((s, t) => s + t, 0) / temps.length;
    expect(mean).toBeCloseTo(track.temp_mean, 0);
  });
});

describe('surfaceByLap (DESIGN.md §5)', () => {
  const rainy = (rain: [number, number][]): RealizedWeather => ({ temp_c: 20, rain });

  it('dry → damp 2 laps after rain starts → wet after 5, and dries in reverse', () => {
    const s = surfaceByLap(rainy([[5, 14]]), 30, regs);
    expect(s.slice(0, 6)).toEqual(['dry', 'dry', 'dry', 'dry', 'dry', 'dry']); // 비는 5랩부터, 5·6랩은 아직 dry
    expect(s[6]).toBe('damp'); // 7랩 = 시작 후 2랩
    expect(s[9]).toBe('wet'); // 10랩 = 시작 후 5랩
    expect(s[14]).toBe('wet'); // 15랩: 그친 직후
    expect(s.slice(15)).toContain('damp');
    expect(s.at(-1)).toBe('dry');
    const firstDamp = s.indexOf('damp', 15);
    const firstDry = s.indexOf('dry', 15);
    expect(firstDamp).toBeLessThan(firstDry);
  });

  it('a short shower only reaches damp', () => {
    const s = surfaceByLap(rainy([[10, 12]]), 20, regs);
    expect(s).not.toContain('wet');
    expect(s).toContain('damp');
    expect(isDryRace(s)).toBe(false);
  });

  it('no rain → all dry; isRaining matches the spells', () => {
    expect(isDryRace(surfaceByLap(rainy([]), 40, regs))).toBe(true);
    expect(isRaining(rainy([[3, 4]]), 3)).toBe(true);
    expect(isRaining(rainy([[3, 4]]), 5)).toBe(false);
  });
});
