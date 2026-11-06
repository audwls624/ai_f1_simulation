/**
 * 코딩 에이전트 팀 (DESIGN.md 9절): Cursor·Antigravity·OpenCode·Claude Code 같은 코딩 에이전트가 팀 워크스페이스에서
 * 호출 하나를 처리한다. 러너가 TASK.md·packet.json을 쓰고, 에이전트는 ./f1sim 명령으로 풍동·전략 시뮬을 쓰고 제출한다.
 *
 * - 헤드리스: command가 있으면 러너가 워크스페이스에서 띄우고 기다린다 ({prompt} 자리에 짧은 지시).
 * - 수동: command가 없으면 안내를 내보내고 제출이 올 때까지 기다린다 (사람이 에이전트를 직접 연다).
 * - 툴 횟수는 러너 쪽 DesignTools/PlanTools가 센다 (워크스페이스 파일로는 바꿀 수 없다).
 * - 제출은 받는 즉시 같은 검증 함수로 확인해 에이전트에게 결과를 돌려준다. 오케스트레이터도 같은 함수로 다시 검증한다.
 *   첫 제출이 걸리면 대화(프로세스)를 살려 둔 채 재제출을 기다린다 — 재제출 호출이 오면 그걸 받는다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import {
  ToolBudgetError,
  ToolInputError,
  type CallReport,
  type DesignTools,
  type GPPacket,
  type PlanTools,
  type PreseasonPacket,
  type Resubmission,
  type TeamAgent,
} from '@f1sim/agents';
import { CarSpecSchema, GPPlanSchema, SetupSchema, formatIssue, lint, validatePlan, validateSpec, type CarSpec, type GPPlan } from '@f1sim/core';
import { z } from 'zod';
import { BRIEF, designTask, headlessPrompt, planTask } from './brief.js';

const MS_PER_S = 1000;
const DEFAULT_POLL_MS = 100;
/** 제출이 받아들여진 뒤 에이전트가 스스로 끝낼 때까지 기다리는 시간. 넘으면 종료시킨다. */
const EXIT_GRACE_MS = 15_000;
const TOOL_SCRIPT = new URL('../../assets/f1sim-tool.mjs', import.meta.url);
const WRAPPER = '#!/bin/sh\nexec node "$(dirname "$0")/.f1sim/tool.mjs" "$@"\n';

export interface CodingAgentOptions {
  /** 에이전트 이름 (cursor, antigravity, opencode, claude-code …). kind = coding:<label>. */
  readonly label: string;
  /** SeasonLog teams[].model. */
  readonly model?: string;
  /** 이 팀의 워크스페이스 디렉터리 (시즌 내내 같은 곳). */
  readonly workspace: string;
  /** 헤드리스 명령 (argv). "{prompt}"는 짧은 지시로 바뀐다. 없으면 수동. */
  readonly command?: readonly string[];
  readonly onEvent?: (message: string) => void;
  readonly pollMs?: number;
}

type Handler = (args: unknown) => unknown;

interface CallSpec {
  readonly key: string;
  readonly title: string;
  readonly task: (errors?: readonly string[]) => string;
  readonly packet: PreseasonPacket | GPPacket;
  readonly timeoutS: number;
  readonly status: () => Record<string, unknown>;
  readonly tools: Readonly<Record<string, Handler>>;
  /** 제출 검증 (오케스트레이터와 같은 함수). */
  readonly check: (value: unknown) => { readonly errors: readonly string[]; readonly warnings: readonly string[] };
}

interface Submission {
  readonly requestId: string;
  readonly text: string;
}

