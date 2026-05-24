import type {
  BoardVolatilityBaselineSource,
  BoardVolatilityPhaseKind,
} from "@signal-console/domain";

import {
  buildBoardVolatilityFeatureSnapshot,
  buildBoardVolatilityBaselineLookupInput,
} from "./board-anomaly/board-volatility-model";
import { deriveBoardVolatilityPhase } from "./board-anomaly/board-volatility-phase";
import { resolveBoardAnomalyConfig } from "./board-anomaly/config";
import { computeH0Adjustment } from "./board-anomaly/h0";
import { scoreObservation } from "./board-anomaly/residual";
import { materializeBoardObservations } from "./board-anomaly-observations";
import { parseTimestampMs } from "./board-anomaly-support";
import {
  executeDatabaseOperation,
  getDatabase,
  currentTimestamp,
} from "./db-core";

export type BoardVolatilityBaselineExpectedRange = {
  p50: number;
  p75: number;
  p90: number;
  p99: number;
};

export type BoardVolatilityBaselineResolved = {
  cohortKey: string;
  coreFamilyBucket: string;
  expectedRange: BoardVolatilityBaselineExpectedRange;
  marginBucket: string;
  periodBucket: string;
  phaseKind: BoardVolatilityPhaseKind;
  sampleSize: number;
  secondsFromTipBucket: string;
  source: BoardVolatilityBaselineSource;
  sourceBucket: string;
};

export type BoardVolatilityBaselineLookupInput = {
  coreFamilyCount: number;
  margin: number | null;
  period: number | null;
  phaseKind: BoardVolatilityPhaseKind;
  secondsFromTip: number | null;
  sourceCount: number;
};

type CohortAccumulator = {
  coreFamilyBucket: string;
  marginBucket: string;
  periodBucket: string;
  phaseKind: BoardVolatilityPhaseKind;
  scores: number[];
  secondsFromTipBucket: string;
  sourceBucket: string;
};

const FALLBACK_BASELINES: Record<
  BoardVolatilityPhaseKind,
  BoardVolatilityBaselineExpectedRange
> = {
  pregame: { p50: 0.08, p75: 0.15, p90: 0.25, p99: 0.4 },
  "near-tip": { p50: 0.18, p75: 0.28, p90: 0.42, p99: 0.62 },
  "tip-burst": { p50: 0.28, p75: 0.4, p90: 0.56, p99: 0.76 },
  "settled-live": { p50: 0.1, p75: 0.18, p90: 0.3, p99: 0.48 },
  "restart-burst": { p50: 0.22, p75: 0.34, p90: 0.5, p99: 0.72 },
  "crunch-time": { p50: 0.16, p75: 0.24, p90: 0.36, p99: 0.54 },
  "final-minute": { p50: 0.2, p75: 0.32, p90: 0.46, p99: 0.68 },
  final: { p50: 0.12, p75: 0.2, p90: 0.32, p99: 0.5 },
};

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? 0;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function bucketPeriod(period: number | null) {
  if (period == null) return "p-unknown";
  if (period <= 1) return "p1";
  if (period === 2) return "p2";
  if (period === 3) return "p3";
  if (period === 4) return "p4";
  return "ot";
}

function bucketSecondsFromTip(secondsFromTip: number | null) {
  if (secondsFromTip == null) return "tip-unknown";
  if (secondsFromTip < -30 * 60) return "tip-gt-30m-pre";
  if (secondsFromTip < -5 * 60) return "tip-5m-30m-pre";
  if (secondsFromTip < 0) return "tip-near";
  if (secondsFromTip <= 90) return "tip-0-90s";
  if (secondsFromTip <= 10 * 60) return "tip-90s-10m";
  if (secondsFromTip <= 60 * 60) return "tip-10m-60m";
  return "tip-gt-60m";
}

function bucketMargin(margin: number | null) {
  if (margin == null || !Number.isFinite(margin)) return "margin-unknown";
  if (margin <= 3) return "margin-0-3";
  if (margin <= 8) return "margin-4-8";
  if (margin <= 15) return "margin-9-15";
  return "margin-16-plus";
}

