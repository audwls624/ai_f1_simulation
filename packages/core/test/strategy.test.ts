import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  evaluateRules,
  initialRuleState,
  lint,
  matches,
  nextPlannedCompound,
  raceSets,
  selectVariant,
  validatePlan,
  type GPPlan,
  type RacePlan,
  type RuleView,
} from '../src/strategy.js';
import { regs } from './helpers.js';

/** DESIGN.md 8절 예시 그대로 (yaml 앵커 포함). */
const DOC_EXAMPLE = `
setup:
  wing_level: 6
  ride_height: low
  ers_mode: balanced

variants:
  - when: {grid_lte: 5}
    plan: &defend
      start_compound: medium
      pace: normal
      stints:
        - {compound: medium, planned_pit_lap: 24}
        - {compound: hard}
      rules:
        - when: {event: safety_car, lap_between: [12, 40], tire_age_gte: 8}
          do: {pit: hard}
          once: true
        - when: {rival_behind_pitted: true, lap_gte: 18, tire_life_lte: 0.5}
          do: {pit: hard}
          once: true
        - when: {event: rain_start}
          do: {pit: inter}
        - when: {surface: dry, tire_compound: inter, laps_on_compound_gte: 2}
          do: {pit: next_planned}
        - when: {laps_remaining_lte: 8, position_lte: 3, gap_behind_gte: 4.0}
          do: {pace: conserve}
  - when: {}
    plan:
      start_compound: soft
      pace: push
      stints:
        - {compound: soft, planned_pit_lap: 14}
        - {compound: hard, planned_pit_lap: 38}
        - {compound: medium}
      rules:
        - when: {event: safety_car}
          do: {pit: next_planned}
          cooldown: 10
`;

const docPlan = (): GPPlan => parse(DOC_EXAMPLE) as GPPlan;
const issues = (plan: unknown, laps = 57) => {
  const r = validatePlan(plan, regs, { laps });
  return r.ok ? [] : r.issues;
};
const clone = <T>(x: T): T => structuredClone(x);

