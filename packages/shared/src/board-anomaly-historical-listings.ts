import type {
  BoardAnomalyAlert,
  MarketAnomalyAlert,
  MarketFamily,
  SignalMismatchRow,
} from "@signal-console/domain";

import { scoreToSeverity } from "./board-anomaly/config";
import { replayBoardAnomaliesForGame } from "./board-anomaly-game-runtime";
import {
  buildHistoricalParticipantFanouts,
  historicalParticipantFanoutToBoardCard,
  listHistoricalParticipantReactionRows,
} from "./board-anomaly-historical-fanouts";
import {
  buildIncidentReason,
  buildVigAdjustedComparison,
  classifyIncidentKind,
  listFinishedGameReplayWindows,
  replayAlertToFinishedIncident,
  type FinishedGameIncident,
  type ListFinishedGameIncidentsInput,
  type VigAdjustedComparison,
  type VigAdjustedSide,
} from "./board-anomaly-incidents";
import {
  buildFanouts,
  fanoutToBoardCard,
  marketAnomalyToBoardCard,
} from "./board-anomaly-live-fanouts";
import { getPlayByPlayContext } from "./board-anomaly-play-by-play";
import { parseTimestampMs } from "./board-anomaly-support";
import { executeDatabaseOperation, getDatabase } from "./db-core";
import {
  listMarketAnomalyAlerts,
  listSignalMismatches,
} from "./live-repository";

export type {
  FinishedGameIncident,
  ListFinishedGameIncidentsInput,
  VigAdjustedComparison,
  VigAdjustedSide,
};

export function listFinishedGameIncidents(
  input: ListFinishedGameIncidentsInput
): FinishedGameIncident[] {
  return executeDatabaseOperation(
    "board-anomaly.listFinishedGameIncidents",
    () => {
      const db = getDatabase();
      const windows = listFinishedGameReplayWindows(db, input);
      const incidents: FinishedGameIncident[] = [];
      const limit = Math.max(1, Math.min(50, input.limit ?? 10));

      for (const window of windows) {
        if (incidents.length >= limit) break;
        const windowStart = window.scheduledStart;
        const scheduledMs = parseTimestampMs(window.scheduledStart);
        const fallbackFinalAt =
          scheduledMs == null
            ? window.scheduledStart
            : new Date(scheduledMs + 4 * 60 * 60_000).toISOString();
        const finalAtMs = parseTimestampMs(window.finalAt);
        const hasPlausibleFinalAt =
          scheduledMs != null &&
          finalAtMs != null &&
          finalAtMs >= scheduledMs &&
          finalAtMs <= scheduledMs + 6 * 60 * 60_000;
        const finalAt = hasPlausibleFinalAt ? window.finalAt! : fallbackFinalAt;
        const finalMs = parseTimestampMs(finalAt);
        const windowEnd =
          finalMs == null
            ? finalAt
            : new Date(finalMs + 2 * 60_000).toISOString();
        const replay = replayBoardAnomaliesForGame({
          gameId: window.gameId,
          ingestionLatencyBufferSeconds: 0,
          stepSeconds: 600,
          windowEnd,
          windowStart,
        });
        if (!replay) continue;
        incidents.push(...replay.alertDeck.map(replayAlertToFinishedIncident));
      }

      incidents.sort(
        (a, b) => Date.parse(a.firstPopAt) - Date.parse(b.firstPopAt)
      );
      return incidents.slice(0, limit);
    },
    input
  );
}

