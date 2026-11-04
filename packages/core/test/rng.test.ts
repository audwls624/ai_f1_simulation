import { describe, expect, it } from 'vitest';
import { makeRng, rngFromState, type Rng } from '../src/rng.js';

function draw(rng: Rng, n: number): number[] {
  return Array.from({ length: n }, () => rng.next());
}

function meanSd(xs: readonly number[]): { mean: number; sd: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
  return { mean, sd: Math.sqrt(variance) };
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const ma = meanSd(a);
  const mb = meanSd(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += ((a[i] ?? 0) - ma.mean) * ((b[i] ?? 0) - mb.mean);
  return s / (a.length - 1) / (ma.sd * mb.sd);
}

describe('xoshiro128** generator', () => {
  // 참조 구현(Blackman & Vigna C 코드)을 컴파일해 뽑은 값.
  it('matches the reference implementation bit for bit', () => {
    const a = rngFromState([1, 2, 3, 4]);
    expect(Array.from({ length: 12 }, () => a.nextUint32())).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804,
      337829053, 2142557243,
    ]);
    const b = rngFromState([0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef]);
    expect(Array.from({ length: 12 }, () => b.nextUint32())).toEqual([
      2463954730, 5524658, 74256371, 1905451993, 3123413897, 314453775, 1263677054, 1531511215, 693760292,
      1307612896, 1023732939, 4236036988,
    ]);
  });
});

describe('makeRng', () => {
  it('same seed → same sequence', () => {
    expect(draw(makeRng(918273), 1000)).toEqual(draw(makeRng(918273), 1000));
  });

  it('different seeds → different sequences', () => {
    expect(draw(makeRng(1), 10)).not.toEqual(draw(makeRng(2), 10));
    expect(draw(makeRng(0), 10)).not.toEqual(draw(makeRng(-1), 10));
    expect(draw(makeRng(2 ** 32), 10)).not.toEqual(draw(makeRng(0), 10));
  });

  it('next() stays in [0, 1) and is roughly uniform', () => {
    const xs = draw(makeRng(7), 100_000);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(meanSd(xs).mean).toBeCloseTo(0.5, 2);
  });

  it('rejects seeds that are not safe integers', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => makeRng(bad)).toThrow(RangeError);
    }
  });

  // 회귀 고정값: 시딩·해시가 바뀌면 이후의 골든 로그(11절)가 전부 깨진다. 의도한 변경일 때만 갱신.
  it('keeps the seeding stable (regression pin)', () => {
    const r = makeRng(20261104);
    expect(draw(r, 3)).toMatchInlineSnapshot(`
      [
        0.5453840179834515,
        0.5483313368167728,
        0.9003106681630015,
      ]
    `);
    expect(draw(r.spawn('weather'), 3)).toMatchInlineSnapshot(`
      [
        0.037128199357539415,
        0.13659847131930292,
        0.3365160091780126,
      ]
    `);
  });
});

describe('spawn', () => {
  it('spawn("a") and spawn("b") are different streams', () => {
    const root = makeRng(42);
    expect(draw(root.spawn('a'), 100)).not.toEqual(draw(root.spawn('b'), 100));
  });

  it('does not touch the parent stream', () => {
    const plain = makeRng(42);
    const spawning = makeRng(42);
    spawning.spawn('a');
    spawning.spawn('b').next();
    expect(draw(spawning, 100)).toEqual(draw(plain, 100));
  });

  it('child is independent of the parent: different values, no correlation', () => {
    const parent = makeRng(42);
    const child = parent.spawn('a');
    const p = draw(parent, 100_000);
    const c = draw(child, 100_000);
    expect(c.slice(0, 100)).not.toEqual(p.slice(0, 100));
    expect(new Set(c.slice(0, 1000)).size).toBe(1000);
    expect(p.slice(0, 1000).filter((x) => c.slice(0, 1000).includes(x))).toEqual([]);
    expect(Math.abs(correlation(p, c))).toBeLessThan(0.02);
  });

  it('same key → same stream, regardless of how much the parent has drawn', () => {
    const fresh = makeRng(42);
    const used = makeRng(42);
    draw(used, 500);
    expect(draw(used.spawn('failures'), 50)).toEqual(draw(fresh.spawn('failures'), 50));
    expect(draw(fresh.spawn('failures'), 50)).toEqual(draw(fresh.spawn('failures'), 50));
  });

  it('spawn paths are distinct: a→b ≠ b→a ≠ "ab"', () => {
    const root = makeRng(42);
    const ab = draw(root.spawn('a').spawn('b'), 20);
    const ba = draw(root.spawn('b').spawn('a'), 20);
    const flat = draw(root.spawn('ab'), 20);
    expect(ab).not.toEqual(ba);
    expect(ab).not.toEqual(flat);
    expect(ba).not.toEqual(flat);
  });

  it('per-car streams (11절: stream.X.spawn(car_index)) are pairwise distinct', () => {
    const failures = makeRng(918273).spawn('failures');
    const firsts = Array.from({ length: 20 }, (_, i) => failures.spawn(String(i)).next());
    expect(new Set(firsts).size).toBe(20);
  });
});

describe('normal', () => {
  it.each([
    [0, 1],
    [50, 5],
    [-3, 0.12],
  ])('100k samples of N(%d, %d): mean and sd within ±2%%', (mu, sd) => {
    const r = makeRng(1234);
    const xs = Array.from({ length: 100_000 }, () => r.normal(mu, sd));
    const stats = meanSd(xs);
    // 평균은 |mu|의 2% 또는 (mu = 0이면) sd의 2% 이내.
    expect(Math.abs(stats.mean - mu)).toBeLessThan(0.02 * Math.max(Math.abs(mu), sd));
    expect(Math.abs(stats.sd - sd) / sd).toBeLessThan(0.02);
  });

  it('consumes exactly two uniforms per call', () => {
    const a = makeRng(99);
    a.normal(0, 1);
    a.normal(0, 1);
    const b = makeRng(99);
    draw(b, 4);
    expect(a.next()).toBe(b.next());
  });

  it('sd = 0 returns mu (and still consumes two uniforms)', () => {
    const a = makeRng(5);
    expect(a.normal(3.5, 0)).toBe(3.5);
    const b = makeRng(5);
    draw(b, 2);
    expect(a.next()).toBe(b.next());
  });

  it('rejects negative or non-finite parameters', () => {
    const r = makeRng(1);
    expect(() => r.normal(0, -1)).toThrow(RangeError);
    expect(() => r.normal(Number.NaN, 1)).toThrow(RangeError);
    expect(() => r.normal(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
