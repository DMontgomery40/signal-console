import { existsSync } from "node:fs";
import { basename } from "node:path";

import type {
  AdminSourceHealth,
  AdminUnmappedMarket,
  CanonicalGame,
  CanonicalGameState,
  ComparableState,
  CoverageRow,
  CoverageSummary,
  DivergenceRow,
  DivergenceSummary,
  GameOutcome,
  InstrumentComparisonView,
  InstrumentDivergenceSummary,
  InstrumentSourceDiagnostics,
  InstrumentTimeline,
  InstrumentTimelinePoint,
  LatestSourceView,
  MarketAnomalyAlert,
  MarketAnomalyLabel,
  MarketAnomalyScoreConfig,
  MappingStatus,
  MarketFamily,
  MarketInstrument,
  MarketInstrumentView,
  MarketMicrostructureEvent,
  MarketMicrostructureEventType,
  QuoteTick,
  RawPayloadAttachment,
  ResearchGameCard,
  ResearchGameDetail,
  ResearchGameStatus,
  ResearchSourceId,
  SignalMismatchRow,
  SourceMarket,
  StorageCoverageRow,
} from "@signal-console/domain";
import { marketFamilies, researchSourceIds } from "@signal-console/domain";

import {
  currentTimestamp,
  executeDatabaseOperation,
  getDatabase,
  getDatabasePath,
  getDatabaseSchemaVersion,
} from "./db-core";
import { DatabaseFailureError } from "./errors";
import { resolveOddsApiKey } from "./env";
import {
  gapToSeverity,
  lineValuesMatch,
  normalizeAlertNumber,
  nullableNumber,
  sourceSelectionMatchesInstrument,
  timestampValue,
  toBoolean,
} from "./live-repository-support";
import {
  getInstrumentDeltaSeries,
  getInstrumentDeltaSummaries,
  summarizeDeltaSeries,
} from "./signal-quality";

import type Database from "better-sqlite3";

export {
  listPlayerPropDisagreementAlerts,
  type PlayerPropAlertFilters,
} from "./player-prop-alert-repository";

type JsonValue = Record<string, unknown> | null | undefined;

type MarketFilters = {
  family?: MarketFamily;
  inPlay?: boolean;
  mappedOnly?: boolean;
  source?: ResearchSourceId;
};

type GamesFilters = {
  date?: string;
  gameId?: string;
  hasUnmappedMarkets?: boolean;
  league?: string;
  limit?: number;
  referenceNow?: string;
  scope?: "all" | "currentSlate";
  sourceCoverage?: string;
  sport?: string;
  status?: string;
};

type DivergenceFilters = {
  date?: string;
  family?: MarketFamily;
  freshness?: string;
  gameId?: string;
  inPlay?: boolean;
  league?: string;
  limit?: number;
  mappedState?: ComparableState;
  severity?: "low" | "medium" | "high" | "critical";
  sort?: "captureRecency" | "divergence" | "freshness" | "lineMismatch" | "signalPriority";
  sourceSet?: string;
  sport?: string;
};

type MarketAnomalyFilters = {
  date?: string;
  family?: MarketFamily;
  gameId?: string;
  includeHistorical?: boolean;
  includeUnmapped?: boolean;
  limit?: number;
  minConfidence?: number;
  minScore?: number;
  now?: Date | string;
  profileId?: string;
  requireBet365?: boolean;
  skipQuoteAnomalies?: boolean;
  source?: Extract<ResearchSourceId, "bet365" | "fanduel" | "draftkings" | "kalshi" | "polymarket">;
};

type QuoteObservationInput = Omit<QuoteTick, "id" | "isHeartbeat"> & {
  heartbeatAfterMs?: number;
};

type MarketMicrostructureEventInput = Omit<MarketMicrostructureEvent, "id" | "capturedAt"> & {
  capturedAt?: string;
};

type AdminActionPayload = {
  payloadJson: Record<string, unknown>;
  requestedBy?: string;
  scope: string;
};

export type AdminActionStatus = "completed" | "error" | "queued" | "running";

export type AdminActionRecord = {
  actionType: string;
  id: number;
  payloadJson: Record<string, unknown>;
  requestedAt: string;
  requestedBy: string;
  scope: string;
  status: AdminActionStatus;
};

function parseJson<T>(payload: string | null | undefined, fallback: T): T {
  if (!payload) {
    return fallback;
  }

  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    throw new DatabaseFailureError("Stored JSON payload is corrupt.", {
      cause: error,
      details: {
        payload,
      },
      operatorHint: "Inspect the offending SQLite JSON column before retrying this read path.",
    });
  }
}

function stringifyJson(payload: JsonValue) {
  return JSON.stringify(payload ?? {});
}

function scoreToSeverity(score: number) {
  if (score >= 85) {
    return "critical" as const;
  }
  if (score >= 65) {
    return "high" as const;
  }
  if (score >= 40) {
    return "medium" as const;
  }
  return "low" as const;
}

function computeCoverageSummary(
  sourceMarkets: SourceMarket[],
  latestTicks: Map<string, QuoteTick>,
  hasNbaState: boolean,
): CoverageSummary {
  const availableSources = new Set<ResearchSourceId>();
  const unmappedSourceMarketCount = sourceMarkets.filter(
    (market) => market.mappingStatus === "unmapped",
  ).length;

  for (const sourceMarket of sourceMarkets) {
    if (latestTicks.has(sourceMarket.id)) {
      availableSources.add(sourceMarket.source);
    }
  }

  if (hasNbaState) {
    availableSources.add("nba");
  }

  const available = researchSourceIds.filter((sourceId) => availableSources.has(sourceId));

  return {
    activeSourceCount: available.length,
    availableSources: available,
    missingSources: researchSourceIds.filter((sourceId) => !availableSources.has(sourceId)),
    unmappedSourceMarketCount,
  };
}

function computeMappingStatus(sourceMarkets: SourceMarket[]): MappingStatus {
  if (sourceMarkets.length === 0) {
    return "unmapped";
  }
  if (sourceMarkets.some((sourceMarket) => sourceMarket.mappingStatus === "unmapped")) {
    return "unmapped";
  }
  if (sourceMarkets.some((sourceMarket) => sourceMarket.mappingStatus === "manual")) {
    return "manual";
  }
  return "auto";
}

function computeComparableState(
  instrument: MarketInstrument,
  mappingStatus: MappingStatus,
  latestSources: LatestSourceView[],
  game?: CanonicalGame,
): ComparableState {
  if (mappingStatus === "unmapped") {
    return "unmapped";
  }

  if (latestSources.some((source) => !sourceSelectionMatchesInstrument(instrument, source, game))) {
    return "selection-mismatch";
  }

  if (
    instrument.family !== "moneyline" &&
    latestSources.some((source) => !lineValuesMatch(source.raw.line, instrument.line))
  ) {
    return "line-mismatch";
  }

  return "comparable";
}

function computeImpliedProbabilityGap(latestSources: LatestSourceView[]) {
  const comparable = latestSources
    .map((source) => ({
      capturedAt: timestampValue(source.capturedAt),
      impliedProbability: source.impliedProbability,
      source: source.source,
    }))
    .filter(
      (
        source,
      ): source is {
        capturedAt: number;
        impliedProbability: number;
        source: ResearchSourceId;
      } => source.capturedAt >= 0 && typeof source.impliedProbability === "number",
    );

  if (comparable.length < 2) {
    return null;
  }

  const sameTimeWindowMs = 10 * 60_000;
  const bet365Rows = comparable.filter((source) => source.source === "bet365");
  const exchangeRows = comparable.filter(
    (source) => source.source === "kalshi" || source.source === "polymarket",
  );
  if (bet365Rows.length === 0 || exchangeRows.length === 0) {
    return null;
  }

  let maxGap: number | null = null;
  for (const book of bet365Rows) {
    for (const exchange of exchangeRows) {
      if (Math.abs(book.capturedAt - exchange.capturedAt) > sameTimeWindowMs) {
        continue;
      }
      const gap = Math.abs(book.impliedProbability - exchange.impliedProbability);
      maxGap = maxGap == null ? gap : Math.max(maxGap, gap);
    }
  }

  return maxGap;
}

function buildInstrumentDivergenceSummary(instrumentId: string) {
  return summarizeDeltaSeries(
    getInstrumentDeltaSeries({
      bucketSeconds: 60,
      instrumentId,
    }),
  );
}

function freshnessMsFromSourceViews(latestSources: LatestSourceView[]) {
  const timestamps = latestSources
    .map((source) => source.capturedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime());

  if (timestamps.length === 0) {
    return null;
  }

  return Math.max(0, Date.now() - Math.max(...timestamps));
}

function freshnessBandFromMs(freshnessMs: number | null) {
  if (freshnessMs == null) {
    return "offline";
  }
  if (freshnessMs <= 60_000) {
    return "fresh";
  }
  if (freshnessMs <= 5 * 60_000) {
    return "aging";
  }
  return "stale";
}

function computeSignalPriority(
  impliedProbabilityGap: number | null,
  latestSources: LatestSourceView[],
  comparableState: ComparableState,
  inPlay: boolean,
) {
  const gapScore = Math.round((impliedProbabilityGap ?? 0) * 1000);
  const coverageBonus = latestSources.filter((source) => source.capturedAt).length * 5;
  const mismatchPenalty =
    comparableState === "line-mismatch" ? -8 : comparableState === "selection-mismatch" ? -80 : 0;
  const inPlayBonus = inPlay ? 12 : 0;

  return Math.max(0, gapScore + coverageBonus + mismatchPenalty + inPlayBonus);
}

function sourceHasProbability(source: LatestSourceView) {
  return typeof source.impliedProbability === "number";
}

function quotedResearchSources(latestSources: LatestSourceView[]) {
  return uniqueResearchSources(
    latestSources.filter(sourceHasProbability).map((source) => source.source),
  );
}

function hasPlayerPropComparisonSource(latestSources: LatestSourceView[]) {
  const sources = new Set(quotedResearchSources(latestSources));
  return sources.has("bet365") && (sources.has("kalshi") || sources.has("polymarket"));
}

function hasBet365PlusExchangeSourceMarkets(instrumentId: string, sourceMarkets: SourceMarket[]) {
  const sources = new Set(
    sourceMarkets
      .filter((sourceMarket) => sourceMarket.instrumentId === instrumentId)
      .map((sourceMarket) => sourceMarket.source),
  );
  return sources.has("bet365") && (sources.has("kalshi") || sources.has("polymarket"));
}

function isVisibleDivergenceInstrument(instrumentView: MarketInstrumentView) {
  return (
    instrumentView.instrument.family !== "player-prop" ||
    hasPlayerPropComparisonSource(instrumentView.sources)
  );
}

function uniqueResearchSources(
  sources: Iterable<ResearchSourceId>,
  options?: { includeNba?: boolean },
) {
  const seen = new Set(sources);
  return researchSourceIds.filter((sourceId) =>
    options?.includeNba === true ? seen.has(sourceId) : sourceId !== "nba" && seen.has(sourceId),
  );
}

function normalizeCoverageFamily(value: string | null | undefined): MarketFamily | null {
  if (value == null) {
    return "other";
  }

  return marketFamilies.includes(value as MarketFamily) ? (value as MarketFamily) : "other";
}

function buildCoverageSources(sourceMarkets: SourceMarket[]) {
  const availableSources = uniqueResearchSources(
    sourceMarkets.map((sourceMarket) => sourceMarket.source),
  );
  const unmappedSources = uniqueResearchSources(
    sourceMarkets
      .filter((sourceMarket) => sourceMarket.mappingStatus === "unmapped")
      .map((sourceMarket) => sourceMarket.source),
  );

  return {
    availableSources,
    missingSources: researchSourceIds.filter(
      (sourceId) => sourceId !== "nba" && !availableSources.includes(sourceId),
    ),
    unmappedSources,
  };
}

function rowToGame(row: Record<string, unknown>): CanonicalGame {
  return {
    awayParticipant: parseJson(String(row.awayParticipantJson), {
      key: "away",
      name: "Away",
      shortName: "Away",
    }),
    homeParticipant: parseJson(String(row.homeParticipantJson), {
      key: "home",
      name: "Home",
      shortName: "Home",
    }),
    id: String(row.id),
    league: String(row.league),
    scheduledStart: String(row.scheduledStart),
    sourceGameKeyNba: row.sourceGameKeyNba == null ? null : String(row.sourceGameKeyNba),
    sport: String(row.sport),
  };
}

function rowToGameState(row: Record<string, unknown> | undefined): CanonicalGameState | null {
  if (!row) {
    return null;
  }

  return {
    awayScore: row.awayScore == null ? null : Number(row.awayScore),
    capturedAt: String(row.capturedAt),
    clock: row.clock == null ? null : String(row.clock),
    finalAt: row.finalAt == null ? null : String(row.finalAt),
    gameId: String(row.gameId),
    homeScore: row.homeScore == null ? null : Number(row.homeScore),
    id: Number(row.id),
    isFinal: toBoolean(row.isFinal as number | boolean | null | undefined),
    period: row.period == null ? null : Number(row.period),
    startedAt: row.startedAt == null ? null : String(row.startedAt),
    status: String(row.status) as ResearchGameStatus,
  };
}

function rowToOutcome(row: Record<string, unknown> | undefined): GameOutcome | null {
  if (!row) {
    return null;
  }

  return {
    capturedAt: String(row.capturedAt),
    finalAwayScore: Number(row.finalAwayScore),
    finalHomeScore: Number(row.finalHomeScore),
    gameId: String(row.gameId),
    winnerKey: row.winnerKey == null ? null : String(row.winnerKey),
  };
}

function rowToInstrument(row: Record<string, unknown>): MarketInstrument {
  return {
    displayLabel: String(row.displayLabel),
    family: String(row.family) as MarketFamily,
    gameId: String(row.gameId),
    id: String(row.id),
    inPlay: toBoolean(row.inPlay as number | boolean | null | undefined),
    line: row.line == null ? null : Number(row.line),
    participantKey: row.participantKey == null ? null : String(row.participantKey),
    selection: String(row.selection),
  };
}

function rowToSourceMarket(row: Record<string, unknown>): SourceMarket {
  return {
    gameId: String(row.gameId),
    id: String(row.id),
    instrumentId: row.instrumentId == null ? null : String(row.instrumentId),
    mappingStatus: String(row.mappingStatus) as MappingStatus,
    rawFamily: row.rawFamily == null ? null : String(row.rawFamily),
    rawLabel: row.rawLabel == null ? null : String(row.rawLabel),
    rawMetadata: parseJson<Record<string, unknown> | null>(
      row.rawMetadataJson == null ? null : String(row.rawMetadataJson),
      null,
    ),
    source: String(row.source) as ResearchSourceId,
    sourceMarketKey: String(row.sourceMarketKey),
    sourceSelectionKey: row.sourceSelectionKey == null ? null : String(row.sourceSelectionKey),
  };
}

function rowToQuoteTick(row: Record<string, unknown> | undefined): QuoteTick | null {
  if (!row) {
    return null;
  }

  return {
    bestAsk: row.bestAsk == null ? null : Number(row.bestAsk),
    bestBid: row.bestBid == null ? null : Number(row.bestBid),
    capturedAt: String(row.capturedAt),
    depthScore: row.depthScore == null ? null : Number(row.depthScore),
    id: Number(row.id),
    impliedProbability: row.impliedProbability == null ? null : Number(row.impliedProbability),
    isHeartbeat: toBoolean(row.isHeartbeat as number | boolean | null | undefined),
    lineRaw: row.lineRaw == null ? null : Number(row.lineRaw),
    oddsRaw: row.oddsRaw == null ? null : String(row.oddsRaw),
    priceRaw: row.priceRaw == null ? null : Number(row.priceRaw),
    sourceMarketId: String(row.sourceMarketId),
    volume: row.volume == null ? null : Number(row.volume),
  };
}

function rowToRawPayload(row: Record<string, unknown> | undefined): RawPayloadAttachment | null {
  if (!row) {
    return null;
  }

  return {
    capturedAt: String(row.capturedAt),
    contentHash: String(row.contentHash),
    entityId: String(row.entityId),
    entityType: String(row.entityType),
    id: Number(row.id),
    payloadJson: parseJson<Record<string, unknown>>(String(row.payloadJson), {}),
    source: String(row.source) as ResearchSourceId,
  };
}

function gameStateLifecycleRank(
  state: Pick<CanonicalGameState, "isFinal" | "status" | "startedAt"> | null | undefined,
) {
  if (!state) return 0;
  if (state.isFinal || state.status === "final") return 4;
  if (state.status === "in-play" || state.startedAt != null) return 3;
  if (state.status === "cancelled" || state.status === "postponed") return 2;
  return 1;
}

function isScheduledRegression(
  latest: Pick<CanonicalGameState, "isFinal" | "status" | "startedAt"> | null | undefined,
  incoming: Pick<
    CanonicalGameState,
    "awayScore" | "clock" | "finalAt" | "homeScore" | "isFinal" | "period" | "startedAt" | "status"
  >,
) {
  if (!latest) return false;

  if (latest.isFinal && !incoming.isFinal) {
    return true;
  }

  if (
    incoming.status === "scheduled" &&
    latest.startedAt != null &&
    incoming.startedAt == null &&
    (incoming.period ?? 0) <= 0 &&
    incoming.clock == null &&
    incoming.homeScore == null &&
    incoming.awayScore == null &&
    incoming.finalAt == null
  ) {
    return true;
  }

  return gameStateLifecycleRank(latest) > gameStateLifecycleRank(incoming);
}

function selectLatestGameState(db: Database.Database, gameId: string) {
  return rowToGameState(
    db
      .prepare(
        `
          SELECT
            id,
            game_id AS gameId,
            captured_at AS capturedAt,
            status,
            period,
            clock,
            home_score AS homeScore,
            away_score AS awayScore,
            is_final AS isFinal,
            started_at AS startedAt,
            final_at AS finalAt
          FROM game_states
          WHERE game_id = ?
          ORDER BY
            CASE
              WHEN is_final = 1 OR status = 'final' THEN 4
              WHEN status = 'in-play' OR started_at IS NOT NULL THEN 3
              WHEN status = 'cancelled' OR status = 'postponed' THEN 2
              ELSE 1
            END DESC,
            CASE
              WHEN datetime(captured_at) > datetime('now', '+10 minutes') THEN 1
              ELSE 0
            END,
            datetime(captured_at) DESC,
            id DESC
          LIMIT 1
        `,
      )
      .get(gameId) as Record<string, unknown> | undefined,
  );
}

function selectOutcome(db: Database.Database, gameId: string) {
  return rowToOutcome(
    db
      .prepare(
        `
          SELECT
            game_id AS gameId,
            final_home_score AS finalHomeScore,
            final_away_score AS finalAwayScore,
            winner_key AS winnerKey,
            captured_at AS capturedAt
          FROM game_outcomes
          WHERE game_id = ?
        `,
      )
      .get(gameId) as Record<string, unknown> | undefined,
  );
}

function selectInstrumentsForGame(db: Database.Database, gameId: string) {
  const rows = db
    .prepare(
      `
        SELECT
          id,
          game_id AS gameId,
          family,
          selection,
          line,
          participant_key AS participantKey,
          in_play AS inPlay,
          display_label AS displayLabel
        FROM market_instruments
        WHERE game_id = ?
        ORDER BY
          CASE family
            WHEN 'moneyline' THEN 0
            WHEN 'spread' THEN 1
            WHEN 'total' THEN 2
            WHEN 'player-prop' THEN 3
            WHEN 'team-prop' THEN 4
            ELSE 5
          END,
          display_label ASC
      `,
    )
    .all(gameId)
    .map((row) => rowToInstrument(row as Record<string, unknown>));

  return rows;
}

