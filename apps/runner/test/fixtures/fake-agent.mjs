// 테스트용 가짜 코딩 에이전트: 워크스페이스에서 TASK.md·packet.json을 읽고 ./f1sim으로 툴을 쓰고 제출한다.
// 모드 (argv[2]): good | bad-first | greedy | silent | slow | linger (제출이 받아들여진 뒤에도 30초 더 산다)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'good';
const f1sim = (...args) => spawnSync('./f1sim', args, { encoding: 'utf8' });
const packet = JSON.parse(readFileSync('packet.json', 'utf8'));
const rules = packet.rules;
const preseason = Array.isArray(packet.calendar);

writeFileSync('pid.txt', String(process.pid));
if (mode === 'silent') process.exit(0);
if (mode === 'slow') await new Promise((r) => setTimeout(r, 30_000));

readFileSync('TASK.md', 'utf8');
const status = JSON.parse(f1sim('status').stdout);
writeFileSync('status.json', JSON.stringify(status));

const half = {
  powertrain: { thermal_efficiency: 0.5, reliability: 0.5, ers_capacity: 0.5, cooling: 0.5 },
  chassis: { weight_reduction: 0.5, mech_grip: 0.5, tire_management: 0.5, wheelbase: 'long' },
  aero: { aero_efficiency: 0.5, philosophy: 'wing', dirty_air_resistance: 0.5, drs_effect: 0.5 },
};

function plan() {
  const pit = Math.round(packet.profile.laps * rules.fallback.plan.pit_at_fraction);
  return {
    setup: rules.fallback.setup,
    variants: [{ when: {}, plan: { start_compound: 'medium', pace: 'normal', stints: [{ compound: 'medium', planned_pit_lap: pit }, { compound: 'hard' }], rules: [] } }],
  };
}

function submit(answer) {
  writeFileSync('answer.json', JSON.stringify(answer));
  return f1sim('submit', 'answer.json');
}

if (preseason) {
  const track = packet.calendar[0].track_id;
  const runs = mode === 'greedy' ? status.wind_tunnel_remaining + 1 : 2;
  const results = [];
  for (let i = 0; i < runs; i++) results.push(f1sim('wind-tunnel', '--spec', JSON.stringify(half), '--setup', JSON.stringify(rules.fallback.setup), '--track', track));
  writeFileSync('notes.json', JSON.stringify(results.map((r) => ({ code: r.status, err: r.stderr.trim() }))));
  if (mode === 'bad-first') {
    const r = submit({ ...half, chassis: { ...half.chassis, mech_grip: 1.5 } });
    if (r.status === 0) process.exit(3);
  }
  const r = submit(half);
  if (mode === 'linger') await new Promise((res) => setTimeout(res, 30_000));
  process.exit(r.status === 0 ? 0 : 4);
} else {
  f1sim('strategy-sim', '--plan', JSON.stringify(plan()), '--samples', '3');
  if (mode === 'bad-first') {
    const r = submit({ ...plan(), setup: { ...rules.fallback.setup, wing_level: 12 } });
    if (r.status === 0) process.exit(3);
  }
  const r = submit(plan());
  process.exit(r.status === 0 ? 0 : 4);
}
