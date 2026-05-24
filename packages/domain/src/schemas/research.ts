import { z } from "zod";

import { severityBandSchema } from "./core";
import {
  canonicalGameSchema,
  canonicalGameStateSchema,
  comparableStateSchema,
  gameOutcomeSchema,
  marketMicrostructureEventTypeSchema,
  marketFamilySchema,
  marketInstrumentSchema,
  mappingStatusSchema,
  marketResearchSourceIdSchema,
  quoteTickSchema,
  rawPayloadAttachmentSchema,
  researchGameStatusSchema,
  researchSourceIdSchema,
  sourceMarketSchema,
} from "./live";
import { marketAnomalyLabels } from "../live-types";
import { isStrictIsoTimestamp, isStrictYmdDate } from "../time";

const booleanQueryParamSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }

  return value;
}, z.boolean());

const positiveIntegerQueryParamSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }

  return value;
}, z.number().int().positive());

const nonNegativeIntegerQueryParamSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }

  return value;
}, z.number().int().nonnegative());

const nonNegativeNumberQueryParamSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }

  return value;
}, z.number().nonnegative());

const isoTimestampQueryParamSchema = z
  .string()
  .min(1)
  .refine((value) => isStrictIsoTimestamp(value), {
    message: "Expected an ISO-8601 timestamp.",
  });

const ymdDateQueryParamSchema = z
  .string()
  .refine((value) => isStrictYmdDate(value), {
    message: "Expected a real YYYY-MM-DD date.",
  });

export const coverageSummarySchema = z.object({
  activeSourceCount: z.number().int().nonnegative(),
  availableSources: z.array(researchSourceIdSchema),
  missingSources: z.array(researchSourceIdSchema),
  unmappedSourceMarketCount: z.number().int().nonnegative(),
});

export const divergenceSummarySchema = z.object({
  instrumentId: z.string(),
  displayLabel: z.string(),
  family: marketFamilySchema,
  impliedProbabilityGap: z.number().nonnegative(),
  lineMismatch: z.boolean(),
  severity: severityBandSchema,
  comparisonSummary: z
    .object({
      threshold: z.number().nonnegative(),
      comparisonCount: z.number().int().nonnegative(),
      firstComparisonAt: z.string().nullable().optional(),
      latestComparisonAt: z.string().nullable().optional(),
      latestGap: z.number().nonnegative().nullable().optional(),
      latestSignedGap: z.number().nullable().optional(),
      latestSourceProbabilities: z
        .record(z.string(), z.number().nullable())
        .optional(),
      maxGap: z.number().nonnegative().nullable().optional(),
      maxGapAt: z.string().nullable().optional(),
      maxGapSourceProbabilities: z
        .record(z.string(), z.number().nullable())
        .optional(),
      minGap: z.number().nonnegative().nullable().optional(),
      firstAboveThresholdAt: z.string().nullable().optional(),
      aboveThresholdDurationMs: z.number().nonnegative(),
    })
    .nullable()
    .optional(),
});

export const latestSourceViewSchema = z.object({
  source: researchSourceIdSchema,
  sourceMarketId: z.string(),
  mappingStatus: mappingStatusSchema,
  raw: z.object({
    label: z.string().nullable().optional(),
    line: z.number().nullable().optional(),
    odds: z.string().nullable().optional(),
    price: z.number().nullable().optional(),
    selectionKey: z.string().nullable().optional(),
    bestBid: z.number().nullable().optional(),
    bestAsk: z.number().nullable().optional(),
    volume: z.number().nullable().optional(),
    depthScore: z.number().nullable().optional(),
  }),
  impliedProbability: z.number().min(0).max(1).nullable().optional(),
  capturedAt: z.string().nullable().optional(),
  freshnessMs: z.number().nullable().optional(),
  lastPayloadId: z.number().int().nullable().optional(),
});

