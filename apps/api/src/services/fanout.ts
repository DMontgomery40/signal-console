// Fanout service (US-051 / PRD §FR-21).
//
// Backs GET /v1/board/:gameId/fanout?bucket_start=<ISO>. For one fired
// bucket on one game, surfaces:
//   1. PBP events strictly within ±5 minutes of bucket_start (the owner's
//      research cap: >5 min worthless, 3-5 almost worthless, <3 useful,
//      <1 gold). Capped to 50 events, ranked by absolute closeness.
//   2. Top market movers over the 60-second bucket window, ranked by the
//      same intensity decomposition the board-mad detector emits:
//      Σ log(1+v) · |Δp| over consecutive in-bucket ticks subject to the
//      detector's freshCapSeconds = 300 sanitation. Each mover's
//      contributionPct = its weighted |ΔIP| / bucket intensity.
//   3. ipBefore / ipAfter snapshots (last tick at-or-before bucket_start,
//      last tick at-or-before bucket_end) for display only — these are
//      independent of contributionPct.
//
// Window enforcement is strict: any PBP event with |deltaSecondsFromFire|
// > 300 is NOT returned. The detector's intensity decomposition is
// reproduced here directly from the gold DB (rather than persisted by
// the detector run) so that fanout works on any bucket, fired or not,
// at query time.

import { openGoldDb } from "@signal-console/db";

import { renderFanoutNarrative } from "./fanout-narrative";

type GoldDbHandle = ReturnType<typeof openGoldDb>;

export const FANOUT_PBP_WINDOW_SECONDS = 300;
export const FANOUT_BUCKET_SECONDS = 60;
export const FANOUT_FRESH_CAP_SECONDS = 300;
export const FANOUT_PBP_MAX_EVENTS = 50;
export const FANOUT_MOVERS_TOP_N = 10;

export interface FanoutPbpEvent {
  readonly timeActual: string;
  readonly actionType: string | null;
  readonly playerName: string | null;
  readonly description: string | null;
  // Offset within the alert window: event_time - bucket_start. Kept for
  // back-compat; UI prefers deltaSecondsFromAlert.
  readonly deltaSecondsFromFire: number;
  // Time of the event relative to the alert confirmation (bucket_end).
  // Negative = event happened BEFORE the alert confirmed. Positive = after.
  // This is the honest framing: the desk's alert lands at bucket_end, so the
  // useful lead/lag against a known PBP event is event_time − bucket_end.
  readonly deltaSecondsFromAlert: number;
  // NBA period (1-4 = quarters, 5+ = overtimes). null on schema-light fixtures.
  readonly period: number | null;
  // Raw ISO 8601 duration for game clock (e.g. "PT08M19.00S" = 8:19 remaining
  // in the period). UI parses to "Q3 8:19" for display. null on schema-light
  // fixtures.
  readonly clock: string | null;
}

export interface FanoutMover {
  readonly sourceMarketId: string;
  readonly instrument: string;
  readonly ipBefore: number | null;
  readonly ipAfter: number | null;
  readonly ipDelta: number | null;
  readonly contributionPct: number;
  // Offset within the alert window: representative_tick_time - bucket_start.
  // Always in [0, 60) for movers (representative ticks fall inside the
  // bucket). NOT a lead-over-the-desk figure. The alert itself confirms at
  // bucket_end = bucket_start + 60s.
  readonly deltaSecondsFromFire: number;
}

export interface FanoutResult {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly pbp: readonly FanoutPbpEvent[];
  readonly movers: readonly FanoutMover[];
  readonly narrative: string;
}

export interface GetFanoutArgs {
  readonly goldDbPath: string;
  readonly gameId: string;
  readonly bucketStart: string;
}

export function getFanout(args: GetFanoutArgs): FanoutResult {
  const bucketStartMs = Date.parse(args.bucketStart);
  if (!Number.isFinite(bucketStartMs)) {
    throw new Error(`fanout: invalid bucket_start ${args.bucketStart}`);
  }
  const bucketStart = new Date(bucketStartMs);
  const bucketEnd = new Date(bucketStartMs + FANOUT_BUCKET_SECONDS * 1000);
  const bucketEndMs = bucketEnd.getTime();
  const pbpLo = new Date(bucketStartMs - FANOUT_PBP_WINDOW_SECONDS * 1000);
  const pbpHi = new Date(bucketStartMs + FANOUT_PBP_WINDOW_SECONDS * 1000);

  const db = openGoldDb(args.goldDbPath);
  try {
    const pbp = loadPbpWindow(db, args.gameId, bucketStartMs, bucketEndMs, pbpLo, pbpHi);
    const movers = loadMovers(db, args.gameId, bucketStartMs, bucketStart, bucketEnd);
    const narrative = renderFanoutNarrative({
      bucketStart: args.bucketStart,
      bucketEnd: bucketEnd.toISOString(),
      pbp,
      movers,
    });
    return {
      bucketStart: bucketStart.toISOString(),
      bucketEnd: bucketEnd.toISOString(),
      pbp,
      movers,
      narrative,
    };
  } finally {
    db.close();
  }
}