describe('validatePlan (DESIGN.md §8, §9)', () => {
  it('accepts the §8 example', () => {
    expect(issues(docPlan())).toEqual([]);
  });

  it('rejects unknown fields with a path and the allowed vocabulary', () => {
    const p = clone(docPlan()) as unknown as { variants: { plan: { rules: { when: Record<string, unknown> }[] } }[] };
    const rule = p.variants[0]?.plan.rules[3];
    if (rule) rule.when.gap_to_leader = 2;
    const [issue] = issues(p);
    expect(issue?.path).toBe('variants[0].plan.rules[3].when.gap_to_leader');
    expect(issue?.message).toMatch(/^unknown field "gap_to_leader"; allowed fields are lap_gte, /);
  });

  it('grid_* only in variants.when, the rest only in rules.when', () => {
    const inRules = clone(docPlan()) as unknown as { variants: { when: Record<string, unknown>; plan: { rules: { when: Record<string, unknown> }[] } }[] };
    const r0 = inRules.variants[0]?.plan.rules[0];
    if (r0) r0.when.grid_lte = 3;
    expect(issues(inRules)[0]?.path).toBe('variants[0].plan.rules[0].when.grid_lte');
    const inVariant = clone(docPlan()) as unknown as { variants: { when: Record<string, unknown> }[] };
    const v0 = inVariant.variants[0];
    if (v0) v0.when.lap_gte = 3;
    expect(issues(inVariant)[0]?.path).toBe('variants[0].when.lap_gte');
  });

  it('explains a malformed action', () => {
    const p = clone(docPlan()) as unknown as { variants: { plan: { rules: { do: unknown }[] } }[] };
    const r0 = p.variants[0]?.plan.rules[0];
    if (r0) r0.do = { pit: 'supersoft' };
    expect(issues(p)).toEqual([
      expect.objectContaining({ path: 'variants[0].plan.rules[0].do', message: expect.stringContaining('{pit: <compound>}') }),
    ]);
  });

  it('enforces the §8 limits', () => {
    const many = clone(docPlan());
    const v1 = many.variants[1];
    if (!v1) throw new Error('no variant');
    many.variants = [v1, v1, v1, v1, v1];
    expect(issues(many).map((i) => i.path)).toContain('variants');

    const rules = clone(docPlan());
    const plan = rules.variants[1]?.plan as RacePlan;
    plan.rules = Array.from({ length: 13 }, () => ({ when: { lap_gte: 2 }, do: { pace: 'normal' as const } }));
    expect(issues(rules).map((i) => i.path)).toContain('variants[1].plan.rules');

    const conds = clone(docPlan());
    const rule = conds.variants[1]?.plan.rules[0];
    if (rule) rule.when = { lap_gte: 2, lap_lte: 50, surface: 'dry', position_lte: 5, tire_age_gte: 3 };
    expect(issues(conds).map((i) => i.path)).toContain('variants[1].plan.rules[0].when');
  });

  it('checks stints: start compound, increasing pit laps, last stint, race length', () => {
    const p = clone(docPlan());
    const plan = p.variants[1]?.plan as RacePlan;
    plan.start_compound = 'medium';
    plan.stints = [
      { compound: 'soft', planned_pit_lap: 20 },
      { compound: 'hard', planned_pit_lap: 15 },
      { compound: 'medium', planned_pit_lap: 50 },
    ];
    expect(issues(p).map((i) => i.message)).toEqual([
      'must match the first stint\'s compound "soft" (got "medium")',
      'must be later than the previous planned pit lap 20',
      'the last stint cannot have a planned pit lap (no stint follows it)',
    ]);
    const late = clone(docPlan());
    const s0 = late.variants[0]?.plan.stints[0];
    if (s0) s0.planned_pit_lap = 60;
    expect(issues(late, 57)[0]?.message).toBe('must be before the last lap (race has 57 laps)');
  });

  it('stays within the tyre allocation for the race (after qualifying)', () => {
    const sets = raceSets(regs);
    expect(sets.soft).toBe(regs.tires.allocation_sets.soft - regs.tires.qualifying.sets);
    const p = clone(docPlan());
    const plan = p.variants[1]?.plan as RacePlan;
    plan.stints = [
      { compound: 'soft', planned_pit_lap: 10 },
      { compound: 'hard', planned_pit_lap: 20 },
      { compound: 'hard', planned_pit_lap: 30 },
      { compound: 'hard' },
    ];
    expect(issues(p)[0]?.message).toBe(`plans 3 hard stints but only ${sets.hard} hard sets are available for the race`);
  });

  it('rejects once together with cooldown', () => {
    const p = clone(docPlan());
    const rule = p.variants[1]?.plan.rules[0];
    if (rule) rule.once = true;
    expect(issues(p)[0]?.message).toBe('use either once or cooldown, not both');
  });
});

describe('lint', () => {
  it('warns about pit rules that can fire every lap', () => {
    expect(lint(docPlan()).map((w) => w.path)).toEqual(['variants[0].plan.rules[2]', 'variants[0].plan.rules[3]']);
  });

  it('warns about rules shadowed by an unconditional rule and a conditional default variant', () => {
    const p = clone(docPlan());
    const plan = p.variants[1]?.plan as RacePlan;
    plan.rules = [{ when: {}, do: { pace: 'push' } }, { when: { lap_gte: 30 }, do: { pace: 'conserve' } }];
    const last = p.variants[1];
    if (last) last.when = { grid_gte: 6 };
    const paths = lint(p).map((w) => w.path);
    expect(paths).toContain('variants[1].plan.rules[0]');
    expect(paths).toContain('variants[1].when');
  });
});

describe('selectVariant (DESIGN.md §7)', () => {
  it('first match from the top, else the last variant', () => {
    expect(selectVariant(docPlan(), 3).index).toBe(0);
    expect(selectVariant(docPlan(), 5).index).toBe(0);
    expect(selectVariant(docPlan(), 6).index).toBe(1);
    const strict = clone(docPlan());
    const last = strict.variants[1];
    if (last) last.when = { grid_lte: 2 };
    expect(selectVariant(strict, 10).index).toBe(1);
  });
});