function selectSourceMarketsForGame(db: Database.Database, gameId: string) {
  const rows = db
    .prepare(
      `
        SELECT
          id,
          source,
          source_market_key AS sourceMarketKey,
          source_selection_key AS sourceSelectionKey,
          game_id AS gameId,
          instrument_id AS instrumentId,
          raw_family AS rawFamily,
          raw_label AS rawLabel,
          mapping_status AS mappingStatus,
          raw_metadata_json AS rawMetadataJson
        FROM source_markets
        WHERE game_id = ?
        ORDER BY source ASC, raw_label ASC, source_market_key ASC
      `,
    )
    .all(gameId)
    .map((row) => rowToSourceMarket(row as Record<string, unknown>));

  return rows;
}

function chunkValues<T>(values: T[], chunkSize: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function selectLatestTicksBySourceMarketIds(db: Database.Database, sourceMarketIds: string[]) {
  const latest = new Map<string, QuoteTick>();
  if (sourceMarketIds.length === 0) {
    return latest;
  }

  for (const chunk of chunkValues(sourceMarketIds, 500)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `
        SELECT
          q.id,
          q.source_market_id AS sourceMarketId,
          q.captured_at AS capturedAt,
          q.price_raw AS priceRaw,
          q.odds_raw AS oddsRaw,
          q.line_raw AS lineRaw,
          q.implied_probability AS impliedProbability,
          q.best_bid AS bestBid,
          q.best_ask AS bestAsk,
          q.volume,
          q.depth_score AS depthScore,
          q.is_heartbeat AS isHeartbeat
        FROM source_markets sm
        JOIN quote_ticks q ON q.id = (
          SELECT q2.id
          FROM quote_ticks q2
          WHERE q2.source_market_id = sm.id
          ORDER BY q2.captured_at DESC, q2.id DESC
          LIMIT 1
        )
        WHERE sm.id IN (${placeholders})
      `,
      )
      .all(...chunk) as Record<string, unknown>[];

    for (const row of rows) {
      const tick = rowToQuoteTick(row);
      if (tick) {
        latest.set(tick.sourceMarketId, tick);
      }
    }
  }

  return latest;
}

function selectLatestRawPayloadsBySourceMarketIds(
  db: Database.Database,
  sourceMarketIds: string[],
  options: { includePayloadJson?: boolean } = { includePayloadJson: true },
) {
  const latest = new Map<string, RawPayloadAttachment>();
  if (sourceMarketIds.length === 0) {
    return latest;
  }

  for (const chunk of chunkValues(sourceMarketIds, 500)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `
        SELECT
          rp.id,
          rp.source,
          rp.captured_at AS capturedAt,
          rp.entity_type AS entityType,
          rp.entity_id AS entityId,
          ${options.includePayloadJson ? "rp.payload_json" : "'{}'"} AS payloadJson,
          rp.content_hash AS contentHash
        FROM source_markets sm
        JOIN raw_payloads rp ON rp.id = (
          SELECT rp2.id
          FROM raw_payloads rp2
          WHERE rp2.entity_type = 'source_market'
            AND rp2.entity_id = sm.id
          ORDER BY rp2.captured_at DESC, rp2.id DESC
          LIMIT 1
        )
        WHERE sm.id IN (${placeholders})
      `,
      )
      .all(...chunk) as Record<string, unknown>[];

    for (const row of rows) {
      const payload = rowToRawPayload(row);
      if (payload) {
        latest.set(payload.entityId, payload);
      }
    }
  }

  return latest;
}

function buildLatestSourceViews(
  sourceMarkets: SourceMarket[],
  latestTicks: Map<string, QuoteTick>,
  latestPayloads: Map<string, RawPayloadAttachment>,
) {
  const latestBySource = new Map<ResearchSourceId, LatestSourceView>();

  for (const sourceMarket of sourceMarkets) {
    const latestTick = latestTicks.get(sourceMarket.id) ?? null;
    const latestPayload = latestPayloads.get(sourceMarket.id) ?? null;
    const freshnessMs = latestTick
      ? Math.max(0, Date.now() - new Date(latestTick.capturedAt).getTime())
      : null;

    const candidate = {
      capturedAt: latestTick?.capturedAt ?? null,
      freshnessMs,
      impliedProbability: latestTick?.impliedProbability ?? null,
      lastPayloadId: latestPayload?.id ?? null,
      mappingStatus: sourceMarket.mappingStatus,
      raw: {
        bestAsk: latestTick?.bestAsk ?? null,
        bestBid: latestTick?.bestBid ?? null,
        depthScore: latestTick?.depthScore ?? null,
        label: sourceMarket.rawLabel ?? null,
        line: latestTick?.lineRaw ?? null,
        odds: latestTick?.oddsRaw ?? null,
        price: latestTick?.priceRaw ?? null,
        selectionKey: sourceMarket.sourceSelectionKey ?? null,
        volume: latestTick?.volume ?? null,
      },
      source: sourceMarket.source,
      sourceMarketId: sourceMarket.id,
    } satisfies LatestSourceView;

    const current = latestBySource.get(candidate.source);
    if (!current) {
      latestBySource.set(candidate.source, candidate);
      continue;
    }

    const candidateTimestamp = timestampValue(candidate.capturedAt);
    const currentTimestamp = timestampValue(current.capturedAt);
    if (candidateTimestamp > currentTimestamp) {
      latestBySource.set(candidate.source, candidate);
      continue;
    }

    if (
      candidateTimestamp === currentTimestamp &&
      (candidate.lastPayloadId ?? -1) > (current.lastPayloadId ?? -1)
    ) {
      latestBySource.set(candidate.source, candidate);
    }
  }

  return researchSourceIds
    .map((source) => latestBySource.get(source) ?? null)
    .filter((view): view is LatestSourceView => Boolean(view));
}

function buildMarketInstrumentView(
  instrument: MarketInstrument,
  sourceMarkets: SourceMarket[],
  latestTicks: Map<string, QuoteTick>,
  latestPayloads: Map<string, RawPayloadAttachment>,
  options: { game?: CanonicalGame; includeDivergenceSummary?: boolean } = {},
) {
  const latestSources = buildLatestSourceViews(sourceMarkets, latestTicks, latestPayloads);
  const mappingStatus = computeMappingStatus(sourceMarkets);
  const comparableState = computeComparableState(
    instrument,
    mappingStatus,
    latestSources,
    options.game,
  );
  const impliedProbabilityGap =
    comparableState === "comparable"
      ? computeImpliedProbabilityGap(latestSources)
      : comparableState === "line-mismatch"
        ? computeImpliedProbabilityGap(
            latestSources.filter((source) => lineValuesMatch(source.raw.line, instrument.line)),
          )
        : null;
  const comparisonSummary =
    options.includeDivergenceSummary && comparableState === "comparable"
      ? buildInstrumentDivergenceSummary(instrument.id)
      : null;

  return {
    comparableState,
    comparisonSummary,
    impliedProbabilityGap,
    instrument,
    lineMismatch: comparableState === "line-mismatch",
    mappingStatus,
    signalPriority: computeSignalPriority(
      impliedProbabilityGap,
      latestSources,
      comparableState,
      instrument.inPlay,
    ),
    sources: latestSources,
  } satisfies MarketInstrumentView;
}

function buildDivergenceRow(
  game: CanonicalGame,
  gameStatus: ResearchGameStatus,
  instrumentView: MarketInstrumentView,
) {
  const freshnessMs = freshnessMsFromSourceViews(instrumentView.sources);
  const comparisonGap =
    gameStatus === "final"
      ? (instrumentView.comparisonSummary?.maxGap ?? instrumentView.impliedProbabilityGap ?? null)
      : (instrumentView.comparisonSummary?.latestGap ??
        instrumentView.impliedProbabilityGap ??
        null);
  const severity = gapToSeverity(comparisonGap ?? 0, instrumentView.lineMismatch);
  const signalPriority = computeSignalPriority(
    comparisonGap,
    instrumentView.sources,
    instrumentView.comparableState,
    gameStatus === "in-play" && instrumentView.instrument.inPlay,
  );

  return {
    captureRecencyMs: freshnessMs,
    comparableState: instrumentView.comparableState,
    comparisonSummary: instrumentView.comparisonSummary,
    displayLabel: instrumentView.instrument.displayLabel,
    family: instrumentView.instrument.family,
    gameId: game.id,
    gameStatus,
    impliedProbabilityGap: comparisonGap,
    inPlay: instrumentView.instrument.inPlay,
    instrumentId: instrumentView.instrument.id,
    league: game.league,
    lineMismatch: instrumentView.lineMismatch,
    mappingStatus: instrumentView.mappingStatus,
    scheduledStart: game.scheduledStart,
    severity,
    signalPriority,
    sources: quotedResearchSources(instrumentView.sources),
    sport: game.sport,
  } satisfies DivergenceRow;
}

function formatGameLabel(game: CanonicalGame) {
  return `${game.awayParticipant.shortName} at ${game.homeParticipant.shortName}`;
}

function deriveResearchGameStatus(bundle: NonNullable<ReturnType<typeof selectGameBundle>>) {
  if (bundle.outcome) {
    return "final" as const;
  }

  return bundle.gameState?.status ?? ("scheduled" as const);
}

function isFreshInPlayGameStateSql(referenceNowExpression: string) {
  return `
    (gs.status = 'in-play' OR gs.started_at IS NOT NULL)
    AND datetime(gs.captured_at) >= datetime(${referenceNowExpression}, '-30 minutes')
  `;
}

function isExpiredScheduledGhostGame(
  bundle: NonNullable<ReturnType<typeof selectGameBundle>>,
  referenceNow: string,
) {
  if (bundle.outcome) return false;
  if (!bundle.gameState) return false;
  if (bundle.gameState.status !== "scheduled") return false;
  if (bundle.gameState.startedAt != null || bundle.gameState.isFinal) {
    return false;
  }
  if (bundle.sourceMarkets.length > 0) {
    const sources = new Set(bundle.sourceMarkets.map((sourceMarket) => sourceMarket.source));
    const hasOnlyPolymarketCoverage =
      sources.size > 0 && Array.from(sources).every((source) => source === "polymarket");
    if (!hasOnlyPolymarketCoverage) {
      return false;
    }
  }

  const scheduledMs = Date.parse(bundle.game.scheduledStart);
  const referenceMs = Date.parse(referenceNow);
  if (!Number.isFinite(scheduledMs) || !Number.isFinite(referenceMs)) {
    return false;
  }

  return scheduledMs < referenceMs - 8 * 60 * 60_000;
}

function selectGameBundle(db: Database.Database, gameId: string) {
  const gameRow = db
    .prepare(
      `
        SELECT
          id,
          sport,
          league,
          source_game_key_nba AS sourceGameKeyNba,
          home_participant_json AS homeParticipantJson,
          away_participant_json AS awayParticipantJson,
          scheduled_start AS scheduledStart
        FROM games
        WHERE id = ?
      `,
    )
    .get(gameId) as Record<string, unknown> | undefined;

  if (!gameRow) {
    return null;
  }

  const game = rowToGame(gameRow);
  const gameState = selectLatestGameState(db, gameId);
  const outcome = selectOutcome(db, gameId);
  const instruments = selectInstrumentsForGame(db, gameId);
  const sourceMarkets = selectSourceMarketsForGame(db, gameId);
  const latestTicks = selectLatestTicksBySourceMarketIds(
    db,
    sourceMarkets.map((sourceMarket) => sourceMarket.id),
  );
  const latestPayloads = selectLatestRawPayloadsBySourceMarketIds(
    db,
    sourceMarkets.map((sourceMarket) => sourceMarket.id),
  );

  return {
    game,
    gameState,
    instruments,
    latestPayloads,
    latestTicks,
    outcome,
    sourceMarkets,
  };
}

function buildGameCard(
  bundle: NonNullable<ReturnType<typeof selectGameBundle>>,
  comparisonSummaries: Map<string, InstrumentDivergenceSummary> = new Map(),
) {
  const instrumentViews = bundle.instruments.map((instrument) => {
    const instrumentView = buildMarketInstrumentView(
      instrument,
      bundle.sourceMarkets.filter((sourceMarket) => sourceMarket.instrumentId === instrument.id),
      bundle.latestTicks,
      bundle.latestPayloads,
      { game: bundle.game },
    );
    return {
      ...instrumentView,
      comparisonSummary:
        instrumentView.comparableState === "comparable"
          ? (comparisonSummaries.get(instrument.id) ?? null)
          : null,
    } satisfies MarketInstrumentView;
  });

  const topDivergences = instrumentViews
    .filter(isVisibleDivergenceInstrument)
    .flatMap((instrumentView): DivergenceSummary[] => {
      const divergence = buildDivergenceRow(
        bundle.game,
        deriveResearchGameStatus(bundle),
        instrumentView,
      );
      if (divergence.impliedProbabilityGap == null) {
        return [];
      }
      return [
        {
          displayLabel: divergence.displayLabel,
          family: divergence.family,
          impliedProbabilityGap: divergence.impliedProbabilityGap,
          instrumentId: divergence.instrumentId,
          lineMismatch: divergence.lineMismatch,
          severity: divergence.severity,
          comparisonSummary: divergence.comparisonSummary,
        },
      ];
    })
    .sort((left, right) => right.impliedProbabilityGap - left.impliedProbabilityGap)
    .slice(0, 3);

  return {
    activeInstrumentCount: instrumentViews.length,
    coverage: computeCoverageSummary(
      bundle.sourceMarkets,
      bundle.latestTicks,
      Boolean(bundle.gameState || bundle.outcome),
    ),
    game: bundle.game,
    gameState: bundle.gameState,
    hasUnmappedMarkets: bundle.sourceMarkets.some(
      (sourceMarket) => sourceMarket.mappingStatus === "unmapped",
    ),
    outcome: bundle.outcome,
    topDivergences,
  } satisfies ResearchGameCard;
}

type ResearchDivergenceEntry = {
  bundle: NonNullable<ReturnType<typeof selectGameBundle>>;
  instrumentView: MarketInstrumentView;
  row: DivergenceRow;
};

function selectFilteredGameBundles(
  db: Database.Database,
  filters: Pick<GamesFilters, "date" | "gameId" | "league" | "limit" | "referenceNow" | "sport"> & {
    family?: MarketFamily;
    order?: "currentSlate" | "scheduledAsc";
  },
) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const orderParams: unknown[] = [];
  const referenceNow = filters.referenceNow ?? new Date().toISOString();

  if (filters.sport) {
    clauses.push("sport = ?");
    params.push(filters.sport);
  }
  if (filters.league) {
    clauses.push("league = ?");
    params.push(filters.league);
  }
  if (filters.date) {
    clauses.push("substr(scheduled_start, 1, 10) = ?");
    params.push(filters.date);
  } else if (filters.order === "currentSlate") {
    clauses.push(`
      (
        (
          datetime(scheduled_start) >= datetime(?, '-8 hours')
          AND datetime(scheduled_start) <= datetime(?, '+48 hours')
        )
        OR (
          SELECT gs.status
          FROM game_states gs
          WHERE gs.game_id = games.id
          ORDER BY
            CASE
              WHEN gs.is_final = 1 OR gs.status = 'final' THEN 4
              WHEN gs.status = 'in-play' OR gs.started_at IS NOT NULL THEN 3
              WHEN gs.status = 'cancelled' OR gs.status = 'postponed' THEN 2
              ELSE 1
            END DESC,
            CASE
              WHEN datetime(gs.captured_at) > datetime(?, '+10 minutes') THEN 1
              ELSE 0
            END,
            datetime(gs.captured_at) DESC,
            gs.id DESC
          LIMIT 1
        ) = 'in-play'
      )
    `);
    params.push(referenceNow, referenceNow, referenceNow);
  }
  if (filters.family) {
    clauses.push(
      "EXISTS (SELECT 1 FROM market_instruments mi WHERE mi.game_id = games.id AND mi.family = ?)",
    );
    params.push(filters.family);
  }
  if (filters.gameId) {
    clauses.push("id = ?");
    params.push(filters.gameId);
  }

  const orderBy =
    filters.order === "currentSlate"
      ? `
        ORDER BY
          CASE
            WHEN (
              SELECT gs.status
              FROM game_states gs
              WHERE gs.game_id = games.id
                AND ${isFreshInPlayGameStateSql("?")}
              ORDER BY
                CASE
                  WHEN gs.is_final = 1 OR gs.status = 'final' THEN 4
                  WHEN gs.status = 'in-play' OR gs.started_at IS NOT NULL THEN 3
                  WHEN gs.status = 'cancelled' OR gs.status = 'postponed' THEN 2
                  ELSE 1
                END DESC,
                CASE
                  WHEN datetime(gs.captured_at) > datetime(?, '+10 minutes') THEN 1
                  ELSE 0
                END,
                datetime(gs.captured_at) DESC,
                gs.id DESC
              LIMIT 1
            ) = 'in-play'
              THEN 0
            WHEN datetime(scheduled_start) >= datetime(?, '-8 hours')
              AND datetime(scheduled_start) <= datetime(?, '+48 hours')
              THEN 1
            WHEN datetime(scheduled_start) >= datetime(?, '-8 hours')
              THEN 2
            ELSE 3
          END,
          ABS(strftime('%s', scheduled_start) - strftime('%s', ?)) ASC,
          scheduled_start ASC,
          id ASC
      `
      : "ORDER BY scheduled_start ASC, id ASC";
  if (filters.order === "currentSlate") {
    orderParams.push(
      referenceNow,
      referenceNow,
      referenceNow,
      referenceNow,
      referenceNow,
      referenceNow,
    );
  }

  const gameRows = db
    .prepare(
      `
        SELECT
          id,
          sport,
          league,
          source_game_key_nba AS sourceGameKeyNba,
          home_participant_json AS homeParticipantJson,
          away_participant_json AS awayParticipantJson,
          scheduled_start AS scheduledStart
        FROM games
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ${orderBy}
        ${
          filters.limit != null && Number.isFinite(filters.limit)
            ? `LIMIT ${Math.min(500, Math.max(1, Math.floor(filters.limit)))}`
            : ""
        }
      `,
    )
    .all(...params, ...orderParams) as Record<string, unknown>[];

  if (gameRows.length === 0) return [];

  const gameIds = gameRows.map((row) => String(row.id));
  const gamePlaceholders = gameIds.map(() => "?").join(", ");

  const gameStateRows = db
    .prepare(
      `
        WITH ranked AS (
          SELECT
            id,
            game_id AS gameId,
            captured_at AS capturedAt,
            status,
            period,
            clock,
            home_score AS homeScore,
            away_score AS awayScore,
            is_final AS isFinal,
            started_at AS startedAt,
            final_at AS finalAt,
            ROW_NUMBER() OVER (
              PARTITION BY game_id
              ORDER BY
                CASE
                  WHEN is_final = 1 OR status = 'final' THEN 4
                  WHEN status = 'in-play' OR started_at IS NOT NULL THEN 3
                  WHEN status = 'cancelled' OR status = 'postponed' THEN 2
                  ELSE 1
                END DESC,
                CASE
                  WHEN datetime(captured_at) > datetime(?, '+10 minutes') THEN 1
                  ELSE 0
                END,
                datetime(captured_at) DESC,
                id DESC
            ) AS rn
          FROM game_states
          WHERE game_id IN (${gamePlaceholders})
        )
        SELECT * FROM ranked WHERE rn = 1
      `,
    )
    .all(referenceNow, ...gameIds) as Record<string, unknown>[];
  const latestStateByGame = new Map<string, CanonicalGameState>();
  for (const row of gameStateRows) {
    const state = rowToGameState(row);
    if (state) latestStateByGame.set(state.gameId, state);
  }

  const outcomeRows = db
    .prepare(
      `
        SELECT
          game_id AS gameId,
          final_home_score AS finalHomeScore,
          final_away_score AS finalAwayScore,
          winner_key AS winnerKey,
          captured_at AS capturedAt
        FROM game_outcomes
        WHERE game_id IN (${gamePlaceholders})
      `,
    )
    .all(...gameIds) as Record<string, unknown>[];
  const outcomeByGame = new Map<string, GameOutcome>();
  for (const row of outcomeRows) {
    const outcome = rowToOutcome(row);
    if (outcome) outcomeByGame.set(outcome.gameId, outcome);
  }

  const instrumentClauses = [`game_id IN (${gamePlaceholders})`];
  const instrumentParams: unknown[] = [...gameIds];
  if (filters.family) {
    instrumentClauses.push("family = ?");
    instrumentParams.push(filters.family);
  }

  const instrumentRows = db
    .prepare(
      `
        SELECT
          id,
          game_id AS gameId,
          family,
          selection,
          line,
          participant_key AS participantKey,
          in_play AS inPlay,
          display_label AS displayLabel
        FROM market_instruments
        WHERE ${instrumentClauses.join(" AND ")}
        ORDER BY display_label ASC
      `,
    )
    .all(...instrumentParams) as Record<string, unknown>[];
  const instrumentsByGame = new Map<string, MarketInstrument[]>();
  for (const row of instrumentRows) {
    const instrument = rowToInstrument(row);
    const list = instrumentsByGame.get(instrument.gameId) ?? [];
    list.push(instrument);
    instrumentsByGame.set(instrument.gameId, list);
  }

  const sourceMarketFamilyJoin = filters.family
    ? "JOIN market_instruments mi ON mi.id = sm.instrument_id"
    : "";
  const sourceMarketClauses = [`sm.game_id IN (${gamePlaceholders})`];
  const sourceMarketParams: unknown[] = [...gameIds];
  if (filters.family) {
    sourceMarketClauses.push("mi.family = ?");
    sourceMarketParams.push(filters.family);
  }

  const sourceMarketRows = db
    .prepare(
      `
        SELECT
          sm.id,
          sm.source,
          sm.source_market_key AS sourceMarketKey,
          sm.source_selection_key AS sourceSelectionKey,
          sm.game_id AS gameId,
          sm.instrument_id AS instrumentId,
          sm.raw_family AS rawFamily,
          sm.raw_label AS rawLabel,
          sm.mapping_status AS mappingStatus,
          sm.raw_metadata_json AS rawMetadataJson
        FROM source_markets sm
        ${sourceMarketFamilyJoin}
        WHERE ${sourceMarketClauses.join(" AND ")}
      `,
    )
    .all(...sourceMarketParams) as Record<string, unknown>[];
  const sourceMarketsByGame = new Map<string, SourceMarket[]>();
  const allSourceMarketIds: string[] = [];
  for (const row of sourceMarketRows) {
    const sourceMarket = rowToSourceMarket(row);
    allSourceMarketIds.push(sourceMarket.id);
    const list = sourceMarketsByGame.get(sourceMarket.gameId) ?? [];
    list.push(sourceMarket);
    sourceMarketsByGame.set(sourceMarket.gameId, list);
  }

  const latestTicks = selectLatestTicksBySourceMarketIds(db, allSourceMarketIds);
  const latestPayloads = selectLatestRawPayloadsBySourceMarketIds(db, allSourceMarketIds, {
    includePayloadJson: false,
  });

  return gameRows
    .map((gameRow) => {
      const game = rowToGame(gameRow);
      const gameId = game.id;
      return {
        game,
        gameState: latestStateByGame.get(gameId) ?? null,
        instruments: instrumentsByGame.get(gameId) ?? [],
        latestPayloads,
        latestTicks,
        outcome: outcomeByGame.get(gameId) ?? null,
        sourceMarkets: sourceMarketsByGame.get(gameId) ?? [],
      };
    })
    .filter((bundle) => !isExpiredScheduledGhostGame(bundle, referenceNow));
}

