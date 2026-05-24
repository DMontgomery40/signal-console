import type { SeverityBand } from "./modes";

export const sportsbookResearchSourceIds = [
  "bet365",
  "fanduel",
  "draftkings",
] as const;

export const predictionMarketResearchSourceIds = [
  "kalshi",
  "polymarket",
] as const;

export const marketResearchSourceIds = [
  ...sportsbookResearchSourceIds,
  ...predictionMarketResearchSourceIds,
] as const;

export const researchSourceIds = [...marketResearchSourceIds, "nba"] as const;

export type ResearchSourceId = (typeof researchSourceIds)[number];
export type MarketResearchSourceId = (typeof marketResearchSourceIds)[number];

export const marketFamilies = [
  "moneyline",
  "spread",
  "total",
  "player-prop",
  "team-prop",
  "other",
] as const;

export type MarketFamily = (typeof marketFamilies)[number];

export const researchGameStatuses = [
  "scheduled",
  "in-play",
  "final",
  "postponed",
  "cancelled",
] as const;

export type ResearchGameStatus = (typeof researchGameStatuses)[number];

export const mappingStatuses = ["auto", "manual", "unmapped"] as const;

export type MappingStatus = (typeof mappingStatuses)[number];

export const comparableStates = [
  "comparable",
  "line-mismatch",
  "selection-mismatch",
  "unmapped",
] as const;

export type ComparableState = (typeof comparableStates)[number];

export const adapterRunStatuses = ["queued", "running", "ok", "error"] as const;

export type AdapterRunStatus = (typeof adapterRunStatuses)[number];

export const adapterCaptureModes = ["discovery", "historical", "live"] as const;

export type AdapterCaptureMode = (typeof adapterCaptureModes)[number];

export const adminActionStatuses = [
  "queued",
  "accepted",
  "completed",
  "error",
] as const;

export type AdminActionStatus = (typeof adminActionStatuses)[number];

export const marketMicrostructureEventTypes = [
  "trade",
  "price-tick",
  "candlestick",
  "book-snapshot",
] as const;

export type MarketMicrostructureEventType =
  (typeof marketMicrostructureEventTypes)[number];

export const marketAnomalyLabels = [
  "isolated off-price print",
  "volume-share anomaly",
  "sustained repricing",
  "volatility shock",
  "liquidity shock",
  "cross-venue disagreement",
  "coverage gap",
] as const;

export type MarketAnomalyLabel = (typeof marketAnomalyLabels)[number];

export type GameParticipant = {
  key: string;
  name: string;
  shortName: string;
  abbreviation?: string | null;
  side?: "home" | "away" | null;
};

export type CanonicalGame = {
  id: string;
  sport: string;
  league: string;
  sourceGameKeyNba?: string | null;
  homeParticipant: GameParticipant;
  awayParticipant: GameParticipant;
  scheduledStart: string;
};

export type CanonicalGameState = {
  id: number;
  gameId: string;
  capturedAt: string;
  status: ResearchGameStatus;
  period?: number | null;
  clock?: string | null;
  homeScore?: number | null;
  awayScore?: number | null;
  startedAt?: string | null;
  finalAt?: string | null;
  isFinal: boolean;
};

export type GameOutcome = {
  gameId: string;
  finalHomeScore: number;
  finalAwayScore: number;
  winnerKey?: string | null;
  capturedAt: string;
};

export type MarketInstrument = {
  id: string;
  gameId: string;
  family: MarketFamily;
  selection: string;
  line?: number | null;
  participantKey?: string | null;
  inPlay: boolean;
  displayLabel: string;
};

export type SourceMarket = {
  id: string;
  source: ResearchSourceId;
  sourceMarketKey: string;
  sourceSelectionKey?: string | null;
  gameId: string;
  instrumentId?: string | null;
  rawFamily?: string | null;
  rawLabel?: string | null;
  mappingStatus: MappingStatus;
  rawMetadata?: Record<string, unknown> | null;
};

export type QuoteTick = {
  id: number;
  sourceMarketId: string;
  capturedAt: string;
  priceRaw?: number | null;
  oddsRaw?: string | null;
  lineRaw?: number | null;
  impliedProbability?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  volume?: number | null;
  depthScore?: number | null;
  isHeartbeat: boolean;
};

