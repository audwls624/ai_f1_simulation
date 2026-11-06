/**
 * 정보 패킷 만들기 (9절: 모든 팀 동일). 오케스트레이터가 엔진 쪽 데이터에서 공개 정보만 골라 담는다.
 */
import {
  baseLap,
  derive,
  profile,
  publicRules,
  raceSets,
  wearPerLap,
  type CarSpec,
  type Forecast,
  type PublicRaceLog,
  type Regulations,
  type Setup,
  type Track,
} from '@f1sim/core';
import type { GPPacket, PreseasonPacket, Standing, WindTunnelSummary } from './base.js';

/** 풍동 요약의 셋업 3개: 윙 낮음·중간·높음 (지상고 mid, ERS balanced). */
export const SUMMARY_WINGS = [2, 5, 8] as const;

export function buildPreseasonPacket(
  regs: Regulations,
  team: string,
  calendar: readonly Track[],
  previousSeason: readonly PublicRaceLog[] = [],
): PreseasonPacket {
  return {
    season: regs.season,
    team,
    rules: publicRules(regs),
    calendar: calendar.map((t, i) => ({ gp: i + 1, track_id: t.id, profile: profile(t) })),
    previous_season: previousSeason,
    wind_tunnel_remaining: regs.tools.wind_tunnel.runs_preseason,
  };
}

/** 자기 차의 이 트랙 풍동 요약 (노이즈 없음, 평균 기온). */
export function windTunnelSummary(spec: CarSpec, track: Track, regs: Regulations): WindTunnelSummary[] {
  return SUMMARY_WINGS.map((wing_level) => {
    const setup: Setup = { wing_level, ride_height: 'mid', ers_mode: 'balanced' };
    const perf = derive(spec, setup, track, regs);
    return {
      setup,
      lap: baseLap(perf, track, 'dry', regs),
      wear_per_lap: wearPerLap(regs.tools.wind_tunnel.wear_compound, perf, track, 'normal', false, 'dry', regs),
    };
  });
}

export function buildGPPacket(args: {
  readonly regs: Regulations;
  readonly team: string;
  readonly gp: number;
  readonly track: Track;
  readonly forecast: Forecast;
  readonly ownSpec: CarSpec;
  readonly standings: readonly Standing[];
  readonly lastGp: PublicRaceLog | null;
}): GPPacket {
  const { regs } = args;
  return {
    season: regs.season,
    gp: args.gp,
    team: args.team,
    rules: publicRules(regs),
    track_id: args.track.id,
    profile: profile(args.track),
    forecast: args.forecast,
    tire_sets: raceSets(regs),
    own_spec: args.ownSpec,
    wind_tunnel_summary: windTunnelSummary(args.ownSpec, args.track, regs),
    standings: args.standings,
    last_gp: args.lastGp,
    strategy_sim_remaining: regs.tools.strategy_sim.runs_per_gp,
  };
}
