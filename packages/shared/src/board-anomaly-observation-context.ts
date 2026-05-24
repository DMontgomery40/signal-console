import type {
  BoardObservationGameState,
  BoardObservationLabelTokens,
  ResearchGameStatus,
} from "@signal-console/domain";

import { parseTimestampMs, tokenizeBoardText } from "./board-anomaly-support";
import { getDatabase } from "./db-core";

function tokenize(value: string | null | undefined): string[] {
  return tokenizeBoardText(value);
}

function statFamilyHintFromTokens(tokens: string[]): string[] {
  const hints: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("rebound")) hints.push("rebounds");
    if (token.startsWith("assist")) hints.push("assists");
    if (token.startsWith("steal")) hints.push("steals");
    if (token.startsWith("block")) hints.push("blocks");
    if (token.startsWith("three") || token === "3pt" || token === "3s") {
      hints.push("threes");
    }
    if (token === "pts" || token.startsWith("point")) hints.push("points");
    if (token === "pra") hints.push("pra");
    if (token === "ra") hints.push("ra");
    if (token === "pa") hints.push("pa");
  }
  return Array.from(new Set(hints));
}

type GameContextRow = {
  gameId: string;
  homeName: string;
  awayName: string;
  homeKey: string;
  awayKey: string;
  scheduledStart: string;
};

export type GameStateRow = {
  gameId: string;
  capturedAt: string;
  capturedAtMs?: number | null;
  status: ResearchGameStatus;
  period?: number | null;
  clock?: string | null;
  homeScore?: number | null;
  awayScore?: number | null;
};

export type LoadedGameContext = {
  game: GameContextRow;
  gameStates: GameStateRow[];
};

export function loadGameContext(gameId: string): LoadedGameContext | null {
  const db = getDatabase();
  const gameRow = db
    .prepare(
      `SELECT
         g.id AS gameId,
         g.home_participant_json AS homeJson,
         g.away_participant_json AS awayJson,
         g.scheduled_start AS scheduledStart
       FROM games g
       WHERE g.id = ?`
    )
    .get(gameId) as
    | {
        gameId: string;
        homeJson: string;
        awayJson: string;
        scheduledStart: string;
      }
    | undefined;
  if (!gameRow) return null;

  const homeParticipant = JSON.parse(gameRow.homeJson) as {
    key: string;
    name: string;
    shortName?: string;
  };
  const awayParticipant = JSON.parse(gameRow.awayJson) as {
    key: string;
    name: string;
    shortName?: string;
  };

  const gameStateRows = db
    .prepare(
      `SELECT
         game_id AS gameId,
         captured_at AS capturedAt,
         status,
         period,
         clock,
         home_score AS homeScore,
         away_score AS awayScore
       FROM game_states
       WHERE game_id = ?
       ORDER BY datetime(captured_at) ASC, id ASC`
    )
    .all(gameId)
    .map((row) => {
      const state = row as GameStateRow;
      return {
        ...state,
        capturedAtMs: parseTimestampMs(state.capturedAt),
      } satisfies GameStateRow;
    });

  return {
    game: {
      gameId: gameRow.gameId,
      homeName: homeParticipant.shortName ?? homeParticipant.name,
      awayName: awayParticipant.shortName ?? awayParticipant.name,
      homeKey: homeParticipant.key,
      awayKey: awayParticipant.key,
      scheduledStart: gameRow.scheduledStart,
    },
    gameStates: gameStateRows,
  };
}

export function gameStateAt(
  gameStates: GameStateRow[],
  timestampMs: number,
  scheduledStartMs: number
): BoardObservationGameState {
  let active: GameStateRow | null = null;
  let low = 0;
  let high = gameStates.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const row = gameStates[mid];
    const ts = row.capturedAtMs ?? parseTimestampMs(row.capturedAt);
    if (ts == null) {
      low = mid + 1;
      continue;
    }
    if (ts <= timestampMs) {
      active = row;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (!active) {
    return {
      status: "scheduled",
      period: null,
      clock: null,
      homeScore: null,
      awayScore: null,
      scoreMargin: null,
      minutesToTip: Number.isFinite(scheduledStartMs)
        ? Math.max(0, (scheduledStartMs - timestampMs) / 60_000)
        : null,
    };
  }
  const scoreMargin =
    active.homeScore != null && active.awayScore != null
      ? Math.abs(active.homeScore - active.awayScore)
      : null;
  const minutesToTip =
    active.status === "scheduled" && Number.isFinite(scheduledStartMs)
      ? Math.max(0, (scheduledStartMs - timestampMs) / 60_000)
      : null;
  return {
    status: active.status,
    period: active.period ?? null,
    clock: active.clock ?? null,
    homeScore: active.homeScore ?? null,
    awayScore: active.awayScore ?? null,
    scoreMargin,
    minutesToTip,
  };
}

export function buildObservationLabels(
  rawFamily: string | null,
  rawLabel: string | null,
  participantKey: string | null,
  displayLabel: string | null
): BoardObservationLabelTokens {
  const labelTokens = tokenize(rawLabel ?? displayLabel ?? "");
  const participantHints = participantKey
    ? [participantKey]
    : labelTokens.filter((token) => token.length >= 4);
  return {
    rawFamily,
    rawLabel,
    normalizedTokens: labelTokens,
    participantHints,
    statFamilyHints: statFamilyHintFromTokens(labelTokens),
  };
}
