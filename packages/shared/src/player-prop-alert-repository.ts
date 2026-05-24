import type {
  LatestSourceView,
  MappingStatus,
  MarketInstrument,
  PlayerPropAlertSource,
  PlayerPropDisagreementAlert,
} from "@signal-console/domain";

import {
  currentTimestamp,
  executeDatabaseOperation,
  getDatabase,
} from "./db-core";
import {
  clampAlertLimit,
  gapToSeverity,
  lineValuesMatch,
  normalizeAlertNumber,
  nullableNumber,
  sourceSelectionMatchesInstrument,
  timestampValue,
  toBoolean,
} from "./live-repository-support";

export type PlayerPropAlertFilters = {
  includeStale?: boolean;
  limit?: number;
  maxQuoteAgeMinutes?: number;
  maxQuoteTimeGapMinutes?: number;
  minDelta?: number;
  now?: Date | string;
};

function playerPropAlertSourceFromRow(
  row: Record<string, unknown>,
  prefix: "bet365" | "external"
): PlayerPropAlertSource {
  return {
    bestAsk: nullableNumber(row[`${prefix}BestAsk`]),
    bestBid: nullableNumber(row[`${prefix}BestBid`]),
    capturedAt: String(row[`${prefix}CapturedAt`]),
    impliedProbability: Number(row[`${prefix}ImpliedProbability`]),
    lineRaw: nullableNumber(row[`${prefix}LineRaw`]),
    mappingStatus: String(row[`${prefix}MappingStatus`]) as MappingStatus,
    oddsRaw:
      row[`${prefix}OddsRaw`] == null ? null : String(row[`${prefix}OddsRaw`]),
    priceRaw: nullableNumber(row[`${prefix}PriceRaw`]),
    rawLabel:
      row[`${prefix}RawLabel`] == null
        ? null
        : String(row[`${prefix}RawLabel`]),
    source: String(row[`${prefix}Source`]) as PlayerPropAlertSource["source"],
    sourceMarketId: String(row[`${prefix}SourceMarketId`]),
    sourceMarketKey: String(row[`${prefix}SourceMarketKey`]),
    sourceSelectionKey:
      row[`${prefix}SourceSelectionKey`] == null
        ? null
        : String(row[`${prefix}SourceSelectionKey`]),
    volume: nullableNumber(row[`${prefix}Volume`]),
  };
}