export type MarketMicrostructureEvent = {
  id: number;
  source: MarketResearchSourceId;
  sourceMarketId: string;
  gameId: string;
  instrumentId?: string | null;
  eventType: MarketMicrostructureEventType;
  apiSurface: string;
  eventTimestamp: string;
  capturedAt: string;
  price?: number | null;
  previousPrice?: number | null;
  tradePrice?: number | null;
  size?: number | null;
  notional?: number | null;
  volume?: number | null;
  finalMarketVolume?: number | null;
  volumeShare?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  spread?: number | null;
  depthScore?: number | null;
  rawPayloadId?: number | null;
  rawMetadata?: Record<string, unknown> | null;
};

export type RawPayloadAttachment = {
  id: number;
  source: ResearchSourceId;
  capturedAt: string;
  entityType: string;
  entityId: string;
  payloadJson: Record<string, unknown>;
  contentHash: string;
};

export type AdapterRun = {
  id: number;
  source: string;
  startedAt: string;
  finishedAt?: string | null;
  status: AdapterRunStatus;
  captureMode?: AdapterCaptureMode;
  errorCode?: string | null;
  errorMessage?: string | null;
  recordsSeen: number;
  recordsWritten: number;
};

export type MappingResolution = {
  id: number;
  sourceMarketId: string;
  instrumentId: string;
  resolvedBy: string;
  resolvedAt: string;
  reason: string;
};

export type CoverageSummary = {
  activeSourceCount: number;
  availableSources: ResearchSourceId[];
  missingSources: ResearchSourceId[];
  unmappedSourceMarketCount: number;
};

export type DivergenceSummary = {
  instrumentId: string;
  displayLabel: string;
  family: MarketFamily;
  impliedProbabilityGap: number;
  lineMismatch: boolean;
  severity: SeverityBand;
  comparisonSummary?: InstrumentDivergenceSummary | null;
};

export type InstrumentDivergenceSummary = {
  threshold: number;
  comparisonCount: number;
  firstComparisonAt?: string | null;
  latestComparisonAt?: string | null;
  latestGap?: number | null;
  latestSignedGap?: number | null;
  latestSourceProbabilities?: Record<string, number | null>;
  maxGap?: number | null;
  maxGapAt?: string | null;
  maxGapSourceProbabilities?: Record<string, number | null>;
  minGap?: number | null;
  firstAboveThresholdAt?: string | null;
  aboveThresholdDurationMs: number;
};

export type LatestSourceView = {
  source: ResearchSourceId;
  sourceMarketId: string;
  mappingStatus: MappingStatus;
  raw: {
    label?: string | null;
    line?: number | null;
    odds?: string | null;
    price?: number | null;
    selectionKey?: string | null;
    bestBid?: number | null;
    bestAsk?: number | null;
    volume?: number | null;
    depthScore?: number | null;
  };
  impliedProbability?: number | null;
  capturedAt?: string | null;
  freshnessMs?: number | null;
  lastPayloadId?: number | null;
};

export type MarketInstrumentView = {
  instrument: MarketInstrument;
  mappingStatus: MappingStatus;
  comparableState: ComparableState;
  lineMismatch: boolean;
  signalPriority: number;
  impliedProbabilityGap?: number | null;
  comparisonSummary?: InstrumentDivergenceSummary | null;
  sources: LatestSourceView[];
};

export type ResearchGameCard = {
  game: CanonicalGame;
  gameState?: CanonicalGameState | null;
  outcome?: GameOutcome | null;
  activeInstrumentCount: number;
  coverage: CoverageSummary;
  topDivergences: DivergenceSummary[];
  hasUnmappedMarkets: boolean;
};

export type ResearchGameDetail = {
  game: CanonicalGame;
  gameState?: CanonicalGameState | null;
  outcome?: GameOutcome | null;
  coverageSummary: CoverageSummary;
  marketFamilyCounts: Array<{
    family: MarketFamily;
    count: number;
  }>;
};

