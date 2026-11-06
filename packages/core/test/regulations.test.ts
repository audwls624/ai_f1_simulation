import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SPEC_PARAMS, type CarSpec } from '../src/car.js';
import {
  RegulationsError,
  cost,
  formatIssue,
  parseRegulations,
  publicRules,
  validateSpec,
  type ValidationIssue,
} from '../src/regulations.js';
import { docExampleSpec, modelYaml, regs, rulesYaml, specArb, uniformSpec, withSpec } from './helpers.js';

function issuesOf(input: unknown): ValidationIssue[] {
  const r = validateSpec(input, regs);
  if (r.ok) throw new Error('expected validation to fail');
  return r.issues;
}

function regsError(rulesText: string, modelText = modelYaml): RegulationsError {
  try {
    parseRegulations(rulesText, modelText);
  } catch (e) {
    if (e instanceof RegulationsError) return e;
    throw e;
  }
  throw new Error('expected parseRegulations to throw');
}

/** spec의 한 경로 값을 바꾼 깊은 복사 (테스트용, 검증 전 임의 입력 생성). */
function setAt(spec: unknown, path: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(spec) as Record<string, unknown>;
  const keys = path.split('.');
  let node = copy;
  for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>;
  const last = keys.at(-1);
  if (last === undefined) throw new Error('empty path');
  if (value === undefined) Reflect.deleteProperty(node, last);
  else node[last] = value;
  return copy;
}

describe('parseRegulations (data/regulations/2026.yaml)', () => {
  it('rejects unknown keys in the engine model file too, naming the file', () => {
    const e = regsError(rulesYaml, `${modelYaml}\nturbo: 1\n`);
    expect(e.issues).toEqual([expect.objectContaining({ path: 'turbo' })]);
    expect(e.message).toContain('engine model');
  });

  it('rejects rules and model files from different seasons', () => {
    expect(regsError(rulesYaml, modelYaml.replace(/^season: 2026$/m, 'season: 2027')).issues[0]?.path).toBe('season');
  });

  it('publicRules drops every engine model block', () => {
    const pub = publicRules(regs) as Record<string, unknown>;
    for (const key of ['car', 'laptime', 'physics', 'track', 'weather', 'overtaking', 'failures', 'ers_battery', 'qualifying', 'start']) {
      expect(pub).not.toHaveProperty(key);
    }
    expect(pub).toHaveProperty('cost');
    expect(pub).toHaveProperty('tires');
  });

  it('parses the season file', () => {
    expect(regs.season).toBe(2026);
    expect(regs.cost.cap_credits).toBe(100);
    expect(regs.limits.min_weight_kg).toBe(798);
  });

  it('has a weight for exactly the SPEC_PARAMS keys', () => {
    expect(Object.keys(regs.cost.weights).sort()).toEqual(SPEC_PARAMS.map((p) => p.key).sort());
  });

  // 3절의 서술. 하네스가 가중치를 바꾸면 문서와 함께 갱신한다.
  it('matches the cost statements of DESIGN.md §3', () => {
    const weightSum = SPEC_PARAMS.reduce((s, p) => s + regs.cost.weights[p.key], 0);
    expect(weightSum).toBe(181);
    expect(cost(uniformSpec(1), regs)).toBeGreaterThan(regs.cost.cap_credits); // "전부 1.0은 불가능"
    expect(cost(uniformSpec(0.74), regs)).toBeLessThanOrEqual(regs.cost.cap_credits); // "0.74에서 캡에 닿는다"
    expect(cost(uniformSpec(0.75), regs)).toBeGreaterThan(regs.cost.cap_credits);
  });

  it('rejects unknown keys with a path to the key', () => {
    const top = regsError(`${rulesYaml}\nturbo_boost: 3\n`);
    expect(top.issues).toContainEqual(expect.objectContaining({ path: 'turbo_boost' }));

    const nested = regsError(rulesYaml.replace('  fuel_flow_kg_per_h: 100', '  fuel_flow_kg_per_h: 100\n  boost_kw: 50'));
    expect(nested.issues).toEqual([expect.objectContaining({ path: 'limits.boost_kw' })]);
    expect(nested.issues[0]?.message).toContain('fuel_flow_kg_per_h');
  });

  it('rejects missing or out-of-range values with a path', () => {
    const missing = regsError(rulesYaml.replace(/^ {2}min_weight_kg: 798.*$/m, ''));
    expect(missing.issues).toEqual([expect.objectContaining({ path: 'limits.min_weight_kg' })]);

    const badCompound = regsError(rulesYaml.replace('cliff_life: 0.25', 'cliff_life: 1.5'));
    expect(badCompound.issues).toEqual([expect.objectContaining({ path: 'tires.compounds.soft.cliff_life' })]);
  });

  it('rejects an unknown compound in a compound table', () => {
    const e = regsError(rulesYaml.replace('{ soft: 8, medium: 3,', '{ soft: 8, supersoft: 1, medium: 3,'));
    expect(e.issues).toContainEqual(expect.objectContaining({ path: 'tires.allocation_sets.supersoft' }));
  });

  it('checks cross-field rules (fallback spec within the cap)', () => {
    const e = regsError(rulesYaml.replace('cap_credits: 100', 'cap_credits: 40'));
    expect(e.issues).toEqual([expect.objectContaining({ path: 'fallback.spec' })]);
    expect(e.message).toContain('fallback');
  });

  it('rejects malformed YAML and duplicate keys', () => {
    expect(regsError('season: [2026').issues[0]?.message).toMatch(/^YAML /);
    expect(regsError(`season: 2026\nseason: 2027\n`).issues[0]?.message).toMatch(/^YAML DUPLICATE_KEY/);
  });
});