function compareDivergenceRows(
  left: DivergenceRow,
  right: DivergenceRow,
  sort: DivergenceFilters["sort"],
) {
  switch (sort) {
    case "captureRecency":
      return (
        (left.captureRecencyMs ?? Number.MAX_SAFE_INTEGER) -
        (right.captureRecencyMs ?? Number.MAX_SAFE_INTEGER)
      );
    case "freshness":
      return freshnessBandFromMs(left.captureRecencyMs ?? null).localeCompare(
        freshnessBandFromMs(right.captureRecencyMs ?? null),
      );
    case "lineMismatch":
      return Number(right.lineMismatch) - Number(left.lineMismatch);
    case "signalPriority":
      return right.signalPriority - left.signalPriority;
    case "divergence":
    default:
      return (right.impliedProbabilityGap ?? 0) - (left.impliedProbabilityGap ?? 0);
  }
}

function buildResearchDivergenceEntries(filters: DivergenceFilters = {}) {
  const db = getDatabase();
  const currentSlateGameLimit = filters.date ? undefined : 48;
  const bundles = selectFilteredGameBundles(db, {
    date: filters.date,
    family: filters.family,
    gameId: filters.gameId,
    league: filters.league,
    limit: currentSlateGameLimit,
    order: filters.date ? "scheduledAsc" : "currentSlate",
    sport: filters.sport,
  });
  const candidateInstrumentIds = bundles.flatMap((bundle) =>
    bundle.instruments
      .filter((instrument) => {
        if (filters.family && instrument.family !== filters.family) {
          return false;
        }
        if (typeof filters.inPlay === "boolean" && instrument.inPlay !== filters.inPlay) {
          return false;
        }
        return hasBet365PlusExchangeSourceMarkets(instrument.id, bundle.sourceMarkets);
      })
      .map((instrument) => instrument.id),
  );
  const candidateInstrumentIdSet = new Set(candidateInstrumentIds);
  const comparisonSummaries = getInstrumentDeltaSummaries({
    bucketSeconds: 60,
    instrumentIds: candidateInstrumentIds,
  });

  let entries = bundles.flatMap((bundle) =>
    bundle.instruments
      .filter((instrument) => {
        if (!candidateInstrumentIdSet.has(instrument.id)) {
          return false;
        }
        if (filters.family && instrument.family !== filters.family) {
          return false;
        }
        if (typeof filters.inPlay === "boolean" && instrument.inPlay !== filters.inPlay) {
          return false;
        }
        return true;
      })
      .flatMap((instrument) => {
        const instrumentView = buildMarketInstrumentView(
          instrument,
          bundle.sourceMarkets.filter(
            (sourceMarket) => sourceMarket.instrumentId === instrument.id,
          ),
          bundle.latestTicks,
          bundle.latestPayloads,
          { game: bundle.game },
        );
        const comparisonSummary =
          instrumentView.comparableState === "comparable"
            ? (comparisonSummaries.get(instrument.id) ?? null)
            : null;
        const enrichedInstrumentView = {
          ...instrumentView,
          comparisonSummary,
        } satisfies MarketInstrumentView;

        if (!isVisibleDivergenceInstrument(enrichedInstrumentView)) {
          return [];
        }

        const row = buildDivergenceRow(
          bundle.game,
          deriveResearchGameStatus(bundle),
          enrichedInstrumentView,
        );
        const keepLineMismatchEvidence = row.lineMismatch && instrument.family !== "player-prop";
        if (row.impliedProbabilityGap == null && !keepLineMismatchEvidence) {
          return [];
        }

        return [
          {
            bundle,
            instrumentView: enrichedInstrumentView,
            row,
          } satisfies ResearchDivergenceEntry,
        ];
      }),
  );

  if (filters.mappedState) {
    entries = entries.filter((entry) => entry.row.comparableState === filters.mappedState);
  }
  if (filters.severity) {
    entries = entries.filter((entry) => entry.row.severity === filters.severity);
  }
  if (filters.freshness) {
    entries = entries.filter(
      (entry) => freshnessBandFromMs(entry.row.captureRecencyMs ?? null) === filters.freshness,
    );
  }
  if (filters.sourceSet) {
    const requestedSources = new Set(
      filters.sourceSet
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );

    entries = entries.filter((entry) =>
      entry.instrumentView.sources.every((source) => requestedSources.has(source.source)),
    );
  }

  const sortedEntries = [...entries].sort((left, right) =>
    compareDivergenceRows(left.row, right.row, filters.sort),
  );
  if (filters.limit == null) {
    return sortedEntries;
  }

  const clampedLimit = Math.min(500, Math.max(1, Math.floor(filters.limit)));
  return sortedEntries.slice(0, clampedLimit);
}

function buildSignalMismatchRow(entry: ResearchDivergenceEntry) {
  const bySource = new Map(entry.instrumentView.sources.map((quote) => [quote.source, quote]));
  const gameStatus = deriveResearchGameStatus(entry.bundle);
  const comparisonSources =
    gameStatus === "final"
      ? entry.instrumentView.comparisonSummary?.maxGapSourceProbabilities
      : entry.instrumentView.comparisonSummary?.latestSourceProbabilities;
  const bet365 = comparisonSources?.bet365 ?? bySource.get("bet365")?.impliedProbability ?? null;
  const kalshi = comparisonSources?.kalshi ?? bySource.get("kalshi")?.impliedProbability ?? null;
  const polymarket =
    comparisonSources?.polymarket ?? bySource.get("polymarket")?.impliedProbability ?? null;
  const externalValues = [kalshi, polymarket].filter(
    (value): value is number => typeof value === "number",
  );
  const externalAverage =
    externalValues.length > 0
      ? externalValues.reduce((sum, value) => sum + value, 0) / externalValues.length
      : null;

  return {
    ...entry.row,
    bet365ImpliedProbability: bet365 ?? null,
    directionalDisagreement:
      typeof bet365 === "number" &&
      typeof externalAverage === "number" &&
      ((bet365 >= 0.5 && externalAverage < 0.5) || (bet365 < 0.5 && externalAverage >= 0.5)),
    finalAwayScore: entry.bundle.outcome?.finalAwayScore ?? null,
    finalHomeScore: entry.bundle.outcome?.finalHomeScore ?? null,
    gameLabel: formatGameLabel(entry.bundle.game),
    gameStatus,
    kalshiImpliedProbability: kalshi ?? null,
    polymarketImpliedProbability: polymarket ?? null,
    scheduledStart: entry.bundle.game.scheduledStart,
  } satisfies SignalMismatchRow;
}

export const defaultMarketAnomalyScoreConfig = {
  contextWindowMinutes: 10,
  families: [...marketFamilies],
  minConfidence: 0.45,
  minScore: 45,
  profileId: "default",
  shockWindowSeconds: 60,
  thresholds: {
    depthScoreDrop: 30,
    maxQuoteAgeMinutes: 10,
    priceJump: 0.18,
    spread: 0.08,
    tradeDistance: 0.25,
    volumeShare: 0.1,
  },
  toggles: {
    includeHistorical: false,
    includeUnmapped: true,
    requireBet365: false,
  },
  updatedAt: null,
  updatedBy: null,
  weights: {
    crossVenue: 0.1,
    liquidity: 0.1,
    offPrice: 0.35,
    volatility: 0.2,
    volumeShare: 0.25,
  },
} satisfies MarketAnomalyScoreConfig;

function clampScorePercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function clampAnomalyLimit(value: number | undefined) {
  if (!value || !Number.isFinite(value)) {
    return 25;
  }

  return Math.min(100, Math.max(1, Math.floor(value)));
}

function normalizeScoreConfig(config: Partial<MarketAnomalyScoreConfig> | null | undefined) {
  const base = defaultMarketAnomalyScoreConfig;
  const families =
    config?.families?.filter((family): family is MarketFamily => marketFamilies.includes(family)) ??
    base.families;
  return {
    contextWindowMinutes: normalizeAlertNumber(
      config?.contextWindowMinutes,
      base.contextWindowMinutes,
      1,
    ),
    families: families.length > 0 ? families : base.families,
    minConfidence: clampScorePercent(config?.minConfidence ?? base.minConfidence),
    minScore: normalizeAlertNumber(config?.minScore, base.minScore, 0),
    profileId: config?.profileId || base.profileId,
    shockWindowSeconds: normalizeAlertNumber(
      config?.shockWindowSeconds,
      base.shockWindowSeconds,
      1,
    ),
    thresholds: {
      depthScoreDrop: normalizeAlertNumber(
        config?.thresholds?.depthScoreDrop,
        base.thresholds.depthScoreDrop,
        0,
      ),
      maxQuoteAgeMinutes: normalizeAlertNumber(
        config?.thresholds?.maxQuoteAgeMinutes,
        base.thresholds.maxQuoteAgeMinutes,
        0,
      ),
      priceJump: normalizeAlertNumber(config?.thresholds?.priceJump, base.thresholds.priceJump, 0),
      spread: normalizeAlertNumber(config?.thresholds?.spread, base.thresholds.spread, 0),
      tradeDistance: normalizeAlertNumber(
        config?.thresholds?.tradeDistance,
        base.thresholds.tradeDistance,
        0,
      ),
      volumeShare: normalizeAlertNumber(
        config?.thresholds?.volumeShare,
        base.thresholds.volumeShare,
        0,
      ),
    },
    toggles: {
      includeHistorical: config?.toggles?.includeHistorical ?? base.toggles.includeHistorical,
      includeUnmapped: config?.toggles?.includeUnmapped ?? base.toggles.includeUnmapped,
      requireBet365: config?.toggles?.requireBet365 ?? base.toggles.requireBet365,
    },
    updatedAt: config?.updatedAt ?? null,
    updatedBy: config?.updatedBy ?? null,
    weights: {
      crossVenue: normalizeAlertNumber(config?.weights?.crossVenue, base.weights.crossVenue, 0),
      liquidity: normalizeAlertNumber(config?.weights?.liquidity, base.weights.liquidity, 0),
      offPrice: normalizeAlertNumber(config?.weights?.offPrice, base.weights.offPrice, 0),
      volatility: normalizeAlertNumber(config?.weights?.volatility, base.weights.volatility, 0),
      volumeShare: normalizeAlertNumber(config?.weights?.volumeShare, base.weights.volumeShare, 0),
    },
  } satisfies MarketAnomalyScoreConfig;
}

export function getMarketAnomalyScoreConfig(profileId = "default") {
  return executeDatabaseOperation(
    "marketAnomalyScoreConfig.get",
    () => {
      const db = getDatabase();
      const row = db
        .prepare(
          `
            SELECT
              profile_id AS profileId,
              config_json AS configJson,
              updated_at AS updatedAt,
              updated_by AS updatedBy
            FROM market_anomaly_score_configs
            WHERE profile_id = ?
          `,
        )
        .get(profileId) as Record<string, unknown> | undefined;

      if (!row) {
        return normalizeScoreConfig({ profileId });
      }

      const config = parseJson<Partial<MarketAnomalyScoreConfig>>(String(row.configJson), {});
      return normalizeScoreConfig({
        ...config,
        profileId: String(row.profileId),
        updatedAt: String(row.updatedAt),
        updatedBy: String(row.updatedBy),
      });
    },
    { profileId },
  );
}

export function upsertMarketAnomalyScoreConfig(
  config: Partial<MarketAnomalyScoreConfig>,
  options: { updatedBy?: string } = {},
) {
  return executeDatabaseOperation(
    "marketAnomalyScoreConfig.upsert",
    () => {
      const db = getDatabase();
      const updatedAt = currentTimestamp();
      const normalized = normalizeScoreConfig({
        ...config,
        updatedAt,
        updatedBy: options.updatedBy ?? "operator",
      });
      db.prepare(
        `
          INSERT INTO market_anomaly_score_configs (
            profile_id,
            config_json,
            updated_at,
            updated_by
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(profile_id) DO UPDATE SET
            config_json = excluded.config_json,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
        `,
      ).run(
        normalized.profileId,
        stringifyJson(normalized),
        updatedAt,
        normalized.updatedBy ?? "operator",
      );

      return normalized;
    },
    {
      profileId: config.profileId ?? "default",
      updatedBy: options.updatedBy ?? "operator",
    },
  );
}

type MarketAnomalyCandidate = {
  apiSurface: string;
  bestAsk: number | null;
  bestBid: number | null;
  capturedAt: string;
  depthScore: number | null;
  displayLabel: string;
  eventTimestamp: string;
  eventType: MarketMicrostructureEventType;
  family: MarketFamily | null;
  finalMarketVolume: number | null;
  gameId: string;
  gameLabel: string;
  instrumentId: string | null;
  league: string;
  mappingStatus: MappingStatus;
  notional: number | null;
  previousPrice: number | null;
  price: number | null;
  rawFamily: string | null;
  rawLabel: string | null;
  size: number | null;
  source: MarketAnomalyAlert["source"];
  sourceMarketId: string;
  sourceMarketKey: string;
  sourceSelectionKey: string | null;
  sport: string;
  spread: number | null;
  tradePrice: number | null;
  volume: number | null;
  volumeShare: number | null;
};

type MarketAnomalyScoreComponents = MarketAnomalyAlert["components"];

function familyFromRaw(value: unknown): MarketFamily | null {
  if (typeof value !== "string") {
    return null;
  }

  return marketFamilies.includes(value as MarketFamily) ? (value as MarketFamily) : null;
}

function buildGameLabelFromRows(row: Record<string, unknown>) {
  const away = parseJson<{ shortName?: string }>(
    row.awayParticipantJson == null ? null : String(row.awayParticipantJson),
    {},
  );
  const home = parseJson<{ shortName?: string }>(
    row.homeParticipantJson == null ? null : String(row.homeParticipantJson),
    {},
  );
  return `${away.shortName ?? "Away"} at ${home.shortName ?? "Home"}`;
}

function marketAnomalyCandidateFromRow(row: Record<string, unknown>): MarketAnomalyCandidate {
  const rawFamily = row.rawFamily == null ? null : String(row.rawFamily);
  const family = familyFromRaw(row.family) ?? familyFromRaw(rawFamily);
  const bestBid = nullableNumber(row.bestBid);
  const bestAsk = nullableNumber(row.bestAsk);
  const spread =
    nullableNumber(row.spread) ??
    (bestBid != null && bestAsk != null ? Math.max(0, bestAsk - bestBid) : null);
  return {
    apiSurface: String(row.apiSurface),
    bestAsk,
    bestBid,
    capturedAt: String(row.capturedAt),
    depthScore: nullableNumber(row.depthScore),
    displayLabel:
      row.displayLabel == null
        ? String(row.rawLabel ?? row.sourceMarketKey)
        : String(row.displayLabel),
    eventTimestamp: String(row.eventTimestamp),
    eventType: String(row.eventType) as MarketMicrostructureEventType,
    family,
    finalMarketVolume: nullableNumber(row.finalMarketVolume),
    gameId: String(row.gameId),
    gameLabel: buildGameLabelFromRows(row),
    instrumentId: row.instrumentId == null ? null : String(row.instrumentId),
    league: String(row.league),
    mappingStatus: String(row.mappingStatus) as MappingStatus,
    notional: nullableNumber(row.notional),
    previousPrice: nullableNumber(row.previousPrice),
    price: nullableNumber(row.price),
    rawFamily,
    rawLabel: row.rawLabel == null ? null : String(row.rawLabel),
    size: nullableNumber(row.size),
    source: String(row.source) as MarketAnomalyAlert["source"],
    sourceMarketId: String(row.sourceMarketId),
    sourceMarketKey: String(row.sourceMarketKey),
    sourceSelectionKey: row.sourceSelectionKey == null ? null : String(row.sourceSelectionKey),
    sport: String(row.sport),
    spread,
    tradePrice: nullableNumber(row.tradePrice),
    volume: nullableNumber(row.volume),
    volumeShare: nullableNumber(row.volumeShare),
  };
}

