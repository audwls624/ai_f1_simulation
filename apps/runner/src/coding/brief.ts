/**
 * 코딩 에이전트 팀의 안내문 (DESIGN.md 9절): BRIEF.md(시즌 내내 같음)와 TASK.md(호출마다).
 * 게임 설명은 공개 문서(2·3·4·7·8절)의 정성적 내용만 — 엔진 모델 계수(model/<season>.yaml)는 넣지 않는다.
 * 모든 코딩 에이전트 팀이 같은 문서를 받는다.
 */
import type { GPPacket, PreseasonPacket } from '@f1sim/agents';

export const BRIEF = `# f1sim team brief

You are the technical director and race strategist of one team in f1sim, a deterministic Formula-1-style simulation. Ten teams build cars under the same regulations and submit plans before every Grand Prix; an engine then runs qualifying and the race with no further input from anyone. Every in-race decision must therefore be written in advance as rules in the strategy language below. Your goal is to finish the season with as many championship points as possible.

## How a call works

The runner calls your team once in the preseason (design the car) and once before every GP (plan the race). For each call it writes into this directory:

- \`TASK.md\`: what this call asks, your budgets and time limit.
- \`packet.json\`: the information packet. Its \`rules\` object is the complete public regulations (cost cap and weights, tyre allocation, pace modes, points, penalties, tool budgets, engine fallbacks, strategy limits). All teams get identically structured packets.
- \`schemas/\`: JSON Schemas of what you submit (\`car-spec.schema.json\`, \`gp-plan.schema.json\`, \`setup.schema.json\`). Unknown fields are rejected.

You work with one command, \`./f1sim\`:

\`\`\`
./f1sim status
./f1sim wind-tunnel --spec spec.json --setup '{"wing_level":5,"ride_height":"mid","ers_mode":"balanced"}' --track mixed
./f1sim strategy-sim --plan plan.json --samples 20
./f1sim submit plan.json
\`\`\`

Arguments take a file path or inline JSON. Results are JSON on stdout. Budgets are counted by the runner: a run over budget is refused and changes nothing; invalid input is refused without using a run. \`submit\` validates immediately. If it is rejected you see the error list and may submit once more; if that also fails, the defaults in \`rules.fallback\` are used (for the car spec, also a back-of-the-grid start in GP 1). Stop as soon as a submission is accepted. Calls that run past the time limit (\`rules.penalties.response_timeout_s\`) count as failed.

This directory is yours for the whole season: keep notes, scripts and data here if they help later calls. Work only inside it — other teams' directories and the engine's source code are off limits. The engine's internal coefficients are not public; you learn how the car behaves only through the tools.

## Car spec (all continuous values 0.0–1.0)

cost = Σ weight × value^exponent over the ten continuous parameters (\`rules.cost\`), and it must not exceed the cap. Credits left unspent earn nothing. The spec is fixed for the whole season.

Powertrain
- \`thermal_efficiency\`: more power and less fuel per lap (lighter at the start). Most expensive engine item; slightly more failures.
- \`reliability\`: fewer mechanical failures (a failure retires the car). Slightly less power.
- \`ers_capacity\`: more energy deployed and recovered per lap, which helps overtaking and defending. Adds battery weight.
- \`cooling\`: keeps full power when the air temperature is 30 °C or more; without it, hot races cost power and raise failure rates. Adds drag.

Chassis
- \`weight_reduction\`: down to the minimum weight (0.0 is 30 kg heavier; about 0.03 s per lap per kg).
- \`mech_grip\`: low-speed corners, traction, kerbs and bumps.
- \`tire_management\`: slower tyre wear and longer stints, but slower warm-up (one-lap qualifying pace and the first two race laps suffer).
- \`wheelbase\`: long = high-speed stability and a better aero platform; short = agility in slow corners. Costs nothing, cannot change.

Aero
- \`aero_efficiency\`: less drag for the same downforce (the whole lift/drag curve improves). The most expensive item.
- \`philosophy\`: floor = more efficient but a narrow setup window, sensitive to bumps and ride height, and it wants good mech_grip (below about 0.5, or on bumpy tracks, the car becomes unstable: slower and harder on tyres); wing = stable. Costs nothing, cannot change.
- \`dirty_air_resistance\`: loses less downforce behind another car, which helps overtaking.
- \`drs_effect\`: larger drag reduction with DRS open; slightly less efficient.

Wind tunnel: runs one candidate spec + setup on one calendar track and returns the base lap time split into straights and low/medium/high-speed corners, a tyre wear estimate and small measurement noise. Each run shows one point of the design space, so plan your exploration. The calendar's track profiles (straight ratio, corner mix, tyre severity, temperature, bumpiness, rain probability, safety-car rate, pit loss, overtaking difficulty) tell you what the season will ask of the car.

## Setup (per GP)

- \`wing_level\` 0–10: raises downforce and drag together along the car's efficiency curve.
- \`ride_height\` low / mid / high: a floor car only works at low; low is unstable on bumpy tracks.
- \`ers_mode\` harvest / balanced / attack, fixed for the race: attack is faster per lap but drains the battery (less overtake and defence boost later); harvest is slower but keeps the battery full.

Each GP packet includes your own car's wind tunnel summary on that track for wing levels 2, 5 and 8.

## Race engine

Qualifying is one lap on soft tyres (one soft set is used up) and sets the grid. Then the first matching variant of your GPPlan is fixed, and the race runs lap by lap: weather, safety car, your rules, lap times, overtakes (only within about 1 s of the car ahead, never under the safety car), failures, pit stops. A pit stop costs the track's pit loss, halved under the safety car. In a dry race you must use at least two dry compounds or receive a time penalty. Retired cars are classified behind finishers. Points go to the top ten (\`rules.points\`).

Engine fallbacks always act before your rules: worn-out tyres force a stop with a time loss; dry tyres on a wet track (or wet tyres on a dry track) for several laps force a change; missing the two-compound rule near the end forces a stop. They prevent disasters but are slower than handling the situation yourself.

## Strategy language (GPPlan)

- \`setup\`, then \`variants\`: checked top to bottom after qualifying; the first match is used; give the last one \`"when": {}\` as the default. Variant conditions: \`grid_lte\`, \`grid_gte\` only.
- Each variant's \`plan\`: \`start_compound\` (must equal the first stint's compound), \`pace\` (push / normal / conserve), \`stints\` (compound + \`planned_pit_lap\`; increasing, inside the race, none on the last stint), \`rules\`.
- Rules are evaluated for your car at the start of every lap. Conditions inside one \`when\` are ANDed; only the first matching rule fires. Conditions: \`lap_gte\`, \`lap_lte\`, \`lap_between\` [a, b], \`laps_remaining_lte\`, \`event\` (safety_car, safety_car_end, rain_start, rain_stop — visible on the lap they happen), \`surface\` (dry / damp / wet), \`tire_life_lte\` (0–1), \`tire_age_gte\`, \`tire_compound\`, \`laps_on_compound_gte\`, \`position_lte\`, \`position_gte\`, \`gap_ahead_lte\`, \`gap_behind_lte\`, \`gap_behind_gte\` (seconds), \`rival_ahead_pitted\`, \`rival_behind_pitted\` (the adjacent car pitted last lap), \`stint_index_eq\` (from 0).
- Actions, one per rule: \`{"pit": "<compound>"}\` or \`{"pit": "next_planned"}\` (ends the current stint; the next planned stint follows), \`{"pace": "push|normal|conserve"}\` (stays until changed), \`{"extend_stint": n}\` (moves the current planned pit lap n laps later), or \`"none"\` (blocks the rules below it). Planned pit laps still happen when a pace, extend or none rule matches; only a pit rule or a fallback replaces them.
- \`"once": true\` fires a rule a single time; \`"cooldown": n\` disables it for n laps after firing (not both). A pit rule with neither fires on every lap its condition holds — usually a bug.
- Pace modes change lap time, wear, fuel use and failure risk (\`rules.pace_modes\`). Compounds must come from your remaining sets (\`packet.tire_sets\`). Limits are in \`rules.strategy\`.

Strategy simulation: runs your GPPlan on this GP's track and forecast over several seeds against the other cars (rivals are modelled with a default spec and default strategy) and returns the position distribution, mean race time, retirements, fallbacks and pit stops. It does not use the real race's seed. Use it to catch rule mistakes and compare options; the budget does not allow a full search.

Public race logs of the previous GP (results, lap times, pit timing) come in later packets; rivals' specs and rules stay private.
`;

