import {
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  BOARD_MAD_WEIGHTING_DEFAULT,
  K_MAD_LIVE,
} from "@signal-console/detectors/board-mad/config";
import {
  BOARD_STATE_SPACE_CONFIG_DEFAULTS,
  type BoardStateSpaceConfig,
} from "@signal-console/detectors/board-mad/state-space-config";

import type {
  MappingStatus,
  MarketFamily,
  ResearchGameStatus,
  ResearchSourceId,
} from "./live-types";
import type { SeverityBand } from "./modes";

export const boardAnomalySourceKinds = ["sportsbook", "prediction-market"] as const;
export type BoardAnomalySourceKind = (typeof boardAnomalySourceKinds)[number];

export const boardAnomalyShockKinds = [
  "pregame-availability",
  "near-tip-availability",
  "game-state-volatility",
  "attribution-shaped",
  "market-structure",
  "cross-surface-disagreement",
  "coverage-gap",
] as const;
export type BoardAnomalyShockKind = (typeof boardAnomalyShockKinds)[number];

export type BoardObservationFlags = {
  isUnmapped: boolean;
  isHeartbeat: boolean;
  isSuspended: boolean;
  isStale: boolean;
};

export type BoardObservationMissing = {
  impliedProbability: boolean;
  line: boolean;
  bestBid: boolean;
  bestAsk: boolean;
  volume: boolean;
  depthScore: boolean;
  tradePrice: boolean;
  tradeSize: boolean;
  participantKey: boolean;
};

export type BoardObservationLabelTokens = {
  rawFamily?: string | null;
  rawLabel?: string | null;
  normalizedTokens: string[];
  participantHints: string[];
  statFamilyHints: string[];
};

export type BoardObservationGameState = {
  status: ResearchGameStatus;
  period?: number | null;
  clock?: string | null;
  homeScore?: number | null;
  awayScore?: number | null;
  scoreMargin?: number | null;
  minutesToTip?: number | null;
};

export type BoardObservation = {
  observationId: string;
  gameId: string;
  source: ResearchSourceId;
  sourceKind: BoardAnomalySourceKind;
  sourceMarketId: string;
  instrumentId?: string | null;
  family?: MarketFamily | null;
  selection?: string | null;
  participantKey?: string | null;
  line?: number | null;
  mappingStatus: MappingStatus;
  displayLabel: string;
  labels: BoardObservationLabelTokens;
  eventTimestamp: string;
  capturedAt: string;
  quoteAgeMs?: number | null;
  impliedProbability?: number | null;
  previousImpliedProbability?: number | null;
  priceMove?: number | null;
  lineMove?: number | null;
  logitMove?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  spread?: number | null;
  depthScore?: number | null;
  volume?: number | null;
  volumeSource?: "quote-tick" | "source-market-metadata" | null;
  tradePrice?: number | null;
  tradeSize?: number | null;
  notional?: number | null;
  volumeShare?: number | null;
  finalMarketVolume?: number | null;
  flags: BoardObservationFlags;
  missing: BoardObservationMissing;
  gameState: BoardObservationGameState;
};

export type H0Adjustment = {
  expectedAbsLogitMove: number;
  expectedAbsLineMove: number;
  expectedAbsTradeDistance: number;
  expectedSpreadFloor: number;
  pregameDriftCap: number;
  closeGameRepricingCap: number;
  staleQuoteSuppression: number;
  reason: string;
};

export type BoardObservationScored = {
  observation: BoardObservation;
  residualLogit: number;
  residualLine: number;
  residualTradeDistance: number;
  microstructure: {
    crossVenue: number;
    liquidity: number;
    offPrice: number;
    volatility: number;
    volumeShare: number;
  };
  h0Adjustment: H0Adjustment;
  h0Suppressed: number;
  contribution: number;
  reason: string;
};

export type BoardShockEvidence = {
  observationId: string;
  source: ResearchSourceId;
  sourceKind: BoardAnomalySourceKind;
  family?: MarketFamily | null;
  participantKey?: string | null;
  displayLabel: string;
  contribution: number;
  reason: string;
  evidenceUnmapped: boolean;
};

export type BoardShockMissingNote = {
  source: ResearchSourceId;
  reason: string;
};

