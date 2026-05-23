// Games service (US-018).
//
// Reads from the gold DB via the v_games CTE in @signal-console/db. The route
// layer owns the DB handle lifecycle (open per request, close in finally) and
// passes it in here, so this module stays pure-query-against-handle.

import { openGoldDb, v_games } from "@signal-console/db";

// Borrow the handle type from openGoldDb so we don't drag better-sqlite3 into
// this module's import graph (matches the pattern in scripts/verify-queries.ts).
type GoldDbHandle = ReturnType<typeof openGoldDb>;

export interface GameRow {
  readonly id: string;
  readonly sport: string;
  readonly league: string;
  readonly scheduledStart: string;
  readonly homeParticipantJson: string;
  readonly awayParticipantJson: string;
  readonly status: string | null;
}

export interface ListGamesArgs {
  readonly since: string;
  // `sport?: string | undefined` (not `sport?: string`) — under
  // exactOptionalPropertyTypes:true, the explicit-undefined variant accepts
  // both shapes the Zod query schema produces (omitted, or present-but-undefined).
  readonly sport?: string | undefined;
}

// ISO 8601 duration subset: P[nW][nD][T[nH][nM][n(.n)S]]. We deliberately omit
// the Y (years) and date-portion M (months) units — they're calendar-relative
// and not what /v1/games callers ever ask for. The `(?!$)` guards reject the
// degenerate forms `P` and `PT` (each requires at least one component).
const ISO_DURATION_RE =
  /^P(?!$)(?:(\d+)W)?(?:(\d+)D)?(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export function isValidIsoDuration(input: string): boolean {
  return ISO_DURATION_RE.test(input);
}

export function parseIsoDuration(input: string): number {
  const m = ISO_DURATION_RE.exec(input);
  if (m === null) {
    throw new Error(`invalid ISO 8601 duration: ${input}`);
  }
  const weeks = m[1] !== undefined ? Number(m[1]) : 0;
  const days = m[2] !== undefined ? Number(m[2]) : 0;
  const hours = m[3] !== undefined ? Number(m[3]) : 0;
  const minutes = m[4] !== undefined ? Number(m[4]) : 0;
  const seconds = m[5] !== undefined ? Number(m[5]) : 0;
  return (
    weeks * 7 * 86_400_000 +
    days * 86_400_000 +
    hours * 3_600_000 +
    minutes * 60_000 +
    seconds * 1000
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function fieldString(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") {
    throw new Error(`field "${key}" is not a string`);
  }
  return v;
}

function fieldStringOrNull(r: Record<string, unknown>, key: string): string | null {
  const v = r[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new Error(`field "${key}" is not a string`);
  }
  return v;
}

function asGameRow(v: unknown): GameRow {
  if (!isRecord(v)) {
    throw new Error("row is not an object");
  }
  return {
    id: fieldString(v, "id"),
    sport: fieldString(v, "sport"),
    league: fieldString(v, "league"),
    scheduledStart: fieldString(v, "scheduled_start"),
    homeParticipantJson: fieldString(v, "home_participant_json"),
    awayParticipantJson: fieldString(v, "away_participant_json"),
    status: fieldStringOrNull(v, "status"),
  };
}

const SELECT_COLS =
  "id, sport, league, scheduled_start, home_participant_json, away_participant_json, status";

export function listGames(
  db: GoldDbHandle,
  args: ListGamesArgs,
  now: Date = new Date(),
): readonly GameRow[] {
  const durationMs = parseIsoDuration(args.since);
  const cutoff = new Date(now.getTime() - durationMs).toISOString();
  const hasSport = args.sport !== undefined && args.sport.length > 0;
  if (hasSport) {
    const stmt = db.prepare(
      `WITH v_games AS (${v_games}) SELECT ${SELECT_COLS} FROM v_games WHERE scheduled_start >= ? AND sport = ? ORDER BY scheduled_start DESC`,
    );
    return stmt.all(cutoff, args.sport).map(asGameRow);
  }
  const stmt = db.prepare(
    `WITH v_games AS (${v_games}) SELECT ${SELECT_COLS} FROM v_games WHERE scheduled_start >= ? ORDER BY scheduled_start DESC`,
  );
  return stmt.all(cutoff).map(asGameRow);
}

export function getGame(db: GoldDbHandle, gameId: string): GameRow | null {
  const stmt = db.prepare(
    `WITH v_games AS (${v_games}) SELECT ${SELECT_COLS} FROM v_games WHERE id = ? LIMIT 1`,
  );
  const row = stmt.get(gameId);
  return row === undefined ? null : asGameRow(row);
}
