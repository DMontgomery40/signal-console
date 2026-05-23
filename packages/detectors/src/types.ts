// Detector<TParams> contract. PRD §10: a detector is one TS file under
// packages/detectors/src/<name>/index.ts exporting `detector: Detector<typeof Params>`.
// The registry (registry.ts) keys detectors by id; the UI auto-renders parameter
// controls from the Zod paramsSchema (number -> slider, enum -> select, boolean -> switch).

import type { z } from "zod";

// A detector's invocation scope. Concrete data is loaded by the caller (route or
// backtest job) and handed to run(); detectors do not open the gold DB themselves.
// Tick/event arrays land in later stories (US-009 board-mad, US-027 off-price-print)
// where the shape is anchored to gold-DB columns; this type stays minimal until then.
export type DetectorWindow = {
  readonly gameIds: readonly string[];
  readonly start: Date;
  readonly end: Date;
};

// One detector fire. Bucket-start is the detector output (the bucket whose
// intensity crossed threshold). Bucket-end is the watcher-confirmation timestamp
// (used by /v1/board observations for downstream UI).
export type DetectorFire = {
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
