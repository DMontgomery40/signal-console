import type {
  InstrumentDivergenceSummary,
  MarketFamily,
  ResearchSourceId,
} from "@signal-console/domain";

import { executeDatabaseOperation, getDatabase } from "./db-core";

type Row = Record<string, unknown>;

const MONEYLINE_FAMILY: MarketFamily = "moneyline";
const DEFAULT_COMPARISON_INTERVAL_MS = 60_000;
const MAX_COMPARISON_CONTINUITY_MS = 10 * 60_000;

export type SourceClosingProbability = {
  source: ResearchSourceId | string;
  impliedProbability: number | null;
  capturedAt: string | null;
  freshnessMs: number | null;
};

export type ClosedGameInstrumentSummary = {
  gameId: string;
  instrumentId: string;
  family: MarketFamily;
  selection: string;
  displayLabel: string;
  participantKey: string | null;
  finalAt: string | null;
  outcome: {
    winnerKey: string | null;
    winnerProbability: 0 | 1 | null;
  };
  sources: SourceClosingProbability[];
};

export type ClosedGameSummary = {
  gameId: string;
  matchup: string;
  league: string;
  sport: string;
  scheduledStart: string;
  finalAt: string | null;
  finalHomeScore: number | null;
  finalAwayScore: number | null;
  winnerKey: string | null;
  moneylineByParticipant: ClosedGameInstrumentSummary[];
};

export type DeltaSeriesPoint = {
  bucketAt: string;
  bet365Probability: number | null;
  externalAverage: number | null;
  perSource: Record<string, number | null>;
  absoluteDelta: number | null;
  signedDelta: number | null;
};

export function summarizeDeltaSeries(
  series: DeltaSeriesPoint[],
  threshold = 0.15
): InstrumentDivergenceSummary | null {
  const orderedSeries = [...series].sort((left, right) =>
    left.bucketAt.localeCompare(right.bucketAt)
  );
  const compared = orderedSeries.filter(
    (
      point
    ): point is DeltaSeriesPoint & {
      absoluteDelta: number;
      signedDelta: number;
    } =>
      typeof point.absoluteDelta === "number" &&
      typeof point.signedDelta === "number"
  );

  if (compared.length === 0) {
    return null;
  }

  const continuityWindowMs = inferComparisonContinuityWindowMs(orderedSeries);
  let maxPoint = compared[0];
  let minPoint = compared[0];
  let aboveThresholdDurationMs = 0;
  let firstAboveThresholdAt: string | null = null;

  for (const point of compared) {
    if (point.absoluteDelta > maxPoint.absoluteDelta) {
      maxPoint = point;
    }
    if (point.absoluteDelta < minPoint.absoluteDelta) {
      minPoint = point;
    }
  }

  orderedSeries.forEach((point, index) => {
    if (typeof point.absoluteDelta !== "number") {
      return;
    }
    if (point.absoluteDelta >= threshold) {
      firstAboveThresholdAt ??= point.bucketAt;
      const next = orderedSeries[index + 1];
      const start = Date.parse(point.bucketAt);
      const end = next ? Date.parse(next.bucketAt) : start;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        aboveThresholdDurationMs += Math.min(end - start, continuityWindowMs);
      }
    }
  });

  const latestPoint = compared[compared.length - 1];

  return {
    aboveThresholdDurationMs,
    comparisonCount: compared.length,
    firstAboveThresholdAt,
    firstComparisonAt: compared[0].bucketAt,
    latestComparisonAt: latestPoint.bucketAt,
    latestGap: latestPoint.absoluteDelta,
    latestSignedGap: latestPoint.signedDelta,
    latestSourceProbabilities: latestPoint.perSource,
    maxGap: maxPoint.absoluteDelta,
    maxGapAt: maxPoint.bucketAt,
    maxGapSourceProbabilities: maxPoint.perSource,
    minGap: minPoint.absoluteDelta,
    threshold,
  };
}

