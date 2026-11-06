// worker_threads 엔트리: 받은 스펙들을 캘린더 전 트랙에서 평가해 돌려준다.
import { parentPort, workerData } from 'node:worker_threads';
import type { CarSpec } from '@f1sim/core';
import { loadRegulations, loadSeasonTracks } from './data.js';
import { bestSetupLap } from './design.js';

const { season, specs } = workerData as { season: number; specs: CarSpec[] };
const regs = loadRegulations(season);
const tracks = loadSeasonTracks(season, regs);
parentPort?.postMessage(specs.map((spec) => tracks.map((track) => bestSetupLap(spec, track, regs))));