function bucketSourceCount(sourceCount: number) {
  if (sourceCount <= 0) return "src-0";
  if (sourceCount === 1) return "src-1";
  if (sourceCount === 2) return "src-2";
  return "src-3plus";
}

function bucketCoreFamilyCount(coreFamilyCount: number) {
  if (coreFamilyCount <= 0) return "core-0";
  if (coreFamilyCount === 1) return "core-1";
  if (coreFamilyCount === 2) return "core-2";
  if (coreFamilyCount === 3) return "core-3";
  return "core-4plus";
}

function buildCohortKey(input: BoardVolatilityBaselineLookupInput) {
  const periodBucket = bucketPeriod(input.period);
  const secondsFromTipBucket = bucketSecondsFromTip(input.secondsFromTip);
  const marginBucket = bucketMargin(input.margin);
  const sourceBucket = bucketSourceCount(input.sourceCount);
  const coreFamilyBucket = bucketCoreFamilyCount(input.coreFamilyCount);
  return {
    cohortKey: [
      input.phaseKind,
      periodBucket,
      secondsFromTipBucket,
      marginBucket,
      sourceBucket,
      coreFamilyBucket,
    ].join("|"),
    coreFamilyBucket,
    marginBucket,
    periodBucket,
    secondsFromTipBucket,
    sourceBucket,
  };
}

export function resolveFallbackBoardVolatilityBaseline(
  input: BoardVolatilityBaselineLookupInput
): BoardVolatilityBaselineResolved {
  const buckets = buildCohortKey(input);
  return {
    cohortKey: buckets.cohortKey,
    coreFamilyBucket: buckets.coreFamilyBucket,
    expectedRange: FALLBACK_BASELINES[input.phaseKind],
    marginBucket: buckets.marginBucket,
    periodBucket: buckets.periodBucket,
    phaseKind: input.phaseKind,
    sampleSize: 0,
    secondsFromTipBucket: buckets.secondsFromTipBucket,
    source: "fallback",
    sourceBucket: buckets.sourceBucket,
  };
}

function queryBaselineRow(
  db: ReturnType<typeof getDatabase>,
  version: string,
  input: BoardVolatilityBaselineLookupInput,
  mode: "exact" | "phase-source-core" | "phase-only"
) {
  const buckets = buildCohortKey(input);
  if (mode === "exact") {
    return db
      .prepare(
        `SELECT * FROM board_volatility_baselines
         WHERE baseline_version = ?
           AND phase_kind = ?
           AND period_bucket = ?
           AND seconds_from_tip_bucket = ?
           AND margin_bucket = ?
           AND source_bucket = ?
           AND core_family_bucket = ?`
      )
      .get(
        version,
        input.phaseKind,
        buckets.periodBucket,
        buckets.secondsFromTipBucket,
        buckets.marginBucket,
        buckets.sourceBucket,
        buckets.coreFamilyBucket
      ) as Record<string, unknown> | undefined;
  }
  if (mode === "phase-source-core") {
    return db
      .prepare(
        `SELECT * FROM board_volatility_baselines
         WHERE baseline_version = ?
           AND phase_kind = ?
           AND source_bucket = ?
           AND core_family_bucket = ?
         ORDER BY sample_size DESC
         LIMIT 1`
      )
      .get(
        version,
        input.phaseKind,
        buckets.sourceBucket,
        buckets.coreFamilyBucket
      ) as Record<string, unknown> | undefined;
  }
  return db
    .prepare(
      `SELECT * FROM board_volatility_baselines
       WHERE baseline_version = ?
         AND phase_kind = ?
       ORDER BY sample_size DESC
       LIMIT 1`
    )
    .get(version, input.phaseKind) as Record<string, unknown> | undefined;
}

