/**
 * 하네스 CLI. `pnpm -F @f1sim/harness <command>`.
 *   gen-tracks   track-briefs.ts → data/tracks/<id>.csv, .yaml
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTrack, profile } from '@f1sim/core';
import { DATA_DIR, loadRegulations } from './data.js';
import { TRACK_BRIEFS } from './track-briefs.js';
import { centerlineCsv, generateLayout, metaFor, metaYaml, seedFor } from './trackgen.js';

const SEASON = 2026;

function genTracks(): void {
  const regs = loadRegulations(SEASON);
  for (const brief of TRACK_BRIEFS) {
    const layout = generateLayout(brief, regs, seedFor(brief.id));
    const meta = metaFor(brief, layout);
    const csv = centerlineCsv(brief, layout);
    const p = profile(parseTrack(csv, meta, regs));
    writeFileSync(join(DATA_DIR, 'tracks', `${brief.id}.csv`), csv);
    writeFileSync(join(DATA_DIR, 'tracks', `${brief.id}.yaml`), metaYaml(brief, meta));
    console.log(
      `${brief.id.padEnd(18)} ${(layout.length_m / 1000).toFixed(2)} km  ratio ${p.straight_ratio.toFixed(3)} (brief ${brief.straightRatio})  ` +
        `corners L${p.corners_low}/M${p.corners_mid}/H${p.corners_high} (brief ${brief.corners.low}/${brief.corners.mid}/${brief.corners.high})  seed ${layout.seed}`,
    );
  }
}

const command = process.argv[2];
switch (command) {
  case 'gen-tracks':
    genTracks();
    break;
  default:
    console.error(`unknown command "${command ?? ''}". commands: gen-tracks`);
    process.exitCode = 1;
}
