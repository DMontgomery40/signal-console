import { prebucket } from "@signal-console/detectors/board-mad/prebucket";
import type { ParamsResolved } from "@signal-console/detectors/board-mad";
import {
  weightedMad,
  weightedMedian,
  type WeightedSample,
} from "@signal-console/detectors/board-mad/weighted-stats";
import type { BoardMadHistoricalPrior, Tick } from "@signal-console/detectors";
import type Database from "better-sqlite3";

type GoldDbHandle = Database.Database;

export interface InPlayBound {
  readonly start: string;
  readonly end: string;
}

interface GameRow {
  readonly id: string;
  readonly scheduledStart: string;
  readonly homeKey: string | null;
  readonly awayKey: string | null;
}

// Raw per-side prior samples. AMENDED 2026-05-25 (audit-fix #4, phase A3):
// per Codex review, the historical-prior combine step now uses weighted
// median/MAD on the raw pooled samples instead of linear-averaging the two
// side medians/MADs (statistically meaningless on nonlinear estimators).
// buildSidePrior returns the raw values + sampleSize so combineSidePriors
// can assign each sample the right per-side weight before computing the
// pooled estimators.
interface SidePriorSamples {
  readonly values: readonly number[];
  readonly sampleSize: number;
}

export function parseNbaClockSecondsRemaining(clock: string | null | undefined): number | null {
  if (clock == null || clock.trim() === "") return null;
  const iso = /^PT(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(clock.trim());
  if (iso !== null) {
    const minutes = Number.parseFloat(iso[1] ?? "0");
    const seconds = Number.parseFloat(iso[2] ?? "0");
    const total = minutes * 60 + seconds;
    return Number.isFinite(total) ? total : null;
  }
  const mmss = /^(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(clock.trim());
  if (mmss !== null) {
    const minutes = Number.parseInt(mmss[1] ?? "0", 10);
    const seconds = Number.parseInt(mmss[2] ?? "0", 10);
    const total = minutes * 60 + seconds;
    return Number.isFinite(total) ? total : null;
  }
  return null;
}

export function nbaGameElapsedSeconds(
  period: number | null | undefined,
  clock: string | null | undefined,
): number | null {
  if (!Number.isFinite(period) || period == null || period < 1) return null;
  const remaining = parseNbaClockSecondsRemaining(clock);
  if (remaining === null) return null;
  const completedRegulationPeriods = Math.min(period - 1, 4);
  const completedOvertimePeriods = Math.max(0, period - 5);
  const currentPeriodLength = period <= 4 ? 12 * 60 : 5 * 60;
  return (
    completedRegulationPeriods * 12 * 60 +
    completedOvertimePeriods * 5 * 60 +
    Math.max(0, currentPeriodLength - remaining)
  );
}

export function loadBoardMadTicksForGame(
  goldDb: GoldDbHandle,
  gameId: string,
  start: string,
  end: string,
): readonly Tick[] {
  const clockColumns = pbpHasGameClockColumns(goldDb);
  const rows = goldDb
    .prepare(
      clockColumns
        ? `SELECT sm.game_id AS game_id,
                  qt.source_market_id AS source_market_id,
                  qt.captured_at AS captured_at,
                  qt.implied_probability AS implied_probability,
                  COALESCE(qt.volume, 0) AS volume,
                  qt.is_heartbeat AS is_heartbeat,
                  (
                    SELECT pbp.period
                    FROM nba_play_by_play_actions pbp
                    WHERE pbp.game_id = sm.game_id
                      AND pbp.time_actual <= qt.captured_at
                      AND pbp.period IS NOT NULL
                      AND pbp.clock IS NOT NULL
                    ORDER BY pbp.time_actual DESC
                    LIMIT 1
                  ) AS game_period,
                  (
                    SELECT pbp.clock
                    FROM nba_play_by_play_actions pbp
                    WHERE pbp.game_id = sm.game_id
                      AND pbp.time_actual <= qt.captured_at
                      AND pbp.period IS NOT NULL
                      AND pbp.clock IS NOT NULL
                    ORDER BY pbp.time_actual DESC
                    LIMIT 1
                  ) AS game_clock
           FROM quote_ticks qt
           JOIN source_markets sm ON sm.id = qt.source_market_id
           WHERE sm.game_id = ?
             AND qt.captured_at >= ?
             AND qt.captured_at <= ?
           ORDER BY qt.source_market_id, qt.captured_at`
        : `SELECT sm.game_id AS game_id,
                  qt.source_market_id AS source_market_id,
                  qt.captured_at AS captured_at,
                  qt.implied_probability AS implied_probability,
                  COALESCE(qt.volume, 0) AS volume,
                  qt.is_heartbeat AS is_heartbeat,
                  NULL AS game_period,
                  NULL AS game_clock
           FROM quote_ticks qt
           JOIN source_markets sm ON sm.id = qt.source_market_id
           WHERE sm.game_id = ?
             AND qt.captured_at >= ?
             AND qt.captured_at <= ?
           ORDER BY qt.source_market_id, qt.captured_at`,
    )
    .all(gameId, start, end);
  return rows.map(rowToTick);
}

export function buildBoardMadHistoricalPriors(
  goldDb: GoldDbHandle,
  gameIds: readonly string[],
  params: Pick<
    ParamsResolved,
    | "bucketSeconds"
    | "freshCapSeconds"
    | "historicalAwayWeight"
    | "historicalLastGames"
    | "openingBaselineBuckets"
    | "weighting"
  >,
): readonly BoardMadHistoricalPrior[] {
  if (gameIds.length === 0) return [];
  const games = loadNbaGames(goldDb);
  const byId = new Map(games.map((game) => [game.id, game]));
  return gameIds.flatMap((gameId): readonly BoardMadHistoricalPrior[] => {
    const target = byId.get(gameId);
    if (target === undefined) return [];
    const awayPrior = buildSidePrior(goldDb, games, target, "away", params);
    const homePrior = buildSidePrior(goldDb, games, target, "home", params);
    const combined = combineSidePriors(awayPrior, homePrior, params.historicalAwayWeight);
    return combined === null
      ? []
      : [{ gameId, median: combined.median, mad: combined.mad, sampleSize: combined.sampleSize }];
  });
}

function buildSidePrior(
  goldDb: GoldDbHandle,
  games: readonly GameRow[],
  target: GameRow,
  side: "away" | "home",
  params: Pick<
    ParamsResolved,
    | "bucketSeconds"
    | "freshCapSeconds"
    | "historicalLastGames"
    | "openingBaselineBuckets"
    | "weighting"
  >,
): SidePriorSamples | null {
  const teamKey = side === "away" ? target.awayKey : target.homeKey;
  if (teamKey === null) return null;
  const previousGames = games
    .filter((game) => {
      if (game.id === target.id || game.scheduledStart >= target.scheduledStart) return false;
      return side === "away" ? game.awayKey === teamKey : game.homeKey === teamKey;
    })
    .toSorted((a, b) => (a.scheduledStart > b.scheduledStart ? -1 : 1))
    .slice(0, Math.max(1, Math.round(params.historicalLastGames)));

  const values = previousGames.flatMap((game): readonly number[] => {
    const bound = readPbpBounds(goldDb, game.id);
    if (bound === null) return [];
    const ticks = loadBoardMadTicksForGame(goldDb, game.id, bound.start, bound.end);
    const series = prebucket(ticks, params.bucketSeconds, {
      freshCapSeconds: params.freshCapSeconds,
      gameIds: [game.id],
      weighting: params.weighting,
    });
    return (
      series.perGame[0]?.buckets
        .slice(0, Math.max(1, Math.round(params.openingBaselineBuckets)))
        .map((bucket) => bucket.intensity) ?? []
    );
  });
  if (values.length === 0) return null;
  return { values, sampleSize: values.length };
}

// AMENDED 2026-05-25 (audit-fix #4, phase A3): weighted median/MAD on raw
// pooled samples. Per-sample weight = side_weight / side_sample_count so
// each side contributes its full configured weight regardless of how many
// underlying samples it produced. Plain concat would let the larger side
// dominate silently (breaks David's 50/50 intent); linear-averaging the two
// side medians/MADs (the old behavior) is statistically meaningless on
// nonlinear estimators; sample repetition would bias MAD by inflating ties.
// See packages/detectors/src/board-mad/weighted-stats.ts for the median spec
// + tie convention.
export function combineSidePriors(
  away: SidePriorSamples | null,
  home: SidePriorSamples | null,
  awayWeightRaw: number,
): { readonly median: number; readonly mad: number; readonly sampleSize: number } | null {
  if (away === null && home === null) return null;
  const awayWeight = Math.min(1, Math.max(0, awayWeightRaw));
  const homeWeight = 1 - awayWeight;
  const weighted: WeightedSample[] = [];
  if (away !== null && away.values.length > 0 && awayWeight > 0) {
    const perSample = awayWeight / away.values.length;
    for (const value of away.values) weighted.push({ value, weight: perSample });
  }
  if (home !== null && home.values.length > 0 && homeWeight > 0) {
    const perSample = homeWeight / home.values.length;
    for (const value of home.values) weighted.push({ value, weight: perSample });
  }
  if (weighted.length === 0) {
    // Degenerate: both sides exist but one carries all the weight and that
    // side has no values. Fall back to the present side's raw median/MAD
    // (no weighting needed when only one side contributes).
    const fallback = away ?? home;
    if (fallback === null || fallback.values.length === 0) return null;
    const equal: WeightedSample[] = fallback.values.map((value) => ({ value, weight: 1 }));
    return {
      median: weightedMedian(equal),
      mad: weightedMad(equal),
      sampleSize: fallback.sampleSize,
    };
  }
  const totalSampleSize = (away?.sampleSize ?? 0) + (home?.sampleSize ?? 0);
  return {
    median: weightedMedian(weighted),
    mad: weightedMad(weighted),
    sampleSize: totalSampleSize,
  };
}

function readPbpBounds(goldDb: GoldDbHandle, gameId: string): InPlayBound | null {
  let row: unknown;
  try {
    row = goldDb
      .prepare(
        `SELECT MIN(time_actual) AS lo, MAX(time_actual) AS hi
         FROM nba_play_by_play_actions
         WHERE game_id = ?`,
      )
      .get(gameId);
  } catch {
    return null;
  }
  if (!isRecord(row)) return null;
  const lo = row["lo"];
  const hi = row["hi"];
  if (typeof lo !== "string" || typeof hi !== "string") return null;
  if (!Number.isFinite(Date.parse(lo)) || !Number.isFinite(Date.parse(hi))) return null;
  return { start: lo, end: hi };
}

function loadNbaGames(goldDb: GoldDbHandle): readonly GameRow[] {
  const rows = goldDb
    .prepare(
      `SELECT id,
              scheduled_start,
              home_participant_json,
              away_participant_json
       FROM games
       WHERE sport = 'NBA'
       ORDER BY scheduled_start ASC`,
    )
    .all();
  return rows.flatMap((row): readonly GameRow[] => {
    if (!isRecord(row)) return [];
    return [
      {
        id: pickString(row, "id"),
        scheduledStart: pickString(row, "scheduled_start"),
        homeKey: participantKey(row["home_participant_json"]),
        awayKey: participantKey(row["away_participant_json"]),
      },
    ];
  });
}

function participantKey(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  if (typeof parsed === "string") return normalizeKey(parsed);
  if (!isRecord(parsed)) return null;
  for (const key of ["key", "abbreviation", "shortName", "name"]) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim() !== "") {
      return normalizeKey(value);
    }
  }
  return null;
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pbpHasGameClockColumns(goldDb: GoldDbHandle): boolean {
  try {
    const rows = goldDb.prepare("PRAGMA table_info(nba_play_by_play_actions)").all();
    const names = new Set(
      rows.flatMap((row): readonly string[] => {
        if (!isRecord(row)) return [];
        const name = row["name"];
        return typeof name === "string" ? [name] : [];
      }),
    );
    return names.has("period") && names.has("clock");
  } catch {
    return false;
  }
}

function rowToTick(row: unknown): Tick {
  if (!isRecord(row)) throw new Error("tick row not an object");
  const ip = row["implied_probability"];
  const period = row["game_period"];
  return {
    gameId: pickString(row, "game_id"),
    sourceMarketId: pickString(row, "source_market_id"),
    capturedAt: new Date(pickString(row, "captured_at")),
    impliedProbability: ip === null ? null : typeof ip === "number" ? ip : null,
    volume: pickNumber(row, "volume"),
    isHeartbeat: pickNumber(row, "is_heartbeat") === 1,
    gameElapsedSeconds: nbaGameElapsedSeconds(
      typeof period === "number" ? period : null,
      typeof row["game_clock"] === "string" ? row["game_clock"] : null,
    ),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new Error(`expected string column ${key}`);
  return v;
}

function pickNumber(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v !== "number") return 0;
  return Number.isFinite(v) ? v : 0;
}
