import { describe, expect, it } from 'vitest';
import { listTrackIds, loadRegulations, loadTrack } from '../src/data.js';

describe('data loader', () => {
  it('loads the season regulations and every track under data/tracks', () => {
    const regs = loadRegulations(2026);
    expect(regs.season).toBe(2026);
    const ids = listTrackIds();
    expect(ids).toEqual([...ids].sort());
    for (const id of ids) expect(loadTrack(id, regs).id).toBe(id);
  });
});