function inferComparisonContinuityWindowMs(series: DeltaSeriesPoint[]) {
  const timestamps = series
    .map((point) => Date.parse(point.bucketAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const deltas = timestamps
    .slice(1)
    .map((timestamp, index) => timestamp - timestamps[index])
    .filter((delta) => delta > 0 && delta <= MAX_COMPARISON_CONTINUITY_MS)
    .sort((left, right) => left - right);

  if (deltas.length === 0) {
    return DEFAULT_COMPARISON_INTERVAL_MS;
  }

  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.min(
    Math.max(DEFAULT_COMPARISON_INTERVAL_MS, median * 2),
    MAX_COMPARISON_CONTINUITY_MS
  );
}

export type SignalQualityReport = {
  sampleCount: number;
  perSource: Array<{
    source: ResearchSourceId | string;
    sampleCount: number;
    brier: number | null;
    logLoss: number | null;
    closingWinnerAccuracy: number | null;
    calibrationSlope: number | null;
    calibrationIntercept: number | null;
  }>;
};

type DeltaBucketRow = {
  bucketAt: string;
  impliedProbability: number;
  source: string;
};

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function matchupFromParticipants(home: Row, away: Row) {
  const homeShort = asString(home.shortName) ?? asString(home.name) ?? "?";
  const awayShort = asString(away.shortName) ?? asString(away.name) ?? "?";
  return `${awayShort} @ ${homeShort}`;
}

function bucketStartIso(iso: string, bucketSeconds: number) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const bucketMs = bucketSeconds * 1000;
  const floored = Math.floor(ms / bucketMs) * bucketMs;
  return new Date(floored).toISOString();
}

function buildDeltaSeriesFromBucketRows(rows: DeltaBucketRow[]) {
  type BucketEntry = Map<string, { sum: number; count: number }>;
  const buckets = new Map<string, BucketEntry>();

  for (const row of rows) {
    const capturedAt = row.bucketAt;
    const source = row.source;
    const implied = row.impliedProbability;
    if (!capturedAt || !source || implied == null) continue;

    const bucket = buckets.get(capturedAt) ?? new Map();
    const entry = bucket.get(source) ?? { count: 0, sum: 0 };
    entry.sum += implied;
    entry.count += 1;
    bucket.set(source, entry);
    buckets.set(capturedAt, bucket);
  }

  const bucketAts = Array.from(buckets.keys()).sort();
  const maxCarryForwardMs = 10 * 60_000;
  const lastSeenBySource = new Map<
    string,
    { bucketAtMs: number; value: number }
  >();
  const result: DeltaSeriesPoint[] = [];

  for (const bucketAt of bucketAts) {
    const entry = buckets.get(bucketAt);
    if (!entry) continue;

    const bucketAtMs = Date.parse(bucketAt);
    const perSource: Record<string, number | null> = {};
    for (const [source, agg] of entry.entries()) {
      const avg = agg.sum / agg.count;
      perSource[source] = avg;
      if (Number.isFinite(bucketAtMs)) {
        lastSeenBySource.set(source, { bucketAtMs, value: avg });
      }
    }

    for (const [source, lastSeen] of lastSeenBySource.entries()) {
      if (
        perSource[source] == null &&
        Number.isFinite(bucketAtMs) &&
        bucketAtMs - lastSeen.bucketAtMs <= maxCarryForwardMs
      ) {
        perSource[source] = lastSeen.value;
      }
    }

    const bet365 = perSource.bet365 ?? null;
    const externals = [perSource.kalshi, perSource.polymarket].filter(
      (value): value is number => typeof value === "number"
    );
    const externalAverage =
      externals.length > 0
        ? externals.reduce((sum, value) => sum + value, 0) / externals.length
        : null;

    const absoluteDelta =
      bet365 != null && externalAverage != null
        ? Math.abs(bet365 - externalAverage)
        : null;
    const signedDelta =
      bet365 != null && externalAverage != null
        ? externalAverage - bet365
        : null;

    result.push({
      absoluteDelta,
      bet365Probability: bet365,
      bucketAt,
      externalAverage,
      perSource,
      signedDelta,
    });
  }

  return result;
}

function clampProbability(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= 0) return 0.0001;
  if (value >= 1) return 0.9999;
  return value;
}