function buildPlayerPropAlert(
  row: Record<string, unknown>,
  options: Required<
    Pick<
      PlayerPropAlertFilters,
      | "includeStale"
      | "limit"
      | "maxQuoteTimeGapMinutes"
      | "maxQuoteAgeMinutes"
      | "minDelta"
    >
  > & { nowIso: string }
): PlayerPropDisagreementAlert | null {
  const bet365 = playerPropAlertSourceFromRow(row, "bet365");
  const predictionMarket = playerPropAlertSourceFromRow(row, "external");
  const bet365Timestamp = timestampValue(bet365.capturedAt);
  const predictionTimestamp = timestampValue(predictionMarket.capturedAt);
  const nowTimestamp = timestampValue(options.nowIso);

  if (
    bet365Timestamp < 0 ||
    predictionTimestamp < 0 ||
    nowTimestamp < 0 ||
    !Number.isFinite(bet365.impliedProbability) ||
    !Number.isFinite(predictionMarket.impliedProbability)
  ) {
    return null;
  }

  const absoluteDelta = Math.abs(
    predictionMarket.impliedProbability - bet365.impliedProbability
  );
  if (absoluteDelta < options.minDelta) {
    return null;
  }

  const quoteTimeGapMs = Math.abs(predictionTimestamp - bet365Timestamp);
  if (quoteTimeGapMs > options.maxQuoteTimeGapMinutes * 60_000) {
    return null;
  }

  const bet365AgeMs = Math.max(0, nowTimestamp - bet365Timestamp);
  const predictionMarketAgeMs = Math.max(0, nowTimestamp - predictionTimestamp);
  if (
    !options.includeStale &&
    (bet365AgeMs > options.maxQuoteAgeMinutes * 60_000 ||
      predictionMarketAgeMs > options.maxQuoteAgeMinutes * 60_000)
  ) {
    return null;
  }

  const line = nullableNumber(row.line);
  const inPlay = toBoolean(row.inPlay as number | boolean | null | undefined);
  const gameId = String(row.gameId);
  const instrumentId = String(row.instrumentId);
  const instrumentForMatch = {
    displayLabel: String(row.displayLabel),
    family: "player-prop",
    gameId,
    id: instrumentId,
    inPlay,
    line,
    participantKey:
      row.participantKey == null ? null : String(row.participantKey),
    selection: String(row.selection),
  } satisfies MarketInstrument;
  const bet365View = {
    capturedAt: bet365.capturedAt,
    impliedProbability: bet365.impliedProbability,
    mappingStatus: bet365.mappingStatus,
    raw: {
      label: bet365.rawLabel ?? null,
      line: bet365.lineRaw ?? null,
      selectionKey: bet365.sourceSelectionKey ?? null,
    },
    source: bet365.source,
    sourceMarketId: bet365.sourceMarketId,
  } satisfies LatestSourceView;
  const predictionMarketView = {
    capturedAt: predictionMarket.capturedAt,
    impliedProbability: predictionMarket.impliedProbability,
    mappingStatus: predictionMarket.mappingStatus,
    raw: {
      label: predictionMarket.rawLabel ?? null,
      line: predictionMarket.lineRaw ?? null,
      selectionKey: predictionMarket.sourceSelectionKey ?? null,
    },
    source: predictionMarket.source,
    sourceMarketId: predictionMarket.sourceMarketId,
  } satisfies LatestSourceView;

  if (
    !sourceSelectionMatchesInstrument(instrumentForMatch, bet365View) ||
    !sourceSelectionMatchesInstrument(instrumentForMatch, predictionMarketView)
  ) {
    return null;
  }

  const lineMismatch =
    !lineValuesMatch(bet365.lineRaw, line) ||
    !lineValuesMatch(predictionMarket.lineRaw, line) ||
    !lineValuesMatch(bet365.lineRaw, predictionMarket.lineRaw);
  if (lineMismatch) {
    return null;
  }
  const detectedAt = new Date(
    Math.max(bet365Timestamp, predictionTimestamp)
  ).toISOString();
  const signedDelta =
    predictionMarket.impliedProbability - bet365.impliedProbability;
  const direction =
    signedDelta > 0 ? "prediction-market-higher" : "bet365-higher";
  const severity = gapToSeverity(absoluteDelta, lineMismatch);
  const riskScore = Math.max(
    0,
    Math.round(
      absoluteDelta * 1000 +
        (lineMismatch ? 120 : 0) +
        (inPlay ? 40 : 0) -
        quoteTimeGapMs / 60_000 -
        Math.min(bet365AgeMs, predictionMarketAgeMs) / 600_000
    )
  );
  return {
    absoluteDelta,
    action: "manual-review",
    bet365,
    detectedAt,
    direction,
    displayLabel: String(row.displayLabel),
    freshness: {
      bet365AgeMs,
      predictionMarketAgeMs,
      quoteTimeGapMs,
    },
    gameId,
    gameLabel: String(row.gameLabel),
    id: [
      gameId,
      instrumentId,
      predictionMarket.source,
      direction,
      bet365.sourceMarketId,
      predictionMarket.sourceMarketId,
    ].join(":"),
    inPlay,
    instrumentId,
    league: String(row.league),
    line,
    lineMismatch,
    participantKey:
      row.participantKey == null ? null : String(row.participantKey),
    predictionMarket,
    riskScore,
    scheduledStart: String(row.scheduledStart),
    selection: String(row.selection),
    severity,
    signedDelta,
    sport: String(row.sport),
  } satisfies PlayerPropDisagreementAlert;
}