const minutes = (s: number) => `${Math.round(s / 60)} minutes`;

function header(team: string, title: string, timeoutS: number): string[] {
  return [`# f1sim — team ${team} — ${title}`, '', `Time limit: ${minutes(timeoutS)} from the start of this call. Read BRIEF.md if you have not yet.`, ''];
}

function retry(errors: readonly string[] | undefined): string[] {
  if (!errors) return [];
  return ['## Previous attempt for this call failed', '', ...errors.map((e) => `- ${e}`), '', 'This is your only resubmission.', ''];
}

export function designTask(packet: PreseasonPacket, errors?: readonly string[]): string {
  return [
    ...header(packet.team, `preseason ${packet.season}: design the car`, packet.rules.penalties.response_timeout_s),
    ...retry(errors),
    '## Inputs',
    '',
    `- \`packet.json\`: rules, the ${packet.calendar.length}-race calendar with track profiles, previous season (if any).`,
    '- `schemas/car-spec.schema.json`: the submission format.',
    '',
    '## Do',
    '',
    `1. Explore with \`./f1sim wind-tunnel\` (${packet.wind_tunnel_remaining} runs).`,
    '2. Write your car spec to a JSON file and run `./f1sim submit <file>`.',
    '3. If it is rejected, fix every error and submit once more. Stop when it is accepted.',
    '',
  ].join('\n');
}

export function planTask(packet: GPPacket, errors?: readonly string[]): string {
  return [
    ...header(packet.team, `GP ${packet.gp} (${packet.track_id}): plan the race`, packet.rules.penalties.response_timeout_s),
    ...retry(errors),
    '## Inputs',
    '',
    '- `packet.json`: track profile, forecast, your tyre sets, your spec and its wind tunnel summary here, standings, the previous GP public log.',
    '- `schemas/gp-plan.schema.json`: the submission format.',
    '',
    '## Do',
    '',
    `1. Check plans with \`./f1sim strategy-sim\` (${packet.strategy_sim_remaining} runs).`,
    '2. Write your GPPlan to a JSON file and run `./f1sim submit <file>`.',
    '3. If it is rejected, fix every error and submit once more. Stop when it is accepted.',
    '',
  ].join('\n');
}

/** 헤드리스 명령의 {prompt} 자리에 들어가는 짧은 지시. */
export function headlessPrompt(team: string): string {
  return (
    `You are team "${team}" in the f1sim racing game, and the current directory is your team workspace. ` +
    'Read TASK.md and BRIEF.md, then complete the task using the ./f1sim command. Work only inside this directory.'
  );
}