function selectCrossVenueContext(
  db: Database.Database,
  candidate: MarketAnomalyCandidate,
  config: MarketAnomalyScoreConfig,
) {
  if (!candidate.instrumentId) {
    return {
      gap: null as number | null,
      hasBet365: false,
    };
  }

  const eventSeconds = Math.floor(timestampValue(candidate.eventTimestamp) / 1000);
  if (!Number.isFinite(eventSeconds) || eventSeconds < 0) {
    return {
      gap: null as number | null,
      hasBet365: false,
    };
  }

  const candidatePrice = candidate.tradePrice ?? candidate.price ?? candidate.previousPrice;
  const rows = db
    .prepare(
      `
        SELECT
          sm.source,
          q.implied_probability AS impliedProbability,
          q.price_raw AS priceRaw,
          q.best_bid AS bestBid,
          q.best_ask AS bestAsk
        FROM source_markets sm
        JOIN quote_ticks q ON q.id = (
          SELECT q2.id
          FROM quote_ticks q2
          WHERE q2.source_market_id = sm.id
            AND ABS(strftime('%s', q2.captured_at) - ?) <= ?
            AND COALESCE(q2.implied_probability, CASE WHEN q2.price_raw BETWEEN 0 AND 1 THEN q2.price_raw END) IS NOT NULL
          ORDER BY ABS(strftime('%s', q2.captured_at) - ?) ASC, q2.id DESC
          LIMIT 1
        )
        WHERE sm.instrument_id = ?
          AND sm.source IN ('bet365', 'kalshi', 'polymarket')
          AND sm.source != ?
          AND sm.mapping_status != 'unmapped'
      `,
    )
    .all(
      eventSeconds,
      config.contextWindowMinutes * 60,
      eventSeconds,
      candidate.instrumentId,
      candidate.source,
    ) as Record<string, unknown>[];

  let gap: number | null = null;
  let hasBet365 = candidate.source === "bet365";
  for (const row of rows) {
    const source = String(row.source);
    if (source === "bet365") {
      hasBet365 = true;
    }
    const midpoint =
      nullableNumber(row.bestBid) != null && nullableNumber(row.bestAsk) != null
        ? ((nullableNumber(row.bestBid) ?? 0) + (nullableNumber(row.bestAsk) ?? 0)) / 2
        : null;
    const rowPrice =
      nullableNumber(row.impliedProbability) ?? nullableNumber(row.priceRaw) ?? midpoint;
    if (candidatePrice == null || rowPrice == null) {
      continue;
    }
    const rowGap = Math.abs(candidatePrice - rowPrice);
    gap = gap == null ? rowGap : Math.max(gap, rowGap);
  }

  return { gap, hasBet365 };
}

function scoreMarketAnomalyComponents(
  components: MarketAnomalyScoreComponents,
  config: MarketAnomalyScoreConfig,
) {
  const weightTotal = Math.max(
    0.001,
    Object.values(config.weights).reduce((sum, value) => sum + value, 0),
  );
  return Math.round(
    (components.crossVenue * config.weights.crossVenue +
      components.liquidity * config.weights.liquidity +
      components.offPrice * config.weights.offPrice +
      components.volatility * config.weights.volatility +
      components.volumeShare * config.weights.volumeShare) *
      (100 / weightTotal),
  );
}

function normalizeVolumeShare(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function confidenceForMarketAnomalyCandidate(candidate: MarketAnomalyCandidate, score: number) {
  const surface = candidate.apiSurface.toLowerCase();
  const typeConfidence =
    candidate.eventType === "trade"
      ? 0.9
      : candidate.eventType === "book-snapshot"
        ? 0.85
        : candidate.eventType === "candlestick" || surface.includes("candle")
          ? 0.55
          : surface.includes("price-history")
            ? 0.65
            : 0.7;
  return clampScorePercent(
    typeConfidence -
      (candidate.mappingStatus === "unmapped" ? 0.15 : 0) +
      Math.min(0.1, score / 1000),
  );
}

function scoreMarketAnomalyCandidate(
  db: Database.Database,
  candidate: MarketAnomalyCandidate,
  config: MarketAnomalyScoreConfig,
): MarketAnomalyAlert | null {
  if (candidate.family && !config.families.includes(candidate.family)) {
    return null;
  }
  if (!config.toggles.includeUnmapped && candidate.mappingStatus === "unmapped") {
    return null;
  }

  const referencePrice =
    candidate.previousPrice ??
    (candidate.bestBid != null && candidate.bestAsk != null
      ? (candidate.bestBid + candidate.bestAsk) / 2
      : null);
  const tradeDistance =
    candidate.tradePrice != null && referencePrice != null
      ? Math.abs(candidate.tradePrice - referencePrice)
      : null;
  const priceChange =
    candidate.price != null && candidate.previousPrice != null
      ? Math.abs(candidate.price - candidate.previousPrice)
      : null;
  const volumeShare =
    normalizeVolumeShare(candidate.volumeShare) ??
    normalizeVolumeShare(
      candidate.finalMarketVolume != null &&
        candidate.finalMarketVolume > 0 &&
        candidate.size != null
        ? candidate.size / candidate.finalMarketVolume
        : null,
    );
  const spread =
    candidate.spread ??
    (candidate.bestBid != null && candidate.bestAsk != null
      ? Math.max(0, candidate.bestAsk - candidate.bestBid)
      : null);
  const componentsWithoutCrossVenue = {
    crossVenue: 0,
    liquidity: clampScorePercent(
      Math.max(
        spread == null ? 0 : spread / Math.max(config.thresholds.spread, 0.001),
        candidate.depthScore == null
          ? 0
          : (config.thresholds.depthScoreDrop - candidate.depthScore) /
              Math.max(config.thresholds.depthScoreDrop, 1),
      ),
    ),
    offPrice: clampScorePercent(
      tradeDistance == null ? 0 : tradeDistance / Math.max(config.thresholds.tradeDistance, 0.001),
    ),
    volatility: clampScorePercent(
      priceChange == null ? 0 : priceChange / Math.max(config.thresholds.priceJump, 0.001),
    ),
    volumeShare: clampScorePercent(
      volumeShare == null ? 0 : volumeShare / Math.max(config.thresholds.volumeShare, 0.001),
    ),
  };
  const maxPossibleScore = scoreMarketAnomalyComponents(
    {
      ...componentsWithoutCrossVenue,
      crossVenue: 1,
    },
    config,
  );
  const maxPossibleConfidence = confidenceForMarketAnomalyCandidate(candidate, maxPossibleScore);

  if (maxPossibleScore < config.minScore || maxPossibleConfidence < config.minConfidence) {
    return null;
  }

  const crossVenue = selectCrossVenueContext(db, candidate, config);
  if (config.toggles.requireBet365 && !crossVenue.hasBet365) {
    return null;
  }

  const components = {
    ...componentsWithoutCrossVenue,
    crossVenue: clampScorePercent(
      crossVenue.gap == null ? 0 : crossVenue.gap / Math.max(config.thresholds.priceJump, 0.001),
    ),
  };
  const score = scoreMarketAnomalyComponents(components, config);
  const confidence = confidenceForMarketAnomalyCandidate(candidate, score);

  if (score < config.minScore || confidence < config.minConfidence) {
    return null;
  }

  const labels: MarketAnomalyLabel[] = [];
  if (components.offPrice > 0) labels.push("isolated off-price print");
  if (components.volumeShare > 0) labels.push("volume-share anomaly");
  if (components.volatility > 0) {
    labels.push(candidate.eventType === "trade" ? "volatility shock" : "sustained repricing");
  }
  if (components.liquidity > 0) labels.push("liquidity shock");
  if (components.crossVenue > 0) labels.push("cross-venue disagreement");
  if (candidate.mappingStatus === "unmapped") labels.push("coverage gap");
  if (labels.length === 0) labels.push("volatility shock");

  return {
    action: "manual-review",
    apiSurface: candidate.apiSurface,
    components,
    confidence,
    detectedAt: candidate.capturedAt,
    displayLabel: candidate.displayLabel,
    eventTimestamp: candidate.eventTimestamp,
    eventType: candidate.eventType,
    family: candidate.family,
    gameId: candidate.gameId,
    gameLabel: candidate.gameLabel,
    id: [
      "market-anomaly",
      candidate.sourceMarketId,
      candidate.eventType,
      candidate.apiSurface,
      candidate.eventTimestamp,
      candidate.tradePrice ?? candidate.price ?? "",
      candidate.size ?? "",
    ].join(":"),
    instrumentId: candidate.instrumentId,
    labels: Array.from(new Set(labels)),
    league: candidate.league,
    mappingStatus: candidate.mappingStatus,
    metrics: {
      bestAsk: candidate.bestAsk,
      bestBid: candidate.bestBid,
      crossVenueGap: crossVenue.gap,
      depthScore: candidate.depthScore,
      finalMarketVolume: candidate.finalMarketVolume,
      notional: candidate.notional,
      price: candidate.price,
      priceChange,
      referencePrice,
      size: candidate.size,
      spread,
      tradeDistance,
      tradePrice: candidate.tradePrice,
      volume: candidate.volume,
      volumeShare,
    },
    rawLabel: candidate.rawLabel,
    score,
    severity: scoreToSeverity(score),
    source: candidate.source,
    sourceMarketId: candidate.sourceMarketId,
    sourceMarketKey: candidate.sourceMarketKey,
    sourceSelectionKey: candidate.sourceSelectionKey,
    sport: candidate.sport,
  } satisfies MarketAnomalyAlert;
}

function buildAnomalyWhereClause(filters: MarketAnomalyFilters, config: MarketAnomalyScoreConfig) {
  const clauses = ["sm.source IN ('bet365', 'kalshi', 'polymarket')"];
  const params: unknown[] = [];

  if (filters.date) {
    clauses.push("substr(EVENT_TIME_COLUMN, 1, 10) = ?");
    params.push(filters.date);
  }
  if (filters.source) {
    clauses.push("sm.source = ?");
    params.push(filters.source);
  }
  if (filters.family) {
    clauses.push("COALESCE(mi.family, sm.raw_family) = ?");
    params.push(filters.family);
  }
  if (filters.gameId) {
    clauses.push("g.id = ?");
    params.push(filters.gameId);
  }
  if (!config.toggles.includeUnmapped) {
    clauses.push("sm.mapping_status != 'unmapped'");
  }
  if (!config.toggles.includeHistorical) {
    clauses.push(`
      NOT EXISTS (
        SELECT 1 FROM game_outcomes go WHERE go.game_id = g.id
      )
      AND COALESCE((
        SELECT gs.status
        FROM game_states gs
        WHERE gs.game_id = g.id
        ORDER BY datetime(gs.captured_at) DESC, gs.id DESC
        LIMIT 1
      ), 'scheduled') != 'final'
    `);
  }
  if (!filters.date && !config.toggles.includeHistorical) {
    const nowMs = filters.now == null ? Date.now() : timestampValue(filters.now);
    const maxAgeMinutes = Math.max(1, config.thresholds.maxQuoteAgeMinutes);
    if (Number.isFinite(nowMs)) {
      clauses.push("datetime(EVENT_TIME_COLUMN) >= datetime(?)");
      params.push(new Date(nowMs - maxAgeMinutes * 60_000).toISOString());
    }
  }

  return { clauses, params };
}

function selectMicrostructureAnomalyCandidates(
  db: Database.Database,
  filters: MarketAnomalyFilters,
  config: MarketAnomalyScoreConfig,
) {
  const where = buildAnomalyWhereClause(filters, config);
  const whereSql = where.clauses
    .join(" AND ")
    .replaceAll("EVENT_TIME_COLUMN", "mme.event_timestamp");

  const rows = db
    .prepare(
      `
        SELECT
          mme.id,
          mme.source,
          mme.source_market_id AS sourceMarketId,
          mme.game_id AS gameId,
          mme.instrument_id AS instrumentId,
          mme.event_type AS eventType,
          mme.api_surface AS apiSurface,
          mme.event_timestamp AS eventTimestamp,
          mme.captured_at AS capturedAt,
          mme.price,
          mme.previous_price AS previousPrice,
          mme.trade_price AS tradePrice,
          mme.size,
          mme.notional,
          mme.volume,
          mme.final_market_volume AS finalMarketVolume,
          mme.volume_share AS volumeShare,
          mme.best_bid AS bestBid,
          mme.best_ask AS bestAsk,
          mme.spread,
          mme.depth_score AS depthScore,
          sm.source_market_key AS sourceMarketKey,
          sm.source_selection_key AS sourceSelectionKey,
          sm.raw_family AS rawFamily,
          sm.raw_label AS rawLabel,
          sm.mapping_status AS mappingStatus,
          mi.family,
          mi.display_label AS displayLabel,
          g.sport,
          g.league,
          g.home_participant_json AS homeParticipantJson,
          g.away_participant_json AS awayParticipantJson
        FROM market_microstructure_events mme
        JOIN source_markets sm ON sm.id = mme.source_market_id
        JOIN games g ON g.id = mme.game_id
        LEFT JOIN market_instruments mi ON mi.id = COALESCE(mme.instrument_id, sm.instrument_id)
        WHERE ${whereSql}
        ORDER BY datetime(mme.event_timestamp) DESC, mme.id DESC
        LIMIT 2000
      `,
    )
    .all(...where.params) as Record<string, unknown>[];

  return rows.map(marketAnomalyCandidateFromRow);
}

function selectQuoteAnomalyCandidates(
  db: Database.Database,
  filters: MarketAnomalyFilters,
  config: MarketAnomalyScoreConfig,
) {
  const where = buildAnomalyWhereClause(filters, config);
  const whereSql = where.clauses.join(" AND ").replaceAll("EVENT_TIME_COLUMN", "q.captured_at");
  const useLiveWindow = !filters.date && !config.toggles.includeHistorical;
  const recentQuoteLimit = useLiveWindow ? 1000 : 500;

  const rows = db
    .prepare(
      `
        WITH recent_quotes AS (
          SELECT q.*
          FROM quote_ticks q INDEXED BY idx_quote_ticks_anomaly_captured_latest
          ${
            useLiveWindow
              ? ""
              : `
          JOIN source_markets sm ON sm.id = q.source_market_id
          JOIN games g ON g.id = sm.game_id
          LEFT JOIN market_instruments mi ON mi.id = sm.instrument_id`
          }
          WHERE (q.implied_probability IS NOT NULL OR q.price_raw IS NOT NULL)
            AND COALESCE(q.implied_probability, CASE WHEN q.price_raw BETWEEN 0 AND 1 THEN q.price_raw END) IS NOT NULL
            AND q.is_heartbeat = 0
            ${useLiveWindow ? "" : `AND ${whereSql}`}
          ORDER BY q.captured_at DESC, q.id DESC
          LIMIT ${recentQuoteLimit}
        )
        SELECT
          q.id,
          sm.source,
          sm.id AS sourceMarketId,
          sm.source_market_key AS sourceMarketKey,
          sm.source_selection_key AS sourceSelectionKey,
          sm.game_id AS gameId,
          sm.instrument_id AS instrumentId,
          sm.raw_family AS rawFamily,
          sm.raw_label AS rawLabel,
          sm.mapping_status AS mappingStatus,
          mi.family,
          mi.display_label AS displayLabel,
          'price-tick' AS eventType,
          'quote-tick' AS apiSurface,
          q.captured_at AS eventTimestamp,
          q.captured_at AS capturedAt,
          COALESCE(q.implied_probability, CASE WHEN q.price_raw BETWEEN 0 AND 1 THEN q.price_raw END) AS price,
          (
            SELECT COALESCE(prev.implied_probability, CASE WHEN prev.price_raw BETWEEN 0 AND 1 THEN prev.price_raw END)
            FROM quote_ticks prev
            WHERE prev.source_market_id = q.source_market_id
              AND COALESCE(prev.implied_probability, CASE WHEN prev.price_raw BETWEEN 0 AND 1 THEN prev.price_raw END) IS NOT NULL
              AND prev.is_heartbeat = 0
              AND (
                prev.captured_at < q.captured_at
                OR (
                  prev.captured_at = q.captured_at
                  AND prev.id < q.id
                )
              )
            ORDER BY prev.captured_at DESC, prev.id DESC
            LIMIT 1
          ) AS previousPrice,
          NULL AS tradePrice,
          NULL AS size,
          NULL AS notional,
          q.volume,
          NULL AS finalMarketVolume,
          NULL AS volumeShare,
          q.best_bid AS bestBid,
          q.best_ask AS bestAsk,
          CASE
            WHEN q.best_bid IS NOT NULL AND q.best_ask IS NOT NULL
            THEN MAX(0, q.best_ask - q.best_bid)
            ELSE NULL
          END AS spread,
          q.depth_score AS depthScore,
          g.sport,
          g.league,
          g.home_participant_json AS homeParticipantJson,
          g.away_participant_json AS awayParticipantJson
        FROM recent_quotes q
        JOIN source_markets sm ON sm.id = q.source_market_id
        JOIN games g ON g.id = sm.game_id
        LEFT JOIN market_instruments mi ON mi.id = sm.instrument_id
        WHERE ${whereSql}
        ORDER BY q.captured_at DESC, q.id DESC
        LIMIT 2000
      `,
    )
    .all(...(useLiveWindow ? [] : where.params), ...where.params) as Record<string, unknown>[];

  return rows.map(marketAnomalyCandidateFromRow);
}

export function listMarketAnomalyAlerts(filters: MarketAnomalyFilters = {}) {
  const storedConfig = getMarketAnomalyScoreConfig(filters.profileId);
  return executeDatabaseOperation(
    "research.marketAnomalies.list",
    () => {
      const db = getDatabase();
      const config = normalizeScoreConfig({
        ...storedConfig,
        ...(filters.minConfidence != null ? { minConfidence: filters.minConfidence } : {}),
        ...(filters.minScore != null ? { minScore: filters.minScore } : {}),
        toggles: {
          ...storedConfig.toggles,
          includeHistorical: filters.includeHistorical ?? storedConfig.toggles.includeHistorical,
          includeUnmapped: filters.includeUnmapped ?? storedConfig.toggles.includeUnmapped,
          requireBet365: filters.requireBet365 ?? storedConfig.toggles.requireBet365,
        },
      });
      const limit = clampAnomalyLimit(filters.limit);
      const candidates = filters.skipQuoteAnomalies
        ? selectMicrostructureAnomalyCandidates(db, filters, config)
        : [
            ...selectMicrostructureAnomalyCandidates(db, filters, config),
            ...selectQuoteAnomalyCandidates(db, filters, config),
          ];
      const seen = new Set<string>();
      return candidates
        .map((candidate) => scoreMarketAnomalyCandidate(db, candidate, config))
        .filter((alert): alert is MarketAnomalyAlert => alert != null)
        .filter((alert) => {
          if (seen.has(alert.id)) {
            return false;
          }
          seen.add(alert.id);
          return true;
        })
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          return timestampValue(right.eventTimestamp) - timestampValue(left.eventTimestamp);
        })
        .slice(0, limit);
    },
    filters,
  );
}

