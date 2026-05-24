import type {
  BoardAnomalyAlert,
  BoardAnomalyShockKind,
  MarketResearchSourceId,
  SignalMismatchRow,
} from "@signal-console/domain";

import {
  classifyPlayByPlayAnchorTiming,
  getPlayByPlayContext,
  type PlayByPlayContext,
} from "./board-anomaly-play-by-play";

import type { getDatabase } from "./db-core";

export type VigAdjustedSide = {
  source: MarketResearchSourceId;
  rawAskProbability: number | null;
  rawOppositeAskProbability: number | null;
  vigPercent: number | null;
  fairProbability: number | null;
  twoSided: boolean;
  note: string;
};

export type VigAdjustedComparison = {
  instrumentOverId: string;
  instrumentUnderId: string | null;
  rawGap: number;
  fairGap: number | null;
  sides: VigAdjustedSide[];
  honestRead: string;
};

export type FinishedGameIncident = BoardAnomalyAlert & {
  playByPlay: PlayByPlayContext;
  vigAdjusted: VigAdjustedComparison | null;
};

export type ListFinishedGameIncidentsInput = {
  date: string;
  gameId?: string;
  minGap?: number;
  limit?: number;
};

export type FinishedGameReplayWindow = {
  gameId: string;
  scheduledStart: string;
  finalAt: string | null;
};

