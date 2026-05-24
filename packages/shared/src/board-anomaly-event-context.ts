import type { BoardObservation } from "@signal-console/domain";

import {
  buildHistoricalParticipantFanouts,
  historicalParticipantFanoutToBoardCard,
  listHistoricalParticipantReactionRowsFromObservations,
} from "./board-anomaly-historical-fanouts";
import { materializeBoardObservations } from "./board-anomaly-observations";
import { getPlayByPlayContext } from "./board-anomaly-play-by-play";
import { parseTimestampMs } from "./board-anomaly-support";
import { executeDatabaseOperation, getDatabase } from "./db-core";

import type { FinishedGameIncident } from "./board-anomaly-incidents";

export type EventContextPbpRow = {
  actionNumber: number;
  timeActual: string | null;
  period: number | null;
  clock: string | null;
  description: string | null;
  teamTricode: string | null;
  offsetSeconds: number | null;
};

export type EventContextPredictionMarketRow = {
  bestAsk: number | null;
  bestBid: number | null;
  capturedAt: string;
  depthScore: number | null;
  displayLabel: string;
  eventTimestamp: string;
  family: string | null;
  finalMarketVolume: number | null;
  impliedProbability: number | null;
  kind: "quote" | "trade";
  mappingStatus: BoardObservation["mappingStatus"];
  notional: number | null;
  observationId: string;
  offsetSeconds: number;
  participantKey: string | null;
  previousImpliedProbability: number | null;
  signalStrength: number;
  source: string;
  sourceMarketId: string;
  spread: number | null;
  tradePrice: number | null;
  tradeSize: number | null;
  volume: number | null;
  volumeShare: number | null;
};

export type EventContextPredictionSourceSummary = {
  families: string[];
  nearestOffsetSeconds: number | null;
  nearestTimestamp: string | null;
  observationCount: number;
  participantKeys: string[];
  quoteCount: number;
  source: string;
  topRows: EventContextPredictionMarketRow[];
  tradeCount: number;
};

export type EventContextOutput = {
  gameId: string;
  gameLabel: string;
  anchorAt: string;
  resolvedIncident: FinishedGameIncident | null;
  predictionMarketContext: {
    bySource: EventContextPredictionSourceSummary[];
    rows: EventContextPredictionMarketRow[];
  };
  windowStart: string;
  windowEnd: string;
  playByPlay: EventContextPbpRow[];
};

function observationKind(
  observation: BoardObservation
): EventContextPredictionMarketRow["kind"] {
  return observation.tradePrice != null ||
    observation.tradeSize != null ||
    observation.notional != null ||
    (observation.volumeShare ?? 0) > 0
    ? "trade"
    : "quote";
}

function observationSignalStrength(observation: BoardObservation) {
  return Math.max(
    Math.abs(observation.logitMove ?? 0),
    Math.abs(observation.priceMove ?? 0) * 4,
    observation.volumeShare ?? 0,
    Math.min(1, (observation.notional ?? 0) / 200)
  );
}

function toPredictionMarketRow(input: {
  anchorMs: number;
  observation: BoardObservation;
}): EventContextPredictionMarketRow {
  const { anchorMs, observation } = input;
  return {
    bestAsk: observation.bestAsk ?? null,
    bestBid: observation.bestBid ?? null,
    capturedAt: observation.capturedAt,
    depthScore: observation.depthScore ?? null,
    displayLabel: observation.displayLabel,
    eventTimestamp: observation.eventTimestamp,
    family: observation.labels.rawFamily ?? observation.family ?? null,
    finalMarketVolume: observation.finalMarketVolume ?? null,
    impliedProbability: observation.impliedProbability ?? null,
    kind: observationKind(observation),
    mappingStatus: observation.mappingStatus,
    notional: observation.notional ?? null,
    observationId: observation.observationId,
    offsetSeconds: Math.round(
      ((parseTimestampMs(observation.eventTimestamp) ?? anchorMs) - anchorMs) /
        1000
    ),
    participantKey: observation.participantKey ?? null,
    previousImpliedProbability: observation.previousImpliedProbability ?? null,
    signalStrength: Number(observationSignalStrength(observation).toFixed(6)),
    source: observation.source,
    sourceMarketId: observation.sourceMarketId,
    spread: observation.spread ?? null,
    tradePrice: observation.tradePrice ?? null,
    tradeSize: observation.tradeSize ?? null,
    volume: observation.volume ?? null,
    volumeShare: observation.volumeShare ?? null,
  };
}