export function listForensicFinishedGameIncidents(
  input: ListFinishedGameIncidentsInput
): FinishedGameIncident[] {
  return executeDatabaseOperation(
    "board-anomaly.listForensicFinishedGameIncidents",
    () => {
      const db = getDatabase();
      const candidateWindows = listFinishedGameReplayWindows(db, input);
      const maxGames = Math.max(1, Math.min(25, input.limit ?? 10));
      const participantFanoutRows = listHistoricalParticipantReactionRows(
        db,
        input.date,
        input.gameId
      );
      const candidateGameIds = Array.from(
        new Set(
          [
            ...(input.gameId
              ? [input.gameId]
              : candidateWindows
                  .slice(0, maxGames)
                  .map((window) => window.gameId)),
            ...participantFanoutRows.map((row) => row.gameId),
          ].filter(Boolean)
        )
      );
      const mismatches = candidateGameIds.flatMap((gameId) =>
        listSignalMismatches({
          date: input.date,
          gameId,
          sort: "divergence",
          limit: 80,
        })
      );
      const minGap = input.minGap ?? 0.15;
      const filtered = mismatches.filter(
        (row) =>
          (row.impliedProbabilityGap ?? 0) >= minGap &&
          (!input.gameId || row.gameId === input.gameId)
      );
      const minMarketStructureNotional = 20;

      const byGame = new Map<string, SignalMismatchRow[]>();
      for (const row of filtered) {
        const list = byGame.get(row.gameId) ?? [];
        list.push(row);
        byGame.set(row.gameId, list);
      }

      const incidents: FinishedGameIncident[] = [];
      for (const [gameId, rows] of byGame.entries()) {
        rows.sort(
          (a, b) =>
            (b.impliedProbabilityGap ?? 0) - (a.impliedProbabilityGap ?? 0)
        );
        const headline = rows[0];
        const summary = headline.comparisonSummary;
        const firstPopAt =
          summary?.firstAboveThresholdAt ??
          summary?.maxGapAt ??
          headline.scheduledStart;
        const pbp = getPlayByPlayContext(gameId, firstPopAt);
        const peakGap = headline.impliedProbabilityGap ?? 0;
        const aboveMs = summary?.aboveThresholdDurationMs ?? 0;
        const score = Math.min(
          100,
          Math.max(
            0,
            Math.round(peakGap * 100 * 2 + Math.min(20, aboveMs / 60000))
          )
        );
        const sustainedBonus = aboveMs >= 30 * 60_000 ? 0.05 : 0;
        const confidence = Math.min(
          0.95,
          0.55 + peakGap * 0.6 + sustainedBonus
        );
        const reason = buildIncidentReason(headline);
        const hasNearbyPbp =
          pbp.nearestBefore?.timeActual != null ||
          pbp.nearestAfter?.timeActual != null;
        const shockKind = classifyIncidentKind(headline, firstPopAt, pbp);

        const evidence = rows.slice(0, 8).map((row) => ({
          observationId: `instrument:${row.instrumentId}`,
          source: (row.sources?.[0] ?? "bet365") as
            | "bet365"
            | "kalshi"
            | "polymarket",
          sourceKind:
            row.sources?.[0] === "bet365"
              ? ("sportsbook" as const)
              : ("prediction-market" as const),
          family: row.family,
          participantKey: null,
          displayLabel: row.displayLabel,
          contribution: Number(
            Math.min(1, (row.impliedProbabilityGap ?? 0) * 2).toFixed(3)
          ),
          reason: `${((row.impliedProbabilityGap ?? 0) * 100).toFixed(1)}pp gap`,
          evidenceUnmapped: row.mappingStatus === "unmapped",
        }));

        const inspectInstrumentIds = rows.map((row) => row.instrumentId);
        const inspectRelationFamilies = Array.from(
          new Set(rows.map((row) => row.family ?? "other"))
        );

        const alert: BoardAnomalyAlert = {
          id: `incident:${gameId}:${firstPopAt}`,
          gameId,
          gameLabel: headline.gameLabel,
          shockKind,
          firstPopAt,
          detectedAt: firstPopAt,
          score,
          confidence: Number(confidence.toFixed(3)),
          severity: scoreToSeverity(score),
          reason,
          primaryEntityKey: null,
          primaryFamily: (headline.family ?? null) as MarketFamily | null,
          components: {
            residual: Number(Math.min(1, peakGap * 2).toFixed(3)),
            microstructure: 0,
            coherence: Number(Math.min(1, rows.length / 4).toFixed(3)),
            coverage: 0,
          },
          h0Adjustments: {
            appliedSuppression: 0,
            drivers: hasNearbyPbp
              ? []
              : ["persisted NBA play-by-play missing for this snapshot"],
          },
          evidence,
          missingDataNotes: pbp.available
            ? []
            : [
                {
                  source: "nba" as const,
                  reason:
                    "persisted NBA play-by-play missing for this game snapshot",
                },
              ],
          inspect: {
            payloadVersion: 1 as const,
            instrumentIds: inspectInstrumentIds,
            sourceMarketIds: [],
            relationFamilies: inspectRelationFamilies,
          },
        };
        const vigAdjusted = buildVigAdjustedComparison(db, headline);
        incidents.push({ ...alert, playByPlay: pbp, vigAdjusted });
      }

      const marketAnomaliesByGame = new Map<string, MarketAnomalyAlert[]>();
      const usedAlertIds = new Set<string>();
      const coveredParticipants = new Set<string>();

      for (const gameId of candidateGameIds) {
        const marketAnomalies = listMarketAnomalyAlerts({
          date: input.date,
          gameId,
          limit: 200,
          includeUnmapped: true,
          includeHistorical: true,
          minConfidence: 0.35,
          minScore: 20,
        }).filter((anomaly) => anomaly.gameId === gameId);
        marketAnomaliesByGame.set(gameId, marketAnomalies);
        const fanouts = buildFanouts(marketAnomalies, 900, 2, 0.01);
        for (const fanout of fanouts) {
          const pbp = getPlayByPlayContext(
            fanout.gameId,
            fanout.windowStartIso
          );
          if (
            pbp.nearestBefore?.timeActual == null &&
            pbp.nearestAfter?.timeActual == null
          ) {
            continue;
          }
          for (const member of fanout.members)
            usedAlertIds.add(member.alert.id);
          coveredParticipants.add(`${fanout.gameId}:${fanout.participantKey}`);
          incidents.push(fanoutToBoardCard(fanout, pbp));
        }
      }

      const participantFanouts = buildHistoricalParticipantFanouts(
        participantFanoutRows
      );
      for (const fanout of participantFanouts) {
        if (
          candidateGameIds.length > 0 &&
          !candidateGameIds.includes(fanout.gameId)
        ) {
          continue;
        }
        const coveredKey = `${fanout.gameId}:${fanout.participantKey}`;
        if (coveredParticipants.has(coveredKey)) continue;
        const pbp = getPlayByPlayContext(fanout.gameId, fanout.windowStartIso);
        if (
          pbp.nearestBefore?.timeActual == null &&
          pbp.nearestAfter?.timeActual == null
        ) {
          continue;
        }
        coveredParticipants.add(coveredKey);
        incidents.push(historicalParticipantFanoutToBoardCard(fanout, pbp));
      }

      const leftoverByGame = new Map<string, MarketAnomalyAlert[]>();
      for (const [gameId, marketAnomalies] of marketAnomaliesByGame.entries()) {
        for (const anomaly of marketAnomalies) {
          if (usedAlertIds.has(anomaly.id)) continue;
          const list = leftoverByGame.get(gameId) ?? [];
          list.push(anomaly);
          leftoverByGame.set(gameId, list);
        }
      }
      for (const [gameId, anomalies] of leftoverByGame.entries()) {
        const sized = anomalies.filter(
          (a) => (a.metrics.notional ?? 0) >= minMarketStructureNotional
        );
        sized.sort((a, b) => {
          const aShare = a.metrics.volumeShare ?? 0;
          const bShare = b.metrics.volumeShare ?? 0;
          if (bShare !== aShare) return bShare - aShare;
          const aNotional = a.metrics.notional ?? 0;
          const bNotional = b.metrics.notional ?? 0;
          return bNotional - aNotional;
        });
        const top = sized.slice(0, 2);
        for (const anomaly of top) {
          if ((anomaly.metrics.volumeShare ?? 0) < 0.25) continue;
          const pbp = getPlayByPlayContext(gameId, anomaly.eventTimestamp);
          const surface = anomaly.apiSurface.toLowerCase();
          const candleEnd = surface.includes("candle");
          incidents.push(marketAnomalyToBoardCard(anomaly, pbp, candleEnd));
        }
      }

      incidents.sort((a, b) => b.score - a.score);
      const limit = Math.max(1, Math.min(50, input.limit ?? 10));
      return incidents.slice(0, limit);
    },
    input
  );
}