export type ClosingCutoff = "live-final" | "pregame";

export function listClosedGameSummaries(options?: {
  closingCutoff?: ClosingCutoff;
  league?: string;
  since?: string;
  until?: string;
  limit?: number;
}) {
  return executeDatabaseOperation("signalQuality.closedGames.list", () => {
    const db = getDatabase();

    const params: (number | string)[] = [];
    const wheres: string[] = ["go.game_id IS NOT NULL"];
    if (options?.league) {
      wheres.push("g.league = ?");
      params.push(options.league);
    }
    if (options?.since) {
      wheres.push("g.scheduled_start >= ?");
      params.push(options.since);
    }
    if (options?.until) {
      wheres.push("g.scheduled_start <= ?");
      params.push(options.until);
    }
    params.push(options?.limit ?? 200);

    const gameRows = db
      .prepare(
        `
          SELECT
            g.id AS gameId,
            g.sport,
            g.league,
            g.scheduled_start AS scheduledStart,
            g.home_participant_json AS homeJson,
            g.away_participant_json AS awayJson,
            go.final_home_score AS finalHomeScore,
            go.final_away_score AS finalAwayScore,
            go.winner_key AS winnerKey,
            (
              SELECT final_at FROM game_states gs
              WHERE gs.game_id = g.id AND gs.is_final = 1
              ORDER BY captured_at DESC LIMIT 1
            ) AS finalAt
          FROM games g
          JOIN game_outcomes go ON go.game_id = g.id
          WHERE ${wheres.join(" AND ")}
          ORDER BY g.scheduled_start DESC
          LIMIT ?
        `
      )
      .all(...params) as Row[];

    if (gameRows.length === 0) return [];

    const gameIds = gameRows.map((row) => String(row.gameId));
    const placeholders = gameIds.map(() => "?").join(",");

    const moneylineInstruments = db
      .prepare(
        `
          SELECT
            id,
            game_id AS gameId,
            family,
            selection,
            participant_key AS participantKey,
            display_label AS displayLabel
          FROM market_instruments
          WHERE game_id IN (${placeholders})
            AND family = ?
        `
      )
      .all(...gameIds, MONEYLINE_FAMILY) as Row[];

    if (moneylineInstruments.length === 0) {
      return gameRows.map((gameRow) =>
        buildClosedGameRecord(gameRow, [], new Map())
      );
    }

    const instrumentIds = moneylineInstruments.map((row) => String(row.id));
    const instrPlaceholders = instrumentIds.map(() => "?").join(",");

    const cutoff = options?.closingCutoff ?? "pregame";
    const cutoffColumn = cutoff === "pregame" ? "scheduled_start" : "final_at";

    const closingRows = db
      .prepare(
        `
          WITH cutoffs AS (
            SELECT g.id AS gameId,
                   g.scheduled_start AS scheduled_start,
                   (
                     SELECT gs.final_at FROM game_states gs
                     WHERE gs.game_id = g.id AND gs.is_final = 1
                     ORDER BY gs.captured_at DESC LIMIT 1
                   ) AS final_at
            FROM games g
          ),
          ranked AS (
            SELECT
              sm.instrument_id AS instrumentId,
              sm.source AS source,
              q.implied_probability AS impliedProbability,
              q.captured_at AS capturedAt,
              ROW_NUMBER() OVER (
                PARTITION BY sm.instrument_id, sm.source
                ORDER BY q.captured_at DESC
              ) AS rn
            FROM source_markets sm
            JOIN quote_ticks q ON q.source_market_id = sm.id
            JOIN cutoffs c ON c.gameId = sm.game_id
            WHERE sm.instrument_id IN (${instrPlaceholders})
              AND c.${cutoffColumn} IS NOT NULL
              AND q.captured_at <= c.${cutoffColumn}
          )
          SELECT instrumentId, source, impliedProbability, capturedAt
          FROM ranked WHERE rn = 1
        `
      )
      .all(...instrumentIds) as Row[];

    const bySourceByInstrument = new Map<string, Map<string, Row>>();
    for (const row of closingRows) {
      const instrumentId = String(row.instrumentId);
      const source = String(row.source);
      const sourceMap = bySourceByInstrument.get(instrumentId) ?? new Map();
      sourceMap.set(source, row);
      bySourceByInstrument.set(instrumentId, sourceMap);
    }

    return gameRows.map((gameRow) =>
      buildClosedGameRecord(
        gameRow,
        moneylineInstruments.filter((row) => row.gameId === gameRow.gameId),
        bySourceByInstrument
      )
    );
  });
}