function loadPbpWindow(
  db: GoldDbHandle,
  gameId: string,
  bucketStartMs: number,
  bucketEndMs: number,
  lo: Date,
  hi: Date,
): readonly FanoutPbpEvent[] {
  const rows = db
    .prepare(
      `SELECT time_actual, action_type, description, period, clock
       FROM nba_play_by_play_actions
       WHERE game_id = ?
         AND time_actual >= ?
         AND time_actual <= ?
       ORDER BY time_actual`,
    )
    .all(gameId, lo.toISOString(), hi.toISOString());
  const events: FanoutPbpEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const timeActual = row["time_actual"];
    if (typeof timeActual !== "string") continue;
    const ms = Date.parse(timeActual);
    if (!Number.isFinite(ms)) continue;
    const deltaSec = (ms - bucketStartMs) / 1000;
    // Strict ±5 min: defense in depth in case of clock skew between
    // bucket_start and stored time_actual strings.
    if (Math.abs(deltaSec) > FANOUT_PBP_WINDOW_SECONDS) continue;
    const description = pickStringOrNull(row, "description");
    const deltaFromAlertSec = (ms - bucketEndMs) / 1000;
    const period = row["period"];
    events.push({
      timeActual,
      actionType: pickStringOrNull(row, "action_type"),
      playerName: extractPlayerName(description),
      description,
      deltaSecondsFromFire: roundTenth(deltaSec),
      deltaSecondsFromAlert: roundTenth(deltaFromAlertSec),
      period: typeof period === "number" && Number.isFinite(period) ? period : null,
      clock: pickStringOrNull(row, "clock"),
    });
  }
  events.sort((a, b) => Math.abs(a.deltaSecondsFromFire) - Math.abs(b.deltaSecondsFromFire));
  return events.slice(0, FANOUT_PBP_MAX_EVENTS);
}

interface RawTickRow {
  readonly sourceMarketId: string;
  readonly capturedAt: string;
  readonly capturedAtMs: number;
  readonly impliedProbability: number;
  readonly volume: number;
}