interface Session {
  readonly key: string;
  readonly spec: CallSpec;
  child: ChildProcess | null;
  exited: boolean;
  timer: ReturnType<typeof setInterval> | null;
  readonly queue: Submission[];
  wake: (() => void) | null;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function issuesText(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`);
}

/** zod → JSON Schema (워크스페이스 schemas/). int의 ±2^53 범위는 뺀다. */
function schemaJson(schema: z.ZodType): string {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'maximum' && v === Number.MAX_SAFE_INTEGER) || (k === 'minimum' && v === Number.MIN_SAFE_INTEGER)) continue;
      out[k] = strip(v);
    }
    return out;
  };
  return `${JSON.stringify(strip(z.toJSONSchema(schema, { io: 'input' })), null, 1)}\n`;
}

export class CodingAgent implements TeamAgent {
  readonly kind: string;
  readonly model?: string;
  readonly #o: CodingAgentOptions;
  readonly #ipc: string;
  #session: Session | null = null;
  #report: CallReport | undefined;
  #attempt = 0;

  constructor(options: CodingAgentOptions) {
    this.#o = options;
    this.kind = `coding:${options.label}`;
    if (options.model !== undefined) this.model = options.model;
    this.#ipc = join(options.workspace, '.f1sim');
    this.#prepareWorkspace();
  }

  get workspace(): string {
    return this.#o.workspace;
  }

  takeReport(): CallReport | undefined {
    const r = this.#report;
    this.#report = undefined;
    return r;
  }

  designCar(packet: PreseasonPacket, tools: DesignTools, resubmission?: Resubmission): Promise<CarSpec> {
    const WindTunnelArgs = z.strictObject({ spec: z.unknown(), setup: z.unknown(), track_id: z.string() });
    return this.#call<CarSpec>(
      {
        key: 'preseason',
        title: 'preseason design',
        task: (errors) => designTask(packet, errors),
        packet,
        timeoutS: packet.rules.penalties.response_timeout_s,
        status: () => ({ team: packet.team, call: 'design_car', season: packet.season, wind_tunnel_remaining: tools.remaining }),
        tools: {
          'wind-tunnel': (args) => {
            const a = WindTunnelArgs.safeParse(args);
            if (!a.success) throw new ToolInputError('wind_tunnel', issuesText(a.error));
            // 스펙·셋업·트랙 검증은 풍동 툴이 한다 (ToolInputError, 횟수 차감 없음).
            const r = tools.windTunnel(a.data.spec as CarSpec, a.data.setup as GPPlan['setup'], a.data.track_id);
            return { ...r, runs_remaining: tools.remaining };
          },
        },
        check: (value) => {
          const r = validateSpec(value, packet.rules);
          return { errors: r.ok ? [] : r.issues.map(formatIssue), warnings: [] };
        },
      },
      resubmission,
    );
  }

  planGp(packet: GPPacket, tools: PlanTools, resubmission?: Resubmission): Promise<GPPlan> {
    const StrategySimArgs = z.strictObject({ plan: z.unknown(), n_samples: z.number().optional() });
    return this.#call<GPPlan>(
      {
        key: `gp${String(packet.gp).padStart(2, '0')}`,
        title: `GP ${packet.gp} (${packet.track_id})`,
        task: (errors) => planTask(packet, errors),
        packet,
        timeoutS: packet.rules.penalties.response_timeout_s,
        status: () => ({ team: packet.team, call: 'plan_gp', season: packet.season, gp: packet.gp, track_id: packet.track_id, strategy_sim_remaining: tools.remaining }),
        tools: {
          'strategy-sim': (args) => {
            const a = StrategySimArgs.safeParse(args);
            if (!a.success) throw new ToolInputError('strategy_sim', issuesText(a.error));
            const r = tools.strategySim(a.data.plan as GPPlan, a.data.n_samples);
            return { ...r, runs_remaining: tools.remaining };
          },
        },
        check: (value) => {
          const r = validatePlan(value, packet.rules, { laps: packet.profile.laps });
          return { errors: r.ok ? [] : r.issues.map(formatIssue), warnings: r.ok ? lint(r.value).map(formatIssue) : [] };
        },
      },
      resubmission,
    );
  }

  /** 떠 있는 에이전트 프로세스를 끝낸다 (시즌 끝, 중단). */
  dispose(): void {
    if (this.#session) this.#close(this.#session, true);
  }

  // ── 호출 ──────────────────────────────────────────────────────────────

  async #call<T>(spec: CallSpec, resubmission: Resubmission | undefined): Promise<T> {
    const deadline = performance.now() + spec.timeoutS * MS_PER_S;
    const current = this.#session;
    let session: Session;
    if (resubmission && current && current.key === spec.key && (!current.exited || current.queue.length > 0 || !this.#o.command)) {
      // 첫 제출이 거절된 대화가 살아 있다: 에이전트는 이미 오류를 받았다. 다음 제출을 기다린다.
      session = current;
      this.#o.onEvent?.(`${this.#label(spec)}: waiting for the resubmission`);
    } else {
      if (current) this.#close(current, true);
      session = this.#open(spec, resubmission?.errors);
    }
    const final = resubmission !== undefined;
    const sub = await this.#nextSubmission(session, deadline);

    let value: unknown;
    let errors: readonly string[];
    let warnings: readonly string[] = [];
    try {
      value = JSON.parse(sub.text);
      ({ errors, warnings } = spec.check(value));
    } catch (e) {
      value = undefined;
      errors = [`submission is not valid JSON: ${errorText(e)}`];
    }
    this.#report = { raw_response: sub.text };
    const accepted = errors.length === 0;
    this.#reply(sub.requestId, accepted, {
      accepted,
      ...(errors.length ? { errors } : {}),
      ...(warnings.length ? { warnings } : {}),
      next: accepted
        ? 'Accepted. This call is done — stop now.'
        : final
          ? 'Rejected again. The default from rules.fallback will be used. This call is done — stop now.'
          : 'Rejected. Fix every error and submit once more; this is your only resubmission.',
    }, accepted ? undefined : `submission rejected:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.#o.onEvent?.(`${this.#label(spec)}: submission ${accepted ? 'accepted' : `rejected (${errors.length} errors)`}`);
    if (accepted || final) this.#finish(session);
    if (value === undefined) throw new Error(errors[0]);
    return value as T;
  }