function buildClosedGameRecord(
  gameRow: Row,
  instruments: Row[],
  bySourceByInstrument: Map<string, Map<string, Row>>
): ClosedGameSummary {
  const home = parseJson<Row>(gameRow.homeJson, {});
  const away = parseJson<Row>(gameRow.awayJson, {});
  const winnerKey = asString(gameRow.winnerKey);
  const finalAt = asString(gameRow.finalAt);
  const finalAtMs = finalAt ? new Date(finalAt).getTime() : null;

  const moneylineByParticipant = instruments.map((instrument) => {
    const instrumentId = String(instrument.id);
    const participantKey = asString(instrument.participantKey);
    const sourceMap = bySourceByInstrument.get(instrumentId) ?? new Map();

    const sources: SourceClosingProbability[] = Array.from(
      sourceMap.entries()
    ).map(([source, row]) => {
      const capturedAt = asString(row.capturedAt);
      const freshnessMs =
        finalAtMs != null && capturedAt != null
          ? Math.max(0, finalAtMs - new Date(capturedAt).getTime())
          : null;
      return {
        capturedAt,
        freshnessMs,
        impliedProbability: asNumber(row.impliedProbability),
        source,
      };
    });

    const winnerProbability: 0 | 1 | null =
      participantKey == null || winnerKey == null
        ? null
        : participantKey === winnerKey
          ? 1
          : 0;

    return {
      displayLabel: asString(instrument.displayLabel) ?? instrumentId,
      family: MONEYLINE_FAMILY,
      finalAt,
      gameId: String(gameRow.gameId),
      instrumentId,
      outcome: {
        winnerKey,
        winnerProbability,
      },
      participantKey,
      selection: asString(instrument.selection) ?? "",
      sources,
    } satisfies ClosedGameInstrumentSummary;
  });

  return {
    finalAt,
    finalAwayScore: asNumber(gameRow.finalAwayScore),
    finalHomeScore: asNumber(gameRow.finalHomeScore),
    gameId: String(gameRow.gameId),
    league: asString(gameRow.league) ?? "",
    matchup: matchupFromParticipants(home, away),
    moneylineByParticipant,
    scheduledStart: asString(gameRow.scheduledStart) ?? "",
    sport: asString(gameRow.sport) ?? "",
    winnerKey,
  };
}

export function getInstrumentDeltaSeries(options: {
  instrumentId: string;
  bucketSeconds?: number;
}) {
  return executeDatabaseOperation("signalQuality.deltaSeries.get", () => {
    const db = getDatabase();
    const bucketSeconds = options.bucketSeconds ?? 60;

    const rows = db
      .prepare(
        `
          SELECT
            sm.source AS source,
            q.implied_probability AS impliedProbability,
            q.captured_at AS capturedAt
          FROM source_markets sm INDEXED BY idx_source_markets_instrument_source
          JOIN quote_ticks q INDEXED BY idx_quote_ticks_source_market_captured
            ON q.source_market_id = sm.id
          WHERE sm.instrument_id = ?
            AND sm.source IN ('bet365', 'kalshi', 'polymarket')
            AND q.implied_probability IS NOT NULL
          ORDER BY q.captured_at ASC
        `
      )
      .all(options.instrumentId) as Row[];

    if (rows.length === 0) return [] as DeltaSeriesPoint[];

    const bucketRows: DeltaBucketRow[] = [];
    for (const row of rows) {
      const capturedAt = asString(row.capturedAt);
      const source = asString(row.source);
      const implied = asNumber(row.impliedProbability);
      if (!capturedAt || !source || implied == null) continue;

      bucketRows.push({
        bucketAt: bucketStartIso(capturedAt, bucketSeconds),
        impliedProbability: implied,
        source,
      });
    }

    return buildDeltaSeriesFromBucketRows(bucketRows);
  });
}

