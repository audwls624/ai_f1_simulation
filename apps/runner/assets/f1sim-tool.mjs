// f1sim 팀 워크스페이스 툴 (DESIGN.md 9절). 코딩 에이전트가 셸에서 부르는 유일한 게임 툴이다.
// 엔진 코드는 없다: 요청을 .f1sim/inbox/<id>.json에 쓰고 러너가 .f1sim/outbox/<id>.json에 답하면 출력한다.
// 횟수·검증은 러너가 한다. 이 파일은 러너가 워크스페이스에 복사해 둔다 (.f1sim/tool.mjs, ./f1sim이 감싼다).
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HOME = resolve(dirname(fileURLToPath(import.meta.url)));
const POLL_MS = 50;
const WAIT_S = 300;

const USAGE = `usage (run from your team workspace):
  ./f1sim status                                          what this call is, budgets left, time left
  ./f1sim wind-tunnel --spec <file|json> --setup <file|json> --track <track_id>
  ./f1sim strategy-sim --plan <file|json> [--samples <n>]
  ./f1sim submit <file>                                   submit your final answer for this call
Results are JSON on stdout. Exit code 0 = ok, 1 = rejected or tool error (message on stderr), 2 = usage or protocol error.`;

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function jsonArg(name, value) {
  if (value === undefined) fail(`missing --${name}\n\n${USAGE}`, 2);
  const text = value.trimStart().startsWith('{') ? value : readText(value);
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`--${name}: not valid JSON (${e.message})`, 2);
  }
}

function readText(path) {
  try {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
  } catch (e) {
    fail(`cannot read ${path}: ${e.message}`, 2);
  }
}

function request(command, args) {
  const id = `${Date.now().toString().padStart(15, '0')}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const inbox = join(HOME, 'inbox');
  const outbox = join(HOME, 'outbox', `${id}.json`);
  writeFileSync(join(inbox, `${id}.tmp`), JSON.stringify({ id, command, args }));
  renameSync(join(inbox, `${id}.tmp`), join(inbox, `${id}.json`));
  const started = Date.now();
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(outbox)) {
    if (Date.now() - started > WAIT_S * 1000) fail('no answer from the f1sim runner — is a call active? (./f1sim status)', 2);
    Atomics.wait(wait, 0, 0, POLL_MS);
  }
  const reply = JSON.parse(readFileSync(outbox, 'utf8'));
  rmSync(outbox, { force: true });
  return reply;
}

const [command, ...rest] = process.argv.slice(2);
let args;
switch (command) {
  case 'status':
    args = {};
    break;
  case 'wind-tunnel': {
    const { values } = parseArgs({ args: rest, options: { spec: { type: 'string' }, setup: { type: 'string' }, track: { type: 'string' } } });
    if (!values.track) fail(`missing --track\n\n${USAGE}`, 2);
    args = { spec: jsonArg('spec', values.spec), setup: jsonArg('setup', values.setup), track_id: values.track };
    break;
  }
  case 'strategy-sim': {
    const { values } = parseArgs({ args: rest, options: { plan: { type: 'string' }, samples: { type: 'string' } } });
    args = { plan: jsonArg('plan', values.plan), ...(values.samples !== undefined ? { n_samples: Number(values.samples) } : {}) };
    break;
  }
  case 'submit': {
    if (rest.length !== 1) fail(`submit takes one file\n\n${USAGE}`, 2);
    args = { text: readText(rest[0]) };
    break;
  }
  case undefined:
  case 'help':
  case '--help':
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
    break;
  default:
    fail(`unknown command "${command}"\n\n${USAGE}`, 2);
}

const reply = request(command, args);
if (reply.ok) {
  process.stdout.write(`${JSON.stringify(reply.result, null, 1)}\n`);
} else {
  if (reply.result !== undefined) process.stdout.write(`${JSON.stringify(reply.result, null, 1)}\n`);
  fail(reply.error, 1);
}