export type InstrumentComparisonView = {
  instrument: MarketInstrument;
  gameState?: CanonicalGameState | null;
  latestQuotesBySource: LatestSourceView[];
  derivedComparison: {
    comparableState: ComparableState;
    lineMismatch: boolean;
    impliedProbabilityGap?: number | null;
    comparisonSummary?: InstrumentDivergenceSummary | null;
    sourceCount: number;
  };
  latestRawReferences: Array<{
    source: ResearchSourceId;
    payloadId: number;
    capturedAt: string;
  }>;
};

export type InstrumentTimelinePoint = {
  source: ResearchSourceId;
  capturedAt: string;
  impliedProbability?: number | null;
  line?: number | null;
  isHeartbeat: boolean;
  bestBid?: number | null;
  bestAsk?: number | null;
  depthScore?: number | null;
  volume?: number | null;
};

export type InstrumentTimeline = {
  quoteSeriesBySource: Record<ResearchSourceId, InstrumentTimelinePoint[]>;
  gameStateSeries: CanonicalGameState[];
  annotations: Array<{
    capturedAt: string;
    label: string;
    detail: string;
    source?: ResearchSourceId | "system";
  }>;
  lineMismatchWindows: Array<{
    start: string;
    end?: string | null;
    sources: ResearchSourceId[];
  }>;
};

export type InstrumentSourceDiagnostics = {
  source: ResearchSourceId;
  sourceMarket: SourceMarket;
  latestQuote?: QuoteTick | null;
  latestRawPayload?: RawPayloadAttachment | null;
  freshnessMs?: number | null;
  diagnostics: {
    mappingStatus: MappingStatus;
    lineMismatch: boolean;
    captureLagMs?: number | null;
  };
};

export type DivergenceRow = {
  gameId: string;
  gameStatus: ResearchGameStatus;
  instrumentId: string;
  displayLabel: string;
  sport: string;
  league: string;
  scheduledStart: string;
  family: MarketFamily;
  inPlay: boolean;
  comparableState: ComparableState;
  mappingStatus: MappingStatus;
  lineMismatch: boolean;
  impliedProbabilityGap?: number | null;
  comparisonSummary?: InstrumentDivergenceSummary | null;
  sources: ResearchSourceId[];
  signalPriority: number;
  captureRecencyMs?: number | null;
  severity: SeverityBand;
};

export type SignalMismatchRow = DivergenceRow & {
  gameLabel: string;
  scheduledStart: string;
  gameStatus: ResearchGameStatus;
  finalAwayScore?: number | null;
  finalHomeScore?: number | null;
  bet365ImpliedProbability?: number | null;
  kalshiImpliedProbability?: number | null;
  polymarketImpliedProbability?: number | null;
  directionalDisagreement: boolean;
};

export type PlayerPropAlertSource = {
  source: Extract<ResearchSourceId, "bet365" | "kalshi" | "polymarket">;
  sourceMarketId: string;
  sourceMarketKey: string;
  sourceSelectionKey?: string | null;
  rawLabel?: string | null;
  mappingStatus: MappingStatus;
  impliedProbability: number;
  capturedAt: string;
  lineRaw?: number | null;
  oddsRaw?: string | null;
  priceRaw?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  volume?: number | null;
};

export type PlayerPropDisagreementAlert = {
  id: string;
  gameId: string;
  instrumentId: string;
  gameLabel: string;
  sport: string;
  league: string;
  scheduledStart: string;
  displayLabel: string;
  participantKey?: string | null;
  selection: string;
  line?: number | null;
  inPlay: boolean;
  severity: SeverityBand;
  riskScore: number;
  absoluteDelta: number;
  signedDelta: number;
  direction: "bet365-higher" | "prediction-market-higher";
  detectedAt: string;
  lineMismatch: boolean;
  bet365: PlayerPropAlertSource;
  predictionMarket: PlayerPropAlertSource;
  freshness: {
    bet365AgeMs: number;
    predictionMarketAgeMs: number;
    quoteTimeGapMs?: number;
  };
  action: "manual-review";
};

export type PlayerPropAlertPlaybackFrame = {
  source: "player-prop-alert-watch";
  capturedAt: string;
  alertCount: number;
  alerts: PlayerPropDisagreementAlert[];
  notifiedAlertIds: string[];
  poll: {
    includeStale: boolean;
    limit: number;
    maxQuoteTimeGapMinutes: number;
    maxQuoteAgeMinutes: number;
    minDelta: number;
  };
  error?: {
    code?: string;
    message: string;
  };
};