export function getInstrumentDeltaSummaries(options: {
  instrumentIds: string[];
  bucketSeconds?: number;
  threshold?: number;
}) {
  return executeDatabaseOperation("signalQuality.deltaSummaries.list", () => {
    const db = getDatabase();
    const instrumentIds = Array.from(new Set(options.instrumentIds)).filter(
      Boolean
    );
    if (instrumentIds.length === 0) {
      return new Map<string, InstrumentDivergenceSummary>();
    }

    const bucketSeconds = options.bucketSeconds ?? 60;
    const placeholders = instrumentIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `
          SELECT
            sm.instrument_id AS instrumentId,
            sm.source AS source,
            ((CAST(strftime('%s', q.captured_at) AS INTEGER) / ?) * ?) AS bucketEpoch,
            AVG(q.implied_probability) AS impliedProbability
          FROM source_markets sm INDEXED BY idx_source_markets_instrument_source
          JOIN quote_ticks q INDEXED BY idx_quote_ticks_source_market_captured
            ON q.source_market_id = sm.id
          WHERE sm.instrument_id IN (${placeholders})
            AND sm.source IN ('bet365', 'kalshi', 'polymarket')
            AND q.implied_probability IS NOT NULL
          GROUP BY sm.instrument_id, sm.source, bucketEpoch
          ORDER BY sm.instrument_id ASC, bucketEpoch ASC
        `
      )
      .all(bucketSeconds, bucketSeconds, ...instrumentIds) as Row[];

    const rowsByInstrument = new Map<string, DeltaBucketRow[]>();
    for (const row of rows) {
      const instrumentId = asString(row.instrumentId);
      const source = asString(row.source);
      const impliedProbability = asNumber(row.impliedProbability);
      const bucketEpoch = asNumber(row.bucketEpoch);
      if (
        !instrumentId ||
        !source ||
        impliedProbability == null ||
        bucketEpoch == null
      ) {
        continue;
      }

      const bucketRows = rowsByInstrument.get(instrumentId) ?? [];
      bucketRows.push({
        bucketAt: new Date(bucketEpoch * 1000).toISOString(),
        impliedProbability,
        source,
      });
      rowsByInstrument.set(instrumentId, bucketRows);
    }

    const summaries = new Map<string, InstrumentDivergenceSummary>();
    for (const [instrumentId, bucketRows] of rowsByInstrument.entries()) {
      const summary = summarizeDeltaSeries(
        buildDeltaSeriesFromBucketRows(bucketRows),
        options.threshold
      );
      if (summary) {
        summaries.set(instrumentId, summary);
      }
    }

    return summaries;
  });
}

