/**
 * 2D 리플레이 뷰어 (DESIGN.md 13절 apps/web — 3D는 M7). 시즌·GP를 고르면 race.json과 트랙을 읽어
 * 트랙 지도 위에 차를 움직이고, 순위표·이벤트를 그 시각에 맞춘다.
 */
import { RaceLogSchema, derive, lapProgress, parseRegulations, parseTrack, parseTrackMeta, type RaceEventLog } from '@f1sim/core';
import { NEUTRAL, SERIES, colorSlots, shortCodes, type TeamRef } from './colors.js';
import { buildReplay, carPosition, eventsUntil, raceLap, tower, trackPoint, type Replay } from './replay.js';

interface RunGp {
  readonly gp: number;
  readonly track: string;
  readonly path: string;
}
interface Run {
  readonly id: string;
  readonly season: number | null;
  readonly teams: readonly (TeamRef & { readonly model?: string })[];
  readonly gps: readonly RunGp[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const runSel = $<HTMLSelectElement>('run');
const gpSel = $<HTMLSelectElement>('gp');
const canvas = $<HTMLCanvasElement>('map');
const tip = $<HTMLDivElement>('tip');
const empty = $<HTMLParagraphElement>('empty');
const playBtn = $<HTMLButtonElement>('play');
const scrub = $<HTMLInputElement>('scrub');
const clock = $<HTMLSpanElement>('clock');
const speedSel = $<HTMLSelectElement>('speed');
const towerBody = $<HTMLTableSectionElement>('tower');
const eventsList = $<HTMLOListElement>('events');
const statusEl = $<HTMLDivElement>('status');
const titleEl = $<HTMLHeadingElement>('title');

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let runs: Run[] = [];
let replay: Replay | null = null;
let colors = new Map<string, string>();
let codes = new Map<string, string>();
let t = 0;
let playing = false;
let last = 0;

const PIT_OFFSET_PX = 16;
const COMPOUND_LETTER: Record<string, string> = { soft: 'S', medium: 'M', hard: 'H', inter: 'I', wet: 'W' };
const SURFACE_LABEL: Record<string, string> = { dry: '건조', damp: '젖음', wet: '웨트' };

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function teamColor(team: string): string {
  return colors.get(team) ?? (dark.matches ? NEUTRAL.dark : NEUTRAL.light);
}

function assignColors(teams: readonly TeamRef[]): void {
  const slots = colorSlots(teams);
  const palette = dark.matches ? SERIES.dark : SERIES.light;
  colors = new Map();
  for (const [team, slot] of slots) if (slot !== null) colors.set(team, palette[slot] ?? NEUTRAL.light);
  codes = shortCodes(teams.map((x) => x.team));
}

// ── 데이터 ──────────────────────────────────────────────────────────────

async function text(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}

async function loadRuns(): Promise<void> {
  runs = (await (await fetch('/api/runs')).json()) as Run[];
  runSel.replaceChildren(...runs.map((r) => new Option(r.id, r.id)));
  if (runs.length === 0) {
    empty.textContent = 'runs/에 레이스가 없습니다. pnpm -F @f1sim/runner season 으로 먼저 시즌을 돌리세요.';
    empty.hidden = false;
    return;
  }
  const params = new URLSearchParams(location.search);
  runSel.value = params.get('run') ?? runs.at(-1)?.id ?? '';
  fillGps(Number(params.get('gp') ?? 0));
  await loadRace();
}

function fillGps(gp: number): void {
  const run = runs.find((r) => r.id === runSel.value);
  gpSel.replaceChildren(...(run?.gps ?? []).map((g) => new Option(`${g.gp} · ${g.track}`, String(g.gp))));
  if (gp && run?.gps.some((g) => g.gp === gp)) gpSel.value = String(gp);
}

async function loadRace(): Promise<void> {
  const run = runs.find((r) => r.id === runSel.value);
  const entry = run?.gps.find((g) => String(g.gp) === gpSel.value) ?? run?.gps[0];
  if (!run || !entry) return;
  history.replaceState(null, '', `?run=${encodeURIComponent(run.id)}&gp=${entry.gp}`);
  const log = RaceLogSchema.parse(JSON.parse(await text(`/runs/${entry.path}`)));
  const season = log.meta.season;
  const [rules, model, csv, meta] = await Promise.all([
    text(`/data/regulations/${season}.yaml`),
    text(`/data/model/${season}.yaml`),
    text(`/data/tracks/${log.meta.track}.csv`),
    text(`/data/tracks/${log.meta.track}.yaml`),
  ]);
  const regs = parseRegulations(rules, model);
  const track = parseTrack(csv, parseTrackMeta(meta), regs);
  // 랩 안 속도 곡선은 기준 차(규정의 기본 스펙·셋업)의 것. 차마다의 차이는 랩 시간에 이미 들어 있다.
  const progress = lapProgress(derive(regs.fallback.spec, regs.fallback.setup, track, regs), track, 'dry', regs);
  replay = buildReplay(log, track, progress);
  const teams: TeamRef[] = run.teams.length > 0 ? [...run.teams] : log.cars.map((c) => ({ team: c.team, agent: 'unknown' }));
  assignColors(teams);
  titleEl.textContent = `GP ${log.meta.gp} · ${log.meta.track} · ${log.meta.laps}랩 · ${log.meta.weather_realized.temp_c.toFixed(0)}°C`;
  scrub.max = String(replay.duration);
  t = 0;
  setPlaying(false);
  empty.hidden = true;
  render();
}

// ── 그리기 ──────────────────────────────────────────────────────────────

interface View {
  readonly w: number;
  readonly h: number;
  readonly toPx: (x: number, y: number) => [number, number];
}

function view(r: Replay): View {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  const pad = 48;
  const minX = Math.min(...r.track.xs);
  const maxX = Math.max(...r.track.xs);
  const minY = Math.min(...r.track.ys);
  const maxY = Math.max(...r.track.ys);
  const scale = Math.min((rect.width - 2 * pad) / (maxX - minX || 1), (rect.height - 2 * pad) / (maxY - minY || 1));
  const ox = (rect.width - (maxX - minX) * scale) / 2;
  const oy = (rect.height - (maxY - minY) * scale) / 2;
  return { w: rect.width, h: rect.height, toPx: (x, y) => [ox + (x - minX) * scale, rect.height - (oy + (y - minY) * scale)] };
}

function drawTrack(ctx: CanvasRenderingContext2D, r: Replay, v: View): void {
  const n = r.track.xs.length;
  const path = new Path2D();
  for (let i = 0; i <= n; i++) {
    const [x, y] = v.toPx(r.track.xs[i % n] ?? 0, r.track.ys[i % n] ?? 0);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  ctx.lineJoin = 'round';
  ctx.strokeStyle = css('--track-edge');
  ctx.lineWidth = 14;
  ctx.stroke(path);
  ctx.strokeStyle = css('--track');
  ctx.lineWidth = 10;
  ctx.stroke(path);
  // DRS 구간: 가는 점선
  ctx.strokeStyle = css('--drs');
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  for (let i = 0; i < n; i++) {
    if (!r.track.drs[i]) continue;
    const [x1, y1] = v.toPx(r.track.xs[i] ?? 0, r.track.ys[i] ?? 0);
    const [x2, y2] = v.toPx(r.track.xs[(i + 1) % n] ?? 0, r.track.ys[(i + 1) % n] ?? 0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // 출발선
  const [ax, ay] = v.toPx(r.track.xs[0] ?? 0, r.track.ys[0] ?? 0);
  const [bx, by] = v.toPx(r.track.xs[1] ?? 0, r.track.ys[1] ?? 0);
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const nx = -(by - ay) / len;
  const ny = (bx - ax) / len;
  ctx.strokeStyle = css('--text-primary');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ax - nx * 10, ay - ny * 10);
  ctx.lineTo(ax + nx * 10, ay + ny * 10);
  ctx.stroke();
  ctx.fillStyle = css('--text-secondary');
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('S/F', ax + nx * 14 + 2, ay + ny * 14 + 4);
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const LABEL_H = 12;
/** 점 주위 후보 자리 (오른쪽 위부터). 겹치지 않는 첫 자리, 없으면 바깥으로 계속 쌓는다. */
function placeLabel(w: number, x: number, y: number, placed: Rect[]): [number, number] {
  const candidates: [number, number][] = [
    [x + 9, y - 7],
    [x + 9, y + 15],
    [x - 9 - w, y - 7],
    [x - 9 - w, y + 15],
  ];
  for (let k = 1; k <= 6; k++) candidates.push([x + 9, y - 7 - k * LABEL_H], [x + 9, y + 15 + k * LABEL_H]);
  const free = ([lx, ly]: [number, number]) =>
    placed.every((q) => lx + w < q.x || q.x + q.w < lx || ly < q.y || q.y + q.h < ly - LABEL_H);
  const spot = candidates.find(free) ?? candidates[0] ?? [x + 9, y - 7];
  placed.push({ x: spot[0], y: spot[1] - LABEL_H, w, h: LABEL_H });
  return spot;
}

interface Dot {
  readonly team: string;
  readonly x: number;
  readonly y: number;
}

function drawCars(ctx: CanvasRenderingContext2D, r: Replay, v: View): Dot[] {
  const surface = css('--surface-1');
  const ink = css('--text-primary');
  const muted = css('--text-muted');
  const items = tower(r, t).flatMap((row) => {
    const car = r.cars.find((c) => c.team === row.team);
    if (!car) return [];
    const p = carPosition(r, car, t);
    const pt = trackPoint(r.track, p.s);
    let [x, y] = v.toPx(pt.x, pt.y);
    if (p.state === 'pit') {
      // 피트: 출발선 옆(피트 레인 쪽)으로 비켜 놓는다.
      const [bx, by] = v.toPx(r.track.xs[1] ?? 0, r.track.ys[1] ?? 0);
      const len = Math.hypot(bx - x, by - y) || 1;
      const [nx, ny] = [-(by - y) / len, (bx - x) / len];
      x += nx * PIT_OFFSET_PX;
      y += ny * PIT_OFFSET_PX;
    }
    return [{ row, x, y, out: p.state === 'retired', label: `${codes.get(row.team) ?? row.team}${p.state === 'pit' ? ' PIT' : ''}` }];
  });
  // 점은 뒤에서부터 그려 선두가 위에 온다.
  for (const it of [...items].reverse()) {
    ctx.beginPath();
    ctx.arc(it.x, it.y, 6, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = surface;
    ctx.fillStyle = it.out ? surface : teamColor(it.row.team);
    ctx.fill();
    ctx.stroke();
    if (it.out) {
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(it.x, it.y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // 라벨은 앞에서부터 자리를 잡는다 (선두가 가장 좋은 자리).
  const placed: Rect[] = [];
  for (const it of items) {
    ctx.font = `${it.row.pos === 1 ? '600 ' : ''}11px system-ui, sans-serif`;
    const [lx, ly] = placeLabel(ctx.measureText(it.label).width, it.x, it.y, placed);
    ctx.lineWidth = 3;
    ctx.strokeStyle = surface;
    ctx.strokeText(it.label, lx, ly);
    ctx.fillStyle = it.out ? muted : ink;
    ctx.fillText(it.label, lx, ly);
  }
  return items.map((it) => ({ team: it.row.team, x: it.x, y: it.y }));
}

let dots: Dot[] = [];

function render(): void {
  const r = replay;
  if (!r) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const v = view(r);
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, v.w, v.h);
  drawTrack(ctx, r, v);
  dots = drawCars(ctx, r, v);
  renderSide(r);
  scrub.value = String(t);
  clock.textContent = `${fmtTime(t)} / ${fmtTime(r.duration)}`;
}

// ── 순위표·이벤트·상태 ──────────────────────────────────────────────────

function cell(content: string | Node, cls?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.append(content);
  return td;
}

function teamCell(team: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'team';
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = teamColor(team);
  const code = document.createElement('span');
  code.className = 'code';
  code.textContent = codes.get(team) ?? team;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = team;
  span.append(sw, code, name);
  return span;
}

function renderSide(r: Replay): void {
  const laps = r.log.meta.laps;
  const rows = tower(r, t).map((row) => {
    const tr = document.createElement('tr');
    if (row.state === 'retired') tr.className = 'out';
    const gap = row.state === 'retired' ? `L${row.lap}` : row.pos === 1 ? `L${row.lap}/${laps}` : row.gap === null ? '—' : `+${row.gap.toFixed(1)}`;
    const tyre = row.compound ? `${COMPOUND_LETTER[row.compound] ?? '?'}${row.life === null ? '' : ` ${Math.round(row.life * 100)}%`}` : '';
    const tag = document.createElement('span');
    const tagText = row.state === 'pit' ? 'PIT' : row.state === 'retired' ? 'OUT' : row.state === 'finished' ? 'FIN' : '';
    if (tagText) {
      tag.className = `tag${row.state === 'retired' ? ' out' : ''}`;
      tag.textContent = tagText;
    }
    tr.append(cell(String(row.pos)), cell(teamCell(row.team)), cell(gap, 'num'), cell(tyre), cell(String(row.pits), 'num'), cell(tag));
    return tr;
  });
  towerBody.replaceChildren(...rows);

  eventsList.replaceChildren(...eventsUntil(r, t).slice(0, 60).map(eventItem));

  const info = raceLap(r, t);
  const badges: HTMLElement[] = [];
  const b = (textContent: string, cls = '') => {
    const s = document.createElement('span');
    s.className = `badge ${cls}`;
    s.textContent = textContent;
    badges.push(s);
  };
  b(`랩 ${Math.min(info.lap, laps)}/${laps}`, 'lap');
  b(SURFACE_LABEL[info.surface] ?? info.surface);
  if (info.sc) b('세이프티카', 'sc');
  statusEl.replaceChildren(...badges);
}

function eventItem(e: RaceEventLog): HTMLLIElement {
  const li = document.createElement('li');
  const lap = document.createElement('span');
  lap.className = 'lapno';
  lap.textContent = `L${e.lap}`;
  const strong = (s: string) => {
    const el = document.createElement('strong');
    el.textContent = codes.get(s) ?? s;
    return el;
  };
  li.append(lap);
  switch (e.type) {
    case 'overtake':
      li.append(strong(e.car), ' 추월 → ', strong(e.on));
      break;
    case 'pit':
      li.append(strong(e.car), ` 피트 ${COMPOUND_LETTER[e.from] ?? e.from}→${COMPOUND_LETTER[e.to] ?? e.to} (${e.loss_s.toFixed(1)}s)`);
      break;
    case 'safety_car':
      li.append(`세이프티카 출동 (${e.duration_laps}랩)`);
      break;
    case 'safety_car_end':
      li.append('세이프티카 복귀');
      break;
    case 'rain_start':
      li.append('비 시작');
      break;
    case 'rain_stop':
      li.append('비 그침');
      break;
    case 'retirement':
      li.append(strong(e.car), ` 리타이어 (${e.reason})`);
      break;
    case 'overtake_failed':
      break;
  }
  return li;
}

// ── 재생·조작 ────────────────────────────────────────────────────────────

function setPlaying(on: boolean): void {
  playing = on;
  playBtn.textContent = on ? '일시정지' : '재생';
  if (on) {
    last = performance.now();
    requestAnimationFrame(tick);
  }
}

function tick(now: number): void {
  if (!playing || !replay) return;
  t = Math.min(replay.duration, t + ((now - last) / 1000) * Number(speedSel.value));
  last = now;
  render();
  if (t >= replay.duration) setPlaying(false);
  else requestAnimationFrame(tick);
}

/** 선두의 랩 경계로 이동 (dir = +1 다음, -1 이전). */
function jumpLap(dir: 1 | -1): void {
  const r = replay;
  if (!r) return;
  const leader = r.cars.find((c) => c.team === tower(r, t)[0]?.team) ?? r.cars[0];
  const ends = [0, ...(leader?.ends ?? [])];
  const target = dir > 0 ? ends.find((x) => x > t + 0.01) : [...ends].reverse().find((x) => x < t - 0.01);
  t = target ?? (dir > 0 ? r.duration : 0);
  render();
}

playBtn.addEventListener('click', () => {
  if (replay && t >= replay.duration) t = 0;
  setPlaying(!playing);
});
$<HTMLButtonElement>('prev').addEventListener('click', () => jumpLap(-1));
$<HTMLButtonElement>('next').addEventListener('click', () => jumpLap(1));
scrub.addEventListener('input', () => {
  t = Number(scrub.value);
  render();
});
runSel.addEventListener('change', () => {
  fillGps(0);
  void loadRace();
});
gpSel.addEventListener('change', () => void loadRace());
window.addEventListener('resize', render);
dark.addEventListener('change', () => {
  const run = runs.find((r) => r.id === runSel.value);
  if (replay) assignColors(run && run.teams.length > 0 ? run.teams : replay.log.cars.map((c) => ({ team: c.team, agent: 'unknown' })));
  render();
});
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') {
    e.preventDefault();
    playBtn.click();
  } else if (e.key === 'ArrowRight') jumpLap(1);
  else if (e.key === 'ArrowLeft') jumpLap(-1);
});

canvas.addEventListener('mousemove', (e) => {
  const r = replay;
  if (!r) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const hit = [...dots].reverse().find((d) => Math.hypot(d.x - mx, d.y - my) <= 12);
  if (!hit) {
    tip.hidden = true;
    return;
  }
  const row = tower(r, t).find((x) => x.team === hit.team);
  if (!row) return;
  const tyre = row.compound ? `${COMPOUND_LETTER[row.compound] ?? ''}${row.life === null ? '' : ` ${Math.round(row.life * 100)}%`}` : '—';
  tip.replaceChildren();
  const title = document.createElement('b');
  title.textContent = `P${row.pos} ${hit.team}`;
  const detail = document.createElement('span');
  detail.textContent = ` · 랩 ${row.lap} · ${tyre} · 피트 ${row.pits}${row.gap !== null && row.pos > 1 ? ` · +${row.gap.toFixed(1)}s` : ''}`;
  tip.append(title, detail);
  tip.style.left = `${mx + 14}px`;
  tip.style.top = `${my + 14}px`;
  tip.hidden = false;
});
canvas.addEventListener('mouseleave', () => {
  tip.hidden = true;
});

void loadRuns().catch((e: unknown) => {
  empty.textContent = `불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}`;
  empty.hidden = false;
});