export type MarketAnomalyScoreConfig = {
  profileId: string;
  minScore: number;
  minConfidence: number;
  shockWindowSeconds: number;
  contextWindowMinutes: number;
  weights: {
    crossVenue: number;
    liquidity: number;
    offPrice: number;
    volatility: number;
    volumeShare: number;
  };
  thresholds: {
    depthScoreDrop: number;
    maxQuoteAgeMinutes: number;
    priceJump: number;
    spread: number;
    tradeDistance: number;
    volumeShare: number;
  };
  toggles: {
    includeHistorical: boolean;
    includeUnmapped: boolean;
    requireBet365: boolean;
  };
  families: MarketFamily[];
  updatedAt?: string | null;
  updatedBy?: string | null;
};

export type MarketAnomalyAlert = {
  id: string;
  action: "manual-review";
  apiSurface: string;
  confidence: number;
  detectedAt: string;
  displayLabel: string;
  eventTimestamp: string;
  eventType: MarketMicrostructureEventType;
  family?: MarketFamily | null;
  gameId: string;
  gameLabel: string;
  instrumentId?: string | null;
  labels: MarketAnomalyLabel[];
  league: string;
  mappingStatus: MappingStatus;
  rawLabel?: string | null;
  score: number;
  severity: SeverityBand;
  source: Extract<ResearchSourceId, "bet365" | "kalshi" | "polymarket">;
  sourceMarketId: string;
  sourceMarketKey: string;
  sourceSelectionKey?: string | null;
  sport: string;
  components: {
    crossVenue: number;
    liquidity: number;
    offPrice: number;
    volatility: number;
    volumeShare: number;
  };
  metrics: {
    bestAsk?: number | null;
    bestBid?: number | null;
    crossVenueGap?: number | null;
    depthScore?: number | null;
    finalMarketVolume?: number | null;
    notional?: number | null;
    price?: number | null;
    priceChange?: number | null;
    referencePrice?: number | null;
    size?: number | null;
    spread?: number | null;
    tradeDistance?: number | null;
    tradePrice?: number | null;
    volume?: number | null;
    volumeShare?: number | null;
  };
};

export type MarketAnomalyPlaybackFrame = {
  source: "market-anomaly-watch";
  alertCount: number;
  alerts: MarketAnomalyAlert[];
  capturedAt: string;
  notifiedAlertIds: string[];
  poll: {
    includeHistorical: boolean;
    includeUnmapped: boolean;
    limit: number;
    minConfidence: number;
    minScore: number;
    requireBet365: boolean;
  };
  error?: {
    code?: string;
    message: string;
  };
};

export type CoverageRow = {
  gameId: string;
  instrumentId?: string | null;
  sport: string;
  league: string;
  family?: MarketFamily | null;
  availableSources: ResearchSourceId[];
  missingSources: ResearchSourceId[];
  unmappedSources: ResearchSourceId[];
};

export type AdminSourceHealth = {
  source: string;
  configured: boolean;
  authState: "configured" | "missing" | "invalid";
  bootstrapState?: "ready" | "missing" | "invalid";
  lastSuccessAt?: string | null;
  lagMs?: number | null;
  currentBackoffMs?: number | null;
  subscriptionState?: "active" | "inactive" | "unknown";
  status: "ok" | "error";
};

export type AdminRuntimeConfigItem = {
  category: string;
  configured: boolean;
  defaultValue?: string | null;
  description: string;
  inputType:
    | "boolean"
    | "number"
    | "password"
    | "path"
    | "select"
    | "text"
    | "url";
  key: string;
  label: string;
  options?: string[];
  restartRequired: boolean;
  sensitive: boolean;
  source: "env";
  valuePreview?: string | null;
};

export type AdminUnmappedMarket = {
  sourceMarket: SourceMarket;
  game?: CanonicalGame | null;
  latestQuote?: QuoteTick | null;
};

export type StorageCoverageRow = {
  source: string;
  sport: string;
  league: string;
  gameId: string;
  family?: MarketFamily | null;
  sourceMarketCount: number;
  quoteTickCount: number;
  rawPayloadCount: number;
};