export function getSourceLeadLagReport(options: {
  instrumentId: string;
  bucketSeconds?: number;
  maxLagBuckets?: number;
}) {
  return executeDatabaseOperation("signalQuality.leadLag.get", () => {
    const series = getInstrumentDeltaSeries({
      bucketSeconds: options.bucketSeconds ?? 60,
      instrumentId: options.instrumentId,
    });

    if (series.length < 10) {
      return {
        bucketSeconds: options.bucketSeconds ?? 60,
        insufficientData: true,
        pairs: [],
      };
    }

    const sourcesSeen = new Set<string>();
    for (const point of series) {
      for (const source of Object.keys(point.perSource))
        sourcesSeen.add(source);
    }

    const sources = Array.from(sourcesSeen);
    const maxLag = options.maxLagBuckets ?? 20;

    type SeriesMap = Record<string, Array<number | null>>;
    const seriesBySource: SeriesMap = {};
    for (const source of sources) seriesBySource[source] = [];
    for (const point of series) {
      for (const source of sources) {
        seriesBySource[source].push(point.perSource[source] ?? null);
      }
    }

    const pairs: Array<{
      pair: [string, string];
      bestLagBuckets: number;
      bestCorrelation: number;
      leadSource: string;
      lagSource: string;
      sampleCount: number;
    }> = [];

    for (let i = 0; i < sources.length; i += 1) {
      for (let j = i + 1; j < sources.length; j += 1) {
        const a = sources[i];
        const b = sources[j];
        const result = crossCorrelateBestLag(
          seriesBySource[a],
          seriesBySource[b],
          maxLag
        );
        if (result == null) continue;

        const lead =
          result.bestLagBuckets === 0 ? a : result.bestLagBuckets > 0 ? a : b;
        const lag =
          result.bestLagBuckets === 0 ? b : result.bestLagBuckets > 0 ? b : a;

        pairs.push({
          bestCorrelation: result.bestCorrelation,
          bestLagBuckets: Math.abs(result.bestLagBuckets),
          lagSource: lag,
          leadSource: lead,
          pair: [a, b],
          sampleCount: result.sampleCount,
        });
      }
    }

    return {
      bucketSeconds: options.bucketSeconds ?? 60,
      insufficientData: false,
      pairs,
    };
  });
}

export type LeadLagSeries = {
  bucketSeconds: number;
  insufficientData: boolean;
  primaryPair: [string, string] | null;
  overall: {
    bestLagBuckets: number;
    bestCorrelation: number;
    leadSource: string;
    lagSource: string;
    sampleCount: number;
  } | null;
  offsetSeries: Array<{
    bucketAt: string;
    lagBuckets: number | null;
    correlation: number | null;
  }>;
  offsetHistogram: Array<{ lagBuckets: number; count: number }>;
};