export const marketInstrumentViewSchema = z.object({
  instrument: marketInstrumentSchema,
  mappingStatus: mappingStatusSchema,
  comparableState: comparableStateSchema,
  lineMismatch: z.boolean(),
  signalPriority: z.number().min(0),
  impliedProbabilityGap: z.number().nonnegative().nullable().optional(),
  comparisonSummary: divergenceSummarySchema.shape.comparisonSummary,
  sources: z.array(latestSourceViewSchema),
});

export const researchGameCardSchema = z.object({
  game: canonicalGameSchema,
  gameState: canonicalGameStateSchema.nullable().optional(),
  outcome: gameOutcomeSchema.nullable().optional(),
  activeInstrumentCount: z.number().int().nonnegative(),
  coverage: coverageSummarySchema,
  topDivergences: z.array(divergenceSummarySchema),
  hasUnmappedMarkets: z.boolean(),
});

export const researchGameDetailSchema = z.object({
  game: canonicalGameSchema,
  gameState: canonicalGameStateSchema.nullable().optional(),
  outcome: gameOutcomeSchema.nullable().optional(),
  coverageSummary: coverageSummarySchema,
  marketFamilyCounts: z.array(
    z.object({
      family: marketFamilySchema,
      count: z.number().int().nonnegative(),
    })
  ),
});

export const instrumentComparisonViewSchema = z.object({
  instrument: marketInstrumentSchema,
  gameState: canonicalGameStateSchema.nullable().optional(),
  latestQuotesBySource: z.array(latestSourceViewSchema),
  derivedComparison: z.object({
    comparableState: comparableStateSchema,
    lineMismatch: z.boolean(),
    impliedProbabilityGap: z.number().nonnegative().nullable().optional(),
    sourceCount: z.number().int().nonnegative(),
  }),
  latestRawReferences: z.array(
    z.object({
      source: researchSourceIdSchema,
      payloadId: z.number().int().nonnegative(),
      capturedAt: z.string(),
    })
  ),
});

export const instrumentTimelinePointSchema = z.object({
  source: researchSourceIdSchema,
  capturedAt: z.string(),
  impliedProbability: z.number().min(0).max(1).nullable().optional(),
  line: z.number().nullable().optional(),
  isHeartbeat: z.boolean(),
  bestBid: z.number().nullable().optional(),
  bestAsk: z.number().nullable().optional(),
  depthScore: z.number().nullable().optional(),
  volume: z.number().nullable().optional(),
});

export const instrumentTimelineSchema = z.object({
  quoteSeriesBySource: z.object({
    bet365: z.array(instrumentTimelinePointSchema),
    kalshi: z.array(instrumentTimelinePointSchema),
    polymarket: z.array(instrumentTimelinePointSchema),
    nba: z.array(instrumentTimelinePointSchema),
  }),
  gameStateSeries: z.array(canonicalGameStateSchema),
  annotations: z.array(
    z.object({
      capturedAt: z.string(),
      label: z.string(),
      detail: z.string(),
      source: z
        .enum(["bet365", "kalshi", "polymarket", "nba", "system"])
        .optional(),
    })
  ),
  lineMismatchWindows: z.array(
    z.object({
      start: z.string(),
      end: z.string().nullable().optional(),
      sources: z.array(researchSourceIdSchema),
    })
  ),
});

export const instrumentSourceDiagnosticsSchema = z.object({
  source: researchSourceIdSchema,
  sourceMarket: sourceMarketSchema,
  latestQuote: quoteTickSchema.nullable().optional(),
  latestRawPayload: rawPayloadAttachmentSchema.nullable().optional(),
  freshnessMs: z.number().nullable().optional(),
  diagnostics: z.object({
    mappingStatus: mappingStatusSchema,
    lineMismatch: z.boolean(),
    captureLagMs: z.number().nullable().optional(),
  }),
});

