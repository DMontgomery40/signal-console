import { parseTimestampMs } from "./board-anomaly-support";
import { executeDatabaseOperation, getDatabase } from "./db-core";

export type PlayByPlayContext = {
  available: boolean;
  firstActionAt: string | null;
  lastActionAt: string | null;
  totalActions: number;
  nearestBefore: PlayByPlayAnchor | null;
  nearestAfter: PlayByPlayAnchor | null;
};

export const NEARBY_PLAY_BY_PLAY_WINDOW_SECONDS = 30 * 60;

export type PlayByPlayAnchorTiming =
  | "pregame"
  | "near-tip"
  | "in-game"
  | "postgame"
  | "unknown";

export type PlayByPlayAnchor = {
  actionNumber: number;
  actionType: string | null;
  period: number | null;
  clock: string | null;
  description: string | null;
  teamTricode: string | null;
  timeActual: string | null;
  offsetSeconds: number | null;
};

function rowToAnchor(
  row: Record<string, unknown> | undefined,
  referenceMs: number | null
): PlayByPlayAnchor | null {
  if (!row) return null;
  const actionNumber = Number(row.actionNumber);
  if (!Number.isFinite(actionNumber)) return null;
  const timeActual = row.timeActual == null ? null : String(row.timeActual);
  const offsetSeconds =
    timeActual && referenceMs != null
      ? Math.round((referenceMs - Date.parse(timeActual)) / 1000)
      : null;
  return {
    actionNumber,
    actionType: row.actionType == null ? null : String(row.actionType),
    period: row.period == null ? null : Number(row.period),
    clock: row.clock == null ? null : String(row.clock),
    description: row.description == null ? null : String(row.description),
    teamTricode: row.teamTricode == null ? null : String(row.teamTricode),
    timeActual,
    offsetSeconds: Number.isFinite(offsetSeconds ?? NaN) ? offsetSeconds : null,
  };
}

function pruneDistantAnchor(
  anchor: PlayByPlayAnchor | null,
  maxDistanceSeconds: number
) {
  if (!anchor) return null;
  if (anchor.offsetSeconds == null) return null;
  return Math.abs(anchor.offsetSeconds) <= maxDistanceSeconds ? anchor : null;
}

export function classifyPlayByPlayAnchorTiming(
  referenceIso: string,
  pbp: Pick<
    PlayByPlayContext,
    | "available"
    | "firstActionAt"
    | "lastActionAt"
    | "nearestBefore"
    | "nearestAfter"
  >
): PlayByPlayAnchorTiming {
  const referenceMs = Date.parse(referenceIso);
  if (!pbp.available || !Number.isFinite(referenceMs)) {
    return "unknown";
  }
  const firstActionMs = Date.parse(pbp.firstActionAt ?? "");
  if (Number.isFinite(firstActionMs) && referenceMs < firstActionMs) {
    return firstActionMs - referenceMs <=
      NEARBY_PLAY_BY_PLAY_WINDOW_SECONDS * 1000
      ? "near-tip"
      : "pregame";
  }
  const lastActionMs = Date.parse(pbp.lastActionAt ?? "");
  if (Number.isFinite(lastActionMs) && referenceMs > lastActionMs) {
    return "postgame";
  }
  if (
    pbp.nearestBefore?.timeActual != null ||
    pbp.nearestAfter?.timeActual != null
  ) {
    return "in-game";
  }
  return "unknown";
}

export function getPlayByPlayContext(
  gameId: string,
  referenceIso: string
): PlayByPlayContext {
  return executeDatabaseOperation(
    "board-anomaly.getPlayByPlayContext",
    () => {
      const db = getDatabase();
      const totalRow = db
        .prepare(
          `SELECT COUNT(*) AS total FROM nba_play_by_play_actions WHERE game_id = ?`
        )
        .get(gameId) as { total: number } | undefined;
      const total = totalRow?.total ?? 0;
      if (total === 0) {
        return {
          available: false,
          firstActionAt: null,
          lastActionAt: null,
          totalActions: 0,
          nearestBefore: null,
          nearestAfter: null,
        };
      }
      const referenceMs = parseTimestampMs(referenceIso);
      const firstActionRow = db
        .prepare(
          `SELECT time_actual AS timeActual
           FROM nba_play_by_play_actions
           WHERE game_id = ?
             AND time_actual IS NOT NULL
           ORDER BY datetime(time_actual) ASC, action_number ASC
           LIMIT 1`
        )
        .get(gameId) as { timeActual: string | null } | undefined;
      const lastActionRow = db
        .prepare(
          `SELECT time_actual AS timeActual
           FROM nba_play_by_play_actions
           WHERE game_id = ?
             AND time_actual IS NOT NULL
           ORDER BY datetime(time_actual) DESC, action_number DESC
           LIMIT 1`
        )
        .get(gameId) as { timeActual: string | null } | undefined;
      const before = db
        .prepare(
          `SELECT
             action_number AS actionNumber,
             action_type AS actionType,
             period,
             clock,
             description,
             team_tricode AS teamTricode,
             time_actual AS timeActual
           FROM nba_play_by_play_actions
           WHERE game_id = ?
             AND time_actual IS NOT NULL
             AND datetime(time_actual) <= datetime(?)
           ORDER BY datetime(time_actual) DESC, action_number DESC
           LIMIT 1`
        )
        .get(gameId, referenceIso) as Record<string, unknown> | undefined;
      const after = db
        .prepare(
          `SELECT
             action_number AS actionNumber,
             action_type AS actionType,
             period,
             clock,
             description,
             team_tricode AS teamTricode,
             time_actual AS timeActual
           FROM nba_play_by_play_actions
           WHERE game_id = ?
             AND time_actual IS NOT NULL
             AND datetime(time_actual) > datetime(?)
           ORDER BY datetime(time_actual) ASC, action_number ASC
           LIMIT 1`
        )
        .get(gameId, referenceIso) as Record<string, unknown> | undefined;
      const nearestBefore = pruneDistantAnchor(
        rowToAnchor(before, referenceMs),
        NEARBY_PLAY_BY_PLAY_WINDOW_SECONDS
      );
      const nearestAfter = pruneDistantAnchor(
        rowToAnchor(after, referenceMs),
        NEARBY_PLAY_BY_PLAY_WINDOW_SECONDS
      );
      return {
        available: true,
        firstActionAt: firstActionRow?.timeActual ?? null,
        lastActionAt: lastActionRow?.timeActual ?? null,
        totalActions: total,
        nearestBefore,
        nearestAfter,
      };
    },
    { gameId, referenceIso }
  );
}