function comparePredictionMarketRows(
  left: EventContextPredictionMarketRow,
  right: EventContextPredictionMarketRow
) {
  if (right.signalStrength !== left.signalStrength) {
    return right.signalStrength - left.signalStrength;
  }
  const offsetDelta =
    Math.abs(left.offsetSeconds) - Math.abs(right.offsetSeconds);
  if (offsetDelta !== 0) return offsetDelta;
  const rightShare = right.volumeShare ?? 0;
  const leftShare = left.volumeShare ?? 0;
  if (rightShare !== leftShare) return rightShare - leftShare;
  const rightNotional = right.notional ?? 0;
  const leftNotional = left.notional ?? 0;
  if (rightNotional !== leftNotional) return rightNotional - leftNotional;
  return (
    (parseTimestampMs(left.eventTimestamp) ?? Number.POSITIVE_INFINITY) -
    (parseTimestampMs(right.eventTimestamp) ?? Number.POSITIVE_INFINITY)
  );
}

function buildPredictionMarketContext(input: {
  anchorMs: number;
  limit: number;
  observations: BoardObservation[];
}): EventContextOutput["predictionMarketContext"] {
  if (input.observations.length === 0) {
    return { bySource: [], rows: [] };
  }

  const bySource = new Map<string, BoardObservation[]>();
  for (const observation of input.observations) {
    if (observation.sourceKind !== "prediction-market") continue;
    const list = bySource.get(observation.source) ?? [];
    list.push(observation);
    bySource.set(observation.source, list);
  }

  const rows = Array.from(bySource.values())
    .flat()
    .map((observation) =>
      toPredictionMarketRow({ anchorMs: input.anchorMs, observation })
    )
    .sort(comparePredictionMarketRows)
    .slice(0, input.limit);

  const bySourceRows = Array.from(bySource.entries())
    .map(([source, observations]) => {
      const sourceRows = observations
        .map((observation) =>
          toPredictionMarketRow({ anchorMs: input.anchorMs, observation })
        )
        .sort(comparePredictionMarketRows);
      const quoteCount = sourceRows.filter(
        (row) => row.kind === "quote"
      ).length;
      const tradeCount = sourceRows.length - quoteCount;
      const nearest =
        sourceRows
          .slice()
          .sort(
            (left, right) =>
              Math.abs(left.offsetSeconds) - Math.abs(right.offsetSeconds)
          )[0] ?? null;

      return {
        families: Array.from(
          new Set(
            sourceRows
              .map((row) => row.family)
              .filter((family): family is string => Boolean(family))
          )
        ).sort(),
        nearestOffsetSeconds: nearest?.offsetSeconds ?? null,
        nearestTimestamp: nearest?.eventTimestamp ?? null,
        observationCount: sourceRows.length,
        participantKeys: Array.from(
          new Set(
            sourceRows
              .map((row) => row.participantKey)
              .filter((participantKey): participantKey is string =>
                Boolean(participantKey)
              )
          )
        ).sort(),
        quoteCount,
        source,
        topRows: sourceRows.slice(0, 5),
        tradeCount,
      } satisfies EventContextPredictionSourceSummary;
    })
    .sort((left, right) => {
      const nearestDelta =
        Math.abs(left.nearestOffsetSeconds ?? Number.POSITIVE_INFINITY) -
        Math.abs(right.nearestOffsetSeconds ?? Number.POSITIVE_INFINITY);
      if (nearestDelta !== 0) return nearestDelta;
      return right.observationCount - left.observationCount;
    });

  return {
    bySource: bySourceRows,
    rows,
  };
}

function parseHistoricalParticipantAlertId(
  alertId: string | undefined,
  gameId: string
) {
  if (!alertId) return null;
  const prefix = `historic-participant:${gameId}:`;
  if (!alertId.startsWith(prefix)) return null;
  const suffix = alertId.slice(prefix.length);
  const match = suffix.match(
    /^(.+):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/
  );
  if (!match) return null;
  const participantKey = match[1]
    .trim()
    .replace(/[+\s]+/g, "-")
    .toLowerCase();
  const windowStartIso = match[2];
  if (!participantKey || !Number.isFinite(Date.parse(windowStartIso))) {
    return null;
  }
  return { participantKey, windowStartIso };
}