describe('evaluateRules (DESIGN.md §8 semantics)', () => {
  const view = (patch: Partial<RuleView> = {}): RuleView => ({
    lap: 20,
    laps_remaining: 37,
    events: new Set(),
    surface: 'dry',
    tire_life: 0.6,
    tire_age: 10,
    tire_compound: 'medium',
    laps_on_compound: 10,
    position: 4,
    gap_ahead: 1.2,
    gap_behind: 2.5,
    rival_ahead_pitted: false,
    rival_behind_pitted: false,
    stint_index: 0,
    ...patch,
  });
  const defend = () => docPlan().variants[0]?.plan as RacePlan;

  it('first match only', () => {
    const plan = defend();
    const v = view({ events: new Set(['safety_car', 'rain_start']) });
    const r = evaluateRules(plan, v, initialRuleState(plan));
    expect(r.fired).toEqual({ index: 0, action: { pit: 'hard' } });
  });

  it('once disables the rule for the rest of the race', () => {
    const plan = defend();
    const v = view({ events: new Set(['safety_car']) });
    const first = evaluateRules(plan, v, initialRuleState(plan));
    const again = evaluateRules(plan, { ...v, lap: 30 }, first.state);
    expect(again.fired).toBeNull();
  });

  it('cooldown n disables the rule for the next n laps, then it can fire again', () => {
    const plan = docPlan().variants[1]?.plan as RacePlan;
    const sc = (lap: number) => view({ lap, events: new Set(['safety_car']) });
    const a = evaluateRules(plan, sc(10), initialRuleState(plan));
    expect(a.fired?.index).toBe(0);
    expect(evaluateRules(plan, sc(15), a.state).fired).toBeNull();
    expect(evaluateRules(plan, sc(20), a.state).fired).toBeNull();
    expect(evaluateRules(plan, sc(21), a.state).fired?.index).toBe(0);
  });

  it('a disabled rule lets the next matching rule fire; no match → null', () => {
    const plan = defend();
    const v = view({ events: new Set(['safety_car', 'rain_start']) });
    const first = evaluateRules(plan, v, initialRuleState(plan));
    expect(evaluateRules(plan, { ...v, lap: 25 }, first.state).fired).toEqual({ index: 2, action: { pit: 'inter' } });
    expect(evaluateRules(plan, view(), initialRuleState(plan)).fired).toBeNull();
  });

  it('matches every trigger type', () => {
    expect(matches({ lap_between: [10, 20], laps_remaining_lte: 40 }, view())).toBe(true);
    expect(matches({ lap_between: [21, 30] }, view())).toBe(false);
    expect(matches({ tire_life_lte: 0.5 }, view())).toBe(false);
    expect(matches({ tire_compound: 'medium', laps_on_compound_gte: 10, stint_index_eq: 0 }, view())).toBe(true);
    expect(matches({ position_gte: 5 }, view())).toBe(false);
    expect(matches({ gap_ahead_lte: 1.5, gap_behind_gte: 2 }, view())).toBe(true);
    expect(matches({ gap_behind_lte: 1 }, view({ gap_behind: Infinity }))).toBe(false);
    expect(matches({ rival_ahead_pitted: true }, view({ rival_ahead_pitted: true }))).toBe(true);
    expect(matches({ surface: 'wet' }, view())).toBe(false);
    expect(matches({}, view())).toBe(true);
  });

  it('next planned compound falls back to hard', () => {
    const plan = defend();
    expect(nextPlannedCompound(plan, 0)).toBe('hard');
    expect(nextPlannedCompound(plan, 1)).toBe('hard');
    expect(nextPlannedCompound(docPlan().variants[1]?.plan as RacePlan, 0)).toBe('hard');
    expect(nextPlannedCompound(docPlan().variants[1]?.plan as RacePlan, 1)).toBe('medium');
  });
});