export function getLeadLagSeries(options: {
  instrumentId: string;
  bucketSeconds?: number;
  windowBuckets?: number;
  maxLagBuckets?: number;
}): LeadLagSeries {
  return executeDatabaseOperation("signalQuality.leadLagSeries.get", () => {
    const bucketSeconds = options.bucketSeconds ?? 60;
    const windowBuckets = Math.max(8, options.windowBuckets ?? 10);
    const maxLagBuckets = options.maxLagBuckets ?? 20;

    const series = getInstrumentDeltaSeries({
      bucketSeconds,
      instrumentId: options.instrumentId,
    });

    if (series.length < windowBuckets + maxLagBuckets) {
      return {
        bucketSeconds,
        insufficientData: true,
        offsetHistogram: [],
        offsetSeries: [],
        overall: null,
        primaryPair: null,
      };
    }

    const sourcesSeen = new Set<string>();
    for (const point of series) {
      for (const source of Object.keys(point.perSource))
        sourcesSeen.add(source);
    }
    const sources = Array.from(sourcesSeen);
    if (sources.length < 2) {
      return {
        bucketSeconds,
        insufficientData: true,
        offsetHistogram: [],
        offsetSeries: [],
        overall: null,
        primaryPair: null,
      };
    }

    type SeriesMap = Record<string, Array<number | null>>;
    const seriesBySource: SeriesMap = {};
    for (const source of sources) seriesBySource[source] = [];
    for (const point of series) {
      for (const source of sources) {
        seriesBySource[source].push(point.perSource[source] ?? null);
      }
    }

    // Pick the pair with the highest overall correlation, preferring a
    // bet365-anchored pair when available because that is the book side.
    const candidatePairs: Array<[string, string]> = [];
    const anchor = sources.includes("bet365") ? "bet365" : sources[0];
    for (const other of sources) {
      if (other === anchor) continue;
      candidatePairs.push([anchor, other]);
    }

    let bestPair: [string, string] | null = null;
    let bestOverallCorr = -Infinity;
    let bestOverallLag = 0;
    let bestOverallSample = 0;
    for (const [a, b] of candidatePairs) {
      const res = crossCorrelateBestLag(
        seriesBySource[a],
        seriesBySource[b],
        maxLagBuckets
      );
      if (res == null) continue;
      if (res.bestCorrelation > bestOverallCorr) {
        bestOverallCorr = res.bestCorrelation;
        bestOverallLag = res.bestLagBuckets;
        bestOverallSample = res.sampleCount;
        bestPair = [a, b];
      }
    }

    if (!bestPair || !Number.isFinite(bestOverallCorr)) {
      return {
        bucketSeconds,
        insufficientData: true,
        offsetHistogram: [],
        offsetSeries: [],
        overall: null,
        primaryPair: null,
      };
    }

    const [a, b] = bestPair;
    const leadSource = bestOverallLag === 0 ? a : bestOverallLag > 0 ? a : b;
    const lagSource = bestOverallLag === 0 ? b : bestOverallLag > 0 ? b : a;

    const overall = {
      bestCorrelation: bestOverallCorr,
      bestLagBuckets: Math.abs(bestOverallLag),
      lagSource,
      leadSource,
      sampleCount: bestOverallSample,
    };

    // Rolling best-lag over windows.
    const offsetSeries: LeadLagSeries["offsetSeries"] = [];
    for (let end = windowBuckets; end <= series.length; end += 1) {
      const start = end - windowBuckets;
      const windowA = seriesBySource[a].slice(start, end);
      const windowB = seriesBySource[b].slice(start, end);
      const res = crossCorrelateBestLag(windowA, windowB, maxLagBuckets);
      const bucketAt = series[end - 1].bucketAt;
      if (res == null) {
        offsetSeries.push({ bucketAt, correlation: null, lagBuckets: null });
      } else {
        offsetSeries.push({
          bucketAt,
          correlation: res.bestCorrelation,
          lagBuckets: res.bestLagBuckets,
        });
      }
    }

    const hist = new Map<number, number>();
    for (const pt of offsetSeries) {
      if (pt.lagBuckets == null) continue;
      hist.set(pt.lagBuckets, (hist.get(pt.lagBuckets) ?? 0) + 1);
    }
    const offsetHistogram = Array.from(hist.entries())
      .map(([lagBuckets, count]) => ({ count, lagBuckets }))
      .sort((x, y) => x.lagBuckets - y.lagBuckets);

    return {
      bucketSeconds,
      insufficientData: false,
      offsetHistogram,
      offsetSeries,
      overall,
      primaryPair: bestPair,
    };
  });
}

function crossCorrelateBestLag(
  seriesA: Array<number | null>,
  seriesB: Array<number | null>,
  maxLag: number
) {
  if (seriesA.length !== seriesB.length) return null;
  const length = seriesA.length;
  if (length < 10) return null;

  let bestLagBuckets = 0;
  let bestCorrelation = -Infinity;
  let bestSampleCount = 0;

  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const aligned: Array<[number, number]> = [];
    for (let t = 0; t < length; t += 1) {
      const otherIndex = t + lag;
      if (otherIndex < 0 || otherIndex >= length) continue;
      const a = seriesA[t];
      const b = seriesB[otherIndex];
      if (a == null || b == null) continue;
      aligned.push([a, b]);
    }
    if (aligned.length < 10) continue;
    const corr = pearsonCorrelation(aligned);
    if (corr != null && corr > bestCorrelation) {
      bestCorrelation = corr;
      bestLagBuckets = lag;
      bestSampleCount = aligned.length;
    }
  }

  if (!Number.isFinite(bestCorrelation) || bestCorrelation === -Infinity) {
    return null;
  }

  return {
    bestCorrelation,
    bestLagBuckets,
    sampleCount: bestSampleCount,
  };
}

