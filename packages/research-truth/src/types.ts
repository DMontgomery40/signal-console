export type ScoreKind =
  | "board-eq"
  | "board-vw"
  | "coverage-normalized-vw"
  | "logit-vw"
  | "volume-heavy"
  | "offprice"
  | "hybrid";

export type BaselineKind =
  | "mad-wall"
  | "mad-game"
  | "mad-blend"
  | "mad-historical"
  | "ewma"
  | "cusum"
  | "rv-bv";

export type DetectorEngine = "research-ts" | "python-state-space";

export type RuntimeBaselineMode = "trailing" | "opening-ramp" | "historical-blend";

export interface IncidentRegistryPayload {
  readonly incidents?: readonly unknown[];
  readonly summary?: unknown;
}

export interface RawIncident {
  readonly id: string;
  readonly confidence: string;
  readonly anchorType: string;
  readonly gameDate: string;
  readonly teams: string;
  readonly gameId: string;
  readonly period: string;
  readonly clock: string;
  readonly utcTime: string;
  readonly stat: string;
  readonly creditedPlayer: string;
  readonly rightfulPlayer: string;
  readonly sourceOrigin: string;
  readonly sourceReference: string;
  readonly sourceTextSummary: string;
  readonly notes: string;
  readonly officialCorrection: boolean;
  readonly localBoardGameIds: readonly string[];
}

export interface PbpPoint {
  readonly timeSec: number;
  readonly iso: string;
  readonly period: number | null;
  readonly clock: string | null;
  readonly secondsRemaining: number | null;
  readonly gameElapsedSec: number | null;
  readonly scoreMarginAbs: number | null;
  readonly description: string;
}

export interface GameWindow {
  readonly gameId: string;
  readonly scheduledStart: string;
  readonly homeKey: string | null;
  readonly awayKey: string | null;
  readonly startIso: string;
  readonly endIso: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly points: readonly PbpPoint[];
}

export interface PairContribution {
  readonly timeSec: number;
  readonly sourceMarketId: string;
  readonly source: string;
  readonly family: string;
  readonly deltaP: number;
  readonly deltaLogit: number;
  readonly volume: number;
}

export interface MicroEvent {
  readonly timeSec: number;
  readonly source: string;
  readonly sourceMarketId: string;
  readonly instrumentId: string;
  readonly severity: number;
}

export interface Bucket {
  readonly startSec: number;
  readonly endSec: number;
  readonly gameElapsedSec: number | null;
  readonly period: number | null;
  readonly secondsRemaining: number | null;
  readonly scoreMarginAbs: number | null;
  readonly eqIntensity: number;
  readonly vwIntensity: number;
  readonly logitVwIntensity: number;
  readonly volumeHeavyIntensity: number;
  readonly activeMarketCount: number;
  readonly sourceCount: number;
  readonly sourceDominance: number | null;
  readonly familyCount: number;
  readonly offpriceSeverity: number;
  readonly offpriceFanout: number;
  readonly offpriceSourceCount: number;
}

export interface GameData {
  readonly gameId: string;
  readonly window: GameWindow;
  readonly pairs: readonly PairContribution[];
  readonly micro: readonly MicroEvent[];
  readonly bucketCache: Map<number, readonly Bucket[]>;
}