export type BoardAnomalyAlert = {
  id: string;
  gameId: string;
  gameLabel: string;
  shockKind: BoardAnomalyShockKind;
  firstPopAt: string;
  detectedAt: string;
  score: number;
  confidence: number;
  severity: SeverityBand;
  reason: string;
  primaryEntityKey: string | null;
  primaryFamily: MarketFamily | null;
  components: {
    residual: number;
    microstructure: number;
    coherence: number;
    coverage: number;
  };
  h0Adjustments: {
    appliedSuppression: number;
    drivers: string[];
  };
  evidence: BoardShockEvidence[];
  missingDataNotes: BoardShockMissingNote[];
  inspect: {
    payloadVersion: 1;
    instrumentIds: string[];
    sourceMarketIds: string[];
    relationFamilies: string[];
  };
};

export type BoardGameStateVolatilityBand =
  | "insufficient-data"
  | "normal"
  | "elevated"
  | "alert"
  | "critical";

export type BoardVolatilityPhaseKind =
  | "pregame"
  | "near-tip"
  | "tip-burst"
  | "settled-live"
  | "restart-burst"
  | "crunch-time"
  | "final-minute"
  | "final";

export type BoardVolatilityBaselineSource = "calibrated" | "fallback";

export type BoardGameStateVolatilityRuntimeConfig = {
  baselineMode: "trailing" | "opening-ramp" | "historical-blend";
  bucketSeconds: number;
  freshCapSeconds: number;
  kMad: number;
  openingBaselineBuckets: number;
  openingRampCompleteBuckets: number;
  stateSpace: BoardStateSpaceConfig;
  trailingBuckets: number;
  warmupBuckets: number;
  weighting: "equal" | "volume";
};

export type BoardGameStateVolatility = {
  gameId: string;
  gameLabel: string;
  measuredAt: string;
  score: number;
  band: BoardGameStateVolatilityBand;
  confidence: number;
  phase: {
    kind: BoardVolatilityPhaseKind;
    period: number | null;
    clock: string | null;
    secondsFromTip: number | null;
    secondsSinceLastScoreChange: number | null;
  };
  baseline: {
    cohortKey: string;
    source: BoardVolatilityBaselineSource;
    sampleSize: number;
    percentile: number;
    expectedRange: {
      p50: number;
      p75: number;
      p90: number;
      p99: number;
    };
  };
  signals: {
    corePriceShock: number;
    coreLiquidityStress: number;
    coreBreadth: number;
    crossSourceConfirmation: number;
    persistenceSeconds: number;
    supportPropShock: number;
    coveragePenalty: number;
    phaseTransitionBonus: number;
    calibratedAbnormality: number;
  };
  filter: {
    stressLevel: number;
    stressVelocity: number;
    innovation: number;
    observationCount: number;
    bucketSeconds: number;
    decayRegime: BoardVolatilityPhaseKind;
  };
  gates: {
    hasCoreBreadth: boolean;
    hasSourceConfirmation: boolean;
    hasPersistence: boolean;
    criticalEligible: boolean;
  };
  drivers: {
    coreMarkets: BoardShockEvidence[];
    supportingMarkets: BoardShockEvidence[];
  };
  thresholds: {
    normalMaxScore: number;
    elevatedMinScore: number;
    alertMinScore: number;
    criticalMinScore: number;
  };
  components: {
    residual: number;
    microstructure: number;
    coherence: number;
    coverage: number;
  };
  sample: {
    predictionMarketRows: number;
    sourceMarketCount: number;
    shockRows: number;
    families: MarketFamily[];
    coreFamilies: MarketFamily[];
    sources: ResearchSourceId[];
    ready: boolean;
  };
  evidence: BoardShockEvidence[];
  missingDataNotes: BoardShockMissingNote[];
  h0Adjustments: {
    appliedSuppression: number;
    drivers: string[];
  };
  diagnostics: {
    detectorStatus: "warming" | "prewarmed" | "armed" | "firing" | "degraded";
    filteredReasonCounts: Record<string, number>;
    latestQuoteAt: string | null;
    materializedObservationRows: number;
    predictionMarketRows: number;
    rawQuoteRows: number;
    sourceMarketCount: number;
    shockRows: number;
    families: MarketFamily[];
    coreFamilies: MarketFamily[];
    sources: ResearchSourceId[];
    ready: boolean;
  };
  inspect: {
    payloadVersion: 1;
    instrumentIds: string[];
    sourceMarketIds: string[];
    relationFamilies: string[];
  };
  alertId: string | null;
};