export const divergenceRowSchema = z.object({
  gameId: z.string(),
  gameStatus: researchGameStatusSchema,
  instrumentId: z.string(),
  displayLabel: z.string(),
  sport: z.string(),
  league: z.string(),
  scheduledStart: z.string(),
  family: marketFamilySchema,
  inPlay: z.boolean(),
  comparableState: comparableStateSchema,
  mappingStatus: mappingStatusSchema,
  lineMismatch: z.boolean(),
  impliedProbabilityGap: z.number().nonnegative().nullable().optional(),
  comparisonSummary: divergenceSummarySchema.shape.comparisonSummary,
  sources: z.array(researchSourceIdSchema),
  signalPriority: z.number().min(0),
  captureRecencyMs: z.number().nullable().optional(),
  severity: severityBandSchema,
});

export const signalMismatchRowSchema = divergenceRowSchema.extend({
  gameLabel: z.string(),
  scheduledStart: z.string(),
  gameStatus: researchGameStatusSchema,
  finalAwayScore: z.number().int().nullable().optional(),
  finalHomeScore: z.number().int().nullable().optional(),
  bet365ImpliedProbability: z.number().min(0).max(1).nullable().optional(),
  kalshiImpliedProbability: z.number().min(0).max(1).nullable().optional(),
  polymarketImpliedProbability: z.number().min(0).max(1).nullable().optional(),
  directionalDisagreement: z.boolean(),
});

export const playerPropAlertSourceSchema = z.object({
  source: z.enum(["bet365", "kalshi", "polymarket"]),
  sourceMarketId: z.string(),
  sourceMarketKey: z.string(),
  sourceSelectionKey: z.string().nullable().optional(),
  rawLabel: z.string().nullable().optional(),
  mappingStatus: mappingStatusSchema,
  impliedProbability: z.number().min(0).max(1),
  capturedAt: z.string(),
  lineRaw: z.number().nullable().optional(),
  oddsRaw: z.string().nullable().optional(),
  priceRaw: z.number().nullable().optional(),
  bestBid: z.number().nullable().optional(),
  bestAsk: z.number().nullable().optional(),
  volume: z.number().nullable().optional(),
});

export const playerPropDisagreementAlertSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  instrumentId: z.string(),
  gameLabel: z.string(),
  sport: z.string(),
  league: z.string(),
  scheduledStart: z.string(),
  displayLabel: z.string(),
  participantKey: z.string().nullable().optional(),
  selection: z.string(),
  line: z.number().nullable().optional(),
  inPlay: z.boolean(),
  severity: severityBandSchema,
  riskScore: z.number().min(0),
  absoluteDelta: z.number().min(0).max(1),
  signedDelta: z.number().min(-1).max(1),
  direction: z.enum(["bet365-higher", "prediction-market-higher"]),
  detectedAt: z.string(),
  lineMismatch: z.boolean(),
  bet365: playerPropAlertSourceSchema,
  predictionMarket: playerPropAlertSourceSchema,
  freshness: z.object({
    bet365AgeMs: z.number().min(0),
    predictionMarketAgeMs: z.number().min(0),
    quoteTimeGapMs: z.number().min(0).optional(),
  }),
  action: z.literal("manual-review"),
});

export const marketAnomalyScoreConfigSchema = z.object({
  profileId: z.string().min(1),
  minScore: z.number().min(0),
  minConfidence: z.number().min(0).max(1),
  shockWindowSeconds: z.number().int().positive(),
  contextWindowMinutes: z.number().positive(),
  weights: z.object({
    crossVenue: z.number().min(0),
    liquidity: z.number().min(0),
    offPrice: z.number().min(0),
    volatility: z.number().min(0),
    volumeShare: z.number().min(0),
  }),
  thresholds: z.object({
    depthScoreDrop: z.number().min(0),
    maxQuoteAgeMinutes: z.number().min(0),
    priceJump: z.number().min(0).max(1),
    spread: z.number().min(0),
    tradeDistance: z.number().min(0).max(1),
    volumeShare: z.number().min(0),
  }),
  toggles: z.object({
    includeHistorical: z.boolean(),
    includeUnmapped: z.boolean(),
    requireBet365: z.boolean(),
  }),
  families: z.array(marketFamilySchema),
  updatedAt: z.string().nullable().optional(),
  updatedBy: z.string().nullable().optional(),
});