describe('cost', () => {
  it('equals Σ w·x^p for the DESIGN.md §4 example spec', () => {
    const expected = SPEC_PARAMS.reduce((s, p) => s + regs.cost.weights[p.key] * p.get(docExampleSpec) ** 2, 0);
    expect(cost(docExampleSpec, regs)).toBeCloseTo(expected, 12);
    expect(cost(docExampleSpec, regs)).toBeCloseTo(93.1454, 4);
  });

  it('ignores architecture choices (cost 0)', () => {
    const a = withSpec(docExampleSpec, { aero: { philosophy: 'floor' }, chassis: { wheelbase: 'long' } });
    const b = withSpec(docExampleSpec, { aero: { philosophy: 'wing' }, chassis: { wheelbase: 'short' } });
    expect(cost(a, regs)).toBe(cost(b, regs));
  });

  it.each(SPEC_PARAMS.map((p) => [p.path, p] as const))(
    'is convex in %s: (0.5→1.0 increase) > (0→0.5 increase)',
    (_path, p) => {
      const at = (x: number): number => {
        const spec = uniformSpec(0);
        const [group, key] = p.path.split('.') as [keyof CarSpec, string];
        return cost(setAt(spec, `${group}.${key}`, x) as CarSpec, regs);
      };
      expect(at(1) - at(0.5)).toBeGreaterThan(at(0.5) - at(0));
      expect(at(0.5)).toBeGreaterThan(at(0));
    },
  );
});