function pearsonCorrelation(pairs: Array<[number, number]>) {
  const n = pairs.length;
  if (n < 2) return null;
  let sumA = 0;
  let sumB = 0;
  for (const [a, b] of pairs) {
    sumA += a;
    sumB += b;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0;
  let denomA = 0;
  let denomB = 0;
  for (const [a, b] of pairs) {
    const da = a - meanA;
    const db = b - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (denomA === 0 || denomB === 0) return null;
  return num / Math.sqrt(denomA * denomB);
}

export function getSignalQualityReport(options?: {
  closingCutoff?: ClosingCutoff;
  league?: string;
  since?: string;
  until?: string;
}) {
  return executeDatabaseOperation("signalQuality.report.get", () => {
    const closedGames = listClosedGameSummaries({
      closingCutoff: options?.closingCutoff,
      league: options?.league,
      limit: 5000,
      since: options?.since,
      until: options?.until,
    });

    type Accumulator = {
      sampleCount: number;
      brierSum: number;
      logLossSum: number;
      closingWinnerCorrect: number;
      closingWinnerTotal: number;
      sumX: number;
      sumY: number;
      sumXX: number;
      sumXY: number;
    };
    const bySource = new Map<string, Accumulator>();

    for (const game of closedGames) {
      for (const instrument of game.moneylineByParticipant) {
        const actual = instrument.outcome.winnerProbability;
        if (actual == null) continue;
        for (const source of instrument.sources) {
          const implied = clampProbability(source.impliedProbability);
          if (implied == null) continue;
          const acc = bySource.get(source.source) ?? {
            brierSum: 0,
            closingWinnerCorrect: 0,
            closingWinnerTotal: 0,
            logLossSum: 0,
            sampleCount: 0,
            sumX: 0,
            sumY: 0,
            sumXX: 0,
            sumXY: 0,
          };
          const diff = implied - actual;
          acc.brierSum += diff * diff;
          acc.logLossSum -=
            actual * Math.log(implied) + (1 - actual) * Math.log(1 - implied);
          acc.sampleCount += 1;
          const predictedWinner = implied >= 0.5 ? 1 : 0;
          if (predictedWinner === actual) acc.closingWinnerCorrect += 1;
          acc.closingWinnerTotal += 1;
          // OLS regression of actual outcome (0/1) on predicted probability.
          acc.sumX += implied;
          acc.sumY += actual;
          acc.sumXX += implied * implied;
          acc.sumXY += implied * actual;
          bySource.set(source.source, acc);
        }
      }
    }

    const perSource = Array.from(bySource.entries()).map(([source, acc]) => {
      let calibrationSlope: number | null = null;
      let calibrationIntercept: number | null = null;
      if (acc.sampleCount >= 10) {
        const n = acc.sampleCount;
        const denom = n * acc.sumXX - acc.sumX * acc.sumX;
        if (Math.abs(denom) > 1e-9) {
          calibrationSlope = (n * acc.sumXY - acc.sumX * acc.sumY) / denom;
          calibrationIntercept = (acc.sumY - calibrationSlope * acc.sumX) / n;
        }
      }
      return {
        brier: acc.sampleCount > 0 ? acc.brierSum / acc.sampleCount : null,
        calibrationIntercept,
        calibrationSlope,
        closingWinnerAccuracy:
          acc.closingWinnerTotal > 0
            ? acc.closingWinnerCorrect / acc.closingWinnerTotal
            : null,
        logLoss: acc.sampleCount > 0 ? acc.logLossSum / acc.sampleCount : null,
        sampleCount: acc.sampleCount,
        source,
      };
    });

    const sampleCount = perSource.reduce(
      (sum, entry) => sum + entry.sampleCount,
      0
    );

    return {
      perSource,
      sampleCount,
    } satisfies SignalQualityReport;
  });
}
