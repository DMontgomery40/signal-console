// off-price-print detector — concentrated-print signal. PRD §10 / US-027.
// One Polymarket trade-print row from market_microstructure_events is a fire
// when its volume_share crosses minVolumeShare AND its off_price_distance
// crosses minOffPriceDistance. No baseline, no time-bucketing — each qualifying
// event is its own fire at its event_timestamp.
//
// The detector consumes pre-loaded MicrostructureEvent rows; the route loader
// (US-029) is responsible for computing offPriceDistance from the raw columns
// and for filtering by source = 'polymarket' before handing them in. The
// "Polymarket only" caveat lives in the displayName per PRD §US-208.

import { z } from "zod";

import type {
  Detector,
  DetectorBucket,
  DetectorFire,
  DetectorResult,
  DetectorStats,
  DetectorWindow,
  MicrostructureEvent,
} from "../types";

export const Params = z.object({
  minVolumeShare: z.number().min(0).max(1).default(0.1),
  minOffPriceDistance: z.number().min(0).max(1).default(0.4),
});

type ParamsResolved = z.infer<typeof Params>;

const passesThresholds = (e: MicrostructureEvent, params: ParamsResolved): boolean =>
  e.volumeShare >= params.minVolumeShare && e.offPriceDistance >= params.minOffPriceDistance;

const eventToFire = (e: MicrostructureEvent): DetectorFire => ({
  gameId: e.gameId,
  bucketStart: e.eventTimestamp,
  bucketEnd: e.eventTimestamp,
  intensity: e.offPriceDistance,
  baselineMedian: 0,
  baselineMad: 0,
});

export const detector: Detector<typeof Params> = {
  id: "off-price-print",
  version: "1.0.0",
  displayName: "Off-price print (Polymarket only)",
  sources: ["polymarket"],
  paramsSchema: Params,
  run(window: DetectorWindow, params: ParamsResolved): DetectorResult {
    const events = window.microstructureEvents ?? [];
    const gameIdSet = new Set(window.gameIds);
    const fires: readonly DetectorFire[] = events
      .filter((e) => gameIdSet.has(e.gameId))
      .filter((e) => passesThresholds(e, params))
      .map(eventToFire);
    const buckets: readonly DetectorBucket[] = [];
    const games = window.gameIds.length;
    const stats: DetectorStats = {
      firesPerGame: games === 0 ? 0 : fires.length / games,
      totalFires: fires.length,
      gamesInWindow: games,
    };
    return { fires, stats, buckets };
  },
};