export function getLatestBoardVolatilityBaselineVersion() {
  return executeDatabaseOperation(
    "boardVolatilityBaselines.latestVersion",
    () => {
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT baseline_version AS baselineVersion
         FROM board_volatility_baselines
         ORDER BY updated_at DESC, baseline_version DESC
         LIMIT 1`
        )
        .get() as { baselineVersion: string } | undefined;
      return row?.baselineVersion ?? null;
    }
  );
}

export function resolveBoardVolatilityBaseline(
  input: BoardVolatilityBaselineLookupInput
): BoardVolatilityBaselineResolved {
  return executeDatabaseOperation(
    "boardVolatilityBaselines.resolve",
    () => {
      let version = getLatestBoardVolatilityBaselineVersion();
      if (!version) {
        rebuildBoardVolatilityBaselines();
        version = getLatestBoardVolatilityBaselineVersion();
      }
      if (!version) {
        return resolveFallbackBoardVolatilityBaseline(input);
      }

      const db = getDatabase();
      const row =
        queryBaselineRow(db, version, input, "exact") ??
        queryBaselineRow(db, version, input, "phase-source-core") ??
        queryBaselineRow(db, version, input, "phase-only");

      if (!row) {
        return resolveFallbackBoardVolatilityBaseline(input);
      }

      return {
        cohortKey: String(row.cohort_key),
        coreFamilyBucket: String(row.core_family_bucket),
        expectedRange: {
          p50: Number(row.p50),
          p75: Number(row.p75),
          p90: Number(row.p90),
          p99: Number(row.p99),
        },
        marginBucket: String(row.margin_bucket),
        periodBucket: String(row.period_bucket),
        phaseKind: String(row.phase_kind) as BoardVolatilityPhaseKind,
        sampleSize: Number(row.sample_size),
        secondsFromTipBucket: String(row.seconds_from_tip_bucket),
        source: "calibrated",
        sourceBucket: String(row.source_bucket),
      };
    },
    input
  );
}

export function rebuildBoardVolatilityBaselines() {
  return executeDatabaseOperation("boardVolatilityBaselines.rebuild", () => {
    const db = getDatabase();
    const config = resolveBoardAnomalyConfig();
    const baselineVersion = currentTimestamp();
    const nowIso = currentTimestamp();
    const games = db
      .prepare(
        `SELECT DISTINCT id, scheduled_start AS scheduledStart
         FROM games
         WHERE league = 'NBA'
         ORDER BY scheduled_start ASC`
      )
      .all() as Array<{ id: string; scheduledStart: string }>;

    const cohorts = new Map<string, CohortAccumulator>();

    for (const game of games) {
      const range = db
        .prepare(
          `SELECT
             MIN(observed_at) AS minObservedAt,
             MAX(observed_at) AS maxObservedAt
           FROM (
             SELECT qt.captured_at AS observed_at
             FROM quote_ticks qt
             JOIN source_markets sm ON sm.id = qt.source_market_id
             WHERE sm.game_id = ?
               AND qt.is_heartbeat = 0
             UNION ALL
             SELECT mme.event_timestamp AS observed_at
             FROM market_microstructure_events mme
             WHERE mme.game_id = ?
           )`
        )
        .get(game.id, game.id) as
        | { maxObservedAt: string | null; minObservedAt: string | null }
        | undefined;

      if (!range?.minObservedAt || !range.maxObservedAt) continue;
      const minMs = parseTimestampMs(range.minObservedAt);
      const maxMs = parseTimestampMs(range.maxObservedAt);
      if (minMs == null || maxMs == null || maxMs <= minMs) continue;

      const materialized = materializeBoardObservations({
        gameId: game.id,
        windowStart: new Date(minMs - 30 * 60_000).toISOString(),
        windowEnd: new Date(maxMs).toISOString(),
      });
      if (!materialized || materialized.observations.length < 4) continue;

      const scoredRows = materialized.observations
        .map((observation) =>
          scoreObservation(
            observation,
            computeH0Adjustment(observation, config),
            config
          )
        )
        .sort(
          (left, right) =>
            (parseTimestampMs(left.observation.eventTimestamp) ??
              parseTimestampMs(left.observation.capturedAt) ??
              0) -
            (parseTimestampMs(right.observation.eventTimestamp) ??
              parseTimestampMs(right.observation.capturedAt) ??
              0)
        );

      const bucketMs = 15_000;
      for (let clockMs = minMs; clockMs <= maxMs; clockMs += bucketMs) {
        const rows = scoredRows.filter((observation) => {
          const ts =
            parseTimestampMs(observation.observation.eventTimestamp) ??
            parseTimestampMs(observation.observation.capturedAt);
          return ts != null && ts <= clockMs && ts >= clockMs - 60_000;
        });
        if (rows.length < 3) continue;

        const latest = rows[rows.length - 1]?.observation;
        if (!latest) continue;
        const phase = deriveBoardVolatilityPhase({
          clock: latest.gameState.clock,
          minutesToTip: latest.gameState.minutesToTip,
          nowIso: new Date(clockMs).toISOString(),
          period: latest.gameState.period,
          scheduledStart: materialized.scheduledStart,
          scoreMargin: latest.gameState.scoreMargin,
          status: latest.gameState.status ?? "scheduled",
          timeline: materialized.gameStates,
        });
        const transitionBoost =
          phase.kind === "tip-burst" || phase.kind === "restart-burst"
            ? 0.1
            : 0;
        const snapshot = buildBoardVolatilityFeatureSnapshot({
          baseline: resolveFallbackBoardVolatilityBaseline(
            buildBoardVolatilityBaselineLookupInput({
              coreFamilyCount: 0,
              margin: latest.gameState.scoreMargin ?? null,
              period: latest.gameState.period ?? null,
              phaseKind: phase.kind,
              secondsFromTip: phase.secondsFromTip,
              sourceCount: 0,
            })
          ),
          config,
          persistenceSeconds: 0,
          phaseKind: phase.kind,
          scored: rows,
          shockWindowMs: config.shockWindowSeconds * 1000,
          topEvidenceRows: config.gameStateVolatility.topEvidenceRows,
          transitionBoost,
        });
        if (
          snapshot.predictionMarketRows <
            config.gameStateVolatility.minPredictionMarketRows ||
          snapshot.coreFamilies.length === 0 ||
          snapshot.distinctCoreSources.length === 0
        ) {
          continue;
        }
        const buckets = buildCohortKey({
          coreFamilyCount: snapshot.coreFamilies.length,
          margin: latest.gameState.scoreMargin ?? null,
          period: latest.gameState.period ?? null,
          phaseKind: phase.kind,
          secondsFromTip: phase.secondsFromTip,
          sourceCount: snapshot.distinctCoreSources.length,
        });
        const existing = cohorts.get(buckets.cohortKey) ?? {
          coreFamilyBucket: buckets.coreFamilyBucket,
          marginBucket: buckets.marginBucket,
          periodBucket: buckets.periodBucket,
          phaseKind: phase.kind,
          scores: [],
          secondsFromTipBucket: buckets.secondsFromTipBucket,
          sourceBucket: buckets.sourceBucket,
        };
        existing.scores.push(snapshot.rawScore);
        cohorts.set(buckets.cohortKey, existing);
      }
    }

    db.transaction(() => {
      db.prepare("DELETE FROM board_volatility_baselines").run();
      const insert = db.prepare(
        `INSERT INTO board_volatility_baselines (
           baseline_version,
           phase_kind,
           period_bucket,
           seconds_from_tip_bucket,
           margin_bucket,
           source_bucket,
           core_family_bucket,
           cohort_key,
           sample_size,
           p50,
           p75,
           p90,
           p99,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const [cohortKey, cohort] of cohorts.entries()) {
        const sorted = cohort.scores
          .slice()
          .sort((left, right) => left - right);
        if (sorted.length === 0) continue;
        insert.run(
          baselineVersion,
          cohort.phaseKind,
          cohort.periodBucket,
          cohort.secondsFromTipBucket,
          cohort.marginBucket,
          cohort.sourceBucket,
          cohort.coreFamilyBucket,
          cohortKey,
          sorted.length,
          quantile(sorted, 0.5),
          quantile(sorted, 0.75),
          quantile(sorted, 0.9),
          quantile(sorted, 0.99),
          nowIso
        );
      }
    })();

    return {
      baselineVersion,
      cohortCount: cohorts.size,
      updatedAt: nowIso,
    };
  });
}