export function listPlayerPropDisagreementAlerts(
  filters: PlayerPropAlertFilters = {}
) {
  return executeDatabaseOperation(
    "research.playerPropDisagreementAlerts.list",
    () => {
      const db = getDatabase();
      const nowIso =
        filters.now instanceof Date
          ? filters.now.toISOString()
          : (filters.now ?? currentTimestamp());
      const options = {
        includeStale: filters.includeStale ?? false,
        limit: clampAlertLimit(filters.limit),
        maxQuoteTimeGapMinutes: normalizeAlertNumber(
          filters.maxQuoteTimeGapMinutes,
          10,
          0
        ),
        maxQuoteAgeMinutes: normalizeAlertNumber(
          filters.maxQuoteAgeMinutes,
          10,
          0
        ),
        minDelta: normalizeAlertNumber(filters.minDelta, 0.15, 0),
        nowIso,
      };

      const rows = db
        .prepare(
          `
            WITH player_props AS (
              SELECT
                mi.id AS instrumentId,
                mi.game_id AS gameId,
                mi.display_label AS displayLabel,
                mi.selection,
                mi.line,
                mi.participant_key AS participantKey,
                mi.in_play AS inPlay,
                g.sport,
                g.league,
                g.scheduled_start AS scheduledStart,
                json_extract(g.away_participant_json, '$.shortName') || ' at ' ||
                  json_extract(g.home_participant_json, '$.shortName') AS gameLabel
              FROM market_instruments mi
              JOIN games g ON g.id = mi.game_id
              WHERE mi.family = 'player-prop'
                AND NOT EXISTS (
                  SELECT 1
                  FROM game_outcomes go
                  WHERE go.game_id = mi.game_id
                )
                AND COALESCE((
                  SELECT gs.status
                  FROM game_states gs
                  WHERE gs.game_id = mi.game_id
                  ORDER BY
                    CASE
                      WHEN datetime(gs.captured_at) > datetime('now', '+10 minutes') THEN 1
                      ELSE 0
                    END,
                    datetime(gs.captured_at) DESC,
                    gs.id DESC
                  LIMIT 1
                ), 'scheduled') != 'final'
            ),
            latest_source_ticks AS (
              SELECT
                p.*,
                sm.source,
                sm.id AS sourceMarketId,
                sm.source_market_key AS sourceMarketKey,
                sm.source_selection_key AS sourceSelectionKey,
                sm.raw_label AS rawLabel,
                sm.mapping_status AS mappingStatus,
                q.id AS tickId,
                q.captured_at AS capturedAt,
                q.implied_probability AS impliedProbability,
                q.line_raw AS lineRaw,
                q.odds_raw AS oddsRaw,
                q.price_raw AS priceRaw,
                q.best_bid AS bestBid,
                q.best_ask AS bestAsk,
                q.volume AS volume,
                ROW_NUMBER() OVER (
                  PARTITION BY sm.instrument_id, sm.source
                  ORDER BY q.captured_at DESC, q.id DESC
                ) AS sourceRank
              FROM player_props p
              JOIN source_markets sm ON sm.instrument_id = p.instrumentId
              JOIN quote_ticks q ON q.id = (
                SELECT q2.id
                FROM quote_ticks q2
                WHERE q2.source_market_id = sm.id
                  AND q2.implied_probability IS NOT NULL
                  AND datetime(q2.captured_at) <= datetime(?)
                ORDER BY q2.captured_at DESC, q2.id DESC
                LIMIT 1
              )
              WHERE sm.source IN ('bet365', 'kalshi', 'polymarket')
                AND sm.mapping_status != 'unmapped'
            ),
            bet365_latest AS (
              SELECT * FROM latest_source_ticks
              WHERE source = 'bet365' AND sourceRank = 1
            ),
            external_latest AS (
              SELECT * FROM latest_source_ticks
              WHERE source IN ('kalshi', 'polymarket') AND sourceRank = 1
            )
            SELECT
              b.gameId,
              b.instrumentId,
              b.gameLabel,
              b.sport,
              b.league,
              b.scheduledStart,
              b.displayLabel,
              b.selection,
              b.line,
              b.participantKey,
              b.inPlay,
              b.source AS bet365Source,
              b.sourceMarketId AS bet365SourceMarketId,
              b.sourceMarketKey AS bet365SourceMarketKey,
              b.sourceSelectionKey AS bet365SourceSelectionKey,
              b.rawLabel AS bet365RawLabel,
              b.mappingStatus AS bet365MappingStatus,
              b.capturedAt AS bet365CapturedAt,
              b.impliedProbability AS bet365ImpliedProbability,
              b.lineRaw AS bet365LineRaw,
              b.oddsRaw AS bet365OddsRaw,
              b.priceRaw AS bet365PriceRaw,
              b.bestBid AS bet365BestBid,
              b.bestAsk AS bet365BestAsk,
              b.volume AS bet365Volume,
              e.source AS externalSource,
              e.sourceMarketId AS externalSourceMarketId,
              e.sourceMarketKey AS externalSourceMarketKey,
              e.sourceSelectionKey AS externalSourceSelectionKey,
              e.rawLabel AS externalRawLabel,
              e.mappingStatus AS externalMappingStatus,
              e.capturedAt AS externalCapturedAt,
              e.impliedProbability AS externalImpliedProbability,
              e.lineRaw AS externalLineRaw,
              e.oddsRaw AS externalOddsRaw,
              e.priceRaw AS externalPriceRaw,
              e.bestBid AS externalBestBid,
              e.bestAsk AS externalBestAsk,
              e.volume AS externalVolume
            FROM bet365_latest b
            JOIN external_latest e ON e.instrumentId = b.instrumentId
          `
        )
        .all(options.nowIso) as Record<string, unknown>[];

      return rows
        .map((row) => buildPlayerPropAlert(row, options))
        .filter((row): row is PlayerPropDisagreementAlert => row != null)
        .sort((left, right) => {
          if (right.riskScore !== left.riskScore) {
            return right.riskScore - left.riskScore;
          }
          return right.absoluteDelta - left.absoluteDelta;
        })
        .slice(0, options.limit);
    },
    filters
  );
}