export const marketAnomalyAlertSchema = z.object({
  id: z.string(),
  action: z.literal("manual-review"),
  apiSurface: z.string(),
  confidence: z.number().min(0).max(1),
  detectedAt: z.string(),
  displayLabel: z.string(),
  eventTimestamp: z.string(),
  eventType: marketMicrostructureEventTypeSchema,
  family: marketFamilySchema.nullable().optional(),
  gameId: z.string(),
  gameLabel: z.string(),
  instrumentId: z.string().nullable().optional(),
  labels: z.array(z.enum(marketAnomalyLabels)),
  league: z.string(),
  mappingStatus: mappingStatusSchema,
  rawLabel: z.string().nullable().optional(),
  score: z.number().min(0),
  severity: severityBandSchema,
  source: marketResearchSourceIdSchema,
  sourceMarketId: z.string(),
  sourceMarketKey: z.string(),
  sourceSelectionKey: z.string().nullable().optional(),
  sport: z.string(),
  components: z.object({
    crossVenue: z.number().min(0),
    liquidity: z.number().min(0),
    offPrice: z.number().min(0),
    volatility: z.number().min(0),
    volumeShare: z.number().min(0),
  }),
  metrics: z.object({
    bestAsk: z.number().nullable().optional(),
    bestBid: z.number().nullable().optional(),
    crossVenueGap: z.number().nullable().optional(),
    depthScore: z.number().nullable().optional(),
    finalMarketVolume: z.number().nullable().optional(),
    notional: z.number().nullable().optional(),
    price: z.number().nullable().optional(),
    priceChange: z.number().nullable().optional(),
    referencePrice: z.number().nullable().optional(),
    size: z.number().nullable().optional(),
    spread: z.number().nullable().optional(),
    tradeDistance: z.number().nullable().optional(),
    tradePrice: z.number().nullable().optional(),
    volume: z.number().nullable().optional(),
    volumeShare: z.number().nullable().optional(),
  }),
});

export const marketAnomalyPlaybackFrameSchema = z.object({
  source: z.literal("market-anomaly-watch"),
  alertCount: z.number().int().nonnegative(),
  alerts: z.array(marketAnomalyAlertSchema),
  capturedAt: z.string(),
  notifiedAlertIds: z.array(z.string()),
  poll: z.object({
    includeHistorical: z.boolean(),
    includeUnmapped: z.boolean(),
    limit: z.number().int().positive(),
    minConfidence: z.number().min(0).max(1),
    minScore: z.number().min(0),
    requireBet365: z.boolean(),
  }),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string(),
    })
    .optional(),
});

export const coverageRowSchema = z.object({
  gameId: z.string(),
  instrumentId: z.string().nullable().optional(),
  sport: z.string(),
  league: z.string(),
  family: marketFamilySchema.nullable().optional(),
  availableSources: z.array(researchSourceIdSchema),
  missingSources: z.array(researchSourceIdSchema),
  unmappedSources: z.array(researchSourceIdSchema),
});

export const adminSourceHealthSchema = z.object({
  source: z.string(),
  configured: z.boolean(),
  authState: z.enum(["configured", "missing", "invalid"]),
  bootstrapState: z.enum(["ready", "missing", "invalid"]).optional(),
  lastSuccessAt: z.string().nullable().optional(),
  lagMs: z.number().nullable().optional(),
  currentBackoffMs: z.number().nullable().optional(),
  subscriptionState: z.enum(["active", "inactive", "unknown"]).optional(),
  status: z.enum(["ok", "error"]),
});

export const adminRuntimeConfigItemSchema = z.object({
  category: z.string(),
  configured: z.boolean(),
  defaultValue: z.string().nullable().optional(),
  description: z.string(),
  inputType: z.enum([
    "boolean",
    "number",
    "password",
    "path",
    "select",
    "text",
    "url",
  ]),
  key: z.string(),
  label: z.string(),
  options: z.array(z.string()).optional(),
  restartRequired: z.boolean(),
  sensitive: z.boolean(),
  source: z.literal("env"),
  valuePreview: z.string().nullable().optional(),
});

