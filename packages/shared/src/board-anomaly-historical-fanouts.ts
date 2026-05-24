import type {
  BoardObservation,
  MarketAnomalyAlert,
  MarketFamily,
} from "@signal-console/domain";

import { scoreToSeverity } from "./board-anomaly/config";
import { titleCase } from "./board-anomaly-fanout-support";
import { materializeBoardObservations } from "./board-anomaly-observations";
import {
  classifyPlayByPlayAnchorTiming,
  type PlayByPlayContext,
} from "./board-anomaly-play-by-play";
import { sourceKindFor } from "./board-anomaly-support";

import type { FinishedGameIncident } from "./board-anomaly-incidents";
import type { getDatabase } from "./db-core";

type HistoricalParticipantReactionRow = {
  displayLabel: string;
  eventTimestamp: string;
  family: string;
  gameId: string;
  gameLabel: string;
  instrumentId: string | null;
  mappingStatus: string;
  notional: number;
  observationKind: "quote" | "trade";
  participantKey: string;
  previousPrice: number | null;
  signalStrength: number;
  source: MarketAnomalyAlert["source"];
  sourceMarketId: string;
  tradePrice: number | null;
  volumeShare: number;
};

type HistoricalParticipantFanout = {
  families: Set<string>;
  gameId: string;
  gameLabel: string;
  members: HistoricalParticipantReactionRow[];
  participantKey: string;
  windowEndIso: string;
  windowStartIso: string;
};

function participantFanoutShockKind(
  anchorAt: string,
  pbp: PlayByPlayContext
): FinishedGameIncident["shockKind"] {
  const timing = classifyPlayByPlayAnchorTiming(anchorAt, pbp);
  if (timing === "near-tip") return "near-tip-availability";
  if (timing === "pregame") return "pregame-availability";
  return "attribution-shaped";
}

function historicalObservationKind(
  observation: BoardObservation
): HistoricalParticipantReactionRow["observationKind"] {
  return observation.tradePrice != null ||
    observation.tradeSize != null ||
    observation.notional != null ||
    (observation.volumeShare ?? 0) > 0
    ? "trade"
    : "quote";
}

function historicalSignalStrength(observation: BoardObservation) {
  const quoteShock = Math.abs(observation.logitMove ?? 0);
  const priceShock = Math.abs(observation.priceMove ?? 0) * 4;
  const tradeShare = observation.volumeShare ?? 0;
  const notionalShock = Math.min(1, (observation.notional ?? 0) / 200);
  return Math.max(quoteShock, priceShock, tradeShare, notionalShock);
}

function isHistoricalParticipantObservation(observation: BoardObservation) {
  if (observation.sourceKind !== "prediction-market") return false;
  if (observation.source !== "kalshi" && observation.source !== "polymarket") {
    return false;
  }
  if (observation.family !== "player-prop") return false;
  if (!observation.participantKey) return false;

  const kind = historicalObservationKind(observation);
  const signalStrength = historicalSignalStrength(observation);
  if (kind === "trade") {
    return (
      (observation.volumeShare ?? 0) >= 0.02 ||
      (observation.notional ?? 0) >= 20 ||
      signalStrength >= 0.2
    );
  }
  return signalStrength >= 0.35;
}

function observationToHistoricalReactionRow(
  observation: BoardObservation,
  gameId: string,
  gameLabel: string
): HistoricalParticipantReactionRow | null {
  if (!observation.participantKey || !observation.sourceMarketId) {
    return null;
  }
  const granularFamily =
    observation.labels.rawFamily ??
    observation.labels.statFamilyHints[0] ??
    observation.family ??
    "other";
  return {
    displayLabel: observation.displayLabel,
    eventTimestamp: observation.eventTimestamp,
    family: granularFamily,
    gameId,
    gameLabel,
    instrumentId: observation.instrumentId ?? null,
    mappingStatus: observation.mappingStatus,
    notional: observation.notional ?? 0,
    observationKind: historicalObservationKind(observation),
    participantKey: observation.participantKey,
    previousPrice: observation.previousImpliedProbability ?? null,
    signalStrength: historicalSignalStrength(observation),
    source: observation.source as MarketAnomalyAlert["source"],
    sourceMarketId: observation.sourceMarketId,
    tradePrice: observation.tradePrice ?? null,
    volumeShare: observation.volumeShare ?? 0,
  };
}

export function listHistoricalParticipantReactionRowsFromObservations(input: {
  observations: BoardObservation[];
  gameId: string;
  gameLabel: string;
  participantKey?: string | null;
}) {
  const reactionRows: HistoricalParticipantReactionRow[] = [];
  for (const observation of input.observations) {
    if (!isHistoricalParticipantObservation(observation)) continue;
    if (
      input.participantKey != null &&
      observation.participantKey !== input.participantKey
    ) {
      continue;
    }
    const row = observationToHistoricalReactionRow(
      observation,
      input.gameId,
      input.gameLabel
    );
    if (!row || !Number.isFinite(Date.parse(row.eventTimestamp))) continue;
    reactionRows.push(row);
  }

  reactionRows.sort(
    (a, b) => Date.parse(a.eventTimestamp) - Date.parse(b.eventTimestamp)
  );
  return reactionRows;
}

