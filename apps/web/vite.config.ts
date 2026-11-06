/**
 * 2D 리플레이 뷰어 개발 서버. runs/(시즌 출력)와 data/(트랙·규정)를 읽기 전용으로 내준다.
 *   GET /api/runs        runs/ 아래 시즌 목록 (season.json, 없으면 gpNN_트랙 폴더의 race.json을 훑는다)
 *   GET /runs/<path>     runs/ 아래 파일
 *   GET /data/<path>     data/ 아래 파일
 * 운영자용 로컬 도구다 — data/model(엔진 계수)도 내준다 (랩 안 속도 곡선 계산에 쓴다).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNS = join(ROOT, 'runs');
const DATA = join(ROOT, 'data');
const GP_DIR = /^gp(\d+)_(.+)$/;

interface RunGp {
  readonly gp: number;
  readonly track: string;
  readonly path: string;
}
interface RunTeam {
  readonly team: string;
  readonly agent: string;
  readonly model?: string;
}
interface Run {
  readonly id: string;
  readonly season: number | null;
  readonly seed: number | null;
  readonly teams: readonly RunTeam[];
  readonly gps: readonly RunGp[];
}

function inside(base: string, rel: string): string | null {
  const p = normalize(join(base, rel));
  return p.startsWith(base + sep) && existsSync(p) && statSync(p).isFile() ? p : null;
}

function listRuns(): Run[] {
  if (!existsSync(RUNS)) return [];
  const runs: Run[] = [];
  for (const id of readdirSync(RUNS).sort()) {
    const dir = join(RUNS, id);
    if (!statSync(dir).isDirectory()) continue;
    const gps: RunGp[] = readdirSync(dir)
      .map((name) => ({ name, m: GP_DIR.exec(name) }))
      .filter((x) => x.m && existsSync(join(dir, x.name, 'race.json')))
      .map((x) => ({ gp: Number(x.m?.[1]), track: x.m?.[2] ?? '', path: `${id}/${x.name}/race.json` }))
      .sort((a, b) => a.gp - b.gp);
    if (gps.length === 0) continue;
    let season: number | null = null;
    let seed: number | null = null;
    let teams: RunTeam[] = [];
    const seasonFile = join(dir, 'season.json');
    if (existsSync(seasonFile)) {
      const s = JSON.parse(readFileSync(seasonFile, 'utf8')) as { season: number; seed: number; teams: RunTeam[] };
      season = s.season;
      seed = s.seed;
      teams = s.teams.map((t) => ({ team: t.team, agent: t.agent, ...(t.model !== undefined ? { model: t.model } : {}) }));
    }
    runs.push({ id, season, seed, teams, gps });
  }
  return runs;
}

function f1simFiles(): Plugin {
  return {
    name: 'f1sim-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/api/runs') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(listRuns()));
          return;
        }
        for (const [prefix, base] of [
          ['/runs/', RUNS],
          ['/data/', DATA],
        ] as const) {
          if (!url.pathname.startsWith(prefix)) continue;
          const file = inside(base, decodeURIComponent(url.pathname.slice(prefix.length)));
          if (!file) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          res.setHeader('content-type', file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8');
          res.end(readFileSync(file));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  // 워크스페이스 패키지를 dist가 아니라 src(TS)로 (tsconfig.base.json의 customConditions와 같다).
  resolve: { conditions: ['@f1sim/source', ...defaultClientConditions] },
  plugins: [f1simFiles()],
  server: { port: 5173 },
});