export type BoardAnomalyDetectorConfig = {
  shockWindowSeconds: number;
  contextWindowMinutes: number;
  minScore: number;
  minConfidence: number;
  thresholds: {
    logitMove: number;
    lineMove: number;
    tradeDistance: number;
    spread: number;
    depthScoreDrop: number;
    volumeShare: number;
    staleQuoteAgeMinutes: number;
    nearTipMinutes: number;
    closeGameMarginAbs: number;
  };
  weights: {
    residual: number;
    microstructure: number;
    coherence: number;
    coverage: number;
  };
  fanout: {
    sameParticipantBoost: number;
    pairedParticipantBoost: number;
    sameStatFamilyBoost: number;
    sameTeamBoost: number;
    sameFamilyBoost: number;
    unmappedTokenBoost: number;
    sportsbookPredictionDisagreementBoost: number;
  };
  classification: {
    pregameMinutesToTip: number;
    nearTipMinutesToTip: number;
    attributionMinComponents: number;
    coverageGapMinStaleMs: number;
  };
  gameStateVolatility: {
    minPredictionMarketRows: number;
    minShockRows: number;
    minFamilies: number;
    minCoreFamilies: number;
    topEvidenceRows: number;
    runtime: BoardGameStateVolatilityRuntimeConfig;
  };
  suppression: {
    dedupeWindowSeconds: number;
    materialConfidenceJump: number;
  };
};

export const defaultBoardAnomalyDetectorConfig: BoardAnomalyDetectorConfig = {
  shockWindowSeconds: 60,
  contextWindowMinutes: 30,
  minScore: 55,
  minConfidence: 0.55,
  thresholds: {
    logitMove: 0.4,
    lineMove: 0.5,
    tradeDistance: 0.08,
    spread: 0.1,
    depthScoreDrop: 0.3,
    volumeShare: 0.15,
    staleQuoteAgeMinutes: 10,
    nearTipMinutes: 30,
    closeGameMarginAbs: 5,
  },
  weights: {
    residual: 0.45,
    microstructure: 0.3,
    coherence: 0.25,
    coverage: 0,
  },
  fanout: {
    sameParticipantBoost: 1.0,
    pairedParticipantBoost: 0.6,
    sameStatFamilyBoost: 0.5,
    sameTeamBoost: 0.35,
    sameFamilyBoost: 0.25,
    unmappedTokenBoost: 0.2,
    sportsbookPredictionDisagreementBoost: 0.4,
  },
  classification: {
    pregameMinutesToTip: 240,
    nearTipMinutesToTip: 30,
    attributionMinComponents: 2,
    coverageGapMinStaleMs: 10 * 60 * 1000,
  },
  gameStateVolatility: {
    minPredictionMarketRows: 3,
    minShockRows: 0,
    minFamilies: 3,
    minCoreFamilies: 2,
    topEvidenceRows: 8,
    runtime: {
      baselineMode: BOARD_MAD_BASELINE_MODE_DEFAULT,
      bucketSeconds: BOARD_MAD_BUCKET_SECONDS_DEFAULT,
      freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
      kMad: K_MAD_LIVE,
      openingBaselineBuckets: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
      openingRampCompleteBuckets: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
      stateSpace: BOARD_STATE_SPACE_CONFIG_DEFAULTS,
      trailingBuckets: BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
      warmupBuckets: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
      weighting: BOARD_MAD_WEIGHTING_DEFAULT,
    },
  },
  suppression: {
    dedupeWindowSeconds: 120,
    materialConfidenceJump: 0.15,
  },
};

export type BoardAnomalyDetectorInput = {
  gameId: string;
  gameLabel: string;
  gameStates?: Array<{
    awayScore?: number | null;
    capturedAt: string;
    capturedAtMs?: number | null;
    clock?: string | null;
    gameId: string;
    homeScore?: number | null;
    period?: number | null;
    status: ResearchGameStatus;
  }>;
  observations: BoardObservation[];
  now: string;
  scheduledStart?: string;
  materializationDiagnostics?: {
    filteredReasonCounts: Record<string, number>;
    latestQuoteAt: string | null;
    materializedObservationRows: number;
    rawMicrostructureRows: number;
    rawQuoteRows: number;
  };
  config?: Partial<BoardAnomalyDetectorConfig>;
};

export type BoardAnomalyReplayInput = {
  gameId: string;
  gameLabel: string;
  gameStates?: BoardAnomalyDetectorInput["gameStates"];
  observations: BoardObservation[];
  scheduledStart?: string;
  windowStart: string;
  windowEnd: string;
  stepSeconds?: number;
  ingestionLatencyBufferSeconds?: number;
  config?: Partial<BoardAnomalyDetectorConfig>;
};

export type BoardAnomalyReplayOutput = {
  gameId: string;
  gameLabel: string;
  windowStart: string;
  windowEnd: string;
  alertDeck: BoardAnomalyAlert[];
};