function resolveHistoricalParticipantIncident(input: {
  alertId?: string;
  gameId: string;
  gameLabel: string;
  observations: BoardObservation[];
}): FinishedGameIncident | null {
  const parsed = parseHistoricalParticipantAlertId(input.alertId, input.gameId);
  if (!parsed) return null;

  const reactionRows = listHistoricalParticipantReactionRowsFromObservations({
    gameId: input.gameId,
    gameLabel: input.gameLabel,
    observations: input.observations,
    participantKey: parsed.participantKey,
  });
  if (reactionRows.length === 0) return null;

  const fanouts = buildHistoricalParticipantFanouts(reactionRows);
  const exactFanout =
    fanouts.find((fanout) => fanout.windowStartIso === parsed.windowStartIso) ??
    fanouts.find((fanout) => {
      const startMs = Date.parse(fanout.windowStartIso);
      const endMs = Date.parse(fanout.windowEndIso);
      const anchorMs = Date.parse(parsed.windowStartIso);
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        !Number.isFinite(anchorMs)
      ) {
        return false;
      }
      return anchorMs >= startMs && anchorMs <= endMs;
    }) ??
    null;
  if (!exactFanout) return null;

  const pbp = getPlayByPlayContext(input.gameId, exactFanout.windowStartIso);
  return historicalParticipantFanoutToBoardCard(exactFanout, pbp);
}

function loadGameLabel(gameId: string): string {
  const db = getDatabase();
  const gameRow = db
    .prepare(
      `SELECT
         g.home_participant_json AS homeJson,
         g.away_participant_json AS awayJson
       FROM games g
       WHERE g.id = ?`
    )
    .get(gameId) as { homeJson: string; awayJson: string } | undefined;
  if (!gameRow) return gameId;
  const home = JSON.parse(gameRow.homeJson) as {
    shortName?: string;
    name?: string;
  };
  const away = JSON.parse(gameRow.awayJson) as {
    shortName?: string;
    name?: string;
  };
  return `${away.shortName ?? away.name ?? "Away"} @ ${
    home.shortName ?? home.name ?? "Home"
  }`;
}

export function getBoardAlertEventContext(input: {
  gameId: string;
  anchorAt: string;
  alertId?: string;
  windowSecondsBefore?: number;
  windowSecondsAfter?: number;
  limit?: number;
}): EventContextOutput {
  return executeDatabaseOperation(
    "board-anomaly.getBoardAlertEventContext",
    () => {
      const db = getDatabase();
      const anchorMs = parseTimestampMs(input.anchorAt);
      if (anchorMs == null) {
        throw new Error(`Invalid anchorAt: ${input.anchorAt}`);
      }
      const before = (input.windowSecondsBefore ?? 7200) * 1000;
      const after = (input.windowSecondsAfter ?? 3600) * 1000;
      const startIso = new Date(anchorMs - before).toISOString();
      const endIso = new Date(anchorMs + after).toISOString();
      const gameLabel = loadGameLabel(input.gameId);
      const limit = Math.max(1, Math.min(200, input.limit ?? 200));
      const materialized = materializeBoardObservations({
        gameId: input.gameId,
        windowEnd: endIso,
        windowStart: startIso,
      });
      const predictionMarketContext = buildPredictionMarketContext({
        anchorMs,
        limit,
        observations: materialized?.observations ?? [],
      });
      const resolvedIncident =
        materialized == null
          ? null
          : resolveHistoricalParticipantIncident({
              alertId: input.alertId,
              gameId: input.gameId,
              gameLabel: materialized.gameLabel,
              observations: materialized.observations,
            });

      const pbpRows = db
        .prepare(
          `SELECT
             action_number AS actionNumber,
             time_actual AS timeActual,
             period,
             clock,
             description,
             team_tricode AS teamTricode,
             ABS(strftime('%s', time_actual) - strftime('%s', ?)) AS anchorDistanceSeconds
           FROM nba_play_by_play_actions
           WHERE game_id = ?
             AND time_actual IS NOT NULL
             AND datetime(time_actual) >= datetime(?)
             AND datetime(time_actual) <= datetime(?)
           ORDER BY anchorDistanceSeconds ASC, action_number ASC
           LIMIT ?`
        )
        .all(input.anchorAt, input.gameId, startIso, endIso, limit) as Array<{
        actionNumber: number;
        timeActual: string | null;
        period: number | null;
        clock: string | null;
        description: string | null;
        teamTricode: string | null;
      }>;
      const playByPlay: EventContextPbpRow[] = pbpRows.map((row) => {
        const ts = row.timeActual ? parseTimestampMs(row.timeActual) : null;
        return {
          ...row,
          offsetSeconds: ts != null ? Math.round((ts - anchorMs) / 1000) : null,
        };
      });

      return {
        gameId: input.gameId,
        gameLabel,
        anchorAt: input.anchorAt,
        resolvedIncident,
        predictionMarketContext,
        windowStart: startIso,
        windowEnd: endIso,
        playByPlay,
      };
    },
    input
  );
}