export function buildIncidentReason(row: SignalMismatchRow): string {
  const gapPp = Math.round((row.impliedProbabilityGap ?? 0) * 1000) / 10;
  const summary = row.comparisonSummary;
  const aboveMs = summary?.aboveThresholdDurationMs ?? 0;
  const aboveText =
    aboveMs > 60_000
      ? ` and stayed above the threshold for ${formatDuration(aboveMs)}`
      : "";
  const sides: string[] = [];
  if (row.bet365ImpliedProbability != null) {
    sides.push(`Bet365 ${(row.bet365ImpliedProbability * 100).toFixed(1)}%`);
  }
  if (row.kalshiImpliedProbability != null) {
    sides.push(`Kalshi ${(row.kalshiImpliedProbability * 100).toFixed(1)}%`);
  }
  if (row.polymarketImpliedProbability != null) {
    sides.push(
      `Polymarket ${(row.polymarketImpliedProbability * 100).toFixed(1)}%`
    );
  }
  const directional = row.directionalDisagreement
    ? " · directional disagreement"
    : "";
  const lineMismatch = row.lineMismatch ? " · line mismatch" : "";
  return `${row.displayLabel}: ${gapPp.toFixed(1)}pp peak (${sides.join(
    " vs "
  )})${directional}${lineMismatch}${aboveText}.`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

export function classifyIncidentKind(
  row: SignalMismatchRow,
  anchorAt: string,
  pbp: PlayByPlayContext
): BoardAnomalyShockKind {
  const timing = classifyPlayByPlayAnchorTiming(anchorAt, pbp);
  if (timing === "near-tip") return "near-tip-availability";
  if (timing === "pregame") return "pregame-availability";
  if (row.gameStatus === "scheduled") {
    return "pregame-availability";
  }
  if (timing === "in-game") {
    return "attribution-shaped";
  }
  return "cross-surface-disagreement";
}

function findOppositeInstrumentId(instrumentId: string): string | null {
  const overIndex = instrumentId.lastIndexOf("-over-");
  if (overIndex !== -1) {
    return (
      instrumentId.slice(0, overIndex) +
      "-under-" +
      instrumentId.slice(overIndex + "-over-".length)
    );
  }
  const underIndex = instrumentId.lastIndexOf("-under-");
  if (underIndex !== -1) {
    return (
      instrumentId.slice(0, underIndex) +
      "-over-" +
      instrumentId.slice(underIndex + "-under-".length)
    );
  }
  return null;
}

function latestImpliedProbability(
  db: ReturnType<typeof getDatabase>,
  instrumentId: string,
  source: MarketResearchSourceId,
  beforeIso: string
): number | null {
  const row = db
    .prepare(
      `SELECT qt.implied_probability AS p
       FROM quote_ticks qt
       JOIN source_markets sm ON sm.id = qt.source_market_id
       WHERE sm.source = ?
         AND sm.instrument_id = ?
         AND qt.is_heartbeat = 0
         AND qt.implied_probability IS NOT NULL
         AND datetime(qt.captured_at) <= datetime(?)
       ORDER BY datetime(qt.captured_at) DESC, qt.id DESC
       LIMIT 1`
    )
    .get(source, instrumentId, beforeIso) as { p: number } | undefined;
  return row?.p ?? null;
}

export function buildVigAdjustedComparison(
  db: ReturnType<typeof getDatabase>,
  row: SignalMismatchRow
): VigAdjustedComparison | null {
  if (row.family !== "player-prop" && row.family !== "team-prop") {
    if (row.family !== "moneyline") return null;
  }
  const referenceTimestamp =
    row.comparisonSummary?.maxGapAt ??
    row.comparisonSummary?.firstAboveThresholdAt ??
    row.comparisonSummary?.latestComparisonAt ??
    new Date().toISOString();
  const oppositeId = findOppositeInstrumentId(row.instrumentId);

  const sides: VigAdjustedSide[] = [];
  const sourcesToConsider: MarketResearchSourceId[] = [
    "bet365",
    "fanduel",
    "draftkings",
    "kalshi",
    "polymarket",
  ];

  for (const source of sourcesToConsider) {
    const overP = latestImpliedProbability(
      db,
      row.instrumentId,
      source,
      referenceTimestamp
    );
    if (overP == null) continue;
    const underP = oppositeId
      ? latestImpliedProbability(db, oppositeId, source, referenceTimestamp)
      : null;
    if (underP != null) {
      const totalImplied = overP + underP;
      const vigPercent = (totalImplied - 1) * 100;
      const fair = overP / totalImplied;
      sides.push({
        source,
        rawAskProbability: Number(overP.toFixed(5)),
        rawOppositeAskProbability: Number(underP.toFixed(5)),
        vigPercent: Number(vigPercent.toFixed(2)),
        fairProbability: Number(fair.toFixed(5)),
        twoSided: true,
        note: `over ask ${(overP * 100).toFixed(1)}% / under ask ${(underP * 100).toFixed(1)}% → vig ${vigPercent.toFixed(2)}%, fair over ${(fair * 100).toFixed(1)}%`,
      });
    } else {
      sides.push({
        source,
        rawAskProbability: Number(overP.toFixed(5)),
        rawOppositeAskProbability: null,
        vigPercent: null,
        fairProbability: null,
        twoSided: false,
        note: `over-side only (${(overP * 100).toFixed(1)}%); cannot de-vig — raw gap may include ~4–8% bookmaker vig`,
      });
    }
  }

  if (sides.length < 2) return null;

  const fairSportsbook = sides.find(
    (side) =>
      (side.source === "bet365" ||
        side.source === "fanduel" ||
        side.source === "draftkings") &&
      side.fairProbability != null
  )?.fairProbability;
  const exchangeRefSide = sides.find(
    (side) =>
      (side.source === "polymarket" || side.source === "kalshi") &&
      (side.fairProbability != null || side.rawAskProbability != null)
  );
  const exchangeRef =
    exchangeRefSide?.fairProbability ??
    exchangeRefSide?.rawAskProbability ??
    null;

  const fairGap =
    fairSportsbook != null && exchangeRef != null
      ? Math.abs(fairSportsbook - exchangeRef)
      : null;

  const rawGap = row.impliedProbabilityGap ?? 0;

  let honestRead: string;
  if (fairGap == null) {
    honestRead = `Raw ask-vs-ask gap ${(rawGap * 100).toFixed(1)}pp. Cannot de-vig (only one side available on at least one source). Treat the gap as an upper bound — bookmaker vig typically inflates by 4–8pp.`;
  } else {
    const inflated = (rawGap - fairGap) * 100;
    if (inflated > 0.5) {
      honestRead = `Raw ${(rawGap * 100).toFixed(1)}pp → vig-adjusted ${(fairGap * 100).toFixed(1)}pp (vig inflated by ${inflated.toFixed(1)}pp). Real disagreement is the vig-adjusted figure.`;
    } else if (inflated < -0.5) {
      honestRead = `Raw ${(rawGap * 100).toFixed(1)}pp → vig-adjusted ${(fairGap * 100).toFixed(1)}pp (vig direction does not help; both sides priced tightly). The gap is real.`;
    } else {
      honestRead = `Raw ${(rawGap * 100).toFixed(1)}pp ≈ vig-adjusted ${(fairGap * 100).toFixed(1)}pp. Vig is small on both sides; the gap is real.`;
    }
  }

  return {
    instrumentOverId: row.instrumentId,
    instrumentUnderId: oppositeId,
    rawGap: Number(rawGap.toFixed(5)),
    fairGap: fairGap == null ? null : Number(fairGap.toFixed(5)),
    sides,
    honestRead,
  };
}

export function listFinishedGameReplayWindows(
  db: ReturnType<typeof getDatabase>,
  input: ListFinishedGameIncidentsInput
): FinishedGameReplayWindow[] {
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const candidateLimit = Math.min(100, Math.max(limit * 4, limit));
  return db
    .prepare(
      `SELECT
         g.id AS gameId,
         g.scheduled_start AS scheduledStart,
         (
           SELECT gs.final_at
           FROM game_states gs
           WHERE gs.game_id = g.id
             AND gs.final_at IS NOT NULL
           ORDER BY datetime(gs.final_at) DESC, gs.id DESC
           LIMIT 1
         ) AS finalAt
       FROM games g
       WHERE substr(g.scheduled_start, 1, 10) = ?
         AND (? IS NULL OR g.id = ?)
         AND (
           EXISTS (SELECT 1 FROM game_outcomes go WHERE go.game_id = g.id)
           OR EXISTS (
             SELECT 1 FROM game_states gs
             WHERE gs.game_id = g.id
               AND (gs.is_final = 1 OR gs.final_at IS NOT NULL)
           )
         )
       ORDER BY datetime(g.scheduled_start) ASC, g.id ASC
       LIMIT ?`
    )
    .all(
      input.date,
      input.gameId ?? null,
      input.gameId ?? null,
      candidateLimit
    ) as FinishedGameReplayWindow[];
}

export function replayAlertToFinishedIncident(
  alert: BoardAnomalyAlert
): FinishedGameIncident {
  const pbp = getPlayByPlayContext(alert.gameId, alert.firstPopAt);
  return {
    ...alert,
    playByPlay: pbp,
    vigAdjusted: null,
  };
}