export function upsertGame(game: CanonicalGame) {
  executeDatabaseOperation(
    "games.upsert",
    () => {
      const db = getDatabase();
      db.prepare(
        `
          INSERT INTO games (
            id,
            sport,
            league,
            source_game_key_nba,
            home_participant_json,
            away_participant_json,
            scheduled_start
          )
          VALUES (
            @id,
            @sport,
            @league,
            @sourceGameKeyNba,
            @homeParticipantJson,
            @awayParticipantJson,
            @scheduledStart
          )
          ON CONFLICT(id) DO UPDATE SET
            sport = excluded.sport,
            league = excluded.league,
            source_game_key_nba = excluded.source_game_key_nba,
            home_participant_json = excluded.home_participant_json,
            away_participant_json = excluded.away_participant_json,
            scheduled_start = excluded.scheduled_start
        `,
      ).run({
        awayParticipantJson: stringifyJson(game.awayParticipant),
        homeParticipantJson: stringifyJson(game.homeParticipant),
        id: game.id,
        league: game.league,
        scheduledStart: game.scheduledStart,
        sourceGameKeyNba: game.sourceGameKeyNba ?? null,
        sport: game.sport,
      });
    },
    {
      gameId: game.id,
    },
  );
}

export function recordGameStateObservation(input: Omit<CanonicalGameState, "id">) {
  return executeDatabaseOperation(
    "gameStates.observe",
    () => {
      const db = getDatabase();
      const latest = selectLatestGameState(db, input.gameId);
      if (isScheduledRegression(latest, input)) {
        return {
          gameState: latest,
          reason: "regressed" as const,
          wrote: false,
        };
      }
      const unchanged =
        latest &&
        latest.status === input.status &&
        latest.period === (input.period ?? null) &&
        latest.clock === (input.clock ?? null) &&
        latest.homeScore === (input.homeScore ?? null) &&
        latest.awayScore === (input.awayScore ?? null) &&
        latest.isFinal === input.isFinal &&
        latest.startedAt === (input.startedAt ?? null) &&
        latest.finalAt === (input.finalAt ?? null);

      if (unchanged) {
        return {
          gameState: latest,
          reason: "deduped" as const,
          wrote: false,
        };
      }

      const result = db
        .prepare(
          `
            INSERT INTO game_states (
              game_id,
              captured_at,
              status,
              period,
              clock,
              home_score,
              away_score,
              is_final,
              started_at,
              final_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.gameId,
          input.capturedAt,
          input.status,
          input.period ?? null,
          input.clock ?? null,
          input.homeScore ?? null,
          input.awayScore ?? null,
          input.isFinal ? 1 : 0,
          input.startedAt ?? null,
          input.finalAt ?? null,
        );

      return {
        gameState: {
          ...input,
          id: Number(result.lastInsertRowid),
        },
        reason: "changed" as const,
        wrote: true,
      };
    },
    {
      gameId: input.gameId,
      status: input.status,
    },
  );
}

export type NbaPlayByPlayActionInput = {
  actionNumber: number;
  actionType?: string | null;
  subType?: string | null;
  personId?: number | null;
  playerName?: string | null;
  clock?: string | null;
  description?: string | null;
  period?: number | null;
  scoreAway?: string | null;
  scoreHome?: string | null;
  teamTricode?: string | null;
  timeActual?: string | null;
  rawMetadata?: Record<string, unknown> | null;
};

export function recordNbaPlayByPlayActions(input: {
  actions: NbaPlayByPlayActionInput[];
  capturedAt: string;
  gameId: string;
}) {
  return executeDatabaseOperation(
    "nbaPlayByPlayActions.upsert",
    () => {
      const db = getDatabase();
      const statement = db.prepare(
        `
          INSERT INTO nba_play_by_play_actions (
            game_id,
            action_number,
            action_type,
            sub_type,
            person_id,
            player_name,
            period,
            clock,
            description,
            score_away,
            score_home,
            team_tricode,
            time_actual,
            captured_at,
            raw_metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(game_id, action_number) DO UPDATE SET
            action_type = excluded.action_type,
            sub_type = excluded.sub_type,
            person_id = excluded.person_id,
            player_name = excluded.player_name,
            period = excluded.period,
            clock = excluded.clock,
            description = excluded.description,
            score_away = excluded.score_away,
            score_home = excluded.score_home,
            team_tricode = excluded.team_tricode,
            time_actual = excluded.time_actual,
            captured_at = excluded.captured_at,
            raw_metadata_json = excluded.raw_metadata_json
        `,
      );

      const run = db.transaction(() => {
        let written = 0;
        for (const action of input.actions) {
          if (!Number.isFinite(action.actionNumber)) continue;
          const result = statement.run(
            input.gameId,
            action.actionNumber,
            action.actionType ?? null,
            action.subType ?? null,
            action.personId ?? null,
            action.playerName ?? null,
            action.period ?? null,
            action.clock ?? null,
            action.description ?? null,
            action.scoreAway ?? null,
            action.scoreHome ?? null,
            action.teamTricode ?? null,
            action.timeActual ?? null,
            input.capturedAt,
            stringifyJson(action.rawMetadata ?? action),
          );
          written += result.changes;
        }
        return written;
      });

      return {
        actionsSeen: input.actions.length,
        actionsWritten: run(),
      };
    },
    {
      gameId: input.gameId,
    },
  );
}

export function recordNbaPlayByPlayRevisions(input: {
  actions: NbaPlayByPlayActionInput[];
  capturedAt: string;
  gameId: string;
}) {
  return executeDatabaseOperation(
    "nbaPlayByPlayRevisions.append",
    () => {
      const db = getDatabase();
      const statement = db.prepare(
        `
          INSERT OR IGNORE INTO nba_pbp_revisions (
            game_id,
            action_number,
            captured_at,
            action_type,
            sub_type,
            person_id,
            player_name,
            period,
            clock,
            description,
            score_away,
            score_home,
            team_tricode,
            time_actual
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      const latestStatement = db.prepare(
        `
          SELECT action_type,
                 sub_type,
                 person_id,
                 player_name,
                 period,
                 clock,
                 description,
                 score_away,
                 score_home,
                 team_tricode,
                 time_actual
          FROM nba_pbp_revisions
          WHERE game_id = ?
            AND action_number = ?
          ORDER BY captured_at DESC, id DESC
          LIMIT 1
        `,
      );
      const run = db.transaction(() => {
        let written = 0;
        for (const action of input.actions) {
          if (!Number.isFinite(action.actionNumber)) continue;
          const latest = latestStatement.get(input.gameId, action.actionNumber) as
            | {
                action_type: string | null;
                clock: string | null;
                description: string | null;
                period: number | null;
                person_id: number | null;
                player_name: string | null;
                score_away: string | null;
                score_home: string | null;
                sub_type: string | null;
                team_tricode: string | null;
                time_actual: string | null;
              }
            | undefined;
          if (
            latest !== undefined &&
            latest.action_type === (action.actionType ?? null) &&
            latest.person_id === (action.personId ?? null) &&
            latest.player_name === (action.playerName ?? null) &&
            latest.sub_type === (action.subType ?? null) &&
            latest.period === (action.period ?? null) &&
            latest.clock === (action.clock ?? null) &&
            latest.description === (action.description ?? null) &&
            latest.score_away === (action.scoreAway ?? null) &&
            latest.score_home === (action.scoreHome ?? null) &&
            latest.team_tricode === (action.teamTricode ?? null) &&
            latest.time_actual === (action.timeActual ?? null)
          ) {
            continue;
          }
          const result = statement.run(
            input.gameId,
            action.actionNumber,
            input.capturedAt,
            action.actionType ?? null,
            action.subType ?? null,
            action.personId ?? null,
            action.playerName ?? null,
            action.period ?? null,
            action.clock ?? null,
            action.description ?? null,
            action.scoreAway ?? null,
            action.scoreHome ?? null,
            action.teamTricode ?? null,
            action.timeActual ?? null,
          );
          written += result.changes;
        }
        return written;
      });
      return { actionsSeen: input.actions.length, revisionsWritten: run() };
    },
    {
      gameId: input.gameId,
    },
  );
}

export interface PbpAttributionTransition {
  actionNumber: number;
  fromPersonId: number | null;
  toPersonId: number | null;
  fromPlayer: string | null;
  toPlayer: string | null;
  fromSubType: string | null;
  toSubType: string | null;
  firstSeenAt: string;
  changedAt: string;
  // Event context from the latest revision so the harvest bridge can keep only
  // stat-bearing corrections (action_type) and window the re-ranker on the event
  // time (time_actual) without re-joining nba_pbp_revisions.
  actionType: string | null;
  timeActual: string | null;
}

export function listPbpAttributionTransitions(gameId: string): PbpAttributionTransition[] {
  return executeDatabaseOperation(
    "nbaPlayByPlayRevisions.transitions",
    () => {
      const db = getDatabase();
      const rows = db
        .prepare(
          `
          SELECT action_number, captured_at, person_id, player_name, sub_type, action_type, time_actual
          FROM nba_pbp_revisions
          WHERE game_id = ?
          ORDER BY action_number ASC, captured_at ASC
        `,
        )
        .all(gameId) as Array<{
        action_number: number;
        captured_at: string;
        person_id: number | null;
        player_name: string | null;
        sub_type: string | null;
        action_type: string | null;
        time_actual: string | null;
      }>;

      const byAction = new Map<number, typeof rows>();
      for (const row of rows) {
        const list = byAction.get(row.action_number);
        if (list) list.push(row);
        else byAction.set(row.action_number, [row]);
      }

      const transitions: PbpAttributionTransition[] = [];
      for (const [actionNumber, revisions] of byAction) {
        let segmentStart = revisions[0];
        for (let index = 1; index < revisions.length; index += 1) {
          const previous = revisions[index - 1];
          const current = revisions[index];
          if (segmentStart === undefined || previous === undefined || current === undefined)
            continue;
          const idChanged =
            previous.person_id !== current.person_id &&
            (previous.person_id !== null || current.person_id !== null);
          const nameChanged =
            previous.person_id === null &&
            current.person_id === null &&
            (previous.player_name ?? null) !== (current.player_name ?? null);
          const subTypeChanged = (previous.sub_type ?? null) !== (current.sub_type ?? null);
          if (idChanged || nameChanged || subTypeChanged) {
            transitions.push({
              actionNumber,
              changedAt: current.captured_at,
              firstSeenAt: segmentStart.captured_at,
              fromPersonId: segmentStart.person_id,
              fromPlayer: segmentStart.player_name,
              fromSubType: segmentStart.sub_type,
              toPersonId: current.person_id,
              toPlayer: current.player_name,
              toSubType: current.sub_type,
              actionType: current.action_type,
              timeActual: current.time_actual,
            });
            segmentStart = current;
          }
        }
      }
      return transitions;
    },
    {
      gameId,
    },
  );
}

export function listNbaPbpRevisionGameIds(): string[] {
  return executeDatabaseOperation("nbaPlayByPlayRevisions.gameIds", () => {
    const db = getDatabase();
    const rows = db
      .prepare(`SELECT DISTINCT game_id FROM nba_pbp_revisions ORDER BY game_id ASC`)
      .all() as Array<{ game_id: string }>;
    return rows.map((r) => r.game_id);
  });
}

export interface HarvestedMiscreditLabel {
  id: string;
  gameId: string;
  creditedPlayer: string;
  rightfulPlayer: string;
  stat: string;
  utcTime: string;
  actionNumber: number;
  firstSeenAt: string;
  changedAt: string;
  correctionLatencySec: number | null;
}

export interface HarvestMiscreditLabelsResult {
  incidents: HarvestedMiscreditLabel[];
  gamesScanned: number;
  netTransitions: number;
  nonStatTransitions: number;
}

/**
 * The label bridge: turn captured PBP revisions into eval-ready miscredit labels.
 * For each game, recover credited->rightful transitions, collapse consecutive
 * flips on one action to the NET correction (earliest credited -> latest credited),
 * keep the stat-bearing ones (default 'rebound') with BOTH a named credited and
 * rightful, and shape them like the incident registry the re-ranker eval consumes.
 * Lives here (not the script) so it is hermetically testable on an in-memory DB.
 */
export function harvestMiscreditLabels(options?: {
  gameIds?: readonly string[];
  stat?: string;
}): HarvestMiscreditLabelsResult {
  const stat = (options?.stat ?? "rebound").toLowerCase();
  const games = options?.gameIds ?? listNbaPbpRevisionGameIds();
  const incidents: HarvestedMiscreditLabel[] = [];
  let netTransitions = 0;
  let nonStatTransitions = 0;
  for (const gameId of games) {
    const byAction = new Map<number, PbpAttributionTransition[]>();
    for (const t of listPbpAttributionTransitions(gameId)) {
      const list = byAction.get(t.actionNumber);
      if (list) list.push(t);
      else byAction.set(t.actionNumber, [t]);
    }
    for (const list of byAction.values()) {
      const first = list[0];
      const last = list[list.length - 1];
      if (first === undefined || last === undefined) continue;
      // Resolve the net credited + rightful ENTITY. For a rebound, a row with no
      // person_id AND no player_name is a TEAM rebound (gold invariant: rebound rows
      // are either id+name present or both null=TEAM, description 'TEAM ... REBOUND'),
      // represented by the "TEAM" sentinel so a TEAM->player correction is a real
      // credited->rightful change instead of a dropped null. Crucially, a transition
      // that keeps the SAME name while only the person_id flickers (e.g. 100/Merrill ->
      // null/Merrill, a feed dropping the id) is the SAME entity and must NEVER become a
      // creditedPlayer===rightfulPlayer self-label.
      const creditedName =
        first.fromPersonId === null && (first.fromPlayer ?? null) === null
          ? "TEAM"
          : first.fromPlayer;
      const rightfulName = last.toPlayer;
      const sameEntity =
        (first.fromPersonId !== null && first.fromPersonId === last.toPersonId) ||
        (creditedName !== null && creditedName === rightfulName);
      if (sameEntity) continue;
      netTransitions += 1;
      if ((last.actionType ?? "").toLowerCase() !== stat) {
        nonStatTransitions += 1;
        continue;
      }
      // The rightful must be a NAMED player (the re-ranker scores its prop); a
      // player->TEAM correction has no named rightful and is not re-ranker-scoreable.
      // The credited may be "TEAM" (TEAM->player correction; the eval's TEAM branch
      // consumes credited_last="").
      if (!rightfulName || !creditedName) continue;
      const firstMs = Date.parse(first.firstSeenAt);
      const changedMs = Date.parse(last.changedAt);
      incidents.push({
        id: `harvested-${gameId}-${last.actionNumber}`,
        gameId,
        creditedPlayer: creditedName,
        rightfulPlayer: rightfulName,
        stat,
        utcTime: last.timeActual ?? last.changedAt,
        actionNumber: last.actionNumber,
        firstSeenAt: first.firstSeenAt,
        changedAt: last.changedAt,
        correctionLatencySec:
          Number.isFinite(firstMs) && Number.isFinite(changedMs)
            ? Math.round((changedMs - firstMs) / 1000)
            : null,
      });
    }
  }
  return { incidents, gamesScanned: games.length, netTransitions, nonStatTransitions };
}

export function upsertMarketInstrument(instrument: MarketInstrument) {
  executeDatabaseOperation(
    "marketInstruments.upsert",
    () => {
      const db = getDatabase();
      db.prepare(
        `
          INSERT INTO market_instruments (
            id,
            game_id,
            family,
            selection,
            line,
            participant_key,
            in_play,
            display_label
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            game_id = excluded.game_id,
            family = excluded.family,
            selection = excluded.selection,
            line = excluded.line,
            participant_key = excluded.participant_key,
            in_play = excluded.in_play,
            display_label = excluded.display_label
        `,
      ).run(
        instrument.id,
        instrument.gameId,
        instrument.family,
        instrument.selection,
        instrument.line ?? null,
        instrument.participantKey ?? null,
        instrument.inPlay ? 1 : 0,
        instrument.displayLabel,
      );
    },
    {
      gameId: instrument.gameId,
      instrumentId: instrument.id,
    },
  );
}

export function upsertSourceMarket(sourceMarket: SourceMarket) {
  executeDatabaseOperation(
    "sourceMarkets.upsert",
    () => {
      const db = getDatabase();
      db.prepare(
        `
          INSERT INTO source_markets (
            id,
            source,
            source_market_key,
            source_selection_key,
            game_id,
            instrument_id,
            raw_family,
            raw_label,
            mapping_status,
            raw_metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source = excluded.source,
            source_market_key = excluded.source_market_key,
            source_selection_key = excluded.source_selection_key,
            game_id = excluded.game_id,
            instrument_id = excluded.instrument_id,
            raw_family = excluded.raw_family,
            raw_label = excluded.raw_label,
            mapping_status = excluded.mapping_status,
            raw_metadata_json = excluded.raw_metadata_json
        `,
      ).run(
        sourceMarket.id,
        sourceMarket.source,
        sourceMarket.sourceMarketKey,
        sourceMarket.sourceSelectionKey ?? null,
        sourceMarket.gameId,
        sourceMarket.instrumentId ?? null,
        sourceMarket.rawFamily ?? null,
        sourceMarket.rawLabel ?? null,
        sourceMarket.mappingStatus,
        stringifyJson(sourceMarket.rawMetadata),
      );
    },
    {
      source: sourceMarket.source,
      sourceMarketId: sourceMarket.id,
    },
  );
}

export type HistoricalTickInput = Omit<QuoteTick, "id" | "isHeartbeat">;

export type HistoricalTickResult = {
  id: number | null;
  inserted: boolean;
};

export function appendHistoricalTick(tick: HistoricalTickInput): HistoricalTickResult {
  return executeDatabaseOperation(
    "quoteTicks.appendHistorical",
    () => {
      const db = getDatabase();
      const result = db
        .prepare(
          `
            INSERT OR IGNORE INTO quote_ticks (
              source_market_id,
              captured_at,
              price_raw,
              odds_raw,
              line_raw,
              implied_probability,
              best_bid,
              best_ask,
              volume,
              depth_score,
              is_heartbeat
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `,
        )
        .run(
          tick.sourceMarketId,
          tick.capturedAt,
          tick.priceRaw ?? null,
          tick.oddsRaw ?? null,
          tick.lineRaw ?? null,
          tick.impliedProbability ?? null,
          tick.bestBid ?? null,
          tick.bestAsk ?? null,
          tick.volume ?? null,
          tick.depthScore ?? null,
        );

      return {
        id: result.changes > 0 ? Number(result.lastInsertRowid) : null,
        inserted: result.changes > 0,
      } satisfies HistoricalTickResult;
    },
    {
      sourceMarketId: tick.sourceMarketId,
    },
  );
}

export function appendQuoteTick(tick: Omit<QuoteTick, "id">) {
  return executeDatabaseOperation(
    "quoteTicks.append",
    () => {
      const db = getDatabase();
      const result = db
        .prepare(
          `
            INSERT INTO quote_ticks (
              source_market_id,
              captured_at,
              price_raw,
              odds_raw,
              line_raw,
              implied_probability,
              best_bid,
              best_ask,
              volume,
              depth_score,
              is_heartbeat
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_market_id, captured_at) DO NOTHING
          `,
        )
        .run(
          tick.sourceMarketId,
          tick.capturedAt,
          tick.priceRaw ?? null,
          tick.oddsRaw ?? null,
          tick.lineRaw ?? null,
          tick.impliedProbability ?? null,
          tick.bestBid ?? null,
          tick.bestAsk ?? null,
          tick.volume ?? null,
          tick.depthScore ?? null,
          tick.isHeartbeat ? 1 : 0,
        );

      if (result.changes === 0) {
        const existing = rowToQuoteTick(
          db
            .prepare(
              `
                SELECT
                  id,
                  source_market_id AS sourceMarketId,
                  captured_at AS capturedAt,
                  price_raw AS priceRaw,
                  odds_raw AS oddsRaw,
                  line_raw AS lineRaw,
                  implied_probability AS impliedProbability,
                  best_bid AS bestBid,
                  best_ask AS bestAsk,
                  volume,
                  depth_score AS depthScore,
                  is_heartbeat AS isHeartbeat
                FROM quote_ticks
                WHERE source_market_id = ?
                  AND captured_at = ?
                LIMIT 1
              `,
            )
            .get(tick.sourceMarketId, tick.capturedAt) as Record<string, unknown> | undefined,
        );
        if (existing) return existing;
      }

      return {
        ...tick,
        id: Number(result.lastInsertRowid),
      } satisfies QuoteTick;
    },
    {
      sourceMarketId: tick.sourceMarketId,
    },
  );
}

export function recordQuoteObservation(input: QuoteObservationInput) {
  return executeDatabaseOperation(
    "quoteTicks.observe",
    () => {
      const db = getDatabase();
      const existingAtCapturedAt = rowToQuoteTick(
        db
          .prepare(
            `
              SELECT
                id,
                source_market_id AS sourceMarketId,
                captured_at AS capturedAt,
                price_raw AS priceRaw,
                odds_raw AS oddsRaw,
                line_raw AS lineRaw,
                implied_probability AS impliedProbability,
                best_bid AS bestBid,
                best_ask AS bestAsk,
                volume,
                depth_score AS depthScore,
                is_heartbeat AS isHeartbeat
              FROM quote_ticks
              WHERE source_market_id = ?
                AND captured_at = ?
              LIMIT 1
            `,
          )
          .get(input.sourceMarketId, input.capturedAt) as Record<string, unknown> | undefined,
      );

      if (existingAtCapturedAt) {
        return {
          reason: "deduped" as const,
          tick: existingAtCapturedAt,
          wrote: false,
        };
      }

      const latest = rowToQuoteTick(
        db
          .prepare(
            `
              SELECT
                id,
                source_market_id AS sourceMarketId,
                captured_at AS capturedAt,
                price_raw AS priceRaw,
                odds_raw AS oddsRaw,
                line_raw AS lineRaw,
                implied_probability AS impliedProbability,
                best_bid AS bestBid,
                best_ask AS bestAsk,
                volume,
                depth_score AS depthScore,
                is_heartbeat AS isHeartbeat
              FROM quote_ticks
              WHERE source_market_id = ?
              ORDER BY captured_at DESC, id DESC
              LIMIT 1
            `,
          )
          .get(input.sourceMarketId) as Record<string, unknown> | undefined,
      );

      const sameShape =
        latest &&
        latest.priceRaw === (input.priceRaw ?? null) &&
        latest.oddsRaw === (input.oddsRaw ?? null) &&
        latest.lineRaw === (input.lineRaw ?? null) &&
        latest.impliedProbability === (input.impliedProbability ?? null) &&
        latest.bestBid === (input.bestBid ?? null) &&
        latest.bestAsk === (input.bestAsk ?? null) &&
        latest.volume === (input.volume ?? null) &&
        latest.depthScore === (input.depthScore ?? null);

      if (sameShape && latest) {
        const heartbeatAfterMs = input.heartbeatAfterMs ?? 0;
        const elapsedMs =
          new Date(input.capturedAt).getTime() - new Date(latest.capturedAt).getTime();

        if (heartbeatAfterMs > 0 && elapsedMs >= heartbeatAfterMs) {
          const heartbeatTick = appendQuoteTick({
            ...input,
            isHeartbeat: true,
          });

          return {
            reason: "heartbeat" as const,
            tick: heartbeatTick,
            wrote: true,
          };
        }

        return {
          reason: "deduped" as const,
          tick: latest,
          wrote: false,
        };
      }

      const tick = appendQuoteTick({
        ...input,
        isHeartbeat: false,
      });

      return {
        reason: "changed" as const,
        tick,
        wrote: true,
      };
    },
    {
      sourceMarketId: input.sourceMarketId,
    },
  );
}

export function recordRawPayload(input: {
  capturedAt: string;
  contentHash: string;
  entityId: string;
  entityType: string;
  payloadJson: Record<string, unknown>;
  source: ResearchSourceId;
}) {
  return executeDatabaseOperation(
    "rawPayloads.append",
    () => {
      const db = getDatabase();
      const existing = db
        .prepare(
          `
            SELECT id
            FROM raw_payloads
            WHERE source = ?
              AND entity_type = ?
              AND entity_id = ?
              AND content_hash = ?
            ORDER BY datetime(captured_at) DESC, id DESC
            LIMIT 1
          `,
        )
        .get(input.source, input.entityType, input.entityId, input.contentHash) as
        | { id: number }
        | undefined;
      if (existing) {
        return {
          ...input,
          id: Number(existing.id),
        } satisfies RawPayloadAttachment;
      }
      const result = db
        .prepare(
          `
            INSERT INTO raw_payloads (
              source,
              captured_at,
              entity_type,
              entity_id,
              payload_json,
              content_hash
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.source,
          input.capturedAt,
          input.entityType,
          input.entityId,
          JSON.stringify(input.payloadJson),
          input.contentHash,
        );

      return {
        ...input,
        id: Number(result.lastInsertRowid),
      } satisfies RawPayloadAttachment;
    },
    {
      entityId: input.entityId,
      source: input.source,
    },
  );
}

export function recordMarketMicrostructureEvent(input: MarketMicrostructureEventInput) {
  return executeDatabaseOperation(
    "marketMicrostructureEvents.append",
    () => {
      const db = getDatabase();
      const capturedAt = input.capturedAt ?? currentTimestamp();
      const result = db
        .prepare(
          `
            INSERT OR IGNORE INTO market_microstructure_events (
              source,
              source_market_id,
              game_id,
              instrument_id,
              event_type,
              api_surface,
              event_timestamp,
              captured_at,
              price,
              previous_price,
              trade_price,
              size,
              notional,
              volume,
              final_market_volume,
              volume_share,
              best_bid,
              best_ask,
              spread,
              depth_score,
              raw_payload_id,
              raw_metadata_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.source,
          input.sourceMarketId,
          input.gameId,
          input.instrumentId ?? null,
          input.eventType,
          input.apiSurface,
          input.eventTimestamp,
          capturedAt,
          input.price ?? null,
          input.previousPrice ?? null,
          input.tradePrice ?? null,
          input.size ?? null,
          input.notional ?? null,
          input.volume ?? null,
          input.finalMarketVolume ?? null,
          input.volumeShare ?? null,
          input.bestBid ?? null,
          input.bestAsk ?? null,
          input.spread ?? null,
          input.depthScore ?? null,
          input.rawPayloadId ?? null,
          stringifyJson(input.rawMetadata),
        );

      return {
        event:
          result.changes > 0
            ? ({
                ...input,
                capturedAt,
                id: Number(result.lastInsertRowid),
              } satisfies MarketMicrostructureEvent)
            : null,
        inserted: result.changes > 0,
      };
    },
    {
      apiSurface: input.apiSurface,
      eventType: input.eventType,
      source: input.source,
      sourceMarketId: input.sourceMarketId,
    },
  );
}

export type AdapterCaptureMode = "discovery" | "historical" | "live";

export function recordAdapterRun(input: {
  captureMode?: AdapterCaptureMode;
  errorCode?: string | null;
  errorMessage?: string | null;
  finishedAt?: string | null;
  recordsSeen?: number;
  recordsWritten?: number;
  source: string;
  startedAt: string;
  status: "error" | "ok" | "queued" | "running";
}) {
  return executeDatabaseOperation(
    "adapterRuns.append",
    () => {
      const db = getDatabase();
      const result = db
        .prepare(
          `
            INSERT INTO adapter_runs (
              source,
              started_at,
              finished_at,
              status,
              error_code,
              error_message,
              records_seen,
              records_written,
              capture_mode
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.source,
          input.startedAt,
          input.finishedAt ?? null,
          input.status,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          input.recordsSeen ?? 0,
          input.recordsWritten ?? 0,
          input.captureMode ?? "live",
        );

      return Number(result.lastInsertRowid);
    },
    {
      captureMode: input.captureMode ?? "live",
      source: input.source,
      status: input.status,
    },
  );
}

export function upsertGameOutcome(outcome: GameOutcome) {
  executeDatabaseOperation(
    "gameOutcomes.upsert",
    () => {
      const db = getDatabase();
      db.prepare(
        `
          INSERT INTO game_outcomes (
            game_id,
            final_home_score,
            final_away_score,
            winner_key,
            captured_at
          )
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(game_id) DO UPDATE SET
            final_home_score = excluded.final_home_score,
            final_away_score = excluded.final_away_score,
            winner_key = excluded.winner_key,
            captured_at = excluded.captured_at
        `,
      ).run(
        outcome.gameId,
        outcome.finalHomeScore,
        outcome.finalAwayScore,
        outcome.winnerKey ?? null,
        outcome.capturedAt,
      );
    },
    {
      gameId: outcome.gameId,
    },
  );
}

export function resolveSourceMarketMapping(input: {
  instrumentId: string;
  reason: string;
  resolvedBy: string;
  sourceMarketId: string;
}) {
  return executeDatabaseOperation(
    "mappings.resolve",
    () => {
      const db = getDatabase();

      const sourceMarket = db
        .prepare("SELECT id FROM source_markets WHERE id = ?")
        .get(input.sourceMarketId) as { id: string } | undefined;
      if (!sourceMarket) {
        throw new DatabaseFailureError("Source market could not be resolved.", {
          details: {
            sourceMarketId: input.sourceMarketId,
          },
          operatorHint:
            "Confirm the unmapped source market exists before attempting a manual resolution.",
        });
      }

      const instrument = db
        .prepare("SELECT id FROM market_instruments WHERE id = ?")
        .get(input.instrumentId) as { id: string } | undefined;
      if (!instrument) {
        throw new DatabaseFailureError("Target market instrument could not be resolved.", {
          details: {
            instrumentId: input.instrumentId,
          },
          operatorHint:
            "Create or locate the target canonical instrument before linking the source market.",
        });
      }

      db.prepare(
        `
          UPDATE source_markets
          SET instrument_id = ?, mapping_status = 'manual'
          WHERE id = ?
        `,
      ).run(input.instrumentId, input.sourceMarketId);

      const resolvedAt = currentTimestamp();
      const result = db
        .prepare(
          `
            INSERT INTO mapping_resolutions (
              source_market_id,
              instrument_id,
              resolved_by,
              resolved_at,
              reason
            )
            VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run(input.sourceMarketId, input.instrumentId, input.resolvedBy, resolvedAt, input.reason);

      return Number(result.lastInsertRowid);
    },
    {
      instrumentId: input.instrumentId,
      sourceMarketId: input.sourceMarketId,
    },
  );
}

function enqueueAdminAction(actionType: string, payload: AdminActionPayload) {
  return executeDatabaseOperation(
    "adminActions.enqueue",
    () => {
      const db = getDatabase();
      const requestedAt = currentTimestamp();
      const result = db
        .prepare(
          `
            INSERT INTO admin_actions (
              action_type,
              scope,
              requested_at,
              requested_by,
              status,
              payload_json
            )
            VALUES (?, ?, ?, ?, 'queued', ?)
          `,
        )
        .run(
          actionType,
          payload.scope,
          requestedAt,
          payload.requestedBy ?? "operator",
          JSON.stringify(payload.payloadJson),
        );

      return {
        actionType,
        id: Number(result.lastInsertRowid),
        requestedAt,
        status: "queued" as const,
      };
    },
    {
      actionType,
      scope: payload.scope,
    },
  );
}

export function enqueueCaptureRestart(payload: AdminActionPayload) {
  return enqueueAdminAction("capture-restart", payload);
}

export function enqueueGameBackfill(payload: AdminActionPayload) {
  return enqueueAdminAction("games-backfill", payload);
}

export function enqueueMarketBackfill(payload: AdminActionPayload) {
  return enqueueAdminAction("markets-backfill", payload);
}

export function enqueueTimelineMaterializationRebuild(payload: AdminActionPayload) {
  return enqueueAdminAction("timeline-materialization-rebuild", payload);
}

export function enqueueBoardVolatilityBaselineRebuild(payload: AdminActionPayload) {
  return enqueueAdminAction("board-volatility-baseline-rebuild", payload);
}

export function enqueueResearchPull(payload: AdminActionPayload) {
  return enqueueAdminAction("research-pull", payload);
}

export function enqueueResearchExport(payload: AdminActionPayload) {
  return enqueueAdminAction("research-export", payload);
}

export function claimNextQueuedAdminAction() {
  return executeDatabaseOperation("adminActions.claimNext", () => {
    const db = getDatabase();

    return db.transaction(() => {
      const row = db
        .prepare(
          `
            SELECT
              id,
              action_type AS actionType,
              scope,
              requested_at AS requestedAt,
              requested_by AS requestedBy,
              status,
              payload_json AS payloadJson
            FROM admin_actions
            WHERE status = 'queued'
            ORDER BY id ASC
            LIMIT 1
          `,
        )
        .get() as
        | {
            actionType: string;
            id: number;
            payloadJson: string;
            requestedAt: string;
            requestedBy: string;
            scope: string;
            status: AdminActionStatus;
          }
        | undefined;

      if (!row) {
        return null;
      }

      const updated = db
        .prepare(
          `
            UPDATE admin_actions
            SET status = 'running'
            WHERE id = ?
              AND status = 'queued'
          `,
        )
        .run(row.id);

      if (updated.changes === 0) {
        return null;
      }

      return {
        actionType: row.actionType,
        id: row.id,
        payloadJson: parseJson(row.payloadJson, {}),
        requestedAt: row.requestedAt,
        requestedBy: row.requestedBy,
        scope: row.scope,
        status: "running" as const,
      } satisfies AdminActionRecord;
    })();
  });
}

export function markAdminActionCompleted(id: number) {
  return executeDatabaseOperation("adminActions.complete", () => {
    getDatabase()
      .prepare(
        `
          UPDATE admin_actions
          SET status = 'completed'
          WHERE id = ?
        `,
      )
      .run(id);
  });
}

export function markAdminActionErrored(id: number) {
  return executeDatabaseOperation("adminActions.error", () => {
    getDatabase()
      .prepare(
        `
          UPDATE admin_actions
          SET status = 'error'
          WHERE id = ?
        `,
      )
      .run(id);
  });
}

export function listResearchGames(filters: GamesFilters = {}) {
  return executeDatabaseOperation(
    "research.games.list",
    () => {
      const db = getDatabase();
      const hasPostBundleFilter =
        filters.status != null ||
        filters.hasUnmappedMarkets != null ||
        filters.sourceCoverage != null;
      const cards = selectFilteredGameBundles(db, {
        date: filters.date,
        league: filters.league,
        limit: hasPostBundleFilter ? undefined : filters.limit,
        order:
          filters.scope === "all" ? "scheduledAsc" : filters.date ? "scheduledAsc" : "currentSlate",
        referenceNow: filters.referenceNow,
        sport: filters.sport,
      })
        .map((bundle) => buildGameCard(bundle))
        .filter((card) => {
          if (filters.status && card.gameState?.status !== filters.status) {
            return false;
          }
          if (
            typeof filters.hasUnmappedMarkets === "boolean" &&
            card.hasUnmappedMarkets !== filters.hasUnmappedMarkets
          ) {
            return false;
          }
          if (filters.sourceCoverage === "complete") {
            return card.coverage.missingSources.length === 0;
          }
          if (filters.sourceCoverage === "partial") {
            return (
              card.coverage.availableSources.length > 0 && card.coverage.missingSources.length > 0
            );
          }
          if (filters.sourceCoverage === "missing") {
            return card.coverage.availableSources.length === 0;
          }
          return true;
        });

      if (hasPostBundleFilter && filters.limit != null) {
        return cards.slice(0, Math.min(500, Math.max(1, Math.floor(filters.limit))));
      }

      return cards;
    },
    filters,
  );
}

export function getResearchGame(gameId: string) {
  return executeDatabaseOperation(
    "research.games.get",
    () => {
      const db = getDatabase();
      const bundle = selectGameBundle(db, gameId);
      if (!bundle) {
        return null;
      }

      const familyCounts = bundle.instruments.reduce<
        Array<{ family: MarketFamily; count: number }>
      >((counts, instrument) => {
        const existing = counts.find((entry) => entry.family === instrument.family);
        if (existing) {
          existing.count += 1;
        } else {
          counts.push({ family: instrument.family, count: 1 });
        }
        return counts;
      }, []);

      return {
        coverageSummary: computeCoverageSummary(
          bundle.sourceMarkets,
          bundle.latestTicks,
          Boolean(bundle.gameState || bundle.outcome),
        ),
        game: bundle.game,
        gameState: bundle.gameState,
        marketFamilyCounts: familyCounts,
        outcome: bundle.outcome,
      } satisfies ResearchGameDetail;
    },
    {
      gameId,
    },
  );
}

export function listGameMarkets(gameId: string, filters: MarketFilters = {}) {
  return executeDatabaseOperation(
    "research.markets.list",
    () => {
      const db = getDatabase();
      const bundle = selectGameBundle(db, gameId);
      if (!bundle) {
        return [];
      }

      return bundle.instruments
        .filter((instrument) => {
          if (filters.family && instrument.family !== filters.family) {
            return false;
          }
          if (typeof filters.inPlay === "boolean" && instrument.inPlay !== filters.inPlay) {
            return false;
          }
          return true;
        })
        .map((instrument) =>
          buildMarketInstrumentView(
            instrument,
            bundle.sourceMarkets.filter((sourceMarket) => {
              if (sourceMarket.instrumentId !== instrument.id) {
                return false;
              }
              if (filters.source && sourceMarket.source !== filters.source) {
                return false;
              }
              return true;
            }),
            bundle.latestTicks,
            bundle.latestPayloads,
            { game: bundle.game },
          ),
        )
        .filter((instrumentView) =>
          filters.mappedOnly ? instrumentView.mappingStatus !== "unmapped" : true,
        );
    },
    {
      ...filters,
      gameId,
    },
  );
}

export function getInstrumentComparison(gameId: string, instrumentId: string) {
  return executeDatabaseOperation(
    "research.instrument.get",
    () => {
      const db = getDatabase();
      const bundle = selectGameBundle(db, gameId);
      if (!bundle) {
        return null;
      }

      const instrument = bundle.instruments.find((entry) => entry.id === instrumentId);
      if (!instrument) {
        return null;
      }

      const sourceMarkets = bundle.sourceMarkets.filter(
        (sourceMarket) => sourceMarket.instrumentId === instrumentId,
      );
      const latestQuotesBySource = buildLatestSourceViews(
        sourceMarkets,
        bundle.latestTicks,
        bundle.latestPayloads,
      );
      const mappingStatus = computeMappingStatus(sourceMarkets);
      const comparableState = computeComparableState(
        instrument,
        mappingStatus,
        latestQuotesBySource,
        bundle.game,
      );
      const impliedProbabilityGap =
        comparableState === "comparable"
          ? computeImpliedProbabilityGap(latestQuotesBySource)
          : comparableState === "line-mismatch"
            ? computeImpliedProbabilityGap(
                latestQuotesBySource.filter((source) =>
                  lineValuesMatch(source.raw.line, instrument.line),
                ),
              )
            : null;
      const comparisonSummary =
        comparableState === "comparable" ? buildInstrumentDivergenceSummary(instrument.id) : null;
      const comparisonGap =
        comparableState === "comparable"
          ? (comparisonSummary?.latestGap ?? impliedProbabilityGap ?? null)
          : impliedProbabilityGap;

      return {
        derivedComparison: {
          comparableState,
          comparisonSummary,
          impliedProbabilityGap: comparisonGap,
          lineMismatch: comparableState === "line-mismatch",
          sourceCount: latestQuotesBySource.length,
        },
        gameState: bundle.gameState,
        instrument,
        latestQuotesBySource,
        latestRawReferences: latestQuotesBySource
          .filter((source) => source.lastPayloadId && source.capturedAt)
          .map((source) => ({
            capturedAt: source.capturedAt!,
            payloadId: source.lastPayloadId!,
            source: source.source,
          })),
      } satisfies InstrumentComparisonView;
    },
    {
      gameId,
      instrumentId,
    },
  );
}

export function getInstrumentTimeline(
  gameId: string,
  instrumentId: string,
  filters: {
    from?: string;
    source?: ResearchSourceId[];
    to?: string;
  } = {},
) {
  return executeDatabaseOperation(
    "research.instrument.timeline",
    () => {
      const db = getDatabase();
      const bundle = selectGameBundle(db, gameId);
      if (!bundle) {
        return null;
      }

      const instrument = bundle.instruments.find((entry) => entry.id === instrumentId);
      if (!instrument) {
        return null;
      }

      const sourceMarkets = bundle.sourceMarkets.filter((sourceMarket) => {
        if (sourceMarket.instrumentId !== instrumentId) {
          return false;
        }
        if (filters.source && !filters.source.includes(sourceMarket.source)) {
          return false;
        }
        return true;
      });

      const quoteSeriesBySource: Record<ResearchSourceId, InstrumentTimelinePoint[]> = {
        bet365: [],
        fanduel: [],
        draftkings: [],
        kalshi: [],
        nba: [],
        polymarket: [],
      };

      for (const sourceMarket of sourceMarkets) {
        const clauses = ["source_market_id = ?"];
        const params: unknown[] = [sourceMarket.id];
        if (filters.from) {
          clauses.push("captured_at >= ?");
          params.push(filters.from);
        }
        if (filters.to) {
          clauses.push("captured_at <= ?");
          params.push(filters.to);
        }

        const rows = db
          .prepare(
            `
              SELECT
                id,
                source_market_id AS sourceMarketId,
                captured_at AS capturedAt,
                price_raw AS priceRaw,
                odds_raw AS oddsRaw,
                line_raw AS lineRaw,
                implied_probability AS impliedProbability,
                best_bid AS bestBid,
                best_ask AS bestAsk,
                volume,
                depth_score AS depthScore,
                is_heartbeat AS isHeartbeat
              FROM quote_ticks
              WHERE ${clauses.join(" AND ")}
              ORDER BY captured_at ASC, id ASC
            `,
          )
          .all(...params) as Record<string, unknown>[];

        quoteSeriesBySource[sourceMarket.source].push(
          ...rows
            .map((row) => rowToQuoteTick(row))
            .filter((tick): tick is QuoteTick => Boolean(tick))
            .map((tick) => ({
              bestAsk: tick.bestAsk ?? null,
              bestBid: tick.bestBid ?? null,
              capturedAt: tick.capturedAt,
              depthScore: tick.depthScore ?? null,
              impliedProbability: tick.impliedProbability ?? null,
              isHeartbeat: tick.isHeartbeat,
              line: tick.lineRaw ?? null,
              source: sourceMarket.source,
              volume: tick.volume ?? null,
            })),
        );
      }

      const gameStateClauses = ["game_id = ?"];
      const gameStateParams: unknown[] = [gameId];
      if (filters.from) {
        gameStateClauses.push("captured_at >= ?");
        gameStateParams.push(filters.from);
      }
      if (filters.to) {
        gameStateClauses.push("captured_at <= ?");
        gameStateParams.push(filters.to);
      }

      const gameStateSeries = db
        .prepare(
          `
            SELECT
              id,
              game_id AS gameId,
              captured_at AS capturedAt,
              status,
              period,
              clock,
              home_score AS homeScore,
              away_score AS awayScore,
              is_final AS isFinal,
              started_at AS startedAt,
              final_at AS finalAt
            FROM game_states
            WHERE ${gameStateClauses.join(" AND ")}
            ORDER BY captured_at ASC, id ASC
          `,
        )
        .all(...gameStateParams)
        .map((row) => rowToGameState(row as Record<string, unknown>))
        .filter((state): state is CanonicalGameState => Boolean(state));

      const lineMismatchWindows: Array<{
        end?: string | null;
        sources: ResearchSourceId[];
        start: string;
      }> = [];

      for (const source of ["bet365", "kalshi", "polymarket"] as const) {
        const points = quoteSeriesBySource[source];
        let activeWindow: {
          end?: string | null;
          sources: ResearchSourceId[];
          start: string;
        } | null = null;

        for (const point of points) {
          const mismatched =
            instrument.family !== "moneyline" && !lineValuesMatch(point.line, instrument.line);

          if (mismatched && !activeWindow) {
            activeWindow = {
              sources: [source],
              start: point.capturedAt,
            };
            continue;
          }

          if (!mismatched && activeWindow) {
            activeWindow.end = point.capturedAt;
            lineMismatchWindows.push(activeWindow);
            activeWindow = null;
          }
        }

        if (activeWindow) {
          lineMismatchWindows.push(activeWindow);
        }
      }

      return {
        annotations: [
          ...lineMismatchWindows.map((window) => ({
            capturedAt: window.start,
            detail: "One or more source lines diverged from the canonical instrument line.",
            label: "Line mismatch",
            source: "system" as const,
          })),
          ...gameStateSeries.map((state) => ({
            capturedAt: state.capturedAt,
            detail:
              `${state.status} ${state.period ? `P${state.period}` : ""} ${state.clock ?? ""}`.trim(),
            label: "Game state",
            source: "system" as const,
          })),
        ].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
        gameStateSeries,
        lineMismatchWindows,
        quoteSeriesBySource,
      } satisfies InstrumentTimeline;
    },
    {
      ...filters,
      gameId,
      instrumentId,
    },
  );
}

export function getInstrumentSources(gameId: string, instrumentId: string) {
  return executeDatabaseOperation(
    "research.instrument.sources",
    () => {
      const db = getDatabase();
      const bundle = selectGameBundle(db, gameId);
      if (!bundle) {
        return [];
      }

      const instrument = bundle.instruments.find((entry) => entry.id === instrumentId);
      if (!instrument) {
        return [];
      }

      return bundle.sourceMarkets
        .filter((sourceMarket) => sourceMarket.instrumentId === instrumentId)
        .map((sourceMarket) => {
          const latestQuote = bundle.latestTicks.get(sourceMarket.id) ?? null;
          const latestRawPayload = bundle.latestPayloads.get(sourceMarket.id) ?? null;
          const freshnessMs = latestQuote
            ? Math.max(0, Date.now() - new Date(latestQuote.capturedAt).getTime())
            : null;

          return {
            diagnostics: {
              captureLagMs: freshnessMs,
              lineMismatch:
                instrument.family !== "moneyline" &&
                !lineValuesMatch(latestQuote?.lineRaw ?? null, instrument.line),
              mappingStatus: sourceMarket.mappingStatus,
            },
            freshnessMs,
            latestQuote,
            latestRawPayload,
            source: sourceMarket.source,
            sourceMarket,
          } satisfies InstrumentSourceDiagnostics;
        });
    },
    {
      gameId,
      instrumentId,
    },
  );
}

export function getInstrumentRawSource(
  gameId: string,
  instrumentId: string,
  source: ResearchSourceId,
) {
  return executeDatabaseOperation(
    "research.instrument.rawSource",
    () => {
      const db = getDatabase();
      const bundle = selectGameBundle(db, gameId);
      if (!bundle) {
        return null;
      }

      const instrument = bundle.instruments.find((entry) => entry.id === instrumentId);
      if (!instrument) {
        return null;
      }

      const sourceMarket = bundle.sourceMarkets
        .filter((entry) => entry.instrumentId === instrumentId && entry.source === source)
        .sort((left, right) => {
          const leftLatestTick = bundle.latestTicks.get(left.id) ?? null;
          const rightLatestTick = bundle.latestTicks.get(right.id) ?? null;
          const leftTimestamp = Math.max(
            timestampValue(leftLatestTick?.capturedAt ?? null),
            timestampValue(bundle.latestPayloads.get(left.id)?.capturedAt ?? null),
          );
          const rightTimestamp = Math.max(
            timestampValue(rightLatestTick?.capturedAt ?? null),
            timestampValue(bundle.latestPayloads.get(right.id)?.capturedAt ?? null),
          );

          if (rightTimestamp !== leftTimestamp) {
            return rightTimestamp - leftTimestamp;
          }

          return right.id.localeCompare(left.id);
        })[0];

      if (!sourceMarket) {
        return null;
      }

      const latestQuote = bundle.latestTicks.get(sourceMarket.id) ?? null;
      const recentRawPayloads = db
        .prepare(
          `
            SELECT
              id,
              source,
              captured_at AS capturedAt,
              entity_type AS entityType,
              entity_id AS entityId,
              payload_json AS payloadJson,
              content_hash AS contentHash
            FROM raw_payloads
            WHERE source = ?
              AND entity_type = 'source_market'
              AND entity_id = ?
            ORDER BY captured_at DESC, id DESC
            LIMIT 10
          `,
        )
        .all(source, sourceMarket.id)
        .map((row) => rowToRawPayload(row as Record<string, unknown>))
        .filter((payload): payload is RawPayloadAttachment => Boolean(payload));

      return {
        captureDiagnostics: {
          freshnessBand: freshnessBandFromMs(
            latestQuote
              ? Math.max(0, Date.now() - new Date(latestQuote.capturedAt).getTime())
              : null,
          ),
          lastQuoteCapturedAt: latestQuote?.capturedAt ?? null,
          mappingStatus: sourceMarket.mappingStatus,
        },
        latestQuote,
        parserOutput: {
          impliedProbability: latestQuote?.impliedProbability ?? null,
          line: latestQuote?.lineRaw ?? null,
          odds: latestQuote?.oddsRaw ?? null,
          price: latestQuote?.priceRaw ?? null,
        },
        rawPayloads: recentRawPayloads,
        sourceMarket,
      };
    },
    {
      gameId,
      instrumentId,
      source,
    },
  );
}

export function listResearchDivergence(filters: DivergenceFilters = {}) {
  return executeDatabaseOperation(
    "research.divergence.list",
    () => buildResearchDivergenceEntries(filters).map((entry) => entry.row),
    filters,
  );
}

export function listSignalMismatches(filters: DivergenceFilters = {}) {
  return executeDatabaseOperation(
    "research.signalMismatches.list",
    () => {
      const { limit, ...entryFilters } = filters;
      const rows = buildResearchDivergenceEntries({
        ...entryFilters,
        sort: entryFilters.sort ?? "divergence",
      })
        .map((entry) => buildSignalMismatchRow(entry))
        .filter((row) => row.directionalDisagreement || (row.impliedProbabilityGap ?? 0) >= 0.08);

      if (limit == null) {
        return rows as SignalMismatchRow[];
      }

      const clampedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
      return rows.slice(0, clampedLimit) as SignalMismatchRow[];
    },
    filters,
  );
}

export function getResearchCoverage() {
  return executeDatabaseOperation("research.coverage.get", () => {
    const db = getDatabase();
    const gameRows = db
      .prepare(
        `
          SELECT
            id,
            sport,
            league
          FROM games
          ORDER BY
            CASE
              WHEN datetime(scheduled_start) >= datetime('now', '-8 hours')
                AND datetime(scheduled_start) <= datetime('now', '+48 hours')
                THEN 0
              WHEN datetime(scheduled_start) >= datetime('now', '-8 hours')
                THEN 1
              ELSE 2
            END,
            ABS(strftime('%s', scheduled_start) - strftime('%s', 'now')) ASC,
            scheduled_start ASC,
            id ASC
          LIMIT 25
        `,
      )
      .all() as Array<{ id: string; league: string; sport: string }>;
    if (gameRows.length === 0) {
      return [];
    }

    const gameIds = gameRows.map((row) => row.id);
    const gamePlaceholders = gameIds.map(() => "?").join(", ");
    const instrumentsByGame = new Map<string, Array<{ family: MarketFamily; id: string }>>();
    const sourceMarketsByGame = new Map<string, SourceMarket[]>();
    const stateGameIds = new Set<string>(
      (
        db
          .prepare(
            `
              SELECT DISTINCT game_id AS gameId
              FROM game_states
              WHERE game_id IN (${gamePlaceholders})
            `,
          )
          .all(...gameIds) as Array<{ gameId: string }>
      ).map((row) => row.gameId),
    );
    const outcomeGameIds = new Set<string>(
      (
        db
          .prepare(
            `
              SELECT game_id AS gameId
              FROM game_outcomes
              WHERE game_id IN (${gamePlaceholders})
            `,
          )
          .all(...gameIds) as Array<{ gameId: string }>
      ).map((row) => row.gameId),
    );

    for (const row of db
      .prepare(
        `
          SELECT
            id,
            game_id AS gameId,
            family
          FROM market_instruments
          WHERE game_id IN (${gamePlaceholders})
          ORDER BY display_label ASC
        `,
      )
      .all(...gameIds) as Array<{
      family: MarketFamily;
      gameId: string;
      id: string;
    }>) {
      const existing = instrumentsByGame.get(row.gameId) ?? [];
      existing.push({ family: row.family, id: row.id });
      instrumentsByGame.set(row.gameId, existing);
    }

    for (const row of db
      .prepare(
        `
          SELECT
            id,
            source,
            game_id AS gameId,
            instrument_id AS instrumentId,
            raw_family AS rawFamily,
            mapping_status AS mappingStatus
          FROM source_markets
          WHERE game_id IN (${gamePlaceholders})
          ORDER BY source ASC, raw_label ASC, source_market_key ASC
        `,
      )
      .all(...gameIds) as Array<{
      gameId: string;
      id: string;
      instrumentId: string | null;
      mappingStatus: MappingStatus;
      rawFamily: string | null;
      source: ResearchSourceId;
    }>) {
      const sourceMarket = {
        gameId: row.gameId,
        id: row.id,
        instrumentId: row.instrumentId,
        mappingStatus: row.mappingStatus,
        rawFamily: row.rawFamily,
        rawLabel: null,
        rawMetadata: null,
        source: row.source,
        sourceMarketKey: row.id,
        sourceSelectionKey: null,
      } satisfies SourceMarket;
      const existing = sourceMarketsByGame.get(row.gameId) ?? [];
      existing.push(sourceMarket);
      sourceMarketsByGame.set(row.gameId, existing);
    }

    const rows: CoverageRow[] = [];
    const maxRows = 500;
    const pushCoverageRow = (row: CoverageRow) => {
      if (rows.length < maxRows) {
        rows.push(row);
      }
    };

    for (const game of gameRows) {
      if (rows.length >= maxRows) {
        break;
      }
      const sourceMarkets = sourceMarketsByGame.get(game.id) ?? [];
      const sourceMarketsByInstrument = new Map<string, SourceMarket[]>();
      for (const sourceMarket of sourceMarkets) {
        if (sourceMarket.instrumentId == null) {
          continue;
        }
        const existing = sourceMarketsByInstrument.get(sourceMarket.instrumentId) ?? [];
        existing.push(sourceMarket);
        sourceMarketsByInstrument.set(sourceMarket.instrumentId, existing);
      }

      const hasNbaState = stateGameIds.has(game.id) || outcomeGameIds.has(game.id);
      const gameCoverageSources = buildCoverageSources(sourceMarkets);
      const gameAvailableSources = hasNbaState
        ? uniqueResearchSources([...gameCoverageSources.availableSources, "nba"], {
            includeNba: true,
          })
        : gameCoverageSources.availableSources;

      pushCoverageRow({
        availableSources: gameAvailableSources,
        gameId: game.id,
        league: game.league,
        missingSources: researchSourceIds.filter(
          (sourceId) => !gameAvailableSources.includes(sourceId),
        ),
        sport: game.sport,
        unmappedSources: uniqueResearchSources(
          sourceMarkets
            .filter((sourceMarket) => sourceMarket.mappingStatus === "unmapped")
            .map((sourceMarket) => sourceMarket.source),
        ),
      });

      for (const instrument of instrumentsByGame.get(game.id) ?? []) {
        if (rows.length >= maxRows) {
          break;
        }
        const coverageSources = buildCoverageSources(
          sourceMarketsByInstrument.get(instrument.id) ?? [],
        );
        pushCoverageRow({
          availableSources: coverageSources.availableSources,
          family: instrument.family,
          gameId: game.id,
          instrumentId: instrument.id,
          league: game.league,
          missingSources: coverageSources.missingSources,
          sport: game.sport,
          unmappedSources: coverageSources.unmappedSources,
        });
      }

      const orphanUnmappedMarkets = sourceMarkets.filter(
        (sourceMarket) =>
          sourceMarket.instrumentId == null && sourceMarket.mappingStatus === "unmapped",
      );
      const orphanGroups = new Map<MarketFamily | null, SourceMarket[]>();

      for (const sourceMarket of orphanUnmappedMarkets) {
        const family = normalizeCoverageFamily(sourceMarket.rawFamily);
        const existing = orphanGroups.get(family) ?? [];
        existing.push(sourceMarket);
        orphanGroups.set(family, existing);
      }

      for (const [family, sourceMarkets] of orphanGroups) {
        if (rows.length >= maxRows) {
          break;
        }
        const coverageSources = buildCoverageSources(sourceMarkets);
        pushCoverageRow({
          availableSources: coverageSources.availableSources,
          family,
          gameId: game.id,
          instrumentId: null,
          league: game.league,
          missingSources: coverageSources.missingSources,
          sport: game.sport,
          unmappedSources: coverageSources.unmappedSources,
        });
      }
    }

    return rows;
  });
}

function latestSuccessfulRun(source: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          source,
          started_at AS startedAt,
          finished_at AS finishedAt,
          status,
          error_code AS errorCode,
          error_message AS errorMessage,
          records_seen AS recordsSeen,
          records_written AS recordsWritten,
          capture_mode AS captureMode
        FROM adapter_runs
        WHERE source = ? AND status = 'ok'
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(source) as Record<string, unknown> | undefined;

  return row
    ? {
        errorCode: row.errorCode == null ? null : String(row.errorCode),
        errorMessage: row.errorMessage == null ? null : String(row.errorMessage),
        captureMode: row.captureMode == null ? "live" : String(row.captureMode),
        finishedAt: row.finishedAt == null ? null : String(row.finishedAt),
        id: Number(row.id),
        recordsSeen: Number(row.recordsSeen),
        recordsWritten: Number(row.recordsWritten),
        source: String(row.source),
        startedAt: String(row.startedAt),
        status: String(row.status),
      }
    : null;
}

function latestRun(source: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          source,
          started_at AS startedAt,
          finished_at AS finishedAt,
          status,
          error_code AS errorCode,
          error_message AS errorMessage,
          records_seen AS recordsSeen,
          records_written AS recordsWritten,
          capture_mode AS captureMode
        FROM adapter_runs
        WHERE source = ?
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(source) as Record<string, unknown> | undefined;

  return row
    ? {
        errorCode: row.errorCode == null ? null : String(row.errorCode),
        errorMessage: row.errorMessage == null ? null : String(row.errorMessage),
        captureMode: row.captureMode == null ? "live" : String(row.captureMode),
        finishedAt: row.finishedAt == null ? null : String(row.finishedAt),
        id: Number(row.id),
        recordsSeen: Number(row.recordsSeen),
        recordsWritten: Number(row.recordsWritten),
        source: String(row.source),
        startedAt: String(row.startedAt),
        status: String(row.status),
      }
    : null;
}

export function listAdminSources() {
  return executeDatabaseOperation("admin.sources.list", () => {
    const oddsApiKey = resolveOddsApiKey();
    const bet365SessionStatePath = process.env.BET365_SESSION_STATE_PATH;
    const bet365SessionReady =
      typeof bet365SessionStatePath === "string" &&
      bet365SessionStatePath.length > 0 &&
      existsSync(bet365SessionStatePath);
    const kalshiKey = process.env.KALSHI_API_KEY;
    const kalshiSecret = process.env.KALSHI_API_SECRET;
    const nbaSidecarBaseUrl = process.env.NBA_SIDECAR_BASE_URL;
    const polymarketKey = process.env.POLYMARKET_API_KEY;
    const polymarketSecret = process.env.POLYMARKET_API_SECRET;
    const polymarketPassphrase = process.env.POLYMARKET_API_PASSPHRASE;
    const polymarketReady = Boolean(polymarketKey && polymarketSecret && polymarketPassphrase);

    const sources: Array<{
      authState: "configured" | "invalid" | "missing";
      bootstrapState?: "invalid" | "missing" | "ready";
      configured: boolean;
      source: string;
      subscriptionState?: "active" | "inactive" | "unknown";
    }> = [
      {
        authState:
          oddsApiKey || bet365SessionReady
            ? "configured"
            : bet365SessionStatePath != null
              ? "invalid"
              : "missing",
        bootstrapState: oddsApiKey
          ? "ready"
          : bet365SessionStatePath == null
            ? "missing"
            : bet365SessionReady
              ? "ready"
              : bet365SessionStatePath.length === 0
                ? "invalid"
                : "invalid",
        configured: Boolean(oddsApiKey || bet365SessionReady),
        source: "bet365",
        subscriptionState: oddsApiKey ? "active" : "unknown",
      },
      {
        authState:
          oddsApiKey || (kalshiKey && kalshiSecret)
            ? "configured"
            : kalshiKey || kalshiSecret
              ? "invalid"
              : "missing",
        configured: Boolean(oddsApiKey || (kalshiKey && kalshiSecret)),
        source: "kalshi",
        subscriptionState: oddsApiKey ? "active" : "unknown",
      },
      {
        authState: polymarketReady
          ? "configured"
          : polymarketKey || polymarketSecret || polymarketPassphrase
            ? "invalid"
            : "missing",
        configured: polymarketReady,
        source: "polymarket",
        subscriptionState: "unknown",
      },
      {
        authState: nbaSidecarBaseUrl ? "configured" : "missing",
        configured: Boolean(nbaSidecarBaseUrl),
        source: "nba",
      },
    ];

    return sources.map((sourceInfo) => {
      const success = latestSuccessfulRun(sourceInfo.source);
      const latest = latestRun(sourceInfo.source);
      const lagMs = success?.finishedAt
        ? Math.max(0, Date.now() - new Date(success.finishedAt).getTime())
        : null;
      const currentBackoffMs =
        latest?.status === "error" && latest.finishedAt
          ? Math.max(0, Date.now() - new Date(latest.finishedAt).getTime())
          : null;

      return {
        authState: sourceInfo.authState,
        bootstrapState: sourceInfo.bootstrapState,
        configured: sourceInfo.configured,
        currentBackoffMs,
        lagMs,
        lastSuccessAt: success?.finishedAt ?? success?.startedAt ?? null,
        source: sourceInfo.source,
        status:
          sourceInfo.source === "polymarket"
            ? success != null
              ? "ok"
              : "error"
            : sourceInfo.authState === "configured" &&
                (sourceInfo.source === "nba" ? success != null : sourceInfo.configured)
              ? "ok"
              : "error",
        subscriptionState: sourceInfo.subscriptionState,
      } satisfies AdminSourceHealth;
    });
  });
}

export function listAdapterRuns(limit = 50) {
  return executeDatabaseOperation(
    "admin.captureRuns.list",
    () => {
      const db = getDatabase();
      return db
        .prepare(
          `
            SELECT
              id,
              source,
              started_at AS startedAt,
              finished_at AS finishedAt,
              status,
              error_code AS errorCode,
              error_message AS errorMessage,
              records_seen AS recordsSeen,
              records_written AS recordsWritten,
              capture_mode AS captureMode
            FROM adapter_runs
            ORDER BY started_at DESC, id DESC
            LIMIT ?
          `,
        )
        .all(limit);
    },
    {
      limit,
    },
  );
}

export function listUnmappedMarkets() {
  return executeDatabaseOperation("admin.unmappedMarkets.list", () => {
    const db = getDatabase();
    const rows = db
      .prepare(
        `
          SELECT
            id,
            source,
            source_market_key AS sourceMarketKey,
            source_selection_key AS sourceSelectionKey,
            game_id AS gameId,
            instrument_id AS instrumentId,
            raw_family AS rawFamily,
            raw_label AS rawLabel,
            mapping_status AS mappingStatus,
            raw_metadata_json AS rawMetadataJson
          FROM source_markets
          WHERE mapping_status = 'unmapped'
          ORDER BY source ASC, raw_label ASC, source_market_key ASC
        `,
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => {
      const sourceMarket = rowToSourceMarket(row);
      const latestQuote = rowToQuoteTick(
        db
          .prepare(
            `
              SELECT
                id,
                source_market_id AS sourceMarketId,
                captured_at AS capturedAt,
                price_raw AS priceRaw,
                odds_raw AS oddsRaw,
                line_raw AS lineRaw,
                implied_probability AS impliedProbability,
                best_bid AS bestBid,
                best_ask AS bestAsk,
                volume,
                depth_score AS depthScore,
                is_heartbeat AS isHeartbeat
              FROM quote_ticks
              WHERE source_market_id = ?
              ORDER BY captured_at DESC, id DESC
              LIMIT 1
            `,
          )
          .get(sourceMarket.id) as Record<string, unknown> | undefined,
      );

      const game = rowToGame(
        db
          .prepare(
            `
              SELECT
                id,
                sport,
                league,
                source_game_key_nba AS sourceGameKeyNba,
                home_participant_json AS homeParticipantJson,
                away_participant_json AS awayParticipantJson,
                scheduled_start AS scheduledStart
              FROM games
              WHERE id = ?
            `,
          )
          .get(sourceMarket.gameId) as Record<string, unknown>,
      );

      return {
        game,
        latestQuote,
        sourceMarket,
      } satisfies AdminUnmappedMarket;
    });
  });
}

export function getStorageCoverage() {
  return executeDatabaseOperation("admin.storageCoverage.get", () => {
    const db = getDatabase();
    return db
      .prepare(
        `
          WITH selected_source_markets AS (
            SELECT
              sm.id AS sourceMarketId,
              sm.source AS source,
              g.sport AS sport,
              g.league AS league,
              g.id AS gameId,
              g.scheduled_start AS scheduledStart,
              mi.family AS family
            FROM source_markets sm
            JOIN games g ON g.id = sm.game_id
            LEFT JOIN market_instruments mi ON mi.id = sm.instrument_id
            ORDER BY
              CASE
                WHEN datetime(g.scheduled_start) >= datetime('now', '-8 hours')
                  AND datetime(g.scheduled_start) <= datetime('now', '+48 hours')
                  THEN 0
                WHEN datetime(g.scheduled_start) >= datetime('now', '-8 hours')
                  THEN 1
                ELSE 2
              END,
              ABS(strftime('%s', g.scheduled_start) - strftime('%s', 'now')) ASC,
              g.scheduled_start ASC,
              sm.source ASC
            LIMIT 1000
          )
          SELECT
            ssm.source AS source,
            ssm.sport AS sport,
            ssm.league AS league,
            ssm.gameId AS gameId,
            ssm.family AS family,
            COUNT(ssm.sourceMarketId) AS sourceMarketCount,
            SUM((
              SELECT COUNT(*)
              FROM quote_ticks qt
              WHERE qt.source_market_id = ssm.sourceMarketId
            )) AS quoteTickCount,
            SUM((
              SELECT COUNT(*)
              FROM raw_payloads rp
              WHERE rp.entity_type = 'source_market'
                AND rp.entity_id = ssm.sourceMarketId
            )) AS rawPayloadCount
          FROM selected_source_markets ssm
          GROUP BY ssm.source, ssm.sport, ssm.league, ssm.gameId, ssm.family
          ORDER BY MIN(ssm.scheduledStart) ASC, ssm.source ASC
        `,
      )
      .all()
      .map((row) => ({
        family:
          (row as { family?: string | null }).family == null
            ? null
            : (String((row as { family: string }).family) as MarketFamily),
        gameId: String((row as { gameId: string }).gameId),
        league: String((row as { league: string }).league),
        quoteTickCount: Number((row as { quoteTickCount: number }).quoteTickCount),
        rawPayloadCount: Number((row as { rawPayloadCount: number }).rawPayloadCount),
        source: String((row as { source: string }).source),
        sourceMarketCount: Number((row as { sourceMarketCount: number }).sourceMarketCount),
        sport: String((row as { sport: string }).sport),
      })) satisfies StorageCoverageRow[];
  });
}

function safeCountTableForAudit(db: Database.Database, tableName: string) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

function auditTimestampAgeMs(value: string | null) {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
}

function classifyAuditDataState(counts: {
  gameCount: number;
  quoteTickCount: number;
  rawPayloadCount: number;
  sourceMarketCount: number;
}) {
  if (counts.quoteTickCount === 0 && counts.rawPayloadCount === 0) {
    return "empty" as const;
  }

  if (counts.gameCount <= 5 && counts.sourceMarketCount <= 25 && counts.quoteTickCount <= 1000) {
    return "seed-or-test" as const;
  }

  if (counts.quoteTickCount >= 10_000 && counts.sourceMarketCount >= 100) {
    return "persisted-live" as const;
  }

  return "partial-live" as const;
}

function inferRuntimeWarnings(input: {
  dataState: "empty" | "partial-live" | "persisted-live" | "seed-or-test";
  dbPath: string;
  sourceBreakdown: Array<{
    source: string;
    quoteTickCount: number;
  }>;
}) {
  const warnings: string[] = [];

  if (input.dataState === "empty") {
    warnings.push(
      "The selected SQLite database has schema but no quote or raw payload rows. Point SIGNAL_CONSOLE_DB_PATH at the persisted live database before a demo.",
    );
  }

  if (input.dataState === "seed-or-test") {
    warnings.push(
      "The selected database looks like a seed or e2e fixture. Do not present it as live evidence.",
    );
  }

  if (input.dbPath.includes(".e2e.")) {
    warnings.push("The active database path contains .e2e.; this is test data by convention.");
  }

  if (!process.env.SIGNAL_CONSOLE_DB_PATH) {
    warnings.push(
      "SIGNAL_CONSOLE_DB_PATH is not set, so the runtime is using the canonical home database path.",
    );
  }

  const bet365 = input.sourceBreakdown.find((row) => row.source === "bet365");
  if (!bet365 || bet365.quoteTickCount === 0) {
    warnings.push(
      "No persisted Bet365 quotes were found in the active DB. The trader desk can still compare external markets, but the book leg is not evidence-backed yet.",
    );
  }

  if (bet365 && bet365.quoteTickCount > 0 && resolveOddsApiKey() != null) {
    warnings.push(
      "Bet365 ticks are currently sourced through ODDS_API_KEY provider plumbing, not a direct internal book feed. Label this as proxy sportsbook pricing until the internal feed is wired.",
    );
  }

  return warnings;
}

export function getRuntimeAudit() {
  return executeDatabaseOperation("admin.runtimeAudit.get", () => {
    const db = getDatabase();
    const dbPath = getDatabasePath();
    const counts = {
      adapterRunCount: safeCountTableForAudit(db, "adapter_runs"),
      adminActionCount: safeCountTableForAudit(db, "admin_actions"),
      gameCount: safeCountTableForAudit(db, "games"),
      gameStateCount: safeCountTableForAudit(db, "game_states"),
      marketInstrumentCount: safeCountTableForAudit(db, "market_instruments"),
      outcomeCount: safeCountTableForAudit(db, "game_outcomes"),
      quoteTickCount: safeCountTableForAudit(db, "quote_ticks"),
      rawPayloadCount: safeCountTableForAudit(db, "raw_payloads"),
      sourceMarketCount: safeCountTableForAudit(db, "source_markets"),
    };

    const sourceRows = db
      .prepare(
        `
          SELECT
            sm.source AS source,
            COUNT(DISTINCT sm.id) AS sourceMarketCount,
            COUNT(DISTINCT sm.game_id) AS gameCount,
            COUNT(qt.id) AS quoteTickCount,
            MAX(qt.captured_at) AS latestQuoteAt
          FROM source_markets sm
          LEFT JOIN quote_ticks qt ON qt.source_market_id = sm.id
          GROUP BY sm.source
          ORDER BY quoteTickCount DESC, sm.source ASC
        `,
      )
      .all() as Array<{
      gameCount: number;
      latestQuoteAt: string | null;
      quoteTickCount: number;
      source: string;
      sourceMarketCount: number;
    }>;

    const rawPayloadRows = new Map(
      (
        db
          .prepare(
            `
              SELECT
                source,
                COUNT(*) AS rawPayloadCount,
                MAX(captured_at) AS latestRawPayloadAt
              FROM raw_payloads
              GROUP BY source
            `,
          )
          .all() as Array<{
          latestRawPayloadAt: string | null;
          rawPayloadCount: number;
          source: string;
        }>
      ).map((row) => [row.source, row]),
    );

    const latestRunRows = new Map(
      (
        db
          .prepare(
            `
              WITH ranked AS (
                SELECT
                  source,
                  started_at AS startedAt,
                  finished_at AS finishedAt,
                  status,
                  capture_mode AS captureMode,
                  records_seen AS recordsSeen,
                  records_written AS recordsWritten,
                  ROW_NUMBER() OVER (
                    PARTITION BY source
                    ORDER BY started_at DESC, id DESC
                  ) AS rn
                FROM adapter_runs
              )
              SELECT * FROM ranked WHERE rn = 1
            `,
          )
          .all() as Array<{
          captureMode: string | null;
          finishedAt: string | null;
          recordsSeen: number;
          recordsWritten: number;
          source: string;
          startedAt: string;
          status: string;
        }>
      ).map((row) => [row.source, row]),
    );

    const captureModesBySource = new Map(
      (
        db
          .prepare(
            `
              SELECT source, GROUP_CONCAT(DISTINCT capture_mode) AS captureModes
              FROM adapter_runs
              GROUP BY source
            `,
          )
          .all() as Array<{ captureModes: string | null; source: string }>
      ).map((row) => [
        row.source,
        row.captureModes ? row.captureModes.split(",").filter((value) => value.length > 0) : [],
      ]),
    );

    const sourceBreakdown = sourceRows.map((row) => {
      const raw = rawPayloadRows.get(row.source);
      const latestRun = latestRunRows.get(row.source);
      return {
        captureModes: captureModesBySource.get(row.source) ?? [],
        gameCount: Number(row.gameCount ?? 0),
        latestQuoteAgeMs: auditTimestampAgeMs(row.latestQuoteAt),
        latestQuoteAt: row.latestQuoteAt ?? null,
        latestRawPayloadAgeMs: auditTimestampAgeMs(raw?.latestRawPayloadAt ?? null),
        latestRawPayloadAt: raw?.latestRawPayloadAt ?? null,
        latestRun: latestRun
          ? {
              captureMode: latestRun.captureMode ?? null,
              finishedAt: latestRun.finishedAt ?? null,
              recordsSeen: Number(latestRun.recordsSeen ?? 0),
              recordsWritten: Number(latestRun.recordsWritten ?? 0),
              startedAt: latestRun.startedAt,
              status: latestRun.status,
            }
          : null,
        quoteTickCount: Number(row.quoteTickCount ?? 0),
        rawPayloadCount: Number(raw?.rawPayloadCount ?? 0),
        source: row.source,
        sourceMarketCount: Number(row.sourceMarketCount ?? 0),
      };
    });

    const dataState = classifyAuditDataState(counts);
    const warnings = inferRuntimeWarnings({
      dataState,
      dbPath,
      sourceBreakdown,
    });

    const hasExternalMarkets = sourceBreakdown.some(
      (row) => (row.source === "kalshi" || row.source === "polymarket") && row.quoteTickCount > 0,
    );
    const hasBookProxy = sourceBreakdown.some(
      (row) => row.source === "bet365" && row.quoteTickCount > 0,
    );
    const hasOutcomes = counts.outcomeCount > 0;
    const hasRawPayloads = counts.rawPayloadCount > 0;

    return {
      database: {
        basename: basename(dbPath),
        path: dbPath,
        schemaVersion: getDatabaseSchemaVersion(),
        wal: {
          mainExists: existsSync(dbPath),
          shmExists: existsSync(`${dbPath}-shm`),
          walExists: existsSync(`${dbPath}-wal`),
        },
      },
      generatedAt: new Date().toISOString(),
      productReadiness: {
        checklist: [
          {
            detail:
              dataState === "persisted-live"
                ? "Large persisted quote history is present."
                : "Use a persisted live DB before demoing the desk as evidence-backed.",
            id: "persisted-live-db",
            label: "Persisted live DB selected",
            status: dataState === "persisted-live" ? "pass" : "fail",
          },
          {
            detail: hasExternalMarkets
              ? "Kalshi or Polymarket ticks are available."
              : "No external prediction-market ticks were found.",
            id: "external-market-feed",
            label: "External market feed present",
            status: hasExternalMarkets ? "pass" : "fail",
          },
          {
            detail: hasBookProxy
              ? "Book-side proxy quotes are present. Label source provenance clearly."
              : "No Bet365/book-side quote rows were found.",
            id: "book-side-feed",
            label: "Book-side feed present",
            status: hasBookProxy ? "warn" : "fail",
          },
          {
            detail: hasOutcomes
              ? "Outcomes exist, so calibration can be computed."
              : "No outcomes exist, so calibration surfaces will be weak.",
            id: "closed-game-outcomes",
            label: "Closed-game outcomes present",
            status: hasOutcomes ? "pass" : "warn",
          },
          {
            detail: hasRawPayloads
              ? "Raw payloads exist for audit and provenance drawers."
              : "No raw payloads were found. Every displayed number should be traceable to raw source data.",
            id: "raw-payload-provenance",
            label: "Raw payload provenance present",
            status: hasRawPayloads ? "pass" : "fail",
          },
        ],
        dataState,
        status:
          warnings.length === 0 && dataState === "persisted-live"
            ? "ready"
            : dataState === "persisted-live"
              ? "usable-with-warnings"
              : "not-ready",
        warnings,
      },
      sourceBreakdown,
      tableCounts: counts,
    };
  });
}