describe('validateSpec', () => {
  it('accepts the DESIGN.md §4 example spec', () => {
    const r = validateSpec(docExampleSpec, regs);
    expect(r).toEqual({ ok: true, value: docExampleSpec });
  });

  it('rejects a spec over the cost cap with a readable sentence', () => {
    const issues = issuesOf(uniformSpec(1));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('');
    expect(issues[0]?.message).toBe(
      'total cost 181.00 credits exceeds the cost cap of 100 credits by 81.00. ' +
        'Each item costs weight × value^2; the most expensive are ' +
        'aero.aero_efficiency 34.00, powertrain.thermal_efficiency 31.00, chassis.weight_reduction 24.00.',
    );
  });

  it('accepts a spec exactly at the cap', () => {
    // aero_efficiency만 x로 올려 정확히 캡에 맞춘다 (나머지는 캡을 넘지 않는 균등값).
    const others = SPEC_PARAMS.reduce((s, p) => s + (p.key === 'aero_efficiency' ? 0 : regs.cost.weights[p.key]), 0);
    const level = Math.sqrt((regs.cost.cap_credits - regs.cost.weights.aero_efficiency * 0.81) / others);
    const base = withSpec(uniformSpec(level), { aero: { aero_efficiency: 0 } });
    const rest = cost(base, regs);
    const x = Math.sqrt((regs.cost.cap_credits - rest) / regs.cost.weights.aero_efficiency);
    expect(x).toBeLessThanOrEqual(1);
    const spec = withSpec(base, { aero: { aero_efficiency: x } });
    expect(cost(spec, regs)).toBeCloseTo(100, 9);
    expect(validateSpec(spec, regs).ok).toBe(true);
  });

  it.each([
    ['chassis.mech_grip', 1.2, 'must be at most 1 (got 1.2)'],
    ['powertrain.cooling', -0.1, 'must be at least 0 (got -0.1)'],
    ['aero.drs_effect', 'high', 'expected a number, got "high"'],
    ['powertrain.reliability', Number.NaN, 'expected a number, got NaN'],
    ['chassis.weight_reduction', Number.POSITIVE_INFINITY, 'expected a number, got Infinity'],
    ['chassis.wheelbase', 'medium', 'must be one of "short", "long" (got "medium")'],
    ['aero.philosophy', undefined, 'missing required field (expected one of "floor", "wing")'],
    ['aero.aero_efficiency', undefined, 'missing required field (expected a number)'],
  ])('rejects %s = %s with an issue at that path', (path, value, message) => {
    expect(issuesOf(setAt(docExampleSpec, path, value))).toEqual([{ path, message }]);
  });

  it('rejects unknown fields at any depth, pointing at the field', () => {
    expect(issuesOf(setAt(docExampleSpec, 'turbo', true))).toEqual([
      { path: 'turbo', message: 'unknown field "turbo"; allowed fields are powertrain, chassis, aero' },
    ]);
    expect(issuesOf(setAt(docExampleSpec, 'powertrain.boost', 1))).toEqual([
      {
        path: 'powertrain.boost',
        message: 'unknown field "boost"; allowed fields are thermal_efficiency, reliability, ers_capacity, cooling',
      },
    ]);
  });

  it('reports every schema problem at once so one resubmission can fix them all', () => {
    const bad = {
      powertrain: { thermal_efficiency: 2, reliability: 0.5, ers_capacity: 0.5 },
      chassis: { weight_reduction: 0.5, mech_grip: 0.5, tire_management: 0.5, wheelbase: 'long', x: 1 },
      aero: { aero_efficiency: 0.5, philosophy: 'wing', dirty_air_resistance: 0.5, drs_effect: -1 },
    };
    expect(issuesOf(bad).map(formatIssue)).toEqual([
      'powertrain.thermal_efficiency: must be at most 1 (got 2)',
      'powertrain.cooling: missing required field (expected a number)',
      'chassis.x: unknown field "x"; allowed fields are weight_reduction, mech_grip, tire_management, wheelbase',
      'aero.drs_effect: must be at least 0 (got -1)',
    ]);
  });

  it.each([[null], [42], ['spec'], [[]], [undefined]])('rejects a non-object spec (%j)', (input) => {
    const issues = issuesOf(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('');
    expect(issues[0]?.message).toMatch(/expected an object/);
  });

  it('property: any in-range spec within the cap is accepted unchanged', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        fc.pre(cost(spec, regs) <= regs.cost.cap_credits);
        expect(validateSpec(spec, regs)).toEqual({ ok: true, value: spec });
      }),
    );
  });

  it('property: pushing one parameter out of range yields exactly one issue at its path', () => {
    const outOfRange = fc.oneof(
      fc.double({ min: 1.000001, max: 1e6, noNaN: true }),
      fc.double({ min: -1e6, max: -0.000001, noNaN: true }),
    );
    const param = fc.constantFrom(...SPEC_PARAMS);
    fc.assert(
      fc.property(specArb, param, outOfRange, (spec, p, value) => {
        const issues = issuesOf(setAt(spec, p.path, value));
        expect(issues).toHaveLength(1);
        expect(issues[0]?.path).toBe(p.path);
      }),
    );
  });

  it('does not mutate its input', () => {
    const input = structuredClone(docExampleSpec);
    validateSpec(input, regs);
    expect(input).toEqual(docExampleSpec);
  });
});
