// Client-side board-mad recompute (US-035 round-trip-stability prerequisite).
//
// /v1/backtest returns one observation per bucket with the intensity already
// computed. For the board-mad detector, baseline-timing params can be re-applied to
// those intensities without a new server round-trip:
//
//   - kMad                       : changes the fire threshold
//   - baselineMode               : chooses rolling current-game vs opening-ramp prior
//   - openingBaselineBuckets     : sets the opening-ramp sample duration
//   - openingRampCompleteBuckets : sets when opening-ramp reaches rolling memory
//   - trailingBuckets            : changes the elapsed lookback feeding median + MAD
//   - warmupBuckets              : changes the elapsed-time holdoff before a bucket can fire
//
// Historical-blend params and prebucket params CANNOT be recomputed from
// observations alone because they change which ticks roll into which bucket
// (i.e. they change the intensity values themselves, or they need same-side
// historical priors/game-clock elapsed context that the client snapshot does
// not carry):
//
//   - bucketSeconds  : re-buckets the underlying ticks
//   - weighting      : log(1+v)*|Δp| versus just |Δp| per tick
//   - freshCapSeconds: gap filter at the tick level
//   - historicalLastGames / historical* / trailingGameMinutes / recentWall*: server-side context
//
// Editing those three should mark the result as "stale" so the user knows the
// shown numbers no longer match the current form values.
//
// The recompute mirrors packages/detectors/src/board-mad/sweep.ts. We keep
// the input data in API-shape (BacktestObservation[]) and group by gameId
// so each game's prior-bucket window is local to that game.

import {
  resolveBoardMadBaseline,
  type BoardMadBaselineEntry,
  type BoardMadBaselineMode,
} from "@signal-console/detectors/board-mad/baseline";
import {
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  K_MAD_LIVE,
} from "@signal-console/detectors/board-mad/config";

import type { BacktestObservation, BacktestResponse, BacktestStats } from "../../data/queries";

export const BOARD_MAD_DETECTOR_ID = "board-mad";
// Stage 1 cascade — runs board-mad AND off-price-print over the same window
// and unions their fires. It is the default detector on the Backtest UI;
// current benchmark scores live in the generated bakeoff report.
export const ENSEMBLE_OR_DETECTOR_ID = "ensemble-or";

// Subset of the form values needed for the client recompute. We accept extra
// keys (the form holds the full param record) and read only what we need.
export interface BoardMadRecomputeParams {
  readonly baselineMode: BoardMadBaselineMode;
  readonly bucketSeconds: number;
  readonly kMad: number;
  readonly openingBaselineBuckets: number;
  readonly openingRampCompleteBuckets: number;
  readonly trailingBuckets: number;
  readonly warmupBuckets: number;
}

const DEFAULT_BOARD_RECOMPUTE_PARAMS: BoardMadRecomputeParams = {
  baselineMode: BOARD_MAD_BASELINE_MODE_DEFAULT,
  bucketSeconds: BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  kMad: K_MAD_LIVE,
  openingBaselineBuckets: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  openingRampCompleteBuckets: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  trailingBuckets: BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  warmupBuckets: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
};

// Params that drive prebucket itself — if any of these have drifted from
// what the backtest was run with, the recompute would be misleading.
export const BOARD_MAD_PREBUCKET_PARAMS: readonly string[] = [
  "bucketSeconds",
  "weighting",
  "freshCapSeconds",
  "historicalLastGames",
  "historicalAwayWeight",
  "historicalPriorWeight",
  "historicalRampCompleteGameMinutes",
  "trailingGameMinutes",
  "recentWallMinutes",
  "recentWallWeight",
];
// Phase B5 (2026-05-25): exposed so BacktestPage can flag the snapshot as
// stale when the user picks a baselineMode the client recompute can't
// apply. Historical-blend needs same-side priors that the snapshot doesn't
// carry; the client recompute returns null for those modes (see lines
// further below where the resolved params are validated). Without this
// stale flag, the trader would tweak baselineMode and see UNCHANGED
// snapshot numbers — silent disagreement between form and preview.
export function clientRecomputeSupportsBaselineMode(mode: BoardMadBaselineMode): boolean {
  return mode === BOARD_MAD_BASELINE_MODE_TRAILING || mode === BOARD_MAD_BASELINE_MODE_OPENING_RAMP;
}