export interface AlgoSpec {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly engine?: DetectorEngine;
  readonly bucketSeconds: number;
  readonly scoreKind: ScoreKind;
  readonly baselineKind: BaselineKind;
  readonly k: number;
  readonly warmupBuckets: number;
  readonly minPrior: number;
  readonly trailingBuckets?: number;
  readonly wallMemorySeconds?: number;
  readonly gameMemorySeconds?: number;
  readonly recentWallSeconds?: number;
  readonly recentWallWeight?: number;
  readonly finalFiveCloseMultiplier?: number;
  readonly finalFoulModeMultiplier?: number;
  readonly requiredMarkets?: number;
  readonly requiredFamilies?: number;
  readonly requiredSources?: number;
  readonly requiredOffpriceFanout?: number;
  readonly cooldownBuckets?: number;
  readonly openingBaselineBuckets?: number;
  readonly openingRampCompleteBuckets?: number;
  readonly historicalLastGames?: number;
  readonly historicalAwayWeight?: number;
  readonly historicalPriorWeight?: number;
  readonly historicalRampCompleteGameSeconds?: number;
  readonly runtimeBaselineMode?: RuntimeBaselineMode;
  readonly stateSpace?: Record<string, unknown>;
  readonly configSource?: "baseline-defaults" | "live-defaults";
  readonly formula: string;
  readonly rationale: string;
  readonly citations: readonly string[];
}

export interface StateSpaceAlgoSpec extends AlgoSpec {
  readonly engine: "python-state-space";
  readonly stateSpace: Record<string, unknown>;
}

export interface BakeoffStateSpaceHistoricalPrior {
  readonly mad: number;
  readonly median: number;
  readonly sampleSize: number;
}

export interface BakeoffStateSpaceObservation {
  readonly activeMarketCount?: number;
  readonly bucketEnd: string;
  readonly bucketStart: string;
  readonly gameElapsedSeconds?: number | null;
  readonly intensity: number;
  readonly sourceCount?: number;
  readonly sourceDominance?: number;
}

export interface BakeoffStateSpaceRequest {
  readonly gameId: string;
  readonly observations: readonly BakeoffStateSpaceObservation[];
  readonly params: {
    readonly baselineMode: RuntimeBaselineMode;
    readonly bucketSeconds: number;
    readonly historicalPrior?: BakeoffStateSpaceHistoricalPrior;
    readonly historicalPriorWeight?: number;
    readonly historicalRampCompleteGameMinutes?: number;
    readonly kMad: number;
    readonly openingBaselineBuckets: number;
    readonly openingRampCompleteBuckets: number;
    readonly recentWallMinutes?: number;
    readonly recentWallWeight?: number;
    readonly stateSpace: Record<string, unknown>;
    readonly trailingBuckets: number;
    readonly trailingGameMinutes: number;
    readonly warmupBuckets: number;
  };
}

export interface HistoricalPrior {
  readonly median: number;
  readonly mad: number;
  readonly sampleSize: number;
}

export interface Fire {
  readonly gameId: string;
  readonly bucketStartIso: string;
  readonly observedAtIso: string;
  readonly observedAtSec: number;
  readonly score: number;
  readonly threshold: number;
  readonly period: number | null;
  readonly secondsRemaining: number | null;
  readonly scoreMarginAbs: number | null;
  readonly activeMarketCount: number;
  readonly sourceCount: number;
  readonly familyCount: number;
  readonly offpriceFanout: number;
}

export interface IncidentAlgoResult {
  readonly incidentId: string;
  readonly algoId: string;
  readonly scoreable: boolean;
  readonly caught: boolean;
  readonly leadSeconds: number | null;
  readonly fireIso: string | null;
  readonly skipReason: string | null;
}

export interface MarketOutlierEpisode {
  readonly gameId: string;
  readonly scheduledStart: string;
  readonly matchup: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly startIso: string;
  readonly endIso: string;
  readonly bucketSeconds: number;
  readonly bucketCount: number;
  readonly peakSeverity: number;
  readonly meanSeverity: number;
  readonly peakPriceMoveZ: number;
  readonly peakBreadthZ: number;
  readonly peakOffpriceZ: number;
  readonly peakActiveMarkets: number;
  readonly peakSources: number;
  readonly peakFamilies: number;
  readonly diagnosis: string;
}

export interface MarketOutlierBucketCandidate {
  readonly bucket: Bucket;
  readonly severity: number;
  readonly priceMoveZ: number;
  readonly breadthZ: number;
  readonly offpriceZ: number;
}