function loadMovers(
  db: GoldDbHandle,
  gameId: string,
  bucketStartMs: number,
  bucketStart: Date,
  bucketEnd: Date,
): readonly FanoutMover[] {
  // Load all non-heartbeat ticks spanning the bucket plus one freshCap
  // window of lookback so we can establish ipBefore + a meaningful prev_ip
  // for the first in-bucket tick of each market. Equality on bucket_end
  // is exclusive so a bucket-aligned tick belongs to the NEXT bucket.
  const lookbackStart = new Date(bucketStart.getTime() - FANOUT_FRESH_CAP_SECONDS * 1000);
  const rows = db
    .prepare(
      `SELECT qt.source_market_id AS source_market_id,
              qt.captured_at AS captured_at,
              qt.implied_probability AS implied_probability,
              COALESCE(qt.volume, 0) AS volume
       FROM quote_ticks qt
       JOIN source_markets sm ON sm.id = qt.source_market_id
       WHERE sm.game_id = ?
         AND qt.is_heartbeat = 0
         AND qt.implied_probability IS NOT NULL
         AND qt.captured_at >= ?
         AND qt.captured_at < ?
       ORDER BY qt.source_market_id, qt.captured_at`,
    )
    .all(gameId, lookbackStart.toISOString(), bucketEnd.toISOString());

  const byMarket = new Map<string, RawTickRow[]>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const ip = row["implied_probability"];
    if (typeof ip !== "number") continue;
    const sourceMarketId = pickString(row, "source_market_id");
    const capturedAt = pickString(row, "captured_at");
    const ms = Date.parse(capturedAt);
    if (!Number.isFinite(ms)) continue;
    const list = byMarket.get(sourceMarketId) ?? [];
    list.push({
      sourceMarketId,
      capturedAt,
      capturedAtMs: ms,
      impliedProbability: ip,
      volume: pickNumber(row, "volume"),
    });
    byMarket.set(sourceMarketId, list);
  }

  interface MarketAgg {
    readonly sourceMarketId: string;
    readonly contribution: number;
    readonly ipBefore: number | null;
    readonly ipAfter: number | null;
    readonly representativeMs: number | null;
  }

  const aggregated: MarketAgg[] = [];
  const bucketEndMs = bucketEnd.getTime();
  for (const [sourceMarketId, ticks] of byMarket) {
    let contribution = 0;
    let ipBefore: number | null = null;
    let ipAfter: number | null = null;
    let representativeMs: number | null = null;
    let bestContribution = 0;
    for (let i = 0; i < ticks.length; i += 1) {
      const t = ticks[i]!;
      if (t.capturedAtMs < bucketStartMs) {
        ipBefore = t.impliedProbability;
        continue;
      }
      if (t.capturedAtMs < bucketEndMs) {
        ipAfter = t.impliedProbability;
        // Skip the first tick of the market that lands inside the bucket
        // if there is no prior tick — we can't compute a delta and the
        // detector treats it the same way (LAG returns null).
        if (i === 0) continue;
        const prev = ticks[i - 1]!;
        const gapSec = (t.capturedAtMs - prev.capturedAtMs) / 1000;
        if (gapSec > FANOUT_FRESH_CAP_SECONDS) continue;
        const delta = Math.abs(t.impliedProbability - prev.impliedProbability);
        const weight = Math.log(1 + Math.max(0, t.volume));
        const term = weight * delta;
        contribution += term;
        if (term > bestContribution) {
          bestContribution = term;
          representativeMs = t.capturedAtMs;
        }
      }
    }
    if (contribution > 0 || ipAfter !== null) {
      aggregated.push({
        sourceMarketId,
        contribution,
        ipBefore,
        ipAfter,
        representativeMs,
      });
    }
  }

  const totalContribution = aggregated.reduce((acc, m) => acc + m.contribution, 0);
  aggregated.sort((a, b) => b.contribution - a.contribution);
  const top = aggregated.slice(0, FANOUT_MOVERS_TOP_N);

  const instrumentLookup = loadInstrumentLabels(
    db,
    top.map((m) => m.sourceMarketId),
  );

  return top.map((m): FanoutMover => {
    const ipBefore = m.ipBefore;
    const ipAfter = m.ipAfter;
    const ipDelta = ipBefore !== null && ipAfter !== null ? ipAfter - ipBefore : null;
    const contributionPct = totalContribution > 0 ? (m.contribution / totalContribution) * 100 : 0;
    const deltaSec =
      m.representativeMs !== null
        ? (m.representativeMs - bucketStartMs) / 1000
        : FANOUT_BUCKET_SECONDS / 2;
    return {
      sourceMarketId: m.sourceMarketId,
      instrument: instrumentLookup.get(m.sourceMarketId) ?? m.sourceMarketId,
      ipBefore,
      ipAfter,
      ipDelta,
      contributionPct: roundTenth(contributionPct),
      deltaSecondsFromFire: roundTenth(deltaSec),
    };
  });
}

function loadInstrumentLabels(db: GoldDbHandle, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, source, raw_family, raw_label
       FROM source_markets
       WHERE id IN (${placeholders})`,
    )
    .all(...ids);
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = row["id"];
    if (typeof id !== "string") continue;
    const family = pickStringOrNull(row, "raw_family");
    const label = pickStringOrNull(row, "raw_label");
    const source = pickStringOrNull(row, "source");
    const parts: string[] = [];
    if (family !== null) parts.push(family);
    if (label !== null) parts.push(label);
    const composed = parts.length > 0 ? parts.join(" · ") : id;
    out.set(id, source !== null ? `${source}: ${composed}` : composed);
  }
  return out;
}

// Player-name extraction from PBP descriptions. The gold-DB schema does not
// store player_name separately; the canonical form in `description` is
// "F. Last <verb>" (e.g. "I. Hartenstein REBOUND", "L. James 10' fadeaway").
// Match "F. Last" or "F. Van Gundy" — each name token must start with a
// capital AND contain at least one lowercase letter, so all-caps action
// type tokens ("REBOUND", "DUNK", "STEAL") are not absorbed into the name.
const PLAYER_NAME_RE = /^(?:MISS\s)?([A-Z]\.\s[A-Z][a-z][A-Za-z'-]*(?:\s[A-Z][a-z][A-Za-z'-]*)*)/;
function extractPlayerName(description: string | null): string | null {
  if (description === null) return null;
  const match = PLAYER_NAME_RE.exec(description);
  return match !== null ? (match[1] ?? null) : null;
}

function roundTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string") throw new Error(`field ${key}: expected string`);
  return v;
}

function pickNumber(rec: Record<string, unknown>, key: string): number {
  const v = rec[key];
  if (typeof v !== "number") throw new Error(`field ${key}: expected number`);
  return v;
}

function pickStringOrNull(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  return v;
}
