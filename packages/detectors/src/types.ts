// Detector<TParams> contract. PRD §10: a detector is one TS file under
// packages/detectors/src/<name>/index.ts exporting `detector: Detector<typeof Params>`.
// The registry (registry.ts) keys detectors by id; the UI auto-renders parameter
// controls from the Zod paramsSchema (number -> slider, enum -> select, boolean -> switch).

import type { z } from "zod";

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
};

// A detector's invocation scope. Concrete data is loaded by the caller (route or
// backtest job) and handed to run(); detectors do not open the gold DB themselves.
// `ticks` is optional/additive (per US-007 guidance) so future detectors
// (US-027 off-price-print) can introduce their own optional inputs without
// breaking the contract; each detector reads only the fields it needs.
export type DetectorWindow = {
  readonly gameIds: readonly string[];
  readonly start: Date;
  readonly end: Date;
  readonly ticks?: readonly Tick[];
};

// One detector fire. Bucket-start is the detector output (the bucket whose
// intensity crossed threshold). Bucket-end is the watcher-confirmation timestamp
// (used by /v1/board observations for downstream UI). `gameId` is required so
// the cache write path (US-021) can populate detector_observations.game_id
// without a separate join.
export type DetectorFire = {
  readonly gameId: string;
  readonly bucketStart: Date;
  readonly bucketEnd: Date;
  readonly intensity: number;
  readonly baselineMedian: number;
  readonly baselineMad: number;
};

export type DetectorStats = {
  readonly firesPerGame: number;
  readonly totalFires: number;
  readonly gamesInWindow: number;
};

export type DetectorResult = {
  readonly fires: readonly DetectorFire[];
  readonly stats: DetectorStats;
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
  readonly paramsSchema: TParams;
  readonly run: (window: DetectorWindow, params: z.infer<TParams>) => DetectorResult;
}