export function listHistoricalParticipantReactionRows(
  db: ReturnType<typeof getDatabase>,
  date: string,
  gameId?: string
) {
  const gameIds = db
    .prepare(
      `SELECT DISTINCT game_id AS gameId
       FROM (
         SELECT sm.game_id AS game_id
         FROM quote_ticks qt
         JOIN source_markets sm ON sm.id = qt.source_market_id
         WHERE substr(qt.captured_at, 1, 10) = ?
           AND (? IS NULL OR sm.game_id = ?)
           AND sm.source IN ('kalshi', 'polymarket')
         UNION
         SELECT mme.game_id AS game_id
         FROM market_microstructure_events mme
         WHERE substr(mme.event_timestamp, 1, 10) = ?
           AND (? IS NULL OR mme.game_id = ?)
           AND mme.source IN ('kalshi', 'polymarket')
       )
       ORDER BY game_id ASC`
    )
    .all(
      date,
      gameId ?? null,
      gameId ?? null,
      date,
      gameId ?? null,
      gameId ?? null
    ) as Array<{ gameId: string }>;

  const windowStart = `${date}T00:00:00.000Z`;
  const windowEnd = `${date}T23:59:59.999Z`;
  const reactionRows: HistoricalParticipantReactionRow[] = [];

  for (const { gameId } of gameIds) {
    const materialized = materializeBoardObservations({
      gameId,
      windowEnd,
      windowStart,
    });
    if (!materialized) continue;
    reactionRows.push(
      ...listHistoricalParticipantReactionRowsFromObservations({
        gameId,
        gameLabel: materialized.gameLabel,
        observations: materialized.observations,
      })
    );
  }

  reactionRows.sort(
    (a, b) => Date.parse(a.eventTimestamp) - Date.parse(b.eventTimestamp)
  );
  return reactionRows;
}

export function buildHistoricalParticipantFanouts(
  rows: ReturnType<typeof listHistoricalParticipantReactionRows>,
  windowSeconds = 1800,
  minStatFamilies = 2
) {
  const byGame = new Map<string, HistoricalParticipantReactionRow[]>();
  for (const row of rows) {
    const list = byGame.get(row.gameId) ?? [];
    list.push(row);
    byGame.set(row.gameId, list);
  }

  const fanouts: HistoricalParticipantFanout[] = [];
  for (const [gameId, list] of byGame.entries()) {
    list.sort(
      (a, b) => Date.parse(a.eventTimestamp) - Date.parse(b.eventTimestamp)
    );
    const used = new Set<string>();
    for (let i = 0; i < list.length; i += 1) {
      const anchor = list[i];
      const anchorKey = `${anchor.sourceMarketId}:${anchor.eventTimestamp}`;
      if (used.has(anchorKey)) continue;
      const cluster = [anchor];
      const families = new Set<string>([anchor.family]);
      const windowMs = windowSeconds * 1000;
      const anchorTs = Date.parse(anchor.eventTimestamp);
      let peakSignalStrength = anchor.signalStrength;
      let tradeCount = anchor.observationKind === "trade" ? 1 : 0;
      for (let j = i + 1; j < list.length; j += 1) {
        const candidate = list[j];
        const candidateTs = Date.parse(candidate.eventTimestamp);
        if (candidateTs - anchorTs > windowMs) break;
        if (candidate.participantKey !== anchor.participantKey) continue;
        cluster.push(candidate);
        families.add(candidate.family);
        peakSignalStrength = Math.max(
          peakSignalStrength,
          candidate.signalStrength
        );
        if (candidate.observationKind === "trade") {
          tradeCount += 1;
        }
      }
      const peakShare = Math.max(...cluster.map((row) => row.volumeShare));
      const totalNotional = cluster.reduce((sum, row) => sum + row.notional, 0);
      if (
        families.size < minStatFamilies ||
        (peakShare < 0.03 &&
          peakSignalStrength < 0.45 &&
          totalNotional < 20 &&
          tradeCount === 0)
      ) {
        continue;
      }
      for (const member of cluster) {
        used.add(`${member.sourceMarketId}:${member.eventTimestamp}`);
      }
      fanouts.push({
        families,
        gameId,
        gameLabel: anchor.gameLabel,
        members: cluster,
        participantKey: anchor.participantKey,
        windowEndIso: cluster[cluster.length - 1].eventTimestamp,
        windowStartIso: cluster[0].eventTimestamp,
      });
    }
  }

  return fanouts;
}

