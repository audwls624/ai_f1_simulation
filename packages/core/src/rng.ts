/**
 * 시드 가능한 난수 — xoshiro128** (DESIGN.md 11·16절). core에서 난수는 여기서만 만든다.
 *
 * spawn(key)는 부모의 "생성 시점 상태"와 key를 해시해 자식 스트림을 만든다.
 * 부모가 next()를 몇 번 불렀는지와 무관하고, 부모 상태도 바꾸지 않는다.
 * → 같은 key는 언제 spawn해도 같은 스트림. 한 팀의 난수 소비량이 다른 팀의 난수를 바꾸지 않는다 (11절).
 */

export interface Rng {
  /** [0, 1) 균등 분포. */
  next(): number;
  /**
   * N(mu, sd). Box–Muller, 호출마다 균등 난수를 정확히 2개 소비한다 (짝 값을 캐시하지 않음 → 소비량이 예측 가능).
   * sd < 0 이거나 유한하지 않으면 RangeError.
   */
  normal(mu: number, sd: number): number;
  /** 독립 자식 스트림. 같은 부모 + 같은 key → 항상 같은 스트림. */
  spawn(key: string): Rng;
}

type State = readonly [number, number, number, number];

const UINT32_RANGE = 2 ** 32;

// ── 해시 (상태 유도용) ─────────────────────────────────────────────────
// MurmurHash3 x86_32의 mix/fmix 상수. 알고리즘 상수이며 게임 수치가 아니다.
const MURMUR_C1 = 0xcc9e2d51;
const MURMUR_C2 = 0x1b873593;
const MURMUR_ADD = 0xe6546b64;
const FMIX_C1 = 0x85ebca6b;
const FMIX_C2 = 0xc2b2ae35;
/** 2^32 / φ. 해시 레인별 시드와 0 상태 회피에 쓴다. */
const GOLDEN_GAMMA = 0x9e3779b9;
const STATE_WORDS = 4;

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

function murmurMix(h: number, k: number): number {
  let x = Math.imul(k, MURMUR_C1);
  x = rotl(x, 15);
  x = Math.imul(x, MURMUR_C2);
  const y = rotl(h ^ x, 13);
  return (Math.imul(y, 5) + MURMUR_ADD) | 0;
}

function fmix32(h: number): number {
  let x = h ^ (h >>> 16);
  x = Math.imul(x, FMIX_C1);
  x ^= x >>> 13;
  x = Math.imul(x, FMIX_C2);
  x ^= x >>> 16;
  return x >>> 0;
}

/** (words, key) → 128비트 상태. 레인마다 시드가 다른 MurmurHash3 4개로 32비트씩 만든다. */
function deriveState(words: readonly number[], key: string): State {
  const lane = (index: number): number => {
    let h = Math.imul(index + 1, GOLDEN_GAMMA);
    for (const w of words) h = murmurMix(h, w);
    for (let i = 0; i < key.length; i++) h = murmurMix(h, key.charCodeAt(i));
    // 길이를 섞어 (words, key) 경계가 모호해지지 않게 한다.
    h = murmurMix(h, words.length);
    h = murmurMix(h, key.length);
    return fmix32(h);
  };
  const s: State = [lane(0), lane(1), lane(2), lane(3)];
  // xoshiro는 전부 0인 상태에서 멈춘다 (확률 2^-128이지만 막아 둔다).
  return (s[0] | s[1] | s[2] | s[3]) === 0 ? [GOLDEN_GAMMA, 0, 0, 0] : s;
}

// ── xoshiro128** 1.1 ───────────────────────────────────────────────────

class Xoshiro128StarStar implements Rng {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;
  /** spawn의 기준. 생성 시점 상태 그대로 보관한다. */
  readonly #identity: State;

  constructor(state: State) {
    if (state.length !== STATE_WORDS) throw new RangeError('xoshiro128** state must have 4 words');
    this.#identity = [state[0] >>> 0, state[1] >>> 0, state[2] >>> 0, state[3] >>> 0];
    [this.#s0, this.#s1, this.#s2, this.#s3] = this.#identity;
  }

  /** 32비트 부호 없는 정수. 참조 구현(Blackman & Vigna)과 비트 단위로 같다. */
  nextUint32(): number {
    const s1 = this.#s1;
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    this.#s2 ^= this.#s0;
    this.#s3 ^= this.#s1;
    this.#s1 ^= this.#s2;
    this.#s0 ^= this.#s3;
    this.#s2 ^= t;
    this.#s3 = rotl(this.#s3, 11);
    return result;
  }

  next(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  normal(mu: number, sd: number): number {
    if (!Number.isFinite(mu) || !Number.isFinite(sd) || sd < 0) {
      throw new RangeError(`normal(mu, sd) needs finite mu and finite sd >= 0 (got mu=${mu}, sd=${sd})`);
    }
    const u1 = 1 - this.next(); // (0, 1] → log(0) 회피
    const u2 = this.next();
    return mu + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  spawn(key: string): Rng {
    return new Xoshiro128StarStar(deriveState(this.#identity, key));
  }
}

/** 정수 시드(안전 정수 범위, 음수 허용)로 루트 스트림을 만든다. */
export function makeRng(seed: number): Rng {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`seed must be a safe integer (got ${seed})`);
  }
  const lo = seed >>> 0;
  const hi = Math.floor(seed / UINT32_RANGE) >>> 0;
  return new Xoshiro128StarStar(deriveState([lo, hi], ''));
}

/**
 * @internal 테스트 전용: 원시 상태에서 생성기를 만든다 (참조 구현과의 known-answer 비교용).
 * index.ts에서 내보내지 않는다.
 */
export function rngFromState(state: State): Rng & { nextUint32(): number } {
  return new Xoshiro128StarStar(state);
}
