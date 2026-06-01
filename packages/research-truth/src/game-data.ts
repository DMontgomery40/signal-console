// Gold-DB GameData loaders extracted byte-identically from
// scripts/run-nba-detector-bakeoff.ts (commit 882621b). These are the shared
// read-only loaders against the gold DB used by both the NBA detector bake-off
// and the snapshot exporter. They take an already-open gold DB handle
// (ReturnType<typeof openGoldDb>) and run the SAME SQL as the original bakeoff;
// the DB open/close lifecycle stays in the callers (this module never opens or
// closes the DB).

import { openGoldDb } from "@signal-console/db";

import { SECONDS_PER_MINUTE } from "./constants";
import { isoFromSeconds, parseIsoSeconds } from "./stats";
import type { Bucket, GameData, GameWindow, MicroEvent, PairContribution, PbpPoint } from "./types";

const PROB_EPSILON = 0.001;
const REGULATION_PERIOD_SECONDS = 12 * SECONDS_PER_MINUTE;
const OVERTIME_PERIOD_SECONDS = 5 * SECONDS_PER_MINUTE;
const STALE_PAIR_GAP_SECONDS = 300;
const DEFAULT_PRE_BUFFER_SECONDS = 10 * SECONDS_PER_MINUTE;
const DEFAULT_POST_BUFFER_SECONDS = 5 * SECONDS_PER_MINUTE;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unknownRows(rows: unknown[]): readonly unknown[] {
  return rows;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function clampProbability(value: number): number {
  return Math.min(1 - PROB_EPSILON, Math.max(PROB_EPSILON, value));
}

function logit(value: number): number {
  const p = clampProbability(value);
  return Math.log(p / (1 - p));
}

function parseClockSecondsRemaining(clock: string | null): number | null {
  if (clock === null || clock.trim() === "") return null;
  const iso = /^PT(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(clock.trim());
  if (iso !== null) {
    const minutes = Number.parseFloat(iso[1] ?? "0");
    const seconds = Number.parseFloat(iso[2] ?? "0");
    const total = minutes * SECONDS_PER_MINUTE + seconds;
    return Number.isFinite(total) ? total : null;
  }
  const mmss = /^(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(clock.trim());
  if (mmss !== null) {
    const minutes = Number.parseInt(mmss[1] ?? "0", 10);
    const seconds = Number.parseInt(mmss[2] ?? "0", 10);
    return minutes * SECONDS_PER_MINUTE + seconds;
  }
  return null;
}

function gameElapsedSeconds(period: number | null, secondsRemaining: number | null): number | null {
  if (period === null || secondsRemaining === null || period < 1) return null;
  const completedRegulationPeriods = Math.min(period - 1, 4);
  const completedOvertimePeriods = Math.max(0, period - 5);
  const currentPeriodLength = period <= 4 ? REGULATION_PERIOD_SECONDS : OVERTIME_PERIOD_SECONDS;
  return (
    completedRegulationPeriods * REGULATION_PERIOD_SECONDS +
    completedOvertimePeriods * OVERTIME_PERIOD_SECONDS +
    Math.max(0, currentPeriodLength - secondsRemaining)
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`expected ${key} string`);
  return value;
}

function participantKey(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    for (const key of ["key", "abbreviation", "name", "shortName"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim().toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function loadGameWindows(db: ReturnType<typeof openGoldDb>): readonly GameWindow[] {
  const gameRows = unknownRows(
    db
      .prepare(
        `SELECT pbp.game_id AS gameId,
              COALESCE(g.scheduled_start, MIN(pbp.time_actual)) AS scheduledStart,
              g.home_participant_json AS homeParticipantJson,
              g.away_participant_json AS awayParticipantJson,
              MIN(pbp.time_actual) AS startIso,
              MAX(pbp.time_actual) AS endIso
       FROM nba_play_by_play_actions pbp
       LEFT JOIN games g ON g.id = pbp.game_id
       WHERE pbp.time_actual IS NOT NULL
       GROUP BY pbp.game_id
       ORDER BY pbp.game_id`,
      )
      .all(),
  );
  const pointStmt = db.prepare(
    `SELECT period, clock, score_home, score_away, time_actual, description
     FROM nba_play_by_play_actions
     WHERE game_id = ?
       AND time_actual IS NOT NULL
     ORDER BY time_actual ASC, action_number ASC`,
  );
  return gameRows.flatMap((row): readonly GameWindow[] => {
    if (!isRecord(row)) return [];
    const gameId = rowString(row, "gameId");
    const startIso = rowString(row, "startIso");
    const endIso = rowString(row, "endIso");
    const scheduledStart = stringField(row, "scheduledStart") || startIso;
    const startRaw = parseIsoSeconds(startIso);
    const endRaw = parseIsoSeconds(endIso);
    if (startRaw === null || endRaw === null) return [];
    const points = unknownRows(pointStmt.all(gameId)).flatMap((pointRow): readonly PbpPoint[] => {
      if (!isRecord(pointRow)) return [];
      const iso = stringOrNull(pointRow["time_actual"]);
      const timeSec = iso === null ? null : parseIsoSeconds(iso);
      if (iso === null || timeSec === null) return [];
      const period = numberOrNull(pointRow["period"]);
      const clock = stringOrNull(pointRow["clock"]);
      const secondsRemaining = parseClockSecondsRemaining(clock);
      const elapsed = gameElapsedSeconds(period, secondsRemaining);
      const home = numberOrNull(pointRow["score_home"]);
      const away = numberOrNull(pointRow["score_away"]);
      return [
        {
          timeSec,
          iso,
          period,
          clock,
          secondsRemaining,
          gameElapsedSec: elapsed,
          scoreMarginAbs: home === null || away === null ? null : Math.abs(home - away),
          description: stringField(pointRow, "description"),
        },
      ];
    });
    return [
      {
        gameId,
        scheduledStart,
        homeKey: participantKey(row["homeParticipantJson"]),
        awayKey: participantKey(row["awayParticipantJson"]),
        startIso: isoFromSeconds(startRaw - DEFAULT_PRE_BUFFER_SECONDS),
        endIso: isoFromSeconds(endRaw + DEFAULT_POST_BUFFER_SECONDS),
        startSec: startRaw - DEFAULT_PRE_BUFFER_SECONDS,
        endSec: endRaw + DEFAULT_POST_BUFFER_SECONDS,
        points,
      },
    ];
  });
}

export function loadPairs(
  db: ReturnType<typeof openGoldDb>,
  window: GameWindow,
): readonly PairContribution[] {
  const rows = unknownRows(
    db
      .prepare(
        `SELECT sm.source AS source,
              COALESCE(sm.raw_family, '') AS family,
              qt.source_market_id AS sourceMarketId,
              qt.captured_at AS capturedAt,
              qt.implied_probability AS impliedProbability,
              COALESCE(qt.volume, 0) AS volume
       FROM quote_ticks qt
       JOIN source_markets sm ON sm.id = qt.source_market_id
       WHERE sm.game_id = ?
         AND qt.is_heartbeat = 0
         AND qt.implied_probability IS NOT NULL
         AND qt.captured_at >= ?
         AND qt.captured_at <= ?
       ORDER BY qt.source_market_id ASC, qt.captured_at ASC`,
      )
      .all(window.gameId, window.startIso, window.endIso),
  );

  const pairs: PairContribution[] = [];
  let previousMarket = "";
  let previousTs: number | null = null;
  let previousP: number | null = null;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const sourceMarketId = rowString(row, "sourceMarketId");
    const capturedAt = rowString(row, "capturedAt");
    const ts = parseIsoSeconds(capturedAt);
    const p = numberOrNull(row["impliedProbability"]);
    if (ts === null || p === null || p === 0.5) {
      previousMarket = sourceMarketId;
      previousTs = ts;
      previousP = p;
      continue;
    }
    if (previousMarket === sourceMarketId && previousTs !== null && previousP !== null) {
      const gap = ts - previousTs;
      const deltaP = Math.abs(p - previousP);
      if (gap > 0 && gap <= STALE_PAIR_GAP_SECONDS && deltaP > 0) {
        pairs.push({
          timeSec: ts,
          sourceMarketId,
          source: rowString(row, "source"),
          family: rowString(row, "family") || "unknown",
          deltaP,
          deltaLogit: Math.abs(logit(p) - logit(previousP)),
          volume: Math.max(0, numberOrNull(row["volume"]) ?? 0),
        });
      }
    }
    previousMarket = sourceMarketId;
    previousTs = ts;
    previousP = p;
  }
  return pairs;
}

export function loadMicro(
  db: ReturnType<typeof openGoldDb>,
  window: GameWindow,
): readonly MicroEvent[] {
  const rows = unknownRows(
    db
      .prepare(
        `SELECT source,
              source_market_id AS sourceMarketId,
              COALESCE(instrument_id, source_market_id) AS instrumentId,
              event_timestamp AS eventTimestamp,
              trade_price AS tradePrice,
              previous_price AS previousPrice,
              volume_share AS volumeShare,
              spread,
              depth_score AS depthScore,
              COALESCE(notional, volume, 0) AS sizeProxy
       FROM market_microstructure_events
       WHERE game_id = ?
         AND event_timestamp >= ?
         AND event_timestamp <= ?
         AND trade_price IS NOT NULL
         AND previous_price IS NOT NULL`,
      )
      .all(window.gameId, window.startIso, window.endIso),
  );
  return rows.flatMap((row): readonly MicroEvent[] => {
    if (!isRecord(row)) return [];
    const eventTimestamp = rowString(row, "eventTimestamp");
    const timeSec = parseIsoSeconds(eventTimestamp);
    const tradePrice = numberOrNull(row["tradePrice"]);
    const previousPrice = numberOrNull(row["previousPrice"]);
    if (timeSec === null || tradePrice === null || previousPrice === null) return [];
    const distance = Math.abs(tradePrice - previousPrice);
    if (distance <= 0) return [];
    const volumeShare = Math.max(0, numberOrNull(row["volumeShare"]) ?? 0);
    const spread = Math.max(0, numberOrNull(row["spread"]) ?? 0);
    const depthScore = numberOrNull(row["depthScore"]);
    const depthPenalty = depthScore === null ? 1 : 1 + Math.max(0, 1 - depthScore / 100);
    const sizeProxy = Math.max(0, numberOrNull(row["sizeProxy"]) ?? 0);
    const severity =
      distance * (1 + volumeShare * 8) * (1 + spread) * depthPenalty * Math.log1p(sizeProxy);
    return [
      {
        timeSec,
        source: rowString(row, "source"),
        sourceMarketId: rowString(row, "sourceMarketId"),
        instrumentId: rowString(row, "instrumentId"),
        severity,
      },
    ];
  });
}

export function buildGameData(db: ReturnType<typeof openGoldDb>, window: GameWindow): GameData {
  return {
    gameId: window.gameId,
    window,
    pairs: loadPairs(db, window),
    micro: loadMicro(db, window),
    bucketCache: new Map<number, readonly Bucket[]>(),
  };
}