export function historicalParticipantFanoutToBoardCard(
  fanout: ReturnType<typeof buildHistoricalParticipantFanouts>[number],
  pbp: PlayByPlayContext
): FinishedGameIncident {
  const peakShare = Math.max(...fanout.members.map((row) => row.volumeShare));
  const peakSignalStrength = Math.max(
    ...fanout.members.map((row) => row.signalStrength)
  );
  const totalNotional = fanout.members.reduce(
    (sum, row) => sum + row.notional,
    0
  );
  const tradeCount = fanout.members.filter(
    (row) => row.observationKind === "trade"
  ).length;
  const familyParts = Array.from(fanout.families).sort().join(", ");
  const durationMs =
    Date.parse(fanout.windowEndIso) - Date.parse(fanout.windowStartIso);
  const durationText =
    durationMs < 60_000
      ? `${Math.max(1, Math.round(durationMs / 1000))}s`
      : `${Math.round(durationMs / 60_000)}m`;
  const score = Math.min(
    100,
    Math.round(
      peakSignalStrength * 70 +
        peakShare * 50 +
        fanout.families.size * 18 +
        Math.min(18, totalNotional / 40) +
        Math.min(10, tradeCount * 2)
    )
  );
  const confidence = Math.min(
    0.97,
    0.55 +
      peakSignalStrength * 0.25 +
      peakShare * 0.2 +
      fanout.families.size * 0.05 +
      Math.min(0.07, tradeCount * 0.015)
  );
  const shockKind = participantFanoutShockKind(fanout.windowStartIso, pbp);
  const evidence = fanout.members
    .slice()
    .sort(
      (a, b) =>
        b.signalStrength - a.signalStrength ||
        b.volumeShare - a.volumeShare ||
        b.notional - a.notional
    )
    .slice(0, 8)
    .map((member) => ({
      observationId: `historic-participant:${member.sourceMarketId}:${member.eventTimestamp}`,
      source: member.source,
      sourceKind: sourceKindFor(member.source),
      family:
        member.family === "other"
          ? null
          : (member.family as MarketFamily | null),
      participantKey: fanout.participantKey,
      displayLabel: member.displayLabel,
      contribution: Number(Math.min(1, member.signalStrength).toFixed(3)),
      reason:
        member.observationKind === "trade"
          ? `${(member.volumeShare * 100).toFixed(1)}% share · $${member.notional.toFixed(0)}${member.tradePrice != null ? ` @ $${member.tradePrice.toFixed(2)}` : ""}`
          : `quote shock ${member.signalStrength.toFixed(2)} · ${member.displayLabel}`,
      evidenceUnmapped: member.mappingStatus === "unmapped",
    }));

  return {
    id: `historic-participant:${fanout.gameId}:${fanout.participantKey}:${fanout.windowStartIso}`,
    gameId: fanout.gameId,
    gameLabel: fanout.gameLabel,
    shockKind,
    firstPopAt: fanout.windowStartIso,
    detectedAt: fanout.windowStartIso,
    score,
    confidence: Number(confidence.toFixed(3)),
    severity: scoreToSeverity(score),
    reason:
      shockKind === "attribution-shaped"
        ? `Movement is concentrated around ${titleCase(fanout.participantKey)}'s ${familyParts} markets within ${durationText}. Pattern is consistent with a player-specific stat event affecting related props.`
        : `Movement is concentrated around ${titleCase(fanout.participantKey)}'s ${familyParts} markets within ${durationText}, but it is still before tip. Treat this as a player-specific availability/timing tripwire until an NBA action row confirms the underlying event.`,
    primaryEntityKey: fanout.participantKey,
    primaryFamily: (evidence[0]?.family ?? null) as MarketFamily | null,
    components: {
      residual: Number(Math.min(1, peakShare * 2).toFixed(3)),
      microstructure: Number(Math.min(1, totalNotional / 150).toFixed(3)),
      coherence: Number(Math.min(1, fanout.families.size / 4).toFixed(3)),
      coverage: pbp.available ? 0 : 1,
    },
    h0Adjustments: {
      appliedSuppression: 0,
      drivers: [
        `${fanout.members.length} prediction-market observations (${tradeCount} trades) across ${fanout.families.size} stat families`,
        pbp.available
          ? "play-by-play context available"
          : "persisted NBA play-by-play missing for this game snapshot",
      ],
    },
    evidence,
    missingDataNotes: pbp.available
      ? []
      : [
          {
            source: "nba",
            reason:
              "persisted NBA play-by-play missing for this snapshot — cannot confirm stat event directly",
          },
        ],
    inspect: {
      payloadVersion: 1,
      instrumentIds: fanout.members
        .map((member) => member.instrumentId)
        .filter((id): id is string => typeof id === "string"),
      sourceMarketIds: fanout.members.map((member) => member.sourceMarketId),
      relationFamilies: Array.from(fanout.families),
    },
    playByPlay: pbp,
    vigAdjusted: null,
  };
}