  #label(spec: CallSpec): string {
    return `${spec.packet.team} ${spec.title}`;
  }

  #open(spec: CallSpec, errors: readonly string[] | undefined): Session {
    for (const dir of ['inbox', 'outbox']) {
      rmSync(join(this.#ipc, dir), { recursive: true, force: true });
      mkdirSync(join(this.#ipc, dir), { recursive: true });
    }
    writeFileSync(join(this.#o.workspace, 'packet.json'), `${JSON.stringify(spec.packet, null, 1)}\n`);
    writeFileSync(join(this.#o.workspace, 'TASK.md'), spec.task(errors));
    const session: Session = { key: spec.key, spec, child: null, exited: false, timer: null, queue: [], wake: null };
    session.timer = setInterval(() => this.#poll(session), this.#o.pollMs ?? DEFAULT_POLL_MS);
    this.#session = session;
    this.#attempt += 1;

    const command = this.#o.command;
    if (command && command.length > 0) {
      const prompt = headlessPrompt(spec.packet.team);
      const [bin, ...args] = command.map((a) => a.replaceAll('{prompt}', prompt));
      const log = openSync(join(this.#ipc, 'logs', `${String(this.#attempt).padStart(3, '0')}-${spec.key}.log`), 'a');
      const child = spawn(bin ?? '', args, { cwd: this.#o.workspace, stdio: ['ignore', log, log] });
      closeSync(log);
      session.child = child;
      const done = () => {
        session.exited = true;
        session.wake?.();
      };
      child.once('exit', done);
      child.once('error', (e) => {
        this.#o.onEvent?.(`${this.#label(spec)}: could not start "${bin ?? ''}": ${e.message}`);
        done();
      });
      this.#o.onEvent?.(`${this.#label(spec)}: started ${bin ?? ''} in ${this.#o.workspace}`);
    } else {
      this.#o.onEvent?.(
        `${this.#label(spec)}: open ${this.#o.workspace} in the team's coding agent and ask it to follow TASK.md ` +
          `(time limit ${Math.round(spec.timeoutS / 60)} min)`,
      );
    }
    return session;
  }

  #nextSubmission(session: Session, deadline: number): Promise<Submission> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.wake = null;
        this.#close(session, true);
        reject(new Error(`no response within ${session.spec.timeoutS} s`));
      }, Math.max(0, deadline - performance.now()));
      const check = () => {
        const sub = session.queue.shift();
        if (sub) {
          clearTimeout(timeout);
          session.wake = null;
          resolve(sub);
          return;
        }
        if (session.exited && session.child) {
          // 헤드리스 에이전트가 제출 없이 끝났다. 남은 요청을 마저 읽고 판정한다.
          this.#poll(session);
          const late = session.queue.shift();
          clearTimeout(timeout);
          session.wake = null;
          if (late) resolve(late);
          else {
            this.#close(session, false);
            reject(new Error('the coding agent exited without submitting'));
          }
        }
      };
      session.wake = check;
      check();
    });
  }

  /** inbox의 요청을 이름 순(시간 순)으로 처리한다. submit은 큐에 넣고, 나머지는 바로 답한다. */
  #poll(session: Session): void {
    let names: string[];
    try {
      names = readdirSync(join(this.#ipc, 'inbox')).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(this.#ipc, 'inbox', name);
      let req: { id: string; command: string; args: unknown };
      try {
        req = z.strictObject({ id: z.string(), command: z.string(), args: z.unknown() }).parse(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        rmSync(path, { force: true });
        continue;
      }
      rmSync(path, { force: true });
      if (req.command === 'submit') {
        const text = z.strictObject({ text: z.string() }).safeParse(req.args);
        if (!text.success) this.#reply(req.id, false, undefined, 'submit: expected the file text');
        else session.queue.push({ requestId: req.id, text: text.data.text });
        continue;
      }
      if (req.command === 'status') {
        this.#reply(req.id, true, session.spec.status());
        continue;
      }
      const handler = session.spec.tools[req.command];
      if (!handler) {
        this.#reply(req.id, false, undefined, `"${req.command}" is not available in this call (${Object.keys(session.spec.tools).join(', ')}, submit, status)`);
        continue;
      }
      try {
        this.#reply(req.id, true, handler(req.args));
      } catch (e) {
        if (e instanceof ToolBudgetError || e instanceof ToolInputError) this.#reply(req.id, false, undefined, e.message);
        else {
          // 엔진 쪽 버그다. 에이전트에게는 알리고 (멈추지 않게), 러너 출력에도 남긴다.
          this.#reply(req.id, false, undefined, `internal error in ${req.command}: ${errorText(e)}`);
          this.#o.onEvent?.(`${this.#label(session.spec)}: internal error in ${req.command}: ${errorText(e)}`);
        }
      }
    }
    if (session.queue.length > 0) session.wake?.();
  }

  #reply(id: string, ok: boolean, result: unknown, error?: string): void {
    const tmp = join(this.#ipc, 'outbox', `${id}.tmp`);
    writeFileSync(tmp, JSON.stringify({ ok, ...(result !== undefined ? { result } : {}), ...(error !== undefined ? { error } : {}) }));
    renameSync(tmp, join(this.#ipc, 'outbox', `${id}.json`));
  }

  /** 받아들여졌거나 마지막 재제출이 끝났다: 요청은 그만 받고, 에이전트가 스스로 끝내게 잠깐 둔 뒤 종료시킨다. */
  #finish(session: Session): void {
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    const child = session.child;
    if (child && !session.exited) {
      const kill = setTimeout(() => child.kill('SIGTERM'), EXIT_GRACE_MS);
      kill.unref();
      child.once('exit', () => clearTimeout(kill));
    }
    if (this.#session === session) this.#session = null;
  }

  #close(session: Session, kill: boolean): void {
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    if (kill && session.child && !session.exited) session.child.kill('SIGTERM');
    if (this.#session === session) this.#session = null;
  }

  #prepareWorkspace(): void {
    const ws = this.#o.workspace;
    for (const dir of ['', 'schemas', '.f1sim', '.f1sim/inbox', '.f1sim/outbox', '.f1sim/logs']) mkdirSync(join(ws, dir), { recursive: true });
    writeFileSync(join(ws, 'BRIEF.md'), BRIEF);
    writeFileSync(join(ws, 'schemas', 'car-spec.schema.json'), schemaJson(CarSpecSchema));
    writeFileSync(join(ws, 'schemas', 'gp-plan.schema.json'), schemaJson(GPPlanSchema));
    writeFileSync(join(ws, 'schemas', 'setup.schema.json'), schemaJson(SetupSchema));
    copyFileSync(TOOL_SCRIPT, join(this.#ipc, 'tool.mjs'));
    writeFileSync(join(ws, 'f1sim'), WRAPPER);
    chmodSync(join(ws, 'f1sim'), 0o755);
  }
}