export const BOARD_MAD_RECOMPUTE_PARAMS: readonly string[] = [
  "baselineMode",
  "kMad",
  "openingBaselineBuckets",
  "openingRampCompleteBuckets",
  "trailingBuckets",
  "warmupBuckets",
];

export function isBoardMadRecomputeField(name: string): boolean {
  return BOARD_MAD_RECOMPUTE_PARAMS.includes(name);
}

export function isBoardMadPrebucketField(name: string): boolean {
  return BOARD_MAD_PREBUCKET_PARAMS.includes(name);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boardParamsForDetector(
  detectorId: string,
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  if (detectorId === BOARD_MAD_DETECTOR_ID) return params;
  if (detectorId === ENSEMBLE_OR_DETECTOR_ID) {
    const board = params["board"];
    return isPlainRecord(board) ? board : {};
  }
  return null;
}

function readBoardMadRecomputeParams(
  detectorId: string,
  params: Readonly<Record<string, unknown>>,
): BoardMadRecomputeParams | null {
  const boardParams = boardParamsForDetector(detectorId, params);
  if (boardParams === null) return null;
  const baselineMode = boardParams["baselineMode"] ?? DEFAULT_BOARD_RECOMPUTE_PARAMS.baselineMode;
  const bucketSeconds =
    boardParams["bucketSeconds"] ?? DEFAULT_BOARD_RECOMPUTE_PARAMS.bucketSeconds;
  const kMad = boardParams["kMad"] ?? DEFAULT_BOARD_RECOMPUTE_PARAMS.kMad;
  const openingBaselineBuckets =
    boardParams["openingBaselineBuckets"] ?? DEFAULT_BOARD_RECOMPUTE_PARAMS.openingBaselineBuckets;
  const openingRampCompleteBuckets =
    boardParams["openingRampCompleteBuckets"] ??
    DEFAULT_BOARD_RECOMPUTE_PARAMS.openingRampCompleteBuckets;
  const trailingBuckets =
    boardParams["trailingBuckets"] ?? DEFAULT_BOARD_RECOMPUTE_PARAMS.trailingBuckets;
  const warmupBuckets =
    boardParams["warmupBuckets"] ?? DEFAULT_BOARD_RECOMPUTE_PARAMS.warmupBuckets;
  if (
    baselineMode !== BOARD_MAD_BASELINE_MODE_TRAILING &&
    baselineMode !== BOARD_MAD_BASELINE_MODE_OPENING_RAMP
  ) {
    return null;
  }
  if (typeof bucketSeconds !== "number" || !Number.isInteger(bucketSeconds)) return null;
  if (typeof kMad !== "number" || !Number.isFinite(kMad)) return null;
  if (typeof openingBaselineBuckets !== "number" || !Number.isInteger(openingBaselineBuckets)) {
    return null;
  }
  if (
    typeof openingRampCompleteBuckets !== "number" ||
    !Number.isInteger(openingRampCompleteBuckets)
  ) {
    return null;
  }
  if (typeof trailingBuckets !== "number" || !Number.isInteger(trailingBuckets)) return null;
  if (typeof warmupBuckets !== "number" || !Number.isInteger(warmupBuckets)) return null;
  return {
    baselineMode,
    bucketSeconds,
    kMad,
    openingBaselineBuckets,
    openingRampCompleteBuckets,
    trailingBuckets,
    warmupBuckets,
  };
}

export function hasBoardMadPrebucketDrift(
  detectorId: string,
  snapshotParams: Readonly<Record<string, unknown>>,
  currentParams: Readonly<Record<string, unknown>>,
): boolean {
  const snapshotBoard = boardParamsForDetector(detectorId, snapshotParams);
  const currentBoard = boardParamsForDetector(detectorId, currentParams);
  if (snapshotBoard === null || currentBoard === null) return false;
  return BOARD_MAD_PREBUCKET_PARAMS.some((key) => snapshotBoard[key] !== currentBoard[key]);
}

function isBoardLaneObservation(obs: BacktestObservation): boolean {
  return obs.lane === undefined || obs.lane === "board";
}

function isOffpriceLaneObservation(obs: BacktestObservation): boolean {
  return obs.lane === "offprice";
}

interface GroupedGame {
  readonly gameId: string;
  readonly observations: readonly BacktestObservation[];
}

function groupByGame(observations: readonly BacktestObservation[]): readonly GroupedGame[] {
  const map = new Map<string, BacktestObservation[]>();
  for (const obs of observations) {
    const existing = map.get(obs.gameId);
    if (existing === undefined) {
      map.set(obs.gameId, [obs]);
    } else {
      existing.push(obs);
    }
  }
  const groups: GroupedGame[] = [];
  for (const [gameId, list] of map.entries()) {
    // Sort by bucketStart so the trailing window walks chronologically.
    list.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
    groups.push({ gameId, observations: list });
  }
  return groups;
}

function observationToBaselineEntry(
  observation: BacktestObservation,
  fallbackBucket: number,
): BoardMadBaselineEntry {
  const parsed = Date.parse(observation.bucketStart);
  return {
    bucket: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallbackBucket,
    ...(observation.gameElapsedSeconds == null
      ? {}
      : { gameElapsedSeconds: observation.gameElapsedSeconds }),
    intensity: observation.intensity,
  };
}

// Same shape as BacktestObservation; `fired`, `baselineMedian`, `baselineMad`
// are the recomputed values; `intensity` is preserved from the original
// observation since the client can't recompute it.
export type RecomputedObservation = BacktestObservation;

export interface RecomputeResult {
  readonly stats: BacktestStats;
  readonly observations: readonly RecomputedObservation[];
}

export function recomputeBoardMad(
  response: BacktestResponse,
  params: BoardMadRecomputeParams,
  gamesInWindow: number,
): RecomputeResult {
  const groups = groupByGame(response.observations.filter(isBoardLaneObservation));
  const totalFires = { count: 0 };
  const out: RecomputedObservation[] = [];
  for (const group of groups) {
    const entries = group.observations.map((o, i) =>
      observationToBaselineEntry(o, i * params.bucketSeconds),
    );
    for (let i = 0; i < group.observations.length; i++) {
      const obs = group.observations[i];
      if (obs === undefined) continue;
      const baseline = resolveBoardMadBaseline(entries, i, params);
      const threshold = baseline.median + params.kMad * baseline.mad;
      const fired = obs.intensity > 0 && obs.intensity >= threshold ? 1 : 0;
      const effectiveFired = baseline.warmedUp ? fired : 0;
      if (effectiveFired === 1) totalFires.count += 1;
      out.push({
        ...obs,
        fired: effectiveFired,
        baselineMedian: baseline.median,
        baselineMad: baseline.mad,
      });
    }
  }
  const denom = gamesInWindow > 0 ? gamesInWindow : 1;
  return {
    stats: {
      totalFires: totalFires.count,
      firesPerGame: totalFires.count / denom,
      gamesInWindow,
    },
    observations: out,
  };
}

// Returns null when client-side recompute is not supported for the detector,
// otherwise re-derives stats + observations from the original API response.
export function applyClientRecompute(
  detectorId: string,
  response: BacktestResponse,
  params: Readonly<Record<string, unknown>>,
): RecomputeResult | null {
  if (detectorId !== BOARD_MAD_DETECTOR_ID && detectorId !== ENSEMBLE_OR_DETECTOR_ID) return null;
  const boardParams = readBoardMadRecomputeParams(detectorId, params);
  if (boardParams === null) return null;
  const boardResult = recomputeBoardMad(response, boardParams, response.stats.gamesInWindow);
  const offpriceRows = response.observations.filter(isOffpriceLaneObservation);
  const offpriceFires = offpriceRows.reduce((acc, obs) => acc + (obs.fired === 1 ? 1 : 0), 0);
  const totalFires = boardResult.stats.totalFires + offpriceFires;
  const denom = response.stats.gamesInWindow > 0 ? response.stats.gamesInWindow : 1;
  return {
    stats: {
      totalFires,
      firesPerGame: totalFires / denom,
      gamesInWindow: response.stats.gamesInWindow,
    },
    observations: [...boardResult.observations, ...offpriceRows],
  };
}