export const adminUnmappedMarketSchema = z.object({
  sourceMarket: sourceMarketSchema,
  game: canonicalGameSchema.nullable().optional(),
  latestQuote: quoteTickSchema.nullable().optional(),
});

export const storageCoverageRowSchema = z.object({
  source: z.string(),
  sport: z.string(),
  league: z.string(),
  gameId: z.string(),
  family: marketFamilySchema.nullable().optional(),
  sourceMarketCount: z.number().int().nonnegative(),
  quoteTickCount: z.number().int().nonnegative(),
  rawPayloadCount: z.number().int().nonnegative(),
});

export const gamesQuerySchema = z.object({
  date: z.string().optional(),
  hasUnmappedMarkets: booleanQueryParamSchema.optional(),
  league: z.string().optional(),
  limit: positiveIntegerQueryParamSchema.optional(),
  sourceCoverage: z.string().optional(),
  sport: z.string().optional(),
  status: z.string().optional(),
});

export const gameMarketsQuerySchema = z.object({
  family: marketFamilySchema.optional(),
  inPlay: booleanQueryParamSchema.optional(),
  mappedOnly: booleanQueryParamSchema.optional(),
  source: researchSourceIdSchema.optional(),
});

export const instrumentTimelineQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  resolution: z.string().optional(),
  source: z.array(researchSourceIdSchema).optional(),
});

export const researchDivergenceQuerySchema = z.object({
  sport: z.string().optional(),
  league: z.string().optional(),
  date: ymdDateQueryParamSchema.optional(),
  family: marketFamilySchema.optional(),
  inPlay: booleanQueryParamSchema.optional(),
  sourceSet: z.string().optional(),
  severity: severityBandSchema.optional(),
  freshness: z.string().optional(),
  limit: positiveIntegerQueryParamSchema.optional(),
  mappedState: comparableStateSchema.optional(),
  sort: z
    .enum([
      "divergence",
      "freshness",
      "captureRecency",
      "lineMismatch",
      "signalPriority",
    ])
    .optional(),
});

export const boardAlertIncidentsQuerySchema = z.object({
  date: ymdDateQueryParamSchema,
  gameId: z.string().optional(),
  minGap: nonNegativeNumberQueryParamSchema.optional(),
  limit: positiveIntegerQueryParamSchema.optional(),
});

export const boardAlertEventContextQuerySchema = z.object({
  alertId: z.string().optional(),
  at: isoTimestampQueryParamSchema,
  gameId: z.string().min(1),
  limit: positiveIntegerQueryParamSchema.optional(),
  windowSecondsAfter: nonNegativeIntegerQueryParamSchema.optional(),
  windowSecondsBefore: nonNegativeIntegerQueryParamSchema.optional(),
});

export const boardAlertReplayQuerySchema = z
  .object({
    gameId: z.string().min(1),
    stepSeconds: positiveIntegerQueryParamSchema.optional(),
    windowEnd: isoTimestampQueryParamSchema,
    windowStart: isoTimestampQueryParamSchema,
  })
  .superRefine((value, context) => {
    if (Date.parse(value.windowEnd) <= Date.parse(value.windowStart)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "windowEnd must be after windowStart.",
        path: ["windowEnd"],
      });
    }
  });

export const mappingResolveBodySchema = z.object({
  sourceMarketId: z.string().min(1),
  instrumentId: z.string().min(1),
  reason: z.string().min(1),
  resolvedBy: z.string().default("operator"),
});

export const backfillGamesBodySchema = z.object({
  sport: z.string().default("basketball"),
  league: z.string().default("NBA"),
  dateFrom: z.string(),
  dateTo: z.string(),
});

export const backfillMarketsBodySchema = z.object({
  source: z.string().optional(),
  gameId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export const captureRestartBodySchema = z.object({
  source: z.string().optional(),
});
