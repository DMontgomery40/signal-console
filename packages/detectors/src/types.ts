// Detector<TParams> contract. PRD §10: a detector is one TS file under
// packages/detectors/src/<name>/index.ts exporting `detector: Detector<typeof Params>`.
// The registry (registry.ts) keys detectors by id; the UI auto-renders parameter
// controls from the Zod paramsSchema (number -> slider, enum -> select, boolean -> switch).

import type { z } from "zod";

// Upstream data sources a detector reads from. Surfaced via /v1/detectors so
// the Detectors UI can render a "SOURCES:" chip per detector (US-048). The
// literal union is closed on purpose — a detector that wants to declare a new
// source has to extend the union here, which forces a single source of truth.
export type Source = "bet365" | "kalshi" | "polymarket";

// Quote tick shape consumed by board-mad (US-009). Mirrors the gold-DB
// quote_ticks columns the route would SELECT for one game; the caller joins
// source_markets to project `gameId` onto each row before handing the batch
// to the detector. impliedProbability is nullable to match the column;
// detectors apply their own filters (board-mad drops 0.500 anchors and
// is_heartbeat rows; see board-mad/index.ts).
export type Tick = {
  readonly gameId: string;
  readonly sourceMarketId: string;
  readonly capturedAt: Date;
  readonly impliedProbability: number | null;
  readonly volume: number;
  readonly isHeartbeat: boolean;
  // Seconds of NBA game clock elapsed at capturedAt, when the API loader can
  // derive it from PBP period/clock. Null/undefined keeps wall-clock behavior.
  readonly gameElapsedSeconds?: number | null;
};

// Polymarket trade-print row from market_microstructure_events. The off-price-print
// detector (US-027) filters on `volumeShare` and `offPriceDistance`; the loader
// (microstructure route, US-029) is responsible for computing `offPriceDistance`
// from the row columns (typically the distance between trade_price and the
// prevailing price). `source` is included so callers can surface the Polymarket-
// only limitation (US-208) without re-querying the gold DB.
export type MicrostructureEvent = {
  readonly gameId: string;
  readonly sourceMarketId: string;
  readonly eventTimestamp: Date;
  readonly source: string;
  readonly volumeShare: number;
  readonly offPriceDistance: number;
};

// Per-game timing fact resolved by the shared detector runner. Single source
// of tipoff truth so the baseline math anchors elapsed seconds to a real game
// instant — never to "first nonzero market bucket" (the original category
// error this audit closes). `clockSource` records which fallback produced the
// anchor; the runner includes it in cache identity so a `scheduled`-anchored
// run recomputes when PBP arrives. Added 2026-05-24 phase A0.
export type ClockSource = "pbp" | "scheduled" | "none";

export type GameTimingContext = {
  readonly gameId: string;
  readonly scheduledStartUtc: Date;
  readonly tipoffAnchorUtc: Date;
  readonly clockSource: ClockSource;
  readonly pbpMinUtc: Date | null;
  readonly pbpMaxUtc: Date | null;
};

// A detector's invocation scope. Concrete data is loaded by the caller (route or
// backtest job) and handed to run(); detectors do not open the gold DB themselves.
// `ticks` and `microstructureEvents` are optional/additive (per US-007 guidance)
// so each detector reads only the fields it needs without breaking the contract.
// `timingContexts` carries the per-game tipoff anchors resolved by the runner.
// As of 2026-05-25 (phase A0) it is plumbed through DetectorWindow and used by
// the runner for cache identity + scheduled-fallback tick-window resolution.
// It WILL be consumed inside prebucket/baseline for the PBP-missing elapsed
// math after audit-fix #2 (phase A2); board-mad currently uses per-tick
// gameElapsedSeconds with a "first nonzero bucket" wall-time fallback, which
// is the bug A2 closes. Until A2 lands, this field is read by the runner only.
export type DetectorWindow = {
  readonly gameIds: readonly string[];
  readonly start: Date;
  readonly end: Date;
  readonly ticks?: readonly Tick[];
  readonly boardMadHistoricalPriors?: readonly BoardMadHistoricalPrior[];
  readonly microstructureEvents?: readonly MicrostructureEvent[];
  readonly timingContexts?: readonly GameTimingContext[];
};

export type BoardMadHistoricalPrior = {
  readonly gameId: string;
  readonly median: number;
  readonly mad: number;
  readonly sampleSize: number;
};

// One detector fire. Bucket-start is the detector output (the bucket whose
// intensity crossed threshold). Bucket-end is the watcher-confirmation timestamp
// (used by /v1/board observations for downstream UI). `gameId` is required so
// the cache write path (US-021) can populate detector_observations.game_id
// without a separate join.
//
// `lane` is set by composite detectors (ensemble-or) so the UI can render
// board fires and off-price-print fires with different visual treatments
// (e.g. solid green vs red dashed). Single-lane detectors leave it undefined;
// downstream consumers default to the detector's id for back-compat.
export type DetectorFireLane = "board" | "offprice";

export type DetectorFire = {
  readonly gameId: string;
  readonly bucketStart: Date;
  readonly bucketEnd: Date;
  readonly intensity: number;
  readonly baselineMedian: number;
  readonly baselineMad: number;
  readonly lane?: DetectorFireLane;
  readonly sourceMarketId?: string;
};

export type DetectorStats = {
  readonly firesPerGame: number;
  readonly totalFires: number;
  readonly gamesInWindow: number;
};

// Per-bucket observation, fired or not. US-047 needs the surrounding context
// (prior buckets + the firing bucket) to render the drilldown timeline, so
// the detector now exposes every bucket alongside the fires-only slice.
// warmedUp explicitly separates "no active threshold yet" from a real zero
// baseline so chart/API consumers do not draw a fake threshold at zero.
export type DetectorBucket = {
  readonly gameId: string;
  readonly bucketStart: Date;
  readonly bucketEnd: Date;
  readonly intensity: number;
  readonly baselineMedian: number;
  readonly baselineMad: number;
  readonly warmedUp: boolean;
  readonly fired: boolean;
};

export type DetectorResult = {
  readonly fires: readonly DetectorFire[];
  readonly stats: DetectorStats;
  readonly buckets: readonly DetectorBucket[];
};

// PRD §10:
//   export const detector: Detector<typeof Params> = {
//     id: "board-mad",
//     version: "1.0.0",
//     displayName: "Board MAD (whole-board volatility)",
//     paramsSchema: Params,
//     run(window, params) { ... },
//   };
export interface Detector<TParams extends z.ZodTypeAny> {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly sources: readonly Source[];
  readonly paramsSchema: TParams;
  readonly run: (window: DetectorWindow, params: z.infer<TParams>) => DetectorResult;
}
